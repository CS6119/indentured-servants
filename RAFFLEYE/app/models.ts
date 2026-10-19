import { createHash } from 'node:crypto';
import { z } from 'zod';
import { labelledTimes, resolvedTimes } from './timeparse.js';
import { SafeError } from './log.js';

export const timeKeys = ['starts_at', 'deadline_at', 'announcement_at'] as const;
export type TimeKey = typeof timeKeys[number];
export type State = 'open' | 'upcoming' | 'ending_soon' | 'ended' | 'cancelled' | 'unknown';
export type Confidence = 'high' | 'medium' | 'low' | 'unknown';
export interface Claim<T> { value: T | null; evidence: string | null; confidence: Confidence }
export interface Extraction {
  is_giveaway: Claim<boolean>;
  announcement: Claim<'open' | 'upcoming' | 'ended' | 'cancelled' | 'update'>;
  prizes: Claim<string[]>;
  winner_count: Claim<number>;
  requirements: Claim<string[]>;
  sponsor: Claim<string>;
  sponsor_websites: Claim<string[]>;
  starts_at: Claim<string>;
  deadline_at: Claim<string>;
  announcement_at: Claim<string>;
}

export function safeUrl(value: string): boolean {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !!url.hostname && !url.username && !url.password; }
  catch { return false; }
}
export function instant(value: string): number {
  if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) throw new SafeError('timezone_required');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new SafeError('invalid_timestamp');
  return result;
}
export const PostSchema = z.object({
  id: z.string().regex(/^\d+$/),
  author: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  author_name: z.string().default(''),
  author_description: z.string().default(''),
  author_location: z.string().default(''),
  profile_fetched: z.boolean().default(false),
  text: z.string().max(30000),
  created_at: z.string().refine(value => { try { instant(value); return true; } catch { return false; } }),
  urls: z.array(z.string()).default([]).transform(values => [...new Set(values.filter(safeUrl))].slice(0, 30)),
  source: z.enum(['mock', 'x', 'apify']),
}).strict();
export type Post = z.infer<typeof PostSchema>;
export function parsePost(body: string | unknown): Post {
  try { return PostSchema.parse(typeof body === 'string' ? JSON.parse(body) : body); }
  catch { throw new SafeError('invalid_post'); }
}
export function postUrl(post: Post): string { return `https://x.com/${post.author}/status/${post.id}`; }
export function sha256(value: string): string { return createHash('sha256').update(value, 'utf8').digest('hex'); }

/** Python json.dumps(..., ensure_ascii=False), including its default separators. */
export function pythonJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(pythonJson).join(', ') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).map(([key, item]) => JSON.stringify(key) + ': ' + pythonJson(item)).join(', ') + '}';
  return JSON.stringify(value);
}
export function contentHash(post: Post): string {
  const fields = [post.author.toLowerCase(), post.text, [...post.urls].sort(), post.author_name, post.author_description];
  if (post.author_location) fields.push(post.author_location);
  return sha256(pythonJson(fields));
}
export function campaignHash(post: Post): string {
  const text = post.text.replace(/https?:\/\/t\.co\/\S+/g, '').normalize('NFKC').toLowerCase().replace(/ß/g, 'ss').replace(/ς/g, 'σ').trim().replace(/\s+/gu, ' ');
  return sha256(post.author.toLowerCase() + '\n' + text);
}
export function unknown<T>(): Claim<T> { return { value: null, evidence: null, confidence: 'unknown' }; }
export function claim<T>(value: T, evidence: string, confidence: Confidence = 'medium'): Claim<T> { return { value, evidence, confidence }; }
export function emptyExtraction(): Extraction {
  return { is_giveaway: unknown(), announcement: unknown(), prizes: unknown(), winner_count: unknown(), requirements: unknown(), sponsor: unknown(), sponsor_websites: unknown(), starts_at: unknown(), deadline_at: unknown(), announcement_at: unknown() };
}
const claimSchema = <T extends z.ZodType>(schema: T) => z.object({ value: schema.nullable(), evidence: z.string().nullable(), confidence: z.enum(['high', 'medium', 'low', 'unknown']) }).strict();
export const ExtractionSchema = z.object({
  is_giveaway: claimSchema(z.boolean()),
  announcement: claimSchema(z.enum(['open', 'upcoming', 'ended', 'cancelled', 'update'])),
  prizes: claimSchema(z.array(z.string())),
  winner_count: claimSchema(z.number().int()),
  requirements: claimSchema(z.array(z.string())),
  sponsor: claimSchema(z.string()),
  sponsor_websites: claimSchema(z.array(z.string())),
  starts_at: claimSchema(z.string()),
  deadline_at: claimSchema(z.string()),
  announcement_at: claimSchema(z.string()),
}).strict();

export function parseExtraction(value: unknown): Extraction {
  const result = ExtractionSchema.safeParse(value);
  if (!result.success) throw new SafeError('invalid_extraction');
  return result.data;
}
export function grounded(extraction: Extraction, post: Post): Extraction {
  const data = structuredClone(extraction);
  const evidenceText = post.text + '\n' + post.urls.join('\n');
  for (const item of Object.values(data)) {
    if (item.value === null || !item.evidence || !evidenceText.includes(item.evidence) || item.confidence === 'unknown') Object.assign(item, unknown());
  }
  for (const key of timeKeys) {
    if (data[key].value === null) {
      const statements = labelledTimes(post.text)[key];
      if (statements.length === 1) {
        const dates = resolvedTimes(statements[0]!.raw, post.text, post.author_location);
        if (dates.length === 1) data[key] = claim(new Date(dates[0]!.epoch).toISOString(), statements[0]!.evidence, dates[0]!.inferredZone ? 'low' : 'high');
      }
    }
    const item = data[key];
    if (item.value !== null) {
      try {
        const parsed = instant(item.value);
        if (!resolvedTimes(item.evidence ?? '', post.text, post.author_location).some(time => time.epoch === parsed)) throw new SafeError('ungrounded_time');
        item.value = new Date(parsed).toISOString();
      } catch { data[key] = unknown(); }
    }
  }
  if (data.winner_count.value !== null && (data.winner_count.value < 1 || data.winner_count.value > 1000000)) data.winner_count = unknown();
  if (data.sponsor_websites.value?.some(url => !safeUrl(url) || !evidenceText.includes(url))) data.sponsor_websites = unknown();
  if (data.starts_at.value && data.deadline_at.value && instant(data.starts_at.value) >= instant(data.deadline_at.value)) {
    data.starts_at = unknown(); data.deadline_at = unknown();
  }
  return data;
}
export function statusOf(data: Extraction, now = Date.now(), endingMinutes = 60): State {
  const state = data.announcement.value;
  if (state === 'ended' || state === 'cancelled') return state;
  if (data.starts_at.value && instant(data.starts_at.value) > now) return 'upcoming';
  if (data.deadline_at.value) {
    const remaining = instant(data.deadline_at.value) - now;
    if (remaining <= 0) return 'ended';
    if (remaining <= endingMinutes * 60000) return 'ending_soon';
  }
  if (state === 'upcoming' && !data.starts_at.value) return 'upcoming';
  if (data.starts_at.value && instant(data.starts_at.value) <= now) return 'open';
  return state === 'open' ? 'open' : 'unknown';
}
export function qualified(data: Extraction): boolean { return data.is_giveaway.value === true && !!data.prizes.value?.some(value => value.trim()); }
export function terminal(state: string): boolean { return state === 'ended' || state === 'cancelled'; }
