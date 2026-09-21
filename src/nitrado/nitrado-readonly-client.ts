import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { NitradoAdmFile, NitradoClient } from "../adapters/nitrado-adm-log-adapter.js";
import { parseAdminLog } from "../dayz/admin-log.js";

const API_BASE_URL = new URL("https://api.nitrado.net");
const MAX_JSON_RESPONSE_BYTES = 1_048_576;

export type NitradoReadOnlyClientOptions = {
  token: string;
  serviceId: number;
  requestTimeoutMs: number;
  retryLimit: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
  discoveryMaxDepth: number;
  discoveryMaxEntries: number;
  maxDownloadBytes: number;
  downloadHostAllowlist: readonly string[];
  logDirectory?: string;
};

type Fetch = typeof fetch;
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;
type Now = () => Date;
type Random = () => number;

type NitradoGameserver = {
  service_id: number;
  game: string;
  game_human: string;
  game_specific: { features: { has_file_browser: boolean } };
};

type NitradoFileEntry = {
  type: "file" | "dir";
  path: string;
  name: string;
  size?: number;
  modified_at?: number;
};

type ResponseBody = { response: Response; bytes: Uint8Array };

export class NitradoClientError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false
  ) {
    super(message);
    this.name = "NitradoClientError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalAbsolutePath(value: string): string | undefined {
  if (!value.startsWith("/") || value.includes("\0") || value.includes("\\")) return undefined;
  const normalized = posix.normalize(value);
  if (normalized !== value || /%2e|%2f/i.test(normalized)) return undefined;
  return normalized;
}

function isInside(root: string, candidate: string): boolean {
  const relative = posix.relative(root, candidate);
  return relative.length > 0 && relative !== ".." && !relative.startsWith("../") && !posix.isAbsolute(relative);
}

function responseRetryAfter(response: Response, now: Date): number | undefined {
  const value = response.headers.get("retry-after")?.trim();
  if (!value) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(value)) return Number(value) * 1_000;
  const retryAt = Date.parse(value);
  return Number.isFinite(retryAt) ? Math.max(0, retryAt - now.getTime()) : undefined;
}

function hasUnsupportedContinuation(data: Record<string, unknown>): boolean {
  if (["next", "next_page", "nextPage", "cursor"].some((key) => data[key] !== undefined && data[key] !== null)) {
    return true;
  }
  const pagination = data.pagination;
  if (!isRecord(pagination)) return false;
  if (["next", "next_page", "nextPage", "cursor"].some((key) => pagination[key] !== undefined && pagination[key] !== null)) {
    return true;
  }
  const current = pagination.current_page;
  const total = pagination.total_pages;
  return typeof current === "number" && typeof total === "number" && current < total;
}

function hostMatchesAllowlist(hostname: string, allowlist: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return allowlist.some((rawPattern) => {
    const pattern = rawPattern.trim().toLowerCase();
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1);
      return host.endsWith(suffix) && host.length > suffix.length;
    }
    return host === pattern;
  });
}

function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
      reject(new DOMException("Aborted", "AbortError"));
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class NitradoReadOnlyClient implements NitradoClient {
  private readonly logDirectory: string | undefined;

  constructor(
    private readonly options: NitradoReadOnlyClientOptions,
    private readonly fetchImplementation: Fetch = fetch,
    private readonly sleep: Sleep = defaultSleep,
    private readonly now: Now = () => new Date(),
    private readonly random: Random = Math.random
  ) {
    if (!options.token.trim()) throw new Error("NITRADO_TOKEN must not be empty.");
    if (!Number.isSafeInteger(options.serviceId) || options.serviceId <= 0) {
      throw new Error("NITRADO_SERVICE_ID must be a positive safe integer.");
    }
    for (const [name, value] of [
      ["requestTimeoutMs", options.requestTimeoutMs],
      ["backoffBaseMs", options.backoffBaseMs],
      ["backoffMaxMs", options.backoffMaxMs],
      ["discoveryMaxEntries", options.discoveryMaxEntries],
      ["maxDownloadBytes", options.maxDownloadBytes],
    ] as const) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
    }
    if (!Number.isSafeInteger(options.retryLimit) || options.retryLimit < 0) {
      throw new Error("retryLimit must be a non-negative integer.");
    }
    if (!Number.isSafeInteger(options.discoveryMaxDepth) || options.discoveryMaxDepth < 0) {
      throw new Error("discoveryMaxDepth must be a non-negative integer.");
    }
    if (options.backoffBaseMs > options.backoffMaxMs) {
      throw new Error("backoffBaseMs must not exceed backoffMaxMs.");
    }
    if (options.downloadHostAllowlist.length === 0 || options.downloadHostAllowlist.some((host) =>
      !/^(?:\*\.)?[a-z0-9.-]+$/i.test(host) || host.includes("..")
    )) {
      throw new Error("downloadHostAllowlist must contain valid explicit host patterns.");
    }
    if (options.logDirectory !== undefined) {
      const canonical = canonicalAbsolutePath(options.logDirectory);
      if (!canonical) throw new Error("NITRADO_LOG_DIRECTORY must be a canonical absolute path.");
      this.logDirectory = canonical;
    }
  }

  async downloadLatestAdmLog(signal?: AbortSignal): Promise<NitradoAdmFile> {
    this.throwIfAborted(signal);
    await this.verifyService(signal);
    const newest = await this.findNewestAdmLog(signal);
    if (newest.size > this.options.maxDownloadBytes) {
      throw new NitradoClientError("NITRADO_RESPONSE_TOO_LARGE", "The newest ADM log exceeds the configured size limit.");
    }
    const content = await this.downloadFile(newest.path, newest.size, signal);
    return {
      id: createHash("sha256").update(newest.path).digest("hex"),
      content,
      fetchedAt: this.now().toISOString(),
    };
  }

  private async verifyService(signal?: AbortSignal): Promise<void> {
    const payload = await this.requestApiJson(
      "gameserver_details",
      `/services/${this.options.serviceId}/gameservers`,
      signal
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    const server = data && isRecord(data.gameserver) ? data.gameserver : undefined;
    const gameSpecific = server && isRecord(server.game_specific) ? server.game_specific : undefined;
    const features = gameSpecific && isRecord(gameSpecific.features) ? gameSpecific.features : undefined;
    if (
      !server || typeof server.service_id !== "number" || typeof server.game !== "string" ||
      typeof server.game_human !== "string" || typeof features?.has_file_browser !== "boolean"
    ) {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned invalid gameserver metadata.");
    }

    const gameserver: NitradoGameserver = {
      service_id: server.service_id,
      game: server.game,
      game_human: server.game_human,
      game_specific: { features: { has_file_browser: features.has_file_browser } },
    };
    const machineIdentityMatches = /^dayz(?:xb|xbox)(?:$|[-_])/i.test(gameserver.game);
    const humanIdentity = gameserver.game_human.toLowerCase();
    const humanIdentityMatches = humanIdentity.includes("dayz") && humanIdentity.includes("xbox");
    if (gameserver.service_id !== this.options.serviceId || !machineIdentityMatches || !humanIdentityMatches) {
      throw new NitradoClientError(
        "NITRADO_WRONG_SERVICE",
        "The configured Nitrado service is not identified as the intended Xbox DayZ service."
      );
    }
    if (!gameserver.game_specific.features.has_file_browser) {
      throw new NitradoClientError(
        "NITRADO_FILE_BROWSER_UNAVAILABLE",
        "The configured Xbox DayZ service does not expose read-only file browsing."
      );
    }
  }

  private async findNewestAdmLog(
    signal?: AbortSignal
  ): Promise<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>> {
    if (this.logDirectory) {
      const entries = await this.listDirectory(this.logDirectory, signal);
      if (entries.length > this.options.discoveryMaxEntries) {
        throw new NitradoClientError(
          "NITRADO_DISCOVERY_LIMIT",
          "Nitrado log discovery exceeded the configured entry limit."
        );
      }
      const logs: Array<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>> = [];
      for (const entry of entries) {
        const path = canonicalAbsolutePath(entry.path);
        if (!path || posix.dirname(path) !== this.logDirectory || posix.basename(path) !== entry.name) {
          throw new NitradoClientError("NITRADO_UNSAFE_PATH", "Nitrado returned a path outside the configured directory.");
        }
        if (
          entry.type === "file" && path.toLowerCase().endsWith(".adm") &&
          typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
          typeof entry.modified_at === "number" && Number.isFinite(entry.modified_at)
        ) {
          logs.push({ path, size: entry.size, modified_at: entry.modified_at });
        }
      }
      return selectNewestAdm(logs);
    }

    const queue: Array<{ directory?: string; depth: number; root?: string }> = this.logDirectory
      ? [{ directory: this.logDirectory, depth: 0, root: this.logDirectory }]
      : [{ depth: 0 }];
    const visited = new Set<string>();
    const logs: Array<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>> = [];
    let discoveredEntries = 0;
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      this.throwIfAborted(signal);
      const current = queue[queueIndex++]!;
      if (current.directory && visited.has(current.directory)) continue;
      if (current.directory) visited.add(current.directory);
      const entries = await this.listDirectory(current.directory, signal);
      discoveredEntries += entries.length;
      if (discoveredEntries > this.options.discoveryMaxEntries) {
        throw new NitradoClientError(
          "NITRADO_DISCOVERY_LIMIT",
          "Nitrado log discovery exceeded the configured entry limit."
        );
      }

      for (const entry of entries) {
        const path = canonicalAbsolutePath(entry.path);
        const insideCurrent = !current.directory || isInside(current.directory, entry.path);
        const insideRoot = !current.root || isInside(current.root, entry.path);
        if (!path || !insideCurrent || !insideRoot || posix.basename(path) !== entry.name) {
          throw new NitradoClientError("NITRADO_UNSAFE_PATH", "Nitrado returned an unsafe file path.");
        }
        const root = current.root ?? (entry.type === "dir" ? path : posix.dirname(path));
        if (entry.type === "dir" && current.depth < this.options.discoveryMaxDepth) {
          queue.push({ directory: path, depth: current.depth + 1, root });
        } else if (
          entry.type === "file" && path.toLowerCase().endsWith(".adm") &&
          typeof entry.size === "number" && Number.isSafeInteger(entry.size) && entry.size >= 0 &&
          typeof entry.modified_at === "number" && Number.isFinite(entry.modified_at)
        ) {
          logs.push({ path, size: entry.size, modified_at: entry.modified_at });
        }
      }
    }

    return selectNewestAdm(logs);
  }

  private async listDirectory(directory: string | undefined, signal?: AbortSignal): Promise<NitradoFileEntry[]> {
    const query = new URLSearchParams({ summarize_folders: "false" });
    if (directory) query.set("dir", directory);
    const payload = await this.requestApiJson(
      "file_list",
      `/services/${this.options.serviceId}/gameservers/file_server/list?${query}`,
      signal
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    if (!data || !Array.isArray(data.entries)) {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid file listing.");
    }
    if (hasUnsupportedContinuation(data)) {
      throw new NitradoClientError(
        "NITRADO_UNSUPPORTED_PAGINATION",
        "Nitrado returned a paginated file listing that cannot be traversed safely."
      );
    }
    return data.entries.map((value) => {
      if (
        !isRecord(value) || (value.type !== "file" && value.type !== "dir") ||
        typeof value.path !== "string" || typeof value.name !== "string"
      ) {
        throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid file entry.");
      }
      const entry: NitradoFileEntry = { type: value.type, path: value.path, name: value.name };
      if (typeof value.size === "number") entry.size = value.size;
      if (typeof value.modified_at === "number") entry.modified_at = value.modified_at;
      return entry;
    });
  }

  private async downloadFile(path: string, expectedSize: number, signal?: AbortSignal): Promise<string> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.options.retryLimit; attempt += 1) {
      this.throwIfAborted(signal);
      try {
        return await this.downloadFileOnce(path, expectedSize, signal);
      } catch (error) {
        lastError = error;
        if (!(error instanceof NitradoClientError) || !error.retryable || attempt === this.options.retryLimit) throw error;
        await this.waitBeforeRetry(attempt, undefined, signal);
      }
    }
    throw lastError;
  }

  private async downloadFileOnce(path: string, expectedSize: number, signal?: AbortSignal): Promise<string> {
    const query = new URLSearchParams({ file: path });
    const payload = await this.requestApiJson(
      "download_ticket",
      `/services/${this.options.serviceId}/gameservers/file_server/download?${query}`,
      signal
    );
    const data = isRecord(payload) && isRecord(payload.data) ? payload.data : undefined;
    const ticket = data && isRecord(data.token) ? data.token : undefined;
    if (!ticket || typeof ticket.url !== "string") {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid download ticket.");
    }

    let downloadUrl: URL;
    try {
      downloadUrl = new URL(ticket.url);
    } catch {
      throw new NitradoClientError("NITRADO_UNSAFE_DOWNLOAD", "Nitrado returned an unsafe download location.");
    }
    if (
      downloadUrl.protocol !== "https:" || downloadUrl.port !== "" || downloadUrl.username !== "" ||
      downloadUrl.password !== "" || downloadUrl.hash !== "" ||
      !hostMatchesAllowlist(downloadUrl.hostname, this.options.downloadHostAllowlist)
    ) {
      throw new NitradoClientError("NITRADO_UNSAFE_DOWNLOAD", "Nitrado returned an unsafe download location.");
    }

    const { response, bytes } = await this.requestBytes(
      "file_content",
      downloadUrl,
      false,
      this.options.maxDownloadBytes,
      signal
    );
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType === "text/html" || contentType === "application/xhtml+xml") {
      throw new NitradoClientError("NITRADO_INVALID_ADM", "Nitrado returned an invalid ADM download.");
    }
    if (bytes.byteLength < expectedSize) {
      throw new NitradoClientError("NITRADO_PARTIAL_DOWNLOAD", "The ADM log download was incomplete.", true);
    }
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      parseAdminLog(content);
    } catch {
      throw new NitradoClientError("NITRADO_INVALID_ADM", "Nitrado returned malformed ADM content.");
    }
    return content;
  }

  private async requestApiJson(operation: string, relativePath: string, signal?: AbortSignal): Promise<unknown> {
    const url = new URL(relativePath, API_BASE_URL);
    if (url.origin !== API_BASE_URL.origin || !url.pathname.startsWith("/services/")) {
      throw new NitradoClientError("NITRADO_UNSAFE_REQUEST", "An unsafe Nitrado API request was blocked.");
    }
    const { response, bytes } = await this.requestBytes(operation, url, true, MAX_JSON_RESPONSE_BYTES, signal);
    const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", `Nitrado returned invalid ${operation} content.`);
    }
    try {
      const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
      if (!isRecord(value) || value.status !== "success") {
        throw new NitradoClientError("NITRADO_INVALID_RESPONSE", `Nitrado returned an invalid ${operation} response.`);
      }
      return value;
    } catch (error) {
      if (error instanceof NitradoClientError) throw error;
      throw new NitradoClientError("NITRADO_INVALID_RESPONSE", `Nitrado returned unreadable ${operation} data.`);
    }
  }

  private async requestBytes(
    operation: string,
    url: URL,
    authenticated: boolean,
    maximumBytes: number,
    signal?: AbortSignal
  ): Promise<ResponseBody> {
    if (authenticated && url.origin !== API_BASE_URL.origin) {
      throw new NitradoClientError("NITRADO_UNSAFE_REQUEST", "An unsafe authenticated request was blocked.");
    }
    let lastError: unknown;
    const retryLimit = authenticated ? this.options.retryLimit : 0;
    for (let attempt = 0; attempt <= retryLimit; attempt += 1) {
      this.throwIfAborted(signal);
      const controller = new AbortController();
      let timedOut = false;
      let retryAfter: number | undefined;
      const forwardAbort = (): void => controller.abort();
      signal?.addEventListener("abort", forwardAbort, { once: true });
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.options.requestTimeoutMs);
      try {
        const response = await this.fetchImplementation(url.toString(), {
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
          retryAfter = responseRetryAfter(response, this.now());
          throw new NitradoClientError("NITRADO_RATE_LIMITED", "Nitrado rate-limited the request.", true);
        }
        if (response.status >= 500) {
          throw new NitradoClientError("NITRADO_UNAVAILABLE", "Nitrado is temporarily unavailable.", true);
        }
        if (!response.ok) {
          if (response.status === 404 && operation === "file_list" && this.logDirectory) {
            throw new NitradoClientError(
              "NITRADO_INVALID_DIRECTORY",
              "The configured Xbox ADM directory is unavailable."
            );
          }
          throw new NitradoClientError(
            "NITRADO_REQUEST_FAILED",
            `Nitrado rejected the ${operation} request with HTTP ${response.status}.`
          );
        }
        const bytes = await this.readBody(response, maximumBytes, controller.signal);
        return { response, bytes };
      } catch (error) {
        if (signal?.aborted) throw this.abortedError();
        const safeError = error instanceof NitradoClientError
          ? error
          : new NitradoClientError(
            "NITRADO_NETWORK_FAILED",
            timedOut ? `The Nitrado ${operation} request exceeded its time limit.` : `The Nitrado ${operation} request failed.`,
            true
          );
        lastError = safeError;
        if (!safeError.retryable || attempt === retryLimit) throw safeError;
        await this.waitBeforeRetry(attempt, retryAfter, signal);
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener("abort", forwardAbort);
      }
    }
    throw lastError;
  }

  private async readBody(response: Response, maximumBytes: number, signal: AbortSignal): Promise<Uint8Array> {
    const declared = response.headers.get("content-length");
    let declaredLength: number | undefined;
    if (declared !== null) {
      if (!/^\d+$/.test(declared)) {
        throw new NitradoClientError("NITRADO_INVALID_RESPONSE", "Nitrado returned an invalid Content-Length.");
      }
      declaredLength = Number(declared);
      if (!Number.isSafeInteger(declaredLength) || declaredLength > maximumBytes) {
        throw new NitradoClientError("NITRADO_RESPONSE_TOO_LARGE", "The Nitrado response exceeded the size limit.");
      }
    }

    const reader = response.body?.getReader();
    if (!reader) return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      if (signal.aborted) throw new DOMException("Aborted", "AbortError");
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new NitradoClientError("NITRADO_RESPONSE_TOO_LARGE", "The Nitrado response exceeded the size limit.");
      }
      chunks.push(value);
    }
    if (declaredLength !== undefined && total !== declaredLength) {
      throw new NitradoClientError("NITRADO_PARTIAL_DOWNLOAD", "The Nitrado response length was incorrect.", true);
    }
    const combined = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  private async waitBeforeRetry(
    attempt: number,
    retryAfter: number | undefined,
    signal?: AbortSignal
  ): Promise<void> {
    const exponential = Math.min(this.options.backoffMaxMs, this.options.backoffBaseMs * (2 ** attempt));
    const minimum = Math.min(this.options.backoffMaxMs, retryAfter ?? exponential);
    const availableJitter = Math.max(0, this.options.backoffMaxMs - minimum);
    const jitterWindow = Math.min(Math.floor(exponential * 0.25), availableJitter);
    const random = Math.min(1, Math.max(0, this.random()));
    const delay = minimum + Math.floor(jitterWindow * random);
    try {
      await this.sleep(delay, signal);
    } catch {
      if (signal?.aborted) throw this.abortedError();
      throw new NitradoClientError("NITRADO_RETRY_WAIT_FAILED", "The Nitrado retry delay was interrupted.");
    }
  }

  private throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw this.abortedError();
  }

  private abortedError(): NitradoClientError {
    return new NitradoClientError("NITRADO_ABORTED", "The Nitrado operation was stopped.");
  }
}

function selectNewestAdm(
  logs: Array<Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">>>
): Required<Pick<NitradoFileEntry, "path" | "size" | "modified_at">> {
  const newest = logs.sort((left, right) =>
    right.modified_at - left.modified_at || left.path.localeCompare(right.path)
  )[0];
  if (!newest) {
    throw new NitradoClientError("NITRADO_ADM_NOT_FOUND", "No ADM log is currently available on the server.");
  }
  return newest;
}
