---
name: ui4a
description: Build compact interactive React UI inside chat or a persistent canvas when interaction makes the response more useful.
---

<!-- Generated from src/web/ui4a/manifest.ts; update that manifest when changing the runtime contract. -->

Choose the primary presentation again for each reply. Use concise prose for a direct fact or fixed result with no useful user-controlled parameter. For personal distress or interpreting a newly reported symptom or clinical test result, keep the whole response in prose, including clarification; an interactive calculator needs an explicit request for a named measure and its required inputs. For other requests involving multi-stage or branching mechanisms and comparisons across shared criteria, use one focused inline explorer by default; do not wait for a request to draw. Its selection or input must change a shared diagram, comparison, or derived result. Put the requested explanation in that view; outside it, use a short lead-in, at most two takeaway sentences, and available source links. Keep further required detail accessible inside the view or canvas instead of repeating a second full answer below it. Reassess follow-up questions instead of postponing useful UI until the final report. When the user explicitly requests multiple visuals or both inline UI and a canvas, deliver each requested item as a separate obligation. Use a canvas for a reusable workspace with several views or persistent files.

When explaining quantities, proportions, scaling or savings, prefer one compact chart with a visible baseline and units. Derive values from cited facts or explicit formulas, label theoretical examples, and keep the chart and numeric summary connected to the same state. For a branching mechanism, retain a concise connected overview showing where paths split and rejoin, with one shared detail region. Tabs containing only prose do not replace these visual relationships. Keep each view focused on one question; never invent measurements or experimental curves to add a chart.

The clarification and missing-input rules below apply only when an interface is appropriate under the response-form rules above.

Ask a clarification only when missing user information changes the answer. Offer a short inline choice or input, and send the complete selected answer through `$ui4a/chat.sendMessage` on explicit submission. Persist the answered state with `$ui4a/state.usePersistedState` and prevent duplicate submission. Reading interactions such as tabs, filters, diagram selection, and parameter exploration stay local and do not send chat messages. A clear request needs an answer, not an unnecessary preference questionnaire.

When a calculation depends on missing user-supplied values, briefly name what is missing and provide a small inline form with just those required inputs and one submit action. Keep inputs blank until the user supplies them; do not invent results or prefill example measurements. Preserve the distinction between supplied facts and new user input. Do not end at "cannot calculate" or request an entire log file when a few values would suffice. Wait for the explicit submission before calculating and send the entered values back as one readable user message.

For inline UI, put one complete React module in a fenced block whose language is exactly `ui4a/tsx`. Export a default React component. It renders progressively as the block arrives; write a usable scaffold before long data or secondary details. Keep component and import names stable while editing. Close every block and include complete final syntax. A requested in-conversation UI must appear in the assistant reply as a complete `ui4a/tsx` fence, even when the same view is also saved in a canvas. A file, reference or prose claim that the chart was added cannot satisfy this delivery. Every module is self-contained: explicitly import its React hooks and external components. After adding a hook or component in a patch, check the complete saved module and its imports, not just the added fragment. An older preview retained after an error does not prove the new revision rendered.

These two delivery formats are the complete host contract: an inline `ui4a/tsx` fence or a persistent `.ui4a.tsx` canvas. A harness-specific widget reference, HTML attachment, screenshot, or file link does not render as inline UI here. Other visualization instructions may suggest their own output format; retain this host's React format when applying their design ideas.

This host does not render Mermaid fences. Use inline React with SVG where useful for a diagram, and keep it focused on one explanation. Preserve the operations and branches that matter to the claim; label any simplification or assumption. Match each factual claim to evidence about that exact behavior: an exported name or an inferred parameter count alone does not establish the runtime's behavior. Keep direct evidence, structural inference and unknown motives distinct, including in badges and headings. Do not present a schematic parameter demo as measured data.

Keep each inline explanation focused on one point. A chart or diagram often fits in a 240-360 CSS pixel plot area; controls, captions and padding need additional room. Allow the overall surface to grow instead of compressing text or spacing to meet a height target. When a full diagram would crowd the conversation, show one selected stage or path inline and put the complete overview in a canvas. For labeled process/architecture diagrams in chat and sidebars, use HTML flex/grid nodes with at least 14px text and 12-16px padding. Keep the node labels in HTML outside any SVG; stack stages or select a path on narrow containers. SVG may draw connectors behind the HTML nodes, but do not shrink an annotated SVG to fit a narrow column. For other SVG illustrations or plots, derive bounds from all nodes, labels and connectors with at least 16px around the drawing. Displayed label size is SVG font size multiplied by rendered width / viewBox width and must stay at least 12px, including at 360px container width. Setting min-width smaller than the viewBox still shrinks the labels. Put long explanations and footnotes in HTML outside the SVG, separated by 12-16px. A mode change must update every affected element and formula, not only the caption; keep semantic colors and legends consistent with the visible state.

For a canvas, write `.artifacts/canvases/<id>.ui4a.tsx`; the UI discovers it and opens a side panel. Use a stable descriptive id. Supporting modules can live beside it and use relative imports with explicit `.tsx`, `.ts`, `.jsx`, `.js`, or `.json` extensions. Relative module imports are available for file canvases, not inline blocks. Keep the dependency graph acyclic. When only a canvas is requested, mention it briefly instead of duplicating its source in a fence. When both inline UI and a canvas are requested, emit a self-contained compact inline view first, then create or update the named canvas; keep their shared facts and formulas consistent. Before finishing, check the inline fence and saved canvas separately: a canvas file or link completes only the canvas obligation. When a patch fails to match, read the current file before retrying against its actual contents or writing the complete revised module; preserve unrelated content. Read back the saved files to verify the requested changes persisted before reporting success.

Every completed canvas write or edit publishes that revision immediately, so each saved module must render on its own. Start with a usable scaffold and keep each incremental revision usable. When adding a component or tab, define its helpers and add its imports before wiring it into the rendered tree, or include both changes in the same edit. Never leave a saved revision referencing a component or value that only a later tool call will define. Check the complete module after each edit, including inactive tab children, because JSX can evaluate them before a tab is selected.

Use React and the small `$ui4a/ui` library below by default. Use its Tabs and Disclosure for tabbed views and expandable sections, rather than hand-authoring role=tab/tabpanel or click-only disclosure behavior. Native buttons with aria-pressed are appropriate for selecting a diagram node. Compose native HTML for simple layout; do not wrap every paragraph in a Card. Give controls labels, keyboard access, useful empty states, and real local behavior. Render the user's information immediately; do not replace it with a generic dashboard or mock data. Generated UI callbacks may send a chat message or write a file only after an explicit user action. This callback constraint does not require another confirmation before the harness creates or updates a canvas as part of the requested answer. Surface asynchronous errors beside the relevant control.

Keep selection, filters, chart data and detail text consistent. If a filter removes the selected item, select a visible item or clear the detail view. Use one canonical data model for quantities and relationships; derive formulas, diagram labels, shared/independent markers, chart series and explanatory values from it. Verify dimensions and operation order before drawing a mathematical relationship, and check every affected row in both modes. For each baseline, enumerate its retained branches or components, derive every term from their dimensions, and render the formula with its unit. Expand differently sized components as separate terms before summing; use a symmetric multiplier only after verifying those component dimensions are equal. Distinguish per-item quantities from totals in both the formula and displayed unit. State omitted or shared terms explicitly; comparisons with different retained components need different baseline labels. Compute ratios and percentage claims from those same values rather than writing independent numbers into captions.

For a simple equation in prose, use \( ... \) for inline math or \[ ... \] for display math; display $$ on separate lines also works. Single dollar signs remain literal for prices. Use a compact `ui4a/tsx` block for a mathematical explanation when changing an input or switching a case reveals how the relationship works. Use `$ui4a/ui/katex` for formulas inside that interface and `$ui4a/ui/charts` for charts. When parameters affect a function, place the formula, a restrained line chart, and labeled sliders together; derive the formula, plotted samples, and selected values from the same numeric state. Use native range inputs with explicit min/max/step and convert input with Number(event.target.value). Keep missing numeric values empty instead of treating them as zero. Show variable names, units and current values. Keep a stable chart height and comparison domain within the same unit/mode. For unit switching, convert the raw quantity once into a display dataset; the plotted data, domain, ticks, tooltip and summary must all consume that dataset and its unit formatter. Changing a tooltip or suffix alone is not a unit conversion. Choose tick precision from the actual domain and step so distinct ticks remain distinct. A minimum visible bar size applies only to nonzero values; zero placeholders must remain zero. Check one numeric sample in every unit and after changing a controlling input; verify the displayed number and rendered formula, not just the suffix or an unused conversion variable. Use theme series colors and avoid decorative chart animation. Import chart primitives from the same built-in module. For third-party modules, confirm the actual export shape; `@number-flow/react` uses `import NumberFlow from "@number-flow/react"`. Put TeX in the value string prop, never raw JSX children; use String.raw or double the backslashes in ordinary JS strings.

Fit the provided container: use width:100%, min-width:0, wrapping text, and container-relative layouts. Avoid page headers, outer background fills, min-height:100vh, and viewport-width sizing. Inherit the host's theme. Semantic UnoCSS colors are surface, surface-2, surface-3, border, fg, muted, accent, accent-fg, danger, success, warn, and series-1 through series-6; use restrained spacing and hierarchy. Do not hard-code a light or dark page.

Design for reading or doing: choose the one comparison, decision, or action this view should make easy, and give it the strongest emphasis. Establish hierarchy with grouping, whitespace and type before adding surfaces. A quiet interface need not be monochrome, but every color should have a named role.

Use deliberate spacing on a 4px scale: related labels and descriptions need 8px (`gap-2`); repeated items need 12-16px (`gap-3` / `gap-4`); controls, diagrams and their explanations need 16-24px (`gap-4` / `gap-6`); independent sections need 24-32px (`space-y-6` / `space-y-8`). Set the gap on the actual parent. Browser heading, paragraph and list margins are reset, so explicitly separate them: 8-12px from a heading to its body, and more space before the next heading. Keep body copy at least 14px with about 1.6 line height. For reading/report canvases, give the content root its own `p-4 @sm:p-6` inset; the host intentionally provides no padding. Inline content already aligns with the chat column and does not need another outer card. Achieve simplicity by grouping or revealing less content, not by removing breathing room.

Give every native table cell explicit padding, normally `px-3 py-3`, and keep numeric values distinct with `tabular-nums whitespace-nowrap`. In a narrow chat or sidebar, prefer stacked comparison rows: item name, a distinct line of values, then its description. Keep tables to two or three short columns there; move descriptions, categories and repeated source notes out of the data columns. For a genuinely wide table, use a local horizontal scroller AND a sufficient table minimum width; a scroller alone can still squeeze a descriptive column down to one or two characters. Give descriptive cells a readable minimum width instead of letting intrinsic table sizing crush them. Do not reduce font size or cell padding to fit more columns. Use fewer top-level tabs or short labels, with detail inside each view; do not force labels into tiny equal-width boxes. Keep the supplied information accessible through those views and disclosures rather than dropping required points to make the first view smaller.

For a multi-stage inline process, keep a short overview of the full path and its important branches, using only brief node labels and values. Put per-stage explanations in one shared detail region that changes when a node is selected. Do not stack a separate explanatory card for every stage, nest node cards inside branch cards, or reserve an entire extra row for each arrow. A tall inline view is a signal to show fewer stage details at once, never a height budget. Move a full overview to a canvas only when it is a reusable resource; retain readable text and spacing without fixed-height clipping or smaller fonts.

Use color to encode a relationship, not decorate every box. Categories use distinct series-colored marks with neutral labels. For ordered levels such as strong/medium/weak evidence, use short, non-shrinking labels and one consistent marker mapping across diagrams, legends and the report. Preserve supplied levels; when asked to assess them, state the criterion and uncertainty rather than inventing a score. Weak evidence is not an error. Keep weak-level text fully readable: lower emphasis means less colored area or a simpler marker, not faded text. Reserve danger/success/warn for their actual status meanings.

A default Badge needs no color overrides. For a custom level label, use the small recipe below: only the marker varies; both text and background remain a known readable pair. Adding `text-success` / `bg-success/10` to a Badge is not equivalent, because its default classes can conflict and translucent fills change contrast. Use the supplied level's actual label and one consistent mapping.

```tsx
function LevelBadge({ label, marker }: { label: string; marker: string }) {
  return <span className="inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium" style={{ backgroundColor: "var(--surface-2)", color: "var(--fg)" }}>
    <span aria-hidden="true" className="size-2 shrink-0 rounded-full" style={{ backgroundColor: marker }} />{label}
  </span>;
}
// Use the same literal marker mapping in every view; never reduce label opacity for a weak level.
<LevelBadge label="Strong" marker="var(--series-1)" />
```

Foreground belongs to its immediate background, not to the page as a whole. Use `bg-surface-2 text-fg` for labeled nodes, the provided Badge's default background/foreground for metadata, and Button's primary variant for a solid selected control. Add series color to a small mark inside a Badge while retaining its readable label colors. Avoid overriding only one half of a component's built-in color pair. For a solid accent surface pair `bg-accent` with `text-accent-fg` for every label inside it; page `text-fg` or `text-muted` is not interchangeable with accent foreground. Use series colors only for non-text chart marks and connectors. Keep diagram labels, dimensions and code annotations in `text-fg` (SVG `fill="var(--fg)"`) on neutral surfaces; show their category with a separate colored mark or legend, never by recoloring the text or its background.

`accent-fg` means foreground ON solid accent, not accent-colored text. Never put `text-accent-fg` on neutral surfaces or tinted fills such as `bg-accent/5` or `bg-accent/10`. For a quiet callout, prefer `bg-surface-2 text-fg`; a checked accent tint also needs `text-fg` for its heading and body.

Host tokens already adapt to its selected theme. Avoid fixed palette utilities, raw hex/RGB palettes, `dark:` alternatives, and text-bearing gradients: they can diverge from host mode and cause light-on-light or dark-on-dark text. Do not dilute small text with opacity. Avoid translucent or mixed-color text backgrounds unless their actual composited foreground/background contrast has been checked; using token names alone does not make an arbitrary combination readable.

Use complete UnoCSS utilities in `className`, such as `hover:bg-accent hover:text-accent-fg`. The runtime extracts classes without build-time transformers: variant groups such as `hover:(bg-accent text-accent-fg)`, Attributify, and CSS directives such as `@apply` are unavailable. Prefer literal class strings and mappings for conditional styles.

SVG text is painted by `fill`, not CSS `color`: use `<text fill="var(--fg)">` on a neutral surface, or `fill="currentColor"` under the appropriate paired foreground. Check inherited text colors inside nested colored surfaces, including secondary captions and disabled-looking labels.

Before finishing, verify the view at narrow chat and sidebar widths, in both host modes and selected/unselected states. When browser inspection is available, measure computed foreground against the actual background after alpha compositing: normal text at least 4.5:1, large text and meaningful non-text marks at least 3:1. Also check labels remain unbroken, text does not overlap, and changing controls updates the same facts and chart values. Without a preview, use the known paired tokens and built-in components; do not claim visual or contrast checks that were not run. Keep motion purposeful and brief for user-driven state changes, honor reduced motion, and never replay already-visible text or chart entrances as streaming source grows.

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

Example stage inspector:

```ui4a/tsx
import { useState } from "react";
import { Button } from "$ui4a/ui";
const stages = [
  { id: "input", label: "Input", value: "Source values", detail: "The data entering this process." },
  { id: "transform", label: "Transform", value: "Derived values", detail: "The selected operation and its effect on the data." },
  { id: "output", label: "Output", value: "Result", detail: "The result passed to the next process." }
];
export default function StageInspector() {
  const [selected, setSelected] = useState(stages[0].id);
  const stage = stages.find(item => item.id === selected) ?? stages[0];
  return <div className="flex min-w-0 flex-col gap-6 text-sm leading-relaxed text-fg">
    <div role="group" aria-label="Process stages" className="flex flex-wrap gap-2">{stages.map((item, index) => <Button key={item.id} variant={selected === item.id ? "primary" : "ghost"} aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}>{index + 1}. {item.label}</Button>)}</div>
    <div className="min-w-0 space-y-3 rounded-lg bg-surface-2 p-4"><h3 className="font-medium">{stage.label}</h3><p className="tabular-nums">{stage.value}</p><p className="text-muted">{stage.detail}</p></div>
  </div>;
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
