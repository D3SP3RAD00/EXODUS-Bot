import { describe, expect, it } from "vitest";

import type { AdmLogSource } from "../src/adapters/adm-log-source.js";
import { statusMessage } from "../src/core/queries.js";
import { AdmIngestor } from "../src/dayz/adm-ingestor.js";
import { NitradoAdmPoller } from "../src/nitrado/nitrado-poller.js";
import { NullLogger } from "../src/observability/logger.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

describe("safe ingestion diagnostics", () => {
  it.each([
    ["NITRADO_ADM_NOT_FOUND", "no_adm"],
    ["NITRADO_AUTHORIZATION_FAILED", "authorization_failure"],
    ["NITRADO_WRONG_SERVICE", "wrong_service"],
    ["NITRADO_INVALID_DIRECTORY", "invalid_directory"],
    ["NITRADO_NETWORK_FAILED", "download_failure"],
    ["NITRADO_INVALID_ADM", "malformed_adm"],
  ])("records %s as %s without retaining raw error data", async (code, expectedStatus) => {
    const storage = new MemoryStorage();
    const source: AdmLogSource = {
      fetchLatest: async () => { throw { code, body: "private response", token: "private token" }; },
    };
    const poller = new NitradoAdmPoller(
      source,
      new AdmIngestor(storage, new NullLogger()),
      new NullLogger(),
      60_000,
      storage,
      () => new Date("2026-09-21T08:00:00Z")
    );

    await expect(poller.pollOnce()).rejects.toMatchObject({ code });
    const state = await storage.read();
    expect(state.diagnostics).toMatchObject({
      status: expectedStatus,
      lastSafeErrorCode: code,
      lastAttemptAt: "2026-09-21T08:00:00.000Z",
    });
    const serialized = JSON.stringify(state.diagnostics);
    expect(serialized).not.toContain("private");
    expect(statusMessage(state)).toContain(`Last safe error: ${code}`);
  });

  it("reports successful ingestion time and parser ignored-line count", async () => {
    const storage = new MemoryStorage();
    const content = [
      "AdminLog started on 2026-09-21 at 05:56:10",
      "not a timed line",
      "",
    ].join("\n");
    await new AdmIngestor(storage, new NullLogger()).ingest({
      sourceId: "safe-source",
      content,
      observedAt: "2026-09-21T08:01:00Z",
    });
    const status = statusMessage(await storage.read());
    expect(status).toContain("ADM state: success");
    expect(status).toContain("Last successful ingestion: 2026-09-21T08:01:00Z");
    expect(status).toContain("Parser ignored lines: 1");
    expect(status).not.toContain("safe-source");
  });
});
