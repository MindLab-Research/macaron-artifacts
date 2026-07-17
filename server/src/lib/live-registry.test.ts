import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveGet, livePush, liveStart } from './live-registry.js';

test('ring eviction retains meta and user-text replay identity', () => {
  const sid = 'ring-identity-session';
  const startedAt = 1_234;
  const images = [{ mimeType: 'image/png', dataUrl: 'data:image/png;base64,YQ==' }];

  liveStart(sid, { cwd: '/repo', startedAt });
  livePush(sid, { type: 'user-text', text: 'hello', images });
  for (let index = 0; index < 4_050; index++) {
    livePush(sid, { type: 'delta', text: `chunk-${index}` });
  }

  const events = liveGet(sid)?.events;
  assert.ok(events);
  assert.equal(events.length, 4_000);
  assert.deepEqual(events[0], { type: 'meta', cwd: '/repo', sessionId: sid, startedAt });
  assert.deepEqual(events[1], { type: 'user-text', text: 'hello', images });
  assert.deepEqual(events.at(-1), { type: 'delta', text: 'chunk-4049' });
});
