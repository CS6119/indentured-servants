import { randomBytes } from 'node:crypto';
import { ActionRowBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits } from 'discord.js';
import type { Client, GuildMember, Role } from 'discord.js';
import { NO_MENTIONS } from './presentation.js';
import { isMissingMessage } from './raffles.js';
import { errorCode, log, SafeError } from './log.js';
import type { Store } from './storage.js';

export interface RolePanel {id:string;guild:string;channel:string;message:string;role:string;owner:string;active:boolean;title?:string;description?:string}
export interface RoleText {title:string;description:string}
export function roleTextDefaults(role:string):RoleText {return {title:'🎁 Want to get notified about giveaways?',description:`React with 🎁 below to get <@&${role}> and receive giveaway pings.\n\nRemove your reaction to stop receiving them.`};}
export function roleTextModal(id:string,text:RoleText):ModalBuilder {
  return new ModalBuilder().setCustomId('raffleye:roletext:'+id).setTitle('Write your role message').addComponents(
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('title').setLabel('Title').setStyle(TextInputStyle.Short).setMaxLength(256).setRequired(true).setValue(text.title)),
    new ActionRowBuilder<TextInputBuilder>().addComponents(new TextInputBuilder().setCustomId('description').setLabel('Description — emojis and Markdown supported').setStyle(TextInputStyle.Paragraph).setMaxLength(3500).setRequired(true).setValue(text.description)),
  );
}
function validateText(text:RoleText):RoleText {const title=text.title.trim(),description=text.description.trim();if(!title||title.length>256||!description||description.length>3500)throw new SafeError('Enter a title up to 256 characters and a description up to 3,500.');return {title,description};}
function roleEmbed(text:RoleText):EmbedBuilder {return new EmbedBuilder().setTitle(text.title).setDescription(text.description).setColor(0x7586fa).setFooter({text:'React 🎁 to get the role. Remove your reaction to opt out.'});}
interface RoleJob {panel:string;user:string;desired:number;version:number;pending:number;available:number;attempts:number}
export function assertOptInRole(role:Role,me:GuildMember,creator?:GuildMember):void {
  if(role.id===role.guild.id||role.managed)throw new SafeError('Choose a regular role, not @everyone or a bot-managed role.');
  if(role.permissions.bitfield!==0n)throw new SafeError('Choose a notification role with no extra permissions, such as Beggars.');
  if(!me.permissions.has(PermissionFlagsBits.ManageRoles))throw new SafeError('Enable Manage Roles for RAFFLEYE first.');
  if(me.roles.highest.comparePositionTo(role)<=0)throw new SafeError('Move RAFFLEYE above the role it should assign.');
  if(creator&&(!creator.permissions.has(PermissionFlagsBits.ManageRoles)||(creator.id!==role.guild.ownerId&&creator.roles.highest.comparePositionTo(role)<=0)))throw new SafeError('You need Manage Roles and a role above the notification role.');
}
export class RolePanels {
  constructor(readonly store:Store) {
    store.db.exec('CREATE TABLE IF NOT EXISTS role_panels(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS role_panel_members(panel TEXT NOT NULL,user TEXT NOT NULL,desired INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,pending INTEGER NOT NULL DEFAULT 1,available INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(panel,user))');
  }
  save(panel:RolePanel):void {this.store.db.prepare('INSERT INTO role_panels VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(panel.id,JSON.stringify(panel));}
  get(id:string):RolePanel|undefined {const row=this.store.db.prepare('SELECT body FROM role_panels WHERE id=?').get(id) as {body:string}|undefined;return row?JSON.parse(row.body) as RolePanel:undefined;}
  list():RolePanel[] {return (this.store.db.prepare('SELECT body FROM role_panels').all() as {body:string}[]).map(row=>JSON.parse(row.body) as RolePanel);}
  queue(panel:string,user:string,desired:boolean):void {this.store.db.prepare('INSERT INTO role_panel_members(panel,user,desired) VALUES (?,?,?) ON CONFLICT(panel,user) DO UPDATE SET desired=excluded.desired,version=role_panel_members.version+1,pending=1,available=0,attempts=0').run(panel,user,Number(desired));}
  members(panel:string):RoleJob[] {return this.store.db.prepare('SELECT * FROM role_panel_members WHERE panel=?').all(panel) as RoleJob[];}
  pending(now=Date.now()):RoleJob[] {return this.store.db.prepare('SELECT * FROM role_panel_members WHERE pending=1 AND available<=? ORDER BY available LIMIT 25').all(now) as RoleJob[];}
  complete(job:RoleJob):void {this.store.db.prepare('UPDATE role_panel_members SET pending=0,attempts=0 WHERE panel=? AND user=? AND version=?').run(job.panel,job.user,job.version);}
  retry(job:RoleJob):void {this.store.db.prepare('UPDATE role_panel_members SET attempts=attempts+1,available=? WHERE panel=? AND user=? AND version=?').run(Date.now()+Math.min(300000,5000*2**Math.min(job.attempts,6)),job.panel,job.user,job.version);}
  reconcile(panel:RolePanel,seen:Set<string>,before:RoleJob[]):void {
    if(!this.get(panel.id)?.active)return;
    const snapshots=new Map(before.map(row=>[row.user,row]));
    const current=new Map(this.members(panel.id).map(row=>[row.user,row]));
    for(const user of new Set([...seen,...snapshots.keys()])) {
      const prior=snapshots.get(user),latest=current.get(user),desired=seen.has(user);
      if(prior?.version!==latest?.version)continue; // A live reaction changed during the scan.
      if(!latest||Boolean(latest.desired)!==desired)this.queue(panel.id,user,desired);
    }
  }
}
export class ReactionRoles {
  readonly panels:RolePanels;
  private flushing?:Promise<void>;
  private scanning?:Promise<void>;
  private creating:Promise<unknown>=Promise.resolve();
  private nextScan=0;
  constructor(readonly store:Store,readonly client:Client,readonly guildId:string,readonly assertOwner:()=>void,readonly signal:AbortSignal) {this.panels=new RolePanels(store);}
  onPacket(packet:unknown):void {
    if(this.signal.aborted||!packet||typeof packet!=='object')return;
    const value=packet as {t?:string;d?:{guild_id?:string;channel_id?:string;message_id?:string;user_id?:string;emoji?:{id?:string|null;name?:string}}};
    if(!['MESSAGE_REACTION_ADD','MESSAGE_REACTION_REMOVE'].includes(value.t??''))return;
    const data=value.d;
    if(!data||data.guild_id!==this.guildId||typeof data.user_id!=='string'||data.user_id===this.client.user?.id||data.emoji?.id||data.emoji?.name!=='🎁')return;
    const panel=this.panels.list().find(item=>item.active&&item.guild===data.guild_id&&item.channel===data.channel_id&&item.message===data.message_id);
    if(!panel)return;
    try {this.assertOwner();this.panels.queue(panel.id,data.user_id,value.t==='MESSAGE_REACTION_ADD');void this.flush().catch(error=>log('reaction_role_error',{error:errorCode(error)}));}
    catch(error){log('reaction_role_error',{error:errorCode(error)});}
  }
  create(guildId:string,channelId:string,roleId:string,creatorId:string,text?:RoleText):Promise<RolePanel> {
    const work=this.creating.then(()=>this.createNow(guildId,channelId,roleId,creatorId,text));this.creating=work.catch(()=>{});return work;
  }
  private async createNow(guildId:string,channelId:string,roleId:string,creatorId:string,text?:RoleText):Promise<RolePanel> {
    this.assertOwner();this.signal.throwIfAborted();
    if(guildId!==this.guildId)throw new SafeError('Use this command in the configured server.');
    const guild=await this.client.guilds.fetch(guildId);
    const [role,me,creator,channel]=await Promise.all([guild.roles.fetch(roleId,{force:true}),guild.members.fetchMe({force:true}),guild.members.fetch({user:creatorId,force:true}),guild.channels.fetch(channelId,{force:true})]);
    if(!role)throw new SafeError('The selected role no longer exists.');
    assertOptInRole(role,me,creator);
    if(!channel||channel.type!==ChannelType.GuildText)throw new SafeError('Choose a regular text channel for the role message.');
    if(!channel.permissionsFor(creator)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages]))throw new SafeError('You need View Channel and Send Messages in that channel.');
    if(!channel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel,PermissionFlagsBits.SendMessages,PermissionFlagsBits.EmbedLinks,PermissionFlagsBits.ReadMessageHistory,PermissionFlagsBits.AddReactions]))throw new SafeError('RAFFLEYE needs View Channel, Send Messages, Embed Links, Read Message History and Add Reactions in this channel.');
    if(this.panels.list().some(item=>item.active&&item.guild===guildId&&item.role===roleId))throw new SafeError('This role already has a reaction message. Remove that panel before creating another.');
    const id=randomBytes(8).toString('hex');
    const wording=validateText(text??roleTextDefaults(role.id));
    const message=await channel.send({embeds:[roleEmbed(wording)],allowedMentions:NO_MENTIONS,flags:MessageFlags.SuppressNotifications,nonce:id,enforceNonce:true});
    const panel:RolePanel={id,guild:guildId,channel:channelId,message:message.id,role:roleId,owner:creatorId,active:true,...wording};this.panels.save(panel);
    try {await message.react('🎁');}catch(error){log('reaction_seed_deferred',{error:errorCode(error)});this.nextScan=0;}
    return panel;
  }
  async editable(messageId:string,creatorId:string):Promise<RolePanel> {
    const panel=this.panels.list().find(item=>item.active&&item.guild===this.guildId&&item.message===messageId);
    if(!panel)throw new SafeError('No active reaction-role message was found with that ID.');
    const guild=await this.client.guilds.fetch(panel.guild),member=await guild.members.fetch({user:creatorId,force:true});
    if(!member.permissions.has(PermissionFlagsBits.ManageRoles)||(creatorId!==panel.owner&&!member.permissions.has(PermissionFlagsBits.ManageGuild)))throw new SafeError('Only the creator or a server manager with Manage Roles can edit this message.');
    return panel;
  }
  async edit(messageId:string,creatorId:string,text:RoleText):Promise<RolePanel> {
    this.assertOwner();this.signal.throwIfAborted();const panel=await this.editable(messageId,creatorId),wording=validateText(text);
    const channel=await this.client.channels.fetch(panel.channel);
    if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==panel.guild)throw new SafeError('The role channel is unavailable.');
    await channel.messages.edit(panel.message,{embeds:[roleEmbed(wording)],allowedMentions:NO_MENTIONS});
    const latest=this.panels.get(panel.id)!;Object.assign(latest,wording);this.panels.save(latest);return latest;
  }
  async remove(messageId:string,creatorId:string):Promise<void> {
    this.assertOwner();this.signal.throwIfAborted();
    const panel=this.panels.list().find(item=>item.guild===this.guildId&&item.message===messageId&&item.active);
    if(!panel)throw new SafeError('No active reaction-role message was found with that ID.');
    const guild=await this.client.guilds.fetch(panel.guild),creator=await guild.members.fetch({user:creatorId,force:true});
    if(!creator.permissions.has(PermissionFlagsBits.ManageRoles)||(creator.id!==panel.owner&&!creator.permissions.has(PermissionFlagsBits.ManageGuild)))throw new SafeError('The creator or a server manager with Manage Roles can remove this panel.');
    panel.active=false;this.panels.save(panel);
    try {const channel=await guild.channels.fetch(panel.channel);if(channel?.type===ChannelType.GuildText)await channel.messages.delete(panel.message);}
    catch(error){if(!isMissingMessage(error))throw new SafeError('The panel is disabled, but its message could not be deleted. You can delete that message manually.');}
  }
  flush():Promise<void> {
    if(this.flushing)return this.flushing;
    const work=this.flushNow();this.flushing=work;void work.finally(()=>{if(this.flushing===work)this.flushing=undefined;}).catch(()=>{});return work;
  }
  private async flushNow():Promise<void> {
    for(const job of this.panels.pending()) {
      this.assertOwner();this.signal.throwIfAborted();
      const panel=this.panels.get(job.panel);
      if(!panel?.active){this.panels.complete(job);continue;}
      try {
        const guild=await this.client.guilds.fetch(panel.guild);
        const [role,me,member]=await Promise.all([guild.roles.fetch(panel.role,{force:true}),guild.members.fetchMe({force:true}),guild.members.fetch({user:job.user,force:true})]);
        if(!role)throw new SafeError('The reaction role was deleted.');
        assertOptInRole(role,me);
        if(!member.user.bot) {
          if(job.desired)await member.roles.add(role.id,'Opted in with the giveaway notification reaction');
          else await member.roles.remove(role.id,'Removed the giveaway notification reaction');
        }
        this.panels.complete(job);
      }catch(error){
        if(typeof error==='object'&&error!==null&&'code' in error&&Number(error.code)===10007)this.panels.complete(job);
        else {this.panels.retry(job);log('reaction_role_retry',{error:errorCode(error)});}
      }
    }
  }
  reconcile(force=false):Promise<void> {
    if(this.scanning)return this.scanning;
    if(!force&&Date.now()<this.nextScan)return Promise.resolve();
    this.nextScan=Date.now()+300000;
    const work=this.reconcileNow();this.scanning=work;void work.finally(()=>{if(this.scanning===work)this.scanning=undefined;}).catch(()=>{});return work;
  }
  private async reconcileNow():Promise<void> {
    for(const panel of this.panels.list().filter(item=>item.active)) {
      this.assertOwner();this.signal.throwIfAborted();
      try {
        const before=this.panels.members(panel.id),channel=await this.client.channels.fetch(panel.channel);
        if(!channel||channel.type!==ChannelType.GuildText||channel.guildId!==panel.guild)continue;
        const message=await channel.messages.fetch({message:panel.message,force:true});
        let reaction=message.reactions.cache.find(item=>item.emoji.name==='🎁'&&!item.emoji.id);
        if(!reaction)reaction=await message.react('🎁');
        const seen=new Set<string>();let after:string|undefined;
        if(reaction)while(true) {
          this.signal.throwIfAborted();
          const users=await reaction.users.fetch({limit:100,...(after?{after}:{})});
          for(const user of users.values())if(!user.bot)seen.add(user.id);
          if(users.size<100)break;after=users.lastKey();
        }
        this.panels.reconcile(panel,seen,before);
      }catch(error){
        if(isMissingMessage(error)){panel.active=false;this.panels.save(panel);}
        else log('reaction_role_scan_retry',{error:errorCode(error)});
      }
    }
    await this.flush();
  }
  async close():Promise<void> {await this.creating.catch(()=>{});await this.scanning?.catch(()=>{});await this.flushing?.catch(()=>{});}
}
