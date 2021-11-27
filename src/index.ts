import { Client as DiscordClient, Intents } from "discord.js";
import * as botConf from "./botconf.json";

interface BotConf {
  discord: {
    token: string;
  };
}

(async () => {
  const client = new DiscordClient({ intents: [Intents.FLAGS.GUILDS] });

  client.once('ready', () => console.log('Ready'));

  client.login((botConf as BotConf).discord.token);
})();
