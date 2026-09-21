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

export type PlayerEmoteRecord = {
  eventKey: string;
  playerId: string;
  playerName: string;
  occurredAt: string;
  emote: string;
  item?: string;
};

export type IngestionCheckpoint = {
  sourceId: string;
  processedLineCount: number;
  prefixHash: string;
  logStartedAt: string;
  updatedAt: string;
};

export type IngestionStatus =
  | "never"
  | "success"
  | "unchanged"
  | "no_adm"
  | "authorization_failure"
  | "wrong_service"
  | "invalid_directory"
  | "download_failure"
  | "malformed_adm"
  | "error";

export type IngestionDiagnostics = {
  status: IngestionStatus;
  lastAttemptAt?: string;
  lastSuccessfulIngestionAt?: string;
  lastSafeErrorCode?: string;
  ignoredLineCount: number;
  discoveredCandidates: number;
  evaluatedCandidates: number;
  validCandidates: number;
  rejectedCandidates: number;
};

export const feedKinds = [
  "join_leave",
  "player_count",
  "killfeed",
  "raid_build",
  "bot_status",
  "admin_audit",
] as const;

export type FeedKind = typeof feedKinds[number];

export type FeedSubscription = {
  channelId: string;
  armed: boolean;
  configuredAt: string;
  lastPlayerCount?: number;
};

export type DiscordOutboxEntry = {
  id: string;
  feed: FeedKind;
  channelId: string;
  content: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt?: string;
};

export type BotState = {
  schemaVersion: 2;
  players: Record<string, PlayerRecord>;
  sessions: Record<string, PlayerSession>;
  emotes: Record<string, PlayerEmoteRecord>;
  openSessionByPlayer: Record<string, string>;
  processedEventKeys: Record<string, string>;
  checkpoints: Record<string, IngestionCheckpoint>;
  diagnostics: IngestionDiagnostics;
  feedSubscriptions: Partial<Record<FeedKind, FeedSubscription>>;
  discordOutbox: Record<string, DiscordOutboxEntry>;
  deliveredNotificationKeys: Record<string, string>;
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
    schemaVersion: 2,
    players: {},
    sessions: {},
    emotes: {},
    openSessionByPlayer: {},
    processedEventKeys: {},
    checkpoints: {},
    diagnostics: {
      status: "never",
      ignoredLineCount: 0,
      discoveredCandidates: 0,
      evaluatedCandidates: 0,
      validCandidates: 0,
      rejectedCandidates: 0,
    },
    feedSubscriptions: {},
    discordOutbox: {},
    deliveredNotificationKeys: {},
    domains: {
      economy: { accounts: {} },
      factions: { factions: {}, memberships: {} },
    },
  };
}

export function migrateBotState(state: Record<string, unknown>): BotState {
  const migrated = structuredClone(state) as unknown as BotState;
  migrated.schemaVersion = 2;
  migrated.emotes ??= {};
  migrated.diagnostics ??= {
    status: "never",
    ignoredLineCount: 0,
    discoveredCandidates: 0,
    evaluatedCandidates: 0,
    validCandidates: 0,
    rejectedCandidates: 0,
  };
  migrated.diagnostics.discoveredCandidates ??= 0;
  migrated.diagnostics.evaluatedCandidates ??= 0;
  migrated.diagnostics.validCandidates ??= 0;
  migrated.diagnostics.rejectedCandidates ??= 0;
  migrated.feedSubscriptions ??= {};
  migrated.discordOutbox ??= {};
  migrated.deliveredNotificationKeys ??= {};
  return migrated;
}

export function cloneState(state: BotState): BotState {
  return structuredClone(state);
}
