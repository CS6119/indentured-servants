import type { Post } from './models.js';

// Kept byte-for-byte compatible so existing query checkpoints remain usable.
export const WUWA_QUERY = '("Wuthering Waves" OR WutheringWaves OR WuWa OR WuwaTwt OR WuwaGiveaway OR WutheringWavesGiveaway OR WutheringWavesTwt OR WutherWaves OR 鳴潮 OR 鸣潮)';
const WUWA_MARKER = /(?<![a-z0-9_])(?:wuwa|wuthering[\s_-]*waves|wutherwaves)(?:giveaways?|twt)?(?![a-z0-9_])|#(?:wuwa|wutheringwaves|wutherwaves)[a-z0-9_]*|鳴潮|鸣潮/i;
export const GIVEAWAY_MARKER = /give\s*aways?|sweepstakes|raffles?|抽獎|抽奖/i;
function withoutIncidental(text: string): string { return text.normalize('NFKC').replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, ''); }
export function profileQualified(post: Post): boolean {
  const profile = withoutIncidental(post.author_name + ' ' + post.author_description);
  return WUWA_MARKER.test(profile) && GIVEAWAY_MARKER.test(profile);
}
export function matchesTopic(post: Post, topic: 'all' | 'wuwa'): boolean { return topic === 'all' || WUWA_MARKER.test(withoutIncidental(post.text)) || profileQualified(post); }
export function scopedQuery(query: string, topic: 'all' | 'wuwa'): string {
  if (topic === 'all') return query;
  if (!query.includes(WUWA_QUERY)) query = `(${query}) ${WUWA_QUERY}`;
  if (!query.includes('-is:reply')) query += ' -is:reply';
  return query;
}
