import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { streamSession } from '../src/lib/sse';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function sseResponse(...events: unknown[]): Response {
  const body = events
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join('');
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

test('streamSession reports terminalSeen after an explicit done event', async () => {
  globalThis.fetch = async () => sseResponse({ type: 'done', exitCode: 0 });
  const terminalSignals: boolean[] = [];

  await streamSession('/api/session', {}, {
    onDone: (terminalSeen) => terminalSignals.push(terminalSeen),
  });

  assert.deepEqual(terminalSignals, [true]);
});

test('streamSession reports terminalSeen false on EOF without done', async () => {
  globalThis.fetch = async () => sseResponse({ type: 'delta', text: 'partial' });
  const terminalSignals: boolean[] = [];

  await streamSession('/api/session', {}, {
    onDone: (terminalSeen) => terminalSignals.push(terminalSeen),
  });

  assert.deepEqual(terminalSignals, [false]);
});
