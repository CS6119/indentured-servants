import { qualified } from './models.js';
import type { Extraction, Post } from './models.js';

export type GiveawayTopic = 'all' | 'wuwa' | 'gacha';

// Kept byte-for-byte compatible so existing query checkpoints remain usable.
export const WUWA_QUERY = '("Wuthering Waves" OR WutheringWaves OR WuWa OR WuwaTwt OR WuwaGiveaway OR WutheringWavesGiveaway OR WutheringWavesTwt OR WutherWaves OR 鳴潮 OR 鸣潮)';
const WUWA_MARKER = /(?<![a-z0-9_])(?:wuwa|wuthering[\s_-]*waves|wutherwaves)(?:giveaways?|twt)?(?![a-z0-9_])|#(?:wuwa|wutheringwaves|wutherwaves)[a-z0-9_]*|鳴潮|鸣潮/i;
const GACHA_MARKER = /(?<![a-z0-9_])(?:gacha|genshin(?:\s*impact)?|honkai(?:\s*(?:impact|star\s*rail))?|hsr|zenless(?:\s*zone\s*zero)?|zzz|nikke|arknights|fate[\s/]*grand[\s/]*order|fgo|azur\s*lane|blue\s*archive|reverse[\s:]*1999|path\s*to\s*nowhere|punishing[\s:]*gray\s*raven|pgr|granblue(?:\s*fantasy)?|epic\s*(?:seven|7)|uma\s*musume|snowbreak|limbus(?:\s*company)?|love\s*and\s*deepspace|girls?[\s']*frontline)(?:twt|giveaways?)?(?![a-z0-9_])|原神|崩[壞坏]|星[穹琼]鐵道|星穹铁道|絕區零|绝区零|明日方舟|碧[藍蓝]航[線线]|蔚[藍蓝]檔案|碧蓝档案|[賽赛]馬娘|赛马娘|勝利女神|胜利女神|戀與深空|恋与深空|少女前[線线]/i;
const EXPLICIT_GIVEAWAY = /(?<![a-z])give\s*aways?(?![a-z])/i;
export const GIVEAWAY_MARKER = /give\s*aways?|sweepstakes|raffles?|抽獎|抽奖/i;
function withoutIncidental(text: string): string { return text.normalize('NFKC').replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, ''); }
export function profileQualified(post: Post, topic: GiveawayTopic = 'wuwa'): boolean {
  const profile = withoutIncidental(post.author_name + ' ' + post.author_description);
  if (topic === 'gacha') return WUWA_MARKER.test(profile) || GACHA_MARKER.test(profile);
  return WUWA_MARKER.test(profile) && GIVEAWAY_MARKER.test(profile);
}
export function matchesTopic(post: Post, topic: GiveawayTopic): boolean {
  const text = withoutIncidental(post.text);
  return topic === 'all' || WUWA_MARKER.test(text) || (topic === 'gacha' && GACHA_MARKER.test(text)) || profileQualified(post, topic);
}

export interface GiveawayQuantity { evidence: string; prize?: string; winnerCount?: number }
export function giveawayQuantity(text: string, only?: 'prize' | 'winnerCount'): GiveawayQuantity | undefined {
  const number = String.raw`(?:[1-9]\d{0,2}(?:,\d{3})+|[1-9]\d*)(?:\.\d{1,2})?`;
  const items = String.raw`welkins?(?:\s+moons?)?|blessings?\s+of\s+the\s+welkin\s+moon|express\s+supply\s+passes?|inter[ -]?knot\s+memberships?|monthly\s+passes|monthly\s+pass|monthly\s+cards?|battle\s+passes|battle\s+pass|lunite(?:\s+(?:subscriptions?|packs?))?|astrites?|primogems?|genesis\s+crystals?|stellar\s+jades?|oneiric\s+shards?|polychromes?|monochromes?|orundum|originium|pyroxenes?|saint\s+quartz|intertwined\s+fates?|acquaint\s+fates?|diamonds?|jewels?|tickets?|vouchers?|gems?|pulls?|summons?|gift\s*cards?|keyboards?|figures?|plushies|accounts?|月卡|星聲|星声|原石|星瓊|星琼`;
  const patterns: [RegExp, 'prize' | 'winnerCount' | 'quantity'][] = [
    [new RegExp(String.raw`(?<![\w.,])(${number})\s*(?:x\s*)?(?:winners?|名得獎者|位得獎者)(?![a-z])`, 'gi'), 'winnerCount'],
    [new RegExp(String.raw`\bwinners?\s*[:：]\s*(${number})(?![\d.])`, 'gi'), 'winnerCount'],
    [new RegExp(String.raw`(?<![\w.,])(?:${number}[ \t]*[x×][ \t]*)?(?:US\$|\$|€|£|¥)[ \t]*(${number})(?![\d,]|\.\d)(?:[ \t]*(?:gift\s*cards?|cash))?`, 'gi'), 'prize'],
    [new RegExp(String.raw`(?<![\w.,])(${number})\s*(?:USD|EUR|GBP|JPY)(?![a-z])`, 'gi'), 'prize'],
    [new RegExp(String.raw`(?<![\w.,])(${number})\s*(?:[x×]\s*)?(?:${items})(?![a-z])`, 'gi'), 'prize'],
    [new RegExp(String.raw`(?<![a-z])(?:${items})\s*[x×]\s*(${number})(?![\d.,])`, 'gi'), 'prize'],
    [new RegExp(String.raw`\b(?:prizes?|rewards?)\s*[:：]\s*(${number})[ \t]+(?!winners?\b|followers?\b|days?\b|hours?\b|minutes?\b)[a-z][^\n]*`, 'gi'), 'prize'],
    [new RegExp(String.raw`\bgiveaways?\s*[:!\-]?\s*[x×]\s*(${number})(?![\d.,])`, 'gi'), 'quantity'],
  ];
  for (const [pattern, kind] of patterns) {
    if (only && kind !== only) continue;
    for (const match of text.matchAll(pattern)) {
      const start = text.lastIndexOf('\n', match.index - 1) + 1;
      const prefix = text.slice(start, match.index);
      if (/https?:\/\/\S*$|@[A-Za-z0-9_]*$|\b(?:spend|buy|bought|purchase|costs?|paid\s+entry|entry\s+fee|donate)\b/i.test(prefix)) continue;
      if (kind === 'winnerCount') {
        const count = Number(match[1]!.replaceAll(',', ''));
        if (!Number.isInteger(count) || count > 1000000) continue;
        return { evidence: match[0], winnerCount: count };
      }
      return { evidence: match[0], ...(kind === 'prize' ? { prize: match[0].trim() } : {}) };
    }
  }
  return undefined;
}
export function numberedGachaGiveaway(post: Post): boolean {
  const text = post.text.replace(/https?:\/\/\S+|@[A-Za-z0-9_]+/g, '');
  return matchesTopic(post, 'gacha') && EXPLICIT_GIVEAWAY.test(text) && !!giveawayQuantity(text);
}
export function qualifiesForFeed(post: Post, data: Extraction, topic: GiveawayTopic): boolean {
  return topic === 'gacha' ? data.is_giveaway.value === true && numberedGachaGiveaway(post) : qualified(data) && matchesTopic(post, topic);
}
export function scopedQuery(query: string, topic: GiveawayTopic): string {
  if (topic === 'all') return query;
  if (topic === 'gacha') {
    // X search cannot filter author bios; qualify returned profiles locally.
    return `${query.replace(WUWA_QUERY, '').trim()}${EXPLICIT_GIVEAWAY.test(query) ? '' : ' giveaway'}${query.includes('-is:reply') ? '' : ' -is:reply'}`;
  }
  if (!query.includes(WUWA_QUERY)) query = `(${query}) ${WUWA_QUERY}`;
  if (!query.includes('-is:reply')) query += ' -is:reply';
  return query;
}
