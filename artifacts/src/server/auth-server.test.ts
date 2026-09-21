import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactsServer } from './index.js';
import type { HarnessAdapter, HarnessTurn } from './harnesses/types.js';
import type { ChatChunk } from '../shared/types.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const password = 'test-only access password';
async function setup(options: { publicOrigin?: string; pairing?: boolean; run?: (turn: HarnessTurn) => AsyncIterable<ChatChunk> } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'artifacts-auth-')); cleanups.push(() => rm(cwd, { recursive: true, force: true }));
  const adapter: HarnessAdapter = { id: 'claude-code', info: async () => ({ id: 'claude-code', name: 'Test', available: true, capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } }), run: options.run ?? async function* () {} };
  const app = await createArtifactsServer({ directory: join(cwd, 'sessions'), instructions: 'test', password, host: '0.0.0.0', publicOrigin: options.publicOrigin, harnesses: { 'claude-code': adapter }, pairing: { enabled: options.pairing, allowedOrigins: ['https://hosted.example'], code: 'ABCD-EFGH-JKLM-NPQR' } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (path: string, input = {}, headers: Record<string, string> = {}) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(input) });
  const login = async (headers?: Record<string, string>) => { const response = await post('/api/auth/login', { password }, headers); expect(response.status).toBe(200); return response.headers.get('set-cookie')!.split(';')[0]; };
  return { app, base, post, login, cwd };
}

test('protects every data and agent route even with no Origin or a loopback Host', async () => {
  const { app, base, post, login, cwd } = await setup();
  expect(await (await fetch(base + '/api/auth')).json()).toEqual({ enabled: true, authenticated: false });
  expect(await (await fetch(base + '/api/health')).json()).toEqual({ ok: true });
  const routes = [['GET', '/api/harnesses'], ['GET', '/api/harnesses/claude-code/profile-options'], ['GET', '/api/sessions'], ['POST', '/api/sessions'], ['GET', '/api/sessions/example'], ['PATCH', '/api/sessions/example'], ['DELETE', '/api/sessions/example'], ['POST', '/api/chat'], ['GET', '/api/chat/example/stream'], ['POST', '/api/sessions/example/stop'], ['GET', '/api/sessions/example/metadata'], ['POST', '/api/sessions/example/approvals/approval'], ['GET', '/api/sessions/example/artifacts'], ['GET', '/api/sessions/example/files?path=.artifacts/test.tsx'], ['PUT', '/api/sessions/example/files?path=.artifacts/test.tsx'], ['GET', '/api/profiles'], ['POST', '/api/profiles'], ['PUT', '/api/profiles/example'], ['DELETE', '/api/profiles/example'], ['POST', '/api/pair/code'], ['GET', '/api/pair/connections'], ['DELETE', '/api/pair/connections/example'], ['GET', '/api/connection']];
  for (const [method, path] of routes) {
    const response = await fetch(base + path, { method, headers: { host: '127.0.0.1:43860' } });
    expect(response.status).toBe(401); expect(await response.json()).toMatchObject({ passwordRequired: true });
  }
  expect(app.store.sessions.size).toBe(0);
  const cookie = await login(), headers = { cookie };
  expect(await (await fetch(base + '/api/auth', { headers })).json()).toEqual({ enabled: true, authenticated: true });
  const created = await post('/api/sessions', { harness: 'claude-code', cwd }, headers); expect(created.status).toBe(201);
  const { id } = await created.json();
  const path = `/api/sessions/${id}/files?path=.artifacts/canvases/auth.ui4a.tsx`;
  expect((await fetch(base + path, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'export default () => <p>private</p>' }) })).status).toBe(200);
  expect(await (await fetch(base + path, { headers })).text()).toContain('private');
  expect((await post('/api/auth/logout', {}, headers)).status).toBe(200);
  expect((await fetch(base + path, { headers })).status).toBe(401);
});

test('rejects cross-origin password/cookie use, including allowed pairing origins', async () => {
  const { base, post, login } = await setup({ pairing: true }), cookie = await login();
  for (const origin of ['https://evil.example', 'https://hosted.example', `https://${new URL(base).host}`, 'http://127.0.0.1:1']) {
    expect((await post('/api/auth/login', { password }, { origin })).status).toBe(403);
    expect((await post('/api/auth/logout', {}, { origin, cookie })).status).toBe(403);
    expect((await post('/api/sessions', {}, { origin, cookie })).ok).toBe(false);
  }
  expect((await post('/api/auth/login', { password }, { origin: 'null' })).status).toBe(400);
  expect((await fetch(base + '/api/sessions', { headers: { cookie, 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  expect((await post('/api/auth/login', { password }, { origin: base })).status).toBe(200);
  expect((await post('/api/auth/login', { password }, { 'content-type': 'text/plain' })).status).toBe(415);
});

test('wrong passwords are rejected and login is rate limited before expensive verification', async () => {
  const { post } = await setup();
  for (let i = 0; i < 10; i++) { const response = await post('/api/auth/login', { password: 'wrong' }); expect(response.status).toBe(401); expect(response.headers.get('set-cookie')).toBeNull(); }
  const blocked = await post('/api/auth/login', { password }); expect(blocked.status).toBe(429); expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0);
});

test('remote HTTP and explicit HTTPS proxy origins work without trusting forwarded headers', async () => {
  const direct = await setup(), host = 'remote.example:43860';
  const cookie = await direct.login({ host, origin: `http://${host}` });
  expect((await fetch(direct.base + '/api/sessions', { headers: { host, cookie, origin: `http://${host}` } })).status).toBe(200);
  expect((await direct.post('/api/auth/login', { password }, { host, origin: `https://${host}`, 'x-forwarded-proto': 'https' })).status).toBe(403);
  const proxy = await setup({ publicOrigin: 'https://artifacts.example' });
  const response = await proxy.post('/api/auth/login', { password }, { host: 'artifacts.example', origin: 'https://artifacts.example' });
  expect(response.status).toBe(200); expect(response.headers.get('set-cookie')).toContain('; Secure');
  expect((await proxy.post('/api/auth/login', { password }, { host: 'artifacts.example:443', origin: 'https://artifacts.example' })).status).toBe(200);
  expect((await fetch(proxy.base + '/api/auth', { headers: { host: 'evil.example', 'x-forwarded-host': 'artifacts.example' } })).status).toBe(403);
  expect((await proxy.post('/api/auth/login', { password }, { host: 'artifacts.example', origin: 'http://artifacts.example' })).status).toBe(403);
  expect(await proxy.login()).toContain('macaron-artifacts-session=');
});

test('password protection preserves independently authorized pairing without exposing management', async () => {
  const { base, post } = await setup({ pairing: true }), origin = 'https://hosted.example';
  const pair = await post('/api/pair', { code: 'ABCD-EFGH-JKLM-NPQR' }, { origin }); expect(pair.status).toBe(200);
  const { token } = await pair.json(), headers = { origin, authorization: `Bearer ${token}` };
  const sessions = await fetch(base + '/api/sessions', { headers }); expect(sessions.status).toBe(200); expect(sessions.headers.get('access-control-allow-credentials')).toBeNull();
  expect((await post('/api/pair/code', {}, headers)).status).toBe(403);
  expect((await fetch(base + '/api/pair/connections', { headers })).status).toBe(403);
  expect((await fetch(base + '/api/sessions', { headers: { authorization: `Bearer ${token}` } })).status).toBe(401);
});

test('logout closes chat, reconnect and metadata streams without cancelling the native turn', async () => {
  let release!: () => void;
  const { app, base, post, login, cwd } = await setup({ run: async function* (turn) {
    if (turn.enrichment) return;
    yield { type: 'text-start', id: 'text' }; yield { type: 'text-delta', id: 'text', delta: 'private' };
    await new Promise<void>(resolve => { release = resolve; turn.signal.addEventListener('abort', () => resolve(), { once: true }); });
    yield { type: 'text-end', id: 'text' };
  } });
  const cookie = await login(), headers = { cookie };
  const { id } = await (await post('/api/sessions', { harness: 'claude-code', cwd }, headers)).json();
  const chat = await post('/api/chat', { id, messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'hello' }] }] }, headers);
  const reconnect = await fetch(`${base}/api/chat/${id}/stream`, { headers }), metadata = await fetch(`${base}/api/sessions/${id}/metadata`, { headers });
  expect((await post('/api/auth/logout', {}, headers)).status).toBe(200);
  expect(await chat.text()).toContain('private'); expect(await reconnect.text()).toContain('private'); expect(await metadata.text()).toContain('data:');
  expect(app.active.has(id)).toBe(true);
  const run = app.active.get(id)!; release(); await run.done;
  expect((await fetch(`${base}/api/chat/${id}/stream`, { headers })).status).toBe(401);
});
