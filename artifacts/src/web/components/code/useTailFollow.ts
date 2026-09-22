'use client';
import { useEffect, useRef, useState } from 'react';
import { createScrollFollow } from './scroll-follow';

/** Preserve the beginning of existing output; only new growth starts following its tail. */
export function useTailFollow(ref: React.RefObject<HTMLElement | null>, height: number, range: number, streaming?: boolean) {
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  const seen = useRef(0);
  const canFollow = useRef(streaming !== false);
  const follower = useRef<ReturnType<typeof createScrollFollow> | null>(null);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let previous: { top: number; bottom: number } | undefined;
    const follow = createScrollFollow(element, {
      following: false,
      enabled: () => canFollow.current,
      onChange: ({ top, gap }) => {
        const ratio = (value: number) => Math.round(Math.min(1, Math.max(0, value / range)) * 50) / 50;
        // Quantized edges avoid rendering the code tree for each fractional motion update.
        // The spring can still be approaching new content; fade every genuinely clipped edge.
        const next = { top: ratio(top), bottom: ratio(gap - top) };
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
    if (streaming === true) canFollow.current = true;
    const grew = height > seen.current && (seen.current > 0 || streaming === true);
    seen.current = height;
    // Explicitly static source must stay at its beginning, including late syntax highlighting.
    if (grew && canFollow.current) follower.current?.grow();
  }, [height, streaming]);

  return edges;
}
