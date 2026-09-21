import { createHash } from "node:crypto";

import type { BotState, FeedKind } from "../core/state.js";
import type { AdminLogEvent } from "../dayz/admin-log.js";
import type { Storage } from "../storage/storage.js";

export type FeedChannelConfig = Partial<Record<FeedKind, string>>;

export async function configureFeedSubscriptions(
  storage: Storage,
  channels: FeedChannelConfig,
  configuredAt: string
): Promise<void> {
  await storage.transaction((state) => {
    for (const feed of [
      "join_leave", "player_count", "killfeed", "raid_build", "bot_status", "admin_audit",
    ] as const) {
      const channelId = channels[feed];
      const existing = state.feedSubscriptions[feed];
      if (!channelId) {
        discardPendingFeed(state, feed);
        delete state.feedSubscriptions[feed];
      } else if (existing?.channelId !== channelId) {
        discardPendingFeed(state, feed);
        state.feedSubscriptions[feed] = {
          channelId,
          armed: Object.keys(state.checkpoints).length > 0,
          configuredAt,
        };
      }
    }
  });
}

function discardPendingFeed(state: BotState, feed: FeedKind): void {
  for (const [id, entry] of Object.entries(state.discordOutbox)) {
    if (entry.feed === feed) delete state.discordOutbox[id];
  }
}

export function routeAdminLogEvent(
  state: BotState,
  event: AdminLogEvent,
  eventKey: string,
  createdAt: string
): void {
  if (event.type === "player_connected") {
    enqueue(state, "join_leave", eventKey, `🟢 ${safePlayerName(event.playerName)} joined.`, createdAt);
  } else if (event.type === "player_disconnected") {
    enqueue(state, "join_leave", eventKey, `🔴 ${safePlayerName(event.playerName)} left.`, createdAt);
  } else if (event.type === "player_count") {
    const subscription = state.feedSubscriptions.player_count;
    if (subscription?.armed && subscription.lastPlayerCount !== event.count) {
      enqueue(state, "player_count", eventKey, `👥 Players online: ${event.count}`, createdAt);
      subscription.lastPlayerCount = event.count;
    }
  }
}

export function enqueueOperationalSummary(
  state: BotState,
  key: string,
  content: string,
  createdAt: string
): void {
  enqueue(state, "bot_status", key, content, createdAt);
  enqueue(state, "admin_audit", key, content, createdAt);
}

export function armFeedSubscriptions(state: BotState): void {
  for (const subscription of Object.values(state.feedSubscriptions)) {
    if (subscription) subscription.armed = true;
  }
}

function enqueue(state: BotState, feed: FeedKind, key: string, content: string, createdAt: string): void {
  const subscription = state.feedSubscriptions[feed];
  if (!subscription?.armed) return;
  const id = createHash("sha256")
    .update(`${feed}|${subscription.channelId}|${key}`)
    .digest("hex")
    .slice(0, 24);
  if (state.discordOutbox[id] || state.deliveredNotificationKeys[id]) return;
  state.discordOutbox[id] = {
    id,
    feed,
    channelId: subscription.channelId,
    content,
    createdAt,
    attempts: 0,
  };
}

function safePlayerName(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/([\\`*_~|>])/g, "\\$1")
    .trim()
    .slice(0, 64) || "Unknown survivor";
}
