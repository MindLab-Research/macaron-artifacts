import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { codexProfileRuntime, createCodexProfiles, readCodexProfileOptions } from './codex-profiles.js';
import { editCodexToml, parseCodexToml } from './codex-profile-toml.js';
import { codexThreadParams, runCodexConnection } from './codex.js';
import type { CodexConnection } from './codex-rpc.js';
import type { HarnessTurn, ResolvedProfile } from './types.js';

const directories: string[] = [];
async function directory() { const path = await mkdtemp(join(tmpdir(), 'artifacts-codex-profiles-')); directories.push(path); return path; }
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
function connection(reply: (method: string, params: Record<string, unknown>) => Record<string, unknown>): CodexConnection & { closed: boolean; calls: string[] } {
  return { closed: false, calls: [], async request(method, params) { this.calls.push(method); return reply(method, params as Record<string, unknown>); }, notify() {}, async close() { this.closed = true; } };
}

test('TOML edits preserve comments, multiline strings, unknown settings and inline-table siblings', () => {
  const source = `# profile note\nmodel = "old" # model note\ndeveloper_instructions = '''\nmodel = "this is not a setting"\n[features]\n'''\nfeatures = { memories = false, code_mode = { enabled = true, excluded_tool_namespaces = ["keep"] } }\n[model_providers."custom.with.dot"]\nname = "Provider"\nbase_url = "https://before.test/v1" # endpoint note\nexperimental_bearer_token = "private-native-token"\n`;
  let edited = editCodexToml(source, ['model'], 'new');
  edited = editCodexToml(edited, ['features', 'code_mode', 'enabled'], undefined);
  edited = editCodexToml(edited, ['features', 'memories'], undefined);
  edited = editCodexToml(edited, ['features', 'shell_tool'], false);
  edited = editCodexToml(edited, ['agents', 'default_subagent_model'], 'sub-model');
  edited = editCodexToml(edited, ['model_providers', 'custom.with.dot', 'base_url'], 'https://after.test/v1');
  expect(edited).toContain('# profile note\nmodel = "new" # model note');
  expect(edited).toContain('model = "this is not a setting"\n[features]\n');
  expect(edited).toContain('experimental_bearer_token = "private-native-token"');
  expect(edited).toContain('# endpoint note');
  expect(parseCodexToml(edited)).toMatchObject({ model: 'new', agents: { default_subagent_model: 'sub-model' }, features: { code_mode: { excluded_tool_namespaces: ['keep'] }, shell_tool: false }, model_providers: { 'custom.with.dot': { base_url: 'https://after.test/v1' } } });
  expect((parseCodexToml(edited).features as Record<string, unknown>)).not.toHaveProperty('memories');
});

test('native profiles use native files, preserve unknown configuration and reject stale concurrent edits', async () => {
  const home = await directory(), profiles = createCodexProfiles(home), base = '# shared config must not change\nmodel = "shared"\n';
  await writeFile(join(home, 'config.toml'), base);
  await writeFile(join(home, 'existing.config.toml'), '# preserve me\nmodel = "old"\n[features.code_mode]\nenabled = true\nexcluded_tool_namespaces = ["example"]\n[model_providers.custom]\nname = "Private"\nexperimental_bearer_token = "synthetic-native-secret"\n');
  const original = (await profiles.list())[0];
  const changes = { harness: 'codex' as const, name: original.name, revision: original.revision, config: { model: 'new', subagentModel: 'sub', effort: 'ultra', features: { code_mode: false } }, credentials: { apiKey: 'must-not-enter-native-file' } };
  const outcomes = await Promise.allSettled([profiles.save(changes, original.id), profiles.save({ ...changes, config: { model: 'other' } }, original.id)]);
  expect(outcomes.filter(item => item.status === 'fulfilled')).toHaveLength(1);
  expect(outcomes.filter(item => item.status === 'rejected')).toHaveLength(1);
  const source = await readFile(join(home, 'existing.config.toml'), 'utf8');
  expect(source).toContain('# preserve me'); expect(source).toContain('excluded_tool_namespaces = ["example"]');
  expect(source).toContain('experimental_bearer_token = "synthetic-native-secret"'); expect(source).not.toContain('must-not-enter-native-file');
  expect(await readFile(join(home, 'config.toml'), 'utf8')).toBe(base);
  expect((await stat(join(home, 'existing.config.toml'))).mode & 0o777).toBe(0o600);
  const updated = (await profiles.list())[0];
  await expect(profiles.delete(updated.id, original.revision)).rejects.toThrow('changed');
  await profiles.delete(updated.id, updated.revision); expect(await profiles.list()).toEqual([]);
  await expect(profiles.save({ harness: 'codex', name: '../escape', config: {} })).rejects.toThrow('names');
});

test('invalid native TOML remains visible without disclosing its contents', async () => {
  const home = await directory(), profiles = createCodexProfiles(home);
  await writeFile(join(home, 'broken.config.toml'), 'experimental_bearer_token = "sensitive-unclosed');
  const entries = await profiles.list(); expect(entries).toHaveLength(1); expect(entries[0].error).toBeTruthy();
  expect(JSON.stringify(entries)).not.toContain('sensitive');
});

test('native profile listing understands an inherited provider while exposing only profile overrides', async () => {
  const home = await directory();
  await writeFile(join(home, 'config.toml'), 'model = "base-model"\nmodel_provider = "custom"\n[model_providers.custom]\nname = "Custom"\nexperimental_bearer_token = "private-base-token"\n');
  await writeFile(join(home, 'endpoint.config.toml'), '[model_providers.custom]\nbase_url = "https://profile.test/v1"\n');
  const entries = await createCodexProfiles(home).list();
  expect(entries[0].config).toEqual({ baseUrl: 'https://profile.test/v1' }); expect(entries[0].credentials.apiKey).toBe(true);
  expect(JSON.stringify(entries)).not.toContain('private-base-token');
});

test('structured feature toggles preserve inherited options and refuse incomplete rollout budgets', async () => {
  const home = await directory(), profiles = createCodexProfiles(home);
  await writeFile(join(home, 'config.toml'), '[features.rollout_budget]\nenabled = false\nlimit_tokens = 10000\n[features.context_management]\nexperimental_mode = false\n');
  const created = await profiles.save({ harness: 'codex', name: 'budget', config: { features: { rollout_budget: true, context_management: true } } });
  const source = await readFile(join(home, 'budget.config.toml'), 'utf8');
  expect(parseCodexToml(source)).toMatchObject({ features: { rollout_budget: { enabled: true }, context_management: { experimental_mode: true } } });
  expect(created.config.features).toEqual({ rollout_budget: true, context_management: true });
  await writeFile(join(home, 'config.toml'), '');
  await expect(profiles.save({ harness: 'codex', name: 'missing-limit', config: { features: { rollout_budget: true } } })).rejects.toThrow('limit_tokens');
});

test('native profile resolution preserves trusted project precedence and ignores disabled or provider-redirecting project values', async () => {
  const home = await directory(), cwd = join(home, 'project');
  await writeFile(join(home, 'review.config.toml'), 'model = "profile-model"\nmodel_provider = "custom"\nmodel_reasoning_effort = "high"\nmodel_catalog_json = "catalog.json"\n[agents]\ndefault_subagent_model = "profile-sub"\n[model_providers.custom]\nbase_url = "https://profile.test/v1"\n');
  const rpc = connection(() => ({ config: { model: 'project-model', model_provider: 'shared', model_providers: { custom: { name: 'Native provider', env_key: 'NATIVE_PROVIDER_KEY' } } }, layers: [
    { name: { type: 'project', dotCodexFolder: join(cwd, '.codex') }, config: { model: 'project-model', model_provider: 'malicious', features: { memories: true } } },
    { name: { type: 'project', dotCodexFolder: '/untrusted' }, disabledReason: 'untrusted', config: { model_reasoning_effort: 'low' } },
    { name: { type: 'user' }, config: { model: 'shared', unusedSecret: 'not-part-of-snapshot' } },
  ] }));
  const selected = await createCodexProfiles(home, () => rpc).resolve('codex:review', cwd);
  expect(selected.config).toMatchObject({ model: 'project-model', provider: 'custom', effort: 'high', subagentModel: 'profile-sub', baseUrl: 'https://profile.test/v1' });
  expect(selected.nativeConfig).toMatchObject({ model_catalog_json: join(home, 'catalog.json'), model_providers: { custom: { name: 'Native provider', env_key: 'NATIVE_PROVIDER_KEY' } } });
  expect(selected.nativeConfig).not.toHaveProperty('unusedSecret'); expect(rpc.closed).toBe(true);
});

test('private provider keys stay out of argv and global environment while main and metadata forks share configuration', () => {
  const profile: ResolvedProfile = { config: { model: 'main-model', subagentModel: 'sub-model', effort: 'ultra', baseUrl: 'https://proxy.test/v1' }, apiKey: 'host-secret-value', nativeConfig: { model_providers: { another: { experimental_bearer_token: 'native-secret-value' } } } };
  const runtime = codexProfileRuntime(profile);
  expect(JSON.stringify(runtime.startup)).not.toContain('host-secret-value'); expect(JSON.stringify(runtime.startup)).not.toContain('native-secret-value');
  expect(runtime.env.MACARON_CODEX_PROFILE_API_KEY).toBe('host-secret-value'); expect(process.env.MACARON_CODEX_PROFILE_API_KEY).not.toBe('host-secret-value');
  expect(runtime.config).toMatchObject({ model_provider: 'macaron-artifacts', agents: { default_subagent_model: 'sub-model' }, model_providers: { 'macaron-artifacts': { env_key: 'MACARON_CODEX_PROFILE_API_KEY', requires_openai_auth: false } } });
  expect(runtime.config).toMatchObject({ shell_environment_policy: { filters: { MACARON_CODEX_PROFILE_API_KEY: 'exclude' } } });
  const turn = { profile, cwd: '/workspace', model: 'manual-override', instructions: 'stable prefix' } as HarnessTurn;
  expect(codexThreadParams(turn)).toMatchObject({ model: 'manual-override', modelProvider: 'macaron-artifacts' });
  expect(codexThreadParams({ ...turn, enrichment: true }).config).toEqual(codexThreadParams(turn).config);
  expect(codexProfileRuntime({ config: {}, apiKey: 'other-secret' }).env.MACARON_CODEX_PROFILE_API_KEY).toBe('other-secret');
});

test('model and feature discovery paginates fully, keeps current deprecated settings and applies managed locks', async () => {
  const rpc = connection((method, params) => {
    if (method === 'model/list') return params.cursor ? { data: [{ model: 'second', displayName: 'Second', supportedReasoningEfforts: [{ reasoningEffort: 'ultra' }] }] } : { data: [{ model: 'first', displayName: 'First', supportedReasoningEfforts: [{ reasoningEffort: 'max' }] }], nextCursor: 'models-2' };
    if (method === 'experimentalFeature/list') return params.cursor ? { data: [{ name: 'last', stage: 'beta', enabled: true }, { name: 'legacy', stage: 'deprecated' }, { name: 'removed', stage: 'removed' }, { name: 'rollout_budget', stage: 'underDevelopment', enabled: false }] } : { data: [{ name: 'memories', stage: 'stable', enabled: true }], nextCursor: 'features-2' };
    if (method === 'configRequirements/read') return { requirements: { featureRequirements: { memories: false } } };
    return {};
  });
  const options = await readCodexProfileOptions(rpc, '/workspace', { config: { features: { legacy: false } } });
  expect(options.models.map(model => model.id)).toEqual(['first', 'second']); expect(options.efforts).toEqual(['max', 'ultra']);
  expect(options.features?.find(feature => feature.id === 'memories')).toMatchObject({ enabled: false, locked: true });
  expect(options.features?.find(feature => feature.id === 'legacy')).toMatchObject({ locked: true }); expect(options.features?.some(feature => feature.id === 'removed')).toBe(false);
  expect(options.features?.find(feature => feature.id === 'rollout_budget')).toMatchObject({ locked: true });
});

test('Codex applies effort on every turn and redacts arbitrary configured credentials from failures', async () => {
  let sent: Record<string, unknown> | undefined;
  const rpc = connection((method, params) => {
    if (method === 'thread/start') return { thread: { id: 'native' } };
    if (method === 'turn/start') { sent = params; queueMicrotask(() => rpc.notification?.('turn/completed', { threadId: 'native', turn: { status: 'failed', error: { message: 'provider rejected secret-value' } } })); return { turn: { id: 'turn' } }; }
    return {};
  });
  const turn: HarnessTurn = { cwd: '/workspace', prompt: 'hello', instructions: 'stable', signal: new AbortController().signal, onNativeSession() {}, async approve() { return false; }, profile: { config: { effort: 'ultra' }, apiKey: 'secret-value' } };
  await expect(async () => { for await (const _ of runCodexConnection(turn, rpc)) {} }).toThrow('provider rejected [redacted]');
  expect(sent?.effort).toBe('ultra'); expect(rpc.closed).toBe(true);
});

test('explicit native inheritance captures configured routing and catalog defaults for resume and metadata', async () => {
  const home = await directory();
  const source = connection((method, params) => {
    if (method === 'config/read') return { config: { model_provider: 'native-provider', model_providers: { 'native-provider': { name: 'Native', base_url: 'https://native.test/v1', env_key: 'NATIVE_KEY' } }, agents: { review: { config_file: 'review.toml' } } } };
    if (method === 'model/list') return params.cursor ? { data: [{ model: 'native-current', isDefault: true, defaultReasoningEffort: 'low' }] } : { data: [{ model: 'other', isDefault: false, defaultReasoningEffort: 'high' }], nextCursor: 'next' };
    return {};
  });
  const profile = await createCodexProfiles(home, () => source).defaults('/workspace');
  expect(profile.config).toMatchObject({ model: 'native-current', provider: 'native-provider', effort: 'low', baseUrl: 'https://native.test/v1' });
  expect(profile.config.subagentModel).toBeUndefined(); expect(source.closed).toBe(true);
  const captured: { method: string; params: Record<string, unknown> }[] = [];
  for (const enrichment of [false, true]) {
    const rpc = connection((method, params) => {
      captured.push({ method, params });
      const id = enrichment ? 'metadata-fork' : 'old-profile-thread';
      if (method === 'thread/resume' || method === 'thread/fork') return { thread: { id } };
      if (method === 'turn/start') { queueMicrotask(() => rpc.notification?.('turn/completed', { threadId: id, turn: { status: 'completed' } })); return { turn: { id: 'turn' } }; }
      return {};
    });
    const turn: HarnessTurn = { cwd: '/workspace', nativeId: 'old-profile-thread', profile, prompt: 'hello', instructions: 'stable', enrichment, signal: new AbortController().signal, onNativeSession() {}, approve: async () => false };
    for await (const _ of runCodexConnection(turn, rpc)) {}
  }
  const resumed = captured.find(call => call.method === 'thread/resume')!.params, forked = captured.find(call => call.method === 'thread/fork')!.params;
  expect(resumed).toMatchObject({ model: 'native-current', modelProvider: 'native-provider', config: { model_reasoning_effort: 'low' } });
  expect(forked.config).toEqual(resumed.config);
  expect(captured.filter(call => call.method === 'turn/start').map(call => call.params.effort)).toEqual(['low', 'low']);
});

test('removed named-profile fields fall back to current native settings without rewriting the profile', async () => {
  const home = await directory(), path = join(home, 'minimal.config.toml'); await writeFile(path, '# only a feature override\n[features]\nmemories = false\n');
  let nativeModel = 'first';
  const profiles = createCodexProfiles(home, () => connection(method => method === 'config/read' ? { config: { model: nativeModel, model_reasoning_effort: 'medium' }, layers: [] } : {}));
  const first = await profiles.resolve('codex:minimal', '/workspace'); nativeModel = 'second';
  const second = await profiles.resolve('codex:minimal', '/workspace');
  expect(first.config).toMatchObject({ model: 'first', effort: 'medium', provider: 'openai' });
  expect(second.config).toMatchObject({ model: 'second', effort: 'medium', provider: 'openai' });
  expect(await readFile(path, 'utf8')).toBe('# only a feature override\n[features]\nmemories = false\n');
});

test('custom models retain an explicit native effort and fail clearly when no default can be discovered', async () => {
  const home = await directory();
  const native = connection(method => method === 'config/read' ? { config: { model: 'custom', model_reasoning_effort: 'max' } } : {});
  expect((await createCodexProfiles(home, () => native).defaults('/workspace')).config).toMatchObject({ model: 'custom', effort: 'max' });
  expect(native.calls).not.toContain('model/list');
  const unknown = connection(method => method === 'config/read' ? { config: { model: 'custom' } } : { data: [] });
  await expect(createCodexProfiles(home, () => unknown).defaults('/workspace')).rejects.toThrow('Choose an effort level');
  expect(unknown.closed).toBe(true);
});
