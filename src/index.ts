import { Client as DiscordClient, Intents } from "discord.js";

import { Archipelabot } from "./Archipelabot";

(async () => {
  new Archipelabot(
    new DiscordClient({
      intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.GUILD_MESSAGE_REACTIONS,
        Intents.FLAGS.DIRECT_MESSAGES,
      ],
    })
  );
})();
