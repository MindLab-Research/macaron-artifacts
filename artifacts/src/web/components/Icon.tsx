/**
 * 宿主自己的图标。
 *
 * 生成代码用 `lucide-react`（从 esm.sh 拉），宿主之前是三套混用：两个手画的 svg、
 * 一批文字符号（`＋ × ☰ ☾ ⌄ ›`）、还有 emoji。同一个界面里三种笔画粗细和视觉重量，
 * 而文字符号还会跟着字体走 —— `×` 在不同系统上宽度差一截，按钮会跟着抖。
 *
 * 这里抄 lucide 的 path（24×24、`stroke-width:2`、round cap），但不引整个包：
 * 宿主只用得到十几个，而 `lucide-react` 进首屏 bundle 是几百 KB 起。
 */
const ICON_PATHS = {
  plus: "M5 12h14M12 5v14",
  x: "M18 6 6 18M6 6l12 12",
  send: "M12 19V5M5 12l7-7 7 7",
  menu: "M4 12h16M4 6h16M4 18h16",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9z",
  monitor: "M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM12 17v4M8 21h8",
  chevronDown: "m6 9 6 6 6-6",
  chevronRight: "m9 18 6-6-6-6",
  chevronLeft: "m15 18-6-6 6-6",
  check: "M20 6 9 17l-5-5",
  chevronUp: "m18 15-6-6-6 6",
  arrowDown: "M12 5v14M19 12l-7 7-7-7",
  panelLeft: "M3 3h18v18H3zM9 3v18",
  sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  ellipsis: "M12 12h.01M19 12h.01M5 12h.01",
} as const;

export type IconName = keyof typeof ICON_PATHS;

/** `filled` 给实心图形用（停止的方块），其余走描边。 */
export function Icon({ name, className, filled }: { name: IconName; className?: string; filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className={className ?? "size-4"} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      {filled ? <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" /> : <path d={ICON_PATHS[name]} />}
    </svg>
  );
}
