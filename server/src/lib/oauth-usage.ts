// Reads the ambient Claude Code OAuth login and fetches rate-limit / usage
// state from Anthropic's oauth/usage endpoint. Same source terminal `claude`
// and macaron's `system` provider already use — no extra auth or config.
//
// Ported from adeotek/claude-code-webui's oauthUsage.ts (2-min success cache,
// 1-h back-off on auth errors, serve-stale on transient failures), minus its
// SQLite disk cache — macaron has no DB and an in-memory cache is plenty for
// an always-visible widget that survives as long as the server does.

import fs from 'node:fs';
import path from 'node:path';
import { HOME } from '../config.js';

export type RateLimitWindow = { utilization: number; resetsAt: string | null };
export type OAuthUsage = { fiveHour: RateLimitWindow | null; sevenDay: RateLimitWindow | null };

const CACHE_TTL_MS = 120_000;        // 2 min — matches the endpoint's own caching
const ERROR_TTL_MS = 60 * 60_000;    // 1 h back-off on auth/permission errors

let cache: { data: OAuthUsage | null; expiresAt: number } | null = null;
let lastGoodData: OAuthUsage | null = null;

function readToken(): string | null {
  try {
    const raw = fs.readFileSync(path.join(HOME, '.claude', '.credentials.json'), 'utf8');
    const creds = JSON.parse(raw) as Record<string, unknown>;
    const oauth = creds.claudeAiOauth as Record<string, unknown> | undefined;
    return typeof oauth?.accessToken === 'string' ? oauth.accessToken : null;
  } catch {
    return null;   // no ambient OAuth login (custom-provider users land here)
  }
}

function parseWindow(w: Record<string, unknown> | undefined): RateLimitWindow | null {
  if (!w) return null;
  const utilization = Number(w.utilization ?? 0);
  return {
    utilization: Number.isFinite(utilization) ? Math.round(utilization) : 0,
    resetsAt: typeof w.resets_at === 'string' ? w.resets_at : null,
  };
}

// Returns null when there's no login to read or the endpoint is unreachable —
// the caller maps that to `available: false` and the widget hides itself.
export async function fetchOAuthUsage(): Promise<OAuthUsage | null> {
  if (cache && Date.now() < cache.expiresAt) return cache.data;

  const token = readToken();
  if (!token) {
    cache = { data: null, expiresAt: Date.now() + CACHE_TTL_MS };
    return null;
  }

  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'anthropic-beta': 'oauth-2025-04-20',
      },
      signal: AbortSignal.timeout(5_000),
    });

    if (!res.ok) {
      if (res.status === 401 || res.status === 403) {
        // Credentials invalid/expired — evict and back off for an hour.
        cache = { data: null, expiresAt: Date.now() + ERROR_TTL_MS };
        lastGoodData = null;
        return null;
      }
      // Transient (429, 5xx) — serve stale if we have it, retry after TTL.
      cache = { data: lastGoodData, expiresAt: Date.now() + CACHE_TTL_MS };
      return lastGoodData;
    }

    const json = (await res.json()) as Record<string, unknown>;
    const data: OAuthUsage = {
      fiveHour: parseWindow(json.five_hour as Record<string, unknown> | undefined),
      sevenDay: parseWindow(json.seven_day as Record<string, unknown> | undefined),
    };
    lastGoodData = data;
    cache = { data, expiresAt: Date.now() + CACHE_TTL_MS };
    return data;
  } catch {
    // Network error — serve stale if available, retry after TTL.
    cache = { data: lastGoodData, expiresAt: Date.now() + CACHE_TTL_MS };
    return lastGoodData;
  }
}
