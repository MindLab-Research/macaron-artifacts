// Persisted session-share mappings, held in ~/.claude/macaron-shares.json.
//
// A share publishes a session behind an unguessable random token. The token
// is the capability — whoever holds the link can read the transcript; there
// is no login. The real project/sid live only on this side of the map, so a
// share URL never leaks the on-disk session id.
//
// Cache is warmed lazily on first access and persisted to disk on every
// mutation, mirroring settings-store.ts.

import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HOME } from '../config.js';

export type ShareEntry = { token: string; project: string; sid: string; createdAt: number };

const CONFIG_PATH = path.join(HOME, '.claude', 'macaron-shares.json');

let cache: ShareEntry[] | null = null;

async function load(): Promise<ShareEntry[]> {
  if (cache) return cache;
  try {
    const raw = await fs.readFile(CONFIG_PATH, 'utf8');
    const j = JSON.parse(raw) as { shares?: ShareEntry[] };
    cache = Array.isArray(j.shares) ? j.shares : [];
  } catch {
    cache = [];
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true });
  await fs.writeFile(CONFIG_PATH, JSON.stringify({ shares: cache }, null, 2), 'utf8');
}

// Idempotent: reuse an existing token for the same project+sid so re-sharing
// doesn't mint duplicates (and an old link keeps working).
export async function createShare(project: string, sid: string): Promise<string> {
  const shares = await load();
  const existing = shares.find((s) => s.project === project && s.sid === sid);
  if (existing) return existing.token;
  const token = randomUUID();
  shares.push({ token, project, sid, createdAt: Date.now() });
  await persist();
  return token;
}

// Warm the cache at startup (mirrors settings-store.ts warmSettingsCache).
// createShare is check-then-act across an `await load()`: on a cold cache, two
// concurrent first-ever shares of the same session both read an empty list and
// each mint a token — breaking idempotency and orphaning one link that Unshare
// then can't fully revoke. Warming the cache before any request serves closes
// that window; the settings store sidesteps the identical race the same way.
export async function warmShareCache(): Promise<void> {
  await load();
}

export async function resolveShare(token: string): Promise<ShareEntry | null> {
  const shares = await load();
  return shares.find((s) => s.token === token) || null;
}

// Unshare by session — the owning UI (sidebar) holds project+sid, not the
// token, so revocation keys on the session. No-op if it was never shared.
export async function deleteShareBySession(project: string, sid: string): Promise<boolean> {
  const shares = await load();
  // Remove EVERY token for this session, not just the first match. If a
  // duplicate was ever minted (e.g. a concurrent create before the cache was
  // warm), a single splice would leave a live token behind — an "Unshare" that
  // silently fails to revoke. Filtering in place keeps the contract airtight.
  const before = shares.length;
  const kept = shares.filter((s) => !(s.project === project && s.sid === sid));
  if (kept.length === before) return false;
  shares.length = 0;
  shares.push(...kept);
  await persist();
  return true;
}
