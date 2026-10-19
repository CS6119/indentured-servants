import { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { config } from './config.js';

try {
  const settings = config();
  const command = new SlashCommandBuilder().setName('confession-panel')
    .setDescription('Post Echoveil’s confession button in the configured channel')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild);
  await new REST().setToken(settings.DISCORD_TOKEN).post(
    Routes.applicationGuildCommands(settings.DISCORD_CLIENT_ID, settings.DISCORD_GUILD_ID),
    { body: command.toJSON() },
  );
  await new REST().setToken(settings.DISCORD_TOKEN).post(
    Routes.applicationGuildCommands(settings.DISCORD_CLIENT_ID, settings.DISCORD_GUILD_ID),
    { body: new SlashCommandBuilder().setName('confession-settings')
      .setDescription('Change your personal confession preferences').toJSON() },
  );
  console.log('Registered /confession-panel and /confession-settings.');
} catch {
  console.error('Registration failed. Check .env values, bot installation and network connection.');
  process.exitCode = 1;
}
