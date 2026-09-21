import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AdmIngestor } from "../src/dayz/adm-ingestor.js";
import { recordIngestionError } from "../src/diagnostics/ingestion-diagnostics.js";
import { configureFeedSubscriptions } from "../src/discord/feed-service.js";
import { DiscordOutboxDispatcher, DiscordRestFeedSender } from "../src/discord/outbox-dispatcher.js";
import { NullLogger, type LogContext } from "../src/observability/logger.js";
import { JsonFileStorage } from "../src/storage/json-file-storage.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

const PLAYER = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const JOIN_CHANNEL = "12345678901234567";
const COUNT_CHANNEL = "23456789012345678";
const STATUS_CHANNEL = "34567890123456789";
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function log(...lines: string[]): string {
  return [
    "******************************************************************************",
    "AdminLog started on 2026-09-21 at 05:56:10",
    ...lines,
    "",
  ].join("\n");
}

function snapshot(content: string, observedAt = "2026-09-21T07:20:00Z") {
  return { sourceId: "nitrado:synthetic", content, observedAt };
}

describe("deterministic Discord feeds", () => {
  it("uses the persistent outbox ID as Discord's enforced idempotency nonce", async () => {
    const post = vi.fn(async () => ({}));
    const sender = new DiscordRestFeedSender("synthetic-token", { post } as never);
    await sender.send({
      id: "deterministic-outbox-id1",
      feed: "join_leave",
      channelId: JOIN_CHANNEL,
      content: "safe message",
      createdAt: "2026-09-21T07:00:00Z",
      attempts: 0,
    });
    expect(post).toHaveBeenCalledWith(expect.stringContaining(JOIN_CHANNEL), {
      body: {
        content: "safe message",
        allowed_mentions: { parse: [] },
        nonce: "deterministic-outbox-id1",
        enforce_nonce: true,
      },
    });
  });

  it("does not flood historical events when feeds are first enabled", async () => {
    const storage = new MemoryStorage();
    await configureFeedSubscriptions(storage, {
      join_leave: JOIN_CHANNEL,
      player_count: COUNT_CHANNEL,
    }, "2026-09-21T07:00:00Z");
    const ingestor = new AdmIngestor(storage, new NullLogger());
    await ingestor.ingest(snapshot(log(
      `07:10:07 | Player "ExampleSurvivor" (id=${PLAYER}) is connected`,
      "07:11:41 | ##### PlayerList log: 1 players"
    )));

    expect((await storage.read()).discordOutbox).toEqual({});
  });

  it("routes only new join, leave, and changed player-count events", async () => {
    const storage = new MemoryStorage();
    await configureFeedSubscriptions(storage, {
      join_leave: JOIN_CHANNEL,
      player_count: COUNT_CHANNEL,
    }, "2026-09-21T07:00:00Z");
    const ingestor = new AdmIngestor(storage, new NullLogger());
    await ingestor.ingest(snapshot(log(
      `07:10:07 | Player "ExampleSurvivor" (id=${PLAYER}) is connected`,
      "07:11:41 | ##### PlayerList log: 1 players"
    )));
    await ingestor.ingest(snapshot(log(
      `07:10:07 | Player "ExampleSurvivor" (id=${PLAYER}) is connected`,
      "07:11:41 | ##### PlayerList log: 1 players",
      `07:20:00 | Player "ExampleSurvivor" (id=${PLAYER}) has been disconnected`,
      "07:20:01 | ##### PlayerList log: 0 players"
    ), "2026-09-21T07:20:02Z"));

    const messages = Object.values((await storage.read()).discordOutbox).map((entry) => entry.content).sort();
    expect(messages).toEqual(["🔴 ExampleSurvivor left.", "👥 Players online: 0"].sort());
  });

  it("keeps every unset feed disabled without affecting ingestion", async () => {
    const storage = new MemoryStorage();
    await configureFeedSubscriptions(storage, {}, "2026-09-21T07:00:00Z");
    await new AdmIngestor(storage, new NullLogger()).ingest(snapshot(log(
      `07:10:07 | Player "ExampleSurvivor" (id=${PLAYER}) is connected`
    )));
    const state = await storage.read();
    expect(state.players[PLAYER]).toBeDefined();
    expect(state.discordOutbox).toEqual({});
  });

  it("cancels pending messages when a feed is disabled or moved", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((state) => {
      state.feedSubscriptions.join_leave = {
        channelId: JOIN_CHANNEL, armed: true, configuredAt: "2026-09-21T07:00:00Z",
      };
      state.discordOutbox.pending = {
        id: "pending", feed: "join_leave", channelId: JOIN_CHANNEL, content: "old", createdAt: "2026-09-21T07:00:00Z", attempts: 0,
      };
    });
    await configureFeedSubscriptions(storage, {}, "2026-09-21T07:01:00Z");
    const state = await storage.read();
    expect(state.feedSubscriptions.join_leave).toBeUndefined();
    expect(state.discordOutbox).toEqual({});
  });

  it("does not publish emotes, IDs, coordinates, raw lines, killfeed, or raid/build guesses", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((state) => {
      state.checkpoints.existing = {
        sourceId: "existing", processedLineCount: 1, prefixHash: "safe", logStartedAt: "earlier", updatedAt: "earlier",
      };
    });
    await configureFeedSubscriptions(storage, {
      join_leave: JOIN_CHANNEL,
      killfeed: COUNT_CHANNEL,
      raid_build: STATUS_CHANNEL,
    }, "2026-09-21T07:00:00Z");
    await new AdmIngestor(storage, new NullLogger()).ingest(snapshot(log(
      `07:10:07 | Player "@everyone_*" (id=${PLAYER} pos=<1000.0, 2000.0, 100.0>) is connected`,
      `07:16:27 | Player "@everyone_*" (id=${PLAYER} pos=<1001.0, 2001.0, 101.0>) performed EmoteSurrender with SyntheticItem`
    )));

    const entries = Object.values((await storage.read()).discordOutbox);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.feed).toBe("join_leave");
    const output = entries[0]?.content ?? "";
    expect(output).toContain("@\u200beveryone");
    expect(output).not.toContain(PLAYER);
    expect(output).not.toContain("1000");
    expect(output).not.toContain("Emote");
    expect(output).not.toContain("SyntheticItem");
  });

  it("persists pending notifications across restart and delivers each outbox ID once", async () => {
    const directory = await mkdtemp(join(tmpdir(), "exodus-outbox-"));
    temporaryDirectories.push(directory);
    const file = join(directory, "state.json");
    const firstStorage = new JsonFileStorage(file);
    await firstStorage.transaction((state) => {
      state.checkpoints.existing = {
        sourceId: "existing", processedLineCount: 1, prefixHash: "safe", logStartedAt: "earlier", updatedAt: "earlier",
      };
    });
    await configureFeedSubscriptions(firstStorage, { join_leave: JOIN_CHANNEL }, "2026-09-21T07:00:00Z");
    await new AdmIngestor(firstStorage, new NullLogger()).ingest(snapshot(log(
      `07:10:07 | Player "ExampleSurvivor" (id=${PLAYER}) is connected`
    )));
    expect(Object.keys((await firstStorage.read()).discordOutbox)).toHaveLength(1);

    const restartedStorage = new JsonFileStorage(file);
    const send = vi.fn(async () => {});
    const dispatcher = new DiscordOutboxDispatcher(restartedStorage, { send }, new NullLogger());
    await expect(dispatcher.deliverPending()).resolves.toEqual({ delivered: 1, failed: 0 });
    await expect(dispatcher.deliverPending()).resolves.toEqual({ delivered: 0, failed: 0 });
    expect(send).toHaveBeenCalledTimes(1);
    const state = await restartedStorage.read();
    expect(state.discordOutbox).toEqual({});
    expect(Object.keys(state.deliveredNotificationKeys)).toHaveLength(1);
  });

  it("retains failed sends with bounded retry state and succeeds later", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((state) => {
      state.discordOutbox.pending = {
        id: "pending", feed: "join_leave", channelId: JOIN_CHANNEL, content: "safe", createdAt: "2026-09-21T07:00:00Z", attempts: 0,
      };
    });
    let now = new Date("2026-09-21T07:00:00Z");
    const send = vi.fn()
      .mockRejectedValueOnce(new Error("Authorization: Bot private-value"))
      .mockResolvedValueOnce(undefined);
    const dispatcher = new DiscordOutboxDispatcher(storage, { send }, new NullLogger(), () => now);

    await expect(dispatcher.deliverPending()).resolves.toEqual({ delivered: 0, failed: 1 });
    expect((await storage.read()).discordOutbox.pending).toMatchObject({ attempts: 1 });
    now = new Date("2026-09-21T07:00:02Z");
    await expect(dispatcher.deliverPending()).resolves.toEqual({ delivered: 1, failed: 0 });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent delivery attempts into one single-flight send", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((state) => {
      state.discordOutbox.pending = {
        id: "pending", feed: "join_leave", channelId: JOIN_CHANNEL, content: "safe", createdAt: "2026-09-21T07:00:00Z", attempts: 0,
      };
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const send = vi.fn(async () => gate);
    const dispatcher = new DiscordOutboxDispatcher(storage, { send }, new NullLogger());

    const first = dispatcher.deliverPending();
    const second = dispatcher.deliverPending();
    expect(first).toBe(second);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { delivered: 1, failed: 0 },
      { delivered: 1, failed: 0 },
    ]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("routes only stable safe error codes to operational feeds", async () => {
    const storage = new MemoryStorage();
    await storage.transaction((state) => {
      state.checkpoints.existing = {
        sourceId: "existing", processedLineCount: 1, prefixHash: "safe", logStartedAt: "earlier", updatedAt: "earlier",
      };
    });
    await configureFeedSubscriptions(storage, {
      bot_status: STATUS_CHANNEL,
      admin_audit: COUNT_CHANNEL,
    }, "2026-09-21T07:00:00Z");
    await recordIngestionError(
      storage,
      { code: "NITRADO_AUTHORIZATION_FAILED", message: "token=private https://signed.example/file?sig=private" },
      "2026-09-21T07:00:01Z"
    );
    const output = JSON.stringify(Object.values((await storage.read()).discordOutbox));
    expect(output).toContain("NITRADO_AUTHORIZATION_FAILED");
    expect(output).not.toContain("token=");
    expect(output).not.toContain("signed.example");
  });

  it("never writes private source data to structured ingestion logs", async () => {
    const storage = new MemoryStorage();
    const records: unknown[] = [];
    const logger = {
      info: (event: string, context?: LogContext) => records.push({ event, context }),
      warn: (event: string, context?: LogContext) => records.push({ event, context }),
      error: (event: string, context?: LogContext) => records.push({ event, context }),
    };
    await new AdmIngestor(storage, logger).ingest({
      sourceId: "nitrado:/private/path/server.ADM?token=private",
      content: log("07:10:07 | ignored private response body"),
      observedAt: "2026-09-21T07:20:00Z",
    });

    const serialized = JSON.stringify(records);
    expect(serialized).not.toContain("private/path");
    expect(serialized).not.toContain("token=");
    expect(serialized).not.toContain("response body");
  });
});
