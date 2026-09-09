import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Agent, Provider, Session } from '@opencode-ai/sdk/v2/types';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';
import { EventQueue } from './common.js';
import { OpenCodeEventMapper } from './opencode-events.js';
import { openCodeDefaultModel, openCodeGuardPlugin, openCodeProfileConfig, openCodeProfileOptions, type OpenCodeConnection, type OpenCodePrompt } from './opencode-server.js';
import { openCodeModel, runOpenCodeConnection } from './opencode.js';

const event = (type: string, properties: Record<string, unknown> = {}) => ({ type, properties });
const message = (role = 'assistant', id = 'message', extra = {}) => event('message.updated', { sessionID: 'native', info: { id, role, ...extra } });
const part = (value: Record<string, unknown>) => event('message.part.updated', { sessionID: 'native', part: { messageID: 'message', id: 'part', type: 'text', text: '', ...value } });
const delta = (text: string) => event('message.part.delta', { sessionID: 'native', messageID: 'message', partID: 'part', field: 'text', delta: text });
const session = (id = 'native', extra = {}) => ({ id, ...extra } as Session);

describe('OpenCode native events', () => {
  test('buffers unknown roles and part kinds without changing native delta boundaries', () => {
    const mapper = new OpenCodeEventMapper(), chunks: ChatChunk[] = [];
    for (const input of [delta('你'), delta('好'), part({ type: 'reasoning', text: '你好' }), message(), part({ type: 'reasoning', text: '你好呀', time: { end: 1 } })]) chunks.push(...mapper.map(input));
    expect(chunks).toEqual([{ type: 'reasoning-start', id: 'part' }, { type: 'reasoning-delta', id: 'part', delta: '你' }, { type: 'reasoning-delta', id: 'part', delta: '好' }, { type: 'reasoning-delta', id: 'part', delta: '呀' }, { type: 'reasoning-end', id: 'part' }]);
    expect(mapper.finish()).toEqual([]);
  });
  test('never echoes user message parts received before role metadata', () => {
    const mapper = new OpenCodeEventMapper();
    expect([delta('secret user text'), part({ text: 'secret user text' }), message('user'), delta('late user text')].flatMap(input => mapper.map(input))).toEqual([]);
  });
  test('maps full tool states once and does not invent streaming tool JSON or command output', () => {
    const mapper = new OpenCodeEventMapper();
    mapper.map(message());
    const tool = (state: Record<string, unknown>) => part({ type: 'tool', tool: 'bash', callID: 'call', state });
    expect(mapper.map(tool({ status: 'pending', raw: '{', input: {} }))).toEqual([]);
    expect(mapper.map(tool({ status: 'running', input: { command: 'pwd' }, metadata: { output: '/tmp' } }))).toEqual([{ type: 'tool-input-available', toolCallId: 'call', toolName: 'bash', input: { command: 'pwd' }, dynamic: true, providerExecuted: true }]);
    expect(mapper.map(tool({ status: 'completed', input: { command: 'pwd' }, output: '/tmp\n' }))).toEqual([{ type: 'tool-output-available', toolCallId: 'call', output: '/tmp\n', dynamic: true, providerExecuted: true }]);
    expect(mapper.map(tool({ status: 'completed', output: '/tmp\n' }))).toEqual([]);
  });
  test('aggregates completed model calls without counting repeated snapshots twice', () => {
    const mapper = new OpenCodeEventMapper(), completed = (id: string, input: number, output: number) => message('assistant', id, { time: { completed: 1 }, tokens: { input, output, cache: { read: 3 } } });
    mapper.map(completed('one', 10, 2)); mapper.map(completed('one', 10, 2));
    expect(mapper.map(completed('two', 20, 4))).toEqual([{ type: 'data-usage', id: 'usage', data: { inputTokens: 36, outputTokens: 6, cachedInputTokens: 6 } }]);
    expect(() => mapper.map(message('assistant', 'failed', { error: { data: { message: 'Bearer credential' } } }))).toThrow('Bearer [redacted]');
  });
  test('includes native cache and reasoning buckets in UI token totals', () => {
    const mapper = new OpenCodeEventMapper();
    expect(mapper.map(message('assistant', 'usage', { time: { completed: 1 }, tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 100, write: 50 } } }))).toEqual([{ type: 'data-usage', id: 'usage', data: { inputTokens: 160, outputTokens: 50, cachedInputTokens: 100 } }]);
  });
});

class FakeConnection implements OpenCodeConnection {
  queue = new EventQueue<unknown>();
  calls: Array<{ method: string; value?: unknown }> = [];
  original = session('native', { model: { id: 'model', providerID: 'provider', variant: 'high' }, agent: 'build', permission: [{ permission: 'bash', pattern: '*', action: 'ask' }] });
  forkID = 'fork';
  onPrompt = (id: string) => { this.emit(id, 'session.status', { status: { type: 'busy' } }); this.emit(id, 'message.updated', { info: { id: 'message', role: 'assistant' } }); this.emit(id, 'message.part.updated', { part: { id: 'part', messageID: 'message', type: 'text', text: '' } }); this.emit(id, 'message.part.delta', { messageID: 'message', partID: 'part', field: 'text', delta: 'hello' }); this.emit(id, 'session.idle'); };
  emit(id: string, type: string, properties = {}) { this.queue.push(event(type, { sessionID: id, ...properties })); }
  async getSession(id: string) { this.calls.push({ method: 'get', value: id }); return this.original; }
  async createSession() { this.calls.push({ method: 'create' }); return this.original; }
  async forkSession(id: string) { this.calls.push({ method: 'fork', value: id }); return session(this.forkID); }
  async copyPermissions(id: string, permission: unknown) { this.calls.push({ method: 'permissions', value: { id, permission } }); }
  async blockTools(id: string) { this.calls.push({ method: 'guard', value: id }); }
  async *events(signal: AbortSignal) {
    const stop = () => this.queue.end(); signal.addEventListener('abort', stop, { once: true });
    try { yield event('server.connected'); yield event('session.idle', { sessionID: 'native' }); yield* this.queue; }
    finally { signal.removeEventListener('abort', stop); }
  }
  async prompt(id: string, prompt: OpenCodePrompt) { this.calls.push({ method: 'prompt', value: { id, prompt } }); this.onPrompt(id); }
  async retry(id: string, messageID: string | undefined, text: string) { this.calls.push({ method: 'retry', value: { id, messageID, text } }); this.onPrompt(id); }
  async replyPermission(id: string, approved: boolean) { this.calls.push({ method: 'reply', value: { id, approved } }); this.emit('native', 'session.idle'); }
  async rejectQuestion(id: string) { this.calls.push({ method: 'question-reject', value: id }); this.emit('native', 'session.idle'); }
  async abort(id: string) { this.calls.push({ method: 'abort', value: id }); this.queue.end(); }
  async deleteSession(id: string) { this.calls.push({ method: 'delete', value: id }); }
  async profileOptions() { return { models: [], efforts: [] }; }
  async defaults() { this.calls.push({ method: 'defaults' }); return { model: 'native/default', agent: 'build' }; }
  async close() { this.calls.push({ method: 'close' }); this.queue.end(); }
}
const makeTurn = (extra: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/tmp', prompt: 'hello', instructions: 'stable instructions', signal: new AbortController().signal, onNativeSession: () => {}, approve: async () => true, ...extra });
async function collect(turn: HarnessTurn, connection: OpenCodeConnection) { const chunks: ChatChunk[] = []; for await (const chunk of runOpenCodeConnection(turn, connection)) chunks.push(chunk); return chunks; }

describe('OpenCode lifecycle', () => {
  test('applies profile model, variant and agent on the next turn without leaking an old variant to a new model', async () => {
    const first = new FakeConnection(), second = new FakeConnection();
    await collect(makeTurn({ nativeId: 'native', profile: { config: { model: 'profile/model', variant: 'max', agent: 'plan' } }, model: 'override/model' }), first);
    await collect(makeTurn({ nativeId: 'native', profile: { config: { model: 'profile/model' } } }), second);
    expect(first.calls.find(call => call.method === 'prompt')?.value).toMatchObject({ prompt: { model: { providerID: 'override', modelID: 'model' }, agent: 'plan', variant: 'max' } });
    expect((second.calls.find(call => call.method === 'prompt')?.value as { prompt: OpenCodePrompt }).prompt.variant).toBe('');
  });
  test('an explicit inherit profile restores native defaults while metadata keeps the completed parent configuration', async () => {
    const connection = new FakeConnection(), metadata = new FakeConnection();
    await collect(makeTurn({ nativeId: 'native', profile: { config: {} } }), connection);
    expect(connection.calls.find(call => call.method === 'prompt')?.value).toMatchObject({ prompt: { model: { providerID: 'native', modelID: 'default' }, agent: 'build', variant: '' } });
    await collect(makeTurn({ nativeId: 'native', profile: { config: {} }, enrichment: true }), metadata);
    expect(metadata.calls.some(call => call.method === 'defaults')).toBe(false);
    expect(metadata.calls.find(call => call.method === 'prompt')?.value).toMatchObject({ prompt: { model: { providerID: 'provider', modelID: 'model' }, variant: 'high' } });
  });
  test('ignores initial idle, resumes the native session and streams the accepted turn', async () => {
    const connection = new FakeConnection(), nativeIDs: string[] = [];
    const chunks = await collect(makeTurn({ nativeId: 'native', onNativeSession: id => nativeIDs.push(id) }), connection);
    expect(nativeIDs).toEqual(['native']);
    expect(chunks.map(chunk => chunk.type)).toEqual(['text-start', 'text-delta', 'text-end']);
    expect(connection.calls.map(call => call.method)).toEqual(['get', 'prompt', 'close']);
    expect(connection.calls[1]?.value).toMatchObject({ id: 'native', prompt: { system: 'stable instructions', agent: 'build', model: { providerID: 'provider', modelID: 'model' }, variant: 'high' } });
  });
  test('uses the native V2 resume operation for failed-turn retry', async () => {
    const connection = new FakeConnection();
    await collect(makeTurn({ nativeId: 'native', retry: true, messageId: 'user' }), connection);
    expect(connection.calls.map(call => call.method)).toEqual(['get', 'retry', 'close']);
    expect(connection.calls[1]?.value).toEqual({ id: 'native', messageID: 'user', text: 'hello' });
  });
  test('forks the complete history, guards execution before prompt and deletes only the fork', async () => {
    const connection = new FakeConnection(), nativeIDs: string[] = [];
    await collect(makeTurn({ nativeId: 'native', enrichment: true, onNativeSession: id => nativeIDs.push(id) }), connection);
    expect(nativeIDs).toEqual([]);
    expect(connection.calls.map(call => call.method)).toEqual(['get', 'fork', 'guard', 'permissions', 'prompt', 'delete', 'close']);
    expect(connection.calls.find(call => call.method === 'prompt')?.value).toMatchObject({ id: 'fork', prompt: { system: 'stable instructions', agent: 'build', model: { providerID: 'provider', modelID: 'model' }, variant: 'high' } });
    expect(connection.calls.find(call => call.method === 'delete')?.value).toBe('fork');
  });
  test('rejects a fork that aliases the main session without deleting it', async () => {
    const connection = new FakeConnection(); connection.forkID = 'native';
    await expect(collect(makeTurn({ nativeId: 'native', enrichment: true }), connection)).rejects.toThrow('isolated metadata fork');
    expect(connection.calls.map(call => call.method)).toEqual(['get', 'fork', 'close']);
  });
  test('forwards native approvals without blocking cancellation', async () => {
    const connection = new FakeConnection(), controller = new AbortController();
    connection.onPrompt = id => { connection.emit(id, 'session.status', { status: { type: 'busy' } }); connection.emit(id, 'permission.asked', { id: 'approval', permission: 'bash', patterns: ['pwd'] }); };
    const approval = Promise.withResolvers<void>();
    const result = collect(makeTurn({ signal: controller.signal, approve: async () => { approval.resolve(); return new Promise(() => {}); } }), connection);
    await approval.promise; controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(connection.calls.slice(-2)).toEqual([{ method: 'abort', value: 'native' }, { method: 'close' }]);
  });
  test('native errors and event disconnection abort the running session and close transport', async () => {
    for (const mode of ['error', 'disconnect']) {
      const connection = new FakeConnection();
      connection.onPrompt = id => { if (mode === 'error') connection.emit(id, 'session.error', { error: { data: { message: 'failure' } } }); else connection.queue.end(); };
      await expect(collect(makeTurn(), connection)).rejects.toThrow(mode === 'error' ? 'failure' : 'event stream ended');
      expect(connection.calls.slice(-2)).toEqual([{ method: 'abort', value: 'native' }, { method: 'close' }]);
    }
  });
  test('context overflow can recover through compaction and a new successful assistant response', async () => {
    const connection = new FakeConnection();
    connection.onPrompt = id => {
      connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant' } });
      connection.emit(id, 'session.error', { error: { name: 'ContextOverflowError', data: { message: 'Context window exceeded' } } });
      connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant', time: { completed: 1 } } });
      connection.emit(id, 'message.updated', { info: { id: 'summary', role: 'assistant', summary: true, finish: 'stop', time: { completed: 2 } } });
      connection.emit(id, 'message.updated', { info: { id: 'answer', role: 'assistant' } });
      connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant', finish: 'error', error: { name: 'ContextOverflowError', data: { message: 'Context window exceeded' } }, time: { completed: 1 } } });
      connection.emit(id, 'message.part.updated', { part: { id: 'part', messageID: 'answer', type: 'text', text: '' } });
      connection.emit(id, 'message.part.delta', { messageID: 'answer', partID: 'part', field: 'text', delta: 'Recovered answer' });
      connection.emit(id, 'message.updated', { info: { id: 'answer', role: 'assistant', finish: 'stop', time: { completed: 3 } } });
      connection.emit(id, 'session.idle');
    };
    const chunks = await collect(makeTurn(), connection);
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['Recovered answer']);
    expect(connection.calls.some(call => call.method === 'abort')).toBe(false);
  });
  test('overflow remains terminal at idle without a new completed non-summary answer', async () => {
    for (const mode of ['idle', 'failed-final', 'failed-error', 'summary-only', 'new-incomplete', 'new-unfinished']) {
      const connection = new FakeConnection();
      connection.onPrompt = id => {
        connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant' } });
        connection.emit(id, 'session.error', { error: { name: 'ContextOverflowError', data: { message: 'Context window exceeded' } } });
        if (mode === 'failed-final') connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant', finish: 'stop', time: { completed: 1 } } });
        if (mode === 'failed-error') connection.emit(id, 'message.updated', { info: { id: 'failed', role: 'assistant', finish: 'error', error: { name: 'ContextOverflowError', data: { message: 'Context window exceeded' } }, time: { completed: 1 } } });
        if (mode === 'summary-only') connection.emit(id, 'message.updated', { info: { id: 'summary', role: 'assistant', summary: true, finish: 'stop', time: { completed: 2 } } });
        if (mode === 'new-incomplete') connection.emit(id, 'message.updated', { info: { id: 'answer', role: 'assistant' } });
        if (mode === 'new-unfinished') connection.emit(id, 'message.updated', { info: { id: 'answer', role: 'assistant', time: { completed: 2 } } });
        connection.emit(id, 'session.status', { status: { type: 'idle' } });
      };
      await expect(collect(makeTurn(), connection)).rejects.toThrow('Context window exceeded');
      expect(connection.calls.at(-1)?.method).toBe('close');
    }
  });
  test('an early consumer return interrupts native generation before closing', async () => {
    const connection = new FakeConnection(); connection.onPrompt = id => { connection.emit(id, 'message.updated', { info: { id: 'message', role: 'assistant' } }); connection.emit(id, 'message.part.updated', { part: { id: 'part', messageID: 'message', type: 'text', text: 'partial' } }); };
    for await (const _chunk of runOpenCodeConnection(makeTurn(), connection)) break;
    expect(connection.calls.slice(-2)).toEqual([{ method: 'abort', value: 'native' }, { method: 'close' }]);
  });
  test('model routing splits only the provider delimiter', () => { expect(openCodeModel('gateway/vendor/model')).toEqual({ providerID: 'gateway', modelID: 'vendor/model' }); expect(() => openCodeModel('model')).toThrow('provider/model'); });
  test('the shared plugin blocks tools only for the isolated metadata session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opencode-guard-test-')), path = join(directory, 'blocked.json'), original = process.env.MACARON_OPENCODE_GUARD_FILE;
    try {
      await writeFile(path, JSON.stringify(['fork'])); process.env.MACARON_OPENCODE_GUARD_FILE = path;
      const plugin = (await import(`data:text/javascript;base64,${Buffer.from(openCodeGuardPlugin).toString('base64')}`)).default;
      const hooks = await plugin.server({ client: {} });
      await hooks['tool.execute.before']({ sessionID: 'main', tool: 'bash' });
      await expect(hooks['tool.execute.before']({ sessionID: 'fork', tool: 'bash' })).rejects.toThrow('Tools are disabled');
      await writeFile(path, 'invalid guard');
      await expect(hooks['tool.execute.before']({ sessionID: 'fork', tool: 'bash' })).rejects.toThrow();
    } finally { if (original === undefined) delete process.env.MACARON_OPENCODE_GUARD_FILE; else process.env.MACARON_OPENCODE_GUARD_FILE = original; await rm(directory, { recursive: true, force: true }); }
  });
  test('fork cache affinity preserves parent routing and respects explicit provider overrides', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'opencode-affinity-test-')), path = join(directory, 'blocked.json'), original = process.env.MACARON_OPENCODE_GUARD_FILE;
    try {
      await writeFile(path, JSON.stringify(['fork'])); process.env.MACARON_OPENCODE_GUARD_FILE = path;
      const plugin = (await import(`data:text/javascript;base64,${Buffer.from(openCodeGuardPlugin).toString('base64')}`)).default;
      const hooks = await plugin.server({ client: { session: { get: async () => ({ data: { metadata: { macaronArtifactsPrefix: { sessionID: 'main' } } } }) } } });
      const params = { options: { promptCacheKey: 'fork', prompt_cache_key: 'fork', user: 'custom-user', reasoningEffort: 'high' } };
      await hooks['chat.params']({ sessionID: 'fork' }, params);
      expect(params.options).toEqual({ promptCacheKey: 'main', prompt_cache_key: 'main', user: 'custom-user', reasoningEffort: 'high' });
      const headers: { headers: Record<string, string> } = { headers: { 'X-Session-Id': 'explicit-route' } };
      await hooks['chat.headers']({ sessionID: 'fork', model: { providerID: 'anthropic', headers: {} } }, headers);
      expect(headers.headers).toEqual({ 'X-Session-Id': 'explicit-route', 'x-session-affinity': 'main' });
      const zen = { headers: {} };
      await hooks['chat.headers']({ sessionID: 'fork', model: { providerID: 'opencode', headers: {} } }, zen);
      expect(zen.headers).toEqual({ 'x-opencode-session': 'main' });
    } finally { if (original === undefined) delete process.env.MACARON_OPENCODE_GUARD_FILE; else process.env.MACARON_OPENCODE_GUARD_FILE = original; await rm(directory, { recursive: true, force: true }); }
  });
});

describe('OpenCode profiles', () => {
  test('native defaults honor config, valid recents, then the native ranked model of a configured provider', () => {
    const providers = [{ id: 'first', models: { main: { id: 'main' } } }, { id: 'configured', models: { preferred: { id: 'preferred' }, recent: { id: 'recent' } } }] as unknown as Provider[];
    const catalog = { providers, default: { first: 'main', configured: 'preferred' } };
    expect(openCodeDefaultModel({ model: 'explicit/model' }, catalog, {})).toBe('explicit/model');
    expect(openCodeDefaultModel({}, catalog, { recent: [{ providerID: 'missing', modelID: 'x' }, { providerID: 'configured', modelID: 'recent' }] })).toBe('configured/recent');
    expect(openCodeDefaultModel({ provider: { configured: {} } }, catalog, { recent: [{ providerID: 'configured', modelID: 'gone' }] })).toBe('configured/preferred');
    expect(openCodeDefaultModel({}, catalog, null)).toBe('first/main');
  });
  test('isolates overlays and preserves native provider, agents, plugins and small model', () => {
    const native = { model: 'local/native', small_model: 'local/small', plugin: ['native-plugin'], agent: { explore: { temperature: 0.1, model: 'local/native' } }, provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: 'https://native.example', apiKey: 'native-key', setCacheKey: true }, models: { native: { name: 'Native' } } } } };
    const before = structuredClone(native), env = process.env.OPENCODE_CONFIG_CONTENT;
    const one = openCodeProfileConfig(native, { config: { model: 'local/one', baseUrl: 'https://one.example', agent: 'plan', agentModels: { explore: 'local/child' } }, apiKey: 'one-key' });
    const two = openCodeProfileConfig(native, { config: { model: 'local/two', baseUrl: 'https://two.example' }, apiKey: 'two-key' });
    expect(one.provider!.local!.options).toEqual({ baseURL: 'https://one.example', apiKey: 'one-key', setCacheKey: true });
    expect(two.provider!.local!.options).toEqual({ baseURL: 'https://two.example', apiKey: 'two-key', setCacheKey: true });
    expect(one.agent!.explore).toEqual({ temperature: 0.1, model: 'local/child' });
    expect(one.small_model).toBe('local/small'); expect(one.plugin).toEqual(['native-plugin']); expect(one.default_agent).toBe('plan');
    expect(one.provider!.local!.models).toEqual(native.provider.local.models); expect(native).toEqual(before); expect(process.env.OPENCODE_CONFIG_CONTENT).toBe(env);
    expect(openCodeProfileConfig(native, { config: { model: 'local/native', authMode: 'inherit' }, apiKey: 'unused' }).provider!.local!.options!.apiKey).toBe('native-key');
    expect(() => openCodeProfileConfig({}, { config: { baseUrl: 'https://proxy.example' } })).toThrow('Choose an OpenCode provider');
    expect(openCodeProfileConfig({}, { config: { model: 'profile/main' }, apiKey: 'key' }, 'override/main').provider).toEqual({ override: { options: { apiKey: 'key' } } });
  });
  test('publishes model-specific variants and agent names without native secrets', () => {
    const providers = [{ id: 'local', name: 'Local', key: 'secret', options: { apiKey: 'secret' }, models: { main: { id: 'main', name: 'Main', headers: { Authorization: 'secret' }, variants: { high: { reasoningEffort: 'high' }, disabled: { disabled: true } } } } }] as unknown as Provider[];
    const agents: Agent[] = [{ name: 'build', mode: 'primary', prompt: 'private', permission: [], options: {} }, { name: 'explore', mode: 'subagent', permission: [], options: { apiKey: 'secret' } }];
    expect(openCodeProfileOptions(providers, agents)).toEqual({ models: [{ id: 'local/main', name: 'Main', provider: 'local', efforts: ['high'] }], efforts: [], agents: [{ id: 'build', name: 'build', subagent: false }, { id: 'explore', name: 'explore', subagent: true }] });
  });
});
