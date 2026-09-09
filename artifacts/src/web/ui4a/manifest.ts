export const ui4aModules = {
  "$ui4a/ui": {
    Button: 'Native button props, variant?: "primary" | "secondary" | "ghost" | "danger", size?: "sm" | "md".',
    Field: "Native input props plus label: string and hint?: string. Includes an associated accessible label.",
    Card: "Native div props. A restrained bordered surface; use only when content needs a boundary.",
    Badge: "Native span props. Compact secondary status or metadata.",
    Tabs: "{ items: { id: string, label: ReactNode, children: ReactNode }[], value?: string, onChange?: (id: string) => void }.",
    Disclosure: "{ title: ReactNode, children: ReactNode, defaultOpen?: boolean }. Accessible expandable content; child state survives collapsing.",
  },
  "$ui4a/chat": { sendMessage: "(text: string) => void. Starts a visible user turn in this session. Call only from an explicit user action." },
  "$ui4a/state": { usePersistedState: "<T>(key: string, initial: T | (() => T)) => [T, Dispatch<SetStateAction<T>>]. JSON state isolated by session and surface, restored after remount/reload. Functional updates work." },
  "$ui4a/fs": {
    readFile: "(path: string) => Promise<string>. Reads UTF-8 text from a workspace-relative .artifacts/ path; rejects unavailable files.",
    writeFile: "(path: string, content: string) => Promise<void>. Writes UTF-8 text inside .artifacts/. Maximum file size is 2 MB. Show pending/success/error feedback.",
  },
} as const;

export function getUi4aSkill(): string {
  const modules = Object.entries(ui4aModules).map(([name, exports]) => `### ${name}\n\n${Object.entries(exports).map(([key, description]) => `- \`${key}\`: ${description}`).join("\n")}`).join("\n\n");
  return `---
name: ui4a
description: Build compact interactive React UI inside chat or a persistent canvas when interaction makes the response more useful.
---

<!-- Generated from src/web/ui4a/manifest.ts; update that manifest when changing the runtime contract. -->

Use ordinary prose for an answer that needs no interaction. Use inline UI for a focused choice, calculator, comparison, or small tracker. Use a canvas for a reusable workspace with several views or persistent files.

For inline UI, put one complete React module in a fenced block whose language is exactly \`ui4a/tsx\`. Export a default React component. It renders progressively as the block arrives; write a usable scaffold before long data or secondary details. Keep component and import names stable while editing. Close every block and include complete final syntax.

For a canvas, write \`.artifacts/canvases/<id>.ui4a.tsx\`; the UI discovers it and opens a side panel. Use a stable descriptive id. Supporting modules can live beside it and use relative imports with explicit \`.tsx\`, \`.ts\`, \`.jsx\`, \`.js\`, or \`.json\` extensions. Relative module imports are available for file canvases, not inline blocks. Keep the dependency graph acyclic. Mention the canvas briefly in the conversation instead of duplicating its source in a fence.

Use React and the small \`$ui4a/ui\` library below by default. Compose native HTML for simple layout; do not wrap every paragraph in a Card. Give controls labels, keyboard access, useful empty states, and real local behavior. Render the user's information immediately; do not replace it with a generic dashboard or mock data. Only send a chat message or write a file after an explicit user action. Surface asynchronous errors beside the relevant control.

Fit the provided container: use width:100%, min-width:0, wrapping text, and container-relative layouts. Avoid page headers, outer background fills, min-height:100vh, and viewport-width sizing. Inherit the host's theme. Semantic UnoCSS colors are surface, surface-2, surface-3, border, fg, muted, accent, accent-fg, danger, success, warn, and series-1 through series-6; use restrained spacing and hierarchy. Do not hard-code a light or dark page.

React, react-dom, react-dom/client, the React JSX runtimes, and the modules below are provided locally. Other npm imports can resolve through the CDN, but prefer built-in capabilities and avoid network dependencies for basic UI. Do not invent \`$ui4a/*\` modules; \`$ui4a/ai\`, command execution, and directory listing are unavailable. Persist only JSON-compatible state; do not store credentials. File read/write paths start with \`.artifacts/\` and are relative to this session's workspace.

${modules}

Example inline module:

\`\`\`ui4a/tsx
import { Button } from "$ui4a/ui";
import { usePersistedState } from "$ui4a/state";
export default function Counter() {
  const [count, setCount] = usePersistedState("count", 0);
  return <div className="flex items-center gap-3"><span>{count} completed</span><Button onClick={() => setCount(n => n + 1)}>Complete one</Button></div>;
}
\`\`\`
`;
}
