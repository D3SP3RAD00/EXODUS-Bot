import { isAbsolute } from "node:path";
import { z } from "zod";

const requiredString = z.string().trim().min(1);

const discordSnowflake = z.string().regex(/^[1-9]\d{16,19}$/).refine(
  (value) => BigInt(value) <= 18_446_744_073_709_551_615n,
  "Must be a valid Discord snowflake."
);

const optionalDiscordSnowflake = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  discordSnowflake.optional()
);

const optionalLogDirectory = z.preprocess(
  (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
  z.string().min(1).optional()
);

const positiveIntegerString = z.string().regex(/^[1-9]\d*$/).transform((value, context) => {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    context.addIssue({ code: "custom", message: "Must be a positive safe integer." });
    return z.NEVER;
  }
  return parsed;
});

const integerEnvironment = (minimum: number, maximum?: number) => {
  let schema = z.string().regex(/^\d+$/).transform(Number).refine(Number.isSafeInteger);
  schema = schema.refine((value) => value >= minimum);
  if (maximum !== undefined) schema = schema.refine((value) => value <= maximum);
  return schema;
};

const configSchema = z.object({
  DISCORD_BOT_TOKEN: requiredString,
  DISCORD_APPLICATION_ID: discordSnowflake,
  DISCORD_GUILD_ID: discordSnowflake,
  DISCORD_JOIN_LEAVE_CHANNEL_ID: optionalDiscordSnowflake,
  DISCORD_PLAYER_COUNT_CHANNEL_ID: optionalDiscordSnowflake,
  DISCORD_KILLFEED_CHANNEL_ID: optionalDiscordSnowflake,
  DISCORD_RAID_BUILD_CHANNEL_ID: optionalDiscordSnowflake,
  DISCORD_BOT_STATUS_CHANNEL_ID: optionalDiscordSnowflake,
  DISCORD_ADMIN_AUDIT_CHANNEL_ID: optionalDiscordSnowflake,
  DATA_DIRECTORY: requiredString.refine(isAbsolute, "Must be an absolute path."),
  NITRADO_TOKEN: requiredString,
  NITRADO_SERVICE_ID: positiveIntegerString,
  NITRADO_LOG_DIRECTORY: optionalLogDirectory,
  NITRADO_DOWNLOAD_HOSTS: z.string().min(1).default("nitrado.net,*.nitrado.net"),
  NITRADO_MAX_DOWNLOAD_BYTES: integerEnvironment(1).default(16_777_216),
  NITRADO_POLL_INTERVAL_MS: integerEnvironment(5_000).default(60_000),
  NITRADO_REQUEST_TIMEOUT_MS: integerEnvironment(1_000).default(15_000),
  NITRADO_RETRY_LIMIT: integerEnvironment(0, 10).default(3),
  NITRADO_BACKOFF_BASE_MS: integerEnvironment(100).default(1_000),
  NITRADO_BACKOFF_MAX_MS: integerEnvironment(1_000).default(30_000),
  NITRADO_DISCOVERY_MAX_DEPTH: integerEnvironment(0, 20).default(8),
  NITRADO_DISCOVERY_MAX_ENTRIES: integerEnvironment(1).default(10_000),
}).superRefine((config, context) => {
  if (config.NITRADO_BACKOFF_BASE_MS > config.NITRADO_BACKOFF_MAX_MS) {
    context.addIssue({
      code: "custom",
      path: ["NITRADO_BACKOFF_BASE_MS"],
      message: "Must not exceed NITRADO_BACKOFF_MAX_MS.",
    });
  }
});

export type BotConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  return configSchema.parse(environment);
}
