"use client";
import { useEffect, useRef, useState } from "react";

/**
 * 两条边各自「外面还藏了多少」，`0`～`1`，离边超过 `range` 像素就饱和。
 *
 * 给连续量而不是布尔：调用方拿它同时驱动蒙版宽度、模糊半径和透明度，滚到边缘附近时渐隐带是
 * 化开的，而不是「有」和「没有」之间闪一下。量化到 1/50 —— 滚动时这个值每帧都在变，
 * 不吸附一下就是每帧一次 React 渲染。
 */
function scrollEdges(element: HTMLElement, range: number) {
  const gap = element.scrollHeight - element.clientHeight;
  const ratio = (value: number) => Math.round(Math.min(1, Math.max(0, value / range)) * 50) / 50;
  return { start: ratio(element.scrollTop), end: ratio(gap - element.scrollTop) };
}

/**
 * 限高窗口跟着内容尾部走：新的一行永远贴在底边。
 *
 * 用弹簧而不是 `scroll-behavior: smooth`：流式每帧都在改目标，smooth 每次赋值都重启一段动画，
 * 叠起来是一顿一顿的；弹簧只有一个持续积分的状态，目标变了也不会打断，看着是一条连续的位移。
 */
const STIFFNESS = 180;
const DAMPING = 28;

export function useTailFollow(ref: React.RefObject<HTMLElement | null>, height: number, range: number) {
  const [edges, setEdges] = useState({ top: 0, bottom: 0 });
  const following = useRef(false);
  /** 上次量到的内容高度。`0` = 还没量过 —— 内容一次到位（刷新、翻历史消息）不算「长出来」，那种该停在开头。 */
  const seen = useRef(0);
  /** 自己维护浮点位置：`scrollTop` 读回来会被取整，拿它当积分状态会在低速段卡住。 */
  const position = useRef(0);
  const velocity = useRef(0);
  const frame = useRef(0);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const { start: top, end: trailing } = scrollEdges(element, range);
      // 滚到底就重新挂上跟随。但内容还没撑开时（scrollHeight === clientHeight）不算 ——
      // 那是「还没有东西」，不是「已经看到底了」
      if (!trailing && element.scrollHeight > element.clientHeight) following.current = true;
      // 跟随中底边一律不糊：弹簧总是落后于正在长高的内容一小段，按距离算的话渐隐带会一直挂在那儿，
      // 糊的正好是刚写出来的那一行 —— 而那一段「还没追上」在语义上不是被截断的内容，是马上就到的
      const bottom = following.current ? 0 : trailing;
      setEdges((previous) => (previous.top === top && previous.bottom === bottom ? previous : { top, bottom }));
    };
    // 用户一动手就脱离跟随。scroll 事件分不出是谁滚的（弹簧自己也在写 scrollTop），
    // wheel / touch / 按键才是人的意图
    const release = () => {
      following.current = false;
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      velocity.current = 0;
    };
    element.addEventListener("scroll", measure, { passive: true });
    // 内容高度变了也要重量：`measure` 只挂在 scroll 上的话，一次到位的内容（刷新、翻历史、
    // 手动点开源码）永远不会触发它 —— 首帧量的时候 scrollHeight 还等于 clientHeight，
    // `!trailing` 把它当成「已经滚到底」挂上了跟随，于是底边一直不糊，几百行代码看着像到此为止
    const resize = new ResizeObserver(measure);
    resize.observe(element);
    if (element.firstElementChild) resize.observe(element.firstElementChild);
    element.addEventListener("wheel", release, { passive: true });
    element.addEventListener("touchstart", release, { passive: true });
    element.addEventListener("keydown", release);
    measure();
    return () => {
      element.removeEventListener("scroll", measure);
      element.removeEventListener("wheel", release);
      element.removeEventListener("touchstart", release);
      element.removeEventListener("keydown", release);
      resize.disconnect();
      cancelAnimationFrame(frame.current);
    };
  }, [ref, range]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const grew = seen.current > 0 && height > seen.current;
    seen.current = height;
    if (!grew) return;
    following.current = true;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.scrollTop = element.scrollHeight - element.clientHeight;
      return;
    }
    // 已经在跑就不重启：目标是每帧现取的，长出来的新内容自然被追上 ——
    // 生成结束只是不再有新目标，弹簧停在原地，不会「弹回顶部」
    if (frame.current) return;
    position.current = element.scrollTop;
    const step = () => {
      if (!following.current) return ((frame.current = 0), undefined);
      const target = element.scrollHeight - element.clientHeight;
      const distance = target - position.current;
      velocity.current += (STIFFNESS * distance - DAMPING * velocity.current) / 60;
      position.current += velocity.current / 60;
      if (Math.abs(distance) < 0.5 && Math.abs(velocity.current) < 2) {
        position.current = target;
        velocity.current = 0;
        element.scrollTop = target;
        frame.current = 0;
        return;
      }
      element.scrollTop = position.current;
      frame.current = requestAnimationFrame(step);
    };
    frame.current = requestAnimationFrame(step);
  }, [height, ref]);

  return edges;
}
