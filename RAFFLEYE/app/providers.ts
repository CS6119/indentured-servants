import { z } from 'zod';
import type { Settings } from './config.js';
import { ExtractionSchema, grounded, parseExtraction, parsePost } from './models.js';
import type { Extraction, Post } from './models.js';
import { SYSTEM_PROMPT } from './extraction.js';
import type { Extractor } from './extraction.js';
import type { Cursor } from './storage.js';
import { Store } from './storage.js';
import { SafeError } from './log.js';
import fixtures from './fixtures/posts.json' with { type: 'json' };

export interface Page { posts: Post[]; next_token: string | null }
export interface Source { readonly name: 'mock' | 'x' | 'apify'; fetch(query: string, cursor: Pick<Cursor, 'token'> & Partial<Cursor>): Promise<Page> }
export type Provider = 'x' | 'apify' | 'ai';
export class ProviderError extends SafeError {
  constructor(code: string, public readonly delay = 300, public readonly fallback = false) { super(code); }
}
export type Fetcher = (input: string | URL, init?: RequestInit) => Promise<Response>;
const record = z.record(z.string(), z.unknown());
export class HTTP {
  constructor(readonly store: Store, readonly settings: Settings, private readonly transport: Fetcher = fetch, private readonly clock: () => number = Date.now, private readonly assertOwner: () => void = () => {}, private readonly signal?: AbortSignal) {}
  async request(provider: Provider, method: string, url: string, options: { headers?: Record<string, string>; params?: Record<string, string | number>; json?: unknown } = {}): Promise<unknown> {
    this.assertOwner();
    this.signal?.throwIfAborted();
    const now = this.clock(), s = this.settings;
    const cooldown = Number(this.store.meta('cooldown:' + provider, '0')) * 1000;
    if (cooldown > now) throw new ProviderError(`${provider}:cooldown`, (cooldown - now) / 1000);
    const metrics: Record<string, number> = { [`${provider}_requests`]: 1, estimated_usd: s[`${provider}_request_reserve_usd`] };
    const limits: Record<string, number> = { [`${provider}_requests`]: s[`daily_${provider}_requests`], estimated_usd: s.daily_estimated_usd };
    if (provider === 'x') { metrics.x_posts = s.page_size; limits.x_posts = s.daily_x_posts; }
    this.store.reserve(metrics, limits, s.monthly_estimated_usd, now);
    const target = new URL(url);
    for (const [key, value] of Object.entries(options.params ?? {})) target.searchParams.set(key, String(value));
    const timeout = AbortSignal.timeout(45000);
    let response: Response;
    try {
      response = await this.transport(target, {
        method, headers: { ...(options.json ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
        ...(options.json ? { body: JSON.stringify(options.json) } : {}),
        redirect: 'error', signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
      });
    } catch { throw new ProviderError(`${provider}:network`, 300, !this.signal?.aborted); }
    if (response.status >= 400) {
      let delay = 300;
      if (response.status === 429) {
        delay = 900;
        const retry = response.headers.get('retry-after');
        if (retry) {
          const seconds = Number(retry);
          const candidate = Number.isFinite(seconds) ? seconds : (Date.parse(retry) - now) / 1000;
          if (Number.isFinite(candidate)) delay = Math.max(delay, candidate);
        }
        const reset = Number(response.headers.get('x-rate-limit-reset'));
        if (Number.isFinite(reset)) delay = Math.max(delay, reset - now / 1000);
      } else if ([401, 402, 403].includes(response.status)) delay = 3600;
      if ([401, 402, 403, 429].includes(response.status)) this.store.setMeta('cooldown:' + provider, now / 1000 + delay);
      await response.body?.cancel().catch(() => {});
      throw new ProviderError(`${provider}:http_${response.status}`, delay, response.status >= 500);
    }
    if (response.status < 200 || response.status >= 300) throw new ProviderError(`${provider}:unexpected_status`);
    try {
      const reader = response.body?.getReader();
      if (!reader) throw new Error();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 10000000) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
    } catch { throw new ProviderError(`${provider}:invalid_json`); }
  }
}
const tweetSchema = z.object({
  id: z.string().regex(/^\d+$/), author_id: z.string(), text: z.string(), created_at: z.string(),
  entities: z.object({ urls: z.array(z.object({ expanded_url: z.string().optional(), url: z.string() })).optional() }).optional(),
});
const searchPageSchema = z.object({
  meta: z.object({ next_token: z.string().optional() }),
  data: z.array(tweetSchema).default([]),
  includes: z.object({ users: z.array(z.object({ id: z.string(), username: z.string(), name: z.string().optional(), description: z.string().optional(), location: z.string().optional() })).optional() }).optional(),
  errors: z.unknown().optional(),
});
export class XSource implements Source {
  readonly name = 'x';
  constructor(private readonly http: HTTP, private readonly settings: Settings) {}
  async fetch(query: string, cursor: Cursor): Promise<Page> {
    const body = await this.http.request('x', 'GET', `https://api.x.com/2/tweets/search/${this.settings.x_search_mode}`, {
      headers: { Authorization: 'Bearer ' + this.settings.x_bearer_token },
      params: { query, max_results: this.settings.page_size, 'tweet.fields': 'created_at,author_id,entities', expansions: 'author_id', 'user.fields': 'username,name,description,location', start_time: cursor.start, end_time: cursor.end, ...(cursor.token ? { next_token: cursor.token } : {}) },
    });
    try {
      const page = searchPageSchema.parse(body);
      if (page.errors && (!Array.isArray(page.errors) || page.errors.length > 0)) throw new Error();
      if (page.data.length > this.settings.page_size) throw new Error();
      const users = new Map(page.includes?.users?.map(user => [user.id, user]) ?? []);
      const posts = page.data.map(tweet => {
        const user = users.get(tweet.author_id);
        if (!user) throw new Error();
        return parsePost({ id: tweet.id, author: user.username, author_name: user.name ?? '', author_description: user.description ?? '', author_location: user.location ?? '', profile_fetched: true, text: tweet.text, created_at: tweet.created_at, source: 'x', urls: tweet.entities?.urls?.map(url => url.expanded_url || url.url) ?? [] });
      });
      return { posts, next_token: page.meta.next_token ?? null };
    } catch { throw new ProviderError('x:invalid_or_partial_page'); }
  }
}
export class ApifySource implements Source {
  readonly name = 'apify';
  constructor(private readonly http: HTTP, private readonly settings: Settings) {}
  async fetch(query: string, cursor: Pick<Cursor, 'token'>): Promise<Page> {
    const offset = Number(cursor.token ?? 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new ProviderError('apify:invalid_cursor');
    const body = await this.http.request('apify', 'GET', `https://api.apify.com/v2/datasets/${encodeURIComponent(this.settings.apify_dataset_id)}/items`, {
      headers: { Authorization: 'Bearer ' + this.settings.apify_token }, params: { format: 'json', clean: 'true', offset, limit: this.settings.page_size },
    });
    try {
      const rows = z.array(record).max(this.settings.page_size).parse(body);
      const posts: Post[] = [];
      for (const item of rows) {
        const author = typeof item.author === 'string' ? item.author : record.parse(item.author).userName ?? record.parse(item.author).username;
        const created = z.string().parse(item.created_at ?? item.createdAt);
        // Dataset RFC-style timestamps must still explicitly supply a timezone.
        if (!/(Z|[+-]\d{2}:?\d{2}|GMT|UTC)(?:\s+\d{4})?$/i.test(created)) throw new Error();
        const post = parsePost({ id: z.string().parse(item.id), author, text: item.text, created_at: new Date(created).toISOString(), source: 'apify', urls: item.urls ?? [] });
        if (query.startsWith('from:') && post.author.toLowerCase() !== query.split(/\s/)[0]!.slice(5).toLowerCase()) continue;
        posts.push(post);
      }
      return { posts, next_token: rows.length === this.settings.page_size ? String(offset + rows.length) : null };
    } catch { throw new ProviderError('apify:dataset_schema_mismatch'); }
  }
}
export class MockSource implements Source {
  readonly name = 'mock';
  async fetch(query: string, _cursor: Pick<Cursor, 'token'>): Promise<Page> {
    let posts = fixtures.map(parsePost);
    if (query.startsWith('from:')) posts = posts.filter(post => post.author.toLowerCase() === query.split(/\s/)[0]!.slice(5).toLowerCase());
    return { posts, next_token: null };
  }
}
export class OpenAIExtractor implements Extractor {
  constructor(private readonly http: HTTP, private readonly settings: Settings) {}
  async extract(post: Post): Promise<Extraction> {
    if ([...post.text].length > this.settings.max_post_chars) throw new ProviderError('ai:post_too_long');
    const body = await this.http.request('ai', 'POST', 'https://api.openai.com/v1/responses', {
      headers: { Authorization: 'Bearer ' + this.settings.openai_api_key },
      json: {
        model: this.settings.openai_model, store: false, max_output_tokens: this.settings.ai_max_output_tokens,
        input: [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: JSON.stringify({ text: post.text, urls: post.urls }) }],
        text: { format: { type: 'json_schema', name: 'giveaway', strict: true, schema: z.toJSONSchema(ExtractionSchema) } },
      },
    });
    const parsed = z.object({ status: z.string(), output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() }).passthrough()).optional() })).default([]) }).safeParse(body);
    if (!parsed.success || parsed.data.status !== 'completed') throw new ProviderError('ai:incomplete_response');
    const parts = parsed.data.output.filter(item => item.type === 'message').flatMap(item => item.content ?? []);
    if (parts.some(part => part.type === 'refusal')) throw new ProviderError('ai:refused');
    const output = parts.filter(part => part.type === 'output_text').map(part => part.text ?? '').join('');
    try { return grounded(parseExtraction(JSON.parse(output)), post); }
    catch { throw new ProviderError('ai:invalid_extraction'); }
  }
}
