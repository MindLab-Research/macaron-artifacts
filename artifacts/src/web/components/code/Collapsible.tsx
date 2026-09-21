"use client";
import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEventHandler } from "react";
import { ProgressiveFade } from "./ProgressiveFade";
import { useTailFollow } from "./useTailFollow";

/**
 * 限高 + 渐进模糊的折叠壳。工具调用的回显（写入的文件、diff、命令输出）动辄几百行，
 * 铺开会把对话冲散；但直接 `overflow: hidden` 硬切又看不出「下面还有」。
 *
 * 渐进模糊而不是单纯的渐隐：叠 N 层各自只在一小段区间内可见的 `backdrop-filter`，
 * 模糊半径逐层加大，视觉上是连续变糊而不是一条明显的分界线（macaron-genui-demo 的
 * `ProgressiveBlur` 同法）。
 *
 * 收起态里内容是**可滚**的，并且跟着尾部走（见 `useTailFollow`）——「限高」不等于「只看得到开头」，
 * 流式写入时该看到的是正在长出来的那一头。糊哪条边因此不是固定的，取决于哪一边还有没露出来的内容。
 */
const BLUR_STEP = 0.6;

/** 渐隐带的高度。模糊层和透明度渐变共用，两者必须同一段区间，否则会看到「糊了但还很实」的一条。 */
const FADE = 96;

/**
 * 强度爬满所需要的滚动距离。**刻意比 `FADE` 大得多**：这两个数一相等，滚轮一格（Chrome 约 100px）
 * 就把强度从 0 顶到 1，整条带子只能靠补间去追，看着就是凭空出现的。拉长到三格左右，
 * 强度才是真的跟着手指/滚轮长出来的。
 */
const RAMP = 280;

/** 收起时的高度上限。比一屏小，但足够看清 diff 的上下文。 */
const CAP = 320;

/** 量化到 1/50 之后每格仍是一小跳，补间把这些台阶抹平。 */
const EASE = "320ms cubic-bezier(0.32,0.72,0,1)";

/**
 * 展开按钮的显示门槛：渐隐带刚起头时它压不住底下的代码。透明度从这里线性爬到 1，
 * 所以出场依然是连续的，不是到点一跳；乘 4 让它在门槛之后很快就满 —— 实测停在 0.38 时
 * 它就是浮在代码上的一层灰字，根本读不出来，半透明的中间态在这里没有任何价值。
 */
const REVEAL = 0.45;
const REVEAL_RAMP = 4;

/** 两条边各自吃掉多少：`--fade-*` 是 0～1 的强度，乘 FADE 得到实际带宽。 */
const MASK = `linear-gradient(180deg,transparent,#000 calc(var(--fade-top) * ${FADE}px),#000 calc(100% - var(--fade-bottom) * ${FADE}px),transparent)`;

export function Collapsible({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  const scroller = useRef<HTMLDivElement>(null);
  const inner = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<HTMLButtonElement | null>(null);
  const contentId = useId();
  const [keyboard, setKeyboard] = useState(false);
  const [height, setHeight] = useState(0);
  const [open, setOpen] = useState(false);
  const toggle = (next: boolean, event: React.MouseEvent<HTMLButtonElement>) => {
    const keyboard = event.detail === 0;
    pendingFocus.current = document.activeElement === event.currentTarget ? event.currentTarget : null;
    setKeyboard(keyboard);
    setOpen(next);
  };
  const edges = useTailFollow(scroller, height, RAMP);

  // 流式增长时内容高度每帧都在变，ResizeObserver 比在 render 里量省事，也不会强制同步布局
  useEffect(() => {
    const element = inner.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setHeight(entry.contentRect.height));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const overflowing = height > CAP;
  const collapsed = overflowing && !open;
  // Edge measurements lag the height change by a frame. Keep a usable expansion target throughout that gap.
  const fallbackExpand = collapsed && edges.top <= REVEAL && edges.bottom <= REVEAL;
  useLayoutEffect(() => {
    const previous = pendingFocus.current;
    if (!previous) return;
    pendingFocus.current = null;
    // The activated control is now hidden. Move only its focus, never focus owned by another control.
    if (document.activeElement !== previous && document.activeElement !== document.body) return;
    const next = controls.current?.querySelector<HTMLButtonElement>(':scope > button[data-export-toggle]:not([hidden])');
    if (fallbackExpand && next) pendingFocus.current = next;
    (next ?? scroller.current)?.focus({ preventScroll: !keyboard });
  }, [open, keyboard, fallbackExpand, edges.top, edges.bottom]);
  return (
    <div className={className}>
      {/* 模糊层和展开开关都贴着**窗口**的边，所以定位基准要在这一层。
          两个渐隐强度在这里落地并补间，底下的蒙版和模糊层都是从它们算出来的（继承），因此永远同步 */}
      <div ref={controls} data-export-collapsible data-keyboard={keyboard || undefined} onPointerDownCapture={() => setKeyboard(false)} onWheelCapture={() => setKeyboard(false)} data-export-open={open} data-export-cap={CAP} data-export-ramp={RAMP} data-export-reveal={REVEAL} className="relative" style={{ "--fade-top": collapsed ? edges.top : 0, "--fade-bottom": collapsed ? edges.bottom : 0, transition: `--fade-top ${EASE}, --fade-bottom ${EASE}` } as React.CSSProperties}>
        {/* 高度给到具体像素而不是 max-height：收起态是常量，展开态跟着测量值走。
            `overflow-y-auto` 而不是 hidden —— 跟随尾部靠的就是真的滚动，用户也能自己滚回去看。
            滚动条一律藏起来：蒙版是盖在整个窗口上的，会把滚动条一起糊掉，露着比藏着更难看 */}
        <div
          ref={scroller}
          id={contentId} tabIndex={collapsed ? 0 : -1}
          data-export-scroller
          className="no-scrollbar overflow-y-auto"
          // Settle layout once; interpolating the height relayouts every following message on each frame.
          style={{ height: collapsed ? CAP : height || undefined, maskImage: MASK, WebkitMaskImage: MASK }}
        >
          <div ref={inner} data-export-content>{children}</div>
        </div>
        {/* 强度为 0 时这两层是零高度的空盒子，所以常挂着也不额外合成 —— 但必须常挂着，
            卸掉重挂就没有过渡可言了 */}
        <ProgressiveFade side="top" size={FADE} step={BLUR_STEP} />
        <ProgressiveFade side="bottom" size={FADE} step={BLUR_STEP} />
        {/* 开关浮在被截断的那条边上，居中。哪条边藏了东西就出现在哪条边 —— 跟随尾部时藏的是上面，
            按钮也就只出现在顶上。一律自带底色：它压着的是代码，而渐隐带最多只糊掉一部分 */}
        <Toggle controls={contentId} expanded={!collapsed} side="top" label="↑ 展开" fade hidden={!(collapsed && edges.top > REVEAL)} onClick={event => toggle(true, event)} />
        <Toggle controls={contentId} expanded={!collapsed} side="bottom" label="展开 ↓" fade fallback={fallbackExpand} hidden={!(collapsed && edges.bottom > REVEAL)} onClick={event => toggle(true, event)} />
        <Toggle controls={contentId} expanded={!collapsed} side="bottom" label="收起 ↑" hidden={!(overflowing && !collapsed)} onClick={event => toggle(false, event)} />
      </div>
    </div>
  );
}

function Toggle({ side, label, onClick, fade, hidden, controls, expanded, fallback = false }: { side: "top" | "bottom"; label: string; onClick: MouseEventHandler<HTMLButtonElement>; fade?: boolean; hidden: boolean; controls: string; expanded: boolean; fallback?: boolean }) {
  return (
    <button
      type="button" hidden={hidden && !fallback} data-export-fallback={fallback || undefined} aria-controls={controls} aria-expanded={expanded} data-export-toggle={fade ? side : 'collapse'}
      onClick={onClick}
      // `inset-x-0` + `mx-auto w-fit` 才是绝对定位下的水平居中；只给 left-1/2 会连按钮自身宽度一起偏
      className={`interactive absolute inset-x-0 z-content-overlay mx-auto w-fit rounded-full border border-secondary-border bg-secondary px-2 py-0.5 text-[11px] text-secondary-fg hover:bg-secondary-hover ${side === "top" ? "top-1.5" : "bottom-1.5"}`}
      style={fade ? { opacity: `calc((var(--fade-${side}) - ${REVEAL}) * ${REVEAL_RAMP})` } : undefined}
    >
      {label}
    </button>
  );
}
