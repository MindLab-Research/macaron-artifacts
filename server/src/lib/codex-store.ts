// Read + parse Codex rollout files under ~/.codex/sessions/YYYY/MM/DD/
// into our shared Session/Message shape so the WebUI can render Codex
// conversations with the exact same components used for Claude.
//
// Rollout format (one JSON object per line):
//   { timestamp, type, payload }
// where type ∈ { session_meta, turn_context, response_item, event_msg }
// and payload's own `type` further discriminates the item.
//
// We prefer the higher-level `event_msg` events for text/reasoning (they
// carry the fully-rendered assistant text) and use `response_item` only
// for tool calls (function_call + function_call_output). Duplicates are
// deduped by id so the transcript reads once end-to-end.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Block, Message, SessionDetail, SessionListItem } from '@macaron/shared';
import { CODEX_SESSIONS } from '../config.js';
import { deleteCodexTitle, getCodexTitle } from './codex-titles.js';
import { getLabels } from './label-store.js';

type CodexMeta = {
  id: string;
  cwd: string;
  gitBranch?: string;
  timestamp?: string;
  model?: string;
  cliVersion?: string;
};

type SummaryCache = {
  mtimeMs: number;
  size: number;
  meta: CodexMeta;
  firstUserText: string;
  approxMessages: number;
};

const summaryCache = new Map<string, SummaryCache>();

function isRolloutFile(name: string): boolean {
  return name.startsWith('rollout-') && name.endsWith('.jsonl');
}

// Read the file head — enough for session_meta + turn_context + the first
// couple of user_message events. Codex 0.115 bakes a ~16KB base_instructions
// personality prompt into the session_meta line, so 32KB was too small
// (first user_message ended up on line 7, past our head). Bumped to 256KB;
// still cheap since results are cached by (mtime, size).
async function readSummary(filePath: string, mtimeMs: number, size: number): Promise<SummaryCache | null> {
  const cached = summaryCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs && cached.size === size) return cached;

  const fh = await fs.open(filePath, 'r').catch(() => null);
  if (!fh) return null;
  try {
    const cap = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(cap);
    await fh.read(buf, 0, cap, 0);
    const text = buf.toString('utf8');
    let meta: CodexMeta | null = null;
    let firstUserText = '';
    let approxMessages = 0;
    // Line-by-line — the last line may be partial (we're reading only the
    // head), so drop the tail if it doesn't end in \n.
    const lines = text.split('\n');
    const upto = size > cap ? lines.length - 1 : lines.length;
    for (let i = 0; i < upto; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let o: { type?: string; payload?: unknown };
      try { o = JSON.parse(line); } catch { continue; }
      const p = (o.payload || {}) as Record<string, unknown>;
      if (o.type === 'session_meta' && !meta) {
        meta = {
          id: String(p.id || ''),
          cwd: String(p.cwd || ''),
          gitBranch: typeof (p.git as { branch?: string })?.branch === 'string'
            ? (p.git as { branch: string }).branch
            : undefined,
          timestamp: typeof p.timestamp === 'string' ? p.timestamp : undefined,
          model: typeof p.model === 'string' ? p.model : undefined,
          cliVersion: typeof p.cli_version === 'string' ? p.cli_version : undefined,
        };
      }
      if (o.type === 'event_msg') {
        const t = (p.type as string) || '';
        if (t === 'user_message' && !firstUserText) {
          const msg = String((p as { message?: string }).message || '').trim();
          if (msg && !msg.startsWith('<')) firstUserText = msg;
        }
        if (t === 'user_message' || t === 'agent_message') approxMessages++;
      }
    }
    if (!meta) return null;
    const entry: SummaryCache = { mtimeMs, size, meta, firstUserText, approxMessages };
    summaryCache.set(filePath, entry);
    return entry;
  } finally {
    await fh.close();
  }
}

// Extract the threadId from a filename. Codex names rollouts:
//   rollout-2026-03-02T20-24-40-019cae81-fc0c-7ac2-954d-edc59df06dae.jsonl
// The uuid is the trailing 5-group hyphenated part before ".jsonl".
function threadIdFromFilename(name: string): string {
  const m = /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i.exec(name);
  return m?.[1] ?? '';
}

// Best-effort project key for a codex session — mirrors the encoded
// project-name convention claude-cli uses (slash → dash). Keeps the UI's
// per-workspace grouping identical for both engines.
export function encodeCodexProjectName(cwd: string): string {
  if (!cwd) return '';
  return cwd.replace(/^\//, '-').replace(/\//g, '-');
}

export async function listCodexSessions(): Promise<SessionListItem[]> {
  const out: SessionListItem[] = [];
  const stack: string[] = [];
  // Cached label map for the whole list — one read per listCodexSessions call.
  const labels = await getLabels().catch(() => ({} as Record<string, string>));
  try {
    await fs.access(CODEX_SESSIONS);
  } catch {
    return out;
  }
  // Walk the YYYY/MM/DD tree.
  const years = await fs.readdir(CODEX_SESSIONS, { withFileTypes: true }).catch(() => []);
  for (const y of years) {
    if (!y.isDirectory()) continue;
    const yp = path.join(CODEX_SESSIONS, y.name);
    const months = await fs.readdir(yp, { withFileTypes: true }).catch(() => []);
    for (const mo of months) {
      if (!mo.isDirectory()) continue;
      const mop = path.join(yp, mo.name);
      const days = await fs.readdir(mop, { withFileTypes: true }).catch(() => []);
      for (const d of days) {
        if (!d.isDirectory()) continue;
        stack.push(path.join(mop, d.name));
      }
    }
  }
  await Promise.all(
    stack.map(async (dir) => {
      const files = await fs.readdir(dir).catch(() => []);
      for (const f of files) {
        if (!isRolloutFile(f)) continue;
        const filePath = path.join(dir, f);
        const st = await fs.stat(filePath).catch(() => null);
        if (!st) continue;
        const summary = await readSummary(filePath, st.mtimeMs, st.size);
        if (!summary) continue;
        const sid = summary.meta.id || threadIdFromFilename(f);
        if (!sid) continue;
        const cwd = summary.meta.cwd;
        const project = encodeCodexProjectName(cwd);
        out.push({
          kind: 'codex',
          project,
          cwd,
          gitBranch: summary.meta.gitBranch,
          sessionId: sid,
          preview: (summary.firstUserText || '').slice(0, 220),
          title: getCodexTitle(sid),
          // Manual label wins in sessionTitle over ai-title / preview / sid,
          // so a Codex user's rename shows immediately in the sidebar.
          label: labels[sid],
          messageCount: summary.approxMessages,
          messageCountSuffix: '',
          mtime: st.mtimeMs,
          size: st.size,
          resumeCommand: `codex resume ${sid}`,
        });
      }
    }),
  );
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Find the rollout file that persists a given codex sessionId. Since the
// filename embeds the threadId we don't need to open every file — just
// grep the tree for a matching suffix.
export async function findCodexRolloutFile(sid: string): Promise<string | null> {
  try {
    await fs.access(CODEX_SESSIONS);
  } catch {
    return null;
  }
  const years = await fs.readdir(CODEX_SESSIONS, { withFileTypes: true }).catch(() => []);
  for (const y of years) {
    if (!y.isDirectory()) continue;
    const yp = path.join(CODEX_SESSIONS, y.name);
    const months = await fs.readdir(yp, { withFileTypes: true }).catch(() => []);
    for (const mo of months) {
      if (!mo.isDirectory()) continue;
      const mop = path.join(yp, mo.name);
      const days = await fs.readdir(mop, { withFileTypes: true }).catch(() => []);
      for (const d of days) {
        if (!d.isDirectory()) continue;
        const dp = path.join(mop, d.name);
        const files = await fs.readdir(dp).catch(() => []);
        const match = files.find((f) => isRolloutFile(f) && f.endsWith(`${sid}.jsonl`));
        if (match) return path.join(dp, match);
      }
    }
  }
  return null;
}

// Parse a rollout jsonl into our shared Message[] shape.
//
// Strategy:
//   - event_msg / user_message + event_msg / agent_message drive the
//     user/assistant text stream (they're already de-templated and clean)
//   - event_msg / agent_reasoning → thinking blocks on the previous
//     assistant message
//   - response_item / function_call → tool_use on the current assistant
//     message; response_item / function_call_output → tool_result (paired
//     by call_id so the client can render Bash/Read/etc. cards)
export async function readCodexSessionMessages(sid: string): Promise<SessionDetail> {
  const filePath = await findCodexRolloutFile(sid);
  if (!filePath) throw new Error(`codex session not found: ${sid}`);
  const st = await fs.stat(filePath);
  const raw = await fs.readFile(filePath, 'utf8');

  let cwd = '';
  let gitBranch = '';
  const messages: Message[] = [];
  const replayMessages: Message[] = [];
  // Track the last assistant message so subsequent tool_use / thinking
  // blocks land on the same bubble instead of forcing a new one.
  let currentAssistant: Message | null = null;
  let sourceLine = 0;
  const ensureAssistant = (): Message => {
    if (currentAssistant) return currentAssistant;
    const m: Message = { role: 'assistant', blocks: [] };
    messages.push(m);
    currentAssistant = m;
    return m;
  };

  for (const line of raw.split('\n')) {
    sourceLine++;
    const t = line.trim();
    if (!t) continue;
    let o: { type?: string; payload?: unknown; timestamp?: string };
    try { o = JSON.parse(t); } catch { continue; }
    const p = (o.payload || {}) as Record<string, unknown>;

    if (o.type === 'session_meta') {
      if (!cwd && typeof p.cwd === 'string') cwd = p.cwd;
      const git = p.git as { branch?: string } | undefined;
      if (!gitBranch && git?.branch) gitBranch = git.branch;
      continue;
    }

    if (o.type === 'event_msg') {
      const kind = String(p.type || '');
      if (kind === 'user_message') {
        currentAssistant = null;
        const text = String((p as { message?: string }).message || '').trim();
        // Codex embeds shell-added environment / turn-context as the first
        // user turns disguised as regular messages. Skip anything wrapped
        // in <environment_context>… / <user_instructions>… tags.
        if (text && !text.startsWith('<')) {
          messages.push({
            role: 'user',
            blocks: [{ kind: 'text', text }],
            timestamp: o.timestamp,
            sourceLine,
          });
          replayMessages.push(messages[messages.length - 1]!);
        }
      } else if (kind === 'agent_message') {
        const text = String((p as { message?: string }).message || '').trim();
        if (!text) continue;
        const m = ensureAssistant();
        m.blocks.push({ kind: 'text', text });
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'text', text }], timestamp: o.timestamp, sourceLine });
      } else if (kind === 'agent_reasoning') {
        const text = String((p as { text?: string }).text || '').trim();
        if (!text) continue;
        const m = ensureAssistant();
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        m.blocks.push({ kind: 'thinking', text });
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'thinking', text }], timestamp: o.timestamp, sourceLine });
      }
      continue;
    }

    if (o.type === 'response_item') {
      const kind = String(p.type || '');
      if (kind === 'function_call') {
        // Rollout jsonl separates MCP tool calls into `name: "render_ui"` +
        // `namespace: "mcp__macaron"`. The live SSE stream (codex-runner)
        // emits the same tool as `mcp:macaron/render_ui` — combine them
        // here so downstream `isRenderUiTool` / general MCP detection
        // works uniformly whether the transcript came from disk or the
        // live event stream.
        const rawName = String(p.name || 'tool');
        const ns = String((p as { namespace?: string }).namespace || '');
        const mcpMatch = ns.match(/^mcp__(.+)$/);
        const name = mcpMatch ? `mcp:${mcpMatch[1]}/${rawName}` : rawName;
        const callId = String(p.call_id || `codex-${messages.length}`);
        let input: unknown = p.arguments;
        if (typeof input === 'string') {
          try { input = JSON.parse(input); } catch { /* keep as string */ }
        }
        const m = ensureAssistant();
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        m.blocks.push({ kind: 'tool_use', id: callId, name, input });
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'tool_use', id: callId, name, input }], timestamp: o.timestamp, sourceLine });
      } else if (kind === 'function_call_output') {
        const callId = String(p.call_id || '');
        let text = '';
        const output = p.output;
        if (typeof output === 'string') text = output;
        else if (output && typeof output === 'object') {
          const o2 = output as { output?: string; content?: string; text?: string };
          text = o2.output || o2.content || o2.text || JSON.stringify(output);
        }
        const m = ensureAssistant();
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        m.blocks.push({
          kind: 'tool_result',
          toolUseId: callId,
          text: text.slice(0, 8000),
        });
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'tool_result', toolUseId: callId, text: text.slice(0, 8000) }], timestamp: o.timestamp, sourceLine });
      } else if (kind === 'custom_tool_call') {
        const name = String(p.name || 'custom');
        const callId = String(p.call_id || `codex-${messages.length}`);
        const m = ensureAssistant();
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        m.blocks.push({ kind: 'tool_use', id: callId, name, input: p.input ?? {} });
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'tool_use', id: callId, name, input: p.input ?? {} }], timestamp: o.timestamp, sourceLine });
      } else if (kind === 'custom_tool_call_output') {
        const callId = String(p.call_id || '');
        const text = typeof p.output === 'string'
          ? p.output
          : JSON.stringify(p.output ?? '').slice(0, 8000);
        const m = ensureAssistant();
        m.timestamp ??= o.timestamp;
        m.sourceLine ??= sourceLine;
        m.blocks.push({
          kind: 'tool_result',
          toolUseId: callId,
          text: text.slice(0, 8000),
        });
        replayMessages.push({ role: 'assistant', blocks: [{ kind: 'tool_result', toolUseId: callId, text: text.slice(0, 8000) }], timestamp: o.timestamp, sourceLine });
      }
      // response_item / message / reasoning duplicate the event_msg
      // stream we already consumed — skip.
      continue;
    }
  }

  return {
    kind: 'codex',
    sessionId: sid,
    project: encodeCodexProjectName(cwd),
    cwd,
    gitBranch,
    title: getCodexTitle(sid),
    messages,
    replayMessages,
    truncated: false,
    totalBytes: st.size,
  };
}

// Delete a codex rollout file.
export async function deleteCodexSession(sid: string): Promise<void> {
  const filePath = await findCodexRolloutFile(sid);
  if (!filePath) throw new Error(`codex session not found: ${sid}`);
  await fs.unlink(filePath);
  summaryCache.delete(filePath);
  await deleteCodexTitle(sid);
}
