import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createEmptyState } from "../src/core/state.js";
import { JsonFileStorage } from "../src/storage/json-file-storage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function storageFile(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "exodus-storage-gate-"));
  temporaryDirectories.push(directory);
  return join(directory, "state.json");
}

describe("JsonFileStorage", () => {
  it("serializes concurrent transactions without lost updates", async () => {
    const storage = new JsonFileStorage(await storageFile());
    await Promise.all([
      storage.transaction(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.domains.economy.accounts.first = { value: 1 };
      }),
      storage.transaction((state) => {
        state.domains.economy.accounts.second = { value: 2 };
      }),
    ]);
    const state = await storage.read();
    expect(state.domains.economy.accounts).toEqual({
      first: { value: 1 },
      second: { value: 2 },
    });
  });

  it("recovers the latest valid state when the primary JSON is corrupted", async () => {
    const file = await storageFile();
    const storage = new JsonFileStorage(file);
    await storage.transaction((state) => {
      state.domains.factions.factions.alpha = { name: "Alpha" };
    });
    await writeFile(file, "{interrupted", "utf8");

    const recovered = await new JsonFileStorage(file).read();
    expect(recovered.domains.factions.factions.alpha).toEqual({ name: "Alpha" });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it("recovers a durable temporary file after interruption before rename", async () => {
    const file = await storageFile();
    const pending = createEmptyState();
    pending.domains.economy.accounts.pending = { balance: 50 };
    await writeFile(`${file}.tmp`, JSON.stringify(pending), "utf8");

    const recovered = await new JsonFileStorage(file).read();
    expect(recovered.domains.economy.accounts.pending).toEqual({ balance: 50 });
    expect(JSON.parse(await readFile(file, "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it("fails closed when every available state file is corrupt", async () => {
    const file = await storageFile();
    await writeFile(file, "broken", "utf8");
    await writeFile(`${file}.bak`, "also broken", "utf8");
    await expect(new JsonFileStorage(file).read()).rejects.toThrow("no valid recovery file");
  });

  it("migrates the production schema without losing existing player data", async () => {
    const file = await storageFile();
    const legacy = createEmptyState() as unknown as Record<string, unknown>;
    legacy.schemaVersion = 1;
    delete legacy.emotes;
    delete legacy.diagnostics;
    delete legacy.feedSubscriptions;
    delete legacy.discordOutbox;
    delete legacy.deliveredNotificationKeys;
    (legacy.players as Record<string, unknown>).PRIVATE = {
      playerId: "PRIVATE",
      currentName: "ExampleSurvivor",
      aliases: ["ExampleSurvivor"],
      firstSeenAt: "2026-09-20T10:00:00Z",
      lastSeenAt: "2026-09-20T10:00:00Z",
      accumulatedPlaytimeMs: 60_000,
    };
    await writeFile(file, JSON.stringify(legacy), "utf8");

    const migrated = await new JsonFileStorage(file).read();
    expect(migrated.schemaVersion).toBe(2);
    expect(migrated.players.PRIVATE?.currentName).toBe("ExampleSurvivor");
    expect(migrated.diagnostics).toEqual({
      status: "never",
      ignoredLineCount: 0,
      discoveredCandidates: 0,
      evaluatedCandidates: 0,
      validCandidates: 0,
      rejectedCandidates: 0,
    });
    expect(migrated.discordOutbox).toEqual({});
  });
});
