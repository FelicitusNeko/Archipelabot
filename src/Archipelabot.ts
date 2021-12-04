import {
  Client as DiscordClient,
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  Interaction as DiscordInteraction,
  Message as DiscordMessage,
  ReactionCollector,
  MessageActionRow,
  MessageSelectMenu,
  MessageButton,
  MessageSelectOptionData,
  MessageEmbed,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import { userMention } from "@discordjs/builders";
import { Sequelize } from "sequelize";
import * as YAML from "yaml";

import { get as httpsGet } from "https";
import { existsSync, mkdirSync } from "fs";
import { writeFile } from "fs/promises";

import { BotConf } from "./defs";
import * as botConf from "./botconf.json";
import * as gameList from "./gamelist.json";

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: BaseCommandInteraction) => void;
}

interface GameRecruitmentProcess {
  msg: DiscordMessage;
  guildId: string;
  channelId: string;
  startingUser: string;
  reactionCollector?: ReactionCollector;
  reactedUsers: string[];
}

interface yamlData {
  error?: string;
  desc?: string;
  games?: string[];
}

const getFile = (url: string) => {
  return new Promise<string>((f, r) => {
    httpsGet(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk.toString()));
      res.on("close", () => f(data));
      res.on("error", (e) => r(e));
    });
  });
};

const quickValidateYaml = (data: string) => {
  const gameListStr = gameList as string[];
  try {
    const yamlIn = YAML.parse(data);

    if (!yamlIn.name) throw new Error("Name missing");
    if (typeof yamlIn.name !== "string") throw new Error("Name not a string");
    const name = (yamlIn.name as string).replace(
      /\{[player|PLAYER|number|NUMBER]\}/,
      "###"
    );
    if (name.length > 16) throw new Error("Name too long");
    if (name.length === 0) throw new Error("Name is zero-length");

    const retval: yamlData = {
      desc: yamlIn.description ?? "No description",
    };

    switch (typeof yamlIn.game) {
      case "object":
        {
          const games = yamlIn.game as Record<string, number>;
          for (const game of Object.keys(games)) {
            if (!gameListStr.includes(game))
              throw new Error(`Game ${game} not in valid game list`);
            if ((yamlIn.game[game] as number) === 0) continue;
            if (yamlIn[game] === undefined)
              throw new Error(`Settings not defined for game ${game}`);
          }

          retval.games = Object.keys(games);
        }
        break;
      case "string":
        if (!gameListStr.includes(yamlIn.game))
          throw new Error(`Game ${yamlIn.game} not in valid game list`);
        if (yamlIn[yamlIn.game] === undefined)
          throw new Error(`Settings not defined for game ${yamlIn.game}`);

        retval.games = [yamlIn.game as string];
        break;
      case "undefined":
        throw new Error("No game defined");
    }

    return retval;
  } catch (e) {
    console.error("Invalid YAML:", e);
    return { error: (e as Error).message } as yamlData;
  }
};

const generateLetterCode = (length = 4) => {
  let retval = "";

  for (let x = 0; x < length; x++)
    retval += String.fromCharCode(
      Math.floor(Math.random() * 26) + "A".charCodeAt(0)
    );

  return retval;
};

export class Archipelabot {
  private client: DiscordClient;
  private cmds: Command[];
  private db: Sequelize;

  private recruit: Record<string, GameRecruitmentProcess>;

  public get clientId(): string {
    return this.client && this.client.user ? this.client.user.id : "";
  }

  constructor(client: DiscordClient) {
    this.client = client;
    this.recruit = {};
    this.db = new Sequelize("sqlite::memory:");
    this.db.close(); // just to shut up the build process for now

    this.cmds = [
      {
        name: "hello",
        description: "Returns a greeting",
        type: "CHAT_INPUT",
        run: this.cmdHello,
      },
      {
        name: "yaml",
        description: "Manage YAML configuration files",
        type: "CHAT_INPUT",
        run: this.cmdYaml,
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

    this.client.on(
      "interactionCreate",
      async (interaction: DiscordInteraction) => {
        if (interaction.isCommand() || interaction.isContextMenu()) {
          const slashCommand = this.cmds.find(
            (c) => c.name === interaction.commandName
          );
          if (!slashCommand) {
            interaction.followUp({
              content: "Sorry, I don't recognize that command.",
            });
            return;
          }

          await interaction.deferReply();
          slashCommand.run(interaction);
        }
      }
    );

    

    if (!existsSync("./yamls")) mkdirSync("./yamls");

    this.client.login((botConf as BotConf).discord.token);
  }

  async cmdHello(interaction: BaseCommandInteraction) {
    await interaction.followUp({
      ephemeral: true,
      content: "Hello there!",
    });
  }

  cmdYaml = async (interaction: BaseCommandInteraction) => {
    console.debug(interaction.id);

    const yamls: MessageSelectOptionData[] = [
      {
        label: "YAML 1",
        description: "A Link to the Past, Factorio",
        value: "123456789012345678/123456789012345678-1",
        emoji: "⚔️",
      },
    ];
    let currentYaml = -1;

    const yamlRow = new MessageActionRow({
      components: [
        new MessageSelectMenu({
          customId: "yaml",
          placeholder: "Select a YAML",
          options: yamls,
        }),
      ],
    });
    const buttonRow = new MessageActionRow({
      components: [
        new MessageButton({
          customId: "backToYamlList",
          label: "Back",
          style: "SECONDARY",
        }),
        new MessageButton({
          customId: "setDefaultYaml",
          label: "Set Default",
          style: "PRIMARY",
        }),
        new MessageButton({
          customId: "deleteYaml",
          label: "Delete",
          style: "DANGER",
        }),
      ],
    });

    const msg = (await interaction.followUp({
      ephemeral: true,
      content:
        "You can reply to this message with a YAML to add it, or select one from the list to act on it.",
      components: [yamlRow],
    })) as DiscordMessage;
    console.log(msg.id);

    const msgCollector = interaction.channel?.createMessageCollector({
      filter: (msg) =>
        msg.type === "REPLY" &&
        msg.reference?.messageId === msg.id &&
        msg.attachments.size > 0,
      max: 1,
      time: 60000,
    });
    msgCollector?.on("collect", (msgIn) => {
      const yamls = msgIn.attachments.filter(
        (i) => i.url.endsWith(".yaml") || i.url.endsWith(".yml")
      );
      if (yamls.size === 0) msg.edit("That wasn't a YAML!");
      else {
        Promise.all(yamls.map((i) => getFile(i.url)))
          .then(async (i) => {
            const userDir = `./yamls/${interaction.user.id}`;
            let addedCount = 0;

            if (!existsSync(userDir)) mkdirSync(userDir);
            for (const x in i)
              if (!quickValidateYaml(i[x]).error) {
                await writeFile(`${userDir}/${msgIn.id}-${x}.yaml`, i[x]);
                addedCount++;
              }

            msg.edit(
              `Thanks! Added ${addedCount} valid YAML(s) of ${msgIn.attachments.size} file(s) submitted. Check debug info.`
            );

            if (msgIn.deletable) msgIn.delete();
          })
          .catch((e) => {
            msg.edit("An error occurred. Check debug log.");
            console.error(e);
          });
      }
    });
    msgCollector?.on("end", (_collected, reason) => {
      if (reason === "time")
        msg.edit({ content: "Timed out.", embeds: [], components: [] });
      //else _msg.edit(`Check debug output. Reason: ${reason}`)
    });

    const subInteractionHandler = (subInt: DiscordInteraction) => {
      if (!subInt.isSelectMenu() && !subInt.isButton()) return;
      if (subInt.user.id !== interaction.user.id) return;
      if (subInt.message.id !== msg.id) return;

      if (subInt.isSelectMenu()) {
        currentYaml = yamls.reduce(
          (r, i, x) => (i.value === subInt.values[0] ? x : r),
          -1
        );
        if (currentYaml < 0)
          subInt.update({
            content:
              "You can reply to this message with a YAML to add it, or select one from the list to act on it.",
            embeds: [],
            components: [yamlRow],
          });
        else
          subInt.update({
            content:
              "You can update the selected YAML by replying to this message with a new one. You can also set it as default for sync runs, or delete it.",
            embeds: [
              new MessageEmbed({
                title: yamls[currentYaml].label ?? "Unknown",
                footer: userMention(subInt.user.id),
                fields: [
                  {
                    name: 'Games',
                    value: yamls[currentYaml].description ?? "Unknown",
                    inline: true
                  }
                ]
              })/*
                .addField(
                  "Games",
                  yamls[currentYaml].description ?? "Unknown",
                  true
                )*/
                .addField("User", userMention(subInt.user.id), true),
            ],
            components: [buttonRow],
          });
      } else if (subInt.isButton()) {
        switch (subInt.customId) {
          case "backToYamlList":
            subInt.update({
              content:
                "You can reply to this message with a YAML to add it, or select one from the list to act on it.",
              embeds: [],
              components: [yamlRow],
            });
            break;

          default:
            subInt.update({
              content: `You clicked the ${subInt.customId} button!`,
            });
        }
      }

      console.debug(subInt);
    };

    this.client.on("interactionCreate", subInteractionHandler);
    //this.client.off('interactionCreate', subInteractionHandler);
  };

  cmdAPGame = async (interaction: BaseCommandInteraction) => {
    if (!interaction.guild || !interaction.channel) {
      await interaction.followUp({
        ephemeral: true,
        content:
          "A game currently can only be organized in a text channel of a server.",
      });
    } else {
      const { guildId, channelId, user: {id: startingUser} } = interaction;
      switch (interaction.options.get("subcommand", true).value as string) {
        case "start":
          {
            if (this.recruit[guildId]) {
              await interaction.followUp(
                "There is already a game being organized on this server!"
              );
              //this.recruit[guildId].msg.reply("Here's where that lives.");
            } else {
              const gameCode = generateLetterCode();
              const newRecruit: GameRecruitmentProcess = {
                msg: (await interaction.followUp({
                  content: `${userMention(startingUser)} is starting a game!`,
                  embeds: [
                    new MessageEmbed({
                      title: "Multiworld Game Call",
                      description:
                        "React ⚔️ to join into this game with your default YAML.",
                      footer: {
                        text: `Game code: ${gameCode}`,
                      },
                    }),
                  ],
                })) as DiscordMessage,
                guildId,
                channelId,
                startingUser,
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
                // TODO: find out when this event fires (if it does)
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
          else if (this.recruit[guildId].startingUser !== startingUser)
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

            reactedUsers.forEach((i) => {
              const user = this.client.users.cache.get(i);
              user?.send(
                "Here's where you'd be sent your data file, if there is one for your game."
              );
            });
          }
          break;

        case "cancel":
          if (!this.recruit[guildId])
            await interaction.followUp({
              ephemeral: true,
              content: "No game is currently being organized!",
            });
          else if (this.recruit[guildId].startingUser !== startingUser)
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
