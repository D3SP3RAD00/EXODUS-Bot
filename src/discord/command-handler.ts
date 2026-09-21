import type { ChatInputCommandInteraction } from "discord.js";

import { adminErrorMessage } from "../core/errors.js";
import { playersMessage, playtimeMessage, statusMessage } from "../core/queries.js";
import type { Logger } from "../observability/logger.js";
import type { Storage } from "../storage/storage.js";

export class CommandHandler {
  constructor(private readonly storage: Storage, private readonly logger: Logger) {}

  async handle(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      const state = await this.storage.read();
      let content: string;
      switch (interaction.commandName) {
        case "status":
          content = statusMessage(state);
          break;
        case "players":
          content = playersMessage(state);
          break;
        case "playtime":
          content = playtimeMessage(state, interaction.options.getString("player", true));
          break;
        default:
          return;
      }
      await interaction.reply({ content, ephemeral: true });
      this.logger.info("discord_command_completed", { command: interaction.commandName });
    } catch (error) {
      this.logger.error("discord_command_failed", {
        command: interaction.commandName,
        code: error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : "EXODUS_INTERNAL",
      });
      const content = adminErrorMessage(error);
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  }
}
