import {
  Client as DiscordClient,
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  Interaction,
  Message,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";

import { BotConf } from "./defs";
import * as botConf from "./botconf.json";

interface Command extends ChatInputApplicationCommandData {
  run: (client: DiscordClient, interaction: BaseCommandInteraction) => void;
}

export class Archipelabot {
  private client: DiscordClient;
  private cmds: Command[];
  private recruitMsg?: Message;

  constructor(client: DiscordClient) {
    this.client = client;

    this.cmds = [
      {
        name: "hello",
        description: "Returns a greeting",
        type: "CHAT_INPUT",
        run: this.cmdHello,
      },
      {
        name: "apgame",
        description: "Start and manage Archipelago games",
        type: "CHAT_INPUT",
        options: [
          /*
           */
          {
            type: ApplicationCommandOptionTypes.STRING,
            name: "subcommand",
            description: "What game command to run.",
            choices: [
              { name: "Start", value: "start" },
              { name: "Launch", value: "launch" },
              { name: "Cancel", value: "cancel" },
            ],
            required: true,
          },
          {
            type: ApplicationCommandOptionTypes.STRING,
            name: "gameid",
            description: "The game ID to act upon.",
            required: false,
          },
        ],
        run: this.cmdAPGame,
      },
    ];

    this.client.once("ready", () => {
      console.log(`${client.user?.username} is online`);
      client.application?.commands.set(this.cmds);
    });

    client.on("interactionCreate", async (interaction: Interaction) => {
      if (interaction.isCommand() || interaction.isContextMenu()) {
        const slashCommand = this.cmds.find(
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
  }

  async cmdHello(_client: DiscordClient, interaction: BaseCommandInteraction) {
    await interaction.followUp({
      ephemeral: true,
      content: "Hello there!",
    });
  }

  async cmdAPGame(_client: DiscordClient, interaction: BaseCommandInteraction) {
    switch (interaction.options.get("subcommand", true).value as string) {
      case "start":
        if (this.recruitMsg) {
          await interaction.followUp({
            ephemeral: true,
            content: "There is already a game being organized!",
          });
          this.recruitMsg.reply({
            content: "Here's where that lives.",
          });
        } else {
          this.recruitMsg = (await interaction.followUp({
            ephemeral: true,
            content:
              "This is the message people would react to if they were playing.",
          })) as Message;

          this.recruitMsg.react("⚔️");
        }
        break;

      default:
        console.warn('Unknown subcommand', interaction.options.get("subcommand", true).value);
        await interaction.followUp({
          ephemeral: true,
          content: "I don't recognize that subcommand. (valid options: start)",
        });
    }
  }
}
