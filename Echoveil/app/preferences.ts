import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

// Preferences only: no confession text, post IDs, or submission history.
export class Preferences {
  private hidden = new Set<string>();
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) {
      const data: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!Array.isArray(data) || !data.every(id => typeof id === 'string')) {
        throw new Error('Invalid preferences file.');
      }
      this.hidden = new Set(data);
    }
  }
  confirmations(userId: string): boolean { return !this.hidden.has(userId); }
  setConfirmations(userId: string, enabled: boolean): void {
    const next = new Set(this.hidden);
    if (enabled) next.delete(userId); else next.add(userId);
    if (this.path) {
      mkdirSync(dirname(this.path), { recursive: true });
      writeFileSync(`${this.path}.tmp`, JSON.stringify([...next]), { mode: 0o600 });
      renameSync(`${this.path}.tmp`, this.path);
    }
    this.hidden = next;
  }
}
