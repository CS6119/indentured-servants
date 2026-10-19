import { createHash } from 'node:crypto';
import { AttachmentBuilder } from 'discord.js';
import type { MessageCreateOptions } from 'discord.js';
import { NO_MENTIONS } from './presentation.js';
import { SafeError,log,errorCode } from './log.js';
import type { Store } from './storage.js';

export const REPORT_PERIOD=30*86400000;
export interface ActivityConfig {guild:string;recipient:string;enabled:boolean;started:number;periodStart:number;next:number;minimum:number;retryAt?:number;lastSent?:number;lastError?:string}
export function activitySchema(store:Store):void {store.db.exec(`
CREATE TABLE IF NOT EXISTS activity_messages(id TEXT PRIMARY KEY,guild TEXT NOT NULL,user TEXT NOT NULL,channel TEXT NOT NULL,at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS activity_messages_period ON activity_messages(guild,at);
CREATE TABLE IF NOT EXISTS activity_participation(guild TEXT NOT NULL,user TEXT NOT NULL,message TEXT NOT NULL,kind TEXT NOT NULL,at INTEGER NOT NULL,PRIMARY KEY(guild,user,message,kind));
CREATE TABLE IF NOT EXISTS activity_coverage(guild TEXT NOT NULL,minute INTEGER NOT NULL,PRIMARY KEY(guild,minute));
CREATE TABLE IF NOT EXISTS activity_reports(id TEXT PRIMARY KEY,guild TEXT NOT NULL,recipient TEXT NOT NULL,body TEXT NOT NULL,message TEXT);
`);}
export function recordParticipation(store:Store,guild:string,user:string,message:string,kind:'entry'|'reaction',at=Date.now()):void {
  const config=store.metaJson<ActivityConfig|null>('activity:'+guild,null);
  if(!config?.enabled||at<config.started)return;
  store.db.prepare('INSERT OR IGNORE INTO activity_participation VALUES (?,?,?,?,?)').run(guild,user,message,kind,at);
}
export class ActivityReports {
  private running?:Promise<void>;
  constructor(readonly store:Store,readonly guild:string,readonly send:(recipient:string,payload:MessageCreateOptions)=>Promise<{id:string}>,readonly clock:()=>number=Date.now) {activitySchema(store);}
  config():ActivityConfig|null {return this.store.metaJson<ActivityConfig|null>('activity:'+this.guild,null);}
  save(config:ActivityConfig):void {this.store.setMeta('activity:'+this.guild,JSON.stringify(config));}
  enable(recipient:string,minimum=3):ActivityConfig {
    const old=this.config();if(old&&old.recipient!==recipient)throw new SafeError('Reports are linked to another account. That recipient must disable them first.');
    if(!Number.isInteger(minimum)||minimum<1||minimum>100)throw new SafeError('Choose a minimum of 1–100 giveaways.');
    if(old?.enabled){old.minimum=minimum;this.save(old);return old;}
    const now=this.clock(),config={guild:this.guild,recipient,enabled:true,started:now,periodStart:now,next:now+REPORT_PERIOD,minimum};this.save(config);return config;
  }
  disable(recipient:string):void {const config=this.config();if(!config)return;if(config.recipient!==recipient)throw new SafeError('Only the report recipient can disable their reports.');this.store.setMeta('activity:'+this.guild,JSON.stringify({...config,enabled:false}));}
  message(input:{id:string;guild:string;user:string;channel:string;at:number;bot:boolean;webhook:boolean;excluded:boolean}):void {
    const config=this.config();if(!config?.enabled||input.guild!==this.guild||input.bot||input.webhook||input.excluded||input.at<config.started||input.at>this.clock()+60000)return;
    this.store.db.prepare('INSERT OR IGNORE INTO activity_messages VALUES (?,?,?,?,?)').run(input.id,input.guild,input.user,input.channel,input.at);
  }
  coverage():void {
    if(this.config()?.enabled)this.store.db.prepare('INSERT OR IGNORE INTO activity_coverage VALUES (?,?)').run(this.guild,Math.floor(this.clock()/60000));
    const key='activity-pruned:'+this.guild;if(Number(this.store.meta(key,'0'))>this.clock()-86400000)return;
    const cutoff=this.clock()-90*86400000;
    this.store.transaction(()=>{
      this.store.db.prepare('DELETE FROM activity_messages WHERE guild=? AND at<?').run(this.guild,cutoff);
      this.store.db.prepare('DELETE FROM activity_participation WHERE guild=? AND at<?').run(this.guild,cutoff);
      this.store.db.prepare('DELETE FROM activity_coverage WHERE guild=? AND minute<?').run(this.guild,Math.floor(cutoff/60000));
      this.store.db.prepare('DELETE FROM activity_reports WHERE guild=? AND message IS NOT NULL AND rowid NOT IN (SELECT rowid FROM activity_reports WHERE guild=? ORDER BY rowid DESC LIMIT 3)').run(this.guild,this.guild);
      this.store.setMeta(key,this.clock());
    });
  }
  report(start:number,end:number,minimum:number) {
    const participation=this.store.db.prepare('SELECT user,message,kind FROM activity_participation WHERE guild=? AND at>=? AND at<?').all(this.guild,start,end) as {user:string;message:string;kind:string}[];
    const users=new Map<string,{entries:Set<string>;reactions:Set<string>}>();
    for(const row of participation){const item=users.get(row.user)??{entries:new Set<string>(),reactions:new Set<string>()};(row.kind==='entry'?item.entries:item.reactions).add(row.message);users.set(row.user,item);}
    const chat=new Map((this.store.db.prepare("SELECT user,COUNT(*) AS messages,COUNT(DISTINCT strftime('%Y-%m-%d',at/1000,'unixepoch')) AS days,MAX(at) AS last FROM activity_messages WHERE guild=? AND at>=? AND at<? GROUP BY user").all(this.guild,start,end) as {user:string;messages:number;days:number;last:number}[]).map(row=>[row.user,row]));
    const rows=[...users].map(([user,value])=>{const activity=chat.get(user),giveaways=new Set([...value.entries,...value.reactions]).size;return {discord_user_id:user,giveaways,raffle_entries:value.entries.size,giveaway_reactions:value.reactions.size,chat_messages:activity?.messages??0,chat_days:activity?.days??0,last_chat:activity?new Date(activity.last).toISOString():null,flag:giveaways>=minimum&&!activity?.messages,low_chat:giveaways>=minimum&&(activity?.messages??0)>0&&(activity?.messages??0)<=2};}).sort((a,b)=>Number(b.flag)-Number(a.flag)||Number(b.low_chat)-Number(a.low_chat)||b.giveaways-a.giveaways||a.chat_messages-b.chat_messages);
    const observed=(this.store.db.prepare('SELECT COUNT(*) AS count FROM activity_coverage WHERE guild=? AND minute>=? AND minute<?').get(this.guild,Math.floor(start/60000),Math.ceil(end/60000)) as {count:number}).count;
    return {period_start:new Date(start).toISOString(),period_end:new Date(end).toISOString(),minimum_giveaways:minimum,observed_minutes:observed,coverage_percent:Math.min(100,Math.round(observed/Math.max(1,(end-start)/60000)*100)),rows};
  }
  payload(report:ReturnType<ActivityReports['report']>) {
    const flags=report.rows.filter(row=>row.flag),limited=report.rows.filter(row=>row.low_chat),lines=[...flags,...limited].slice(0,10).map(row=>`• <@${row.discord_user_id}> — ${row.raffle_entries} entries, ${row.giveaway_reactions} reacted posts, ${row.chat_messages} chat messages across ${row.chat_days} days`);
    return {content:`**RAFFLEYE · private activity report**\n${report.period_start.slice(0,10)} → ${report.period_end.slice(0,10)} (UTC)\n${report.rows.length} giveaway participants · ${flags.length} with no chat and ${limited.length} with only 1–2 messages observed, each across ≥${report.minimum_giveaways} giveaway posts.\n\n${lines.join('\n')||'No participants meet the review threshold.'}\n\nObserved gateway coverage: ${report.coverage_percent}%. Gaps and inaccessible channels are not counted. For personal review only; counts cannot judge friendship or conversation quality. No automatic disqualification.\nEntries include later withdrawals. Reactions count 🎁/🎉 on giveaway-channel posts, excluding role menus; they are not verified entries. Chat excludes giveaway channels and their threads, bots and webhooks. Voice, reading, DMs and external X participation are not measured. Full counts are attached.`,allowedMentions:NO_MENTIONS,files:[new AttachmentBuilder(Buffer.from(JSON.stringify(report,null,2)),{name:'giveaway-activity.json'})]};
  }
  preview(recipient:string) {const config=this.config();if(!config||config.recipient!==recipient)throw new SafeError('Enable reports for your account first.');return this.payload(this.report(config.periodStart,this.clock(),config.minimum));}
  tick():Promise<void> {if(this.running)return this.running;const work=this.tickNow();this.running=work;void work.finally(()=>{if(this.running===work)this.running=undefined;}).catch(()=>{});return work;}
  private async tickNow():Promise<void> {
    const config=this.config();if(!config?.enabled||this.clock()<config.next||this.clock()<(config.retryAt??0))return;
    const id=createHash('sha256').update(`${this.guild}:${config.recipient}:${config.periodStart}:${config.next}`).digest('hex').slice(0,24);
    let saved=this.store.db.prepare('SELECT body,message FROM activity_reports WHERE id=?').get(id) as {body:string;message:string|null}|undefined;
    if(!saved){const body=JSON.stringify(this.report(config.periodStart,config.next,config.minimum));this.store.db.prepare('INSERT INTO activity_reports VALUES (?,?,?,?,NULL)').run(id,this.guild,config.recipient,body);saved={body,message:null};}
    try {
      if(!saved.message){const message=await this.send(config.recipient,{...this.payload(JSON.parse(saved.body) as ReturnType<ActivityReports['report']>),nonce:id,enforceNonce:true});this.store.db.prepare('UPDATE activity_reports SET message=? WHERE id=?').run(message.id,id);}
      const latest=this.config();if(!latest||latest.recipient!==config.recipient||latest.periodStart!==config.periodStart)return;
      latest.periodStart=config.next;latest.next=config.next+REPORT_PERIOD;latest.lastSent=this.clock();latest.retryAt=undefined;latest.lastError=undefined;this.save(latest);
    }catch(error){const latest=this.config();if(latest&&latest.recipient===config.recipient&&latest.periodStart===config.periodStart){latest.retryAt=this.clock()+3600000;latest.lastError=errorCode(error);this.save(latest);}log('activity_dm_deferred',{error:errorCode(error)});}
  }
  async close():Promise<void>{await this.running;}
}
