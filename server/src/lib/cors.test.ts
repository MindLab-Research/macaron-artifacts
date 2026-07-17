import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCorsHook } from './cors.js';

// Minimal Fastify req/reply doubles: enough for the hook's header/method logic.
// Base CORS headers land on reply.raw (survives the SSE/relay hijack); preflight
// extras land on reply.header. The double records both into one `headers` bag.
function makeReply() {
  const headers: Record<string, string> = {};
  let code = 0;
  let sent = false;
  return {
    headers,
    raw: { setHeader(k: string, v: string) { headers[k.toLowerCase()] = v; } },
    get code_() { return code; },
    get sent_() { return sent; },
    header(k: string, v: string) { headers[k.toLowerCase()] = v; return this; },
    code(c: number) { code = c; return this; },
    send() { sent = true; return this; },
  };
}
function req(method: string, origin?: string, extra: Record<string, string> = {}) {
  return { method, headers: { ...(origin ? { origin } : {}), ...extra } } as never;
}

const ALLOW = ['https://hosted.example'];

test('allowed origin: GET gets echoed origin + credentials, done() called', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  hook(req('GET', 'https://hosted.example'), reply as never, () => { doneCalled = true; });
  assert.equal(reply.headers['access-control-allow-origin'], 'https://hosted.example');
  assert.equal(reply.headers['access-control-allow-credentials'], 'true');
  assert.equal(doneCalled, true);
  assert.equal(reply.sent_, false); // GET is not short-circuited
});

test('disallowed cross-origin: refused 403 before routing (no ACAO, done NOT called)', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  hook(req('GET', 'https://evil.example'), reply as never, () => { doneCalled = true; });
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.equal(reply.code_, 403);
  assert.equal(reply.sent_, true);
  assert.equal(doneCalled, false); // short-circuited, never reaches auth/route
});

test('disallowed cross-origin simple write (POST): also refused 403, handler never runs', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  // A simple/no-cors text/plain POST would otherwise execute server-side even
  // though the browser can't read the response — the 403 stops it outright.
  hook(req('POST', 'https://evil.example', { 'content-type': 'text/plain' }), reply as never, () => { doneCalled = true; });
  assert.equal(reply.code_, 403);
  assert.equal(doneCalled, false);
});

test('OPTIONS preflight from allowed origin: 204, methods, and PNA grant', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  hook(req('OPTIONS', 'https://hosted.example', { 'access-control-request-private-network': 'true' }), reply as never, () => { doneCalled = true; });
  assert.equal(reply.code_, 204);
  assert.equal(reply.sent_, true);
  assert.equal(doneCalled, false); // short-circuited, done NOT called
  assert.equal(reply.headers['access-control-allow-methods'], 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  assert.equal(reply.headers['access-control-allow-private-network'], 'true');
});

test('OPTIONS preflight echoes requested headers when present', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  hook(req('OPTIONS', 'https://hosted.example', { 'access-control-request-headers': 'authorization,x-custom' }), reply as never, () => {});
  assert.equal(reply.headers['access-control-allow-headers'], 'authorization,x-custom');
});

test('OPTIONS preflight from disallowed origin: refused 403, no PNA grant', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  hook(req('OPTIONS', 'https://evil.example', { 'access-control-request-private-network': 'true' }), reply as never, () => { doneCalled = true; });
  assert.equal(reply.code_, 403);
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.equal(reply.headers['access-control-allow-private-network'], undefined);
  assert.equal(doneCalled, false);
});

test('wildcard allowlist echoes any origin (with credentials, never literal *)', () => {
  const hook = makeCorsHook(['*']);
  const reply = makeReply();
  hook(req('GET', 'https://anything.example'), reply as never, () => {});
  assert.equal(reply.headers['access-control-allow-origin'], 'https://anything.example');
});

test('no Origin header: no CORS headers, request proceeds', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  hook(req('GET'), reply as never, () => { doneCalled = true; });
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.equal(doneCalled, true);
});

test('same-origin request (Origin host == host): not refused, no CORS headers, proceeds', () => {
  const hook = makeCorsHook(ALLOW);
  const reply = makeReply();
  let doneCalled = false;
  // Browsers attach an Origin on same-origin POST/PUT/DELETE; that must not be
  // read as cross-origin and 403'd.
  hook(req('POST', 'http://127.0.0.1:7878', { host: '127.0.0.1:7878' }), reply as never, () => { doneCalled = true; });
  assert.equal(reply.code_, 0);
  assert.equal(reply.headers['access-control-allow-origin'], undefined);
  assert.equal(doneCalled, true);
});
