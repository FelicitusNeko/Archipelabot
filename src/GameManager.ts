import { spawn } from "child_process";
import { createWriteStream } from "fs";
import { copyFile, readdir, rm as fsRm, writeFile } from "fs/promises";
import { basename, join as pathJoin, resolve as pathResolve } from "path";

import { userMention } from "@discordjs/builders";
import AdmZip = require("adm-zip");
import {
  BaseCommandInteraction,
  Client as DiscordClient,
  Interaction as DiscordInteraction,
  Message as DiscordMessage,
  MessageActionRow,
  MessageAttachment,
  MessageButton,
  MessageEditOptions,
  MessageEmbed,
  MessageSelectMenu,
  ReactionCollector,
} from "discord.js";
import { Op as SqlOp } from "sequelize/dist";

import {
  GameFunctionState,
  GameState,
  GenerateLetterCode,
  GetStdFunctionStateErrorMsg,
  isPortAvailable,
  MkdirIfNotExist,
} from "./core";
import { GameTable, PlayerTable } from "./Sequelize";
import { YamlListenerResult, YamlManager } from "./YamlManager";

const { PYTHON_PATH, AP_PATH, HOST_DOMAIN } = process.env;

/*
export interface GameRecruitmentProcess {
  msg: DiscordMessage;
  guildId: string;
  channelId: string;
  startingUser: string;
  reactionCollector: ReactionCollector;
  defaultUsers: string[];
  selectUsers: string[];
}

export interface RunningGame {
  msg?: DiscordMessage;
  guildId: string;
  channelId: string;
  startingUser: string;
  state: GameState;
}
*/

interface Players {
  /** Players who have indicated they're joining with their default YAML. */
  joinDefault: string[];
  /** Players who have indicated they're joining with a different YAML. */
  joinSelect: string[];
  /** Players who are playing this game. */
  playing: string[];
}

/** The interface for creating and managing games. */
export class GameManager {
  /** The Discord API client interface. */
  private readonly _client: DiscordClient;
  /** The unique four-letter code for this game. */
  private readonly _code: string;
  /** Whether this game is a test game. */
  private readonly _testGame: boolean;
  /** The current state of the game. */
  private _state = GameState.Ready;
  /** The snowflake for the server this game is running on. */
  private _guildId?: string;
  /** The snowflake for the channel this game is running on. */
  private _channelId?: string;
  /** The snowflake for the user hosting this game. */
  private _hostId?: string;
  /** The generated filename for this game. */
  private _filename?: string;

  /** The current hot message for this game. */
  private _msg?: DiscordMessage;
  /** The players for this game. */
  private _players: Players = {
    joinDefault: [],
    joinSelect: [],
    playing: [],
  };

  /** The reaction collector for this game. */
  private _reactCollector?: ReactionCollector;

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
    const { joinDefault, joinSelect, playing } = this._players;
    if (playing.length > 0) return playing.length;
    else return [...joinDefault, ...joinSelect].length;
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
      if (existingGame.active) this._state = GameState.Running;
    }
  }

  async RecruitGame(interaction: BaseCommandInteraction) {
    if (this._filename) throw new Error("Game has already been generated");

    this._guildId = interaction.guildId;
    this._channelId = interaction.channelId;
    this._hostId = interaction.user.id;
    this._msg = (await interaction.followUp({
      content: `${userMention(this._hostId)} is starting a ${
        this._testGame ? "testing " : ""
      }game!`,
      embeds: [
        new MessageEmbed({
          title: this._testGame ? "Testing Game Call" : "Multiworld Game Call",
          description:
            (this._testGame
              ? "This is a testing game. Expect things to go wrong and/or implode. Game may end prematurely for any reason.\n" +
                "Testing YAMLs are available for this game.\n\n"
              : "") +
            "React ⚔️ to join into this game with your default YAML.\n" +
            "React 🛡️ to join with a different YAML.",
          footer: {
            text: `Game code: ${this._code}`,
          },
        }),
      ],
    })) as DiscordMessage;

    this._reactCollector = this._msg.createReactionCollector({
      filter: (reaction, user) =>
        this.clientId !== user.id &&
        reaction.emoji.name !== null &&
        ["⚔️", "🛡️"].includes(reaction.emoji.name),
      dispose: true,
    });

    const { _msg, _reactCollector } = this;

    await _msg.react("⚔️");
    await _msg.react("🛡️");

    _reactCollector.on("collect", (reaction, user) => {
      if (reaction.emoji.name === "⚔️") this._players.joinDefault.push(user.id);
      else if (reaction.emoji.name === "🛡️")
        this._players.joinSelect.push(user.id);
    });
    _reactCollector.on("remove", (reaction, user) => {
      if (reaction.emoji.name === "⚔️")
        this._players.joinDefault = this._players.joinDefault.filter(
          (i) => i != user.id
        );
      else if (reaction.emoji.name === "🛡️")
        this._players.joinSelect = this._players.joinSelect.filter(
          (i) => i != user.id
        );
    });
    _reactCollector.on("dispose", (reaction) => {
      // TODO: find out when this event fires (if it does)
      console.debug("Dispose:", reaction);
      if (reaction.emoji.name === "⚔️") {
        _msg.react("⚔️");
        this._players.joinDefault = [];
      }
    });
    _reactCollector.on("end", async (_collected, reason) => {
      if (["aplaunch", "apcancel"].includes(reason)) {
        await _msg.delete();
      }
    });

    this._state = GameState.Assembling;
  }

  CancelGame(interaction: BaseCommandInteraction) {
    if (this._hostId !== interaction.user.id) {
      interaction.followUp("You're not the person who launched this event!");
      return false;
    } else if (this._state !== GameState.Assembling) {
      interaction.followUp("This game is not currently assembling!");
      return false;
    } else {
      interaction.followUp("The game has been cancelled.");
      this._reactCollector?.stop("apcancel");
      return true;
    }
  }

  /**
   * Creates a new game.
   * @param interaction The interaction leading to the creation of a new game.
   */
  async CreateGame(interaction: BaseCommandInteraction) {
    const { joinDefault, joinSelect } = this._players;
    this._reactCollector?.stop("aplaunch");
    this._reactCollector = undefined;

    if (!PYTHON_PATH)
      throw new Error("Python path has not been defined! Game cannot start.");
    if (!AP_PATH)
      throw new Error(
        "Archipelago path has not been defined! Game cannot start."
      );

    const defaultYamls = await PlayerTable.findAll({
      attributes: ["userId", "defaultCode"],
      where: {
        userId: {
          [SqlOp.in]: joinDefault.filter((i) => !joinSelect.includes(i)),
        },
        defaultCode: { [SqlOp.not]: null },
      },
    });
    const hasDefaults = defaultYamls.map((i) => i.userId);
    const missingDefaults = joinDefault
      .filter((i) => !hasDefaults.includes(i) && !joinSelect.includes(i))
      .concat(joinSelect);

    this._state = GameState.Assembling;

    if (missingDefaults.length === 0) {
      this._msg = (await interaction.followUp(
        "Now generating the game..."
      )) as DiscordMessage;
      this.LaunchGame(...defaultYamls);
    } else {
      this._state = GameState.GatheringYAMLs;

      this._msg = (await interaction.followUp(
        "The following player(s) need to provide a YAML before the game can begin. " +
          `The game will start <t:${
            Math.floor(Date.now() / 1000) + 30 * 60
          }:R> if not everyone has responded.\n` +
          missingDefaults.map((i) => userMention(i)).join(", ")
      )) as DiscordMessage;

      const { _msg } = this;

      // TODO: Request YAMLs from players whose default YAML has an invalid game in it
      await Promise.all(
        missingDefaults.map((i) => this.RequestYaml(i, !joinSelect.includes(i)))
      ).then((responses) => {
        _msg.edit(
          "Everyone's responses have been received. Now generating the game..."
        );
        this.LaunchGame(...defaultYamls, ...responses);
      });
    }
  }

  /**
   * Request a YAML from a participating player who is not using their default YAML.
   * @param userId The player to ask for a YAML to use.
   * @param missingDefault Whether the player selected Default, but does not have a default YAML.
   * @returns A promise that resolves with the player's YAML selection, or `null` if none.
   */
  private async RequestYaml(
    userId: string,
    missingDefault = false
  ): Promise<[string, string | null]> {
    const worstValidState = this._testGame
      ? GameFunctionState.Testing
      : GameFunctionState.Playable;
    const user = this._client.users.cache.get(userId);
    if (!user) return [userId, null];
    const yamlMgr = new YamlManager(this._client, userId);

    //const yamls = await YamlTable.findAll({ where: { userId } });
    /** The time at which the YAML request will time out, in Unix timestamp format. */
    const timeout = Math.floor(Date.now() / 1000) + 30 * 60;

    const msg = (await user.send({
      content:
        (!missingDefault
          ? "Please select the YAML you wish to use from the dropdown box, or, alternatively, submit a new one by replying to this message with an attachment."
          : "Looks like you don't have a default YAML set up. Please select one from the list, or reply to this message with a new one.") +
        ` If you've changed your mind, you can click on "Withdraw". This message will time out <t:${timeout}:R>.`,
      components: [
        new MessageActionRow({
          components: [
            new MessageSelectMenu({
              customId: "selectYaml",
              placeholder: "Select a YAML",
              options: await yamlMgr.GetYamlOptionsV2(
                this._testGame
                  ? GameFunctionState.Testing
                  : GameFunctionState.Playable
              ),
            }),
          ],
        }),
        new MessageActionRow({
          components: [
            new MessageButton({
              customId: "withdraw",
              label: "Withdraw from this game",
              style: "DANGER",
            }),
          ],
        }),
      ],
    })) as DiscordMessage;

    return (async (): Promise<[string, string | null]> => {
      let retval: string | null = null;
      let done = false;

      const GetNewStatus = (status: GameFunctionState) => {
        if (
          status === GameFunctionState.Playable ||
          (status === GameFunctionState.Testing && this._testGame)
        )
          return null;
        else
          return {
            content: GetStdFunctionStateErrorMsg(
              status,
              "in this game. Please select a different YAML"
            ),
          };
      };

      let { result, terminate } = await YamlManager.YamlListener(
        msg,
        timeout * 1000 - Date.now()
      );

      const subInteractionHandler = async (subInt: DiscordInteraction) => {
        if (!subInt.isButton() && !subInt.isSelectMenu()) return;
        if (subInt.user.id !== userId) return;
        if (subInt.message.id !== msg.id) return;

        if (subInt.isButton()) {
          switch (subInt.customId) {
            case "withdraw":
              terminate("withdrawn");
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
            const status = GetNewStatus(
              await YamlManager.GetWorstStatusByCode(code)
            );
            if (status) subInt.update(status);
            else {
              retval = code;
              terminate("selectedyaml");
            }
          }
        }
      };
      this._client.on("interactionCreate", subInteractionHandler);

      const waitForResponse = async ({
        reason,
        retval: ylRetval,
      }: YamlListenerResult) => {
        let content = `Unrecognized reason code: ${reason}`;
        done = true;

        switch (reason) {
          case "gotyaml":
            if (ylRetval[0].worstState === undefined) {
              content =
                "For some reason, no worst state was provided for this YAML. This is probably a bug.";
              console.debug(ylRetval[0]);
              done = false;
            } else if (ylRetval[0].worstState > worstValidState) {
              content = GetStdFunctionStateErrorMsg(
                ylRetval[0].worstState,
                "in this game. Please select or submit a different YAML"
              );
              done = false;
            } else {
              [retval] = await new YamlManager(this._client, userId).AddYamls(
                ylRetval[0]
              );
              content =
                "Thanks! Your new YAML has been added to your library and will be used in your upcoming game.";
            }
            break;
          case "selectedyaml":
            content = "Thanks! That YAML will be used in your upcoming game.";
            break;
          case "yamlerror":
            content = `There was a problem parsing the YAML: \`${ylRetval[0].error}\`\nPlease review the error and try again.`;
            done = false;
            break;
          case "notyaml":
            content =
              "That doesn't look like a valid YAML. Please check your submission and try again.";
            done = false;
            break;
          case "withdrawn":
            content = "Sorry to hear that. Your request has been withdrawn.";
            break;
          case "time":
            content = "Sorry, this YAML request has timed out.";
            break;
        }

        msg.edit({ content, components: done ? [] : undefined });
        if (done)
          console.info(`${this._code}: ${user.username} responded ${reason}`);
      };
      while (!done) {
        await result.then(waitForResponse);
        if (!done)
          ({ result, terminate } = await YamlManager.YamlListener(
            msg,
            timeout * 1000 - Date.now()
          ));
      }
      this._client.off("interactionCreate", subInteractionHandler);
      return [userId, retval];
    })();
  }

  /**
   * Launches the generation process for this game.
   * @param incomingYamls The YAMLs to use for this game.
   * @returns A promise that resolves when the game has been generated.
   */
  private async LaunchGame(
    ...incomingYamls: (PlayerTable | [string, string | null])[] //msg?: DiscordMessage
  ) {
    if (!PYTHON_PATH) throw new Error("Python path has not been defined");
    if (!AP_PATH) throw new Error("Archipelago path has not been defined");
    if (!this._guildId) throw new Error("No guild associated to this game");
    if (!this._hostId) throw new Error("No host associated to this game");

    const playerList: [string, string][] = [];
    for (const yamlEntry of incomingYamls) {
      if (yamlEntry instanceof PlayerTable) {
        if (yamlEntry.defaultCode)
          playerList.push([yamlEntry.userId, yamlEntry.defaultCode]);
      } else if (yamlEntry[1] !== null)
        playerList.push(yamlEntry as [string, string]);
    }
    this._players.playing = playerList.map((i) => i[0]);

    const writeMsg = (msgContent: string | MessageEditOptions) => {
      this._msg?.edit(msgContent);
    };

    if (playerList.length === 0) {
      writeMsg(
        "There are no players left to play this game! It has been cancelled."
      );
      this._state = GameState.Cancelled;
      return;
    }

    const outputPath = pathJoin("./games", this._code);
    await MkdirIfNotExist(outputPath);

    const yamlPath = pathJoin(outputPath, "yamls");
    await MkdirIfNotExist(yamlPath);
    // NOTE: Is it necessary to make sure the YAML directory is empty? It should just have been created
    // await readdir(yamlPath, { withFileTypes: true }).then((files) =>
    //   files
    //     .filter((i) => !i.isDirectory())
    //     .forEach((i) => unlink(pathJoin(yamlPath, i.name)))
    // );

    const playerYamlList = await YamlManager.GetYamlsByCode(
      ...playerList.map((i) => i[1])
    );

    await Promise.all(
      playerYamlList.map((i) =>
        copyFile(
          pathJoin("yamls", i.userId, `${i.filename}.yaml`),
          pathJoin(yamlPath, `${i.filename}.yaml`)
        )
      )
    );

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
            return new MessageAttachment(spoilerData)
              .setName(i.name)
              .setSpoiler(true);
          });

        writeMsg({
          content:
            `Game ${this._code} has been generated. Players: ` +
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

        this._state = GameState.Ready;
        return this.RunGame();
      })
      .catch((e) => {
        writeMsg({
          content: "An error occurred during game generation.",
          files: [
            new MessageAttachment((e as Error).message, "Generation Error.txt"),
          ],
        });
        this._state = GameState.GenerationFailed;
      });
  }

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
    if (!channel.isText()) throw new Error("Channel is not text channel");

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
          value: userMention(this._hostId),
        },
      ],
      footer: {
        text: `Game code: ${this._code}`,
      },
    });
    const msg = await channel.send({
      content:
        `Game ${this._code} is live! The game host can reply to this message to send commands to the server. ` +
        "To send a slash command, precede it with a period instead of a slash so that it doesn't get intercepted by Discord. " +
        "For instance: `.forfeit player`",
      embeds: [liveEmbed],
    });

    const gamePath = pathJoin("./games", this._code);
    const logout = createWriteStream(
      pathJoin(gamePath, `${this._filename}.stdout.log`)
    );

    const lastFiveLines: string[] = [];
    const pyApServer = spawn(
      PYTHON_PATH,
      [
        "MultiServer.py",
        "--port",
        port.toString(),
        "--use_embedded_options",
        pathResolve(pathJoin(gamePath, `${this._filename}.archipelago`)),
      ],
      { cwd: AP_PATH }
    );
    pyApServer.stderr.pipe(
      createWriteStream(pathJoin(gamePath, `${this._filename}.stderr.log`))
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
        content: `Server for game ${this._code} closed ${
          pcode === 0 ? "normally" : ` with error code ${pcode}`
        }.`,
        embeds: [],
      });
      GameTable.update({ active: false }, { where: { code: this._code } });
      msgCollector.stop("serverclose");
      this._state = GameState.Stopped;
    });

    const msgCollector = channel.createMessageCollector({
      filter: (msgIn) =>
        msgIn.type === "REPLY" &&
        msgIn.reference?.messageId === msg.id &&
        msgIn.author.id === this._hostId,
    });
    msgCollector.on("collect", (msgIn) => {
      pyApServer.stdin.write(msgIn.content.replace(/^\./, "/") + "\n");
      lastFiveLines.push("← " + msgIn.content.replace(/^\./, "/"));
      while (lastFiveLines.length > 5) lastFiveLines.shift();

      if (msgIn.deletable) msgIn.delete();
      else msgIn.react("⌨️");
    });
  }

  static async fromCode(client: DiscordClient, code: string) {
    return GameTable.findByPk(code).then((existingGame) => {
      if (existingGame)
        return new GameManager(client, code, false, existingGame);
      else throw new Error(`Game ${code} not found`);
    });
  }

  static async NewGame(client: DiscordClient, isTestGame = false) {
    return GameTable.findAll({ attributes: ["code"] }).then(
      (codeList) =>
        new GameManager(
          client,
          GenerateLetterCode(codeList.map((i) => i.code)),
          isTestGame
        )
    );
  }

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

  static async CleanupGames(interaction?: BaseCommandInteraction) {
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
          .filter((i) => i.active && i.updatedAt.getTime() < twoWeeksAgo)
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
}
