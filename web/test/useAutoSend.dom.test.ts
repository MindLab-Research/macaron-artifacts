import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';

// Mounts the REAL web/public/genui-shim/chat.mjs against the REAL host bridge
// (createScheduleBridge) in a jsdom React tree — the two halves a widget
// actually runs through. autoSend.test.ts covers the host timer directly; the
// gap this closes is the shim's own hook body: it is shipped as a .mjs the
// bundler never type-checks or executes, so a bad dep array or a wrong global
// name would ship silently and only misbehave in a live session.
const SHIM = path.join(import.meta.dirname, '../public/genui-shim/chat.mjs');

let dom: JSDOM;
let container: HTMLElement;
let listeners: Array<() => void>;
let timers: Array<{ cb: () => void; interval: number; next: number; id: number }>;
let now: number;

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = dom.window;
  g.document = dom.window.document;
  Object.defineProperty(g, 'navigator', { configurable: true, value: dom.window.navigator });
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  // The host's countdown ticks on a real 1s interval; drive it by hand so the
  // test doesn't spend 30 wall-clock seconds waiting for a commit.
  listeners = [];
  timers = [];
  now = 0;
  let nextId = 1;
  const doc = dom.window.document;
  doc.addEventListener = ((_t: string, cb: () => void) => listeners.push(cb)) as typeof doc.addEventListener;
  doc.removeEventListener = ((_t: string, cb: () => void) => { listeners = listeners.filter((l) => l !== cb); }) as typeof doc.removeEventListener;
  g.setInterval = ((cb: () => void, interval: number) => {
    const id = nextId++;
    timers.push({ cb, interval, next: now + interval, id });
    return id;
  }) as unknown as typeof setInterval;
  g.clearInterval = ((id: number) => { timers = timers.filter((t) => t.id !== id); }) as unknown as typeof clearInterval;
  container = doc.createElement('div');
  doc.body.appendChild(container);
});

afterEach(async () => {
  const { cancelAutoSend } = await import('../src/lib/autoSend');
  cancelAutoSend();
  const g = globalThis as Record<string, unknown>;
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node']) delete g[k];
  delete g['$app/chat'];
  delete g['$app/chat/schedule'];
});

function tick(seconds: number) {
  for (let i = 0; i < seconds; i += 1) {
    now += 1000;
    for (const t of [...timers]) if (t.next <= now) { t.next += t.interval; t.cb(); }
  }
}

/**
 * Mount a widget that uses the hook, wired exactly as production wires it:
 * genui-shim/react.mjs re-exports `globalThis.__macaron_React`, so the shim and
 * the test tree share one React instance (a second copy = "Invalid hook call").
 */
/** Forces a re-render of the mounted widget WITHOUT unmounting it. */
let bump: () => void = () => {};

async function mountWidget(opts: { isLive?: boolean; seconds?: number } = {}) {
  const React = await import('react');
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const g = globalThis as Record<string, unknown>;
  g.__macaron_React = React;

  const { createScheduleBridge } = await import('../src/lib/autoSend');
  const sent: string[] = [];
  const bridge = (prompt: string) => { sent.push(prompt); };
  g['$app/chat'] = bridge;
  g['$app/chat/schedule'] = createScheduleBridge({
    send: bridge,
    isBusy: () => false,
    isLive: () => opts.isLive ?? true,
  });

  // Import the shipped .mjs itself, not a re-implementation.
  const { useAutoSend, sendUserMessage } = await import(SHIM);
  const COMMIT = 'Commit it.';
  const renders: Array<number | null> = [];

  const Widget = () => {
    const [, forceRender] = React.useState(0);
    bump = () => forceRender((n) => n + 1);
    const left = useAutoSend(COMMIT, opts.seconds ?? 30);
    renders.push(left);
    return React.createElement(
      'button',
      { onClick: () => sendUserMessage(COMMIT) },
      `Commit${left !== null ? ` (${left}s)` : ''}`,
    );
  };

  const root = createRoot(container);
  await act(async () => { root.render(React.createElement(Widget)); });
  const button = () => container.querySelector('button')!;
  return { sent, renders, button, act, root, COMMIT };
}

test('the shipped shim counts down on the button and fires once', async () => {
  const { sent, button, act } = await mountWidget({ seconds: 3 });

  // Armed synchronously on mount: the label shows the timer without waiting a tick.
  assert.equal(button().textContent, 'Commit (3s)');
  await act(async () => { tick(1); });
  assert.equal(button().textContent, 'Commit (2s)');

  await act(async () => { tick(2); });
  assert.deepEqual(sent, ['Commit it.']);
  // Fired ⇒ null ⇒ the label drops the suffix rather than freezing at "(1s)".
  assert.equal(button().textContent, 'Commit');

  await act(async () => { tick(10); });
  assert.deepEqual(sent, ['Commit it.'], 'the interval must be cleared after firing');
});

test('re-rendering the widget does not restart the countdown', async () => {
  // The bug this pins: if the effect's deps include a per-render value (an
  // inline handler, the setter's closure), it re-arms on EVERY render — the
  // countdown resets to N forever and the auto-send never fires. Each tick
  // re-renders (the label changes), so a re-arming hook would live-lock here.
  const { sent, button, act } = await mountWidget({ seconds: 3 });

  // Interleave extra re-renders with the ticks, without unmounting.
  await act(async () => { tick(1); });
  await act(async () => { bump(); });
  assert.equal(button().textContent, 'Commit (2s)', 'a re-render must not reset the label to 3s');
  await act(async () => { tick(1); });
  await act(async () => { bump(); });
  await act(async () => { tick(1); });

  assert.deepEqual(sent, ['Commit it.'], 'must still fire on its ORIGINAL deadline despite re-renders');
});

test('a click sends exactly one message, with no cancel bookkeeping', async () => {
  const { sent, button, act, COMMIT } = await mountWidget({ seconds: 30 });

  await act(async () => { button().dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  assert.deepEqual(sent, [COMMIT]);

  // The widget never called a canceller — production's send() calls
  // cancelAutoSend() for real, so simulate that and confirm no second message.
  const { cancelAutoSend } = await import('../src/lib/autoSend');
  cancelAutoSend();
  await act(async () => { tick(60); });
  assert.deepEqual(sent, [COMMIT], 'the countdown must not land a second message on top of the click');
});

test('a re-opened transcript renders the buttons with no timer', async () => {
  const { sent, button, act } = await mountWidget({ isLive: false, seconds: 3 });

  assert.equal(button().textContent, 'Commit', 'no countdown suffix when the host refuses to arm');
  await act(async () => { tick(30); });
  assert.deepEqual(sent, [], 're-opening an old transcript must never auto-commit');
});
