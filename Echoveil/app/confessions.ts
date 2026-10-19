import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, LabelBuilder,
  ModalBuilder, TextInputBuilder, TextInputStyle, MessageFlags, PermissionFlagsBits,
  ChannelType,
} from 'discord.js';
import type { Client, Interaction } from 'discord.js';
import type { Settings } from './config.js';
import { Preferences } from './preferences.js';

export const BUTTON = 'sinner:write:v1';
export const MODAL = 'sinner:confession:v1';
export const SETTINGS = 'echoveil:settings:v1';
export const CONFIRM_ON = 'echoveil:confirm:on';
export const CONFIRM_OFF = 'echoveil:confirm:off';
const privateReply = (content: string) => ({ content, flags: MessageFlags.Ephemeral as const, allowedMentions: { parse: [] } });

function settingsButton() {
  return new ButtonBuilder().setCustomId(SETTINGS).setLabel('My settings').setStyle(ButtonStyle.Secondary);
}

function preferencesView(enabled: boolean) {
  return {
    content: `**Your confession settings**\nSuccess confirmation: **${enabled ? 'On' : 'Off'}**\n${enabled ? 'You see a private confirmation after posting.' : 'The success confirmation disappears after posting. Errors still appear.'}\nOnly affects you. Saved for future visits.`,
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
      .setCustomId(enabled ? CONFIRM_OFF : CONFIRM_ON)
      .setLabel(enabled ? 'Turn confirmation off' : 'Turn confirmation on').setStyle(ButtonStyle.Secondary))],
  };
}

export function confessionButton() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
    .setCustomId(BUTTON).setLabel('I wanna confess').setStyle(ButtonStyle.Secondary), settingsButton());
}

export function panel() {
  return {
    embeds: [new EmbedBuilder().setColor(0x756583).setTitle('A quiet place to confess')
      .setDescription('Write privately. Share here without your name.')
      .setFooter({ text: 'Echoveil · Anonymous to members, not Discord or the bot.' })],
    components: [new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder()
      .setCustomId(BUTTON).setLabel('Write a confession').setStyle(ButtonStyle.Secondary), settingsButton())],
    allowedMentions: { parse: [] },
  };
}

export function modal() {
  return new ModalBuilder().setCustomId(MODAL).setTitle('Write a confession')
    .addLabelComponents(new LabelBuilder().setLabel('What’s on your mind?')
      .setDescription('Shared in this channel without your name. Avoid identifying details.')
      .setTextInputComponent(new TextInputBuilder().setCustomId('confession')
        .setStyle(TextInputStyle.Paragraph).setRequired(true).setMinLength(1).setMaxLength(4000)
        .setPlaceholder('Start here…')));
}

export function confessionPost(value: string) {
  const text = value.trim();
  if (!text || text.length > 4000) throw new Error('Confessions must contain 1–4000 characters.');
  return {
    embeds: [new EmbedBuilder().setColor(0x756583).setTitle('Anonymous confession')
      .setDescription(text).setFooter({ text: 'Posted' }).setTimestamp()],
    components: [confessionButton()],
    allowedMentions: { parse: [], users: [], roles: [], repliedUser: false },
  };
}

export function createHandler(client: Client, settings: Settings, preferences = new Preferences()) {
  // Only transient cooldown timestamps; no confession text, message IDs or author mapping.
  const cooldowns = new Map<string, number>();
  const pending = new Set<string>();
  const cooldownMs = 45_000;
  async function destination() {
    const channel = await client.channels.fetch(settings.CONFESSION_CHANNEL_ID);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== settings.DISCORD_GUILD_ID) {
      throw new Error('Configured destination must be a text channel in the configured server.');
    }
    const me = channel.guild.members.me ?? await channel.guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
      throw new Error('Missing channel permissions.');
    }
    return channel;
  }
  return async (interaction: Interaction) => {
    const setup = interaction.isChatInputCommand() && interaction.commandName === 'confession-panel';
    const button = interaction.isButton() && interaction.customId === BUTTON;
    const submission = interaction.isModalSubmit() && interaction.customId === MODAL;
    const personalSettings = interaction.isChatInputCommand() && interaction.commandName === 'confession-settings';
    const settingsAction = interaction.isButton() && [SETTINGS, CONFIRM_ON, CONFIRM_OFF].includes(interaction.customId);
    if (!setup && !button && !submission && !personalSettings && !settingsAction) return;
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !interaction.isModalSubmit()) return;
    if (interaction.guildId !== settings.DISCORD_GUILD_ID) {
      await interaction.reply(privateReply('This bot is not configured for this server.'));
      return;
    }
    if (personalSettings || settingsAction) {
      if (interaction.isButton() && interaction.customId !== SETTINGS) {
        // Derive the preference owner from the click, never from user-supplied IDs.
        preferences.setConfirmations(interaction.user.id, interaction.customId === CONFIRM_ON);
        await interaction.update(preferencesView(preferences.confirmations(interaction.user.id)));
      } else {
        await interaction.reply({ ...preferencesView(preferences.confirmations(interaction.user.id)), flags: MessageFlags.Ephemeral });
      }
      return;
    }
    if (interaction.isChatInputCommand() && setup) {
      if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) {
        await interaction.reply(privateReply('Manage Server permission is required.'));
        return;
      }
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await (await destination()).send(panel());
      await interaction.editReply('The confession button is ready in the configured channel.');
      return;
    }
    const now = Date.now();
    for (const [id, until] of cooldowns) if (until <= now) cooldowns.delete(id);
    const userId = interaction.user.id;
    if (pending.has(userId) || cooldowns.has(userId)) {
      await interaction.reply(privateReply('Please wait 45 seconds between confessions.'));
      return;
    }
    if (interaction.isButton() && button) {
      await interaction.showModal(modal());
      return;
    }
    if (!interaction.isModalSubmit()) return;
    const text = interaction.fields.getTextInputValue('confession');
    if (!text.trim() || text.length > 4000) {
      await interaction.reply(privateReply('Please write between 1 and 4000 characters.'));
      return;
    }
    pending.add(userId);
    try {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await (await destination()).send(confessionPost(text));
      cooldowns.set(userId, Date.now() + cooldownMs);
      const cleanup = setTimeout(() => cooldowns.delete(userId), cooldownMs);
      cleanup.unref?.();
      if (preferences.confirmations(userId)) {
        await interaction.editReply({ content: 'Your confession has been posted anonymously.',
          components: [new ActionRowBuilder<ButtonBuilder>().addComponents(settingsButton())] });
      } else {
        await interaction.deleteReply();
      }
    } finally {
      pending.delete(userId);
    }
  };
}
