import {expect,it,vi} from 'vitest';
import type {Interaction} from 'discord.js';
import {ChannelType,Collection} from 'discord.js';
import {Store} from '../app/storage.js';
import {Raffles,raffleEmbed,raffleModal,entryModal,raffleControls} from '../app/raffles.js';
import {Bot} from '../app/bot.js';
import {Service} from '../app/service.js';
import {offlineSettings} from '../app/config.js';
const now=Date.parse('2026-10-18T00:00:00Z');
const input={prize:'Lunite pass',minutes:'60',rules:'One monthly pass'};
const context={owner:'1',guild:'2',channel:'3',host:'Host'};
function open(repo:Raffles) {const draft=repo.create(input,context),item=repo.claim(draft.id,'1','2','3');item.status='open';item.requiresDetails=false;item.message='message';repo.save(item);return item;}
it('validates durations and protects publication, owner and destination',()=>{
 const store=new Store(':memory:');let clock=now;const repo=new Raffles(store,()=>clock);
 try {
 expect(raffleModal().toJSON().components).toHaveLength(3);
 for(const minutes of ['0','1.5','10081','NaN'])expect(()=>repo.create({...input,minutes},context)).toThrow();
 const draft=repo.create(input,context);expect(()=>repo.claim(draft.id,'other','2','3')).toThrow();expect(()=>repo.claim(draft.id,'1','2','different')).toThrow();
 repo.claim(draft.id,'1','2','3');expect(()=>repo.claim(draft.id,'1','2','3')).toThrow();
 const old=repo.create(input,context);clock+=600001;expect(()=>repo.claim(old.id,'1','2','3')).toThrow('expired');
 }finally{store.close();}
});
it('allows one entry per user, leaving/rejoining, and rejects host, bots and mismatched messages',()=>{
 const store=new Store(':memory:'),repo=new Raffles(store,()=>now);try {
 const item=open(repo);
 expect(repo.enter(item.id,'4','2','3','message')).toBe(true);expect(repo.enter(item.id,'4','2','3','message')).toBe(false);expect(repo.count(item.id)).toBe(1);
 expect(()=>repo.enter(item.id,'1','2','3','message')).toThrow();expect(()=>repo.enter(item.id,'bot','2','3','message',true)).toThrow();
 expect(()=>repo.enter(item.id,'5','2','3','wrong')).toThrow();expect(()=>repo.enter(item.id,'5','wrong','3','message')).toThrow();
 expect(repo.enter(item.id,'4','2','3','message',false,true)).toBe(true);expect(repo.count(item.id)).toBe(0);
 expect(repo.enter(item.id,'4','2','3','message')).toBe(true);expect(new Raffles(store).count(item.id)).toBe(1);
 }finally{store.close();}
});
it('closes entries at the deadline and stores exactly one draw across retries and recreation',()=>{
 const store=new Store(':memory:');let clock=now;const choose=vi.fn(()=>1),repo=new Raffles(store,()=>clock,choose);try {
 const item=open(repo);repo.enter(item.id,'4','2','3','message');repo.enter(item.id,'5','2','3','message');
 expect(()=>repo.draw(item.id)).toThrow('not due');clock=item.ends!;
 expect(()=>repo.enter(item.id,'6','2','3','message')).toThrow('closed');expect(()=>repo.enter(item.id,'4','2','3','message',false,true)).toThrow('closed');
 const result=repo.draw(item.id);expect(result).toMatchObject({status:'drawn',winner:'5',entriesAtDraw:2,drawnBy:'timer'});expect(choose).toHaveBeenCalledWith(2);
 expect(new Raffles(store,()=>clock,()=>{throw Error('must not redraw');}).draw(item.id).winner).toBe('5');
 expect(repo.draw(item.id,{owner:'1',guild:'2'}).winner).toBe('5');expect(choose).toHaveBeenCalledOnce();
 expect(raffleEmbed(result,2).data.description).toContain('**Winner: <@5>**');
 }finally{store.close();}
});
it('supports publisher-only early draw, empty draws and cancellation',()=>{
 const store=new Store(':memory:'),choose=vi.fn(()=>0),repo=new Raffles(store,()=>now,choose);try {
 const item=open(repo);expect(()=>repo.draw(item.id,{owner:'other',guild:'2'})).toThrow();expect(()=>repo.cancel(item.id,'other','2')).toThrow();
 const empty=repo.draw(item.id,{owner:'1',guild:'2'});expect(empty.winner).toBeNull();expect(choose).not.toHaveBeenCalled();expect(raffleEmbed(empty,0).data.description).toContain('nobody entered');
 const cancelled=open(repo);repo.enter(cancelled.id,'4','2','3','message');repo.cancel(cancelled.id,'1','2');expect(()=>repo.draw(cancelled.id,{owner:'1',guild:'2'})).toThrow();expect(()=>repo.enter(cancelled.id,'5','2','3','message')).toThrow();
 }finally{store.close();}
});
it('publishes a Discord raffle, handles entrants, persists the draw despite delivery failure and deletes on cancel',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='2';store.subscribe('2','3');
 const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal);
 const item=bot.raffles.create(input,context),send=vi.fn(async()=>({id:'message'})),edit=vi.fn(async()=>({id:'message'})),remove=vi.fn(async()=>{});
 vi.spyOn(bot.client.channels,'fetch').mockResolvedValue({type:ChannelType.GuildText,guildId:'2',send,messages:{edit,delete:remove}} as never);
 vi.spyOn(bot,'giveawayPing').mockResolvedValue({content:'<@&beggars>',allowedMentions:{parse:[],roles:['beggars'],users:[],repliedUser:false}});
 item.requiresDetails=false;bot.raffles.save(item);
 const channel={type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true})};
 function interaction(action:string,user='1') {
  const value={customId:'raffleye:raffle:'+action+':'+item.id,channelId:'3',message:{id:'message',flags:{has:()=>false}},guildId:'2',user:{id:user,bot:false},guild:{id:'2',channels:{fetch:async()=>channel},members:{fetch:async()=>({permissions:{has:()=>true}}),fetchMe:async()=>({})}},deferred:false,replied:false,
   isRepliable:()=>true,inGuild:()=>true,isChatInputCommand:()=>false,isMessageComponent:()=>true,isModalSubmit:()=>false,isButton:()=>true,
   deferReply:vi.fn(async()=>{value.deferred=true;}),editReply:vi.fn(),reply:vi.fn()};return value;
 }
 try {
 await bot.handle(interaction('publish') as unknown as Interaction);expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0]![0]).toMatchObject({content:'<@&beggars>',allowedMentions:{parse:[],roles:['beggars']}});
 await bot.handle(interaction('join','4') as unknown as Interaction);await bot.handle(interaction('join','4') as unknown as Interaction);expect(bot.raffles.count(item.id)).toBe(1);
 await bot.handle(interaction('draw','4') as unknown as Interaction);await bot.handle(interaction('cancel','4') as unknown as Interaction);expect(bot.raffles.get(item.id)?.status).toBe('open');
 edit.mockRejectedValueOnce(new Error('Discord temporary outage'));
 await bot.handle(interaction('draw') as unknown as Interaction);expect(bot.raffles.get(item.id)).toMatchObject({status:'drawn',winner:'4'});
 await bot.refreshRaffles();expect(bot.raffles.get(item.id)?.renderedRevision).toBe(bot.raffles.get(item.id)?.revision);
 await bot.handle(interaction('draw') as unknown as Interaction);expect(bot.raffles.get(item.id)?.winner).toBe('4');expect(send).toHaveBeenCalledOnce();
 await bot.handle(interaction('cancel') as unknown as Interaction);expect(remove).toHaveBeenCalledWith('message');expect(bot.raffles.get(item.id)?.deleted).toBe(true);
 }finally{await bot.close();store.close();}
});
it('automatically draws expired raffles after startup/recreation and retries deletion',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='2';
 const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal);
 const item=open(bot.raffles);bot.raffles.enter(item.id,'4','2','3','message');const expired=bot.raffles.get(item.id)!;expired.ends=Date.now()-1;bot.raffles.save(expired);
 const edit=vi.fn(async()=>({id:'message'})),remove=vi.fn().mockRejectedValueOnce(new Error('temporary')).mockRejectedValueOnce({code:10008});
 vi.spyOn(bot.client.channels,'fetch').mockResolvedValue({type:ChannelType.GuildText,guildId:'2',messages:{edit,delete:remove}} as never);
 try {
 await bot.refreshRaffles();expect(bot.raffles.get(item.id)).toMatchObject({winner:'4',drawnBy:'timer'});
 bot.raffles.cancel(item.id,'1','2');await bot.refreshRaffles();expect(bot.raffles.get(item.id)?.deleted).not.toBe(true);
 await bot.refreshRaffles();expect(bot.raffles.get(item.id)?.deleted).toBe(true);await bot.refreshRaffles();expect(remove).toHaveBeenCalledTimes(2);
 }finally{await bot.close();store.close();}
});

it('saves private UID/server edits as one entry and rejects stale, forged and closed forms',()=>{
 const store=new Store(':memory:');let clock=now;const repo=new Raffles(store,()=>clock);try {
 const item=open(repo);item.requiresDetails=true;repo.save(item);
 const form=entryModal(item,'4').toJSON();expect(form.components).toHaveLength(2);expect(JSON.stringify(form.components[0])).toContain('UID');expect(JSON.stringify(form.components[1])).toContain('Server');
 expect(()=>repo.enter(item.id,'4','2','3','message')).toThrow('numeric UID');
 repo.enter(item.id,'4','2','3','message',false,false,{uid:'00123',server:'Asia'});
 repo.enter(item.id,'4','2','3','message',false,false,{uid:'00456',server:'Europe'});
 expect(repo.count(item.id)).toBe(1);expect(new Raffles(store).entry(item.id,'4')).toEqual({uid:'00456',server:'Europe'});
 expect(repo.entry(item.id,'5')).toBeUndefined();expect(()=>repo.submissions(item.id,'4','2')).toThrow();
 expect(repo.submissions(item.id,'1','2')[0]).toMatchObject({uid:'00456',server:'Europe'});
 expect(raffleEmbed(item,1).data.description).not.toContain('00456');
 expect(()=>repo.enter(item.id,'4','2','3','forged',false,false,{uid:'7',server:'Asia'})).toThrow();
 expect(()=>repo.enter(item.id,'4','2','3','message',false,false,{uid:'bad',server:'Asia'})).toThrow();
 expect(repo.entry(item.id,'4')?.uid).toBe('00456');
 repo.enter(item.id,'4','2','3','message',false,true);expect(repo.entry(item.id,'4')).toBeUndefined();
 repo.enter(item.id,'4','2','3','message',false,false,{uid:'7',server:'Asia'});clock=item.ends!;
 expect(()=>repo.enter(item.id,'4','2','3','message',false,false,{uid:'8',server:'Asia'})).toThrow('closed');
 expect(repo.entry(item.id,'4')?.uid).toBe('7');
 }finally{store.close();}
});

it('opens a prefilled private popup and binds submissions to the entrant and original message',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='2';
 const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal),item=open(bot.raffles);item.requiresDetails=true;bot.raffles.save(item);
 vi.spyOn(bot,'refreshRaffles').mockResolvedValue();
 const make=(action:string,user='4',modal=false)=>{
 const value={customId:'raffleye:raffle:'+action,channelId:'3',message:{id:'message',flags:{has:()=>false}},guildId:'2',guild:{id:'2'},user:{id:user,bot:false},deferred:false,replied:false,
 isRepliable:()=>true,inGuild:()=>true,isChatInputCommand:()=>false,isMessageComponent:()=>!modal,isModalSubmit:()=>modal,isButton:()=>!modal,
 fields:{getTextInputValue:(id:string)=>id==='uid'?'000123':'Asia'},showModal:vi.fn(),deferReply:vi.fn(async()=>{value.deferred=true;}),editReply:vi.fn(),reply:vi.fn()};return value;};
 try {
 const join=make('join:'+item.id);await bot.handle(join as unknown as Interaction);expect(join.showModal).toHaveBeenCalledOnce();expect(join.deferReply).not.toHaveBeenCalled();expect(bot.raffles.count(item.id)).toBe(0);
 const submit=make(`entry:${item.id}:4:message`,'4',true);await bot.handle(submit as unknown as Interaction);expect(bot.raffles.count(item.id)).toBe(1);expect(submit.deferReply).toHaveBeenCalledWith({flags:64});
 const again=make('join:'+item.id);await bot.handle(again as unknown as Interaction);expect(JSON.stringify(again.showModal.mock.calls[0])).toContain('000123');
 const forged=make(`entry:${item.id}:4:message`,'5',true);await bot.handle(forged as unknown as Interaction);expect(bot.raffles.entry(item.id,'5')).toBeUndefined();
 const denied=make('submissions:'+item.id);await bot.handle(denied as unknown as Interaction);expect(JSON.stringify(denied.editReply.mock.calls)).not.toContain('000123');
 const download=make('submissions:'+item.id,'1');await bot.handle(download as unknown as Interaction);expect(download.editReply.mock.calls[0]![0].files).toHaveLength(1);
 bot.raffles.draw(item.id,{owner:'1',guild:'2'});const info=make('winners:'+item.id,'1');await bot.handle(info as unknown as Interaction);expect(info.deferReply).toHaveBeenCalledWith({flags:64});expect(JSON.stringify(info.editReply.mock.calls)).toContain('000123');
 const forbidden=make('winners:'+item.id,'4');await bot.handle(forbidden as unknown as Interaction);expect(JSON.stringify(forbidden.editReply.mock.calls)).not.toContain('000123');
 }finally{await bot.close();store.close();}
});

it('limits new announcement pings to the unique Beggars role and validates mention permission',async()=>{
 const store=new Store(':memory:'),bot=new Bot(new Service(store,offlineSettings(':memory:')),()=>{},new AbortController().signal);
 const role={id:'role',name:'Beggars',managed:false,mentionable:true},roles=new Collection([['role',role]]);
 const guild={roles:{fetch:async()=>roles},channels:{fetch:async()=>({permissionsFor:()=>({has:()=>false})})},members:{fetchMe:async()=>({})}};
 vi.spyOn(bot.client.guilds,'fetch').mockResolvedValue(guild as never);
 try {
 expect(await bot.giveawayPing('channel','guild')).toEqual({content:'<@&role>',allowedMentions:{parse:[],roles:['role'],users:[],repliedUser:false}});
 role.mentionable=false;await expect(bot.giveawayPing('channel','guild')).rejects.toThrow('Allow mentioning');
 role.mentionable=true;roles.set('duplicate',{...role,id:'duplicate'});await expect(bot.giveawayPing('channel','guild')).rejects.toThrow('exactly one');
 }finally{await bot.close();store.close();}
});

it('draws three distinct winners, saves them before delivery and reuses the complete result',()=>{
 const store=new Store(':memory:'),choose=vi.fn((_count:number)=>0),repo=new Raffles(store,()=>now,choose);try {
 const item=open(repo);item.winnerCount=3;repo.save(item);
 for(const user of ['4','5','6','7'])repo.enter(item.id,user,'2','3','message');
 const result=repo.draw(item.id,{owner:'1',guild:'2'});expect(result.winners).toEqual(['4','5','6']);expect(result.entriesAtDraw).toBe(4);expect(choose.mock.calls.map(call=>call[0])).toEqual([4,3,2]);
 expect(new Raffles(store,()=>now,()=>{throw Error('redraw');}).draw(item.id).winners).toEqual(['4','5','6']);expect(raffleEmbed(result,4).data.description).toContain('**Winners: <@4>, <@5>, <@6>**');
 const small=open(repo);small.winnerCount=3;repo.save(small);repo.enter(small.id,'4','2','3','message');const partial=repo.draw(small.id,{owner:'1',guild:'2'});expect(partial.winners).toEqual(['4']);expect(raffleEmbed(partial,1).data.description).toContain('1 of 3 prizes awarded');
 const bad=repo.create(input,context);bad.winnerCount=0;repo.save(bad);expect(()=>repo.claim(bad.id,'1','2','3')).toThrow('1 and 25');
 }finally{store.close();}
});

it('shows each winner UID/server only to the publisher and keeps public results free of entry details',()=>{
 const store=new Store(':memory:'),repo=new Raffles(store,()=>now,()=>0);try {
 const item=open(repo);item.requiresDetails=true;item.winnerCount=3;repo.save(item);
 for(const user of ['4','5','6'])repo.enter(item.id,user,'2','3','message',false,false,{uid:'12345678'+user,server:'Asia'});
 expect(()=>repo.winnerInfo(item.id,'1','2')).toThrow('not been drawn');
 const drawn=repo.draw(item.id,{owner:'1',guild:'2'}),privateCard=repo.winnerInfo(item.id,'1','2').toJSON();
 expect(privateCard.fields).toHaveLength(3);expect(privateCard.fields![0]!.value).toContain('123456784');expect(privateCard.fields![0]!.value).toContain('Asia');
 expect(()=>repo.winnerInfo(item.id,'other','2')).toThrow();expect(()=>repo.winnerInfo(item.id,'1','other')).toThrow();
 expect(JSON.stringify(raffleEmbed(drawn,3))).not.toContain('123456784');expect(JSON.stringify(raffleControls(drawn))).toContain('Winner info');
 }finally{store.close();}
});
