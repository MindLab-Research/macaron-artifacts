import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownCodeStreamingProvider, MarkdownPre } from '../components/MarkdownCode';
import { ArrowDown, ArrowUp, Bot, Check, ChevronDown, ChevronRight, Circle, CircleDot, ClipboardList, GitBranch, GitFork, Info, Lock, MessageCircle, MoreHorizontal, Paperclip, Plus, RefreshCw, Square, Undo2, X } from 'lucide-react';
import { sessionToMarkdown } from '@macaron/shared';
import {
  api,
  basename,
  downloadTextFile,
  sessionTitle,
  type Message,
  type SessionDetail,
  type PrContext,
  type SlashCommand,
} from '../lib/api';
import { streamSession } from '../lib/sse';
import {
  attachLive,
  clearLive,
  discardLive,
  fingerprintLiveTurn,
  getLive,
  snapshotCoversLiveTurn,
  startNewSession,
  subscribeFollowup,
  subscribeLive,
  type LiveTurnFingerprint,
} from '../lib/liveStore';
import { peekPendingCwd, takePendingCwd, takePendingPrompt } from '../lib/newSession';
import { hasActiveModal } from '../lib/modal';
import { extractPartialCode, parseFollowups } from '../lib/partialJson';
import { SlashPalette } from '../components/SlashPalette';
import {
  THINKING_VERBS,
  SPINNER_FRAMES,
  SPINNER_INTERVAL_MS,
  thinkingTail,
  formatDuration,
  easeTowards,
} from '../lib/thinkingVerbs';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/Confirm';
import { useFileMention } from '../components/MentionPopup';
import { StatusBar, type PermissionMode } from '../components/StatusBar';
import { DiffCard, isDiffTool, extractDiff } from '../components/DiffCard';
import { loadHistory, pushHistory } from '../lib/history';
import { ensureNotificationPermission, notify } from '../lib/notify';
import { playSound } from '../lib/sound';
import StaticGenUIRenderer from '../macaron-vendor/StaticGenUIRenderer';
import { CreatePrDialog } from '../components/CreatePrDialog';
import { collapseReadSearchGroups, summarize } from '../lib/collapseReadSearch';

const RENDER_UI_TOOL = 'mcp__macaron__render_ui';
const isRenderUITool = (name: string) => name === RENDER_UI_TOOL || name.endsWith('__render_ui');

const PAGE_SIZE = 80;

type AttachedImage = { id: string; name: string; mimeType: string; dataUrl: string };

// A message the user typed while a turn was still running. Held client-side
// (macaron's runner is single-shot — one `/message` POST per turn — so there
// is no persistent stdin to inject into) and auto-sent when the turn finishes.
type QueuedMessage = { id: string; text: string };
const queueId = (prefix = 'q') => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

// ---- Flatten Claude's per-block messages into a TUI-style item list -------

// A "part" is a sub-block inside a single user or live-user message card:
// text and image blocks the CLI persisted (or the current live turn is
// accumulating) belong to the same message and should render inside a
// single "❯"-gutter card in their original order.
export type MsgPart =
  | { kind: 'text'; text: string }
  | { kind: 'image'; mimeType: string; data: string };

export type TodoEntry = {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

type Item =
  // uuid is the jsonl `uuid` of the source user message — used as the
  // rewind cutoff (drop this line and everything after).
  | { id: string; kind: 'user'; parts: MsgPart[]; uuid?: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'thinking'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string; durationMs?: number; isError?: boolean }
  // A spawned custom subagent (the `Agent` tool). Drills into the child
  // transcript stored under <sid>/subagents/, linked back by toolUseId.
  | { id: string; kind: 'subagent'; agentType: string; description: string; toolUseId: string; result?: string }
  | { id: string; kind: 'todo'; todos: TodoEntry[] }
  | { id: string; kind: 'system_event'; eventType: string; text: string }
  | { id: string; kind: 'genui'; toolUseId: string; prompt: string; code?: string; status: 'pending' | 'ready' | 'error'; error?: string }
  // Assistant-side inline image (rare — only when the model emits one).
  | { id: string; kind: 'assistant-image'; mimeType: string; data: string }
  | { id: string; kind: 'live-user'; parts: MsgPart[] }
  | { id: string; kind: 'live-assistant'; text: string }
  // Pending / resolved permission gate. Rendered as an inline card with
  // Allow/Deny buttons while `status === 'pending'`.
  | { id: string; kind: 'permission'; permissionId: string; toolName: string; input: unknown; suggestion?: { label: string }; status: 'pending' | 'allow' | 'deny' }
  // Collapsed run of consecutive read-only tools (Read / Grep / Glob / cat /
  // ls / …) — clicking expands the group back into its constituent rows.
  // Built by collapseReadSearchGroups() during the render pass; `items` is
  // the original sequence so the expand path re-renders each ToolItem.
  | { id: string; kind: 'collapsed'; ids: string[]; searchCount: number; readFiles: Set<string>; readOpCount: number; listCount: number; latestHint: string; allDone: boolean; anyError: boolean; items: Item[] };

const TODO_WRITE_NAMES = new Set(['TodoWrite', 'todo_write']);
const isTodoWriteTool = (name: string) => TODO_WRITE_NAMES.has(name);

function isNoisyUserText(t: string): boolean {
  if (!t) return true;
  if (t.startsWith('<')) return true;
  if (/^The file .* (has been (updated|created) successfully|file state is current)/.test(t)) return true;
  if (/^Tool .* failed/.test(t)) return true;
  return false;
}

export function flatten(messages: Message[]): Item[] {
  const out: Item[] = [];
  let i = 0;
  type PairedTool = Extract<Item, { kind: 'tool' | 'genui' }>;
  type PendingTool = { item: PairedTool; ts?: string };
  const pendingTools = new Map<string, PendingTool>();
  // Legacy fallback for older/malformed transcripts without toolUseId. Normal
  // Claude turns can emit multiple tool_use blocks before any tool_result, so
  // id-based pairing below is the load-bearing path.
  let fallbackTool: PendingTool | null = null;
  // TodoWrite fires repeatedly with the full task list each time. Only the
  // latest snapshot is meaningful, so we track its slot in `out` and splice
  // out the previous one when a new one arrives — this mirrors the CLI which
  // shows a single up-to-date todo card and status-bar summary.
  let latestTodoIdx = -1;
  for (const mi in messages) {
    const m = messages[mi]!;
    // System-role messages carry synthetic events (recap after /compact,
    // resume markers). Render each block as its own inline `※` item.
    if (m.role === 'system') {
      for (const b of m.blocks) {
        if (b.kind === 'system_event') {
          out.push({ id: `sys${i++}`, kind: 'system_event', eventType: b.eventType, text: b.text });
        }
      }
      fallbackTool = null;
      continue;
    }
    // Collect any text + image blocks the user sent in this message into a
    // SINGLE user Item so they render inside one card in original order
    // (the CLI stores them interleaved; splitting them into separate cards
    // makes one message look like three).
    if (m.role === 'user') {
      const parts: MsgPart[] = [];
      for (const b of m.blocks) {
        if (b.kind === 'text' && !isNoisyUserText(b.text)) parts.push({ kind: 'text', text: b.text });
        else if (b.kind === 'image') parts.push({ kind: 'image', mimeType: b.mimeType, data: b.data });
      }
      if (parts.length) out.push({ id: `u${i++}-msg${mi}`, kind: 'user', parts, uuid: m.uuid });
    }
    // Non-user blocks (assistant text/thinking/tool_*) still emit one Item
    // per block so their per-block visuals (tool cards, thinking boxes, code
    // panes) stay independent.
    for (const b of m.blocks) {
      if (m.role !== 'user' && b.kind === 'text') {
        if (b.text.trim()) out.push({ id: `a${i++}`, kind: 'assistant', text: b.text });
        fallbackTool = null;
      } else if (b.kind === 'thinking') {
        if (b.text.trim()) out.push({ id: `t${i++}`, kind: 'thinking', text: b.text });
        fallbackTool = null;
      } else if (m.role !== 'user' && b.kind === 'image') {
        // Very rare — assistant emitting an image. Keep in its own row.
        out.push({ id: `img${i++}`, kind: 'assistant-image', mimeType: b.mimeType, data: b.data });
        fallbackTool = null;
      } else if (b.kind === 'tool_use') {
        if (isTodoWriteTool(b.name)) {
          const input = (b.input || {}) as { todos?: TodoEntry[] };
          const todos = Array.isArray(input?.todos) ? input.todos : [];
          // Drop the previous todo card — a fresh TodoWrite always replaces
          // it (CLI shows only the latest state).
          if (latestTodoIdx >= 0) {
            out.splice(latestTodoIdx, 1);
            latestTodoIdx = -1;
          }
          latestTodoIdx = out.length;
          out.push({ id: `todo${i++}`, kind: 'todo', todos });
          // TodoWrite's tool_result is just an ACK — don't chain it to
          // anything real.
          fallbackTool = null;
        } else if (isRenderUITool(b.name)) {
          // Claude writes the TSX directly into the tool_use input.code field;
          // jsonl persists it. We use that as the rendered code immediately.
          const input = (b.input || {}) as { code?: string; prompt?: string };
          const code = typeof input.code === 'string' ? input.code : '';
          const prompt = code
            ? `${code.split('\n')[0] || ''} … (${code.length} chars)`
            : (typeof input.prompt === 'string' ? input.prompt : JSON.stringify(input));
          const toolUseId = (b as unknown as { id?: string }).id || `synthetic-${i}`;
          // Stable key by toolUseId so the live placeholder (created on tool_use)
          // and the post-load jsonl render reconcile into the same component —
          // otherwise StaticGenUIRenderer would unmount/remount and flash.
          i++;
          const it: Extract<Item, { kind: 'genui' }> = {
            id: `genui-${toolUseId}`,
            kind: 'genui',
            toolUseId,
            prompt,
            code: code || undefined,
            status: code ? 'ready' : 'pending',
          };
          out.push(it);
          const pending = { item: it as PairedTool, ts: m.timestamp };
          pendingTools.set(toolUseId, pending);
          fallbackTool = pending;
        } else if (b.name === 'Agent') {
          // A spawned subagent. Its child transcript lives under
          // <sid>/subagents/ keyed by the tool_use id — SubagentItem drills in.
          const input = (b.input || {}) as { subagent_type?: string; description?: string };
          const toolUseId = (b as unknown as { id?: string }).id || `synthetic-${i}`;
          const it: Extract<Item, { kind: 'subagent' }> = {
            id: `sub${i++}`,
            kind: 'subagent',
            agentType: String(input.subagent_type || ''),
            description: String(input.description || ''),
            toolUseId,
          };
          out.push(it);
          const pending = { item: it as unknown as PairedTool, ts: m.timestamp };
          pendingTools.set(toolUseId, pending);
          fallbackTool = pending;
        } else {
          const toolUseId = (b as unknown as { id?: string }).id || `synthetic-${i}`;
          const it: Extract<Item, { kind: 'tool' }> = {
            id: `tool${i++}`,
            kind: 'tool',
            name: b.name,
            input: b.input,
          };
          out.push(it);
          const pending = { item: it as PairedTool, ts: m.timestamp };
          pendingTools.set(toolUseId, pending);
          fallbackTool = pending;
        }
      } else if (b.kind === 'tool_result') {
        const pending = b.toolUseId ? pendingTools.get(b.toolUseId) : fallbackTool;
        const item = pending?.item;
        if (item) {
          if (item.kind === 'genui') {
            const g = item;
            const t = b.text || '';
            if (t.startsWith('render_ui failed:')) {
              g.status = 'error';
              g.error = t.slice('render_ui failed:'.length).trim();
            } else if (!g.code) {
              // Result arrived but the tool_use never carried any `code` —
              // the model sent the wrong arg (e.g. `prompt`) or the input
              // was rejected upstream. Don't leave the row spinning; flag
              // it so the user + the model can see something went wrong.
              g.status = 'error';
              g.error = t
                ? `no TSX code in tool_use input (result: ${t.slice(0, 200)})`
                : 'no TSX code in tool_use input — check the render_ui call arguments.';
            } else {
              g.status = 'ready';
            }
          } else {
            item.result = (item.result ? item.result + '\n' : '') + b.text;
            if (b.isError) item.isError = true;
            // Wall-clock = result message time − tool_use message time. Both
            // are best-effort ISO strings; leave undefined if either is absent
            // or the delta is nonsensical (clock skew / same-line messages).
            if (pending.ts && m.timestamp) {
              const d = new Date(m.timestamp).getTime() - new Date(pending.ts).getTime();
              if (Number.isFinite(d) && d >= 0) item.durationMs = d;
            }
          }
        }
      }
    }
  }
  return out;
}

// ---- Tool header formatting (Bash → command first line, etc.) -------------

export function toolHeader(name: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Bash') {
    return String(input.command || '').replace(/\s+/g, ' ').slice(0, 240);
  }
  if (name === 'Read' || name === 'Edit' || name === 'Write' || name === 'MultiEdit') {
    const p = String(input.file_path || '');
    return p ? '…' + p.split('/').slice(-2).join('/') : '';
  }
  if (name === 'Glob') return String(input.pattern || '');
  if (name === 'Grep') return String(input.pattern || '');
  if (name === 'TaskCreate') return String(input.subject || '');
  if (name === 'TaskUpdate') return `#${input.taskId || ''} → ${input.status || input.subject || ''}`;
  if (name === 'WebFetch' || name === 'WebSearch') return String(input.url || input.query || '');
  const s = JSON.stringify(input);
  return s.length > 200 ? s.slice(0, 200) + '…' : s;
}

// ---- Items ----------------------------------------------------------------

// Dim italic header at the top of the thread (visually the top because the
// thread renders column-reverse, so it must be the LAST DOM child of .thread).
function SessionHeader({ cwd, startedAt }: { cwd: string; startedAt: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!startedAt) return;
    const id = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(id);
  }, [startedAt]);
  const shownCwd = cwd ? cwd.replace(/^\/Users\/[^/]+/, '~').replace(/^\/home\/[^/]+/, '~') : '';
  const elapsedMs = startedAt ? Math.max(0, now - startedAt) : 0;
  const elapsed = startedAt ? formatElapsed(elapsedMs) : '';
  return (
    <div className="ti-session-head">
      <span className="ti-session-cwd">{shownCwd || '(unknown cwd)'}</span>
      {elapsed && <span className="ti-session-elapsed">({elapsed})</span>}
    </div>
  );
}

function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// ---- Todo card ------------------------------------------------------------

const TODO_STATUS_ORDER: Record<TodoEntry['status'], number> = {
  in_progress: 0,
  pending: 1,
  completed: 2,
};

function TodoItem({ id, todos }: { id?: string; todos: TodoEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  const total = todos.length;
  const done = todos.filter((t) => t.status === 'completed').length;
  const inProg = todos.filter((t) => t.status === 'in_progress').length;
  const open = todos.filter((t) => t.status === 'pending').length;

  const sorted = [...todos].sort(
    (a, b) => TODO_STATUS_ORDER[a.status] - TODO_STATUS_ORDER[b.status],
  );
  // Show all non-completed, plus up to first 3 completed. Overflow rolls
  // into a "… +N completed" footer.
  const shown: TodoEntry[] = [];
  let completedShown = 0;
  const COMPLETED_LIMIT = expanded ? Infinity : 3;
  for (const t of sorted) {
    if (t.status === 'completed') {
      if (completedShown < COMPLETED_LIMIT) {
        shown.push(t);
        completedShown++;
      }
    } else {
      shown.push(t);
    }
  }
  const hiddenCompleted = Math.max(0, done - completedShown);

  return (
    <div className="ti-todo" data-item-id={id}>
      <div className="ti-todo-stats">
        <strong>{total} tasks</strong> ({done} done, {inProg} in progress, {open} open)
      </div>
      <ul className="ti-todo-list">
        {shown.map((t, idx) => {
          const label =
            t.status === 'in_progress' && t.activeForm ? t.activeForm : t.content;
          return (
            <li key={idx} className={`ti-todo-li ti-todo-${t.status}`}>
              <span className="ti-todo-icon" role="img" aria-label={t.status.replace('_', ' ')}>
                {t.status === 'completed' ? <Check size={11} aria-hidden="true" /> : t.status === 'in_progress' ? <CircleDot size={11} aria-hidden="true" /> : <Square size={11} aria-hidden="true" />}
              </span>
              <span className="ti-todo-text">{label}</span>
            </li>
          );
        })}
      </ul>
      {hiddenCompleted > 0 && (
        <button className="ti-expand" onClick={() => setExpanded((v) => !v)}>
          {expanded ? <><ArrowUp size={12} aria-hidden="true" /> collapse</> : `… +${hiddenCompleted} completed`}
        </button>
      )}
    </div>
  );
}

// ---- System event ---------------------------------------------------------

function SystemEventItem({ eventType, text }: { eventType: string; text: string }) {
  const [open, setOpen] = useState(false);
  const label =
    eventType === 'summary'
      ? 'recap'
      : eventType === 'resume'
        ? 'resume'
        : eventType === 'compact'
          ? 'compact'
          : eventType;
  const isLong = text.length > 200;
  const shown = open || !isLong ? text : text.slice(0, 200) + '…';
  return (
    <div className="ti-sysevent">
      <span className="ti-sysevent-mark"><Info size={13} aria-hidden="true" /></span>
      <span className="ti-sysevent-label">{label}:</span> {shown}
      {isLong && (
        <button className="ti-expand ti-sysevent-toggle" onClick={() => setOpen((v) => !v)}>
          {open ? <> <ArrowUp size={12} aria-hidden="true" /> collapse</> : ' expand'}
        </button>
      )}
    </div>
  );
}

// One user message = one visual card, no matter how many text or image
// blocks it holds. The "❯" chevron sits at top-left; parts stack in
// original order so pasted "image → text → image" reads naturally.
function UserItem({
  parts,
  onRewind,
  onFork,
}: {
  parts: MsgPart[];
  onRewind?: () => void;
  onFork?: () => void;
}) {
  const hasNonEmptyText = parts.some((p) => p.kind === 'text' && p.text);
  const hasImage = parts.some((p) => p.kind === 'image');
  if (!hasNonEmptyText && !hasImage) return null;
  return (
    <div className="ti-user">
      <span className="ti-chev"><ChevronRight size={14} aria-hidden="true" /></span>
      <div className="ti-user-body">
        {parts.map((p, idx) =>
          p.kind === 'text' ? (
            <div key={idx} className="ti-user-text">{p.text}</div>
          ) : (
            <div key={idx} className="ti-user-image">
              <img className="ti-image" src={`data:${p.mimeType};base64,${p.data}`} alt="attachment" />
            </div>
          ),
        )}
      </div>
      {onFork && (
        <button
          type="button"
          className="ti-user-fork"
          onClick={onFork}
          title="Fork a new session from before this message"
          aria-label="Fork"
        >
          <GitFork size={13} aria-hidden="true" /> fork
        </button>
      )}
      {onRewind && (
        <button
          type="button"
          className="ti-user-rewind"
          onClick={onRewind}
          title="Rewind to before this message"
          aria-label="Rewind"
        >
          <Undo2 size={13} aria-hidden="true" /> rewind
        </button>
      )}
    </div>
  );
}

const CHAT_MARKDOWN_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre } as const;

function AssistantItem({ text }: { text: string }) {
  return (
    <div className="ti-text md">
      <MarkdownCodeStreamingProvider content={text} streaming={false}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
      </MarkdownCodeStreamingProvider>
    </div>
  );
}

function LiveAssistantItem({ text, streaming }: { text: string; streaming: boolean }) {
  return (
    <div className="ti-text md">
      <MarkdownCodeStreamingProvider content={text} streaming={streaming}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={CHAT_MARKDOWN_COMPONENTS}>{text}</ReactMarkdown>
      </MarkdownCodeStreamingProvider>
    </div>
  );
}

function ThinkingItem({ text }: { text: string }) {
  return <div className="ti-thinking"><MessageCircle size={12} aria-hidden="true" /> {text}</div>;
}

// Assistant-side inline image (rare — some models emit vision output).
// User-side images render inside UserItem's parts instead of here.
function AssistantImageItem({ mimeType, data }: { mimeType: string; data: string }) {
  const src = `data:${mimeType};base64,${data}`;
  return (
    <div className="ti-image-row">
      <div className="ti-image-wrap">
        <img className="ti-image" src={src} alt="attachment" />
      </div>
    </div>
  );
}

// A spawned subagent card. Collapsed it looks like a tool row; expanded it
// lazy-loads the child transcript (<sid>/subagents/agent-<id>.jsonl) and
// renders it inline with the same ItemView the parent thread uses.
function SubagentItem({
  it,
  project,
  sid,
}: {
  it: Extract<Item, { kind: 'subagent' }>;
  project?: string;
  sid?: string;
}) {
  const [open, setOpen] = useState(false);
  const [child, setChild] = useState<Item[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const label = it.agentType || 'Agent';

  const toggle = useCallback(async () => {
    const next = !open;
    setOpen(next);
    if (!next || child || loading || !project || !sid) return;
    setLoading(true);
    setErr('');
    try {
      // The parent tool_use id links to exactly one child jsonl via its
      // meta sidecar; resolve that agentId, then read the child transcript.
      const { subagents } = await api.subagents(project, sid);
      const match = subagents.find((s) => s.toolUseId === it.toolUseId);
      if (!match) throw new Error('child transcript not found');
      const detail = await api.subagent(project, sid, match.agentId);
      setChild(flatten(detail.messages));
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [open, child, loading, project, sid, it.toolUseId]);

  return (
    <div className="ti-tool ti-subagent">
      <button type="button" className="ti-tool-head ti-subagent-head" onClick={toggle}>
        <span className="ti-dot"><Bot size={14} aria-hidden="true" /></span>
        <span className="ti-tool-name">{label}</span>
        {it.description && (
          <span className="ti-tool-args" title={it.description}>
            ({it.description})
          </span>
        )}
        <span className="ti-subagent-toggle">{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
      </button>
      {open && (
        <div className="ti-subagent-body">
          {loading && <div className="ti-subagent-note muted">Loading transcript…</div>}
          {err && <div className="ti-subagent-note ti-error">{err}</div>}
          {child && child.length === 0 && <div className="ti-subagent-note muted">Empty transcript.</div>}
          {child?.map((c) => (
            <ItemView key={c.id} it={c} />
          ))}
        </div>
      )}
    </div>
  );
}

const PREVIEW_LINES = 2;

function ToolItem({ id, name, input, result, durationMs, isError }: { id?: string; name: string; input: unknown; result?: string; durationMs?: number; isError?: boolean }) {
  const [open, setOpen] = useState(false);
  const header = toolHeader(name, input);
  const resultText = (result ?? '').replace(/\n+$/, '');
  const allLines = resultText ? resultText.split('\n') : [];
  const previewLines = open ? allLines : allLines.slice(0, PREVIEW_LINES);
  const extra = Math.max(0, allLines.length - PREVIEW_LINES);

  return (
    <div className="ti-tool" data-item-id={id}>
      <div className="ti-tool-head">
        <span className={`ti-dot${isError ? ' ti-dot-error' : ''}`}><Circle size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" /></span>
        <span className="ti-tool-name">{name}</span>
        {header && (
          <span className="ti-tool-args" title={header}>
            ({header})
          </span>
        )}
        {durationMs != null && <span className="ti-tool-dur">{formatDuration(durationMs)}</span>}
      </div>
      {result !== undefined && allLines.length > 0 && (
        <div className="ti-tool-out">
          <span className="ti-rail">└</span>
          <div className="ti-tool-body">
            {previewLines.length > 0 && <pre>{previewLines.join('\n')}</pre>}
            {extra > 0 && (
              <button className="ti-expand" onClick={() => setOpen((v) => !v)}>
                {open ? <><ArrowUp size={12} aria-hidden="true" /> collapse</> : `… +${extra} ${extra === 1 ? 'line' : 'lines'} (expand)`}
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// 1:1 clone of Claude Code CLI's thinking spinner. All constants (verb list,
// spinner frames, tail-phrase thresholds, duration format, token easing) are
// extracted byte-for-byte from the shipped `claude` binary — see
// `../lib/thinkingVerbs.ts` for source offsets.
function ThinkingIndicator({
  assistantLen,
  outputTokens,
}: {
  assistantLen: number;
  // Authoritative cumulative output_tokens from the SDK's message_delta
  // usage stream. -1 = no signal yet (Macaron path or pre-first-delta); in
  // that case we fall back to the CLI's len/4 English estimate.
  outputTokens: number;
}) {
  const startRef = useRef(Date.now());
  const verbRef = useRef<string>(THINKING_VERBS[Math.floor(Math.random() * THINKING_VERBS.length)]!);
  const [now, setNow] = useState(() => Date.now());
  const [frameIdx, setFrameIdx] = useState(0);
  // Animated token count: eases toward the true target at 50ms cadence with
  // the same step schedule the CLI uses (3/tick close, ~15% medium, 50/tick
  // far behind). The target is real tokens when available, else len/4.
  const [displayTokens, setDisplayTokens] = useState(0);
  const targetTokensRef = useRef(0);
  targetTokensRef.current =
    outputTokens >= 0 ? outputTokens : Math.round(assistantLen / 4);

  useEffect(() => {
    startRef.current = Date.now();
    setNow(Date.now());
    setDisplayTokens(0);
    const clockId = window.setInterval(() => setNow(Date.now()), 500);
    const frameId = window.setInterval(
      () => setFrameIdx((i) => (i + 1) % SPINNER_FRAMES.length),
      SPINNER_INTERVAL_MS,
    );
    const easeId = window.setInterval(() => {
      setDisplayTokens((cur) => easeTowards(cur, targetTokensRef.current));
    }, 50);
    return () => {
      window.clearInterval(clockId);
      window.clearInterval(frameId);
      window.clearInterval(easeId);
    };
  }, []);

  const elapsedMs = Math.max(0, now - startRef.current);
  const tokens = displayTokens;
  const tail = thinkingTail(elapsedMs);

  return (
    <div className="ti-thinking-line">
      <span className="ti-thinking-star">{SPINNER_FRAMES[frameIdx]}</span>
      <span className="ti-thinking-verb">{verbRef.current}…</span>
      <span className="ti-thinking-parens">(</span>
      <span className="ti-thinking-meta">{formatDuration(elapsedMs)}</span>
      {tokens > 0 && (
        <>
          <span className="ti-thinking-sep">·</span>
          <span className="ti-thinking-meta">↓ {tokens.toLocaleString()} tokens</span>
        </>
      )}
      {tail && (
        <>
          <span className="ti-thinking-sep">·</span>
          <span className="ti-thinking-tail">{tail} with high effort</span>
        </>
      )}
      <span className="ti-thinking-parens">)</span>
    </div>
  );
}

function GenuiItem({ it }: { it: Extract<Item, { kind: 'genui' }> }) {
  const code = it.code || '';
  const streaming = it.status === 'pending' && Boolean(code);

  // Remember the most recent code that actually rendered so a subsequent
  // failure (streamed partial that briefly breaks, or a tool_result marked
  // error) doesn't wipe the widget — we keep showing the last good frame
  // and just tack an error banner on top.
  const [lastGoodCode, setLastGoodCode] = useState('');
  const [runtimeError, setRuntimeError] = useState('');

  const onRendered = useCallback((rendered: string) => {
    setLastGoodCode(rendered);
    setRuntimeError('');
  }, []);
  const onError = useCallback((err: Error) => {
    setRuntimeError(err.message || String(err));
  }, []);

  const displayCode = code || lastGoodCode;
  const toolError = it.status === 'error' ? (it.error || 'unknown error') : '';
  const banner = toolError || runtimeError;

  if (!displayCode) {
    if (toolError) {
      return (
        <div className="ti-genui" data-item-id={it.id}>
          <div className="ti-genui-error">render_ui failed: {toolError}</div>
        </div>
      );
    }
    return (
      <div className="ti-genui" data-item-id={it.id}>
        <div className="ti-genui-pending">generating UI…</div>
      </div>
    );
  }
  return (
    <div className="ti-genui" data-item-id={it.id}>
      {banner && (
        <div className="ti-genui-error stale" title={banner}>
          Newer render failed — showing last good frame. {banner}
        </div>
      )}
      <StaticGenUIRenderer
        code={displayCode}
        active
        streaming={streaming}
        preserveStateOnUpdate={streaming}
        flushMode="immediate"
        onRendered={onRendered}
        onError={onError}
        className="ti-genui-renderer macaron-genui-scope"
      />
    </div>
  );
}

// Inline permission gate. Deny / Allow-once always show; Session / Always
// appear when the server sent a `suggestion` (i.e. there's a concrete rule to
// remember) and POST the decision with a scope so canUseTool persists it.
function PermissionItem({
  it,
  onDecide,
}: {
  it: Extract<Item, { kind: 'permission' }>;
  onDecide: (permissionId: string, decision: 'allow' | 'deny', scope?: 'once' | 'session' | 'always') => void;
}) {
  // Only pending gates are worth showing — once resolved, the tool block
  // above already tells the story (Bash ran / didn't run).
  if (it.status !== 'pending') return null;
  const header = toolHeader(it.toolName, it.input);
  const remember = it.suggestion?.label;
  return (
    <div className="ti-perm">
      <span className="ti-perm-icon"><Lock size={14} aria-hidden="true" /></span>
      <span className="ti-perm-title">
        Run <strong>{it.toolName}</strong>?
      </span>
      {header && (
        <span className="ti-perm-args" title={header}>
          ({header})
        </span>
      )}
      <span className="ti-perm-actions">
        <button
          type="button"
          className="ghost small"
          onClick={() => onDecide(it.permissionId, 'deny')}
        >
          Deny
        </button>
        <button
          type="button"
          className="ghost small"
          onClick={() => onDecide(it.permissionId, 'allow', 'once')}
        >
          Allow once
        </button>
        {remember && (
          <button
            type="button"
            className="ghost small"
            title={`Don't ask again this session for: ${remember}`}
            onClick={() => onDecide(it.permissionId, 'allow', 'session')}
          >
            Session
          </button>
        )}
        {remember && (
          <button
            type="button"
            className="primary small"
            title={`Always allow in this project: ${remember}`}
            onClick={() => onDecide(it.permissionId, 'allow', 'always')}
          >
            Always
          </button>
        )}
      </span>
    </div>
  );
}

// Plan-mode approval panel — shown when the model calls `ExitPlanMode` to
// present a plan. Three choices map to how the run proceeds once plan mode
// exits: auto-accept edits (acceptEdits), approve each edit (default), or
// keep planning (deny — the model refines and re-proposes).
function PlanApprovalItem({
  it,
  onDecide,
}: {
  it: Extract<Item, { kind: 'permission' }>;
  onDecide: (permissionId: string, decision: 'allow' | 'deny', mode?: PermissionMode) => void;
}) {
  if (it.status !== 'pending') return null;
  const rawPlan = (it.input as { plan?: unknown } | null)?.plan;
  const plan = typeof rawPlan === 'string' ? rawPlan : '';
  return (
    <div className="ti-plan">
      <div className="ti-plan-head">
        <span className="ti-plan-icon"><ClipboardList size={13} aria-hidden="true" /></span>
        <span className="ti-plan-title">Ready to code?</span>
        <span className="ti-plan-sub">Here is the plan — choose how to proceed.</span>
      </div>
      {plan && (
        <div className="ti-plan-body md">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{plan}</ReactMarkdown>
        </div>
      )}
      <div className="ti-plan-actions">
        <button type="button" className="primary small" onClick={() => onDecide(it.permissionId, 'allow', 'acceptEdits')}>
          Yes, and auto-accept edits
        </button>
        <button type="button" className="ghost small" onClick={() => onDecide(it.permissionId, 'allow', 'default')}>
          Yes, and manually approve edits
        </button>
        <button type="button" className="ghost small" onClick={() => onDecide(it.permissionId, 'deny')}>
          No, keep planning
        </button>
      </div>
    </div>
  );
}

export function ItemView({
  it,
  onRewind,
  onFork,
  onPermissionDecide,
  streaming,
  project,
  sid,
}: {
  it: Item;
  onRewind?: (uuid: string) => void;
  onFork?: (uuid: string) => void;
  // 3rd arg is a scope ('once'/'session'/'always') from PermissionItem or a plan-mode
  // ('acceptEdits'/'default') from PlanApprovalItem — disjoint value sets, so a single
  // handler serves both. This wider param is assignable to both child onDecide props.
  onPermissionDecide?: (permissionId: string, decision: 'allow' | 'deny', arg?: PermissionMode | 'once' | 'session' | 'always') => void;
  // True only while the turn is still live; a bare EOF/stop/error flips it off so a
  // trailing unclosed fence stops streaming and releases its reader/observer.
  streaming?: boolean;
  project?: string;
  sid?: string;
}) {
  switch (it.kind) {
    case 'user':
      return (
        <UserItem
          parts={it.parts}
          onRewind={
            onRewind && it.uuid ? () => onRewind(it.uuid!) : undefined
          }
          onFork={onFork && it.uuid ? () => onFork(it.uuid!) : undefined}
        />
      );
    case 'live-user':
      return <UserItem parts={it.parts} />;
    case 'assistant':
      return <AssistantItem text={it.text} />;
    case 'live-assistant':
      return <LiveAssistantItem text={it.text} streaming={streaming ?? true} />;
    case 'thinking':
      return <ThinkingItem text={it.text} />;
    case 'tool': {
      // Edit/Write/MultiEdit render as an inline diff card; every other tool
      // (and any edit whose input hasn't fully streamed yet) uses the plain row.
      const diff = isDiffTool(it.name) ? extractDiff(it.name, it.input) : null;
      return diff
        ? <DiffCard name={it.name} diff={diff} result={it.result} isError={it.isError} />
        : <ToolItem id={it.id} name={it.name} input={it.input} result={it.result} durationMs={it.durationMs} isError={it.isError} />;
    }
    case 'subagent':
      return <SubagentItem it={it} project={project} sid={sid} />;
    case 'todo':
      return <TodoItem id={it.id} todos={it.todos} />;
    case 'system_event':
      return <SystemEventItem eventType={it.eventType} text={it.text} />;
    case 'genui':
      return <GenuiItem it={it} />;
    case 'assistant-image':
      return <AssistantImageItem mimeType={it.mimeType} data={it.data} />;
    case 'permission': {
      const decide = onPermissionDecide ?? (() => {});
      return it.toolName === 'ExitPlanMode' ? (
        <PlanApprovalItem it={it} onDecide={decide} />
      ) : (
        <PermissionItem it={it} onDecide={decide} />
      );
    }
    case 'collapsed':
      return <CollapsedGroupItem it={it} project={project} sid={sid} />;
  }
}

// Summary row for a group of consecutive read-only tool calls (Read /
// Grep / Glob / cat / grep / ls / …). Click to expand — reveals each row
// at full detail via the same ItemView, so this is a pure UI wrapper.
function CollapsedGroupItem({
  it,
  project,
  sid,
}: {
  it: Extract<Item, { kind: 'collapsed' }>;
  project?: string;
  sid?: string;
}) {
  const [open, setOpen] = useState(false);
  const summary = summarize(it);
  return (
    <div className="ti-collapsed" data-item-id={it.id}>
      <button
        type="button"
        className={'ti-collapsed-head' + (it.anyError ? ' err' : '')}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="ti-collapsed-dot"><Circle size={9} fill="currentColor" strokeWidth={0} aria-hidden="true" /></span>
        <span className="ti-collapsed-summary">{summary || `${it.ids.length} operations`}</span>
        <span className="ti-collapsed-caret">{open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronRight size={12} aria-hidden="true" />}</span>
      </button>
      {open && (
        <div className="ti-collapsed-body">
          {it.items.map((child) => (
            <ItemView key={child.id} it={child} project={project} sid={sid} />
          ))}
        </div>
      )}
    </div>
  );
}

// Session-level actions dropdown ("···" button). Extra items get added
// here — the button intentionally does nothing on its own; each menu row
// carries its own click handler.
function SessionActionsMenu({
  disabled,
  busyCompact,
  busyPr,
  onCompact,
  onCreatePr,
  onExport,
}: {
  disabled: boolean;
  busyCompact: boolean;
  busyPr: boolean;
  onCompact: () => void;
  onCreatePr: () => void;
  onExport: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: Event) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: Event) => {
      const ke = e as unknown as { key: string };
      if (ke.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onEsc);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onEsc);
    };
  }, [open]);
  return (
    <div className="actions-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="icon-btn"
        title="Session actions"
        aria-label="Session actions"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
      </button>
      {open && (
        <div className="actions-menu">
          <button
            type="button"
            className="actions-menu-item"
            disabled={disabled || busyPr}
            onClick={() => {
              setOpen(false);
              onCreatePr();
            }}
          >
            <span className="actions-menu-body">
              <span className="actions-menu-label">
                {busyPr ? 'Opening PR…' : 'Create PR'}
              </span>
              <span className="actions-menu-sub">Push branch → open a pull request</span>
            </span>
          </button>
          <button
            type="button"
            className="actions-menu-item"
            disabled={disabled}
            onClick={() => {
              setOpen(false);
              onExport();
            }}
          >
            <span className="actions-menu-body">
              <span className="actions-menu-label">Export to Markdown</span>
              <span className="actions-menu-sub">Download the transcript as a .md file</span>
            </span>
          </button>
          <button
            type="button"
            className="actions-menu-item"
            disabled={disabled || busyCompact}
            onClick={() => {
              setOpen(false);
              onCompact();
            }}
          >
            <span className="actions-menu-body">
              <span className="actions-menu-label">
                {busyCompact ? 'Compacting…' : 'Compact'}
              </span>
              <span className="actions-menu-sub">Summarise → replace transcript</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

// ---- Pending queue --------------------------------------------------------

// Messages the user lined up while a turn was running. Rendered above the
// composer (mirrors the img-chips row). Each row can be reordered, edited
// (pulled back into the composer), or removed.
function PendingQueue({
  queue,
  onRemove,
  onMove,
  onEdit,
}: {
  queue: QueuedMessage[];
  onRemove: (id: string) => void;
  onMove: (id: string, dir: -1 | 1) => void;
  onEdit: (id: string) => void;
}) {
  if (queue.length === 0) return null;
  return (
    <div className="pending-queue">
      <div className="pending-queue-head">
        {queue.length} queued · sends when the current turn finishes
      </div>
      {queue.map((q, idx) => (
        <div key={q.id} className="pending-item">
          <span className="pending-item-idx">{idx + 1}</span>
          <button
            type="button"
            className="pending-item-text"
            title={q.text}
            aria-label="Edit queued message"
            onClick={() => onEdit(q.id)}
          >
            {q.text}
          </button>
          <span className="pending-item-actions">
            <button
              type="button"
              className="icon-btn pending-item-btn"
              title="Move up"
              aria-label="Move up"
              disabled={idx === 0}
              onClick={() => onMove(q.id, -1)}
            ><ArrowUp size={14} aria-hidden="true" /></button>
            <button
              type="button"
              className="icon-btn pending-item-btn"
              title="Move down"
              aria-label="Move down"
              disabled={idx === queue.length - 1}
              onClick={() => onMove(q.id, 1)}
            ><ArrowDown size={14} aria-hidden="true" /></button>
            <button
              type="button"
              className="icon-btn pending-item-btn"
              title="Remove"
              aria-label="Remove"
              onClick={() => onRemove(q.id)}
            ><X size={14} aria-hidden="true" /></button>
          </span>
        </div>
      ))}
    </div>
  );
}

// ---- Session view ---------------------------------------------------------

export type SessionProps = {
  // When rendered as a canvas tile the parent passes project + sid directly
  // instead of relying on the URL params (multiple tiles on one route can't
  // share params). `focused` gates the global Shift+Tab handler so only the
  // active tile responds.
  project?: string;
  sid?: string;
  focused?: boolean;
  onFocus?: () => void;
  onRemove?: () => void;
  // Suppress the top breadcrumb + copy/refresh bar — the tile grip already
  // hosts those actions in canvas mode.
  hideBar?: boolean;
  // Incrementing this from the parent forces a fresh reload of the jsonl
  // (used by the tile's refresh button).
  refreshKey?: number;
  // Fired when the streaming state flips so a canvas tile can wrap itself
  // in a flowing-light animation while a turn is in-flight.
  onSendingChange?: (sending: boolean) => void;
  // Canvas-path "the first turn is already streaming" flag — parent sets
  // this when a draft tile just got promoted to a real sid. Session then
  // subscribes to the liveStore stream instead of GET-ing the (not-yet-
  // written) jsonl (which would 404). Equivalent to the `/s/new` route's
  // `state: { pending: true }`.
  initialPending?: boolean;
  onPendingConsumed?: () => void;
  // Called by the isNew send path (draft tile) with the real sid the server
  // assigned. The parent swaps the draft sentinel for this sid in place, so
  // the tile keeps its grid position and Session remounts under the real
  // sid with `initialPending=true`.
  onCreated?: (newSid: string) => void;
};

export function Session(props: SessionProps = {}) {
  const params = useParams();
  const project = props.project ?? params.project ?? '';
  const sid = props.sid ?? params.sid ?? '';
  const location = useLocation();
  const navigate = useNavigate();
  const isNew = !sid;
  const routePending = Boolean((location.state as { pending?: boolean } | null)?.pending);
  // Set to true if the mount-time probe finds a live server-side run for this
  // sid (page refreshed mid-turn). Fed into isPending so the existing
  // subscribeLive branch runs the same way it does for a freshly-started
  // session.
  const [reattached, setReattached] = useState(false);
  // A pending prop can stay true across a transport reconnect, so boolean
  // isPending alone is not enough to restart the liveStore subscription.
  const [liveSubscriptionGen, setLiveSubscriptionGen] = useState(0);
  const liveDisconnected = useRef(false);
  const isPending = routePending || Boolean(props.initialPending) || reattached;
  const onCreated = props.onCreated;
  const onPendingConsumed = props.onPendingConsumed;
  // When mounted as a canvas tile the parent decides focus. Standalone
  // (single-URL) mount is always focused.
  const focused = props.focused ?? true;
  const hideBar = props.hideBar ?? false;
  const refreshKey = props.refreshKey ?? 0;
  const [reconnectKey, setReconnectKey] = useState(0);
  const lastRefreshKey = useRef({ refreshKey, reconnectKey });
  const onSendingChange = props.onSendingChange;
  // Ref rather than closure — send() captures props once, but permission
  // notifications may fire long after the send call. Ref lets the click
  // handler always dispatch to the current onFocus.
  const onFocusRef = useRef(props.onFocus);
  onFocusRef.current = props.onFocus;
  // Marked true once a stream has started so the done-notification only
  // fires for turns the user actually initiated (not initial jsonl load).
  const streamedRef = useRef(false);
  // Latest user prompt for the in-flight turn. Captured at send() so the
  // completion notification can display "what was this turn about" instead
  // of a bare session hash.
  const lastPromptRef = useRef<string>('');
  // Set when the current turn hit onError, so the completion effect below can
  // skip the 'complete' cue — onDone still runs after a stream error, and a
  // failed turn shouldn't sound like a success.
  const turnErroredRef = useRef(false);
  // Set while a user-initiated Stop is in flight. Stop aborts the SDK
  // stream, which claude-runner's catch surfaces as an onError (it doesn't
  // filter AbortError) — so without this the deliberate Stop would play the
  // 'error' cue as if the turn had actually failed.
  const stoppingRef = useRef(false);
  const [data, setData] = useState<SessionDetail | null>(null);
  // Invalidates a post-done JSONL poll when the session changes or another
  // turn starts before the prior handoff finishes.
  const snapshotHandoffGen = useRef(0);
  const pendingSnapshotTurn = useRef<ReturnType<typeof fingerprintLiveTurn> | null>(null);
  const directSnapshotTurn = useRef<LiveTurnFingerprint | null>(null);
  const directTurnStartedAt = useRef<number | undefined>(undefined);
  const [error, setError] = useState('');
  const [sending, setSending] = useState(false);
  const [polling, setPolling] = useState(false);
  const [handoffPending, setHandoffPending] = useState(false);
  // Notify the parent tile whenever the effective "running" state flips
  // (either an in-flight send OR the initial new-session SSE poll). Debounced
  // by a microtask so React batches state updates naturally.
  useEffect(() => {
    onSendingChange?.(sending || polling || handoffPending);
  }, [sending, polling, handoffPending, onSendingChange]);
  // Browser notification on stream completion. Tracks the running edge:
  // fires on true→false when we actually streamed this turn (avoids
  // pinging on the initial jsonl load when everything starts at false).
  useEffect(() => {
    const running = sending || polling;
    if (running) {
      streamedRef.current = true;
      return;
    }
    if (!streamedRef.current) return;
    streamedRef.current = false;
    // A turn that ended in onError already played the 'error' cue; don't also
    // play 'complete' (onDone still fires after a stream error).
    const errored = turnErroredRef.current;
    turnErroredRef.current = false;
    if (!errored) playSound('complete');
    const prompt = lastPromptRef.current.trim();
    // Truncate to a card-friendly length. Newlines collapse to spaces so a
    // multi-line prompt still reads as one glance-able summary.
    const oneline = prompt.replace(/\s+/g, ' ');
    const preview = oneline.length > 140 ? oneline.slice(0, 140) + '…' : oneline;
    notify({
      title: preview || 'Macaron · session ready',
      body: preview ? '✓ turn finished' : `${sid.slice(0, 8)} finished a turn`,
      tag: `macaron-done-${sid}`,
      project,
      sid,
      onClick: () => onFocusRef.current?.(),
    });
  }, [sending, polling, sid, project]);
  const [liveUser, setLiveUser] = useState<string>('');
  // Raw follow-up text streamed after each turn (a throwaway cache-hit
  // query). Parsed incrementally with partial-json. Deltas can arrive from a
  // stream that a newer send / session switch already superseded (e.g. click
  // a chip and send while the previous follow-up is still streaming), so
  // every producer captures its generation and stale deltas are dropped.
  const [followupRaw, setFollowupRaw] = useState('');
  const followupGen = useRef(0);
  const followups = useMemo(() => parseFollowups(followupRaw), [followupRaw]);
  // The row keeps a reserved slot (so streaming chips don't shove the thread
  // up) ONLY while the feature is on — when it's off there's nothing to wait
  // for, so we collapse the space entirely. Fetched once on mount.
  const [followupsEnabled, setFollowupsEnabled] = useState(false);
  useEffect(() => { api.settings().then((s) => setFollowupsEnabled(s.followupSuggestions)).catch(() => {}); }, []);
  // Clear the chips and invalidate any deltas still streaming from a superseded
  // follow-up query, atomically. Returns the new generation so a producer can
  // capture it as its token; call sites that only need to reset ignore it.
  const resetFollowups = useCallback(() => { setFollowupRaw(''); return ++followupGen.current; }, []);
  // First-turn follow-ups stream over an independent live-store channel that
  // outlives the main turn's `done` (which clears the live store). 2nd+ turns
  // deliver follow-ups via streamSession's onFollowupDelta instead. Not gated
  // on isPending — the canvas path flips it right at `done`, before the
  // follow-up stream even starts.
  useEffect(() => {
    const gen = resetFollowups();
    return subscribeFollowup(sid, (text) => {
      if (followupGen.current !== gen) return;
      setFollowupRaw((prev) => prev + text);
    });
  }, [sid]);
  // Single ordered timeline for the current turn: text chunks and tool
  // calls/permissions are interleaved in the same array so the render
  // matches Claude's actual "text → tool → text → tool" sequencing. Previous
  // implementation kept `liveAssistant: string` separate and rendered it
  // as one block ABOVE `liveTools`, which visually flipped the order.
  type LiveTurnItem = Extract<Item, { kind: 'live-assistant' | 'tool' | 'genui' | 'permission' }>;
  const [liveTurn, setLiveTurn] = useState<LiveTurnItem[]>([]);
  // Cumulative assistant text length across the timeline — the thinking
  // indicator uses this as its len/4 fallback estimate.
  const liveAssistantLen = useMemo(
    () =>
      liveTurn.reduce(
        (sum, it) => (it.kind === 'live-assistant' ? sum + it.text.length : sum),
        0,
      ),
    [liveTurn],
  );
  // -1 = no usage signal yet (Macaron path or pre-first-delta). Indicator
  // falls back to a len/4 estimate when this is < 0.
  const [outputTokens, setOutputTokens] = useState<number>(-1);
  // Images the user attached to the CURRENT in-flight turn. Rendered inline
  // (above the user text) while streaming and rolled into completedTurns on
  // the next send — same pattern as liveUser / liveAssistant / liveTools.
  const [liveUserImages, setLiveUserImages] = useState<AttachedImage[]>([]);
  // Completed turns held in-memory between refreshes. We used to re-fetch the
  // jsonl after each `done` event to promote live buffers into canonical
  // data.messages, but the CLI flushes the jsonl asynchronously — sometimes
  // the file is still stale when we load, and users see the just-streamed
  // reply vanish. Instead: freeze the live buffers into this list on the
  // NEXT send (or on unmount), and let a full page refresh be the only
  // trigger that pulls the canonical data back.
  const [completedTurns, setCompletedTurns] = useState<Item[]>([]);
  const [input, setInput] = useState('');
  // Shell-style prompt history, per project. Latest at the end. Loaded
  // lazily so each new mount picks up entries appended by sibling tiles.
  const [history, setHistory] = useState<string[]>(() => loadHistory(project));
  useEffect(() => { setHistory(loadHistory(project)); }, [project]);
  // Fetch the slash-command list once per project (built-ins + custom
  // `.claude/commands`). Best-effort — a failure just leaves the palette empty.
  useEffect(() => {
    if (!project) return;
    let alive = true;
    api.commands(project).then((r) => { if (alive) setCommands(r.commands); }).catch(() => {});
    return () => { alive = false; };
  }, [project]);
  // Navigation state. null = user is composing a fresh draft; otherwise
  // 0 = latest sent, 1 = one before, … history.length-1 = oldest. When we
  // enter history navigation we stash the draft so ArrowDown-past-latest
  // can restore it.
  const [historyIdx, setHistoryIdx] = useState<number | null>(null);
  const draftInputRef = useRef<string>('');
  // Slash-command palette. `commands` is fetched once per session; the palette
  // opens while the input is a bare `/name` (no space yet) and `slashIdx`
  // tracks the keyboard-highlighted row. The SDK expands the picked `/name` on
  // send, so this is purely a discoverability helper.
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [slashIdx, setSlashIdx] = useState(0);
  const [shown, setShown] = useState(PAGE_SIZE);
  const [permissionMode, setPermissionMode] = useState<PermissionMode>('default');
  // Pull the global default once per mount so a fresh session opens at the
  // mode the user configured in Settings. Only applies when the user hasn't
  // already touched the picker (checked via a ref because the settings call
  // is async and could otherwise stomp a manual change).
  const permissionModeTouchedRef = useRef(false);
  useEffect(() => {
    let alive = true;
    api.settings().then((s) => {
      if (!alive || permissionModeTouchedRef.current) return;
      setPermissionMode(s.defaultPermissionMode);
    }).catch(() => {/* keep 'default' */});
    return () => { alive = false; };
  }, []);
  // Shift+Tab cycles through permission modes globally on the Session view
  // (mirrors claude-cli). The toast surfaces the change since the status bar
  // may be off-screen when the user scrolls up through history.
  const permissionModeRef = useRef<PermissionMode>('default');
  permissionModeRef.current = permissionMode;
  const [images, setImages] = useState<AttachedImage[]>([]);
  // New-session-only: run the first turn in a dedicated git worktree+branch so
  // parallel sessions in one repo don't share a working tree. Ignored on resume.
  const [isolate, setIsolate] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const threadRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const composingRef = useRef(false);
  const compositionEndedAtRef = useRef(0);
  const toast = useToast();
  const confirm = useConfirm();
  const [busyCompact, setBusyCompact] = useState(false);
  const [busyRewind, setBusyRewind] = useState(false);
  const [busyFork, setBusyFork] = useState(false);
  const [busyPr, setBusyPr] = useState(false);
  // Non-null while the Create-PR dialog is open; holds the git snapshot used
  // to prefill and gate it.
  const [prCtx, setPrCtx] = useState<PrContext | null>(null);
  // @-mention file autocomplete over the project tree. Inserts `@relpath`
  // tokens the CLI resolves natively; no server-side prompt rewriting.
  const mention = useFileMention({ project, value: input, setValue: setInput, textareaRef, composingRef });
  // Messages the user lined up while the current turn was still streaming.
  // Auto-sent one at a time as each turn completes (see the dequeue effect).
  const [queue, setQueue] = useState<QueuedMessage[]>([]);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const accepted: AttachedImage[] = [];
    for (const f of Array.from(files)) {
      if (!f.type.startsWith('image/')) continue;
      if (f.size > MAX_IMAGE_BYTES) {
        toast(`${f.name}: too big (>${(MAX_IMAGE_BYTES / 1024 / 1024).toFixed(0)} MB)`);
        continue;
      }
      const dataUrl: string = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result || ''));
        r.onerror = () => rej(r.error);
        r.readAsDataURL(f);
      }).catch((e) => { toast(`${f.name}: read failed (${(e as Error).message})`); return ''; });
      if (!dataUrl) continue;
      accepted.push({ id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: f.name, mimeType: f.type, dataUrl });
    }
    if (accepted.length) setImages((cur) => [...cur, ...accepted]);
  }, [toast]);

  // Rewind: drop the picked message + everything after it. Server backs up
  // the discarded tail to a .rewind-<ts>.jsonl.bak sibling so it's
  // recoverable. Fresh jsonl means we drop completedTurns too and reload.
  const handleRewind = useCallback(
    async (uuid: string) => {
      if (busyRewind) return;
      const ok = await confirm({
        title: 'Rewind to before this message?',
        body: (
          <>
            This message and every reply / tool call after it will be removed
            from the transcript. A backup is kept next to the jsonl.
          </>
        ),
        confirmLabel: 'Rewind',
        destructive: true,
      });
      if (!ok) return;
      setBusyRewind(true);
      try {
        const r = await api.rewindSession(project, sid, uuid);
        setCompletedTurns([]);
        setLiveUser('');
        setLiveTurn([]);
        const d = await api.session(project, sid);
        setData(d);
        setShown(PAGE_SIZE);
        toast(`Rewound · dropped ${r.dropped} lines`);
      } catch (e) {
        toast(`rewind failed: ${(e as Error).message}`);
      } finally {
        setBusyRewind(false);
      }
    },
    [busyRewind, confirm, project, sid, toast],
  );

  // Fork: non-destructive branch. Copy the transcript up to (excluding) the
  // picked message into a fresh sid and navigate there — Workspace pins it as
  // a new focused tile. The original session is untouched, so no confirm.
  const handleFork = useCallback(
    async (uuid: string) => {
      if (busyFork) return;
      setBusyFork(true);
      try {
        const r = await api.forkSession(project, sid, uuid);
        toast(`forked → ${r.newSid.slice(0, 8)}`);
        navigate(`/w/${encodeURIComponent(project)}/s/${encodeURIComponent(r.newSid)}`);
      } catch (e) {
        toast(`fork failed: ${(e as Error).message}`);
      } finally {
        setBusyFork(false);
      }
    },
    [busyFork, navigate, project, sid, toast],
  );

  // Compact: replace the transcript with a provider-generated recap.
  const handleCompact = useCallback(async () => {
    if (busyCompact) return;
    const ok = await confirm({
      title: 'Compact this session?',
      body: (
        <>
          The current transcript will be replaced with a single recap
          paragraph generated by your active provider. A full backup is kept
          next to the jsonl.
        </>
      ),
      confirmLabel: 'Compact',
      destructive: true,
    });
    if (!ok) return;
    setBusyCompact(true);
    try {
      await api.compactSession(project, sid);
      setCompletedTurns([]);
      setLiveUser('');
      setLiveTurn([]);
      const d = await api.session(project, sid);
      setData(d);
      setShown(PAGE_SIZE);
      toast('Session compacted');
    } catch (e) {
      toast(`compact failed: ${(e as Error).message}`);
    } finally {
      setBusyCompact(false);
    }
  }, [busyCompact, confirm, project, sid, toast]);

  // Create PR: fetch the git snapshot for this session's cwd, then open the
  // dialog prefilled from the first user prompt. Gating (default branch, no
  // commits ahead, existing PR) is surfaced inside the dialog.
  const handleOpenPr = useCallback(async () => {
    if (busyPr) return;
    setBusyPr(true);
    try {
      const ctx = await api.prContext(project, sid);
      setPrCtx(ctx);
    } catch (e) {
      toast(`couldn't read git state: ${(e as Error).message}`);
    } finally {
      setBusyPr(false);
    }
  }, [busyPr, project, sid, toast]);

  const handleCreatePr = useCallback(
    async (input: { title: string; body: string; draft: boolean }) => {
      setBusyPr(true);
      try {
        const { url, created } = await api.createPr(project, sid, input);
        setPrCtx(null);
        toast(created ? 'Pull request opened' : 'PR already exists — opening it');
        window.open(url, '_blank', 'noopener');
      } catch (e) {
        toast(`create PR failed: ${(e as Error).message}`);
      } finally {
        setBusyPr(false);
      }
    },
    [project, sid, toast],
  );

  // Prefill for the PR dialog, derived from the first real user prompt. Title
  // = its first line (capped); body = a short recap pointing back at Macaron.
  const firstPrompt = useMemo(() => {
    for (const m of data?.messages ?? []) {
      if (m.role !== 'user') continue;
      const text = m.blocks.filter((b) => b.kind === 'text').map((b) => (b as { text: string }).text).join('\n').trim();
      if (text && !isNoisyUserText(text)) return text;
    }
    return '';
  }, [data]);
  const prTitle = useMemo(() => {
    const line = (firstPrompt.split('\n')[0] || prCtx?.branch || 'Update').trim();
    return line.length > 72 ? `${line.slice(0, 69)}…` : line;
  }, [firstPrompt, prCtx]);
  const prBody = useMemo(() => {
    const recap = firstPrompt ? `${firstPrompt}\n\n` : '';
    return `${recap}---\n_Opened from a Macaron session._`;
  }, [firstPrompt]);

  // Export: serialize the loaded transcript to Markdown and download it —
  // client-side, no server round-trip (we already hold the parsed messages).
  const handleExport = useCallback(() => {
    if (!data) return;
    const md = sessionToMarkdown(data);
    const name = `${basename(data.cwd) || 'session'}-${sid.slice(0, 8)}.md`;
    downloadTextFile(name, md);
    toast(`Exported ${name}`);
  }, [data, sid, toast]);

  // Permission decision: POST to server; server resolves the pending
  // canUseTool promise. Optimistically update the local card so it doesn't
  // linger in "pending" — the server will echo a permission_resolved event
  // that overwrites the same status field anyway.
  const handlePermissionDecide = useCallback(
    (permissionId: string, decision: 'allow' | 'deny', arg?: PermissionMode | 'once' | 'session' | 'always') => {
      setLiveTurn((cur) =>
        cur.map((t) =>
          t.kind === 'permission' && t.permissionId === permissionId
            ? { ...t, status: decision }
            : t,
        ),
      );
      // The 3rd arg is either a plan-mode (from PlanApprovalItem) or a remember-scope
      // (from PermissionItem) — disjoint value sets, so route by value.
      const mode = arg === 'default' || arg === 'acceptEdits' || arg === 'plan' || arg === 'bypassPermissions' ? arg : undefined;
      const scope = arg === 'once' || arg === 'session' || arg === 'always' ? arg : undefined;
      // A plan approval switches the session out of plan mode (server-side via
      // setMode). Mirror that in the local mode state so the next send() and
      // the status bar reflect it — otherwise the composer would silently
      // re-enter plan mode on the following turn.
      if (decision === 'allow' && mode) { permissionModeTouchedRef.current = true; setPermissionMode(mode); }
      api.permissionDecision(permissionId, decision, { scope, mode }).catch((e) => {
        toast(`permission ${decision} failed: ${(e as Error).message}`);
      });
    },
    [toast],
  );

  // Stop: signal the server to abort the in-flight SDK stream for this
  // session. The SSE will close as a result and `sending` flips off via
  // the existing `done` handler.
  const handleStop = useCallback(async () => {
    if (!sid) return;
    // Mark the abort as user-initiated before requesting it, so the error
    // that comes back over the SSE is recognised as a Stop, not a failure,
    // and its cue is suppressed. (turnErroredRef still trips, so the
    // trailing completion effect stays silent too.)
    stoppingRef.current = true;
    try {
      await api.stopSession(project, sid);
      toast('Stop requested');
    } catch (e) {
      toast(`stop failed: ${(e as Error).message}`);
    }
  }, [project, sid, toast]);

  const commitSnapshot = useCallback((next: SessionDetail, clearLiveOverlay = false) => {
    setData(next);
    setShown(PAGE_SIZE);
    setCompletedTurns([]);
    if (clearLiveOverlay) {
      // Commit the authoritative snapshot and retire every volatile source in
      // the same React batch. Rendering data first and clearing live after an
      // await exposes both copies for a frame.
      setLiveUser('');
      setLiveTurn([]);
      setLiveUserImages([]);
      setOutputTokens(-1);
    }
  }, []);

  const fetchSnapshot = useCallback(() => api.session(project, sid), [project, sid]);

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setError('');
    try {
      const d = await fetchSnapshot();
      commitSnapshot(d);
      return d;
    } catch (e) {
      if (!opts?.silent) setError((e as Error).message);
      return null;
    }
  }, [commitSnapshot, fetchSnapshot]);

  const refreshFromDisk = useCallback(async () => {
    const generation = ++snapshotHandoffGen.current;
    setError('');
    try {
      const next = await fetchSnapshot();
      if (snapshotHandoffGen.current !== generation) return;
      const liveTurn = pendingSnapshotTurn.current ?? directSnapshotTurn.current;
      if (liveTurn && !snapshotCoversLiveTurn(next.messages, liveTurn)) {
        setError('Transcript is still flushing; the complete live turn was kept visible.');
        return;
      }
      pendingSnapshotTurn.current = null;
      directSnapshotTurn.current = null;
      commitSnapshot(next, true);
      clearLive(sid, directTurnStartedAt.current);
    } catch (e) {
      if (snapshotHandoffGen.current === generation) setError((e as Error).message);
    }
  }, [commitSnapshot, fetchSnapshot, sid]);

  // Pick exactly one source for the current turn. A freshly-created session
  // already has startNewSession's POST reader writing to liveStore; opening a
  // second /live reader would replay and append every token again. On a true
  // page refresh the module store is empty, so probe /live first and only load
  // the canonical jsonl when the server confirms there is no active stream.
  useEffect(() => {
    const refreshRequested = refreshKey !== lastRefreshKey.current.refreshKey
      || reconnectKey !== lastRefreshKey.current.reconnectKey;
    lastRefreshKey.current = { refreshKey, reconnectKey };
    // Canvas refresh is a source switch. Ignore a stale/programmatic click
    // while a direct POST, reattach, or snapshot handoff still owns the turn.
    if (refreshRequested && (sending || polling || handoffPending)) return;
    // If automatic handoff exhausted its retry window, a later tile refresh
    // must still pass the same completeness gate instead of dropping the live
    // overlay and loading a stale/partial snapshot.
    if (refreshRequested && (pendingSnapshotTurn.current || directSnapshotTurn.current)) {
      void refreshFromDisk();
      return;
    }
    snapshotHandoffGen.current += 1;
    pendingSnapshotTurn.current = null;
    directSnapshotTurn.current = null;
    directTurnStartedAt.current = undefined;
    if (!refreshRequested) liveDisconnected.current = false;
    setHandoffPending(false);
    setData(null);
    setLiveTurn([]);
    setLiveUser('');
    setShown(PAGE_SIZE);
    setReattached(false);
    if (isNew || !sid) return;

    const local = getLive(sid);
    if (local) {
      setReattached(true);
      setSending(!local.done);
      if (liveDisconnected.current) {
        liveDisconnected.current = false;
        setLiveSubscriptionGen((generation) => generation + 1);
      }
      return;
    }

    let cancelled = false;
    void attachLive(project, sid).then((r) => {
      if (cancelled) return;
      if (r === 'attached') {
        // A buffered ended replay can reach `done` and be consumed by the
        // pending subscription before this promise callback runs. Re-read the
        // store instead of reviving a stream that has already been cleared.
        const current = getLive(sid);
        if (!current) {
          setReattached(false);
          setPolling(false);
          setSending(false);
          return;
        }
        setReattached(true);
        setSending(!current.done);
        if (liveDisconnected.current) {
          liveDisconnected.current = false;
          setLiveSubscriptionGen((generation) => generation + 1);
        }
        return;
      }
      void load({ silent: true }).finally(() => {
        if (!cancelled) { setPolling(false); setSending(false); }
      });
    });
    return () => { cancelled = true; };
  }, [project, sid, load, isNew, refreshKey, reconnectKey, refreshFromDisk]);

  // Global Shift+Tab → cycle permission mode, matching claude-cli's binding.
  // The browser's own "reverse focus" behaviour is preempted; we surface the
  // switch via toast because the status bar might be scrolled out of view.
  useEffect(() => {
    const CYCLE: PermissionMode[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];
    const LABELS: Record<PermissionMode, string> = {
      default: 'Default (ask)',
      acceptEdits: 'Accept edits',
      plan: 'Plan mode',
      bypassPermissions: 'Bypass all',
    };
    const onKey = (e: Event) => {
      if (!focused || hasActiveModal()) return; // canvas tiles only respond when active and no modal is covering them
      const ke = e as unknown as { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean; altKey: boolean; preventDefault: () => void };
      if (ke.key !== 'Tab' || !ke.shiftKey || ke.ctrlKey || ke.metaKey || ke.altKey) return;
      ke.preventDefault();
      const cur = permissionModeRef.current;
      const next = CYCLE[(CYCLE.indexOf(cur) + 1) % CYCLE.length]!;
      permissionModeTouchedRef.current = true;
      setPermissionMode(next);
      toast(`Permission → ${LABELS[next]}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toast, focused]);

  // When we arrived from "+ New session", the in-browser live store already
  // has the fetch open and is collecting deltas (this survived the route
  // change, unlike the previous Workspace-local fetch). Subscribe and render.
  useEffect(() => {
    if (!isPending) return;
    setPolling(true);
    // Seed from whatever has already arrived before this view mounted.
    const seed = getLive(sid);
    const applyState = (s: typeof seed) => {
      if (!s) return;
      setLiveUser(s.userText);
      setOutputTokens(s.outputTokens);
      // Rehydrate image chips on the user bubble — needed on a
      // draft→real remount where local liveUserImages state was reset.
      // Only apply when we have images AND the local state is empty, so
      // we don't clobber a locally-owned attachment mid-turn.
      if (s.userImages?.length) {
        setLiveUserImages((cur) =>
          cur.length > 0
            ? cur
            : s.userImages.map((img, i) => ({
                id: `hydrated-${i}`,
                name: '',
                mimeType: img.mimeType,
                dataUrl: img.dataUrl,
              })),
        );
      }
      // Project liveStore timeline → Session Item shape (fresh objects so
      // React notices identity changes even when the underlying entry was
      // mutated in-place).
      setLiveTurn(
        s.timeline.map((t) => {
          if (t.kind === 'genui') {
            return {
              id: `genui-${t.toolUseId}`,
              kind: 'genui' as const,
              toolUseId: t.toolUseId,
              prompt: 'TSX rendering…',
              code: t.code || undefined,
              status: t.status,
              error: t.error,
            };
          }
          if (t.kind === 'permission') {
            return {
              id: t.id,
              kind: 'permission' as const,
              permissionId: t.permissionId,
              toolName: t.toolName,
              input: t.input,
              suggestion: t.suggestion,
              status: t.status,
            };
          }
          if (t.kind === 'tool') {
            return {
              id: t.id,
              kind: 'tool' as const,
              name: t.name,
              input: t.input,
              result: t.result,
            };
          }
          return {
            id: t.id,
            kind: 'live-assistant' as const,
            text: t.text,
          };
        }),
      );
    };
    const finishLive = (finished: NonNullable<typeof seed>) => {
      const turn = fingerprintLiveTurn(finished);
      const generation = ++snapshotHandoffGen.current;
      pendingSnapshotTurn.current = turn;
      setPolling(false);
      setSending(false);
      setHandoffPending(true);
      setReattached(false);
      liveDisconnected.current = false;
      clearLive(sid);
      onPendingConsumed?.();
      // Poll without publishing intermediate snapshots. JSONL can briefly
      // contain only old history or the new user line; neither is allowed to
      // coexist with (or replace) the complete live turn.
      const swap = async () => {
        try {
          for (let attempt = 0; attempt < 6; attempt++) {
            if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
            const d = await fetchSnapshot().catch(() => null);
            if (snapshotHandoffGen.current !== generation) return;
            if (d && snapshotCoversLiveTurn(d.messages, turn)) {
              pendingSnapshotTurn.current = null;
              commitSnapshot(d, true);
              return;
            }
          }
        } finally {
          if (snapshotHandoffGen.current === generation) setHandoffPending(false);
        }
      };
      void swap();
    };
    if (seed) {
      applyState(seed);
      // The retained replay can finish before attachLive's promise callback
      // enables this subscription. Consume that terminal snapshot immediately
      // instead of waiting for a future notification that will never arrive.
      if (seed.done) {
        if (seed.terminalSeen) finishLive(seed);
        else {
          setPolling(false);
          setSending(false);
          setReattached(false);
          liveDisconnected.current = true;
          discardLive(sid);
          setError('Live stream disconnected before completion. Refresh to reconnect.');
        }
        return;
      }
    }
    let rafScheduled = false;
    let pendingState = seed;
    const flush = () => {
      rafScheduled = false;
      applyState(pendingState);
    };
    const unsub = subscribeLive(sid, (s) => {
      pendingState = s;
      if (s.done) {
        applyState(s);
        unsub();
        // Keep the live buffers mounted while finishLive restores canonical
        // history. The CLI may still be flushing jsonl, so that reload must not
        // replace the just-streamed turn.
        if (s.terminalSeen) finishLive(s);
        else {
          setPolling(false);
          setSending(false);
          setReattached(false);
          liveDisconnected.current = true;
          discardLive(sid);
          setError('Live stream disconnected before completion. Refresh to reconnect.');
        }
        // Follow-up suggestions stream AFTER `done` over an independent
        // channel (subscribeFollowup), so clearing the live store here is
        // safe — the stop semantics are identical to before the feature.
        // Let the parent (draft-tile owner) drop this sid from its
        // pending set so a later refresh doesn't re-enter this branch.
        return;
      }
      if (!rafScheduled) {
        rafScheduled = true;
        requestAnimationFrame(flush);
      }
    });
    return () => {
      unsub();
    };
  }, [commitSnapshot, fetchSnapshot, isPending, liveSubscriptionGen, sid, onPendingConsumed]);

  const rawItems = useMemo(() => (data ? flatten(data.messages) : []), [data]);
  // Collapse consecutive read-only tool operations (Read / Grep / Glob /
  // cat / grep / ls / …) into a single summary badge, mirroring Claude
  // Code CLI's `⏺ Searching for N patterns, reading M files, listing K
  // directories…` line. Destructive tools (Edit / Write / Bash mutations)
  // and non-tool items break the group so nothing important gets hidden.
  const items = useMemo(() => collapseReadSearchGroups(rawItems) as Item[], [rawItems]);
  const total = items.length;
  const hidden = Math.max(0, total - shown);
  const tail = items.slice(-shown);

  // Opening an already-idle session (last item is an assistant reply, nothing
  // streaming) surfaces follow-ups too — not only the instant a turn ends.
  // Fires once per sid: after our OWN turn `onDone` flips `sending` false while
  // the message stream is still open, so without this latch the effect would
  // re-run and fire a duplicate /followups query — bumping the generation and
  // starving the in-flight post-turn deltas. sid change ⇒ remount ⇒ ref resets.
  const lastItemKind = items[items.length - 1]?.kind;
  const idleFollowupFired = useRef(false);
  useEffect(() => {
    if (isNew || isPending || sending || polling || handoffPending) return;
    if (lastItemKind !== 'assistant' || followupRaw || idleFollowupFired.current) return;
    idleFollowupFired.current = true;
    const gen = ++followupGen.current;
    void streamSession(
      `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/followups`,
      {},
      { onFollowupDelta: (t) => { if (followupGen.current === gen) setFollowupRaw((prev) => prev + t); } },
    );
  }, [project, sid, isNew, isPending, sending, polling, handoffPending, lastItemKind]);

  // Latest TodoWrite snapshot (flatten dedupes to keep only one at any time).
  // The status bar mirrors the current in-progress task + progress fraction.
  const currentTodo = useMemo(() => {
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i]!;
      if (it.kind === 'todo') {
        const inProg = it.todos.find((t) => t.status === 'in_progress');
        const done = it.todos.filter((t) => t.status === 'completed').length;
        if (!inProg) return null;
        return {
          text: inProg.activeForm || inProg.content,
          done,
          total: it.todos.length,
        };
      }
    }
    return null;
  }, [items]);

  // Note: no auto-scroll useEffect. The thread uses flex-direction:
  // column-reverse so the browser anchors scroll at the visual bottom
  // automatically — new content pushes existing content up without us
  // touching scrollTop. The user can freely scroll up to read history.

  const cwd = data?.cwd || '';
  const name = cwd ? basename(cwd) : 'Session';
  // Session start time from the earliest message timestamp — mirrors the CLI's
  // "cwd (elapsed)" header. Null before any messages arrive.
  const startedAt = useMemo(() => {
    const first = data?.messages?.find((m) => m.timestamp);
    if (!first?.timestamp) return null;
    const t = new Date(first.timestamp).getTime();
    return Number.isFinite(t) ? t : null;
  }, [data]);

  // Snapshot the current live buffers (from the last completed turn) into
  // completedTurns, then reset live state for the next turn. Called just
  // before we start streaming a new message so users don't lose the
  // previous turn's assistant reply/tools when they type another prompt.
  const rollLiveIntoHistory = useCallback(() => {
    const frozen: Item[] = [];
    const ts = Date.now();
    // Freeze the user turn (images + text) into ONE Item so it renders as
    // a single card in history — matches how a page-refresh load groups
    // them via flatten() from the jsonl.
    const parts: MsgPart[] = [];
    for (const img of liveUserImages) {
      const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
      const mimeType = m?.[1] || img.mimeType || 'image/png';
      const data = m?.[2] || '';
      if (data) parts.push({ kind: 'image', mimeType, data });
    }
    if (liveUser) parts.push({ kind: 'text', text: liveUser });
    if (parts.length) frozen.push({ id: `hist-u-${ts}`, kind: 'user', parts });
    // Walk the timeline in order — convert `live-assistant` chunks into
    // final `assistant` items so completedTurns rendering is uniform.
    for (const it of liveTurn) {
      if (it.kind === 'live-assistant') {
        if (it.text) frozen.push({ id: `${it.id}-hist`, kind: 'assistant', text: it.text });
      } else {
        frozen.push(it);
      }
    }
    if (frozen.length) setCompletedTurns((cur) => [...cur, ...frozen]);
    setLiveUser('');
    setLiveTurn([]);
    setLiveUserImages([]);
    setOutputTokens(-1);
  }, [liveUser, liveTurn, liveUserImages]);

  const send = useCallback(
    async (opts?: {
      text?: string;
      images?: AttachedImage[];
      permissionMode?: PermissionMode;
      isolate?: boolean;
    }) => {
      // `opts` present = programmatic send (auto-dequeue / send-now / the
      // $macaron/chat bridge) with the given text; absent = the user submitting
      // the composer's current draft. permissionMode/isolate overrides let the
      // seed path apply the Home landing's picks without racing setState.
      const text = (opts?.text ?? input).trim();
      const sentImages = opts ? (opts.images ?? []) : images;
      const effectivePermissionMode = opts?.permissionMode ?? permissionMode;
      const effectiveIsolate = opts?.isolate ?? isolate;
      if ((!text && sentImages.length === 0) || sending) return;
      if (!opts) {
        mention.close();
        setInput('');
        setImages([]);
        setHistoryIdx(null);
        draftInputRef.current = '';
      }
      // New turn ⇒ new follow-up generation: clears the chips and invalidates
      // any deltas still streaming from the previous turn's follow-up query.
      const fGen = resetFollowups();
      // Any pending snapshot handoff belongs to the previous turn. Also allow
      // a remount to attach to the fresh server ring for this send instead of
      // treating the prior ended ring's tombstone as current.
      snapshotHandoffGen.current += 1;
      pendingSnapshotTurn.current = null;
      setHandoffPending(false);
      directTurnStartedAt.current = undefined;
      const directTurn: LiveTurnFingerprint | null = isNew
        ? null
        : {
            startedAt: Date.now(),
            userText: text,
            userImages: sentImages.map((image) => ({ mimeType: image.mimeType, dataUrl: image.dataUrl })),
            assistantText: '',
            toolUseIds: [],
            resolvedToolUseIds: [],
            terminalSeen: false,
          };
      directSnapshotTurn.current = directTurn;
      // Persist to prompt history (manual and queued sends alike).
      const nextHistory = pushHistory(project, text);
      setHistory(nextHistory);
      lastPromptRef.current = text;
      // Roll the *previous* turn's live buffers into history before we
      // clobber them with this turn's user text — otherwise typing a second
      // message erases the first reply until the next page refresh.
      rollLiveIntoHistory();
      setSending(true);
      // First send in a session triggers a permission request — one-time
      // per user, cached across sessions. Silently no-ops if denied.
      void ensureNotificationPermission();
      // Live text is just what the user typed; images render inline via
      // liveUserImages instead of a placeholder string.
      setLiveUser(text);
      setLiveUserImages(sentImages);
      setLiveTurn([]);
      setOutputTokens(-1);
      // Fresh turn: clear the Stop latch so a prior Stop can't suppress
      // this turn's error cue. (turnErroredRef is cleared by the completion
      // effect when the previous turn settled.)
      stoppingRef.current = false;

      if (isNew) {
        // First message of a brand-new session. liveStore opens the SSE,
        // buffers deltas, and resolves with the real sid as soon as meta lands.
        // Peek the directory-picker cwd without consuming it so a failed first
        // send can be retried against the same chosen folder.
        const pendingCwd = peekPendingCwd(project);
        try {
          const newSid = await startNewSession(project, {
            text,
            permissionMode: effectivePermissionMode,
            images: sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
            isolate: effectiveIsolate,
            // Directory-picker path: start this brand-new session in the chosen
            // folder. Undefined for sessions opened inside an existing workspace.
            cwd: pendingCwd,
          });
          takePendingCwd(project);
          if (onCreated) {
            // Canvas draft-tile path: hand the real sid to the parent so it
            // can swap the draft sentinel in place. Session then remounts
            // with the real sid + `initialPending=true` and picks up the
            // in-flight SSE stream via subscribeLive.
            onCreated(newSid);
          } else {
            // Standalone /s/new route: navigate keeps the existing behaviour.
            navigate(
              `/w/${encodeURIComponent(project)}/s/${encodeURIComponent(newSid)}`,
              { replace: true, state: { pending: true } },
            );
          }
        } catch (err) {
          toast(`error: ${(err as Error).message}`);
          setSending(false);
        }
        return;
      }

      await streamSession(
        `/api/sessions/claude/${encodeURIComponent(project)}/${encodeURIComponent(sid)}/message`,
        {
          text,
          permissionMode: effectivePermissionMode,
          images: sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl })),
        },
        {
          onMeta: (meta) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            if (typeof meta.startedAt === 'number') {
              directTurnStartedAt.current = meta.startedAt;
              directTurn.startedAt = meta.startedAt;
            }
          },
          onDelta: (t) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            directTurn.assistantText += t;
            setLiveTurn((cur) => {
              const last = cur[cur.length - 1];
              if (last?.kind === 'live-assistant') {
                return [
                  ...cur.slice(0, -1),
                  { ...last, text: last.text + t },
                ];
              }
              return [
                ...cur,
                { id: `live-a-${Date.now()}-${cur.length}`, kind: 'live-assistant', text: t },
              ];
            });
          },
          onToolUse: ({ id, name, input: toolInput }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            directTurn.toolUseIds.push(id);
            setLiveTurn((cur) =>
              isRenderUITool(name)
                ? [
                    ...cur,
                    { id: `genui-${id}`, kind: 'genui', toolUseId: id, prompt: 'TSX rendering…', status: 'pending' },
                  ]
                : [
                    ...cur,
                    { id: `live-${id}`, kind: 'tool', name, input: toolInput },
                  ],
            );
          },
          onToolInputDelta: ({ id, name, accumulated }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            if (!isRenderUITool(name)) return;
            const partial = extractPartialCode(accumulated);
            if (!partial) return;
            setLiveTurn((cur) =>
              cur.map((t) =>
                t.kind === 'genui' && t.toolUseId === id && (!t.code || partial.length > t.code.length)
                  ? { ...t, code: partial }
                  : t,
              ),
            );
          },
          onToolInputDone: ({ id, name, final_json }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            try {
              const obj = JSON.parse(final_json);
              if (isRenderUITool(name) && typeof obj?.code === 'string') {
                setLiveTurn((cur) =>
                  cur.map((t) =>
                    t.kind === 'genui' && t.toolUseId === id
                      ? { ...t, status: 'ready', code: obj.code }
                      : t,
                  ),
                );
              } else if (isDiffTool(name)) {
                setLiveTurn((cur) =>
                  cur.map((t) => (t.kind === 'tool' && t.id === `live-${id}` ? { ...t, input: obj } : t)),
                );
              }
            } catch { /* tolerate parse fail; stream still delivers */ }
          },
          onPermissionRequest: ({ id, toolName, input, suggestion }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            // Nudge the user via native notification when a tool needs
            // approval — otherwise a session in a background tab can
            // silently stall. requireInteraction keeps it visible until
            // acted on.
            playSound('permission');
            notify({
              title: 'Macaron · permission needed',
              body: `${toolName} wants to run` + (
                typeof (input as { command?: string })?.command === 'string'
                  ? `: ${(input as { command?: string }).command!.slice(0, 80)}`
                  : ''
              ),
              tag: `macaron-perm-${sid}`,
              requireInteraction: true,
              project,
              sid,
              onClick: () => onFocusRef.current?.(),
            });
            setLiveTurn((cur) => [
              ...cur,
              {
                id: `perm-${id}`,
                kind: 'permission',
                permissionId: id,
                toolName,
                input,
                suggestion,
                status: 'pending',
              },
            ]);
          },
          onPermissionResolved: ({ id, decision }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            setLiveTurn((cur) =>
              cur.map((t) =>
                t.kind === 'permission' && t.permissionId === id ? { ...t, status: decision } : t,
              ),
            );
          },
          onToolResult: ({ tool_use_id, text: resultText, isError }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            if (!directTurn.resolvedToolUseIds.includes(tool_use_id)) {
              directTurn.resolvedToolUseIds.push(tool_use_id);
            }
            setLiveTurn((cur) =>
              cur.map((t) => {
                if (t.kind === 'genui' && t.toolUseId === tool_use_id) {
                  if (isError || resultText.startsWith('render_ui failed:')) {
                    return { ...t, status: 'error', error: resultText.replace(/^render_ui failed:/, '').trim() };
                  }
                  return { ...t, status: 'ready' };
                }
                if (t.kind === 'tool' && (t.id === `live-${tool_use_id}`)) {
                  return { ...t, result: resultText, isError };
                }
                return t;
              }),
            );
          },
          onUsage: ({ outputTokens: ot }) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            setOutputTokens((cur) => (ot > cur ? ot : cur));
          },
          onError: (err) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            turnErroredRef.current = true;
            // A user Stop surfaces here as an error — suppress the error cue
            // in that case (turnErroredRef above already keeps the trailing
            // completion effect silent, so the Stop makes no sound at all).
            if (!stoppingRef.current) playSound('error');
            setLiveTurn((cur) => {
              const last = cur[cur.length - 1];
              const chunk = `\n[error] ${err}`;
              if (last?.kind === 'live-assistant') {
                return [...cur.slice(0, -1), { ...last, text: last.text + chunk }];
              }
              return [
                ...cur,
                { id: `live-a-err-${Date.now()}`, kind: 'live-assistant', text: chunk },
              ];
            });
          },
          onDone: (terminalSeen) => {
            if (!directTurn || directSnapshotTurn.current !== directTurn) return;
            if (terminalSeen) {
              directTurn.terminalSeen = true;
            } else if (!terminalSeen && directTurnStartedAt.current !== undefined) {
              // The server assigned this turn, so a bare EOF means only the
              // browser transport died. Keep the rendered overlay, drop the
              // incomplete disk fingerprint, and let Refresh reattach /live.
              directSnapshotTurn.current = null;
              liveDisconnected.current = true;
              setError('Live stream disconnected before completion. Refresh to reconnect.');
            }
            // Don't re-read the jsonl here — the CLI writes it asynchronously
            // and it's often still stale at this point, which made the
            // just-streamed reply flicker or vanish. Keep the live buffers
            // visible; the next send() rolls them into `completedTurns`,
            // and a page refresh reloads the canonical jsonl.
            setSending(false);
          },
          onFollowupDelta: (t) => {
            if (followupGen.current === fGen) setFollowupRaw((prev) => prev + t);
          },
        },
      );
    },
    [project, sid, input, sending, load, images, permissionMode, isolate, isNew, navigate, toast, onCreated, rollLiveIntoHistory, history, mention.close],
  );

  // Enqueue a message typed while a turn is running. macaron's runner is
  // single-shot (no stdin into the live turn), so we hold it client-side and
  // auto-send it once the turn finishes.
  const enqueue = useCallback((text: string) => {
    const t = text.trim();
    if (!t) return;
    setQueue((q) => [...q, { id: queueId(), text: t }]);
  }, []);

  // Demos and Home flow: a card / the landing composer stashes a prompt via
  // setPendingPrompt(project, ...) before navigating here. On mount of a
  // brand-new session, pop it and either auto-send (default) or drop into the
  // composer as a draft. The seed also carries the images / isolate /
  // permissionMode the sender picked, so the first turn honours them without
  // the user having to re-configure the composer here. Guarded by a ref so a
  // re-render / hook re-fire doesn't double-send.
  const seededPromptRef = useRef(false);
  useEffect(() => {
    if (!isNew || seededPromptRef.current) return;
    const seed = takePendingPrompt(project);
    if (!seed) return;
    seededPromptRef.current = true;
    // Apply UI-facing knobs upfront so the composer chrome reflects the picks
    // even before the first turn resolves. send() takes explicit overrides
    // below to avoid racing these setState calls on the auto path.
    if (seed.permissionMode) { permissionModeTouchedRef.current = true; setPermissionMode(seed.permissionMode); }
    if (seed.isolate !== undefined) setIsolate(seed.isolate);
    const seedImages: AttachedImage[] = (seed.images ?? []).map((img, i) => ({
      id: img.id ?? `seed-img-${i}`,
      name: img.name ?? `image-${i + 1}`,
      mimeType: img.mimeType,
      dataUrl: img.dataUrl,
    }));
    if (seed.auto) {
      // Auto-send path: don't populate the composer. send() uses opts.text
      // directly and the programmatic branch skips setInput('') clean-up —
      // leaving the seed visible for the whole first turn until the user
      // types over it. Fire on the next tick so the initial mount commits
      // before we kick off the SDK call.
      setTimeout(() => {
        void send({
          text: seed.text,
          images: seedImages,
          permissionMode: seed.permissionMode,
          isolate: seed.isolate,
        });
      }, 0);
    } else {
      // Draft path: drop the text into the composer for the user to edit
      // and press Send themselves.
      setInput(seed.text);
      if (seedImages.length > 0) setImages(seedImages);
    }
    // send intentionally excluded — we only fire this on mount, and
    // capturing the identity at mount avoids re-firing when send changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project, isNew]);

  // The composer's submit path: while a turn runs, Enter/Send queues the text
  // instead of being blocked; when idle it sends immediately. Images ride the
  // immediate path only (first increment), so they stay attached while busy.
  const submitComposer = useCallback(() => {
    const text = input.trim();
    if (!text && images.length === 0) return;
    if (sending) {
      if (!text) return; // nothing queueable (images can't be queued yet)
      enqueue(text);
      mention.close();
      setInput('');
      setHistoryIdx(null);
      draftInputRef.current = '';
      return;
    }
    void send();
  }, [input, images, sending, enqueue, send, mention.close]);

  // Send now: interrupt the running turn and send this message next. macaron's
  // only interrupt primitive is /stop (abort the subprocess), so we push the
  // text to the FRONT of the queue and stop — the idle-edge dequeue effect
  // below then sends it first. Graceful mid-tool steer would need the SDK's
  // streaming-input mode, which the single-shot runner doesn't use (follow-up).
  const handleSendNow = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    setQueue((q) => [{ id: queueId('q-now'), text }, ...q]);
    mention.close();
    setInput('');
    setHistoryIdx(null);
    draftInputRef.current = '';
    void handleStop();
  }, [input, handleStop, mention.close]);

  const removeQueued = useCallback((id: string) => {
    setQueue((q) => q.filter((m) => m.id !== id));
  }, []);

  const moveQueued = useCallback((id: string, dir: -1 | 1) => {
    setQueue((q) => {
      const i = q.findIndex((m) => m.id === id);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= q.length) return q;
      const next = [...q];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });
  }, []);

  // Edit a queued message: pull it back into the composer (removing it from
  // the queue). If the composer already holds a draft, keep that safe by
  // prepending it back onto the queue front.
  const editQueued = useCallback((id: string) => {
    mention.close();
    setQueue((q) => {
      const target = q.find((m) => m.id === id);
      if (!target) return q;
      const rest = q.filter((m) => m.id !== id);
      const draft = input.trim();
      setInput(target.text);
      if (draft) return [{ id: queueId('q-draft'), text: draft }, ...rest];
      return rest;
    });
  }, [input, mention.close]);

  // Idle-edge dequeue: when a turn finishes (running true→false), auto-send the
  // next queued message. Edge-guarded so exactly one message goes per turn —
  // send() flips `sending` back to true synchronously, re-arming the guard.
  const runningRef = useRef(false);
  useEffect(() => {
    const running = sending || polling;
    const wasRunning = runningRef.current;
    runningRef.current = running;
    if (wasRunning && !running && queue.length > 0) {
      const [head, ...rest] = queue;
      setQueue(rest);
      void send({ text: head!.text });
    }
  }, [sending, polling, queue, send]);

  // Chat bridge: a sandboxed render_ui widget imports sendUserMessage from
  // '$macaron/chat', and the shim (web/public/genui-shim/chat.mjs) dispatches
  // the payload to this host global slot ('$app/chat'), which relays it into
  // send() as a programmatic user turn. Only the focused session registers —
  // canvas multi-tile mounts share one slot, so the widget the user is actually
  // looking at owns the bridge.
  useEffect(() => {
    if (!focused) return;
    const g = globalThis as unknown as {
      '$app/chat'?: (prompt: string) => void;
      sendUserMessage?: (prompt: string) => void;
    };
    const bridge = (prompt: string) => { void send({ text: prompt }); };
    g['$app/chat'] = bridge;
    // Also expose sendUserMessage as a bare global for widgets that forget
    // to `import { sendUserMessage } from '$macaron/chat'` — models drop the
    // import surprisingly often, and the resulting ReferenceError is fatal
    // to the whole onClick with no path to recover at runtime.
    g.sendUserMessage = bridge;
    return () => {
      if (g['$app/chat'] === bridge) delete g['$app/chat'];
      if (g.sendUserMessage === bridge) delete g.sendUserMessage;
    };
  }, [focused, send]);

  // ---- Slash palette derivation + keyboard reconciliation ----------------
  // Open only while the input is a bare `/word` — leading slash, no space yet
  // (still typing the command name). `slashQuery` is everything after the `/`.
  const slashQuery = input.startsWith('/') && !input.includes(' ') ? input.slice(1) : null;
  const filteredCommands = useMemo(() => {
    if (slashQuery === null) return [];
    const q = slashQuery.toLowerCase();
    return commands.filter(
      (c) => c.name.toLowerCase().includes(q) || (c.namespace ?? '').toLowerCase().includes(q),
    );
  }, [commands, slashQuery]);
  const paletteOpen = slashQuery !== null && filteredCommands.length > 0;
  // Clamp / reset the highlight whenever the filtered set changes.
  useEffect(() => { setSlashIdx(0); }, [slashQuery]);

  const pickCommand = useCallback((cmd: SlashCommand) => {
    // Insert `/name ` (trailing space) and keep focus. The SDK expands it on
    // send; the trailing space both closes the palette and readies args.
    setInput(`/${cmd.name} `);
    setHistoryIdx(null);
  }, []);

  // Returns true if the palette consumed the key (so the composer's own
  // handler must not also act on it). Only called while the palette is open.
  const handlePaletteKey = (e: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (e.nativeEvent.isComposing || composingRef.current) return false;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSlashIdx((i) => Math.min(i + 1, filteredCommands.length - 1));
      return true;
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSlashIdx((i) => Math.max(i - 1, 0));
      return true;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const cmd = filteredCommands[slashIdx];
      if (cmd) {
        e.preventDefault();
        pickCommand(cmd);
        return true;
      }
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      // Closing without a pick: append a space so the palette-open predicate
      // (bare `/word`) goes false while keeping what the user typed.
      setInput((v) => (v.startsWith('/') && !v.includes(' ') ? v + ' ' : v));
      return true;
    }
    return false;
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Palette intercepts ↑/↓/Enter/Esc FIRST when open, then falls through
    // untouched — history-nav + send keep their exact behaviour when closed.
    if (paletteOpen && handlePaletteKey(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      // Some IMEs emit the confirming Enter just after compositionend; keep it
      // reserved for candidate selection instead of submitting the prompt.
      if (e.nativeEvent.isComposing || composingRef.current || e.keyCode === 229) return;
      if (compositionEndedAtRef.current > 0 && performance.now() - compositionEndedAtRef.current < 80) {
        e.preventDefault();
        return;
      }
    }
    // Mention popup handles ↑/↓/Enter/Tab/Esc after the IME Enter guard above.
    if (mention.onKeyDown(e)) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submitComposer();
      return;
    }
    // Shell-style history navigation: ArrowUp when already in history mode
    // OR when the textarea is empty / cursor is at position 0 recalls an
    // earlier prompt. Escape bails back to the draft the user was typing.
    if (e.key === 'ArrowUp') {
      const ta = e.currentTarget;
      const canEnter =
        historyIdx !== null || input === '' || ta.selectionStart === 0;
      if (!canEnter || history.length === 0) return;
      e.preventDefault();
      const nextIdx = historyIdx === null ? 0 : Math.min(historyIdx + 1, history.length - 1);
      if (historyIdx === null) draftInputRef.current = input;
      setHistoryIdx(nextIdx);
      setInput(history[history.length - 1 - nextIdx]!);
      return;
    }
    if (e.key === 'ArrowDown') {
      if (historyIdx === null) return;
      e.preventDefault();
      if (historyIdx === 0) {
        setHistoryIdx(null);
        setInput(draftInputRef.current);
        return;
      }
      const nextIdx = historyIdx - 1;
      setHistoryIdx(nextIdx);
      setInput(history[history.length - 1 - nextIdx]!);
      return;
    }
    if (e.key === 'Escape' && historyIdx !== null) {
      e.preventDefault();
      setHistoryIdx(null);
      setInput(draftInputRef.current);
    }
  };

  return (
    <section className="view session-view">
      {!hideBar && (
        <div className="session-bar">
          <div className="session-bar-left">
            <Link to="/" className="crumb-link">Workspaces</Link>
            <span className="sep">›</span>
            <Link to={`/w/${encodeURIComponent(project)}`} className="crumb-link">{name}</Link>
            <span className="sep">›</span>
            <span className="sess-id-crumb" title={isNew ? undefined : sid}>{isNew ? 'new' : (data ? sessionTitle(data) : sid.slice(0, 8))}</span>
            {data?.gitBranch && <span className="sess-branch">{data.gitBranch}</span>}
          </div>
          <div className="session-bar-right">
            {!isNew && (
              <button
                className="ghost small"
                onClick={() => navigator.clipboard.writeText(`claude --resume ${sid}`).then(() => toast(`copied: claude --resume ${sid}`))}
                title="Copy claude --resume command"
              >
                Copy resume
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() => {
                if (liveDisconnected.current) setReconnectKey((key) => key + 1);
                else void refreshFromDisk();
              }}
              title="Refresh"
              aria-label="Refresh"
              disabled={isNew || sending || polling || handoffPending}
            >
              <RefreshCw size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          </div>
        </div>
      )}

      {/*
        flex-direction: column-reverse on .thread. DOM order must be newest →
        oldest. Everything that should appear at the visual TOP (load-earlier
        button, banners, error/empty placeholders) goes at the END of the DOM.
      */}
      <div className="thread tui" ref={threadRef}>
        {(sending || polling) && <ThinkingIndicator assistantLen={liveAssistantLen} outputTokens={outputTokens} />}
        {/* Suggested follow-ups from the throwaway cache-hit query. Rendered
            ABOVE liveTurn in DOM (so BELOW it visually — column-reverse)
            i.e. just above the input area, right under the latest reply.
            Clicking fills the textarea (setInput), doesn't auto-send. The row
            stays mounted (reserving its height) whenever the feature is on so
            chips streaming in never shift the thread; off ⇒ no slot at all. */}
        {followupsEnabled && !isNew && (
          <div className="ti-followups">
            {followups.map((q, i) => (
              <button
                key={`${q}-${i}`}
                className="ti-followup-chip"
                onClick={() => {
                  resetFollowups();
                  setInput(q);
                }}
              >
                {q}
              </button>
            ))}
          </div>
        )}
        {/* Single ordered timeline for the current turn. Items are appended
            to `liveTurn` in exact SSE arrival order, so reversing here
            (thread is column-reverse) puts the newest at the visual bottom
            while preserving relative text/tool interleaving. */}
        {[...liveTurn].reverse().map((t) => (
          <ItemView key={t.id} it={t} onPermissionDecide={handlePermissionDecide} streaming={sending} />
        ))}
        {/* Current-turn user message = one card. Images stack ABOVE the
            text (Claude-web ordering: attachments before prose). */}
        {(liveUser || liveUserImages.length > 0) && (
          <ItemView
            it={{
              id: 'live-u',
              kind: 'live-user',
              parts: [
                ...liveUserImages.map((img) => ({
                  kind: 'image' as const,
                  mimeType: img.mimeType,
                  data: /^data:[^;]+;base64,(.*)$/.exec(img.dataUrl)?.[1] || '',
                })),
                ...(liveUser ? [{ kind: 'text' as const, text: liveUser }] : []),
              ],
            }}
          />
        )}
        {[...(collapseReadSearchGroups(completedTurns) as Item[])].reverse().map((it) => (
          <ItemView key={it.id} it={it} project={project} sid={sid} />
        ))}
        {[...tail].reverse().map((it) => (
          <ItemView key={it.id} it={it} onRewind={handleRewind} onFork={handleFork} project={project} sid={sid} />
        ))}
        {hidden > 0 && (
          <button className="ghost load-earlier" onClick={() => setShown((s) => s + PAGE_SIZE)}>
            Load {Math.min(hidden, PAGE_SIZE)} earlier · {hidden} hidden
          </button>
        )}
        {data?.truncated && (
          <div className="thread-banner">Showing tail only — full session is {(data.totalBytes! / 1024 / 1024).toFixed(1)} MB.</div>
        )}
        {data && total === 0 && !polling && !liveUser && <div className="placeholder">No messages yet.</div>}
        {isNew && !liveUser && !sending && (() => {
          const pendingCwd = peekPendingCwd(project);
          return (
            <div className="placeholder">
              Start a new session — set permissions below and send your first message.
              {pendingCwd && <div className="new-session-cwd">in <code>{pendingCwd}</code></div>}
            </div>
          );
        })()}
        {/* Only show "Loading…" if we truly have nothing to render — hide it
            when live buffers or completed turns already show content, since
            the canonical jsonl may just be a beat behind the CLI. */}
        {!isNew &&
          !data &&
          !error &&
          !polling &&
          !liveUser &&
          liveTurn.length === 0 &&
          completedTurns.length === 0 && (
            <div className="muted">Loading…</div>
          )}
        {error && <div className="ti-error">error: {error}</div>}
        {/* CLI-parity: cwd + elapsed line at the visual top of the thread.
            Rendered LAST in DOM because .thread is column-reverse. */}
        {(cwd || startedAt) && <SessionHeader cwd={cwd} startedAt={startedAt} />}
      </div>

      {/* Input area always mounted — collapses to a zero-fr grid row
          when the tile isn't focused so a click-focus animates in
          smoothly against the content's natural height, and the user's
          typed draft survives focus changes. */}
      <div className={`session-input-area${focused ? '' : ' collapsed'}`}>
      <div className="session-input-inner">
      <form
        className={`session-input${dragOver ? ' drag-over' : ''}`}
        onSubmit={(e) => { e.preventDefault(); submitComposer(); }}
        onDragOver={(e) => { e.preventDefault(); if (!dragOver) setDragOver(true); }}
        onDragLeave={(e) => {
          // Only clear when leaving the form itself, not when entering a child
          if (e.currentTarget === e.target) setDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
        }}
      >
        <PendingQueue
          queue={queue}
          onRemove={removeQueued}
          onMove={moveQueued}
          onEdit={editQueued}
        />
        {images.length > 0 && (
          <div className="img-chips">
            {images.map((img) => (
              <div key={img.id} className="img-chip" title={img.name}>
                <img src={img.dataUrl} alt={img.name} />
                <button
                  type="button"
                  className="img-chip-x"
                  onClick={() => setImages((cur) => cur.filter((c) => c.id !== img.id))}
                  aria-label="Remove image"
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </div>
            ))}
          </div>
        )}
        {paletteOpen && (
          <SlashPalette
            commands={filteredCommands}
            activeIndex={slashIdx}
            onPick={pickCommand}
            onHover={setSlashIdx}
          />
        )}
        <div className="mention-anchor">
        {mention.popup}
        <textarea
          ref={textareaRef}
          rows={2}
          placeholder={sending ? 'Queue a message…' : 'Reply to Claude…'}
          value={input}
          onChange={(e) => {
            if (followupRaw) resetFollowups();
            setInput(e.target.value);
            // Any manual edit exits history-navigation mode — pressing
            // Send now sends the (possibly edited) text as a fresh entry.
            if (historyIdx !== null) setHistoryIdx(null);
            mention.refresh();
          }}
          onSelect={() => mention.refresh()}
          onCompositionStart={() => { composingRef.current = true; }}
          onCompositionEnd={() => {
            composingRef.current = false;
            compositionEndedAtRef.current = performance.now();
          }}
          onPaste={(e) => {
            const files: File[] = [];
            for (const item of Array.from(e.clipboardData.items)) {
              if (item.kind === 'file') {
                const f = item.getAsFile();
                if (f && f.type.startsWith('image/')) files.push(f);
              }
            }
            if (files.length) { e.preventDefault(); void addFiles(files); }
          }}
          onKeyDown={onKey}
        />
        </div>
        {/*
          Claude-web-style toolbar. Attach on the far left. Model (provider)
          and permission chips grouped on the right next to Send. Each chip
          is a small pill button with icon + label + caret; a real <select>
          sits on top of it (opacity:0) to get native picker behaviour.
        */}
        <div className="session-input-tools">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void addFiles(e.target.files);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="icon-btn"
            title="Attach image"
            aria-label="Attach image"
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip size={16} strokeWidth={2} aria-hidden="true" />
          </button>
          <SessionActionsMenu
            disabled={isNew || sending}
            busyCompact={busyCompact}
            busyPr={busyPr}
            onCompact={() => void handleCompact()}
            onCreatePr={() => void handleOpenPr()}
            onExport={handleExport}
          />
          {isNew && (
            <button
              type="button"
              className={`icon-btn iso-toggle${isolate ? ' active' : ''}`}
              title={isolate ? 'Isolated: runs in a dedicated git worktree + branch' : 'Run in a dedicated git worktree + branch (no-op if not a git repo)'}
              aria-label="Toggle worktree isolation"
              aria-pressed={isolate}
              onClick={() => setIsolate((v) => !v)}
            >
              <GitBranch size={16} strokeWidth={2} aria-hidden="true" />
            </button>
          )}
          <div className="session-input-spacer" />
          {sending ? (
            <>
              {input.trim() && (
                <>
                  <button
                    type="button"
                    className="ghost small send-now-btn"
                    onClick={handleSendNow}
                    disabled={!sid}
                    title="Interrupt the current turn and send this now"
                  >
                    Send now
                  </button>
                  <button
                    className="primary send-btn queue-btn"
                    type="submit"
                    title="Queue — sends after the current turn finishes"
                    aria-label="Queue message"
                  >
                    <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
                  </button>
                </>
              )}
              <button
                type="button"
                className="primary send-btn stop-btn"
                onClick={() => void handleStop()}
                disabled={!sid}
                title="Stop generation"
                aria-label="Stop"
              >
                <Square size={12} fill="currentColor" strokeWidth={0} aria-hidden="true" />
              </button>
            </>
          ) : (
            <button
              className="primary send-btn"
              type="submit"
              disabled={!input.trim() && images.length === 0}
              aria-label="Send"
            >
              <ArrowUp size={14} strokeWidth={2.4} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>

      <StatusBar
        projectName={name}
        permissionMode={permissionMode}
        onPermissionChange={(v) => { permissionModeTouchedRef.current = true; setPermissionMode(v); }}
        sending={sending}
        currentTodo={currentTodo}
        latestUsage={data?.latestUsage}
        contextBreakdown={data?.contextBreakdown}
        claudeMdCount={data?.claudeMdCount}
        mcpCount={data?.mcpCount}
      />
      </div>
      </div>
      {prCtx && (
        <CreatePrDialog
          ctx={prCtx}
          initialTitle={prTitle}
          initialBody={prBody}
          busy={busyPr}
          onSubmit={(input) => void handleCreatePr(input)}
          onCancel={() => setPrCtx(null)}
        />
      )}
    </section>
  );
}
