import { describe, expect, test } from 'bun:test';
import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { claudeNativeModel, claudeProfileEnvironment, claudeProfileOptions, prepareClaudeProfile, resolveClaudeProfile } from './claude-profile.js';
import { claudeOptions, runClaudeTurn } from './claude.js';
import { abortable } from './common.js';
import type { HarnessTurn, ResolvedProfile } from './types.js';

const turn = (overrides: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: '/tmp', prompt: 'hello', instructions: 'Stable UI4A guidance', signal: new AbortController().signal, onNativeSession() {}, approve: async () => true, ...overrides });
const profile: ResolvedProfile = { config: { model: 'primary', subagentModel: 'worker', effort: 'auto', baseUrl: 'https://example.test', authMode: 'api-key' }, apiKey: 'test-profile-secret' };
const result = { type: 'result', is_error: false, result: 'done' };
const assistant = { type: 'assistant', message: { id: 'a1', content: [{ type: 'text', text: 'hello' }] } };
const consume = async (stream: AsyncIterable<unknown>) => { for await (const _ of stream) { /* Drain to exercise finalization. */ } };

describe('Claude profile settings', () => {
  test('captures current native model precedence instead of retaining the model from the resumed session', async () => {
    expect(claudeNativeModel({ model: 'setting', env: { ANTHROPIC_MODEL: 'settings-env' } }, { ANTHROPIC_MODEL: 'shell', ANTHROPIC_DEFAULT_MODEL: 'fallback' })).toBe('settings-env');
    expect(claudeNativeModel({ model: 'setting', env: { ANTHROPIC_MODEL: '' } }, { ANTHROPIC_MODEL: 'shell' })).toBe('setting');
    expect(claudeNativeModel({}, { ANTHROPIC_DEFAULT_MODEL: 'fallback' })).toBe('fallback');
    expect(claudeNativeModel({}, {})).toBe('default');
    let model = 'native-first', reads = 0;
    const readSettings = async () => { reads++; return { effective: { model }, provenance: {}, sources: [] }; };
    const captured = await resolveClaudeProfile('/tmp', { config: {} }, readSettings);
    model = 'native-next';
    const main = claudeOptions(turn({ profile: captured, nativeId: 'previous-profile-session' }), new AbortController());
    const fork = claudeOptions(turn({ profile: captured, nativeId: 'previous-profile-session', enrichment: true }), new AbortController());
    expect(main.model).toBe('native-first'); expect(fork.model).toBe('native-first');
    expect(claudeOptions(turn({ profile: captured, model: 'explicit' }), new AbortController()).model).toBe('explicit');
    expect((await resolveClaudeProfile('/tmp', { config: {} }, readSettings)).nativeConfig!.model).toBe('native-next');
    await resolveClaudeProfile('/tmp', { config: { model: 'profile-model' } }, readSettings); expect(reads).toBe(2);
  });

  test('leaves native configuration untouched until a field is explicitly overridden', async () => {
    for (const value of [undefined, { config: {} }, { config: { model: 'custom', authMode: 'inherit' as const }, apiKey: 'saved-but-not-selected' }]) {
      const prepared = await prepareClaudeProfile(value);
      expect(prepared.options).toEqual({});
      await prepared.dispose();
    }
    expect(claudeOptions(turn(), new AbortController()).model).toBeUndefined();
    expect(claudeOptions(turn({ profile }), new AbortController()).model).toBe('primary');
    expect(claudeOptions(turn({ profile, model: 'session-override' }), new AbortController()).model).toBe('session-override');
  });

  test('applies explicit effort, subagent precedence, aliases and streaming without inventing other overrides', () => {
    const env = claudeProfileEnvironment({ config: { subagentModel: 'worker', effort: 'max', modelAliases: { opus: 'large', haiku: 'fast' }, fineGrainedToolStreaming: true } });
    expect(env).toEqual({ CLAUDE_CODE_EFFORT_LEVEL: 'max', CLAUDE_CODE_SUBAGENT_MODEL: 'worker', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1', ANTHROPIC_DEFAULT_OPUS_MODEL: 'large', ANTHROPIC_DEFAULT_HAIKU_MODEL: 'fast', CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '1' });
    expect(claudeProfileEnvironment({ config: { subagentModel: 'worker', forceSubagentModel: false, fineGrainedToolStreaming: false } })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL: 'worker', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '0', CLAUDE_CODE_ENABLE_FINE_GRAINED_TOOL_STREAMING: '0' });
    expect(claudeProfileEnvironment({ config: { forceSubagentModel: true } })).toEqual({ CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    expect(() => claudeProfileEnvironment({ config: { effort: 'unknown' } })).toThrow('Unsupported Claude Code effort');
  });

  test('switches auth headers and provider selectors without retaining the higher-priority bearer token', () => {
    const key = claudeProfileEnvironment(profile);
    expect(key.ANTHROPIC_API_KEY).toBe(profile.apiKey!); expect(key.ANTHROPIC_AUTH_TOKEN).toBe('');
    for (const provider of ['BEDROCK', 'VERTEX', 'FOUNDRY', 'ANTHROPIC_AWS', 'MANTLE']) expect(key[`CLAUDE_CODE_USE_${provider}`]).toBe('');
    const bearer = claudeProfileEnvironment({ config: { authMode: 'auth-token' }, apiKey: 'other-key', authToken: 'bearer-secret' });
    expect(bearer.ANTHROPIC_AUTH_TOKEN).toBe('bearer-secret'); expect(bearer.ANTHROPIC_API_KEY).toBe('');
    expect(claudeProfileEnvironment({ config: { baseUrl: 'https://example.test' } })).not.toHaveProperty('ANTHROPIC_API_KEY');
    expect(() => claudeProfileEnvironment({ config: { authMode: 'api-key' } })).toThrow('needs an API key');
    expect(() => claudeProfileEnvironment({ config: { authMode: 'auth-token' } })).toThrow('needs a bearer token');
  });

  test('writes private flag settings, preserves native files and parent env, and disposes idempotently', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'macaron-claude-native-test-'));
    const inherited = Object.freeze({ HOME: directory, PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'parent-token', CLAUDE_CODE_EFFORT_LEVEL: 'low' });
    const nativePath = join(directory, '.claude', 'settings.json'), native = JSON.stringify({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'low', ANTHROPIC_AUTH_TOKEN: 'native-token' }, permissions: { deny: ['Bash'] } });
    await mkdir(dirname(nativePath)); await writeFile(nativePath, native);
    const prepared = await prepareClaudeProfile(profile, inherited), path = prepared.options.settings as string;
    try {
      expect(typeof prepared.options.settings).toBe('string'); expect(path).not.toContain(profile.apiKey!);
      expect((await stat(path)).mode & 0o777).toBe(0o600); expect((await stat(dirname(path))).mode & 0o777).toBe(0o700);
      const settings = JSON.parse(await readFile(path, 'utf8'));
      expect(Object.keys(settings)).toEqual(['env']);
      expect(settings.env).toEqual(claudeProfileEnvironment(profile));
      expect(prepared.options.env).toMatchObject({ HOME: directory, PATH: '/bin', ANTHROPIC_AUTH_TOKEN: '', CLAUDE_CODE_EFFORT_LEVEL: 'auto' });
      expect(prepared.options).not.toHaveProperty('settingSources'); expect(prepared.options).not.toHaveProperty('managedSettings');
      expect(inherited.ANTHROPIC_AUTH_TOKEN).toBe('parent-token'); expect(inherited.CLAUDE_CODE_EFFORT_LEVEL).toBe('low');
      expect(await readFile(nativePath, 'utf8')).toBe(native);
    } finally { await prepared.dispose(); await prepared.dispose(); await rm(directory, { recursive: true, force: true }); }
    expect(existsSync(dirname(path))).toBe(false);
  });

  test('concurrent turns have independent settings and expose a model catalog without spawning a query', async () => {
    const other = { config: { effort: 'low', authMode: 'auth-token' as const }, authToken: 'separate-secret' };
    const [a, b] = await Promise.all([prepareClaudeProfile(profile, {}), prepareClaudeProfile(other, {})]);
    try {
      expect(a.options.settings).not.toBe(b.options.settings);
      expect(a.options.env!.ANTHROPIC_AUTH_TOKEN).toBe(''); expect(b.options.env!.ANTHROPIC_AUTH_TOKEN).toBe('separate-secret');
      await a.dispose(); expect(existsSync(b.options.settings as string)).toBe(true);
      const catalog = await claudeProfileOptions('/does/not/exist', { config: { model: 'gateway/custom', modelAliases: { sonnet: 'gateway/custom' } } });
      expect(catalog.models.map(model => model.id)).toEqual(['fable', 'opus', 'sonnet', 'haiku', 'opusplan', 'gateway/custom']);
      expect(catalog.efforts).toEqual(['auto', 'low', 'medium', 'high', 'xhigh', 'max']);
    } finally { await Promise.all([a.dispose(), b.dispose()]); }
  });
});

describe('Claude profile query lifetime', () => {
  test('redacts the entire configured credential before generic key-pattern scrubbing', async () => {
    const secretProfile = { config: { authMode: 'api-key' as const }, apiKey: 'sk-profile.partial-suffix' };
    await expect(consume(runClaudeTurn(turn({ profile: secretProfile }), async () => {
      return Object.assign((async function* () { yield { type: 'result', is_error: true, errors: [`Provider refused ${secretProfile.apiKey}`] }; })(), { close() {} }) as unknown as Query;
    }))).rejects.toThrow('Provider refused [redacted]');
  });

  for (const mode of ['success', 'stream-error', 'launch-error', 'abort', 'return', 'close-error'] as const) test(`removes private settings after ${mode}`, async () => {
    const controller = new AbortController();
    let path = '', closed = false, filePresentAtClose = false;
    const stream = runClaudeTurn(turn({ profile, signal: controller.signal }), async (_prompt, options) => {
      path = options.settings as string;
      expect(existsSync(path)).toBe(true);
      if (mode === 'launch-error') throw new Error(`launch failed with ${profile.apiKey}`);
      const output = (async function* () {
        if (mode === 'stream-error') throw new Error('stream failed');
        if (mode === 'abort') await abortable(new Promise<void>(() => {}), options.abortController!.signal);
        if (mode === 'return') yield assistant;
        yield result;
      })();
      if (mode === 'abort') queueMicrotask(() => controller.abort());
      return Object.assign(output, { close() { closed = true; filePresentAtClose = existsSync(path); if (mode === 'close-error') throw new Error('close failed'); } }) as unknown as Query;
    });
    if (mode === 'return') { await stream.next(); await stream.return(undefined); }
    else if (mode === 'launch-error') await expect(consume(stream)).rejects.toThrow('launch failed with [redacted]');
    else if (mode === 'stream-error' || mode === 'close-error') await expect(consume(stream)).rejects.toThrow(mode === 'stream-error' ? 'stream failed' : 'close failed');
    else if (mode === 'abort') await expect(consume(stream)).rejects.toMatchObject({ name: 'AbortError' });
    else await consume(stream);
    expect(path).not.toBe(''); expect(existsSync(dirname(path))).toBe(false);
    expect(closed).toBe(mode !== 'launch-error'); expect(filePresentAtClose).toBe(mode !== 'launch-error');
  });

  test('enrichment uses the same resolved profile while keeping the original native history', async () => {
    const captured: { options: Options; env: unknown }[] = [];
    for (const enrichment of [false, true]) await consume(runClaudeTurn(turn({ profile, model: 'session-model', nativeId: 'native-main', enrichment }), async (_prompt, options) => {
      captured.push({ options, env: JSON.parse(await readFile(options.settings as string, 'utf8')) });
      return Object.assign((async function* () { yield result; })(), { close() {} }) as unknown as Query;
    }));
    expect(captured[0].env).toEqual(captured[1].env);
    for (const { options } of captured) { expect(options.model).toBe('session-model'); expect(options.resume).toBe('native-main'); }
    expect(captured[1].options).toMatchObject({ forkSession: true, persistSession: false, maxTurns: 1 });
    expect(captured[1].options.systemPrompt).toEqual(captured[0].options.systemPrompt);
  });
});
