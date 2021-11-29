import {
  Client as DiscordClient,
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  Interaction,
  Message,
  ReactionCollector,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import { userMention } from "@discordjs/builders";

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

  private recruit: Record<string, GameRecruitmentProcess>;

  public get clientId(): string {
    return this.client && this.client.user ? this.client.user.id : "";
  }

  constructor(client: DiscordClient) {
    this.client = client;
    this.recruit = {};

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

  cmdAPGame = async (
    _client: DiscordClient,
    interaction: BaseCommandInteraction
  ) => {
    if (!interaction.guild || !interaction.channel) {
      await interaction.followUp({
        ephemeral: true,
        content:
          "A game currently can only be organized in a text channel of a server.",
      });
    } else {
      const { guildId, channelId } = interaction;
      switch (interaction.options.get("subcommand", true).value as string) {
        case "start":
          {
            if (this.recruit[guildId]) {
              await interaction.followUp(
                "There is already a game being organized!"
              );
              this.recruit[guildId].msg.reply("Here's where that lives.");
            } else {
              const newRecruit: GameRecruitmentProcess = {
                msg: (await interaction.followUp(
                  "This is the message people would react to if they were playing."
                )) as Message,
                guildId,
                channelId,
                startingUser: interaction.user.id,
                reactedUsers: [],
              };
              this.recruit[guildId] = newRecruit;

              newRecruit.msg.react("⚔️");
              newRecruit.reactionCollector =
                newRecruit.msg.createReactionCollector({
                  filter: (reaction, user) =>
                    this.clientId !== user.id && reaction.emoji.name === "⚔️",
                  dispose: true,
                });

              const { reactionCollector } = newRecruit;
              reactionCollector.on("collect", (reaction, user) => {
                if (newRecruit && reaction.emoji.name === "⚔️")
                  newRecruit.reactedUsers.push(user.id);
              });
              reactionCollector.on("remove", (reaction, user) => {
                if (newRecruit && reaction.emoji.name === "⚔️")
                  newRecruit.reactedUsers = newRecruit.reactedUsers.filter(
                    (i) => i != user.id
                  );
              });
              reactionCollector.on("dispose", (reaction) => {
                console.debug("Dispose:" /*, reaction*/);
                if (newRecruit && reaction.emoji.name === "⚔️") {
                  newRecruit.msg.react("⚔️");
                  newRecruit.reactedUsers = [];
                }
              });
              reactionCollector.on("end", async (_collected, reason) => {
                if (["aplaunch", "apcancel"].includes(reason)) {
                  console.debug(newRecruit.reactedUsers);
                  await newRecruit.msg.delete();
                  delete this.recruit[newRecruit.guildId];
                }
              });
            }
          }
          break;

        case "launch":
          if (!this.recruit[guildId])
            await interaction.followUp({
              ephemeral: true,
              content: "No game is currently being organized!",
            });
          else if (this.recruit[guildId].startingUser !== interaction.user.id)
            await interaction.followUp({
              ephemeral: true,
              content: "You're not the person who launched this event!",
            });
          else if (this.recruit[guildId].reactedUsers.length === 0)
            await interaction.followUp({
              ephemeral: true,
              content:
                "Nobody has signed up for this game yet! Either wait for signups or cancel.",
            });
          else {
            const { reactedUsers } = this.recruit[guildId];
            this.recruit[guildId].reactionCollector?.stop("aplaunch");

            await interaction.followUp(
              "TEST: Game has started. Players: " +
                reactedUsers.map((i) => userMention(i)).join(", ")
            );

            reactedUsers.forEach(i => {
              const user = this.client.users.cache.get(i);
              user?.send("Here's where you'd be sent your data file, if there is one for your game.");
            })
          }
          break;

        case "cancel":
          if (!this.recruit)
            await interaction.followUp({
              ephemeral: true,
              content: "No game is currently being organized!",
            });
          else if (this.recruit[guildId].startingUser !== interaction.user.id)
            await interaction.followUp({
              ephemeral: true,
              content: "You're not the person who launched this event!",
            });
          else {
            await interaction.followUp("The game has been cancelled.");
            this.recruit[guildId].reactionCollector?.stop("apcancel");
          }
          break;

        default:
          console.warn(
            "Unknown subcommand",
            interaction.options.get("subcommand", true).value
          );
          await interaction.followUp({
            ephemeral: true,
            content:
              "I don't recognize that subcommand. (valid options: start, launch, cancel)",
          });
      }
    }
  };

  /*
  async generateGame(channel: string, users: string[]) {
  }
  */
}
