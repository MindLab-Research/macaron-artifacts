import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactsServer } from './index.js';
import { hermesAdapter, closeHermesConnections, encodeHermesNativeId } from './harnesses/hermes.js';
import { normalizeConnection, redactConnection, validateConnectionResponse } from './connections.js';
import type { ConnectionState, ChatChunk, Session } from '../shared/types.js';

const snapshot = (): ConnectionState => ({ op_id: 'repeat-op', tool_call_id: 'tool', seq: 0, deadline_at: Date.now() / 1000 + 60, timeout_seconds: 60, targets: [
  { name: 'Mail', kind: 'connector', action: 'authorize', state: 'initiated', connect_url: 'https://example.test/authorize?nonce=PRIVATE-NONCE' },
  { name: 'Docs', kind: 'mcp', action: 'install', state: 'pending', required_env: [{ name: 'API_KEY', required: true, secret: true, default: 'PRIVATE-DEFAULT' }] },
] });
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
async function until<T>(read: () => T, predicate: (value: T) => boolean): Promise<T> {
  const end = Date.now() + 4000;
  while (Date.now() < end) { const value = read(); if (predicate(value)) return value; await Bun.sleep(10); }
  throw new Error('Timed out waiting for the real protocol boundary');
}
async function fixture(mode = '') {
  const cwd = await mkdtemp(join(tmpdir(), 'connection-test-'));
  cleanup.push(() => rm(cwd, { recursive: true, force: true }));
  let socket: any, state = snapshot(), failures = 0;
  const calls: Array<{ method: string; params: any }> = [];
  const event = (type: string, payload: unknown, sid: string | undefined = 'native') => socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, ...(sid ? { session_id: sid } : {}), payload } }));
  const finish = (reason = 'continue') => {
    state = { ...state, seq: state.seq + 1, settled: true, settled_by: reason as ConnectionState['settled_by'], settled_at: Date.now() / 1000 };
    event('connection.update', { ...state, owner: { type: 'session', session_id: 'native' } });
    event('message.complete', { text: 'done' });
  };
  const gateway = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, server) { if (server.upgrade(req)) return; return new Response('', { status: 404 }); }, websocket: {
    open(ws) { socket = ws; event('gateway.ready', {}); },
    message(ws, raw) {
      const { id, method, params: p } = JSON.parse(String(raw)); calls.push({ method, params: p });
      const reply = (result: unknown) => { ws.send(JSON.stringify({ jsonrpc: '2.0', id, result })); };
      if (method === 'session.create') return reply({ session_id: 'native', stored_session_id: 'stored' });
      if (method === 'session.resume') {
        if (mode === 'early') event('connection.request', state);
        return reply({ session_id: 'native', stored_session_id: 'stored', ...(mode === 'resume' || mode.startsWith('retry-pending') ? { pending_connection: state } : {}) });
      }
      if (method === 'prompt.submit') { state = snapshot(); if (mode === 'deadline') state.deadline_at = Date.now() / 1000 + 0.08; reply({ status: 'streaming' }); event('connection.request', state); return; }
      if (method === 'prompt.btw') { reply({}); event('btw.complete', { text: '{}' }); return; }
      if (method === 'session.interrupt') { finish('interrupt'); return reply({}); }
      if (method === 'connectors.operation.status') return reply(state);
      if (method === 'connectors.operation.wake') return reply({ status: 'ok' });
      if (method === 'connection.respond') {
        if (failures > 0) { failures--; ws.send(JSON.stringify({ jsonrpc: '2.0', id, error: { message: 'PRIVATE-SUBMITTED-KEY rejected' } })); return; }
        for (const answer of p.result.targets) { const row = state.targets.find(t => t.name === answer.name)!; row.state = answer.status === 'approved' ? 'connected' : 'skipped'; }
        if (p.result.settled_by) finish();
        else { state.seq++; event('connection.update', { ...state, owner: { type: 'session', session_id: 'native' } }); }
        return reply({ status: 'ok', settled: Boolean(state.settled) });
      }
      reply({});
    },
  } });
  cleanup.push(async () => { await closeHermesConnections(); gateway.stop(true); });
  const adapter = { ...hermesAdapter, run: (turn: Parameters<typeof hermesAdapter.run>[0]) => hermesAdapter.run({ ...turn, profile: { config: { gatewayUrl: `ws://127.0.0.1:${gateway.port}`, nativeProfile: 'test-profile' } } }) };
  const app = await createArtifactsServer({ directory: join(cwd, 'data'), instructions: '', harnesses: { hermes: adapter } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => app.close());
  const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  const post = (path: string, body: unknown) => fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000) });
  const session = await (await post('/api/sessions', { cwd, harness: 'hermes' })).json() as Session;
  if (['resume', 'early'].includes(mode) || mode.startsWith('retry-pending')) {
    session.nativeId = encodeHermesNativeId({ sessionId: 'old-native', storedId: 'stored', profile: 'test-profile', ...(mode === 'retry-pending-known' ? { submittedMessageId: 'user' } : mode === 'retry-pending-unsent' ? { submittedMessageId: 'older-user' } : {}) });
    if (mode.startsWith('retry-pending')) { session.status = 'error'; session.messages = [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'connect' }] }]; }
    await app.store.save(session);
  }
  const first = await post('/api/chat', { id: session.id, messages: [{ id: 'user', role: 'user', parts: [{ type: 'text', text: 'connect' }] }] });
  const journal = () => app.active.get(session.id)?.journal ?? [];
  const parts = () => journal().filter((chunk): chunk is Extract<ChatChunk, { type: 'data-connection' }> => chunk.type === 'data-connection');
  await until(parts, chunks => chunks.length > 0);
  const requestId = parts()[0].data.id;
  const command = (body: unknown, id = requestId) => post(`/api/sessions/${session.id}/connections/${id}`, body);
  return { app, first, post, session, base, parts, calls, event, finish, command, requestId, failOnce: () => failures++, setState: (value: ConnectionState) => { state = value; } };
}

test('real HTTP -> native owner RPC, retry, detach/replay and secret-free persistence', async () => {
  const f = await fixture();
  expect((await f.command({ targets: [{ name: 'Mail', status: 'approved' }] })).status).toBe(400);
  expect((await f.command({ targets: [{ name: 'Docs', status: 'approved', env: { EXTRA: 'no' } }] })).status).toBe(400);
  expect(f.calls.filter(call => call.method === 'connection.respond')).toHaveLength(0);
  f.failOnce();
  const failed = await f.command({ targets: [{ name: 'Docs', status: 'approved', env: { API_KEY: 'PRIVATE-SUBMITTED-KEY' } }] });
  expect(failed.status).toBe(502); expect(await failed.text()).not.toContain('PRIVATE-SUBMITTED-KEY');
  expect((await f.command({ targets: [{ name: 'Docs', status: 'approved' }] })).status).toBe(200);
  const response = f.calls.findLast(call => call.method === 'connection.respond')!.params;
  expect(response.owner).toEqual({ type: 'session', session_id: 'native' });
  expect(response.profile).toBe('test-profile'); expect(response).not.toHaveProperty('session_id');
  expect(response.result.targets[0].env).toEqual({ API_KEY: 'PRIVATE-DEFAULT' });
  expect(f.parts().at(-1)!.data.targets[1].state).toBe('connected');
  expect(JSON.stringify(f.parts())).not.toContain('PRIVATE-DEFAULT');
  await f.first.body!.cancel();
  expect(f.calls.some(call => call.method === 'session.interrupt')).toBe(false);
  const replay = await fetch(`${f.base}/api/chat/${f.session.id}/stream`);
  expect((await f.command({ action: 'check' })).status).toBe(200);
  expect(f.calls.slice(-2).map(call => call.method)).toEqual(['connectors.operation.wake', 'connectors.operation.status']);
  expect((await f.command({ targets: [], settled_by: 'continue' })).status).toBe(200);
  const wire = await replay.text();
  const cards = wire.split('\n').filter(line => line.startsWith('data: {')).map(line => JSON.parse(line.slice(6))).filter(c => c.type === 'data-connection');
  expect(new Set(cards.map(c => c.id)).size).toBe(1);
  expect(cards.at(-1).data.actionable).toBe(false);
  const saved = await readFile(f.app.store.path(f.session.id), 'utf8');
  for (const secret of ['PRIVATE-NONCE', 'PRIVATE-DEFAULT', 'PRIVATE-SUBMITTED-KEY']) expect(saved).not.toContain(secret);
  expect((await f.command({ targets: [], settled_by: 'continue' })).status).toBe(409);
});

test('strict session/owner, monotonic request/update and stable terminal card id', async () => {
  const f = await fixture(), count = f.parts().length;
  for (const [sid, owner] of [['foreign', undefined], ['', undefined], ['native', { type: 'account', account_id: 'other' }], ['native', { type: 'session', session_id: 'foreign' }]] as const) {
    f.event('connection.request', { ...snapshot(), op_id: `bad-${sid}-${JSON.stringify(owner)}`, ...(owner ? { owner } : {}) }, sid);
  }
  f.event('connection.update', { ...snapshot(), seq: 0, targets: [{ ...snapshot().targets[0], name: 'stale' }] });
  await Bun.sleep(40); expect(f.parts()).toHaveLength(count);
  f.event('connection.update', { ...snapshot(), seq: 3, settled: true, settled_by: 'continue' });
  await until(f.parts, parts => parts.length > count);
  const terminal = f.parts().at(-1)!;
  expect(terminal.id).toBe(f.requestId); expect(terminal.data.tool_call_id).toBe('tool');
  f.event('connection.request', { ...snapshot(), seq: 4 });
  await Bun.sleep(20); expect(f.parts().at(-1)).toEqual(terminal);
  expect((await f.command({ action: 'check' })).status).toBe(409);
  f.finish(); await f.first.text();
});

test.each(['resume', 'early', 'retry-pending-unsent'])('restores %s pending operation and submits the NEW user message after settlement', async mode => {
  const f = await fixture(mode);
  expect(f.calls.some(call => call.method === 'prompt.submit')).toBe(false);
  expect((await f.command({ targets: [], settled_by: 'continue' })).status).toBe(200);
  await until(() => f.calls.filter(call => call.method === 'prompt.submit'), calls => calls.length === 1);
  await until(f.parts, parts => parts.at(-1)?.data.actionable === true && parts.at(-1)?.data.id !== f.requestId);
  expect(f.calls.find(call => call.method === 'prompt.submit')!.params.text).toBe('connect');
  expect((await f.command({ targets: [], settled_by: 'continue' }, f.parts().at(-1)!.data.id)).status).toBe(200);
  const wire = await f.first.text();
  expect(wire.split('\n').filter(line => line.includes('"type":"text-delta"'))).toHaveLength(1);
});

test.each(['retry-pending', 'retry-pending-known'])('%s does not send its already-submitted prompt twice', async mode => {
  const f = await fixture(mode);
  expect((await f.command({ targets: [], settled_by: 'continue' })).status).toBe(200);
  await f.first.text();
  expect(f.calls.some(call => call.method === 'prompt.submit')).toBe(false);
});

test('expired operations cannot use status/wake or respond', async () => {
  const f = await fixture();
  f.event('connection.update', { ...snapshot(), seq: 1, deadline_at: Date.now() / 1000 - 1 });
  await until(f.parts, parts => parts.at(-1)?.data.actionable === false);
  for (const action of ['check', 'status', 'respond']) expect((await f.command({ action, targets: [], settled_by: 'continue' })).status).toBe(409);
  expect(new Set(f.parts().map(c => c.id)).size).toBe(1);
  f.finish('deadline'); await f.first.text();
});

test('native deadline closes controls without an update event', async () => {
  const f = await fixture('deadline');
  await until(f.parts, parts => parts.at(-1)?.data.actionable === false);
  expect(new Set(f.parts().map(c => c.id)).size).toBe(1);
  expect((await f.command({ action: 'check' })).status).toBe(409);
  f.finish('deadline'); await f.first.text();
});

test('stop closes cards and a retry cannot reuse their browser capability', async () => {
  const f = await fixture();
  expect((await f.post(`/api/sessions/${f.session.id}/stop`, {})).status).toBe(200);
  const stopped = await f.first.text();
  expect(stopped).toContain('"actionable":false');
  expect((await f.command({ action: 'check' })).status).toBe(409);
  const saved = await (await fetch(`${f.base}/api/sessions/${f.session.id}`)).json() as Session;
  const retry = await f.post('/api/chat', { id: saved.id, messages: saved.messages });
  await until(f.parts, parts => parts.length > 0);
  const id = f.parts()[0].data.id;
  expect(id).not.toBe(f.requestId);
  expect((await f.command({ targets: [], settled_by: 'continue' })).status).toBe(409);
  expect((await f.command({ targets: [], settled_by: 'continue' }, id)).status).toBe(200);
  await retry.text();
});

test('normalizer rejects ambiguous contracts and retains only safe authorization URLs', () => {
  for (const bad of [{ seq: NaN }, { seq: -1 }, { deadline_at: 0 }, { op_id: ' ' }, { op_id: ' padded ' }, { targets: [snapshot().targets[0], snapshot().targets[0]] }]) expect(normalizeConnection({ ...snapshot(), ...bad })).toBeUndefined();
  for (const link of ['javascript:alert(1)', '/relative', 'data:text/html,x', 'https://user:password@example.test/']) {
    expect(normalizeConnection({ ...snapshot(), targets: [{ ...snapshot().targets[0], connect_url: link }] })!.targets[0].connect_url).toBeUndefined();
  }
  const url = 'https://example.test';
  expect(normalizeConnection({ ...snapshot(), targets: [{ ...snapshot().targets[0], connect_url: url }] })!.targets[0].connect_url).toBe(url);
  expect(JSON.stringify(redactConnection(snapshot()))).not.toContain('PRIVATE-');
});

test('MCP required/default and answer contract do not admit unadvertised or hosted approval', () => {
  const state = snapshot(); state.targets[1].required_env![0].default = '';
  for (const answer of [{ targets: [] }, { targets: [{ name: 'Docs', status: 'approved' }] }, { targets: [{ name: 'Docs', status: 'approved', env: [] }] }, { targets: [{ name: 'Mail', status: 'connected' }] }, { targets: [{ name: 'Mail', status: 'approved' }] }, { targets: [], settled_by: 'all_resolved' }]) expect(() => validateConnectionResponse(answer, state)).toThrow();
  expect(validateConnectionResponse({ targets: [], settled_by: 'continue' }, state)).toEqual({ targets: [], settled_by: 'continue' });
  expect(validateConnectionResponse({ targets: [{ name: 'Docs', status: 'approved', env: { API_KEY: 'public-test-value' } }] }, state).targets[0].env).toEqual({ API_KEY: 'public-test-value' });
});
