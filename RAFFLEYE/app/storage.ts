import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { campaignHash, contentHash, grounded, parseExtraction, parsePost, qualified, statusOf, terminal } from './models.js';
import type { Extraction, Post, State } from './models.js';
import { SafeError } from './log.js';
import { closureSignal, linkedPosts } from './lifecycle.js';

export interface Query { key: string; query: string; priority: number; interval_s: number; next_due: number; cursor: string | null; last_ok: string | null; error: string | null }
export interface Cursor { source: string; scan_key?: string; deep?: boolean; start: string; end: string; token: string | null }
export interface ScanProgress { covered_until?: string; deep_scan_at?: string }
export interface RawPost { id: string; hash: string; body: string; processed: number; attempts: number; available: number; error: string | null; seen_at: string }
export interface GiveawayRow { id: string; hash: string; post: string; extraction: string; status: State; revision: number; updated_at: string }
export interface Delivery { channel_id: string; post_id: string; revision: number; attempts: number; available: number; error: string | null; message_id: string | null }
export interface Subscription { guild_id: string; channel_id: string }
export class BudgetExceeded extends SafeError { constructor(public readonly period: string, public readonly metric: string) { super(`${period} ${metric} limit reached`); } }
const schema = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS posts(id TEXT PRIMARY KEY,hash TEXT NOT NULL,body TEXT NOT NULL,processed INTEGER NOT NULL DEFAULT 0,attempts INTEGER NOT NULL DEFAULT 0,available REAL NOT NULL DEFAULT 0,error TEXT,seen_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS pending_posts ON posts(processed,available);
CREATE TABLE IF NOT EXISTS giveaways(id TEXT PRIMARY KEY,hash TEXT NOT NULL,post TEXT NOT NULL,extraction TEXT NOT NULL,status TEXT NOT NULL,revision INTEGER NOT NULL,updated_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS giveaway_hash ON giveaways(hash);
CREATE TABLE IF NOT EXISTS queries(key TEXT PRIMARY KEY,query TEXT NOT NULL,priority INTEGER NOT NULL,interval_s INTEGER NOT NULL,next_due REAL NOT NULL DEFAULT 0,cursor TEXT,last_ok TEXT,error TEXT);
CREATE TABLE IF NOT EXISTS budgets(period TEXT NOT NULL,metric TEXT NOT NULL,used REAL NOT NULL,PRIMARY KEY(period,metric));
CREATE TABLE IF NOT EXISTS subscriptions(guild_id TEXT PRIMARY KEY,channel_id TEXT NOT NULL UNIQUE);
CREATE TABLE IF NOT EXISTS deliveries(channel_id TEXT NOT NULL,post_id TEXT NOT NULL,message_id TEXT NOT NULL,PRIMARY KEY(channel_id,post_id));
CREATE TABLE IF NOT EXISTS outbox(channel_id TEXT NOT NULL,post_id TEXT NOT NULL,revision INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,available REAL NOT NULL DEFAULT 0,error TEXT,PRIMARY KEY(channel_id,post_id));
INSERT OR IGNORE INTO meta VALUES('schema_version','1');`;

export class Store {
  readonly db: Database.Database;
  constructor(public readonly path: string, readonly = false) {
    if (path !== ':memory:' && !readonly) mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { readonly, fileMustExist: readonly, timeout: 10000 });
    this.db.pragma('foreign_keys = ON');
    if (!readonly) { this.db.pragma('journal_mode = WAL'); this.db.exec(schema); }
    if (this.meta('schema_version') !== '1') { this.db.close(); throw new SafeError('unsupported_database_schema'); }
  }
  close(): void { this.db.close(); }
  transaction<T>(action: () => T): T { return this.db.transaction(action).immediate(); }
  meta(key: string, fallback = ''): string {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value: string } | undefined)?.value ?? fallback;
  }
  setMeta(key: string, value: string | number): void { this.db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)').run(key, String(value)); }
  metaJson<T>(key: string, fallback: T): T {
    const value = this.meta(key);
    if (!value) return fallback;
    try { return JSON.parse(value) as T; } catch { throw new SafeError('invalid_persisted_metadata'); }
  }
  usage(period = `day:${new Date().toISOString().slice(0, 10)}`): Record<string, number> {
    const rows = this.db.prepare('SELECT metric,used FROM budgets WHERE period=?').all(period) as { metric: string; used: number }[];
    return Object.fromEntries(rows.map(row => [row.metric, row.used]));
  }
  reserve(metrics: Record<string, number>, limits: Record<string, number>, monthlyUsd: number, now = Date.now()): void {
    const iso = new Date(now).toISOString();
    const entries: [string, string, number, number][] = Object.entries(metrics).map(([key, amount]) => [`day:${iso.slice(0, 10)}`, key, amount, limits[key] ?? 0]);
    entries.push([`month:${iso.slice(0, 7)}`, 'estimated_usd', metrics.estimated_usd ?? 0, monthlyUsd]);
    this.transaction(() => {
      for (const [period, key, amount, limit] of entries) {
        if (!Number.isFinite(amount) || amount < 0 || !Number.isFinite(limit) || limit < 0) throw new SafeError('invalid_budget');
        const used = (this.db.prepare('SELECT used FROM budgets WHERE period=? AND metric=?').get(period, key) as { used: number } | undefined)?.used ?? 0;
        if (used + amount > limit + 1e-9) throw new BudgetExceeded(period, key);
      }
      for (const [period, key, amount] of entries) this.db.prepare('INSERT INTO budgets VALUES (?,?,?) ON CONFLICT(period,metric) DO UPDATE SET used=used+excluded.used').run(period, key, amount);
    });
  }
  addQuery(key: string, query: string, priority: number, interval: number): void {
    this.db.prepare(`INSERT INTO queries(key,query,priority,interval_s) VALUES (?,?,?,?) ON CONFLICT(key) DO UPDATE SET
      cursor=CASE WHEN queries.query=excluded.query THEN queries.cursor ELSE NULL END,
      query=excluded.query,priority=excluded.priority,interval_s=excluded.interval_s`).run(key, query, priority, interval);
  }
  queries(): Query[] { return this.db.prepare('SELECT * FROM queries ORDER BY priority,key').all() as Query[]; }
  watch(handle: string, priority = 2): void {
    handle = handle.replace(/^@+/, '').toLowerCase();
    if (!/^[A-Za-z0-9_]{1,15}$/.test(handle) || ![1, 2, 3].includes(priority)) throw new SafeError('Use an X handle and priority 1, 2, or 3.');
    this.addQuery('watch:' + handle, `from:${handle} -is:retweet`, priority, [0, 300, 900, 3600][priority]!);
  }
  unwatch(handle: string): void { this.db.prepare('DELETE FROM queries WHERE key=?').run('watch:' + handle.replace(/^@+/, '').toLowerCase()); }
  dueQueries(limit: number, now: number): Query[] {
    const rows = this.db.prepare('SELECT * FROM queries WHERE next_due<=? ORDER BY next_due,priority,key').all(now / 1000) as Query[];
    return [...rows.filter(q => q.key === 'global'), ...rows.filter(q => q.key !== 'global')].slice(0, limit);
  }
  queryFailed(key: string, delay: number, error: string, now: number): void {
    this.db.prepare('UPDATE queries SET next_due=?,error=? WHERE key=?').run(now / 1000 + Math.max(10, delay), error.slice(0, 200), key);
  }
  stagePage(query: Query, posts: Post[], cursor: Cursor | null, now: number, checkpoint?: [string, ScanProgress]): void {
    this.transaction(() => {
      if (checkpoint) this.setMeta(checkpoint[0], JSON.stringify(checkpoint[1]));
      for (const post of posts) this.db.prepare(`INSERT INTO posts(id,hash,body,seen_at) VALUES (?,?,?,?) ON CONFLICT(id) DO UPDATE SET
        processed=CASE WHEN posts.hash=excluded.hash THEN posts.processed ELSE 0 END,
        attempts=CASE WHEN posts.hash=excluded.hash THEN posts.attempts ELSE 0 END,
        available=CASE WHEN posts.hash=excluded.hash THEN posts.available ELSE 0 END,
        hash=excluded.hash,body=excluded.body,seen_at=excluded.seen_at`).run(post.id, contentHash(post), JSON.stringify(post), new Date(now).toISOString());
      this.db.prepare('UPDATE queries SET cursor=?,next_due=?,last_ok=?,error=NULL WHERE key=?').run(cursor ? JSON.stringify(cursor) : null, now / 1000 + (cursor ? 10 : query.interval_s), new Date(now).toISOString(), query.key);
      for (const post of posts) this.observeClosure(post, now);
    });
  }
  pending(limit: number, now: number): RawPost[] { return this.db.prepare('SELECT * FROM posts WHERE processed=0 AND attempts<5 AND available<=? ORDER BY seen_at,id LIMIT ?').all(now / 1000, limit) as RawPost[]; }
  markFiltered(id: string): void { this.db.prepare('UPDATE posts SET processed=1,error=NULL WHERE id=?').run(id); }
  extractionFailed(id: string, error: string, now: number): void { this.db.prepare('UPDATE posts SET attempts=attempts+1,available=?,error=? WHERE id=?').run(now / 1000 + 300, error.slice(0, 200), id); }
  retryFailed(): void { this.transaction(() => { this.db.exec('UPDATE posts SET attempts=0,available=0,error=NULL WHERE processed=0; UPDATE outbox SET attempts=0,available=0,error=NULL;'); }); }
  giveaway(id: string): GiveawayRow | undefined { return this.db.prepare('SELECT * FROM giveaways WHERE id=?').get(id) as GiveawayRow | undefined; }
  list(limit = 10, predicate: (row: GiveawayRow) => boolean = () => true): GiveawayRow[] {
    const rows: GiveawayRow[] = [];
    for (const item of this.db.prepare('SELECT * FROM giveaways ORDER BY updated_at DESC,id DESC').iterate()) {
      const row = item as GiveawayRow;
      if (predicate(row)) rows.push(row);
      if (rows.length >= limit) break;
    }
    return rows;
  }
  queue(id: string, revision: number, channel?: string): void {
    const row = this.giveaway(id);
    const channels = channel ? [channel] : this.subscriptions().map(subscription => subscription.channel_id);
    for (const channelId of channels) {
      if (row && terminal(row.status) && !this.db.prepare('SELECT 1 FROM deliveries WHERE channel_id=? AND post_id=?').get(channelId, id) && !this.db.prepare('SELECT 1 FROM outbox WHERE channel_id=? AND post_id=?').get(channelId, id)) continue;
      this.db.prepare(`INSERT INTO outbox(channel_id,post_id,revision) VALUES (?,?,?) ON CONFLICT(channel_id,post_id) DO UPDATE SET revision=excluded.revision,attempts=0,available=0,error=NULL`).run(channelId, id, revision);
    }
  }
  saveExtraction(post: Post, extraction: Extraction, now: number, endingMinutes: number): void {
    extraction = grounded(extraction, post);
    this.transaction(() => {
      this.markFiltered(post.id);
      if (!qualified(extraction)) { this.db.prepare('DELETE FROM outbox WHERE post_id=?').run(post.id); this.db.prepare('DELETE FROM giveaways WHERE id=?').run(post.id); return; }
      const hash = contentHash(post);
      if (this.db.prepare('SELECT 1 FROM giveaways WHERE hash=? AND id<>?').get(hash, post.id)) return;
      const others = this.db.prepare("SELECT post FROM giveaways WHERE json_extract(post,'$.author')=? COLLATE NOCASE AND id<>?").all(post.author, post.id) as { post: string }[];
      if (others.some(other => campaignHash(parsePost(other.post)) === campaignHash(post))) return;
      const old = this.giveaway(post.id);
      const closure = this.metaJson<{ state: State; author: string; created_at: string } | null>('closure:' + post.id, null);
      const payload = JSON.stringify(extraction), status = closure && closure.author.toLowerCase() === post.author.toLowerCase() && Date.parse(closure.created_at) >= Date.parse(post.created_at) ? closure.state : statusOf(extraction, now, endingMinutes);
      if (old && JSON.stringify(JSON.parse(old.extraction)) === payload && old.status === status && old.hash === hash) return;
      const revision = (old?.revision ?? 0) + 1;
      this.db.prepare('INSERT OR REPLACE INTO giveaways VALUES (?,?,?,?,?,?,?)').run(post.id, hash, JSON.stringify(post), payload, status, revision, new Date(now).toISOString());
      this.queue(post.id, revision);
    });
  }
  observeClosure(post: Post, now = Date.now()): void {
    const signal = closureSignal(post.text);
    if (!signal) return;
    for (const id of linkedPosts(post)) {
      const target = this.giveaway(id);
      if (target) {
        const original = parsePost(target.post);
        if (original.author.toLowerCase() !== post.author.toLowerCase() || Date.parse(post.created_at) < Date.parse(original.created_at)) continue;
      }
      this.setMeta('closure:' + id, JSON.stringify({ ...signal, author: post.author, source_id: post.id, created_at: post.created_at }));
      if (!target || target.status === signal.state) continue;
      this.db.prepare('UPDATE giveaways SET status=?,revision=revision+1,updated_at=? WHERE id=?').run(signal.state, new Date(now).toISOString(), id);
      this.db.prepare('DELETE FROM outbox WHERE post_id=?').run(id);
      const deliveries = this.db.prepare('SELECT channel_id FROM deliveries WHERE post_id=?').all(id) as { channel_id: string }[];
      for (const delivery of deliveries) this.queue(id, target.revision + 1, delivery.channel_id);
    }
  }
  reconcileClosures(): void {
    this.transaction(() => {
      for (const item of this.db.prepare('SELECT body FROM posts').all() as {body:string}[]) this.observeClosure(parsePost(item.body));
    });
  }
  refreshStatuses(now: number, endingMinutes: number): void {
    this.transaction(() => {
      for (const row of this.db.prepare("SELECT * FROM giveaways WHERE status NOT IN ('ended','cancelled')").all() as GiveawayRow[]) {
        const status = statusOf(parseExtraction(JSON.parse(row.extraction)), now, endingMinutes);
        if (status === row.status) continue;
        this.db.prepare('UPDATE giveaways SET status=?,revision=?,updated_at=? WHERE id=?').run(status, row.revision + 1, new Date(now).toISOString(), row.id);
        this.queue(row.id, row.revision + 1);
      }
    });
  }
  subscriptions(): Subscription[] { return this.db.prepare('SELECT * FROM subscriptions').all() as Subscription[]; }
  subscription(guildId: string): string | undefined { return (this.db.prepare('SELECT channel_id FROM subscriptions WHERE guild_id=?').get(guildId) as { channel_id: string } | undefined)?.channel_id; }
  subscribe(guildId: string, channelId: string): void {
    this.transaction(() => {
      const old = this.subscription(guildId);
      if (old && old !== channelId) this.db.prepare('DELETE FROM outbox WHERE channel_id=?').run(old);
      this.db.prepare('INSERT OR REPLACE INTO subscriptions VALUES (?,?)').run(guildId, channelId);
      const rows = this.db.prepare("SELECT * FROM giveaways WHERE status NOT IN ('ended','cancelled') ORDER BY updated_at DESC,id DESC LIMIT 25").all() as GiveawayRow[];
      for (const row of rows) this.queue(row.id, row.revision, channelId);
    });
  }
  unsubscribe(guildId: string): void {
    this.transaction(() => {
      this.db.prepare('DELETE FROM outbox WHERE channel_id IN (SELECT channel_id FROM subscriptions WHERE guild_id=?)').run(guildId);
      this.db.prepare('DELETE FROM subscriptions WHERE guild_id=?').run(guildId);
    });
  }
  paused(channelId: string): boolean { return this.meta('notifications_paused:' + channelId) === 'true'; }
  setPaused(channelId: string, paused: boolean): void { this.setMeta('notifications_paused:' + channelId, String(paused)); }
  pendingNotifications(now: number): Delivery[] {
    return this.db.prepare(`SELECT o.*,d.message_id FROM outbox o LEFT JOIN deliveries d ON o.channel_id=d.channel_id AND o.post_id=d.post_id
      WHERE o.available<=? AND o.attempts<8 ORDER BY CASE WHEN d.message_id IS NULL THEN 1 ELSE 0 END,o.available,o.post_id LIMIT 25`).all(now / 1000) as Delivery[];
  }
  discardNotification(item: Delivery): void { this.db.prepare('DELETE FROM outbox WHERE channel_id=? AND post_id=? AND revision=?').run(item.channel_id, item.post_id, item.revision); }
  delivered(item: Delivery, messageId: string): void {
    this.transaction(() => { this.db.prepare('INSERT OR REPLACE INTO deliveries VALUES (?,?,?)').run(item.channel_id, item.post_id, messageId); this.discardNotification(item); });
  }
  deliveryFailed(item: Delivery, error: string, now: number): void {
    this.db.prepare('UPDATE outbox SET attempts=attempts+1,available=?,error=? WHERE channel_id=? AND post_id=? AND revision=?').run(now / 1000 + Math.min(3600, 30 * 2 ** item.attempts), error.slice(0, 200), item.channel_id, item.post_id, item.revision);
  }
  count(sql: string): number { return (this.db.prepare(sql).get() as { count: number }).count; }
  status() {
    return {
      giveaways: this.count('SELECT COUNT(*) AS count FROM giveaways'),
      pending_extractions: this.count('SELECT COUNT(*) AS count FROM posts WHERE processed=0'),
      quarantined_extractions: this.count('SELECT COUNT(*) AS count FROM posts WHERE processed=0 AND attempts>=5'),
      pending_notifications: this.count('SELECT COUNT(*) AS count FROM outbox'),
      failed_notifications: this.count('SELECT COUNT(*) AS count FROM outbox WHERE attempts>=8'),
      query_errors: Object.fromEntries(this.queries().filter(q => q.error).map(q => [q.key, q.error])),
      last_tick: this.meta('last_tick'), last_progress: this.meta('last_progress'),
      worker_error: this.meta('worker_error'), coverage_warning: this.meta('coverage_warning'), extraction_warning: this.meta('extraction_warning'),
      usage_today: this.usage(), usage_month: this.usage(`month:${new Date().toISOString().slice(0, 7)}`),
    };
  }
}

interface LeaseRecord { owner: string; expires: number }
export class RuntimeLease {
  readonly owner = randomUUID();
  private timer?: NodeJS.Timeout;
  private lost = false;
  constructor(private readonly store: Store, private readonly clock: () => number = Date.now) {}
  acquire(): void {
    this.store.transaction(() => {
      const old = this.store.metaJson<LeaseRecord | null>('runtime_lease', null);
      if (old && old.expires > this.clock()) throw new SafeError('another_raffleye_worker_is_running');
      this.store.setMeta('runtime_lease', JSON.stringify({ owner: this.owner, expires: this.clock() + 60000 }));
    });
  }
  start(onLost: () => void): void {
    this.acquire();
    this.timer = setInterval(() => {
      try { this.renew(); } catch { this.lost = true; onLost(); }
    }, 10000);
    this.timer.unref();
  }
  assert(): void {
    const old = this.store.metaJson<LeaseRecord | null>('runtime_lease', null);
    if (this.lost || !old || old.owner !== this.owner || old.expires <= this.clock()) throw new SafeError('worker_lease_lost');
  }
  renew(): void {
    this.store.transaction(() => { this.assert(); this.store.setMeta('runtime_lease', JSON.stringify({ owner: this.owner, expires: this.clock() + 60000 })); });
  }
  release(): void {
    if (this.timer) clearInterval(this.timer);
    this.store.transaction(() => {
      if (this.store.metaJson<LeaseRecord | null>('runtime_lease', null)?.owner === this.owner) this.store.db.prepare('DELETE FROM meta WHERE key=?').run('runtime_lease');
    });
  }
}
