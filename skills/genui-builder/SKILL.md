---
name: genui-builder
description: Build streaming GenUI-capable TSX/HTML artifacts for Macaron previews. Use when the user asks an agent to create a GenUI UI, GenUI-enabled HTML, standalone renderable HTML from TSX, a visual TSX preview that should run through Macaron GenUI, a browser runtime that displays model-generated UI while tokens stream, or wants to validate/live-preview GenUI output with the @genui/cli package.
---

# GenUI Builder

Use this skill to produce streaming GenUI `App.tsx`/HTML artifacts. Default to streaming model output and incremental preview refresh; do not build one-shot "wait for full TSX, then render" experiences unless the user explicitly asks for non-streaming output.

## Preferred path: `render_ui` MCP tool

If the `mcp__macaron.render_ui` tool is exposed to you, call it directly with the complete TSX module in its `code` field — the host mounts the component inline in the conversation. The tool's own description already carries the authoring rules for `$macaron/ui`, streaming write order, and quality constraints. Do NOT curl anything or emit markdown TSX fences when this tool is available.

## Local authoring rules (fallback)

If `render_ui` is not exposed (older host or a bare CLI), fall back to writing a self-contained TSX module and use the CLI below to validate or render it. Detailed constraints and common fixes are in `references/tsx-output.md`.

Optionally, if the runtime allows network egress, you MAY fetch the canonical live authoring prompt for cross-check — but only if you already have a specific ambiguity to resolve. Do NOT fetch it prophylactically before every render:

```bash
curl -fsSL https://genui.macaron.im/api/system-prompt
```

If that command errors (DNS blocked, no network, non-2xx), silently proceed with the local rules — do not surface the failure to the user.

## CLI

The CLI is optional. Prefer direct streaming runtimes when the user wants an HTML harness or GenUI capability inside a page. Use the CLI for validation, standalone one-shot export, or when the user explicitly asks for the CLI.

Use this exact pinned command unless the user provides a newer one:

```bash
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767
```

The CLI supports:

```bash
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 lint App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 check App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 build App.tsx -o index.html
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 dev App.tsx -p 4173 --host 127.0.0.1
```

Before relying on the CLI, check that Bun/Bunx is available:

```bash
command -v bunx || command -v bun
```

If Bun is missing, still create `App.tsx` and explain that CLI validation/build could not run.

## Streaming Policy

Streaming is mandatory by default.

- Set OpenAI-compatible requests with `stream: true`.
- Read SSE `data:` chunks incrementally.
- Append each `choices[0].delta.content` or tool-call argument delta into the current TSX buffer.
- Update the visible code buffer immediately as tokens arrive.
- Refresh the preview during the stream, not only after `[DONE]`.
- Use `partial-react` / `GenUIRenderer.pushCode(...)` when available.
- If `partial-react` is unavailable, use `partial-tsx` / `normalizeGeneratedTsx(...)` to complete prefix-growing TSX before compiling snapshots.
- Keep the last good rendered UI visible while a new partial frame fails to compile.
- Do a final complete render when the stream finishes.
- If an upstream proxy is used, it must pass through `text/event-stream` without buffering. Include `Cache-Control: no-store, no-transform` and avoid `await response.text()` / `arrayBuffer()` before returning to the browser.

Non-streaming is acceptable only for static file export, offline examples, or explicit user direction.

## Workflow

1. Clarify the target artifact: `App.tsx` only, standalone `index.html`, or a small project folder containing both.
2. Fetch the live GenUI system prompt and scan for current constraints.
3. For model-backed generation, implement streaming first: SSE request, incremental code buffer, partial TSX completion, preview refresh, final render.
4. Write a single self-contained `App.tsx` with `default export function App` when creating a TSX artifact.
5. Keep imports GenUI-compatible; prefer local primitives from `$macaron/ui` and chart primitives from `$macaron/ui/charts`.
6. Validate:
   - Run `lint App.tsx`.
   - Run `check App.tsx` when available.
   - Run `build App.tsx -o index.html` when the user asked for HTML.
7. If validation fails, fix the TSX and rerun the failed command.
8. For interactive review, start a local server and give the local URL.

## Output Rules

- Treat a GenUI HTML runtime as incomplete if it only renders after the whole model response finishes.
- Do not paste GenUI TSX in chat as a substitute for creating files when the user asked for an artifact.
- Do not create extra scaffolding unless the user asked for a project; a single `App.tsx` plus generated HTML is usually enough.
- Do not add external runtime data fetching; use provided data, local constants, or clearly marked sample content.
- Keep every visible control functional. Remove inert buttons, switches, tabs, and menu items.
- Use stable keys from data IDs/slugs, never array indexes.
- Prefer compact, embeddable surfaces. GenUI output is hosted inside another product surface, not a full website shell.

## Streaming HTML Pattern

For browser HTML harnesses, implement this shape:

```js
const response = await fetch('/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ model, stream: true, messages }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let tsx = '';

for (;;) {
  const { done, value } = await reader.read();
  buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
  const events = buffer.split(/\r?\n\r?\n/);
  buffer = events.pop() || '';
  for (const event of events) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trimStart()).join('\n').trim();
    if (!data || data === '[DONE]') continue;
    const payload = JSON.parse(data);
    tsx += payload.choices?.[0]?.delta?.content ?? '';
    updateCodePane(tsx);
    renderPartialTsx(tsx);
  }
  if (done) break;
}
renderFinalTsx(tsx);
```

Use `partial-react` when it can be imported:

```js
const renderer = await GenUIRenderer.create(root, { preserveStateOnUpdate: true, flushMode: 'immediate' });
renderer.pushCode(delta);
renderer.finish(finalCode);
```

Fallback snapshot rendering:

```js
import { normalizeGeneratedTsx } from 'https://esm.sh/partial-tsx@0.0.1?dev';

const source = normalizeGeneratedTsx(partialTsx);
// Compile `source`, but keep the visible editor showing the raw streamed TSX.
```

## Common Deliverables

For a standalone HTML request:

```bash
mkdir -p genui-output
$EDITOR genui-output/App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 lint genui-output/App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 check genui-output/App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 build genui-output/App.tsx -o genui-output/index.html
```

For an agent-facing TSX artifact:

```bash
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 lint App.tsx
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 check App.tsx
```

For live preview:

```bash
bunx genui@https://pkg.pr.new/MindLab-Research/macaron-genui-demo/@genui/cli@00b6767 dev App.tsx -p 4173 --host 127.0.0.1
```

For a model-backed HTML runtime, do not use the CLI as the default. Build a page that streams model output into a GenUI renderer and verify during generation that the code pane grows before the final response completes.
