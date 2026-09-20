import { createHash } from "node:crypto";

import type { AdmLogSource } from "../adapters/adm-log-source.js";
import type { AdmIngestor } from "../dayz/adm-ingestor.js";
import type { Logger } from "../observability/logger.js";

export type PollResult = "ingested" | "unchanged";

export class NitradoAdmPoller {
  private lastContentHash: string | undefined;
  private running = false;

  constructor(
    private readonly source: AdmLogSource,
    private readonly ingestor: AdmIngestor,
    private readonly logger: Logger,
    private readonly intervalMs: number,
    private readonly wait: (milliseconds: number) => Promise<void> =
      (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  ) {}

  async pollOnce(): Promise<PollResult> {
    const snapshot = await this.source.fetchLatest();
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
          await this.pollOnce();
        } catch (error) {
          this.logger.error("nitrado_adm_poll_failed", {
            errorName: error instanceof Error ? error.name : "UnknownError",
            errorMessage: error instanceof Error ? error.message : String(error),
          });
        }
        if (!signal?.aborted) await this.wait(this.intervalMs);
      }
    } finally {
      this.running = false;
    }
  }
}
