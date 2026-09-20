import { describe, expect, it } from "vitest";

import { NitradoAdmLogAdapter, type NitradoAdmFile, type NitradoClient } from "../src/adapters/nitrado-adm-log-adapter.js";
import { AdmIngestor } from "../src/dayz/adm-ingestor.js";
import { NitradoAdmPoller } from "../src/nitrado/nitrado-poller.js";
import { NullLogger } from "../src/observability/logger.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

const PLAYER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function log(startedAt: string, ...lines: string[]): string {
  const [date, time] = startedAt.split("T");
  return [
    "******************************************************************************",
    `AdminLog started on ${date} at ${time}`,
    ...lines,
    "",
  ].join("\n");
}

class StubNitradoClient implements NitradoClient {
  constructor(private readonly files: NitradoAdmFile[]) {}

  async downloadLatestAdmLog(): Promise<NitradoAdmFile> {
    const next = this.files.shift();
    if (!next) throw new Error("No stub file remains.");
    return next;
  }
}

describe("Nitrado adapter polling", () => {
  it("passes downloads through the existing adapter, skips unchanged files, and handles restarts", async () => {
    const firstContent = log(
      "2026-09-20T10:00:00",
      `10:05:00 | Player "ExampleOne" (id=${PLAYER}) is connected`
    );
    const restartedContent = log(
      "2026-09-20T11:00:00",
      `11:05:00 | Player "ExampleOne" (id=${PLAYER}) is connected`,
      `11:20:00 | Player "ExampleOne" (id=${PLAYER}) has been disconnected`
    );
    const client = new StubNitradoClient([
      { id: "first", content: firstContent, fetchedAt: "2026-09-20T10:06:00Z" },
      { id: "first", content: firstContent, fetchedAt: "2026-09-20T10:07:00Z" },
      { id: "second", content: restartedContent, fetchedAt: "2026-09-20T11:21:00Z" },
    ]);
    const storage = new MemoryStorage();
    const logger = new NullLogger();
    const adapter = new NitradoAdmLogAdapter(client);
    const ingestor = new AdmIngestor(storage, logger);
    const poller = new NitradoAdmPoller(adapter, ingestor, logger, 60_000);

    await expect(poller.pollOnce()).resolves.toBe("ingested");
    await expect(poller.pollOnce()).resolves.toBe("unchanged");
    await expect(poller.pollOnce()).resolves.toBe("ingested");

    const state = await storage.read();
    expect(Object.values(state.sessions)).toHaveLength(2);
    expect(Object.values(state.sessions).some((session) => session.closeReason === "server_restart")).toBe(true);
    expect(state.players[PLAYER]?.accumulatedPlaytimeMs).toBe(4_200_000);
  });
});
