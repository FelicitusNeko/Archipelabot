import {
  Client as DiscordClient,
  Message as DiscordMessage,
  Interaction as DiscordInteraction,
  User as DiscordUser,
  BaseCommandInteraction,
  MessageActionRow,
  MessageSelectMenu,
  MessageButton,
  MessageSelectOptionData,
  MessageEmbed,
  InteractionUpdateOptions,
  InteractionReplyOptions,
  MessageAttachment,
} from "discord.js";
import { ApplicationCommandOptionTypes } from "discord.js/typings/enums";
import { userMention } from "@discordjs/builders";
import { Op as SqlOp } from "sequelize/dist";
import * as AdmZip from "adm-zip";

import { join as pathJoin, sep as pathSep, basename } from "path";
import { readdirSync } from "fs";
import { readdir, readFile, unlink, writeFile } from "fs/promises";

import { PlayerTable, YamlTable } from "./Sequelize";
import { BotConf } from "./defs";
import * as botConf from "./botconf.json";
import {
  Command,
  GameState,
  GenerateLetterCode,
  GetFile,
  isPortAvailable,
  MkdirIfNotExist,
  QuickValidateYaml,
  YamlData,
} from "./core";
import { GameManager } from "./GameManager";

export class Archipelabot {
  /** The Discord API client interface. */
  private _client: DiscordClient;
  /** The list of commands accepted by the bot. */
  private _cmds: Command[];

  // /** The list of games currently recruiting. */
  // private recruit: Record<string, GameRecruitmentProcess> = {};
  // /** The list of games currently running. */
  // private running: Record<string, RunningGame> = {};

  /** The list of games currently being used. */
  private _games: GameManager[] = [];

  /** The client's user ID, if it is available. If not, returns an empty string. */
  public get clientId(): string {
    return this._client && this._client.user ? this._client.user.id : "";
  }

  constructor(client: DiscordClient) {
    this._client = client;

    this._cmds = [
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

    this._client.once("ready", () => {
      console.log(`${client.user?.username} is online`);
      client.application?.commands.set(this._cmds);
    });

    this._client.on(
      "interactionCreate",
      async (interaction: DiscordInteraction) => {
        if (interaction.isCommand() || interaction.isContextMenu()) {
          const slashCommand = this._cmds.find(
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

    MkdirIfNotExist("./yamls");
    MkdirIfNotExist("./games");

    this._client.login((botConf as BotConf).discord.token);
  }

  cmdYaml = async (interaction: BaseCommandInteraction) => {
    const {
      user: { id: userId },
    } = interaction;

    const updateYamlList = async () => {
      const playerEntry =
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
    console.debug(
      "Message collector for YAML manager for user %s#%s is %s.",
      interaction.user.username,
      interaction.user.discriminator,
      msgCollector ? "active" : "broken"
    );
    msgCollector.on("collect", (msgIn) => {
      ResetTimeout();
      const yamls = msgIn.attachments.filter(
        (i) => i.url.endsWith(".yaml") || i.url.endsWith(".yml")
      );
      if (yamls.size === 0) msg.edit("That wasn't a YAML!");
      else {
        Promise.all(yamls.map((i) => GetFile(i.url)))
          .then(async (i) => {
            const userDir = pathJoin("./yamls", userId);
            if (curEntry) {
              // Edit an existing YAML
              const validate = QuickValidateYaml(i[0]);
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

              MkdirIfNotExist(userDir);
              for (const x in i) {
                const validate = QuickValidateYaml(i[x]);
                if (!validate.error) {
                  const code = GenerateLetterCode(usedCodes);
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
      console.debug(
        "Message collector for YAML manager for user %s#%s has been closed.",
        interaction.user.username,
        interaction.user.discriminator
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
        curEntry = await YamlTable.findByPk(subInt.values[0]);

        if (!curEntry) {
          subInt.update(startingState);
        } else {
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

    this._client.on("interactionCreate", subInteractionHandler);

    let timeoutSignal: NodeJS.Timeout;
    const Timeout = () => {
      this._client.off("interactionCreate", subInteractionHandler);
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
            const code = GenerateLetterCode(
              (await YamlTable.findAll({ attributes: ["code"] })).map(
                (i) => i.code
              )
            );
            // Create player entry if it doesn't exist
            (await PlayerTable.findByPk(receivingUser.id)) ??
              (await PlayerTable.create({
                userId: receivingUser.id,
                defaultCode: null,
              }));

            await MkdirIfNotExist(pathJoin("./yamls", receivingUser.id));
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
        this._client.off("interactionCreate", subInteractionHandler);
    };
    this._client.on("interactionCreate", subInteractionHandler);
  }

  cmdAPGame = async (interaction: BaseCommandInteraction) => {
    if (!interaction.guild || !interaction.channel || !interaction.channel.isText()) {
      interaction.followUp({
        ephemeral: true,
        content:
          "A game currently can only be organized in a text channel of a server.",
      });
    } else {
      const {
        guildId,
        user: { id: hostId },
      } = interaction;
      try {
        switch (interaction.options.get("subcommand", true).value as string) {
          case "start":
            {
              const gameHere = this._games.find((i) => i.guildId === guildId);
              if (gameHere) {
                interaction.followUp(
                  "There is already a game being organized on this server!"
                );
              } else {
                const game = await GameManager.NewGame(this._client);
                this._games.push(game);
                await game.RecruitGame(interaction);
                console.debug(game);
              }
            }
            break;

          case "launch":
            {
              const code = interaction.options.get("code", false);
              if (code && typeof code.value === "string") {
                const codeUpper = code.value.toUpperCase();
                //const gameData = await GameTable.findByPk(codeUpper);
                const creationData = await GameManager.GetCreationData(
                  codeUpper
                );

                if (creationData) {
                  if (interaction.guildId !== creationData.guild) {
                    interaction.followUp(
                      `Game ${codeUpper} was not created on this server.`
                    );
                  } else if (interaction.user.id !== creationData.host) {
                    interaction.followUp(
                      `This is not your game! Game ${codeUpper} was created by ${userMention(
                        creationData.host
                      )}.`
                    );
                  } else {
                    interaction.followUp(
                      `Attempting to launch game ${codeUpper}.`
                    );
                    const game = await GameManager.fromCode(
                      this._client,
                      codeUpper
                    );
                    this._games.push(game);
                    game.RunGame(interaction.channelId);
                  }
                } else {
                  interaction.followUp(`Game code ${codeUpper} not found.`);
                }
              } else {
                const game = this._games.find(
                  (i) =>
                    i.guildId === guildId && i.state === GameState.Assembling
                );
                if (!game) {
                  interaction.followUp({
                    ephemeral: true,
                    content: "No game is currently being organized!",
                  });
                } else if (game.hostId !== hostId) {
                  interaction.followUp({
                    ephemeral: true,
                    content: "You're not the person who launched this event!",
                  });
                } else if (game.playerCount === 0) {
                  interaction.followUp({
                    ephemeral: true,
                    content:
                      "Nobody has signed up for this game yet! Either wait for signups or cancel.",
                  });
                } else
                  game.CreateGame(interaction).then(() => {
                    this._games = this._games.filter((i) => i !== game);
                  });
              }
            }
            break;

          case "cancel":
            {
              console.debug(this._games.map(i => i.guildId))
              const game = this._games.find(
                (i) => i.guildId === guildId && i.state === GameState.Assembling
              );
              if (!game)
                interaction.followUp({
                  ephemeral: true,
                  content: "No game is currently being organized!",
                });
              else if (game.CancelGame(interaction))
                this._games = this._games.filter((i) => i !== game);
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
          const [defaultsAffected] = await PlayerTable.update(
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
            `Removed ${dbPrune} DB entry/ies, and ${filePrune} orphaned file(s), and reset ${defaultsAffected} defaults.`
          );
        }
        break;
      case "purgegame":
        GameManager.CleanupGames(interaction);
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
                  Promise.all(yamls.map((i) => GetFile(i.url)))
                    .then(async (i) => {
                      const validate = QuickValidateYaml(i[0]);
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
