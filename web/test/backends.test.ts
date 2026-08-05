import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// jsdom-free storage shims. `fail` makes every operation throw, standing in for
// private mode / a disabled-storage profile. apiBase caches on read, so the
// modules are imported after the shims are installed.
class MemStorage {
  private m = new Map<string, string>();
  private getCount = 0;
  fail = false;
  failAfterSuccessfulGets: number | null = null;
  getItem(k: string) {
    if (this.fail || (this.failAfterSuccessfulGets !== null && this.getCount >= this.failAfterSuccessfulGets)) throw new Error('SecurityError');
    this.getCount++;
    return this.m.has(k) ? this.m.get(k)! : null;
  }
  setItem(k: string, v: string) { if (this.fail) throw new Error('SecurityError'); this.m.set(k, v); }
  removeItem(k: string) { if (this.fail) throw new Error('SecurityError'); this.m.delete(k); }
  clear() { this.m.clear(); this.getCount = 0; this.failAfterSuccessfulGets = null; }
}
const local = new MemStorage();
const session = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = local;
(globalThis as unknown as { sessionStorage: MemStorage }).sessionStorage = session;

const { setApiBase, clearApiBase, getApiBase, __resetCacheForTests } = await import('../src/lib/apiBase');
const { loadBackends, saveBackends, getActiveBackend, activateBackend, LOCAL_BACKEND_ID } = await import('../src/lib/backends');
const { authedFetch, getToken, setToken } = await import('../src/lib/auth');

if (typeof window === 'undefined') (globalThis as unknown as { window: EventTarget }).window = new EventTarget();

beforeEach(() => {
  local.clear(); session.clear();
  local.fail = false; session.fail = false;
  clearApiBase();
});

const BOX: { id: string; label: string; baseUrl: string } = { id: 'box', label: 'Box', baseUrl: 'https://box.example.com' };

// --- registry: the shared, non-sensitive part ---

test('a fresh profile has exactly the built-in local backend', () => {
  const list = loadBackends();
  assert.deepEqual(list, [{ id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' }]);
});

test('saved backends round-trip and keep the local default first', () => {
  saveBackends([...loadBackends(), BOX]);
  const list = loadBackends();
  assert.equal(list.length, 2);
  assert.equal(list[0].id, LOCAL_BACKEND_ID);
  assert.deepEqual(list[1], BOX);
});

test('the registry NEVER contains a token, even if one is handed to it', () => {
  saveBackends([...loadBackends(), { ...BOX, token: 'SECRET' } as never]);
  const raw = local.getItem('macaron_backends')!;
  assert.ok(!raw.includes('SECRET'), `token leaked into localStorage: ${raw}`);
  assert.deepEqual(loadBackends()[1], BOX);
});

test('the synthetic local default is not persisted and cannot be duplicated', () => {
  saveBackends([{ id: LOCAL_BACKEND_ID, label: 'Impostor', baseUrl: 'https://evil.test' }, BOX]);
  assert.equal(local.getItem('macaron_backends'), JSON.stringify([BOX]));
  const list = loadBackends();
  assert.equal(list.filter((b) => b.id === LOCAL_BACKEND_ID).length, 1);
  assert.equal(list[0].baseUrl, ''); // the real local default, not the stored impostor
});

test('malformed entries are dropped instead of crashing or rerouting', () => {
  local.setItem('macaron_backends', JSON.stringify([null, {}, { id: 'a' }, { id: 'b', label: 'B', baseUrl: 'https://ok.test/deep/path' }, BOX]));
  assert.deepEqual(loadBackends(), [{ id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' }, BOX]);
});

test('a corrupt registry degrades to the local default', () => {
  local.setItem('macaron_backends', '{not json');
  assert.deepEqual(loadBackends(), [{ id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' }]);
});

// --- per-tab activation ---

test('activating a backend retargets this tab; local reverts to same-origin', () => {
  saveBackends([...loadBackends(), BOX]);
  activateBackend('box');
  assert.equal(getApiBase(), BOX.baseUrl);
  assert.equal(getActiveBackend().id, 'box');
  activateBackend(LOCAL_BACKEND_ID);
  assert.equal(getApiBase(), '');
  assert.equal(getActiveBackend().id, LOCAL_BACKEND_ID);
});

test('the active backend is per-tab: it is never written to shared localStorage', () => {
  saveBackends([...loadBackends(), BOX]);
  activateBackend('box');
  const shared = local.getItem('macaron_backends')!;
  assert.ok(!shared.includes('active'), `active target leaked into localStorage: ${shared}`);
  assert.equal(session.getItem('macaron_api_base'), BOX.baseUrl);
});

// --- tab isolation: the reason tokens stay in sessionStorage ---

test('two tabs on the SAME backend keep their own token', () => {
  saveBackends([...loadBackends(), BOX]);
  activateBackend('box');
  setToken('TOKEN_TAB_A');
  // A second tab shares localStorage (the registry) but not sessionStorage.
  assert.equal(local.getItem(`macaron_auth_token::${BOX.baseUrl}`), null);
  assert.equal(session.getItem(`macaron_auth_token::${BOX.baseUrl}`), 'TOKEN_TAB_A');
});

test('switching backends and back does not leak or lose either token', () => {
  const OTHER = { id: 'other', label: 'Other', baseUrl: 'https://other.example.com' };
  saveBackends([...loadBackends(), BOX, OTHER]);
  activateBackend('box');
  setToken('TOKEN_BOX');
  activateBackend('other');
  assert.equal(getToken(), '', 'box token must not be readable while other is active');
  setToken('TOKEN_OTHER');
  activateBackend('box');
  assert.equal(getToken(), 'TOKEN_BOX', 'switching back must not require logging in again');
  activateBackend('other');
  assert.equal(getToken(), 'TOKEN_OTHER');
});

// --- storage exceptions ---

test('an unreadable registry still yields a working local backend', () => {
  local.fail = true;
  assert.deepEqual(loadBackends(), [{ id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' }]);
});

test('an unwritable registry loses the edit but does not throw', () => {
  local.fail = true;
  assert.doesNotThrow(() => saveBackends([BOX]));
});

test('FAIL-CLOSED: an unreadable api base refuses to send /api and /relay requests', async () => {
  session.setItem('macaron_api_base', BOX.baseUrl);
  __resetCacheForTests();       // fresh page load: the base is not yet cached
  session.fail = true;
  // Without the guard this would resolve to a same-origin '/api/...' fetch,
  // sending a request meant for the remote server to the hosting origin.
  await assert.rejects(() => authedFetch('/api/workspaces'), /cannot determine the API target/);
  await assert.rejects(() => authedFetch('/relay/session'), /cannot determine the API target/);
});

test('routing reuses the guard read if storage fails immediately afterward', async () => {
  session.setItem('macaron_api_base', BOX.baseUrl);
  __resetCacheForTests();
  session.failAfterSuccessfulGets = 1;
  let seen = '';
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (u: string) => { seen = u; return new Response('{}'); }) as never;
  await authedFetch('/api/x');
  assert.equal(seen, `${BOX.baseUrl}/api/x`, 'a second target read must not fall back to the hosting origin');
});

test('a readable api base still routes normally after a transient failure', async () => {
  session.setItem('macaron_api_base', BOX.baseUrl);
  __resetCacheForTests();
  session.fail = true;
  await assert.rejects(() => authedFetch('/api/x'));
  session.fail = false;         // storage recovers — the failure must not be cached
  __resetCacheForTests();
  let seen = '';
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (async (u: string) => { seen = u; return new Response('{}'); }) as never;
  await authedFetch('/api/x');
  assert.equal(seen, `${BOX.baseUrl}/api/x`);
});

test('a late 401 only clears the backend and token used by that request', async () => {
  const OTHER = { id: 'other', label: 'Other', baseUrl: 'https://other.example.com' };
  saveBackends([...loadBackends(), BOX, OTHER]);
  activateBackend('box');
  setToken('TOKEN_BOX');

  let finish!: (response: Response) => void;
  (globalThis as unknown as { fetch: typeof fetch }).fetch = (() => new Promise<Response>((resolve) => { finish = resolve; })) as never;
  let authRequired = 0;
  const onAuthRequired = () => { authRequired++; };
  window.addEventListener('macaron:auth-required', onAuthRequired);
  const pending = authedFetch('/api/x');

  activateBackend('other');
  setToken('TOKEN_OTHER');
  finish(new Response('{}', { status: 401 }));
  await pending;

  assert.equal(getToken(), 'TOKEN_OTHER', 'the current backend token must survive an old request');
  assert.equal(authRequired, 0, 'an inactive backend must not re-arm the current backend auth gate');
  activateBackend('box');
  assert.equal(getToken(), '', 'the rejected request token must be cleared from its own backend');
  window.removeEventListener('macaron:auth-required', onAuthRequired);
});
