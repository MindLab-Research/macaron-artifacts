import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Measure the untransformed stack, not the animated viewport: otherwise resize retargets the morph every frame. */
export function useQuestionTrack(page: number) {
  const viewport = useRef<HTMLDivElement>(null), track = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const frame = viewport.current, stack = track.current, item = stack?.children[page] as HTMLElement | undefined;
    if (!frame || !stack || !item) return;
    const sync = () => { frame.style.height = `${item.offsetHeight}px`; stack.style.transform = `translate3d(0, ${-item.offsetTop}px, 0)`; };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(stack); observer.observe(item);
    return () => observer.disconnect();
  });
  return { viewport, track };
}

/** One shared background preserves the glide between rows, including rows whose previews change their height. */
export function QuestionChoices({ children }: { children: ReactNode }) {
  const menu = useRef<HTMLDivElement>(null), highlight = useRef<HTMLDivElement>(null), row = useRef<HTMLElement | null>(null);
  const sync = () => {
    if (!highlight.current) return;
    highlight.current.style.opacity = row.current ? '1' : '0';
    if (row.current) { highlight.current.style.top = `${row.current.offsetTop}px`; highlight.current.style.height = `${row.current.offsetHeight}px`; }
  };
  const point = (target: EventTarget | null) => { row.current = target instanceof Element ? target.closest<HTMLElement>('[data-question-choice]') : null; sync(); };
  useLayoutEffect(() => {
    const observer = new ResizeObserver(sync);
    if (menu.current) { observer.observe(menu.current); for (const child of menu.current.children) if (child.hasAttribute('data-question-choice')) observer.observe(child); }
    return () => observer.disconnect();
  }, []);
  return <div ref={menu} className="question-choices clear-both flex flex-col gap-1" onPointerOver={event => point(event.target)} onPointerLeave={() => point(menu.current?.contains(document.activeElement) ? document.activeElement : null)} onFocusCapture={event => point(event.target)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget)) point(null); }}>
    <div ref={highlight} aria-hidden="true" className="question-highlight rounded-lg bg-surface-3" />{children}
  </div>;
}

export function QuestionCounter({ value, motion }: { value: number; motion: boolean }) {
  const root = useRef<HTMLSpanElement>(null);
  const [roll, setRoll] = useState({ value, previous: value, animate: false });
  if (value !== roll.value) setRoll({ value, previous: roll.value, animate: motion });
  useLayoutEffect(() => {
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    if (!roll.animate || reduced.matches) return;
    const distance = roll.value < roll.previous ? -100 : 100, timing = { duration: 350, easing: 'cubic-bezier(.4,0,.2,1)', fill: 'both' as const };
    const animations = [...root.current!.querySelectorAll('.question-digit-old, .question-digit-new')].map(element => element.animate(element.classList.contains('question-digit-old')
      ? [{ transform: 'translateY(0)', visibility: 'visible' }, { transform: `translateY(${-distance}%)`, visibility: 'visible' }]
      : [{ transform: `translateY(${distance}%)` }, { transform: 'translateY(0)' }], timing));
    const cancel = () => animations.forEach(animation => animation.cancel());
    reduced.addEventListener('change', cancel);
    return () => { cancel(); reduced.removeEventListener('change', cancel); };
  }, [roll]);
  useLayoutEffect(() => { if (!motion) root.current?.getAnimations({ subtree: true }).forEach(animation => animation.cancel()); }, [motion]);
  const previous = String(roll.previous), current = String(roll.value), length = Math.max(previous.length, current.length);
  return <span ref={root} aria-hidden="true" className="question-counter">{Array.from({ length }, (_, index) => {
    const old = previous.padStart(length, ' ')[index], next = current.padStart(length, ' ')[index];
    return <span className="question-digit" key={`${index}:${old}:${next}`}>{old === next ? next : <><span className="question-digit-old">{old}</span><span className="question-digit-new">{next}</span></>}</span>;
  })}</span>;
}
