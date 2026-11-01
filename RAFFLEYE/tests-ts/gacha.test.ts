import { describe, expect, it, vi } from 'vitest';
import { offlineSettings, SettingsSchema } from '../app/config.js';
import { matchesTopic, numberedGachaGiveaway, profileQualified, scopedQuery, WUWA_QUERY } from '../app/discovery.js';
import { RulesExtractor } from '../app/extraction.js';
import { claim, parsePost } from '../app/models.js';
import { giveawayEmbed, visible } from '../app/presentation.js';
import { Service } from '../app/service.js';
import { Store } from '../app/storage.js';
import { Notifier } from '../app/notifications.js';

const now = Date.parse('2026-11-01T00:00:00Z');
const post = (text: string, bio = 'Genshin Impact player', id = '100') => parsePost({
  id, author: 'host', author_name: 'Host', author_description: bio, profile_fetched: true,
  text, created_at: new Date(now).toISOString(), source: 'x',
});

describe('gacha topic and numeric eligibility', () => {
  it.each(['Wuthering Waves', '原神', 'GenshinTwt', 'Honkai Star Rail', 'HSR', 'Zenless Zone Zero', 'NIKKE', 'Arknights', 'Fate/Grand Order', 'Blue Archive', 'Reverse: 1999', 'gacha fan'])('accepts profile context: %s', bio => {
    expect(numberedGachaGiveaway(post('GIVEAWAY! 3 winners', bio))).toBe(true);
  });
  it('accepts game evidence in post text even when the profile is generic', () => {
    expect(numberedGachaGiveaway(post('Genshin giveaway — 5 Welkins', 'Artist'))).toBe(true);
  });
  it.each([
    'Giveaway! 5 Welkins', 'GIVEAWAY: $50', 'Giveaway — 3 winners', 'Giveaway! Winners: 4',
    'Giveaway! 1,600 Primogems', 'Giveaway! 5x monthly pass', 'Giveaway! 3 Express Supply Passes',
    'Giveaway! 980 Lunite', 'Giveaway! 50 USD', 'Giveaway! 3x $50 gift cards',
    'Welkin x5 giveaway', 'GIVEAWAY x5', '#giveaway 2 winners', 'Giveaway! Prize: 2 acrylic stands',
    'Giveaway! 300 Saint Quartz', 'Giveaway! 10 tickets', 'Giveaway! $50.',
  ])('accepts a concrete number: %s', text => expect(numberedGachaGiveaway(post(text))).toBe(true));
  it.each([
    'Giveaway! Prize: keyboard', 'Giveaway ends 2026-11-05', 'Giveaway at 20:00 UTC',
    'Giveaway for 1000 followers!', 'Giveaway!\n1. Follow\n2. Repost', 'Giveaway! Tag 3 friends',
    'Giveaway! Spend $10 to enter', 'Giveaway! Buy 3 monthly passes to qualify',
    'Giveaway! https://example.com/50USD', 'Giveaway! @50USD', 'Giveaway! 0 winners',
    'Giveaway! 0 Welkins', 'Giveaway! 1.5 winners', 'Raffle! 3 winners', 'Sweepstakes $50',
    'Prize: $50. https://example.com/giveaway',
  ])('rejects missing or incidental numbers: %s', text => expect(numberedGachaGiveaway(post(text))).toBe(false));
  it.each(['Travel blogger', 'https://example.com/genshin', 'Follow @GenshinImpact'])('rejects unrelated/incidental profile context: %s', bio => {
    expect(numberedGachaGiveaway(post('Giveaway! 3 winners', bio))).toBe(false);
  });
  it('does not use the username alone as game evidence', () => {
    expect(numberedGachaGiveaway({ ...post('Giveaway! $50', ''), author: 'GenshinHost' })).toBe(false);
  });
  it('allows game-only bios without requiring giveaway in the bio', () => {
    expect(profileQualified(post('hello'), 'gacha')).toBe(true);
    expect(profileQualified(post('hello'), 'wuwa')).toBe(false);
    expect(matchesTopic(post('Giveaway! $50'), 'wuwa')).toBe(false);
  });
  it('keeps global search broad for bio-only accounts and adds giveaway to profile watches', () => {
    expect(SettingsSchema.parse({ giveaway_topic: 'gacha' }).giveaway_topic).toBe('gacha');
    const query = scopedQuery('(giveaway OR giveaways) -is:retweet', 'gacha');
    expect(query).not.toContain(WUWA_QUERY); expect(query).toContain('-is:reply');
    expect(scopedQuery(query, 'gacha')).toBe(query);
    expect(scopedQuery('from:host -is:retweet', 'gacha')).toContain(' giveaway');
  });
  it('resets changed query pagination without resetting spending or provider cooldowns', () => {
    const store = new Store(':memory:');
    try {
      store.addQuery('global', scopedQuery('giveaway', 'wuwa'), 2, 900);
      store.db.prepare('UPDATE queries SET cursor=?,next_due=?,error=? WHERE key=?').run('{}', now / 1000 + 3600, 'old limit', 'global');
      store.setMeta('cooldown:x', 'keep');
      store.reserve({ estimated_usd: 1 }, { estimated_usd: 5 }, 50, now);
      store.addQuery('global', scopedQuery('giveaway', 'gacha'), 2, 900);
      const query = store.queries()[0]!;
      expect(query.cursor).toBeNull(); expect(query.next_due).toBe(0); expect(query.error).toBeNull();
      expect(store.meta('cooldown:x')).toBe('keep'); expect(store.usage('day:2026-11-01').estimated_usd).toBe(1);
    } finally { store.close(); }
  });
  it('keeps the automatic profile watch cap', () => {
    const store = new Store(':memory:');
    try {
      const service = new Service(store, { ...offlineSettings(':memory:'), giveaway_topic: 'gacha', profile_watch_limit: 1 });
      service.observeProfile(post('Giveaway! $50'));
      service.observeProfile({ ...post('Giveaway! $50'), author: 'second' });
      expect(store.queries().filter(q => q.key.startsWith('profile:'))).toHaveLength(1);
    } finally { store.close(); }
  });
});

describe('gacha extraction, storage and delivery', () => {
  it('posts a numbered bio-only giveaway end to end, without inventing the prize', async () => {
    const store = new Store(':memory:');
    try {
      const settings = { ...offlineSettings(':memory:'), giveaway_topic: 'gacha' as const, discord_guild_id: '1' };
      const service = new Service(store, settings);
      store.subscribe('1', '2');
      service.source = { name: 'mock', fetch: vi.fn(async () => ({ posts: [post('GIVEAWAY — 3 winners')], next_token: null })) };
      await service.tick(now);
      const saved = store.giveaway('100')!;
      expect(saved).toBeDefined(); expect(visible(saved, 'gacha')).toBe(true);
      expect(JSON.parse(saved.extraction).prizes.value).toBeNull();
      expect(JSON.parse(saved.extraction).winner_count.value).toBe(3);
      expect(giveawayEmbed(saved).data.description).toContain('3 winners');
      const send = vi.fn(async () => ({ id: 'message' }));
      await new Notifier(service, async () => ({ guildId: '1', send, edit: vi.fn() }), () => {}, () => now).notify();
      expect(send).toHaveBeenCalledOnce();
      const watch = store.queries().find(q => q.key === 'profile:host')!;
      expect(watch).toBeDefined(); expect(service.queryText(watch)).toContain('giveaway');
    } finally { store.close(); }
  });
  it('retains both prize evidence and winner count', async () => {
    const data = await new RulesExtractor('gacha').extract(post('Giveaway! 5 Welkins for 3 winners'));
    expect(data.prizes.value).toEqual(['5 Welkins']); expect(data.winner_count.value).toBe(3);
  });
  it('does not let a URL alter the evidence for a following cash prize', async () => {
    const data = await new RulesExtractor('gacha').extract(post('Giveaway! https://example.com/info $50.'));
    expect(data.prizes.value).toEqual(['$50']); expect(data.prizes.evidence).toBe('$50');
  });
  it.each(['GIVEAWAY RESULTS! 3 winners', 'Giveaway ended. 5 Welkins', 'Giveaway cancelled. $50'])('rejects new result/ended cards: %s', async text => {
    const data = await new RulesExtractor('gacha').extract(post(text));
    expect(data.is_giveaway.value).toBe(false);
  });
  it('enforces eligibility again for AI or historical extractions', async () => {
    const store = new Store(':memory:');
    try {
      const item = post('Giveaway! Prize: keyboard\nTo enter: Follow me');
      const data = await new RulesExtractor().extract(item);
      expect(data.is_giveaway.value).toBe(true);
      store.saveExtraction(item, data, now, 60);
      expect(visible(store.giveaway(item.id)!, 'gacha')).toBe(false);
      store.saveExtraction(item, data, now, 60, 'gacha');
      expect(store.giveaway(item.id)).toBeUndefined(); expect(store.pendingNotifications(now)).toEqual([]);
    } finally { store.close(); }
  });
  it('does not broaden legacy modes to winner-count-only posts', async () => {
    const store = new Store(':memory:');
    try {
      const item = post('WuWa giveaway! 3 winners\nTo enter: Follow me');
      store.saveExtraction(item, await new RulesExtractor().extract(item), now, 60, 'wuwa');
      expect(store.giveaway(item.id)).toBeUndefined();
    } finally { store.close(); }
  });
  it('shows UTC/local time without assigning WuWa server clocks to other games', async () => {
    const store = new Store(':memory:');
    try {
      const item = post('Giveaway! 5 Welkins\nEnds: 2026-11-05 20:00 UTC');
      const data = await new RulesExtractor('gacha').extract(item);
      data.deadline_at = claim('2026-11-05T20:00:00Z', 'Ends: 2026-11-05 20:00 UTC');
      store.saveExtraction(item, data, now, 60, 'gacha');
      const text = giveawayEmbed(store.giveaway(item.id)!).data.description!;
      expect(text).toContain('UTC'); expect(text).toContain('Local'); expect(text).not.toContain('Europe');
    } finally { store.close(); }
  });
});
