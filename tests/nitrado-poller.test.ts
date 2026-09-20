import { describe, expect, it } from "vitest";

import type { AdmLogSnapshot, AdmLogSource } from "../src/adapters/adm-log-source.js";
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

  it("serializes overlapping poll requests into one download and one ingestion", async () => {
    let resolveSnapshot!: (snapshot: AdmLogSnapshot) => void;
    const pending = new Promise<AdmLogSnapshot>((resolve) => { resolveSnapshot = resolve; });
    let fetches = 0;
    const source: AdmLogSource = {
      fetchLatest: async () => {
        fetches += 1;
        return pending;
      },
    };
    const storage = new MemoryStorage();
    const poller = new NitradoAdmPoller(
      source,
      new AdmIngestor(storage, new NullLogger()),
      new NullLogger(),
      60_000
    );

    const first = poller.pollOnce();
    const second = poller.pollOnce();
    expect(second).toBe(first);
    expect(fetches).toBe(1);
    resolveSnapshot({
      sourceId: "nitrado:single-flight",
      content: log("2026-09-20T10:00:00"),
      observedAt: "2026-09-20T10:00:01Z",
    });
    await expect(Promise.all([first, second])).resolves.toEqual(["ingested", "ingested"]);
    expect(Object.keys((await storage.read()).checkpoints)).toHaveLength(1);
  });

  it("aborts an active poll cleanly without writing a checkpoint", async () => {
    let fetches = 0;
    const source: AdmLogSource = {
      fetchLatest: (signal) => new Promise((_resolve, reject) => {
        fetches += 1;
        signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
      }),
    };
    const storage = new MemoryStorage();
    const controller = new AbortController();
    const poller = new NitradoAdmPoller(
      source,
      new AdmIngestor(storage, new NullLogger()),
      new NullLogger(),
      60_000
    );

    const running = poller.start(controller.signal);
    await Promise.resolve();
    controller.abort();
    await expect(running).resolves.toBeUndefined();
    expect(fetches).toBe(1);
    expect((await storage.read()).checkpoints).toEqual({});
  });

  it("remains idempotent when the same downloaded file is replayed after a poller restart", async () => {
    const replayed = log(
      "2026-09-20T10:00:00",
      `10:05:00 | Player "ExampleOne" (id=${PLAYER}) is connected`,
      `10:15:00 | Player "ExampleOne" (id=${PLAYER}) has been disconnected`
    );
    const storage = new MemoryStorage();
    const logger = new NullLogger();
    const first = new NitradoAdmPoller(
      new NitradoAdmLogAdapter(new StubNitradoClient([
        { id: "same-path", content: replayed, fetchedAt: "2026-09-20T10:16:00Z" },
      ])),
      new AdmIngestor(storage, logger),
      logger,
      60_000
    );
    const restarted = new NitradoAdmPoller(
      new NitradoAdmLogAdapter(new StubNitradoClient([
        { id: "same-path", content: replayed, fetchedAt: "2026-09-20T10:17:00Z" },
      ])),
      new AdmIngestor(storage, logger),
      logger,
      60_000
    );

    await first.pollOnce();
    const before = await storage.read();
    await restarted.pollOnce();
    const after = await storage.read();
    expect(after.players[PLAYER]?.accumulatedPlaytimeMs).toBe(600_000);
    expect(after.sessions).toEqual(before.sessions);
    expect(after.processedEventKeys).toEqual(before.processedEventKeys);
  });
});
