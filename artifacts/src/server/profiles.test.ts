import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProfileInput } from '../shared/profiles.js';
import type { CodexConnection } from './harnesses/codex-rpc.js';
import { createCodexProfiles } from './harnesses/codex-profiles.js';
import { parseCodexToml } from './harnesses/codex-profile-toml.js';
import { ProfileStore, validateProfileInput } from './profiles.js';
import type { ResolvedProfile } from './harnesses/types.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const appInput = (config: ProfileInput['config'] = {}, extra: Partial<ProfileInput> = {}): ProfileInput => ({ harness: 'claude-code', name: 'Daily', config, ...extra });
const unchangedClaude = async (_cwd: string, profile: ResolvedProfile) => profile;
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-profile-store-test-')); directories.push(directory);
  const path = join(directory, 'profiles'), home = join(directory, 'codex'); await mkdir(home);
  let closed = 0;
  const native = createCodexProfiles(home, () => ({
    async request(method: string) {
      if (method === 'config/read') return { config: { model: 'base', model_reasoning_effort: 'medium', model_provider: 'gateway', model_providers: { gateway: { name: 'Inherited gateway', base_url: 'https://example.test', experimental_bearer_token: 'inherited-native-secret' } } }, layers: [
        { name: { type: 'project', dotCodexFolder: '/workspace/.codex' }, config: { model: 'trusted-project', model_provider: 'blocked-project-provider' } },
        { name: { type: 'project' }, disabledReason: 'Untrusted', config: { model: 'untrusted-model' } },
      ] };
      return {};
    }, notify() {}, async close() { closed++; },
  }) as CodexConnection);
  const helpers = { list: native.list, save: native.save, remove: native.delete, resolve: native.resolve };
  const store = new ProfileStore(path, helpers, unchangedClaude); await store.load();
  return { store, path, home, helpers, closed: () => closed };
}

describe('profile validation', () => {
  test('normalizes explicit values and preserves false and credential removal', () => {
    expect(validateProfileInput({ harness: 'claude-code', name: ' Daily ', config: { model: ' opus ', effort: ' auto ', subagentModel: null, forceSubagentModel: false, modelAliases: { sonnet: ' custom ', haiku: '' }, fineGrainedToolStreaming: false }, credentials: { apiKey: ' key ', authToken: null } })).toEqual({
      harness: 'claude-code', name: 'Daily', config: { model: 'opus', effort: 'auto', forceSubagentModel: false, modelAliases: { sonnet: 'custom' }, fineGrainedToolStreaming: false }, credentials: { apiKey: 'key', authToken: null },
    });
    expect(validateProfileInput({ harness: 'codex', name: 'work', config: { features: { multi_agent: false }, subagentEffort: 'high' } }).config).toEqual({ features: { multi_agent: false }, subagentEffort: 'high' });
    expect(validateProfileInput({ harness: 'opencode', name: 'work', config: { agentModels: { explore: 'vendor/model' }, variant: 'high' } }).config.agentModels).toEqual({ explore: 'vendor/model' });
    expect(validateProfileInput({ harness: 'pi', name: 'work', config: { effort: 'off' }, credentials: { apiKey: ' ' } }).credentials).toEqual({ apiKey: null });
  });

  test.each([
    null, [], { harness: 'unknown', name: 'work', config: {} }, appInput({}, { name: ' ' }), appInput({}, { name: 'a\nb' }), appInput({}, { name: 'x'.repeat(101) }),
    appInput(null as never), appInput({ model: 3 as never }), appInput({ model: 'x'.repeat(501) }), appInput({ model: 'bad\0model' }), appInput({ effort: 'ultra' }),
    appInput({ baseUrl: '/relative' }), appInput({ baseUrl: 'file:///tmp/config' }), appInput({ baseUrl: 'https://user:password@example.test' }),
    appInput({ features: {} }), appInput({ forceSubagentModel: 'false' as never }), appInput({ modelAliases: { other: 'model' } as never }),
    appInput({ modelAliases: JSON.parse('{"__proto__":"model"}') }), appInput({}, { credentials: { apiKey: 'a\nb' } }), appInput({}, { credentials: { other: 'secret' } as never }),
    appInput({ authMode: 'auth-token' }, { harness: 'codex' }), appInput({}, { harness: 'pi', credentials: { authToken: 'secret' } }), appInput({ effort: 'auto' }, { harness: 'pi' }),
    appInput({ features: { multi_agent: 'true' } as never }, { harness: 'codex' }),
  ].map(value => [value]))('rejects invalid input %# before persistence', (value) => {
    try { validateProfileInput(value); throw new Error('Expected validation failure'); }
    catch (error) { expect(error).toMatchObject({ status: 400 }); }
  });
});

describe('app profiles and credentials', () => {
  test('persists private files and returns only credential state in every DTO', async () => {
    const { store, path, helpers } = await fixture();
    const created = await store.save(appInput({ model: 'opus', authMode: 'api-key' }, { credentials: { apiKey: 'private-key', authToken: 'inactive-token' } }));
    expect(created).toMatchObject({ source: 'app', harness: 'claude-code', credentials: { apiKey: true, authToken: true } });
    expect(JSON.stringify(created)).not.toContain('private-key'); expect(JSON.stringify(await store.list())).not.toContain('inactive-token');
    expect((await stat(path)).mode & 0o777).toBe(0o700); expect((await stat(join(path, 'profiles.json'))).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(join(path, 'profiles.json'), 'utf8'));
    expect(persisted.credentials[created.id]).toEqual({ apiKey: 'private-key', authToken: 'inactive-token' });
    expect(JSON.stringify(persisted.profiles)).not.toContain('private-key'); expect(await readdir(path)).toEqual(['profiles.json']);
    const reloaded = new ProfileStore(path, helpers, unchangedClaude); await reloaded.load();
    expect(await reloaded.list()).toEqual(await store.list());
    expect(await reloaded.resolve(created.id, 'claude-code', '/tmp')).toEqual({ config: { model: 'opus', authMode: 'api-key' }, apiKey: 'private-key' });
  });

  test('keeps, replaces and clears credentials independently from the active auth mode', async () => {
    const { store } = await fixture();
    let profile = await store.save(appInput({ authMode: 'api-key' }, { credentials: { apiKey: 'first', authToken: 'bearer' } }));
    profile = await store.save(appInput({ model: 'sonnet', authMode: 'api-key' }, { revision: profile.revision }), profile.id);
    expect((await store.resolve(profile.id, 'claude-code', '/tmp'))!.apiKey).toBe('first');
    profile = await store.save(appInput({ authMode: 'api-key' }, { revision: profile.revision, credentials: { apiKey: 'second' } }), profile.id);
    expect((await store.resolve(profile.id, 'claude-code', '/tmp'))!.apiKey).toBe('second');
    profile = await store.save(appInput({ authMode: 'auth-token' }, { revision: profile.revision }), profile.id);
    expect(await store.resolve(profile.id, 'claude-code', '/tmp')).toEqual({ config: { authMode: 'auth-token' }, authToken: 'bearer' });
    profile = await store.save(appInput({ authMode: 'inherit' }, { revision: profile.revision, credentials: { apiKey: null } }), profile.id);
    expect(profile.credentials).toEqual({ apiKey: false, authToken: true });
    expect(await store.resolve(profile.id, 'claude-code', '/tmp')).toEqual({ config: { authMode: 'inherit' } });
    profile = await store.save(appInput({}, { revision: profile.revision, credentials: { authToken: null } }), profile.id);
    expect(profile.credentials).toEqual({ apiKey: false, authToken: false });
  });

  test('rejects clearing the active credential atomically and recovers its write queue', async () => {
    const { store, path } = await fixture();
    const profile = await store.save(appInput({ authMode: 'api-key' }, { credentials: { apiKey: 'keep' } }));
    const previous = await readFile(join(path, 'profiles.json'), 'utf8');
    await expect(store.save(appInput({ authMode: 'api-key' }, { revision: profile.revision, credentials: { apiKey: null } }), profile.id)).rejects.toMatchObject({ status: 400 });
    expect(await readFile(join(path, 'profiles.json'), 'utf8')).toBe(previous);
    expect((await store.resolve(profile.id, 'claude-code', '/tmp'))!.apiKey).toBe('keep');
    const saved = await store.save(appInput({ authMode: 'inherit' }, { revision: profile.revision, credentials: { apiKey: null } }), profile.id);
    expect(saved.credentials.apiKey).toBe(false);
    await expect(store.save(appInput({ authMode: 'auth-token' }, { name: 'Missing' }))).rejects.toMatchObject({ status: 400 });
  });

  test('isolates mutable inputs, public DTOs, and resolved per-turn snapshots', async () => {
    const { store } = await fixture(), input = appInput({ model: 'primary', modelAliases: { haiku: 'worker' } });
    const profile = await store.save(input);
    input.config.model = 'mutated-input'; input.config.modelAliases!.haiku = 'mutated-alias';
    profile.config.modelAliases!.haiku = 'mutated-dto';
    const listed = (await store.list())[0]; listed.config.modelAliases!.haiku = 'mutated-list';
    const resolved = await store.resolve(profile.id, 'claude-code', '/tmp');
    expect(resolved!.config).toEqual({ model: 'primary', modelAliases: { haiku: 'worker' } });
    resolved!.config.modelAliases!.haiku = 'mutated-resolution';
    expect((await store.resolve(profile.id, 'claude-code', '/tmp'))!.config.modelAliases!.haiku).toBe('worker');
    const next = await store.save(appInput({ model: 'next' }, { revision: profile.revision }), profile.id);
    expect(resolved!.config.model).toBe('primary'); expect((await store.resolve(next.id, 'claude-code', '/tmp'))!.config.model).toBe('next');
  });

  test('serializes concurrent revisions and rejects stale updates or removals', async () => {
    const { store, path } = await fixture();
    const previous = await store.save(appInput());
    const results = await Promise.allSettled(['first', 'second'].map(model => store.save(appInput({ model }, { revision: previous.revision }), previous.id)));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { status: 409 } });
    const current = (await store.list())[0]; expect(current.config.model).toBe('first');
    await expect(store.remove(current.id, previous.revision)).rejects.toMatchObject({ status: 409 });
    await expect(store.save(appInput())).rejects.toMatchObject({ status: 409 });
    await expect(store.resolve(current.id, 'pi', '/tmp')).rejects.toMatchObject({ status: 400 });
    await expect(store.resolve('missing', 'claude-code', '/tmp')).rejects.toMatchObject({ status: 404 });
    await expect(store.resolve('codex:other', 'claude-code', '/tmp')).rejects.toMatchObject({ status: 400 });
    await expect(store.save(appInput({}, { revision: current.revision }), 'missing')).rejects.toMatchObject({ status: 404 });
    expect(await store.resolve(undefined, 'claude-code', '/tmp')).toBeUndefined();
    await store.save(appInput({}, { harness: 'pi' }));
    await store.remove(current.id, current.revision);
    const data = JSON.parse(await readFile(join(path, 'profiles.json'), 'utf8'));
    expect(data.credentials).not.toHaveProperty(current.id); expect((await store.list()).map(profile => profile.harness)).toEqual(['pi']);
  });

  test('tightens permissions on an existing store and rejects malformed data without overwriting it', async () => {
    const { store, path, helpers } = await fixture(); await store.save(appInput());
    const file = join(path, 'profiles.json'); await chmod(path, 0o755); await chmod(file, 0o644);
    const reloaded = new ProfileStore(path, helpers, unchangedClaude); await reloaded.load();
    expect((await stat(path)).mode & 0o777).toBe(0o700); expect((await stat(file)).mode & 0o777).toBe(0o600);
    await writeFile(file, '{bad json');
    await expect(new ProfileStore(path, helpers, unchangedClaude).load()).rejects.toThrow('无法读取 Profiles 配置');
    expect(await readFile(file, 'utf8')).toBe('{bad json');
  });
});

describe('native Codex profiles with private overlays', () => {
  test('blocks mixed native/private revisions after a real final-write failure and requires explicit repair across restart', async () => {
    const { store, path, home, helpers } = await fixture();
    const input: ProfileInput = { harness: 'codex', name: 'daily', config: { provider: 'gateway', baseUrl: 'https://old.test', authMode: 'api-key' }, credentials: { apiKey: 'old-private-key' } };
    const first = await store.save(input), file = join(path, 'profiles.json'), backup = join(path, 'retained-marker.json');
    const originalPrivate = JSON.parse(await readFile(file, 'utf8'));
    const failing = new ProfileStore(path, { ...helpers, async save(input, id) {
      const profile = await helpers.save(input, id);
      // Deterministic rename failure on every OS/user: preserve the durable marker,
      // then replace its destination with a directory until the failed write returns.
      await rename(file, backup); await mkdir(file); return profile;
    } });
    await failing.load();
    await expect(failing.save({ ...input, revision: first.revision, config: { ...input.config, baseUrl: 'https://new.test' }, credentials: { apiKey: 'new-private-key' } }, first.id)).rejects.toBeDefined();
    expect(parseCodexToml(await readFile(join(home, 'daily.config.toml'), 'utf8'))).toMatchObject({ model_providers: { gateway: { base_url: 'https://new.test' } } });
    await expect(failing.resolve(first.id, 'codex', '/workspace')).rejects.toMatchObject({ status: 409 });
    await rm(file, { recursive: true }); await rename(backup, file);
    const pendingPrivate = JSON.parse(await readFile(file, 'utf8'));
    expect(pendingPrivate.pendingNative).toEqual({ [first.id]: true }); expect(pendingPrivate.credentials).toEqual(originalPrivate.credentials); expect(pendingPrivate.native).toEqual(originalPrivate.native);
    const reloaded = new ProfileStore(path, helpers); await reloaded.load();
    const pending = (await reloaded.list())[0]; expect(pending.pending).toBe(true); expect(pending.error).toContain('保存未完成');
    await expect(reloaded.resolve(first.id, 'codex', '/workspace')).rejects.toMatchObject({ status: 409 });
    await expect(reloaded.save({ ...input, revision: pending.revision, config: pending.config, credentials: undefined }, first.id)).rejects.toThrow('重新输入凭据');
    const repaired = await reloaded.save({ ...input, revision: pending.revision, config: pending.config, credentials: { apiKey: 'confirmed-new-key' } }, first.id);
    expect(repaired.pending).toBeUndefined(); expect(repaired.error).toBeUndefined();
    expect(await reloaded.resolve(first.id, 'codex', '/workspace')).toMatchObject({ config: { baseUrl: 'https://new.test' }, apiKey: 'confirmed-new-key' });
    expect(JSON.parse(await readFile(file, 'utf8')).pendingNative).toBeUndefined();
  });

  test('retains a pending marker when native rejection cleanup cannot be persisted', async () => {
    const { store, path, helpers } = await fixture();
    const input: ProfileInput = { harness: 'codex', name: 'daily', config: { model: 'old' } };
    const first = await store.save(input), file = join(path, 'profiles.json'), backup = join(path, 'retained-marker.json');
    const failing = new ProfileStore(path, { ...helpers, async save() { await rename(file, backup); await mkdir(file); throw new Error('native save rejected'); } });
    await failing.load();
    await expect(failing.save({ ...input, revision: first.revision }, first.id)).rejects.toThrow('native save rejected');
    await expect(failing.resolve(first.id, 'codex', '/workspace')).rejects.toMatchObject({ status: 409 });
    await rm(file, { recursive: true }); await rename(backup, file);
    const reloaded = new ProfileStore(path, helpers); await reloaded.load();
    const pending = (await reloaded.list())[0]; expect(pending.pending).toBe(true);
    const repaired = await reloaded.save({ ...input, revision: pending.revision, config: { model: 'confirmed', authMode: 'inherit' } }, pending.id);
    expect(repaired.pending).toBeUndefined();
  });

  test('lists and repairs an interrupted new native profile before its TOML file existed', async () => {
    const { path, helpers } = await fixture();
    await writeFile(join(path, 'profiles.json'), JSON.stringify({ version: 1, profiles: [], credentials: {}, native: {}, pendingNative: { 'codex:new': true } }));
    const reloaded = new ProfileStore(path, helpers); await reloaded.load();
    const pending = (await reloaded.list())[0]; expect(pending).toMatchObject({ id: 'codex:new', name: 'new', pending: true });
    await expect(reloaded.resolve(pending.id, 'codex', '/workspace')).rejects.toMatchObject({ status: 409 });
    const repaired = await reloaded.save({ harness: 'codex', name: 'new', revision: pending.revision, config: { model: 'confirmed', authMode: 'inherit' } }, pending.id);
    expect(repaired.pending).toBeUndefined(); expect(repaired.config.model).toBe('confirmed');
  });

  test('keeps keys in the private store while native model/features remain native TOML', async () => {
    const { store, home, path, closed } = await fixture();
    const input: ProfileInput = { harness: 'codex', name: 'daily', config: { model: 'profile-model', provider: 'gateway', baseUrl: 'https://profile.test', authMode: 'api-key', features: { multi_agent: false } }, credentials: { apiKey: 'app-overlay-secret' } };
    const profile = await store.save(input), nativePath = join(home, 'daily.config.toml'), native = await readFile(nativePath, 'utf8');
    expect(native).not.toContain('app-overlay-secret'); expect(native).not.toContain('authMode');
    expect(parseCodexToml(native)).toMatchObject({ model: 'profile-model', features: { multi_agent: false } });
    expect(JSON.stringify(await store.list())).not.toContain('app-overlay-secret');
    expect(profile.config.authMode).toBe('api-key'); expect(profile.credentials.apiKey).toBe(true);
    const resolved = await store.resolve(profile.id, 'codex', '/workspace');
    expect(resolved).toMatchObject({ config: { model: 'trusted-project', provider: 'gateway', baseUrl: 'https://profile.test', authMode: 'api-key' }, apiKey: 'app-overlay-secret', nativeProfile: 'daily' });
    expect(resolved!.nativeConfig).toMatchObject({ model: 'trusted-project' }); expect(closed()).toBe(1);
    expect(JSON.parse(await readFile(join(path, 'profiles.json'), 'utf8')).profiles).toEqual([]);
    await store.remove(profile.id, profile.revision);
    expect(await readdir(home)).toEqual([]); expect((await store.list())).toEqual([]);
    const data = JSON.parse(await readFile(join(path, 'profiles.json'), 'utf8'));
    expect(data.credentials).toEqual({}); expect(data.native).toEqual({});
  });

  test('distinguishes private credential readiness from inherited native auth without exposing either token', async () => {
    const { store, home } = await fixture();
    await writeFile(join(home, 'existing.config.toml'), 'model_provider = "gateway"\n[model_providers.gateway]\nexperimental_bearer_token = "native-file-secret"\n');
    const profile = (await store.list())[0];
    expect(profile.credentials).toEqual({ apiKey: false, authToken: false }); expect(JSON.stringify(profile)).not.toContain('native-file-secret');
    const resolved = await store.resolve(profile.id, 'codex', '/workspace');
    expect(resolved!.apiKey).toBeUndefined(); expect(resolved!.nativeConfig).toMatchObject({ model_providers: { gateway: { experimental_bearer_token: 'native-file-secret' } } });
    await expect(store.save({ harness: 'codex', name: 'existing', config: { authMode: 'api-key' }, revision: profile.revision }, profile.id)).rejects.toMatchObject({ status: 400 });
  });

  test('combines native-file and private-overlay revisions, including credential-only edits', async () => {
    const { store, home } = await fixture();
    const input: ProfileInput = { harness: 'codex', name: 'daily', config: { model: 'profile-model', authMode: 'api-key' }, credentials: { apiKey: 'first' } };
    const first = await store.save(input), nativePath = join(home, 'daily.config.toml'), original = await readFile(nativePath, 'utf8');
    const second = await store.save({ ...input, revision: first.revision, credentials: { apiKey: 'second' } }, first.id);
    expect(second.revision).not.toBe(first.revision); expect(await readFile(nativePath, 'utf8')).toBe(original);
    await expect(store.save({ ...input, revision: first.revision }, first.id)).rejects.toMatchObject({ status: 409 });
    await writeFile(nativePath, original + '\n# External edit\n');
    await expect(store.remove(first.id, second.revision)).rejects.toMatchObject({ status: 409 });
    const third = (await store.list())[0]; expect(third.revision).not.toBe(second.revision);
    expect((await store.resolve(third.id, 'codex', '/workspace'))!.apiKey).toBe('second');
  });

  test('does not commit private credentials when an external edit wins the native save race', async () => {
    const { store, home, path, helpers } = await fixture();
    const first = await store.save({ harness: 'codex', name: 'daily', config: { model: 'old', authMode: 'api-key' }, credentials: { apiKey: 'keep-secret' } });
    const nativePath = join(home, 'daily.config.toml'), before = await readFile(join(path, 'profiles.json'), 'utf8');
    const racing = new ProfileStore(path, { ...helpers, async save(input, id) { await writeFile(nativePath, 'model = "external-winner"\n'); return helpers.save(input, id); } });
    await racing.load();
    await expect(racing.save({ harness: 'codex', name: 'daily', config: { model: 'ours', authMode: 'api-key' }, credentials: { apiKey: 'rejected-secret' }, revision: first.revision }, first.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(await readFile(join(path, 'profiles.json'), 'utf8')).toBe(before);
    expect(await readFile(nativePath, 'utf8')).toBe('model = "external-winner"\n');
    expect((await racing.resolve(first.id, 'codex', '/workspace'))!.apiKey).toBe('keep-secret');
  });

  test('captures one native/private revision while a credential edit waits for an in-flight native read', async () => {
    const { store, path, helpers } = await fixture();
    const input: ProfileInput = { harness: 'codex', name: 'daily', config: { model: 'old-model', authMode: 'api-key' }, credentials: { apiKey: 'old-key' } };
    const profile = await store.save(input), native = (await helpers.list())[0];
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
    let saveStarted = false;
    const concurrent = new ProfileStore(path, {
      ...helpers, list: async () => [native],
      async resolve() { entered.resolve(); await release.promise; return { config: { model: 'old-model' }, nativeProfile: 'daily', nativeConfig: { model: 'old-model' } }; },
      async save() { saveStarted = true; return native; },
    });
    await concurrent.load();
    const reading = concurrent.resolve(profile.id, 'codex', '/workspace'); await entered.promise;
    const saving = concurrent.save({ ...input, revision: profile.revision, credentials: { apiKey: 'new-key' } }, profile.id);
    try {
      // The helpers are synchronous promises, so draining their microtasks detects a write that bypasses the pending read without timing sleeps.
      for (let index = 0; index < 5; index++) await Promise.resolve();
      expect(saveStarted).toBe(false);
    } finally { release.resolve(); }
    expect(await reading).toMatchObject({ config: { model: 'old-model', authMode: 'api-key' }, apiKey: 'old-key' });
    await saving; expect(saveStarted).toBe(true);
    expect((await concurrent.resolve(profile.id, 'codex', '/workspace'))!.apiKey).toBe('new-key');
  });
});
