import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk } from '../../shared/types.js';
import type { FormInfo1, OpenCodeClient } from '@opencode/client';
import type { HarnessTurn } from './types.js';
import type { OpenCodeV2Connection } from './opencode-v2-server.js';
import { EventQueue } from './common.js';
import { openCodeBinary, requireOpenCodeBinary } from './opencode-binary.js';
import { OpenCodeV2EventMapper } from './opencode-v2-events.js';
import { openCodeV2Model, openCodeV2ProfileConfig } from './opencode-v2-server.js';
import { openCodeV2Questions, openCodeV2Answers, openCodeV2MessageID, runOpenCodeV2Connection } from './opencode-v2.js';

const event = (type: string, data: Record<string, unknown> = {}) => ({ type, data: { sessionID: 'main', assistantMessageID: 'answer', ...data } });
const turn = (overrides: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/workspace', instructions: 'stable', prompt: 'hello', signal: AbortSignal.timeout(1000), onNativeSession() {}, approve: async () => true, ask: async () => ({ cancelled: true }), ...overrides });
function fake(emit: (queue: EventQueue<unknown>, id: string) => void) {
  const events = new EventQueue<unknown>(), calls: { method: string; input?: any }[] = [];
  const method = (name: string, value?: any) => async (input: any) => { calls.push({ method: name, input }); return value; };
  const connection: OpenCodeV2Connection = {
    client: {
      session: {
        get: method('get', { id: 'main', model: { providerID: 'local', id: 'main', variant: 'high' }, permissions: [] }),
        create: method('create', { id: 'main' }), fork: method('fork', { id: 'fork', fork: { sessionID: 'main' } }),
        update: method('update'), switchAgent: method('agent'), switchModel: method('model'),
        prompt: async (input: any) => { calls.push({ method: 'prompt', input }); emit(events, input.sessionID); },
        interrupt: method('interrupt'), remove: method('remove'), form: { reply: method('form.reply'), cancel: method('form.cancel') },
      },
      permission: { reply: method('permission.reply') },
      event: { subscribe: ({ signal }: { signal: AbortSignal }) => { events.push(event('server.connected')); signal.addEventListener('abort', () => events.end(), { once: true }); return events; } },
    } as unknown as OpenCodeClient,
    options: signal => ({ signal }), guard: async (...args) => { calls.push({ method: 'guard', input: args }); },
    defaults: async () => ({ agent: 'build', model: { providerID: 'local', id: 'default' } }),
    profileOptions: async () => ({ models: [], efforts: [] }), close: async () => { calls.push({ method: 'close' }); events.end(); },
  };
  return { connection, events, calls };
}
async function collect(input: HarnessTurn, connection: OpenCodeV2Connection) { const result: ChatChunk[] = []; for await (const chunk of runOpenCodeV2Connection(input, connection)) result.push(chunk); return result; }
const success = (queue: EventQueue<unknown>, sessionID: string) => { queue.push(event('session.text.delta', { sessionID, ordinal: 0, delta: 'answer' })); queue.push(event('session.execution.succeeded', { sessionID })); };

describe('native OpenCode v2 events', () => {
  test('native data/ordinal text and reasoning snapshots do not duplicate deltas', () => {
    const mapper = new OpenCodeV2EventMapper(), chunks = [
      ...mapper.map(event('session.text.delta', { ordinal: 0, delta: 'ab' })),
      ...mapper.map(event('session.text.ended', { ordinal: 0, text: 'abc' })),
      ...mapper.map(event('session.reasoning.delta', { ordinal: 1, delta: 'why' })), ...mapper.finish(), ...mapper.finish(),
    ];
    expect(chunks.map(chunk => chunk.type)).toEqual(['text-start', 'text-delta', 'text-delta', 'text-end', 'reasoning-start', 'reasoning-delta', 'reasoning-end']);
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['ab', 'c']);
  });
  test('native tool deltas, called input, terminal results and usage', () => {
    const mapper = new OpenCodeV2EventMapper();
    expect(mapper.map(event('session.tool.input.started', { id: 'tool', name: 'shell' }))[0]).toMatchObject({ type: 'tool-input-start', toolName: 'shell' });
    expect(mapper.map(event('session.tool.input.delta', { id: 'tool', delta: '{' }))[0]).toMatchObject({ type: 'tool-input-delta', inputTextDelta: '{' });
    expect(mapper.map(event('session.tool.called', { id: 'tool', input: { command: 'pwd' } }))[0]).toMatchObject({ type: 'tool-input-available', toolName: 'shell' });
    expect(mapper.map(event('session.tool.failed', { id: 'tool', error: { message: 'blocked' } }))[0]).toMatchObject({ type: 'tool-output-error', errorText: 'blocked' });
    expect(mapper.map(event('session.tool.failed', { id: 'tool', error: { message: 'blocked' } }))).toEqual([]);
    const usage = event('session.step.ended', { tokens: { input: 10, output: 2, reasoning: 3, cache: { read: 4, write: 1 } } });
    expect(mapper.map(usage)[0]).toMatchObject({ type: 'data-usage', data: { inputTokens: 15, outputTokens: 5, cachedInputTokens: 4 } });
    expect(mapper.map(usage)[0]).toMatchObject({ data: { inputTokens: 15 } });
  });
});

describe('native OpenCode v2 lifecycle', () => {
  test('create/resume and terminal execution events, never session.idle', async () => {
    const value = fake((queue, id) => { queue.push(event('session.idle')); queue.push(event('session.text.delta', { sessionID: 'other', ordinal: 0, delta: 'wrong' })); success(queue, id); });
    const chunks = await collect(turn({ nativeId: 'main' }), value.connection);
    expect(chunks.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta).join('')).toBe('answer');
    expect(value.calls.map(call => call.method)).not.toContain('create');
    expect(value.calls.at(-1)?.method).toBe('close');
  });
  test('retry preserves native identity and requests resume without model switch', async () => {
    const value = fake(success); await collect(turn({ nativeId: 'main', retry: true, messageId: 'message-1', model: 'local/ignored' }), value.connection);
    expect(value.calls.find(call => call.method === 'prompt')?.input).toMatchObject({ id: openCodeV2MessageID('message-1'), resume: true });
    expect(openCodeV2MessageID('message-1')).toMatch(/^msg_[a-f0-9]+$/);
    expect(openCodeV2MessageID('message-1')).not.toBe(openCodeV2MessageID('message-2'));
    expect(value.calls.some(call => call.method === 'model')).toBe(false);
  });
  test('explicit inherit profile resets model and stale variant while forks retain parent model', async () => {
    const value = fake(success); await collect(turn({ nativeId: 'main', profile: { config: {} } }), value.connection);
    expect(value.calls.find(call => call.method === 'model')?.input.model).toEqual({ providerID: 'local', id: 'default' });
    const fork = fake(success); await collect(turn({ nativeId: 'main', profile: { config: {} }, enrichment: true }), fork.connection);
    expect(fork.calls.find(call => call.method === 'guard')?.input).toEqual(['fork', 'stable', 'main']);
    expect(fork.calls.filter(call => call.method === 'remove').map(call => call.input.sessionID)).toEqual(['fork']);
    expect(fork.calls.some(call => call.method === 'model')).toBe(false);
  });
  test('failed/interrupted/disconnected streams surface errors and clean up', async () => {
    for (const type of ['session.execution.failed', 'session.execution.interrupted', 'disconnect']) {
      const value = fake(queue => type === 'disconnect' ? queue.end() : queue.push(event(type, { error: { message: 'native failed' } })));
      await expect(collect(turn(), value.connection)).rejects.toThrow(type === 'session.execution.failed' ? 'native failed' : type === 'disconnect' ? 'stream ended' : 'interrupted');
      expect(value.calls.at(-1)?.method).toBe('close');
    }
  });
  test('permissions expose the native v2 action, not the v1 permission field', async () => {
    const value = fake((queue, id) => { queue.push(event('permission.asked', { id: 'approval', action: 'shell', resources: ['pwd'] })); success(queue, id); });
    const approvals: unknown[] = [];
    await collect(turn({ approve: async request => { approvals.push(request); return true; } }), value.connection);
    expect(approvals).toEqual([{ id: 'approval', tool: 'shell', input: expect.objectContaining({ action: 'shell', resources: ['pwd'] }) }]);
  });
  test('cancellation while permission UI is unresolved cannot hang the event pump', async () => {
    const controller = new AbortController(), value = fake(queue => { queue.push(event('permission.asked', { id: 'approval', action: 'shell', resources: ['pwd'] })); setTimeout(() => controller.abort(), 5); });
    await expect(collect(turn({ signal: controller.signal, approve: () => new Promise(() => {}) }), value.connection)).rejects.toThrow('interrupted');
    expect(value.calls.map(call => call.method)).toContain('interrupt');
  });
  test('fork alias rejection never deletes the parent; early consumer return interrupts', async () => {
    const alias = fake(success);
    alias.connection.client.session.fork = async () => ({ id: 'main' }) as never;
    await expect(collect(turn({ nativeId: 'main', enrichment: true }), alias.connection)).rejects.toThrow('isolated metadata fork');
    expect(alias.calls.some(call => call.method === 'remove')).toBe(false);
    const early = fake(queue => queue.push(event('session.text.delta', { ordinal: 0, delta: 'partial' })));
    for await (const _chunk of runOpenCodeV2Connection(turn(), early.connection)) break;
    expect(early.calls.map(call => call.method)).toContain('interrupt');
    expect(early.calls.at(-1)?.method).toBe('close');
  });
  test('guard failure prevents prompt and disposes metadata fork', async () => {
    const value = fake(success); value.connection.guard = async () => { throw Error('guard unavailable'); };
    await expect(collect(turn({ nativeId: 'main', enrichment: true }), value.connection)).rejects.toThrow('guard unavailable');
    expect(value.calls.map(call => call.method)).not.toContain('prompt');
    expect(value.calls.find(call => call.method === 'remove')?.input.sessionID).toBe('fork');
  });
});

test('native v2 question forms preserve field keys, labels, values and multiselect', () => {
  const form: FormInfo1 = { id: 'form', sessionID: 'main', title: 'Choose', fields: [{ key: 'color', type: 'string', description: 'Color?', options: [{ value: 'b', label: 'Blue' }], custom: false }, { key: 'many', type: 'multiselect', options: [{ value: 'r', label: 'Red' }], custom: true }] };
  expect(openCodeV2Questions(form)).toMatchObject([{ id: 'color', custom: false }, { id: 'many', multiple: true, custom: true }]);
  expect(openCodeV2Answers(form, { color: ['Blue'], many: ['Red', 'custom'] })).toEqual({ color: 'b', many: ['r', 'custom'] });
});

test('native v2 profile overlays preserve provider config, plugins and native credentials', () => {
  const native = { plugins: ['user-plugin'], providers: { local: { package: 'adapter', settings: { baseURL: 'old', apiKey: 'native', extra: true }, models: { main: {} } } }, agents: { explore: { description: 'native' } } };
  const result = openCodeV2ProfileConfig(native, { config: { model: 'local/main', baseUrl: 'new', authMode: 'inherit', agentModels: { explore: 'local/worker' } }, apiKey: 'unused' });
  expect(result).toMatchObject({ plugins: ['user-plugin'], providers: { local: { package: 'adapter', settings: { baseURL: 'new', apiKey: 'native', extra: true }, models: { main: {} } } }, agents: { explore: { description: 'native', model: 'local/worker' } } });
  expect(native.providers.local.settings.baseURL).toBe('old'); expect(openCodeV2Model('provider/folder/model')).toEqual({ providerID: 'provider', id: 'folder/model' });
});

test('native v2 overlays retain legacy entries and respect alias precedence without mutation', () => {
  const native = { provider: { local: { npm: 'adapter', options: { apiKey: 'native', extra: true }, models: { main: {} } }, untouched: { npm: 'other' } }, agent: { scout: { prompt: 'instructions', mode: 'subagent', temperature: 0.3 }, untouched: { prompt: 'other' } } };
  const before = structuredClone(native);
  const profile = { config: { model: 'local/main', baseUrl: 'new', authMode: 'inherit' as const, agentModels: { scout: 'local/worker' } }, apiKey: 'unused' };
  const result = openCodeV2ProfileConfig(native, profile);
  expect(result).toEqual({ ...native, model: 'local/main', provider: { ...native.provider, local: { ...native.provider.local, options: { apiKey: 'native', extra: true, baseURL: 'new' } } }, agent: { ...native.agent, scout: { ...native.agent.scout, model: 'local/worker' } } });
  expect(native).toEqual(before);
  const mixed = { ...native, providers: { local: { package: 'canonical', models: { main: {} }, settings: { apiKey: 'winner' } } }, mode: { scout: { prompt: 'mode wins' } }, agents: { scout: { system: 'canonical wins' } } };
  const canonical = openCodeV2ProfileConfig(mixed, profile);
  expect(canonical).toMatchObject({ provider: native.provider, agent: native.agent, mode: mixed.mode, providers: { local: { package: 'canonical', models: { main: {} }, settings: { apiKey: 'winner', baseURL: 'new' } } }, agents: { scout: { system: 'canonical wins', model: 'local/worker' } } });
  const modeOnly = openCodeV2ProfileConfig({ ...native, mode: mixed.mode }, profile);
  expect(modeOnly).toMatchObject({ agent: native.agent, mode: { scout: { prompt: 'mode wins', model: 'local/worker' } } });
  expect(modeOnly).not.toHaveProperty('agents');
  const explicit = openCodeV2ProfileConfig(native, { ...profile, config: { ...profile.config, authMode: 'api-key' } });
  expect(explicit).toMatchObject({ provider: { local: { options: { apiKey: 'unused' } } } });
});

test('independent binary paths reject the wrong native major before serving', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'opencode-major-')), saved = [process.env.MACARON_OPENCODE_PATH, process.env.MACARON_OPENCODE_V2_PATH];
  try {
    for (const major of [1, 2]) await writeFile(join(directory, String(major)), `#!/bin/sh\n[ "$1" = "--version" ] || exit 99\nprintf '${major === 1 ? '1.18.29' : 'opencode v2.0.13'}\\n'\n`, { mode: 0o700 });
    process.env.MACARON_OPENCODE_PATH = join(directory, '1'); process.env.MACARON_OPENCODE_V2_PATH = join(directory, '2');
    expect((await openCodeBinary(1)).available).toBe(true); expect((await openCodeBinary(2)).available).toBe(true);
    process.env.MACARON_OPENCODE_PATH = join(directory, '2'); process.env.MACARON_OPENCODE_V2_PATH = join(directory, '1');
    await expect(requireOpenCodeBinary(1)).rejects.toThrow('MACARON_OPENCODE_PATH'); await expect(requireOpenCodeBinary(2)).rejects.toThrow('MACARON_OPENCODE_V2_PATH');
  } finally { for (const [index, key] of ['MACARON_OPENCODE_PATH', 'MACARON_OPENCODE_V2_PATH'].entries()) { if (saved[index] === undefined) delete process.env[key]; else process.env[key] = saved[index]; } await rm(directory, { recursive: true, force: true }); }
});
