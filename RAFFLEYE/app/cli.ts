import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { loadSettings, offlineSettings } from './config.js';
import { Bot } from './bot.js';
import { errorCode, log, SafeError } from './log.js';
import { Store, RuntimeLease } from './storage.js';
import { Service } from './service.js';
import { RulesExtractor } from './extraction.js';
import { parsePost } from './models.js';
import { visible } from './presentation.js';
import { matchesTopic } from './discovery.js';

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0] ?? 'status';
  const settings = command === 'demo' ? offlineSettings() : loadSettings();
  if (['health', 'status'].includes(command)) {
    const store = new Store(settings.db_path, true);
    try {
      if (command === 'status') { console.log(JSON.stringify({ runtime: store.meta('runtime'), ...store.status() }, null, 2)); return; }
      const heartbeat = Date.parse(store.meta('heartbeat'));
      const lease = store.metaJson<{ expires: number } | null>('runtime_lease', null);
      const progress = Date.parse(store.meta('last_progress'));
      const healthy = store.meta('runtime') === 'typescript' && Number.isFinite(heartbeat) && Date.now() - heartbeat < 45000 && !!lease && lease.expires > Date.now() && store.meta('discord_connected') === 'true' && Number.isFinite(progress) && Date.now() - progress < Math.max(300000, settings.poll_seconds * 3000 + 120000);
      console.log(JSON.stringify({ healthy, pid: Number(store.meta('runtime_pid')), runtime: store.meta('runtime') }));
      if (!healthy) process.exitCode = 1;
      return;
    } finally { store.close(); }
  }
  if (!['bot', 'worker', 'demo', 'reprocess', 'backup'].includes(command)) throw new SafeError('unknown_command');
  const store = new Store(settings.db_path);
  const lease = new RuntimeLease(store), abort = new AbortController();
  let bot: Bot | undefined, heartbeat: NodeJS.Timeout | undefined;
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    lease.start(stop);
    if (command === 'backup') {
      const destination = args[1];
      if (!destination) throw new SafeError('backup_destination_required');
      mkdirSync(dirname(resolve(destination)), { recursive: true });
      await store.db.backup(destination); log('backup_complete'); return;
    }
    if (command === 'reprocess') {
      const extractor = new RulesExtractor(settings.giveaway_topic);
      const posts = store.db.prepare('SELECT body FROM posts').all() as { body: string }[];
      for (const item of posts) { lease.assert(); const post = parsePost(item.body); if (matchesTopic(post, settings.giveaway_topic)) store.saveExtraction(post, await extractor.extract(post), Date.now(), settings.ending_soon_minutes, settings.giveaway_topic); }
      for (const item of store.list(10000, row => visible(row, settings.giveaway_topic))) store.queue(item.id, item.revision);
      log('reprocessed', { posts: posts.length }); return;
    }
    const service = new Service(store, settings, { assertOwner: () => lease.assert(), signal: abort.signal });
    if (command === 'demo') { await service.tick(); console.log(JSON.stringify(store.status(), null, 2)); return; }
    store.setMeta('runtime', 'typescript'); store.setMeta('runtime_pid', process.pid);
    store.setMeta('last_progress', new Date().toISOString());
    store.setMeta('worker_error', '');
    const stopFile = resolve(dirname(settings.db_path), `stop-${process.pid}`);
    const beat = () => {
      if (existsSync(stopFile)) abort.abort();
      store.setMeta('heartbeat', new Date().toISOString());
      store.setMeta('discord_connected', String(bot?.client.isReady() ?? false));
    };
    const metadata = resolve(dirname(settings.db_path), 'typescript-process.json');
    writeFileSync(metadata, JSON.stringify({ pid: process.pid, started_at: new Date().toISOString(), stop_file: stopFile, runtime: 'typescript' }));
    beat(); heartbeat = setInterval(beat, 10000);
    if (command === 'bot') { bot = new Bot(service, () => lease.assert(), abort.signal); await bot.start(); }
    beat();
    await service.run(abort.signal, bot ? () => bot!.notify() : undefined);
    lease.assert();
  } finally {
    abort.abort(); if (heartbeat) clearInterval(heartbeat);
    await bot?.close(); lease.release(); store.close();
    process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
main().catch(error => { log('fatal', { error: errorCode(error) }); process.exitCode = 1; });
