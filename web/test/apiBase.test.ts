import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// jsdom-free storage shims. apiBase caches on read, so install before import.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
const local = new MemStorage();
const session = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = local;
(globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = session;

const { getApiBase, setApiBase, clearApiBase, resolveApiUrl, isLoopbackBase } = await import('../src/lib/apiBase');
const { getToken, setToken, clearToken, consumeHandoff } = await import('../src/lib/auth');

beforeEach(() => { local.clear(); session.clear(); clearApiBase(); });

test('same-origin (empty base): /api paths pass through untouched', () => {
  assert.equal(getApiBase(), '');
  assert.equal(resolveApiUrl('/api/workspaces'), '/api/workspaces');
  assert.equal(resolveApiUrl('/api/events?token=x'), '/api/events?token=x');
});

test('with a base: /api and /relay paths are retargeted, others are not', () => {
  setApiBase('https://tunnel.test');
  assert.equal(resolveApiUrl('/api/workspaces'), 'https://tunnel.test/api/workspaces');
  assert.equal(resolveApiUrl('/relay/foo'), 'https://tunnel.test/relay/foo');
  assert.equal(resolveApiUrl('/sw.js'), '/sw.js');           // asset stays local
  assert.equal(resolveApiUrl('/assets/x.js'), '/assets/x.js');
});

test('setApiBase stores the origin only and strips a trailing path', () => {
  setApiBase('https://tunnel.test/'); // trailing slash is the root path — allowed
  assert.equal(getApiBase(), 'https://tunnel.test');
});

test('setApiBase rejects a base that carries a path (no silent reroute)', () => {
  assert.throws(() => setApiBase('https://tunnel.test/deep/path'));
});

test('setApiBase rejects garbage', () => {
  assert.throws(() => setApiBase('not a url ::::'));
});

test('http://localhost base is honored (loopback)', () => {
  setApiBase('http://localhost:7878');
  assert.equal(resolveApiUrl('/api/health'), 'http://localhost:7878/api/health');
  assert.equal(isLoopbackBase(), true);
});

test('isLoopbackBase: 127.x and ::1 are loopback, public host is not', () => {
  setApiBase('http://127.0.0.1:7979');
  assert.equal(isLoopbackBase(), true);
  setApiBase('http://[::1]:7878');
  assert.equal(isLoopbackBase(), true);
  setApiBase('https://xxx.trycloudflare.com');
  assert.equal(isLoopbackBase(), false);
});

test('clearApiBase reverts to same-origin passthrough', () => {
  setApiBase('https://tunnel.test');
  clearApiBase();
  assert.equal(getApiBase(), '');
  assert.equal(resolveApiUrl('/api/x'), '/api/x');
});

// --- P0-2 + P1-bypass: hosted handoff comes from same-tab sessionStorage, NOT
// the URL. A crafted ?server= link carries no handoff and is inert. ---

const HANDOFF_KEY = 'macaron_connect_handoff';
function stashHandoff(server: string, token: string) { session.setItem(HANDOFF_KEY, JSON.stringify({ server, token })); }

test('consumeHandoff: binds api base + token from the same-tab handoff, then clears it', () => {
  stashHandoff('https://tunnel.test', 'tok-A');
  consumeHandoff();
  assert.equal(getApiBase(), 'https://tunnel.test');
  assert.equal(getToken(), 'tok-A');
  assert.equal(session.getItem(HANDOFF_KEY), null); // one-time
});

test('consumeHandoff: no handoff is a no-op (same-origin local mode, base stays empty)', () => {
  consumeHandoff();
  assert.equal(getApiBase(), '');
});

test('consumeHandoff: malformed handoff leaves no half-bound base', () => {
  session.setItem(HANDOFF_KEY, '{not json');
  consumeHandoff();
  assert.equal(getApiBase(), '');
});

// --- P0-3: {origin, token} bind atomically. Two hosted tabs on different
// servers can't leak one's token to the other, even sharing one localStorage. ---

test('two-realm: token minted for server A is never returned when the base is server B', () => {
  // Tab A binds server A + token A.
  stashHandoff('https://server-a.test', 'TOKEN_A');
  consumeHandoff();
  assert.equal(getToken(), 'TOKEN_A');
  // Tab B (same localStorage) binds server B + token B via its own sessionStorage.
  setApiBase('https://server-b.test');
  setToken('TOKEN_B');
  assert.equal(getToken(), 'TOKEN_B');
  // Back on server A's base, we still read A's token — B never clobbered it.
  setApiBase('https://server-a.test');
  assert.equal(getToken(), 'TOKEN_A');
});

// --- same-server dual-tab: two tabs bound to the SAME server must keep their
// OWN token. localStorage is shared across a tab group, sessionStorage is not,
// so the token must live in sessionStorage — asserted by it never touching the
// shared localStorage shim. ---

test('token is stored per-tab (sessionStorage), never in shared localStorage', () => {
  setApiBase('https://server-a.test');
  setToken('TOKEN_A');
  // The credential is in sessionStorage (per-tab) and absent from localStorage
  // (shared) — so a second tab on the same server can't overwrite this one.
  assert.equal(session.getItem('macaron_auth_token::https://server-a.test'), 'TOKEN_A');
  assert.equal(local.getItem('macaron_auth_token::https://server-a.test'), null);
});

