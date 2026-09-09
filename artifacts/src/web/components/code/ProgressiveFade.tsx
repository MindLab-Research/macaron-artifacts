"use client";

import { memo } from "react";

/**
 * 渐进模糊的边缘带。叠 N 层各自只在一小段区间内可见的 `backdrop-filter`，模糊半径逐层加大，
 * 视觉上是连续变糊而不是一条明显的分界线（macaron-genui-demo 的 `ProgressiveBlur` 同法）。
 *
 * 强度取自 `--fade-<side>`（0～1，注册过的 `<number>`，由调用方补间）：带宽、模糊半径、透明度
 * 全从这一个变量算出来。三者必须一起趋近 0 —— 只淡不减半径的话，收尾那一下仍然看得出
 * 「模糊是被拔掉的」；各自补各自的话，backdrop-filter 慢一两帧合成，看着就是模糊后到。
 */
const LAYERS = 5;

/** 梯度的 0%（最不糊的一层）要落在靠内容的那条边上，所以每个方向的角度都不一样。 */
const ANGLE = { top: 0, bottom: 180 };
const BOX = { top: "inset-x-0 top-0", bottom: "inset-x-0 bottom-0" };

export type FadeSide = keyof typeof ANGLE;

// 三个 prop 全是常量，但外层 Collapsible 每个滚动 tick 都会因为 `edges` 重渲染 —— memo 掉，
// 免得每帧重新拼 5 条 mask 梯度字符串。
export const ProgressiveFade = memo(function ProgressiveFade({ side, size, step }: { side: FadeSide; size: number; step: number }) {
  const segment = 100 / (LAYERS + 1);
  return (
    <div aria-hidden className={`pointer-events-none absolute max-h-full ${BOX[side]}`} style={{ height: `calc(var(--fade-${side}) * ${size}px)` }}>
      {Array.from({ length: LAYERS }, (_, index) => {
        const stops = [index, index + 1, index + 2, index + 3].map((stop, at) => `rgba(0,0,0,${at === 1 || at === 2 ? 1 : 0}) ${stop * segment}%`).join(",");
        const mask = `linear-gradient(${ANGLE[side]}deg,${stops})`;
        // 父层 opacity < 1 会建立 backdrop root，子层采样不到外部内容，直到 opacity = 1 才突然变糊。
        return <div key={index} className="absolute inset-0" style={{ maskImage: mask, WebkitMaskImage: mask, backdropFilter: `blur(calc(var(--fade-${side}) * ${index * step}px))`, opacity: `var(--fade-${side})` }} />;
      })}
    </div>
  );
});
