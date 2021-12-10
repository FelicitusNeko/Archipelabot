import {
  Client as DiscordClient,
  Message as DiscordMessage,
  Interaction as DiscordInteraction,
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
  ReactionCollector,
  MessageActionRow,
  MessageSelectMenu,
  MessageButton,
  MessageSelectOptionData,
  MessageEmbed,
  InteractionUpdateOptions,
  InteractionReplyOptions,
  //MessageAttachment,
  User as DiscordUser,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import { userMention } from "@discordjs/builders";
//import { Sequelize } from "sequelize";
import * as YAML from "yaml";

import { get as httpsGet } from "https";
import { existsSync, mkdirSync } from "fs";
import { unlink, writeFile } from "fs/promises";

import { BotConf } from "./defs";
import * as botConf from "./botconf.json";
import * as gameList from "./gamelist.json";
import { /*sequelize,*/ PlayerTable, YamlTable } from "./Sequelize";

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

interface YamlData {
  error?: string;
  desc?: string;
  games?: string[];
  data: string;
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

    const retval: YamlData = {
      desc: yamlIn.description ?? "No description",
      data,
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
    return { error: (e as Error).message, data } as YamlData;
  }
};

/**
 * Generates a letter code.
 * @param {string[]} checkAgainst A list of already used codes. The function will generate a code that is not on this list.
 * @param {number} length The length of the code. Defaults to 4.
 * @returns {string} A unique letter code.
 */
const generateLetterCode = (
  checkAgainst: string[] = [],
  length = 4
): string => {
  let retval = "";

  do {
    retval = "";
    for (let x = 0; x < length; x++)
      retval += String.fromCharCode(
        Math.floor(Math.random() * 26) + "A".charCodeAt(0)
      );
  } while (checkAgainst.includes(retval));

  return retval;
};

export class Archipelabot {
  private client: DiscordClient;
  private cmds: Command[];
  //private db: Sequelize;

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
        name: "yaml",
        description: "Manage YAML configuration files",
        type: "CHAT_INPUT",
        options: [
          {
            type: ApplicationCommandOptionTypes.STRING,
            name: "subcommand",
            description: "What YAML command to run.",
            choices: [
              { name: "Manage (default)", value: "manage" },
              { name: "Give to user", value: "give" },
            ],
            required: false,
          },
          {
            type: ApplicationCommandOptionTypes.USER,
            name: "target",
            description: "Which user to affect with this command.",
            required: false,
          },
        ],
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
    const {
      user: { id: userId },
    } = interaction;

    const subcommand = interaction.options.get("subcommand", false);
    if (!subcommand || subcommand.value === "manage") {
      const updateYamlList = async () => {
        const playerEntry =
          (await PlayerTable.findOne({ where: { userId } })) ??
          (await PlayerTable.create({ userId, defaultCode: null }));
        const retval = await YamlTable.findAll({ where: { userId } }).then(
          (r) =>
            r.map((i) => {
              return {
                label: i.description,
                description: (JSON.parse(i.games) as string[]).join(", "),
                value: i.code,
                emoji: i.code === playerEntry?.defaultCode ? "⚔️" : undefined,
              } as MessageSelectOptionData;
            })
        );

        return retval.length === 0
          ? [
              {
                label: "No YAMLs",
                value: "noyaml",
              },
            ]
          : retval;
      };

      let curEntry: YamlTable | null = null;
      const generateCurEntryEmbed = (calledUser?: string) => {
        if (!curEntry) return [];
        else
          return [
            new MessageEmbed({
              title: curEntry.description ?? "Unknown",
              footer: userMention(calledUser ?? curEntry.userId),
              fields: [
                {
                  name: "Games",
                  value:
                    (JSON.parse(curEntry.games) as string[]).join(", ") ??
                    "Unknown",
                  inline: true,
                },
                {
                  name: "User",
                  value: userMention(curEntry.userId),
                  inline: true,
                },
              ],
            }),
          ];
      };

      const yamlRow = new MessageActionRow({
        components: [
          new MessageSelectMenu({
            customId: "yaml",
            placeholder: "Select a YAML",
            options: await updateYamlList(),
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
      const startingState: InteractionUpdateOptions = {
        content:
          "You can reply to this message with a YAML to add it, or select one from the list to act on it.",
        embeds: [],
        components: [yamlRow],
      };

      const msg = (await interaction.followUp(
        Object.assign<InteractionReplyOptions, InteractionUpdateOptions>(
          { ephemeral: true },
          startingState
        )
      )) as DiscordMessage;

      const msgCollector = interaction.channel?.createMessageCollector({
        filter: (msgIn) =>
          msgIn.type === "REPLY" &&
          msgIn.reference?.messageId === msg.id &&
          msgIn.attachments.size > 0,
      });
      msgCollector?.on("collect", (msgIn) => {
        ResetTimeout();
        const yamls = msgIn.attachments.filter(
          (i) => i.url.endsWith(".yaml") || i.url.endsWith(".yml")
        );
        if (yamls.size === 0) msg.edit("That wasn't a YAML!");
        else {
          Promise.all(yamls.map((i) => getFile(i.url)))
            .then(async (i) => {
              const userDir = `./yamls/${userId}`;
              if (curEntry) {
                const validate = quickValidateYaml(i[0]);
                if (!validate.error) {
                  await writeFile(`${userDir}/${msgIn.id}-u.yaml`, i[0]);
                  const updateInfo = {
                    filename: `${msgIn.id}-u`,
                    description: validate.desc ?? "No description provided",
                    games: JSON.stringify(
                      validate.games ?? ["A Link to the Past"]
                    ),
                  };

                  await YamlTable.update(updateInfo, {
                    where: { code: curEntry.code },
                  });

                  unlink(`${userDir}/${curEntry.filename}.yaml`);
                  curEntry = Object.assign<YamlTable, Partial<YamlTable>>(
                    curEntry,
                    updateInfo
                  );
                  msg.edit({
                    content: `Thanks! YAML has been updated.`,
                    embeds: generateCurEntryEmbed(userId),
                  });
                } else {
                  msg.edit(
                    "That doesn't look like a valid YAML. The entry was not updated."
                  );
                }
              } else {
                const usedCodes = (await YamlTable.findAll()).map(
                  (i) => i.code
                );
                let addedCount = 0;

                if (!existsSync(userDir)) mkdirSync(userDir);
                for (const x in i) {
                  const validate = quickValidateYaml(i[x]);
                  if (!validate.error) {
                    const code = generateLetterCode(usedCodes);
                    await Promise.all([
                      writeFile(`${userDir}/${msgIn.id}-${x}.yaml`, i[x]),
                      YamlTable.create({
                        code,
                        userId,
                        filename: `${msgIn.id}-${x}`,
                        description: validate.desc ?? "No description provided",
                        games: JSON.stringify(
                          validate.games ?? ["A Link to the Past"]
                        ),
                      }),
                    ]);
                    usedCodes.push(code);
                    addedCount++;
                  }
                }
                (yamlRow.components[0] as MessageSelectMenu).setOptions(
                  await updateYamlList()
                );
                msg.edit({
                  content: `Thanks! Added ${addedCount} valid YAML(s) of ${msgIn.attachments.size} file(s) submitted.`,
                  components: [yamlRow],
                });
              }

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

      const subInteractionHandler = async (subInt: DiscordInteraction) => {
        if (!subInt.isSelectMenu() && !subInt.isButton()) return;
        if (subInt.user.id !== userId) return;
        if (subInt.message.id !== msg.id) return;

        if (subInt.isSelectMenu()) {
          if (subInt.values[0] === "noyaml") {
            subInt.update({
              content:
                "There are no YAMLs currently associated to you. Please provide one by replying to this message with it attached.",
            });
            return;
          }
          curEntry = await YamlTable.findOne({
            where: { code: subInt.values[0] },
          });

          if (!curEntry) {
            subInt.update(startingState);
          } else {
            const playerEntry = await PlayerTable.findOne({
              where: { userId },
            });
            (buttonRow.components[1] as MessageButton).disabled =
              playerEntry?.defaultCode === curEntry.code;
            subInt.update({
              content:
                "You can update the selected YAML by replying to this message with a new one. You can also set it as default for sync runs, or delete it.",
              embeds: generateCurEntryEmbed(subInt.user.id),
              components: [buttonRow],
            });
          }
        } else if (subInt.isButton() && curEntry) {
          switch (subInt.customId) {
            case "backToYamlList":
              subInt.update(startingState);
              break;

            case "setDefaultYaml":
              await PlayerTable.update(
                { defaultCode: curEntry.code },
                {
                  where: { userId: curEntry.userId },
                }
              );

              (buttonRow.components[1] as MessageButton).disabled = true;
              subInt.update({
                content: "Your default YAML has been changed to this one.",
                components: [buttonRow],
              });
              (yamlRow.components[0] as MessageSelectMenu).setOptions(
                await updateYamlList()
              );
              break;

            case "deleteYaml":
              subInt.update({
                content: "Are you sure you wish to delete this YAML?",
                components: [
                  new MessageActionRow({
                    components: [
                      new MessageButton({
                        customId: "deleteYamlYes",
                        label: "Yes",
                        style: "DANGER",
                      }),
                      new MessageButton({
                        customId: "deleteYamlNo",
                        label: "No",
                        style: "SECONDARY",
                      }),
                    ],
                  }),
                ],
              });
              break;

            case "deleteYamlYes":
              await YamlTable.destroy({ where: { code: curEntry.code } });

              PlayerTable.update(
                { defaultCode: null },
                { where: { defaultCode: curEntry.code } }
              ),
                unlink(`./yamls/${curEntry.userId}/${curEntry.filename}.yaml`);
              (yamlRow.components[0] as MessageSelectMenu).setOptions(
                await updateYamlList()
              );
              subInt.update(
                Object.assign<
                  InteractionUpdateOptions,
                  InteractionUpdateOptions
                >(startingState, {
                  content:
                    "The YAML has been deleted. You can now add more if you wish, or manage any remaining YAMLs.",
                })
              );
              break;

            case "deleteYamlNo":
              subInt.update({
                content:
                  "You can update the selected YAML by replying to this message with a new one. You can also set it as default for sync runs, or delete it.",
                components: [buttonRow],
              });
              break;

            default:
              console.debug(subInt);
              subInt.update({
                content: `You clicked the ${subInt.customId} button!`,
              });
              break;
          }
        }
      };

      this.client.on("interactionCreate", subInteractionHandler);

      let timeoutSignal: NodeJS.Timeout;
      const Timeout = () => {
        this.client.off("interactionCreate", subInteractionHandler);
        msgCollector?.stop("time");
      };
      const ResetTimeout = (msec = 180000) => {
        if (timeoutSignal) clearTimeout(timeoutSignal);
        timeoutSignal = setTimeout(Timeout, msec);
      };
      ResetTimeout();
    } else if (subcommand.value === "give") {
      try {
        const sendingUser = interaction.user.id;
        const targetUser = interaction.options.get("target", true);
        if (!targetUser.value || !targetUser.user)
          throw new Error("Failed to resolve user");
        else {
          //const beginner = interaction.options.get("beginner", false);
          const msg = (await interaction.followUp({
            ephemeral: true,
            content: `Assigning a YAML to ${userMention(
              targetUser.value as string
            )}. Please reply to this message with the YAML you wish to assign.`,
          })) as DiscordMessage;

          console.debug(interaction);
          const msgCollector = interaction.channel?.createMessageCollector({
            filter: (msgIn) =>
              msgIn.type === "REPLY" &&
              msgIn.reference?.messageId === msg.id &&
              msgIn.attachments.size > 0,
          });
          //console.debug(msgCollector);
          msgCollector?.on("collect", (msgIn) => {
            const yamls = msgIn.attachments.filter(
              (i) => i.url.endsWith(".yaml") || i.url.endsWith(".yml")
            );
            if (yamls.size === 0)
              msg.edit("That wasn't a YAML! Please try again.");
            else {
              Promise.all(yamls.map((i) => getFile(i.url)))
                .then(async (i) => {
                  const validate = quickValidateYaml(i[0]);
                  if (!validate.error) {
                    msg.edit({
                      content: `The YAML has been sent to the user. They will need to approve it before they can use it.`,
                      components: [],
                    });
                    this.sendYamlForApproval(
                      sendingUser,
                      targetUser.user,
                      validate
                    );
                  } else {
                    msg.edit(
                      `The supplied YAML was invalid: ${validate.error}. Please try again.`
                    );
                  }

                  if (msgIn.deletable) msgIn.delete();
                })
                .catch((e) => {
                  msg.edit("An error occurred. Check debug log.");
                  console.error(e);
                });
            }
          });

          //console.debug(targetUser);
        }
      } catch (e) {
        interaction.followUp({
          ephemeral: true,
          content:
            "Oops, an error occured. (Did you maybe forget to specify a user?)",
        });
        console.error(e);
      }
    } else {
      interaction.followUp({
        ephemeral: true,
        content:
          "I don't recognize that subcommand. (valid options: [default] manage, give)",
      });
      console.warn("Unknown subcommand", subcommand);
    }
  };

  async sendYamlForApproval(
    sendingUser: string,
    receivingUser: DiscordUser | undefined,
    yamlData: YamlData
  ) {
    if (!receivingUser) return;
    //const user = this.client.users.cache.get(receivingUser);
    const msg = (await receivingUser.send({
      content: `${userMention(
        sendingUser
      )} has sent you a YAML. Please review it and choose if you'd like to add it to your collection.`,
      //attachments: [new MessageAttachment(Buffer.from(yamlData.data), "Received.yaml")],
      components: [
        new MessageActionRow({
          components: [
            new MessageButton({
              customId: "accept",
              label: "Accept",
              style: "PRIMARY",
            }),
            new MessageButton({
              customId: "acceptAsDefault",
              label: "Accept as default",
              style: "SECONDARY",
            }),
            new MessageButton({
              customId: "reject",
              label: "Reject",
              style: "DANGER",
            }),
          ],
        }),
      ],
    })) as DiscordMessage;

    const subInteractionHandler = async (subInt: DiscordInteraction) => {
      if (!subInt.isSelectMenu() && !subInt.isButton()) return;
      if (subInt.user.id !== receivingUser.id) return;
      if (subInt.message.id !== msg.id) return;

      if (subInt.isButton()) {
        let dismissListener = true;
        switch (subInt.customId) {
          case "accept":
          case "acceptAsDefault":
            {
              const code = generateLetterCode(
                (await YamlTable.findAll()).map((i) => i.code)
              );
              // Create player entry if it doesn't exist
              (await PlayerTable.findOne({
                where: { userId: receivingUser.id },
              })) ??
                (await PlayerTable.create({
                  userId: receivingUser.id,
                  defaultCode: null,
                }));
              await Promise.all([
                writeFile(
                  `./yamls/${receivingUser.id}/${msg.id}.yaml`,
                  yamlData.data
                ),
                YamlTable.create({
                  code,
                  userId: receivingUser.id,
                  filename: `${msg.id}`,
                  description: yamlData.desc ?? "No description provided",
                  games: JSON.stringify(
                    yamlData.games ?? ["A Link to the Past"]
                  ),
                }),
              ]);

              if (subInt.customId === "acceptAsDefault")
                PlayerTable.update(
                  { defaultCode: code },
                  { where: { userId: receivingUser.id } }
                );

              subInt.update({
                content: `Okay, the YAML has been added to your collection${
                  subInt.customId === "acceptAsDefault"
                    ? " and assigned as your default YAML"
                    : ""
                }.`,
                components: [],
              });
            }
            break;

          case "reject":
            subInt.update({
              content: "Okay, the YAML has not been added to your collection.",
              components: [],
            });
            break;

          default:
            dismissListener = false;
            break;
        }

        if (dismissListener)
          this.client.off("interactionCreate", subInteractionHandler);
      }
      // Not sure why this is detecting as an unused variable; it's definitely not, we're using it *right now*
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      this.client.on("interactionCreate", subInteractionHandler);
    };
  }

  cmdAPGame = async (interaction: BaseCommandInteraction) => {
    if (!interaction.guild || !interaction.channel) {
      interaction.followUp({
        ephemeral: true,
        content:
          "A game currently can only be organized in a text channel of a server.",
      });
    } else {
      const {
        guildId,
        channelId,
        user: { id: startingUser },
      } = interaction;
      try {
        switch (interaction.options.get("subcommand", true).value as string) {
          case "start":
            {
              if (this.recruit[guildId]) {
                interaction.followUp(
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
              interaction.followUp({
                ephemeral: true,
                content: "No game is currently being organized!",
              });
            else if (this.recruit[guildId].startingUser !== startingUser)
              interaction.followUp({
                ephemeral: true,
                content: "You're not the person who launched this event!",
              });
            else if (this.recruit[guildId].reactedUsers.length === 0)
              interaction.followUp({
                ephemeral: true,
                content:
                  "Nobody has signed up for this game yet! Either wait for signups or cancel.",
              });
            else {
              const { reactedUsers } = this.recruit[guildId];
              this.recruit[guildId].reactionCollector?.stop("aplaunch");

              interaction.followUp(
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
              interaction.followUp({
                ephemeral: true,
                content: "No game is currently being organized!",
              });
            else if (this.recruit[guildId].startingUser !== startingUser)
              interaction.followUp({
                ephemeral: true,
                content: "You're not the person who launched this event!",
              });
            else {
              interaction.followUp("The game has been cancelled.");
              this.recruit[guildId].reactionCollector?.stop("apcancel");
            }
            break;

          default:
            interaction.followUp({
              ephemeral: true,
              content:
                "I don't recognize that subcommand. (valid options: start, launch, cancel)",
            });
            console.warn(
              "Unknown subcommand",
              interaction.options.get("subcommand", true).value
            );
            break;
        }
      } catch (e) {
        interaction.followUp(
          "An error occured. Check debug log. (Maybe you forgot to specify a subcommand?)"
        );
        console.error(e);
      }
    }
  };

  /*
  async generateGame(channel: string, users: string[]) {
  }
  */
}
