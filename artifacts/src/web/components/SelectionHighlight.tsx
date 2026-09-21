import { useLayoutEffect, useRef, type ReactNode } from 'react';
import './SelectionHighlight.css';

/** Retain one background while Headless UI owns tab/radio semantics and focus. */
export function SelectionHighlight({ value, className, highlightClassName, children }: { value: string; className: string; highlightClassName: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null), pill = useRef<HTMLSpanElement>(null), pointer = useRef(false), previous = useRef(value);
  useLayoutEffect(() => {
    const container = root.current!, highlight = pill.current!;
    // Headless UI can update aria-selected in a later layout pass; use the controlled value, not stale DOM state.
    const selected = [...container.querySelectorAll<HTMLElement>('[data-selection-value]')].find(item => item.dataset.selectionValue === value);
    if (!selected) return;
    const sync = (motion: boolean) => {
      highlight.dataset.motion = String(motion);
      highlight.style.width = `${selected.offsetWidth}px`; highlight.style.height = `${selected.offsetHeight}px`;
      highlight.style.transform = `translate(${selected.offsetLeft}px, ${selected.offsetTop}px)`;
    };
    sync(previous.current !== value && pointer.current && !document.hidden);
    previous.current = value;
    // A queued initial observer delivery must not cancel the selection transition.
    const geometry = () => [selected.offsetLeft, selected.offsetTop, selected.offsetWidth, selected.offsetHeight].join(':');
    let bounds = geometry();
    const observer = new ResizeObserver(() => {
      const next = geometry(); if (bounds === next) return;
      bounds = next; sync(false);
    });
    observer.observe(container); observer.observe(selected);
    return () => observer.disconnect();
  }, [value]);
  return <div ref={root} className={`selection-highlight ${className}`} onPointerDownCapture={() => { pointer.current = true; }} onKeyDownCapture={() => { pointer.current = false; if (pill.current) pill.current.dataset.motion = 'false'; }}>
    <span ref={pill} aria-hidden="true" className={`selection-pill ${highlightClassName}`} />{children}
  </div>;
}
