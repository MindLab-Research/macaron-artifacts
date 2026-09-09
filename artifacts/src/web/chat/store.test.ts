import { afterEach, describe, expect, test } from 'bun:test';
import type { ChatChunk, Session } from '../../shared/types';
import { WorkspaceStore } from './store';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });
const session = (id: string): Session => ({ id, harness: 'claude-code', cwd: '/workspace', title: id, messages: [], suggestions: [], createdAt: 1, updatedAt: 1, status: 'idle' });
const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('persistent session chat connections', () => {
  test('drafts belong to sessions and keystrokes do not publish the workspace snapshot', () => {
    const store = new WorkspaceStore(), snapshot = store.getSnapshot();
    let firstUpdates = 0, secondUpdates = 0;
    const unsubscribe = store.subscribeDraft('first', () => firstUpdates++);
    store.subscribeDraft('second', () => secondUpdates++);
    store.setDraft('first', 'Unsent in A'); store.setDraft('second', 'Unsent in B');
    expect(store.draft('first')).toBe('Unsent in A'); expect(store.draft('second')).toBe('Unsent in B');
    expect(firstUpdates).toBe(1); expect(secondUpdates).toBe(1); expect(store.getSnapshot()).toBe(snapshot);
    store.setDraft('first', ''); expect(store.draft('second')).toBe('Unsent in B');
    unsubscribe(); store.setDraft('first', 'New draft'); expect(firstUpdates).toBe(2);
  });

  test('clearing a session profile and model removes old summary values when JSON omits the cleared fields', async () => {
    const first = { ...session('first'), profileId: 'previous-profile', model: 'previous-model' };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (init?.method === 'PATCH') {
        expect(JSON.parse(String(init.body))).toEqual({ profileId: null, model: null });
        const { profileId: _profile, model: _model, ...cleared } = first;
        return Response.json(cleared);
      }
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore(); await store.initialize(); const chat = store.chat('first');
    expect(store.active()).toMatchObject({ profileId: 'previous-profile', model: 'previous-model' });
    await store.configure('first', { profileId: null, model: null });
    expect(store.active()?.profileId).toBeUndefined(); expect(store.active()?.model).toBeUndefined(); expect(store.chat('first')).toBe(chat);
  });

  test('a delayed finish GET cannot restore the old profile after configuration PATCH or stall the next turn', async () => {
    const first = { ...session('first'), profileId: 'previous-profile', model: 'previous-model' };
    let started!: () => void, release!: () => void;
    const refreshing = new Promise<void>(resolve => { started = resolve; });
    let reads = 0, sends = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (path === '/api/chat') {
        sends++; first.messages = JSON.parse(String(init?.body)).messages;
        return new Response(`data: {"type":"start","messageId":"answer-${sends}"}\n\ndata: {"type":"finish"}\n\n`, { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      }
      if (init?.method === 'PATCH') { Object.assign(first, JSON.parse(String(init.body))); return Response.json(first); }
      if (++reads === 2) {
        const stale = structuredClone(first);
        return new Promise<Response>(resolve => { release = () => resolve(Response.json(stale)); started(); });
      }
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore(); await store.initialize();
    store.send('first', 'Finish the previous turn'); await refreshing;
    try {
      await store.configure('first', { profileId: 'next-profile', model: 'next-model' });
      expect(store.active()).toMatchObject({ profileId: 'next-profile', model: 'next-model' });
    } finally { release(); }
    await tick();
    expect(store.active()).toMatchObject({ profileId: 'next-profile', model: 'next-model' });
    store.send('first', 'Use the selected profile'); await tick(); await tick();
    expect(sends).toBe(2); expect(store.chat('first')?.status).toBe('ready');
  });

  test('configuration saved while the initial transcript loads keeps the newer summary and still initializes chat data', async () => {
    const first = { ...session('first'), profileId: 'previous-profile', model: 'previous-model', messages: [{ id: 'saved-message', role: 'assistant' as const, parts: [{ type: 'text' as const, text: 'Durable history' }] }] };
    let started!: () => void, release!: () => void;
    const loading = new Promise<void>(resolve => { started = resolve; });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (init?.method === 'PATCH') return Response.json({ ...first, ...JSON.parse(String(init.body)), title: 'Current title' });
      return new Promise<Response>(resolve => { release = () => resolve(Response.json(first)); started(); });
    }) as typeof fetch;
    const store = new WorkspaceStore(), initialized = store.initialize(); await loading;
    try { await store.configure('first', { profileId: 'next-profile', model: 'next-model' }); }
    finally { release(); }
    await initialized;
    expect(store.active()).toMatchObject({ title: 'Current title', status: 'idle', profileId: 'next-profile', model: 'next-model' });
    expect(store.chat('first')?.messages).toEqual(first.messages); expect(store.getSnapshot().loading).toBe(false);
  });
  for (const failure of ['network', 400, 409] as const) test(`a rejected ${failure} submission preserves its prompt and retries the same message only on demand`, async () => {
    const first = session('first');
    const requests: { id: string; messages: Session['messages'] }[] = [];
    let accepted = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (path === '/api/chat') {
        const request = JSON.parse(String(init?.body));
        requests.push(request);
        if (!accepted) {
          if (failure === 'network') throw new TypeError('fetch failed before acceptance');
          return Response.json({ error: 'Rejected before acceptance' }, { status: failure });
        }
        const user = request.messages.findLast((message: Session['messages'][number]) => message.role === 'user');
        first.messages = [user, { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'Accepted', state: 'done' }] }];
        return new Response('data: {"type":"start","messageId":"answer"}\n\ndata: {"type":"text-start","id":"t"}\n\ndata: {"type":"text-delta","id":"t","delta":"Accepted"}\n\ndata: {"type":"text-end","id":"t"}\n\ndata: {"type":"finish"}\n\n', { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      }
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    store.send('first', 'Keep this exact original intent');
    await tick(); await tick();
    const original = store.chat('first')!.messages[0];
    expect(original.parts).toEqual([{ type: 'text', text: 'Keep this exact original intent' }]);
    expect(store.chat('first')?.status).toBe('error');
    expect(store.chat('first')?.error).toBeDefined();
    expect(store.active()?.status).toBe('error');
    expect(requests).toHaveLength(1);
    accepted = true;
    await store.retry('first');
    await tick();
    expect(requests).toHaveLength(2);
    expect(requests[1].messages).toEqual([original]);
    expect(store.chat('first')?.messages.filter(message => message.role === 'user')).toEqual([original]);
    expect(store.chat('first')?.messages.at(-1)?.parts).toEqual([{ type: 'text', text: 'Accepted', state: 'done' }]);
  });

  test('a disconnected completed turn restores durable history when the active stream is gone', async () => {
    const first = session('first');
    let turn!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (path.endsWith('/stream')) return new Response(null, { status: 204 });
      if (path === '/api/chat') return new Response(new ReadableStream({ start(controller) { turn = controller; } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    store.send('first', 'question');
    await tick();
    turn.enqueue(encoder.encode('data: {"type":"start","messageId":"answer"}\n\ndata: {"type":"text-start","id":"text"}\n\ndata: {"type":"text-delta","id":"text","delta":"PARTIAL"}\n\n'));
    await tick();
    first.status = 'running';
    turn.error(new TypeError('network disconnected'));
    await tick();
    first.status = 'idle';
    first.messages = [store.chat('first')!.messages[0], { id: 'answer', role: 'assistant', parts: [{ type: 'text', text: 'PARTIAL AND COMPLETE', state: 'done' }] }];
    await store.resume('first');
    expect(store.chat('first')?.messages).toEqual(first.messages);
    expect(store.chat('first')?.error).toBeUndefined();
    expect(store.chat('first')?.status).toBe('ready');
  });

  test('loading a running turn accepts stream revisions older than the disk listing timestamp', async () => {
    const first = { ...session('first'), status: 'running' as const };
    const path = '.artifacts/card.tsx';
    let turn!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const route = String(input);
      if (route === '/api/harnesses') return Response.json([]);
      if (route === '/api/sessions') return Response.json([first]);
      if (route.endsWith('/artifacts')) return Response.json([{ path, source: 'DISK OLD', streaming: false, revision: 5000 }]);
      if (route.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (route.endsWith('/stream')) return new Response(new ReadableStream({ start(controller) { turn = controller; } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    await tick();
    for (const chunk of [{ type: 'start', messageId: 'answer' }, { type: 'data-artifact', id: path, data: { path, source: 'FINAL NEW', streaming: false, revision: 1101 } }, { type: 'data-artifact', id: path, data: { path, source: 'STALE LIVE', streaming: true, revision: 1100 } }, { type: 'finish' }]) turn.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
    turn.close();
    await tick();
    expect(store.artifacts('first')).toEqual([{ path, source: 'FINAL NEW', streaming: false, revision: 1101 }]);
  });

  test('an old finish refresh cannot restore suggestions over a newer active turn', async () => {
    const first = session('first');
    const turns: ReadableStreamDefaultController<Uint8Array>[] = [];
    let releaseRefresh!: () => void;
    let reads = 0;
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response('data: {"suggestions":[]}\n\n');
      if (path === '/api/chat') return new Response(new ReadableStream({ start(controller) { turns.push(controller); } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      if (++reads === 2) return new Promise<Response>(resolve => { releaseRefresh = () => resolve(Response.json({ ...first, title: 'STALE TITLE', suggestions: ['STALE SUGGESTION'] })); });
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    store.send('first', 'first question');
    await tick();
    turns[0].enqueue(encoder.encode('data: {"type":"start","messageId":"a"}\n\ndata: {"type":"finish"}\n\n'));
    turns[0].close();
    await tick();
    store.send('first', 'second question');
    await tick();
    releaseRefresh();
    await tick();
    expect(store.active()?.title).toBe('first');
    expect(store.active()?.suggestions).toEqual([]);
    expect(store.active()?.status).toBe('running');
    expect(store.chat('first')?.messages.filter(message => message.role === 'user')).toHaveLength(2);
    turns[1].enqueue(encoder.encode('data: {"type":"start","messageId":"b"}\n\ndata: {"type":"finish"}\n\n'));
    turns[1].close();
    await tick();
  });

  test('metadata leaves chat idle and stale frames cannot overwrite a newly started turn', async () => {
    const first = session('first');
    const metadata: { controller: ReadableStreamDefaultController<Uint8Array>; signal?: AbortSignal | null }[] = [];
    let turn!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path.endsWith('/metadata')) return new Response(new ReadableStream({ start(controller) { metadata.push({ controller, signal: init?.signal }); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (path === '/api/chat') return new Response(new ReadableStream({ start(controller) { turn = controller; } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } });
      return Response.json(first);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    metadata[0].controller.enqueue(encoder.encode('data: {"title":"Named","suggestions":["Next"]}\n\n'));
    await tick();
    expect(store.chat('first')?.status).toBe('ready');
    expect(store.active()?.title).toBe('Named');
    expect(store.active()?.suggestions).toEqual(['Next']);
    store.send('first', 'New turn');
    await tick();
    expect(metadata[0].signal?.aborted).toBe(true);
    metadata[0].controller.enqueue(encoder.encode('data: {"title":"Stale title","suggestions":["Old"]}\n\n'));
    metadata[0].controller.close();
    await tick();
    expect(store.active()?.title).toBe('Named');
    expect(store.active()?.suggestions).toEqual([]);
    turn.enqueue(encoder.encode('data: {"type":"start","messageId":"new"}\n\ndata: {"type":"finish"}\n\n'));
    turn.close();
    await tick();
    for (const entry of metadata.slice(1)) entry.controller.close();
  });

  test('switching sessions keeps consuming the first stream and routes data to its owning session', async () => {
    const first = session('first');
    const second = session('second');
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    let streamSignal: AbortSignal | null | undefined;
    const encode = (chunk: ChatChunk) => new TextEncoder().encode(`data: ${JSON.stringify(chunk)}\n\n`);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === '/api/harnesses') return Response.json([]);
      if (path === '/api/sessions') return Response.json([first, second]);
      if (path.endsWith('/artifacts')) return Response.json([]);
      if (path === '/api/chat') { streamSignal = init?.signal; return new Response(new ReadableStream({ start(value) { controller = value; } }), { headers: { 'content-type': 'text/event-stream', 'x-vercel-ai-ui-message-stream': 'v1' } }); }
      return Response.json(path.endsWith('/first') ? first : second);
    }) as typeof fetch;
    const store = new WorkspaceStore();
    await store.initialize();
    const originalChat = store.chat('first');
    store.send('first', 'Build a card');
    await tick();
    controller.enqueue(encode({ type: 'start', messageId: 'answer' }));
    controller.enqueue(encode({ type: 'text-start', id: 'text' }));
    controller.enqueue(encode({ type: 'text-delta', id: 'text', delta: 'before ' }));
    await tick();
    await store.select('second');
    expect(streamSignal?.aborted).toBe(false);
    controller.enqueue(encode({ type: 'text-delta', id: 'text', delta: 'after' }));
    controller.enqueue(encode({ type: 'data-artifact', id: 'file', data: { path: '.artifacts/test.tsx', source: 'export default () => <p>ok</p>', revision: 1, streaming: false } }));
    controller.enqueue(encode({ type: 'data-recap', id: 'recap', data: { title: 'First title', suggestions: ['Change it'] } }));
    controller.enqueue(encode({ type: 'text-end', id: 'text' }));
    controller.enqueue(encode({ type: 'finish' }));
    controller.close();
    await tick();
    expect(store.getSnapshot().activeId).toBe('second');
    expect(store.artifacts('second')).toHaveLength(0);
    expect(store.artifacts('first')).toHaveLength(1);
    await store.select('first');
    expect(store.chat('first')).toBe(originalChat);
    expect(originalChat?.messages.at(-1)?.parts.find(part => part.type === 'text')).toEqual({ type: 'text', text: 'before after', state: 'done' });
  });
});
