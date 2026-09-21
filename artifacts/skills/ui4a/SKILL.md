---
name: ui4a
description: Build compact interactive React UI inside chat or a persistent canvas when interaction makes the response more useful.
---

<!-- Generated from src/web/ui4a/manifest.ts; update that manifest when changing the runtime contract. -->

Use ordinary prose for an answer that needs no interaction. Use inline UI for a focused choice, calculator, comparison, or small tracker. Use a canvas for a reusable workspace with several views or persistent files.

For inline UI, put one complete React module in a fenced block whose language is exactly `ui4a/tsx`. Export a default React component. It renders progressively as the block arrives; write a usable scaffold before long data or secondary details. Keep component and import names stable while editing. Close every block and include complete final syntax.

For a canvas, write `.artifacts/canvases/<id>.ui4a.tsx`; the UI discovers it and opens a side panel. Use a stable descriptive id. Supporting modules can live beside it and use relative imports with explicit `.tsx`, `.ts`, `.jsx`, `.js`, or `.json` extensions. Relative module imports are available for file canvases, not inline blocks. Keep the dependency graph acyclic. Mention the canvas briefly in the conversation instead of duplicating its source in a fence.

Use React and the small `$ui4a/ui` library below by default. Compose native HTML for simple layout; do not wrap every paragraph in a Card. Give controls labels, keyboard access, useful empty states, and real local behavior. Render the user's information immediately; do not replace it with a generic dashboard or mock data. Only send a chat message or write a file after an explicit user action. Surface asynchronous errors beside the relevant control.

For a simple equation in prose, use \( ... \) for inline math or \[ ... \] for display math; display $$ on separate lines also works. Single dollar signs remain literal for prices. For mathematical explanations, prefer a compact `ui4a/tsx` block when a rendered formula or interaction makes the relationship clearer. Use `$ui4a/ui/katex` for formulas and `$ui4a/ui/charts` for charts. When parameters affect a function, place the formula, a restrained line chart, and labeled sliders together; derive the formula, plotted samples, and selected values from the same numeric state. Use native range inputs with explicit min/max/step and convert input with Number(event.target.value). Show variable names, units and current values. Keep a stable chart height and domain so changes are comparable, use theme series colors, and avoid decorative chart animation. Import chart primitives from the same built-in module. Put TeX in the value string prop, never raw JSX children; use String.raw or double the backslashes in ordinary JS strings.

Fit the provided container: use width:100%, min-width:0, wrapping text, and container-relative layouts. Avoid page headers, outer background fills, min-height:100vh, and viewport-width sizing. Inherit the host's theme. Semantic UnoCSS colors are surface, surface-2, surface-3, border, fg, muted, accent, accent-fg, danger, success, warn, and series-1 through series-6; use restrained spacing and hierarchy. Do not hard-code a light or dark page.

Use complete UnoCSS utilities in `className`, such as `hover:bg-accent hover:text-accent-fg`. The runtime extracts classes without build-time transformers: variant groups such as `hover:(bg-accent text-accent-fg)`, Attributify, and CSS directives such as `@apply` are unavailable. Prefer literal class strings and mappings for conditional styles.

React, react-dom, react-dom/client, the React JSX runtimes, and the modules below are provided locally. Other npm imports can resolve through the CDN, but prefer built-in capabilities and avoid network dependencies for basic UI. Do not invent `$ui4a/*` modules; `$ui4a/ai`, command execution, and directory listing are unavailable. Persist only JSON-compatible state; do not store credentials. File read/write paths start with `.artifacts/` and are relative to this session's workspace.

### $ui4a/ui

- `Button`: Native button props, variant?: "primary" | "secondary" | "ghost" | "danger", size?: "sm" | "md".
- `Field`: Native input props plus label: string and hint?: string. Includes an associated accessible label.
- `Card`: Native div props. A restrained filled surface for grouping; prefer spacing and surface hierarchy over adding borders.
- `Badge`: Native span props. Compact secondary status or metadata.
- `Tabs`: { items: { id: string, label: ReactNode, children: ReactNode }[], value?: string, onChange?: (id: string) => void }.
- `Disclosure`: { title: ReactNode, children: ReactNode, defaultOpen?: boolean }. Accessible expandable content; child state survives collapsing.

### $ui4a/ui/katex

- `LaTeX`: { value?: string, block?: boolean, className?: string, style?: CSSProperties }. KaTeX formula; value is TeX without delimiters. Stable DOM during sibling updates; incomplete TeX degrades to readable source.
- `MathBlock`: Same props as LaTeX without block; standalone display formula with horizontal overflow contained.

### $ui4a/ui/charts

- `ChartContainer`: { children?: ReactElement, height?: number (default 240), ...divProps }. Responsive chart frame; give it a stable id. Preserves the previous complete chart during partial source updates.
- `LineChart`: Recharts LineChart props. Use inside ChartContainer with data rows, XAxis, YAxis and Line children; enable accessibilityLayer.
- `AreaChart`: Recharts AreaChart props; filled trends with Area children.
- `BarChart`: Recharts BarChart props; category comparisons with Bar children.
- `ComposedChart`: Recharts ComposedChart props; combine line, area and bar series.
- `PieChart`: Recharts PieChart props; put data on its Pie child.
- `Line`: Recharts Line props, including dataKey, stroke, strokeWidth and dot. Animation defaults off and is suppressed during partial source updates.
- `Area`: Recharts Area props, including dataKey, stroke and fill. Streaming-aware data and animation.
- `Bar`: Recharts Bar props, including dataKey and fill. Streaming-aware data and animation.
- `Pie`: Recharts Pie props, including data, dataKey and nameKey. Streaming-aware data and animation.
- `XAxis`: Recharts XAxis props. For functions use type="number", dataKey="x" and an explicit domain; source updates preserve equivalent callbacks.
- `YAxis`: Recharts YAxis props. Set an explicit domain when comparing parameter changes; choose width to fit tick labels.
- `CartesianGrid`: Recharts CartesianGrid props. Prefer subtle horizontal grid lines (vertical={false}).
- `Tooltip`: Recharts Tooltip props; host-themed by default.
- `Legend`: Recharts Legend props; name each series clearly.
- `ReferenceLine`: Recharts ReferenceLine props; mark a threshold or x/y=0.
- `ReferenceDot`: Recharts ReferenceDot props; mark a selected (x, y) point.
- `Cell`: Recharts Cell props; per-item fill for bars or pie slices.

### $ui4a/chat

- `sendMessage`: (text: string) => void. Starts a visible user turn in this session. Call only from an explicit user action.

### $ui4a/state

- `usePersistedState`: <T>(key: string, initial: T | (() => T)) => [T, Dispatch<SetStateAction<T>>]. JSON state isolated by session and surface, restored after remount/reload. Functional updates work.

### $ui4a/fs

- `readFile`: (path: string) => Promise<string>. Reads UTF-8 text from a workspace-relative .artifacts/ path; rejects unavailable files.
- `writeFile`: (path: string, content: string) => Promise<void>. Writes UTF-8 text inside .artifacts/. Maximum file size is 2 MB. Show pending/success/error feedback.

Example inline module:

```ui4a/tsx
import { Button } from "$ui4a/ui";
import { usePersistedState } from "$ui4a/state";
export default function Counter() {
  const [count, setCount] = usePersistedState("count", 0);
  return <div className="flex items-center gap-3"><span>{count} completed</span><Button onClick={() => setCount(n => n + 1)}>Complete one</Button></div>;
}
```

Example interactive formula:

```ui4a/tsx
import { useId, useState } from "react";
import { MathBlock } from "$ui4a/ui/katex";
import { ChartContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip } from "$ui4a/ui/charts";
export default function Quadratic() {
  const [a, setA] = useState(0.5);
  const inputId = useId();
  const data = Array.from({ length: 41 }, (_, i) => { const x = (i - 20) / 4; return { x, y: a * x * x }; });
  return <div className="@container grid items-center gap-4 @md:grid-cols-2">
    <div className="min-w-0"><MathBlock value={"y = " + a.toFixed(1) + "x^2"} />
      <label htmlFor={inputId} className="mt-4 flex justify-between text-sm"><span>a</span><output className="tabular-nums">{a.toFixed(1)}</output></label>
      <input id={inputId} type="range" min={-1} max={1} step={0.1} value={a} onChange={event => setA(Number(event.target.value))} className="w-full accent-accent" />
    </div>
    <ChartContainer id="quadratic" height={240} aria-label="y = a x squared">
      <LineChart data={data} accessibilityLayer margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
        <CartesianGrid vertical={false} /><XAxis dataKey="x" type="number" domain={[-5, 5]} ticks={[-5, 0, 5]} tickLine={false} axisLine={false} />
        <YAxis domain={[-25, 25]} ticks={[-25, 0, 25]} width={36} tickLine={false} axisLine={false} /><Tooltip />
        <Line dataKey="y" name="y" stroke="var(--series-1)" strokeWidth={2} dot={false} />
      </LineChart>
    </ChartContainer>
  </div>;
}
```
