'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createScrollFollow } from '../code/scroll-follow';

const EDGE_RAMP = 24;
const BOTTOM_TOLERANCE = 2;

export function useReasoningScroll(contentKey: string, live: boolean, historyOpen = false) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const liveRef = useRef(live);
  const follower = useRef<ReturnType<typeof createScrollFollow> | null>(null);
  const resume = useCallback((event?: { detail: number }) => follower.current?.resume(event?.detail === 0 ? 'instant' : 'smooth'), []);

  useEffect(() => {
    const element = viewport.current, inner = content.current;
    if (!element || !inner) return;
    let lastFollowing = true, lastOverflowing = false;
    const follow = createScrollFollow(element, {
      following: liveRef.current, enabled: () => liveRef.current,
      onChange: ({ top, gap, following }) => {
        element.style.setProperty('--reasoning-fade-top', String(Math.min(1, top / EDGE_RAMP)));
        element.style.setProperty('--reasoning-fade-bottom', String(Math.min(1, Math.max(0, gap - top) / EDGE_RAMP)));
        if (lastFollowing !== following) { lastFollowing = following; setFollowing(following); }
        if (lastOverflowing !== (gap > BOTTOM_TOLERANCE)) { lastOverflowing = gap > BOTTOM_TOLERANCE; setOverflowing(lastOverflowing); }
      },
    });
    follower.current = follow;
    follow.update(true);
    const observer = new ResizeObserver(() => follow.update());
    observer.observe(element); observer.observe(inner);
    return () => { observer.disconnect(); follow.destroy(); follower.current = null; };
  }, []);

  // Only committed streaming state reaches the controller; it owns transient positions outside React.
  useEffect(() => {
    const finished = liveRef.current && !live;
    liveRef.current = live;
    // Finish the last streamed movement; opening history is a distinct request to stop following.
    if (historyOpen) follower.current?.pause();
    else if (finished) follower.current?.finish();
    else if (contentKey) follower.current?.update();
  }, [contentKey, live, historyOpen]);
  return { viewport, content, following, overflowing, resume };
}
