import {expect,it} from 'vitest';
import {Store} from '../app/storage.js';
import {parsePost} from '../app/models.js';
import {RulesExtractor} from '../app/extraction.js';
import {closureSignal} from '../app/lifecycle.js';
import {giveawayEmbed,cardButtons} from '../app/presentation.js';
const original=parsePost({id:'123',author:'host',text:'WuWa giveaway!\nPrize: 3,280 Lunite\nTo enter: Follow me',created_at:'2026-10-13T12:00:00Z',source:'x'});
const results=parsePost({id:'124',author:'host',text:'GIVEAWAY RESULTS! 10 winners. Congratulations!',created_at:'2026-10-13T15:00:00Z',source:'x',urls:['https://twitter.com/host/status/123']});
const now=Date.parse('2026-10-17T00:00:00Z');
it('links results to the original, edits every delivered copy and never reopens on reextraction',async()=>{
 const db=new Store(':memory:');try{
 db.subscribe('1','old');db.saveExtraction(original,await new RulesExtractor().extract(original),now,60);
 db.delivered(db.pendingNotifications(now)[0]!,'message1');db.subscribe('1','new');db.delivered(db.pendingNotifications(now)[0]!,'message2');
 db.observeClosure(results,now);
 expect(db.giveaway('123')?.status).toBe('ended');
 expect(db.pendingNotifications(now).map(x=>x.channel_id).sort()).toEqual(['new','old']);
 await db.saveExtraction(original,await new RulesExtractor().extract(original),now,60);
 expect(db.giveaway('123')?.status).toBe('ended');
 expect(giveawayEmbed(db.giveaway('123')!).data.title).toContain('ENDED');
 expect(cardButtons(db.giveaway('123')!).toJSON().components[0]).toMatchObject({label:'VIEW ORIGINAL ↗'});
 }finally{db.close();}
});
it('handles results arriving before their original and does not announce an ended discovery',async()=>{
 const db=new Store(':memory:');try{db.subscribe('1','2');db.observeClosure(results,now);db.saveExtraction(original,await new RulesExtractor().extract(original),now,60);expect(db.giveaway('123')?.status).toBe('ended');expect(db.pendingNotifications(now)).toEqual([]);}finally{db.close();}
});
it('does not let unrelated authors or a mere matching prize close a giveaway',async()=>{
 const db=new Store(':memory:');try{db.saveExtraction(original,await new RulesExtractor().extract(original),now,60);db.observeClosure({...results,author:'stranger'},now);db.observeClosure({...results,urls:[]},now);expect(db.giveaway('123')?.status).toBe('open');}finally{db.close();}
});
it('does not classify scheduled announcements as completed or results as new giveaways',async()=>{
 expect(closureSignal('Winners will be announced tomorrow')).toBeNull();expect(closureSignal('Giveaway results tomorrow')).toBeNull();
 expect((await new RulesExtractor().extract(results)).is_giveaway.value).toBe(false);
});
it('reconciles already-processed cached results at startup',async()=>{
 const db=new Store(':memory:');try{db.saveExtraction(original,await new RulesExtractor().extract(original),now,60);db.db.prepare('INSERT INTO posts(id,hash,body,processed,seen_at) VALUES (?,?,?,?,?)').run(results.id,'hash',JSON.stringify(results),1,new Date(now).toISOString());db.reconcileClosures();expect(db.giveaway('123')?.status).toBe('ended');}finally{db.close();}
});
