import {
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  Client as DiscordClient,
  Intents,
  Interaction,
} from "discord.js";

import { BotConf } from "./defs";
import * as botConf from "./botconf.json";

interface Command extends ChatInputApplicationCommandData {
  run: (client: DiscordClient, interaction: BaseCommandInteraction) => void;
}

const Hello: Command = {
  name: "hello",
  description: "Returns a greeting",
  type: "CHAT_INPUT",
  run: async (_client: DiscordClient, interaction: BaseCommandInteraction) => {
    await interaction.followUp({
      ephemeral: true,
      content: "Hello there!",
    });
  },
};

const Commands = [Hello];

(async () => {
  const client = new DiscordClient({ intents: [Intents.FLAGS.GUILDS] });

  client.once("ready", () => {
    console.log(`${client.user?.username} is online`);
    client.application?.commands.set(Commands);
  });

  client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isCommand() || interaction.isContextMenu()) {
      const slashCommand = Commands.find(
        (c) => c.name === interaction.commandName
      );
      if (!slashCommand) {
        interaction.followUp({ content: "An error has occurred" });
        return;
      }

      await interaction.deferReply();

      slashCommand.run(client, interaction);
    }
  });

  client.login((botConf as BotConf).discord.token);
})();
