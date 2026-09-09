import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createArtifactsServer } from './index.js';
import type { HarnessAdapter } from './harnesses/types.js';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), 'artifacts-pairing-')); cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const adapter: HarnessAdapter = { id: 'claude-code', info: async () => ({ id: 'claude-code', name: 'Test', available: true, capabilities: { textDeltas: true, reasoningDeltas: true, toolInputDeltas: true, commandOutputDeltas: true, approvals: true, fork: true } }), async *run() {} };
  const app = await createArtifactsServer({ directory: join(directory, 'sessions'), instructions: 'test', harnesses: { 'claude-code': adapter }, pairing: { enabled: true, allowedOrigins: ['https://artifacts.example'], code: 'ABCD-EFGH-JKLM-NPQR' } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve)); cleanups.push(() => app.close());
  return { app, base: `http://127.0.0.1:${(app.server.address() as { port: number }).port}`, cwd: directory };
}

test('pairs a hosted origin, binds the token to that origin, and exposes stable connection context', async () => {
  const { base } = await setup(), hosted = { origin: 'https://artifacts.example' };
  const denied = await fetch(`${base}/api/sessions`, { headers: hosted }); expect(denied.status).toBe(401); expect((await denied.json()).authRequired).toBe(true);
  const pair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { ...hosted, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'abcd-efgh-jklm-npqr', origin: 'https://evil.example' }) });
  expect(pair.status).toBe(200); const token = (await pair.json()).token as string;
  const context = await fetch(`${base}/api/connection`, { headers: { ...hosted, authorization: `Bearer ${token}` } }); expect(context.status).toBe(200); expect(await context.json()).toMatchObject({ name: 'Macaron Artifacts', protocolVersion: 1 });
  const wrongOrigin = await fetch(`${base}/api/connection`, { headers: { origin: 'https://evil.example', authorization: `Bearer ${token}` } }); expect(wrongOrigin.status).toBe(403);
  const sessions = await fetch(`${base}/api/sessions`, { headers: { ...hosted, authorization: `Bearer ${token}` } }); expect(sessions.status).toBe(200);
  expect(pair.headers.get('access-control-allow-origin')).toBe('https://artifacts.example'); expect(pair.headers.get('access-control-allow-credentials')).toBeNull();
  const replay = await fetch(`${base}/api/pair`, { method: 'POST', headers: { ...hosted, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH-JKLM-NPQR' }) }); expect(replay.status).toBe(410);
});

test('keeps code and grant management local-only and supports multiple revocable grants', async () => {
  const { base } = await setup(), local = { host: `127.0.0.1:${new URL(base).port}` };
  const code = await fetch(`${base}/api/pair/code`, { method: 'POST', headers: local }); expect(code.status).toBe(200); expect((await code.json()).code).toMatch(/^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  const cross = await fetch(`${base}/api/pair/code`, { method: 'POST', headers: { origin: 'https://artifacts.example' } }); expect(cross.status).toBe(403);
  const connections = await fetch(`${base}/api/pair/connections`, { headers: local }); expect(connections.status).toBe(200); expect(await connections.json()).toEqual([]);
  const spoofedHost = await fetch(`${base}/api/health`, { headers: { host: 'attacker.example' } }); expect(spoofedHost.status).toBe(403);
  const deniedOrigin = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } }); expect(deniedOrigin.status).toBe(403);
  const deniedScheme = await fetch(`${base}/api/health`, { headers: { origin: `https://127.0.0.1:${new URL(base).port}` } }); expect(deniedScheme.status).toBe(403);
});

test('authenticated hosted clients can use file, metadata, and reconnect streams', async () => {
  const { base, cwd } = await setup(), hosted = { origin: 'https://artifacts.example' };
  const pair = await fetch(`${base}/api/pair`, { method: 'POST', headers: { ...hosted, 'content-type': 'application/json' }, body: JSON.stringify({ code: 'ABCD-EFGH-JKLM-NPQR' }) });
  const token = (await pair.json()).token as string, headers = { ...hosted, authorization: `Bearer ${token}` }, create = await fetch(`${base}/api/sessions`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ cwd, harness: 'claude-code' }) });
  const session = await create.json() as { id: string };
  const write = await fetch(`${base}/api/sessions/${session.id}/files?path=.artifacts/canvases/pair.ui4a.tsx`, { method: 'PUT', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ content: 'export default () => null' }) }); expect(write.status).toBe(200);
  const read = await fetch(`${base}/api/sessions/${session.id}/files?path=.artifacts/canvases/pair.ui4a.tsx`, { headers }); expect(await read.text()).toBe('export default () => null');
  const reconnect = await fetch(`${base}/api/chat/${session.id}/stream`, { headers }); expect(reconnect.status).toBe(204);
  const metadata = await fetch(`${base}/api/sessions/${session.id}/metadata`, { headers }); expect(metadata.status).toBe(200);
  const revoked = await fetch(`${base}/api/connection`, { method: 'DELETE', headers }); expect(revoked.status).toBe(200); expect(await metadata.text()).toContain('data:');
});
