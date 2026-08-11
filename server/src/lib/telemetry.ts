// Server-side umami reporting. ON by default; MACARON_TELEMETRY=0 turns it off
// entirely, after which this module makes no network calls at all.
//
// umami events are NOT idempotent (each row gets a fresh uuid, no upsert), so a
// retry duplicates data rather than repairing it. Delivery is therefore
// at-most-once: one attempt per batch, failures are dropped silently.

import type { AnalyticsEvents } from '@macaron/shared';
import { INSTALL_ID } from './install-id.js';

// Our self-hosted umami instance. Hard-coded rather than env-driven: the site is
// ours and never changes per install, so an unset variable should not silently
// turn a build into a no-op. MACARON_TELEMETRY is the only switch that matters.
const HOST = 'https://u-m-a-m-i.macaron.im';
const WEBSITE_ID = '46aa3885-b86d-4f02-9ecb-b6124ea724fe';
const COLLECT_PATH = '/api/pulse';
const SCRIPT_PATH = '/u.js';

const active = !/^(0|false|no|off)$/i.test(process.env.MACARON_TELEMETRY || '');

export const telemetryConfig = { enabled: active, host: active ? HOST : '', websiteId: active ? WEBSITE_ID : '', scriptPath: SCRIPT_PATH, installId: active ? INSTALL_ID : '' };

type Pending = { name: string; data: Record<string, unknown> };
const queue: Pending[] = [];
let timer: NodeJS.Timeout | null = null;

const FLUSH_AFTER_MS = 5000;
const FLUSH_AT_COUNT = 20;

function post(batch: Pending[]): Promise<unknown> {
  return Promise.all(
    batch.map((ev) =>
      fetch(`${HOST}${COLLECT_PATH}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          // umami runs the UA through isbot and silently drops matches ({"beep":"boop"},
          // HTTP 200). isbot matches the substring "server", so this UA must NOT say
          // "macaron-server" — the server identity travels in payload.hostname instead.
          'User-Agent': `Mozilla/5.0 (${process.platform}) macaron/${process.env.npm_package_version || '0'} Chrome/131.0.0.0 Safari/537.36`,
        },
        body: JSON.stringify({ type: 'event', payload: { website: WEBSITE_ID, hostname: 'server.macaron.local', name: ev.name, data: ev.data } }),
      }).catch(() => undefined),
    ),
  );
}

function flush(): void {
  if (timer) { clearTimeout(timer); timer = null; }
  if (!queue.length) return;
  void post(queue.splice(0, queue.length));
}

export function track<K extends keyof AnalyticsEvents>(name: K, data: AnalyticsEvents[K]): void {
  if (!active) return;
  // Redact centrally so a new call site can't leak by forgetting to. Deliberately
  // a local copy of shared's redactMessage: @macaron/shared must stay types-only
  // here (see bin/mcc.mjs) — a value import survives `bun build --packages=external`
  // as a bare specifier the published tarball cannot resolve. Keep the two in sync.
  const payload: Record<string, unknown> = 'message' in data
    ? { ...data, message: data.message.replace(/\b[a-z]+:\/\/\S+/gi, '<url>').replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '<email>').replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{8,}/g, '<key>').replace(/(?:[A-Za-z]:)?(?<![\w])[\\/](?:[\w.-]+[\\/])+[\w.-]+/g, '<path>').slice(0, 200) }
    : { ...data };
  queue.push({ name, data: { ...payload, installId: INSTALL_ID } });
  if (queue.length >= FLUSH_AT_COUNT) return flush();
  timer ||= setTimeout(flush, FLUSH_AFTER_MS).unref();
}

if (active) {
  // Best-effort drain on the way out. `exit` is synchronous-only so the fetch
  // won't complete there; SIGINT/SIGTERM is where the last batch actually lands.
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, flush);
  process.once('beforeExit', flush);
}
