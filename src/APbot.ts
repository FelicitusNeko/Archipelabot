import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  Client,
  CommandInteraction,
  EmbedBuilder,
  IntentsBitField,
  Interaction,
  InteractionType,
  MessageFlags,
} from "discord.js";
import { BotCommand, MkdirIfNotExist } from "./core";
import debug from "debug";

const { DC_TOKEN, DC_BOTID, DC_OWNERID, ENABLE_TEST } = process.env;
const dbg = debug("main");

export class APbot {
  /** The Discord API client interface. */
  private readonly _client: Client;
  /** The list of commands accepted by the bot. */
  private readonly _cmds: BotCommand[];
  /** The list of games currently running. */
  private readonly _games = new Set<unknown>();

  /** The client's user ID, if it is available. If not, returns an empty string. */
  public get clientId(): string {
    return this._client && this._client.user
      ? this._client.user.id
      : DC_BOTID ?? "";
  }

  constructor() {
    if (!DC_TOKEN || DC_TOKEN === "")
      throw new Error("DC_TOKEN not provided in environment");

    this._client = new Client({
      intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.DirectMessages,
        IntentsBitField.Flags.DirectMessageReactions,
      ],
    });

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
        run: this.cmdAPStart,
        defer: true,
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
        run: this.cmdAPResume,
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
              //{ name: "Send YAML to user", value: "giveyaml" },
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
        run: async (i) => {
          i.reply({
            content: "Hello! I'm awake.",
            flags: MessageFlags.Ephemeral,
          });
        },
      },
    ];

    if (ENABLE_TEST === "1") {
      dbg("Enabling test suite");
      this._cmds.push({
        name: "test",
        description: "Testing commands",
        type: ApplicationCommandType.ChatInput,
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "name",
            description: "What test to run.",
            required: true,
          },
        ],
        run: this.cmdTest,
      });
    }

    this._client.once("ready", () => {
      dbg(
        "%s is online and running in %d servers",
        this._client.user?.username ?? "Archipelabot",
        this._client.guilds.cache.size
      );
      this._client.application?.commands.set(this._cmds);
    });

    this._client.on("interactionCreate", async (i: Interaction) => {
      if (i.type == InteractionType.ApplicationCommand) {
        const cmd = this._cmds.find((c) => c.name === i.commandName);
        if (!cmd)
          i.followUp({
            content: "Sorry, I don't recognize that command.",
            flags: MessageFlags.Ephemeral,
          });
        else
          (cmd.defer === true ? i.deferReply() : Promise.resolve())
            .then(() => cmd.run(i))
            .catch((e) => {
              console.error(e);
              i.followUp({
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
    });

    MkdirIfNotExist("./yamls");
    MkdirIfNotExist("./games");
    MkdirIfNotExist("./pipes");

    this._client.login(DC_TOKEN);
  }

  cmdAPStart = async (i: CommandInteraction) => {
    i.followUp(
      "The bot is currently being reworked and commands may be unavailable at times."
    );
  };

  cmdAPResume = async (i: CommandInteraction) => {
    i.reply(
      "The bot is currently being reworked and commands may be unavailable at times."
    );
  };

  cmdYaml = async (i: CommandInteraction) => {
    i.reply(
      "The bot is currently being reworked and commands may be unavailable at times."
    );
  };

  cmdAdmin = async (i: CommandInteraction) => {
    if (i.user.id !== DC_OWNERID)
      // TODO: check user table for admin status
      i.reply({
        content: "Admin commands are only available to bot admins.",
        flags: MessageFlags.Ephemeral,
      });
    else
      i.reply(
        "The bot is currently being reworked and commands may be unavailable at times."
      );
  };

  cmdTest = async (i: CommandInteraction) => {
    if (i.user.id !== DC_OWNERID)
      i.reply({
        content: "Test commands are only available to bot developers.",
        flags: MessageFlags.Ephemeral,
      });
    else
      switch (i.options.get("name", true).value) {
        default:
          i.reply({
            content: "Test not found.",
            flags: MessageFlags.Ephemeral,
          });
          break;
      }
  };
}
