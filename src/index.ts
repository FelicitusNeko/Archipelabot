import { Client as DiscordClient, Intents } from "discord.js";

import { Archipelabot } from "./Archipelabot";

(async () => {
  new Archipelabot(new DiscordClient({ intents: [Intents.FLAGS.GUILDS] }));
})();
