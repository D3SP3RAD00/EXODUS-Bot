import { Client, Events, GatewayIntentBits } from "discord.js";
import { join } from "node:path";

import { loadConfig } from "./config.js";
import { CommandHandler } from "./discord/command-handler.js";
import { StructuredConsoleLogger } from "./observability/logger.js";
import { JsonFileStorage } from "./storage/json-file-storage.js";

const config = loadConfig();
const logger = new StructuredConsoleLogger();
const storage = new JsonFileStorage(join(config.DATA_DIRECTORY, "exodus-bot.json"));
const commandHandler = new CommandHandler(storage, logger);
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info("discord_client_ready", { botUser: readyClient.user.tag });
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  await commandHandler.handle(interaction);
});

try {
  await client.login(config.DISCORD_BOT_TOKEN);
} catch (error) {
  logger.error("discord_login_failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
