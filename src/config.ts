import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
  z.string().min(1).optional()
);

const configSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/),
  DATA_DIRECTORY: z.string().min(1).default("./data"),
  NITRADO_TOKEN: z.string().min(1),
  NITRADO_SERVICE_ID: z.coerce.number().int().positive(),
  NITRADO_LOG_DIRECTORY: optionalNonEmptyString,
  NITRADO_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).default(60_000),
  NITRADO_REQUEST_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(15_000),
  NITRADO_RETRY_LIMIT: z.coerce.number().int().min(0).max(10).default(3),
  NITRADO_BACKOFF_BASE_MS: z.coerce.number().int().min(100).default(1_000),
  NITRADO_BACKOFF_MAX_MS: z.coerce.number().int().min(1_000).default(30_000),
  NITRADO_DISCOVERY_MAX_DEPTH: z.coerce.number().int().min(0).max(20).default(8),
  NITRADO_DISCOVERY_MAX_ENTRIES: z.coerce.number().int().min(1).default(10_000),
});

export type BotConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  return configSchema.parse(environment);
}
