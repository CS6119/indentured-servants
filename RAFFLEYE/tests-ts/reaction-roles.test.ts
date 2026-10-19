import {expect,it,vi} from 'vitest';
import {ChannelType,Client,Collection,GatewayIntentBits,MessageFlags,PermissionFlagsBits,PermissionsBitField} from 'discord.js';
import type {GuildMember,Role} from 'discord.js';
import {Store} from '../app/storage.js';
import {assertOptInRole,ReactionRoles,RolePanels,roleTextModal} from '../app/reaction-roles.js';

function fixture() {
 const store=new Store(':memory:'),client=new Client({intents:[GatewayIntentBits.Guilds,GatewayIntentBits.GuildMessageReactions]});
 const controller=new ReactionRoles(store,client,'2',()=>{},new AbortController().signal);
 const role={id:'reward',managed:false,permissions:new PermissionsBitField(),guild:{id:'2',ownerId:'owner'}};
 const me={id:'bot',permissions:new PermissionsBitField(PermissionFlagsBits.ManageRoles),roles:{highest:{comparePositionTo:()=>1}}};
 const creator={...me,id:'owner'},add=vi.fn(async()=>{}),remove=vi.fn(async()=>{});
 const member={id:'user',user:{bot:false},roles:{add,remove}};
 const users=vi.fn(async()=>new Collection([['user',{id:'user',bot:false}]]));
 const reaction={emoji:{id:null,name:'🎁'},users:{fetch:users}};
 const message={id:'message',react:vi.fn(async()=>reaction),reactions:{cache:new Collection([['🎁',reaction]])}};
 const send=vi.fn(async()=>message),deleteMessage=vi.fn(async()=>{}),editMessage=vi.fn(async()=>message);
 const channel={type:ChannelType.GuildText,guildId:'2',permissionsFor:()=>({has:()=>true}),send,messages:{fetch:vi.fn(async()=>message),delete:deleteMessage,edit:editMessage}};
 const guild={id:'2',roles:{fetch:vi.fn(async()=>role)},members:{fetchMe:vi.fn(async()=>me),fetch:vi.fn(async(value:unknown)=>((typeof value==='string'?value:(value as {user:string}).user)==='owner')?creator:member)},channels:{fetch:vi.fn(async()=>channel)}};
 vi.spyOn(client.guilds,'fetch').mockResolvedValue(guild as never);vi.spyOn(client.channels,'fetch').mockResolvedValue(channel as never);
 const panel={id:'panel',guild:'2',channel:'3',message:'message',role:'reward',owner:'owner',active:true};
 const packet=(t:string,user='user',emoji='🎁')=>({t,d:{guild_id:'2',channel_id:'3',message_id:'message',user_id:user,emoji:{id:null,name:emoji}}});
 return {store,client,controller,role,me,creator,member,add,remove,users,message,send,deleteMessage,editMessage,channel,guild,panel,packet,close:async()=>{await controller.close();await client.destroy();store.close();}};
}
it('restricts opt-in roles to manageable notification roles without elevated permissions',()=>{
 const role={id:'reward',guild:{id:'2',ownerId:'owner'},managed:false,permissions:new PermissionsBitField()};
 const me={id:'bot',permissions:new PermissionsBitField(PermissionFlagsBits.ManageRoles),roles:{highest:{comparePositionTo:()=>1}}};
 const creator={...me,id:'owner'};
 expect(()=>assertOptInRole(role as Role,me as unknown as GuildMember,creator as unknown as GuildMember)).not.toThrow();
 expect(()=>assertOptInRole({...role,id:'2'} as Role,me as unknown as GuildMember)).toThrow();
 expect(()=>assertOptInRole({...role,managed:true} as Role,me as unknown as GuildMember)).toThrow();
 expect(()=>assertOptInRole({...role,permissions:new PermissionsBitField(PermissionFlagsBits.Administrator)} as Role,me as unknown as GuildMember)).toThrow('no extra permissions');
 expect(()=>assertOptInRole(role as Role,{...me,permissions:new PermissionsBitField()} as unknown as GuildMember)).toThrow('Enable Manage Roles');
 expect(()=>assertOptInRole(role as Role,{...me,roles:{highest:{comparePositionTo:()=>0}}} as unknown as GuildMember)).toThrow('above');
 expect(()=>assertOptInRole(role as Role,me as unknown as GuildMember,{...creator,id:'other',roles:{highest:{comparePositionTo:()=>0}}} as unknown as GuildMember)).toThrow('You need Manage Roles');
});
it('posts a silent reaction panel, seeds its emoji, persists it and rejects duplicate panels',async()=>{
 const f=fixture();try {
 const panel=await f.controller.create('2','3','reward','owner');
 expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0]![0]).toMatchObject({flags:MessageFlags.SuppressNotifications,allowedMentions:{parse:[]}});
 expect(f.message.react).toHaveBeenCalledWith('🎁');expect(new RolePanels(f.store).get(panel.id)?.message).toBe('message');
 await expect(f.controller.create('2','3','reward','owner')).rejects.toThrow('already has');expect(f.send).toHaveBeenCalledOnce();
 }finally{await f.close();}
});
it('refuses setup before sending when the bot lacks Manage Roles',async()=>{
 const f=fixture();try {
 f.me.permissions=new PermissionsBitField();await expect(f.controller.create('2','3','reward','owner')).rejects.toThrow('Enable Manage Roles');expect(f.send).not.toHaveBeenCalled();
 }finally{await f.close();}
});
it('handles uncached reaction events: add gives only the mapped role and remove takes it away',async()=>{
 const f=fixture();try {
 f.controller.panels.save(f.panel);
 f.controller.onPacket(f.packet('MESSAGE_REACTION_ADD'));await f.controller.flush();expect(f.add).toHaveBeenCalledWith('reward',expect.any(String));expect(f.remove).not.toHaveBeenCalled();
 f.controller.onPacket(f.packet('MESSAGE_REACTION_REMOVE'));await f.controller.flush();expect(f.remove).toHaveBeenCalledWith('reward',expect.any(String));
 expect(f.controller.panels.pending()).toHaveLength(0);
 f.controller.onPacket(f.packet('MESSAGE_REACTION_ADD','user','🔥'));f.controller.onPacket({...f.packet('MESSAGE_REACTION_ADD'),d:{...f.packet('MESSAGE_REACTION_ADD').d,message_id:'unrelated'}});await f.controller.flush();expect(f.add).toHaveBeenCalledOnce();
 }finally{await f.close();}
});
it('ignores bots and rechecks role safety when processing reactions',async()=>{
 const f=fixture();try {
 f.controller.panels.save(f.panel);f.member.user.bot=true;f.controller.onPacket(f.packet('MESSAGE_REACTION_ADD'));await f.controller.flush();expect(f.add).not.toHaveBeenCalled();
 f.member.user.bot=false;f.role.permissions=new PermissionsBitField(PermissionFlagsBits.ManageRoles);f.controller.onPacket(f.packet('MESSAGE_REACTION_ADD'));await f.controller.flush();expect(f.add).not.toHaveBeenCalled();expect(f.controller.panels.members('panel')[0]?.pending).toBe(1);
 }finally{await f.close();}
});
it('retains a newer opt-out when an earlier opt-in completes late',()=>{
 const store=new Store(':memory:');try {
 const panels=new RolePanels(store);panels.queue('panel','user',true);const old=panels.pending()[0]!;panels.queue('panel','user',false);panels.complete(old);
 expect(panels.pending()).toMatchObject([{desired:0,version:2}]);expect(new RolePanels(store).pending()).toHaveLength(1);
 }finally{store.close();}
});
it('reconciles offline changes from the actual reaction list without overwriting newer live events',async()=>{
 const f=fixture();try {
 f.controller.panels.save(f.panel);f.controller.panels.queue('panel','gone',true);f.controller.panels.complete(f.controller.panels.pending()[0]!);
 await f.controller.reconcile(true);expect(f.add).toHaveBeenCalledWith('reward',expect.any(String));expect(f.remove).toHaveBeenCalledWith('reward',expect.any(String));
 const before=f.controller.panels.members('panel');f.controller.panels.queue('panel','user',false);f.controller.panels.reconcile(f.panel,new Set(['user']),before);
 expect(f.controller.panels.members('panel').find(row=>row.user==='user')?.desired).toBe(0);
 }finally{await f.close();}
});
it('removes a panel without removing existing member roles',async()=>{
 const f=fixture();try {
 f.controller.panels.save(f.panel);await f.controller.remove('message','owner');expect(f.deleteMessage).toHaveBeenCalledWith('message');expect(f.controller.panels.get('panel')?.active).toBe(false);
 f.controller.onPacket(f.packet('MESSAGE_REACTION_ADD'));await f.controller.flush();expect(f.add).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();
 }finally{await f.close();}
});

it('publishes custom multiline wording and edits the same message while preserving reactions',async()=>{
 const f=fixture();try {
 const text={title:'🎁 Beggars club',description:'**Free stuff!**\nReact below.\n- Giveaway pings'};
 expect(roleTextModal('new:reward:3',text).toJSON().components).toHaveLength(2);
 const panel=await f.controller.create('2','3','reward','owner',text);
 expect(f.send.mock.calls[0]![0].embeds[0].data.description).toBe(text.description);
 const updated=await f.controller.edit(panel.message,'owner',{title:'New title',description:'New **description**'});
 expect(updated).toMatchObject({message:panel.message,role:'reward',title:'New title'});
 expect(f.editMessage).toHaveBeenCalledWith('message',expect.objectContaining({allowedMentions:{parse:[],repliedUser:false}}));
 expect(f.send).toHaveBeenCalledOnce();expect(f.message.react).toHaveBeenCalledOnce();expect(f.add).not.toHaveBeenCalled();expect(f.remove).not.toHaveBeenCalled();
 await expect(f.controller.edit(panel.message,'other',text)).rejects.toThrow();
 await expect(f.controller.edit(panel.message,'owner',{title:' ',description:'hello'})).rejects.toThrow();
 }finally{await f.close();}
});
