import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import { playerPlaytimeMs } from "../src/core/session-service.js";
import { AdmIngestor } from "../src/dayz/adm-ingestor.js";
import { NullLogger } from "../src/observability/logger.js";
import { JsonFileStorage } from "../src/storage/json-file-storage.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

const PLAYER_A = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const PLAYER_B = "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB";
const temporaryDirectories: string[] = [];

function log(startedAt: string, ...lines: string[]): string {
  const [date, time] = startedAt.split("T");
  return [
    "******************************************************************************",
    `AdminLog started on ${date} at ${time}`,
    ...lines,
    "",
  ].join("\n");
}

function snapshot(sourceId: string, content: string) {
  return { sourceId, content, observedAt: "2026-09-20T12:00:00Z" };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("AdmIngestor", () => {
  it("closes the previous session when a player reconnects", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    await ingestor.ingest(snapshot("adm:reconnect", log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `10:15:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `10:45:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));

    const state = await storage.read();
    const sessions = Object.values(state.sessions);
    expect(sessions).toHaveLength(2);
    expect(sessions[0]).toMatchObject({ closeReason: "reconnect", incomplete: true, durationMs: 900_000 });
    expect(sessions[1]).toMatchObject({ closeReason: "disconnect", incomplete: false, durationMs: 1_800_000 });
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(2_700_000);
  });

  it("keeps legitimate identical events distinct while replay remains idempotent", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    const duplicate = `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`;
    const first = await ingestor.ingest(snapshot("adm:duplicates", log(
      "2026-09-20T09:55:00",
      duplicate,
      duplicate,
      `10:30:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));
    const second = await ingestor.ingest(snapshot("adm:duplicates", log(
      "2026-09-20T09:55:00",
      duplicate,
      duplicate,
      `10:30:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));

    const state = await storage.read();
    expect(first).toMatchObject({ processedEvents: 3, duplicateEvents: 0 });
    expect(second.processedEvents).toBe(0);
    expect(Object.values(state.sessions)).toHaveLength(2);
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(1_800_000);
  });

  it("persists checkpoints and sessions across process restarts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exodus-storage-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "state.json");
    const firstStorage = new JsonFileStorage(file);
    const firstIngestor = new AdmIngestor(firstStorage, new NullLogger());
    await firstIngestor.ingest(snapshot("adm:persistent", log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`
    )));

    const restartedStorage = new JsonFileStorage(file);
    const restartedIngestor = new AdmIngestor(restartedStorage, new NullLogger());
    const result = await restartedIngestor.ingest(snapshot("adm:persistent", log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `10:20:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));

    const state = await restartedStorage.read();
    expect(result.processedEvents).toBe(1);
    expect(Object.values(state.sessions)).toHaveLength(1);
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(1_200_000);
  });

  it("closes incomplete sessions when a new server log starts", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    await ingestor.ingest(snapshot("adm:rotating-file", log(
      "2026-09-20T09:55:00",
      `10:05:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`
    )));
    const result = await ingestor.ingest(snapshot("adm:rotating-file", log(
      "2026-09-20T11:00:00",
      `11:05:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `11:35:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));

    const state = await storage.read();
    const sessions = Object.values(state.sessions);
    expect(result.incompleteSessionsClosed).toBe(1);
    expect(result.checkpointReset).toBe(true);
    expect(sessions.find((session) => session.closeReason === "server_restart")).toMatchObject({
      incomplete: true,
      durationMs: 3_300_000,
    });
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(5_100_000);
  });

  it("reports malformed lines without corrupting player state", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    const result = await ingestor.ingest(snapshot("adm:malformed", log(
      "2026-09-20T09:55:00",
      "this is not a timed ADM line",
      "10:00:00 | Player line missing the required structure",
      `10:05:00 | Player "ExampleTwo" (id=${PLAYER_B}) is connected`
    )));

    const state = await storage.read();
    expect(result.malformedLines).toBe(2);
    expect(Object.keys(state.players)).toEqual([PLAYER_B]);
    expect(Object.keys(state.openSessionByPlayer)).toEqual([PLAYER_B]);
  });

  it("retains incomplete live sessions and includes them in playtime queries", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    await ingestor.ingest(snapshot("adm:incomplete", log(
      "2026-09-20T09:55:00",
      `10:05:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`
    )));

    const state = await storage.read();
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(0);
    expect(state.openSessionByPlayer[PLAYER_A]).toBeDefined();
    expect(playerPlaytimeMs(state, PLAYER_A, "2026-09-20T10:30:00Z")).toBe(1_500_000);
    expect(playerPlaytimeMs(state, PLAYER_A, "2026-09-20T09:30:00Z")).toBe(0);
  });

  it("does not move checkpoints backward for temporarily truncated snapshots", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    const full = log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`
    );
    await ingestor.ingest(snapshot("adm:truncation", full));
    const before = (await storage.read()).checkpoints["adm:truncation"];

    const truncated = await ingestor.ingest(snapshot(
      "adm:truncation",
      log("2026-09-20T09:55:00")
    ));
    const afterTruncation = (await storage.read()).checkpoints["adm:truncation"];
    expect(truncated.truncatedSnapshot).toBe(true);
    expect(afterTruncation).toEqual(before);

    const resumed = await ingestor.ingest(snapshot("adm:truncation", log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `10:20:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    )));
    expect(resumed.processedEvents).toBe(1);
    expect((await storage.read()).players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(1_200_000);
  });

  it("does not double-count sessions when a prefix rewrite forces event replay", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    const connected = `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`;
    const disconnected = `10:20:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`;
    await ingestor.ingest(snapshot("adm:rewritten-prefix", log(
      "2026-09-20T09:55:00",
      connected,
      disconnected
    )));

    const replay = await ingestor.ingest(snapshot("adm:rewritten-prefix", log(
      "2026-09-20T09:55:00",
      "09:59:00 | harmless rewritten prefix line",
      connected,
      disconnected
    )));
    const state = await storage.read();

    expect(replay).toMatchObject({
      checkpointReset: true,
      processedEvents: 0,
      duplicateEvents: 2,
      malformedLines: 1,
    });
    expect(Object.values(state.sessions)).toHaveLength(1);
    expect(state.openSessionByPlayer[PLAYER_A]).toBeUndefined();
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(1_200_000);
  });

  it("prevents replay duplicates when the same log rotates to a different source path", async () => {
    const storage = new MemoryStorage();
    const ingestor = new AdmIngestor(storage, new NullLogger());
    const content = log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) is connected`,
      `10:20:00 | Player "ExampleOne" (id=${PLAYER_A}) has been disconnected`
    );
    await ingestor.ingest(snapshot("adm:path-before-rotation", content));
    const replay = await ingestor.ingest(snapshot("adm:path-after-rotation", content));

    expect(replay).toMatchObject({ processedEvents: 0, duplicateEvents: 2 });
    const state = await storage.read();
    expect(Object.values(state.sessions)).toHaveLength(1);
    expect(state.players[PLAYER_A]?.accumulatedPlaytimeMs).toBe(1_200_000);
  });

  it("stores emote and held item as separate deterministic fields", async () => {
    const storage = new MemoryStorage();
    await new AdmIngestor(storage, new NullLogger()).ingest(snapshot("adm:emotes", log(
      "2026-09-20T09:55:00",
      `10:00:00 | Player "ExampleOne" (id=${PLAYER_A}) performed EmoteTauntKiss with SyntheticItem`,
      `10:00:01 | Player "ExampleOne" (id=${PLAYER_A}) performed EmoteSurrender`
    )));

    const emotes = Object.values((await storage.read()).emotes).sort((left, right) =>
      left.occurredAt.localeCompare(right.occurredAt)
    );
    expect(emotes[0]).toMatchObject({ emote: "EmoteTauntKiss", item: "SyntheticItem" });
    expect(emotes[1]).toMatchObject({ emote: "EmoteSurrender" });
    expect(emotes[1]).not.toHaveProperty("item");
  });
});
