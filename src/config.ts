import { z } from "zod";

const optionalNonEmptyString = z.preprocess(
  (value) => value === "" ? undefined : value,
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
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/),
  DATA_DIRECTORY: z.string().min(1).default("./data"),
  NITRADO_TOKEN: z.string().min(1),
  NITRADO_SERVICE_ID: positiveIntegerString,
  NITRADO_LOG_DIRECTORY: optionalNonEmptyString,
  NITRADO_DOWNLOAD_HOSTS: z.string().min(1).default("nitrado.net,*.nitrado.net"),
  NITRADO_MAX_DOWNLOAD_BYTES: integerEnvironment(1).default(16_777_216),
  NITRADO_POLL_INTERVAL_MS: integerEnvironment(5_000).default(60_000),
  NITRADO_REQUEST_TIMEOUT_MS: integerEnvironment(1_000).default(15_000),
  NITRADO_RETRY_LIMIT: integerEnvironment(0, 10).default(3),
  NITRADO_BACKOFF_BASE_MS: integerEnvironment(100).default(1_000),
  NITRADO_BACKOFF_MAX_MS: integerEnvironment(1_000).default(30_000),
  NITRADO_DISCOVERY_MAX_DEPTH: integerEnvironment(0, 20).default(8),
  NITRADO_DISCOVERY_MAX_ENTRIES: integerEnvironment(1).default(10_000),
});

export type BotConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  return configSchema.parse(environment);
}
