import { test } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { makeCorsHook } from '../src/lib/cors.js';
import { makeAuthHook, setArmedToken } from '../src/lib/auth.js';

// Integration regression for the startup path: index.ts registers the CORS hook
// UNCONDITIONALLY (even with an empty MACARON_ALLOWED_ORIGINS, the default), so
// a cross-origin request is 403'd before it can route. An earlier build gated
// the hook behind `if (ALLOWED_ORIGINS.length > 0)`, which silently dropped the
// gate in the default config. This wires the hooks exactly as index.ts does —
// empty allowlist — around a stub protected route and drives it via inject.
async function bootApp() {
  const app = Fastify();
  setArmedToken(''); // auth off (loopback default) — isolate the CORS gate
  app.addHook('onRequest', makeCorsHook([])); // empty allowlist, as at boot
  app.addHook('onRequest', makeAuthHook());
  app.get('/api/settings', async () => ({ ok: true }));
  app.post('/api/tunnel/stop', async () => ({ stopped: true }));
  await app.ready();
  return app;
}

test('empty allowlist: cross-origin GET is 403 before routing', async (t) => {
  const app = await bootApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { origin: 'https://evil.example', host: '127.0.0.1:7878' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-origin'], undefined);
});

test('empty allowlist: cross-origin simple POST (text/plain) is 403, handler never runs', async (t) => {
  const app = await bootApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'POST', url: '/api/tunnel/stop', headers: { origin: 'https://evil.example', host: '127.0.0.1:7878', 'content-type': 'text/plain' } });
  assert.equal(res.statusCode, 403);
  assert.notEqual(res.json().stopped, true);
});

test('empty allowlist: cross-origin preflight is 403 (no CORS grant)', async (t) => {
  const app = await bootApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'OPTIONS', url: '/api/settings', headers: { origin: 'https://evil.example', host: '127.0.0.1:7878', 'access-control-request-private-network': 'true' } });
  assert.equal(res.statusCode, 403);
  assert.equal(res.headers['access-control-allow-private-network'], undefined);
});

test('empty allowlist: same-origin request passes through (Origin host == host)', async (t) => {
  const app = await bootApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/settings', headers: { origin: 'http://127.0.0.1:7878', host: '127.0.0.1:7878' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});

test('empty allowlist: no-Origin CLI request passes through', async (t) => {
  const app = await bootApp();
  t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/settings' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
});
