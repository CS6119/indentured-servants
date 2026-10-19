import { ActivityReports, recordParticipation } from './activity-reports.js';
import { ActionRowBuilder, AttachmentBuilder, ChannelType, Client, Events, GatewayIntentBits, MessageFlags, ModalBuilder, PermissionFlagsBits, SlashCommandBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { Interaction, InteractionReplyOptions, RepliableInteraction } from 'discord.js';
import { accountsPanel, BrowseSessions, browsePanel, button, dashboard, helpPanel, homeRow, row, setupPanel, statusPanel, HELP_TOPICS } from './dashboard.js';
import type { BrowseFilter, HelpTopic } from './dashboard.js';
import { cardButtons, DETAIL_SECTIONS, detailEmbed, detailMenu, NO_MENTIONS, visible } from './presentation.js';
import type { DetailSection } from './presentation.js';
import { Notifier } from './notifications.js';
import type { Service } from './service.js';
import { errorCode, log, SafeError } from './log.js';
import { HeadsUps, headsUpFiles, headsUpImageModal, headsUpStartChoices, headsUpEmbed, headsUpLinks, headsUpModal, headsUpPhase } from './headsups.js';
import { prepareHeadsUpImage } from './headsup-media.js';
import type { HeadsUpInput } from './headsups.js';
import { Raffles, isMissingMessage, raffleEmbed, raffleControls, entryModal } from './raffles.js';
import { prizeGallery, prizeTitle, setupPanel as raffleSetup, setupChoices, setupModal, scheduleInput, prizeDetailsModal } from './raffle-setup.js';
import { presetPrizeImage, prizeImageChoices } from './prize-images.js';
import { ReactionRoles,roleTextModal,roleTextDefaults } from './reaction-roles.js';

export function commands() {
  const command = new SlashCommandBuilder().setName('raffleye').setDescription('Giveaway discovery and private controls');
  for (const [name, description] of Object.entries({ dashboard: 'Open your private dashboard', setup: 'Choose or pause the feed', help: 'Browse the help guide', status: 'Monitoring, queues and budget', list: 'Browse and search saved giveaways', watchlist: 'View watched accounts', unsubscribe: 'Stop the giveaway feed', retry: 'Retry failed jobs' })) command.addSubcommand(sub => sub.setName(name).setDescription(description));
  command.addSubcommand(sub => sub.setName('show').setDescription('Open giveaway details').addStringOption(option => option.setName('post_id').setDescription('Numeric X post ID').setRequired(true)));
  command.addSubcommand(sub => sub.setName('subscribe').setDescription('Set the feed channel').addChannelOption(option => option.setName('channel').setDescription('Feed channel').addChannelTypes(ChannelType.GuildText).setRequired(true)));
  command.addSubcommand(sub => sub.setName('watch').setDescription('Add or update an account watch').addStringOption(option => option.setName('handle').setDescription('X handle').setRequired(true)).addIntegerOption(option => option.setName('priority').setDescription('1 = 5m, 2 = 15m, 3 = 60m').setMinValue(1).setMaxValue(3)));
  command.addSubcommand(sub => sub.setName('unwatch').setDescription('Remove an account watch').addStringOption(option => option.setName('handle').setDescription('X handle').setRequired(true)));
  command.addSubcommand(sub => sub.setName('headsup').setDescription('Create a giveaway with pictured prizes and UID/server entries'));
  command.addSubcommand(sub => sub.setName('giveaway').setDescription('Create a Discord-only giveaway with a random winner'));
  command.addSubcommand(sub=>sub.setName('reactionrole').setDescription('Post a gift-reaction menu for a notification role').addRoleOption(option=>option.setName('role').setDescription('Notification role with no extra permissions, e.g. Beggars').setRequired(true)).addChannelOption(option=>option.setName('channel').setDescription('Channel for the message (default: this channel)').addChannelTypes(ChannelType.GuildText)));
  command.addSubcommand(sub=>sub.setName('reactionrole-remove').setDescription('Remove a reaction-role panel').addStringOption(option=>option.setName('message_id').setDescription('ID of the reaction-role message').setRequired(true)));
  command.addSubcommand(sub=>sub.setName('reactionrole-edit').setDescription('Edit the title and description of a role message').addStringOption(option=>option.setName('message_id').setDescription('ID of the reaction-role message').setRequired(true)));
  command.addSubcommand(sub=>sub.setName('activity-report').setDescription('Private monthly giveaway versus chat activity report').addStringOption(option=>option.setName('action').setDescription('Enable, preview, check status or disable your private reports').setRequired(true).addChoices({name:'Enable monthly DMs to me',value:'enable'},{name:'Preview my current report',value:'preview'},{name:'Status',value:'status'},{name:'Disable my reports',value:'disable'})).addIntegerOption(option=>option.setName('minimum_giveaways').setDescription('Flag at least this many giveaways with no observed chat (default 3)').setMinValue(1).setMaxValue(100)));
  return command;
}
export function canConfigure(manageGuild: boolean, viewChannel: boolean, manageChannel: boolean, current?: string, target?: string): boolean {
  return manageGuild || (viewChannel && manageChannel && (!current || current === target));
}
export class Bot {
  readonly client = new Client({ intents: [GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessages,GatewayIntentBits.GuildMessageReactions], allowedMentions: NO_MENTIONS });
  readonly sessions = new BrowseSessions();
  readonly notifier: Notifier;
  readonly headsups: HeadsUps;
  readonly raffles: Raffles;
  readonly reactionRoles:ReactionRoles;
  readonly activity:ActivityReports;
  private activityTimer?:ReturnType<typeof setInterval>;
  private headsRefresh: Promise<void> = Promise.resolve();
  private raffleRefresh?: Promise<void>;
  private raffleTimer?: ReturnType<typeof setInterval>;
  constructor(readonly service: Service, readonly assertOwner: () => void, readonly signal: AbortSignal) {
    this.activity=new ActivityReports(service.store,service.settings.discord_guild_id,async(recipient,payload)=>{this.assertOwner();this.signal.throwIfAborted();const guild=await this.client.guilds.fetch(service.settings.discord_guild_id),member=await guild.members.fetch({user:recipient,force:true});if(!member.permissions.has(PermissionFlagsBits.ManageGuild))throw new SafeError('activity_recipient_requires_manage_server');return (await this.client.users.fetch(recipient)).send(payload);});
    this.headsups = new HeadsUps(service.store);
    this.raffles = new Raffles(service.store);
    this.reactionRoles=new ReactionRoles(service.store,this.client,service.settings.discord_guild_id,assertOwner,signal);
    this.notifier = new Notifier(service, async id => {
      const channel = await this.client.channels.fetch(id);
      if (!channel || channel.type !== ChannelType.GuildText) throw new SafeError('feed_channel_unavailable');
      return { guildId: channel.guildId, ping:()=>this.giveawayPing(channel.id,channel.guildId), send: options => channel.send(options), edit: (messageId, options) => channel.messages.edit(messageId, options) };
    }, assertOwner, Date.now, signal);
    this.client.on(Events.InteractionCreate, interaction => { void this.handle(interaction); });
    this.client.on('raw',(packet:unknown)=>{this.reactionRoles.onPacket(packet);void this.recordGiveawayReaction(packet).catch(error=>log('activity_reaction_error',{error:errorCode(error)}));});
    this.client.on(Events.MessageCreate,message=>{
      try {this.assertOwner();this.activity.message({id:message.id,guild:message.guildId??'',user:message.author.id,channel:message.channelId,at:message.createdTimestamp,bot:message.author.bot,webhook:Boolean(message.webhookId),excluded:this.giveawayChannels().has(message.channelId)||Boolean(message.channel.isThread()&&this.giveawayChannels().has(message.channel.parentId??''))});}catch(error){log('activity_record_error',{error:errorCode(error)});}
    });
    this.client.on(Events.Error, () => log('discord_connection_error'));
  }
  private giveawayChannels():Set<string> {
    return new Set([this.service.store.subscription(this.service.settings.discord_guild_id)??'',...this.raffles.list().filter(item=>item.message).map(item=>item.channel),...this.headsups.list().filter(item=>item.message).map(item=>item.channel)]);
  }
  async recordGiveawayReaction(packet:unknown):Promise<void> {
    if(!this.activity.config()?.enabled||!packet||typeof packet!=='object')return;
    const event=packet as {t?:string;d?:{guild_id?:string;channel_id?:string;message_id?:string;user_id?:string;emoji?:{name?:string};member?:{user?:{bot?:boolean}}}};
    const data=event.d;
    if(event.t!=='MESSAGE_REACTION_ADD'||!data||data.guild_id!==this.service.settings.discord_guild_id||!data.channel_id||!data.message_id||!data.user_id||!['🎁','🎉'].includes(data.emoji?.name??'')||!this.giveawayChannels().has(data.channel_id))return;
    if(this.reactionRoles.panels.list().some(panel=>panel.message===data.message_id))return;
    const bot=data.member?.user?.bot??(await this.client.users.fetch(data.user_id)).bot;if(bot)return;
    this.assertOwner();this.signal.throwIfAborted();recordParticipation(this.service.store,data.guild_id,data.user_id,data.message_id,'reaction');
  }
  async giveawayPing(channelId:string,guildId:string) {
    const guild=await this.client.guilds.fetch(guildId),roles=await guild.roles.fetch();
    const matches=roles.filter(role=>role.name.toLowerCase()==='beggars'&&!role.managed&&role.id!==guildId);
    if(matches.size!==1)throw new SafeError('Giveaway ping needs exactly one role named Beggars in this server.');
    const role=matches.first()!,channel=await guild.channels.fetch(channelId),me=await guild.members.fetchMe();
    if(!role.mentionable&&!channel?.permissionsFor(me)?.has(PermissionFlagsBits.MentionEveryone))throw new SafeError('Allow mentioning the Beggars role, or give RAFFLEYE Mention Everyone permission in the giveaway channel.');
    return {content:`<@&${role.id}>`,allowedMentions:{parse:[] as [],roles:[role.id],users:[],repliedUser:false}};
  }
  private async respond(interaction: RepliableInteraction, payload: InteractionReplyOptions): Promise<void> {
    const options = { ...payload, allowedMentions: NO_MENTIONS };
    if (interaction.deferred || interaction.replied) { await interaction.editReply({ ...options, flags: undefined } as Parameters<typeof interaction.editReply>[0]); return; }
    if (interaction.isMessageComponent() && interaction.message.flags.has(MessageFlags.Ephemeral)) await interaction.update({ ...options, flags: undefined } as Parameters<typeof interaction.update>[0]);
    else await interaction.reply({ ...options, flags: MessageFlags.Ephemeral });
  }
  private async manager(interaction: RepliableInteraction): Promise<boolean> {
    const member = await interaction.guild!.members.fetch(interaction.user.id);
    return member.permissions.has(PermissionFlagsBits.ManageGuild);
  }
  private async requireManager(interaction: RepliableInteraction): Promise<void> {
    if (!await this.manager(interaction)) throw new SafeError('Manage Server permission is required for account changes and retries.');
  }
  private async authorizeChannel(interaction: RepliableInteraction, target: string): Promise<void> {
    const guild = interaction.guild!;
    const channel = await guild.channels.fetch(target);
    if (!channel || channel.type !== ChannelType.GuildText) throw new SafeError('Choose a text channel in this server.');
    const member = await guild.members.fetch(interaction.user.id), permissions = channel.permissionsFor(member);
    if (!canConfigure(member.permissions.has(PermissionFlagsBits.ManageGuild), !!permissions?.has(PermissionFlagsBits.ViewChannel), !!permissions?.has(PermissionFlagsBits.ManageChannels), this.service.store.subscription(guild.id), target)) throw new SafeError('You need View Channel + Manage Channels here. Moving an existing feed requires Manage Server.');
    const me = await guild.members.fetchMe();
    if (!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, ...(this.service.settings.post_screenshots ? [PermissionFlagsBits.AttachFiles] : [])])) throw new SafeError('RAFFLEYE needs View Channel, Send Messages, Embed Links and Attach Files here.');
  }
  private details(id: string, section: DetailSection = 'entry'): InteractionReplyOptions {
    const item = this.service.store.giveaway(id);
    if (!item || !visible(item, this.service.settings.giveaway_topic)) throw new SafeError('That giveaway is not in the saved feed.');
    return { embeds: [detailEmbed(item, section)], components: [detailMenu(item, section), cardButtons(item)] };
  }
  private browse(interaction: RepliableInteraction, filter: BrowseFilter = 'active', query = '') {
    const token = this.sessions.create(interaction.user.id, interaction.guildId!, filter, query);
    return browsePanel(this.service, token, this.sessions.get(token, interaction.user.id, interaction.guildId!)!);
  }
  private watch(handle: string, priority: number): void { this.service.store.watch(handle, priority); this.service.store.setMeta('profile_blocked:' + handle.replace(/^@/, '').toLowerCase(), 'false'); }
  private unwatch(handle: string): void {
    handle = handle.replace(/^@/, '').toLowerCase();
    if (!/^[a-z0-9_]{1,15}$/.test(handle)) throw new SafeError('Enter a valid X handle.');
    this.service.store.unwatch(handle);
    this.service.store.db.prepare('DELETE FROM queries WHERE key=?').run('profile:' + handle);
    this.service.store.setMeta('profile_blocked:' + handle, 'true');
  }
  async handle(interaction: Interaction): Promise<void> {
    if (!interaction.isRepliable()) return;
    if (interaction.isChatInputCommand() && interaction.commandName !== 'raffleye') return;
    if ((interaction.isMessageComponent() || interaction.isModalSubmit()) && !interaction.customId.startsWith('raffleye:')) return;
    try {
      if (!interaction.inGuild() || interaction.guildId !== this.service.settings.discord_guild_id || !interaction.guild) throw new SafeError('Use RAFFLEYE in its configured server.');
      this.assertOwner();
      const { store } = this.service;
      let id = interaction.isChatInputCommand() ? interaction.options.getSubcommand() : interaction.isMessageComponent() || interaction.isModalSubmit() ? interaction.customId.slice(9) : '';
      if(id.startsWith('roletext:')&&interaction.isModalSubmit()) {
        await interaction.deferReply({flags:MessageFlags.Ephemeral});
        const parts=id.split(':'),text={title:interaction.fields.getTextInputValue('title'),description:interaction.fields.getTextInputValue('description')};
        const panel=parts[1]==='new'?await this.reactionRoles.create(interaction.guildId,parts[3]!,parts[2]!,interaction.user.id,text):await this.reactionRoles.edit(parts[2]!,interaction.user.id,text);
        await this.respond(interaction,{content:`Role message ${parts[1]==='new'?'published':'updated'}. [View message](https://discord.com/channels/${panel.guild}/${panel.channel}/${panel.message})`});return;
      }
      if(id==='headsup'||id==='heads:new') {await this.handleRaffle(interaction,'raffle:new');return;}
      if(id.startsWith('heads:')) { await this.handleHeadsUp(interaction,id); return; }
      if(id==='giveaway'||id.startsWith('raffle:')) { await this.handleRaffle(interaction,id); return; }
      if (interaction.isChatInputCommand()) {
        if(id==='activity-report') {
          await interaction.deferReply({flags:MessageFlags.Ephemeral});
          if(!await this.manager(interaction))throw new SafeError('Manage Server is required for private activity reports.');
          const action=interaction.options.getString('action',true),recipient=interaction.user.id,config=this.activity.config();
          if(action==='enable') {
            if(config?.enabled&&config.recipient!==recipient)throw new SafeError('Reports are already linked to another recipient.');
            if(config&&!config.enabled&&config.recipient!==recipient)this.service.store.setMeta('activity:'+interaction.guildId,'null');
            if(!config?.enabled){try{await interaction.user.send({content:'RAFFLEYE can DM you here. Your activity report will arrive after 30 days, then every 30 days. Monitoring starts when setup completes. Use /raffleye activity-report to preview or disable it.',allowedMentions:NO_MENTIONS});}catch{throw new SafeError('I could not DM you. Allow direct messages from this server, then enable reports again.');}}
            const saved=this.activity.enable(recipient,interaction.options.getInteger('minimum_giveaways')??3);this.activity.coverage();
            await this.respond(interaction,{content:`Private reports enabled for you. First/next DM: <t:${Math.floor(saved.next/1000)}:F>. Review threshold: at least ${saved.minimum} giveaways and zero chat messages observed. Collection starts when first enabled; no message text is stored.`});return;
          }
          if(action==='disable'){this.activity.disable(recipient);await this.respond(interaction,{content:'Your monthly reports and activity collection are disabled.'});return;}
          if(action==='preview'){await this.respond(interaction,this.activity.preview(recipient));return;}
          await this.respond(interaction,{content:config?.enabled?`Monthly private reports are enabled. Next report: <t:${Math.floor(config.next/1000)}:F>. ${config.lastError?'Last DM attempt failed; delivery will retry hourly. Check that server DMs are allowed.':'No delivery issue recorded.'} Counts cover bot-visible messages and 🎁/🎉 reactions in giveaway channels; notification-role menus are excluded.`:'Monthly reports are disabled. Choose Enable to link them to your Discord account.'});return;
        }

        if(id==='reactionrole') {
          const role=interaction.options.getRole('role',true),channel=interaction.options.getChannel('channel')?.id??interaction.channelId;
          await interaction.showModal(roleTextModal(`new:${role.id}:${channel}`,roleTextDefaults(role.id)));return;
        }
        if(id==='reactionrole-edit') {
          const panel=await this.reactionRoles.editable(interaction.options.getString('message_id',true),interaction.user.id);
          await interaction.showModal(roleTextModal('edit:'+panel.message,{...roleTextDefaults(panel.role),...(panel.title?{title:panel.title}:{}),...(panel.description?{description:panel.description}:{})}));return;
        }
        if(id==='reactionrole-remove') {
          await interaction.deferReply({flags:MessageFlags.Ephemeral});
          await this.reactionRoles.remove(interaction.options.getString('message_id',true),interaction.user.id);
          await this.respond(interaction,{content:'Reaction-role panel removed. Existing role holders keep their roles.'});return;
        }
        if (id === 'show') { await this.respond(interaction, this.details(interaction.options.getString('post_id', true))); return; }
        if (id === 'subscribe') {
          const channel = interaction.options.getChannel('channel', true).id;
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          await this.authorizeChannel(interaction, channel); store.subscribe(interaction.guildId, channel); id = 'setup';
        }
        if (id === 'watch' || id === 'unwatch') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.requireManager(interaction);
          const handle = interaction.options.getString('handle', true);
          if (id === 'watch') this.watch(handle, interaction.options.getInteger('priority') ?? 2); else this.unwatch(handle);
          id = 'accounts:0';
        }
      }
      if (interaction.isModalSubmit()) {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        if (id === 'search:submit') { await this.respond(interaction, this.browse(interaction, 'all', interaction.fields.getTextInputValue('query'))); return; }
        await this.requireManager(interaction);
        const handle = interaction.fields.getTextInputValue('handle');
        if (id === 'watch:submit') this.watch(handle, Number(interaction.fields.getTextInputValue('priority') || 2));
        else if (id === 'unwatch:submit') this.unwatch(handle);
        id = 'accounts:0';
      }
      if (interaction.isButton() && ['search', 'watch:add', 'watch:remove'].includes(id)) {
        if (id !== 'search' && !interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) throw new SafeError('Manage Server permission is required for account changes.');
        const search = id === 'search', remove = id === 'watch:remove';
        const modal = new ModalBuilder().setCustomId('raffleye:' + (search ? 'search:submit' : remove ? 'unwatch:submit' : 'watch:submit')).setTitle(search ? 'Search saved giveaways' : remove ? 'Remove account' : 'Add or update account');
        modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId(search ? 'query' : 'handle').setLabel(search ? 'Words, X handle, or post ID' : 'X handle').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(search ? 100 : 16)));
        if (!search && !remove) modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('priority').setLabel('Priority: 1 (5m), 2 (15m), 3 (60m)').setValue('2').setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(1)));
        await interaction.showModal(modal); return;
      }
      if (interaction.isChannelSelectMenu() && id === 'channel') {
        const target = interaction.values[0]!;
        await interaction.deferUpdate(); await this.authorizeChannel(interaction, target); store.subscribe(interaction.guildId!, target); id = 'setup';
      }
      if (interaction.isStringSelectMenu()) {
        if (id === 'helpmenu') id = 'help:' + interaction.values[0];
        if (id === 'pick') { await this.respond(interaction, this.details(interaction.values[0]!)); return; }
        if (id.startsWith('detailmenu:')) {
          const section = interaction.values[0]!;
          if (!(section in DETAIL_SECTIONS)) throw new SafeError('Choose a valid detail section.');
          await this.respond(interaction, this.details(id.split(':')[1]!, section as DetailSection)); return;
        }
      }
      if (id.startsWith('page:') || id.startsWith('filter:')) {
        const [, token, direction] = id.split(':');
        const session = this.sessions.get(token!, interaction.user.id, interaction.guildId!);
        if (!session) throw new SafeError('This browsing session expired. Open the Dashboard to start again.');
        if (interaction.isStringSelectMenu()) {
          const filter = interaction.values[0]!;
          if (!['active','ending','upcoming','all'].includes(filter)) throw new SafeError('Choose a valid filter.');
          session.filter = filter as BrowseFilter; session.page = 0;
        } else session.page += direction === 'next' ? 1 : -1;
        await this.respond(interaction, browsePanel(this.service, token!, session)); return;
      }
      if (['pause', 'resume', 'stop:confirm', 'unsubscribe'].includes(id)) {
        const channel = store.subscription(interaction.guildId!);
        if (!channel) throw new SafeError('No feed channel is selected.');
        if (!interaction.deferred) await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        await this.authorizeChannel(interaction, channel);
        if (id === 'stop:confirm' || id === 'unsubscribe') store.unsubscribe(interaction.guildId!); else store.setPaused(channel, id === 'pause');
        id = 'setup';
      }
      if (id === 'retry') { await interaction.deferReply({ flags: MessageFlags.Ephemeral }); await this.requireManager(interaction); store.retryFailed(); id = 'status'; }
      let panel: InteractionReplyOptions;
      if (['home', 'dashboard'].includes(id)) panel = dashboard(this.service);
      else if (id === 'status') panel = statusPanel(this.service);
      else if (id === 'setup') panel = setupPanel(this.service);
      else if (id === 'stop:ask') panel = { content: 'Stop new giveaway delivery to this server? Monitoring and saved giveaways remain available.', embeds: [], components: [row(button('stop:confirm', 'Stop feed'), button('setup', 'Keep feed'))] };
      else if (id === 'help' || id.startsWith('help:')) { const topic = id.split(':')[1] ?? 'home'; panel = helpPanel(this.service, (topic in HELP_TOPICS ? topic : 'home') as HelpTopic); }
      else if (id === 'watchlist' || id.startsWith('accounts:')) panel = accountsPanel(this.service, Number(id.split(':')[1]) || 0);
      else if (id === 'list' || id.startsWith('browse:')) panel = this.browse(interaction, id.endsWith('ending') ? 'ending' : 'active');
      else if (id.startsWith('details:')) panel = this.details(id.split(':')[1]!);
      else throw new SafeError('This control is outdated. Open /raffleye dashboard.');
      await this.respond(interaction, { content: '', ...panel });
    } catch (error) {
      log('interaction_error', { error: errorCode(error) });
      const message = error instanceof SafeError && /[ .]/.test(error.code) ? error.code : 'That action could not be completed. Try again from the dashboard.';
      try { await this.respond(interaction, { content: message, embeds: [], components: [homeRow()] }); } catch { /* Interaction expired or connection lost. */ }
    }
  }
  private async handleRaffle(interaction: RepliableInteraction,id:string):Promise<void> {
    const owner=interaction.user.id,guild=interaction.guildId!,token=id.split(':')[2];
    if(id==='giveaway'||id==='raffle:home') {await this.respond(interaction,this.raffles.panel(owner,guild));return;}
    if(id==='raffle:new'&&(interaction.isButton()||interaction.isChatInputCommand())) {
      await interaction.deferReply({flags:MessageFlags.Ephemeral});
      const channel=this.service.store.subscription(guild);if(!channel)throw new SafeError('Set a feed channel first.');await this.authorizeChannel(interaction,channel);
      const draft=this.raffles.create({prize:'1 × Lunite Subscription',minutes:'60',rules:''},{owner,guild,channel,host:interaction.user.globalName??interaction.user.username});
      draft.detailsReady=false;draft.prizeKind='lunite-subscription';draft.quantity=1;draft.image=await presetPrizeImage(draft.prizeKind,this.service.settings.db_path);this.raffles.save(draft);
      await this.respond(interaction,await prizeGallery(draft,this.service.settings.db_path));return;
    }
    const setupAction=id.split(':')[1]!;
    if(['choose','details'].includes(setupAction)&&interaction.isButton()) {
      const draft=this.raffles.own(token!,owner,guild);if(draft.status!=='draft')throw new SafeError('Only unpublished drafts can be configured.');
      await interaction.showModal(prizeDetailsModal(draft,id.split(':')[3]!));return;
    }
    if(['custom','quantity','schedule'].includes(setupAction)&&interaction.isButton()) {
      const draft=this.raffles.own(token!,owner,guild);if(draft.status!=='draft')throw new SafeError('Only unpublished drafts can be configured.');
      await interaction.showModal(setupModal(draft,setupAction as 'custom'|'quantity'|'schedule'));return;
    }
    if(id.startsWith('raffle:image:')&&interaction.isButton()) {
      const item=this.raffles.own(token!,owner,guild);
      if(!['draft','open'].includes(item.status))throw new SafeError('This giveaway can no longer be changed.');
      await this.respond(interaction,prizeImageChoices('raffle',item.id));return;
    }
    if(id.startsWith('raffle:upload:')&&interaction.isButton()) {
      const item=this.raffles.own(token!,owner,guild);
      if(!['draft','open'].includes(item.status))throw new SafeError('This giveaway can no longer be changed.');
      await interaction.showModal(headsUpImageModal(item).setCustomId('raffleye:raffle:media:'+item.id).setTitle('Giveaway image'));return;
    }
    if(id.startsWith('raffle:join:')&&interaction.isButton()) {
      const item=this.raffles.entryContext(token!,owner,guild,interaction.channelId,interaction.message.id,interaction.user.bot);
      if(item.requiresDetails){await interaction.showModal(entryModal(item,owner,this.raffles.entry(item.id,owner)));return;}
    }
    if(interaction.isMessageComponent()&&interaction.message.flags.has(MessageFlags.Ephemeral))await interaction.deferUpdate();
    else await interaction.deferReply({flags:MessageFlags.Ephemeral});
    if(id.startsWith('raffle:entry:')&&interaction.isModalSubmit()) {
      const parts=id.split(':'),raffleId=parts[2]!,user=parts[3]!,message=parts[4]!;
      if(user!==owner)throw new SafeError('This entry form belongs to another user.');
      this.raffles.enter(raffleId,owner,guild,interaction.channelId!,message,interaction.user.bot,false,{uid:interaction.fields.getTextInputValue('uid'),server:interaction.fields.getTextInputValue('server')});
      await this.respond(interaction,{content:'Your entry is saved. Press Enter / edit on the announcement to correct your UID or server before entries close. You still have exactly one entry.'});
      await this.refreshRaffles();return;
    }
    if((id.startsWith('raffle:join:')||id.startsWith('raffle:leave:'))&&interaction.isButton()) {
      const leaving=id.startsWith('raffle:leave:');
      const changed=this.raffles.enter(token!,owner,guild,interaction.channelId,interaction.message.id,interaction.user.bot,leaving);
      await this.respond(interaction,{content:leaving?(changed?'Your entry was removed.':'You were not entered.'):(changed?'You’re entered! One entry per person.':'You’re already entered. One entry per person.')});
      await this.refreshRaffles();return;
    }
    if(id==='raffle:form'&&interaction.isModalSubmit()) {
      const channel=this.service.store.subscription(guild);
      if(!channel)throw new SafeError('Set a feed channel before creating a giveaway.');
      await this.authorizeChannel(interaction,channel);
      const item=this.raffles.create({prize:interaction.fields.getTextInputValue('prize'),minutes:interaction.fields.getTextInputValue('minutes'),rules:interaction.fields.getTextInputValue('rules')},{owner,guild,channel,host:interaction.user.globalName??interaction.user.username});
      await this.respond(interaction,raffleSetup(item));return;
    }
    const item=this.raffles.own(token??'',owner,guild);
    if(['gallery','choose','setup-details','configure','amount','starts','ends','set-amount','set-starts','set-ends','setup-custom','setup-quantity','setup-schedule'].includes(setupAction)) {
      if(item.status!=='draft')throw new SafeError('Only unpublished drafts can be configured.');
      const value=id.split(':')[3]!;
      if(setupAction==='gallery'){await this.respond(interaction,await prizeGallery(item,this.service.settings.db_path));return;}
      if(['amount','starts','ends'].includes(setupAction)){await this.respond(interaction,setupChoices(item,setupAction as 'amount'|'starts'|'ends'));return;}
      if(setupAction==='setup-details'&&interaction.isModalSubmit()) {
        const name=interaction.fields.getTextInputValue('name').trim(),count=Number(interaction.fields.getTextInputValue('quantity')),description=interaction.fields.getTextInputValue('description').trim();
        if(!name||name.length>150||description.length>1000||!Number.isInteger(count)||count<1||count>25)throw new SafeError('Enter a prize name, quantity from 1 to 25, and description up to 1,000 characters.');
        const image=value==='custom'?undefined:await presetPrizeImage(value,this.service.settings.db_path);
        const latest=this.raffles.own(item.id,owner,guild);if(latest.status!=='draft')throw new SafeError('This draft was already published.');
        Object.assign(item,latest,{prize:name,winnerCount:count,rules:description,prizeKind:value==='custom'?undefined:value,image:image??latest.image,detailsReady:true});
      }
      if(setupAction==='choose') {
        const amount=value==='lunite-pack'?60:1;
        const title=prizeTitle(value,amount),image=await presetPrizeImage(value,this.service.settings.db_path);
        const latest=this.raffles.own(item.id,owner,guild);if(latest.status!=='draft')throw new SafeError('This draft was already published.');
        Object.assign(item,latest,{prizeKind:value,quantity:amount,prize:title,image});
      }
      if(setupAction==='set-amount'||setupAction==='setup-quantity') {
        const quantity=Number(setupAction==='setup-quantity'&&interaction.isModalSubmit()?interaction.fields.getTextInputValue('quantity'):value);
        if(!Number.isInteger(quantity)||quantity<1||quantity>100000)throw new SafeError('Choose an amount from 1 to 100,000.');
        if(!item.prizeKind)throw new SafeError('For a custom prize, use Prize details to write the amount.');
        item.quantity=quantity;item.prize=prizeTitle(item.prizeKind,quantity);
      }
      if(setupAction==='set-starts') {
        const delay=Number(value);if(![0,5,15,60,480,1440].includes(delay))throw new SafeError('Choose one of the start options.');
        item.startDelay=delay;item.startAt=undefined;item.endAt=undefined;
      }
      if(setupAction==='set-ends') {
        const minutes=Number(value);if(![25,30,60,360,720,1440,4320,10080].includes(minutes))throw new SafeError('Choose one of the durations.');
        item.minutes=minutes;item.endAt=undefined;
      }
      if(setupAction==='setup-schedule'&&interaction.isModalSubmit())Object.assign(item,scheduleInput(interaction.fields.getTextInputValue('start'),interaction.fields.getTextInputValue('end')));
      if(setupAction==='setup-custom'&&interaction.isModalSubmit()) {
        const prize=interaction.fields.getTextInputValue('prize').trim(),rules=interaction.fields.getTextInputValue('rules').trim();
        if(!prize||prize.length>150||rules.length>1000)throw new SafeError('Enter a prize up to 150 characters and details up to 1,000.');
        if(prize!==item.prize){item.prizeKind=undefined;item.quantity=undefined;}
        item.prize=prize;item.rules=rules;
      }
      item.created=Date.now();this.raffles.save(item);await this.respond(interaction,raffleSetup(item));return;
    }
    if(id.startsWith('raffle:winners:')) {
      await this.respond(interaction,{embeds:[this.raffles.winnerInfo(item.id,owner,guild)],components:[row(button('raffle:submissions:'+item.id,'Download submissions'),button('raffle:home','My giveaways'))]});return;
    }
    if(id.startsWith('raffle:submissions:')) {
      const submissions=this.raffles.submissions(item.id,owner,guild);
      await this.respond(interaction,{content:`Private submissions: ${submissions.length}. Winners: ${(item.winners??(item.winner?[item.winner]:[])).join(', ')||'not drawn'}.`,files:[new AttachmentBuilder(Buffer.from(JSON.stringify({giveaway:item.prize,winner:item.winner??null,winners:item.winners??(item.winner?[item.winner]:[]),submissions},null,2)),{name:'giveaway-submissions.json'})]});return;
    }
    if(id.startsWith('raffle:view:')) {
      if(item.status==='draft') {await this.respond(interaction,raffleSetup(item));return;}
      await this.respond(interaction,{content:item.message?`[View giveaway](https://discord.com/channels/${guild}/${item.channel}/${item.message})`:'Publication is incomplete. Check the channel before creating another giveaway.',embeds:[raffleEmbed(item,this.raffles.count(item.id))],files:headsUpFiles(item),components:[row(...(item.status==='drawn'?[button('raffle:winners:'+item.id,'Winner info')]:[]),button('raffle:submissions:'+item.id,'Download submissions'),button('raffle:home','My Discord giveaways'))]});return;
    }
    await this.authorizeChannel(interaction,item.channel);
    if(id.startsWith('raffle:preset-')||id.startsWith('raffle:removeimage:')) {
      if(!['draft','open'].includes(item.status))throw new SafeError('This giveaway can no longer be changed.');
      const image=id.startsWith('raffle:preset-')?await presetPrizeImage(id.split(':')[1]!.slice(7),this.service.settings.db_path):undefined;
      const latest=this.raffles.own(item.id,owner,guild);
      if(!['draft','open'].includes(latest.status))throw new SafeError('This giveaway closed while preparing the image.');
      latest.image=image;latest.revision++;this.raffles.save(latest);
      if(latest.status==='draft'){await this.respond(interaction,raffleSetup(latest));return;}
      await this.refreshRaffles();await this.respond(interaction,{content:'Prize image saved. The public giveaway card will update automatically.'});return;
    }
    if(id.startsWith('raffle:media:')&&interaction.isModalSubmit()) {
      if(!['draft','open'].includes(item.status))throw new SafeError('This giveaway can no longer be changed.');
      const image=await prepareHeadsUpImage(interaction.fields.getUploadedFiles('image')?.first(),interaction.fields.getTextInputValue('post').trim(),this.service.settings.db_path,this.notifier.screenshots,this.signal);
      const latest=this.raffles.own(item.id,owner,guild);
      if(!['draft','open'].includes(latest.status))throw new SafeError('The giveaway closed while preparing the image.');
      latest.image=image;latest.revision++;this.raffles.save(latest);
      if(latest.status==='draft'){await this.respond(interaction,raffleSetup(latest));return;}
      await this.refreshRaffles();await this.respond(interaction,{content:'Image saved. The giveaway card will update automatically.'});return;
    }
    if(id.startsWith('raffle:draw:')) {
      this.raffles.draw(item.id,{owner,guild});await this.refreshRaffles();
      await this.respond(interaction,{content:'Draw saved. The result appears on the original giveaway card; delivery retries automatically if Discord is unavailable.'});return;
    }
    if(id.startsWith('raffle:cancel:')) {
      const cancelled=this.raffles.cancel(item.id,owner,guild);await this.refreshRaffles();
      await this.respond(interaction,{content:cancelled.message?(this.raffles.get(item.id)?.deleted?'Giveaway cancelled and announcement deleted.':'Giveaway cancelled. Deleting its announcement will retry automatically.'):'Draft discarded.'});return;
    }
    if(id.startsWith('raffle:publish:')) {
      const channelId=this.service.store.subscription(guild);
      if(!channelId)throw new SafeError('Set a feed channel before publishing.');
      const channel=await this.client.channels.fetch(item.channel);
      if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==guild)throw new SafeError('The giveaway channel is unavailable.');
      const ping=await this.giveawayPing(item.channel,guild);
      const claimed=this.raffles.claim(item.id,owner,guild,channelId);
      this.assertOwner();this.signal.throwIfAborted();
      const message=await channel.send({embeds:[raffleEmbed(claimed,0)],components:raffleControls(claimed),files:headsUpFiles(claimed),...ping,nonce:claimed.id,enforceNonce:true});
      claimed.status='open';claimed.message=message.id;claimed.renderedRevision=claimed.revision;claimed.renderedControls=2;this.raffles.save(claimed);
      await this.respond(interaction,{content:`Giveaway announced in <#${claimed.channel}>. Entries ${claimed.opened!>Date.now()?'open at the scheduled start':'are open'}. [View announcement](https://discord.com/channels/${guild}/${claimed.channel}/${message.id})`});return;
    }
  }
  refreshRaffles():Promise<void> {
    if(this.raffleRefresh)return this.raffleRefresh;
    const task=this.refreshRafflesNow();this.raffleRefresh=task;
    void task.finally(()=>{if(this.raffleRefresh===task)this.raffleRefresh=undefined;}).catch(()=>{});
    return task;
  }
  private async refreshRafflesNow():Promise<void> {
    for(const candidate of this.raffles.list()) {
      this.assertOwner();this.signal.throwIfAborted();
      let item=this.raffles.get(candidate.id)!;
      if(item.status==='open'&&Date.now()>=item.ends!)item=this.raffles.draw(item.id);
      if(!item.message||!['open','drawn','cancelled'].includes(item.status)||item.deleted)continue;
      if(item.status!=='cancelled'&&item.renderedRevision===item.revision&&item.renderedControls===2)continue;
      try {
        const channel=await this.client.channels.fetch(item.channel);
        if(channel&&(channel.type!==ChannelType.GuildText||channel.guildId!==item.guild))continue;
        if(item.status==='cancelled') {
          if(channel)await channel.messages.delete(item.message);
          item.deleted=true;this.raffles.save(item);continue;
        }
        if(!channel)continue;
        await channel.messages.edit(item.message,{embeds:[raffleEmbed(item,this.raffles.count(item.id))],components:raffleControls(item),files:headsUpFiles(item),attachments:[],allowedMentions:NO_MENTIONS});
        const latest=this.raffles.get(item.id)!;
        if(latest.revision===item.revision){latest.renderedRevision=item.revision;latest.renderedControls=2;this.raffles.save(latest);}
      } catch(error) {
        if(item.status==='cancelled'&&isMissingMessage(error)){item.deleted=true;this.raffles.save(item);}
        else log('raffle_update_deferred',{error:errorCode(error)});
      }
    }
  }
  private async handleHeadsUp(interaction: RepliableInteraction, id: string): Promise<void> {
    const owner=interaction.user.id,guild=interaction.guildId!;
    if(id==='headsup'||id==='heads:home') { await this.respond(interaction,this.headsups.panel(owner,guild));return; }
    const token=id.split(':')[2];
    if(id.startsWith('heads:image:')&&interaction.isButton()) {
      const item=this.headsups.own(token!,owner,guild);
      if(!['draft','published'].includes(item.status))throw new SafeError('This heads-up can no longer be changed.');
      await this.respond(interaction,prizeImageChoices('heads',item.id));return;
    }
    if(id.startsWith('heads:upload:')&&interaction.isButton()) {
      const item=this.headsups.own(token!,owner,guild);
      if(!['draft','published'].includes(item.status))throw new SafeError('This heads-up can no longer be changed.');
      await interaction.showModal(headsUpImageModal(item));return;
    }
    if((id==='heads:new'||id.startsWith('heads:edit:'))&&interaction.isButton()) {
      const item=token?this.headsups.own(token,owner,guild):undefined;
      if(item&&!['draft','published'].includes(item.status))throw new SafeError('This heads-up cannot be edited while publishing or after cancellation.');
      await this.respond(interaction,headsUpStartChoices(item));return;
    }
    if(id.startsWith('heads:start:')&&interaction.isButton()) {
      const itemId=id.split(':')[3];
      const item=itemId?this.headsups.own(itemId,owner,guild):undefined;
      if(item&&!['draft','published'].includes(item.status))throw new SafeError('This heads-up cannot be edited while publishing or after cancellation.');
      if(!['15','60','480','720','1440','custom'].includes(token??''))throw new SafeError('Choose one of the start-time options.');
      await interaction.showModal(headsUpModal(item,token==='custom'?undefined:`in ${token}m`));return;
    }
    await interaction.deferReply({flags:MessageFlags.Ephemeral});
    const channelId=this.service.store.subscription(guild);
    if(id.startsWith('heads:preset-')||id.startsWith('heads:removeimage:')) {
      const item=this.headsups.own(token!,owner,guild);
      if(!['draft','published'].includes(item.status))throw new SafeError('This heads-up can no longer be changed.');
      await this.authorizeChannel(interaction,item.channel);
      const image=id.startsWith('heads:preset-')?await presetPrizeImage(id.split(':')[1]!.slice(7),this.service.settings.db_path):undefined;
      const latest=this.headsups.own(item.id,owner,guild);
      if(!['draft','published'].includes(latest.status))throw new SafeError('This heads-up can no longer be changed.');
      latest.image=image;latest.revision=(latest.revision??0)+1;this.headsups.save(latest);
      if(latest.status==='draft'){await this.respond(interaction,this.headsups.preview(latest));return;}
      await this.refreshHeadsUps();await this.respond(interaction,{content:'Prize image saved. The public announcement will update automatically.'});return;
    }
    if(id.startsWith('heads:media:')&&interaction.isModalSubmit()) {
      const item=this.headsups.own(token!,owner,guild);
      if(!['draft','published'].includes(item.status))throw new SafeError('This heads-up can no longer be changed.');
      await this.authorizeChannel(interaction,item.channel);
      const image=await prepareHeadsUpImage(interaction.fields.getUploadedFiles('image')?.first(),interaction.fields.getTextInputValue('post').trim(),this.service.settings.db_path,this.notifier.screenshots,this.signal);
      const latest=this.headsups.own(item.id,owner,guild);
      if(!['draft','published'].includes(latest.status))throw new SafeError('This heads-up changed while preparing the image. Reopen it to continue.');
      latest.image=image;latest.revision=(latest.revision??0)+1;this.headsups.save(latest);
      if(latest.status==='draft') {await this.respond(interaction,this.headsups.preview(latest));return;}
      await this.refreshHeadsUps();
      const saved=this.headsups.get(latest.id)!;
      await this.respond(interaction,{content:saved.renderedRevision===latest.revision?'Image updated on your announcement.':'Image saved. The public card update will retry automatically.',components:[row(button('heads:view:'+latest.id,'Manage announcement'))]});return;
    }
    if(id.startsWith('heads:form')&&interaction.isModalSubmit()) {
      const input=Object.fromEntries(['prize','start','minutes','rules','url'].map(key=>[key,interaction.fields.getTextInputValue(key)])) as unknown as HeadsUpInput;
      const old=token?this.headsups.own(token,owner,guild):undefined;
      if(!channelId&&old?.status!=='published')throw new SafeError('Set a feed channel before creating a heads-up.');
      await this.authorizeChannel(interaction,old?.status==='published'?old.channel:channelId!);
      if(old?.status==='published') {
        const updated=this.headsups.updatePublished(old.id,owner,guild,input);
        await this.refreshHeadsUps();
        const saved=this.headsups.get(updated.id)!;
        await this.respond(interaction,{content:(saved.renderedRevision===updated.revision?'Changes saved to your public announcement.':'Changes saved. The public card update is pending and will retry automatically.')+` [View announcement](https://discord.com/channels/${guild}/${updated.channel}/${updated.message})`,components:[row(button('heads:edit:'+updated.id,'Edit heads-up'),button('heads:cancel:'+updated.id,'Cancel heads-up'),button('heads:home','My heads-ups'))]});return;
      }
      const draft=this.headsups.create(input,{owner,guild,channel:channelId!,host:interaction.user.globalName??interaction.user.username},old);
      await this.respond(interaction,this.headsups.preview(draft));return;
    }
    const item=this.headsups.own(token??'',owner,guild);
    if(id.startsWith('heads:view:')) {
      if(item.status==='draft') {await this.respond(interaction,this.headsups.preview(item));return;}
      await this.respond(interaction,{content:item.message?`[View your announcement](https://discord.com/channels/${guild}/${item.channel}/${item.message})`:'Publication is incomplete. Check the feed before trying again.',embeds:[headsUpEmbed(item)],files:headsUpFiles(item),components:[row(...(item.status==='published'?[button('heads:edit:'+item.id,'Edit heads-up'),button('heads:image:'+item.id,'Image')]:[]),button('heads:cancel:'+item.id,'Cancel heads-up'),button('heads:home','My heads-ups'))]});return;
    }
    await this.authorizeChannel(interaction,item.channel);
    if(id.startsWith('heads:cancel:')) {
      if(item.status==='publishing')throw new SafeError('This heads-up is currently being sent. Try again shortly.');
      item.status='cancelled';this.headsups.save(item);await this.refreshHeadsUps();
      await this.respond(interaction,{content:item.message?(this.headsups.get(item.id)?.deleted?'Heads-up cancelled and announcement deleted.':'Heads-up cancelled. Deleting the announcement will retry automatically.'):'Draft discarded.',components:[row(button('heads:home','My heads-ups'))]});return;
    }
    if(id.startsWith('heads:publish:')) {
      if(!channelId)throw new SafeError('Set a feed channel before publishing.');
      const claimed=this.headsups.claimPublish(item.id,owner,guild,channelId);
      try {
        const channel=await this.client.channels.fetch(claimed.channel);
        if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==guild)throw new SafeError('The feed channel is unavailable.');
        this.assertOwner();this.signal.throwIfAborted();
        const ping=await this.giveawayPing(claimed.channel,guild);
        const message=await channel.send({embeds:[headsUpEmbed(claimed)],components:headsUpLinks(claimed),files:headsUpFiles(claimed),...ping,nonce:claimed.id,enforceNonce:true});
        claimed.status='published';claimed.message=message.id;claimed.rendered=headsUpPhase(claimed);claimed.renderedControls=2;this.headsups.save(claimed);
        await this.respond(interaction,{content:`Heads-up posted to <#${claimed.channel}>. [View announcement](https://discord.com/channels/${guild}/${claimed.channel}/${message.id})`,components:[row(button('heads:edit:'+claimed.id,'Edit heads-up'),button('heads:cancel:'+claimed.id,'Cancel heads-up'),button('heads:home','My heads-ups'))]});
      } catch(error) {
        if(claimed.status==='publishing'){claimed.status='draft';this.headsups.save(claimed);}
        throw error;
      }
    }
  }
  refreshHeadsUps(): Promise<void> {
    const task=this.headsRefresh.then(()=>this.refreshHeadsUpsNow());
    this.headsRefresh=task.catch(()=>{});return task;
  }
  private async refreshHeadsUpsNow(): Promise<void> {
    for(const item of this.headsups.list()) {
      if(!item.message||!['published','cancelled'].includes(item.status))continue;
      if(item.status==='cancelled') {
        if(item.deleted)continue;
        try {
          this.assertOwner();this.signal.throwIfAborted();
          const channel=await this.client.channels.fetch(item.channel);
          if(channel&&channel.type===ChannelType.GuildText&&channel.guildId===item.guild) await channel.messages.delete(item.message);
          else if(channel)continue;
          item.deleted=true;this.headsups.save(item);
        } catch(error) {
          if(isMissingMessage(error)){item.deleted=true;this.headsups.save(item);}
          else log('headsup_delete_deferred',{error:errorCode(error)});
        }
        continue;
      }
      const phase=headsUpPhase(item);
      if(item.renderedControls===2 && item.rendered===phase && (item.renderedRevision??0)===(item.revision??0))continue;
      try {
        this.assertOwner();this.signal.throwIfAborted();
        const channel=await this.client.channels.fetch(item.channel);
        if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==item.guild)continue;
        await channel.messages.edit(item.message,{embeds:[headsUpEmbed(item)],components:headsUpLinks(item),files:headsUpFiles(item),attachments:[],allowedMentions:NO_MENTIONS});
        const latest=this.headsups.get(item.id);
        if(latest&&headsUpPhase(latest)===phase&&(latest.revision??0)===(item.revision??0)){latest.rendered=phase;latest.renderedControls=2;latest.renderedRevision=item.revision??0;this.headsups.save(latest);}
      } catch(error){log('headsup_edit_deferred',{error:errorCode(error)});}
    }
  }
  async notify(): Promise<void> { await this.reactionRoles.reconcile();await this.reactionRoles.flush();await this.refreshRaffles(); await this.refreshHeadsUps(); await this.notifier.notify(); }
  async start(): Promise<void> {
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new SafeError('discord_ready_timeout')), 60000);
      this.signal.addEventListener('abort', () => { clearTimeout(timeout); reject(new SafeError('shutdown_requested')); void this.client.destroy(); }, { once: true });
      this.client.once(Events.ClientReady, () => { clearTimeout(timeout); resolve(); });
    });
    await Promise.all([this.client.login(this.service.settings.discord_token), ready]);
    const guild = await this.client.guilds.fetch(this.service.settings.discord_guild_id);
    const registered = await guild.commands.set([commands().toJSON()]);
    this.service.store.setMeta('discord_command_id', registered.first()!.id);
    this.service.store.setMeta('discord_connected', 'true');
    this.raffleTimer=setInterval(()=>{if(!this.signal.aborted){void this.refreshRaffles().catch(error=>log('raffle_timer_error',{error:errorCode(error)}));void this.reactionRoles.flush().catch(error=>log('reaction_role_error',{error:errorCode(error)}));}},5000);
    this.raffleTimer.unref();
    this.activityTimer=setInterval(()=>{if(!this.signal.aborted&&this.client.isReady()){try{this.assertOwner();this.activity.coverage();void this.activity.tick().catch(error=>log('activity_report_error',{error:errorCode(error)}));}catch(error){log('activity_report_error',{error:errorCode(error)});}}},60000);this.activityTimer.unref();
    this.activity.coverage();await this.activity.tick();
    await this.refreshRaffles();
    await this.reactionRoles.reconcile(true);
    log('discord_ready', { runtime: 'typescript', commands: registered.size });
  }
  async close(): Promise<void> { if(this.activityTimer)clearInterval(this.activityTimer);await this.activity.close();if(this.raffleTimer)clearInterval(this.raffleTimer);await this.reactionRoles.close();await this.raffleRefresh?.catch(()=>{});await this.headsRefresh.catch(()=>{});this.service.store.setMeta('discord_connected', 'false'); await this.client.destroy(); }
}
