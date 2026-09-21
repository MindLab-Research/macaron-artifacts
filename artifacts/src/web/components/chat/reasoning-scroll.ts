type ScrollViewport = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;

export const reasoningScrollTop = (element: ScrollViewport) => Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, element.scrollTop));

export function followReasoningScroll(element: ScrollViewport, following: boolean, force: boolean): number {
  const gap = Math.max(0, element.scrollHeight - element.clientHeight);
  const rawTop = element.scrollTop;
  // Safari exposes elastic offsets outside [0, gap]. A scrollTop write cancels that native motion.
  const bouncing = rawTop < 0 || rawTop > gap;
  if (force ? rawTop !== gap : following && !bouncing && gap - rawTop > 1) element.scrollTop = gap;
  return gap;
}
