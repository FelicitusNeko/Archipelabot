import { Client as DiscordClient, IntentsBitField } from "discord.js";
import { existsSync } from "fs";
import { join as pathJoin } from "path";

import { Archipelabot } from "./Archipelabot";

const { PYTHON_PATH, AP_PATH } = process.env;

(async () => {
  if (!PYTHON_PATH)
    console.warn(
      "No Python path specified. Bot will not be able to run games.",
    );
  if (!AP_PATH)
    console.warn(
      "No Archipelago path specified. Bot will not be able to run games.",
    );
  else if (!existsSync(pathJoin(AP_PATH, "Generate.py")))
    console.warn(
      "Archipelago path provided seems to be missing files. Bot may not be able to run games.",
    );

  new Archipelabot(
    new DiscordClient({
      intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.GuildMessageReactions,
        IntentsBitField.Flags.DirectMessages,
        IntentsBitField.Flags.DirectMessageReactions,
      ],
    }),
  );
})();
