import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { config } from './config.js';
import { createHandler } from './confessions.js';
import { Preferences } from './preferences.js';

let settings;
try { settings = config(); } catch (error) { console.error(error instanceof Error ? error.message : 'Invalid configuration.'); process.exit(1); }
const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
let preferences;
try { preferences = new Preferences('data/preferences.json'); }
catch { console.error('Cannot load personal settings. Check data/preferences.json.'); process.exit(1); }
const handle = createHandler(client, settings, preferences);
client.once(Events.ClientReady, () => console.log('Echoveil is online. Use /confession-panel to publish the button.'));
client.on(Events.InteractionCreate, async interaction => {
  try { await handle(interaction); }
  catch {
    // Never log raw Discord errors: request bodies can contain private confession text.
    console.error('An interaction failed. Check bot permissions and connection.');
    const content = 'Unable to confirm completion. Please check the confession channel before trying again.';
    try {
      if (!interaction.isRepliable()) return;
      if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch { /* An expired interaction cannot receive a response. */ }
  }
});
client.on(Events.Error, () => console.error('Discord connection error.'));
client.login(settings.DISCORD_TOKEN).catch(() => {
  console.error('Login failed. Check the bot token in .env and your network connection.');
  process.exitCode = 1;
  client.destroy();
});
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { client.destroy(); process.exit(0); });
