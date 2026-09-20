export type SessionCloseReason = "disconnect" | "reconnect" | "server_restart";

export type PlayerRecord = {
  playerId: string;
  currentName: string;
  aliases: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  accumulatedPlaytimeMs: number;
};

export type PlayerSession = {
  sessionId: string;
  playerId: string;
  playerName: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  closeReason?: SessionCloseReason;
  incomplete: boolean;
};

export type IngestionCheckpoint = {
  sourceId: string;
  processedLineCount: number;
  prefixHash: string;
  logStartedAt: string;
  updatedAt: string;
};

export type BotState = {
  schemaVersion: 1;
  players: Record<string, PlayerRecord>;
  sessions: Record<string, PlayerSession>;
  openSessionByPlayer: Record<string, string>;
  processedEventFingerprints: Record<string, string>;
  checkpoints: Record<string, IngestionCheckpoint>;
  domains: {
    economy: { accounts: Record<string, unknown> };
    factions: {
      factions: Record<string, unknown>;
      memberships: Record<string, unknown>;
    };
  };
};

export function createEmptyState(): BotState {
  return {
    schemaVersion: 1,
    players: {},
    sessions: {},
    openSessionByPlayer: {},
    processedEventFingerprints: {},
    checkpoints: {},
    domains: {
      economy: { accounts: {} },
      factions: { factions: {}, memberships: {} },
    },
  };
}

export function cloneState(state: BotState): BotState {
  return structuredClone(state);
}
