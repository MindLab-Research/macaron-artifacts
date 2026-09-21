"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * 「贴底」滚动：内容在长，视口就跟着长；用户一旦自己往上翻，就立刻松手，不再抢。
 *
 * 之前那版按消息条数触发，有两个硬伤：流式输出是在**同一条消息内部**变长的，条数不变所以整段
 * 输出期间根本不跟；而且不判断用户意图，翻上去看历史会被拽回底部。
 *
 * 跟随靠 `ResizeObserver` 监视内容盒子 —— 内容变高不会触发 scroll 事件，只有尺寸变化会。
 * 这同时覆盖了文字流入、ui4a 编译完成后撑开、图片加载完成这几种"高度自己长出来"的情况。
 */
export function useStickToBottom<V extends HTMLElement, C extends HTMLElement>() {
  const viewport = useRef<V>(null);
  const content = useRef<C>(null);
  const [stuck, setStuck] = useState(true);
  const stuckRef = useRef(true);

  const setStuckBoth = useCallback((next: boolean) => {
    stuckRef.current = next;
    setStuck(next);
  }, []);

  /**
   * 跟随时用 instant：内容每帧只长几像素，直接贴底本身就是连续的；
   * 换成 smooth 反而会让动画不断被新的目标打断，滚动条一路抖。
   * 离底较远的一次性跳跃（用户点「回到底部」）才值得用 smooth。
   */
  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "smooth") => {
      const element = viewport.current;
      if (!element) return;
      setStuckBoth(true);
      element.scrollTo({ top: element.scrollHeight, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : behavior });
    },
    [setStuckBoth],
  );

  useEffect(() => {
    const element = viewport.current;
    const box = content.current;
    if (!element || !box) return;
    const readTop = () => Math.min(Math.max(0, element.scrollHeight - element.clientHeight), Math.max(0, element.scrollTop));
    let lastTop = readTop();
    let lastHeight = element.scrollHeight;

    /**
     * 判**方向**而不是判距离。
     *
     * 用「离底距离 > 阈值就松手」是错的：内容长得比 pin 得快时，pin 完到回调之间又流入一段，
     * 这时距离本来就是大的 —— 于是自己造成的滞后被当成用户意图，跟随从此断掉（实测流式到一半必挂）。
     * 而内容增长只会让 scrollTop 不变、pin 只会让它变大，**只有用户才会让 scrollTop 变小**。
     */
    const onScroll = () => {
      const top = readTop();
      const height = element.scrollHeight;
      const distance = height - top - element.clientHeight;
      // 内容变矮（折叠、消息被过滤掉）时浏览器会自己把 scrollTop 夹小，那不是用户在翻
      const shrank = height < lastHeight;
      const movedUp = !shrank && top < lastTop - SCROLL_UP_TOLERANCE_PX;
      lastTop = top;
      lastHeight = height;
      if (movedUp) return setStuckBoth(false);
      if (distance <= STICK_THRESHOLD_PX) setStuckBoth(true);
    };
    element.addEventListener("scroll", onScroll, { passive: true });

    const observer = new ResizeObserver(() => {
      if (!stuckRef.current) return;
      const gap = Math.max(0, element.scrollHeight - element.clientHeight);
      // Preserve native elastic offsets, just as the nested Reasoning viewport does.
      if (element.scrollTop < 0 || element.scrollTop > gap) return;
      if (gap - element.scrollTop > 1) element.scrollTo({ top: gap, behavior: 'instant' });
      // 同步更新基线：这次 pin 造成的 scrollTop 变化不该在下一次 onScroll 里被读成用户动作
      lastTop = readTop();
      lastHeight = element.scrollHeight;
    });
    observer.observe(box);

    return () => {
      element.removeEventListener("scroll", onScroll);
      observer.disconnect();
    };
  }, [setStuckBoth]);

  return { viewport, content, stuck, scrollToBottom };
}

/** 约一行正文（14px × 1.6 ≈ 22px）再加一点余量，够盖住 flex gap 造成的取整误差。 */
const STICK_THRESHOLD_PX = 48;
/** 惯性滚动和子像素取整会带来 1px 级的抖动，别把它当成"用户往上翻了"。 */
const SCROLL_UP_TOLERANCE_PX = 2;
