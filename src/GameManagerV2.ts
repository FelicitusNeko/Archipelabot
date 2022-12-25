import { spawn, StdioOptions } from "child_process";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  unlinkSync,
} from "fs";
import { copyFile, readdir, rm as fsRm, writeFile } from "fs/promises";
import { basename, join as pathJoin, resolve as pathResolve } from "path";

import AdmZip = require("adm-zip");
import {
  Client as DiscordClient,
  Interaction as DiscordInteraction,
  Message as DiscordMessage,
  ButtonInteraction,
  CommandInteraction,
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  EmbedBuilder,
  ModalBuilder,
  SelectMenuBuilder,
  TextInputBuilder,
  ButtonStyle,
  ChannelType,
  MessageType,
  TextInputStyle,
  InteractionReplyOptions,
  MessagePayload,
  APIEmbedField,
  userMention,
  SelectMenuInteraction,
} from "discord.js";
import { Op as SqlOp } from "sequelize";
import { mkfifoSync } from "mkfifo";

import {
  GameFunctionState,
  GameState,
  GenerateLetterCode,
  GetGameList,
  isPortAvailable,
  MkdirIfNotExist,
  SystemHasMkfifo,
  VersionSpec,
} from "./core";
import { GameTable, PlayerTable } from "./Sequelize";
import { YamlListenerResult, YamlManager } from "./YamlManager";

const { PYTHON_PATH, AP_PATH, HOST_DOMAIN } = process.env;

type PlayersV3 = Record<string, string[]>;

export type ChangeStateListener = (game: GameManagerV2, g: GameState) => void;

/** The interface for creating and managing games. */
export class GameManagerV2 {
  /** The Discord API client interface. */
  private readonly _client: DiscordClient;
  /** The unique four-letter code for this game. */
  private readonly _code: string;
  /** Whether this game is a test game. */
  private readonly _testGame: boolean;
  /** The current state of the game. */
  private _state = GameState.Ready;
  /** The snowflake for the server this game is running on. */
  private _guildId: string | null = null;
  /** The snowflake for the channel this game is running on. */
  private _channelId?: string;
  /** The snowflake for the user hosting this game. */
  private _hostId?: string;
  /** The generated filename for this game. */
  private _filename?: string;
  /** The current hot message for this game. */
  private _msg?: DiscordMessage;
  /** The players for this game. */
  private _players: PlayersV3 = {};

  private _changeStateListeners = new Set<ChangeStateListener>();

  /** The client's user ID, if it is available. If not, returns an empty string. */
  public get clientId() {
    return this._client && this._client.user ? this._client.user.id : "";
  }
  /** The unique four-letter code for this game. */
  public get code() {
    return this._code;
  }
  /** The current state of the game. */
  public get state() {
    return this._state;
  }
  private set state(state) {
    if (state !== this._state)
      for (const listener of [...this._changeStateListeners])
        listener(this, state);
    this._state = state;
  }
  /** The snowflake for the server this game is running on. */
  public get guildId() {
    return this._guildId;
  }
  /** The snowflake for the channel this game is running on. */
  public get channelId() {
    return this._channelId;
  }
  /** The snowflake for the user hosting this game. */
  public get hostId() {
    return this._hostId;
  }

  /** The number of players playing this game. */
  public get playerCount() {
    return Object.keys(this._players).length;
  }

  /** The number of total YAMLs included in this game. */
  public get yamlCount() {
    return Object.values(this._players).reduce((r, i) => r + i.length, 0);
  }

  /**
   * Creates a new game instance.
   * @param client The Discord API client to use.
   * @param code The four-letter code to use.
   * @param existingGame The existing game data to use, if any.
   */
  private constructor(
    client: DiscordClient,
    code: string,
    testGame: boolean,
    existingGame?: GameTable
  ) {
    this._client = client;
    this._testGame = testGame;
    this._code = code;
    if (existingGame) {
      this._guildId = existingGame.guildId;
      this._hostId = existingGame.userId;
      this._filename = existingGame.filename;
      // TODO: make Running bool into gameState integer
      if (existingGame.active) this.state = GameState.Running;
    }
  }

  public onChangeState(listener: ChangeStateListener) {
    return this._changeStateListeners.add(listener);
  }

  public offChangeState(listener?: ChangeStateListener) {
    if (!listener) {
      if (this._changeStateListeners.size === 0) return false;
      this._changeStateListeners.clear();
      return true;
    } else return this._changeStateListeners.delete(listener);
  }

  /**
   * Starts recruitment for a new game.
   * @async
   * @param interaction The originating interaction.
   */
  async RecruitGame(interaction: CommandInteraction) {
    if (this._filename) throw new Error("Game has already been generated");

    const { version: apVer } = GetGameList();
    this._guildId = interaction.guildId;
    this._channelId = interaction.channelId;
    this._hostId = interaction.user.id;

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

    // TODO: add a YAML listener to allow players to directly submit a YAML through the joiner
    // - this should already be implemented but I think it's not working?
    // TODO: add a method to remove a YAML
    const playersField: APIEmbedField = {
      name: "Players",
      value: "None yet",
    };
    const liveEmbed = new EmbedBuilder()
      .setTitle(this._testGame ? "Testing Game Call" : "Multiworld Game Call")
      .setDescription(
        (this._testGame
          ? "This is a testing game. Expect things to go wrong and/or implode. Game may end prematurely for any reason.\n" +
            "Testing YAMLs are available for this game.\n\n"
          : "") +
          'Click "⚔️ Join" to join this game with your default YAML.\n' +
          'Click "🛡️ Join with..." to join with a different YAML.\n' +
          'The host can then click "🚀 Launch" to start, or "🚪 Cancel" to cancel.'
      )
      .setFields(playersField)
      .setColor("Gold")
      .setTimestamp(Date.now())
      .setFooter({ text: `Game code: ${this.code}` });
    const msg = await interaction.followUp({
      content: `${userMention(this._hostId)} is starting a ${
        this._testGame ? "testing " : ""
      }game!`,
      embeds: [liveEmbed],
      components: [buttonRow],
    });

    const UpdatePlayers = () => {
      playersField.value = Object.entries(this._players)
        .filter((i) => i[1].length)
        .map((i) => `${userMention(i[0])} ×${i[1].length}`)
        .join("\n");
      return msg.edit({
        components: [buttonRow],
        embeds: [liveEmbed],
      });
    };

    const addYaml = (userId: string, code: string) => {
      if (!this._players[userId]) this._players[userId] = [code];
      else this._players[userId].push(code);
      return true;
    };

    //const killQueue = new Set<() => void>();

    const addYamlSafe = async (
      userId: string,
      code: string,
      subInt: ButtonInteraction | SelectMenuInteraction,
      isDefault = false
    ) => {
      let olderYaml = false;
      const yamlVer = await YamlManager.GetYamlVersionByCode(code);
      if (apVer && yamlVer) {
        switch (GameManagerV2.CompareVersion(yamlVer, apVer)) {
          case -1:
            olderYaml = true;
            // {
            //   // the YAML is older than the current AP version
            //   const confMsg = await subInt.reply({
            //     content: `The selected YAML is for Archipelago version ${yamlVer.join(
            //       "."
            //     )}, which is older than the current version (${apVer.join(
            //       "."
            //     )}). This may negatively affect game generation. Use this YAML anyway? (If not, just dismiss this message.)`,
            //     components: [
            //       new ActionRowBuilder<ButtonBuilder>().addComponents(
            //         new ButtonBuilder()
            //           .setCustomId(`${subInt.user.id}-${code}-confirm`)
            //           .setLabel("Yes, use this YAML")
            //       ),
            //     ],
            //     ephemeral: true,
            //   });
            //   let killer = () => {/*nope*/};
            //   const confirmInteractionHandler = (
            //     confInt: DiscordInteraction
            //   ) => {
            //     if (!confInt.isButton()) return;
            //     if (confInt.message.reference?.messageId === confMsg.id) {
            //       addYaml(userId, code);
            //       launchBtn.setDisabled(this.yamlCount === 0);
            //       confInt.reply("Okay, this YAML will be used in the game.");
            //       console.debug(
            //         `${confInt.user.username}#${
            //           confInt.user.discriminator
            //         } is using YAML ${code}, which is for an older version (${yamlVer.join(
            //           "."
            //         )})`
            //       );
            //       killQueue.delete(killer);
            //       this._client.off(
            //         "interactionCreate",
            //         confirmInteractionHandler
            //       );
            //     }
            //   };
            //   killer = () => {
            //     this._client.off(
            //       "interactionCreate",
            //       confirmInteractionHandler
            //     );
            //   };

            //   this._client.on("interactionCreate", confirmInteractionHandler);
            //   killQueue.add(killer);
            // }
            break;
          case 1: // the YAML is newer than the current AP version
            subInt.reply(
              `This YAML is for Archipelago version ${yamlVer.join(
                "."
              )}, which is newer than the Archipelago version in use (${apVer.join(
                "."
              )}). This would cause generation to fail. Please select a different YAML.`
            );
            return false;
        }
      }
      addYaml(userId, code);
      subInt.reply({
        content: `You joined with ${
          isDefault ? "your default YAML." : `YAML code ${code}`
        }.${
          olderYaml
            ? ` Please be advised that this YAML is for an older version of Archipelago (${yamlVer?.join(
                "."
              )}), which may cause generation issues.`
            : ""
        }`,
        ephemeral: true,
      });
      // TODO: see if we can provide a better confirmation for this
      if (yamlVer && olderYaml)
        console.debug(
          `${subInt.user.username}#${
            subInt.user.discriminator
          } is using YAML ${code}, which is for an older version (${yamlVer.join(
            "."
          )})`
        );
      else
        console.debug(
          `Adding ${isDefault ? "default " : ""}YAML ${code} for ${
            subInt.user.username
          }#${subInt.user.discriminator}`
        );
      launchBtn.setDisabled(this.yamlCount === 0);
      UpdatePlayers();
      return true;
    };

    const hasYaml = (userId: string, code: string) => {
      if (this._players[userId]) return this._players[userId].includes(code);
      else return false;
    };

    let { result, terminate } = await YamlManager.YamlListener(msg);

    const subInteractionHandler = async (subInt: DiscordInteraction) => {
      if (subInt.channelId !== msg.channelId) return;
      if (!(subInt.isButton() || subInt.isSelectMenu())) return;

      if (subInt.message.id == msg.id) {
        // Main message
        if (!subInt.isButton()) return;

        switch (subInt.customId) {
          case "default":
            {
              const defaultYaml = (await PlayerTable.findByPk(subInt.user.id))
                ?.defaultCode;
              if (!defaultYaml) {
                subInt.reply({
                  content:
                    'You do not have a default YAML selected. Please use the YAML manager (`/yaml`) to set one, or use the "🛡️ Join with..." button instead.',
                  ephemeral: true,
                });
              } else if (hasYaml(subInt.user.id, defaultYaml)) {
                subInt.reply({
                  content:
                    'You may only use the "⚔️ Join" button once. To add your default YAML again, use the "🛡️ Join with..." button. ' +
                    "This is to prevent accidental double-clicks.",
                  ephemeral: true,
                });
              } else {
                addYamlSafe(subInt.user.id, defaultYaml, subInt, true);
                // launchBtn.setDisabled(this.yamlCount === 0);
                // UpdatePlayers();
              }
            }
            break;
          case "select":
            {
              const states = [
                GameFunctionState.Playable,
                GameFunctionState.Support,
              ];
              if (this._testGame) states.push(GameFunctionState.Testing);
              const yamlMgr = new YamlManager(this._client, subInt.user.id);
              const yamlList = new SelectMenuBuilder()
                .setCustomId("yaml")
                .setPlaceholder("Select your YAML")
                .addOptions([...(await yamlMgr.GetYamlOptionsV3(states))]);

              console.debug(
                `${subInt.user.username}#${subInt.user.discriminator} is requesting YAML list`
              );
              subInt.reply({
                content: "Select a YAML to play.",
                components: [
                  new ActionRowBuilder<SelectMenuBuilder>().addComponents(
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
                content: "Only the game's host may launch the game.",
                ephemeral: true,
              });
            } else {
              subInt.deferReply();

              msg.edit({
                content: `Game ${this.code} is now closed to new players and is being generated.`,
                embeds: [],
                components: [],
              });
              this.state = GameState.Generating;

              terminate("gamelaunch");
              this.LaunchGame(subInt);
              this._client.off("interactionCreate", subInteractionHandler);
            }
            break;
          case "cancel":
            if (subInt.user.id !== interaction.user.id) {
              subInt.reply({
                content: "Only the game's host may cancel the game.",
                ephemeral: true,
              });
            } else {
              msg.edit({
                content: "The game has been cancelled.",
                embeds: [],
                components: [],
              });
              // TODO: make sure this game gets cleaned up
              this.state = GameState.Cancelled;
              terminate("gamecancel");
              this._client.off("interactionCreate", subInteractionHandler);
            }
            break;
          default:
            subInt.reply({
              content: `I don't know what "${subInt.customId}" means. This is probably a bug.`,
              ephemeral: true,
            });
            break;
        }
      } else if (subInt.message.reference?.messageId === msg.id) {
        // YAML response
        if (subInt.isSelectMenu() && subInt.customId === "yaml") {
          msg.edit({ components: [buttonRow] });

          console.debug(
            `Adding ${subInt.values[0]} for ${subInt.user.username}#${subInt.user.discriminator}`
          );
          //addYaml(subInt.user.id, subInt.values[0]);
          addYamlSafe(subInt.user.id, subInt.values[0], subInt);
          // launchBtn.setDisabled(this.yamlCount === 0);
          // UpdatePlayers();
          // subInt.reply({
          //   content: `YAML ${subInt.values[0]} added to this game.`,
          //   ephemeral: true,
          // });
        }
      } else {
        subInt.reply({
          content: `Hm, I can't seem to identify this message.`,
          ephemeral: true,
        });
        console.debug("Unidentified message", subInt.message.id, msg.id);
      }
    };

    const resultThen = async ({ retval, reason, user }: YamlListenerResult) => {
      let autorestart = false;
      if (user)
        switch (reason) {
          case "gotyaml":
            {
              const yamlMgr = new YamlManager(this._client, user.id);
              const [code] = await yamlMgr.AddYamls(retval[0]);
              user.send(
                `The YAML you sent for game ${this.code} in ${msg.guild?.name} has been added to your library and will be used in that game.`
              );
              addYaml(user.id, code);
              autorestart = true;
            }
            break;
          case "yamlerror":
            user.send(
              `There was a problem parsing YAMLs for game ${this.code} in ${msg.guild?.name}: ${retval[0].error}\nPlease review the error and try again.`
            );
            autorestart = true;
            break;
          case "notyaml":
            user.send(
              `The YAML you sent for game ${this.code} in ${msg.guild?.name} doesn't appear to be valid. Please check your submission and try again.`
            );
            autorestart = true;
            break;
          default:
            break;
        }
      if (autorestart)
        ({ result, terminate } = await YamlManager.YamlListener(msg));
    };
    result.then(resultThen);

    this._client.on("interactionCreate", subInteractionHandler);

    this.state = GameState.Assembling;
  }

  /**
   * Launches the generation process for this game.
   * @async
   * @param incomingYamls The YAMLs to use for this game.
   * @returns A promise that resolves when the game has been generated.
   */
  private async LaunchGame(interaction: ButtonInteraction) {
    if (!PYTHON_PATH) throw new Error("Python path has not been defined");
    if (!AP_PATH) throw new Error("Archipelago path has not been defined");
    if (!this._guildId) throw new Error("No guild associated to this game");
    if (!this._hostId) throw new Error("No host associated to this game");

    const incomingYamls: [string, string][] = [];
    for (const user in this._players)
      for (const yaml of this._players[user]) incomingYamls.push([user, yaml]);

    const writeMsg = (
      msgContent: string | MessagePayload | InteractionReplyOptions
    ) => interaction.followUp(msgContent);

    const outputPath = pathJoin("./games", this._code);
    await MkdirIfNotExist(outputPath);

    const yamlPath = pathJoin(outputPath, "yamls");
    await MkdirIfNotExist(yamlPath);

    const playerYamlList = await YamlManager.GetYamlsByCode(
      ...incomingYamls.map((i) => i[1])
    );
    console.debug(incomingYamls, playerYamlList);

    await Promise.all(
      playerYamlList.map((i) =>
        copyFile(
          pathJoin("yamls", i.userId, `${i.filename}.yaml`),
          pathJoin(yamlPath, `${i.filename}.yaml`)
        )
      )
    );

    this.state = GameState.Generating;

    await new Promise<string>((f, r) => {
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
        pathJoin(outputPath, `${this._code}-gen.stdout.log`)
      );
      const logerr = createWriteStream(
        pathJoin(outputPath, `${this._code}-gen.stderr.log`)
      );
      let errTimeout: NodeJS.Timeout | undefined = undefined;

      pyApGenerate.stdout.on("data", (data: Buffer) => {
        logout.write(data);
        outData += data;
        const dataStr = data.toString();

        const itemCount = /Filling the world with (\d+) items\./.exec(dataStr);
        if (itemCount && this._msg)
          this._msg.edit(
            this._msg.content +
              ` This multiworld will have **${itemCount[1]} items**.`
          );

        if (dataStr.includes("press enter to install it"))
          pyApGenerate.stdin.write("\n");
        else if (dataStr.includes("Press enter to close"))
          pyApGenerate.stdin.write("\n");
        if (errTimeout) {
          clearTimeout(errTimeout);
          errTimeout = undefined;
        }
      });
      pyApGenerate.stderr.on("data", (data: Buffer) => {
        logerr.write(data);
        errData += data;
        // If a Python module is missing, hit Enter
        if (data.toString().includes("press enter to install it"))
          pyApGenerate.stdin.write("\n");
        // If the generation process has (probably) failed, hit Enter
        else if (data.toString().includes("Press enter to close"))
          pyApGenerate.stdin.write("\n");
        // If there's any other error, wait three seconds and hit Enter if nothing was written to stdout by then
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
    })
      .then((outputFile) => {
        if (!this._guildId) throw new Error("No guild associated to this game");
        if (!this._hostId) throw new Error("No host associated to this game");

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
            const playerCountResult = /Players:\s+(\d+)/.exec(
              spoilerDataString
            );
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
            return new AttachmentBuilder(spoilerData)
              .setName(i.name)
              .setSpoiler(true);
          });

        this._msg?.delete();
        this._msg = undefined;
        writeMsg({
          content:
            `Game ${this._code} has been generated. Players: ` +
            incomingYamls.map((i) => userMention(i[0])).join(", "),
          files: spoiler.map((i) => i.setSpoiler(true)),
          embeds:
            playerListing.length > 0
              ? [
                  new EmbedBuilder({
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
          const user = this._client.users.cache.get(userId);
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
                `Here is your data file for game ${this._code}. If you're not sure how to use this, ` +
                `please refer to the Archipelago setup guide for your game, or ask someone for help.`,
              files: playerFile,
            });
        }

        this._filename = basename(outputFile, ".zip");
        GameTable.create({
          code: this._code,
          filename: this._filename,
          guildId: this._guildId,
          userId: this._hostId,
          active: false,
        });

        this.state = GameState.Ready;
        return this.RunGame();
      })
      .catch((e) => {
        // BUG: this doesn't seem to actually do anything; if generation fails, the bot crashes
        writeMsg({
          content: "An error occurred during game generation.",
          files: [
            new AttachmentBuilder((e as Error).message, {
              name: "Generation Error.txt",
            }),
          ],
        });
        this.state = GameState.GenerationFailed;
      });
  }

  /**
   * Launches the server process for this game.
   * @param channelId Optional. The channel in which to run the game. Will default to the predefined channel.
   * @returns A promise that resolves when the server initialization has completed.
   * @throws {Error} Throws if an invalid or no channel has been specified for running the game.
   */
  async RunGame(channelId?: string) {
    if (!PYTHON_PATH) throw new Error("Python path has not been defined");
    if (!AP_PATH) throw new Error("Archipelago path has not been defined");
    if (!this._guildId) throw new Error("No guild associated to this game");
    if (!this._hostId) throw new Error("No host associated to this game");
    if (!this._channelId) {
      if (channelId) this._channelId = channelId;
      else throw new Error("No channel associated to this game");
    }

    const channel = this._client.channels.cache.get(this._channelId);
    if (!channel) throw new Error("Cannot find channel");
    if (channel.type !== ChannelType.GuildText)
      throw new Error("Channel is not text channel");

    if (this._state > GameState.Ready) {
      channel.send(`Game ${this._code} is already running.`);
      return;
    }

    const port = (() => {
      let port;
      do {
        port = 38281 + Math.floor(Math.random() * 1000);
      } while (!isPortAvailable(port));
      return port;
    })();

    const serverOutput: APIEmbedField = {
      name: "Server output",
      value: "Wait...",
    };
    const liveEmbed = new EmbedBuilder()
      .setColor("Green")
      .setTitle("Archipelago Server")
      .setFields(
        serverOutput,
        {
          name: "Server",
          value: `${HOST_DOMAIN}:${port}`,
          inline: true,
        },
        {
          name: "Host",
          value: userMention(this._hostId),
        }
      )
      .setTimestamp(Date.now())
      .setFooter({
        text: `Game code: ${this.code}`,
      });

    const msg = await channel.send({
      content:
        `Game ${this.code} is live!\n` +
        "The host can send commands to the server either by selecting them from the list, or replying to this message. " +
        "To send a slash command, precede it with a period instead of a slash so that it doesn't get intercepted by Discord. " +
        "For instance: `.forfeit player`",
      embeds: [liveEmbed],
      components: [
        new ActionRowBuilder<SelectMenuBuilder>().addComponents(
          new SelectMenuBuilder()
            .setCustomId("cmd")
            .setPlaceholder("Select a command")
            .addOptions(
              {
                value: "release",
                label: "Release (forfeit)",
                description:
                  "Sends a player's world's items to their respective players.",
              },
              {
                value: "collect",
                label: "Collect",
                description:
                  "Gathers a player's items from everyone else's worlds.",
              },
              {
                value: "hint",
                label: "Request hint",
                description: "Send a player a hint about an item.",
              },
              {
                value: "send",
                label: "Send an item",
                description: "Send a player an item.",
              },
              {
                value: "exit",
                label: "Close server",
                description: "Closes the server.",
              }
            )
        ),
      ],
    });

    const gamePath = pathJoin("./games", this._code);
    const logout = createWriteStream(
      pathJoin(gamePath, `${this._filename}.stdout.log`)
    );

    const lastFiveLines: string[] = [];
    const [pyApServer, apIn, apOut, apErr] = await (async () => {
      const hasMkfifo = (await SystemHasMkfifo()) && false;
      const pathprefix = pathJoin(gamePath, `${this.code}-std`);
      const params = [
        "MultiServer.py",
        "--port",
        port.toString(),
        "--use_embedded_options",
        pathResolve(pathJoin(gamePath, `${this._filename}.archipelago`)),
      ];

      let stdio: StdioOptions | undefined = undefined;
      if (hasMkfifo) {
        for (const pipe of ["in", "out", "err"])
          mkfifoSync(pathprefix + pipe, 0o600);
        stdio = [
          createReadStream(pathprefix + "in"),
          createWriteStream(pathprefix + "out"),
          createWriteStream(pathprefix + "err"),
        ];
        // params.unshift(
        //   `<${pathprefix}in`,
        //   `>${pathprefix}out`,
        //   `2>${pathprefix}err`
        // );
      }
      const pyApServer = spawn(PYTHON_PATH, params, { cwd: AP_PATH, stdio });

      if (hasMkfifo)
        return [
          pyApServer,
          createWriteStream(pathprefix + "in"),
          createReadStream(pathprefix + "out"),
          createReadStream(pathprefix + "err"),
        ];
      else
        return [
          pyApServer,
          pyApServer.stdin,
          pyApServer.stdout,
          pyApServer.stderr,
        ];
    })();
    apErr?.pipe(
      createWriteStream(pathJoin(gamePath, `${this._filename}.stderr.log`))
    );
    this.state = GameState.Running;

    const writeToServer = (text: string) => {
      apIn?.write(`${text}\n`);
      lastFiveLines.push(`← ${text}`);
      while (lastFiveLines.length > 5) lastFiveLines.shift();
    };

    const UpdateOutput = (() => {
      let lastTimestampUpdate = Date.now();
      let timeout: NodeJS.Timeout | null = null;
      let queuedRun = false;
      const retval = async (updateTimestamp = false) => {
        if (this._state !== GameState.Running) return;
        if (updateTimestamp) lastTimestampUpdate = Date.now();
        if (timeout) {
          if (this._state === GameState.Running) queuedRun = true;
          return;
        }

        serverOutput.value = lastFiveLines.join("\n");
        if (serverOutput.value.length > 1024)
          serverOutput.value = serverOutput.value.substring(0, 1021) + "…";
        liveEmbed.setTimestamp(lastTimestampUpdate);
        msg.edit({
          embeds: [liveEmbed],
        });

        timeout = setTimeout(() => {
          timeout = null;
          if (queuedRun) {
            queuedRun = false;
            retval(false);
          }
        }, 1000);
      };
      return retval;
    })();

    apOut?.on("data", (data: Buffer) => {
      logout.write(data);
      const newLines = data
        .toString()
        .trim()
        .split(/\n/)
        // this filter removes the "Now that you are connected" message, which is unnecessary in server output
        .filter(
          (i) =>
            !/^Notice \(Player .* in team \d+\): Now that you are connected,/.test(
              i
            )
        );
      const includesCheck = newLines.reduce(
        (r, i) => r || /^\(Team #\d+\) .* sent .* to .*/.test(i),
        false
      );
      lastFiveLines.push(...newLines);
      while (lastFiveLines.length > 5) lastFiveLines.shift();
      UpdateOutput(includesCheck);
      if (data.toString().includes("press enter to install it"))
        apIn?.write("\n");
    });
    apOut?.on("close", logout.close);

    const subInteractionHandler = async (subInt: DiscordInteraction) => {
      if (subInt.channelId !== msg.channelId) return;
      if (!(subInt.isSelectMenu() || subInt.isModalSubmit())) return;

      if (subInt.user.id !== this.hostId) {
        subInt.reply({
          content: "Only the game host can perform that action.",
          ephemeral: true,
        });
        return;
      }

      const modalPrompt = async (event: string) => {
        if (!subInt.isSelectMenu()) return;
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

      if (subInt.isSelectMenu()) {
        if (subInt.message.id !== msg.id) return;
        switch (subInt.values[0]) {
          case "release":
          case "collect":
            // Release or collect
            msg.edit({ components: msg.components });
            modalPrompt(subInt.values[0]);
            break;
          case "hint":
            {
              const modal = new ModalBuilder()
                .setTitle("Specify user/item")
                .setCustomId(`hint-${msg.id}`)
                .setComponents(
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setLabel("Who would like a hint?")
                      .setCustomId("target")
                      .setRequired(true)
                      .setStyle(TextInputStyle.Short)
                  ),
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setLabel("Which item is it for?")
                      .setCustomId("item")
                      .setRequired(true)
                      .setStyle(TextInputStyle.Short)
                  )
                );

              await subInt.showModal(modal);
            }
            break;
          case "send":
            {
              const modal = new ModalBuilder()
                .setTitle("Specify user/item")
                .setCustomId(`send-${msg.id}`)
                .setComponents(
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setLabel("Who would like an item?")
                      .setCustomId("target")
                      .setRequired(true)
                      .setStyle(TextInputStyle.Short)
                  ),
                  new ActionRowBuilder<TextInputBuilder>().addComponents(
                    new TextInputBuilder()
                      .setLabel("Which item will they receive?")
                      .setCustomId("item")
                      .setRequired(true)
                      .setStyle(TextInputStyle.Short)
                  )
                );

              await subInt.showModal(modal);
            }
            break;
          case "exit":
            writeToServer("/exit");
            subInt.reply({
              content: "The game is now being closed.",
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
        switch (event) {
          case "collect":
          case "release":
            {
              const slotName = subInt.fields.getTextInputValue("target");
              subInt.reply({
                content: `Sending command to ${event} ${slotName}.`,
                ephemeral: true,
              });
              writeToServer(`/${event} ${slotName}`);
            }
            break;
          case "hint":
            {
              const slotName = subInt.fields.getTextInputValue("target");
              const itemName = subInt.fields.getTextInputValue("item");
              subInt.reply({
                content: `Sending hint for ${itemName} to ${slotName}.`,
                ephemeral: true,
              });
              writeToServer(`/${event} ${slotName} ${itemName}`);
            }
            break;
          case "send":
            {
              const slotName = subInt.fields.getTextInputValue("target");
              const itemName = subInt.fields.getTextInputValue("item");
              subInt.reply({
                content: `Sending item ${itemName} to ${slotName}.`,
                ephemeral: true,
              });
              writeToServer(`/${event} ${slotName} ${itemName}`);
            }
            break;
        }
      }
    };

    const msgCollector = channel.createMessageCollector({
      filter: (msgIn) =>
        msgIn.type === MessageType.Reply &&
        msgIn.reference?.messageId === msg.id &&
        msgIn.author.id === this._hostId,
    });
    msgCollector.on("collect", (msgIn) => {
      if (apIn) {
        writeToServer(msgIn.content.replace(/^\./, "/"));
        if (msgIn.deletable) msgIn.delete();
        else msgIn.react("⌨️");
      } else msgIn.react("❌");
    });

    pyApServer.on("close", (pcode) => {
      msg.edit({
        content: `Server for game ${this._code} closed ${
          pcode === 0 ? "normally" : `with error code ${pcode}`
        }. It can be resumed later with the command \`/apresume ${
          this.code
        }\`.`,
        embeds: [],
        components: [],
      });
      GameTable.update({ active: false }, { where: { code: this._code } });
      this._client.off("interactionCreate", subInteractionHandler);
      msgCollector.stop("serverclose");
      this.state = GameState.Stopped;

      const pathprefix = pathJoin(gamePath, `${this.code}-std`);
      for (const pipe of ["in", "out", "err"])
        if (existsSync(pathprefix + pipe)) unlinkSync(pathprefix + pipe);
    });

    this._client.on("interactionCreate", subInteractionHandler);
  }

  /**
   * Creates a new {@link GameManagerV2} instance from an existing four-letter game code.
   * @async
   * @param client The Discord client.
   * @param code The four-letter code attached to the game to load.
   * @returns {Promise<GameManagerV2>} The requested game.
   * @throws {Error} Throws an error if the game code was not found.
   */
  static async fromCode(
    client: DiscordClient,
    code: string
  ): Promise<GameManagerV2> {
    return GameTable.findByPk(code).then((existingGame) => {
      if (existingGame)
        return new GameManagerV2(client, code, false, existingGame);
      else throw new Error(`Game ${code} not found`);
    });
  }

  /**
   * Creates a new {@link GameManagerV2} instance for a new game.
   * @async
   * @param client The Discord client.
   * @param isTestGame Whether this new game is a testing game.
   * @returns {Promise<GameManagerV2>} The new game.
   */
  static async NewGame(
    client: DiscordClient,
    isTestGame = false
  ): Promise<GameManagerV2> {
    return GameTable.findAll({ attributes: ["code"] }).then(
      (codeList) =>
        new GameManagerV2(
          client,
          GenerateLetterCode(codeList.map((i) => i.code)),
          isTestGame
        )
    );
  }

  /**
   * Retrieve the guild and host user ID for a given game code.
   * @async
   * @param code The four-letter code to check.
   * @returns The guild and host ID the game belongs to, or `null` if the code was not found.
   */
  static async GetCreationData(code: string) {
    return GameTable.findByPk(code).then((existingGame) => {
      if (existingGame)
        return {
          guild: existingGame.guildId,
          host: existingGame.userId,
        };
      else return null;
    });
  }

  /**
   * Cleans up all games in the database that are:
   *  - over two weeks old
   *  - are orphaned between the database and file system
   * @async
   * @param interaction Optional. The originating interaction. The function will call `followUp()` when done if present.
   * @return A promise that resolves when the operation completes.
   */
  static async CleanupGames(interaction?: CommandInteraction) {
    // 1000 msec * 60 sec * 60 min * 24 hr * 14 d = 1,209,600,000
    /** A Unix millisecond timestamp corresponding to two weeks before the current time. */
    const twoWeeksAgo = Date.now() - 1_209_600_000;
    const gamesToPurge = await Promise.all([
      GameTable.findAll({
        attributes: ["code", "updatedAt", "active"],
      }),
      readdir("games", { withFileTypes: true }),
    ]).then(([gameRows, gameDirs]) => {
      const gameCodes = gameRows.map((i) => i.code);
      return new Set([
        ...gameRows
          .filter((i) => !i.active && i.updatedAt.getTime() < twoWeeksAgo)
          .map((i) => i.code),
        ...gameDirs
          .filter((i) => i.isDirectory() && !gameCodes.includes(i.name))
          .map((i) => i.name),
      ]);
    });

    console.debug("Purging:", gamesToPurge);
    for (const code of gamesToPurge) {
      await fsRm(pathJoin("games", code), {
        recursive: true,
        force: true,
      });
    }

    await GameTable.destroy({
      where: { code: { [SqlOp.in]: [...gamesToPurge] } },
    });
    interaction?.followUp(`${gamesToPurge.size} game(s) purged.`);
  }

  /**
   * Compares two {@link VersionSpec}s.
   * @param lhs The first version to compare.
   * @param rhs The second version to compare.
   * @returns 0 if equal; otherwise, returns negative if `lhs` is older, and positive if `lhs` is newer.
   */
  static CompareVersion(lhs: VersionSpec, rhs: VersionSpec) {
    for (const x of [0, 1, 2])
      if (lhs[x] !== rhs[x]) return lhs[x] > rhs[x] ? 1 : -1;
    return 0;
  }
}
