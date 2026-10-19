import { access, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { chromium } from 'playwright';
import type { Settings } from './config.js';
import { sha256 } from './models.js';
import type { Post } from './models.js';
import { errorCode, log, SafeError } from './log.js';

export class PostScreenshots {
  private tail: Promise<unknown> = Promise.resolve();
  readonly directory: string;
  constructor(private readonly settings: Settings, private readonly signal?: AbortSignal) { this.directory = join(dirname(settings.db_path), 'post-screenshots'); }
  cachePath(post: Pick<Post,'id'|'text'>): string { return join(this.directory, `${post.id}-${sha256(post.text).slice(0, 12)}.png`); }
  async get(post: Post): Promise<string | null> {
    if (!this.settings.post_screenshots || post.source === 'mock' || this.signal?.aborted) return null;
    const operation = this.tail.then(() => this.getLocked(post));
    this.tail = operation.catch(() => {});
    return operation;
  }
  async getById(id: string): Promise<string | null> {
    if (!/^\d{1,30}$/.test(id)) throw new SafeError('Invalid X post ID.');
    if (!this.settings.post_screenshots || this.signal?.aborted) return null;
    const operation = this.tail.then(()=>this.getLocked({id,text:'headsup-public-embed'}));
    this.tail=operation.catch(()=>{});return operation;
  }
  private async valid(path: string): Promise<boolean> {
    try {
      const info = await stat(path);
      if (info.size <= 8 || info.size > 8000000) return false;
      const data = await readFile(path);
      return data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    } catch { return false; }
  }
  private async getLocked(post: Pick<Post,'id'|'text'>): Promise<string | null> {
    const path = this.cachePath(post), failure = path.replace(/\.png$/, '.failed'), temporary = path.replace(/\.png$/, '.tmp.png');
    if (await this.valid(path)) return path;
    try { if (Date.now() - (await stat(failure)).mtimeMs < 3600000) return null; } catch { /* no failure cache */ }
    if (this.signal?.aborted) return null;
    await mkdir(this.directory, { recursive: true });
    try {
      await this.capture(post, temporary);
      if (!(await this.valid(temporary))) throw new SafeError('invalid_screenshot');
      await rename(temporary, path);
      await rm(failure, { force: true });
      return path;
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => {});
      if (!this.signal?.aborted) await writeFile(failure, '').catch(() => {});
      log('screenshot_unavailable', { error: errorCode(error) });
      return null;
    }
  }
  async capture(post: Pick<Post,'id'>, destination: string): Promise<void> {
    this.signal?.throwIfAborted();
    const browser = await chromium.launch({ headless: true, ...(this.settings.screenshot_browser_channel ? { channel: this.settings.screenshot_browser_channel } : {}) });
    const close = () => { void browser.close().catch(() => {}); };
    const timeout = setTimeout(close, 45000);
    this.signal?.addEventListener('abort', close, { once: true });
    try {
      const page = await browser.newPage({ viewport: { width: 620, height: 2400 }, deviceScaleFactor: 2, locale: 'en-US' });
      page.setDefaultTimeout(15000);
      await page.setContent('<html><body style="margin:0;background:white"><div id="post"></div></body></html>');
      await page.addScriptTag({ url: 'https://platform.twitter.com/widgets.js' });
      await page.waitForFunction('window.twttr && twttr.widgets');
      await page.evaluate(async id => {
        const api = (window as unknown as { twttr: { widgets: { createTweet(id: string, node: HTMLElement | null, options: Record<string, unknown>): Promise<unknown> } } }).twttr;
        await api.widgets.createTweet(id, document.getElementById('post'), { conversation: 'none', cards: 'visible', theme: 'light', dnt: true, width: 550 });
      }, post.id);
      const frame = page.frames().find(item => item.url().startsWith('https://platform.twitter.com/embed/Tweet.html'));
      if (!frame) throw new SafeError('official_embed_missing');
      const article = frame.locator('article').first();
      await article.waitFor({ state: 'visible' });
      await article.locator('[data-testid="tweetText"]').first().waitFor({ state: 'visible' });
      const timestamp = article.locator(`a[href*="/status/${post.id}"] time`).last();
      await timestamp.waitFor({ state: 'visible' });
      await article.evaluate(async element => {
        await Promise.all([...element.querySelectorAll('img')].map(image => image.decode().catch(() => {})));
        element.querySelectorAll('video').forEach(video => video.pause());
      });
      const bounds = await article.boundingBox(), end = await timestamp.boundingBox();
      if (!bounds || !end) throw new SafeError('post_bounds_missing');
      const height = end.y + end.height + 12 - bounds.y;
      if (height < 100 || height > 6000 || bounds.width < 300 || bounds.width > 600) throw new SafeError('unexpected_post_geometry');
      await page.screenshot({ path: destination, clip: { x: bounds.x, y: bounds.y, width: bounds.width, height }, animations: 'disabled' });
    } finally { clearTimeout(timeout); this.signal?.removeEventListener('abort', close); await browser.close(); }
  }
  async browserAvailable(): Promise<boolean> {
    if (!this.settings.post_screenshots) return true;
    if (this.settings.screenshot_browser_channel) return true; // Launch probe happens during the deployment smoke test.
    try { await access(chromium.executablePath()); return true; } catch { return false; }
  }
}
