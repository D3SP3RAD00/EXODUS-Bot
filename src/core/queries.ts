import { AdminFacingError } from "./errors.js";
import { playerPlaytimeMs } from "./session-service.js";
import type { BotState, PlayerRecord } from "./state.js";

export function findPlayerByName(state: BotState, name: string): PlayerRecord {
  const normalized = name.trim().toLowerCase();
  const matches = Object.values(state.players).filter((player) =>
    player.aliases.some((alias) => alias.toLowerCase() === normalized)
  );
  if (matches.length === 0) {
    throw new AdminFacingError("PLAYER_NOT_FOUND", `No tracked player matches “${name}”.`);
  }
  if (matches.length > 1) {
    throw new AdminFacingError("PLAYER_NAME_AMBIGUOUS", `More than one tracked player has used “${name}”.`);
  }
  return matches[0]!;
}

export function formatDuration(milliseconds: number): string {
  const totalMinutes = Math.floor(milliseconds / 60_000);
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "", `${minutes}m`]
    .filter(Boolean)
    .join(" ");
}

export function statusMessage(state: BotState): string {
  const online = Object.keys(state.openSessionByPlayer).length;
  const diagnostics = state.diagnostics;
  return [
    "**!!EXODUS Core Status**",
    `Tracked players: ${Object.keys(state.players).length}`,
    `Online sessions: ${online}`,
    `ADM state: ${diagnostics.status}`,
    `Last successful ingestion: ${diagnostics.lastSuccessfulIngestionAt ?? "None yet"}`,
    `Parser ignored lines: ${diagnostics.ignoredLineCount}`,
    `ADM candidates: ${diagnostics.discoveredCandidates} discovered, ${diagnostics.evaluatedCandidates} evaluated, ${diagnostics.validCandidates} valid, ${diagnostics.rejectedCandidates} rejected`,
    `Last safe error: ${diagnostics.lastSafeErrorCode ?? "None"}`,
  ].join("\n");
}

export function playersMessage(state: BotState): string {
  const online = Object.keys(state.openSessionByPlayer)
    .map((playerId) => state.players[playerId]?.currentName)
    .filter((name): name is string => Boolean(name))
    .sort((a, b) => a.localeCompare(b));
  return online.length
    ? `**Online players (${online.length})**\n${online.map((name) => `• ${name}`).join("\n")}`
    : "No players currently have an active session.";
}

export function playtimeMessage(state: BotState, name: string, asOf = new Date().toISOString()): string {
  const player = findPlayerByName(state, name);
  const live = Boolean(state.openSessionByPlayer[player.playerId]);
  return `**${player.currentName}** — ${formatDuration(playerPlaytimeMs(state, player.playerId, asOf))}${live ? " (online)" : ""}`;
}
