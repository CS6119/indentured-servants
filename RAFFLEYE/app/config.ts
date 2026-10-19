import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'dotenv';
import { z } from 'zod';
import { SafeError } from './log.js';

const bool = (fallback: boolean) => z.preprocess(value => {
  if (typeof value !== 'string') return value;
  if (['true', '1', 'yes'].includes(value.toLowerCase())) return true;
  if (['false', '0', 'no'].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean().default(fallback));
const integer = (fallback: number, min: number, max = Number.MAX_SAFE_INTEGER) => z.coerce.number().int().min(min).max(max).default(fallback);
const amount = (fallback: number) => z.coerce.number().finite().min(0).default(fallback);

export const SettingsSchema = z.object({
  source: z.enum(['mock', 'x', 'apify']).default('mock'),
  extractor: z.enum(['rules', 'openai']).default('rules'),
  giveaway_topic: z.enum(['all', 'wuwa']).default('all'),
  profile_watch_limit: integer(5, 0, 20),
  notification_interval_seconds: integer(300, 60, 86400),
  post_screenshots: bool(false),
  screenshot_browser_channel: z.enum(['', 'msedge', 'chrome']).default(''),
  db_path: z.string().default('data/raffleye.sqlite3'),
  x_bearer_token: z.string().default(''),
  apify_token: z.string().default(''),
  apify_dataset_id: z.string().default(''),
  apify_authorized: bool(false),
  apify_fallback: bool(false),
  openai_api_key: z.string().default(''),
  openai_model: z.string().default(''),
  discord_token: z.string().default(''),
  // Snowflakes must never pass through Number: Python IDs exceed JS safe integers.
  discord_guild_id: z.string().regex(/^\d*$/).default(''),
  global_query: z.string().default('(giveaway OR sweepstakes OR 抽獎) -is:retweet'),
  poll_seconds: integer(60, 10),
  global_interval_seconds: integer(900, 60),
  lookback_hours: integer(24, 1, 144),
  x_search_mode: z.enum(['recent', 'all']).default('recent'),
  backfill_hours: integer(144, 1, 8760),
  backfill_interval_hours: integer(24, 1, 168),
  page_size: integer(25, 10, 100),
  queries_per_tick: integer(4, 2, 50),
  extraction_batch: integer(25, 1, 100),
  daily_x_requests: integer(100, 0),
  daily_x_posts: integer(2500, 0),
  daily_apify_requests: integer(50, 0),
  daily_ai_requests: integer(100, 0),
  daily_estimated_usd: amount(2),
  monthly_estimated_usd: amount(20),
  x_request_reserve_usd: amount(0),
  apify_request_reserve_usd: amount(0),
  ai_request_reserve_usd: amount(0),
  ai_max_output_tokens: integer(2500, 500, 8000),
  max_post_chars: integer(12000, 1000, 30000),
  ending_soon_minutes: integer(60, 1),
});
export type Settings = z.infer<typeof SettingsSchema>;

export function loadSettings(options: { env?: NodeJS.ProcessEnv; envFile?: string | false; overrides?: Partial<Settings> } = {}): Settings {
  const envFile = options.envFile === undefined ? '.env' : options.envFile;
  const file = envFile && existsSync(envFile) ? parse(readFileSync(envFile)) : {};
  const env = { ...file, ...(options.env ?? process.env) };
  const values = Object.fromEntries(Object.keys(SettingsSchema.shape).map(key => [key, env['RAFFLEYE_' + key.toUpperCase()]]));
  const parsed = SettingsSchema.safeParse({ ...values, ...options.overrides });
  if (!parsed.success) throw new SafeError('configuration_invalid');
  const settings = parsed.data;
  settings.db_path = settings.db_path === ':memory:' ? ':memory:' : resolve(settings.db_path);
  if (settings.x_search_mode === 'recent' && settings.backfill_hours > 144) throw new SafeError('recent_backfill_exceeds_144_hours');
  if (settings.source === 'x' && (!settings.x_bearer_token || settings.x_request_reserve_usd <= 0)) throw new SafeError('x_credentials_or_reserve_missing');
  if ((settings.source === 'apify' || settings.apify_fallback) && (!settings.apify_authorized || !settings.apify_token || !settings.apify_dataset_id || settings.apify_request_reserve_usd <= 0)) throw new SafeError('apify_authorization_or_configuration_missing');
  if (settings.extractor === 'openai' && (!settings.openai_api_key || !settings.openai_model || settings.ai_request_reserve_usd <= 0)) throw new SafeError('ai_credentials_or_reserve_missing');
  return settings;
}

export function offlineSettings(dbPath = 'data/demo-ts.sqlite3'): Settings {
  return loadSettings({ env: {}, envFile: false, overrides: { db_path: dbPath } });
}
