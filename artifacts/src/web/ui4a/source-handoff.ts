/** Reserve the old source height before React removes it, including during forced layout in sibling effects. */
export function prepareSourceHandoff(root: HTMLElement) {
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  if (reduced.matches || document.hidden) return;
  const height = root.getBoundingClientRect().height;
  if (height <= 0) return;
  const previousHeight = root.style.height, previousPadding = root.style.paddingBlockEnd;
  let animation: Animation | undefined, revealed = false, cancelled = false;
  root.style.height = `${height}px`;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    root.style.height = previousHeight;
    root.style.paddingBlockEnd = previousPadding;
    reduced.removeEventListener('change', reduce);
    animation?.cancel();
  };
  const reduce = () => { if (reduced.matches) cancel(); };
  reduced.addEventListener('change', reduce);
  return {
    cancel,
    reveal(preview: HTMLElement) {
      if (revealed || cancelled) return;
      revealed = true;
      const gap = height - preview.getBoundingClientRect().height;
      if (gap <= 0) { cancel(); return; }
      // Release only the vacated space. The preview stays auto-height and new tokens never restart this motion.
      root.style.paddingBlockEnd = `${gap}px`;
      root.style.height = previousHeight;
      animation = root.animate([{ paddingBlockEnd: `${gap}px` }, { paddingBlockEnd: '0px' }], { duration: 720, easing: 'cubic-bezier(.45,0,.55,1)' });
      root.style.paddingBlockEnd = previousPadding;
      animation.addEventListener('finish', cancel, { once: true });
      animation.addEventListener('cancel', cancel, { once: true });
    },
  };
}
