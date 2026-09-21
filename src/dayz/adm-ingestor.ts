import { createHash } from "node:crypto";

import type { AdmLogSnapshot, AdmLogSource } from "../adapters/adm-log-source.js";
import { AdminFacingError } from "../core/errors.js";
import { applyAdminLogEvent, closeOpenSessionsForRestart } from "../core/session-service.js";
import { recordSuccessfulIngestion } from "../diagnostics/ingestion-diagnostics.js";
import { armFeedSubscriptions, routeAdminLogEvent } from "../discord/feed-service.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/storage.js";
import { completeAdmLines, hashAdmLines, parseAdminLog, type ParsedAdminLog } from "./admin-log.js";

export type IngestionResult = {
  sourceId: string;
  processedEvents: number;
  duplicateEvents: number;
  malformedLines: number;
  checkpointReset: boolean;
  incompleteSessionsClosed: number;
  truncatedSnapshot: boolean;
};

function eventKey(logStartedAt: string, fingerprint: string, occurrence: number): string {
  return createHash("sha256")
    .update(`${logStartedAt}|${fingerprint}|${occurrence}`)
    .digest("hex");
}

export class AdmIngestor {
  constructor(private readonly storage: Storage, private readonly logger: Logger) {}

  async ingestFrom(source: AdmLogSource): Promise<IngestionResult> {
    return this.ingest(await source.fetchLatest());
  }

  async ingest(snapshot: AdmLogSnapshot): Promise<IngestionResult> {
    let parsed: ParsedAdminLog;
    try {
      parsed = parseAdminLog(snapshot.content);
    } catch {
      throw new AdminFacingError("ADM_MALFORMED", "The downloaded ADM content could not be parsed safely.");
    }
    const lines = completeAdmLines(snapshot.content);
    const result = await this.storage.transaction((state) => {
      const checkpoint = state.checkpoints[snapshot.sourceId];
      const sameLog = checkpoint?.logStartedAt === parsed.startedAt;
      if (checkpoint && sameLog && lines.length < checkpoint.processedLineCount) {
        return {
          sourceId: snapshot.sourceId,
          processedEvents: 0,
          duplicateEvents: 0,
          malformedLines: 0,
          checkpointReset: false,
          incompleteSessionsClosed: 0,
          truncatedSnapshot: true,
        };
      }
      const prefixStillMatches = checkpoint !== undefined
        && sameLog
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
        const key = eventKey(parsed.startedAt, event.fingerprint, event.occurrence);
        if (state.processedEventKeys[key]) {
          duplicateEvents += 1;
          continue;
        }
        applyAdminLogEvent(state, event);
        if (event.type === "player_emote") {
          state.emotes[key] = {
            eventKey: key,
            playerId: event.playerId,
            playerName: event.playerName,
            occurredAt: event.occurredAt,
            emote: event.emote,
            ...(event.item ? { item: event.item } : {}),
          };
        }
        routeAdminLogEvent(state, event, key, snapshot.observedAt);
        state.processedEventKeys[key] = event.occurredAt;
        processedEvents += 1;
      }
      state.checkpoints[snapshot.sourceId] = {
        sourceId: snapshot.sourceId,
        processedLineCount: parsed.completeLineCount,
        prefixHash: hashAdmLines(lines),
        logStartedAt: parsed.startedAt,
        updatedAt: snapshot.observedAt,
      };
      recordSuccessfulIngestion(
        state,
        snapshot.observedAt,
        parsed.ignoredLines.length,
        processedEvents,
        snapshot.discovery
      );
      armFeedSubscriptions(state);
      return {
        sourceId: snapshot.sourceId,
        processedEvents,
        duplicateEvents,
        malformedLines: parsed.ignoredLines.filter((line) => line.lineNumber >= firstUnprocessedLine).length,
        checkpointReset,
        incompleteSessionsClosed,
        truncatedSnapshot: false,
      };
    });
    if (result.truncatedSnapshot) {
      this.logger.warn("adm_ingestion_truncated_snapshot", { code: "ADM_TRUNCATED_SNAPSHOT" });
    }
    if (result.malformedLines > 0) {
      this.logger.warn("adm_ingestion_malformed_lines", { count: result.malformedLines });
    }
    this.logger.info("adm_ingestion_completed", {
      processedEvents: result.processedEvents,
      duplicateEvents: result.duplicateEvents,
      malformedLines: result.malformedLines,
      checkpointReset: result.checkpointReset,
      incompleteSessionsClosed: result.incompleteSessionsClosed,
      truncatedSnapshot: result.truncatedSnapshot,
    });
    return result;
  }
}
