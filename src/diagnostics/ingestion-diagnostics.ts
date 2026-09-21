import type { BotState, IngestionStatus } from "../core/state.js";
import { enqueueOperationalSummary } from "../discord/feed-service.js";
import type { Storage } from "../storage/storage.js";

const safeCodes = new Set([
  "NITRADO_ADM_NOT_FOUND",
  "NITRADO_ADM_FETCH_FAILED",
  "NITRADO_AUTHORIZATION_FAILED",
  "NITRADO_WRONG_SERVICE",
  "NITRADO_INVALID_DIRECTORY",
  "NITRADO_INVALID_ADM",
  "NITRADO_PARTIAL_DOWNLOAD",
  "NITRADO_NETWORK_FAILED",
  "NITRADO_REQUEST_FAILED",
  "NITRADO_RETRY_WAIT_FAILED",
  "NITRADO_UNAVAILABLE",
  "NITRADO_RATE_LIMITED",
  "NITRADO_RESPONSE_TOO_LARGE",
  "NITRADO_FILE_BROWSER_UNAVAILABLE",
  "NITRADO_INVALID_RESPONSE",
  "NITRADO_UNSAFE_PATH",
  "NITRADO_UNSAFE_DOWNLOAD",
  "NITRADO_DISCOVERY_LIMIT",
  "NITRADO_UNSUPPORTED_PAGINATION",
  "ADM_MALFORMED",
]);

export function safeErrorCode(error: unknown): string {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && safeCodes.has(code)) return code;
  }
  return "EXODUS_INTERNAL";
}

export function statusForErrorCode(code: string): IngestionStatus {
  if (code === "NITRADO_ADM_NOT_FOUND") return "no_adm";
  if (code === "NITRADO_AUTHORIZATION_FAILED") return "authorization_failure";
  if (code === "NITRADO_WRONG_SERVICE") return "wrong_service";
  if (code === "NITRADO_INVALID_DIRECTORY") return "invalid_directory";
  if (code === "NITRADO_INVALID_ADM" || code === "ADM_MALFORMED") return "malformed_adm";
  if (code.startsWith("NITRADO_")) return "download_failure";
  return "error";
}

export function recordSuccessfulIngestion(
  state: BotState,
  observedAt: string,
  ignoredLineCount: number,
  processedEvents: number
): void {
  const changed = state.diagnostics.status !== "success" || state.diagnostics.lastSafeErrorCode !== undefined;
  state.diagnostics = {
    status: "success",
    lastAttemptAt: observedAt,
    lastSuccessfulIngestionAt: observedAt,
    ignoredLineCount,
  };
  if (changed) {
    enqueueOperationalSummary(
      state,
      `ingestion-success:${observedAt}`,
      `✅ ADM ingestion healthy. Events: ${processedEvents}. Ignored lines: ${ignoredLineCount}.`,
      observedAt
    );
  }
}

export async function recordUnchangedIngestion(storage: Storage, observedAt: string): Promise<void> {
  await storage.transaction((state) => {
    const changed = state.diagnostics.status !== "unchanged";
    state.diagnostics.status = "unchanged";
    state.diagnostics.lastAttemptAt = observedAt;
    delete state.diagnostics.lastSafeErrorCode;
    if (changed) {
      enqueueOperationalSummary(
        state,
        `ingestion-unchanged:${observedAt}`,
        "ℹ️ ADM log is unchanged.",
        observedAt
      );
    }
  });
}

export async function recordIngestionError(storage: Storage, error: unknown, observedAt: string): Promise<string> {
  const code = safeErrorCode(error);
  await storage.transaction((state) => {
    const status = statusForErrorCode(code);
    const changed = state.diagnostics.status !== status || state.diagnostics.lastSafeErrorCode !== code;
    state.diagnostics.status = status;
    state.diagnostics.lastAttemptAt = observedAt;
    state.diagnostics.lastSafeErrorCode = code;
    if (changed) {
      enqueueOperationalSummary(
        state,
        `ingestion-error:${code}:${observedAt}`,
        `⚠️ ADM ingestion issue: ${code}.`,
        observedAt
      );
    }
  });
  return code;
}
