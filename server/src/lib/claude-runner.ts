// Wraps the Claude Agent SDK so the rest of the app sees a normalized stream of
// {sessionId, deltas, events, done}. Replaces the previous child_process.spawn
// approach — same UX, no CLI stdout parsing, typed events, no IPC buffering.

import { randomUUID } from 'node:crypto';
import { query, type SDKMessage, type PermissionMode, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { macaronMcpServer } from './macaron-mcp.js';
import { registerPending } from './permission-registry.js';
import { computeRuleKeys, isAllowed, rememberSession, rememberProject } from './permission-rules.js';
import type { CodexPlanStatus, CodexApprovalKind, CodexDecision } from '@macaron/shared';

export type AttachedImage = { mimeType: string; dataUrl: string };

export type RunnerEvent =
  | { kind: 'session'; sessionId: string }
  | { kind: 'delta'; text: string }
  // Reasoning/thinking stream, kept separate from `delta` so downstream can
  // render it as its own collapsible block.
  | { kind: 'reasoning'; text: string }
  // Emitted when the model starts a tool_use block (carries id+name).
  | { kind: 'tool_use'; id: string; name: string; input: unknown }
  // Token-level streaming of the tool's JSON input. partial_json is a chunk
  // of the in-progress arguments JSON; consumers may concat them and try a
  // tolerant parse to extract a partial `code` field for live rendering.
  | { kind: 'tool_input_delta'; id: string; name: string; partial_json: string; accumulated: string }
  // Tool's JSON input is fully streamed (content_block_stop fired). Carries
  // the complete accumulated JSON so consumers can finalize state.
  | { kind: 'tool_input_done'; id: string; name: string; final_json: string }
  | { kind: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  // Live usage. Emitted from Anthropic's `message_delta` streaming events
  // (authoritative cumulative output_tokens) and from thinking-phase ping
  // digests (estimated tokens burned during silent extended thinking).
  | { kind: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { kind: 'message'; subtype: string }
  // Fired when the SDK's canUseTool asks whether to run a tool. The client
  // must POST /permission-decision with { id, decision } — canUseTool is
  // parked on a Promise until that arrives. `suggestion.label` is what the
  // "Session/Always" buttons will remember (server-computed so the client
  // does no command parsing); absent when there's nothing rememberable.
  | { kind: 'permission_request'; id: string; toolName: string; input: unknown; suggestion?: { label: string } }
  | { kind: 'permission_resolved'; id: string; decision: 'allow' | 'deny' }
  // Codex-native plan + approval events. Only the codex app-server runner emits
  // these; they carry the shared SSE payload verbatim so the route can relay
  // them without re-shaping. See shared/src/sse.ts for field semantics.
  | { kind: 'codex_plan'; steps: Array<{ step: string; status: CodexPlanStatus }>; explanation?: string | null }
  | { kind: 'codex_approval_request'; id: string; approval: CodexApprovalKind; command?: string; cwd?: string; reason?: string | null; fileChanges?: Array<{ path: string; kind: string; diff?: string }>; grantRoot?: string | null; network?: { host: string; protocol: string; port?: number }; available: CodexDecision[] }
  | { kind: 'codex_approval_resolved'; id: string; decision?: CodexDecision | 'stale' }
  | { kind: 'error'; error: string }
  | { kind: 'done'; exitCode: number };

export type RunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing sessionId. Omit for a new session. */
  resume?: string;
  abortController?: AbortController;
  permissionMode?: PermissionMode;
  model?: string;
  images?: AttachedImage[];
  /**
   * Env vars to pass to the Claude Code SDK subprocess. Setting
   * ANTHROPIC_BASE_URL + ANTHROPIC_AUTH_TOKEN here reroutes the SDK to a
   * different Anthropic-compatible endpoint (e.g. Macaron). When null, the
   * subprocess inherits process.env unchanged (default Anthropic path).
   */
  envOverrides?: Record<string, string> | null;
};

function buildPromptInput(opts: RunOptions): string | AsyncIterable<SDKUserMessage> {
  if (!opts.images || opts.images.length === 0) return opts.prompt;
  // When images are attached we must pass content blocks via an async iterable.
  // Strip the data-URL prefix so the SDK sees raw base64.
  const allowed = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
  const imageBlocks = opts.images.map((img) => {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const detected = m?.[1] || img.mimeType || 'image/png';
    const mediaType = (allowed.has(detected) ? detected : 'image/png') as
      'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
    const data = m?.[2] || '';
    return {
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: mediaType, data },
    };
  });
  const content = [
    ...imageBlocks,
    ...(opts.prompt ? [{ type: 'text' as const, text: opts.prompt }] : []),
  ];
  const msg: SDKUserMessage = {
    type: 'user',
    message: { role: 'user', content },
    parent_tool_use_id: null,
  };
  return (async function* () { yield msg; })();
}

export async function* runClaude(opts: RunOptions): AsyncGenerator<RunnerEvent> {
  // Queue-based generator: both the SDK's async iterator loop and the
  // canUseTool callback push here. canUseTool needs to *both* emit a
  // permission_request event AND await a client decision — a plain
  // `yield` inside a callback context can't do that, so we drain a shared
  // queue from the outer generator.
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

  // Per-content-block context for streaming tool input. The SDK fires
  // content_block_start/delta/stop with an `index`; we use that to pair
  // input_json_delta chunks with the originating tool_use's id+name.
  const toolBlocks = new Map<number, { id: string; name: string; json: string }>();

  const e = opts.envOverrides;
  const routedBase = e?.ANTHROPIC_BASE_URL || '(inherited from process.env)';
  const cfgDir = e?.CLAUDE_CONFIG_DIR || '(user default ~/.claude)';
  console.log(
    `[claude-runner] starting  model=${opts.model ?? '(sdk default)'}  base=${routedBase}  CLAUDE_CONFIG_DIR=${cfgDir}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}`,
  );

  // Launch the SDK stream in the background. Both success and error paths
  // eventually push a `done` and call `finish()` so the outer drain loop
  // can exit cleanly.
  void (async () => {
    let sessionEmitted = false;
    // Tracks the session this run belongs to so canUseTool can scope
    // "remember for session" rules. Known upfront when resuming; for a brand
    // new session it's filled in once the first `session` message arrives.
    let currentSid = opts.resume ?? '';
    try {
      // Honor whatever the WebUI sent. The global "default permission mode"
      // in Settings is applied client-side (Session / Home init their
      // per-session picker from readPublicSettings().defaultPermissionMode),
      // so by the time we get here `opts.permissionMode` already reflects
      // the user's picked mode for this session.
      const effectivePermissionMode: PermissionMode = opts.permissionMode ?? 'default';
      const stream = query({
        prompt: buildPromptInput(opts),
        options: {
          cwd: opts.cwd,
          resume: opts.resume,
          model: opts.model,
          permissionMode: effectivePermissionMode,
          // The SDK passes `permissionMode` to the CLI as `--permission-mode`,
          // but the CLI refuses to actually enter `bypassPermissions` unless
          // `--allow-dangerously-skip-permissions` is also on the arg list (or
          // `skipDangerousModePermissionPrompt: true` is in the config dir's
          // settings.json). Our subprocess runs against an isolated
          // CLAUDE_CONFIG_DIR (/tmp/macaron-plugin-isolated-claude) that has
          // no settings.json, so neither condition is met and the CLI silently
          // falls back to default mode — canUseTool fires for every tool call
          // and the "Bypass all" toggle in the WebUI does nothing. Pass the
          // flag explicitly so bypass mode actually takes effect.
          allowDangerouslySkipPermissions: effectivePermissionMode === 'bypassPermissions',
          includePartialMessages: true,
          abortController: opts.abortController,
          mcpServers: { macaron: macaronMcpServer },
          allowedTools: ['mcp__macaron__render_ui'],
          // AskUserQuestion is the CLI's built-in "pick one of these" prompt.
          // We ship render_ui as a superior replacement (real UI, arbitrary
          // widgets, sendUserMessage) so the model doesn't fall back to the
          // text-only Ask variant when a click-to-answer card would beat it.
          // See skills/ask-via-ui/SKILL.md for the authored guidance.
          disallowedTools: ['AskUserQuestion'],
          // canUseTool: pause the SDK, ask the client, resume once decided.
          // A promise is registered under a random id; the client's POST to
          // /permission-decision looks the id up and resolves it.
          // NOTE: when permissionMode === 'bypassPermissions' (and
          // allowDangerouslySkipPermissions is true), the SDK does NOT invoke
          // this callback — every tool auto-approves. That's the intended
          // "yolo" UX.
          canUseTool: async (toolName: string, input: Record<string, unknown>) => {
            // Remembered rules: if a prior "Session"/"Always" decision already
            // covers every part of this call, auto-approve silently — no card,
            // no round-trip. Empty/unknown key sets never match, so this can
            // only ever skip a prompt the user already answered.
            const { keys, label } = computeRuleKeys(toolName, input);
            if (isAllowed(currentSid, opts.cwd, keys)) {
              return { behavior: 'allow', updatedInput: input };
            }
            const id = randomUUID();
            const decision = await new Promise<
              { decision: 'allow'; mode?: PermissionMode; scope?: 'once' | 'session' | 'always' } | { decision: 'deny'; reason?: string }
            >((resolve) => {
              registerPending(id, resolve);
              push({ kind: 'permission_request', id, toolName, input, ...(label ? { suggestion: { label } } : {}) });
            });
            if (decision.decision === 'allow') {
              if (decision.scope === 'session') rememberSession(currentSid, keys);
              // A persist failure must not strand the callback: the user already
              // clicked Allow, so log and proceed rather than leaving the SDK's
              // pending promise (and their tool call) hung forever.
              else if (decision.scope === 'always') {
                try { await rememberProject(opts.cwd, keys); } catch (e) { console.error('[permission-rules] persist failed:', e); }
              }
              push({ kind: 'permission_resolved', id, decision: 'allow' });
              // A `mode` rides along when the plan-approval panel exits plan
              // mode: setMode(session) switches how subsequent edits are
              // gated (acceptEdits = auto, default = ask each time).
              return {
                behavior: 'allow',
                updatedInput: input,
                ...(decision.mode ? { updatedPermissions: [{ type: 'setMode', mode: decision.mode, destination: 'session' }] } : {}),
              };
            }
            push({ kind: 'permission_resolved', id, decision: 'deny' });
            return { behavior: 'deny', message: decision.reason || 'denied by user', interrupt: false };
          },
          ...(opts.envOverrides ? { env: opts.envOverrides } : {}),
        },
      });
      for await (const m of stream as AsyncIterable<SDKMessage>) {
        if (!sessionEmitted && 'session_id' in m && m.session_id) {
          sessionEmitted = true;
          currentSid = m.session_id;
          push({ kind: 'session', sessionId: m.session_id });
        }
        if (m.type === 'stream_event') {
          const ev = m.event;
          if (ev.type === 'message_delta') {
            const usage = (ev as unknown as { usage?: { output_tokens?: number } }).usage;
            if (usage && typeof usage.output_tokens === 'number') {
              push({ kind: 'usage', outputTokens: usage.output_tokens });
            }
          }
          if (ev.type === 'content_block_start') {
            const cb = ev.content_block as {
              type?: string; id?: string; name?: string; input?: unknown;
            };
            if (cb?.type === 'tool_use' && cb.id && cb.name) {
              toolBlocks.set(ev.index, { id: cb.id, name: cb.name, json: '' });
              push({ kind: 'tool_use', id: cb.id, name: cb.name, input: cb.input ?? {} });
            }
          } else if (ev.type === 'content_block_delta') {
            const d = ev.delta as { type?: string; text?: string; partial_json?: string };
            if (d?.type === 'text_delta' && d.text) {
              push({ kind: 'delta', text: d.text });
            } else if (d?.type === 'input_json_delta' && typeof d.partial_json === 'string') {
              const tb = toolBlocks.get(ev.index);
              if (tb) {
                tb.json += d.partial_json;
                push({
                  kind: 'tool_input_delta',
                  id: tb.id,
                  name: tb.name,
                  partial_json: d.partial_json,
                  accumulated: tb.json,
                });
              }
            }
          } else if (ev.type === 'content_block_stop') {
            const tb = toolBlocks.get(ev.index);
            if (tb) {
              push({ kind: 'tool_input_done', id: tb.id, name: tb.name, final_json: tb.json });
              toolBlocks.delete(ev.index);
            }
          }
        } else if (m.type === 'user') {
          const blocks = ((m.message as { content?: unknown })?.content || []) as Array<{
            type?: string; tool_use_id?: string; content?: unknown; is_error?: boolean;
          }>;
          for (const b of blocks) {
            if (b.type === 'tool_result' && b.tool_use_id) {
              const c = b.content;
              const text =
                typeof c === 'string'
                  ? c
                  : Array.isArray(c)
                    ? c.map((x: { text?: string }) => x.text || '').join('')
                    : '';
              push({ kind: 'tool_result', tool_use_id: b.tool_use_id, text, isError: Boolean(b.is_error) });
            }
          }
        } else if (m.type === 'system') {
          if (m.subtype === 'thinking_tokens') {
            const est = (m as unknown as { estimated_tokens?: number }).estimated_tokens;
            if (typeof est === 'number') {
              push({ kind: 'usage', outputTokens: 0, thinkingTokens: est });
            }
          }
          push({ kind: 'message', subtype: m.subtype || 'system' });
        } else if (m.type === 'result') {
          if (m.is_error) {
            const r = m as unknown as {
              subtype?: string;
              stop_reason?: string;
              api_error_status?: number | null;
              errors?: string[];
              result?: string;
            };
            const detail =
              (r.errors && r.errors.length ? r.errors.join(' | ') : '') ||
              r.result ||
              [r.subtype, r.stop_reason, r.api_error_status ? `http ${r.api_error_status}` : '']
                .filter(Boolean)
                .join(' · ') ||
              'unknown SDK error';
            console.log('[claude-runner] SDK error result:', JSON.stringify(r, null, 2));
            push({ kind: 'error', error: detail });
          }
          push({ kind: 'done', exitCode: m.is_error ? 1 : 0 });
          finish();
          return;
        }
      }
      push({ kind: 'done', exitCode: 0 });
    } catch (err) {
      push({ kind: 'error', error: (err as Error).message });
      push({ kind: 'done', exitCode: -1 });
    } finally {
      finish();
    }
  })();

  while (true) {
    const r = await next();
    if (r.done) return;
    yield r.value;
  }
}

// Follow-up question suggestions: a second, throwaway query that resumes the
// just-finished session so it shares the LLM prefix with the main turn —
// provider-side prompt caching kicks in, so it's near-free. persistSession:
// false keeps this off disk (the original transcript is never appended to).
// The prompt is a no-tools-guard (à la Piebald's summarization guard) fused
// with promplate's suggest.j2 content shape: user-perspective, 2-5 items,
// JSON list, same language/tone as the user.
const FOLLOWUP_PROMPT = `CRITICAL: Respond with TEXT ONLY. Do NOT call any tools.
You already have the full conversation above as context — tool calls will be rejected and waste your only turn.

Your task: envisage 2-5 possible follow-up questions the USER could ask next to continue this conversation productively.

Rules:
- User's perspective: questions the user would ask the assistant, not the reverse.
- Each fundamentally different in intent (dive deeper / pivot / verify / request an example / challenge an assumption).
- 2-8 words each, concise, no duplication, no platitudes like "thanks".
- Use THE SAME LANGUAGE and tone as the user's most recent message.

Output ONLY a JSON array of strings, nothing else. Example:
["how does caching work","show a smaller example","what if I skip persistSession"]`;

export type FollowupOptions = {
  resume: string;
  cwd: string;
  model?: string;
  envOverrides?: Record<string, string> | null;
};

// Yields raw text deltas of the model's JSON-array reply. The route forwards
// these as `followup_delta` SSE events; the WebUI accumulates and parses them
// incrementally with partial-json (Allow.ARR) so chips appear as they stream.
// Parsing lives client-side — here we only relay text, never interpret it.
export async function* runFollowup(opts: FollowupOptions): AsyncGenerator<string> {
  const stream = query({
    prompt: FOLLOWUP_PROMPT,
    options: {
      cwd: opts.cwd,
      resume: opts.resume,
      model: opts.model,
      // Advertise the exact same toolset as runClaude so this request's
      // tools+system+messages prefix is byte-identical to the main turn's —
      // that's what makes the provider's prompt cache hit. That takes both
      // the same mcpServers AND a canUseTool callback: without one the SDK
      // drops its interactive tools (AskUserQuestion, EnterPlanMode, …) and
      // injects a "tools no longer available" system block, breaking the
      // prefix. Ours just denies, so nothing can ever execute; maxTurns: 1
      // keeps a stray tool_use from spiraling into an agentic loop.
      mcpServers: { macaron: macaronMcpServer },
      canUseTool: async () => ({ behavior: 'deny', message: 'text-only query', interrupt: true }),
      maxTurns: 1,
      persistSession: false,
      // Stream content_block_delta text so the route can relay it; without
      // this the SDK only emits the final `result` and there's nothing to forward.
      includePartialMessages: true,
      ...(opts.envOverrides ? { env: opts.envOverrides } : {}),
    },
  });
  let got = false;
  for await (const m of stream as AsyncIterable<SDKMessage>) {
    if (m.type === 'stream_event') {
      const ev = m.event;
      if (ev.type === 'content_block_delta') {
        const d = ev.delta as { type?: string; text?: string };
        if (d?.type === 'text_delta' && d.text) {
          got = true;
          yield d.text;
        }
      }
    }
  }
  console.log(`[claude-runner] followup  resume=${opts.resume.slice(0, 8)}  text=${got ? 'ok' : 'empty'}`);
}

