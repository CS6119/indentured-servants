import { expect, it } from 'vitest';
import { explicitTimes, resolvedTimes } from '../app/timeparse.js';
import { fixedClock, timestamp, serverClocks, giveawayEmbed, detailEmbed } from '../app/presentation.js';
import { parsePost } from '../app/models.js';
import { RulesExtractor } from '../app/extraction.js';
import { Store } from '../app/storage.js';

it('converts the same instant across month and year boundaries', () => {
  const value = '2026-12-31T20:30:00Z';
  expect(serverClocks(value)).toEqual([
    'JST · 2027-01-01 05:30 (UTC+9)',
    'Asia / SEA / HMT · 2027-01-01 04:30 (UTC+8)',
    'Europe · 2026-12-31 21:30 (UTC+1)',
    'America · 2026-12-31 15:30 (UTC−5)',
  ]);
  expect(fixedClock('2026-03-01T02:00:00Z', -5)).toBe('2026-02-28 21:00');
});
it('treats JST as an explicit source timezone even when the profile is elsewhere', () => {
  const text = '2026-10-19 20:30 JST';
  expect(explicitTimes(text)[0]?.epoch).toBe(Date.parse('2026-10-19T11:30:00Z'));
  expect(resolvedTimes(text, '', 'New York, NY')[0]?.inferredZone).toBeUndefined();
  expect(resolvedTimes('2026-10-19 20:30', 'All times are JST', 'Taipei')[0]?.epoch).toBe(Date.parse('2026-10-19T11:30:00Z'));
});
it('uses host DST to resolve the source, then fixed WuWa server offsets', () => {
  const summer = resolvedTimes('2026-07-19 20:30', '', 'New York, NY')[0]!;
  const winter = resolvedTimes('2026-12-19 20:30', '', 'New York, NY')[0]!;
  expect(fixedClock(new Date(summer.epoch).toISOString(), -5)).toBe('2026-07-19 19:30');
  expect(fixedClock(new Date(winter.epoch).toISOString(), -5)).toBe('2026-12-19 20:30');
});
it('keeps UTC, every server clock and local time when cancelled, without a countdown', () => {
  const value = timestamp('2026-10-19T20:30:00Z', false);
  for(const label of ['UTC','JST','Asia / SEA / HMT','Europe','America','Local']) expect(value).toContain(label);
  expect(value).not.toContain(':R>');
});
it('shows the host estimate and converted clocks in public and private cards', async () => {
  const post = parsePost({id:'123',author:'host',source:'x',created_at:'2026-10-17T00:00:00Z',author_location:'Tokyo, Japan',text:'WuWa giveaway!\nPrize: keyboard\nEnds: 19/10/2026 20:30'});
  const store = new Store(':memory:');
  try {
    store.saveExtraction(post,await new RulesExtractor().extract(post),Date.parse(post.created_at),60);
    const row=store.giveaway(post.id)!;
    for(const output of [JSON.stringify(giveawayEmbed(row).toJSON()),JSON.stringify(detailEmbed(row,'dates').toJSON())]) {
      expect(output).toContain('2026-10-19 11:30 UTC');expect(output).toContain('2026-10-19 20:30 (UTC+9)');
      expect(output).toContain('Estimated from profile location');expect(output).toContain('America');expect(output).toContain(':R>');
    }
  } finally {store.close();}
});
