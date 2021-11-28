import {
  Client as DiscordClient,
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  Interaction,
  Message,
  ReactionCollector,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";

import { BotConf } from "./defs";
import * as botConf from "./botconf.json";

interface Command extends ChatInputApplicationCommandData {
  run: (client: DiscordClient, interaction: BaseCommandInteraction) => void;
}

interface GameRecruitmentProcess {
  msg: Message;
  guildId: string;
  channelId: string;
  startingUser: string;
  reactionCollector?: ReactionCollector;
  reactedUsers: string[];
}

export class Archipelabot {
  private client: DiscordClient;
  private cmds: Command[];

  private recruit?: GameRecruitmentProcess;

  private _clientId: string;
  public get clientId(): string {
    return this._clientId;
  }

  constructor(client: DiscordClient) {
    this.client = client;
    this._clientId = '';

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
      if (this.client.user) this._clientId = this.client.user.id;
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

  cmdAPGame = async (_client: DiscordClient, interaction: BaseCommandInteraction) => {
    switch (interaction.options.get("subcommand", true).value as string) {
      case "start":
        if (this.recruit) {
          await interaction.followUp({
            ephemeral: true,
            content: "There is already a game being organized!",
          });
          this.recruit.msg.reply({
            content: "Here's where that lives.",
          });
        } else {
          this.recruit = {
            msg: (await interaction.followUp({
              ephemeral: true,
              content:
                "This is the message people would react to if they were playing.",
            })) as Message,
            guildId: interaction.guildId,
            channelId: interaction.channelId,
            startingUser: interaction.user.id,
            reactedUsers: [],
          };

          this.recruit.msg.react("⚔️");
          this.recruit.reactionCollector =
            this.recruit.msg.createReactionCollector({
              filter: (reaction, user) => {
                console.debug(this.clientId);
                return this.clientId !== user.id && reaction.emoji.name === "⚔️"
              }
            });

          const { reactionCollector } = this.recruit;
          reactionCollector.on("collect", (reaction, user) => {
            console.debug("Collect:" /*, reaction, user*/);
            if (this.recruit && reaction.emoji.name === "⚔️")
              this.recruit.reactedUsers.push(user.id);
          });
          reactionCollector.on("remove", (reaction, user) => {
            console.debug("Remove:" /*, reaction, user*/);
            if (this.recruit && reaction.emoji.name === "⚔️")
              this.recruit.reactedUsers = this.recruit.reactedUsers.filter(
                (i) => i != user.id
              );
          });
          reactionCollector.on("dispose", (reaction) => {
            console.debug("Dispose:" /*, reaction*/);
            if (this.recruit && reaction.emoji.name === "⚔️") {
              this.recruit.msg.react("⚔️");
              this.recruit.reactedUsers = [];
            }
          });
          reactionCollector.on("end", async (_collected, reason) => {
            console.debug("End:"/*, collected, reason*/);
            if (reason === "aplaunch") {
              console.debug(this.recruit?.reactedUsers);
              await this.recruit?.msg.delete();
              this.recruit = undefined;
            }
          });
        }
        break;

      case "launch":
        if (!this.recruit)
          await interaction.followUp({
            ephemeral: true,
            content: "No game is currently being organized!",
          });
        else if (this.recruit.startingUser !== interaction.user.id)
          await interaction.followUp({
            ephemeral: true,
            content: "You're not the person who launched this event!",
          });
        else {
          const {reactedUsers} = this.recruit;
          this.recruit.reactionCollector?.stop("aplaunch");

          await interaction.followUp({
            ephemeral: true,
            content: "TEST: Game has started. Players: " + reactedUsers.join(', '),
          });

        }
        break;

      case "cancel":
        if (!this.recruit)
          await interaction.followUp({
            ephemeral: true,
            content: "No game is currently being organized!",
          });
        else if (this.recruit.startingUser !== interaction.user.id)
          await interaction.followUp({
            ephemeral: true,
            content: "You're not the person who launched this event!",
          });
        else {
          await interaction.followUp({
            ephemeral: true,
            content: "The game has been cancelled.",
          });

          this.recruit.reactionCollector?.stop("apcancel");
        }
        break;

      default:
        console.warn(
          "Unknown subcommand",
          interaction.options.get("subcommand", true).value
        );
        await interaction.followUp({
          ephemeral: true,
          content: "I don't recognize that subcommand. (valid options: start)",
        });
    }
  }

  /*
  async generateGame(channel: string, users: string[]) {
  }
  */
}
