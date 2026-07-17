import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { isCrossOriginRequest, isLocalRequest, makeAuthHook, redactTokenInUrl, setArmedToken } from './auth.js';

// Minimal FastifyRequest double: only the fields the auth predicates read.
function req(opts: { ip?: string; host?: string; origin?: string; auth?: string; url?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...(opts.headers || {}) };
  headers.host = opts.host ?? '127.0.0.1:7878'; // real clients always send a Host
  if (opts.origin) headers.origin = opts.origin;
  if (opts.auth) headers.authorization = opts.auth;
  return { ip: opts.ip ?? '127.0.0.1', headers, url: opts.url ?? '/api/settings', routeOptions: { url: opts.url ?? '/api/settings' } } as never;
}
function reply() {
  let code = 0; let sent = false;
  return { code_: () => code, sent_: () => sent, code(c: number) { code = c; return this; }, send() { sent = true; return this; } };
}

afterEach(() => setArmedToken(''));

// P1: Fastify percent-decodes the query before authenticating, so a request with
// `?%74oken=<secret>` authenticates AND must be scrubbed from the pino req.url log.
// The old literal /token=/ regex missed the encoded key, leaking the full secret.
test('redactTokenInUrl: scrubs literal and percent-encoded token keys', () => {
  assert.equal(redactTokenInUrl('/api/x?token=SECRET'), '/api/x?token=[redacted]');
  assert.equal(redactTokenInUrl('/api/x?a=1&token=SECRET&b=2'), '/api/x?a=1&token=[redacted]&b=2');
  assert.equal(redactTokenInUrl('/api/x?%74oken=SECRET'), '/api/x?%74oken=[redacted]');
  assert.equal(redactTokenInUrl('/api/events?TOKEN=SECRET'), '/api/events?TOKEN=[redacted]');
  assert.equal(redactTokenInUrl('/api/x?other=keep'), '/api/x?other=keep');
});

test('isCrossOriginRequest: cross-origin Origin true, same-origin/no-origin false', () => {
  assert.equal(isCrossOriginRequest(req({ origin: 'https://hosted.example', host: '127.0.0.1:7878' })), true);
  assert.equal(isCrossOriginRequest(req({ origin: 'http://127.0.0.1:7878', host: '127.0.0.1:7878' })), false);
  assert.equal(isCrossOriginRequest(req({ host: '127.0.0.1:7878' })), false); // no Origin (CLI)
});

test('isLocalRequest: loopback CLI (no Origin) is local; loopback + cross-origin Origin is NOT', () => {
  assert.equal(isLocalRequest(req({ ip: '127.0.0.1' })), true);
  // P0-1: a hosted page hitting the loopback server must not inherit the bypass.
  assert.equal(isLocalRequest(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878' })), false);
});

test('auth hook: cross-origin loopback request with wrong token is 401 (P0-1 regression)', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878', auth: 'Bearer wrong' }), r as never, () => { done = true; });
  assert.equal(done, false);
  assert.equal(r.code_(), 401);
});

test('auth hook: cross-origin loopback request with correct token proceeds', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1', origin: 'https://hosted.example', host: '127.0.0.1:7878', auth: 'Bearer correct-token' }), r as never, () => { done = true; });
  assert.equal(done, true);
  assert.equal(r.code_(), 0);
});

test('auth hook: same-box CLI (no Origin) stays frictionless even with a token armed', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1' }), r as never, () => { done = true; });
  assert.equal(done, true);
});

// P0: a Host-spoofing / DNS-rebinding page served from 127.0.0.1 sends a
// NON-loopback (attacker-chosen) Host that matches its own Origin, so the old
// `Origin.host === req.host` same-origin check let it through with no token.
// A non-loopback Host must never inherit the frictionless-localhost bypass.
test('auth hook: loopback socket with a spoofed non-loopback Host is 401 (Host-spoofing regression)', () => {
  setArmedToken('correct-token');
  const hook = makeAuthHook();
  const r = reply();
  let done = false;
  hook(req({ ip: '127.0.0.1', origin: 'http://attacker.localhost:7878', host: 'attacker.localhost:7878' }), r as never, () => { done = true; });
  assert.equal(done, false);
  assert.equal(r.code_(), 401);
});
