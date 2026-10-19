import { randomBytes } from 'node:crypto';
import { AttachmentBuilder, FileUploadBuilder, LabelBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { explicitTimes } from './timeparse.js';
import { clean, compactUtc, serverClocks } from './presentation.js';
import { safeUrl } from './models.js';
import { SafeError } from './log.js';
import type { Store } from './storage.js';

export interface HeadsUp {
  id: string; owner: string; host: string; guild: string; channel: string;
  prize: string; start: string; minutes: number; rules: string; url: string;
  created: number; status: 'draft' | 'publishing' | 'published' | 'cancelled';
  image?: { path: string; name: string; source?: string };
  message?: string; deleted?: boolean; rendered?: string; revision?: number; renderedRevision?: number; renderedControls?: number;
}
export interface HeadsUpInput { prize: string; start: string; minutes: string; rules: string; url: string }
export function parseHeadsUp(input: HeadsUpInput, now = Date.now(), unchangedStart?: string) {
  const prize = input.prize.trim(), rules = input.rules.trim(), url = input.url.trim();
  if (!prize || prize.length > 150 || !rules || rules.length > 1000) throw new SafeError('Enter a prize (up to 150 characters) and entry details (up to 1,000).');
  const minutes = Number(input.minutes);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new SafeError('Duration must be 1–1440 minutes.');
  if (url && (!safeUrl(url) || !url.startsWith('https://') || url.length > 500)) throw new SafeError('Use an HTTPS entry link, or leave it blank.');
  const relative = /^in\s+(\d+)\s*(?:m|min|minutes?)$/i.exec(input.start.trim());
  let epoch: number;
  if (relative) epoch = now + Number(relative[1]) * 60000;
  else {
    let text = input.start.trim();
    if (/^\d{4}-\d{2}-\d{2}\s+\d{1,2}:\d{2}$/.test(text)) text += ' UTC+8';
    const matches = explicitTimes(text);
    if (matches.length !== 1) throw new SafeError('Use “in 15m” or a full date such as 2026-10-18 20:00 UTC+8. Plain YYYY-MM-DD HH:mm uses Taipei time (UTC+8).');
    epoch = matches[0]!.epoch;
  }
  const unchanged = unchangedStart && input.start.trim() === headsUpStartInput(unchangedStart);
  if (unchanged) epoch = Date.parse(unchangedStart);
  if (!unchanged && (epoch <= now + 30000 || epoch > now + 30 * 86400000)) throw new SafeError('Choose a start at least 30 seconds ahead and within 30 days.');
  return { prize, rules, url, minutes, start: new Date(epoch).toISOString() };
}
export function headsUpPhase(item: HeadsUp, now = Date.now()): string {
  if (item.status === 'cancelled') return 'Cancelled';
  if (now >= Date.parse(item.start) + item.minutes * 60000) return 'Ended';
  return now >= Date.parse(item.start) ? 'Scheduled start reached' : 'Heads-up';
}
export function headsUpEmbed(item: HeadsUp, now = Date.now()): EmbedBuilder {
  const phase = headsUpPhase(item, now), end = new Date(Date.parse(item.start) + item.minutes * 60000).toISOString();
  const embed = new EmbedBuilder().setTitle(`${phase} · ${clean(item.prize, 160)}`).setColor(phase === 'Ended' || phase === 'Cancelled' ? 0x808080 : 0x7586fa)
    .setAuthor({ name: clean(item.host, 100) })
    .setDescription(`**START · UTC**\n**${compactUtc(item.start)}**\n**END · UTC**\n**${compactUtc(end)}**\n\n**Your local time**\nStarts <t:${Math.floor(Date.parse(item.start)/1000)}:f>${item.status !== 'cancelled' ? ` (<t:${Math.floor(Date.parse(item.start)/1000)}:R>)` : ''}\nEnds <t:${Math.floor(Date.parse(end)/1000)}:f>${item.status !== 'cancelled' ? ` (<t:${Math.floor(Date.parse(end)/1000)}:R>)` : ''}\n\n**Duration** · ${item.minutes} minutes\n**To enter** · ${clean(item.rules, 1200)}`)
    .addFields({name:'Start in other timezones',value:serverClocks(item.start).join('\n')})
    .setFooter({ text: 'Host-created heads-up. Follow the host’s entry instructions. No automatic entry.' });
  if(item.image) embed.setImage('attachment://'+item.image.name);
  if(item.image?.source) embed.addFields({name:'Image source',value:item.image.source});
  return embed;
}
const btn = (id: string, label: string, style = ButtonStyle.Secondary) => new ButtonBuilder().setCustomId('raffleye:heads:' + id).setLabel(label).setStyle(style);
export function headsUpLinks(item: HeadsUp): ActionRowBuilder<ButtonBuilder>[] {
  const buttons: ButtonBuilder[] = [];
  if (item.url) buttons.push(new ButtonBuilder().setLabel('Giveaway / entry link ↗').setStyle(ButtonStyle.Link).setURL(item.url));
  if (item.status === 'published' || item.status === 'publishing') buttons.push(btn('edit:'+item.id,'Edit heads-up'),btn('image:'+item.id,'Image'),btn('cancel:'+item.id,'Cancel heads-up',ButtonStyle.Danger));
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(...buttons)] : [];
}
export function headsUpFiles(item: Pick<HeadsUp,'image'>): AttachmentBuilder[] { return item.image ? [new AttachmentBuilder(item.image.path,{name:item.image.name})] : []; }
export function headsUpImageModal(item: Pick<HeadsUp,'id'>): ModalBuilder {
  return new ModalBuilder().setCustomId('raffleye:heads:media:'+item.id).setTitle('Heads-up image')
    .addLabelComponents(
      new LabelBuilder().setLabel('Upload a prize picture (PNG, JPG, GIF, WebP)').setDescription('Choose one image up to 8 MB, OR paste an X post below.').setFileUploadComponent(new FileUploadBuilder().setCustomId('image').setMinValues(0).setMaxValues(1).setRequired(false)),
      new LabelBuilder().setLabel('Published X post URL (optional)').setDescription('Captures the public post. Scheduled posts must be live first.').setTextInputComponent(new TextInputBuilder().setCustomId('post').setStyle(TextInputStyle.Short).setMaxLength(500).setRequired(false)),
    );
}
export function headsUpStartInput(start: string): string { return start.slice(0,19).replace('T',' ')+' UTC'; }
export function headsUpModal(item?: HeadsUp, startOverride?: string): ModalBuilder {
  const modal = new ModalBuilder().setCustomId('raffleye:heads:form' + (item ? ':' + item.id : '')).setTitle(item?.status === 'published' ? 'Edit published heads-up' : 'Heads-up giveaway');
  const fields: [string,string,string,number,boolean,TextInputStyle][] = [
    ['prize','Prize / giveaway title',item?.prize ?? '',150,true,TextInputStyle.Short],
    ['start','Start: in 15m, or YYYY-MM-DD HH:mm UTC+8',startOverride ?? (item ? headsUpStartInput(item.start) : 'in 15m'),80,true,TextInputStyle.Short],
    ['minutes','Duration in minutes',String(item?.minutes ?? 10),4,true,TextInputStyle.Short],
    ['rules','Entry details / where to participate',item?.rules ?? '',1000,true,TextInputStyle.Paragraph],
    ['url','Entry link (optional, HTTPS)',item?.url ?? '',500,false,TextInputStyle.Short],
  ];
  for (const [id,label,value,max,required,style] of fields) {
    const field = new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(required);
    if(value) field.setValue(value);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(field));
  }
  return modal;
}
export function headsUpStartChoices(item?: HeadsUp) {
  const suffix = item ? ':'+item.id : '';
  return { content: '**When should it start?** Choose a time from now, then review the prize and entry details. The delay is measured when you submit the form.', embeds: [], components: [
    new ActionRowBuilder<ButtonBuilder>().addComponents(...([['15','15 minutes later'],['60','1 hour later'],['480','8 hours later'],['720','12 hours later'],['1440','24 hours later']] as const).map(([minutes,label])=>btn('start:'+minutes+suffix,label))),
    new ActionRowBuilder<ButtonBuilder>().addComponents(btn('start:custom'+suffix,item ? 'Keep time / custom time' : 'Custom time'),btn('home','My heads-ups')),
  ] };
}
export class HeadsUps {
  constructor(readonly store: Store, readonly clock: () => number = Date.now) {
    store.db.exec('CREATE TABLE IF NOT EXISTS headsups(id TEXT PRIMARY KEY, body TEXT NOT NULL)');
  }
  get(id: string): HeadsUp | undefined { const row = this.store.db.prepare('SELECT body FROM headsups WHERE id=?').get(id) as {body:string}|undefined; return row ? JSON.parse(row.body) as HeadsUp : undefined; }
  save(item: HeadsUp): void { this.store.db.prepare('INSERT OR REPLACE INTO headsups VALUES (?,?)').run(item.id,JSON.stringify(item)); }
  own(id: string, owner: string, guild: string): HeadsUp {
    const item = this.get(id);
    if (!item || item.owner !== owner || item.guild !== guild) throw new SafeError('This heads-up belongs to another user or is no longer available.');
    return item;
  }
  create(input: HeadsUpInput, context: Pick<HeadsUp,'owner'|'host'|'guild'|'channel'>, existing?: HeadsUp): HeadsUp {
    if(existing && existing.status !== 'draft') throw new SafeError('Only an unpublished draft can be edited.');
    const item: HeadsUp = { ...context, ...parseHeadsUp(input,this.clock()), id:existing?.id ?? randomBytes(8).toString('hex'), created:this.clock(), status:'draft', ...(existing?.image ? {image:existing.image} : {}) };
    this.save(item); return item;
  }
  updatePublished(id: string, owner: string, guild: string, input: HeadsUpInput): HeadsUp {
    const item = this.own(id, owner, guild);
    if (item.status !== 'published' || !item.message) throw new SafeError('Only published heads-ups can be updated.');
    Object.assign(item, parseHeadsUp(input, this.clock(), item.start));
    item.revision = (item.revision ?? 0) + 1;
    this.save(item); return item;
  }
  list(): HeadsUp[] { return (this.store.db.prepare('SELECT body FROM headsups ORDER BY rowid DESC').all() as {body:string}[]).map(row=>JSON.parse(row.body) as HeadsUp); }
  claimPublish(id: string, owner: string, guild: string, channel: string): HeadsUp {
    return this.store.transaction(()=>{
      const item=this.own(id,owner,guild);
      if(item.status !== 'draft') throw new SafeError('This heads-up was already published, cancelled, or is being sent.');
      if(item.channel!==channel) throw new SafeError('The feed channel changed. Create a fresh preview before publishing.');
      if(this.clock()-item.created>600000 || Date.parse(item.start)<=this.clock()) throw new SafeError('This preview expired or its start time passed. Edit it before publishing.');
      item.status='publishing';this.save(item);return item;
    });
  }
  preview(item: HeadsUp) {
    return { content:`**Private preview** → <#${item.channel}>\nPublish posts this heads-up immediately and pings Beggars. Plain dates use Taipei (UTC+8).`, embeds:[headsUpEmbed(item,this.clock())], files:headsUpFiles(item), attachments:[], components:[new ActionRowBuilder<ButtonBuilder>().addComponents(btn('publish:'+item.id,'Publish heads-up',ButtonStyle.Primary),btn('edit:'+item.id,'Edit'),btn('image:'+item.id,'Image'),btn('cancel:'+item.id,'Discard'))] };
  }
  panel(owner: string,guild: string) {
    const items=this.list().filter(item=>item.owner===owner&&item.guild===guild&&item.status!=='cancelled').slice(0,4);
    return { content:'**Existing announcements**\nManage your announcement-only posts below. To collect participant UID and server, choose Create giveaway.', embeds:[], components:[new ActionRowBuilder<ButtonBuilder>().addComponents(new ButtonBuilder().setCustomId('raffleye:raffle:new').setLabel('Create giveaway (UID + server)').setStyle(ButtonStyle.Primary),new ButtonBuilder().setCustomId('raffleye:home').setLabel('Dashboard').setStyle(ButtonStyle.Secondary)),...items.map(item=>new ActionRowBuilder<ButtonBuilder>().addComponents(btn('view:'+item.id,(item.status==='draft'?'Draft: ':'Manage: ')+item.prize.slice(0,60))))] };
  }
}
