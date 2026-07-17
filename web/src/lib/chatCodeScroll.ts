// Pure scroll-ownership decision for the streaming code viewport, split out so it can be
// unit-tested without a DOM. Auto-follow only ever scrolls DOWN toward the bottom, so any
// upward movement is unambiguously the user taking ownership — hand it over immediately,
// with no timed suppression window that could swallow a real scroll. Scrolling back to the
// bottom re-arms auto-follow.
export function nextScrollStickiness(
  previous: boolean,
  viewport: { scrollTop: number; lastScrollTop: number; scrollHeight: number; clientHeight: number },
  bottomThreshold = 72,
): boolean {
  // Sub-pixel epsilon so smooth-scroll jitter isn't misread as an upward user scroll.
  if (viewport.scrollTop < viewport.lastScrollTop - 1) return false;
  if (viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= bottomThreshold) return true;
  return previous;
}
