import { stepTailSpring } from './tail-spring';

type ScrollPosition = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;
export const scrollLimit = (element: ScrollPosition) => Math.max(0, element.scrollHeight - element.clientHeight);
export const scrollTop = (element: ScrollPosition) => Math.min(scrollLimit(element), Math.max(0, element.scrollTop));
export type ScrollFollowState = { top: number; gap: number; following: boolean };

/** One motion owner for streamed growth and explicit resume; resize must never replace an in-flight return with a jump. */
export function createScrollFollow(element: HTMLElement, options: { following: boolean; enabled?: () => boolean; tolerance?: number; resumeWhenContentFits?: boolean; onChange?: (state: ScrollFollowState) => void }) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const anchor = element.style.overflowAnchor;
  const tolerance = options.tolerance ?? 2;
  let following = options.following, paused = false, forced = false, touching = false, trackingTouch = false, touchY = 0;
  let frame = 0, previousTime = 0, position = scrollTop(element), velocity = 0;
  let lastTop = position, lastGap = scrollLimit(element);
  const active = () => following && (forced || options.enabled?.() !== false);
  const notify = () => options.onChange?.({ top: scrollTop(element), gap: scrollLimit(element), following });
  const stop = () => { cancelAnimationFrame(frame); frame = 0; velocity = 0; reduced.removeEventListener('change', onPreference); };
  const setFollowing = (next: boolean) => { following = next; element.style.overflowAnchor = next ? 'none' : anchor; };
  const release = () => { paused = true; forced = false; setFollowing(false); stop(); notify(); };
  const write = (top: number) => {
    element.scrollTop = top;
    lastTop = scrollTop(element);
    lastGap = scrollLimit(element);
  };
  const reconcile = () => {
    const gap = scrollLimit(element), top = scrollTop(element);
    const bouncing = element.scrollTop < 0 || element.scrollTop > gap;
    // A shrink can clamp scrollTop before the same layout grows again. Position alone cannot prove
    // reader intent; wheel, keyboard, touch and scrollbar input take ownership explicitly instead.
    if (!bouncing && top > lastTop && gap - top <= tolerance) { paused = false; setFollowing(true); }
    else if (!bouncing && !following && top !== lastTop) paused = true;
    if (!bouncing && top !== lastTop) { position = top; velocity = 0; }
    if (gap < lastGap) { position = Math.min(position, gap); if (position === gap) velocity = 0; }
    lastTop = top; lastGap = gap;
    return bouncing;
  };
  const step = (time: number) => {
    frame = 0;
    if (reconcile() || touching || !active()) { stop(); notify(); return; }
    const target = scrollLimit(element);
    if (reduced.matches) { position = target; write(target); forced = false; stop(); notify(); return; }
    const next = stepTailSpring(position, velocity, target, time - previousTime);
    previousTime = time; position = next.position; velocity = next.velocity;
    if (target - position < 0.5 && Math.abs(velocity) < 2) {
      position = target; write(target); forced = false; stop(); notify(); return;
    }
    write(position); notify();
    frame = requestAnimationFrame(step);
  };
  const update = (instant = false) => {
    const bouncing = reconcile();
    const gap = scrollLimit(element);
    if (!gap && paused && options.resumeWhenContentFits !== false) { paused = false; setFollowing(true); }
    if (options.enabled?.() === false && !forced && gap - scrollTop(element) > tolerance) setFollowing(false);
    if (bouncing || touching || !active()) { stop(); notify(); return; }
    if (instant || reduced.matches) { stop(); position = gap; if (element.scrollTop !== gap) write(gap); forced = false; }
    else if (!frame && gap - scrollTop(element) > 0.5) {
      position = scrollTop(element); velocity = 0; previousTime = performance.now();
      reduced.addEventListener('change', onPreference); frame = requestAnimationFrame(step);
    }
    else if (!frame) forced = false;
    notify();
  };
  // Nested panes own their input unless a gesture can chain beyond their current edge.
  const ownsInput = (event: Event, direction = 0) => {
    if (event.defaultPrevented) return false;
    for (let node = event.target instanceof Element ? event.target : null; node && node !== element; node = node.parentElement) {
      if (node.scrollHeight <= node.clientHeight + 1) continue;
      const style = getComputedStyle(node);
      if (/auto|scroll|overlay/.test(style.overflowY)) {
        if (!direction || /contain|none/.test(style.overscrollBehaviorY) || (direction < 0 ? scrollTop(node) > 0 : scrollTop(node) < scrollLimit(node))) return false;
      }
    }
    return true;
  };
  const onWheel = (event: WheelEvent) => { if ((event.deltaY < 0 || !following && event.deltaY !== 0) && ownsInput(event, event.deltaY)) release(); };
  // Native scrollbar thumb/track input targets the scroll plane itself, not its content descendants.
  const onPointerDown = (event: PointerEvent) => { if (event.target === element && event.pointerType !== 'touch' && !event.defaultPrevented) release(); };
  const onKeyDown = (event: KeyboardEvent) => {
    if (!ownsInput(event) || event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="slider"]')) return;
    if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || event.key === ' ' && event.shiftKey) release();
  };
  const onTouchStart = (event: TouchEvent) => {
    if (event.defaultPrevented || !event.touches.length) return;
    trackingTouch = true; touchY = event.touches[0].clientY;
    if (ownsInput(event)) { touching = true; stop(); }
  };
  const onTouchMove = (event: TouchEvent) => {
    if (!trackingTouch || !event.touches.length) return;
    const nextY = event.touches[0].clientY, direction = touchY - nextY;
    if (ownsInput(event, direction)) { touching = true; stop(); if (direction < 0) release(); }
    touchY = nextY;
  };
  const onTouchEnd = () => { trackingTouch = false; touching = false; update(); };
  const onScroll = () => update();
  const onPreference = () => update();
  setFollowing(following);
  element.addEventListener('scroll', onScroll, { passive: true });
  element.addEventListener('wheel', onWheel, { passive: true });
  element.addEventListener('pointerdown', onPointerDown, { passive: true });
  element.addEventListener('keydown', onKeyDown);
  element.addEventListener('touchstart', onTouchStart, { passive: true });
  element.addEventListener('touchmove', onTouchMove, { passive: true });
  element.addEventListener('touchend', onTouchEnd, { passive: true });
  element.addEventListener('touchcancel', onTouchEnd, { passive: true });
  return {
    update,
    pause: release,
    finish() { if (following) { forced = true; update(); } },
    grow() { if (!paused) setFollowing(true); update(); },
    reset() {
      if (!following) return;
      // Source-to-preview replacement is our navigation, not a reverse scroll from the reader.
      stop(); position = 0; write(0); update();
    },
    resume(behavior: ScrollBehavior = 'smooth') {
      paused = false; forced = true; setFollowing(true);
      // Explicit navigation may end an elastic gesture; passive growth never writes outside the native range.
      if (element.scrollTop !== scrollTop(element)) write(scrollTop(element));
      update(behavior !== 'smooth');
    },
    destroy() {
      stop(); element.style.overflowAnchor = anchor;
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('pointerdown', onPointerDown);
      element.removeEventListener('keydown', onKeyDown);
      element.removeEventListener('touchstart', onTouchStart);
      element.removeEventListener('touchmove', onTouchMove);
      element.removeEventListener('touchend', onTouchEnd);
      element.removeEventListener('touchcancel', onTouchEnd);
    },
  };
}
