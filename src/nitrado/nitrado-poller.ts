import { createHash } from "node:crypto";

import type { AdmLogSource } from "../adapters/adm-log-source.js";
import type { AdmIngestor } from "../dayz/adm-ingestor.js";
import type { Logger } from "../observability/logger.js";

export type PollResult = "ingested" | "unchanged";

export class NitradoAdmPoller {
  private lastContentHash: string | undefined;
  private running = false;
  private inFlight: Promise<PollResult> | undefined;

  constructor(
    private readonly source: AdmLogSource,
    private readonly ingestor: AdmIngestor,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly wait: (milliseconds: number, signal?: AbortSignal) => Promise<void> =
      (milliseconds, signal) => new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
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
          resolve();
        }
        signal?.addEventListener("abort", abort, { once: true });
      })
  ) {}

  pollOnce(signal?: AbortSignal): Promise<PollResult> {
    if (this.inFlight) return this.inFlight;
    const operation = this.executePoll(signal);
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    }).catch(() => {});
    return operation;
  }

  private async executePoll(signal?: AbortSignal): Promise<PollResult> {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const snapshot = await this.source.fetchLatest(signal);
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const contentHash = createHash("sha256").update(snapshot.content).digest("hex");
    if (contentHash === this.lastContentHash) {
      this.logger.info("nitrado_adm_unchanged", { sourceId: snapshot.sourceId });
      return "unchanged";
    }
    await this.ingestor.ingest(snapshot);
    this.lastContentHash = contentHash;
    return "ingested";
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!signal?.aborted) {
        try {
          await this.pollOnce(signal);
        } catch (error) {
          if (signal?.aborted) break;
          this.logger.error("nitrado_adm_poll_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        if (!signal?.aborted) await this.wait(this.intervalMs, signal);
      }
    } finally {
      this.running = false;
    }
  }
}
