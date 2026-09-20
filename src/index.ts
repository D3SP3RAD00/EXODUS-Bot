import { Client, Events, GatewayIntentBits } from "discord.js";
import { join } from "node:path";

import { NitradoAdmLogAdapter } from "./adapters/nitrado-adm-log-adapter.js";
import { loadConfig } from "./config.js";
import { AdmIngestor } from "./dayz/adm-ingestor.js";
import { CommandHandler } from "./discord/command-handler.js";
import { NitradoAdmPoller } from "./nitrado/nitrado-poller.js";
import { NitradoReadOnlyClient } from "./nitrado/nitrado-readonly-client.js";
import { StructuredConsoleLogger } from "./observability/logger.js";
import { JsonFileStorage } from "./storage/json-file-storage.js";

const config = loadConfig();
const logger = new StructuredConsoleLogger();
const storage = new JsonFileStorage(join(config.DATA_DIRECTORY, "exodus-bot.json"));
const commandHandler = new CommandHandler(storage, logger);
const nitradoClient = new NitradoReadOnlyClient({
  token: config.NITRADO_TOKEN,
  serviceId: config.NITRADO_SERVICE_ID,
  requestTimeoutMs: config.NITRADO_REQUEST_TIMEOUT_MS,
  retryLimit: config.NITRADO_RETRY_LIMIT,
  backoffBaseMs: config.NITRADO_BACKOFF_BASE_MS,
  backoffMaxMs: config.NITRADO_BACKOFF_MAX_MS,
  discoveryMaxDepth: config.NITRADO_DISCOVERY_MAX_DEPTH,
  discoveryMaxEntries: config.NITRADO_DISCOVERY_MAX_ENTRIES,
  maxDownloadBytes: config.NITRADO_MAX_DOWNLOAD_BYTES,
  downloadHostAllowlist: config.NITRADO_DOWNLOAD_HOSTS.split(",").map((host) => host.trim()).filter(Boolean),
  ...(config.NITRADO_LOG_DIRECTORY ? { logDirectory: config.NITRADO_LOG_DIRECTORY } : {}),
});
const ingestor = new AdmIngestor(storage, logger);
const nitradoSource = new NitradoAdmLogAdapter(nitradoClient);
const nitradoPoller = new NitradoAdmPoller(
  nitradoSource,
  ingestor,
  logger,
  config.NITRADO_POLL_INTERVAL_MS
);
const shutdown = new AbortController();
let pollerTask: Promise<void> | undefined;
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  logger.info("discord_client_ready", { botUser: readyClient.user.tag });
  pollerTask = nitradoPoller.start(shutdown.signal);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    shutdown.abort();
    client.destroy();
    void pollerTask?.catch(() => {});
  });
}

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
