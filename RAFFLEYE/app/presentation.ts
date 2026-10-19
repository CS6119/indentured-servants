import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, StringSelectMenuBuilder, escapeMarkdown } from 'discord.js';
import type { APIEmbed } from 'discord.js';
import { matchesTopic } from './discovery.js';
import { instant, parseExtraction, parsePost, postUrl, qualified, terminal, timeKeys } from './models.js';
import type { State } from './models.js';
import type { GiveawayRow } from './storage.js';
import { labelledTimes, unresolvedTimeReason, timezoneNote } from './timeparse.js';

export const NO_MENTIONS = { parse: [] as ('users' | 'roles' | 'everyone')[], repliedUser: false };
export const COLORS: Record<State, number> = { open: 0x26ad81, upcoming: 0x7586fa, ending_soon: 0xf0ab3d, ended: 0x808080, cancelled: 0xd84855, unknown: 0x808080 };
export function clean(value: unknown, limit = 700): string {
  const text = Array.isArray(value) ? value.join('\n') : String(value ?? 'Not stated');
  return escapeMarkdown(text).replace(/@(everyone|here)/gi, '@\u200b$1').slice(0, limit);
}
export function visible(row: GiveawayRow, topic: 'wuwa' | 'all'): boolean {
  try { return qualified(parseExtraction(JSON.parse(row.extraction))) && matchesTopic(parsePost(row.post), topic); }
  catch { return false; }
}
export function compactUtc(value: string): string { return new Date(instant(value)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC'; }
export function fixedClock(value: string, offsetHours: number): string {
  return new Date(instant(value) + offsetHours * 3600000).toISOString().replace('T', ' ').slice(0, 16);
}
// WuWa server clocks are fixed offsets, not the changing civil offsets of a host's city.
// References: https://wutheringwaves.gg/server and https://wutheringwaves.fandom.com/wiki/Reset
export function serverClocks(value: string): string[] {
  return [
    `JST · ${fixedClock(value, 9)} (UTC+9)`,
    `Asia / SEA / HMT · ${fixedClock(value, 8)} (UTC+8)`,
    `Europe · ${fixedClock(value, 1)} (UTC+1)`,
    `America · ${fixedClock(value, -5)} (UTC−5)`,
  ];
}
export function timestamp(value: string, relative = true): string {
  const seconds = Math.floor(instant(value) / 1000);
  return [compactUtc(value), ...serverClocks(value), `Local · <t:${seconds}:f>${relative ? ` (<t:${seconds}:R>)` : ''}`].join('\n');
}
export function giveawayEmbed(row: GiveawayRow): EmbedBuilder {
  const post = parsePost(row.post), extraction = parseExtraction(JSON.parse(row.extraction));
  const title = clean(extraction.prizes.value?.join(', ') || 'Giveaway', 160);
  const embed = new EmbedBuilder().setTitle((terminal(row.status) ? row.status.toUpperCase() + ' · ' : '') + (post.source === 'mock' ? 'Sample · ' : '') + title).setAuthor({ name: clean('@' + post.author, 100) }).setColor(COLORS[row.status]);
  const lines: string[] = [];
  if (extraction.winner_count.value) lines.push(`${extraction.winner_count.value} winner${extraction.winner_count.value === 1 ? '' : 's'}`);
  const timing = labelledTimes(post.text);
  const names = { starts_at: 'Starts', deadline_at: 'Ends', announcement_at: 'Announcement' };
  let hasTiming = false;
  for (const key of timeKeys) {
    const value = extraction[key].value;
    if (value) { const note = timezoneNote(extraction[key].evidence ?? '', post.text, post.author_location); lines.push(`**${names[key]}** · ${timestamp(value, row.status !== 'cancelled')}${note ? '\n' + clean(note, 200) : ''}`); hasTiming = true; }
    else if (timing[key].length) {
      const raw = timing[key].map(item => item.raw).join(' / ');
      lines.push(`**${names[key]}** · ${clean(raw, 160)} — ${unresolvedTimeReason(raw, post.text)}`); hasTiming = true;
    }
  }
  if (!hasTiming) lines.push('**Time** · Not clearly stated');
  if (extraction.sponsor.value) lines.push('**Sponsor** · ' + clean(extraction.sponsor.value.replace(/\s+/g, ' '), 200));
  if (extraction.requirements.value?.length) {
    let requirements = extraction.requirements.value.map(value => value.replace(/https?:\/\/t\.co\/\S+/g, '').trim().replace(/\s+/g, ' ')).join(' • ');
    if (requirements.length > 600) requirements = requirements.slice(0, 597).replace(/\s+\S*$/, '') + '…';
    lines.push('**To enter** · ' + clean(requirements, 700));
  } else lines.push('**To enter** · See original post');
  embed.setDescription(lines.join('\n'));
  if (row.status === 'upcoming' || row.status === 'ending_soon' || terminal(row.status)) embed.setFooter({ text: row.status.replaceAll('_', ' ').replace(/^./, letter => letter.toUpperCase()) });
  return embed;
}
export function cardButtons(row: GiveawayRow): ActionRowBuilder<ButtonBuilder> {
  const post = parsePost(row.post);
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel(terminal(row.status) ? 'VIEW ORIGINAL ↗' : 'OPEN GIVEAWAY ↗').setStyle(ButtonStyle.Link).setURL(postUrl(post)),
    new ButtonBuilder().setLabel('Details').setStyle(ButtonStyle.Secondary).setCustomId(`raffleye:details:${post.id}`),
    new ButtonBuilder().setLabel('Dashboard').setStyle(ButtonStyle.Secondary).setCustomId('raffleye:home'),
  );
}
export const DETAIL_SECTIONS = {
  entry: ['Prize & entry', 'Prizes, winner count, and all entry requirements'],
  dates: ['Dates & countdowns', 'UTC, JST, WuWa server clocks and original date wording'],
  sponsors: ['Sponsors & links', 'Stated sponsors and supplied links'],
  evidence: ['Source evidence', 'Exact text behind the extracted information'],
} as const;
export type DetailSection = keyof typeof DETAIL_SECTIONS;
export function detailEmbed(row: GiveawayRow, section: DetailSection = 'entry'): EmbedBuilder {
  const post = parsePost(row.post), data = parseExtraction(JSON.parse(row.extraction));
  const embed = new EmbedBuilder().setTitle(DETAIL_SECTIONS[section][0]).setAuthor({ name: clean('@' + post.author, 100) }).setColor(COLORS[row.status]);
  const missing = 'Not clearly stated in the post.';
  if (section === 'entry') {
    for (const [name, item] of [['Prize', data.prizes], ['Winners', data.winner_count], ['How to enter', data.requirements]] as const) embed.addFields({ name, value: item.value === null ? missing : clean(item.value, 1000) });
  } else if (section === 'dates') {
    const stated = labelledTimes(post.text);
    for (const key of timeKeys) {
      const value = data[key].value;
      const raw = stated[key].map(item => item.raw).join(' / ');
      const note = timezoneNote(data[key].evidence ?? '', post.text, post.author_location);
      embed.addFields({ name: { starts_at: 'Starts', deadline_at: 'Entry deadline', announcement_at: 'Scheduled announcement' }[key], value: value ? timestamp(value, row.status !== 'cancelled') + (note ? '\n' + clean(note, 200) : '') : raw ? clean(raw, 300) + '\n' + unresolvedTimeReason(raw, post.text) : missing });
    }
    embed.setFooter({ text: 'Same moment in every clock. Server clocks use fixed offsets; Local follows your Discord timezone.' });
  } else if (section === 'sponsors') {
    embed.addFields({ name: 'Sponsor', value: data.sponsor.value ? clean(data.sponsor.value) : missing }, { name: 'Sponsor websites', value: data.sponsor_websites.value ? clean(data.sponsor_websites.value) : missing });
    if (post.urls.length) embed.addFields({ name: 'Other supplied links', value: clean(post.urls, 1000) });
    embed.setFooter({ text: 'Sponsor claims come from the post and are not independently verified.' });
  } else {
    const excerpts = [...new Set(Object.values(data).map(item => item.evidence).filter((item): item is string => !!item))];
    embed.setDescription(excerpts.length ? clean(excerpts.join('\n\n'), 3500) : missing);
  }
  if (!embed.data.footer) embed.setFooter({ text: 'Open the original post for its full terms. No automatic giveaway entry.' });
  return embed;
}
export function detailMenu(row: GiveawayRow, section: DetailSection): ActionRowBuilder<StringSelectMenuBuilder> {
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`raffleye:detailmenu:${row.id}`).setPlaceholder('Choose details').addOptions(Object.entries(DETAIL_SECTIONS).map(([value, [label, description]]) => ({ value, label, description, default: value === section }))));
}
export function embedCharacterCount(embed: APIEmbed): number {
  return (embed.title?.length ?? 0) + (embed.description?.length ?? 0) + (embed.author?.name.length ?? 0) + (embed.footer?.text.length ?? 0) + (embed.fields?.reduce((sum, field) => sum + field.name.length + field.value.length, 0) ?? 0);
}
