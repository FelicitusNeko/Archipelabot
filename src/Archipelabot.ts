import {
  Client as DiscordClient,
  // Message as DiscordMessage,
  Interaction as DiscordInteraction,
  User as DiscordUser,
  CommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  InteractionType,
  MessageType,
  ChannelType,
  ButtonStyle,
  userMention,
} from "discord.js";
import * as AdmZip from "adm-zip";

import { Dirent } from "fs";
import { readdir, readFile, writeFile } from "fs/promises";
import { basename, join as pathJoin } from "path";

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
  SystemHasScreen,
  YamlData,
} from "./core";
import { GameManager } from "./GameManager";
import { YamlManager } from "./YamlManager";

const { ENABLE_TEST } = process.env;

export class Archipelabot {
  /** The Discord API client interface. */
  private _client: DiscordClient;
  /** The list of commands accepted by the bot. */
  private _cmds: Command[];

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
        type: ApplicationCommandType.ChatInput,
        run: this.cmdYaml,
      },
      {
        name: "apgame",
        description: "Start and manage Archipelago games",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
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
            type: ApplicationCommandOptionType.String,
            name: "code",
            description:
              "The game code to act upon, if any. Omit if launching a game currently being recruited.",
            required: false,
          },
        ],
        run: this.cmdAPGame,
      },
      {
        name: "aptestgame",
        description: "Start Archipelago test games (use /apgame to manage)",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "subcommand",
            description: "What game command to run.",
            choices: [{ name: "Start", value: "start" }],
            required: true,
          },
        ],
        run: (i) => this.cmdAPGame(i, true),
      },
      {
        name: "admin",
        description: "Administrative functions (must be a bot admin to use)",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
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
            type: ApplicationCommandOptionType.String,
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
        type: ApplicationCommandType.ChatInput,
        run: async (interaction) => {
          interaction.followUp({
            content: "Hello! I'm awake.",
            ephemeral: true,
          });
        },
      },
    ];

    //console.debug("Test state:", ENABLE_TEST);
    if (ENABLE_TEST === "1") {
      console.info("Enabling test suite");
      this._cmds.push({
        name: "test",
        description: "Testing commands",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "run",
            description: "What test to run.",
            choices: [
              { name: "Send file", value: "sendfile" },
              { name: "ZIP", value: "zip" },
              { name: "Port detection", value: "port" },
              { name: "Long embeds/spoiler parsing", value: "spoiler" },
              { name: "Rebuild YAML table", value: "rebuildyaml" },
              { name: "Check for 'screen'", value: "checkscreen" },
            ],
            required: true,
          },
        ],
        run: this.cmdTest,
      });
    }

    console.debug(
      "Commands:",
      this._cmds.map((i) => i.name)
    );

    this._client.once("ready", () => {
      console.log(`${client.user?.username} is online`);
      client.application?.commands.set(this._cmds);
    });

    this._client.on(
      "interactionCreate",
      async (interaction: DiscordInteraction) => {
        //if (interaction.isCommand() || interaction.isContextMenu()) {
        if (interaction.type == InteractionType.ApplicationCommand) {
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
                new EmbedBuilder({
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
    MkdirIfNotExist("./pipes");

    this._client.login((botConf as BotConf).discord.token);
  }

  cmdYaml = async (interaction: CommandInteraction) => {
    const {
      user: { id: userId },
    } = interaction;

    interaction.followUp("Okay, YAML manager. One sec...");
    const manager = new YamlManager(this._client, userId);
    manager.YamlManager();
  };

  async sendYamlForApproval(
    sendingUser: string,
    receivingUser: DiscordUser | undefined,
    yamlData: YamlData,
    yamlAttach?: AttachmentBuilder // NOTE: is this being used?
  ) {
    if (!receivingUser || !yamlAttach) return;

    const actRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder({
        customId: "accept",
        label: "Accept",
        style: ButtonStyle.Primary,
      }),
      new ButtonBuilder({
        customId: "acceptAsDefault",
        label: "Accept as default",
        style: ButtonStyle.Secondary,
      }),
      new ButtonBuilder({
        customId: "reject",
        label: "Reject",
        style: ButtonStyle.Danger,
      })
    );

    const msg = (await receivingUser.send({
      content: `${userMention(
        sendingUser
      )} has sent you a YAML. Please review it and choose if you'd like to add it to your collection.`,
      files: [{ attachment: Buffer.from(yamlData.data) }],
      components: [actRow],
    }));

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

  cmdAPGame = async (interaction: CommandInteraction, isTestGame = false) => {
    if (isTestGame && interaction.user.id !== "475120074621976587") {
      interaction.followUp({
        ephemeral: true,
        content: "You're not a bot admin!",
      });
    } else if (
      !interaction.guild ||
      !interaction.channel ||
      interaction.channel.type !== ChannelType.GuildText
    ) {
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
      switch (interaction.options.get("subcommand", true).value as string) {
        case "start":
          {
            const gameHere = this._games.find((i) => i.guildId === guildId);
            if (gameHere) {
              interaction.followUp(
                "There is already a game being organized on this server!"
              );
            } else {
              const game = await GameManager.NewGame(this._client, isTestGame);
              this._games.push(game);
              await game.RecruitGame(interaction);
              //console.debug(game);
            }
          }
          break;

        case "launch":
          {
            const code = interaction.options.get("code", false);
            if (code && typeof code.value === "string") {
              const codeUpper = code.value.toUpperCase();
              //const gameData = await GameTable.findByPk(codeUpper);
              const creationData = await GameManager.GetCreationData(codeUpper);

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
                (i) => i.guildId === guildId && i.state === GameState.Assembling
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
            console.debug(this._games.map((i) => i.guildId));
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
    }
  };

  cmdAdmin = async (interaction: CommandInteraction) => {
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
        YamlManager.CleanupYamls(interaction);
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
              })());

              const msgCollector = msg.channel.createMessageCollector({
                filter: (msgIn) =>
                  msgIn.type === MessageType.Reply &&
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
                          validate
                          //yamls.first() // TODO: not sure that I'm even using this anywhere
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

  cmdTest = async (interaction: CommandInteraction) => {
    // TODO: Make sure user running command is a developer (hard-coded to me for now)
    if (interaction.user.id !== "475120074621976587") {
      interaction.followUp({
        ephemeral: true,
        content: "You're not a bot developer!",
      });
      return;
    }

    switch (interaction.options.get("run", true).value as string) {
      case "sendfile": // Tests attaching a file to a message.
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
      case "zip": // Tests extracting a spoiler file from an AP archive.
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
      case "port": // Tests checking port 38281.
        interaction.followUp(
          `Port 38281 is ${
            (await isPortAvailable(38281)) ? "" : "not "
          }available.`
        );
        break;
      case "spoiler": // Tests reading a spoiler file for who's playing.
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
                    new EmbedBuilder({
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
      case "rebuildyaml": // Rebuilds the YAML table. This is a destructive action.
        {
          const codes: string[] = [];

          await YamlTable.truncate();
          await readdir("./yamls", { withFileTypes: true })
            .then((dirList) =>
              Promise.all(
                dirList
                  .filter((i) => i.isDirectory() && /\d+/.test(i.name))
                  .map((i) =>
                    readdir(pathJoin("yamls", i.name), {
                      withFileTypes: true,
                    }).then((files) => [i.name, files] as [string, Dirent[]])
                  )
              )
            )
            .then(async (fileList) => {
              for (const [userId, files] of fileList) {
                for (const file of files.filter((i) =>
                  i.name.endsWith(".yaml")
                )) {
                  const validate = await readFile(
                    pathJoin("yamls", userId, file.name)
                  ).then((data) => QuickValidateYaml(data.toString()));
                  if (!validate.error) {
                    const code = GenerateLetterCode(codes);
                    await YamlTable.create({
                      code,
                      userId,
                      playerName: validate.name ?? ["Who?"],
                      description: validate.desc ?? "No description",
                      games: validate.games ?? ["A Link to the Past"],
                      filename: basename(file.name, ".yaml"),
                    });
                    codes.push(code);
                  }
                }
              }
            });

          await PlayerTable.update({ defaultCode: null }, { where: {} });

          interaction.followUp(
            `YAML table rebuilt with ${codes.length} YAMLs. All defaults reset.`
          );
        }
        break;
      case "checkscreen": // Checks for presence of `screen` multiplexer.
        interaction.followUp(
          `This system ${
            (await SystemHasScreen()) ? "has" : "does not have"
          } \`screen\` available to it.`
        );
        break;
      default:
        interaction.followUp(
          "Unrecognized subcommand. That shouldn't happen..."
        );
    }
  };
}
