import { expect, test } from 'bun:test';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';
import { encodeOpenClawNativeId, openClawAdapter } from './openclaw.js';
import capturedEvents from './fixtures/openclaw-tool-then-ui.json';

type Event = { event: string; payload: Record<string, any> };

// Captured from OpenClaw 2026.9.3 in Docker: a native write tool ends before the final UI4A response.
// Exercise the real Gateway SDK/WS transport so the capability handshake and early stream closure are covered too.
async function replay(events: Event[], overrides: Partial<HarnessTurn> = {}) {
  const requests: Array<{ method: string; params: Record<string, any> }> = [], chunks: ChatChunk[] = [], archived = new Set<string>();
  let connection: Record<string, any> = {}, error: unknown;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request, server) { if (server.upgrade(request)) return; return new Response(null, { status: 400 }); }, websocket: {
    open(ws) { ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test', ts: Date.now() } })); },
    message(ws, message) {
      const { id, method, params = {} } = JSON.parse(String(message)); requests.push({ method, params });
      const reply = (payload: unknown) => ws.send(JSON.stringify({ type: 'res', id, ok: true, payload }));
      if (method === 'connect') { connection = params; reply({ type: 'hello-ok', protocol: 4, policy: { tickIntervalMs: 30000 } }); }
      else if (method === 'plugins.inspect') reply({ plugin: { enabled: true }, declared: { contracts: ['macaron-metadata-gate'] } });
      else if (method === 'sessions.create') reply({ key: params.key ? `agent:main:${params.key}` : 'agent:main:test', sessionId: 'test-session' });
      else if (method === 'sessions.patch') { if (params.expectedSessionId !== 'test-session') ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { code: 'INVALID_REQUEST', message: 'expectedSessionId required for session lifecycle patch' } })); else { if (params.archived) archived.add(params.key); reply({ ok: true }); } }
      else if (method === 'sessions.delete') {
        if (params.archivedOnly !== true || !archived.has(params.key)) ws.send(JSON.stringify({ type: 'res', id, ok: false, error: { code: 'FORBIDDEN', message: 'missing scope: operator.admin' } }));
        else { archived.delete(params.key); reply({ ok: true }); }
      } else if (method === 'agent') {
        reply({ runId: params.idempotencyKey, status: 'accepted' });
        for (const event of events) {
          if (event.payload.stream === 'tool' && !connection.caps?.includes('tool-events')) continue;
          ws.send(JSON.stringify({ type: 'event', ...event, payload: { ...event.payload, sessionKey: params.sessionKey, runId: params.idempotencyKey } }));
        }
      } else reply({ ok: true });
    },
  } });
  try {
    for await (const chunk of openClawAdapter.run({ cwd: '/tmp', prompt: 'Show the report', instructions: 'UI4A guidance', signal: AbortSignal.timeout(5000), approve: async () => false, onNativeSession() {}, profile: { config: { gatewayUrl: `ws://127.0.0.1:${server.port}` } }, ...overrides })) chunks.push(chunk);
  } catch (cause) { error = cause; }
  finally { server.stop(true); }
  return { chunks, requests, connection, archived, error };
}

test('keeps streaming the captured inline UI after the native tool item ends', async () => {
  const result = await replay(capturedEvents);
  expect(result.error).toBeUndefined();
  const snapshots = capturedEvents.filter(event => event.payload.stream === 'assistant');
  expect(result.chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(snapshots.map(event => event.payload.data.delta!));
  expect(result.chunks.filter(chunk => chunk.type === 'text-end')).toHaveLength(1);
});

test('requests raw tool events and does not mistake compaction for a turn terminal', async () => {
  const result = await replay([
    { event: 'agent', payload: { stream: 'tool', data: { phase: 'start', toolCallId: 'write-1', name: 'write', args: { path: 'report.ui4a.tsx', content: 'report' } } } },
    { event: 'agent', payload: { stream: 'tool', data: { phase: 'result', toolCallId: 'write-1', name: 'write', result: { content: [{ type: 'text', text: 'saved' }] } } } },
    { event: 'agent', payload: { stream: 'compaction', data: { phase: 'end', completed: true } } },
    { event: 'agent', payload: { stream: 'assistant', data: { text: 'Complete report' } } },
    { event: 'agent', payload: { stream: 'lifecycle', data: { phase: 'end' } } },
  ]);
  expect(result.error).toBeUndefined(); expect(result.connection.caps).toContain('tool-events');
  expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'tool-input-available', toolCallId: 'write-1', input: { path: 'report.ui4a.tsx', content: 'report' } }));
  expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'tool-output-available', toolCallId: 'write-1', output: { content: [{ type: 'text', text: 'saved' }] } }));
  expect(result.chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Complete report' }));
});

test('reports run errors instead of silently finishing successfully', async () => {
  const result = await replay([{ event: 'agent', payload: { stream: 'lifecycle', data: { phase: 'error', error: 'Provider failed' } } }]);
  expect(result.error).toBeInstanceOf(Error); expect((result.error as Error).message).toBe('Provider failed');
});

test('archives metadata forks before deleting them without requesting admin access', async () => {
  const result = await replay(capturedEvents, { enrichment: true, nativeId: encodeOpenClawNativeId({ key: 'agent:main:parent', cwd: '/tmp' }) });
  expect(result.error).toBeUndefined(); expect(result.connection.scopes).not.toContain('operator.admin');
  const cleanup = result.requests.filter(request => ['sessions.patch', 'sessions.delete'].includes(request.method));
  expect(cleanup).toHaveLength(2);
  const key = cleanup[0]!.params.key;
  expect(key).toStartWith('agent:main:macaron-metadata:');
  expect(cleanup).toEqual([{ method: 'sessions.patch', params: { key, expectedSessionId: 'test-session', archived: true } }, { method: 'sessions.delete', params: { key, expectedSessionId: 'test-session', deleteTranscript: true, archivedOnly: true } }]);
  expect(result.archived.size).toBe(0);
});
