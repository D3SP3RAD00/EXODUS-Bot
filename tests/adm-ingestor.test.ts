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

  it("prevents duplicate ADM lines from creating duplicate sessions", async () => {
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
    expect(first).toMatchObject({ processedEvents: 2, duplicateEvents: 1 });
    expect(second.processedEvents).toBe(0);
    expect(Object.values(state.sessions)).toHaveLength(1);
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
  });
});
