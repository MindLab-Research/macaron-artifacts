import { describe, expect, test } from 'bun:test';
import { closeHermesConnections, decodeHermesNativeId, encodeHermesNativeId } from './hermes.js';
import { parseHermesReadyLine, rpcPayload } from './hermes-server.js';

describe('Hermes gateway adapter protocol helpers', () => {
  test('parses only the public serve readiness sentinel', () => {
    expect(parseHermesReadyLine('HERMES_BACKEND_READY port=43123')).toBe('ws://127.0.0.1:43123/api/ws');
    expect(parseHermesReadyLine('Hermes backend listening on 127.0.0.1:43123')).toBeUndefined();
  });

  test('keeps runtime and durable session identity across reconnects', () => {
    const encoded = encodeHermesNativeId({ sessionId: 'runtime-1', storedId: '20260909_foo', profile: 'coding' });
    expect(decodeHermesNativeId(encoded)).toEqual({ sessionId: 'runtime-1', storedId: '20260909_foo', profile: 'coding' });
    expect(decodeHermesNativeId('legacy-session')).toEqual({ sessionId: 'legacy-session' });
  });

  test('unwraps JSON-RPC result envelopes without exposing unrelated fields', () => {
    expect(rpcPayload({ result: { session_id: 'runtime-1' }, id: 1 })).toEqual({ session_id: 'runtime-1' });
    expect(rpcPayload({ session_id: 'runtime-1' })).toEqual({ session_id: 'runtime-1' });
  });

  test.each(['streamed', 'fallback', 'interleaved'] as const)('resumes the durable session and preserves %s reasoning boundaries', async mode => {
    const OriginalWebSocket = globalThis.WebSocket;
    const originalUrl = process.env.MACARON_HERMES_URL;
    const events: [string, Record<string, unknown>][] = mode === 'interleaved' ? [
      ['thinking.delta', { text: 'plan ' }], ['reasoning.delta', { text: 'first' }],
      ['tool.start', { tool_id: 'tool-1', name: 'read_file', args: {} }], ['tool.complete', { tool_id: 'tool-1', result: 'source' }],
      ['thinking.delta', { text: 'check ' }], ['message.delta', { text: '' }], ['reasoning.delta', { text: 'result' }],
      ['message.delta', { text: 'answer' }], ['message.complete', { text: 'answer' }],
    ] : [['thinking.delta', { text: 'plan' }], ...(mode === 'streamed' ? [['message.delta', { text: 'answer' }]] as [string, Record<string, unknown>][] : []), ['message.complete', { text: 'answer' }]];
    let runtime = 0, connections = 0, closed = 0;
    const resumes: Record<string, unknown>[] = [];
    class FakeWebSocket {
      static OPEN = 1;
      static CLOSING = 2;
      readyState = 1;
      private listeners = new Map<string, Set<(event: { data?: string }) => void>>();
      constructor() { connections++; queueMicrotask(() => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type: 'gateway.ready', payload: {} } }) })); }
      addEventListener(type: string, listener: (event: { data?: string }) => void) { let listeners = this.listeners.get(type); if (!listeners) this.listeners.set(type, listeners = new Set()); listeners.add(listener); }
      send(raw: string) {
        const request = JSON.parse(raw) as { id: number; method: string; params: Record<string, unknown> }, reply = (result: Record<string, unknown>) => this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) });
        if (request.method === 'session.create') { expect(request.params.cwd).toBe('/tmp'); runtime = 1; reply({ session_id: 'runtime-1', stored_session_id: 'stored-1' }); }
        else if (request.method === 'session.resume') {
          // Hermes rejects unknown resume fields; cwd is only accepted when creating a session.
          const extra = Object.keys(request.params).find(key => !['session_id', 'omit_messages'].includes(key));
          if (extra) { this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32602, message: `invalid params for session.resume: ${extra}: Extra inputs are not permitted` } }) }); return; }
          resumes.push(request.params); runtime++; reply({ session_id: `runtime-${runtime}`, stored_session_id: 'stored-1' });
        }
        else if (request.method === 'prompt.submit') { reply({ status: 'streaming' }); queueMicrotask(() => { const sid = `runtime-${runtime}`; for (const [type, payload] of events) this.emit('message', { data: JSON.stringify({ jsonrpc: '2.0', method: 'event', params: { type, session_id: sid, payload } }) }); }); }
        else reply({});
      }
      close() { closed++; this.readyState = 3; }
      private emit(type: string, event: { data?: string }) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
    }
    (globalThis as unknown as { WebSocket: typeof FakeWebSocket }).WebSocket = FakeWebSocket;
    process.env.MACARON_HERMES_URL = 'ws://hermes.test';
    try {
      const { hermesAdapter } = await import('./hermes.js');
      const base = { cwd: '/tmp', instructions: '', signal: new AbortController().signal, approve: async () => true, onNativeSession: (_id: string) => {} };
      let nativeId: string | undefined;
      const run = async (prompt: string) => { const chunks = []; for await (const chunk of hermesAdapter.run({ ...base, prompt, nativeId, onNativeSession: id => { nativeId = id; } })) chunks.push(chunk); return chunks; };
      const first = await run('first'), resumed = await run('second');
      expect(first.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.delta)).toEqual(mode === 'interleaved' ? ['plan ', 'first', 'check ', 'result'] : ['plan']);
      const starts = first.filter(chunk => chunk.type === 'reasoning-start'), ends = first.filter(chunk => chunk.type === 'reasoning-end');
      expect(new Set(starts.map(chunk => chunk.id)).size).toBe(mode === 'interleaved' ? 2 : 1);
      expect(ends.map(chunk => chunk.id)).toEqual(starts.map(chunk => chunk.id));
      expect(first.findLastIndex(chunk => chunk.type === 'reasoning-end')).toBeLessThan(first.findIndex(chunk => chunk.type === 'text-start'));
      if (mode === 'interleaved') {
        const toolIndex = first.findIndex(chunk => chunk.type === 'tool-input-available');
        expect(first[toolIndex - 1]).toEqual({ type: 'reasoning-end', id: starts[0]?.id });
        expect(first[toolIndex + 2]).toEqual({ type: 'reasoning-start', id: starts[1]?.id });
        expect(first.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.id)).toEqual([starts[0]?.id, starts[0]?.id, starts[1]?.id, starts[1]?.id]);
      }
      expect(decodeHermesNativeId(nativeId!).sessionId).toBe('runtime-2');
      expect(resumed.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['answer']);
      await closeHermesConnections();
      expect(closed).toBe(1);
      const reconnected = await run('third');
      expect(connections).toBe(2);
      expect(resumes).toEqual([{ session_id: 'stored-1', omit_messages: true }, { session_id: 'stored-1', omit_messages: true }]);
      expect(decodeHermesNativeId(nativeId!)).toEqual({ sessionId: 'runtime-3', storedId: 'stored-1' });
      expect(reconnected.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['answer']);
    } finally {
      await closeHermesConnections();
      globalThis.WebSocket = OriginalWebSocket;
      if (originalUrl === undefined) delete process.env.MACARON_HERMES_URL; else process.env.MACARON_HERMES_URL = originalUrl;
    }
  });
});
