/** Never serialize errors, settings, HTTP bodies, or headers into operator logs. */
export function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  process.stdout.write(JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
}

export class SafeError extends Error {
  constructor(public readonly code: string) { super(code); this.name = 'SafeError'; }
}

export function errorCode(error: unknown): string {
  return error instanceof SafeError ? error.code : error instanceof Error ? error.name : 'UnknownError';
}
