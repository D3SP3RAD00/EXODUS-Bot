import { createHash } from "node:crypto";

import type { NitradoAdmFile, NitradoClient } from "../adapters/nitrado-adm-log-adapter.js";

const API_BASE_URL = "https://api.nitrado.net";

export type NitradoReadOnlyClientOptions = {
  token: string;
  serviceId: number;
  requestTimeoutMs: number;
  retryLimit: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  discoveryMaxDepth: number;
  discoveryMaxEntries: number;
  logDirectory?: string;
};

type Fetch = typeof fetch;
type Sleep = (milliseconds: number) => Promise<void>;
type Now = () => Date;

type NitradoGameserver = {
  service_id: number;
  game: string;
  game_human: string;
  game_specific: {
    features: { has_file_browser: boolean };
  };
};

type NitradoFileEntry = {
  type: "file" | "dir";
  path: string;
  name: string;
  size?: number;
  modified_at?: number;
};

export class NitradoClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "NitradoClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function safePath(value: string): boolean {
  return !value.includes("\0") && !value.includes("\\") && !value.split("/").includes("..");
}

function isDescendant(parent: string, child: string): boolean {
  const normalized = parent.endsWith("/") ? parent : `${parent}/`;
  return child.startsWith(normalized);
}

function responseRetryAfter(response: Response): number | undefined {
  const value = response.headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

export class NitradoReadOnlyClient implements NitradoClient {
  constructor(
    private readonly options: NitradoReadOnlyClientOptions,
    private readonly fetchImplementation: Fetch = fetch,
    private readonly sleep: Sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    private readonly now: Now = () => new Date()
  ) {
    if (!options.token) throw new Error("NITRADO_TOKEN must not be empty.");
    if (!Number.isSafeInteger(options.serviceId) || options.serviceId <= 0) {
      throw new Error("NITRADO_SERVICE_ID must be a positive integer.");
    }
  }

  async downloadLatestAdmLog(): Promise<NitradoAdmFile> {
    await this.verifyService();
    const newest = await this.findNewestAdmLog();
    const content = await this.downloadFile(newest.path, newest.size);
    return {
      id: createHash("sha256").update(newest.path).digest("hex"),
      content,
      fetchedAt: this.now().toISOString(),
    };
  }

  private async verifyService(): Promise<void> {
    const payload = await this.requestJson(
      "gameserver_details",
      `${API_BASE_URL}/services/${this.options.serviceId}/gameservers`
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    const server = data && isRecord(data.gameserver) ? data.gameserver : undefined;
    const gameSpecific = server && isRecord(server.game_specific) ? server.game_specific : undefined;
    const features = gameSpecific && isRecord(gameSpecific.features) ? gameSpecific.features : undefined;
    if (
      !server ||
      typeof server.service_id !== "number" ||
      typeof server.game !== "string" ||
      typeof server.game_human !== "string" ||
      typeof features?.has_file_browser !== "boolean"
    ) {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned invalid gameserver metadata.");
    }

    const gameserver: NitradoGameserver = {
      service_id: server.service_id,
      game: server.game,
      game_human: server.game_human,
      game_specific: { features: { has_file_browser: features.has_file_browser } },
    };
    const identity = `${gameserver.game} ${gameserver.game_human}`.toLowerCase();
    const xboxIdentity = identity.includes("xbox") || /^dayz.*(?:xb|xbox)/i.test(gameserver.game);
    if (gameserver.service_id !== this.options.serviceId || !identity.includes("dayz") || !xboxIdentity) {
      throw new NitradoClientError(
        "NITRADO_WRONG_SERVICE",
        "The configured Nitrado service is not identified as an Xbox DayZ server."
      );
    }
    if (!gameserver.game_specific.features.has_file_browser) {
      throw new NitradoClientError(
        "NITRADO_FILE_BROWSER_UNAVAILABLE",
        "The configured Xbox DayZ service does not expose read-only file browsing."
      );
    }
  }

  private async findNewestAdmLog(): Promise<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>> {
    const queue: Array<{ directory?: string; depth: number }> = [
      this.options.logDirectory ? { directory: this.options.logDirectory, depth: 0 } : { depth: 0 },
    ];
    const visited = new Set<string>();
    const logs: Array<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>> = [];
    let discoveredEntries = 0;

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current.directory && visited.has(current.directory)) continue;
      if (current.directory) visited.add(current.directory);
      const entries = await this.listDirectory(current.directory);
      discoveredEntries += entries.length;
      if (discoveredEntries > this.options.discoveryMaxEntries) {
        throw new NitradoClientError(
          "NITRADO_DISCOVERY_LIMIT",
          "Nitrado log discovery exceeded the configured entry limit."
        );
      }

      for (const entry of entries) {
        if (!safePath(entry.path) || (current.directory && !isDescendant(current.directory, entry.path))) {
          throw new NitradoClientError("NITRADO_UNSAFE_PATH", "Nitrado returned an unsafe file path.");
        }
        if (entry.type === "dir" && current.depth < this.options.discoveryMaxDepth) {
          queue.push({ directory: entry.path, depth: current.depth + 1 });
        } else if (
          entry.type === "file" &&
          entry.name.toLowerCase().endsWith(".adm") &&
          typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
          typeof entry.modified_at === "number" && Number.isFinite(entry.modified_at)
        ) {
          logs.push({ path: entry.path, size: entry.size, modified_at: entry.modified_at });
        }
      }
    }

    const newest = logs.sort((left, right) =>
      right.modified_at - left.modified_at || right.path.localeCompare(left.path)
    )[0];
    if (!newest) {
      throw new NitradoClientError("NITRADO_ADM_NOT_FOUND", "No ADM log is currently available on the server.");
    }
    return newest;
  }

  private async listDirectory(directory?: string): Promise<NitradoFileEntry[]> {
    const query = new URLSearchParams({ summarize_folders: "false" });
    if (directory) query.set("dir", directory);
    const payload = await this.requestJson(
      "file_list",
      `${API_BASE_URL}/services/${this.options.serviceId}/gameservers/file_server/list?${query}`
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    if (!data || !Array.isArray(data.entries)) {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid file listing.");
    }
    return data.entries.map((value) => {
      if (
        !isRecord(value) ||
        (value.type !== "file" && value.type !== "dir") ||
        typeof value.path !== "string" ||
        typeof value.name !== "string"
      ) {
        throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid file entry.");
      }
      const entry: NitradoFileEntry = { type: value.type, path: value.path, name: value.name };
      if (typeof value.size === "number") entry.size = value.size;
      if (typeof value.modified_at === "number") entry.modified_at = value.modified_at;
      return entry;
    });
  }

  private async downloadFile(path: string, expectedSize: number): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retryLimit; attempt += 1) {
      try {
        return await this.downloadFileOnce(path, expectedSize);
      } catch (error) {
        lastError = error;
        if (!(error instanceof NitradoClientError) || !error.retryable || attempt === this.options.retryLimit) {
          throw error;
        }
        await this.waitBeforeRetry(attempt);
      }
    }
    throw lastError;
  }

  private async downloadFileOnce(path: string, expectedSize: number): Promise<string> {
    const query = new URLSearchParams({ file: path });
    const payload = await this.requestJson(
      "download_ticket",
      `${API_BASE_URL}/services/${this.options.serviceId}/gameservers/file_server/download?${query}`
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    const ticket = data && isRecord(data.token) ? data.token : undefined;
    if (!ticket || typeof ticket.url !== "string") {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid download ticket.");
    }
    const downloadUrl = new URL(ticket.url);
    if (
      downloadUrl.protocol !== "https:" ||
      (downloadUrl.hostname !== "nitrado.net" && !downloadUrl.hostname.endsWith(".nitrado.net")) ||
      downloadUrl.username || downloadUrl.password
    ) {
      throw new NitradoClientError("NITRADO_UNSAFE_DOWNLOAD", "Nitrado returned an unsafe download location.");
    }

    const response = await this.request("file_content", downloadUrl.toString(), false);
    let content: string;
    try {
      content = await response.text();
    } catch (error) {
      throw new NitradoClientError(
        "NITRADO_NETWORK_FAILED",
        "The ADM log download was interrupted.",
        true,
        { cause: error }
      );
    }
    const actualSize = Buffer.byteLength(content, "utf8");
    const contentLength = response.headers.get("content-length");
    if (
      (contentLength !== null && Number(contentLength) !== actualSize) ||
      actualSize < expectedSize
    ) {
      throw new NitradoClientError(
        "NITRADO_PARTIAL_DOWNLOAD",
        "The ADM log download was incomplete.",
        true
      );
    }
    return content;
  }

  private async requestJson(operation: string, url: string): Promise<unknown> {
    const response = await this.request(operation, url, true);
    try {
      const value: unknown = await response.json();
      if (!isRecord(value) || value.status !== "success") {
        throw new NitradoClientError("NITRADO_INVALID_RESPONSE", `Nitrado returned an invalid ${operation} response.`);
      }
      return value;
    } catch (error) {
      if (error instanceof NitradoClientError) throw error;
      throw new NitradoClientError(
        "NITRADO_INVALID_RESPONSE",
        `Nitrado returned unreadable ${operation} data.`,
        false,
        { cause: error }
      );
    }
  }

  private async request(operation: string, url: string, authenticated: boolean): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retryLimit; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.options.requestTimeoutMs);
      try {
        const response = await this.fetchImplementation(url, {
          method: "GET",
          ...(authenticated ? { headers: { Authorization: `Bearer ${this.options.token}` } } : {}),
          redirect: "error",
          signal: controller.signal,
        });
        if (response.status === 401 || response.status === 403) {
          throw new NitradoClientError(
            "NITRADO_AUTHORIZATION_FAILED",
            "Nitrado rejected the configured access token or service permission."
          );
        }
        if (response.status === 429) {
          const error = new NitradoClientError("NITRADO_RATE_LIMITED", "Nitrado rate-limited the request.", true);
          if (attempt === this.options.retryLimit) throw error;
          await this.waitBeforeRetry(attempt, responseRetryAfter(response));
          continue;
        }
        if (response.status >= 500) {
          const error = new NitradoClientError("NITRADO_UNAVAILABLE", "Nitrado is temporarily unavailable.", true);
          if (attempt === this.options.retryLimit) throw error;
          await this.waitBeforeRetry(attempt);
          continue;
        }
        if (!response.ok) {
          throw new NitradoClientError(
            "NITRADO_REQUEST_FAILED",
            `Nitrado rejected the ${operation} request with HTTP ${response.status}.`
          );
        }
        return response;
      } catch (error) {
        if (error instanceof NitradoClientError && !error.retryable) throw error;
        lastError = error;
        if (attempt === this.options.retryLimit) break;
        await this.waitBeforeRetry(attempt);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof NitradoClientError
      ? lastError
      : new NitradoClientError(
        "NITRADO_NETWORK_FAILED",
        `The Nitrado ${operation} request failed after retries.`,
        true,
        { cause: lastError }
      );
  }

  private async waitBeforeRetry(attempt: number, retryAfter?: number): Promise<void> {
    const exponential = Math.min(
      this.options.backoffMaxMs,
      this.options.backoffBaseMs * (2 ** attempt)
    );
    await this.sleep(Math.min(this.options.backoffMaxMs, retryAfter ?? exponential));
  }
}
