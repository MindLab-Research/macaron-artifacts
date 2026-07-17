import type { Block, Message, SessionDetail } from './types.js';

// Serialize a parsed session transcript to a single clean Markdown document —
// the same `Message[]` the WebUI already holds, rendered for pasting into a
// PR, issue or doc. Pure and side-effect free: no DOM, no I/O, never throws.
// OpenCode's `/export` is the reference behavior.

function slugTitle(text: string, max = 60): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= max) return oneLine;
  return oneLine.slice(0, max).trimEnd() + '…';
}

// Pick a fence long enough that nothing inside can break out of it. CommonMark
// lets an opening fence be closed only by a run of >= as many backticks, so we
// use one more than the longest run present in the body.
function fenceFor(body: string): string {
  let longest = 0;
  for (const m of body.matchAll(/`+/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(Math.max(3, longest + 1));
}

function codeFence(body: string, lang = ''): string {
  const fence = fenceFor(body);
  return `${fence}${lang}\n${body.replace(/\n+$/, '')}\n${fence}`;
}

// A one-line hint for the tool-call header, e.g. `Read · foo.ts` or
// `Bash · npm run build`. Falls back to nothing when no obvious field fits.
function toolHint(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const o = input as Record<string, unknown>;
  const key = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'].find(
    (k) => typeof o[k] === 'string' && o[k],
  );
  if (!key) return '';
  return slugTitle(String(o[key]), 72);
}

function toolInputJson(input: unknown): string {
  // JSON.stringify(undefined) returns the JS value `undefined` (not a string),
  // which then blows up fenceFor's `.matchAll` and aborts the whole export — an
  // absent `input` is real (a partial write during a streaming or aborted tool
  // call). Coerce every non-string result so the "never throws" contract holds.
  if (input === undefined) return '';
  try {
    const json = JSON.stringify(input, null, 2);
    return typeof json === 'string' ? json : String(input);
  } catch {
    return String(input);
  }
}

// Escape the three characters that would otherwise be parsed as raw HTML when
// interpolated into an HTML context (a <summary>, a heading) or a Markdown
// inline-HTML span (a blockquote). Untrusted tool names/hints, the title and
// system-event text must not silently corrupt the exported doc — a faithful
// paste into a PR/issue is the whole point of the export.
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A literal </details> or </summary> inside Markdown-rendered content (thinking
// text) would close the disclosure block wrapping it. Insert a zero-width space
// after the "<" so the token no longer parses as a closing tag while staying
// visually identical — thinking is otherwise kept as Markdown so its formatting
// survives.
function neutralizeClosers(text: string): string {
  return text.replace(/<(\/(?:details|summary)>)/gi, '<\u200b$1');
}

// tool_use + its paired tool_result render as one collapsed <details>.
function renderToolUse(
  block: Extract<Block, { kind: 'tool_use' }>,
  result: string | undefined,
): string {
  const hint = toolHint(block.input);
  const summary = `🔧 ${escapeHtml(block.name)}${hint ? ` · ${escapeHtml(hint)}` : ''}`;
  const parts = [`<details>`, `<summary>${summary}</summary>`, ''];
  parts.push('**Input**', '', codeFence(toolInputJson(block.input), 'json'), '');
  if (result != null && result.trim()) parts.push('**Result**', '', codeFence(result), '');
  parts.push(`</details>`);
  return parts.join('\n');
}

function renderMessage(m: Message, resultByToolId: Map<string, string>): string {
  // Collect each block as a self-contained chunk and join with a single blank
  // line. We must NOT run a global `\n{3,}` collapse over the assembled body:
  // it would reach inside the code fences (tool input JSON, tool results) and
  // silently rewrite blank lines that are the user's verbatim content — git
  // diffs, logs, PEP8 double-blanks. Trimming each chunk's outer edges and
  // joining with `\n\n` keeps block separation tidy without touching any
  // fenced interior. (Extra blank runs inside prose render identically anyway.)
  const chunks: string[] = [];
  const push = (s: string) => {
    const t = s.trim();
    if (t) chunks.push(t);
  };
  for (const b of m.blocks) {
    switch (b.kind) {
      case 'text':
        push(b.text);
        break;
      case 'thinking':
        if (b.text.trim())
          push(`<details>\n<summary>💭 Thinking</summary>\n\n${neutralizeClosers(b.text.trim())}\n</details>`);
        break;
      case 'tool_use':
        push(renderToolUse(b, resultByToolId.get(b.id)));
        break;
      case 'tool_result':
        // Only surface results not already merged into their tool_use above
        // (unpaired results are rare but keep them rather than drop context).
        if ((!b.toolUseId || !resultByToolId.has(b.toolUseId)) && b.text.trim())
          push(`<details>\n<summary>🔧 Tool result</summary>\n\n${codeFence(b.text)}\n</details>`);
        break;
      case 'image':
        // b.data is base64 (~4 chars per 3 bytes); report the decoded size.
        push(`_[image: ${b.mimeType}, ${Math.round((b.data.length * 3) / 4 / 1024)} KB]_`);
        break;
      case 'system_event':
        push(`> ※ ${escapeHtml(b.text.replace(/\n/g, ' ').trim())}`);
        break;
    }
  }
  const body = chunks.join('\n\n');
  // A message whose only blocks were tool_results already merged upstream
  // renders empty — skip it (and its role header) rather than emit a bare
  // "### User" with nothing under it.
  if (!body) return '';
  const header = m.role === 'user' ? '### 🧑 User' : m.role === 'assistant' ? '### 🤖 Assistant' : '';
  return (header ? header + '\n\n' : '') + body;
}

export function sessionToMarkdown(detail: SessionDetail): string {
  // Pre-index every tool_result by the tool_use it answers so each call and
  // its output render together (mirrors the WebUI's paired rendering). Only
  // pair a result to a tool_use that actually exists — a rare orphan result
  // (no matching call) still renders standalone rather than vanishing.
  const toolUseIds = new Set<string>();
  for (const m of detail.messages)
    for (const b of m.blocks) if (b.kind === 'tool_use') toolUseIds.add(b.id);
  const resultByToolId = new Map<string, string>();
  for (const m of detail.messages)
    for (const b of m.blocks)
      if (b.kind === 'tool_result' && b.toolUseId && toolUseIds.has(b.toolUseId) && !resultByToolId.has(b.toolUseId))
        resultByToolId.set(b.toolUseId, b.text);

  const firstUserText =
    detail.messages
      .find((m) => m.role === 'user' && m.blocks.some((b) => b.kind === 'text' && b.text.trim()))
      ?.blocks.find((b): b is Extract<Block, { kind: 'text' }> => b.kind === 'text' && !!b.text.trim())
      ?.text ?? '';
  const model = detail.messages.find((m) => m.model)?.model;

  const title = firstUserText ? slugTitle(firstUserText) : `Session ${detail.sessionId.slice(0, 8)}`;
  const meta = [
    `\`${detail.sessionId}\``,
    detail.cwd ? `**cwd** \`${detail.cwd}\`` : '',
    detail.gitBranch ? `**branch** \`${detail.gitBranch}\`` : '',
    model ? `**model** \`${model}\`` : '',
  ].filter(Boolean);

  const head = [
    `# ${escapeHtml(title)}`,
    '',
    `> ${meta.join(' · ')}`,
    `> Exported from macaron · ${detail.messages.length} messages${detail.truncated ? ' · _transcript truncated (older messages omitted)_' : ''}`,
    '',
    '---',
    '',
  ];

  const body = detail.messages
    .map((m) => renderMessage(m, resultByToolId))
    .filter((s) => s.trim())
    .join('\n\n');

  return head.join('\n') + body + '\n';
}
