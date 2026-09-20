import { createHash } from "node:crypto";

import type { AdminLogEvent } from "../dayz/admin-log.js";
import type { BotState, PlayerRecord, PlayerSession, SessionCloseReason } from "./state.js";

function epoch(isoTimestamp: string): number | undefined {
  const value = Date.parse(isoTimestamp);
  return Number.isFinite(value) ? value : undefined;
}

function duration(startedAt: string, endedAt: string): number {
  const start = epoch(startedAt);
  const end = epoch(endedAt);
  if (start === undefined || end === undefined || end <= start) return 0;
  return end - start;
}

function createSessionId(event: AdminLogEvent): string {
  return createHash("sha256")
    .update(`${event.playerId}|${event.occurredAt}|${event.fingerprint}|${event.occurrence}`)
    .digest("hex");
}

function upsertPlayer(state: BotState, event: AdminLogEvent): PlayerRecord {
  const existing = state.players[event.playerId];
  if (!existing) {
    const created: PlayerRecord = {
      playerId: event.playerId,
      currentName: event.playerName,
      aliases: [event.playerName],
      firstSeenAt: event.occurredAt,
      lastSeenAt: event.occurredAt,
      accumulatedPlaytimeMs: 0,
    };
    state.players[event.playerId] = created;
    return created;
  }
  existing.currentName = event.playerName;
  existing.lastSeenAt = event.occurredAt;
  if (!existing.aliases.includes(event.playerName)) existing.aliases.push(event.playerName);
  return existing;
}

export function closeSession(
  state: BotState,
  playerId: string,
  endedAt: string,
  reason: SessionCloseReason
): PlayerSession | undefined {
  const openId = state.openSessionByPlayer[playerId];
  if (!openId) return undefined;
  const session = state.sessions[openId];
  if (!session || session.endedAt) {
    delete state.openSessionByPlayer[playerId];
    return undefined;
  }
  const sessionDuration = duration(session.startedAt, endedAt);
  session.endedAt = endedAt;
  session.durationMs = sessionDuration;
  session.closeReason = reason;
  session.incomplete = reason !== "disconnect";
  delete state.openSessionByPlayer[playerId];
  const player = state.players[playerId];
  if (player) player.accumulatedPlaytimeMs += sessionDuration;
  return session;
}

export function closeOpenSessionsForRestart(state: BotState, restartedAt: string): number {
  let closed = 0;
  for (const playerId of Object.keys(state.openSessionByPlayer)) {
    if (closeSession(state, playerId, restartedAt, "server_restart")) closed += 1;
  }
  return closed;
}

export function applyAdminLogEvent(state: BotState, event: AdminLogEvent): void {
  upsertPlayer(state, event);
  if (event.type === "player_connected") {
    closeSession(state, event.playerId, event.occurredAt, "reconnect");
    const id = createSessionId(event);
    state.sessions[id] = {
      sessionId: id,
      playerId: event.playerId,
      playerName: event.playerName,
      startedAt: event.occurredAt,
      incomplete: false,
    };
    state.openSessionByPlayer[event.playerId] = id;
  } else if (event.type === "player_disconnected") {
    closeSession(state, event.playerId, event.occurredAt, "disconnect");
  }
}

export function playerPlaytimeMs(
  state: BotState,
  playerId: string,
  asOf: string = new Date().toISOString()
): number {
  const player = state.players[playerId];
  if (!player) return 0;
  const openId = state.openSessionByPlayer[playerId];
  const open = openId ? state.sessions[openId] : undefined;
  return player.accumulatedPlaytimeMs + (open ? duration(open.startedAt, asOf) : 0);
}
