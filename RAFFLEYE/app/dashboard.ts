import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelSelectMenuBuilder, ChannelType, EmbedBuilder, StringSelectMenuBuilder } from 'discord.js';
import { randomBytes } from 'node:crypto';
import type { Service } from './service.js';
import type { GiveawayRow } from './storage.js';
import { instant, parseExtraction, parsePost, postUrl, terminal } from './models.js';
import { clean, visible } from './presentation.js';

export function button(id: string, label: string, style = ButtonStyle.Secondary, disabled = false): ButtonBuilder { return new ButtonBuilder().setCustomId('raffleye:' + id).setLabel(label).setStyle(style).setDisabled(disabled); }
export function row(...buttons: ButtonBuilder[]): ActionRowBuilder<ButtonBuilder> { return new ActionRowBuilder<ButtonBuilder>().addComponents(buttons); }
export const homeRow = () => row(button('home', 'Dashboard'), button('help', 'Help'), button('status', 'Status'));
export function relative(value: string | null | undefined): string {
  if (!value || !Number.isFinite(Date.parse(value))) return 'Not yet';
  return `<t:${Math.floor(Date.parse(value) / 1000)}:R>`;
}
export function humanIssue(code: string): string {
  if (/limit reached/.test(code)) return 'A daily or monthly budget limit was reached. Monitoring resumes after the limit resets.';
  if (/http_401|http_403/.test(code)) return 'The provider token or access permissions need attention.';
  if (/http_402/.test(code)) return 'The provider account needs billing attention.';
  if (/http_429|cooldown/.test(code)) return 'The provider is cooling down; automatic retries are scheduled.';
  if (/network|http_5/.test(code)) return 'The provider is temporarily unreachable; retries are scheduled.';
  if (/partial|schema|invalid/.test(code)) return 'The provider returned data that could not be verified; that page was not accepted.';
  return 'A job needs attention. Check the queued failures or retry after the underlying problem is fixed.';
}
function commandRef(service: Service, name: string): string {
  const id = service.store.meta('discord_command_id');
  return id ? `</raffleye ${name}:${id}>` : `\`/raffleye ${name}\``;
}
export function dashboard(service: Service) {
  const { store, settings } = service;
  const channel = store.subscription(settings.discord_guild_id);
  const active = store.list(1000, candidate => visible(candidate, settings.giveaway_topic) && !terminal(candidate.status)).length;
  const data = store.status();
  const issues = Object.values(data.query_errors).filter((item): item is string => !!item);
  const embed = new EmbedBuilder().setTitle('RAFFLEYE').setColor(0x7586fa)
    .setDescription('Your giveaway controls, all in one place. This menu is private.');
  embed.addFields(
    { name: 'Giveaways', value: `${active} saved active or date-unclear offers\n${settings.giveaway_topic === 'gacha' ? 'Gacha · giveaway + amount, quantity or winner count' : settings.giveaway_topic === 'wuwa' ? 'Wuthering Waves · concrete prizes required' : 'All configured topics · concrete prizes required'}`, inline: true },
    { name: 'Your feed', value: channel ? `<#${channel}>\n${store.paused(channel) ? 'New cards paused' : `One new card every ${settings.notification_interval_seconds / 60} minutes`}` : 'No channel selected\nOpen Setup to choose one', inline: true },
    { name: 'Monitoring', value: `Last check ${relative(data.last_tick)}\n${data.pending_notifications} cards or edits queued${issues.length ? '\n' + humanIssue(issues[0]!) : ''}` },
  );
  embed.setFooter({ text: 'New posts ping Beggars. Existing cards update in place. Never enters giveaways for you.' });
  return { embeds: [embed], components: [row(button('browse:active', 'Browse giveaways', ButtonStyle.Primary), button('browse:ending', 'Ending soon'), button('accounts:0', 'Accounts')), row(button('raffle:new','Create giveaway',ButtonStyle.Success),button('raffle:home','My giveaways'),button('heads:home','Announcements (no entries)')),row(button('setup','Setup'),button('status','Status & budget'),button('help','Help'))] };
}
export function statusPanel(service: Service) {
  const { store, settings } = service, data = store.status();
  const issues = [...new Set([...Object.values(data.query_errors), data.extraction_warning, data.worker_error].filter((item): item is string => !!item))];
  const used = data.usage_today.estimated_usd ?? 0, monthly = data.usage_month.estimated_usd ?? 0;
  const fresh = data.last_progress && Date.now() - Date.parse(data.last_progress) < settings.poll_seconds * 3000 + 120000;
  const title = data.worker_error || !fresh ? 'Monitoring needs attention' : issues.length ? 'Monitoring · waiting or limited' : 'Monitoring is running';
  const embed = new EmbedBuilder().setTitle(title).setColor(data.worker_error || !fresh ? 0xf0ab3d : 0x26ad81);
  embed.addFields(
    { name: 'Checks & delivery', value: `Last completed cycle ${relative(data.last_tick)}\nLast progress ${relative(data.last_progress)}\nLast card or edit ${relative(store.meta('last_delivery'))}` },
    { name: 'Estimated spend', value: `Today: **US$${used.toFixed(2)} / $${settings.daily_estimated_usd.toFixed(2)}**\nThis month: **US$${monthly.toFixed(2)} / $${settings.monthly_estimated_usd.toFixed(2)}**\nLimits reset at UTC day/month boundaries. These are conservative reservations, not the provider invoice.` },
    { name: 'Queue', value: `${data.pending_extractions} posts waiting for review\n${data.pending_notifications} cards or edits queued\n${data.quarantined_extractions + data.failed_notifications} failed jobs need attention`, inline: true },
    { name: 'Feed rules', value: `${settings.giveaway_topic === 'gacha' ? 'Gacha · giveaway + amount, quantity or winner count' : settings.giveaway_topic === 'wuwa' ? 'WuWa only · named prizes' : 'Configured topics · named prizes'}\nOne new card per ${settings.notification_interval_seconds / 60} minutes\nCatch-up window: ${settings.backfill_hours / 24} days`, inline: true },
  );
  if (issues.length) embed.addFields({ name: 'What is happening', value: [...new Set(issues.map(humanIssue))].join('\n').slice(0, 1000) });
  if (data.coverage_warning) embed.addFields({ name: 'Coverage', value: clean(data.coverage_warning) });
  embed.setFooter({ text: 'You can retry failed jobs with Manage Server permission. A fresh heartbeat is not proof that X is available.' });
  return { embeds: [embed], components: [row(button('status', 'Refresh'), button('retry', 'Retry failed jobs'), button('home', 'Dashboard'))] };
}
export function setupPanel(service: Service) {
  const { store, settings } = service, channel = store.subscription(settings.discord_guild_id);
  const embed = new EmbedBuilder().setTitle('Feed setup').setColor(0x7586fa).setDescription(channel ? `Current feed: <#${channel}>\n${store.paused(channel) ? '**New cards are paused.**' : '**New cards are enabled.**'}` : 'Choose where RAFFLEYE should post giveaways.');
  embed.addFields({ name: 'Giveaway notifications', value: `One new card every ${settings.notification_interval_seconds / 60} minutes, with a Beggars role ping. Pause stops new cards while monitoring and edits continue.` }, { name: 'Who can change this?', value: 'You need View Channel + Manage Channels in the chosen feed channel, or Manage Server. Moving an existing feed to another channel requires Manage Server.' });
  return { embeds: [embed], components: [new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(new ChannelSelectMenuBuilder().setCustomId('raffleye:channel').setPlaceholder('Choose the feed channel').setChannelTypes(ChannelType.GuildText)), row(button(channel && store.paused(channel) ? 'resume' : 'pause', channel && store.paused(channel) ? 'Resume new cards' : 'Pause new cards', ButtonStyle.Secondary, !channel), button('stop:ask', 'Stop feed', ButtonStyle.Secondary, !channel), button('home', 'Dashboard'))] };
}
export function accountsPanel(service: Service, page = 0) {
  const queries = service.store.queries().filter(query => /^(watch|profile):/.test(query.key));
  const last = Math.max(0, Math.ceil(queries.length / 10) - 1);
  page = Math.max(0, Math.min(last, page));
  const lines = queries.slice(page * 10, page * 10 + 10).map(query => `**@${clean(query.key.split(':')[1], 30)}** · ${query.key.startsWith('profile:') ? 'discovered from bio' : ['','high','normal','low'][query.priority] + ' priority'} · every ${query.interval_s / 60}m`);
  const embed = new EmbedBuilder().setTitle('Watched accounts').setColor(0x7586fa).setDescription(lines.join('\n') || 'No account watches yet. Global giveaway discovery is still active.');
  embed.addFields({ name: 'Discovery', value: service.settings.giveaway_topic === 'gacha' ? `Gacha-related post text and profiles qualify. Posts need giveaway plus an amount, reward quantity or winner count. Up to ${service.settings.profile_watch_limit} discovered profiles receive hourly checks.` : `Relevant WuWa hashtags and account bios are checked. Up to ${service.settings.profile_watch_limit} discovered accounts with both WuWa and giveaway wording receive extra checks. Every post still needs a concrete prize.` });
  embed.setFooter({ text: `Page ${page + 1}/${last + 1} · Account changes require Manage Server. Automatic accounts are learned from search results.` });
  return { embeds: [embed], components: [row(button('watch:add', 'Add / update account', ButtonStyle.Primary), button('watch:remove', 'Remove account'), button('home', 'Dashboard')), row(button(`accounts:${page - 1}`, 'Previous', ButtonStyle.Secondary, page <= 0), button(`accounts:${page + 1}`, 'Next', ButtonStyle.Secondary, page >= last))] };
}
export type BrowseFilter = 'active' | 'ending' | 'upcoming' | 'all';
export interface BrowseSession { owner: string; guild: string; filter: BrowseFilter; query: string; page: number; expires: number }
export class BrowseSessions {
  private readonly sessions = new Map<string, BrowseSession>();
  constructor(private readonly clock: () => number = Date.now) {}
  create(owner: string, guild: string, filter: BrowseFilter = 'active', query = ''): string {
    for (const [key, value] of this.sessions) if (value.expires <= this.clock()) this.sessions.delete(key);
    if (this.sessions.size >= 1000) this.sessions.delete(this.sessions.keys().next().value!);
    const token = randomBytes(8).toString('hex');
    this.sessions.set(token, { owner, guild, filter, query: query.slice(0, 100), page: 0, expires: this.clock() + 600000 });
    return token;
  }
  get(token: string, owner: string, guild: string): BrowseSession | null {
    const value = this.sessions.get(token);
    if (!value || value.owner !== owner || value.guild !== guild || value.expires <= this.clock()) return null;
    value.expires = this.clock() + 600000;
    return value;
  }
}
export function browseRows(service: Service, session: BrowseSession): GiveawayRow[] {
  const query = session.query.toLowerCase();
  const rows = service.store.list(1000, item => {
    if (!visible(item, service.settings.giveaway_topic)) return false;
    if (session.filter === 'active' && terminal(item.status)) return false;
    if (session.filter === 'ending' && item.status !== 'ending_soon') return false;
    if (session.filter === 'upcoming' && item.status !== 'upcoming') return false;
    const post = parsePost(item.post);
    return !query || `${post.author} ${post.text} ${post.id}`.toLowerCase().includes(query);
  });
  if (session.filter === 'ending') rows.sort((a, b) => instant(parseExtraction(JSON.parse(a.extraction)).deadline_at.value!) - instant(parseExtraction(JSON.parse(b.extraction)).deadline_at.value!));
  return rows;
}
export function browsePanel(service: Service, token: string, session: BrowseSession) {
  const rows = browseRows(service, session), pages = Math.max(1, Math.ceil(rows.length / 5));
  session.page = Math.max(0, Math.min(pages - 1, session.page));
  const page = rows.slice(session.page * 5, session.page * 5 + 5);
  const labels: Record<BrowseFilter, string> = { active: 'Active / date unclear', ending: 'Ending soon', upcoming: 'Upcoming', all: 'All saved giveaways' };
  const embed = new EmbedBuilder().setTitle(labels[session.filter]).setColor(0x7586fa).setDescription(session.query ? `Search: **${clean(session.query, 100)}**` : 'Choose an offer below to see its full details.');
  for (const item of page) {
    const post = parsePost(item.post), data = parseExtraction(JSON.parse(item.extraction));
    embed.addFields({ name: clean(data.prizes.value?.join(', ') || 'Giveaway', 200), value: `[@${clean(post.author)} · Open original ↗](${postUrl(post)})\n${data.deadline_at.value ? `Ends <t:${Math.floor(instant(data.deadline_at.value) / 1000)}:R>` : 'Deadline not fully specified'} · ${item.status.replaceAll('_', ' ')}` });
  }
  if (!page.length) embed.addFields({ name: 'No matches', value: 'Try another filter or search. Searches cover saved giveaways; new discoveries appear as monitoring runs.' });
  embed.setFooter({ text: `Page ${session.page + 1}/${pages} · ${rows.length}${rows.length === 1000 ? '+' : ''} matches · Only you can see this menu` });
  const filter = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId(`raffleye:filter:${token}`).setPlaceholder('Filter giveaways').addOptions(Object.entries(labels).map(([value, label]) => ({ value, label, default: value === session.filter }))));
  const controls = row(button(`page:${token}:previous`, 'Previous', ButtonStyle.Secondary, session.page === 0), button(`page:${token}:next`, 'Next', ButtonStyle.Secondary, session.page >= pages - 1), button('search', 'Search'), button('home', 'Dashboard'));
  const components: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [filter];
  if (page.length) components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('raffleye:pick').setPlaceholder('Open giveaway details').addOptions(page.map(item => ({ label: parseExtraction(JSON.parse(item.extraction)).prizes.value!.join(', ').slice(0, 95), value: item.id, description: '@' + parsePost(item.post).author })))));
  components.push(controls);
  return { embeds: [embed], components };
}
export const HELP_TOPICS = { home: 'Getting started', browse: 'Finding giveaways', cards: 'Reading a card', headsup: 'Heads-up giveaways', giveaway: 'Discord-only giveaways', roles: 'Giveaway notification role', activity: 'Private activity reports', setup: 'Feed setup', accounts: 'Accounts & discovery', status: 'Health & spending' } as const;
export type HelpTopic = keyof typeof HELP_TOPICS;
export function helpPanel(service: Service, section: HelpTopic = 'home') {
  const ref = (name: string) => commandRef(service, name);
  const embed = new EmbedBuilder().setTitle(HELP_TOPICS[section]).setColor(0x7586fa);
  const content: Record<HelpTopic, string> = {
    home: `Use **Dashboard** for private controls. Browse offers, check monitoring, choose a feed channel, or manage account watches.\n\n${ref('dashboard')} opens it anytime. ${ref('help')} opens this guide. No separate document is needed.`,
    browse: `${ref('list')} opens saved giveaways with filters, pages and search. **Ending soon** requires a known deadline. **Active / date unclear** includes offers whose end time is not fully specified.\n\n${ref('show')} opens a post by its numeric X post ID. **Details** on any card shows the same private menu.`,
    headsup: `${ref('headsup')} opens the same picture-first giveaway creator as **Create giveaway**. Choose a prize, enter its name/amount per winner, quantity (number of winners) and description, then schedule and publish. Participants enter UID and Server. Existing announcement-only posts remain editable under **Announcements (no entries)**.`,
    giveaway: `${ref('giveaway')} or **Discord giveaway** on the Dashboard creates a button-entry raffle. Choose **Lunite**, **Monthly Pass**, **Battle Pass** or **Premium Battle Pass** from the picture gallery. The next form asks for **prize name/amount**, **quantity (one prize per winner)** and **description**, in that order. Then use **Starts** and **Ends**. Pick quick presets or **Custom time** for exact dates (plain dates use Taipei UTC+8). The preview shows the image, amount and both times. Publishing announces it immediately and pings Beggars; entries open at the scheduled start. Each winner receives the named prize; quantity sets the number of distinct winners. Entrants use **Enter / edit** to submit a private UID and server/region, and can correct them until entries close. After the draw, **Winner info** on the result post shows each winner’s UID and server privately to the publisher. The publisher can also download submissions through **My Discord giveaways → Manage → Download submissions**. Each member gets one entry; publisher and bots cannot enter. **Leave** withdraws an entry before the draw.\n\nThe bot selects the configured number of distinct random winners when the timer ends, or the publisher presses **Draw now**. The saved result appears on the original card and survives restarts; there is no automatic redraw. No entrants means no winner. **Cancel** deletes the announcement and stops the raffle. Image, Draw now and Cancel work only for the publisher.\n\nImages include Lunite, Lunite Subscription, Insider Channel and Connoisseur Channel presets, uploads and published X screenshots. Set the exact prize and quantity in the title. The publisher arranges prize delivery.`,
    activity: `${ref('activity-report')} with **action: Enable** links monthly private reports to your Discord account and checks that DMs work. Manage Server is required. Reports arrive every **30 days** from enabling; use Preview, Status or Disable from the same command.\n\nReports compare recorded raffle entries and 🎁/🎉 reactions on posts in giveaway channels with human messages in other bot-visible channels. Beggars opt-in panels are excluded. Entries and reactions on the same post count once toward the default review threshold: **3 giveaway posts with no regular chat observed**. A separate limited-chat section highlights repeat participants with only **1–2 chat messages**. Counts cannot judge conversation quality or friendship. Each participant’s counts and chat days are attached, including those below the threshold.\n\nTracking begins when enabled, with no historical backfill. Coverage gaps are disclosed. Voice, lurking, DMs and external X entries are not measured. No message text is stored; metadata is retained for 90 days. Reports are private, and do not automatically punish members.`,
    roles: `${ref('reactionrole')} opens a form to write the title and multiline description of an emoji-reaction role message. Choose a notification role such as **Beggars**, and optionally a channel. Members react with 🎁 to receive that role and remove their reaction to opt out. This does not enter a giveaway.\n\nYou and RAFFLEYE need **Manage Roles**, with your roles above the role being assigned. The notification role must have no extra permissions. RAFFLEYE also needs View Channel, Send Messages, Embed Links, Read Message History and Add Reactions in the destination.\n\n${ref('reactionrole-edit')} edits existing wording by message ID without changing roles or reactions. ${ref('reactionrole-remove')} removes a panel by message ID; existing role holders keep their roles. Missed reactions are reconciled after restarts and periodically. New giveaway announcements, including the automatic feed, ping **Beggars**. Edits do not ping again.`,
    cards: '**Prize, entry steps, stated sponsors and times stay on the card.** Complete dates show UTC, JST, WuWa server clocks, your local time, and a countdown. JST is UTC+9; Asia/SEA/HMT servers use UTC+8, Europe UTC+1, and America UTC-5. These are different displays of the same moment. A timezone stated in the post takes priority. Otherwise, a recognizable account profile location supplies an estimated timezone, with daylight saving applied for that date. The card labels this estimate. Vague or multizone locations, missing years/times and ambiguous dates remain unresolved.\n\n**OPEN GIVEAWAY** opens X. Screenshots capture only the public embedded post through its timestamp; long posts may say Show more. If X cannot render an embed, the link remains available. Details includes source evidence.\n\nIn gacha mode, posts need gacha context, giveaway wording, and a numeric prize amount, reward quantity or winner count. Unknown prizes stay unstated. Other modes require a concrete prize. No automatic entry, likes, follows, reposts or tagging.',
    setup: `${ref('setup')} lets you choose a channel, pause/resume new cards or stop the feed. You need **View Channel + Manage Channels in the target channel**, or **Manage Server**. Moving an existing feed requires Manage Server.\n\nThe bot needs View Channel, Send Messages, Embed Links and Attach Files for screenshots.\n\n${ref('subscribe')} and ${ref('unsubscribe')} remain available. New cards ping Beggars, at most one per ${service.settings.notification_interval_seconds / 60} minutes. Existing cards update in place. Pausing new cards does not pause monitoring.`,
    accounts: `${ref('watchlist')} shows manual and discovered watches. Add/update/remove controls require **Manage Server**, as do ${ref('watch')} and ${ref('unwatch')}. Priorities 1/2/3 check every 5/15/60 minutes.\n\nGacha mode checks game context in returned posts and account profiles. Relevant profiles qualify for hourly extra checks, capped at ${service.settings.profile_watch_limit} discovered accounts. WuWa mode requires both WuWa and giveaway wording in the profile. This is not an exhaustive search of every profile.\n\nCatch-up covers ${service.settings.backfill_hours / 24} days and resumes after interruptions. Older posts and image-only information can be missed.`,
    status: `${ref('status')} explains connection or budget delays, queued work and failures. Daily/monthly estimates persist across restarts and reset on UTC boundaries. They are conservative local reservations, not the provider invoice.\n\nX may pause requests for access, billing, rate limits or exhausted budgets. Monitoring retries without bypassing limits. ${ref('retry')} retries failed jobs and requires **Manage Server**.\n\nA running process does not prove every source is available or every giveaway was found.`,
  };
  embed.setDescription(content[section]);
  return { embeds: [embed], components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(new StringSelectMenuBuilder().setCustomId('raffleye:helpmenu').setPlaceholder('Choose a help topic').addOptions(Object.entries(HELP_TOPICS).map(([value, label]) => ({ value, label, default: value === section })))), homeRow()] };
}
