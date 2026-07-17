// Read + parse Kimi Code sessions under ~/.kimi-code/sessions/<workDirKey>/
// <sessionId>/ into our shared Session/Message shape so the WebUI can render
// Kimi conversations with the exact same components used for Claude.
//
// Layout per session dir:
//   state.json               — { createdAt, updatedAt, title, workDir, agents }
//   agents/main/wire.jsonl   — the main agent's transcript (protocol 1.4)
//   agents/agent-*/wire.jsonl— subagent transcripts
// Discovery prefers ~/.kimi-code/session_index.jsonl (one {sessionId,
// sessionDir, workDir} JSON per line) and falls back to scanning
// sessions/wd_*/session_* when the index is missing.
//
// wire.jsonl line types we consume (everything else is skipped):
//   turn.prompt / turn.steer (origin.kind === 'user')   → user message
//   context.append_message (role user, origin 'user')   → user message
//     (deduped — kimi mirrors every turn.prompt with an identical append)
//   context.append_loop_event event.type:
//     content.part {think|text} → thinking / text blocks on the assistant msg
//     tool.call                 → tool_use (id = toolCallId, input = args)
//     tool.result               → tool_result (paired by toolCallId)
//     step.end                  → usage snapshot

import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Message, SessionDetail, SessionListItem, SubagentInfo, UsageSnapshot } from '@macaron/shared';
import { KIMI_HOME, KIMI_SESSIONS } from '../config.js';

type KimiState = {
  title?: string;
  isCustomTitle?: boolean;
  workDir?: string;
  createdAt?: string;
  updatedAt?: string;
  agents?: Record<string, { type?: string; parentAgentId?: string | null; swarmItem?: string }>;
};

type IndexEntry = { sessionId: string; sessionDir: string; workDir: string };

type SummaryCache = {
  mtimeMs: number;
  size: number;
  firstUserText: string;
  approxMessages: number;
};

const summaryCache = new Map<string, SummaryCache>();

// The fast discovery path — one JSON per line, written by the CLI itself.
// Returns null when the index is missing/unreadable so callers fall back to
// a directory scan.
async function readSessionIndex(): Promise<IndexEntry[] | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path.join(KIMI_HOME, 'session_index.jsonl'), 'utf8');
  } catch {
    return null;
  }
  const out: IndexEntry[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as Partial<IndexEntry>;
      if (o.sessionId && o.sessionDir) {
        out.push({ sessionId: o.sessionId, sessionDir: o.sessionDir, workDir: String(o.workDir || '') });
      }
    } catch { /* skip malformed line */ }
  }
  return out;
}

// Directory-scan fallback: sessions/<workDirKey>/<sessionId>/.
async function scanSessionDirs(): Promise<Array<{ sessionId: string; sessionDir: string }>> {
  const out: Array<{ sessionId: string; sessionDir: string }> = [];
  const buckets = await fs.readdir(KIMI_SESSIONS, { withFileTypes: true }).catch(() => []);
  for (const b of buckets) {
    if (!b.isDirectory()) continue;
    const bp = path.join(KIMI_SESSIONS, b.name);
    const dirs = await fs.readdir(bp, { withFileTypes: true }).catch(() => []);
    for (const d of dirs) {
      if (d.isDirectory() && d.name.startsWith('session_')) out.push({ sessionId: d.name, sessionDir: path.join(bp, d.name) });
    }
  }
  return out;
}

// All known session dirs, index-first with a scan fallback. Stale index
// entries (dir deleted underneath) are filtered out.
async function discoverSessions(): Promise<Array<{ sessionId: string; sessionDir: string; workDir: string }>> {
  const index = await readSessionIndex();
  if (index) {
    const checks = await Promise.all(
      index.map(async (e) => ((await fs.stat(e.sessionDir).catch(() => null))?.isDirectory() ? e : null)),
    );
    return checks.filter((e): e is IndexEntry => e !== null);
  }
  return (await scanSessionDirs()).map((e) => ({ ...e, workDir: '' }));
}

export async function findKimiSessionDir(sid: string): Promise<string | null> {
  const index = await readSessionIndex();
  if (index) {
    const hit = index.find((e) => e.sessionId === sid);
    if (hit && (await fs.stat(hit.sessionDir).catch(() => null))?.isDirectory()) return hit.sessionDir;
  }
  const scanned = await scanSessionDirs();
  return scanned.find((e) => e.sessionId === sid)?.sessionDir ?? null;
}

async function readState(sessionDir: string): Promise<KimiState> {
  try {
    return JSON.parse(await fs.readFile(path.join(sessionDir, 'state.json'), 'utf8')) as KimiState;
  } catch {
    return {};
  }
}

// Read the wire.jsonl head — enough for the first turn.prompt + a message
// count estimate. Kimi bakes a large system prompt into config.update and
// full MCP tool manifests into mcp.tools_discovered lines, so the head cap
// matches codex-store's 256KB; results are cached by (mtime, size).
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
    let firstUserText = '';
    let approxMessages = 0;
    // Line-by-line — the last line may be partial (we're reading only the
    // head), so drop the tail if it doesn't end in \n.
    const lines = text.split('\n');
    const upto = size > cap ? lines.length - 1 : lines.length;
    for (let i = 0; i < upto; i++) {
      const line = lines[i]!.trim();
      if (!line) continue;
      let o: { type?: string; origin?: { kind?: string }; input?: unknown; event?: { type?: string; part?: { type?: string } } };
      try { o = JSON.parse(line); } catch { continue; }
      if ((o.type === 'turn.prompt' || o.type === 'turn.steer') && o.origin?.kind === 'user') {
        approxMessages++;
        if (!firstUserText) {
          const t = inputText(o.input).trim();
          if (t && !t.startsWith('<')) firstUserText = t;
        }
      } else if (o.type === 'context.append_loop_event' && o.event?.type === 'content.part' && o.event.part?.type === 'text') {
        approxMessages++;
      }
    }
    const entry: SummaryCache = { mtimeMs, size, firstUserText, approxMessages };
    summaryCache.set(filePath, entry);
    return entry;
  } finally {
    await fh.close();
  }
}

// Concat the text parts of a turn.prompt / turn.steer `input` array.
function inputText(input: unknown): string {
  if (!Array.isArray(input)) return '';
  return input
    .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: string }).text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

// Concat the text parts of a context.append_message content array.
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((p) => (p && typeof p === 'object' && (p as { type?: string }).type === 'text' ? String((p as { text?: string }).text || '') : ''))
    .filter(Boolean)
    .join('\n');
}

// Best-effort project key for a kimi session — mirrors the encoded
// project-name convention claude-cli uses (slash → dash). Keeps the UI's
// per-workspace grouping identical across engines.
export function encodeKimiProjectName(cwd: string): string {
  if (!cwd) return '';
  return cwd.replace(/^\//, '-').replace(/\//g, '-');
}

const wirePath = (sessionDir: string) => path.join(sessionDir, 'agents', 'main', 'wire.jsonl');

export async function listKimiSessions(): Promise<SessionListItem[]> {
  const out: SessionListItem[] = [];
  const found = await discoverSessions();
  await Promise.all(
    found.map(async ({ sessionId, sessionDir, workDir }) => {
      const state = await readState(sessionDir);
      const cwd = state.workDir || workDir;
      const wp = wirePath(sessionDir);
      const st = await fs.stat(wp).catch(() => null);
      const summary = st ? await readSummary(wp, st.mtimeMs, st.size) : null;
      // A session with no wire yet (created, no turn sent) still lists, keyed
      // off state.json's own timestamps.
      const mtime = st?.mtimeMs ?? (Date.parse(state.updatedAt || state.createdAt || '') || 0);
      // Kimi auto-titles from the first prompt; "New Session"/empty means the
      // title never landed — fall back to the first-user-message preview.
      const title = state.title && state.title !== 'New Session' ? state.title : undefined;
      out.push({
        kind: 'kimi',
        project: encodeKimiProjectName(cwd),
        cwd,
        sessionId,
        preview: (summary?.firstUserText || '').slice(0, 220),
        title,
        messageCount: summary?.approxMessages ?? 0,
        messageCountSuffix: '',
        mtime,
        size: st?.size,
        resumeCommand: `kimi -r ${sessionId}`,
      });
    }),
  );
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

// Parse one wire.jsonl (main agent or a subagent's) into shared Message[].
// Split out from readKimiSessionMessages so subagent transcripts reuse it.
function parseWire(raw: string): { messages: Message[]; latestUsage?: UsageSnapshot } {
  const messages: Message[] = [];
  let latestUsage: UsageSnapshot | undefined;
  // Track the last assistant message so subsequent tool_use / thinking
  // blocks land on the same bubble instead of forcing a new one.
  let currentAssistant: Message | null = null;
  const ensureAssistant = (time?: number): Message => {
    if (currentAssistant) return currentAssistant;
    const m: Message = { role: 'assistant', blocks: [] };
    if (time) m.timestamp = new Date(time).toISOString();
    messages.push(m);
    currentAssistant = m;
    return m;
  };
  // Dedupe user turns: kimi logs every turn.prompt twice (once as the prompt
  // itself, once mirrored into context.append_message with the same text).
  let lastUserText = '';

  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    let o: {
      type?: string;
      time?: number;
      origin?: { kind?: string };
      input?: unknown;
      message?: { role?: string; content?: unknown; origin?: { kind?: string }; toolCalls?: unknown };
      event?: Record<string, unknown> & { type?: string };
    };
    try { o = JSON.parse(t); } catch { continue; }

    if (o.type === 'turn.prompt' || o.type === 'turn.steer') {
      if (o.origin?.kind !== 'user') continue;
      const text = inputText(o.input).trim();
      if (!text) continue;
      currentAssistant = null;
      lastUserText = text;
      messages.push({
        role: 'user',
        blocks: [{ kind: 'text', text }],
        timestamp: o.time ? new Date(o.time).toISOString() : undefined,
      });
      continue;
    }

    if (o.type === 'context.append_message') {
      const m = o.message || {};
      // Non-user origins (injection, skill_activation, system_trigger) are
      // the kimi equivalent of claude's isMeta wrappers — never render them.
      if (m.role !== 'user' || m.origin?.kind !== 'user') continue;
      const text = contentText(m.content).trim();
      if (!text || text === lastUserText) continue;
      currentAssistant = null;
      lastUserText = text;
      messages.push({
        role: 'user',
        blocks: [{ kind: 'text', text }],
        timestamp: o.time ? new Date(o.time).toISOString() : undefined,
      });
      continue;
    }

    if (o.type !== 'context.append_loop_event') continue;
    const ev = o.event || {};
    const kind = String(ev.type || '');

    if (kind === 'content.part') {
      const part = (ev.part || {}) as { type?: string; text?: string; think?: string };
      if (part.type === 'think') {
        const text = String(part.think || '').trim();
        if (!text) continue;
        ensureAssistant(o.time).blocks.push({ kind: 'thinking', text });
      } else if (part.type === 'text') {
        const text = String(part.text || '').trim();
        if (!text) continue;
        const m = ensureAssistant(o.time);
        m.blocks.push({ kind: 'text', text });
        if (o.time) m.timestamp ??= new Date(o.time).toISOString();
      }
      continue;
    }

    if (kind === 'tool.call') {
      const id = String(ev.toolCallId || ev.uuid || `kimi-${messages.length}`);
      const name = String(ev.name || 'tool');
      ensureAssistant(o.time).blocks.push({ kind: 'tool_use', id, name, input: ev.args ?? {} });
      continue;
    }

    if (kind === 'tool.result') {
      const id = String(ev.toolCallId || '');
      const result = (ev.result ?? {}) as { output?: unknown; error?: unknown; isError?: boolean; is_error?: boolean };
      let text = '';
      if (typeof result.output === 'string') text = result.output;
      else if (result.output != null) text = JSON.stringify(result.output);
      else if (result.error != null) text = typeof result.error === 'string' ? result.error : JSON.stringify(result.error);
      const isError = Boolean(result.isError || result.is_error || result.error);
      ensureAssistant(o.time).blocks.push({ kind: 'tool_result', toolUseId: id, text: text.slice(0, 8000), isError });
      continue;
    }

    if (kind === 'step.end') {
      const u = (ev.usage || {}) as { inputOther?: number; output?: number; inputCacheRead?: number; inputCacheCreation?: number };
      latestUsage = {
        inputTokens: u.inputOther ?? 0,
        cacheCreationInputTokens: u.inputCacheCreation ?? 0,
        cacheReadInputTokens: u.inputCacheRead ?? 0,
        outputTokens: u.output ?? 0,
      };
      continue;
    }
  }
  return { messages, latestUsage };
}

// Parse a kimi session dir into our shared SessionDetail shape.
export async function readKimiSessionMessages(sid: string): Promise<SessionDetail> {
  const sessionDir = await findKimiSessionDir(sid);
  if (!sessionDir) throw new Error(`kimi session not found: ${sid}`);
  const state = await readState(sessionDir);
  const wp = wirePath(sessionDir);
  const st = await fs.stat(wp).catch(() => null);
  if (!st) throw new Error(`kimi session has no transcript: ${sid}`);
  const raw = await fs.readFile(wp, 'utf8');
  const { messages, latestUsage } = parseWire(raw);
  const cwd = state.workDir || '';

  return {
    kind: 'kimi',
    sessionId: sid,
    project: encodeKimiProjectName(cwd),
    cwd,
    messages,
    truncated: false,
    totalBytes: st.size,
    latestUsage,
  };
}

// Delete a kimi session dir (state.json + all agent wires). The CLI-owned
// session_index.jsonl keeps a stale line; discovery already filters those.
export async function deleteKimiSession(sid: string): Promise<void> {
  const sessionDir = await findKimiSessionDir(sid);
  if (!sessionDir) throw new Error(`kimi session not found: ${sid}`);
  await fs.rm(sessionDir, { recursive: true, force: true });
  summaryCache.delete(wirePath(sessionDir));
}

// List the subagents spawned from this session. Kimi records them in
// state.json's `agents` map (type 'sub', dirs agents/agent-*); pair each
// with the main wire's Agent/AgentSwarm tool.call events (in order) so the
// WebUI can link an inline Agent tool card to the child transcript.
export async function listKimiSubagents(sid: string): Promise<SubagentInfo[]> {
  const sessionDir = await findKimiSessionDir(sid);
  if (!sessionDir) return [];
  const state = await readState(sessionDir);
  const subs = Object.entries(state.agents || {})
    .filter(([, a]) => a?.type === 'sub')
    .sort(([a], [b]) => a.localeCompare(b, undefined, { numeric: true }));
  if (subs.length === 0) return [];
  const raw = await fs.readFile(wirePath(sessionDir), 'utf8').catch(() => '');
  const agentCalls: Array<{ id: string; agentType: string; description: string }> = [];
  const swarmCalls: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t || !t.includes('"tool.call"')) continue;
    try {
      const o = JSON.parse(t) as { type?: string; event?: { type?: string; name?: string; toolCallId?: string; args?: { subagent_type?: string; description?: string } } };
      const ev = o.event;
      if (o.type !== 'context.append_loop_event' || ev?.type !== 'tool.call') continue;
      if (ev.name === 'Agent') {
        agentCalls.push({ id: String(ev.toolCallId || ''), agentType: String(ev.args?.subagent_type || ''), description: String(ev.args?.description || '') });
      } else if (ev.name === 'AgentSwarm') {
        swarmCalls.push(String(ev.toolCallId || ''));
      }
    } catch { /* skip malformed line */ }
  }
  // A single Agent spawn maps 1:1 to its tool card; an AgentSwarm call spawns
  // the whole batch, so every swarm agent (state.json carries `swarmItem`)
  // links back to that same card. Best-effort, order-based.
  let ai = 0;
  return subs.map(([agentId, a]) => {
    if (a?.swarmItem !== undefined) {
      return { agentId, agentType: '', description: a.swarmItem, toolUseId: swarmCalls[0] || '' };
    }
    const call = agentCalls[ai++];
    return { agentId, agentType: call?.agentType || '', description: call?.description || '', toolUseId: call?.id || '' };
  });
}

// Snapshot every known sessionId. The runner diffs this against the tree
// after spawning a NEW session to learn the sid before the CLI's final meta
// line arrives (kimi only prints session.resume_hint at stream end).
export async function snapshotKimiSessionIds(): Promise<Set<string>> {
  return new Set((await scanSessionDirs()).map((e) => e.sessionId));
}

// Find a session dir that appeared after `since` was taken and whose
// state.json workDir matches `cwd`. Returns null while nothing matches.
export async function findNewKimiSession(since: Set<string>, cwd: string): Promise<{ sessionId: string; sessionDir: string } | null> {
  for (const e of await scanSessionDirs()) {
    if (since.has(e.sessionId)) continue;
    const state = await readState(e.sessionDir);
    if ((state.workDir || '') === cwd) return e;
  }
  return null;
}
