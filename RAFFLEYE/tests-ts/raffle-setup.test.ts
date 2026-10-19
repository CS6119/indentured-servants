import { ChannelType } from 'discord.js';
import type { Interaction } from 'discord.js';
import { Bot } from '../app/bot.js';
import { Service } from '../app/service.js';
import { offlineSettings } from '../app/config.js';
import { expect,it,vi } from 'vitest';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../app/storage.js';
import { Raffles } from '../app/raffles.js';
import { prizeTitle,prizeGallery,setupPanel,setupChoices,setupModal,scheduleInput,prizeDetailsModal } from '../app/raffle-setup.js';
const now=Date.parse('2026-10-18T00:00:00Z');
const context={owner:'1',guild:'2',channel:'3',host:'Host'};
it('shows four pictured prizes and serializes amount, start, end and custom controls',async()=>{
 const store=new Store(':memory:'),repo=new Raffles(store,()=>now),directory=await mkdtemp(join(tmpdir(),'raffle-gallery-'));
 try {
 const item=repo.create({prize:'980 Lunite',minutes:'60',rules:''},context);item.prizeKind='lunite-pack';item.quantity=980;
 const gallery=await prizeGallery(item,join(directory,'db.sqlite3'));
 expect(gallery.embeds).toHaveLength(4);expect(gallery.files).toHaveLength(4);expect(gallery.embeds.every(embed=>embed.data.image?.url.startsWith('attachment://'))).toBe(true);
 for(const component of gallery.components)expect(component.toJSON().components.length).toBeLessThanOrEqual(5);
 expect(prizeTitle('lunite-pack',3280)).toBe('3,280 Lunite');expect(prizeTitle('lunite-subscription',2)).toBe('2 × Lunite Subscription');expect(()=>prizeTitle('unknown',1)).toThrow();
 for(const kind of ['amount','starts','ends'] as const)for(const row of setupChoices(item,kind).components)expect(row.toJSON().components.length).toBeLessThanOrEqual(5);
 for(const kind of ['custom','quantity','schedule'] as const)expect(setupModal(item,kind).toJSON().components?.length).toBeGreaterThan(0);
 const detail=prizeDetailsModal(item,'lunite-pack').toJSON();expect(detail.components).toHaveLength(3);expect(JSON.stringify(detail)).toContain('Description');
 const preview=setupPanel(item,now);expect(preview.embeds[0]!.data.description).toContain('STARTS');expect(preview.embeds[0]!.data.description).toContain('ENDS');
 }finally{store.close();await rm(directory,{recursive:true,force:true});}
});
it('parses start delays, durations and exact Taipei or explicit UTC dates',()=>{
 expect(scheduleInput('now','2h',now)).toMatchObject({startDelay:0,minutes:120});
 expect(scheduleInput('in 15m','3d',now)).toMatchObject({startDelay:15,minutes:4320});
 expect(scheduleInput('2026-10-18 10:00','2026-10-18 12:00',now)).toMatchObject({startAt:now+7200000,endAt:now+14400000,minutes:120});
 expect(scheduleInput('2026-10-18 10:00 UTC','1h',now).startAt).toBe(now+36000000);
 for(const [start,end] of [['yesterday','1h'],['now','0m'],['now','8d'],['in 50000m','1h'],['2026-10-18 10:00','2026-10-18 09:00']])expect(()=>scheduleInput(start!,end!,now)).toThrow();
});
it('opens only at the scheduled start and keeps relative durations anchored to publishing',()=>{
 const store=new Store(':memory:');let clock=now;const repo=new Raffles(store,()=>clock);
 try {
 const draft=repo.create({prize:'1 pass',minutes:'60',rules:''},context);draft.startDelay=15;repo.save(draft);clock+=120000;
 const item=repo.claim(draft.id,'1','2','3');expect(item.opened).toBe(clock+900000);expect(item.ends).toBe(item.opened!+3600000);item.status='open';item.message='m';repo.save(item);
 expect(()=>repo.enter(item.id,'4','2','3','m',false,false,{uid:'123',server:'Asia'})).toThrow('not opened');expect(()=>repo.draw(item.id,{owner:'1',guild:'2'})).toThrow('not started');
 clock=item.opened!;repo.enter(item.id,'4','2','3','m',false,false,{uid:'123',server:'Asia'});expect(repo.count(item.id)).toBe(1);
 clock=item.ends!;expect(()=>repo.enter(item.id,'4','2','3','m',false,false,{uid:'456',server:'Asia'})).toThrow('closed');expect(repo.draw(item.id).winner).toBe('4');
 const expired=repo.create({prize:'x',minutes:'60',rules:''},context);expired.startAt=clock-1;repo.save(expired);expect(()=>repo.claim(expired.id,'1','2','3')).toThrow('scheduled times');expect(repo.get(expired.id)?.status).toBe('draft');
 }finally{store.close();}
});

it('guides an owner through the gallery and preset controls in one private message',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'raffle-setup-')),store=new Store(':memory:'),settings=offlineSettings(join(directory,'db.sqlite3'));settings.discord_guild_id='2';store.subscribe('2','3');
 const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal),channel={type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true})};
 const make=(action:string,user='1')=>{const value={customId:'raffleye:raffle:'+action,channelId:'3',message:{id:'private',flags:{has:()=>true}},guildId:'2',user:{id:user,bot:false,username:'Host'},guild:{id:'2',channels:{fetch:async()=>channel},members:{fetch:async()=>({permissions:{has:()=>true}}),fetchMe:async()=>({})}},deferred:false,replied:false,
 isRepliable:()=>true,inGuild:()=>true,isChatInputCommand:()=>false,isMessageComponent:()=>true,isModalSubmit:()=>false,isButton:()=>true,
 deferReply:vi.fn(async()=>{value.deferred=true;}),deferUpdate:vi.fn(async()=>{value.deferred=true;}),editReply:vi.fn(),reply:vi.fn(),update:vi.fn(),showModal:vi.fn()};return value;};
 try {
 const start=make('new');await bot.handle(start as unknown as Interaction);expect(start.editReply.mock.calls[0]![0].embeds).toHaveLength(4);const draft=bot.raffles.list()[0]!;
 expect(()=>bot.raffles.claim(draft.id,'1','2','3')).toThrow('name, quantity');
 const pick=make(`choose:${draft.id}:lunite-pack`);await bot.handle(pick as unknown as Interaction);expect(pick.showModal).toHaveBeenCalledOnce();expect(pick.deferUpdate).not.toHaveBeenCalled();
 const modal=make(`setup-details:${draft.id}:lunite-pack`);modal.isButton=()=>false;modal.isMessageComponent=()=>false;modal.isModalSubmit=()=>true;Object.assign(modal,{fields:{getTextInputValue:(key:string)=>({name:'3,280 Lunite',quantity:'3',description:'Three prizes'}[key])}});await bot.handle(modal as unknown as Interaction);expect(bot.raffles.get(draft.id)).toMatchObject({prize:'3,280 Lunite',winnerCount:3,rules:'Three prizes',detailsReady:true});expect(bot.raffles.get(draft.id)?.image?.name).toContain('lunite-pack');
 for(const action of [`set-amount:${draft.id}:980`,`set-starts:${draft.id}:60`,`set-ends:${draft.id}:1440`])await bot.handle(make(action) as unknown as Interaction);
 expect(bot.raffles.get(draft.id)).toMatchObject({prize:'980 Lunite',startDelay:60,minutes:1440});
 const custom=make('schedule:'+draft.id);await bot.handle(custom as unknown as Interaction);expect(custom.showModal).toHaveBeenCalledOnce();
 await bot.handle(make(`set-amount:${draft.id}:60`,'other') as unknown as Interaction);expect(bot.raffles.get(draft.id)?.quantity).toBe(980);
 const claimed=bot.raffles.claim(draft.id,'1','2','3');expect(claimed.ends!-claimed.opened!).toBe(86400000);
 await bot.handle(make(`set-amount:${draft.id}:60`) as unknown as Interaction);expect(bot.raffles.get(draft.id)?.quantity).toBe(980);
 }finally{await bot.close();store.close();await rm(directory,{recursive:true,force:true});}
});
