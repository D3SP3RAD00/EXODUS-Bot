import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current !!EXODUS bot status."),
].map((command) => command.toJSON());
