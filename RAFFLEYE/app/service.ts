import { setTimeout as sleep } from 'node:timers/promises';
import type { Settings } from './config.js';
import { matchesTopic, profileQualified, scopedQuery } from './discovery.js';
import { RulesExtractor } from './extraction.js';
import type { Extractor } from './extraction.js';
import { parsePost, sha256 } from './models.js';
import type { Post } from './models.js';
import { ApifySource, HTTP, MockSource, OpenAIExtractor, ProviderError, XSource } from './providers.js';
import type { Fetcher, Source } from './providers.js';
import { BudgetExceeded, Store } from './storage.js';
import type { Cursor, Query, ScanProgress } from './storage.js';
import { errorCode, log } from './log.js';

export class Service {
  readonly http: HTTP;
  source: Source;
  extractor: Extractor;
  readonly fallback?: ApifySource;
  private busy = false;
  constructor(readonly store: Store, readonly settings: Settings, options: { fetch?: Fetcher; clock?: () => number; assertOwner?: () => void; signal?: AbortSignal } = {}) {
    this.http = new HTTP(store, settings, options.fetch, options.clock, options.assertOwner, options.signal);
    this.source = settings.source === 'x' ? new XSource(this.http, settings) : settings.source === 'apify' ? new ApifySource(this.http, settings) : new MockSource();
    this.extractor = settings.extractor === 'openai' ? new OpenAIExtractor(this.http, settings) : new RulesExtractor();
    if (settings.apify_fallback) this.fallback = new ApifySource(this.http, settings);
    store.addQuery('global', scopedQuery(settings.global_query, settings.giveaway_topic), 2, settings.global_interval_seconds);
    store.reconcileClosures();
  }
  queryText(query: Query): string {
    if (/^(profile|watch):/.test(query.key) && this.store.meta('profile:' + query.key.split(':')[1]) === 'eligible') return query.query + (query.query.includes('-is:reply') ? '' : ' -is:reply');
    return scopedQuery(query.query, this.settings.giveaway_topic);
  }
  scanKey(query: Query): string { return 'scan:' + sha256(`${this.source.name}:${this.settings.x_search_mode}:${this.queryText(query)}`); }
  observeProfile(post: Post): void {
    if (this.settings.giveaway_topic !== 'wuwa') return;
    const key = 'profile:' + post.author.toLowerCase();
    if (this.store.meta('profile_blocked:' + post.author.toLowerCase()) === 'true') return;
    if (!profileQualified(post)) {
      if (post.profile_fetched) { this.store.setMeta(key, 'ineligible'); this.store.db.prepare('DELETE FROM queries WHERE key=?').run(key); }
      return;
    }
    const queries = this.store.queries();
    if (queries.some(query => query.key === 'watch:' + post.author.toLowerCase())) { this.store.setMeta(key, 'eligible'); return; }
    if (!queries.some(query => query.key === key) && queries.filter(query => query.key.startsWith('profile:')).length >= this.settings.profile_watch_limit) return;
    this.store.setMeta(key, 'eligible');
    this.store.addQuery(key, `from:${post.author} -is:retweet -is:reply`, 3, 3600);
  }
  cursor(query: Query, now: number): Cursor {
    const old = query.cursor ? JSON.parse(query.cursor) as Cursor : null;
    const key = this.scanKey(query);
    let expired = false;
    if (old && old.source === this.source.name && (old.scan_key ?? key) === key) {
      if (this.source.name !== 'x' || this.settings.x_search_mode === 'all' || Date.parse(old.start) > now - 167 * 3600000) return old;
      expired = true;
      this.store.setMeta('coverage_warning', 'X backlog exceeded recent-search retention; window restarted');
      log('x_backlog_expired');
    }
    let start = now - this.settings.lookback_hours * 3600000, deep = false;
    if (this.source.name === 'x') {
      const checkpoint = this.store.metaJson<ScanProgress>(key, {});
      const floor = now - this.settings.backfill_hours * 3600000;
      deep = expired || !checkpoint.deep_scan_at || Date.parse(checkpoint.deep_scan_at) <= now - this.settings.backfill_interval_hours * 3600000;
      if (deep || !checkpoint.covered_until) start = floor;
      else start = Math.max(floor, Math.min(start, Date.parse(checkpoint.covered_until) - 300000));
      if (checkpoint.covered_until && Date.parse(checkpoint.covered_until) < floor) this.store.setMeta('coverage_warning', 'Outage exceeds configured backfill window; older posts may be missing');
    }
    return { source: this.source.name, scan_key: key, deep, start: new Date(start).toISOString(), end: new Date(now - 15000).toISOString(), token: null };
  }
  async poll(query: Query, now: number): Promise<void> {
    const cursor = this.cursor(query, now);
    try {
      const page = await this.source.fetch(this.queryText(query), cursor);
      cursor.token = page.next_token;
      let checkpoint: [string, ScanProgress] | undefined;
      if (this.source.name === 'x' && !page.next_token) {
        const key = this.scanKey(query), progress = this.store.metaJson<ScanProgress>(key, {});
        progress.covered_until = cursor.end;
        if (cursor.deep) progress.deep_scan_at = new Date(now).toISOString();
        checkpoint = [key, progress];
      }
      this.store.stagePage(query, page.posts, page.next_token ? cursor : null, now, checkpoint);
    } catch (error) {
      if (error instanceof ProviderError) {
        if (this.source.name === 'x' && this.fallback && error.fallback) {
          const key = 'fallback:' + query.key;
          try {
            const page = await this.fallback.fetch(query.query, { token: this.store.meta(key) || null });
            this.store.stagePage(query, page.posts, cursor, now);
            this.store.setMeta(key, page.next_token ?? '');
          } catch (fallbackError) {
            if (!(fallbackError instanceof ProviderError || fallbackError instanceof BudgetExceeded)) throw fallbackError;
            log('fallback_unavailable', { error: errorCode(fallbackError) });
          }
        }
        this.store.queryFailed(query.key, error.delay, error.code, now);
        log('query_delayed', { error: error.code });
      } else if (error instanceof BudgetExceeded) this.store.queryFailed(query.key, 3600, error.code, now);
      else throw error;
    }
  }
  async tick(now = Date.now(), signal?: AbortSignal): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (const query of this.store.dueQueries(this.settings.queries_per_tick, now)) {
        signal?.throwIfAborted(); this.store.setMeta('last_progress', new Date().toISOString());
        await this.poll(query, now);
      }
      for (const row of this.store.pending(this.settings.extraction_batch, now)) {
        signal?.throwIfAborted(); this.store.setMeta('last_progress', new Date().toISOString());
        const post = parsePost(row.body);
        this.observeProfile(post);
        if (!matchesTopic(post, this.settings.giveaway_topic)) { this.store.markFiltered(post.id); continue; }
        try {
          const extraction = await this.extractor.extract(post);
          this.store.saveExtraction(post, extraction, now, this.settings.ending_soon_minutes);
          this.store.setMeta('extraction_warning', '');
        } catch (error) {
          if (error instanceof BudgetExceeded || (error instanceof ProviderError && ['ai:cooldown', 'ai:http_429', 'ai:http_401', 'ai:http_402', 'ai:http_403'].includes(error.code))) {
            this.store.setMeta('extraction_warning', error.code); break;
          }
          if (!(error instanceof ProviderError)) throw error;
          this.store.extractionFailed(post.id, error.code, now);
        }
      }
      this.store.refreshStatuses(now, this.settings.ending_soon_minutes);
      this.store.setMeta('last_tick', new Date(now).toISOString());
      this.store.setMeta('last_progress', new Date().toISOString());
    } finally { this.busy = false; }
  }
  async run(signal: AbortSignal, notify?: () => Promise<void>): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      try {
        await this.tick(Date.now(), signal);
        if (notify) await notify();
        this.store.setMeta('worker_error', ''); failures = 0;
      } catch (error) {
        if (signal.aborted) break;
        this.store.setMeta('worker_error', errorCode(error));
        log('worker_error', { error: errorCode(error) });
        if (++failures >= 3) throw error; // Let the supervisor recover a broken worker.
      }
      try { await sleep(this.settings.poll_seconds * 1000, undefined, { signal }); }
      catch { break; }
    }
  }
}
