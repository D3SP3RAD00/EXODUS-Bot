import { Client, Events, GatewayIntentBits } from "discord.js";

import { NitradoAdmLogAdapter } from "./adapters/nitrado-adm-log-adapter.js";
import { loadConfig } from "./config.js";
import { AdmIngestor } from "./dayz/adm-ingestor.js";
import { CommandHandler } from "./discord/command-handler.js";
import { registerGuildCommands } from "./discord/command-registration.js";
import { configureFeedSubscriptions } from "./discord/feed-service.js";
import { DiscordOutboxDispatcher, DiscordRestFeedSender } from "./discord/outbox-dispatcher.js";
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
      void lifecycle.shutdown(signal).catch(() => {
        logger.error("application_shutdown_failed", {
          code: "APPLICATION_SHUTDOWN_FAILED",
        });
        process.exitCode = 1;
      });
    });
  }

  try {
    const storage = new JsonFileStorage(storageFilePath(config.DATA_DIRECTORY));
    await configureFeedSubscriptions(storage, {
      ...(config.DISCORD_JOIN_LEAVE_CHANNEL_ID ? { join_leave: config.DISCORD_JOIN_LEAVE_CHANNEL_ID } : {}),
      ...(config.DISCORD_PLAYER_COUNT_CHANNEL_ID ? { player_count: config.DISCORD_PLAYER_COUNT_CHANNEL_ID } : {}),
      ...(config.DISCORD_KILLFEED_CHANNEL_ID ? { killfeed: config.DISCORD_KILLFEED_CHANNEL_ID } : {}),
      ...(config.DISCORD_RAID_BUILD_CHANNEL_ID ? { raid_build: config.DISCORD_RAID_BUILD_CHANNEL_ID } : {}),
      ...(config.DISCORD_BOT_STATUS_CHANNEL_ID ? { bot_status: config.DISCORD_BOT_STATUS_CHANNEL_ID } : {}),
      ...(config.DISCORD_ADMIN_AUDIT_CHANNEL_ID ? { admin_audit: config.DISCORD_ADMIN_AUDIT_CHANNEL_ID } : {}),
    }, new Date().toISOString());
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
      config.NITRADO_POLL_INTERVAL_MS,
      storage
    );
    const outboxDispatcher = new DiscordOutboxDispatcher(
      storage,
      new DiscordRestFeedSender(config.DISCORD_BOT_TOKEN),
      logger
    );

    try {
      await registerGuildCommands({
        token: config.DISCORD_BOT_TOKEN,
        applicationId: config.DISCORD_APPLICATION_ID,
        guildId: config.DISCORD_GUILD_ID,
        logger,
      });
    } catch {
      logger.warn("application_continuing_without_command_refresh", {
        code: "DISCORD_COMMAND_REGISTRATION_FAILED",
      });
    }

    client.once(Events.ClientReady, () => {
      logger.info("application_started", {
        pollIntervalMs: config.NITRADO_POLL_INTERVAL_MS,
      });
      lifecycle.attachPoller(Promise.all([
        nitradoPoller.start(abortController.signal),
        outboxDispatcher.start(abortController.signal),
      ]).then(() => undefined));
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      await commandHandler.handle(interaction);
    });

    logger.info("application_starting");
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
    code: error instanceof Error && "code" in error && typeof error.code === "string"
      ? error.code
      : "APPLICATION_START_FAILED",
  });
  process.exitCode = 1;
}
