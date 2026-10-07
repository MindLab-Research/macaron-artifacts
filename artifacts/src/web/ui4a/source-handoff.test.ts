import { afterEach, beforeEach, expect, test } from 'bun:test';
import { prepareSourceHandoff } from './source-handoff';

class Motion extends EventTarget {
  progress = 0;
  active = true;
  constructor(readonly gap: number, readonly options: KeyframeAnimationOptions) { super(); }
  cancel() { if (this.active) { this.active = false; this.dispatchEvent(new Event('cancel')); } }
  finish() { this.progress = 1; this.active = false; this.dispatchEvent(new Event('finish')); }
}
class Surface {
  style = { height: '', paddingBlockEnd: '' };
  contentHeight = 320;
  motions: Motion[] = [];
  layoutReads: number[] = [];
  get height() {
    const motion = this.motions.at(-1), padding = motion?.active ? motion.gap * (1 - motion.progress) : parseFloat(this.style.paddingBlockEnd) || 0;
    return this.style.height ? parseFloat(this.style.height) : this.contentHeight + padding;
  }
  getBoundingClientRect() { return { height: this.height }; }
  animate(frames: Keyframe[], options: KeyframeAnimationOptions) {
    // Starting a WAAPI animation may force layout, just like another component's layout effect.
    this.layoutReads.push(this.height);
    const motion = new Motion(parseFloat(String(frames[0]!.paddingBlockEnd)), options);
    this.motions.push(motion);
    return motion;
  }
  preview() { return { getBoundingClientRect: () => { this.layoutReads.push(this.height); return { height: this.contentHeight }; } } as HTMLElement; }
}

const originals = { matchMedia: globalThis.matchMedia, document: globalThis.document };
let media: EventTarget & { matches: boolean }, page: { hidden: boolean };
beforeEach(() => {
  media = Object.assign(new EventTarget(), { matches: false }); page = { hidden: false };
  globalThis.matchMedia = (() => media) as unknown as typeof matchMedia;
  globalThis.document = page as Document;
});
afterEach(() => Object.assign(globalThis, originals));

test('the 320px source cannot collapse to its 24px first preview during forced layout', () => {
  const root = new Surface(), handoff = prepareSourceHandoff(root as unknown as HTMLElement)!;
  root.contentHeight = 24; // React has removed the source and put the preview in normal flow.
  expect(root.height).toBe(320);
  handoff.reveal(root.preview());
  expect(root.layoutReads).toEqual([320, 320]);
  expect(root.height).toBe(320);
  expect(root.style.height).toBe('');
  expect(root.style.paddingBlockEnd).toBe('');
  const motion = root.motions[0]!;
  expect(motion.options).toEqual({ duration: 720, easing: 'cubic-bezier(.45,0,.55,1)' });
  motion.progress = 0.5; expect(root.height).toBe(172);
  motion.finish(); expect(root.height).toBe(24);
});

test('tokens grow naturally during handoff without a new animation or persistent height constraint', () => {
  const root = new Surface(), handoff = prepareSourceHandoff(root as unknown as HTMLElement)!;
  root.contentHeight = 24; handoff.reveal(root.preview());
  const motion = root.motions[0]!;
  motion.progress = 0.5;
  root.contentHeight = 500; handoff.reveal(root.preview());
  expect(root.height).toBe(648);
  expect(root.motions).toHaveLength(1);
  motion.finish(); expect(root.height).toBe(500);
  root.contentHeight = 64; expect(root.height).toBe(64);
});

test('an equal or taller first preview needs no artificial spacing', () => {
  for (const height of [320, 640]) {
    const root = new Surface(), handoff = prepareSourceHandoff(root as unknown as HTMLElement)!;
    root.contentHeight = height; handoff.reveal(root.preview());
    expect(root.height).toBe(height);
    expect(root.style.height).toBe('');
    expect(root.motions).toHaveLength(0);
  }
});

test('source reset, identity change or unmount cancels both a pending pin and a running handoff', () => {
  for (const revealed of [false, true]) {
    const root = new Surface(), handoff = prepareSourceHandoff(root as unknown as HTMLElement)!;
    root.contentHeight = 24;
    if (revealed) handoff.reveal(root.preview());
    handoff.cancel(); handoff.cancel(); handoff.reveal(root.preview());
    expect(root.height).toBe(24);
    expect(root.style).toEqual({ height: '', paddingBlockEnd: '' });
    expect(root.motions.filter(motion => motion.active)).toHaveLength(0);
    expect(root.motions).toHaveLength(revealed ? 1 : 0);
  }
});

test('reduced motion and hidden pages skip the pin; enabling reduced motion releases it immediately', () => {
  const root = new Surface();
  media.matches = true; expect(prepareSourceHandoff(root as unknown as HTMLElement)).toBeUndefined();
  media.matches = false; page.hidden = true; expect(prepareSourceHandoff(root as unknown as HTMLElement)).toBeUndefined();
  expect(root.style.height).toBe('');
  page.hidden = false;
  const handoff = prepareSourceHandoff(root as unknown as HTMLElement)!;
  root.contentHeight = 24; handoff.reveal(root.preview());
  media.matches = true; media.dispatchEvent(new Event('change'));
  expect(root.height).toBe(24);
  expect(root.motions[0]!.active).toBe(false);
});

test('zero-height hidden sources do not reserve space', () => {
  const root = new Surface(); root.contentHeight = 0;
  expect(prepareSourceHandoff(root as unknown as HTMLElement)).toBeUndefined();
  expect(root.style.height).toBe('');
});
