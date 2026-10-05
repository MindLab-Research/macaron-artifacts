import { describe, expect, test } from 'bun:test';
import type { Question } from '../../shared/questions.js';
import { closeHermesConnections, decodeHermesNativeId, encodeHermesNativeId } from './hermes.js';
import { parseHermesReadyLine, rpcPayload } from './hermes-server.js';

type FakeRequest = { jsonrpc?: string; id: number | string; method?: string; params?: Record<string, unknown>; result?: unknown; error?: unknown };
interface FakeGateway {
  connections: number;
  closed: number;
  readonly sent: FakeRequest[];
  reply(request: FakeRequest, result: Record<string, unknown>): void;
  replyError(request: FakeRequest, code: number, message: string): void;
  event(type: string, payload: Record<string, unknown>, sessionId?: string): void;
  serverRequest(id: string, method: string, params: Record<string, unknown>): void;
  /** Deliver on a later turn, the way the real gateway never answers within the same send. */
  soon(action: () => void): void;
}
type FakeRoute = (request: FakeRequest, gateway: FakeGateway) => void;

/**
 * In-process stand-in for the public `serve` gateway: it announces readiness, records every client frame
 * and lets each test route the replies. Only one socket is live at a time, so frames go to the newest.
 */
function fakeGateway(route: FakeRoute) {
  let current: FakeWebSocket | undefined;
  const deliver = (frame: Record<string, unknown>) => current?.deliver(JSON.stringify(frame));
  const gateway: FakeGateway = {
    connections: 0,
    closed: 0,
    sent: [],
    reply: (request, result) => deliver({ jsonrpc: '2.0', id: request.id, result }),
    replyError: (request, code, message) => deliver({ jsonrpc: '2.0', id: request.id, error: { code, message } }),
    event: (type, payload, sessionId) => deliver({ jsonrpc: '2.0', method: 'event', params: { type, ...(sessionId ? { session_id: sessionId } : {}), payload } }),
    serverRequest: (id, method, params) => deliver({ jsonrpc: '2.0', id, method, params }),
    soon: action => queueMicrotask(action),
  };
  class FakeWebSocket {
    static OPEN = 1;
    static CLOSING = 2;
    readyState = 1;
    private listeners = new Map<string, Set<(event: { data?: string }) => void>>();
    constructor() { current = this; gateway.connections++; queueMicrotask(() => gateway.event('gateway.ready', {})); }
    addEventListener(type: string, listener: (event: { data?: string }) => void) { let listeners = this.listeners.get(type); if (!listeners) this.listeners.set(type, listeners = new Set()); listeners.add(listener); }
    send(raw: string) { const request = JSON.parse(raw) as FakeRequest; gateway.sent.push(request); route(request, gateway); }
    close() { gateway.closed++; this.readyState = 3; }
    deliver(raw: string) { for (const listener of this.listeners.get('message') ?? []) listener({ data: raw }); }
  }
  return { socket: FakeWebSocket, gateway };
}

/** Point the adapter at a fake gateway for one test, then restore the global socket and configured URL. */
async function withFakeGateway(url: string, route: FakeRoute, run: (gateway: FakeGateway) => Promise<void>) {
  const OriginalWebSocket = globalThis.WebSocket;
  const originalUrl = process.env.MACARON_HERMES_URL;
  const { socket, gateway } = fakeGateway(route);
  (globalThis as unknown as { WebSocket: unknown }).WebSocket = socket;
  process.env.MACARON_HERMES_URL = url;
  try { await run(gateway); }
  finally {
    await closeHermesConnections();
    globalThis.WebSocket = OriginalWebSocket;
    if (originalUrl === undefined) delete process.env.MACARON_HERMES_URL; else process.env.MACARON_HERMES_URL = originalUrl;
  }
}

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
    const events: [string, Record<string, unknown>][] = mode === 'interleaved' ? [
      ['thinking.delta', { text: 'plan ' }], ['reasoning.delta', { text: 'first' }],
      ['tool.start', { tool_id: 'tool-1', name: 'read_file', args: {} }], ['tool.complete', { tool_id: 'tool-1', result: 'source' }],
      ['thinking.delta', { text: 'check ' }], ['message.delta', { text: '' }], ['reasoning.delta', { text: 'result' }],
      ['message.delta', { text: 'answer' }], ['message.complete', { text: 'answer' }],
    ] : [['thinking.delta', { text: 'plan' }], ...(mode === 'streamed' ? [['message.delta', { text: 'answer' }]] as [string, Record<string, unknown>][] : []), ['message.complete', { text: 'answer' }]];
    let runtime = 0;
    const resumes: Record<string, unknown>[] = [];
    const route: FakeRoute = (request, gateway) => {
      const params = request.params ?? {};
      if (request.method === 'session.create') { expect(params.cwd).toBe('/tmp'); runtime = 1; gateway.reply(request, { session_id: 'runtime-1', stored_session_id: 'stored-1' }); }
      else if (request.method === 'session.resume') {
        // Hermes rejects unknown resume fields; cwd is only accepted when creating a session.
        const extra = Object.keys(params).find(key => !['session_id', 'omit_messages'].includes(key));
        if (extra) { gateway.replyError(request, -32602, `invalid params for session.resume: ${extra}: Extra inputs are not permitted`); return; }
        resumes.push(params); runtime++; gateway.reply(request, { session_id: `runtime-${runtime}`, stored_session_id: 'stored-1' });
      }
      else if (request.method === 'prompt.submit') { gateway.reply(request, { status: 'streaming' }); gateway.soon(() => { const sid = `runtime-${runtime}`; for (const [type, payload] of events) gateway.event(type, payload, sid); }); }
      else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const base = { cwd: '/tmp', instructions: '', signal: new AbortController().signal, ask: async () => ({ cancelled: true as const }), approve: async () => true, onNativeSession: (_id: string) => {} };
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
      expect(gateway.closed).toBe(1);
      const reconnected = await run('third');
      expect(gateway.connections).toBe(2);
      expect(resumes).toEqual([{ session_id: 'stored-1', omit_messages: true }, { session_id: 'stored-1', omit_messages: true }]);
      expect(decodeHermesNativeId(nativeId!)).toEqual({ sessionId: 'runtime-3', storedId: 'stored-1' });
      expect(reconnected.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['answer']);
    });
  });

  test('advertises server-request support and round-trips a clarify request', async () => {
    let activeSession = 'runtime-1';
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: ['clarify'] });
      else if (request.method === 'session.create') { activeSession = 'runtime-1'; gateway.reply(request, { session_id: activeSession, stored_session_id: 'stored-1' }); }
      else if (request.method === 'session.resume') {
        activeSession = 'runtime-2';
        gateway.reply(request, { session_id: activeSession, stored_session_id: 'stored-1', open_requests: [{ id: 'srq-unknown', method: 'future.request', params: { session_id: activeSession } }, { id: 'srq-replay', method: 'clarify', params: { session_id: activeSession, question: 'Resume?', choices: ['North, America'], multi_select: true } }] });
      }
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-clarify', 'clarify', { session_id: activeSession, questions: [{ qid: 'q1', question: 'Continue?', choices: ['North, America', 'No'], multi_select: true }] }));
      }
      else if (request.id === 'srq-clarify') {
        expect(request.method).toBeUndefined();
        expect(request.params).toBeUndefined();
        gateway.soon(() => gateway.event('message.complete', { text: 'done' }, activeSession));
      }
      else if (request.id === 'srq-replay') gateway.soon(() => gateway.event('message.complete', { text: 'resumed' }, activeSession));
      else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      let nativeId = '';
      const base = {
        cwd: '/tmp', instructions: '', signal: new AbortController().signal,
        ask: async (request: { questions: { id: string; question: string; options: { label: string }[]; multiple?: boolean; custom?: boolean }[] }) => {
          if (request.questions[0]?.id === 'q1') expect(request.questions).toEqual([{ id: 'q1', question: 'Continue?', options: [{ label: 'North, America' }, { label: 'No' }], multiple: true, custom: false }]);
          else expect(request.questions).toEqual([{ id: 'single', question: 'Resume?', options: [{ label: 'North, America' }], multiple: true, custom: false }]);
          const answers: Record<string, string[]> = request.questions[0]?.id === 'q1' ? { q1: ['North, America'] } : { single: ['North, America'] };
          return { answers };
        },
        approve: async () => true,
        onNativeSession: (id: string) => { nativeId = id; },
      };
      const chunks = [];
      for await (const chunk of hermesAdapter.run({ ...base, prompt: 'ask me' })) chunks.push(chunk);
      expect(gateway.sent.find(request => request.method === 'client.capabilities')).toMatchObject({ params: { server_requests: true } });
      expect(gateway.sent.find(request => request.id === 'srq-clarify')).toEqual({ jsonrpc: '2.0', id: 'srq-clarify', result: { answers: { q1: '["North, America"]' } } });
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['done']);
      const promptSubmitCount = gateway.sent.filter(request => request.method === 'prompt.submit').length;
      for await (const chunk of hermesAdapter.run({ ...base, nativeId, prompt: 'resume me' })) chunks.push(chunk);
      expect(gateway.sent.filter(request => request.method === 'prompt.submit')).toHaveLength(promptSubmitCount + 1);
      expect(gateway.sent.find(request => request.id === 'srq-unknown')).toEqual({ jsonrpc: '2.0', id: 'srq-unknown', error: { code: -32601, message: 'no handler for server request: future.request' } });
      expect(gateway.sent.find(request => request.id === 'srq-replay')).toEqual({ jsonrpc: '2.0', id: 'srq-replay', result: { answer: '["North, America"]' } });
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['done', 'done']);
      await closeHermesConnections();
      expect(gateway.closed).toBe(1);
    });
  });

  test('answers request.cancel and does not answer the cancelled server request', async () => {
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: ['clarify'] });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-cancel', stored_session_id: 'stored-cancel' });
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-clarify-cancelled', 'clarify', { session_id: 'runtime-cancel', questions: [{ qid: 'q1', question: 'Continue?', choices: ['Yes'], multi_select: false }] }));
        gateway.soon(() => gateway.serverRequest('srq-cancel', 'request.cancel', { session_id: 'runtime-cancel', request_id: 'srq-clarify-cancelled' }));
      }
      else if (request.id === 'srq-cancel') {
        expect(request.method).toBeUndefined();
        gateway.soon(() => gateway.event('message.complete', { text: 'cancelled' }, 'runtime-cancel'));
      }
      else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.cancel.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const base = {
        cwd: '/tmp', instructions: '', signal: new AbortController().signal,
        ask: async (_request: unknown, signal?: AbortSignal) => {
          if (!signal) throw new Error('cancel smoke did not receive a request signal');
          return new Promise<{ cancelled: true }>(resolve => signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true }));
        },
        approve: async () => true,
        onNativeSession: (_id: string) => {},
      };
      const chunks = [];
      for await (const chunk of hermesAdapter.run({ ...base, prompt: 'ask then cancel' })) chunks.push(chunk);
      expect(gateway.sent.find(request => request.id === 'srq-cancel')).toEqual({ jsonrpc: '2.0', id: 'srq-cancel', result: {} });
      expect(gateway.sent.some(request => request.id === 'srq-clarify-cancelled')).toBe(false);
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['cancelled']);
    });
  });

  test('forwards Hermes notification show and clear events as transient data chunks', async () => {
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'session.create') {
        gateway.event('notification.show', {
          text: 'External memory is unavailable', level: 'warn', kind: 'sticky', ttl_ms: null,
          key: 'startup-warning.external-memory', id: 'notice-1',
        }, 'runtime-notice');
        gateway.reply(request, { session_id: 'runtime-notice', stored_session_id: 'stored-notice' });
      }
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => {
          gateway.event('notification.clear', { key: 'startup-warning.external-memory' }, 'runtime-notice');
          gateway.event('message.complete', { text: 'ready' }, 'runtime-notice');
          gateway.soon(() => gateway.event('notification.clear', { key: 'startup-warning.external-memory' }, 'runtime-notice'));
        });
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.notifications.test', route, async () => {
      const { hermesAdapter } = await import('./hermes.js');
      const base = { cwd: '/tmp', instructions: '', signal: new AbortController().signal, ask: async () => ({ cancelled: true as const }), approve: async () => true, onNativeSession: (_id: string) => {} };
      const chunks = [];
      for await (const chunk of hermesAdapter.run({ ...base, prompt: 'show startup notice' })) chunks.push(chunk);
      expect(chunks).toContainEqual({
        type: 'data-notification', id: 'hermes-notification:notice-1', transient: true,
        data: { action: 'show', text: 'External memory is unavailable', level: 'warn', kind: 'sticky', ttl_ms: null, key: 'startup-warning.external-memory', id: 'notice-1' },
      });
      expect(chunks).toContainEqual({
        type: 'data-notification', id: 'hermes-notification-clear:startup-warning.external-memory', transient: true,
        data: { action: 'clear', key: 'startup-warning.external-memory' },
      });
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['ready']);
    });
  });

  test('round-trips vault login and one-time-code requests as secret questions', async () => {
    let askCount = 0;
    const requestParams: Record<string, unknown>[] = [];
    const route: FakeRoute = (request, gateway) => {
      if (request.params) requestParams.push(request.params);
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: ['vault.save_login', 'vault.code'] });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-vault', stored_session_id: 'stored-vault' });
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-save-login', 'vault.save_login', { session_id: 'runtime-vault', origin: 'https://example.com/login?next=private', site: 'Example' }));
      } else if (request.id === 'srq-save-login') {
        expect(request.method).toBeUndefined();
        expect(request.params).toBeUndefined();
        gateway.soon(() => gateway.serverRequest('srq-code', 'vault.code', { session_id: 'runtime-vault', site: 'Example', hint: 'email' }));
      } else if (request.id === 'srq-code') {
        expect(request.method).toBeUndefined();
        expect(request.params).toBeUndefined();
        gateway.soon(() => gateway.event('message.complete', { text: 'vault complete' }, 'runtime-vault'));
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.vault.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const base = {
        cwd: '/tmp', instructions: '', signal: new AbortController().signal,
        ask: async (request: { questions: Question[] }): Promise<{ answers: Record<string, string[]> }> => {
          askCount++;
          if (askCount === 1) {
            expect(request.questions).toEqual([
              { id: 'identifier', header: 'example.com', question: '登录账号或邮箱', options: [], custom: true, secret: true, placeholder: '输入账号或邮箱' },
              { id: 'password', header: 'example.com', question: '登录密码', options: [], custom: true, secret: true, placeholder: '输入密码' },
            ]);
            return { answers: { identifier: ['alice@example.com'], password: ['vault-password'] } };
          }
          expect(request.questions).toEqual([{ id: 'code', header: 'Example', question: '一次性验证码', options: [], custom: true, secret: true, placeholder: '输入验证码' }]);
          return { answers: { code: ['123456'] } };
        },
        approve: async () => true,
        onNativeSession: (_id: string) => {},
      };
      const chunks = [];
      for await (const chunk of hermesAdapter.run({ ...base, prompt: 'trigger vault' })) chunks.push(chunk);
      expect(requestParams.every(params => !JSON.stringify(params).includes('alice@example.com') && !JSON.stringify(params).includes('vault-password') && !JSON.stringify(params).includes('123456'))).toBe(true);
      expect(gateway.sent.find(request => request.id === 'srq-save-login')).toEqual({ jsonrpc: '2.0', id: 'srq-save-login', result: { value: '{"identifier":"alice@example.com","password":"vault-password"}' } });
      expect(gateway.sent.find(request => request.id === 'srq-code')).toEqual({ jsonrpc: '2.0', id: 'srq-code', result: { value: '123456' } });
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['vault complete']);
    });
  });

  test('returns an empty vault value when the user cancels the prompt', async () => {
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: true });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-vault-cancel', stored_session_id: 'stored-vault-cancel' });
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-vault-cancel', 'vault.code', { session_id: 'runtime-vault-cancel', site: 'Example' }));
      } else if (request.id === 'srq-vault-cancel') {
        expect(request.result).toEqual({ value: '' });
        expect(request.params).toBeUndefined();
        gateway.soon(() => gateway.event('message.complete', { text: 'cancelled' }, 'runtime-vault-cancel'));
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.vault-cancel.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const chunks = [];
      for await (const chunk of hermesAdapter.run({
        cwd: '/tmp', prompt: 'cancel vault', instructions: '', signal: new AbortController().signal,
        ask: async () => ({ cancelled: true as const }), approve: async () => true, onNativeSession: () => {},
      })) chunks.push(chunk);
      expect(gateway.sent.find(request => request.id === 'srq-vault-cancel')).toEqual({ jsonrpc: '2.0', id: 'srq-vault-cancel', result: { value: '' } });
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['cancelled']);
    });
  });

  test('suppresses a timed-out vault request after request.cancel aborts its question', async () => {
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: true });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-vault-timeout', stored_session_id: 'stored-vault-timeout' });
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-vault-timeout', 'vault.code', { session_id: 'runtime-vault-timeout', site: 'Example' }));
      } else if (request.id === 'srq-vault-timeout') {
        throw new Error('A timed-out vault request must not receive a response');
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.vault-timeout.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const chunks = [];
      for await (const chunk of hermesAdapter.run({
        cwd: '/tmp', prompt: 'timeout vault', instructions: '', signal: new AbortController().signal,
        ask: async (_request, signal) => new Promise<{ cancelled: true }>(resolve => {
          if (!signal) throw new Error('vault timeout smoke did not receive a signal');
          signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
          queueMicrotask(() => {
            gateway.event('request.cancel', { id: 'srq-vault-timeout', method: 'vault.code', reason: 'timeout' }, 'runtime-vault-timeout');
            queueMicrotask(() => gateway.event('message.complete', { text: 'timeout vault finished' }, 'runtime-vault-timeout'));
          });
        }),
        approve: async () => true, onNativeSession: () => {},
      })) chunks.push(chunk);
      expect(gateway.sent.some(request => request.id === 'srq-vault-timeout')).toBe(false);
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['timeout vault finished']);
    });
  });

  test('routes vault requests only to the bound session and redacts handler errors', async () => {
    let asks = 0;
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: true });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-vault-route', stored_session_id: 'stored-vault-route' });
      else if (request.method === 'prompt.submit') {
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.serverRequest('srq-vault-foreign', 'vault.code', { session_id: 'other-session', site: 'Example' }));
      } else if (request.id === 'srq-vault-foreign') {
        expect(request.error).toEqual({ code: -32601, message: 'no handler for server request: vault.code' });
        gateway.soon(() => gateway.serverRequest('srq-vault-error', 'vault.code', { session_id: 'runtime-vault-route', site: 'Example' }));
      } else if (request.id === 'srq-vault-error') {
        expect(request.error).toEqual({ code: -32603, message: 'Hermes vault request failed' });
        gateway.soon(() => gateway.event('message.complete', { text: 'route complete' }, 'runtime-vault-route'));
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.vault-route.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const chunks = [];
      for await (const chunk of hermesAdapter.run({
        cwd: '/tmp', prompt: 'route vault', instructions: '', signal: new AbortController().signal,
        ask: async () => { asks++; throw new Error('handler failure with sensitive value'); },
        approve: async () => true, onNativeSession: () => {},
      })) chunks.push(chunk);
      expect(asks).toBe(1);
      expect(gateway.sent.find(request => request.id === 'srq-vault-foreign')?.error).toBeDefined();
      expect(JSON.stringify(gateway.sent.find(request => request.id === 'srq-vault-error'))).not.toContain('sensitive value');
      expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['route complete']);
    });
  });

  test('replays an open vault request after reconnect before submitting the next prompt', async () => {
    let nativeId = '';
    let promptSubmits = 0;
    const route: FakeRoute = (request, gateway) => {
      if (request.method === 'client.capabilities') gateway.reply(request, { server_requests: true });
      else if (request.method === 'session.create') gateway.reply(request, { session_id: 'runtime-vault-first', stored_session_id: 'stored-vault-reconnect' });
      else if (request.method === 'session.resume') gateway.reply(request, { session_id: 'runtime-vault-reconnected', stored_session_id: 'stored-vault-reconnect', open_requests: [{ id: 'srq-vault-replay', method: 'vault.code', params: { session_id: 'runtime-vault-reconnected', site: 'Example' } }] });
      else if (request.method === 'prompt.submit') {
        promptSubmits++;
        gateway.reply(request, { status: 'streaming' });
        gateway.soon(() => gateway.event('message.complete', { text: promptSubmits === 1 ? 'first' : 'second' }, promptSubmits === 1 ? 'runtime-vault-first' : 'runtime-vault-reconnected'));
      } else if (request.id === 'srq-vault-replay') {
        expect(request.result).toEqual({ value: '654321' });
        expect(request.params).toBeUndefined();
        gateway.soon(() => gateway.event('message.complete', { text: 'replayed request complete' }, 'runtime-vault-reconnected'));
      } else gateway.reply(request, {});
    };
    await withFakeGateway('ws://hermes.vault-reconnect.test', route, async gateway => {
      const { hermesAdapter } = await import('./hermes.js');
      const base = {
        cwd: '/tmp', instructions: '', signal: new AbortController().signal,
        ask: async (request: { questions: Question[] }) => {
          expect(request.questions).toEqual([{ id: 'code', header: 'Example', question: '一次性验证码', options: [], custom: true, secret: true, placeholder: '输入验证码' }]);
          return { answers: { code: ['654321'] } };
        },
        approve: async () => true, onNativeSession: (id: string) => { nativeId = id; },
      };
      const first = [];
      for await (const chunk of hermesAdapter.run({ ...base, prompt: 'first prompt' })) first.push(chunk);
      const second = [];
      for await (const chunk of hermesAdapter.run({ ...base, nativeId, prompt: 'second prompt' })) second.push(chunk);
      expect(gateway.sent.find(request => request.id === 'srq-vault-replay')).toEqual({ jsonrpc: '2.0', id: 'srq-vault-replay', result: { value: '654321' } });
      expect(promptSubmits).toBe(2);
      expect(first.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['first']);
      expect(second.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['second']);
    });
  });
});
