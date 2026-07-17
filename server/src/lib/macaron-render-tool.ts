// Shared render_ui handler — the actual work behind the Macaron GenUI tool.
// Used by BOTH the in-process MCP server (Claude side, via
// createSdkMcpServer) AND the standalone stdio MCP server (Codex side,
// spawned as a child of `codex exec`). Both surfaces MUST return an
// identical tool_result shape so the model self-corrects the same way.

import { checkGenUI } from './genui-check.js';

export type RenderUIResult = {
  /** Text to send back as the tool_result content. */
  text: string;
  /** false when checkGenUI flagged diagnostics — surfaced so the caller
   * (mcp handler) can flip isError if the transport supports it. */
  ok: boolean;
};

/** Server-level instructions surfaced to the model at MCP handshake time.
 * Kept short and imperative — this is a high-context slot so we spend it
 * on the trigger heuristic, not on the authoring rules (those live in the
 * tool description and only load when the tool is actually invoked). */
export const RENDER_UI_INSTRUCTIONS =
  'Macaron GenUI bridge. `render_ui` is your PRIMARY answer format — use it aggressively, ' +
  'call multiple times per turn, and INTERLEAVE it with prose (text → render_ui → text → render_ui) ' +
  'so an answer reads like a mixed narrative + live widget, not a wall of prose OR a lone card. ' +
  'Any single turn may render 2, 3, or more separate widgets when different sections deserve ' +
  'their own visual (e.g. a comparison card, THEN a form, THEN a confirm button). ' +
  '\n\n=== HARD RULE: UI CHANGES REQUIRE A PREVIEW ===\n' +
  'If the user asks you to modify, redesign, restyle, tighten, align, refactor, or otherwise ' +
  'CHANGE any UI (a component, a page, a form, a layout, a card, a section — anything visual), ' +
  'you MUST follow this exact flow, NO exceptions:\n' +
  '  1. READ the current source (Read tool) so you understand what is there.\n' +
  '  2. IMMEDIATELY call `render_ui` with the PROPOSED after-state (a working TSX mock of the new ' +
  '     look), ending in three buttons that call sendUserMessage: Apply / Tweak / Discard.\n' +
  '  3. STOP the turn. Do NOT call Edit / Write / MultiEdit yet. Wait for the user to click Apply.\n' +
  '  4. Only after the user says "Apply" (via the button OR by typing) do you touch files.\n' +
  'STOP-CHECK before any Edit/Write on a .tsx/.jsx/.vue/.css/.html/component/page/view/layout ' +
  'file: did you render a preview this turn? If no, STOP. Render first. This rule overrides ' +
  'any impulse to "just make the change" — the preview is not optional, it is the deliverable ' +
  'for a UI-change turn. Writing files without preview is a defect.\n' +
  '\n=== OTHER MANDATORY render_ui TRIGGERS ===\n' +
  '  (ASK) Any turn that ends with the user needing to answer. AskUserQuestion is DISABLED here and ' +
  '  text-only "reply 1/2/3" is equally forbidden — buttons / form / slider that call sendUserMessage.\n' +
  '  (CHOICE) Two or more options for the user to pick between — clickable buttons, always. When ' +
  '  each option has a visual counterpart (layout, theme, chart style, template), use options-left / ' +
  '  preview-right so picking one previews it.\n' +
  '  (COMPARE) Two or more items with attributes — Card / Table / StatGrid, not a Markdown table.\n' +
  '  (DATA) The user shared JSON / CSV / a list of records / a config — visualize it.\n' +
  '  (FORM) Structured input needed — Input / Switch / Slider / Select in a Card.\n' +
  '  (STATUS) Snapshot of state (build, PR, tests, TODOs, service health) — StatGrid / Timeline.\n' +
  '  (NEXT) "You could do X, Y, or Z" — each an actionable Button that fires sendUserMessage.\n' +
  '  (CONFIRM) Before a destructive action — diff summary card + Apply / Cancel buttons.\n' +
  '  (RESEARCH) Multi-section research / comparison / metrics breakdown — render a report card ' +
  '  (titled sections + Stats + Table), not a long Markdown wall.\n' +
  '\nRules: NEVER put TSX in ```tsx fences. NEVER explain code before calling — call first, ' +
  'then the surrounding prose acknowledges + threads the widgets together. Prefer multiple small ' +
  'widgets to one big monolithic card. Write UI copy + the surrounding ack in the user\'s own ' +
  'language. Only stay in pure text for: single-line factual answers, pure prose explanations ' +
  'with no structure at all, a yes/no confirmation, error/failure traces, and code you were ' +
  'asked to write to a FILE (WHEN A PREVIEW WAS ALREADY APPROVED). When in doubt, render.';

export async function handleRenderUI(code: string): Promise<RenderUIResult> {
  const result = await checkGenUI(code);
  const text = result.ok
    ? 'Rendered inline. The user sees the UI now.'
    : `Rendered inline, but the TSX has issues:\n${result.diagnostics}`;
  return { text, ok: result.ok };
}

/** Tool description mirrored on both sides so the model gets the same
 * authoring rules regardless of which engine it's running under. Kept in
 * sync with macaron-mcp.ts's in-process tool description. */
export const RENDER_UI_TOOL_DESCRIPTION = `Render an interactive TSX UI inline in the assistant message. \`code\` is a COMPLETE TSX module the host immediately mounts via React.

# MUST call render_ui — not describe, not fence — when

**Explicit visual asks** (obvious):
- dashboard, panel, card, widget, badge, chart, graph, plot, table, timeline, calendar, gallery, grid
- login / signup / settings / profile / pricing / checkout / onboarding page or form
- comparison, leaderboard, roadmap, status report, changelog, KPIs, metrics
- interactive demo, mini editor, playground, animation, toy component
- "draw X", "show me X", "make X", "design X", "prototype X", "generate a X"

**Structural fit** — call render_ui even when the user did NOT ask visually, if your answer would contain any of:
- **Choice**: 2+ options the user needs to pick from → render clickable buttons that call \`sendUserMessage\` with the chosen option. (You would otherwise write "Options: 1. A  2. B  3. C, which do you want?" — that's a bad answer; render buttons instead.)
- **Comparison / summary of records**: 2+ items with attributes ("here are 3 approaches, tradeoffs are…") → render a Table or side-by-side Cards, not a Markdown table.
- **Structured data the user shared**: array of objects, JSON, CSV, config, records → visualize as a UI, not a bulleted breakdown.
- **Status / dashboard / snapshot**: build result, PR checks, service health, TODO progress, session state → render Stats/StatGrid/Timeline.
- **Form / wizard / configurator**: any answer that would say "tell me the following: name, ..., ..." → render Inputs the user submits back via sendUserMessage.
- **Actionable next steps**: "you could do X, Y, or Z" where each step is something the user might click to trigger → render each as a Button that fires sendUserMessage.
- **You are asking the user**: your turn ends in a question with **3+ discrete options, or 2+ fields to fill** → render a form the user submits via \`sendUserMessage\` instead of asking in prose. When each option has a visual counterpart (layout / theme / chart type / template), use an **options-left, preview-right** layout (e.g. a \`Row\` of a choice list + a live preview pane) so selecting an option shows what it looks like. A yes/no or any other **binary confirmation** stays as text — don't render a form for it.
- **Report-style answer**: the user asked a question whose answer is **structured research or data findings** — multi-section analysis, comparison of records, metrics/breakdown ("research …", "compare …", "summarize this data") → render it as a report — a titled \`Card\`/\`Stack\` with sections, Stats/StatGrid for numbers, Tables for records — instead of a long Markdown wall. This does NOT cover code/debug explanation: a code walkthrough, error/failure analysis, or debugging trace stays as plain text even when it runs long (see MUST NOT). A short factual answer that fits in a sentence or two also stays as plain text.

If a Markdown table, numbered list of ≥3 things, or "reply with your choice" would be in your answer — you're describing what render_ui is for. Render it instead.

# MUST NOT

- **NEVER** put TSX inside a markdown code fence in your assistant text.  \`\`\`tsx / \`\`\`jsx code blocks are a failed answer — the user came here for a rendered component, not source to copy-paste.
- **NEVER** explain the component structure before calling. Call first, ack in one sentence after.
- **NEVER** call render_ui for:
  - Pure prose explanations, code walkthroughs, debugging traces, error/failure analysis, single-sentence Q&A — these stay text even when multi-section; they are NOT "reports" in the sense above (that trigger is only for structured research / data findings).
  - Code you are asked to write to a FILE (use Edit/Write, not render_ui)
  - Simple confirmations ("done", "here's the file path", "the tests pass") and any yes/no or binary confirmation question
  - Answers that fit in one line of text

# Imports — exact rules

- Import all UI primitives from \`$macaron/ui\` in ONE combined import: \`import { Stack, Row, Card, Button, Badge, Text, Tabs, TabsList, TabsTrigger, TabsContent, NumberFlow, motion, AnimatePresence /* etc */ } from '$macaron/ui';\`
- For charts: \`import { ChartContainer, ChartTooltip, ChartTooltipContent, AreaChart, Area, BarChart, Bar, LineChart, Line, CartesianGrid, XAxis, YAxis, PieChart, Pie } from '$macaron/ui/charts';\` (never import 'recharts' directly)
- Icons: \`import { Plus, Minus, ChevronDown, CheckCircle2, /* … */ } from 'lucide-react';\`
- React: \`import { useState, useEffect, useRef } from 'react';\`
- No relative imports, no other bare packages, no markdown fences, no JSON wrapping.

# Available $macaron/ui components (use these instead of raw div/span when possible)

Layout: Stack, Row, Grid, Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter, Surface, FeatureCard, Field, Separator
Text: Text, TextShimmer, TextMorph, TextLoop, SpinningText
Controls: Button, Badge, Checkbox, Switch, Slider, Input, Textarea, Select+SelectTrigger+SelectValue+SelectContent+SelectItem, RadioGroup+RadioGroupItem, Label, Calendar, InputOTP
Surfaces: Tabs+TabsList+TabsTrigger+TabsContent, Accordion, Popover, MorphingDialog, Disclosure
Lists/data: Table, Carousel, Sortable, Timeline
Stats: Stat, StatGrid, PillRow, NumberFlow
Media/decor: Avatar+AvatarImage+AvatarFallback, Tilt, GlowEffect, ProgressiveBlur, motion, AnimatePresence

# Quality rules

- One default export (\`export default function App()\`), no extra files, no fetch/network
- Use UnoCSS Tailwind v3 utility classes via className
- Every mapped list needs stable \`key\` from data (id/slug); never \`key={i}\`
- Keep helper components at module scope, not inside App
- No \`as any\` casts in JSX
- Write all visible UI copy (labels, headings, button text) in the user's own language, not English by default

# Sending messages back to chat (interactive widgets)

- **Always import** from \`$macaron/chat\`: \`import { sendUserMessage } from '$macaron/chat';\`. Never call \`window.sendUserMessage(...)\`, \`globalThis.sendUserMessage(...)\`, or any other global lookup — the type checker will complain and reviewers will ask you to change it, even though it happens to run at runtime.
- \`sendUserMessage(prompt)\` takes a single string and posts it to the chat as if the user typed it, driving the next assistant turn. Use it when a widget action should continue the conversation: form submits, choice confirmations, apply/regenerate buttons, wizard steps.
- \`prompt\` is the message the next turn receives — write it as the user would (e.g. "Book the 3pm slot"); fold any structured context the next turn needs directly into that string.
- **Preview must equal Apply.** When a widget is an "options-left, preview-right" picker where each option maps to concrete code you'll write in a follow-up turn (fonts, themes, layouts, palettes, copy), the preview shown for a selected option MUST use the *exact* CSS / class / prop values you will later apply. If \`Monospace\` sets \`font-family: "JetBrains Mono", ...; font-weight: 500\`, the preview swatch for it must use those same values — not a stylized "hero" version with bolder weight, extra letter-spacing, decorative subtitle, etc. And the prompt string you send via \`sendUserMessage\` on Apply must carry the full CSS block, not just the option name, so the follow-up turn writes byte-identical code to disk.
- **Mirror the real component, not a mockup.** When previewing a change to an **existing UI** (logo area, sidebar, tile, header — anything the user is currently looking at), you MUST first Read the target component source file so the preview reproduces its actual markup and assets, not a placeholder. Reuse the real image paths (\`<img src="/mindlab-symbol.svg" />\`, not a fake "M" square), the real copy ("Macaron Artifacts / Presented by Mind Lab", not "Sample Brand"), the real container (padding, border-radius, background), and the real neighboring elements around the swapped property. Only the property under change (the font, the color, the layout) varies between option swatches; everything else is byte-copied from the current component. A preview that "looks like the general idea" is a failed answer — the user is choosing a change they will see land verbatim in their app, and a mocked-up placeholder makes the choice meaningless.
- Call it ONLY from event handlers or effects, never during render, and at most once per user gesture. For a purely display-only UI, don't call it.

# After the call

The host already shows the rendered UI to the user. Your follow-up reply is at most ONE sentence acknowledging what was rendered (e.g. "Here's the dashboard."). Do not paste the code, do not describe the layout, do not offer variations unless the user asks.`;
