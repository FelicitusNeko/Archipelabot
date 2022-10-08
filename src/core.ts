import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { get as httpsGet } from "https";
import { resolve as pathResolve } from "path";

import {
  ChatInputApplicationCommandData, CommandInteraction,
} from "discord.js";
import * as YAML from "yaml";

import { YamlManager } from "./YamlManager";

/** The current state of a given AP session. */
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

/** The current functional state of a given game. */
export enum GameFunctionState {
  /** The game is available to play. */
  Playable,
  /** The game is only available for testing. */
  Testing,
  /** The game is currently broken. */
  Broken,
  /** The game will soon be available. */
  Upcoming,
  /** The game is classified as a Support game, which is meant to be played alongside another game. */
  Support,
  /** The game has been removed. */
  Excluded,
  /** The game is not on the list in any category. */
  Unknown,
}

/**
 * The definition for a Discord slash command.
 * @extends ChatInputApplicationCommandData
 */
export interface Command extends ChatInputApplicationCommandData {
  /** The function to run when this command is invoked. */
  run: (interaction: CommandInteraction) => Promise<void>;
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
  /** The worst state of any given game in this YAML. */
  worstState?: GameFunctionState;
  /** The stringified data for this YAML. */
  data: string;
}

export interface GameList {
  version?: [number, number, number];
  games: string[];
  testgames?: string[];
  broken?: string[];
  upcoming?: string[];
  excluded?: string[];
  support?: string[];
}

/**
 * Returns the current list of valid games.
 * @returns {GameList} The current list of games.
 */
const GetGameList = (() => {
  let gameList = { games: [] } as GameList;
  let lastModified = new Date(0);
  return () => {
    const fileinfo = statSync("gamelist.json");
    if (fileinfo.mtime !== lastModified) {
      gameList = JSON.parse(
        readFileSync("gamelist.json").toString()
      ) as GameList;
      lastModified = fileinfo.mtime;
    }
    return gameList;
  };
})();

/**
 * Returns whether the current operating system has the given application available.
 * Only currently works on Linux.
 * @async
 * @param pgm The program to check for.
 * @returns {boolean} Whether that program is available on this system.
 */
 const SystemHas = (() => {
  let retval: boolean | null = null;
  return async (pgm: string) => {
    if (retval !== null) return Promise.resolve(retval);
    if (process.platform !== "linux") return Promise.resolve((retval = false));
    return new Promise<boolean>((f) => {
      const which = spawn("which", [pgm]);
      which.on("close", (code) => {
        f((retval = code === 0));
      });
    });
  };
})();

/**
 * Returns whether the current operating system has the `screen` multiplexer available.
 * @async
 * @returns {Promise<boolean>} Whether `screen` is available on this system.
 */
const SystemHasScreen = (): Promise<boolean> => SystemHas('screen');

/**
 * Returns whether the current operating system has the `mkfifo` tool available.
 * @async
 * @returns {boolean} Whether `mkfifo` is available on this system.
 */
const SystemHasMkfifo = (): Promise<boolean> => SystemHas('mkfifo');

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
 * Determines whether a given list of games contains all Support games or not, or whether there is a mix.
 * @param games List of games to evaolute against the Support games list.
 * @returns Whether every game in the given list is a Support game. `null` if there is a mix.
 */
const ContainsSupportGames = (...games: string[]) => {
  const { support } = GetGameList();
  if (!support) return false;

  let allSupport: boolean | undefined = undefined;
  for (const game in games) {
    const isSupport = support.includes(game);
    if (allSupport === undefined) allSupport = isSupport;
    else if (allSupport !== isSupport) return null;
  }

  return allSupport;
};

/**
 * Checks the game list to see whether a game is available to be played, or else why it is not available.
 * @param game The game to check.
 * @returns An indicator of what stage the given game is in, or `GameFunctionState.Unknown` if it is not in the list.
 */
const GetGameFunctionState = (game: string): GameFunctionState => {
  for (const [category, list] of Object.entries(GetGameList()) as [
    string,
    string[]
  ][]) {
    if (list.includes(game))
      switch (category) {
        case "games":
          return GameFunctionState.Playable;
        case "testgames":
          return GameFunctionState.Testing;
        case "broken":
          return GameFunctionState.Broken;
        case "upcoming":
          return GameFunctionState.Upcoming;
        case "support":
          return GameFunctionState.Support;
        case "excluded":
          return GameFunctionState.Excluded;
        default:
          return GameFunctionState.Unknown;
      }
  }
  return GameFunctionState.Unknown;
};

/**
 * Runs a quick sanity check on the given YAML data.
 * @param data The stringified YAML data.
 * @returns {YamlData} A set of analysis data pertaining to the scanned YAML.
 */
const QuickValidateYaml = (data: string) => {
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

    if (yamlIn.description === "") delete yamlIn.description;
    const retval: YamlData = {
      desc: yamlIn.description ?? "No description",
      data,
    };

    switch (typeof yamlIn.name) {
      case "object":
        retval.name = Object.keys(yamlIn.name).map(ValidateName);
        break;
      case "string":
        retval.name = [ValidateName(yamlIn.name)];
        break;
      case "undefined":
        throw new Error("Name missing");
    }

    switch (typeof yamlIn.game) {
      case "object":
        retval.games = Object.keys(yamlIn.game as Record<string, number>);
        break;
      case "string":
        retval.games = [yamlIn.game as string];
        break;
      case "undefined":
        throw new Error("No game defined");
    }
    if (!retval.games) throw new Error("Games not defined");

    if (ContainsSupportGames(...retval.games) === null)
      throw new Error(`Cannot mix Support games with others`);

    retval.worstState = YamlManager.GetWorstStatus(retval.games);
    if (retval.worstState >= GameFunctionState.Excluded)
      throw new Error(`Invalid game found in this YAML`);

    for (const game of retval.games)
      if (yamlIn[game] === undefined)
        throw new Error(`Settings not defined for game ${game}`);

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

const GetStdFunctionStateErrorMsg = (
  reason: GameFunctionState,
  cannotBeUsed: string
) => {
  switch (reason) {
    case GameFunctionState.Playable:
      return `This YAML is valid to be used ${cannotBeUsed}.`;
    case GameFunctionState.Testing:
      return `This YAML contains games in testing, and cannot be used ${cannotBeUsed}.`;
    case GameFunctionState.Upcoming:
      return `This YAML contains games not yet available in AP, and cannot be used ${cannotBeUsed}.`;
    case GameFunctionState.Broken:
      return `This YAML contains games that are currently broken, and cannot be used ${cannotBeUsed}.`;
    case GameFunctionState.Excluded:
      return `This YAML contains games that are no longer part of AP, and cannot be used ${cannotBeUsed}.`;
    case GameFunctionState.Support:
      return `This YAML contains a support game. Whether it can be used ${cannotBeUsed} is up to the host.`;
    case GameFunctionState.Unknown:
      return `This YAML contains games in an unknown state, and cannot be used ${cannotBeUsed}.`;
  }
};
export {
  SystemHasScreen,
  SystemHasMkfifo,
  MkdirIfNotExist,
  GetFile,
  ContainsSupportGames,
  GetGameFunctionState,
  QuickValidateYaml,
  isPortAvailable,
  GenerateLetterCode,
  GetStdFunctionStateErrorMsg,
};
