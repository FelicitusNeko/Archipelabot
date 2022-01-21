import {
  Client as DiscordClient,
  Message as DiscordMessage,
  Interaction as DiscordInteraction,
  User as DiscordUser,
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
  MessageAttachment,
  MessageEditOptions,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import { userMention } from "@discordjs/builders";
import { Op as SqlOp } from "sequelize/dist";
import * as YAML from "yaml";
import * as AdmZip from "adm-zip";

import { spawn } from "child_process";
import {
  join as pathJoin,
  resolve as pathResolve,
  sep as pathSep,
  basename,
} from "path";
import { get as httpsGet } from "https";
import { createWriteStream, existsSync, readdirSync } from "fs";
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from "fs/promises";

import { GameTable, PlayerTable, YamlTable } from "./Sequelize";
import { BotConf } from "./defs";
import * as botConf from "./botconf.json";
import * as gameList from "./gamelist.json";

const { PYTHON_PATH, AP_PATH, HOST_DOMAIN } = process.env;

enum GameState {
  Assembling,
  Running,
  Stopped,
}

interface Command extends ChatInputApplicationCommandData {
  run: (interaction: BaseCommandInteraction) => Promise<void>;
}

interface GameRecruitmentProcess {
  msg: DiscordMessage;
  guildId: string;
  channelId: string;
  startingUser: string;
  reactionCollector: ReactionCollector;
  defaultUsers: string[];
  selectUsers: string[];
}

interface RunningGame {
  msg?: DiscordMessage;
  guildId: string;
  channelId: string;
  startingUser: string;
  //playingUsers: string[];
  state: GameState;
}

interface YamlData {
  error?: string;
  games?: string[];
  name?: string[];
  desc?: string;
  data: string;
}

/**
 * Creates a file system path, if it does not already exist.
 * @param path The directory path to create.
 * @returns A promise that resolves when the directory has been created. Resolves instantly if it exists.
 */
const mkdirIfNotExist = (path: string): Promise<void> =>
  !existsSync(pathResolve(path)) ? mkdir(pathResolve(path)) : Promise.resolve();

/**
 * Retrieves a file from a URL.
 * @param url The URL to retrieve.
 * @returns A promise that resolves as the data from the file.
 */
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

/**
 * Runs a quick sanity check on the given YAML data.
 * @param data The stringified YAML data.
 * @returns `true` if the YAML data looks fine; otherwise `false`.
 */
const quickValidateYaml = (data: string) => {
  const gameListStr = gameList as string[];
  try {
    const yamlIn = (() => {
      try {
        return YAML.parse(data);
      } catch (e) {
        console.warn(
          `Parsing as YAML failed: ${
            (e as Error).message
          }\nTrying to parse as JSON instead`
        );
        return JSON.parse(data);
      }
    })();

    const ValidateName = (name: string) => {
      const parsedName = name.replace(
        /\{[player|PLAYER|number|NUMBER]\}/,
        "###"
      );
      if (parsedName.length > 16) throw new Error("Name too long");
      if (parsedName.length === 0) throw new Error("Name is zero-length");
      return parsedName;
    };

    let nameList: string[] = [];
    switch (typeof yamlIn.name) {
      case "object":
        nameList = Object.keys(yamlIn.name).map(ValidateName);
        break;
      case "string":
        nameList = [ValidateName(yamlIn.name)];
        break;
      case "undefined":
        throw new Error("Name missing");
    }

    if (yamlIn.description === "") delete yamlIn.description;
    const retval: YamlData = {
      desc: yamlIn.description ?? "No description",
      name: nameList,
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
 * Checks whether a port is available.
 * @param port The port number to check.
 * @returns `true` if the port is available; otherwise `false`.
 */
const isPortAvailable = (port: number) => {
  const { platform } = process;
  return new Promise((f, r) => {
    if (port < 1024 || port > 65535) r(new Error(`Invalid port: ${port}`));
    switch (platform) {
      case "win32":
        {
          const netstat = spawn("netstat", ["-ano"]);
          let output = "";
          netstat.stdout.on("data", (data) => (output += data));
          netstat.on("close", (code) => {
            if (code === 0) {
              f(
                !output
                  .trim()
                  .split("\n")
                  .slice(4)
                  .map((i) =>
                    Number.parseInt(i.trim().split(/\s+/)[1].split(":")[1])
                  )
                  .includes(port)
              );
            } else r(new Error(`netstat returned with code: ${code}`));
          });
        }
        break;
      case "linux":
        {
          const lsof = spawn("lsof", [`-i:${port}`]);
          let output = "";
          lsof.stdout.on("data", (data) => (output += data));
          lsof.on("close", () => {
            f(output.length === 0);
          });
        }
        break;
      default:
        r(new Error(`Platform unrecognized: ${platform}`));
        break;
    }
  });
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

  private recruit: Record<string, GameRecruitmentProcess> = {};
  private running: Record<string, RunningGame> = {};

  public get clientId(): string {
    return this.client && this.client.user ? this.client.user.id : "";
  }

  constructor(client: DiscordClient) {
    this.client = client;

    this.cmds = [
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
            name: "code",
            description:
              "The game code to act upon, if any. Omit if launching a game currently being recruited.",
            required: false,
          },
        ],
        run: this.cmdAPGame,
      },
      {
        name: "admin",
        description: "Administrative functions (must be a bot admin to use)",
        type: "CHAT_INPUT",
        options: [
          {
            type: ApplicationCommandOptionTypes.STRING,
            name: "subcommand",
            description: "What subcommand to run.",
            choices: [
              { name: "Clean YAMLs", value: "cleanyaml" },
              { name: "Purge games older than 2 weeks", value: "purgegame" },
              { name: "Send YAML to user", value: "giveyaml" },
            ],
            required: true,
          },
          {
            type: ApplicationCommandOptionTypes.USER,
            name: "target",
            description: "Which user to affect with this command.",
            required: false,
          },
        ],
        run: this.cmdAdmin,
      },
      {
        name: "hello",
        description:
          'Replies "hello". Basically just to make sure the bot is running.',
        type: "CHAT_INPUT",
        run: async (interaction) => {
          interaction.followUp({
            content: "Hello! I'm awake.",
            ephemeral: true,
          });
        },
      },
      // {
      //   name: "test",
      //   description: "Testing commands",
      //   type: "CHAT_INPUT",
      //   options: [
      //     {
      //       type: ApplicationCommandOptionTypes.STRING,
      //       name: "run",
      //       description: "What test to run.",
      //       choices: [
      //         { name: "Send file", value: "sendfile" },
      //         { name: "ZIP", value: "zip" },
      //         { name: "Port detection", value: "port" },
      //         { name: "Long embeds/spoiler parsing", value: "spoiler" },
      //       ],
      //       required: true,
      //     },
      //   ],
      //   run: this.cmdTest,
      // },
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
          slashCommand.run(interaction).catch((e) => {
            console.error(e);
            interaction.followUp({
              content: "An error occured.",
              embeds: [
                new MessageEmbed({
                  title: "Error content",
                  description: (e as Error).message,
                  timestamp: Date.now(),
                }),
              ],
            });
          });
        }
      }
    );

    mkdirIfNotExist("./yamls");
    mkdirIfNotExist("./games");

    this.client.login((botConf as BotConf).discord.token);
  }

  cmdYaml = async (interaction: BaseCommandInteraction) => {
    const {
      user: { id: userId },
    } = interaction;

    const updateYamlList = async () => {
      const playerEntry =
        //(await PlayerTable.findOne({ where: { userId } })) ??
        (await PlayerTable.findByPk(userId)) ??
        (await PlayerTable.create({ userId, defaultCode: null }));
      const retval = await YamlTable.findAll({ where: { userId } }).then((r) =>
        r.map((i) => {
          return {
            label:
              i.description && i.description.length > 0
                ? i.description
                : "No description provided",
            description: i.games.join(", "),
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

    /** The current working entry for this YAML manager. */
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
                value: curEntry.games.join(", ") ?? "Unknown",
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

    /** A component row containing a YAML dropdown box. */
    const yamlRow = new MessageActionRow({
      components: [
        new MessageSelectMenu({
          customId: "yaml",
          placeholder: "Select a YAML",
          options: await updateYamlList(),
        }),
      ],
    });
    /** A component row containing buttons to manage individual YAMLs. */
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
    /** The default starting state of the YAML manager. */
    const startingState: InteractionUpdateOptions = {
      content:
        "You can reply to this message with a YAML to add it, or select one from the list to act on it.",
      embeds: [],
      components: [yamlRow],
    };

    /** The message that will be controlled to represent the YAML management interface. */
    const msg = (await (async () => {
      if (interaction.channel)
        return interaction.followUp(
          Object.assign<InteractionReplyOptions, InteractionUpdateOptions>(
            { ephemeral: true },
            startingState
          )
        );
      else {
        await interaction.followUp("Okay, YAML manager. One sec...");
        return interaction.user.send(
          Object.assign<InteractionReplyOptions, InteractionUpdateOptions>(
            { ephemeral: true },
            startingState
          )
        );
      }
    })()) as DiscordMessage;

    /** The message collector that will gather YAMLs sent in. */
    const msgCollector = msg.channel.createMessageCollector({
      filter: (msgIn) =>
        msgIn.type === "REPLY" &&
        msgIn.reference?.messageId === msg.id &&
        msgIn.attachments.size > 0,
    });
    console.info(
      "Message collector for YAML manager for user %s is %s.",
      userId,
      msgCollector ? "active" : "broken"
    );
    msgCollector.on("collect", (msgIn) => {
      ResetTimeout();
      const yamls = msgIn.attachments.filter(
        (i) => i.url.endsWith(".yaml") || i.url.endsWith(".yml")
      );
      if (yamls.size === 0) msg.edit("That wasn't a YAML!");
      else {
        Promise.all(yamls.map((i) => getFile(i.url)))
          .then(async (i) => {
            const userDir = pathJoin("./yamls", userId);
            if (curEntry) {
              // Edit an existing YAML
              const validate = quickValidateYaml(i[0]);
              if (!validate.error) {
                await writeFile(pathJoin(userDir, `${msgIn.id}-u.yaml`), i[0]);
                const updateInfo = {
                  filename: `${msgIn.id}-u`,
                  description: validate.desc ?? "No description provided",
                  games: validate.games ?? ["A Link to the Past"],
                  playerName: validate.name,
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
              // Add a new YAML
              /** The list of currently used codes in the YAML manager. */
              const usedCodes = (
                await YamlTable.findAll({ attributes: ["code"] })
              ).map((i) => i.code);
              let addedCount = 0;

              mkdirIfNotExist(userDir);
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
                      playerName: validate.name ?? ["Who?"],
                      games: validate.games ?? ["A Link to the Past"],
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
            else msgIn.react("👀");
          })
          .catch((e) => {
            msg.edit("An error occurred. Check debug log.");
            console.error(e);
          });
      }
    });
    msgCollector.on("end", (_collected, reason) => {
      if (reason === "time")
        msg.edit({ content: "Timed out.", embeds: [], components: [] });
      console.info(
        "Message collector for YAML manager for user %s has been closed.",
        userId
      );
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
        // curEntry = await YamlTable.findOne({
        //   where: { code: subInt.values[0] },
        // });
        curEntry = await YamlTable.findByPk(subInt.values[0]);

        if (!curEntry) {
          subInt.update(startingState);
        } else {
          // const playerEntry = await PlayerTable.findOne({
          //   where: { userId },
          // });
          const playerEntry = await PlayerTable.findByPk(userId);
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
            curEntry = null;
            subInt.update(
              Object.assign<InteractionUpdateOptions, InteractionUpdateOptions>(
                startingState,
                {
                  content:
                    "The YAML has been deleted. You can now add more if you wish, or manage any remaining YAMLs.",
                }
              )
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
  };

  async sendYamlForApproval(
    sendingUser: string,
    receivingUser: DiscordUser | undefined,
    yamlData: YamlData,
    yamlAttach?: MessageAttachment
  ) {
    if (!receivingUser || !yamlAttach) return;

    const msg = (await receivingUser.send({
      content: `${userMention(
        sendingUser
      )} has sent you a YAML. Please review it and choose if you'd like to add it to your collection.`,
      //attachments: [yamlAttach],
      files: [{ attachment: Buffer.from(yamlData.data) }],
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
      if (!subInt.isButton()) return;
      if (subInt.user.id !== receivingUser.id) return;
      if (subInt.message.id !== msg.id) return;

      let dismissListener = true;
      switch (subInt.customId) {
        case "accept":
        case "acceptAsDefault":
          {
            const code = generateLetterCode(
              (await YamlTable.findAll({ attributes: ["code"] })).map(
                (i) => i.code
              )
            );
            // Create player entry if it doesn't exist
            // (await PlayerTable.findOne({
            //   where: { userId: receivingUser.id },
            // })) ??
            (await PlayerTable.findByPk(receivingUser.id)) ??
              (await PlayerTable.create({
                userId: receivingUser.id,
                defaultCode: null,
              }));

            await mkdirIfNotExist(pathJoin("./yamls", receivingUser.id));
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
                //playerName: JSON.stringify(yamlData.name ?? ["Who?"]),
                playerName: yamlData.name ?? ["Who?"],
                games: yamlData.games ?? ["A Link to the Past"],
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
              embeds: [],
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
          subInt.update({
            content: `Something weird happened. customId: ${subInt.customId}`,
          });
          dismissListener = false;
          break;
      }

      if (dismissListener)
        this.client.off("interactionCreate", subInteractionHandler);
    };
    this.client.on("interactionCreate", subInteractionHandler);
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
                const gameCode = generateLetterCode(
                  (await GameTable.findAll({ attributes: ["code"] })).map(
                    (i) => i.code
                  )
                );
                const msg = (await interaction.followUp({
                  content: `${userMention(startingUser)} is starting a game!`,
                  embeds: [
                    new MessageEmbed({
                      title: "Multiworld Game Call",
                      description:
                        "React ⚔️ to join into this game with your default YAML.\n" +
                        "React 🛡️ to join with a different YAML.",
                      footer: {
                        text: `Game code: ${gameCode}`,
                      },
                    }),
                  ],
                })) as DiscordMessage;
                await msg.react("⚔️");
                await msg.react("🛡️");

                const newRecruit: GameRecruitmentProcess = {
                  msg,
                  guildId,
                  channelId,
                  startingUser,
                  defaultUsers: [],
                  selectUsers: [],
                  reactionCollector: msg.createReactionCollector({
                    filter: (reaction, user) =>
                      this.clientId !== user.id &&
                      reaction.emoji.name !== null &&
                      ["⚔️", "🛡️"].includes(reaction.emoji.name),
                    dispose: true,
                  }),
                };
                this.recruit[guildId] = newRecruit;

                const { reactionCollector } = newRecruit;
                reactionCollector.on("collect", (reaction, user) => {
                  if (reaction.emoji.name === "⚔️")
                    newRecruit.defaultUsers.push(user.id);
                  else if (reaction.emoji.name === "🛡️")
                    newRecruit.selectUsers.push(user.id);
                });
                reactionCollector.on("remove", (reaction, user) => {
                  if (reaction.emoji.name === "⚔️")
                    newRecruit.defaultUsers = newRecruit.defaultUsers.filter(
                      (i) => i != user.id
                    );
                  else if (reaction.emoji.name === "🛡️")
                    newRecruit.selectUsers = newRecruit.selectUsers.filter(
                      (i) => i != user.id
                    );
                });
                reactionCollector.on("dispose", (reaction) => {
                  // TODO: find out when this event fires (if it does)
                  console.debug("Dispose:" /*, reaction*/);
                  if (reaction.emoji.name === "⚔️") {
                    newRecruit.msg.react("⚔️");
                    newRecruit.defaultUsers = [];
                  }
                });
                reactionCollector.on("end", async (_collected, reason) => {
                  if (["aplaunch", "apcancel"].includes(reason)) {
                    await newRecruit.msg.delete();
                    delete this.recruit[newRecruit.guildId];
                  }
                });
              }
            }
            break;

          case "launch":
            {
              const code = interaction.options.get("code", false);
              if (code && typeof code.value === "string") {
                const codeUpper = code.value.toUpperCase();
                // const gameData = await GameTable.findOne({
                //   where: { code: codeUpper },
                // });
                const gameData = await GameTable.findByPk(codeUpper);
                if (gameData) {
                  if (interaction.guildId !== gameData.guildId) {
                    interaction.followUp(
                      `Game ${codeUpper} was not created on this server.`
                    );
                  } else if (interaction.user.id !== gameData.userId) {
                    interaction.followUp(
                      `This is not your game! Game ${codeUpper} was created by ${userMention(
                        gameData.userId
                      )}.`
                    );
                  } else {
                    interaction.followUp(
                      `Attempting to launch game ${codeUpper}.`
                    );
                    this.RunGame(codeUpper, interaction.channelId);
                  }
                } else {
                  interaction.followUp(`Game code ${codeUpper} not found.`);
                }
              } else if (!this.recruit[guildId])
                interaction.followUp({
                  ephemeral: true,
                  content: "No game is currently being organized!",
                });
              else if (this.recruit[guildId].startingUser !== startingUser)
                interaction.followUp({
                  ephemeral: true,
                  content: "You're not the person who launched this event!",
                });
              else if (
                this.recruit[guildId].defaultUsers.length +
                  this.recruit[guildId].selectUsers.length ===
                0
              )
                interaction.followUp({
                  ephemeral: true,
                  content:
                    "Nobody has signed up for this game yet! Either wait for signups or cancel.",
                });
              else this.CreateGame(interaction, this.recruit[guildId]);
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

  async CreateGame(
    interaction: BaseCommandInteraction,
    recruitInfo: GameRecruitmentProcess
  ) {
    const { reactionCollector, defaultUsers, selectUsers } = recruitInfo;
    reactionCollector.stop("aplaunch");

    if (!PYTHON_PATH) {
      interaction.reply("Python path has not been defined! Game cannot start.");
      return;
    }
    if (!AP_PATH) {
      interaction.reply(
        "Archipelago path has not been defined! Game cannot start."
      );
      return;
    }

    const code = generateLetterCode(
      (await GameTable.findAll({ attributes: ["code"] })).map((i) => i.code)
    );
    const defaultYamls = await PlayerTable.findAll({
      attributes: ["userId", "defaultCode"],
      where: {
        userId: {
          [SqlOp.in]: defaultUsers.filter((i) => !selectUsers.includes(i)),
        },
        defaultCode: { [SqlOp.not]: null },
      },
    });
    const hasDefaults = defaultYamls.map((i) => i.userId);
    const missingDefaults = defaultUsers
      .filter((i) => !hasDefaults.includes(i) && !selectUsers.includes(i))
      .concat(selectUsers);

    const LaunchGame = async (
      incomingYamls?: [string, string][],
      msg?: DiscordMessage
    ) => {
      const playerList: [string, string][] = defaultYamls.map((i) => [
        i.userId,
        i.defaultCode,
      ]) as [string, string][];
      if (incomingYamls) playerList.push(...incomingYamls);

      const writeMsg = (
        msgContent: string | (MessageEditOptions & InteractionReplyOptions)
      ) => {
        if (msg) msg.edit(msgContent);
        else interaction.followUp(msgContent);
      };

      if (playerList.length === 0) {
        writeMsg(
          "There are no players left to play this game! It has been cancelled."
        );
        delete this.running[code];
        return;
      }

      //await mkdirIfNotExist(pathJoin(AP_PATH, "Players"));
      const outputPath = pathJoin("./games", code);
      await mkdirIfNotExist(outputPath);

      //const yamlPath = pathJoin(AP_PATH, "Players", code);
      const yamlPath = pathJoin(outputPath, 'yamls');
      await mkdirIfNotExist(yamlPath);
      await readdir(yamlPath, { withFileTypes: true }).then((files) =>
        files
          .filter((i) => !i.isDirectory())
          .forEach((i) => unlink(pathJoin(yamlPath, i.name)))
      );

      const playerYamlList = await YamlTable.findAll({
        attributes: ["userId", "filename", "playerName"],
        where: { code: { [SqlOp.in]: playerList.map((i) => i[1]) } },
      });

      await Promise.all(
        playerYamlList.map((i) =>
          copyFile(
            //`./yamls/${i.userId}/${i.filename}.yaml`,
            pathJoin('yamls', i.userId, `${i.filename}.yaml`),
            pathJoin(yamlPath, `${i.filename}.yaml`)
          )
        )
      );

      const outputFile = await new Promise<string>((f, r) => {
        const pyApGenerate = spawn(
          PYTHON_PATH,
          [
            "Generate.py",
            "--player_files_path",
            pathResolve(yamlPath),
            "--outputpath",
            pathResolve(outputPath),
          ],
          { cwd: AP_PATH, windowsHide: true }
        );
        let outData = "";
        let errData = "";

        const logout = createWriteStream(
          pathJoin(outputPath, `${code}-gen.stdout.log`)
        );
        const logerr = createWriteStream(
          pathJoin(outputPath, `${code}-gen.stderr.log`)
        );
        let errTimeout: NodeJS.Timeout | undefined = undefined;

        pyApGenerate.stdout.on("data", (data: Buffer) => {
          logout.write(data);
          outData += data;
          if (data.toString().includes("press enter to install it"))
            pyApGenerate.stdin.write("\n");
          else if (data.toString().includes("Press enter to close"))
            pyApGenerate.stdin.write("\n");
          if (errTimeout) {
            clearTimeout(errTimeout);
            errTimeout = undefined;
          }
        });
        pyApGenerate.stderr.on("data", (data: Buffer) => {
          logerr.write(data);
          errData += data;
          if (data.toString().includes("press enter to install it"))
            pyApGenerate.stdin.write("\n");
          else if (data.toString().includes("Press enter to close"))
            pyApGenerate.stdin.write("\n");
          else {
            if (errTimeout) clearTimeout(errTimeout);
            errTimeout = setTimeout(() => {
              pyApGenerate.stdin.write("\n");
              errTimeout = undefined;
            }, 3000);
          }
        });
        pyApGenerate.on("close", (code: number) => {
          logout.close();
          logerr.close();

          if (code === 0) {
            const outputFile = /(AP_\d+\.zip)/.exec(outData);
            if (!outputFile || !outputFile[1])
              r(new Error("Unable to identify output file"));
            else f(outputFile[1]);
          } else r(new Error(errData));
        });
      }).catch((e) => {
        writeMsg({
          content: "An error occurred during game generation.",
          files: [
            new MessageAttachment((e as Error).message, "Generation Error.txt"),
          ],
        });
        return undefined;
      });
      if (outputFile === undefined) return;

      const gameZip = new AdmZip(pathJoin(outputPath, outputFile));
      const gameZipEntries = gameZip.getEntries();
      const playerListing: RegExpExecArray[] = [];
      gameZipEntries
        .filter((i) => i.name.endsWith(".archipelago"))
        .forEach((i) => writeFile(pathJoin(outputPath, i.name), i.getData()));
      const spoiler = gameZipEntries
        .filter((i) => i.name.endsWith("_Spoiler.txt"))
        .map((i) => {
          const spoilerData = i.getData();
          const spoilerDataString = spoilerData.toString();
          const playerCountResult = /Players:\s+(\d+)/.exec(spoilerDataString);
          const playerCount = playerCountResult
            ? Number.parseInt(playerCountResult[1])
            : 2;
          if (playerCount === 1) {
            const gameMatch = /Game:\s+(.*)/.exec(spoilerDataString);
            if (gameMatch) playerListing.push(gameMatch);
          } else {
            const playerListingRegex =
              /Player (\d+)+: (.+)[\r\n]+Game:\s+(.*)/gm;
            for (
              let match = playerListingRegex.exec(spoilerDataString);
              match !== null;
              match = playerListingRegex.exec(spoilerDataString)
            )
              playerListing.push(match);
          }
          //return { attachment: spoilerData, name: i.name } as MessageAttachment;
          return new MessageAttachment(spoilerData)
            .setName(i.name)
            .setSpoiler(true);
        });

      writeMsg({
        content:
          `Game ${code} has been generated. Players: ` +
          playerList.map((i) => userMention(i[0])).join(", "),
        files: spoiler.map((i) => i.setSpoiler(true)),
        embeds:
          playerListing.length > 0
            ? [
                new MessageEmbed({
                  title: "Who's Playing What",
                  description:
                    playerListing.length === 1
                      ? `It's only you for this one, and you'll be playing **${playerListing[0][1]}**.`
                      : playerListing
                          .map((i) => `${i[2]} → **${i[3]}**`)
                          .join("\n"),
                }),
              ]
            : [],
      });

      for (const { userId, playerName } of playerYamlList) {
        const user = this.client.users.cache.get(userId);
        if (!user) continue;

        //const playerNames: string[] = JSON.parse(playerName);
        const playerFile = gameZipEntries
          .filter((i) => {
            for (const name of playerName)
              if (i.name.indexOf(name) > 0) return true;
            return false;
          })
          .map((i) => {
            return { attachment: i.getData(), name: i.name };
          });

        if (playerFile.length > 0)
          user.send({
            content:
              `Here is your data file for game ${code}. If you're not sure how to use this, ` +
              `please refer to the Archipelago setup guide for your game, or ask someone for help.`,
            files: playerFile,
          });
      }

      GameTable.create({
        code,
        filename: basename(outputFile, ".zip"),
        guildId: recruitInfo.guildId,
        userId: recruitInfo.startingUser,
        active: false,
      });

      this.RunGame(code, recruitInfo.channelId);
    };

    this.running[code] = {
      state: GameState.Assembling,
      guildId: recruitInfo.guildId,
      channelId: recruitInfo.channelId,
      startingUser: recruitInfo.startingUser,
    };

    if (missingDefaults.length === 0) LaunchGame();
    else {
      const incomingYamls: Record<string, string | null> = {};

      const msg = (await interaction.followUp(
        "The following player(s) need to provide a YAML before the game can begin. " +
          `The game will start <t:${
            Math.floor(Date.now() / 1000) + 30 * 60
          }:R> if not everyone has responded.\n` +
          missingDefaults.map((i) => userMention(i)).join(", ")
      )) as DiscordMessage;

      const CheckPlayerResponses = () => {
        if (Object.keys(incomingYamls).length === missingDefaults.length) {
          msg.edit(
            "Everyone's responses have been received. Now generating the game..."
          );
          LaunchGame(
            Object.entries(incomingYamls).filter((i) => i[1] !== null) as [
              string,
              string
            ][],
            msg
          );
        }
      };

      for (const userId of missingDefaults) {
        const user = this.client.users.cache.get(userId);
        if (!user) {
          incomingYamls[userId] = null;
          break;
        }

        const yamls = await YamlTable.findAll({ where: { userId } });

        const msg = (await user.send({
          content:
            (selectUsers.includes(userId)
              ? "Please select the YAML you wish to use from the dropdown box, or, alternatively, submit a new one by replying to this message with an attachment."
              : "Looks like you don't have a default YAML set up. Please select one from the list, or reply to this message with a new one.") +
            ` If you've changed your mind, you can click on "Withdraw". This message will time out <t:${
              Math.floor(Date.now() / 1000) + 30 * 60
            }:R>.`,
          components: [
            new MessageActionRow({
              components: [
                new MessageSelectMenu({
                  customId: "selectYaml",
                  placeholder: "Select a YAML",
                  options:
                    yamls.length > 0
                      ? yamls.map((i) => {
                          return {
                            label: i.description,
                            description: i.games.join(", "),
                            value: i.code,
                          } as MessageSelectOptionData;
                        })
                      : [{ label: "No YAMLs", value: "noyaml" }],
                }),
              ],
            }),
            new MessageActionRow({
              components: [
                new MessageButton({
                  customId: "withdraw",
                  label: "Withdraw",
                  style: "DANGER",
                }),
              ],
            }),
          ],
        })) as DiscordMessage;

        const subInteractionHandler = async (subInt: DiscordInteraction) => {
          if (!subInt.isButton() && !subInt.isSelectMenu()) return;
          if (subInt.user.id !== userId) return;
          if (subInt.message.id !== msg.id) return;

          if (subInt.isButton()) {
            switch (subInt.customId) {
              case "withdraw":
                incomingYamls[userId] = null;
                subInt.update(
                  "Sorry to hear that. Your request has been withdrawn."
                );
                msgCollector.stop("withdrawn");
                break;
            }
          } else if (subInt.isSelectMenu()) {
            const code = subInt.values[0];
            if (code === "noyaml")
              subInt.update({
                content:
                  "You don't seem to have any YAMLs assigned to you. Please submit one by replying to this message with an attachment.",
              });
            else {
              incomingYamls[userId] = code;
              subInt.update(
                "Thanks! Your YAML has been received and will be used in your upcoming game."
              );
              msgCollector.stop("selectedyaml");
            }
          }
        };
        this.client.on("interactionCreate", subInteractionHandler);

        const msgCollector = msg.channel.createMessageCollector({
          filter: (msgIn) =>
            msgIn.type === "REPLY" &&
            msgIn.reference?.messageId === msg.id &&
            msgIn.attachments.size > 0,
          time: 30 * 60 * 1000,
        });
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
                  //const filename = `./yamls/${userId}/${msg.id}.yaml`;
                  const filepath = pathJoin("./yamls", userId);
                  const filename = pathJoin(filepath, msg.id + ".yaml");
                  await mkdirIfNotExist(filepath);

                  const code = generateLetterCode(
                    (await YamlTable.findAll({ attributes: ["code"] })).map(
                      (i) => i.code
                    )
                  );
                  await Promise.all([
                    // PlayerTable.findOne({ where: { userId } }).then(
                    PlayerTable.findByPk(userId).then(
                      (i) =>
                        i ?? PlayerTable.create({ userId, defaultCode: null })
                    ),
                    YamlTable.create({
                      code,
                      userId,
                      //playerName: JSON.stringify(validate.name ?? ["Who?"]),
                      playerName: validate.name ?? ["Who?"],
                      description: validate.desc ?? "No description given",
                      games: validate.games ?? ["A Link to the Past"],
                      filename: msg.id,
                    }),
                    writeFile(filename, validate.data),
                  ]);

                  incomingYamls[userId] = code;
                  msgCollector.stop("newyaml");
                } else {
                  msg.edit({
                    content: `The supplied YAML was invalid: ${validate.error}. Please try again.`,
                  });
                }

                if (msgIn.deletable) msgIn.delete();
                else msgIn.react("👀");
              })
              .catch((e) => {
                msg.edit("An error occurred. Check debug log.");
                console.error(e);
              });
          }
        });
        msgCollector.on("end", (_collected, reason) => {
          const finallyMsg = (() => {
            console.info(`${code}: ${user.username} responded ${reason}`);
            switch (reason) {
              case "time":
                return "Sorry, this YAML request has timed out.";
              case "newyaml":
                return "Thanks! Your new YAML has been added to your library and will be used in your upcoming game.";
              case "selectedyaml":
                return "Thanks! That YAML will be used in your upcoming game.";
              case "withdrawn":
                return "Sorry to hear that. Your request has been withdrawn.";
              default:
                return `Unrecognized reason code: ${reason}`;
            }
          })();
          msg.edit({
            content: finallyMsg,
            components: [],
          });
          CheckPlayerResponses();
          this.client.off("interactionCreate", subInteractionHandler);
        });
      }
    }
  }

  async RunGame(code: string, channelId: string) {
    const channel = this.client.channels.cache.get(channelId);
    if (!channel) throw new Error("Cannot find channel");
    if (!channel.isText()) throw new Error("Channel is not text channel");

    if (!PYTHON_PATH) {
      channel.send("Python path has not been defined! Game cannot start.");
      return;
    }
    if (!AP_PATH) {
      channel.send("Archipelago path has not been defined! Game cannot start.");
      return;
    }

    // const gameData = await GameTable.findOne({ where: { code } });
    const gameData = await GameTable.findByPk(code);
    if (!gameData) {
      channel.send(`Game ${code} not found.`);
      return;
    }
    if (
      gameData.active ||
      (this.running[code] && this.running[code].state === GameState.Running)
    ) {
      channel.send(`Game ${code} is already running.`);
      return;
    }

    if (this.running[code]) {
      this.running[code] = Object.assign<RunningGame, Partial<RunningGame>>(
        this.running[code],
        {
          state: GameState.Running,
        }
      );
    } else {
      this.running[code] = {
        state: GameState.Running,
        guildId: gameData.guildId,
        startingUser: gameData.userId,
        channelId,
      };
    }

    const port = (() => {
      let port;
      do {
        port = 38281 + Math.floor(Math.random() * 1000);
      } while (!isPortAvailable(port));
      return port;
    })();

    const liveEmbed = new MessageEmbed({
      title: "Archipelago Server",
      fields: [
        {
          name: "Server output",
          value: "Wait...",
        },
        {
          name: "Server",
          value: `${HOST_DOMAIN}:${port}`,
          inline: true,
        },
        {
          name: "Host",
          value: userMention(gameData.userId),
        },
      ],
      footer: {
        text: `Game code: ${code}`,
      },
    });
    const msg = await channel.send({
      content:
        `Game ${code} is live! The game host can reply to this message to send commands to the server. ` +
        "To send a slash command, precede it with a period instead of a slash so that it doesn't get intercepted by Discord. " +
        "For instance: `.forfeit player`",
      embeds: [liveEmbed],
    });

    const gamePath = pathJoin("./games", code);
    const logout = createWriteStream(
      pathJoin(gamePath, `${gameData.filename}.stdout.log`)
    );

    const lastFiveLines: string[] = [];
    const pyApServer = spawn(
      PYTHON_PATH,
      [
        "MultiServer.py",
        "--port",
        port.toString(),
        "--use_embedded_options",
        pathResolve(pathJoin(gamePath, gameData.filename + ".archipelago")),
      ],
      { cwd: AP_PATH }
    );
    pyApServer.stderr.pipe(
      createWriteStream(pathJoin(gamePath, `${gameData.filename}.stderr.log`))
    );

    let lastUpdate = Date.now();
    let timeout: NodeJS.Timeout | undefined;

    const UpdateOutput = () => {
      lastUpdate = Date.now();
      liveEmbed.fields[0].value = lastFiveLines.join("\n");
      msg.edit({
        embeds: [liveEmbed],
      });
      timeout = undefined;
    };

    pyApServer.stdout.on("data", (data: Buffer) => {
      logout.write(data);
      lastFiveLines.push(...data.toString().trim().split(/\n/));
      while (lastFiveLines.length > 5) lastFiveLines.shift();
      if (!timeout) {
        const deltaLastUpdate = Date.now() - lastUpdate - 1000;
        if (deltaLastUpdate < 0)
          timeout = setTimeout(UpdateOutput, Math.abs(deltaLastUpdate));
        else UpdateOutput();
      }
      if (data.toString().includes("press enter to install it"))
        pyApServer.stdin.write("\n");
    });
    pyApServer.stdout.on("close", logout.close);

    pyApServer.on("close", (pcode) => {
      if (timeout) clearTimeout(timeout);
      msg.edit({
        content: `Server for game ${code} closed ${
          pcode === 0 ? "normally" : ` with error code ${pcode}`
        }.`,
        embeds: [],
      });
      GameTable.update({ active: false }, { where: { code } });
      msgCollector.stop("serverclose");
      delete this.running[code];
    });

    const msgCollector = channel.createMessageCollector({
      filter: (msgIn) =>
        msgIn.type === "REPLY" &&
        msgIn.reference?.messageId === msg.id &&
        msgIn.author.id === gameData.userId,
    });
    msgCollector.on("collect", (msgIn) => {
      pyApServer.stdin.write(msgIn.content.replace(/^\./, "/") + "\n");
      lastFiveLines.push("← " + msgIn.content.replace(/^\./, "/"));
      while (lastFiveLines.length > 5) lastFiveLines.shift();

      if (msgIn.deletable) msgIn.delete();
      else msgIn.react("⌨️");
    });
  }

  cmdTest = async (interaction: BaseCommandInteraction) => {
    switch (interaction.options.get("run", true).value as string) {
      case "sendfile":
        interaction.followUp({
          content: "Here you go.",
          files: [
            {
              attachment: await readFile(".yarnrc.yml"),
              name: "test.yaml",
            },
          ],
        });
        break;
      case "zip":
        {
          const testZip = new AdmZip("./test/AP_77478974287435297562.zip");
          interaction.followUp({
            content: "Here you go.",
            files: testZip
              .getEntries()
              .filter((i) => i.name.endsWith(".txt"))
              .map((i) => {
                return { attachment: i.getData(), name: i.name };
              }),
          });
        }
        break;
      case "port":
        interaction.followUp(
          `Port 38281 is ${
            (await isPortAvailable(38281)) ? "" : "not "
          }available.`
        );
        break;
      case "spoiler":
        {
          const bigSpoiler = (
            await readFile("./test/AP_51012885067020691880_Spoiler.txt")
          ).toString();
          const playerListing: RegExpExecArray[] = [];
          const playerListingRegex = /Player (\d+): (.+)[\r\n]+Game:\s+(.*)/gm;

          for (
            let match = playerListingRegex.exec(bigSpoiler);
            match !== null;
            match = playerListingRegex.exec(bigSpoiler)
          )
            playerListing.push(match);

          interaction.followUp({
            content: `Testing reading the spoiler file for players.`,
            embeds:
              playerListing.length > 0
                ? [
                    new MessageEmbed({
                      title: "Who's Playing What",
                      description: playerListing
                        .map((i) => `${i[1]}: ${i[2]} → **${i[3]}**`)
                        .join("\n"),
                    }),
                  ]
                : [],
          });
        }
        break;
      default:
        interaction.followUp(
          "Unrecognized subcommand. That shouldn't happen..."
        );
    }
  };

  cmdAdmin = async (interaction: BaseCommandInteraction) => {
    // TODO: Make sure user running command is an admin (hard-coded to me for now)
    if (interaction.user.id !== "475120074621976587") {
      interaction.followUp({
        ephemeral: true,
        content: "You're not a bot admin!",
      });
      return;
    }

    switch (interaction.options.get("subcommand", true).value as string) {
      case "cleanyaml":
        {
          const [yamlDb, yamlFiles] = await Promise.all([
            YamlTable.findAll().then((i) =>
              i.map((ii) => pathJoin("yamls", ii.userId, `${ii.filename}.yaml`))
            ),
            readdir("yamls", { withFileTypes: true }).then((yamlDir) =>
              yamlDir
                .filter((yamlUserDir) => yamlUserDir.isDirectory)
                .map((yamlUserDir) =>
                  readdirSync(pathJoin("yamls", yamlUserDir.name))
                    .filter((yamlFile) => yamlFile.endsWith(".yaml"))
                    .map((yamlFile) =>
                      pathJoin("yamls", yamlUserDir.name, yamlFile)
                    )
                )
                .flat()
            ),
          ]);
          /** The list of files that are in common between the database and the file store. */
          const yamlCommon = yamlDb.filter((i) => yamlFiles.includes(i));

          /** The number of database entries pruned. */
          const dbPrune = yamlDb.length - yamlCommon.length,
            /** The number of file entries pruned. */
            filePrune = yamlFiles.length - yamlCommon.length;

          if (filePrune > 0) {
            // First, unlink orphaned files
            for (const file of yamlFiles.filter((i) => !yamlCommon.includes(i)))
              await unlink(file);
          }

          if (dbPrune > 0) {
            // Then, deal with cleaning the database
            /** The data to be used for cleaning the database. */
            const dbCleanup: Record<string, string[]> = {};
            // first here, parse the file list
            for (const file of yamlDb
              .filter((i) => !yamlCommon.includes(i))
              .map((i) => i.split(pathSep).slice(1))) {
              if (!dbCleanup[file[0]]) dbCleanup[file[0]] = [file[1]];
              else dbCleanup[file[0]].push(file[1]);
            }
            console.debug(dbCleanup);
            // then, remove any users that don't have any files (otherwise, they wouldn't get pruned at all)
            await YamlTable.destroy({
              where: { userId: { notIn: Object.keys(dbCleanup) } },
            });
            // finally, remove missing entries for users
            for (const op of Object.entries(dbCleanup)) {
              await YamlTable.destroy({
                where: {
                  userId: op[0],
                  filename: { notIn: op[1].map((i) => basename(i, ".yaml")) },
                },
              });
            }
          }

          // finally, clear any invalid defaults
          await PlayerTable.update(
            { defaultCode: null },
            {
              where: {
                defaultCode: {
                  [SqlOp.notIn]: (
                    await YamlTable.findAll({ attributes: ["code"] })
                  ).map((i) => i.code),
                },
              },
            }
          );

          interaction.followUp(
            `Removed ${dbPrune} DB entry/ies, and ${filePrune} orphaned file(s).`
          );
        }
        break;
      case "purgegame":
        interaction.followUp("Not implemented yet.");
        break;
      case "giveyaml":
        {
          try {
            const sendingUser = interaction.user.id;
            const targetUser = interaction.options.get("target", true);
            if (!targetUser.value || !targetUser.user)
              throw new Error("Failed to resolve user");
            else {
              const msg = (await (async () => {
                const supervisorMsg = {
                  ephemeral: true,
                  content: `Assigning a YAML to ${userMention(
                    targetUser.value as string
                  )}. Please reply to this message with the YAML you wish to assign.`,
                };
                if (interaction.channel)
                  return interaction.followUp(supervisorMsg);
                else {
                  await interaction.followUp(
                    "Okay, YAML supervisor. One sec..."
                  );
                  return interaction.user.send(supervisorMsg);
                }
              })()) as DiscordMessage;

              const msgCollector = msg.channel.createMessageCollector({
                filter: (msgIn) =>
                  msgIn.type === "REPLY" &&
                  msgIn.reference?.messageId === msg.id &&
                  msgIn.attachments.size > 0,
              });
              msgCollector.on("collect", (msgIn) => {
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
                          validate,
                          yamls.first()
                        );
                      } else {
                        msg.edit(
                          `The supplied YAML was invalid: ${validate.error}. Please try again.`
                        );
                      }

                      if (msgIn.deletable) msgIn.delete();
                      else msgIn.react("👀");
                    })
                    .catch((e) => {
                      msg.edit("An error occurred. Check debug log.");
                      console.error(e);
                    });
                }
              });
            }
          } catch (e) {
            interaction.followUp({
              ephemeral: true,
              content:
                "Oops, an error occured. (Did you maybe forget to specify a user?)",
            });
            console.error(e);
          }
        }
        break;
      default:
        interaction.followUp(
          "Unrecognized subcommand. That shouldn't happen..."
        );
    }
  };
}
