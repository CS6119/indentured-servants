import {expect,it,vi} from 'vitest';
import type {Interaction} from 'discord.js';
import {MessageFlags,ChannelType} from 'discord.js';
import {HeadsUps,parseHeadsUp,headsUpPhase,headsUpEmbed,headsUpModal,headsUpStartInput,headsUpStartChoices,headsUpImageModal} from '../app/headsups.js';
import {Store} from '../app/storage.js';
import {Bot} from '../app/bot.js';
import {Service} from '../app/service.js';
import {offlineSettings} from '../app/config.js';
const now=Date.parse('2026-10-18T00:00:00Z');
const input={prize:'Lunite pass',start:'in 15m',minutes:'10',rules:'Reply with your UID',url:'https://x.com/host'};
const context={owner:'1',guild:'2',channel:'3',host:'Host'};
it('supports quick relative starts and explicit/default Taipei times',()=>{
 expect(parseHeadsUp(input,now).start).toBe('2026-10-18T00:15:00.000Z');
 expect(parseHeadsUp({...input,start:'2026-10-18 20:00'},now).start).toBe('2026-10-18T12:00:00.000Z');
 expect(parseHeadsUp({...input,start:'2026-10-18 20:00 JST'},now).start).toBe('2026-10-18T11:00:00.000Z');
});
it.each([{start:'yesterday'},{start:'2026-10-17 20:00 UTC'},{minutes:'0'},{minutes:'1.5'},{url:'javascript:alert(1)'},{prize:''},{rules:''}])('rejects invalid heads-ups %j',patch=>expect(()=>parseHeadsUp({...input,...patch},now)).toThrow());
it('requires ownership, fresh previews, matching destination and one publish claim',()=>{
 let clock=now;const store=new Store(':memory:'),repo=new HeadsUps(store,()=>clock);
 try{
 const item=repo.create(input,context);
 expect(()=>repo.own(item.id,'other','2')).toThrow();expect(()=>repo.own(item.id,'1','other')).toThrow();
 expect(()=>repo.claimPublish(item.id,'1','2','different')).toThrow();
 expect(repo.claimPublish(item.id,'1','2','3').status).toBe('publishing');expect(()=>repo.claimPublish(item.id,'1','2','3')).toThrow();
 const expired=repo.create(input,context);clock+=600001;expect(()=>repo.claimPublish(expired.id,'1','2','3')).toThrow();
 }finally{store.close();}
});
it('keeps records across repository recreation and renders scheduled phases and cancellation',()=>{
 const store=new Store(':memory:');try{
 const repo=new HeadsUps(store,()=>now),item=repo.create(input,context);
 expect(new HeadsUps(store).get(item.id)?.prize).toBe(input.prize);
 expect(headsUpPhase(item,now)).toContain('Heads-up');expect(headsUpPhase(item,now+15*60000)).toBe('Scheduled start reached');expect(headsUpPhase(item,now+25*60000)).toBe('Ended');
 item.status='cancelled';expect(headsUpEmbed(item,now).data.title).toContain('Cancelled');
 expect(headsUpModal(item).toJSON().components).toHaveLength(5);
 }finally{store.close();}
});
it('publishes only after preview, pings only the notification role, prevents duplicates and deletes on cancellation',async()=>{
 const store=new Store(':memory:'),settings=offlineSettings(':memory:');settings.discord_guild_id='2';store.subscribe('2','3');
 const bot=new Bot(new Service(store,settings),()=>{},new AbortController().signal);
 vi.spyOn(bot,'giveawayPing').mockResolvedValue({content:'<@&beggars>',allowedMentions:{parse:[],roles:['beggars'],users:[],repliedUser:false}});
 const item=bot.headsups.create(input,context),send=vi.fn(async()=>({id:'message'})),edit=vi.fn(async()=>({id:'message'})),remove=vi.fn(async()=>{});
 vi.spyOn(bot.client.channels,'fetch').mockResolvedValue({type:ChannelType.GuildText,guildId:'2',send,messages:{edit,delete:remove}} as never);
 const channel={type:ChannelType.GuildText,permissionsFor:()=>({has:()=>true})};
 const interaction={customId:'raffleye:heads:publish:'+item.id,guildId:'2',user:{id:'1'},guild:{id:'2',channels:{fetch:async()=>channel},members:{fetch:async()=>({permissions:{has:()=>true}}),fetchMe:async()=>({})}},deferred:false,replied:false,
 isRepliable:()=>true,inGuild:()=>true,isChatInputCommand:()=>false,isMessageComponent:()=>true,isModalSubmit:()=>false,isButton:()=>true,
 deferReply:vi.fn(async()=>{interaction.deferred=true;}),editReply:vi.fn(),reply:vi.fn()};
 try{
 expect(send).not.toHaveBeenCalled();await bot.handle(interaction as unknown as Interaction);
 expect(send).toHaveBeenCalledOnce();expect(send.mock.calls[0]![0]).toMatchObject({content:'<@&beggars>',allowedMentions:{parse:[],roles:['beggars']}});
 expect(bot.headsups.get(item.id)?.status).toBe('published');
 expect(JSON.stringify(send.mock.calls[0]![0].components)).toContain('raffleye:heads:edit:'+item.id);
 expect(JSON.stringify(send.mock.calls[0]![0].components)).toContain('raffleye:heads:cancel:'+item.id);
 expect(JSON.stringify(send.mock.calls[0]![0].components)).toContain('raffleye:heads:image:'+item.id);
 const publicClick={...interaction,deferred:false,customId:'raffleye:heads:edit:'+item.id,message:{flags:{has:()=>false}},reply:vi.fn(),showModal:vi.fn()};
 await bot.handle(publicClick as unknown as Interaction);
 expect(publicClick.reply).toHaveBeenCalledWith(expect.objectContaining({flags:MessageFlags.Ephemeral,content:expect.stringContaining('When should it start?')}));
 publicClick.reply.mockClear();
 await bot.handle({...publicClick,user:{id:'other'}} as unknown as Interaction);
 expect(publicClick.reply).toHaveBeenCalledWith(expect.objectContaining({flags:MessageFlags.Ephemeral,content:expect.stringContaining('belongs to another user')}));
 expect(publicClick.showModal).not.toHaveBeenCalled();
 await bot.handle({...publicClick,customId:'raffleye:heads:upload:'+item.id} as unknown as Interaction);
 expect(publicClick.showModal).toHaveBeenCalledOnce();
 publicClick.showModal.mockClear();
 await bot.handle({...publicClick,customId:'raffleye:heads:upload:'+item.id,user:{id:'other'}} as unknown as Interaction);
 expect(publicClick.showModal).not.toHaveBeenCalled();
 await bot.handle({...publicClick,deferred:true,customId:'raffleye:heads:cancel:'+item.id,user:{id:'other'}} as unknown as Interaction);
 expect(bot.headsups.get(item.id)?.status).toBe('published');
 const legacy=bot.headsups.get(item.id)!;delete legacy.renderedControls;bot.headsups.save(legacy);
 await bot.refreshHeadsUps();expect(edit).toHaveBeenCalledOnce();
 expect(JSON.stringify(edit.mock.calls[0]![1].components)).toContain('raffleye:heads:edit:'+item.id);
 edit.mockClear();
 await bot.handle(interaction as unknown as Interaction);expect(send).toHaveBeenCalledOnce();
 const form={...interaction,customId:'raffleye:heads:form:'+item.id,isModalSubmit:()=>true,fields:{getTextInputValue:(key:string)=>({...input,prize:'Updated prize',rules:'Updated rules',start:'in 30m'} as Record<string,string>)[key]!}};
 await bot.handle(form as unknown as Interaction);
 expect(send).toHaveBeenCalledOnce();expect(edit).toHaveBeenCalledOnce();
 expect(edit.mock.calls[0]![0]).toBe('message');expect(edit.mock.calls[0]![1].embeds[0].data.title).toContain('Updated prize');
 expect(bot.headsups.get(item.id)?.renderedRevision).toBe(1);
 edit.mockClear();
 vi.spyOn(bot.notifier.screenshots,'getById').mockResolvedValue('test-prize.png');
 const mediaForm={...interaction,customId:'raffleye:heads:media:'+item.id,isModalSubmit:()=>true,fields:{getUploadedFiles:()=>null,getTextInputValue:()=> 'https://x.com/host/status/123'}};
 await bot.handle(mediaForm as unknown as Interaction);
 expect(bot.headsups.get(item.id)?.image?.name).toBe('headsup-post-123.png');
 expect(edit).toHaveBeenCalledOnce();expect(edit.mock.calls[0]![1].files).toHaveLength(1);
 expect(edit.mock.calls[0]![1].embeds[0].data.image?.url).toBe('attachment://headsup-post-123.png');
 expect(send).toHaveBeenCalledOnce();edit.mockClear();
 interaction.customId='raffleye:heads:cancel:'+item.id;await bot.handle(interaction as unknown as Interaction);
 expect(bot.headsups.get(item.id)).toMatchObject({status:'cancelled',deleted:true});expect(edit).not.toHaveBeenCalled();expect(remove).toHaveBeenCalledWith('message');
 await bot.refreshHeadsUps();expect(remove).toHaveBeenCalledOnce();
 }finally{await bot.client.destroy();store.close();}
});

it('edits published details without losing identity and preserves unchanged past starts',()=>{
 let clock=now+123;const store=new Store(':memory:'),repo=new HeadsUps(store,()=>clock);
 try {
 const item=repo.create(input,context);item.status='published';item.message='original';repo.save(item);
 clock+=3600000;
 const updated=repo.updatePublished(item.id,'1','2',{...input,start:headsUpStartInput(item.start),prize:'New prize',rules:'New entry details'});
 expect(updated).toMatchObject({id:item.id,message:'original',status:'published',channel:'3',start:item.start,prize:'New prize',rules:'New entry details',revision:1});
 expect(()=>repo.updatePublished(item.id,'other','2',input)).toThrow();
 expect(()=>repo.updatePublished(item.id,'1','2',{...input,start:'2026-10-17 20:00 UTC'})).toThrow();
 const rescheduled=repo.updatePublished(item.id,'1','2',{...input,start:'in 30m',minutes:'20'});
 expect(Date.parse(rescheduled.start)).toBe(clock+1800000);
 expect(headsUpEmbed(rescheduled,clock).data.description?.match(/:R>/g)).toHaveLength(2);
 rescheduled.status='cancelled';repo.save(rescheduled);expect(()=>repo.updatePublished(item.id,'1','2',input)).toThrow();
 }finally{store.close();}
});

it('offers all five delay presets and custom time for new and published heads-ups',()=>{
 const store=new Store(':memory:');try {
 const repo=new HeadsUps(store,()=>now),item=repo.create(input,context);
 const choices=headsUpStartChoices(item).components[0]!.toJSON().components;
 expect(choices.map(button=>'custom_id' in button?button.custom_id:'')).toEqual(['15','60','480','720','1440'].map(delay=>'raffleye:heads:start:'+delay+':'+item.id));
 for(const delay of [15,60,480,720,1440]) expect(Date.parse(parseHeadsUp({...input,start:`in ${delay}m`},now).start)).toBe(now+delay*60000);
 expect(JSON.stringify(headsUpModal(item,'in 480m').toJSON())).toContain('in 480m');
 expect(headsUpStartChoices().components).toHaveLength(2);
 }finally{store.close();}
});

it('makes UTC prominent and accepts an image upload modal without losing draft media on edit',()=>{
 const store=new Store(':memory:');try {
 const repo=new HeadsUps(store,()=>now),item=repo.create(input,context);
 const modal=headsUpImageModal(item).toJSON();expect(modal.components).toHaveLength(2);
 item.image={path:'image.png',name:'prize.png'};repo.save(item);
 const edited=repo.create({...input,prize:'Updated'},context,item);
 const embed=headsUpEmbed(edited,now).toJSON();
 expect(embed.description).toContain('**START · UTC**');expect(embed.description).toContain('**END · UTC**');
 expect(embed.image?.url).toBe('attachment://prize.png');expect(edited.image).toEqual(item.image);
 }finally{store.close();}
});
