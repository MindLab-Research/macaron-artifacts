// Codex thread view. Layout is the same left→right rail we had in the
// ChatGPT-style pass, but the paper-theme CSS pulls it into the Macaron
// look. Every visual detail — background, borders, tool cards, code
// blocks — is tuned to match the claude WebUI's palette (see styles.css).

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Terminal, Pencil, Search, Hexagon, ListTodo, Settings, ChevronDown, ChevronRight, Sparkles, Diamond, CheckSquare, CircleDot, Square, Flag, GitBranch, AlertTriangle } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MarkdownCode, MarkdownCodeStreamingProvider, MarkdownPre } from '../components/MarkdownCode';
import type { SessionDetail, Message, Block, CodexPlanStatus, CodexApprovalKind, CodexDecision } from '@macaron/shared';
import { codexApi } from './api';
import { basename } from '../lib/api';
import type { CodexRuntimeOverride } from './api';
import { sendCodexMessage, startCodexThread, subscribeCodexLive, type CodexStreamEvent } from './stream';
import { CodexComposer, type ComposerImage } from './CodexComposer';
import { notify } from '../lib/notify';
import { useReplay } from '../components/ReplayControls';
import { formatDuration } from '../lib/thinkingVerbs';

// GenuiPreview + its vendored runtime (~500KB gzip) is behind a lazy
// import so the default codex bundle stays small. First render_ui in a
// thread triggers the load; subsequent ones use the cached chunk.
const GenuiPreview = lazy(() =>
  import('../genui-runtime').then((m) => ({ default: m.GenuiPreview })),
);

const RENDER_UI_TOOL_NAME = 'mcp:macaron/render_ui';
const isRenderUiTool = (name: string): boolean =>
  name === RENDER_UI_TOOL_NAME || name === 'mcp__macaron__render_ui';

type Item =
  | { id: string; kind: 'user'; text: string; images?: ComposerImage[] }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'reasoning'; text: string }
  | { id: string; kind: 'tool'; name: string; input: unknown; result?: string; durationMs?: number; isError?: boolean }
  // GenUI render_ui tool call. Codex hands us the full `code` at
  // tool_use time (arguments are already aggregated by the CLI), so we
  // render immediately — no pending phase in practice. The tool_result
  // (checkGenUI diagnostics) may flip `status` to 'error' with details.
  | { id: string; kind: 'genui'; toolUseId: string; code: string; status: 'ready' | 'error'; streaming?: boolean; error?: string }
  // Codex-native plan card (turn/plan/updated). One per thread, replaced in
  // place as new plan snapshots arrive.
  | { id: string; kind: 'plan'; steps: Array<{ step: string; status: CodexPlanStatus }>; explanation?: string | null }
  // Codex-native approval request. `decision` set once answered (or 'stale'
  // when the server cleared it) so the card disables its buttons.
  | { id: string; kind: 'approval'; approval: CodexApprovalKind; command?: string; cwd?: string; reason?: string | null; fileChanges?: Array<{ path: string; kind: string; diff?: string }>; grantRoot?: string | null; network?: { host: string; protocol: string; port?: number }; available: CodexDecision[]; decision?: CodexDecision | 'stale' };

function toolInputToCmd(name: string, input: unknown): string {
  if (name === 'Bash') {
    const cmd = (input as { command?: string } | null)?.command;
    return cmd || JSON.stringify(input);
  }
  if (name === 'Edit') {
    const changes = (input as { changes?: Array<{ path: string; kind: string }> } | null)?.changes;
    if (Array.isArray(changes)) {
      return changes
        .map((c) => `${c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} ${c.path}`)
        .join('\n');
    }
  }
  if (name === 'WebSearch') {
    const q = (input as { query?: string } | null)?.query;
    return q ? q : JSON.stringify(input);
  }
  return typeof input === 'string' ? input : JSON.stringify(input, null, 2);
}

function historyToItems(detail: SessionDetail): Item[] {
  const out: Item[] = [];
  const toolStartedAt = new Map<string, number>();
  let seq = 0;
  const next = () => `h-${seq++}`;
  const walk = (blocks: Block[], role: Message['role'], timestamp?: string) => {
    for (const b of blocks) {
      if (b.kind === 'text' && b.text.trim()) {
        if (role === 'user') out.push({ id: next(), kind: 'user', text: b.text });
        else out.push({ id: next(), kind: 'assistant', text: b.text });
      } else if (b.kind === 'thinking' && b.text.trim()) {
        out.push({ id: next(), kind: 'reasoning', text: b.text });
      } else if (b.kind === 'tool_use') {
        if (isRenderUiTool(b.name)) {
           const input = b.input as { code?: unknown; _replayStreaming?: boolean } | null;
           const code = String(input?.code || '');
          out.push({
            id: `genui-${b.id}`,
            kind: 'genui',
            toolUseId: b.id,
             code,
             status: 'ready',
             streaming: input?._replayStreaming,
          });
        } else {
          out.push({ id: b.id, kind: 'tool', name: b.name, input: b.input });
          if (timestamp) toolStartedAt.set(b.id, Date.parse(timestamp));
        }
      } else if (b.kind === 'tool_result') {
        const target = [...out].reverse().find(
          (it) =>
            (it.kind === 'tool' && it.result === undefined && (b.toolUseId ? it.id === b.toolUseId : true))
            || (it.kind === 'genui' && it.toolUseId === b.toolUseId),
        );
        if (target?.kind === 'tool') {
          target.result = b.text;
          const startedAt = toolStartedAt.get(target.id);
          const finishedAt = timestamp ? Date.parse(timestamp) : NaN;
          if (startedAt !== undefined && Number.isFinite(startedAt) && Number.isFinite(finishedAt) && finishedAt >= startedAt) target.durationMs = finishedAt - startedAt;
        }
        else if (target?.kind === 'genui') {
          const flagged = b.text.startsWith('Rendered inline, but the TSX has issues');
          if (flagged) { target.status = 'error'; target.error = b.text; }
        }
      }
    }
  };
  for (const m of detail.messages) walk(m.blocks, m.role, m.timestamp);
  return out;
}

function reconcileHistoryWithLive(history: Item[], live: Item[]): Item[] {
  const liveUser = live.find((it): it is Extract<Item, { kind: 'user' }> => it.kind === 'user');
  const liveText = liveUser?.text.trim();
  if (!liveText) return history;

  // Codex may have already appended part of the in-flight turn to its rollout.
  // When that latest user bubble matches the live snapshot, let the snapshot own
  // the whole turn so partial disk blocks are not rendered a second time.
  for (let i = history.length - 1; i >= 0; i--) {
    const item = history[i]!;
    if (item.kind !== 'user') continue;
    return item.text.trim() === liveText ? history.slice(0, i) : history;
  }
  return history;
}

function withUser(cur: Item[], text: string, images?: ComposerImage[]): Item[] {
  return [
    ...cur,
    { id: `u-${Date.now()}-${cur.length}`, kind: 'user', text, images: images?.length ? images : undefined },
  ];
}

function withAssistantDelta(cur: Item[], text: string): Item[] {
  const last = cur[cur.length - 1];
  if (last?.kind === 'assistant') {
    return [...cur.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [...cur, { id: `a-${Date.now()}-${cur.length}`, kind: 'assistant', text }];
}

function withTool(cur: Item[], id: string, name: string, input: unknown): Item[] {
  if (isRenderUiTool(name)) {
    const code = String((input as { code?: unknown } | null)?.code || '');
    return [
      ...cur,
      {
        id: `genui-${id}`,
        kind: 'genui',
        toolUseId: id,
        code,
        status: 'ready',
      },
    ];
  }
  return [...cur, { id, kind: 'tool', name, input }];
}

function withToolResult(cur: Item[], toolUseId: string, text: string, isError: boolean): Item[] {
  return cur.map((it) => {
    if (it.kind === 'tool' && it.id === toolUseId) return { ...it, result: text, isError };
    if (it.kind === 'genui' && it.toolUseId === toolUseId) {
      const flagged = isError || text.startsWith('Rendered inline, but the TSX has issues');
      return flagged
        ? { ...it, status: 'error' as const, error: text }
        : it;
    }
    return it;
  });
}

// Plan is a singleton per thread: replace the existing card in place (keeping
// its position) or append if this is the first snapshot.
function withPlan(cur: Item[], steps: Array<{ step: string; status: CodexPlanStatus }>, explanation?: string | null): Item[] {
  const idx = cur.findIndex((it) => it.kind === 'plan');
  const item: Item = { id: 'plan', kind: 'plan', steps, explanation };
  if (idx < 0) return [...cur, item];
  return cur.map((it, i) => (i === idx ? item : it));
}

function withApproval(cur: Item[], ev: Extract<CodexStreamEvent, { type: 'codex_approval_request' }>): Item[] {
  if (cur.some((it) => it.kind === 'approval' && it.id === ev.id)) return cur;
  return [...cur, { id: ev.id, kind: 'approval', approval: ev.kind, command: ev.command, cwd: ev.cwd, reason: ev.reason, fileChanges: ev.fileChanges, grantRoot: ev.grantRoot, network: ev.network, available: ev.available }];
}

function withApprovalResolved(cur: Item[], id: string, decision?: CodexDecision | 'stale'): Item[] {
  return cur.map((it) => (it.kind === 'approval' && it.id === id ? { ...it, decision: decision ?? 'stale' } : it));
}

function Reasoning({ text }: { text: string }) {  const [open, setOpen] = useState(false);
  return (
    <div className="cx-reasoning">
      <div className="cx-reasoning-head" onClick={() => setOpen((v) => !v)}>
        <span className="cx-reasoning-caret">{open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}</span>
        <span>Reasoning</span>
      </div>
      {open && <div className="cx-reasoning-body">{text}</div>}
    </div>
  );
}

function toolGlyph(name: string): ReactNode {
  if (name === 'Bash') return <Terminal size={14} aria-hidden="true" />;
  if (name === 'Edit') return <Pencil size={14} aria-hidden="true" />;
  if (name === 'WebSearch') return <Search size={14} aria-hidden="true" />;
  if (name.startsWith('mcp:')) return <Hexagon size={14} aria-hidden="true" />;
  if (name === 'TodoWrite') return <ListTodo size={14} aria-hidden="true" />;
  return <Settings size={14} aria-hidden="true" />;
}

function ToolCard({ it }: { it: Extract<Item, { kind: 'tool' }> }) {
  const [expanded, setExpanded] = useState(false);
  const cmd = toolInputToCmd(it.name, it.input);
  const out = it.result ?? '';
  const running = it.result === undefined;
  const long = out.split('\n').length > 8 || out.length > 600;
  const shown = expanded || !long ? out : out.split('\n').slice(0, 8).join('\n') + '\n…';
  return (
    <div className={'cx-tool' + (it.isError ? ' err' : '')}>
      <div className="cx-tool-head">
        <span className="cx-tool-glyph">{toolGlyph(it.name)}</span>
        <span className="cx-tool-name">{it.name}</span>
        <span className={'cx-tool-status' + (it.isError ? ' err' : '')}>
          {running ? 'running…' : it.isError ? 'failed' : 'done'}{it.durationMs != null ? ` · ${formatDuration(it.durationMs)}` : ''}
        </span>
      </div>
      <div className="cx-tool-cmd">{cmd}</div>
      {out && (
        <>
          <div className={'cx-tool-out' + (it.isError ? ' err' : '')}>{shown}</div>
          {long && (
            <button className="cx-tool-more" onClick={() => setExpanded((v) => !v)}>
              {expanded ? 'collapse' : `expand (${out.split('\n').length} lines)`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function GenuiCard({ it }: { it: Extract<Item, { kind: 'genui' }> }) {
  return (
    <div className="cx-genui">
      <div className="cx-genui-head">
        <span className="cx-genui-glyph"><Sparkles size={14} aria-hidden="true" /></span>
        <span className="cx-genui-name">Rendered UI</span>
        {it.status === 'error' && <span className="cx-genui-status err">diagnostics failed</span>}
      </div>
      <Suspense fallback={<div className="cx-genui-loading">Loading GenUI runtime…</div>}>
        <GenuiPreview code={it.code} done={!it.streaming} />
      </Suspense>
      {it.status === 'error' && it.error && (
        <details className="cx-genui-details">
          <summary>Show diagnostics</summary>
          <pre>{it.error}</pre>
        </details>
      )}
    </div>
  );
}

function PlanCard({ it }: { it: Extract<Item, { kind: 'plan' }> }) {
  const glyph = (s: CodexPlanStatus): ReactNode => (s === 'completed' ? <CheckSquare size={13} aria-hidden="true" /> : s === 'inProgress' ? <CircleDot size={13} aria-hidden="true" /> : <Square size={13} aria-hidden="true" />);
  const statusLabel = (s: CodexPlanStatus): string => (s === 'completed' ? 'completed' : s === 'inProgress' ? 'in progress' : 'pending');
  return (
    <div className="cx-plan">
      <div className="cx-plan-head">
        <span className="cx-plan-glyph"><Diamond size={14} aria-hidden="true" /></span>
        <span className="cx-plan-name">Plan</span>
      </div>
      {it.explanation && <div className="cx-plan-explanation">{it.explanation}</div>}
      <div className="cx-plan-steps">
        {it.steps.map((s, i) => (
          <div key={i} className={'cx-plan-step ' + s.status}>
            <span className="cx-plan-step-glyph" role="img" aria-label={statusLabel(s.status)}>{glyph(s.status)}</span>
            <span className="cx-plan-step-text">{s.step}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

const DECISION_LABEL: Record<CodexDecision, string> = {
  accept: 'Approve',
  acceptForSession: 'Approve for session',
  decline: 'Decline',
  cancel: 'Cancel',
};

function ApprovalCard({ it, onDecide }: { it: Extract<Item, { kind: 'approval' }>; onDecide: (id: string, decision: CodexDecision) => void }) {
  const resolved = it.decision !== undefined;
  const title = it.approval === 'file' ? 'File change approval' : it.approval === 'network' ? 'Network access approval' : 'Command approval';
  return (
    <div className={'cx-approval' + (resolved ? ' resolved' : '')}>
      <div className="cx-approval-head">
        <span className="cx-approval-glyph"><Flag size={14} aria-hidden="true" /></span>
        <span className="cx-approval-name">{title}</span>
        {resolved && <span className="cx-approval-status">{it.decision === 'stale' ? 'expired' : it.decision}</span>}
      </div>
      {it.command && <div className="cx-approval-cmd">{it.command}</div>}
      {it.network && <div className="cx-approval-net">{it.network.protocol}://{it.network.host}{it.network.port != null ? `:${it.network.port}` : ''}</div>}
      {it.cwd && <div className="cx-approval-cwd">{it.cwd}</div>}
      {it.grantRoot && <div className="cx-approval-cwd">grant root: {it.grantRoot}</div>}
      {it.reason && <div className="cx-approval-reason">{it.reason}</div>}
      {it.fileChanges?.map((c, i) => (
        <div key={i} className="cx-approval-file">
          <div className="cx-approval-file-head">{c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} {c.path}</div>
          {c.diff && <pre className="cx-approval-diff">{c.diff}</pre>}
        </div>
      ))}
      {!resolved && (
        <div className="cx-approval-actions">
          {it.available.map((d) => (
            <button key={d} className={'cx-approval-btn ' + d} onClick={() => onDecide(it.id, d)}>
              {DECISION_LABEL[d]}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

const CODEX_MARKDOWN_COMPONENTS = { code: MarkdownCode, pre: MarkdownPre } as const;

function MessageRow({ it, streaming = false, onDecide }: { it: Item; streaming?: boolean; onDecide?: (id: string, decision: CodexDecision) => void }) {
  if (it.kind === 'reasoning') return <Reasoning text={it.text} />;
  if (it.kind === 'tool') return <ToolCard it={it} />;
  if (it.kind === 'genui') return <GenuiCard it={it} />;
  if (it.kind === 'plan') return <PlanCard it={it} />;
  if (it.kind === 'approval') return <ApprovalCard it={it} onDecide={onDecide ?? (() => {})} />;
  const isUser = it.kind === 'user';
  return (
    <div className={'cx-msg ' + (isUser ? 'user' : 'assistant')}>
      <div className="cx-msg-body">
        <div className="cx-msg-role">{isUser ? 'You' : 'Codex'}</div>
        {isUser && it.images && it.images.length > 0 && (
          <div className="cx-msg-imgs">
            {it.images.map((img) => <img key={img.id} src={img.dataUrl} alt={img.name} />)}
          </div>
        )}
        {/* User text stays as pre-wrap plain text (WYSIWYG for what they typed);
            assistant text renders as GitHub-flavored Markdown so headings,
            lists, tables, inline code, and links come through. */}
        {isUser ? (
          <div className="cx-msg-text">{it.text}</div>
        ) : (
          <div className="cx-msg-text md">
            <MarkdownCodeStreamingProvider content={it.text} streaming={streaming}>
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={CODEX_MARKDOWN_COMPONENTS}>{it.text}</ReactMarkdown>
            </MarkdownCodeStreamingProvider>
          </div>
        )}
      </div>
    </div>
  );
}

// Codex-side "thinking…" indicator — three black-and-white dots pulsing in
// sequence. Minimal, quiet, no verb chatter; visible at the tail of the
// thread while a turn is in flight and no streaming text has landed yet.
function CxThinkingLine() {
  return (
    <div className="cx-thinking" aria-label="Codex is thinking">
      <span className="cx-dot" />
      <span className="cx-dot" />
      <span className="cx-dot" />
    </div>
  );
}

export type CodexChatProps = {
  /** Override sid from URL when rendered inside a canvas tile. */
  sid?: string;
  /** Suppress the top breadcrumb bar (tile grip carries the header). */
  hideBar?: boolean;
  /** Only render composer + reduce padding when this tile is the focused one. */
  focused?: boolean;
  /** Notify parent tile whenever the in-flight run flips (for running-bar animation). */
  onSendingChange?: (sending: boolean) => void;
  /** Bump this number from the parent to force a fresh transcript reload. */
  refreshKey?: number;
};

export function CodexChat(props: CodexChatProps = {}) {
  const params = useParams();
  const navigate = useNavigate();
  const sid = props.sid ?? params.sid ?? '';
  const isNew = !sid;
  const focused = props.focused ?? true;
  const hideBar = props.hideBar ?? false;
  const onSendingChange = props.onSendingChange;
  const refreshKey = props.refreshKey ?? 0;
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [live, setLive] = useState<Item[]>([]);
  const [pending, setPending] = useState('');
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);
  // Per-turn runtime override from the composer's picker; kept in a ref so
  // submit() reads the latest choice without re-subscribing. The setter is
  // stable so the picker only reloads its persisted pref when the workspace
  // changes, not on every keystroke.
  const runtimeRef = useRef<CodexRuntimeOverride>({});
  const setRuntime = useCallback((ov: CodexRuntimeOverride) => { runtimeRef.current = ov; }, []);
  // On a brand-new thread the route `sid` stays empty until `onDone` navigates,
  // but approvals arrive mid-turn — so approve/stop must target the sid the
  // server reveals via `meta`. Captured here the instant it streams in.
  const liveSidRef = useRef('');
  // True only after the user kicks off a turn on THIS mount. A server-side
  // reattach also flips `sending`, but must not create a completion notification.
  const streamedRef = useRef(false);

  useEffect(() => { onSendingChange?.(sending); }, [sending, onSendingChange]);

  // In-app notification when a turn finishes — matches the Claude side
  // (NotifyStack is mounted in CodexApp). Click routes to the thread's
  // canvas view so the user lands on the right tile.
  useEffect(() => {
    if (sending) return;
    if (!streamedRef.current) return;
    streamedRef.current = false;
    if (!sid) return;
    const project = detail?.project;
    notify({
      title: 'Macaron · thread ready',
      body: `${sid.slice(0, 8)} finished a turn`,
      tag: `codex-done-${sid}`,
      href: project
        ? `/w/${encodeURIComponent(project)}/t/${encodeURIComponent(sid)}`
        : `/t/${encodeURIComponent(sid)}`,
    });
  }, [sending, sid, detail?.project]);

  useEffect(() => {
    if (isNew) {
      setDetail(null);
      setLive([]);
      setSending(false);
      setError('');
      return;
    }
    let active = true;
    let hasLiveSnapshot = false;
    setLive([]);
    setSending(false);
    setError('');
    void codexApi.thread(sid)
      .then((next) => { if (active) setDetail(next); })
      .catch((e) => { if (active && !hasLiveSnapshot) setError((e as Error).message); });

    const unsubscribe = subscribeCodexLive(sid, {
      // `meta` is present only when the registry has a snapshot. Reset first so
      // a fresh subscription is idempotent if this effect reruns.
      onMeta: () => {
        if (!active) return;
        hasLiveSnapshot = true;
        setLive([]);
        setSending(true);
        setError('');
      },
      onUserText: (text) => { if (active) setLive((cur) => withUser(cur, text)); },
      onDelta: (text) => { if (active) setLive((cur) => withAssistantDelta(cur, text)); },
      onToolUse: (ev) => { if (active) setLive((cur) => withTool(cur, ev.id, ev.name, ev.input)); },
      onToolResult: (ev) => {
        if (active) setLive((cur) => withToolResult(cur, ev.tool_use_id, ev.text, ev.isError));
      },
      onCodexPlan: (ev) => { if (active) setLive((cur) => withPlan(cur, ev.steps, ev.explanation)); },
      onCodexApproval: (ev) => { if (active) setLive((cur) => withApproval(cur, ev)); },
      onCodexApprovalResolved: (ev) => { if (active) setLive((cur) => withApprovalResolved(cur, ev.id, ev.decision)); },
      onError: (message) => { if (active) setError(message); },
      onDone: () => {
        if (!active) return;
        setSending(false);
        // Keep the complete live buffer visible while the Codex rollout catches
        // up asynchronously; refresh metadata without clearing that buffer.
        void codexApi.thread(sid).then((next) => { if (active) setDetail(next); }).catch(() => {});
      },
      onLiveEnd: () => { if (active) setSending(false); },
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [sid, isNew, refreshKey]);

  const replay = useReplay(detail?.replayMessages ?? detail?.messages ?? [], isNew || sending);
  const diskHistory = useMemo(() => detail ? historyToItems({ ...detail, messages: replay.messages }) : [], [detail, replay.messages]);
  const history = useMemo(
    () => reconcileHistoryWithLive(diskHistory, live),
    [diskHistory, live],
  );
  const items = useMemo(() => [...history, ...live], [history, live]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items.length, live[live.length - 1]]);

  const appendUser = (text: string, imgs?: ComposerImage[]) =>
    setLive((cur) => withUser(cur, text, imgs));
  // Codex emits each reasoning item atomically on completed, so every event
  // is one full thinking block — append, don't concat.
  const appendReasoning = (text: string) =>
    setLive((cur) => [...cur, { id: `r-${Date.now()}-${cur.length}`, kind: 'reasoning', text }]);
  const appendAssistantDelta = (text: string) => setLive((cur) => withAssistantDelta(cur, text));
  const appendTool = (id: string, name: string, input: unknown) =>
    setLive((cur) => withTool(cur, id, name, input));
  const applyToolResult = (toolUseId: string, text: string, isError: boolean) => {
    setLive((cur) => withToolResult(cur, toolUseId, text, isError));
  };
  const applyPlan = (ev: Extract<CodexStreamEvent, { type: 'codex_plan' }>) =>
    setLive((cur) => withPlan(cur, ev.steps, ev.explanation));
  const applyApproval = (ev: Extract<CodexStreamEvent, { type: 'codex_approval_request' }>) =>
    setLive((cur) => withApproval(cur, ev));
  const applyApprovalResolved = (ev: Extract<CodexStreamEvent, { type: 'codex_approval_resolved' }>) =>
    setLive((cur) => withApprovalResolved(cur, ev.id, ev.decision));

  // Answer an approval optimistically (disable the card), then POST. On failure
  // the server already treated it as resolved (stale race), so we keep it off.
  const decideApproval = useCallback((id: string, decision: CodexDecision) => {
    const target = sid || liveSidRef.current;
    if (!target) return;
    setLive((cur) => withApprovalResolved(cur, id, decision));
    void codexApi.approve(target, id, decision).catch(() => {});
  }, [sid]);

  const stop = useCallback(async () => {
    const target = sid || liveSidRef.current;
    if (!target) return;
    try { await codexApi.stopThread(target); } catch { /* nop */ }
  }, [sid]);

  const submit = useCallback(async (opts?: { text?: string }) => {
    // `opts.text` present ⇒ programmatic send (from the $macaron/chat bridge
    // or auto-continue). We don't consume composer state in that case, so a
    // user still typing something doesn't get their draft cleared.
    const programmatic = typeof opts?.text === 'string';
    const text = (programmatic ? opts!.text! : pending).trim();
    if ((!text && images.length === 0) || sending) return;
    const sentImages = programmatic ? [] : images;
    const wire = sentImages.map((i) => ({ mimeType: i.mimeType, dataUrl: i.dataUrl }));
    if (!programmatic) {
      setPending('');
      setImages([]);
    }
    streamedRef.current = true;
    setSending(true);
    setError('');
    appendUser(text, sentImages);
    try {
      if (isNew) {
        let newSid = '';
        await startCodexThread({ text, images: wire, runtime: runtimeRef.current }, {
          onMeta: (s) => { newSid = s; liveSidRef.current = s; },
          onDelta: appendAssistantDelta,
          onReasoning: appendReasoning,
          onToolUse: (ev) => appendTool(ev.id, ev.name, ev.input),
          onToolResult: (ev) => applyToolResult(ev.tool_use_id, ev.text, ev.isError),
          onCodexPlan: applyPlan,
          onCodexApproval: applyApproval,
          onCodexApprovalResolved: applyApprovalResolved,
          onError: (m) => setError(m),
          onDone: () => {
            setSending(false);
            if (newSid) navigate(`/t/${encodeURIComponent(newSid)}`, { replace: true });
          },
        });
      } else {
        await sendCodexMessage(sid, { text, images: wire, runtime: runtimeRef.current }, {
          onDelta: appendAssistantDelta,
          onReasoning: appendReasoning,
          onToolUse: (ev) => appendTool(ev.id, ev.name, ev.input),
          onToolResult: (ev) => applyToolResult(ev.tool_use_id, ev.text, ev.isError),
          onCodexPlan: applyPlan,
          onCodexApproval: applyApproval,
          onCodexApprovalResolved: applyApprovalResolved,
          onError: (m) => setError(m),
          onDone: () => {
            setSending(false);
            codexApi.thread(sid).then(setDetail).catch(() => {}).finally(() => setLive([]));
          },
        });
      }
    } catch (e) {
      setError((e as Error).message);
      setSending(false);
    }
  }, [pending, images, sending, isNew, sid, navigate]);

  // Chat bridge for render_ui widgets. Mirrors Claude side (Session.tsx):
  // a sandboxed widget imports `sendUserMessage` from '$macaron/chat',
  // the shim dispatches to globalThis['$app/chat'], and we relay into
  // submit() as a programmatic user turn. `sendUserMessage` is also bound
  // on globalThis so widgets that forget the import still work.
  useEffect(() => {
    if (!focused) return;
    const g = globalThis as unknown as {
      '$app/chat'?: (prompt: string) => void;
      sendUserMessage?: (prompt: string) => void;
    };
    const bridge = (prompt: string) => { void submit({ text: prompt }); };
    g['$app/chat'] = bridge;
    g.sendUserMessage = bridge;
    return () => {
      if (g['$app/chat'] === bridge) delete g['$app/chat'];
      if (g.sendUserMessage === bridge) delete g.sendUserMessage;
    };
  }, [focused, submit]);

  const title = isNew
    ? 'New thread'
    : detail?.title || basename(detail?.cwd || '') || sid.slice(0, 8);

  return (
    <div className={'cx-main' + (hideBar ? ' tile' : '')}>
      {!hideBar && (
        <div className="cx-main-head">
          <div className="cx-main-head-title">{title}</div>
          <div className="cx-main-head-replay">{replay.controls}</div>
          {!isNew && (
            <>
              <span className="cx-main-head-dot">·</span>
              <span className="cx-main-head-sub">{sid.slice(0, 8)}</span>
              {detail?.gitBranch && (
                <>
                  <span className="cx-main-head-dot">·</span>
                  <span className="cx-main-head-branch"><GitBranch size={13} aria-hidden="true" /> {detail.gitBranch}</span>
                </>
              )}
            </>
          )}
        </div>
      )}
      <div className="cx-main-scroll" ref={scrollRef}>
        {isNew && items.length === 0 ? (
          <div className="cx-home">
            <div className="cx-home-inner">
              <h1 className="cx-home-title">What can I help with?</h1>
              <p className="cx-home-sub">
                Codex will run in your working directory with the effort / sandbox / approval
                mode set on the composer below.
              </p>
            </div>
          </div>
        ) : (
          <div className="cx-thread-body">
            {items.map((it, i) => (
              <MessageRow
                key={it.id}
                it={it}
                streaming={sending && i === items.length - 1 && it.kind === 'assistant'}
                onDecide={decideApproval}
              />
            ))}
            {/* Show the thinking spinner at the tail of the thread while a
                turn is in flight. Hide it once the last item is a live
                assistant message that has actually started emitting text —
                at that point the streaming text itself is the progress
                signal, so a second one is noise. */}
            {sending && (() => {
              const last = items[items.length - 1];
              const streamingText = last?.kind === 'assistant' && last.text.length > 0;
              return streamingText ? null : <CxThinkingLine />;
            })()}
            {error && (
              <div className="cx-tool err">
                <div className="cx-tool-head">
                  <span className="cx-tool-glyph"><AlertTriangle size={14} aria-hidden="true" /></span>
                  <span className="cx-tool-name">Error</span>
                </div>
                <div className="cx-tool-out err">{error}</div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className={'cx-composer-grid' + (focused ? ' open' : '')}>
        <div className="cx-composer-inner">
          <CodexComposer
            value={pending}
            onChange={setPending}
            images={images}
            onImagesChange={setImages}
            onSubmit={submit}
            onStop={stop}
            disabled={sending}
            running={sending && !isNew}
            placeholder={sending ? 'Draft next message…' : undefined}
            project={detail?.project ?? params.project ?? ''}
            onRuntime={setRuntime}
          />
        </div>
      </div>
    </div>
  );
}
