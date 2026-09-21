'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createScrollFollow } from '../code/scroll-follow';

/** Stream growth and explicit return share one interruptible motion, independent of React token renders. */
export function useStickToBottom<V extends HTMLElement, C extends HTMLElement>() {
  const viewport = useRef<V>(null);
  const content = useRef<C>(null);
  const [stuck, setStuck] = useState(true);
  const follower = useRef<ReturnType<typeof createScrollFollow> | null>(null);
  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => follower.current?.resume(behavior), []);

  useEffect(() => {
    const element = viewport.current, box = content.current;
    if (!element || !box) return;
    let lastFollowing = true;
    const follow = createScrollFollow(element, { following: true, tolerance: 48, onChange: ({ following }) => { if (following !== lastFollowing) { lastFollowing = following; setStuck(following); } } });
    follower.current = follow;
    // Loading a conversation has no preceding motion to animate. Only subsequent layout growth eases.
    follow.update(true);
    const observer = new ResizeObserver(() => follow.update());
    observer.observe(element); observer.observe(box);
    return () => { observer.disconnect(); follow.destroy(); follower.current = null; };
  }, []);

  return { viewport, content, stuck, scrollToBottom };
}
