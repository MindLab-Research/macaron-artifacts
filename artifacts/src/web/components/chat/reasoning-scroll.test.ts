import { expect, test } from 'bun:test';
import { followReasoningScroll, reasoningScrollTop } from './reasoning-scroll';

function viewport(top: number, scrollHeight = 1000, clientHeight = 200) {
  const writes: number[] = [];
  const element = { scrollHeight, clientHeight, get scrollTop() { return top; }, set scrollTop(value: number) { writes.push(value); top = value; } };
  return { element, writes, position(value: number) { top = value; } };
}

test('bottom and subpixel scroll events do not reset native scrolling', () => {
  const { element, writes } = viewport(799.5);
  expect(followReasoningScroll(element, true, false)).toBe(800);
  expect(writes).toEqual([]);
  const atBottom = viewport(800);
  followReasoningScroll(atBottom.element, true, true);
  expect(atBottom.writes).toEqual([]);
});

test.each([-40, 840])('elastic offset %s survives content growth and measurement', top => {
  const { element, writes } = viewport(top);
  followReasoningScroll(element, true, false);
  element.scrollHeight = 1020;
  followReasoningScroll(element, true, false);
  expect(element.scrollTop).toBe(top);
  expect(writes).toEqual([]);
});

test('bottom rebound remains at the logical bottom instead of looking like an upward gesture', () => {
  expect([800, 840, 820, 805, 800].map(top => reasoningScrollTop(viewport(top).element))).toEqual([800, 800, 800, 800, 800]);
  expect([0, -40, -10, 0].map(top => reasoningScrollTop(viewport(top).element))).toEqual([0, 0, 0, 0]);
});

test('live following still tracks layout changes, but paused or finished reasoning stays put', () => {
  const live = viewport(800, 1100);
  expect(followReasoningScroll(live.element, true, false)).toBe(900);
  expect(live.writes).toEqual([900]);
  const paused = viewport(300, 1100);
  followReasoningScroll(paused.element, false, false);
  expect(paused.writes).toEqual([]);
});

test('explicit resume can exit overscroll, including while history is open', () => {
  const { element, writes } = viewport(-40);
  followReasoningScroll(element, false, true);
  expect(writes).toEqual([800]);
});

test('initial live content pins once; content without overflow does not produce invalid offsets', () => {
  const live = viewport(0);
  followReasoningScroll(live.element, true, false);
  expect(live.writes).toEqual([800]);
  const short = viewport(-12, 100, 200);
  expect(followReasoningScroll(short.element, true, false)).toBe(0);
  expect(reasoningScrollTop(short.element)).toBe(0);
  expect(short.writes).toEqual([]);
});

test('a follow skipped during overscroll is recovered after settlement without another resize', () => {
  const view = viewport(850, 1020);
  followReasoningScroll(view.element, true, false);
  expect(view.writes).toEqual([]);
  view.position(800);
  followReasoningScroll(view.element, true, false);
  expect(view.writes).toEqual([820]);
});
