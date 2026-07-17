// Client-side auth for the WebUI. The server gates /api and /relay behind a
// shared token when reachable from the network; here we store that token and
// attach it to every request. macaron streams over fetch()+getReader() (not
// the browser EventSource), so a single Authorization header covers plain
// requests and streaming reads alike — no cookie / query-token escape hatch.

import { getApiBase, isLoopbackBase, resolveApiUrl, setApiBase, clearApiBase } from './apiBase';

// The token is keyed by the server origin it was minted for, so a token bound to
// server A can never be sent to server B. It lives in sessionStorage — per browser
// tab, not shared like localStorage — so two hosted tabs each bound to the SAME
// server keep their OWN tokens instead of the later tab clobbering the earlier
// one. Same-origin (empty base) keeps the historical bare key. See the two-realm
// and same-server dual-tab regressions.
const KEY = 'macaron_auth_token';
function tokenKey(): string { const b = getApiBase(); return b ? `${KEY}::${b}` : KEY; }

// sessionStorage key the docs connect page WRITES and we READ once on load.
// Must stay identical to HANDOFF_KEY in site/app/lib/hosted-target.ts.
const HANDOFF_KEY = 'macaron_connect_handoff';

export function getToken(): string {
  try { return sessionStorage.getItem(tokenKey()) || ''; } catch { return ''; }
}

export function setToken(token: string): void {
  try { sessionStorage.setItem(tokenKey(), token); } catch { /* private mode */ }
}

export function clearToken(): void {
  try { sessionStorage.removeItem(tokenKey()); } catch { /* private mode */ }
}

// fetch wrapper that injects the token and re-gates the UI on 401 (expired /
// wrong token). Every call site that hits our own server uses this.
export async function authedFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const t = getToken();
  if (t) headers.set('Authorization', `Bearer ${t}`);
  const url = resolveApiUrl(input);
  const extra: RequestInit = {};
  // Cross-origin hosted mode: the browser needs credentials mode explicit, and
  // loopback targets want the LNA hint so Chrome skips the mixed-content check.
  if (getApiBase()) {
    extra.mode = 'cors';
    if (isLoopbackBase()) (extra as { targetAddressSpace?: string }).targetAddressSpace = 'loopback';
  }
  const resp = await fetch(url, { ...init, ...extra, headers });
  if (resp.status === 401) {
    clearToken();
    window.dispatchEvent(new Event('macaron:auth-required'));
  }
  return resp;
}

// Hosted-mode bootstrap. The docs connect page validated the server target and
// stashed {server, token} in sessionStorage (same tab, same origin) — never on
// the URL, so the credential can't leak into the document GET / logs / referrers.
// Read it ONCE, bind the api base FIRST so the token is keyed to that origin,
// then store the token atomically with it, and delete the handoff.
//
// Only this same-tab handoff is trusted: a hand-crafted `/app?server=<attacker>`
// carries no handoff and is ignored, so the connect page's scheme / self-origin
// / public-HTTP validation cannot be bypassed by a direct link. Call once at
// startup, before anything fetches. No handoff → same-origin local mode, base
// stays empty and any existing local login survives.
export function consumeHandoff(): void {
  let raw: string | null = null;
  try { raw = sessionStorage.getItem(HANDOFF_KEY); sessionStorage.removeItem(HANDOFF_KEY); } catch { return; }
  if (!raw) return;
  try {
    const { server, token } = JSON.parse(raw) as { server?: string; token?: string };
    if (!server) return;
    setApiBase(server);                       // bind origin FIRST → token keys to it
    if (token) setToken(token); else clearToken();
  } catch { clearApiBase(); }                 // malformed handoff → no half-bound base
}
