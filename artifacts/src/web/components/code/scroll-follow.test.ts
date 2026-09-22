import { afterEach, beforeEach, expect, mock, test } from 'bun:test';
import { createScrollFollow, type ScrollFollowState } from './scroll-follow';
import { createCanvasFollow } from '../canvas-follow';

class Viewport extends EventTarget {
  style = { overflowAnchor: 'auto' };
  scrollHeight = 1000;
  clientHeight = 200;
  overflowY = 'auto';
  rawTop = 800;
  writes: number[] = [];
  parentElement: Viewport | null = null;
  editing = false;
  get scrollTop() { return this.rawTop; }
  set scrollTop(value: number) { this.writes.push(value); this.rawTop = Math.max(0, Math.min(this.scrollHeight - this.clientHeight, value)); }
  closest() { return this.editing ? this : null; }
  scroll(top: number) { this.rawTop = top; this.dispatchEvent(new Event('scroll')); }
  input(type: string, detail: object, target: Viewport = this) {
    const event = Object.assign(new Event(type), detail);
    Object.defineProperty(event, 'target', { value: target });
    this.dispatchEvent(event);
  }
}

const originals = { requestAnimationFrame: globalThis.requestAnimationFrame, cancelAnimationFrame: globalThis.cancelAnimationFrame, matchMedia: globalThis.matchMedia, Element: globalThis.Element, getComputedStyle: globalThis.getComputedStyle, ResizeObserver: globalThis.ResizeObserver };
const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
let now = 0, frameId = 0;
let frames = new Map<number, FrameRequestCallback>();
let media: EventTarget & { matches: boolean };
let followers: { destroy(): void }[];
let observers: { resize(): void; elements: Element[]; disconnected: boolean }[];
let clock: ReturnType<typeof mock>;
beforeEach(() => {
  now = 0; frameId = 0; frames = new Map(); followers = []; observers = [];
  globalThis.ResizeObserver = class {
    elements: Element[] = []; disconnected = false;
    constructor(private callback: ResizeObserverCallback) { observers.push(this); }
    observe(element: Element) { this.elements.push(element); }
    unobserve() {}
    disconnect() { this.disconnected = true; }
    resize() { if (!this.disconnected) this.callback([], this); }
  } as typeof ResizeObserver;
  media = Object.assign(new EventTarget(), { matches: false });
  globalThis.requestAnimationFrame = callback => { frames.set(++frameId, callback); return frameId; };
  globalThis.cancelAnimationFrame = id => { frames.delete(id); };
  globalThis.matchMedia = (() => media) as unknown as typeof matchMedia;
  globalThis.Element = Viewport as unknown as typeof Element;
  globalThis.getComputedStyle = (element => ({ overflowY: (element as unknown as Viewport).overflowY })) as typeof getComputedStyle;
  clock = mock(() => now);
  Object.defineProperty(performance, 'now', { configurable: true, value: clock });
});
afterEach(() => {
  followers.forEach(follower => follower.destroy());
  Object.assign(globalThis, originals);
  if (originalClock) Object.defineProperty(performance, 'now', originalClock);
  else delete (performance as Partial<Performance>).now;
});

function setup({ following = true, enabled = () => true, top = 800 }: { following?: boolean; enabled?: () => boolean; top?: number } = {}) {
  const element = new Viewport(); element.rawTop = top;
  let state: ScrollFollowState = { top, gap: 800, following };
  const follow = createScrollFollow(element as unknown as HTMLElement, { following, enabled, onChange: next => { state = next; } });
  followers.push(follow);
  follow.update(true); element.writes.length = 0;
  return { element, follow, state: () => state };
}
function advance(count = 1) {
  for (let frame = 0; frame < count; frame++) {
    now += 1000 / 60;
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback(now));
  }
}

function canvas(streaming = true, waitForRender = true) {
  const element = new Viewport(), content = new Viewport();
  const follow = createCanvasFollow(element as unknown as HTMLElement, content as unknown as HTMLElement, streaming, waitForRender);
  followers.push(follow);
  return { element, content, follow, observer: observers.at(-1)! };
}

test('Canvas follows layout growth through a late final render, then leaves static interactions alone', () => {
  const { element, content, follow, observer } = canvas();
  expect(observer.elements).toEqual([element, content] as unknown as Element[]);
  advance(120); expect(element.scrollTop).toBe(800);
  element.scrollHeight += 400; observer.resize(); advance(4);
  const before = element.scrollTop;
  follow.update(false); expect(element.scrollTop).toBe(before);
  advance(120); expect(element.scrollTop).toBe(1200);
  element.scrollHeight += 300; observer.resize(); follow.rendered(); advance(120);
  expect(element.scrollTop).toBe(1500);
  element.scrollHeight += 400; observer.resize(); advance(120);
  expect(element.scrollTop).toBe(1500);
});

test('Canvas replaces a scrolled source with a taller first preview from rest without losing follow', () => {
  const { element, follow, observer } = canvas();
  advance(120); expect(element.scrollTop).toBe(800);
  element.scrollHeight = 1600; follow.preview(); expect(element.scrollTop).toBe(0);
  observer.resize(); advance(); const first = element.scrollTop;
  expect(first).toBeGreaterThan(0); expect(first).toBeLessThan((element.scrollHeight - element.clientHeight) * 0.01);
  advance(); expect(element.scrollTop - first).toBeGreaterThan(first);
  advance(120); expect(element.scrollTop).toBe(1400);
});

test('Canvas keeps manual ownership through short previews, new growth and completion', () => {
  const { element, follow, observer } = canvas();
  advance(120); element.input('wheel', { deltaY: -1 }); element.scroll(150);
  element.scrollHeight = 800; follow.preview(); expect(element.scrollTop).toBe(150);
  element.scrollHeight = 100; element.rawTop = 0; observer.resize();
  element.scrollHeight = 1200; observer.resize(); follow.update(false); follow.rendered(); advance(120);
  expect(element.scrollTop).toBe(0);
  follow.update(true); observer.resize(); advance(120); expect(element.scrollTop).toBe(0);
  element.scroll(1000); element.scrollHeight += 100; observer.resize(); advance(120);
  expect(element.scrollTop).toBe(1100);
});

test('Canvas teardown removes old observers and motion; a static replacement opens at its beginning', () => {
  const previous = canvas(); advance(4); expect(frames.size).toBe(1);
  previous.follow.destroy(); expect(previous.observer.disconnected).toBe(true); expect(frames.size).toBe(0);
  previous.element.scrollHeight += 100; previous.observer.resize(); advance(120); expect(frames.size).toBe(0);
  const next = canvas(false); next.element.scrollHeight += 100; next.observer.resize(); advance(120);
  expect(next.element.scrollTop).toBe(0);
  next.follow.update(true); next.observer.resize(); advance(120); expect(next.element.scrollTop).toBe(900);
});

test('explicit Canvas source view finishes its last spring without waiting for a renderer', () => {
  const { element, follow, observer } = canvas(true, false);
  advance(4); follow.update(false); advance(120); expect(element.scrollTop).toBe(800);
  element.scrollHeight += 100; observer.resize(); advance(120); expect(element.scrollTop).toBe(800);
});

test('stream growth accelerates smoothly and settles without losing follow to its own scroll events', () => {
  const { element, follow, state } = setup();
  element.scrollHeight += 320; follow.update();
  expect(element.writes).toEqual([]);
  advance(); const first = element.scrollTop - 800;
  expect(first).toBeGreaterThan(0); expect(first).toBeLessThan(20);
  element.dispatchEvent(new Event('scroll'));
  advance(); expect(element.scrollTop - 800 - first).toBeGreaterThan(first);
  advance(100);
  expect(element.scrollTop).toBe(1120); expect(state().following).toBe(true); expect(frames.size).toBe(0);
});

test('growth retargets a return in flight without an immediate jump or a velocity restart', () => {
  const { element, follow } = setup({ following: false, top: 0 });
  follow.resume(); advance(5);
  const before = element.scrollTop, previousStep = element.writes.at(-1)! - element.writes.at(-2)!;
  element.scrollHeight += 400; follow.update();
  expect(element.scrollTop).toBe(before);
  advance(); expect(element.scrollTop - before).toBeGreaterThan(previousStep);
  advance(120); expect(element.scrollTop).toBe(1200);
});

test.each([1, 0.1])('a %spx scrollbar move releases follow and is not recaptured near the bottom', delta => {
  const { element, follow, state } = setup();
  element.scroll(800 - delta); expect(state().following).toBe(false);
  element.dispatchEvent(new Event('scroll')); element.scrollHeight += 100; follow.update(); advance(30);
  expect(element.writes).toEqual([]); expect(element.scrollTop).toBe(800 - delta);
  element.scroll(900); expect(state().following).toBe(true);
});

test('upward input takes control before scrolling; editor keys and nested panes do not release the outer chat', () => {
  const { element, follow, state } = setup();
  const child = new Viewport(); child.parentElement = element; child.editing = true; child.scrollHeight = child.clientHeight;
  element.input('keydown', { key: 'ArrowUp' }, child); expect(state().following).toBe(true);
  child.editing = false; child.scrollHeight = 1000;
  element.input('wheel', { deltaY: -1 }, child); expect(state().following).toBe(true);
  element.input('wheel', { deltaY: -0.01 }); expect(state().following).toBe(false);
  element.scrollHeight += 100; follow.update(); advance(30); expect(element.writes).toEqual([]);
  follow.resume('instant'); element.input('keydown', { key: 'PageUp' }); expect(state().following).toBe(false);
});

test('initial history stays at its beginning and future growth respects a reader who paused', () => {
  const { element, follow, state } = setup({ following: false, top: 0 });
  expect(element.scrollTop).toBe(0); expect(state().following).toBe(false);
  element.scrollHeight += 100; follow.grow(); advance(5); expect(element.scrollTop).toBeGreaterThan(0);
  element.input('wheel', { deltaY: -1 }); const stopped = element.scrollTop;
  element.scrollHeight += 100; follow.grow(); advance(120); expect(element.scrollTop).toBe(stopped);
});

test('reading downward through existing output pauses future growth until the reader reaches its end', () => {
  const { element, follow, state } = setup({ following: false, top: 0 });
  element.scroll(100); element.scrollHeight += 100; follow.grow(); advance(120);
  expect(element.scrollTop).toBe(100); expect(state().following).toBe(false);
  element.scroll(900); element.scrollHeight += 100; follow.grow(); advance(120);
  expect(element.scrollTop).toBe(1000); expect(state().following).toBe(true);
});

test('when a collapse removes all hidden history, future growth may follow again', () => {
  const { element, follow, state } = setup();
  element.scroll(100); expect(state().following).toBe(false);
  element.scrollHeight = 100; element.rawTop = 0; follow.update();
  expect(state().following).toBe(true);
  element.scrollHeight = 1000; follow.update(); advance(120); expect(element.scrollTop).toBe(800);
});

test('disabled history does not resume on resize, but explicit navigation is available', () => {
  let live = true;
  const { element, follow, state } = setup({ enabled: () => live });
  element.scrollHeight += 400; follow.update(); advance(5);
  live = false; follow.update(); const stopped = element.scrollTop;
  advance(100); expect(element.scrollTop).toBe(stopped); expect(state().following).toBe(false);
  follow.resume(); advance(120); expect(element.scrollTop).toBe(1200);
});

test('finishing a stream settles its pending movement without overriding a paused reader', () => {
  let live = true;
  const { element, follow } = setup({ enabled: () => live });
  element.scrollHeight += 400; follow.update(); advance(5);
  const before = element.scrollTop;
  live = false; follow.finish(); expect(element.scrollTop).toBe(before);
  advance(120); expect(element.scrollTop).toBe(1200);
  live = true; element.scrollHeight += 400; follow.update(); advance(5);
  element.input('wheel', { deltaY: -1 }); const paused = element.scrollTop;
  live = false; follow.finish(); advance(120); expect(element.scrollTop).toBe(paused);
});

test('opening history cancels even the final settling animation', () => {
  let live = true;
  const { element, follow, state } = setup({ enabled: () => live });
  element.scrollHeight += 400; follow.update(); advance(5);
  live = false; follow.finish(); advance(2); follow.pause();
  const before = element.scrollTop; element.scrollHeight += 1000; follow.update(); advance(120);
  expect(element.scrollTop).toBe(before); expect(state().following).toBe(false);
});

test('target shortening clamps stored motion to the actual range without dropping ownership', () => {
  const { element, follow, state } = setup({ following: false, top: 0 });
  follow.resume(); advance(6);
  const before = element.scrollTop, target = before + 1;
  element.scrollHeight = target + element.clientHeight; follow.update(); advance();
  expect(element.writes.at(-1)).toBeGreaterThanOrEqual(before); expect(element.writes.at(-1)).toBeLessThanOrEqual(target);
  element.scrollHeight = 220; element.rawTop = 20; follow.update(); advance(120);
  expect(element.scrollTop).toBe(20); expect(state().following).toBe(true); expect(frames.size).toBe(0);
  element.scrollHeight = 600; follow.update(); advance(); expect(element.scrollTop).toBeGreaterThan(20);
});

test('elastic rebound and growth during overscroll never write until native scrolling settles', () => {
  const { element, follow, state } = setup();
  element.scroll(850); element.scrollHeight += 20; follow.update(); advance(20);
  expect(element.writes).toEqual([]); expect(state().following).toBe(true);
  element.scroll(800); advance(90);
  expect(element.scrollTop).toBe(820); expect(state().following).toBe(true);
  element.scroll(-20); element.scrollHeight += 20; follow.update(); expect(element.writes.at(-1)).toBe(820);
});

test('reduced motion enabled mid-flight settles immediately; instant keyboard return never schedules animation', () => {
  const { element, follow } = setup();
  element.scrollHeight += 400; follow.update(); advance(4); expect(frames.size).toBe(1);
  media.matches = true; media.dispatchEvent(new Event('change'));
  expect(element.scrollTop).toBe(1200); expect(frames.size).toBe(0);
  media.matches = false; element.scroll(100); follow.resume('instant');
  expect(element.scrollTop).toBe(1200); expect(frames.size).toBe(0);
});

test('touch interrupts motion without preventing native scrolling and explicit resume exits overscroll', () => {
  const { element, follow, state } = setup();
  element.scrollHeight += 400; follow.update(); advance(4);
  element.input('touchstart', { touches: [{ clientY: 200 }] }); const stopped = element.scrollTop;
  element.scrollHeight += 100; follow.update(); advance(20); expect(element.scrollTop).toBe(stopped);
  element.input('touchmove', { touches: [{ clientY: 201 }] }); expect(state().following).toBe(false);
  element.input('touchend', {}); advance(20); expect(element.scrollTop).toBe(stopped);
  element.scroll(-20); follow.resume('instant'); expect(element.scrollTop).toBe(1300);
});

test('cleanup cancels pending frames, restores scroll anchoring and removes input listeners', () => {
  const { element, follow, state } = setup();
  element.scrollHeight += 100; follow.update(); expect(element.style.overflowAnchor).toBe('none');
  follow.destroy(); expect(frames.size).toBe(0); expect(element.style.overflowAnchor).toBe('auto');
  element.input('wheel', { deltaY: -1 }); expect(state().following).toBe(true);
});
