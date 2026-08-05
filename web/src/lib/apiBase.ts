// Where the WebUI sends its /api and /relay calls. Normally empty: the UI is
// served by the same server it talks to, so every path stays same-origin (the
// historical behavior). When the UI is hosted on a *different* origin (e.g. the
// docs site connecting to a user's local `mcc`/`mcx`), the connect flow records
// that server's origin here and we retarget every API call to it.
//
// Only `/api` and `/relay` paths are rewritten — asset/SPA URLs stay local. The
// base is an origin only (scheme://host[:port]); we reject anything with a path
// so a stored value can't silently reroute non-API URLs.
//
// The base lives in sessionStorage, NOT localStorage: it is per-tab. Two tabs
// hosted on the same docs origin can point at different servers without one
// clobbering the other's target (the localStorage-backed old design let Tab B's
// server overwrite Tab A's, so Tab A then sent its token to the wrong host). The
// token is keyed by this base in auth.ts, so {origin, token} bind atomically.

const KEY = 'macaron_api_base';

let cached: string | null = null;

function normalize(raw: string): string {
  const u = new URL(raw); // throws on garbage → caller falls back to same-origin
  if (u.pathname !== '/' && u.pathname !== '') throw new Error('api base must be an origin, no path');
  return u.origin;
}

export function getApiBase(): string {
  if (cached !== null) return cached;
  try { cached = sessionStorage.getItem(KEY) || ''; } catch { return ''; }
  return cached;
}

// Whether the target is actually KNOWN. A sessionStorage read that throws is not
// "same-origin" — it's "we can't tell". getApiBase() returns '' in that case (its
// callers all want a string), so routing a request on that answer would send a
// hosted tab's call to the local origin instead of the server it is bound to.
// authedFetch gates on this and fails closed rather than guessing. We do NOT
// cache the failure: a later successful read resolves the real base.
export function isApiBaseKnown(): boolean {
  if (cached !== null) return true;
  // No storage API at all (SSR / a non-browser host) is not the same as a storage
  // that REFUSES to answer. Without the API, no hosted binding could ever have been
  // written, so same-origin is provably the target rather than a guess. A present
  // sessionStorage that throws IS a guess, and that is what we refuse to make.
  if (typeof sessionStorage === 'undefined') { cached = ''; return true; }
  // Use getApiBase for the probe so a successful read becomes the exact cached
  // value used by the ensuing request. Probing and then reading again creates a
  // TOCTOU window where the probe succeeds, the second read throws, and routing
  // silently falls back to the hosting origin.
  getApiBase();
  return cached !== null;
}

// Test-only: drop the module cache so the next read hits storage, simulating a
// fresh page load. clearApiBase() can't stand in for this — clearing the base is
// a real state ('' = same-origin), not the absence of a known state.
export function __resetCacheForTests(): void { cached = null; }

export function setApiBase(origin: string): void {
  const clean = normalize(origin);
  cached = clean;
  try { sessionStorage.setItem(KEY, clean); } catch { /* private mode */ }
}

export function clearApiBase(): void {
  cached = '';
  try { sessionStorage.removeItem(KEY); } catch { /* private mode */ }
}

// Loopback / private-range hosts are reached over Chrome's Local Network Access
// path; annotating the fetch with targetAddressSpace lets the browser skip the
// mixed-content pre-check (see server CORS + LNA headers). Best-effort: only
// loopback literals/names get flagged, everything else is left to normal rules.
export function isLoopbackBase(b = getApiBase()): boolean {
  if (!b) return false;
  try {
    const h = new URL(b).hostname.replace(/\.$/, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h.startsWith('127.') || h === '[::1]' || h === '::1';
  } catch { return false; }
}

// Retarget an /api or /relay path at the configured server. Absolute URLs and
// non-API paths pass through untouched.
export function resolveApiUrl(input: string, base = getApiBase()): string {
  if (!base) return input;
  if (!input.startsWith('/api') && !input.startsWith('/relay')) return input;
  return base + input;
}
