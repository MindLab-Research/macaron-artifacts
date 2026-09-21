'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { followReasoningScroll, reasoningScrollTop } from './reasoning-scroll';

const EDGE_RAMP = 24;
const BOTTOM_TOLERANCE = 2;

export function useReasoningScroll(contentKey: string, live: boolean) {
  const viewport = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [overflowing, setOverflowing] = useState(false);
  const followingRef = useRef(true);
  const liveRef = useRef(live);
  const forcePin = useRef(false);
  const schedule = useRef(() => {});

  const resume = useCallback(() => {
    followingRef.current = true;
    forcePin.current = true;
    schedule.current();
  }, []);

  useEffect(() => {
    const element = viewport.current;
    const inner = content.current;
    if (!element || !inner) return;
    let frame = 0;
    let lastTop = reasoningScrollTop(element);
    let lastHeight = element.scrollHeight;
    const measure = () => {
      frame = 0;
      const gap = followReasoningScroll(element, liveRef.current && followingRef.current, forcePin.current);
      forcePin.current = false;
      const top = reasoningScrollTop(element);
      const bottom = Math.max(0, gap - top);
      if (bottom <= BOTTOM_TOLERANCE) followingRef.current = true;
      else if (!liveRef.current) followingRef.current = false;
      lastTop = top;
      lastHeight = element.scrollHeight;
      element.style.setProperty('--reasoning-fade-top', String(Math.min(1, top / EDGE_RAMP)));
      element.style.setProperty('--reasoning-fade-bottom', String(Math.min(1, bottom / EDGE_RAMP)));
      setFollowing((previous) => previous === followingRef.current ? previous : followingRef.current);
      setOverflowing((previous) => previous === (gap > BOTTOM_TOLERANCE) ? previous : gap > BOTTOM_TOLERANCE);
    };
    const requestMeasure = () => {
      if (!frame) frame = requestAnimationFrame(measure);
    };
    schedule.current = requestMeasure;
    const onScroll = () => {
      // Elastic rebound is not an upward gesture; compare only positions inside the scrollable range.
      const top = reasoningScrollTop(element);
      const shrank = element.scrollHeight < lastHeight;
      if (!shrank && top < lastTop - 0.5) followingRef.current = false;
      if (element.scrollHeight - element.clientHeight - top <= BOTTOM_TOLERANCE) followingRef.current = true;
      lastTop = top;
      lastHeight = element.scrollHeight;
      requestMeasure();
    };
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) followingRef.current = false;
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'ArrowUp' || event.key === 'PageUp' || event.key === 'Home' || (event.key === ' ' && event.shiftKey)) followingRef.current = false;
    };
    const observer = new ResizeObserver(requestMeasure);
    observer.observe(element);
    observer.observe(inner);
    element.addEventListener('scroll', onScroll, { passive: true });
    element.addEventListener('wheel', onWheel, { passive: true });
    element.addEventListener('keydown', onKeyDown);
    requestMeasure();
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      schedule.current = () => {};
      element.removeEventListener('scroll', onScroll);
      element.removeEventListener('wheel', onWheel);
      element.removeEventListener('keydown', onKeyDown);
    };
  }, []);

  // Content/viewport resize handles new tokens; only the committed live state belongs in this effect.
  useEffect(() => { liveRef.current = live; if (contentKey) schedule.current(); }, [contentKey, live]);
  return { viewport, content, following, overflowing, resume };
}
