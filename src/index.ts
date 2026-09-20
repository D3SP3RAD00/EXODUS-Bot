import { Client, Events, GatewayIntentBits } from "discord.js";

import { NitradoAdmLogAdapter } from "./adapters/nitrado-adm-log-adapter.js";
import { loadConfig } from "./config.js";
import { AdmIngestor } from "./dayz/adm-ingestor.js";
import { CommandHandler } from "./discord/command-handler.js";
import { NitradoAdmPoller } from "./nitrado/nitrado-poller.js";
import { NitradoReadOnlyClient } from "./nitrado/nitrado-readonly-client.js";
import { StructuredConsoleLogger } from "./observability/logger.js";
import { instanceLeasePath, storageFilePath } from "./runtime/paths.js";
import { RuntimeLifecycle } from "./runtime/runtime-lifecycle.js";
import { SingleInstanceLease } from "./runtime/single-instance-lease.js";
import { JsonFileStorage } from "./storage/json-file-storage.js";

const logger = new StructuredConsoleLogger();

async function start(): Promise<void> {
  const config = loadConfig();
  const lease = await SingleInstanceLease.acquire(instanceLeasePath(config.DATA_DIRECTORY));
  const abortController = new AbortController();
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const lifecycle = new RuntimeLifecycle({
    abortController,
    closeDiscord: () => client.destroy(),
    releaseLease: () => lease.release(),
    logger,
  });

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void lifecycle.shutdown(signal).catch((error) => {
        logger.error("application_shutdown_failed", {
          errorName: error instanceof Error ? error.name : "UnknownError",
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        process.exitCode = 1;
      });
    });
  }

  try {
    const storage = new JsonFileStorage(storageFilePath(config.DATA_DIRECTORY));
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

    client.once(Events.ClientReady, (readyClient) => {
      logger.info("application_started", {
        botUser: readyClient.user.tag,
        dataDirectory: config.DATA_DIRECTORY,
        pollIntervalMs: config.NITRADO_POLL_INTERVAL_MS,
      });
      lifecycle.attachPoller(nitradoPoller.start(abortController.signal));
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await commandHandler.handle(interaction);
    });

    logger.info("application_starting", {
      dataDirectory: config.DATA_DIRECTORY,
    });
    await client.login(config.DISCORD_BOT_TOKEN);
  } catch (error) {
    await lifecycle.shutdown("startup_failure");
    throw error;
  }
}

try {
  await start();
} catch (error) {
  logger.error("application_start_failed", {
    errorName: error instanceof Error ? error.name : "UnknownError",
    errorMessage: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
}
