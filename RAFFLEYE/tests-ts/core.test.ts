import { afterEach, describe, expect, it, vi } from 'vitest';
import { offlineSettings } from '../app/config.js';
import { RulesExtractor } from '../app/extraction.js';
import { parsePost, grounded, claim } from '../app/models.js';
import { explicitTimes, locationTimezone, resolvedTimes } from '../app/timeparse.js';
import { BudgetExceeded, RuntimeLease, Store } from '../app/storage.js';
import { Service } from '../app/service.js';
import { HTTP, ProviderError, XSource } from '../app/providers.js';
import { giveawayEmbed } from '../app/presentation.js';
import { Notifier } from '../app/notifications.js';
import { canConfigure, commands } from '../app/bot.js';
import { BrowseSessions } from '../app/dashboard.js';

const now = Date.parse('2026-10-17T00:00:00Z');
const post = (text = 'WuWa giveaway!\nPrize: keyboard\nTo enter: Follow me and repost', location = '') => parsePost({ id: '2110128768618786937', author: 'example', text, author_location: location, source: 'x', created_at: new Date(now).toISOString() });
const stores: Store[] = [];
const database = () => { const store = new Store(':memory:'); stores.push(store); return store; };
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
describe('date formats and profile location', () => {
  it.each([
    ['10/19/2026 20:30 UTC+8', '2026-10-19T12:30:00.000Z'],
    ['19/10/2026 20:30 GMT+08:00', '2026-10-19T12:30:00.000Z'],
    ['19.10.2026 at 8:30 PM (UTC +8)', '2026-10-19T12:30:00.000Z'],
    ['10-19-2026 8:30 PM -0400', '2026-10-20T00:30:00.000Z'],
    ['2026/10/19 8:30 PM UTC', '2026-10-19T20:30:00.000Z'],
    ['19th October 2026 at 12 AM UTC', '2026-10-19T00:00:00.000Z'],
    ['October 19, 2026 at 12 PM GMT-3:30', '2026-10-19T15:30:00.000Z'],
    ['29/02/2028 12:00 UTC', '2028-02-29T12:00:00.000Z'],
  ])('converts %s', (text, expected) => expect(new Date(explicitTimes(text)[0]!.epoch).toISOString()).toBe(expected));
  it.each(['04/05/2026 8 PM UTC','31/02/2026 20:00 UTC','29/02/2026 20:00 UTC','13/14/2026 20:00 UTC','19/10/2026 25:00 UTC','19/10/2026 13 PM UTC','19/10/2026 20:00 UTC+25','19/10/2026 20:00 CST','19/10 20:00 UTC','19.10.'])('does not invent %s', text => expect(explicitTimes(text)).toEqual([]));
  it('uses declared date order', () => expect(new Date(explicitTimes('04/05/2026 8 PM UTC', 'DD/MM/YYYY')[0]!.epoch).toISOString()).toBe('2026-05-04T20:00:00.000Z'));
  it('post-wide explicit timezone takes priority over location', () => expect(resolvedTimes('2026-10-19 20:30', 'All times are UTC+2', 'Taipei')[0]?.epoch).toBe(Date.parse('2026-10-19T18:30:00Z')));
  it('maps exact location and rejects multizone or fictional locations', () => {
    expect(locationTimezone('Taipei, Taiwan')).toBe('Asia/Taipei');
    expect(locationTimezone('USA')).toBeNull(); expect(locationTimezone('Springfield')).toBeNull(); expect(locationTimezone('In your heart')).toBeNull();
  });
  it.each([
    ['2026-10-19 20:30', 'Taipei, Taiwan', '2026-10-19T12:30:00.000Z'],
    ['2026-07-19 20:30', 'New York, NY', '2026-07-20T00:30:00.000Z'],
    ['2026-12-19 20:30', 'New York, NY', '2026-12-20T01:30:00.000Z'],
  ])('applies dated location offset %s', (text, location, expected) => expect(new Date(resolvedTimes(text, '', location)[0]!.epoch).toISOString()).toBe(expected));
  it.each(['2026-11-01 01:30', '2026-03-08 02:30', '04/05/2026 20:30', '19.10.', '2026-10-19 20:30 CST'])('rejects ambiguous location time %s', text => expect(resolvedTimes(text, '', 'New York, NY')).toEqual([]));
  it('explicit offset wins and estimated cards disclose location', async () => {
    expect(resolvedTimes('2026-10-19 20:30 UTC', '', 'Taipei')[0]?.epoch).toBe(Date.parse('2026-10-19T20:30:00Z'));
    const item = post('WuWa giveaway!\nPrize: keyboard\nEnds: 19/10/2026 20:30', 'Taipei, Taiwan');
    const extracted = await new RulesExtractor().extract(item);
    expect(extracted.deadline_at.value).toBe('2026-10-19T12:30:00.000Z');
    const store = database(); store.saveExtraction(item, extracted, now, 60);
    const description = giveawayEmbed(store.giveaway(item.id)!).data.description!;
    expect(description).toContain('UTC'); expect(description).toContain('Local'); expect(description).toContain(':R>'); expect(description).toContain('Estimated from profile location');
    extracted.deadline_at = claim('2026-10-19T14:30:00Z', 'Ends: 19/10/2026 20:30');
    expect(grounded(extracted, item).deadline_at.value).toBeNull();
  });
});
describe('qualification and persistent workflow', () => {
  it.each(['Prize: TBD','Prize: surprise prize','Prize: 10 winners','10 winners!','Spend $10 and follow me','I bought 3 monthly passes'])('rejects nonprize %s', async text => {
    const store = database(), item = post('Wuwa giveaway!\nTo enter: Follow me\n' + text);
    store.subscribe('123', '456'); store.saveExtraction(item, await new RulesExtractor().extract(item), now, 60);
    expect(store.giveaway(item.id)).toBeUndefined(); expect(store.pendingNotifications(now)).toEqual([]);
  });
  it.each(['5x monthly pass giveaway', '3,280 LUNITE (WuWa) X 10 WINNERS', '3x Lunite Subscription\n1x 980 Lunite Pack\n2x 3280 Lunite Pack', '$50 gift card', 'Prize: keyboard'])('keeps prize %s', async text => {
    const store = database(), item = post('WuWa giveaway!\n' + text + '\nTo enter: Follow me and repost');
    store.subscribe('1538760053916442624', '1560894987724660838'); store.saveExtraction(item, await new RulesExtractor().extract(item), now, 60);
    expect(store.pendingNotifications(now)).toHaveLength(1); expect(store.subscription('1538760053916442624')).toBe('1560894987724660838');
  });
  it('retains multiline optional entry steps and sponsor', async () => {
    const item = post('WuWa giveaway!\nPrize: keyboard\nRules:\n- Follow @example\n- RT and Like\n- Optional: Comment your favorite\nSponsor: @sponsor\nEnds: 19.10.');
    const data = await new RulesExtractor().extract(item);
    expect(data.requirements.value).toEqual(['Follow @example','RT and Like','Optional: Comment your favorite']); expect(data.sponsor.value).toBe('@sponsor');
    const store = database(); store.saveExtraction(item, data, now, 60);
    expect(giveawayEmbed(store.giveaway(item.id)!).data.description).toContain('year/time/timezone missing');
  });
  it('reserves budgets atomically and honors month limits', () => {
    const store = database(); store.reserve({ x_requests: 1, estimated_usd: 0.5 }, { x_requests: 2, estimated_usd: 5 }, 0.7, now);
    expect(() => store.reserve({ x_requests: 1, estimated_usd: 0.5 }, { x_requests: 2, estimated_usd: 5 }, 0.7, now)).toThrow(BudgetExceeded);
    expect(store.usage('day:2026-10-17').x_requests).toBe(1);
  });
  it('stages raw posts and cursor in one transaction', () => {
    const store = database(); store.addQuery('global','giveaway',2,900);
    const query = store.queries()[0]!;
    expect(() => store.stagePage(query, [post()], null, NaN, ['scan:test', { covered_until: 'bad' }])).toThrow();
    expect(store.pending(10, now)).toEqual([]); expect(store.meta('scan:test')).toBe('');
    store.stagePage(query, [post()], { source:'x', start:'start', end:'end', token:'next' }, now);
    expect(store.pending(10, now)).toHaveLength(1); expect(JSON.parse(store.queries()[0]!.cursor!).token).toBe('next');
  });
  it('allows one writer and detects lease loss', () => {
    const store = database(); let clock = now;
    const first = new RuntimeLease(store, () => clock), second = new RuntimeLease(store, () => clock);
    first.acquire(); expect(() => second.acquire()).toThrow(); clock += 61000; second.acquire(); expect(() => first.assert()).toThrow(); first.release(); second.assert(); second.release();
  });
  it('pings the opted-in role once on new cards and keeps edits silent', async () => {
    const store = database(), settings = offlineSettings(':memory:'); settings.discord_guild_id = '1';
    const service = new Service(store, settings); store.subscribe('1','2');
    for (const id of ['100','101']) { const item = post('Giveaway!\nPrize: keyboard '+id+'\nTo enter: Follow me'); item.id = id; store.saveExtraction(item, await new RulesExtractor().extract(item), now, 60); }
    const send = vi.fn(async () => ({ id: '999' })), edit = vi.fn(async () => ({ id: '999' }));
    const ping=vi.fn(async()=>({content:'<@&beggars>',allowedMentions:{parse:[] as [],roles:['beggars'],users:[],repliedUser:false}}));
    const notify = new Notifier(service, async () => ({ guildId: '1', send, edit, ping }), () => {}, () => now);
    await notify.notify(); expect(send).toHaveBeenCalledTimes(1); expect(send.mock.calls[0]![0]).toMatchObject({ content:'<@&beggars>',allowedMentions: { parse: [], roles:['beggars'],users:[],repliedUser: false } });
    store.queue('100', 2); await notify.notify(); expect(edit).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(1);expect(ping).toHaveBeenCalledOnce();expect(edit.mock.calls[0]![1]).toMatchObject({allowedMentions:{parse:[]}});expect(send.mock.calls[0]![0]).not.toHaveProperty('flags');
    store.setMeta('notification_after:2',0);store.queue('100',2);edit.mockRejectedValueOnce({code:10008});await notify.notify();expect(send).toHaveBeenCalledTimes(2);expect(ping).toHaveBeenCalledOnce();expect(send.mock.calls[1]![0]).toMatchObject({flags:4096,allowedMentions:{parse:[]}});
  });
});
describe('provider and private UI boundaries', () => {
  it('requests profile location and preserves IDs', async () => {
    const store = database(), settings = offlineSettings(':memory:');
    const transport = vi.fn(async (url: string | URL) => { expect(new URL(url).searchParams.get('user.fields')).toContain('location'); return Response.json({ data: [{ id: '2110128768618786937',author_id:'5',text:'Giveaway!',created_at:new Date(now).toISOString() }],includes:{ users:[{id:'5',username:'example',location:'Taipei'}] },meta:{} }); });
    const source = new XSource(new HTTP(store, settings, transport), settings);
    const page = await source.fetch('giveaway', { source:'x',start:new Date(now-3600000).toISOString(),end:new Date(now).toISOString(),token:null });
    expect(page.posts[0]?.author_location).toBe('Taipei'); expect(page.posts[0]?.id).toBe('2110128768618786937');
  });
  it('retains reservation on HTTP failure and respects cooldown', async () => {
    const store = database(), settings = offlineSettings(':memory:'); settings.x_request_reserve_usd = 0.2;
    const fetch = vi.fn(async () => new Response('', {status:429, headers:{'retry-after':'3600'}}));
    const http = new HTTP(store, settings, fetch, () => now);
    await expect(http.request('x','GET','https://api.x.com/test')).rejects.toBeInstanceOf(ProviderError);
    await expect(http.request('x','GET','https://api.x.com/test')).rejects.toThrow('cooldown');
    expect(fetch).toHaveBeenCalledTimes(1); expect(store.usage('day:2026-10-17').estimated_usd).toBe(0.2);
  });
  it('channel managers cannot move an existing feed', () => { expect(canConfigure(false,true,true,undefined,'1')).toBe(true); expect(canConfigure(false,true,true,'1','2')).toBe(false); expect(canConfigure(true,false,false,'1','2')).toBe(true); });
  it('binds private browse sessions to user, guild and expiry', () => {
    let clock = now; const sessions = new BrowseSessions(() => clock), token = sessions.create('a','b');
    expect(sessions.get(token,'x','b')).toBeNull(); expect(sessions.get(token,'a','c')).toBeNull(); expect(sessions.get(token,'a','b')).not.toBeNull(); clock += 600001; expect(sessions.get(token,'a','b')).toBeNull();
  });
  it('serializes the slash command schema', () => expect(commands().toJSON().options?.length).toBe(18));
});
