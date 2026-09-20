import type { AdmLogSnapshot, AdmLogSource } from "../adapters/adm-log-source.js";
import { applyAdminLogEvent, closeOpenSessionsForRestart } from "../core/session-service.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/storage.js";
import { completeAdmLines, hashAdmLines, parseAdminLog } from "./admin-log.js";

export type IngestionResult = {
  sourceId: string;
  processedEvents: number;
  duplicateEvents: number;
  malformedLines: number;
  checkpointReset: boolean;
  incompleteSessionsClosed: number;
};

export class AdmIngestor {
  constructor(private readonly storage: Storage, private readonly logger: Logger) {}

  async ingestFrom(source: AdmLogSource): Promise<IngestionResult> {
    return this.ingest(await source.fetchLatest());
  }

  async ingest(snapshot: AdmLogSnapshot): Promise<IngestionResult> {
    const parsed = parseAdminLog(snapshot.content);
    const lines = completeAdmLines(snapshot.content);
    const result = await this.storage.transaction((state) => {
      const checkpoint = state.checkpoints[snapshot.sourceId];
      const prefixStillMatches = checkpoint !== undefined
        && checkpoint.processedLineCount <= lines.length
        && hashAdmLines(lines.slice(0, checkpoint.processedLineCount)) === checkpoint.prefixHash;
      const checkpointReset = checkpoint !== undefined && !prefixStillMatches;
      const firstUnprocessedLine = prefixStillMatches ? checkpoint.processedLineCount + 1 : 1;
      const previousStarts = new Set(Object.values(state.checkpoints).map((entry) => entry.logStartedAt));
      const newServerLog = checkpoint
        ? checkpoint.logStartedAt !== parsed.startedAt
        : previousStarts.size > 0 && !previousStarts.has(parsed.startedAt);
      const incompleteSessionsClosed = newServerLog
        ? closeOpenSessionsForRestart(state, parsed.startedAt)
        : 0;
      let processedEvents = 0;
      let duplicateEvents = 0;
      for (const event of parsed.events.filter((entry) => entry.lineNumber >= firstUnprocessedLine)) {
        if (state.processedEventFingerprints[event.fingerprint]) {
          duplicateEvents += 1;
          continue;
        }
        applyAdminLogEvent(state, event);
        state.processedEventFingerprints[event.fingerprint] = event.occurredAt;
        processedEvents += 1;
      }
      state.checkpoints[snapshot.sourceId] = {
        sourceId: snapshot.sourceId,
        processedLineCount: parsed.completeLineCount,
        prefixHash: hashAdmLines(lines),
        logStartedAt: parsed.startedAt,
        updatedAt: snapshot.observedAt,
      };
      return {
        sourceId: snapshot.sourceId,
        processedEvents,
        duplicateEvents,
        malformedLines: parsed.ignoredLines.filter((line) => line.lineNumber >= firstUnprocessedLine).length,
        checkpointReset,
        incompleteSessionsClosed,
      };
    });
    if (result.malformedLines > 0) {
      this.logger.warn("adm_ingestion_malformed_lines", { sourceId: result.sourceId, count: result.malformedLines });
    }
    this.logger.info("adm_ingestion_completed", result);
    return result;
  }
}
