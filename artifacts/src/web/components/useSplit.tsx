"use client";
import { useCallback, useEffect, useRef, useState } from "react";

const STORAGE_KEY = "macaron-artifacts:canvas-width";
const DEFAULT_FRACTION = 0.46;
/**
 * 夹取按**像素**而不是比例。
 *
 * 只按比例夹（20%~80%）在 1280px 下就等于允许 chat 只剩 256px —— 输入框会被挤成一竖条，
 * 加号、文本框、发送挤在一起（实测就是这个样子）。两侧的可用性有绝对下限，跟窗口多大无关：
 * chat 要放得下输入框那一行，canvas 要放得下一张卡片。
 */
const MIN_CHAT_PX = 380;
const MIN_CANVAS_PX = 300;

/** 把一个目标比例夹进"两侧都还能用"的区间；容器本身就窄到装不下两边时，退回等分。 */
function clampFraction(fraction: number, width: number) {
  if (width < MIN_CHAT_PX + MIN_CANVAS_PX + 1) return fraction;
  return Math.min(1 - (MIN_CHAT_PX + 1) / width, Math.max(MIN_CANVAS_PX / width, fraction));
}

/**
 * 可拖动的分栏。存在的理由不只是"好看"：生成的 UI 全部用 container query 做响应式，
 * 拖动 canvas 宽度就是**唯一**能直接验证那些 `@sm:` / `@md:` 断点的方式，不用改窗口大小。
 */
export function useSplit() {
  const container = useRef<HTMLDivElement>(null);
  const [fraction, setFraction] = useState(DEFAULT_FRACTION);
  const [dragging, setDragging] = useState(false);

  // 初值只能在这儿读：`useState` 的初始化跑在服务端，那里没有 localStorage。
  // lint 会建议「直接初始化 state」，照做就是 hydration 不匹配
  useEffect(() => {
    let stored = 0;
    try { stored = Number(localStorage.getItem(STORAGE_KEY)); } catch { /* Resizing remains usable when preference storage is unavailable. */ }
    // oxlint-disable-next-line react/set-state-in-effect
    if (stored > 0 && stored < 1) setFraction(stored);
  }, []);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, String(fraction)); } catch { /* Optional preference, never fail a render or interaction. */ } }, [fraction]);

  // 窗口变窄时旧比例可能已经把某一侧压到下限以下，重新夹一次
  useEffect(() => {
    const onResize = () => {
      const width = container.current?.getBoundingClientRect().width;
      if (width) setFraction((current) => clampFraction(current, width));
    };
    const observer = new ResizeObserver(onResize);
    if (container.current) observer.observe(container.current);
    onResize();
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // preventDefault 挡掉拖动时选中两侧文字，但它同时也挡掉了默认的聚焦 —— 键盘调节要靠这个焦点
    event.preventDefault();
    event.currentTarget.focus();
    // 指针捕获：拖到 iframe / canvas 内容上方时事件仍然回到分隔条，不会中途丢失
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  }, []);

  const onPointerMove = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!dragging) return;
      const box = container.current?.getBoundingClientRect();
      if (!box) return;
      setFraction(clampFraction((box.right - event.clientX) / box.width, box.width));
    },
    [dragging],
  );

  const onPointerUp = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      if (!dragging) return;
      event.currentTarget.releasePointerCapture(event.pointerId);
      setDragging(false);
    },
    [dragging],
  );

  /** 键盘也能调：分隔条是可聚焦的 separator，方向键每次挪 2%。 */
  const onKeyDown = useCallback((event: React.KeyboardEvent) => {
    const step = event.key === "ArrowLeft" ? 0.02 : event.key === "ArrowRight" ? -0.02 : 0;
    if (!step) return;
    event.preventDefault();
    setFraction((current) => {
      const next = clampFraction(current + step, container.current?.getBoundingClientRect().width ?? 0);
      return next;
    });
  }, []);

  return { container, fraction, dragging, handlers: { onPointerDown, onPointerMove, onPointerUp, onKeyDown, onPointerCancel: () => setDragging(false), onLostPointerCapture: () => setDragging(false) } };
}

export function SplitHandle({ dragging, fraction = 50, handlers }: { dragging: boolean; fraction?: number; handlers: ReturnType<typeof useSplit>["handlers"] }) {
  return (
    <div
      role="separator"
      aria-label="调整聊天和 Canvas 宽度"
      aria-orientation="vertical"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(fraction)}
      tabIndex={0}
      {...handlers}
      // 视觉上只有 1px 的线，但热区有 9px —— 光标能落在上面，才谈得上"可拖动"
      className={`group relative hidden w-px shrink-0 cursor-col-resize touch-none bg-border outline-none @[681px]/panes:block ${dragging ? "bg-accent" : ""}`}
    >
      <span className="absolute inset-y-0 -right-1 -left-1 z-10" />
      <span className={`interactive absolute inset-y-0 left-0 w-px bg-accent ${dragging ? "opacity-100" : "opacity-0 group-hover:opacity-100 group-focus:opacity-100"}`} />
    </div>
  );
}
