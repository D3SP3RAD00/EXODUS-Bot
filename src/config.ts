import { z } from "zod";

const configSchema = z.object({
  DISCORD_BOT_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().regex(/^\d+$/),
  DISCORD_GUILD_ID: z.string().regex(/^\d+$/),
  DATA_DIRECTORY: z.string().min(1).default("./data"),
});

export type BotConfig = z.infer<typeof configSchema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): BotConfig {
  return configSchema.parse(environment);
}
