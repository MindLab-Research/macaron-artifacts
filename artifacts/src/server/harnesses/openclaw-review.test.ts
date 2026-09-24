import { expect, test } from 'bun:test';
import { openClawReviewUrl, readProviderReview, describeProviderReview } from './openclaw-review.js';
import { openClawAdapter, encodeOpenClawNativeId } from './openclaw.js';
import type { ProviderReview } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';

const key = 'agent:main:review-test', id = 'generation-1';
const review = { id: 'review-1', runId: 'old-run', canContinue: false, explanation: 'Manual provider review required.' };
test('literal Control UI links preserve proxy base and reject unsafe bases', () => {
  expect(openClawReviewUrl('https://control.example/proxy/', 'agent:main:topic:release.js')).toBe('https://control.example/proxy/chat/main/~key/topic/release%2Ejs');
  expect(openClawReviewUrl('https://control.example', 'agent:main:..')).toBe('https://control.example/chat/main/~key/~dotdot');
  for (const base of ['javascript:alert(1)', 'file:///tmp/x', 'https://user:secret@example.com', 'https://example.com?token=secret', 'https://example.com/#secret']) expect(openClawReviewUrl(base, key)).toBeUndefined();
  expect(openClawReviewUrl('https://example.com', 'unscoped-key')).toBeUndefined();
});
test('non-continuable reviews are valid; malformed review cannot mean cleared', () => {
  expect(readProviderReview(review, { key, id })?.canContinue).toBe(false);
  for (const invalid of [{}, false, { ...review, canContinue: 'false' }, { ...review, explanation: {} }]) expect(() => readProviderReview(invalid, { key, id })).toThrow();
});
test('describe uses the closed upstream request schema and validates wrapper/key/generation', async () => {
  let args: unknown;
  const client = { async request<T>(_method: string, params: unknown): Promise<T> { args = params; return { session: { key, sessionId: id, providerReview: review } } as T; } };
  expect((await describeProviderReview(client, { key, id })).review?.id).toBe(review.id);
  expect(args).toEqual({ key });
  for (const response of [{}, { session: null }, { session: {} }, { session: { key: 'wrong', sessionId: id } }, { session: { key, sessionId: 'wrong' } }]) {
    await expect(describeProviderReview({ async request<T>() { return response as T; } }, { key, id })).rejects.toThrow();
  }
});
test('describe handles ordinary rows without providerReview', async () => {
  const client = { async request<T>(): Promise<T> { return { session: { key, sessionId: id } } as T; } };
  const result = await describeProviderReview(client, { key, id });
  expect(result.sessionId).toBe(id);
  expect(result.review).toBeUndefined();
});
test('describe handles paused review rows', async () => {
  const pausedReview = { ...review, id: 'review-2', runId: 'paused-run' };
  const client = { async request<T>(): Promise<T> { return { session: { key, sessionId: id, providerReview: pausedReview } } as T; } };
  const result = await describeProviderReview(client, { key, id });
  expect(result.review?.canContinue).toBe(false);
  expect(result.review?.explanation).toBe(review.explanation);
});

async function replay(mode: 'initial' | 'terminal-error' | 'terminal-end' | 'different-session' | 'different-generation') {
  const requests: { method: string; params: Record<string, any> }[] = [], reviews: ProviderReview[] = [];
  let pending = mode === 'initial';
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(req, s) { if (s.upgrade(req)) return; return new Response(null, { status: 400 }); }, websocket: {
    open(ws) { ws.send(JSON.stringify({ type: 'event', event: 'connect.challenge', payload: { nonce: 'test', ts: Date.now() } })); },
    message(ws, data) {
      const request = JSON.parse(String(data)), { method, params = {} } = request; requests.push({ method, params });
      const reply = (payload: unknown) => ws.send(JSON.stringify({ type: 'res', id: request.id, ok: true, payload }));
      if (method === 'connect') reply({ type: 'hello-ok', protocol: 4, features: { methods: ['sessions.describe', 'sessions.subscribe', 'agent'] }, policy: { tickIntervalMs: 30000 } });
      else if (method === 'sessions.describe') reply({ session: { key, sessionId: id, ...(pending ? { providerReview: review } : {}) } });
      else if (method === 'sessions.subscribe') reply({ ok: true });
      else if (method === 'agent') {
        reply({ runId: params.idempotencyKey, status: 'accepted' });
        pending = mode.startsWith('terminal');
        ws.send(JSON.stringify({ type: 'event', event: 'sessions.updated', payload: { sessionKey: mode === 'different-session' ? 'agent:main:other' : key, sessionId: mode === 'different-generation' ? 'stale' : id, runId: 'not-the-agent-run', providerReview: review } }));
        ws.send(JSON.stringify({ type: 'event', event: 'agent', payload: { sessionKey: key, runId: params.idempotencyKey, stream: 'lifecycle', data: { phase: mode === 'terminal-error' ? 'error' : 'end', error: 'requires review' } } }));
      } else reply({ ok: true });
    },
  } });
  const turn: HarnessTurn = { nativeId: encodeOpenClawNativeId({ key, id, cwd: '/tmp' }), cwd: '/tmp', prompt: 'hello', instructions: '', signal: AbortSignal.timeout(5000), profile: { config: { gatewayUrl: `ws://127.0.0.1:${server.port}` } }, onNativeSession() {}, onProviderReview(value) { reviews.push(value); }, approve: async () => false, ask: async () => ({ cancelled: true }) };
  let error: unknown;
  try { for await (const _ of openClawAdapter.run(turn)) { /* consume */ } } catch (cause) { error = cause; }
  finally { server.stop(true); }
  return { requests, reviews, error };
}
for (const mode of ['initial', 'terminal-error', 'terminal-end', 'different-session', 'different-generation'] as const) test(`real GatewayClient preserves review semantics: ${mode}`, async () => {
  const result = await replay(mode);
  expect(result.requests.some(request => ['sessions.providerReview.continue', 'sessions.patch', 'sessions.create', 'sessions.reset'].includes(request.method))).toBe(false);
  if (mode === 'initial') { expect(result.requests.filter(request => request.method === 'agent')).toHaveLength(0); expect(result.error).toBeDefined(); }
  else expect(result.requests.filter(request => request.method === 'agent')).toHaveLength(1);
  if (mode.startsWith('different')) expect(result.reviews).toHaveLength(0);
  else { expect(result.reviews.length).toBeGreaterThan(0); expect(result.reviews[0]?.scope).toMatch(/^[a-f0-9]{64}$/); expect(result.reviews[0]?.canContinue).toBe(false); }
});
