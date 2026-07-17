import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import type { Message } from '@macaron/shared';
import {
  attachLive,
  clearLive,
  fingerprintLiveTurn,
  getLive,
  snapshotCoversLiveTurn,
  startNewSession,
  subscribeLive,
  type LiveState,
} from '../src/lib/liveStore';

const originalFetch = globalThis.fetch;
const encoder = new TextEncoder();

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function frame(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

function sseResponse(events: unknown[]): Response {
  return new Response(events.map(frame).join('') + frame('[DONE]'), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

function streamedText(sid: string): string {
  return getLive(sid)?.timeline
    .filter((item) => item.kind === 'text')
    .map((item) => item.text)
    .join('') ?? '';
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.fail('condition was not met');
}

test('concurrent reattach probes share one SSE reader and apply each delta once', async () => {
  const sid = 'single-flight-session';
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return sseResponse([
      { type: 'meta', cwd: '/repo', sessionId: sid, startedAt: 1234 },
      { type: 'user-text', text: 'question' },
      { type: 'delta', text: 'The ' },
      { type: 'delta', text: 'user' },
      { type: 'done', exitCode: 0 },
    ]);
  };

  const results = await Promise.all([
    attachLive('project', sid),
    attachLive('project', sid),
  ]);
  await waitFor(() => getLive(sid)?.done === true);

  assert.deepEqual(results, ['attached', 'attached']);
  assert.equal(fetches, 1);
  assert.equal(getLive(sid)?.cwd, '/repo');
  assert.equal(getLive(sid)?.startedAt, 1234);
  assert.equal(getLive(sid)?.userText, 'question');
  assert.equal(streamedText(sid), 'The user');
  clearLive(sid);

  // The server retains the ended ring briefly. Once consumed, a sequential
  // remount probes its identity but must not replay that completed turn.
  assert.equal(await attachLive('project', sid), 'not-live');
  assert.equal(fetches, 2);
});

test('an existing new-session POST owner prevents a second live attachment', async () => {
  const sid = 'post-owned-session';
  let fetches = 0;
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(new ReadableStream<Uint8Array>({
      start(next) {
        controller = next;
        next.enqueue(encoder.encode(
          frame({ type: 'meta', cwd: '/repo', sessionId: sid }) +
          frame({ type: 'delta', text: 'only once' }),
        ));
      },
    }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };

  assert.equal(await startNewSession('project', { text: 'question' }), sid);
  assert.equal(await attachLive('project', sid), 'attached');
  assert.equal(fetches, 1);
  assert.equal(streamedText(sid), 'only once');

  controller.enqueue(encoder.encode(frame({ type: 'done', exitCode: 0 }) + frame('[DONE]')));
  controller.close();
  await waitFor(() => getLive(sid)?.done === true);
  clearLive(sid);
});

test('an ended replay can be consumed before the attach promise callback runs', async () => {
  const sid = 'ended-replay-session';
  globalThis.fetch = async () => sseResponse([
    { type: 'meta', cwd: '/repo', sessionId: sid },
    { type: 'user-text', text: 'question' },
    { type: 'delta', text: 'answer' },
    { type: 'done', exitCode: 0 },
  ]);

  let rendered = '';
  const unsubscribe = subscribeLive(sid, (state) => {
    rendered = state.timeline
      .filter((item) => item.kind === 'text')
      .map((item) => item.text)
      .join('');
    if (state.done) clearLive(sid);
  });

  assert.equal(await attachLive('project', sid), 'attached');
  assert.equal(rendered, 'answer');
  assert.equal(getLive(sid), undefined);
  unsubscribe();
});

function transcriptMessage(
  role: Message['role'],
  timestamp: string,
  blocks: Message['blocks'],
): Message {
  return { role, timestamp, blocks };
}

test('snapshot handoff rejects stale and partial JSONL, then accepts the complete live turn', () => {
  const startedAt = Date.parse('2026-07-14T10:00:00.000Z');
  const live: LiveState = {
    cwd: '/repo',
    startedAt,
    userText: 'hello',
    userImages: [],
    timeline: [{ kind: 'text', id: 'live-t-1', text: 'Hey! What are you working on today?' }],
    outputTokens: 9,
    done: true,
    terminalSeen: true,
  };
  const turn = fingerprintLiveTurn(live);
  const oldTimestamp = '2026-07-14T09:59:50.000Z';
  const currentTimestamp = '2026-07-14T10:00:00.100Z';

  const stale: Message[] = [
    transcriptMessage('user', oldTimestamp, [{ kind: 'text', text: 'hello' }]),
    transcriptMessage('assistant', oldTimestamp, [{ kind: 'text', text: 'Hey! What are you working on today?' }]),
  ];
  assert.equal(snapshotCoversLiveTurn(stale, turn), false);

  const partial: Message[] = [
    ...stale,
    transcriptMessage('user', currentTimestamp, [{ kind: 'text', text: 'hello' }]),
  ];
  assert.equal(snapshotCoversLiveTurn(partial, turn), false);

  const complete: Message[] = [
    ...partial,
    transcriptMessage('assistant', currentTimestamp, [{ kind: 'text', text: 'Hey! What are you working on today?' }]),
  ];
  assert.equal(snapshotCoversLiveTurn(complete, turn), true);
});

test('snapshot handoff tolerates persisted assistant line-ending and trailing-space normalization', () => {
  const startedAt = Date.parse('2026-07-14T10:00:00.000Z');
  const turn = fingerprintLiveTurn({
    cwd: '/repo',
    startedAt,
    userText: 'hello',
    userImages: [],
    timeline: [{ kind: 'text', id: 'live-t-1', text: 'first\r\nsecond  \r\n' }],
    outputTokens: 4,
    done: true,
    terminalSeen: true,
  });
  const timestamp = '2026-07-14T10:00:00.100Z';
  const normalized: Message[] = [
    transcriptMessage('user', timestamp, [{ kind: 'text', text: 'hello' }]),
    transcriptMessage('assistant', timestamp, [{ kind: 'text', text: 'first\nsecond' }]),
  ];

  assert.equal(snapshotCoversLiveTurn(normalized, turn), true);
  assert.equal(snapshotCoversLiveTurn([
    normalized[0]!,
    transcriptMessage('assistant', timestamp, [{ kind: 'text', text: 'first' }]),
  ], turn), false);
});

test('snapshot handoff waits for persisted tool results that were visible live', () => {
  const startedAt = Date.parse('2026-07-14T10:00:00.000Z');
  const live: LiveState = {
    cwd: '/repo',
    startedAt,
    userText: 'inspect it',
    userImages: [],
    timeline: [{ kind: 'tool', id: 'live-tool-1', name: 'Read', input: { file_path: '/repo/a.ts' }, result: 'content' }],
    outputTokens: 0,
    done: true,
    terminalSeen: true,
  };
  const turn = fingerprintLiveTurn(live);
  const timestamp = '2026-07-14T10:00:00.100Z';
  const withoutResult: Message[] = [
    transcriptMessage('user', timestamp, [{ kind: 'text', text: 'inspect it' }]),
    transcriptMessage('assistant', timestamp, [{ kind: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/repo/a.ts' } }]),
  ];
  assert.equal(snapshotCoversLiveTurn(withoutResult, turn), false);

  const complete: Message[] = [
    ...withoutResult,
    transcriptMessage('user', timestamp, [{ kind: 'tool_result', toolUseId: 'tool-1', text: 'content' }]),
  ];
  assert.equal(snapshotCoversLiveTurn(complete, turn), true);
});

test('snapshot handoff accepts an explicitly terminal empty turn but not transport EOF', () => {
  const startedAt = Date.parse('2026-07-14T10:00:00.000Z');
  const currentUser = transcriptMessage(
    'user',
    '2026-07-14T10:00:00.100Z',
    [{ kind: 'text', text: 'stop here' }],
  );
  const live: LiveState = {
    cwd: '/repo',
    startedAt,
    userText: 'stop here',
    userImages: [],
    timeline: [],
    outputTokens: 0,
    done: true,
    terminalSeen: true,
  };

  assert.equal(snapshotCoversLiveTurn([currentUser], fingerprintLiveTurn(live)), true);
  assert.equal(snapshotCoversLiveTurn([
    transcriptMessage('user', '2026-07-14T09:59:50.000Z', [{ kind: 'text', text: 'stop here' }]),
  ], fingerprintLiveTurn(live)), false);
  assert.equal(snapshotCoversLiveTurn(
    [currentUser],
    fingerprintLiveTurn({ ...live, terminalSeen: false }),
  ), false);
});

test('a consumed ended ring does not hide a newer turn on the same session', async () => {
  const sid = 'turn-aware-tombstone-session';
  let startedAt = 1_000;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return sseResponse([
      { type: 'meta', cwd: '/repo', sessionId: sid, startedAt },
      { type: 'user-text', text: `turn ${startedAt}` },
      { type: 'delta', text: 'answer' },
      { type: 'done', exitCode: 0 },
    ]);
  };

  assert.equal(await attachLive('project', sid), 'attached');
  await waitFor(() => getLive(sid)?.terminalSeen === true);
  clearLive(sid);

  // First probe still sees the retained old ring and consumes its identity.
  // Its settled single-flight entry must be gone before a newer turn starts.
  assert.equal(await attachLive('project', sid), 'not-live');
  startedAt = 2_000;
  assert.equal(await attachLive('project', sid), 'attached');
  await waitFor(() => getLive(sid)?.terminalSeen === true);
  assert.equal(getLive(sid)?.startedAt, 2_000);
  assert.equal(fetches, 3);
  clearLive(sid);
});
