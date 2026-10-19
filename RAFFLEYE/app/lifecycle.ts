import type { Post } from './models.js';

export function closureSignal(text: string): { state: 'ended' | 'cancelled'; evidence: string } | null {
  const cancelled = /giveaway\s+(?:is\s+|has\s+been\s+)?cancel(?:l)?ed|取消抽獎/i.exec(text);
  if (cancelled) return { state: 'cancelled', evidence: cancelled[0] };
  const ended = /giveaway\s+results(?!\s+(?:soon|tomorrow|on|at|will|coming)\b)|giveaway\s+(?:has\s+|is\s+)?(?:ended|closed)|winners?\s+(?:have\s+been|were)\s+(?:announced|selected|picked)|抽獎結果|抽獎已結束/i.exec(text);
  return ended ? { state: 'ended', evidence: ended[0] } : null;
}
export function linkedPosts(post: Post): string[] {
  const ids = new Set<string>();
  for (const value of post.urls) {
    try {
      const url = new URL(value);
      if (!['x.com','www.x.com','twitter.com','www.twitter.com'].includes(url.hostname.toLowerCase())) continue;
      const match = /^\/([A-Za-z0-9_]+)\/status\/(\d+)(?:\/|$)/.exec(url.pathname);
      if (match && match[1]!.toLowerCase() === post.author.toLowerCase() && match[2] !== post.id) ids.add(match[2]!);
    } catch { /* Invalid external URL cannot establish a relationship. */ }
  }
  return [...ids];
}
