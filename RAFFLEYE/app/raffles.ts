import { activitySchema, recordParticipation } from './activity-reports.js';
import { randomBytes, randomInt } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, escapeMarkdown, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import type { HeadsUp } from './headsups.js';
import { headsUpFiles } from './headsups.js';
import { clean, compactUtc } from './presentation.js';
import { SafeError } from './log.js';
import type { Store } from './storage.js';

export interface Raffle {
  id: string; owner: string; host: string; guild: string; channel: string;
  prize: string; minutes: number; rules: string; created: number;
  status: 'draft'|'publishing'|'open'|'drawn'|'cancelled';
  opened?: number; ends?: number; message?: string; image?: HeadsUp['image'];
  winnerCount?: number; winners?: string[];
  winner?: string | null; drawnAt?: number; drawnBy?: string; entriesAtDraw?: number;
  requiresDetails?: boolean; detailsReady?: boolean;
  prizeKind?: string; quantity?: number; startAt?: number; startDelay?: number; endAt?: number;
  revision: number; renderedRevision?: number; renderedControls?: number; deleted?: boolean;
}
export interface EntryDetails {uid:string;server:string}
export function entryModal(item:Raffle,user:string,details?:EntryDetails):ModalBuilder {
  const modal=new ModalBuilder().setCustomId(`raffleye:raffle:entry:${item.id}:${user}:${item.message}`).setTitle('Enter / edit giveaway entry');
  for(const [id,label,max] of [['uid','UID',32],['server','Server',80]] as const) {
    const input=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(max);
    if(details)input.setValue(details[id]);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}
export const raffleButton=(action: string,label: string,style=ButtonStyle.Secondary)=>new ButtonBuilder().setCustomId('raffleye:raffle:'+action).setLabel(label).setStyle(style);
export function isMissingMessage(error: unknown): boolean { return typeof error==='object'&&error!==null&&'code' in error&&[10008,10003].includes(Number(error.code)); }
export function raffleModal(): ModalBuilder {
  const modal=new ModalBuilder().setCustomId('raffleye:raffle:form').setTitle('Discord-only giveaway');
  for(const [id,label,value,max,style] of [
    ['prize','Prize / giveaway title','',150,TextInputStyle.Short],
    ['minutes','Duration in minutes (1–10080)','60',5,TextInputStyle.Short],
    ['rules','Prize details (optional)','',1000,TextInputStyle.Paragraph],
  ] as const) {
    const input=new TextInputBuilder().setCustomId(id).setLabel(label).setStyle(style).setMaxLength(max).setRequired(id!=='rules');
    if(value)input.setValue(value);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
  }
  return modal;
}
export function raffleEmbed(item: Raffle,entries: number): EmbedBuilder {
  const finished=item.status==='drawn';
  const embed=new EmbedBuilder().setTitle(`${finished?'Winner drawn':'Discord giveaway'} · ${clean(item.prize,150)}`)
    .setAuthor({name:clean(item.host,100)}).setColor(finished?0x26ad81:0x7586fa);
  const shownTime=finished?item.drawnAt:item.ends;
  const endTiming=shownTime?`**${finished?'DRAWN':'ENDS'} · UTC**\n**${compactUtc(new Date(shownTime).toISOString())}**\nYour time: <t:${Math.floor(shownTime/1000)}:f>${finished?'':` (<t:${Math.floor(shownTime/1000)}:R>)`}`:`**Duration** · ${item.minutes} minutes after publishing`;
  const timing=(item.opened?`**STARTS · UTC**\n**${compactUtc(new Date(item.opened).toISOString())}**\nYour time: <t:${Math.floor(item.opened/1000)}:f> (<t:${Math.floor(item.opened/1000)}:R>)\n\n`:'')+endTiming;
  const winners=item.winners??(item.winner?[item.winner]:[]),target=item.winnerCount??1;
  const result=finished?(winners.length?`**${winners.length===1?'Winner':'Winners'}: ${winners.map(user=>`<@${user}>`).join(', ')}**${winners.length<target?`\nOnly ${winners.length} eligible entrant(s); ${winners.length} of ${target} prizes awarded.`:''}`:'**No winner — nobody entered.**'):(item.requiresDetails?'Click **Enter / edit** to submit your UID and server/region. Only you and the publisher can view these details. You can correct them until entries close. ':'Click **Enter** below. ')+`One entry per person; the publisher and bots cannot enter. ${target===1?'One winner is':`${target} distinct winners are`} chosen randomly.`;
  embed.setDescription(`${result}\n\n${timing}\n**Entries** · ${finished?item.entriesAtDraw:entries}\n${item.rules?'\n**Prize details**\n'+clean(item.rules,1200):''}`)
    .setFooter({text:finished?'Result saved. The publisher arranges prize delivery.':'Automatic draw at the deadline. The publisher may also draw early.'});
  if(item.image)embed.setImage('attachment://'+item.image.name);
  if(item.image?.source)embed.addFields({name:'Image source',value:item.image.source});
  return embed;
}
export function raffleControls(item: Raffle) {
  if(item.status==='cancelled')return [];
  if(item.status==='drawn')return [new ActionRowBuilder<ButtonBuilder>().addComponents(raffleButton('winners:'+item.id,'Winner info',ButtonStyle.Primary),raffleButton('cancel:'+item.id,'Cancel / delete',ButtonStyle.Danger))];
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    raffleButton('join:'+item.id,item.requiresDetails?'Enter / edit':'Enter',ButtonStyle.Success),raffleButton('leave:'+item.id,'Leave'),
    raffleButton('draw:'+item.id,'Draw now',ButtonStyle.Primary),raffleButton('image:'+item.id,'Image'),raffleButton('cancel:'+item.id,'Cancel',ButtonStyle.Danger),
  )];
}
export class Raffles {
  constructor(readonly store: Store,readonly clock:()=>number=Date.now,readonly choose:(count:number)=>number=randomInt) {
    activitySchema(store);
    store.db.exec('CREATE TABLE IF NOT EXISTS raffles(id TEXT PRIMARY KEY,body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS raffle_entries(raffle_id TEXT NOT NULL REFERENCES raffles(id),user_id TEXT NOT NULL,joined_at INTEGER NOT NULL,PRIMARY KEY(raffle_id,user_id)); CREATE TABLE IF NOT EXISTS raffle_entry_details(raffle_id TEXT NOT NULL,user_id TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(raffle_id,user_id))');
  }
  get(id: string): Raffle | undefined {const row=this.store.db.prepare('SELECT body FROM raffles WHERE id=?').get(id) as {body:string}|undefined;return row?JSON.parse(row.body) as Raffle:undefined;}
  save(item:Raffle):void {this.store.db.prepare('INSERT INTO raffles VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body').run(item.id,JSON.stringify(item));}
  list():Raffle[] {return (this.store.db.prepare('SELECT body FROM raffles ORDER BY rowid DESC').all() as {body:string}[]).map(row=>JSON.parse(row.body) as Raffle);}
  own(id:string,owner:string,guild:string):Raffle {const item=this.get(id);if(!item||item.owner!==owner||item.guild!==guild)throw new SafeError('Only the publisher can manage this giveaway.');return item;}
  count(id:string):number {return (this.store.db.prepare('SELECT COUNT(*) AS count FROM raffle_entries WHERE raffle_id=?').get(id) as {count:number}).count;}
  create(input:{prize:string;minutes:string;rules:string},context:Pick<Raffle,'owner'|'host'|'guild'|'channel'>):Raffle {
    const prize=input.prize.trim(),minutes=Number(input.minutes),rules=input.rules.trim();
    if(!prize||prize.length>150||rules.length>1000)throw new SafeError('Enter a prize up to 150 characters and details up to 1,000 characters.');
    if(!Number.isInteger(minutes)||minutes<1||minutes>10080)throw new SafeError('Choose a duration of 1–10080 minutes (up to seven days).');
    const item:Raffle={...context,id:randomBytes(8).toString('hex'),prize,minutes,rules,created:this.clock(),status:'draft',requiresDetails:true,revision:0};this.save(item);return item;
  }
  claim(id:string,owner:string,guild:string,channel:string):Raffle {
    return this.store.transaction(()=>{
      const item=this.own(id,owner,guild);
      if(item.status!=='draft')throw new SafeError('This giveaway was already published or is being sent.');
      if(item.detailsReady===false)throw new SafeError('Choose a prize and fill in its name, quantity and description first.');
      if(item.channel!==channel)throw new SafeError('The feed channel changed. Create a new giveaway preview.');
      if(this.clock()-item.created>600000)throw new SafeError('This preview expired. Create a new giveaway.');
      if(!Number.isInteger(item.winnerCount??1)||(item.winnerCount??1)<1||(item.winnerCount??1)>25)throw new SafeError('Choose between 1 and 25 winners.');
      const now=this.clock();
      const start=item.startAt??now+(item.startDelay??0)*60000,end=item.endAt??start+item.minutes*60000;
      if(start<now||start>now+30*86400000||end-start<60000||end-start>7*86400000)throw new SafeError('The scheduled times are no longer valid. Update the start and end before publishing.');
      item.status='publishing';item.opened=start;item.ends=end;this.save(item);return item;
    });
  }
  entry(id:string,user:string):EntryDetails|undefined {const row=this.store.db.prepare('SELECT body FROM raffle_entry_details WHERE raffle_id=? AND user_id=?').get(id,user) as {body:string}|undefined;return row?JSON.parse(row.body) as EntryDetails:undefined;}
  submissions(id:string,owner:string,guild:string) {this.own(id,owner,guild);return this.store.db.prepare('SELECT e.user_id,e.joined_at,d.body FROM raffle_entries e LEFT JOIN raffle_entry_details d ON e.raffle_id=d.raffle_id AND e.user_id=d.user_id WHERE e.raffle_id=? ORDER BY e.joined_at,e.user_id').all(id).map(raw=>{const row=raw as {user_id:string;joined_at:number;body:string|null};return {discord_user_id:row.user_id,joined_at:row.joined_at,...(row.body?JSON.parse(row.body) as EntryDetails:{})};});}
  winnerInfo(id:string,owner:string,guild:string):EmbedBuilder {
    const item=this.own(id,owner,guild);if(item.status!=='drawn')throw new SafeError('Winners have not been drawn yet.');
    const winners=item.winners??(item.winner?[item.winner]:[]);
    const embed=new EmbedBuilder().setTitle('Winner details · '+clean(item.prize,150)).setColor(0x26ad81).setFooter({text:'Private · only the giveaway publisher can open these details.'});
    if(!winners.length)embed.setDescription('No winners — nobody entered.');
    winners.forEach((user,index)=>{const details=this.entry(id,user);embed.addFields({name:`Winner ${index+1}`,value:`Member: <@${user}>\nDiscord ID: ${user}\nUID: ${details?'`'+details.uid+'`':'Not submitted'}\nServer: ${details?escapeMarkdown(details.server):'Not submitted'}`});});
    return embed;
  }
  entryContext(id:string,user:string,guild:string,channel:string,message:string,bot=false):Raffle {
    const item=this.get(id);
    if(!item||item.guild!==guild||item.channel!==channel||item.message!==message)throw new SafeError('Use the entry button on the original giveaway announcement.');
    if(item.status!=='open'||this.clock()>=item.ends!)throw new SafeError('Entries are closed for this giveaway.');
    if(this.clock()<(item.opened??0))throw new SafeError('Entries have not opened yet. Check the start time on the announcement.');
    if(user===item.owner||bot)throw new SafeError('The publisher and bots cannot enter this giveaway.');
    return item;
  }
  enter(id:string,user:string,guild:string,channel:string,message:string,bot=false,leave=false,details?:EntryDetails):boolean {
    return this.store.transaction(()=>{
      const item=this.entryContext(id,user,guild,channel,message,bot);
      if(!leave&&item.requiresDetails) {
        if(!details||!/^\d{1,32}$/.test(details.uid.trim())||!details.server.trim()||details.server.trim().length>80)throw new SafeError('Enter a numeric UID (up to 32 digits) and your server/region (up to 80 characters).');
        this.store.db.prepare('INSERT INTO raffle_entry_details VALUES (?,?,?) ON CONFLICT(raffle_id,user_id) DO UPDATE SET body=excluded.body').run(id,user,JSON.stringify({uid:details.uid.trim(),server:details.server.trim()}));
      }
      if(leave)this.store.db.prepare('DELETE FROM raffle_entry_details WHERE raffle_id=? AND user_id=?').run(id,user);
      const changed=leave?this.store.db.prepare('DELETE FROM raffle_entries WHERE raffle_id=? AND user_id=?').run(id,user).changes:
        this.store.db.prepare('INSERT OR IGNORE INTO raffle_entries VALUES (?,?,?)').run(id,user,this.clock()).changes;
      if(changed){if(!leave)recordParticipation(this.store,guild,user,message,'entry',this.clock());item.revision++;this.save(item);}return Boolean(changed);
    });
  }
  draw(id:string,manual?:{owner:string;guild:string}):Raffle {
    return this.store.transaction(()=>{
      const item=manual?this.own(id,manual.owner,manual.guild):this.get(id);
      if(!item)throw new SafeError('This giveaway is unavailable.');
      if(item.status==='drawn')return item;
      if(item.status!=='open')throw new SafeError('This giveaway is not open.');
      if(this.clock()<(item.opened??0))throw new SafeError('This giveaway has not started yet.');
      if(!manual&&this.clock()<item.ends!)throw new SafeError('The draw is not due yet.');
      const entries=this.store.db.prepare('SELECT user_id FROM raffle_entries WHERE raffle_id=? ORDER BY joined_at,user_id').all(id) as {user_id:string}[];
      const target=item.winnerCount??1;if(!Number.isInteger(target)||target<1||target>25)throw new SafeError('Choose between 1 and 25 winners.');
      const pool=[...entries],winners:string[]=[];
      while(winners.length<target&&pool.length)winners.push(pool.splice(this.choose(pool.length),1)[0]!.user_id);
      item.winners=winners;item.winner=winners[0]??null;
      item.entriesAtDraw=entries.length;item.drawnAt=this.clock();item.drawnBy=manual?.owner??'timer';item.status='drawn';item.revision++;this.save(item);return item;
    });
  }
  cancel(id:string,owner:string,guild:string):Raffle {
    const item=this.own(id,owner,guild);if(item.status==='publishing')throw new SafeError('This giveaway is being sent. Try again shortly.');
    item.status='cancelled';item.revision++;this.save(item);return item;
  }
  preview(item:Raffle) {
    return {content:`**Private preview** → <#${item.channel}>\nPublishing pings Beggars and starts the timer. One winner, one entry per person.`,embeds:[raffleEmbed(item,0)],files:headsUpFiles(item),attachments:[],components:[new ActionRowBuilder<ButtonBuilder>().addComponents(raffleButton('publish:'+item.id,'Publish giveaway',ButtonStyle.Primary),raffleButton('image:'+item.id,'Image'),raffleButton('cancel:'+item.id,'Discard'))]};
  }
  panel(owner:string,guild:string) {
    const items=this.list().filter(item=>item.owner===owner&&item.guild===guild&&item.status!=='cancelled').slice(0,4);
    return {content:'**Discord-only giveaway**\nPeople enter their UID and server/region in a private popup and can edit until entries close. One random winner is drawn at the deadline, or when you press Draw now. Results stay on the announcement.',components:[new ActionRowBuilder<ButtonBuilder>().addComponents(raffleButton('new','Create Discord giveaway',ButtonStyle.Primary)),...items.map(item=>new ActionRowBuilder<ButtonBuilder>().addComponents(raffleButton('view:'+item.id,'Manage: '+item.prize.slice(0,60))))]};
  }
}
