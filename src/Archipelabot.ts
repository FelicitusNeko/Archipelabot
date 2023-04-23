import {
  Client as DiscordClient,
  Interaction as DiscordInteraction,
  User as DiscordUser,
  CommandInteraction,
  ActionRowBuilder,
  ButtonBuilder,
  EmbedBuilder,
  AttachmentBuilder,
  StringSelectMenuBuilder,
  TextInputBuilder,
  ModalBuilder,
  ApplicationCommandType,
  ApplicationCommandOptionType,
  InteractionType,
  MessageType,
  ButtonStyle,
  userMention,
  APIEmbedField,
  TextInputStyle,
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
import { GameManagerV2 } from "./GameManagerV2";
import { YamlManager } from "./YamlManager";

const { ENABLE_TEST } = process.env;

export class Archipelabot {
  /** The Discord API client interface. */
  private _client: DiscordClient;
  /** The list of commands accepted by the bot. */
  private _cmds: Command[];

  /** The list of games currently being used. */
  //private _gamesv2: GameManagerV2[] = [];
  private _gamesv2 = new Set<GameManagerV2>();

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
        name: "apstart",
        description: "Start a new Archipelago multiworld.",
        type: ApplicationCommandType.ChatInput,
        run: this.cmdAPStartV2,
      },
      {
        name: "apresume",
        description: "Resume an existing Archipelago multiworld.",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "code",
            description: "The four-letter code for the game to resume.",
            required: true,
          },
        ],
        run: this.cmdAPResumeV2,
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
              { name: "Start a test game", value: "testgame" },
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
          'Replies "hello", basically just to make sure the bot is running.',
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
              { name: "Test new GameManager joiner", value: "joinertest" },
              { name: "Test new GameManager runner", value: "runnertest" },
              { name: "Test Send modal", value: "sendmodal" },
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

    const msg = await receivingUser.send({
      content: `${userMention(
        sendingUser
      )} has sent you a YAML. Please review it and choose if you'd like to add it to your collection.`,
      files: [{ attachment: Buffer.from(yamlData.data) }],
      components: [actRow],
    });

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

  cmdAPStartV2 = async (
    interaction: CommandInteraction,
    isTestGame = false
  ) => {
    const gameHere = [...this._gamesv2].find(
      (i) => i.guildId === interaction.guildId
    );
    if (gameHere) {
      interaction.followUp(
        "There is already a game being organized on this server!"
      );
    } else {
      const game = await GameManagerV2.NewGame(this._client, isTestGame);
      this._gamesv2.add(game);
      game.onChangeState(this.onChangeState);
      await game.RecruitGame(interaction);
    }
  };

  cmdAPResumeV2 = async (interaction: CommandInteraction) => {
    const code = interaction.options.get("code", false);
    if (code && typeof code.value === "string") {
      const codeUpper = code.value.toUpperCase();
      const creationData = await GameManagerV2.GetCreationData(codeUpper);

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
          interaction.followUp(`Attempting to launch game ${codeUpper}.`);
          const game = await GameManagerV2.fromCode(this._client, codeUpper);
          this._gamesv2.add(game);
          game.onChangeState(this.onChangeState);
          game.RunGame(interaction.channelId);
        }
      } else interaction.followUp(`Game code ${codeUpper} not found.`);
    } else interaction.followUp("No game code was specified.");
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
        GameManagerV2.CleanupGames(interaction);
        break;
      case "giveyaml":
        {
          try {
            const sendingUser = interaction.user.id;
            const targetUser = interaction.options.get("target", true);
            if (!targetUser.value || !targetUser.user)
              throw new Error("Failed to resolve user");
            else {
              const msg = await (async () => {
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
              })();

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
      case "testgame":
        return this.cmdAPStartV2(interaction, true);
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
      case "joinertest":
        return this.joinerTest(interaction);
      case "runnertest":
        return this.runnerTest(interaction);
      case "sendmodal":
        {
          const test = await interaction.followUp({
            content: "Push the button to test the Send modal.",
            components: [
              new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder()
                  .setCustomId(`test-${interaction.id}`)
                  .setLabel("Test")
                  .setStyle(ButtonStyle.Primary)
              ),
            ],
          });
          const listener = async (subInt: DiscordInteraction) => {
            if (!subInt.isButton()) return;
            if (subInt.message.id === test.id) {
              test.edit({
                content: "Test launched!",
                components: []
              });
              const modal = new ModalBuilder()
                .setTitle("Specify user/item")
                .setCustomId(`send-${test.id}`)
                .setComponents(
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setLabel("Who would like an item?")
                      .setCustomId("target")
                      .setRequired(true)
                      .setStyle(TextInputStyle.Short),
                  ),
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                    .setLabel("Which item to send?")
                    .setCustomId("item")
                    .setRequired(true)
                    .setStyle(TextInputStyle.Short)
                  )
                );
              this._client.off("interactionCreate", listener);
              await subInt.showModal(modal);
            }
          };
          this._client.on("interactionCreate", listener);
        }
        break;
      default:
        interaction.followUp(
          "Unrecognized subcommand. That shouldn't happen..."
        );
    }
  };

  joinerTest = async (interaction: CommandInteraction) => {
    {
      const launchBtn = new ButtonBuilder()
        .setCustomId("launch")
        .setStyle(ButtonStyle.Primary)
        .setEmoji("🚀")
        .setLabel("Launch")
        .setDisabled(true);

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId("default")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("⚔️")
          .setLabel("Join"),
        new ButtonBuilder()
          .setCustomId("select")
          .setStyle(ButtonStyle.Secondary)
          .setEmoji("🛡️")
          .setLabel("Join with..."),
        launchBtn,
        new ButtonBuilder()
          .setCustomId("cancel")
          .setStyle(ButtonStyle.Danger)
          .setEmoji("🚪")
          .setLabel("Cancel")
      );

      const msg = await interaction.followUp({
        content: `${userMention(
          interaction.user.id
        )} is starting a game! ||not actually but pretend they are||`,
        embeds: [
          new EmbedBuilder()
            .setTitle("Multiworld Game Call")
            .setDescription(
              'Click "⚔️ Join" to join this game with your default YAML.\n' +
                'Click "🛡️ Join with..." to join with a different YAML.\n' +
                'The host can then click "🚀 Launch" to start, or "🚪 Cancel" to cancel.'
            )
            .setColor("Gold")
            .setTimestamp(Date.now())
            .setFooter({ text: "Game code: ABCD" }),
        ],
        components: [buttonRow],
      });

      const subInteractionHandler = async (subInt: DiscordInteraction) => {
        if (subInt.channelId !== msg.channelId) return;
        if (!(subInt.isButton() || subInt.isStringSelectMenu())) return;

        if (subInt.message.id == msg.id) {
          // Main message
          console.debug("Input from main message");
          if (!subInt.isButton()) return;

          switch (subInt.customId) {
            case "default":
              launchBtn.setDisabled(false);
              subInt.reply({
                content: "You joined with your default YAML.",
                ephemeral: true,
              });
              msg.edit({ components: [buttonRow] });
              console.debug(
                `Simulating adding default for ${subInt.user.username}#${subInt.user.discriminator}`
              );
              break;
            case "select":
              {
                const yamlMgr = new YamlManager(this._client, subInt.user.id);
                const yamlList = new StringSelectMenuBuilder()
                  .setCustomId("yaml")
                  .setPlaceholder("Select your YAML")
                  .addOptions([...(await yamlMgr.GetYamlOptionsV3())]);

                console.debug(
                  `${subInt.user.username}#${subInt.user.discriminator} is requesting YAML list`
                );
                subInt.reply({
                  content:
                    "Select a YAML to play. You can select more than one if you wish, including the same YAML multiple times.",
                  components: [
                    new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                      yamlList
                    ),
                  ],
                  ephemeral: true,
                });
              }
              break;
            case "launch":
              if (subInt.user.id !== interaction.user.id) {
                subInt.reply({
                  content: "Only the game's host can launch the game.",
                  ephemeral: true,
                });
                break;
              }

              subInt.deferReply();

              msg.edit({
                content:
                  "Game ABCD is now closed. ||not that there actually was one; it was a test||",
                embeds: [],
                components: [],
              });
              this._client.off("interactionCreate", subInteractionHandler);

              setTimeout(
                () =>
                  subInt.followUp(
                    "If this was a real game, it would have generated at this point."
                  ),
                3000
              );
              break;
            case "cancel":
              if (subInt.user.id !== interaction.user.id) {
                subInt.reply({
                  content: "Only the game's host can cancel the game.",
                  ephemeral: true,
                });
                break;
              }

              msg.edit({
                content:
                  "The game has been cancelled. ||not that there actually was one; it was a test||",
                embeds: [],
                components: [],
              });
              this._client.off("interactionCreate", subInteractionHandler);
              break;
            default:
              subInt.reply({
                content: `I don't know what "${subInt.customId}" means.`,
                ephemeral: true,
              });
              break;
          }
        } else if (subInt.message.reference?.messageId === msg.id) {
          // YAML response
          console.debug("Input from YAML selector");
          if (subInt.isStringSelectMenu() && subInt.customId === "yaml") {
            launchBtn.setDisabled(false);
            msg.edit({ components: [buttonRow] });

            console.debug(
              `Simulating adding ${subInt.values[0]} for ${subInt.user.username}#${subInt.user.discriminator}`
            );
            subInt.reply({
              content: `YAML ${subInt.values[0]} added to this game. You can add more by selecting them in the list.`,
              ephemeral: true,
            });
            // here's where we would retrieve the YAML
          }
        } else {
          subInt.reply({
            content: `Hm, I can't seem to identify this message.`,
            ephemeral: true,
          });
          console.debug("Unidentified message", subInt.message.id, msg.id);
        }
      };

      this._client.on("interactionCreate", subInteractionHandler);
    }
  };

  runnerTest = async (interaction: CommandInteraction) => {
    const serverOutput: APIEmbedField = {
      name: "Server output",
      value:
        "Kewlio has joined the game\n" +
        "Weirdo has found Something at Somewhere for Someone\n" +
        "Matto has completed their goal.\n" +
        "Sicko: lol butts",
    };
    const liveEmbed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("Archipelago Server")
      .setFields(
        serverOutput,
        {
          name: "Server",
          value: `example.com:12345`,
          inline: true,
        },
        {
          name: "Host",
          value: userMention(interaction.user.id),
        }
      )
      .setTimestamp(Date.now())
      .setFooter({
        text: "Game code: ABCD",
      });

    const msg = await interaction.followUp({
      content:
        "Game ABCD is live!\n" +
        "The host can send commands to the server either by selecting them from the list, or replying to this message. " +
        "To send a slash command, precede it with a period instead of a slash so that it doesn't get intercepted by Discord. " +
        "For instance: `.forfeit player`",
      embeds: [liveEmbed],
      components: [
        new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
          new StringSelectMenuBuilder()
            .setCustomId("cmd")
            .setPlaceholder("Select a command")
            .addOptions(
              {
                value: "release",
                label: "Release (forfeit)",
                description:
                  "Releases a player's world's items to their respective players.",
              },
              {
                value: "collect",
                label: "Collect",
                description:
                  "Gathers a player's items from everyone else's worlds.",
              },
              {
                value: "exit",
                label: "Close server",
                description:
                  "Closes the server. It can be relaunched later with `/apresume ABCD`.",
              }
            )
        ),
      ],
    });

    const subInteractionHandler = async (subInt: DiscordInteraction) => {
      if (subInt.channelId !== msg.channelId) return;
      if (!(subInt.isStringSelectMenu() || subInt.isModalSubmit())) return;

      const modalPrompt = async (event: string) => {
        if (!subInt.isStringSelectMenu()) return;
        const modal = new ModalBuilder()
          .setTitle("Specify user")
          .setCustomId(`${event}-${msg.id}`)
          .setComponents(
            new ActionRowBuilder<TextInputBuilder>().addComponents(
              new TextInputBuilder()
                .setLabel(`Who would you like to ${event}?`)
                .setCustomId("target")
                .setRequired(true)
                .setStyle(TextInputStyle.Short)
            )
          );

        await subInt.showModal(modal);
      };

      if (subInt.isStringSelectMenu()) {
        if (subInt.message.id !== msg.id) return;
        switch (subInt.values[0]) {
          case "release":
          case "collect":
            // Release or collect
            msg.edit({ components: msg.components });
            modalPrompt(subInt.values[0]);
            break;
          case "exit":
            this._client.off("interactionCreate", subInteractionHandler);
            msg.edit({
              content:
                "Server for game ABCD has closed normally. It can be relaunched with `/apresume ABCD`.",
              embeds: [],
              components: [],
            });
            subInt.reply({
              content: "The game has been closed.",
              ephemeral: true,
            });
            break;
          case undefined:
            subInt.deleteReply();
            break;
          default:
            subInt.reply({
              content: `I don't know what ${subInt.values[0]} means.`,
              ephemeral: true,
            });
        }
      } else {
        const idData = /^([a-z]+)-(\d+)$/.exec(subInt.customId);
        if (idData === null) return;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const [_, event, msgId] = idData;
        if (msgId !== msg.id) {
          console.debug("Unidentified reference", msgId, msg.id);
          return;
        }
        const slotName = subInt.fields.getTextInputValue("target");
        // Here is where we would pipe the command to the server
        subInt.reply({
          content: `Sending command to ${event} ${slotName}.`,
          ephemeral: true,
        });
      }
    };

    this._client.on("interactionCreate", subInteractionHandler);
  };

  onChangeState = (game: GameManagerV2, state: GameState) => {
    if (state >= GameState.Stopped) this._gamesv2.delete(game);
  };
}
