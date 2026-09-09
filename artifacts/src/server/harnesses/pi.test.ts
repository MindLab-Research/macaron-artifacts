import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FileEntry } from '@earendil-works/pi-coding-agent';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';
import { PiEventMapper } from './pi-events.js';
import { createPiSession, piMetadataEntries, piPayloadPrefix, restorePiPayloadPrefix, runPiSession } from './pi.js';

const turn = (overrides: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/tmp', prompt: 'hello', instructions: 'Stable UI4A guidance', signal: new AbortController().signal, onNativeSession() {}, approve: async () => true, ...overrides });
const update = (type: string, fields: Record<string, unknown> = {}) => ({ type: 'message_update', assistantMessageEvent: { type, contentIndex: 0, ...fields } });

describe('Pi event mapping', () => {
  test('preserves every text/reasoning delta and closes each native message once', () => {
    const mapper = new PiEventMapper(), chunks: ChatChunk[] = [];
    chunks.push(...mapper.map({ type: 'message_start', message: { role: 'assistant' } }));
    chunks.push(...mapper.map(update('thinking_start')));
    for (const delta of ['one', ' ', 'thought']) chunks.push(...mapper.map(update('thinking_delta', { delta })));
    chunks.push(...mapper.map(update('thinking_end', { content: 'one thought' })));
    chunks.push(...mapper.map({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'one thought' }] } }));
    chunks.push(...mapper.map({ type: 'message_start', message: { role: 'assistant' } }));
    for (const delta of ['```ui4a/tsx\n', 'export ', 'default']) chunks.push(...mapper.map(update('text_delta', { delta })));
    chunks.push(...mapper.map({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: '```ui4a/tsx\nexport default' }] } }));
    expect(chunks.filter(c => c.type === 'text-delta').map(c => c.delta)).toEqual(['```ui4a/tsx\n', 'export ', 'default']);
    expect(chunks.filter(c => c.type === 'reasoning-delta').map(c => c.delta)).toEqual(['one', ' ', 'thought']);
    expect(chunks.filter(c => c.type === 'text-end' || c.type === 'reasoning-end')).toHaveLength(2);
    expect(mapper.finish()).toEqual([]);
  });

  test('takes ids from the SDK partial snapshot and maps tool arguments before execution', () => {
    const mapper = new PiEventMapper(), partial = { content: [{ type: 'toolCall', id: 'write-1', name: 'write', arguments: {} }] }, chunks: ChatChunk[] = [];
    chunks.push(...mapper.map(update('toolcall_start', { partial })));
    const deltas = ['{"path":"test', '.txt","content":"', '你好"}'];
    for (const delta of deltas) chunks.push(...mapper.map(update('toolcall_delta', { partial, delta })));
    chunks.push(...mapper.map(update('toolcall_end', { partial, toolCall: { id: 'write-1', name: 'write', arguments: { path: 'test.txt', content: '你好' } } })));
    chunks.push(...mapper.map({ type: 'tool_execution_start', toolCallId: 'write-1', toolName: 'write', args: { path: 'test.txt', content: '你好' } }));
    chunks.push(...mapper.map({ type: 'tool_execution_end', toolCallId: 'write-1', toolName: 'write', result: { content: [{ type: 'text', text: 'saved' }] } }));
    chunks.push(...mapper.map({ type: 'message_end', message: { role: 'toolResult', toolCallId: 'write-1', content: 'saved' } }));
    expect(chunks[0]).toMatchObject({ type: 'tool-input-start', toolCallId: 'write-1', toolName: 'write' });
    expect(chunks.filter(c => c.type === 'tool-input-delta').map(c => c.inputTextDelta)).toEqual(deltas);
    expect(chunks.filter(c => c.type === 'tool-input-available')).toHaveLength(1);
    expect(chunks.filter(c => c.type === 'tool-output-available')).toHaveLength(1);
  });

  test('closes interrupted tool JSON as an error and preserves cumulative shell output', () => {
    const mapper = new PiEventMapper();
    mapper.map(update('toolcall_start', { id: 'bash-1', toolName: 'bash' }));
    mapper.map(update('toolcall_delta', { delta: '{"command":' }));
    expect(mapper.finish()).toMatchObject([{ type: 'tool-input-error', toolCallId: 'bash-1' }]);
    const output = (text: string) => mapper.map({ type: 'tool_execution_update', toolCallId: 'bash-1', toolName: 'bash', partialResult: { content: [{ type: 'text', text }] } });
    expect(output('hello')).toMatchObject([{ type: 'data-command', data: { output: 'hello' } }]);
    expect(output('hello world')).toMatchObject([{ type: 'data-command', data: { output: ' world' } }]);
    expect(output('hello world')).toEqual([]);
    expect(output('world truncated')).toEqual([]);
    expect(output('world truncated later')).toEqual([]);
  });

  test('includes cache buckets in cumulative usage across tool-loop messages', () => {
    const mapper = new PiEventMapper(), message = { role: 'assistant', content: [], usage: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7 } };
    mapper.map({ type: 'message_end', message });
    expect(mapper.map({ type: 'message_end', message })).toEqual([{ type: 'data-usage', id: 'usage', data: { inputTokens: 28, outputTokens: 6, cachedInputTokens: 10 } }]);
  });
});

test('protects serialized Responses and Google prefixes while retaining the new conversation and abort signal', () => {
  const source = { model: 'model', instructions: 'parent', tools: [{ name: 'tool' }], prompt_cache_key: 'parent-id', input: [{ role: 'developer', content: 'parent rule' }, { role: 'user', content: 'main' }] };
  const next = { ...source, instructions: 'changed', prompt_cache_key: 'new-id', input: [{ role: 'developer', content: 'new rule' }, { role: 'assistant', content: 'answer' }, { role: 'user', content: 'metadata' }] };
  expect(restorePiPayloadPrefix(next, 'openai-responses', piPayloadPrefix(source, 'openai-responses')!)).toEqual({ ...source, input: [source.input[0], ...next.input.slice(1)] });
  const signal = new AbortController().signal;
  const google = { model: 'gemini', contents: [{ role: 'user', parts: [{ text: 'metadata' }] }], config: { abortSignal: signal, systemInstruction: 'new', tools: [], temperature: 0.5 } };
  const result = restorePiPayloadPrefix(google, 'google-generative-ai', piPayloadPrefix({ ...google, config: { systemInstruction: 'parent', tools: [{ functionDeclarations: [] }] } }, 'google-generative-ai')!) as typeof google;
  expect(result.config.abortSignal).toBe(signal); expect(result.config.systemInstruction).toBe('parent'); expect(result.contents).toEqual(google.contents); expect(result.config.temperature).toBe(0.5);
  expect(() => restorePiPayloadPrefix({ custom: true }, 'custom', piPayloadPrefix(source, 'openai-responses')!)).toThrow('no longer matches');
  expect(() => restorePiPayloadPrefix({ ...next, model: 'another-model' }, 'openai-responses', piPayloadPrefix(source, 'openai-responses')!)).toThrow('no longer matches');
});

describe('Pi native SDK with a local scripted provider', () => {
  let directory: string, agentDir: string, cwd: string, oldAgentDir: string | undefined;
  let server: ReturnType<typeof Bun.serve>, requests: Record<string, unknown>[] = [], answer = 'main';
  let streaming!: () => void;
  beforeAll(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'artifacts-pi-')); agentDir = path.join(directory, 'agent'); cwd = path.join(directory, 'work');
    await mkdir(agentDir); await mkdir(cwd);
    oldAgentDir = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as Record<string, unknown>; requests.push(body);
      if (answer === 'waiting') {
        const response = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('data: {"id":"pending","choices":[{"index":0,"delta":{"role":"assistant","content":"first"},"finish_reason":null}]}\n\n')); streaming(); } });
        return new Response(response, { headers: { 'content-type': 'text/event-stream' } });
      }
      const isTool = answer === 'write' || answer === 'confirm';
      const delta = isTool ? { tool_calls: [{ index: 0, id: 'call-write', type: 'function', function: { name: answer === 'confirm' ? 'confirm_probe' : 'write', arguments: answer === 'confirm' ? '{}' : JSON.stringify({ path: path.join(cwd, 'forbidden.txt'), content: 'not allowed' }) } }] } : { content: answer };
      const lines = [
        { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
        { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 'completion', object: 'chat.completion.chunk', created: 1, model: 'stub', choices: [{ index: 0, delta: {}, finish_reason: isTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 3, total_tokens: 23 } },
      ];
      if (isTool) answer = 'after-tool';
      return new Response(lines.map(line => `data: ${JSON.stringify(line)}\n\n`).join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    } });
    await writeFile(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { stub: { baseUrl: `http://127.0.0.1:${server.port}/v1`, api: 'openai-completions', apiKey: 'test-key', models: [{ id: 'stub', name: 'Stub', reasoning: false, input: ['text'], contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    await writeFile(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'stub', defaultModel: 'stub', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false } }));
    await writeFile(path.join(agentDir, 'APPEND_SYSTEM.md'), 'Native user instruction.');
    await mkdir(path.join(agentDir, 'extensions'));
    await writeFile(path.join(agentDir, 'extensions', 'probe.ts'), `export default function(pi) {
      pi.registerTool({ name: 'confirm_probe', label: 'Confirm probe', description: 'Test a native extension confirmation', parameters: { type: 'object', properties: {} }, async execute(_id, _args, _signal, _update, ctx) { const ok = await ctx.ui.confirm('Extension confirmation', 'Proceed?'); return { content: [{ type: 'text', text: String(ok) }] }; } });
      pi.on('session_start', (_event, ctx) => pi.appendEntry('test-extension-start', { session: ctx.sessionManager.getSessionId() }));
      pi.on('session_shutdown', () => pi.appendEntry('test-extension-stop', {}));
      pi.on('before_provider_request', (event, ctx) => {
        const payload = event.payload, id = ctx.sessionManager.getSessionId();
        payload.metadata = { user_id: id };
        return { ...payload, messages: [{ role: 'system', content: 'Final extension prefix: ' + id }, ...payload.messages], tools: payload.tools?.map(tool => ({ ...tool, function: { ...tool.function, description: tool.function.description + ' ' + id } })), prompt_cache_key: 'extension-' + id };
      });
    }`);
  });
  afterAll(async () => { server?.stop(true); if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = oldAgentDir; if (directory) await rm(directory, { recursive: true, force: true }); });

  async function run(options: Partial<HarnessTurn> = {}) { const chunks: ChatChunk[] = []; for await (const chunk of runPiSession(turn({ cwd, ...options }))) chunks.push(chunk); return chunks; }

  test('uses native config/auth discovery, persists history and resumes', async () => {
    let nativeId = ''; requests = []; answer = 'first response';
    const first = await run({ onNativeSession: id => { nativeId = id; } });
    expect(first.filter(c => c.type === 'text-delta').map(c => c.delta).join('')).toBe('first response');
    expect(nativeId).toStartWith(agentDir);
    expect(JSON.stringify(requests[0])).toContain('Native user instruction.');
    expect(JSON.stringify(requests[0])).toContain('Stable UI4A guidance');
    expect((requests[0]!.messages as { content: string }[])[0]!.content).toStartWith('Final extension prefix: ');
    answer = 'second response'; await run({ nativeId, prompt: 'follow up' });
    expect(JSON.stringify(requests.at(-1))).toContain('first response');
    expect(await readFile(nativeId, 'utf8')).toContain('second response');
  }, 30_000);

  test('metadata preserves full history and exact request prefix without writing its parent or executing tools', async () => {
    let nativeId = ''; requests = []; answer = 'latest assistant response';
    await run({ onNativeSession: id => { nativeId = id; } });
    const original = await readFile(nativeId, 'utf8'), mainRequest = requests.at(-1)!;
    // No trailing newline: a native loadEntriesFromFile/open call would repair this, which metadata must never do.
    await writeFile(nativeId, original.trimEnd());
    let callbacks = 0; answer = 'write';
    await run({ nativeId, enrichment: true, prompt: 'metadata only', onNativeSession: () => { callbacks++; }, approve: async () => { throw new Error('Metadata must not ask'); } });
    const metadataRequest = requests.at(-1)!;
    expect(JSON.stringify(metadataRequest)).toContain('latest assistant response');
    expect((metadataRequest.messages as unknown[])[0]).toEqual((mainRequest.messages as unknown[])[0]);
    expect(metadataRequest.prompt_cache_key).toBe(mainRequest.prompt_cache_key);
    expect(metadataRequest.metadata).toEqual(mainRequest.metadata);
    expect((metadataRequest.messages as { role: string }[]).filter(message => message.role === 'system')).toEqual((mainRequest.messages as { role: string }[]).filter(message => message.role === 'system'));
    expect(metadataRequest.tools).toEqual(mainRequest.tools);
    expect(await readFile(nativeId, 'utf8')).toBe(original.trimEnd());
    expect(await Bun.file(path.join(cwd, 'forbidden.txt')).exists()).toBe(false);
    expect(callbacks).toBe(0);
  }, 30_000);

  test('metadata has unique runtime identity, parent affinity and independent native records', async () => {
    let nativeId = ''; answer = 'completed'; await run({ onNativeSession: id => { nativeId = id; } });
    const { parseSessionEntries } = await import('@earendil-works/pi-coding-agent');
    const entries = parseSessionEntries(await readFile(nativeId, 'utf8'));
    const fork = piMetadataEntries(entries);
    expect(fork.entries[0]!.id).not.toBe(entries[0]!.id); expect(fork.affinity).toBe(entries[0]!.id);
    const runtime = await createPiSession(turn({ cwd, nativeId, enrichment: true }));
    try { expect(runtime.session.agent.sessionId).toBe(entries[0]!.id); expect(runtime.session.sessionManager.isPersisted()).toBe(false); expect(runtime.session.messages.at(-1)?.role).toBe('assistant'); }
    finally { await runtime.dispose(); }
    expect(fork.entries).not.toBe(entries);
    expect(() => piMetadataEntries([{ type: 'session', id: 'empty', cwd, timestamp: '', version: 3 }] as FileEntry[])).toThrow('completed');
  }, 30_000);

  test('metadata uses SSE at the provider boundary without changing the parent transport or affinity', async () => {
    let nativeId = ''; answer = 'main'; await run({ onNativeSession: id => { nativeId = id; } });
    const parent = await createPiSession(turn({ cwd, nativeId }));
    const metadata = await createPiSession(turn({ cwd, nativeId, enrichment: true }));
    const seen: unknown[] = [], stream = metadata.session.modelRuntime.streamSimple.bind(metadata.session.modelRuntime);
    metadata.session.modelRuntime.streamSimple = (model, context, options) => { seen.push({ transport: options?.transport, sessionId: options?.sessionId }); return stream(model, context, options); };
    try {
      expect(parent.session.agent.transport).toBe('auto');
      expect(metadata.session.agent.transport).toBe('sse');
      // Even an extension changing Agent.transport cannot make a metadata request
      // acquire a provider socket under the concurrently live parent's cache id.
      metadata.session.agent.transport = 'websocket';
      answer = 'metadata'; await metadata.session.prompt('metadata only'); await metadata.session.waitForIdle();
      expect(seen).toEqual([{ transport: 'sse', sessionId: parent.session.sessionId }]);
      expect(parent.session.agent.transport).toBe('auto'); expect(parent.session.agent.sessionId).toBe(parent.session.sessionId);
    } finally { await metadata.dispose(); await parent.dispose(); }
  }, 30_000);

  test('metadata restores the active native branch without flattening sibling history', async () => {
    let nativeId = ''; answer = 'first branch answer'; await run({ onNativeSession: id => { nativeId = id; } });
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    let native = SessionManager.open(nativeId);
    const branchPoint = native.getLeafId()!;
    answer = 'discarded sibling answer'; await run({ nativeId, prompt: 'sibling prompt' });
    native = SessionManager.open(nativeId); native.branch(branchPoint);
    native.appendMessage({ role: 'user', content: 'active branch prompt', timestamp: Date.now() });
    native.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'active branch answer' }], provider: 'stub', model: 'stub', api: 'openai-completions', stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const original = await readFile(nativeId, 'utf8'); expect(original).toContain('discarded sibling answer');
    requests = []; answer = 'metadata'; await run({ nativeId, enrichment: true, prompt: 'metadata only' });
    const body = JSON.stringify(requests[0]); expect(body).toContain('active branch answer'); expect(body).not.toContain('discarded sibling answer');
    expect(await readFile(nativeId, 'utf8')).toBe(original);
  }, 30_000);

  test('main tool execution awaits approval and denial prevents mutation', async () => {
    let approvals = 0; answer = 'write';
    const chunks = await run({ approve: async request => { approvals++; expect(request.tool).toBe('write'); return false; } });
    expect(approvals).toBe(1); expect(await Bun.file(path.join(cwd, 'forbidden.txt')).exists()).toBe(false);
    expect(chunks.some(c => c.type === 'tool-output-error')).toBe(true);
  }, 30_000);

  test('approval permits the native write tool', async () => {
    answer = 'write';
    await run({ approve: async () => true });
    expect(await readFile(path.join(cwd, 'forbidden.txt'), 'utf8')).toBe('not allowed');
    await rm(path.join(cwd, 'forbidden.txt'));
  }, 30_000);

  test('native extensions load, receive lifecycle events and route confirmations to the host', async () => {
    const approvals: string[] = []; let nativeId = ''; answer = 'confirm';
    await run({ onNativeSession: id => { nativeId = id; }, approve: async request => { approvals.push(request.tool); return true; } });
    expect(approvals).toEqual(['confirm_probe', 'Extension confirmation']);
    const source = await readFile(nativeId, 'utf8'); expect(source).toContain('test-extension-start'); expect(source).toContain('test-extension-stop');
  }, 30_000);

  test('cancels a pending approval and disposes the session', async () => {
    const controller = new AbortController(); answer = 'write';
    let asked!: () => void; const waiting = new Promise<void>(resolve => { asked = resolve; });
    const task = run({ signal: controller.signal, approve: async () => { asked(); return new Promise<boolean>(() => {}); } });
    await waiting; controller.abort(); await expect(task).rejects.toMatchObject({ name: 'AbortError' });
    expect(await Bun.file(path.join(cwd, 'forbidden.txt')).exists()).toBe(false);
  }, 30_000);

  test('cancels a native HTTP stream without waiting for another token', async () => {
    const controller = new AbortController(); answer = 'waiting';
    const waiting = new Promise<void>(resolve => { streaming = resolve; });
    const task = run({ signal: controller.signal });
    await waiting; controller.abort(); await expect(task).rejects.toMatchObject({ name: 'AbortError' });
  }, 30_000);

  test('a callback failure still disposes the native session', async () => {
    const runtime = await createPiSession(turn({ cwd }));
    let disposed = false;
    const dispose = runtime.dispose;
    runtime.dispose = async () => { disposed = true; await dispose(); };
    const task = (async () => { for await (const _ of runPiSession(turn({ cwd, onNativeSession() { throw new Error('save failed'); } }), async () => runtime)) {} })();
    await expect(task).rejects.toThrow('save failed'); expect(disposed).toBe(true);
  }, 30_000);
});
