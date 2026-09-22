import { afterEach, expect, test } from 'bun:test';
import { WorkspaceStore } from './store';
import type { Session } from '../../shared/types';
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

test('provider-review stream holds queued intent and draft through refresh until explicit send', async () => {
  const first: Session = { id: 'review', harness: 'openclaw', cwd: '/workspace', title: 'review', messages: [], suggestions: [], status: 'idle', createdAt: 1, updatedAt: 1 };
  const turns: ReadableStreamDefaultController<Uint8Array>[] = [];
  let failRefresh = true;
  globalThis.fetch = (async input => {
    const path = String(input);
    if (path === '/api/harnesses' || path.endsWith('/artifacts')) return Response.json([]);
    if (path === '/api/sessions') return Response.json([first]);
    if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
    if (path.endsWith('/provider-review/refresh')) {
      if (failRefresh) return Response.json({ error: 'Gateway unavailable' }, { status: 503 });
      first.providerReview = undefined; return Response.json({ providerReview: null });
    }
    if (path === '/api/chat') return new Response(new ReadableStream({ start(controller) { turns.push(controller); } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
    return Response.json(first);
  }) as typeof fetch;
  const store = new WorkspaceStore(), encoder = new TextEncoder();
  try {
    await store.initialize(); store.send(first.id, 'first prompt'); await tick();
    store.send(first.id, 'held prompt'); store.setDraft(first.id, 'unsent draft');
    first.providerReview = { id: 'r', runId: 'old', sessionId: 'native', canContinue: false }; first.status = 'idle';
    turns[0]!.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', messageId: 'a' })}\n\ndata: ${JSON.stringify({ type: 'data-providerReview', data: first.providerReview, transient: true })}\n\ndata: {"type":"finish"}\n\n`)); turns[0]!.close();
    await tick(); await tick(); await tick();
    expect(store.active()?.providerReview?.id).toBe('r'); expect(turns).toHaveLength(1); expect(store.queue(first.id).map(q => q.text)).toEqual(['held prompt']);
    store.send(first.id, 'must not send'); await store.retry(first.id); expect(turns).toHaveLength(1); expect(store.draft(first.id)).toBe('unsent draft');
    await expect(store.refreshProviderReview(first.id)).rejects.toThrow('Gateway unavailable'); expect(store.active()?.providerReview).toBeDefined();
    failRefresh = false; await store.refreshProviderReview(first.id); await tick();
    expect(store.active()?.providerReview).toBeUndefined(); expect(turns).toHaveLength(1); expect(store.queue(first.id)).toHaveLength(1); expect(store.draft(first.id)).toBe('unsent draft');
    store.sendQueued(first.id); await tick(); expect(turns).toHaveLength(2);
    turns[1]!.enqueue(encoder.encode('data: {"type":"start","messageId":"b"}\n\ndata: {"type":"finish"}\n\n')); turns[1]!.close(); await tick(); await tick();
  } finally { store.dispose(); }
});
