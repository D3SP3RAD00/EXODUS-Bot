import { loadConfig } from "../config.js";
import { StructuredConsoleLogger } from "../observability/logger.js";
import { registerGuildCommands } from "./command-registration.js";

const logger = new StructuredConsoleLogger();

try {
  const config = loadConfig();
  await registerGuildCommands({
    token: config.DISCORD_BOT_TOKEN,
    applicationId: config.DISCORD_APPLICATION_ID,
    guildId: config.DISCORD_GUILD_ID,
    logger,
  });
} catch {
  process.exitCode = 1;
}
