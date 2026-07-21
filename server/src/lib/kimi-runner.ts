// Drives the Kimi Code CLI in ACP mode (`kimi acp` — Agent Client Protocol,
// JSON-RPC over stdio) and translates its session/update notifications into
// the same RunnerEvent stream shape as claude-runner.ts / codex-runner.ts, so
// the SSE handlers and client store don't need to know which engine produced
// the events.
//
// Why ACP instead of the old `kimi -p … --output-format stream-json`: ACP's
// session/new (and session/load) accept an `mcpServers` list, which lets us
// inject the Macaron stdio MCP bridge (render_ui) exactly like codex does.
// The bridge tool surfaces on the wire as a tool_call whose `title` is the
// fully-qualified `mcp__macaron__render_ui` — the same string KimiChat.tsx
// matches to render inline GenUI.
//
// Session lifecycle per turn (a fresh `kimi acp` process each call):
//   initialize → session/new (new) | session/load (resume) → session/prompt.
// session/load replays the prior conversation as session/update notifications
// before returning; we gate those out so only post-prompt output reaches the
// stream. The sessionId is known synchronously (new returns it; resume already
// has it), so no snapshot-poll is needed.
//
// ACP carries no per-turn token usage, so after the turn we sum the final
// turn's step.end usage from the session's wire.jsonl (best effort).

import { execSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
import type { Client, ReadTextFileRequest, ReadTextFileResponse, RequestPermissionRequest, RequestPermissionResponse, SessionNotification, WriteTextFileRequest, ContentBlock, McpServerStdio } from '@agentclientprotocol/sdk';
import { getActiveKimiProviderEnv } from './kimi-config.js';
import { findKimiSessionDir } from './kimi-store.js';
import { MACARON_MCP_CMD, MACARON_MCP_ARGS } from './macaron-mcp-path.js';
import type { RunnerEvent, AttachedImage } from './claude-runner.js';

// Resolution order: explicit env override, common global install paths, then
// `which kimi`. No bundled fallback — the kimi CLI has no SDK vendor copy.
function detectKimiBinary(): string | undefined {
  if (process.env.MACARON_KIMI_PATH && existsSync(process.env.MACARON_KIMI_PATH)) {
    return process.env.MACARON_KIMI_PATH;
  }
  const bunGlobal = process.env.HOME ? [path.join(process.env.HOME, '.bun/bin/kimi')] : [];
  for (const p of ['/opt/homebrew/bin/kimi', '/usr/local/bin/kimi', '/usr/bin/kimi', ...bunGlobal]) {
    if (existsSync(p)) return p;
  }
  try {
    const which = execSync('which kimi', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    // `which` happily prints a dangling symlink (e.g. a pruned bun global
    // install) — verify the target actually exists before trusting it.
    if (which && existsSync(which)) return which;
  } catch { /* not on PATH */ }
  return undefined;
}

// Cache only on success: a server booted before the CLI was installed (or
// before its dir landed on PATH) must recover on the next run instead of
// serving "kimi CLI not found" until restart.
let cachedKimiBinary: string | undefined;
function kimiBinary(): string | undefined {
  if (!cachedKimiBinary || !existsSync(cachedKimiBinary)) cachedKimiBinary = detectKimiBinary();
  return cachedKimiBinary;
}

export type KimiRunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing sessionId. Omit for a new session. */
  resume?: string;
  abortController?: AbortController;
  images?: AttachedImage[];
};

// The Macaron stdio MCP bridge, shared with codex-runner (render_ui lives here).
const MACARON_MCP: McpServerStdio = { name: 'macaron', command: MACARON_MCP_CMD, args: MACARON_MCP_ARGS, env: [] };

function buildPromptBlocks(text: string, images: AttachedImage[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text) blocks.push({ type: 'text', text });
  for (const img of images) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const mimeType = m?.[1] || img.mimeType || 'image/png';
    const data = m?.[2] ?? img.dataUrl;
    blocks.push({ type: 'image', mimeType, data });
  }
  // ACP requires at least one block; an image-only turn still needs text to be
  // absent-safe on agents that assume it, so fall back to an empty text block.
  if (blocks.length === 0) blocks.push({ type: 'text', text: '' });
  return blocks;
}

// Sum the output tokens of the LAST turn recorded in the session's wire.jsonl.
// step.end carries per-step usage keyed by turnId; the current turn is the
// highest turnId in the file. Returns null on any failure — usage is
// nice-to-have and must never break the stream.
async function readLastTurnOutputTokens(sessionDir: string): Promise<number | null> {
  try {
    const wp = path.join(sessionDir, 'agents', 'main', 'wire.jsonl');
    const st = await fs.stat(wp);
    const fh = await fs.open(wp, 'r');
    let text: string;
    try {
      const cap = Math.min(st.size, 512 * 1024);
      const buf = Buffer.alloc(cap);
      await fh.read(buf, 0, cap, st.size - cap);
      text = buf.toString('utf8');
    } finally {
      await fh.close();
    }
    let lastTurn = -1;
    const usages: Array<{ turnId: number; output: number }> = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (!t || !t.includes('"step.end"')) continue;
      try {
        const o = JSON.parse(t) as { type?: string; event?: { type?: string; turnId?: string; usage?: { output?: number } } };
        const ev = o.event;
        if (o.type !== 'context.append_loop_event' || ev?.type !== 'step.end') continue;
        const turnId = Number(ev.turnId ?? -1);
        if (!Number.isFinite(turnId) || turnId < 0) continue;
        if (turnId > lastTurn) lastTurn = turnId;
        usages.push({ turnId, output: Number(ev.usage?.output ?? 0) });
      } catch { /* skip malformed line */ }
    }
    if (lastTurn < 0) return null;
    const total = usages.filter((u) => u.turnId === lastTurn).reduce((s, u) => s + u.output, 0);
    return total > 0 ? total : null;
  } catch {
    return null;
  }
}

export async function* runKimi(opts: KimiRunOptions): AsyncGenerator<RunnerEvent> {
  const queue: RunnerEvent[] = [];
  const waiters: Array<(v: IteratorResult<RunnerEvent>) => void> = [];
  let ended = false;
  const push = (ev: RunnerEvent) => {
    const w = waiters.shift();
    if (w) w({ value: ev, done: false });
    else queue.push(ev);
  };
  const finish = () => {
    ended = true;
    while (waiters.length) waiters.shift()!({ value: undefined as unknown as RunnerEvent, done: true });
  };
  const next = (): Promise<IteratorResult<RunnerEvent>> => {
    if (queue.length) return Promise.resolve({ value: queue.shift()!, done: false });
    if (ended) return Promise.resolve({ value: undefined as unknown as RunnerEvent, done: true });
    return new Promise((res) => waiters.push(res));
  };

  void (async () => {
    const binary = kimiBinary();
    if (!binary) {
      push({ kind: 'error', error: 'kimi CLI not found — install Kimi Code or set MACARON_KIMI_PATH' });
      push({ kind: 'done', exitCode: -1 });
      finish();
      return;
    }

    const providerEnv = getActiveKimiProviderEnv();
    console.log(
      `[kimi-runner] starting  model=${providerEnv.KIMI_MODEL_NAME || '(system)'}  base=${providerEnv.KIMI_MODEL_BASE_URL || '(ambient)'}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}  cwd=${opts.cwd}`,
    );
    const child = spawn(binary, ['acp'], {
      cwd: opts.cwd,
      env: { ...process.env, ...providerEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stderrTail = '';
    child.stderr.on('data', (chunk: Buffer) => { stderrTail = (stderrTail + chunk.toString('utf8')).slice(-8192); });

    // While session/load replays the prior conversation, swallow its
    // notifications — only output produced after our prompt should stream.
    let replaying = false;
    // Per tool call: remember its title (mcp__macaron__render_ui …) and whether
    // we've already emitted a `tool_use` (once rawInput is available).
    const toolTitle = new Map<string, string>();
    const toolUseEmitted = new Set<string>();

    const emitToolUseIfReady = (id: string, title: string | undefined, rawInput: unknown) => {
      if (title) toolTitle.set(id, title);
      if (rawInput == null || toolUseEmitted.has(id)) return;
      toolUseEmitted.add(id);
      push({ kind: 'tool_use', id, name: toolTitle.get(id) || 'tool', input: rawInput });
    };

    const clientImpl: Client = {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        if (replaying) return;
        const u = params.update;
        switch (u.sessionUpdate) {
          case 'agent_message_chunk': {
            if (u.content.type === 'text' && u.content.text) push({ kind: 'delta', text: u.content.text });
            break;
          }
          case 'tool_call': {
            emitToolUseIfReady(u.toolCallId, u.title, (u as { rawInput?: unknown }).rawInput);
            break;
          }
          case 'tool_call_update': {
            const id = u.toolCallId;
            emitToolUseIfReady(id, u.title ?? undefined, (u as { rawInput?: unknown }).rawInput);
            if (u.status === 'completed' || u.status === 'failed') {
              // Some agents carry rawInput only on rawOutput-bearing updates; if
              // no tool_use went out yet, emit one now so the result isn't orphaned.
              if (!toolUseEmitted.has(id)) {
                toolUseEmitted.add(id);
                push({ kind: 'tool_use', id, name: toolTitle.get(id) || 'tool', input: {} });
              }
              const raw = (u as { rawOutput?: unknown }).rawOutput;
              let text = typeof raw === 'string' ? raw : raw != null ? JSON.stringify(raw) : '';
              if (!text && Array.isArray(u.content)) {
                text = u.content
                  .map((c) => (c.type === 'content' && c.content.type === 'text' ? c.content.text : ''))
                  .filter(Boolean)
                  .join('');
              }
              push({ kind: 'tool_result', tool_use_id: id, text: text.slice(0, 8000), isError: u.status === 'failed' });
            }
            break;
          }
          default:
            break;
        }
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        // Auto-approve — Macaron runs the agent with the user's own trust
        // boundary, same as the codex/claude runners' approvalPolicy: never.
        const opts2 = params.options;
        const pick = opts2.find((o) => o.kind === 'allow_once') || opts2.find((o) => o.kind === 'allow_always') || opts2[0];
        if (!pick) return { outcome: { outcome: 'cancelled' } };
        return { outcome: { outcome: 'selected', optionId: pick.optionId } };
      },
      async readTextFile(params: ReadTextFileRequest): Promise<ReadTextFileResponse> {
        let content = await fs.readFile(params.path, 'utf8');
        if (params.line != null || params.limit != null) {
          const lines = content.split('\n');
          const start = Math.max(0, (params.line ?? 1) - 1);
          content = lines.slice(start, params.limit != null ? start + params.limit : undefined).join('\n');
        }
        return { content };
      },
      async writeTextFile(params: WriteTextFileRequest): Promise<void> {
        await fs.mkdir(path.dirname(params.path), { recursive: true });
        await fs.writeFile(params.path, params.content, 'utf8');
      },
    };

    let capturedSid = '';
    try {
      // Lazy-import the ACP SDK so only the kimi (mkx) launcher pulls it in — the
      // claude/codex launchers boot the shared bundle without it installed. Kept
      // inside the try so a missing SDK surfaces as a stream `error` (like the
      // claude/codex runners), not an unhandled rejection.
      const { ClientSideConnection, PROTOCOL_VERSION, ndJsonStream } = await import('@agentclientprotocol/sdk');
      const stream = ndJsonStream(
        Writable.toWeb(child.stdin) as WritableStream<Uint8Array>,
        Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>,
      );
      const conn = new ClientSideConnection(() => clientImpl, stream);

      const onAbort = () => {
        if (capturedSid) void conn.cancel({ sessionId: capturedSid }).catch(() => {});
        child.kill('SIGTERM');
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already gone */ } }, 3000).unref();
      };

      await conn.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
      });

      if (opts.resume) {
        capturedSid = opts.resume;
        replaying = true;
        await conn.loadSession({ sessionId: opts.resume, cwd: opts.cwd, mcpServers: [MACARON_MCP] });
        replaying = false;
        push({ kind: 'session', sessionId: capturedSid });
      } else {
        const res = await conn.newSession({ cwd: opts.cwd, mcpServers: [MACARON_MCP] });
        capturedSid = res.sessionId;
        push({ kind: 'session', sessionId: capturedSid });
      }

      if (opts.abortController?.signal.aborted) {
        onAbort();
        push({ kind: 'done', exitCode: -1 });
        return;
      }
      opts.abortController?.signal.addEventListener('abort', onAbort, { once: true });

      const result = await conn.prompt({ sessionId: capturedSid, prompt: buildPromptBlocks(opts.prompt, opts.images || []) });
      const aborted = Boolean(opts.abortController?.signal.aborted) || result.stopReason === 'cancelled';

      if (!aborted && capturedSid) {
        const dir = await findKimiSessionDir(capturedSid);
        const outputTokens = dir ? await readLastTurnOutputTokens(dir) : null;
        if (outputTokens !== null) push({ kind: 'usage', outputTokens });
      }
      push({ kind: 'done', exitCode: aborted ? -1 : 0 });
    } catch (err) {
      const detail = stderrTail.trim().split('\n').slice(-3).join('\n').trim();
      push({ kind: 'error', error: (err as Error).message || detail || 'kimi acp failed' });
      push({ kind: 'done', exitCode: -1 });
    } finally {
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      finish();
    }
  })();

  while (true) {
    const r = await next();
    if (r.done) return;
    yield r.value;
  }
}
