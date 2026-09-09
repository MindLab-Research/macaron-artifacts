import { execFile } from 'node:child_process';
import type { ResolvedProfile } from './types.js';

/** A callback producer can fail while its consumer is awaiting the next native event. */
export class EventQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private wake?: () => void;
  private ended = false;
  private error?: unknown;
  push(value: T) { if (!this.ended) { this.values.push(value); this.wake?.(); } }
  end() { this.ended = true; this.wake?.(); }
  fail(error: unknown) { this.error = error; this.end(); }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.values.length) { yield this.values.shift()!; continue; }
      if (this.error) throw this.error;
      if (this.ended) return;
      await new Promise<void>((resolve) => { this.wake = resolve; });
      this.wake = undefined;
    }
  }
}

export function record(value: unknown): Record<string, unknown> { return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}; }
export function string(value: unknown): string { return typeof value === 'string' ? value : ''; }
export function abortError(): Error { return new DOMException('The turn was interrupted', 'AbortError'); }
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError());
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export function executableVersion(binary: string): Promise<string | undefined> {
  return new Promise((resolve) => execFile(binary, ['--version'], { timeout: 5000, maxBuffer: 4096 }, (error, stdout) => resolve(error ? undefined : stdout.trim())));
}

// Native diagnostics occasionally include authorization headers; never expose those in the WebUI.
export function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]').replace(/\bsk-[A-Za-z0-9_-]+/g, '[redacted]');
}

/** Providers use arbitrary key formats. Mask the actual captured credentials before errors reach journals, clients or logs. */
export function safeProfileError(error: unknown, profile?: ResolvedProfile): string {
  const secrets = new Set([profile?.apiKey, profile?.authToken]);
  const remember = (value: unknown) => { if (typeof value === 'string' && value) { secrets.add(value); if (/^(Bearer|Basic)\s+/i.test(value)) secrets.add(value.replace(/^\S+\s+/, '')); } };
  for (const provider of Object.values(record(profile?.nativeConfig?.model_providers))) {
    const config = record(provider);
    remember(config.experimental_bearer_token); remember(process.env[string(config.env_key)]);
    for (const [header, value] of Object.entries(record(config.http_headers))) if (/^(authorization|x-api-key|api-key)$/i.test(header)) remember(value);
    for (const [header, key] of Object.entries(record(config.env_http_headers))) if (/^(authorization|x-api-key|api-key)$/i.test(header)) remember(process.env[string(key)]);
  }
  const message = error instanceof Error ? error.message : String(error);
  const redacted = [...secrets].filter((secret): secret is string => Boolean(secret)).sort((a, b) => b.length - a.length).reduce((text, secret) => text.split(secret).join('[redacted]'), message);
  return safeError(redacted);
}
