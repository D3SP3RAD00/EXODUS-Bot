import { createHash } from "node:crypto";

import type { AdmLogSource } from "../adapters/adm-log-source.js";
import type { AdmIngestor } from "../dayz/adm-ingestor.js";
import { recordIngestionError, recordUnchangedIngestion, safeErrorCode } from "../diagnostics/ingestion-diagnostics.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/storage.js";

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
    private readonly diagnosticsStorage?: Storage,
    private readonly now: () => Date = () => new Date(),
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
    const operation = this.executePoll(signal).catch(async (error: unknown) => {
      if (this.diagnosticsStorage && !signal?.aborted) {
        await recordIngestionError(this.diagnosticsStorage, error, this.now().toISOString());
      }
      throw error;
    });
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
      if (this.diagnosticsStorage) {
        await recordUnchangedIngestion(this.diagnosticsStorage, snapshot.observedAt);
      }
      this.logger.info("nitrado_adm_unchanged", { code: "ADM_UNCHANGED" });
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
          const code = safeErrorCode(error);
          this.logger.error("nitrado_adm_poll_failed", {
            code,
          });
        }
        if (!signal?.aborted) await this.wait(this.intervalMs, signal);
      }
    } finally {
      this.running = false;
    }
  }
}
