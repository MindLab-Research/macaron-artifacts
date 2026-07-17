import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { JSDOM } from 'jsdom';

// Mount UsageHeatmap in a real (jsdom) DOM and drive width changes to prove the
// resize-focus blocker is fixed: after any wide↔narrow resize, document.active-
// Element, the single roving tabIndex=0 cell, and the detail caption must all
// point at the SAME still-visible day. Regressions here are exactly what stable
// date keys prevent — a positional key would let the focused DOM node survive a
// resize while its date silently changed underneath it.

let dom: JSDOM;
let container: HTMLElement;
let mockWidth = 900;
let roCallbacks: Array<() => void> = [];

beforeEach(() => {
  dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true });
  const g = globalThis as Record<string, unknown>;
  g.IS_REACT_ACT_ENVIRONMENT = true;
  g.window = dom.window;
  g.document = dom.window.document;
  // globalThis.navigator is a getter-only accessor in modern Node — plain
  // assignment throws, so redefine it.
  Object.defineProperty(g, 'navigator', { configurable: true, value: dom.window.navigator });
  g.HTMLElement = dom.window.HTMLElement;
  g.Node = dom.window.Node;
  g.getComputedStyle = dom.window.getComputedStyle;
  // The heatmap wrapper reads clientWidth; jsdom always reports 0, so back it
  // with a mutable mock we flip between "wide" and "narrow".
  Object.defineProperty(dom.window.HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => mockWidth });
  // jsdom has no ResizeObserver; capture the callbacks so a width change can fire them.
  roCallbacks = [];
  g.ResizeObserver = class {
    cb: () => void;
    constructor(cb: () => void) { this.cb = cb; roCallbacks.push(cb); }
    observe() {}
    disconnect() {}
  };
  container = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(container);
});

afterEach(() => {
  const g = globalThis as Record<string, unknown>;
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'getComputedStyle', 'ResizeObserver']) delete g[k];
});

async function resizeTo(width: number, act: (fn: () => void | Promise<void>) => Promise<void>) {
  mockWidth = width;
  await act(async () => { roCallbacks.forEach((cb) => cb()); });
}

// Read the three sources of truth back out of the mounted DOM.
function coherence() {
  const doc = dom.window.document;
  const activeKey = (doc.activeElement as HTMLElement | null)?.dataset?.key ?? null;
  const rovingEls = [...doc.querySelectorAll<HTMLElement>('.heatmap-cell[data-key][tabindex="0"]')];
  const rovingKey = rovingEls.length === 1 ? rovingEls[0]!.dataset.key! : `INVALID(${rovingEls.length})`;
  const caption = doc.querySelector('.heatmap-detail')?.textContent ?? '';
  const captionKey = caption.split(' ·')[0] ?? '';
  const visible = new Set([...doc.querySelectorAll<HTMLElement>('.heatmap-cell[data-key]')].map((c) => c.dataset.key!));
  return { activeKey, rovingKey, captionKey, visible };
}

test('bidirectional resize keeps focus, roving tab stop, and caption on one visible day', async () => {
  // Dynamic imports so the jsdom globals above are in place first.
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { UsageHeatmap } = await import('../src/views/Analytics');

  // ~1 year of daily activity so wide shows far more columns than narrow.
  const daily: Array<{ date: string; messageCount: number }> = [];
  for (let ms = Date.UTC(2025, 6, 14, 12); ms <= Date.UTC(2026, 6, 14, 12); ms += 86400000) {
    const d = new Date(ms);
    daily.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, messageCount: 3 });
  }

  const root = createRoot(container);
  mockWidth = 900;
  await act(async () => { root.render(React.createElement(UsageHeatmap, { daily, sinceDate: '2025-07-14', untilDate: '2026-07-14', window: 'all' })); });

  // Focus the EARLIEST visible day at wide width — the one most likely to be
  // dropped when we narrow.
  const doc = dom.window.document;
  const wideCells = [...doc.querySelectorAll<HTMLElement>('.heatmap-cell[data-key]')];
  const earliest = wideCells.reduce((a, b) => (a.dataset.key! < b.dataset.key! ? a : b));
  const earliestKey = earliest.dataset.key!;
  await act(async () => { earliest.focus(); });
  {
    const c = coherence();
    assert.equal(c.activeKey, earliestKey, 'focus lands on the earliest day');
    assert.equal(c.rovingKey, earliestKey, 'roving follows focus');
    assert.equal(c.captionKey, earliestKey, 'caption follows focus');
  }

  // Wide → narrow: the earliest day is no longer visible. All three must move to
  // the same still-visible day, and there must be exactly one roving cell.
  await resizeTo(220, (fn) => act(async () => { await fn(); }));
  await act(async () => {}); // flush the reconcile effect's re-focus
  {
    const c = coherence();
    assert.ok(!c.visible.has(earliestKey), 'earliest day dropped when narrow');
    assert.ok(c.visible.has(c.activeKey!), 'focus is on a visible day');
    assert.equal(c.activeKey, c.rovingKey, 'focus === roving after narrowing');
    assert.equal(c.activeKey, c.captionKey, 'focus === caption after narrowing');
  }
  const narrowKey = coherence().activeKey!;

  // Narrow → wide: earlier columns reappear. The focused day stayed visible the
  // whole time, so focus/roving/caption must remain pinned to it (no snap-back
  // to a DOM-first cell).
  await resizeTo(900, (fn) => act(async () => { await fn(); }));
  await act(async () => {});
  {
    const c = coherence();
    assert.ok(c.visible.has(narrowKey), 'the day focused while narrow is still visible when wide');
    assert.equal(c.activeKey, narrowKey, 'focus stays put after widening');
    assert.equal(c.rovingKey, narrowKey, 'roving stays put after widening');
    assert.equal(c.captionKey, narrowKey, 'caption stays put after widening');
  }

  await act(async () => { root.unmount(); });
});

test('caption clears when a blurred old day is cropped away by narrowing (no stale detail)', async () => {
  const React = (await import('react')).default;
  const { act } = await import('react');
  const { createRoot } = await import('react-dom/client');
  const { UsageHeatmap } = await import('../src/views/Analytics');

  const daily: Array<{ date: string; messageCount: number }> = [];
  for (let ms = Date.UTC(2025, 6, 14, 12); ms <= Date.UTC(2026, 6, 14, 12); ms += 86400000) {
    const d = new Date(ms);
    daily.push({ date: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`, messageCount: 3 });
  }

  const root = createRoot(container);
  mockWidth = 900;
  await act(async () => { root.render(React.createElement(UsageHeatmap, { daily, sinceDate: '2025-07-14', untilDate: '2026-07-14', window: 'all' })); });

  const doc = dom.window.document;
  const wideCells = [...doc.querySelectorAll<HTMLElement>('.heatmap-cell[data-key]')];
  const earliest = wideCells.reduce((a, b) => (a.dataset.key! < b.dataset.key! ? a : b));
  const earliestKey = earliest.dataset.key!;

  // Focus an old day so the caption names it, then blur to <body> — this is what
  // clicking the "All" window pill (outside the grid) does: focus leaves the grid
  // BEFORE any resize, so focusedRef is already null when the reconcile runs.
  await act(async () => { earliest.focus(); });
  assert.equal(coherence().captionKey, earliestKey, 'caption names the focused old day');
  await act(async () => { (doc.activeElement as HTMLElement).blur(); });

  // Narrow so the old day is cropped out of the visible set. With nothing focused
  // to re-emit it, the caption must drop back to the placeholder, not keep naming
  // a date the grid no longer shows.
  await resizeTo(220, (fn) => act(async () => { await fn(); }));
  await act(async () => {});
  const c = coherence();
  assert.ok(!c.visible.has(earliestKey), 'the old day is cropped away when narrow');
  const caption = doc.querySelector('.heatmap-detail')?.textContent ?? '';
  assert.equal(caption, 'Hover or focus a day for details', 'caption fell back to the placeholder (no stale detail)');

  await act(async () => { root.unmount(); });
});

