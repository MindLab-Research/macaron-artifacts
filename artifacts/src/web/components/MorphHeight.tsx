import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './MorphHeight.css';

/** Only explicit state changes morph; typing, initial layout and responsive reflow stay direct. */
export function MorphHeight({ change, animate, children }: { change: unknown; animate: boolean; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null), content = useRef<HTMLDivElement>(null), previous = useRef(change);
  useLayoutEffect(() => {
    const outer = frame.current!, inner = content.current!, reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const changed = previous.current !== change;
    previous.current = change;
    const motion = changed && animate && !reduced.matches && !document.hidden;
    const sync = (animate: boolean) => {
      const height = `${inner.offsetHeight}px`;
      if (outer.style.height === height) return;
      outer.dataset.motion = String(animate); outer.style.height = height;
    };
    sync(motion);
    const arrival = motion ? inner.animate([{ opacity: 0, transform: 'translateY(4px)' }, { opacity: 1, transform: 'translateY(0)' }], { duration: 240, easing: 'cubic-bezier(.22,1,.36,1)' }) : undefined;
    const cancel = () => arrival?.cancel();
    reduced.addEventListener('change', cancel);
    // Observe natural content, never the animated frame, to avoid restarting the resize on every frame.
    const observer = new ResizeObserver(() => sync(false));
    observer.observe(inner);
    return () => { observer.disconnect(); cancel(); reduced.removeEventListener('change', cancel); };
  }, [change, animate]);
  return <div ref={frame} className="morph-height"><div ref={content}>{children}</div></div>;
}
