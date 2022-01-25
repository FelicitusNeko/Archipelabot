import {
  BaseCommandInteraction,
  ChatInputApplicationCommandData,
} from "discord.js";
import * as YAML from "yaml";

import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { get as httpsGet } from "https";
import { resolve as pathResolve } from "path";
import { spawn } from "child_process";

import * as gameList from "./gamelist.json";

/** The current state of a given game. */
export enum GameState {
  /** The game data has been loaded into the game manager. */
  Ready,
  /** Players are assembling into this game. */
  Assembling,
  /** YAMLs are being gathered for this game. */
  GatheringYAMLs,
  /** The game is being generated. */
  Generating,
  /** The game is running. */
  Running,

  /** The game server has been stopped. */
  Stopped = 100,
  /** The game has failed to generate. */
  GenerationFailed,
  /** The game was cancelled, either manually or due to lack of players. */
  Cancelled,
}

/**
 * The definition for a Discord slash command.
 * @extends ChatInputApplicationCommandData
 */
export interface Command extends ChatInputApplicationCommandData {
  /** The function to run when this command is invoked. */
  run: (interaction: BaseCommandInteraction) => Promise<void>;
}

/** Data pertaining to the parsed YAML. */
export interface YamlData {
  /** The error encountered while parsing the YAML, if any. */
  error?: string;
  /** The games enabled for this YAML. */
  games?: string[];
  /** The slot name(s) for this YAML. */
  name?: string[];
  /** The description for this YAML, if any. */
  desc?: string;
  /** The message ID where the YAML was received. */
  msgId?: string;
  /** The stringified data for this YAML. */
  data: string;
}

/**
 * Creates a file system path, if it does not already exist.
 * @param path The directory path to create.
 * @returns A promise that resolves when the directory has been created. Resolves instantly if it exists.
 */
const MkdirIfNotExist = (path: string): Promise<void> =>
  !existsSync(pathResolve(path)) ? mkdir(pathResolve(path)) : Promise.resolve();

/**
 * Retrieves a file from a URL.
 * @param url The URL to retrieve.
 * @returns A promise that resolves as the data from the file.
 */
const GetFile = (url: string) => {
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
const QuickValidateYaml = (data: string) => {
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
const GenerateLetterCode = (
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

export {
  MkdirIfNotExist,
  GetFile,
  QuickValidateYaml,
  isPortAvailable,
  GenerateLetterCode,
};
