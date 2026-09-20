import { SlashCommandBuilder } from "discord.js";

export const commands = [
  new SlashCommandBuilder()
    .setName("status")
    .setDescription("Show the current !!EXODUS bot and ingestion status."),
  new SlashCommandBuilder()
    .setName("players")
    .setDescription("List players with active DayZ sessions."),
  new SlashCommandBuilder()
    .setName("playtime")
    .setDescription("Show accumulated playtime for a DayZ player.")
    .addStringOption((option) =>
      option
        .setName("player")
        .setDescription("Current or previous player name")
        .setRequired(true)
    ),
].map((command) => command.toJSON());
