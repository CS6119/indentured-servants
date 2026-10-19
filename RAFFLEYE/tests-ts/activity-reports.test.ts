import { expect,it,vi } from 'vitest';
import { Store } from '../app/storage.js';
import { ActivityReports,REPORT_PERIOD,recordParticipation } from '../app/activity-reports.js';
import { Raffles } from '../app/raffles.js';
import { Bot } from '../app/bot.js';
import { Service } from '../app/service.js';
import { offlineSettings } from '../app/config.js';
import type { Interaction } from 'discord.js';
const now=Date.parse('2026-10-18T00:00:00Z');
function message(id:string,user='u',at=now+1000){return {id,user,guild:'g',channel:'chat',at,bot:false,webhook:false,excluded:false};}
it('collects only enabled, human, in-scope metadata and deduplicates messages',()=>{
 const store=new Store(':memory:'),activity=new ActivityReports(store,'g',vi.fn(),()=>now+2000);
 try {
 activity.message(message('before'));expect(store.db.prepare('SELECT * FROM activity_messages').all()).toHaveLength(0);
 activity.enable('owner');activity.message(message('one','u',now+2100));activity.message(message('one','u',now+2100));
 for(const patch of [{bot:true},{webhook:true},{excluded:true},{guild:'other'},{at:now-1}])activity.message({...message('excluded'),...patch});
 expect(store.db.prepare('SELECT * FROM activity_messages').all()).toHaveLength(1);activity.disable('owner');activity.message(message('after','u',now+2100));expect(store.db.prepare('SELECT * FROM activity_messages').all()).toHaveLength(1);
 }finally{store.close();}
});
it('reports distinct giveaways, separate reaction counts and chat days without accusing motives',()=>{
 const store=new Store(':memory:'),activity=new ActivityReports(store,'g',vi.fn(),()=>now);activity.enable('owner');
 try {
 for(const user of ['quiet','chatty'])for(const id of ['a','b','c']){recordParticipation(store,'g',user,id,'entry',now+100);recordParticipation(store,'g',user,id,'reaction',now+100);recordParticipation(store,'g',user,id,'reaction',now+200);}
 activity.message(message('chat','chatty'));activity.coverage();
 const report=activity.report(now,now+60000,3);expect(report.rows[0]).toMatchObject({discord_user_id:'quiet',giveaways:3,raffle_entries:3,giveaway_reactions:3,chat_messages:0,flag:true});
 expect(report.rows[1]).toMatchObject({discord_user_id:'chatty',chat_messages:1,chat_days:1,flag:false,low_chat:true});expect(report.coverage_percent).toBe(100);
 const payload=activity.payload(report);expect(payload.allowedMentions.parse).toEqual([]);expect(payload.content).toContain('personal review only');expect(payload.content.length).toBeLessThan(2000);expect(()=>activity.preview('other')).toThrow();
 }finally{store.close();}
});
it('delivers after 30 days, retries failed DMs with a saved report, and does not repeat success after restart',async()=>{
 const store=new Store(':memory:');let clock=now;const send=vi.fn().mockRejectedValueOnce(new Error('DM blocked')).mockResolvedValue({id:'dm'}),activity=new ActivityReports(store,'g',send,()=>clock);activity.enable('owner');
 try {
 recordParticipation(store,'g','u','a','entry',now+100);await activity.tick();expect(send).not.toHaveBeenCalled();clock+=REPORT_PERIOD;await Promise.all([activity.tick(),activity.tick()]);expect(send).toHaveBeenCalledOnce();expect(activity.config()?.lastError).toBeTruthy();
 await activity.tick();expect(send).toHaveBeenCalledOnce();clock+=3600000;await activity.tick();expect(send).toHaveBeenCalledTimes(2);expect(send.mock.calls[1]![1].nonce).toBe(send.mock.calls[0]![1].nonce);expect(activity.config()?.lastSent).toBe(clock);
 await new ActivityReports(store,'g',send,()=>clock).tick();expect(send).toHaveBeenCalledTimes(2);expect(activity.config()?.next).toBe(now+2*REPORT_PERIOD);
 }finally{store.close();}
});
it('does not send disabled reports and prunes expired metadata even when disabled',async()=>{
 const store=new Store(':memory:');let clock=now;const send=vi.fn(),activity=new ActivityReports(store,'g',send,()=>clock);activity.enable('owner');
 try {
 activity.message(message('one'));recordParticipation(store,'g','u','a','entry',now);activity.coverage();expect(()=>activity.disable('other')).toThrow();activity.disable('owner');clock+=91*86400000;activity.coverage();await activity.tick();expect(send).not.toHaveBeenCalled();expect(store.db.prepare('SELECT * FROM activity_messages').all()).toHaveLength(0);expect(store.db.prepare('SELECT * FROM activity_participation').all()).toHaveLength(0);
 }finally{store.close();}
});
it('records one participation across entry corrections, leaving and rejoining',()=>{
 const store=new Store(':memory:'),activity=new ActivityReports(store,'g',vi.fn(),()=>now),repo=new Raffles(store,()=>now+100);activity.enable('owner');
 try {
 const item=repo.create({prize:'test',minutes:'60',rules:''},{owner:'owner',guild:'g',channel:'feed',host:'Host'});const opened=repo.claim(item.id,'owner','g','feed');opened.status='open';opened.message='m';repo.save(opened);
 for(const uid of ['123','456'])repo.enter(item.id,'u','g','feed','m',false,false,{uid,server:'Asia'});
 repo.enter(item.id,'u','g','feed','m',false,true);repo.enter(item.id,'u','g','feed','m',false,false,{uid:'456',server:'Asia'});
 expect(activity.report(now,now+1000,1).rows[0]?.raffle_entries).toBe(1);
 }finally{store.close();}
});
it('excludes opt-in role reactions, bots, other emojis and other channels',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='g';store.subscribe('g','feed');const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal);bot.activity.enable('owner');
 bot.reactionRoles.panels.save({id:'p',guild:'g',channel:'feed',message:'role-menu',role:'role',owner:'owner',active:true});
 const packet=(message_id:string,channel_id='feed',name='🎉',isBot=false)=>({t:'MESSAGE_REACTION_ADD',d:{guild_id:'g',channel_id,message_id,user_id:'u',emoji:{name},member:{user:{bot:isBot}}}});
 try {
 for(const value of [packet('role-menu'),packet('bot','feed','🎉',true),packet('chat','chat'),packet('other','feed','👍'),packet('giveaway'),packet('giveaway')])await bot.recordGiveawayReaction(value);
 expect(store.db.prepare('SELECT * FROM activity_participation').all()).toHaveLength(1);
 }finally{await bot.close();store.close();}
});
it('requires Manage Server, verifies DM delivery and binds reports to the slash-command caller',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='g';const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal);
 let allowed=false;const send=vi.fn().mockRejectedValueOnce(new Error('DM closed')).mockResolvedValue({id:'confirm'});
 const make=()=>{const value={guildId:'g',guild:{members:{fetch:async()=>({permissions:{has:()=>allowed}})}},user:{id:'owner',send},commandName:'raffleye',deferred:false,replied:false,options:{getSubcommand:()=> 'activity-report',getString:()=> 'enable',getInteger:()=>3},isRepliable:()=>true,inGuild:()=>true,isChatInputCommand:()=>true,isMessageComponent:()=>false,isModalSubmit:()=>false,isButton:()=>false,deferReply:vi.fn(async()=>{value.deferred=true;}),editReply:vi.fn(),reply:vi.fn()};return value;};
 try {
 await bot.handle(make() as unknown as Interaction);expect(bot.activity.config()).toBeNull();expect(send).not.toHaveBeenCalled();
 allowed=true;await bot.handle(make() as unknown as Interaction);expect(bot.activity.config()).toBeNull();
 await bot.handle(make() as unknown as Interaction);expect(bot.activity.config()).toMatchObject({enabled:true,recipient:'owner',minimum:3});expect(send).toHaveBeenCalledTimes(2);
 }finally{await bot.close();store.close();}
});
