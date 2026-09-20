import { REST, Routes } from "discord.js";

import { loadConfig } from "../config.js";
import { commands } from "./commands.js";

const config = loadConfig();
const rest = new REST({ version: "10" }).setToken(config.DISCORD_BOT_TOKEN);

await rest.put(
  Routes.applicationGuildCommands(
    config.DISCORD_APPLICATION_ID,
    config.DISCORD_GUILD_ID
  ),
  { body: commands }
);

console.log(`Registered ${commands.length} guild command(s).`);
