import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

// The countdown that auto-commits for a user who always commits. Everything
// worth testing is a refusal-to-fire: a re-opened transcript, a turn still
// streaming, a manual pick, a keystroke. Firing when it shouldn't means the
// agent committed without being asked.

let listeners: Array<() => void>;
let now: number;
let timers: Array<{ cb: () => void; interval: number; next: number; id: number }>;

beforeEach(() => {
  listeners = [];
  timers = [];
  now = 0;
  let nextId = 1;
  const g = globalThis as Record<string, unknown>;
  g.document = {
    addEventListener: (_t: string, cb: () => void) => listeners.push(cb),
    removeEventListener: (_t: string, cb: () => void) => { listeners = listeners.filter((l) => l !== cb); },
  };
  g.setInterval = ((cb: () => void, interval: number) => {
    const id = nextId++;
    timers.push({ cb, interval, next: now + interval, id });
    return id;
  }) as unknown as typeof setInterval;
  g.clearInterval = ((id: number) => { timers = timers.filter((t) => t.id !== id); }) as unknown as typeof clearInterval;
});

afterEach(async () => {
  const { cancelAutoSend } = await import('../src/lib/autoSend');
  cancelAutoSend();
  const g = globalThis as Record<string, unknown>;
  delete g.document;
});

/** Advance the fake clock, firing each due interval callback. */
function tick(seconds: number) {
  for (let i = 0; i < seconds; i++) {
    now += 1000;
    for (const t of [...timers]) {
      if (t.next <= now) { t.next += t.interval; t.cb(); }
    }
  }
}

const bridge = async (over: { isBusy?: () => boolean; isLive?: () => boolean } = {}) => {
  const { createScheduleBridge } = await import('../src/lib/autoSend');
  const sent: string[] = [];
  const schedule = createScheduleBridge({
    send: (p) => sent.push(p),
    isBusy: over.isBusy ?? (() => false),
    isLive: over.isLive ?? (() => true),
  });
  return { schedule, sent };
};

test('sends the default prompt once the countdown elapses', async () => {
  const { schedule, sent } = await bridge();
  const ticks: Array<number | null> = [];
  schedule('Commit it.', 3, (r) => ticks.push(r));

  tick(2);
  assert.deepEqual(sent, []);
  tick(1);
  assert.deepEqual(sent, ['Commit it.']);
  // Starts at 3, counts down, then null once it has fired.
  assert.deepEqual(ticks, [3, 2, 1, null]);

  // No repeat: the interval is cleared when it fires.
  tick(5);
  assert.deepEqual(sent, ['Commit it.']);
});

test('never fires on a re-opened transcript', async () => {
  const { schedule, sent } = await bridge({ isLive: () => false });
  const cancel = schedule('Commit it.', 2);
  tick(10);
  assert.deepEqual(sent, []);
  assert.equal(typeof cancel, 'function'); // widget can still call it unconditionally
});

test('holds the countdown while a turn is streaming', async () => {
  let busy = true;
  const { schedule, sent } = await bridge({ isBusy: () => busy });
  schedule('Commit it.', 2);

  tick(30);
  assert.deepEqual(sent, [], 'a send during a running turn would be silently dropped');
  busy = false;
  tick(2);
  assert.deepEqual(sent, ['Commit it.']);
});

test('cancel stops the timer so a manual pick is the only message', async () => {
  const { schedule, sent } = await bridge();
  const cancel = schedule('Commit it.', 3);
  tick(1);
  cancel();
  tick(10);
  assert.deepEqual(sent, []);
});

test('a keystroke cancels the countdown', async () => {
  const { schedule, sent } = await bridge();
  schedule('Commit it.', 3);
  assert.equal(listeners.length, 1);
  listeners[0]!();
  tick(10);
  assert.deepEqual(sent, []);
  assert.equal(listeners.length, 0, 'the keydown listener is removed on cancel');
});

test('arming a second countdown retires the first', async () => {
  const { schedule, sent } = await bridge();
  const cancelFirst = schedule('Commit it.', 2);
  schedule('Push it.', 2);
  tick(2);
  assert.deepEqual(sent, ['Push it.']);
  // The stale canceller must not kill the live countdown it doesn't own.
  cancelFirst();
  assert.equal(listeners.length, 0);
});
