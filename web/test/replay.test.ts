import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@macaron/shared';
import { compressReplayGap, createReplayTimeline, replayFrame } from '../src/lib/replay';

const user = (text: string, timestamp: string): Message => ({ role: 'user', timestamp, blocks: [{ kind: 'text', text }] });
const assistant = (text: string, timestamp: string): Message => ({ role: 'assistant', timestamp, blocks: [{ kind: 'text', text }] });

test('reveals complete assistant text at its event timestamp', () => {
  const timeline = createReplayTimeline([user('go', '2026-01-01T00:00:00.000Z'), assistant('abcdefghij', '2026-01-01T00:00:01.000Z')]);
  assert.deepEqual(replayFrame(timeline, 0), [timeline[0]!.message]);
  assert.deepEqual(replayFrame(timeline, 999), [timeline[0]!.message]);
  assert.deepEqual(replayFrame(timeline, 1_000), timeline.map((entry) => entry.message));
});

test('predicts render_ui generation from code size and streams it until the recorded timestamp', () => {
  const code = Array.from({ length: 20 }, () => 'x'.repeat(31)).join('\n') + '\n'; // 640 chars, 160 estimated tokens at 50 tokens/second.
  const messages: Message[] = [user('go', '2026-01-01T00:00:00.000Z'), { role: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', blocks: [{ kind: 'tool_use', id: '1', name: 'mcp__macaron__render_ui', input: { code } }] }];
  const timeline = createReplayTimeline(messages, 'exact');
  assert.equal(timeline[1]!.start, 1_800);
  assert.equal(replayFrame(timeline, 1_799).length, 1);
  const halfway = replayFrame(timeline, 3_400);
  assert.equal(halfway.length, 2);
  const halfwayInput = (halfway[1]!.blocks[0] as Extract<Message['blocks'][number], { kind: 'tool_use' }>).input as { code: string; _replayStreaming: boolean };
  // Partial frames snap to the next line boundary so partial-react never sees half an identifier.
  assert.equal(halfwayInput.code.length, 352);
  assert.ok(halfwayInput.code.endsWith('\n'));
  assert.equal(halfwayInput._replayStreaming, true);
  assert.deepEqual(replayFrame(timeline, 5_000), messages);
});

test('streams render_ui before its paired text becomes due', () => {
  // Real Claude transcripts flush a text block and its tool_use block together
  // at message completion, so the paired text's end ≈ the render_ui end while
  // the back-calculated stream starts far earlier. The frame must include the
  // streaming render_ui even though the paired text is not due yet.
  const code = Array.from({ length: 20 }, () => 'x'.repeat(31)).join('\n') + '\n';
  const messages: Message[] = [
    user('go', '2026-01-01T00:00:00.000Z'),
    { role: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', blocks: [{ kind: 'text', text: '先说一句' }] },
    { role: 'assistant', timestamp: '2026-01-01T00:00:05.010Z', blocks: [{ kind: 'tool_use', id: '1', name: 'mcp__macaron__render_ui', input: { code } }] },
  ];
  const timeline = createReplayTimeline(messages, 'exact');
  const mid = replayFrame(timeline, 3_000);
  assert.equal(mid.length, 2); // user + streaming render_ui; paired text not yet visible
  assert.equal((mid[1]!.blocks[0] as { kind: string }).kind, 'tool_use');
  const midInput = (mid[1]!.blocks[0] as Extract<Message['blocks'][number], { kind: 'tool_use' }>).input as { code: string; _replayStreaming: boolean };
  assert.equal(midInput._replayStreaming, true);
  assert.ok(midInput.code.length > 0 && midInput.code.length < code.length);
  assert.equal(replayFrame(timeline, 5_010).length, 3);
});

test('does not mock streaming for non-render_ui tools', () => {
  const messages: Message[] = [user('go', '2026-01-01T00:00:00.000Z'), { role: 'assistant', timestamp: '2026-01-01T00:00:05.000Z', blocks: [{ kind: 'tool_use', id: '1', name: 'Read', input: { code: 'x'.repeat(640) } }] }];
  const timeline = createReplayTimeline(messages, 'exact');
  assert.equal(replayFrame(timeline, 4_999).length, 1);
  assert.deepEqual(replayFrame(timeline, 5_000), messages);
});

test('reveals intermediate and final text only at their recorded event times', () => {
  const messages = [user('go', '2026-01-01T00:00:00.000Z'), assistant('intermediate text', '2026-01-01T00:00:00.100Z'), assistant('final response', '2026-01-01T00:00:01.000Z')];
  const timeline = createReplayTimeline(messages, 'exact');
  assert.equal(timeline[1]!.end, 100);
  assert.equal(timeline[2]!.end, 1_000);
  assert.deepEqual(replayFrame(timeline, 99), messages.slice(0, 1));
  assert.deepEqual(replayFrame(timeline, 100).slice(0, 2), messages.slice(0, 2));
  assert.deepEqual(replayFrame(timeline, 999), messages.slice(0, 2));
  assert.deepEqual(replayFrame(timeline, 1_000), messages);
});

test('offers exact, logarithmic, and compact replay timing', () => {
  assert.equal(compressReplayGap(60_000, 'exact'), 60_000);
  assert.equal(compressReplayGap(60_000, 'compact'), 2_000);
  assert.equal(Math.round(compressReplayGap(60_000, 'natural')), 8_802);
  assert.equal(compressReplayGap(1_000, 'natural'), 1_000);
});

test('compact timing caps long event gaps while preserving non-text event boundaries', () => {
  const messages: Message[] = [user('go', '2026-01-01T00:00:00.000Z'), { role: 'assistant', timestamp: '2026-01-01T00:01:00.000Z', blocks: [{ kind: 'tool_use', id: '1', name: 'Read', input: {} }] }];
  const timeline = createReplayTimeline(messages, 'compact');
  assert.equal(timeline[1]!.end, 2_000);
  assert.equal(replayFrame(timeline, 1_999).length, 1);
  assert.deepEqual(replayFrame(timeline, 2_000), messages);
});
