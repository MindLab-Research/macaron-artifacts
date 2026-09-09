import { describe, expect, test } from 'bun:test';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';
import { ClaudeEventMapper, claudeOptions } from './claude.js';
import { CodexEventMapper } from './codex-events.js';
import { codexServerRequest, codexThreadParams, runCodexConnection } from './codex.js';
import type { CodexConnection } from './codex-rpc.js';

const turn = (overrides: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/tmp', prompt: 'hello', instructions: 'Stable UI4A guidance', signal: new AbortController().signal, onNativeSession() {}, approve: async () => true, ...overrides });
const partial = (event: unknown, parent_tool_use_id: string | null = null) => ({ type: 'stream_event', session_id: 'native-main', parent_tool_use_id, event });

describe('Claude native deltas', () => {
  test('keeps every token boundary and suppresses the completed message echo', () => {
    const mapper = new ClaudeEventMapper(), chunks: ChatChunk[] = [];
    chunks.push(...mapper.map(partial({ type: 'message_start', message: { id: 'm1' } })));
    chunks.push(...mapper.map(partial({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })));
    const deltas = ['你', '好', '\n```ui4a/tsx\n', 'export ', 'default'];
    for (const text of deltas) chunks.push(...mapper.map(partial({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } })));
    chunks.push(...mapper.map(partial({ type: 'content_block_stop', index: 0 })));
    chunks.push(...mapper.map(partial({ type: 'message_stop' })));
    chunks.push(...mapper.map({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: deltas.join('') }] } }));
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta)).toEqual(deltas);
    expect(chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'text-end')).toHaveLength(1);
  });

  test('streams reasoning separately and keeps subagent block indexes distinct', () => {
    const mapper = new ClaudeEventMapper();
    mapper.map(partial({ type: 'message_start', message: { id: 'm1' } }));
    mapper.map(partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }));
    mapper.map(partial({ type: 'message_start', message: { id: 'm2' } }, 'agent-tool'));
    mapper.map(partial({ type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } }, 'agent-tool'));
    const main = mapper.map(partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'main' } }));
    const child = mapper.map(partial({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'child' } }, 'agent-tool'));
    expect(main[0]).toMatchObject({ type: 'reasoning-delta', delta: 'main' });
    expect(child[0]).toMatchObject({ type: 'reasoning-delta', delta: 'child' });
    expect(main[0]).not.toHaveProperty('id', 'claude:agent-tool:m2:0');
    expect(mapper.finish().filter((chunk) => chunk.type === 'reasoning-end')).toHaveLength(2);
  });

  test('preserves partial JSON and validates the final input before the tool result', () => {
    const mapper = new ClaudeEventMapper(), chunks: ChatChunk[] = [];
    mapper.map(partial({ type: 'message_start', message: { id: 'm1' } }));
    chunks.push(...mapper.map(partial({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'write1', name: 'Write', input: {} } })));
    const deltas = ['{"file_path":".artifacts/', 'example.tsx","content":"', 'hello\\nworld"}'];
    for (const partial_json of deltas) chunks.push(...mapper.map(partial({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json } })));
    chunks.push(...mapper.map(partial({ type: 'content_block_stop', index: 2 })));
    chunks.push(...mapper.map({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'write1', content: 'saved' }] } }));
    expect(chunks.filter((chunk) => chunk.type === 'tool-input-delta').map((chunk) => chunk.inputTextDelta)).toEqual(deltas);
    expect(chunks.at(-2)).toMatchObject({ type: 'tool-input-available', input: { file_path: '.artifacts/example.tsx', content: 'hello\nworld' } });
    expect(chunks.at(-1)).toMatchObject({ type: 'tool-output-available', toolCallId: 'write1', output: 'saved' });
  });

  test('preserves input/cache usage when an output-only native update follows', () => {
    const mapper = new ClaudeEventMapper();
    mapper.map(partial({ type: 'message_start', message: { id: 'm1', usage: { input_tokens: 123, cache_read_input_tokens: 456, output_tokens: 1 } } }));
    expect(mapper.map(partial({ type: 'message_delta', usage: { output_tokens: 20 } }))).toEqual([{ type: 'data-usage', id: 'usage', data: { inputTokens: 579, outputTokens: 20, cachedInputTokens: 456 } }]);
  });

  test('metadata keeps the bootstrap and callback tool schema while forking without persistence', async () => {
    const main = claudeOptions(turn({ nativeId: 'main', model: 'configured-model' }), new AbortController());
    let approvalCount = 0;
    const fork = claudeOptions(turn({ nativeId: 'main', model: 'configured-model', enrichment: true, approve: async () => { approvalCount++; return true; } }), new AbortController());
    expect(fork.systemPrompt).toEqual(main.systemPrompt);
    expect(fork.model).toEqual(main.model);
    expect(fork.resume).toBe('main'); expect(fork.forkSession).toBe(true); expect(fork.persistSession).toBe(false);
    expect(fork.tools).toEqual(main.tools); expect(fork.disallowedTools).toEqual(main.disallowedTools);
    expect(fork.canUseTool).toBeFunction(); expect(main.canUseTool).toBeFunction();
    const decision = await fork.canUseTool!('Write', { file_path: '/tmp/never' }, { signal: new AbortController().signal, toolUseID: 't1', requestId: 'approval1' });
    expect(decision?.behavior).toBe('deny'); expect(approvalCount).toBe(0);
    const hook = fork.hooks!.PreToolUse![0]!.hooks[0]!;
    const gate = await hook({ hook_event_name: 'PreToolUse', session_id: 'fork', transcript_path: '', cwd: '/tmp', tool_name: 'Write', tool_input: {}, tool_use_id: 't1' }, 't1', { signal: new AbortController().signal });
    expect(gate).toMatchObject({ hookSpecificOutput: { permissionDecision: 'deny' } });
  });
  test('uses Claude native continuation for a failed-turn retry', () => {
    const options = claudeOptions(turn({ nativeId: 'main', retry: true }), new AbortController());
    expect(options.continue).toBe(true);
    expect(options.resume).toBeUndefined();
  });
});

describe('Codex native deltas', () => {
  test('streams text and both reasoning channels without completion duplicates', () => {
    const mapper = new CodexEventMapper(), chunks: ChatChunk[] = [];
    chunks.push(...mapper.map('item/started', { item: { id: 'a', type: 'agentMessage', text: '' } }));
    for (const delta of ['A', ' ', '中']) chunks.push(...mapper.map('item/agentMessage/delta', { itemId: 'a', delta }));
    chunks.push(...mapper.map('item/completed', { item: { id: 'a', type: 'agentMessage', text: 'A 中' } }));
    chunks.push(...mapper.map('item/reasoning/summaryTextDelta', { itemId: 'r', summaryIndex: 0, delta: 'Summary' }));
    chunks.push(...mapper.map('item/reasoning/textDelta', { itemId: 'r', contentIndex: 0, delta: 'Detail' }));
    chunks.push(...mapper.map('item/completed', { item: { id: 'r', type: 'reasoning', summary: ['Summary'], content: ['Detail'] } }));
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta)).toEqual(['A', ' ', '中']);
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-delta').map((chunk) => chunk.delta)).toEqual(['Summary', 'Detail']);
    expect(chunks.filter((chunk) => chunk.type === 'reasoning-end')).toHaveLength(2);
  });

  test('keeps each native command output delta rather than synthesizing final output chunks', () => {
    const mapper = new CodexEventMapper(), chunks: ChatChunk[] = [];
    chunks.push(...mapper.map('item/started', { item: { id: 'cmd', type: 'commandExecution', command: 'echo test', cwd: '/tmp' } }));
    for (const delta of ['te', 'st', '\n']) chunks.push(...mapper.map('item/commandExecution/outputDelta', { itemId: 'cmd', delta }));
    chunks.push(...mapper.map('item/completed', { item: { id: 'cmd', type: 'commandExecution', command: 'echo test', aggregatedOutput: 'test\n', status: 'completed', exitCode: 0 } }));
    expect(chunks.filter((chunk) => chunk.type === 'data-command').map((chunk) => chunk.data.output)).toEqual(['te', 'st', '\n']);
    expect(chunks.filter((chunk) => chunk.type === 'tool-input-delta')).toHaveLength(0);
    expect(chunks.at(-1)).toMatchObject({ type: 'tool-output-available', output: 'test\n' });
  });

  test('emits native cached-token accounting', () => {
    const mapper = new CodexEventMapper();
    expect(mapper.map('thread/tokenUsage/updated', { tokenUsage: { last: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 }, total: { inputTokens: 10000 } } })).toEqual([{ type: 'data-usage', id: 'usage', data: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 80 } }]);
  });
});

class ReplayConnection implements CodexConnection {
  notification?: CodexConnection['notification']; serverRequest?: CodexConnection['serverRequest']; failure?: CodexConnection['failure'];
  calls: { method: string; params: unknown }[] = []; closed = false;
  constructor(private mode: 'complete' | 'failed' | 'waiting' | 'setup-error' = 'complete') {}
  async request(method: string, params: unknown): Promise<Record<string, unknown>> {
    this.calls.push({ method, params });
    if (method === 'initialize') return {};
    if (this.mode === 'setup-error') throw new Error('Fixture setup failed');
    if (method.startsWith('thread/')) {
      this.notification?.('item/agentMessage/delta', { threadId: 'native', itemId: 'history', delta: 'Old history must not replay' });
      return { thread: { id: method === 'thread/fork' ? 'fork' : 'native' } };
    }
    if (method === 'turn/start') {
      const threadId = (params as { threadId: string }).threadId;
      this.notification?.('turn/started', { threadId, turn: { id: 't1' } });
      this.notification?.('item/agentMessage/delta', { threadId, itemId: 'text', delta: 'fresh' });
      if (this.mode !== 'waiting') this.notification?.('turn/completed', { threadId, turn: { status: this.mode === 'failed' ? 'failed' : 'completed', error: { message: 'Fixture failed' } } });
      return { turn: { id: 't1' } };
    }
    return {};
  }
  notify(method: string, params: unknown) { this.calls.push({ method, params }); }
  async close() { this.closed = true; }
}

describe('Codex turn lifecycle', () => {
  test('waits for initialize/resume responses and ignores native history replay', async () => {
    const connection = new ReplayConnection(), ids: string[] = [], chunks: ChatChunk[] = [];
    for await (const chunk of runCodexConnection(turn({ nativeId: 'native', onNativeSession: (id) => ids.push(id) }), connection)) chunks.push(chunk);
    expect(connection.calls.map((call) => call.method)).toEqual(['initialize', 'initialized', 'thread/resume', 'turn/start']);
    expect(chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.delta)).toEqual(['fresh']);
    expect(ids).toEqual(['native']); expect(connection.closed).toBe(true);
  });
  test('starts a failed-turn retry with Codex native empty input', async () => {
    const connection = new ReplayConnection();
    for await (const _chunk of runCodexConnection(turn({ nativeId: 'native', retry: true }), connection)) { /* Drain the actual adapter. */ }
    expect(connection.calls.find(call => call.method === 'turn/start')?.params).toMatchObject({ threadId: 'native', input: [] });
  });

  test('an ephemeral metadata fork cannot overwrite the durable native id', async () => {
    const connection = new ReplayConnection(), ids: string[] = [];
    const main = turn({ nativeId: 'native', model: 'configured-model', onNativeSession: (id) => ids.push(id) });
    for await (const _ of runCodexConnection({ ...main, enrichment: true }, connection)) { /* Drain the actual adapter. */ }
    expect(connection.calls[2]).toMatchObject({ method: 'thread/fork', params: { threadId: 'native', ephemeral: true, excludeTurns: true, sandbox: 'read-only' } });
    // The native server rejects deferGoalContinuation together with ephemeral, even though both fields appear in its schema.
    expect(codexThreadParams({ ...main, enrichment: true })).not.toHaveProperty('deferGoalContinuation');
    expect(codexThreadParams({ ...main, enrichment: true }).developerInstructions).toBe(codexThreadParams(main).developerInstructions);
    expect(codexThreadParams({ ...main, enrichment: true }).model).toBe(codexThreadParams(main).model);
    expect(ids).toEqual([]); expect(connection.closed).toBe(true);
  });

  test('native failures and consumer cancellation both clean up', async () => {
    for (const mode of ['failed', 'setup-error'] as const) {
      const connection = new ReplayConnection(mode);
      await expect(async () => { for await (const _ of runCodexConnection(turn(), connection)) {} }).toThrow();
      expect(connection.closed).toBe(true);
    }
    const connection = new ReplayConnection('waiting');
    for await (const _ of runCodexConnection(turn(), connection)) break;
    expect(connection.closed).toBe(true);
  });

  test('abort interrupts the native turn and releases the connection', async () => {
    const connection = new ReplayConnection('waiting'), controller = new AbortController();
    const request = connection.request.bind(connection);
    connection.request = async (method, params) => {
      const response = await request(method, params);
      if (method === 'turn/interrupt') connection.notification?.('turn/completed', { threadId: 'native', turn: { status: 'interrupted' } });
      return response;
    };
    let error: unknown;
    try { for await (const _ of runCodexConnection(turn({ signal: controller.signal }), connection)) controller.abort(); } catch (caught) { error = caught; }
    expect(error).toMatchObject({ name: 'AbortError' }); expect(connection.closed).toBe(true);
    expect(connection.calls).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'native', turnId: 't1' } });
  });

  test('abort waits for native completion after interrupt acknowledgement before closing', async () => {
    const connection = new ReplayConnection('waiting'), controller = new AbortController();
    let acknowledged!: () => void;
    const ack = new Promise<void>(resolve => { acknowledged = resolve; }), request = connection.request.bind(connection);
    connection.request = async (method, params) => { const result = await request(method, params); if (method === 'turn/interrupt') acknowledged(); return result; };
    const stream = runCodexConnection(turn({ signal: controller.signal }), connection);
    await stream.next(); controller.abort();
    const draining = (async () => { try { for await (const _ of stream) {} } catch (error) { expect(error).toMatchObject({ name: 'AbortError' }); } })();
    await ack;
    // Let queued cleanup microtasks run: the old implementation closed here immediately.
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(connection.closed).toBe(false);
    connection.notification?.('turn/completed', { threadId: 'native', turn: { status: 'interrupted' } });
    await draining; expect(connection.closed).toBe(true);
  });

  test('abort during turn/start waits for the returned turn id and interrupts it', async () => {
    const connection = new ReplayConnection('waiting'), controller = new AbortController();
    let starting!: () => void, resolveStart!: (value: Record<string, unknown>) => void;
    const started = new Promise<void>(resolve => { starting = resolve; }), pendingStart = new Promise<Record<string, unknown>>(resolve => { resolveStart = resolve; });
    const request = connection.request.bind(connection);
    connection.request = async (method, params) => {
      if (method === 'turn/start') { connection.calls.push({ method, params }); starting(); return pendingStart; }
      const response = await request(method, params);
      if (method === 'turn/interrupt') connection.notification?.('turn/completed', { threadId: 'native', turn: { status: 'interrupted' } });
      return response;
    };
    const draining = (async () => { try { for await (const _ of runCodexConnection(turn({ signal: controller.signal }), connection)) {} } catch (error) { expect(error).toMatchObject({ name: 'AbortError' }); } })();
    await started; controller.abort(); await new Promise<void>(resolve => setImmediate(resolve));
    expect(connection.closed).toBe(false);
    resolveStart({ turn: { id: 'late-turn' } }); await draining;
    expect(connection.calls).toContainEqual({ method: 'turn/interrupt', params: { threadId: 'native', turnId: 'late-turn' } });
    expect(connection.closed).toBe(true);
  });

  test('an unresponsive turn/start is forcibly closed at the cancellation deadline', async () => {
    const connection = new ReplayConnection('waiting'), controller = new AbortController();
    let starting!: () => void, rejectStart!: (error: Error) => void;
    const started = new Promise<void>(resolve => { starting = resolve; }), pendingStart = new Promise<Record<string, unknown>>((_, reject) => { rejectStart = reject; });
    const request = connection.request.bind(connection);
    connection.request = async (method, params) => { if (method === 'turn/start') { starting(); return pendingStart; } return request(method, params); };
    connection.close = async () => { connection.closed = true; rejectStart(new Error('Connection closed')); };
    const draining = (async () => { try { for await (const _ of runCodexConnection(turn({ signal: controller.signal }), connection)) {} } catch (error) { expect(error).toMatchObject({ name: 'AbortError' }); } })();
    await started; const since = performance.now(); controller.abort(); await draining;
    expect(connection.closed).toBe(true); expect(performance.now() - since).toBeLessThan(3500);
    expect(connection.calls.some(call => call.method === 'turn/interrupt')).toBe(false);
  });

  test('metadata auto-denies native approvals while main turns await the user callback', async () => {
    let approved = 0;
    const source = turn({ approve: async () => { approved++; return true; } });
    const params = { threadId: 'native', itemId: 'cmd', command: 'touch /tmp/example' };
    expect(await codexServerRequest({ ...source, enrichment: true }, 'item/commandExecution/requestApproval', params)).toEqual({ decision: 'decline' });
    expect(approved).toBe(0);
    expect(await codexServerRequest(source, 'item/commandExecution/requestApproval', params)).toEqual({ decision: 'accept' });
    expect(approved).toBe(1);
  });
});
