// Wraps @openai/codex-sdk into the same RunnerEvent stream shape as
// claude-runner.ts so the SSE handlers and client store don't need to know
// which engine produced the events. Codex's SDK emits ThreadEvents over
// JSONL (via a spawned codex CLI); we translate them 1:1 into
// {kind:'delta'|'tool_use'|'tool_result'|...}.
//
// Key mapping choices:
//   - `thread.started`               → session (thread_id = our sessionId)
//   - `item.completed { agent_message }` → single delta with full text
//   - `item.completed { reasoning }`     → thinking-tagged event
//   - `item.started/updated/completed { command_execution }` → tool_use +
//     streamed tool_result (Bash-shaped card in the WebUI)
//   - `item.completed { file_change }`   → tool_use + tool_result (patch)
//   - `item.completed { todo_list }`     → synthesized TodoWrite tool_use
//   - `turn.completed`                    → usage + done
//   - `turn.failed` / `error`             → error + done
//
// Streaming caveat: the Codex SDK delivers agent_message text as a single
// `item.completed` (full text landed) rather than a token-level delta
// stream. We emit it as one `delta` for now — good enough for the WebUI
// bubble to render; can be split later if the SDK adds mid-turn updates.

import { execSync } from 'node:child_process';
import { existsSync, writeFileSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import type {
  CodexOptions,
  Input,
  ThreadEvent,
  ThreadItem,
  ThreadOptions,
  UserInput,
} from '@openai/codex-sdk';
import { getActiveCodexProvider, getCodexConfig, type CodexRuntimeOverride } from './codex-config.js';
import type { RunnerEvent, AttachedImage } from './claude-runner.js';

// The Macaron stdio MCP path resolution now lives in macaron-mcp-path.ts so
// kimi-runner can inject the same bridge without pulling in the codex SDK.
// Re-exported for the app-server runner (codex-app-server.ts), which injects
// the same Macaron stdio MCP into its thread/start config.
import { MACARON_MCP_CMD, MACARON_MCP_ARGS } from './macaron-mcp-path.js';
export { MACARON_MCP_CMD, MACARON_MCP_ARGS };

// @openai/codex-sdk ships the `codex` binary via platform-specific optional
// deps. The SDK resolves it from `@openai/codex`'s vendor/ dir; we mirror that
// lookup so the app-server transport (which spawns the binary directly, not via
// the SDK) gets the same bundled fallback the SDK path enjoys.
const PLATFORM_PACKAGE_BY_TARGET: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};
function targetTriple(): string | null {
  const { platform, arch } = process;
  if ((platform === 'linux' || platform === 'android') && arch === 'x64') return 'x86_64-unknown-linux-musl';
  if ((platform === 'linux' || platform === 'android') && arch === 'arm64') return 'aarch64-unknown-linux-musl';
  if (platform === 'darwin' && arch === 'x64') return 'x86_64-apple-darwin';
  if (platform === 'darwin' && arch === 'arm64') return 'aarch64-apple-darwin';
  if (platform === 'win32' && arch === 'x64') return 'x86_64-pc-windows-msvc';
  if (platform === 'win32' && arch === 'arm64') return 'aarch64-pc-windows-msvc';
  return null;
}
function resolveBundledCodex(): string | undefined {
  const triple = targetTriple();
  const pkg = triple ? PLATFORM_PACKAGE_BY_TARGET[triple] : undefined;
  if (!triple || !pkg) return undefined;
  try {
    const req = createRequire(import.meta.url);
    const codexReq = createRequire(req.resolve('@openai/codex/package.json'));
    const vendorRoot = path.join(path.dirname(codexReq.resolve(`${pkg}/package.json`)), 'vendor');
    const bin = process.platform === 'win32' ? 'codex.exe' : 'codex';
    const root = path.join(vendorRoot, triple);
    for (const cand of [path.join(root, 'bin', bin), path.join(root, 'codex', bin)]) {
      if (existsSync(cand)) return cand;
    }
  } catch { /* SDK / platform pkg not installed */ }
  return undefined;
}

// Resolution order: explicit env override, common global install paths,
// `which codex`, then the SDK's bundled platform binary. The bundled fallback
// is last so a user's own codex (matching their terminal CLI) still wins, but a
// plain package install with no global codex no longer regresses to "not found".
function detectCodexBinary(): string | undefined {
  if (process.env.MACARON_CODEX_PATH && existsSync(process.env.MACARON_CODEX_PATH)) {
    return process.env.MACARON_CODEX_PATH;
  }
  for (const p of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', '/usr/bin/codex']) {
    if (existsSync(p)) return p;
  }
  try {
    const which = execSync('which codex', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
    if (which) return which;
  } catch { /* not on PATH */ }
  return resolveBundledCodex();
}
export const CODEX_BINARY = detectCodexBinary();

export type CodexRunOptions = {
  prompt: string;
  cwd: string;
  /** Resume an existing thread_id. Omit for a new thread. */
  resume?: string;
  abortController?: AbortController;
  images?: AttachedImage[];
  /** Per-turn runtime knobs; each field falls back to the global default. */
  runtime?: CodexRuntimeOverride;
};

// Build the CodexOptions + ThreadOptions from our persisted settings plus an
// optional per-turn override. Kept here (not exported) so the runner is the
// single caller — settings changes take effect on the next `runCodex()`
// without hot-reload plumbing. Override fields (effort / sandbox / approval /
// web-search) win over the global defaults when present; omitted fields fall
// back to the global runtime and active provider.
//
// When the active selection is the built-in `system` provider we return the
// minimum surface possible: no baseUrl / apiKey override, no
// `model_providers.*` config entries — the codex CLI reads
// ~/.codex/config.toml as-is. Sandbox / approval come from runtime knobs
// (independent of provider choice) and skipGitRepoCheck stays on so the
// server can spawn threads from arbitrary cwds.
function buildOptions(override?: CodexRuntimeOverride): { codex: CodexOptions; thread: ThreadOptions } {
  const s = getCodexConfig();
  const p = getActiveCodexProvider();
  const sandboxMode = override?.sandboxMode ?? s.runtime.sandboxMode;
  const approvalPolicy = override?.approvalPolicy ?? s.runtime.approvalPolicy;

  // Inject the Macaron stdio MCP server into every codex spawn so `render_ui`
  // is always available regardless of which provider is active. We do NOT
  // touch the user's ~/.codex/config.toml — these keys land as
  // `-c mcp_servers.macaron.command=…` overrides on the codex process.
  const mcpConfig = {
    'mcp_servers.macaron.command': MACARON_MCP_CMD,
    'mcp_servers.macaron.args': MACARON_MCP_ARGS,
    // Under sandbox=workspace-write + approval_policy=never, codex refuses
    // MCP tool calls with "user cancelled MCP tool call" (duration=0)
    // unless the server is explicitly marked auto-approved. `"approve"` is
    // the value that lets the call through without an interactive prompt;
    // `"auto"` counterintuitively does NOT. Kept opt-in per-server (not a
    // global bypass) so only our stdio bridge gets the pass, not any
    // third-party MCP the user might add elsewhere.
    'mcp_servers.macaron.default_tools_approval_mode': 'approve',
    // Enable network egress from the codex process. Under `workspace-write`
    // (our default) codex disables outbound network by default; that broke
    // any exec_command that needed curl/wget/git fetch, including the
    // GenUI-builder skill's optional `curl https://genui.macaron.im/...`
    // probe. Users can still lock this down by setting the runtime
    // sandboxMode to `read-only`, which supersedes this key.
    network_access: 'enabled',
  } satisfies CodexOptions['config'];

  if (!p) {
    // System pass-through — inherit everything from ~/.codex/config.toml.
    // The override fields are the exception: system mode has no provider to
    // read them from, so we thread them through only when the caller set one
    // (a bare `override?.x`, no global fallback — an explicit `false` for
    // webSearchEnabled must be preserved, not collapsed against a default).
    return {
      codex: {
        codexPathOverride: CODEX_BINARY,
        config: mcpConfig,
      },
      thread: {
        sandboxMode,
        approvalPolicy,
        modelReasoningEffort: override?.reasoningEffort,
        webSearchEnabled: override?.webSearchEnabled,
        skipGitRepoCheck: true,
      },
    };
  }

  return {
    codex: {
      codexPathOverride: CODEX_BINARY,
      apiKey: p.apiKey || undefined,
      baseUrl: p.baseUrl || undefined,
      // Flattened into `--config key=value` args by the SDK. Mirrors what
      // the user would put in ~/.codex/config.toml for CLI use.
      config: {
        ...mcpConfig, // network_access + macaron MCP already in here
        model_provider: p.modelProvider,
        model: p.model,
        review_model: p.model,
        model_reasoning_effort: override?.reasoningEffort ?? p.reasoningEffort,
        model_context_window: p.contextWindow,
        model_auto_compact_token_limit: p.autoCompactTokenLimit,
        disable_response_storage: p.disableResponseStorage,
        // The bearer_token pathway; the SDK also sets OPENAI_API_KEY.
        [`model_providers.${p.modelProvider}.name`]: p.modelProvider,
        [`model_providers.${p.modelProvider}.base_url`]: p.baseUrl,
        [`model_providers.${p.modelProvider}.wire_api`]: p.wireApi,
        [`model_providers.${p.modelProvider}.experimental_bearer_token`]: p.apiKey,
      },
    },
    thread: {
      model: p.model,
      sandboxMode,
      approvalPolicy,
      modelReasoningEffort: override?.reasoningEffort ?? p.reasoningEffort,
      webSearchEnabled: override?.webSearchEnabled ?? p.webSearchEnabled,
      skipGitRepoCheck: true,
    },
  };
}

// Build the SDK Input from a text prompt + optional base64 images. Codex only
// accepts `local_image` (a path on disk), not inline data URLs, so each
// attached image is written to a temp file; the caller must remove the
// returned `tmpFiles` once the turn ends.
const IMAGE_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
};
function buildInput(opts: CodexRunOptions): { input: Input; tmpFiles: string[] } {
  if (!opts.images?.length) return { input: opts.prompt, tmpFiles: [] };
  const tmpFiles: string[] = [];
  const items: UserInput[] = [];
  for (const img of opts.images) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(img.dataUrl);
    const mime = m?.[1] || img.mimeType || 'image/png';
    const data = m?.[2] || '';
    if (!data) continue;
    const file = path.join(os.tmpdir(), `macaron-codex-${randomUUID()}.${IMAGE_EXT[mime] || 'png'}`);
    writeFileSync(file, Buffer.from(data, 'base64'));
    tmpFiles.push(file);
    items.push({ type: 'local_image', path: file });
  }
  if (opts.prompt) items.push({ type: 'text', text: opts.prompt });
  return { input: items, tmpFiles };
}

export async function* runCodex(opts: CodexRunOptions): AsyncGenerator<RunnerEvent> {
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

  const { codex: codexOpts, thread: threadOpts } = buildOptions(opts.runtime);
  console.log(
    `[codex-runner] starting  model=${threadOpts.model}  effort=${threadOpts.modelReasoningEffort ?? '(default)'}  sandbox=${threadOpts.sandboxMode}  base=${codexOpts.baseUrl || '(sdk default)'}  resume=${opts.resume ? opts.resume.slice(0, 8) : '(new)'}  cwd=${opts.cwd}`,
  );

  // De-dupe tool cards: item.started and item.updated may fire multiple
  // times before item.completed. We emit tool_use once (started), streaming
  // partial tool_result on updates (command_execution's aggregated_output),
  // then a final tool_result on completed.
  const emittedToolUse = new Set<string>();

  const handleItemEvent = (
    phase: 'started' | 'updated' | 'completed',
    item: ThreadItem,
  ) => {
    switch (item.type) {
      case 'agent_message': {
        // Codex emits agent_message as one atomic item (full text). Emit
        // once on completed so streaming ordering with tool_use events is
        // preserved.
        if (phase !== 'completed') return;
        const text = item.text?.trim();
        if (text) push({ kind: 'delta', text });
        return;
      }
      case 'reasoning': {
        if (phase !== 'completed') return;
        const text = item.text?.trim();
        if (!text) return;
        push({ kind: 'reasoning', text });
        return;
      }
      case 'command_execution': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'Bash',
            input: { command: item.command },
          });
        }
        if (phase === 'completed') {
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: item.aggregated_output || `(exit ${item.exit_code ?? '?'})`,
            isError: item.status === 'failed' || (item.exit_code ?? 0) !== 0,
          });
        }
        return;
      }
      case 'file_change': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'Edit',
            input: { changes: item.changes },
          });
        }
        if (phase === 'completed') {
          const summary = item.changes
            .map((c) => `${c.kind === 'add' ? '＋' : c.kind === 'delete' ? '－' : '△'} ${c.path}`)
            .join('\n');
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: summary || '(no changes)',
            isError: item.status === 'failed',
          });
        }
        return;
      }
      case 'mcp_tool_call': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: `mcp:${item.server}/${item.tool}`,
            input: item.arguments ?? {},
          });
        }
        if (phase === 'completed') {
          const text = item.error?.message
            ?? JSON.stringify(item.result?.content ?? item.result?.structured_content ?? '', null, 2);
          push({
            kind: 'tool_result',
            tool_use_id: id,
            text: (text || '').slice(0, 8000),
            isError: item.status === 'failed',
          });
        }
        return;
      }
      case 'web_search': {
        const id = item.id;
        if (!emittedToolUse.has(id)) {
          emittedToolUse.add(id);
          push({
            kind: 'tool_use',
            id,
            name: 'WebSearch',
            input: { query: item.query },
          });
        }
        if (phase === 'completed') {
          push({ kind: 'tool_result', tool_use_id: id, text: '(search dispatched)', isError: false });
        }
        return;
      }
      case 'todo_list': {
        // Emit as a synthetic TodoWrite so the WebUI's existing todo card
        // renders. Only on completed to avoid churn.
        if (phase !== 'completed') return;
        const id = item.id;
        push({
          kind: 'tool_use',
          id,
          name: 'TodoWrite',
          input: {
            todos: item.items.map((t, i) => ({
              content: t.text,
              status: t.completed ? 'completed' : 'pending',
              activeForm: t.text,
              id: `codex-todo-${i}`,
            })),
          },
        });
        push({ kind: 'tool_result', tool_use_id: id, text: 'todo list updated', isError: false });
        return;
      }
      case 'error': {
        if (phase !== 'completed') return;
        const msg = item.message || 'unknown codex item error';
        // Codex emits the "Skill descriptions were shortened to fit the 2%
        // skills context budget" line as an ErrorItem, but it's purely
        // informational (the skills are still fully loaded, just their
        // descriptions got trimmed). Rendering it as a red Error card in
        // fresh threads scares users; swallow it silently — the model
        // still sees the note in its own context.
        if (/Skill descriptions were shortened/i.test(msg)) return;
        push({ kind: 'error', error: msg });
        return;
      }
      default:
        return;
    }
  };

  void (async () => {
    let sessionEmitted = false;
    // Temp files backing local_image inputs; removed once the turn ends.
    let tmpFiles: string[] = [];
    try {
      // Lazy-import so the default (claude) engine never loads @openai/codex-sdk
      // — the bundled tarball (server/dist/index.js only) has no node_modules, so
      // a top-level import would crash boot with ERR_MODULE_NOT_FOUND.
      const { Codex } = await import('@openai/codex-sdk');
      const codex = new Codex(codexOpts);
      const thread = opts.resume
        ? codex.resumeThread(opts.resume, { ...threadOpts, workingDirectory: opts.cwd })
        : codex.startThread({ ...threadOpts, workingDirectory: opts.cwd });

      // Emit the session id as soon as we can. resumeThread already knows
      // the id; startThread learns it via thread.started below.
      if (opts.resume) {
        sessionEmitted = true;
        push({ kind: 'session', sessionId: opts.resume });
      }

      const built = buildInput(opts);
      tmpFiles = built.tmpFiles;
      const streamed = await thread.runStreamed(built.input, {
        signal: opts.abortController?.signal,
      });

      for await (const ev of streamed.events as AsyncIterable<ThreadEvent>) {
        switch (ev.type) {
          case 'thread.started':
            if (!sessionEmitted) {
              sessionEmitted = true;
              push({ kind: 'session', sessionId: ev.thread_id });
            }
            break;
          case 'turn.started':
            push({ kind: 'message', subtype: 'codex_turn_started' });
            break;
          case 'item.started':
            handleItemEvent('started', ev.item);
            break;
          case 'item.updated':
            handleItemEvent('updated', ev.item);
            break;
          case 'item.completed':
            handleItemEvent('completed', ev.item);
            break;
          case 'turn.completed':
            push({
              kind: 'usage',
              outputTokens: ev.usage.output_tokens,
              thinkingTokens: ev.usage.reasoning_output_tokens,
            });
            push({ kind: 'done', exitCode: 0 });
            finish();
            return;
          case 'turn.failed':
            push({ kind: 'error', error: ev.error?.message || 'codex turn failed' });
            push({ kind: 'done', exitCode: 1 });
            finish();
            return;
          case 'error':
            push({ kind: 'error', error: ev.message || 'codex stream error' });
            push({ kind: 'done', exitCode: 1 });
            finish();
            return;
        }
      }
      push({ kind: 'done', exitCode: 0 });
    } catch (err) {
      push({ kind: 'error', error: (err as Error).message });
      push({ kind: 'done', exitCode: -1 });
    } finally {
      for (const f of tmpFiles) { try { unlinkSync(f); } catch { /* already gone */ } }
      finish();
    }
  })();

  while (true) {
    const r = await next();
    if (r.done) return;
    yield r.value;
  }
}
