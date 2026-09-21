'use client';
import { useEffect, useRef, useState } from 'react';
import { createScrollFollow } from './scroll-follow';

/** Preserve the beginning of existing output; only new growth starts following its tail. */
export function useTailFollow(ref: React.RefObject<HTMLElement | null>, height: number, range: number) {
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  const seen = useRef(0);
  const follower = useRef<ReturnType<typeof createScrollFollow> | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let previous: { top: number; bottom: number } | undefined;
    const follow = createScrollFollow(element, {
      following: false,
      onChange: ({ top, gap, following }) => {
        const ratio = (value: number) => Math.round(Math.min(1, Math.max(0, value / range)) * 50) / 50;
        // Quantized edges avoid rendering the code tree for each fractional motion update.
        const next = { top: ratio(top), bottom: following ? 0 : ratio(gap - top) };
        if (previous?.top !== next.top || previous?.bottom !== next.bottom) { previous = next; setEdges(next); }
      },
    });
    follower.current = follow;
    follow.update();
    const observer = new ResizeObserver(() => follow.update());
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => { observer.disconnect(); follow.destroy(); follower.current = null; };
  }, [ref, range]);

  useEffect(() => {
    const grew = seen.current > 0 && height > seen.current;
    seen.current = height;
    if (grew) follower.current?.grow();
  }, [height]);

  return edges;
}
