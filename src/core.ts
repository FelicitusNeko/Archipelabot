import {
  ChatInputApplicationCommandData,
  CommandInteraction,
} from "discord.js";

import { spawn } from "child_process";
import { existsSync, readFileSync, statSync } from "fs";
import { mkdir } from "fs/promises";
import { get } from "https";
import { resolve } from "path";

/** The current state of a given AP session. */
enum GameState {
  /** The game data has been loaded into the game manager. */
  Ready,
  
  /** Players are assembling into this game. */
  Assembling = 100,
  /** The game is being generated. */
  Generating,
  /** The game is running. */
  Running,

  /** The game server has been stopped. */
  Stopped = 200,
  /** The game has failed to generate. */
  GenerationFailed,
  /** The game was cancelled, either manually or due to lack of players. */
  Cancelled,
}

/** The current functional state of a given game. */
enum GameFlags {
  /** The game is available to play. */
  Playable = "games",
  /** The game is classified as a Support game, which is meant to be played alongside another game. */
  Support = "support",
  /** The game is not officially supported by Archipelago. */
  Unsupported = "unsupported",
  /** The game is only available for testing. */
  Testing = "testgames",
  /** The game will soon be officially supported. */
  Upcoming = "upcoming",
  /** The game is not available to be played. It may be broken, or it may have been removed from official support. */
  Unavailable = "unavailable",
  /** The game has special handling and does not require a YAML. */
  SpecialHandling = "specialHandling",
  /** The game is not on the list in any category. */
  Unknown = "unknown",
}

/** A version number specification, broken down as `[major, minor, revision]`. */
type VersionSpec = [number, number, number];

/**
 * The definition for a Discord slash command.
 * @extends ChatInputApplicationCommandData
 */
interface BotCommand extends ChatInputApplicationCommandData {
  /** The function to run when this command is invoked. */
  run: (interaction: CommandInteraction) => Promise<void>;
  /** Whether the command handler should automatically defer reply for longer operations. Default `false`. */
  defer?: boolean;
}

/** List of games available to the local copy of Archipelago. */
interface GameList {
  /** The current version of the local copy of Archipelago. */
  version: VersionSpec;
  /** The list of games known to the local copy of Archipelago, along with their current status. */
  games: Map<string, GameFlags[]>;
}

/**
 * Creates a file system path, if it does not already exist.
 * @param path The directory path to create.
 * @returns A promise that resolves when the directory has been created. Resolves instantly if it exists.
 */
const MkdirIfNotExist = (path: string): Promise<void> =>
  existsSync(resolve(path)) ? Promise.resolve() : mkdir(resolve(path));

/**
 * Returns the current list of recognised games.
 * @returns {GameList} The current list of games.
 */
const GetGameList = (() => {
  const gameList = { version: [0, 0, 0], games: new Map() } as GameList;
  let lastModified = new Date(0);
  return () => {
    const fileinfo = statSync("gamelist.json");
    if (fileinfo.mtime !== lastModified) {
      lastModified = fileinfo.mtime;
      const refresh = JSON.parse(readFileSync("gamelist.json").toString());
      gameList.games.clear();
      for (const k in refresh) {
        const v = refresh[k];
        if (k === "version") gameList.version = v as VersionSpec;
        else
          for (const game of v as string[]) {
            if (!gameList.games.has(game))
              gameList.games.set(game, [k as GameFlags]);
            else gameList.games.get(game)?.push(k as GameFlags);
          }
      }
    }
    return gameList;
  };
})();

/**
 * Retrieves a file from a URL.
 * @param url The URL to retrieve.
 * @returns A promise that resolves as the data from the file.
 */
const GetRemoteFile = (url: string) =>
  new Promise<string>((f, r) => {
    get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk.toString()));
      res.on("close", () => f(data));
      res.on("error", (e) => r(e));
    });
  });

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
          lsof.on("close", (_) => {
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
  length: number = 4
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
  GameState,
  GameFlags as GameFunctionState,
  VersionSpec,
  BotCommand,
  GameList,
  MkdirIfNotExist,
  GetGameList,
  GetRemoteFile,
  isPortAvailable,
  GenerateLetterCode,
};
