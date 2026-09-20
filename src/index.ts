import { Client, Events, GatewayIntentBits } from "discord.js";

import { loadConfig } from "./config.js";

const config = loadConfig();
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

client.once(Events.ClientReady, (readyClient) => {
  console.log(`!!EXODUS bot online as ${readyClient.user.tag}.`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "status") {
    await interaction.reply({
      content: "!!EXODUS systems are online.",
      ephemeral: true,
    });
  }
});

await client.login(config.DISCORD_BOT_TOKEN);
