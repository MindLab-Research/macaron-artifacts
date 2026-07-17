// Codex runner over the `codex app-server` JSON-RPC transport (stdio), the
// bidirectional protocol the SDK's one-shot `codex exec` surface can't do.
// It gives us the two things MAC-8129 needs and the SDK lacks: live
// `turn/plan/updated` events and interactive command/file/network approval
// requests we can answer mid-turn.
//
// Shape mirrors codex-runner.ts (runCodex): one process per turn, translated
// 1:1 into the shared RunnerEvent stream so the SSE route and client don't
// know which transport produced them. The extra surface is the approval
// channel — an in-flight run registers itself in `active-approvals` keyed by
// sid, and the /approval route calls respondCodexApproval() to send the
// user's decision back over the same stdio pipe.
//
// Protocol reference: `codex app-server generate-ts` (verified empirically
// against codex-cli 0.144.1). Handshake is initialize → initialized →
// thread/start|thread/resume → turn/start; the server drives the turn with
// notifications and pauses on `item/*/requestApproval` server requests.

import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Writable, Readable } from 'node:stream';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { getActiveCodexProvider, getCodexConfig, type CodexRuntimeOverride } from './codex-config.js';
import { CODEX_BINARY, MACARON_MCP_CMD, MACARON_MCP_ARGS, type CodexRunOptions } from './codex-runner.js';
import { registerApprovalHandler, clearApprovalHandler } from './active-approvals.js';
import type { RunnerEvent } from './claude-runner.js';
import type { CodexDecision } from '@macaron/shared';

// Flat config map (dotted keys → JSON values) plus the top-level thread knobs.
// Same values codex-runner feeds the SDK, reshaped for thread/start params.
function buildAppServerConfig(override?: CodexRuntimeOverride): { config: Record<string, unknown>; model?: string; sandbox: string; approvalPolicy: string; modelProvider?: string } {
  const s = getCodexConfig();
  const p = getActiveCodexProvider();
  const sandbox = override?.sandboxMode ?? s.runtime.sandboxMode;
  const approvalPolicy = override?.approvalPolicy ?? s.runtime.approvalPolicy;
  const config: Record<string, unknown> = {
    'mcp_servers.macaron.command': MACARON_MCP_CMD,
    'mcp_servers.macaron.args': MACARON_MCP_ARGS,
    'mcp_servers.macaron.default_tools_approval_mode': 'approve',
    network_access: 'enabled',
  };
  if (!p) {
    return { config, sandbox, approvalPolicy };
  }
  Object.assign(config, {
    model_provider: p.modelProvider,
    model: p.model,
    review_model: p.model,
    model_reasoning_effort: override?.reasoningEffort ?? p.reasoningEffort,
    model_context_window: p.contextWindow,
    model_auto_compact_token_limit: p.autoCompactTokenLimit,
    disable_response_storage: p.disableResponseStorage,
    [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
    [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
    [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
    [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey,
  });
  return { config, model: p.model, modelProvider: p.modelProvider, sandbox, approvalPolicy };
}

const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };

// UserInput[] in app-server shape ({type:'text'} / {type:'localImage'}). Codex
// can't take inline data URLs, so images are written to temp files the caller
// removes once the turn ends.
function buildAppServerInput(opts: CodexRunOptions): { input: unknown[]; tmpFiles: string[] } {
  const items: unknown[] = [];
  const tmpFiles: string[] = [];
  for (const img of opts.images ?? []) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const mime = m?.[1] || img.mimeType || 'image/png';
    const data = m?.[2] || '';
    if (!data) continue;
    const file = path.join(os.tmpdir(), `macaron-codex-${randomUUID()}.${IMAGE_EXT[mime] || 'png'}`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    tmpFiles.push(file);
    items.push({ type: 'localImage', path: file });
  }
  if (opts.prompt) items.push({ type: 'text', text: opts.prompt, text_elements: [] });
  return { input: items, tmpFiles };
}

// Map the app-server's `availableDecisions` (mixed strings + amendment
// objects) down to the plain decision set the UI renders. Amendment variants
// (acceptWithExecpolicyAmendment, applyNetworkPolicyAmendment) collapse to a
// single `acceptForSession`-adjacent option is out of scope — we keep the
// four plain decisions and let the client show whichever were offered.
export function normalizeDecisions(available: unknown): CodexDecision[] {
  const known: CodexDecision[] = ['accept', 'acceptForSession', 'decline', 'cancel'];
  if (!Array.isArray(available)) return ['accept', 'decline', 'cancel'];
  const out: CodexDecision[] = [];
  for (const d of available) {
    if (typeof d === 'string' && (known as string[]).includes(d)) out.push(d as CodexDecision);
  }
  return out.length ? out : ['accept', 'decline', 'cancel'];
}

type Pending = { requestId: string | number; method: string };
type CodexProc = ChildProcessByStdio<Writable, Readable, null>;

// The exact stdout line the runner writes to answer a server approval request.
// app-server does NOT use JSON-RPC response envelopes ({jsonrpc,id,result}); a
// reply echoes the request `method` and `id` with a `response: { decision }`
// payload. Exported so a transport-level test can assert the wire shape.
export function buildApprovalResponseFrame(id: string | number, method: string, decision: CodexDecision): string {
  return `${JSON.stringify({ method, id, response: { decision } })}\n`;
}

export function runCodexAppServer(opts: CodexRunOptions): AsyncGenerator<RunnerEvent> {
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

  const { config, model, sandbox, approvalPolicy, modelProvider } = buildAppServerConfig(opts.runtime);
  const bin = CODEX_BINARY;

  void (async () => {
    let tmpFiles: string[] = [];
    let sid: string | null = opts.resume ?? null;
    let turnId: string | null = null;
    let proc: CodexProc | null = null;
    // Our approval-request id → the JSON-RPC request id we must reply on. Keyed
    // by a stable string (`<sid>:<requestId>`) so a reconnecting client and the
    // /approval route agree on which request they're answering.
    const pending = new Map<string, Pending>();
    let approvalRegistered = false;

    const cleanup = () => {
      if (sid && approvalRegistered) clearApprovalHandler(sid);
      for (const f of tmpFiles) { try { unlinkSync(f); } catch { /* gone */ } }
      try { proc?.kill(); } catch { /* already dead */ }
    };

    try {
      if (!bin || !existsSync(bin)) throw new Error('codex binary not found (set MACARON_CODEX_PATH)');
      proc = spawn(bin, ['app-server'], { stdio: ['pipe', 'pipe', 'ignore'] }) as CodexProc;

      let rpcId = 0;
      const sendRequest = (method: string, params: unknown): number => {
        const id = ++rpcId;
        proc!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
        return id;
      };
      const sendNotify = (method: string, params: unknown) => {
        proc!.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
      };
      // Reply to a server-initiated approval request. app-server does NOT use
      // standard JSON-RPC response envelopes: a reply echoes the request method
      // and id alongside a `response` payload, not `{ result }`. Getting this
      // wrong leaves the turn parked while our card optimistically disables.
      const respondApproval = (id: string | number, method: string, decision: CodexDecision) => {
        proc!.stdin.write(buildApprovalResponseFrame(id, method, decision));
      };

      // Abort → interrupt the active turn natively (turn/interrupt needs both
      // threadId and turnId), then let the turn/failed|completed notification
      // drive the stream close. A bounded timer force-kills the process if the
      // server never acknowledges the interrupt, so a wedged app-server can't
      // hang the request forever.
      opts.abortController?.signal.addEventListener('abort', () => {
        if (ended) return;
        if (sid && turnId) {
          try { sendRequest('turn/interrupt', { threadId: sid, turnId }); } catch { /* closing */ }
          setTimeout(() => {
            if (ended) return;
            push({ kind: 'done', exitCode: 130 });
            cleanup();
            finish();
          }, 2000);
        } else {
          push({ kind: 'done', exitCode: 130 });
          cleanup();
          finish();
        }
      });

      // Register the approval channel once we know the sid. Answers the parked
      // server request with the decision the user picked in the WebUI.
      const registerApprovals = () => {
        if (!sid || approvalRegistered) return;
        approvalRegistered = true;
        registerApprovalHandler(sid, (approvalId: string, decision: CodexDecision) => {
          const p = pending.get(approvalId);
          if (!p) return false;
          respondApproval(p.requestId, p.method, decision);
          pending.delete(approvalId);
          push({ kind: 'codex_approval_resolved', id: approvalId, decision });
          return true;
        });
      };

      // --- item translation (item/started + item/completed) ----------------
      const emittedToolUse = new Set<string>();
      // Proposed file changes keyed by item id, captured from the fileChange
      // item so the fileChange approval request (which carries only an itemId)
      // can render the actual diff instead of an empty card.
      const fileChangesByItem = new Map<string, Array<{ path: string; kind: string; diff?: string }>>();
      const handleItem = (phase: 'started' | 'completed', item: Record<string, unknown>) => {
        const type = item.type as string;
        const id = String(item.id ?? '');
        if (type === 'agentMessage') {
          if (phase !== 'completed') return;
          const text = String(item.text ?? '').trim();
          if (text) push({ kind: 'delta', text });
        } else if (type === 'reasoning') {
          if (phase !== 'completed') return;
          const parts = [...((item.summary as string[]) ?? []), ...((item.content as string[]) ?? [])];
          const text = parts.join('\n').trim();
          if (text) push({ kind: 'reasoning', text });
        } else if (type === 'commandExecution') {
          if (!emittedToolUse.has(id)) { emittedToolUse.add(id); push({ kind: 'tool_use', id, name: 'Bash', input: { command: item.command } }); }
          if (phase === 'completed') {
            push({ kind: 'tool_result', tool_use_id: id, text: String(item.aggregatedOutput ?? `(exit ${item.exitCode ?? '?'})`), isError: item.status === 'failed' || (Number(item.exitCode ?? 0) !== 0) });
          }
        } else if (type === 'fileChange') {
          const changes = (item.changes as Array<{ path: string; kind: string; diff?: string }>) ?? [];
          fileChangesByItem.set(id, changes);
          if (!emittedToolUse.has(id)) { emittedToolUse.add(id); push({ kind: 'tool_use', id, name: 'Edit', input: { changes } }); }
          if (phase === 'completed') {
            const summary = changes.map((c) => `${c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} ${c.path}`).join('\n');
            push({ kind: 'tool_result', tool_use_id: id, text: summary || '(no changes)', isError: item.status === 'failed' });
          }
        } else if (type === 'mcpToolCall') {
          if (!emittedToolUse.has(id)) { emittedToolUse.add(id); push({ kind: 'tool_use', id, name: `mcp:${item.server}/${item.tool}`, input: (item.arguments as unknown) ?? {} }); }
          if (phase === 'completed') {
            const err = (item.error as { message?: string } | null)?.message;
            const res = item.result as { content?: unknown; structured_content?: unknown } | null;
            const text = err ?? JSON.stringify(res?.content ?? res?.structured_content ?? '', null, 2);
            push({ kind: 'tool_result', tool_use_id: id, text: (text || '').slice(0, 8000), isError: item.status === 'failed' });
          }
        } else if (type === 'webSearch') {
          if (!emittedToolUse.has(id)) { emittedToolUse.add(id); push({ kind: 'tool_use', id, name: 'WebSearch', input: { query: item.query } }); }
          if (phase === 'completed') push({ kind: 'tool_result', tool_use_id: id, text: '(search dispatched)', isError: false });
        }
      };

      // --- server → client notification / request routing ------------------
      const onMessage = (msg: Record<string, unknown>) => {
        // Server request (approval) — has both method and id.
        if (typeof msg.method === 'string' && msg.id !== undefined && (msg.method as string).includes('requestApproval')) {
          const method = msg.method as string;
          const params = (msg.params ?? {}) as Record<string, unknown>;
          const approvalId = `${sid ?? params.threadId}:${msg.id}`;
          pending.set(approvalId, { requestId: msg.id as string | number, method });
          registerApprovals();
          if (method === 'item/fileChange/requestApproval') {
            const changes = fileChangesByItem.get(String(params.itemId ?? ''));
            push({ kind: 'codex_approval_request', id: approvalId, approval: 'file', reason: (params.reason as string) ?? null, grantRoot: (params.grantRoot as string) ?? null, fileChanges: changes, available: normalizeDecisions(params.availableDecisions) });
          } else {
            const net = params.networkApprovalContext as { host: string; protocol: string; port?: number } | null | undefined;
            push({
              kind: 'codex_approval_request',
              id: approvalId,
              approval: net ? 'network' : 'command',
              command: (params.command as string) ?? undefined,
              cwd: (params.cwd as string) ?? undefined,
              reason: (params.reason as string) ?? null,
              network: net ? { host: net.host, protocol: net.protocol, port: net.port } : undefined,
              available: normalizeDecisions(params.availableDecisions),
            });
          }
          return;
        }
        if (typeof msg.method !== 'string') return; // a response to one of our requests
        const method = msg.method as string;
        const params = (msg.params ?? {}) as Record<string, unknown>;
        switch (method) {
          case 'thread/started': {
            const thread = params.thread as { id: string } | undefined;
            if (thread?.id && !sid) { sid = thread.id; push({ kind: 'session', sessionId: sid }); registerApprovals(); }
            break;
          }
          case 'turn/started':
            turnId = (params.turn as { id?: string } | undefined)?.id ?? null;
            push({ kind: 'message', subtype: 'codex_turn_started' });
            break;
          case 'item/started':
            handleItem('started', params.item as Record<string, unknown>);
            break;
          case 'item/completed':
            handleItem('completed', params.item as Record<string, unknown>);
            break;
          case 'turn/plan/updated':
            push({ kind: 'codex_plan', steps: (params.plan as Array<{ step: string; status: 'pending' | 'inProgress' | 'completed' }>) ?? [], explanation: (params.explanation as string) ?? null });
            break;
          case 'serverRequest/resolved': {
            // The server cleared a request we never answered (auto-approved,
            // superseded, or turn ended). Mark it stale so the card disables.
            const approvalId = `${params.threadId}:${(params.requestId as string | number)}`;
            if (pending.delete(approvalId)) push({ kind: 'codex_approval_resolved', id: approvalId, decision: 'stale' });
            break;
          }
          case 'turn/completed': {
            const turn = params.turn as { status?: string } | undefined;
            push({ kind: 'done', exitCode: turn?.status === 'failed' ? 1 : 0 });
            cleanup();
            finish();
            break;
          }
          case 'turn/failed': {
            const err = params.error as { message?: string } | undefined;
            push({ kind: 'error', error: err?.message || 'codex turn failed' });
            push({ kind: 'done', exitCode: 1 });
            cleanup();
            finish();
            break;
          }
          case 'error':
            push({ kind: 'error', error: (params.message as string) || 'codex stream error' });
            break;
        }
      };

      // Line-delimited JSON reader over stdout.
      let buf = '';
      proc.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
          if (!line.trim()) continue;
          let msg: Record<string, unknown>;
          try { msg = JSON.parse(line); } catch { continue; }
          try { onMessage(msg); } catch (e) { push({ kind: 'error', error: (e as Error).message }); }
        }
      });
      proc.on('exit', (code) => {
        if (!ended) { push({ kind: 'done', exitCode: code ?? -1 }); cleanup(); finish(); }
      });

      // --- handshake -------------------------------------------------------
      sendRequest('initialize', { clientInfo: { name: 'macaron', title: 'Macaron WebUI', version: '0.1.0' }, capabilities: null });
      sendNotify('initialized', {});

      const startCfg = { cwd: opts.cwd, sandbox, approvalPolicy, config, model, modelProvider };
      if (sid) {
        push({ kind: 'session', sessionId: sid });
        registerApprovals();
        sendRequest('thread/resume', { threadId: sid, cwd: opts.cwd, sandbox, approvalPolicy, config, model, modelProvider });
      } else {
        sendRequest('thread/start', startCfg);
      }

      // Fire the turn once we have a thread id. thread/start responds with the
      // thread synchronously (id: 2), and also emits thread/started — either
      // path sets `sid`. Poll briefly for the id, then start the turn.
      const built = buildAppServerInput(opts);
      tmpFiles = built.tmpFiles;
      const startTurn = async () => {
        for (let i = 0; i < 200 && !sid; i++) await new Promise((r) => setTimeout(r, 25));
        if (!sid) { push({ kind: 'error', error: 'codex thread did not start' }); push({ kind: 'done', exitCode: -1 }); cleanup(); finish(); return; }
        sendRequest('turn/start', { threadId: sid, input: built.input });
      };
      void startTurn();
    } catch (err) {
      push({ kind: 'error', error: (err as Error).message });
      push({ kind: 'done', exitCode: -1 });
      cleanup();
      finish();
    }
  })();

  return (async function* () {
    while (true) {
      const r = await next();
      if (r.done) return;
      yield r.value;
    }
  })();
}
