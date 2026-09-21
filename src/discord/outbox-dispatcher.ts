import { REST, Routes } from "discord.js";

import type { DiscordOutboxEntry } from "../core/state.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/storage.js";

export interface DiscordFeedSender {
  send(entry: DiscordOutboxEntry): Promise<void>;
}

export class DiscordRestFeedSender implements DiscordFeedSender {
  private readonly rest: Pick<REST, "post">;

  constructor(token: string, rest?: Pick<REST, "post">) {
    this.rest = rest ?? new REST({ version: "10", timeout: 15_000 }).setToken(token);
  }

  async send(entry: DiscordOutboxEntry): Promise<void> {
    await this.rest.post(Routes.channelMessages(entry.channelId), {
      body: {
        content: entry.content,
        allowed_mentions: { parse: [] },
        nonce: entry.id,
        enforce_nonce: true,
      },
    });
  }
}

export class DiscordOutboxDispatcher {
  private inFlight: Promise<{ delivered: number; failed: number }> | undefined;
  private running = false;

  constructor(
    private readonly storage: Storage,
    private readonly sender: DiscordFeedSender,
    private readonly logger: Logger,
    private readonly now: () => Date = () => new Date(),
    private readonly intervalMs = 5_000
  ) {}

  deliverPending(): Promise<{ delivered: number; failed: number }> {
    if (this.inFlight) return this.inFlight;
    const operation = this.performDelivery();
    this.inFlight = operation;
    void operation.finally(() => {
      if (this.inFlight === operation) this.inFlight = undefined;
    }).catch(() => {});
    return operation;
  }

  async start(signal?: AbortSignal): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      while (!signal?.aborted) {
        await this.deliverPending();
        await wait(this.intervalMs, signal);
      }
    } finally {
      this.running = false;
    }
  }

  private async performDelivery(): Promise<{ delivered: number; failed: number }> {
    const now = this.now();
    const entries = Object.values((await this.storage.read()).discordOutbox)
      .filter((entry) => !entry.nextAttemptAt || Date.parse(entry.nextAttemptAt) <= now.getTime())
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id));
    let delivered = 0;
    let failed = 0;
    const blockedChannels = new Set<string>();

    for (const entry of entries) {
      if (blockedChannels.has(entry.channelId)) continue;
      try {
        await this.sender.send(entry);
        await this.storage.transaction((state) => {
          if (!state.discordOutbox[entry.id]) return;
          delete state.discordOutbox[entry.id];
          state.deliveredNotificationKeys[entry.id] = now.toISOString();
          pruneDeliveredKeys(state.deliveredNotificationKeys);
        });
        delivered += 1;
      } catch {
        failed += 1;
        await this.storage.transaction((state) => {
          const pending = state.discordOutbox[entry.id];
          if (!pending) return;
          pending.attempts += 1;
          const delay = Math.min(300_000, 1_000 * (2 ** Math.min(pending.attempts - 1, 8)));
          pending.nextAttemptAt = new Date(now.getTime() + delay).toISOString();
        });
        this.logger.warn("discord_feed_delivery_failed", {
          code: "DISCORD_FEED_SEND_FAILED",
          feed: entry.feed,
          attempts: entry.attempts + 1,
        });
        blockedChannels.add(entry.channelId);
      }
    }
    return { delivered, failed };
  }
}

function pruneDeliveredKeys(keys: Record<string, string>): void {
  const entries = Object.entries(keys);
  if (entries.length <= 20_000) return;
  entries.sort((left, right) => left[1].localeCompare(right[1]));
  for (const [key] of entries.slice(0, entries.length - 20_000)) delete keys[key];
}

function wait(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timeout = setTimeout(finish, milliseconds);
    function finish(): void {
      signal?.removeEventListener("abort", abort);
      resolve();
    }
    function abort(): void {
      clearTimeout(timeout);
      resolve();
    }
    signal?.addEventListener("abort", abort, { once: true });
  });
}
