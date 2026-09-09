import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HarnessId } from '../shared/types.js';
import type { HarnessProfile, ProfileConfig, ProfileInput } from '../shared/profiles.js';
import type { ResolvedProfile } from './harnesses/types.js';
import { deleteCodexProfile, listCodexProfiles, resolveCodexDefaultProfile, resolveCodexProfile, saveCodexProfile } from './harnesses/codex-profiles.js';
import { resolveClaudeProfile } from './harnesses/claude-profile.js';

type Credentials = { apiKey?: string; authToken?: string };
type StoredProfile = Omit<HarnessProfile, 'credentials'>;
type NativeOverride = { revision: string; authMode?: ProfileConfig['authMode'] };
type ProfileData = { version: 1; profiles: StoredProfile[]; credentials: Record<string, Credentials>; native: Record<string, NativeOverride>; pendingNative?: Record<string, true> };
type NativeProfiles = { list: typeof listCodexProfiles; save: typeof saveCodexProfile; remove: typeof deleteCodexProfile; resolve: typeof resolveCodexProfile; defaults?: typeof resolveCodexDefaultProfile };
const nativeProfiles: NativeProfiles = { list: listCodexProfiles, save: saveCodexProfile, remove: deleteCodexProfile, resolve: resolveCodexProfile, defaults: resolveCodexDefaultProfile };
const harnesses: HarnessId[] = ['claude-code', 'codex', 'opencode', 'pi'];
const record = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const fields: Record<HarnessId, string[]> = {
  'claude-code': ['model', 'subagentModel', 'effort', 'baseUrl', 'authMode', 'forceSubagentModel', 'modelAliases', 'fineGrainedToolStreaming'],
  codex: ['model', 'subagentModel', 'effort', 'subagentEffort', 'provider', 'baseUrl', 'authMode', 'features'],
  opencode: ['model', 'provider', 'baseUrl', 'authMode', 'agent', 'variant', 'agentModels'],
  pi: ['model', 'provider', 'baseUrl', 'authMode', 'effort'],
};
const fail = (message: string, status = 400): never => { throw Object.assign(new Error(message), { status }); };
const revision = () => crypto.randomUUID();
const incompleteSave = '上次保存未完成。请确认服务地址，重新输入凭据或选择继承本机认证后再保存。';
function clearPending(data: ProfileData, id: string): ProfileData {
  const { pendingNative, ...rest } = data, pending = { ...pendingNative }; delete pending[id];
  return Object.keys(pending).length ? { ...rest, pendingNative: pending } : rest;
}
const string = (value: unknown, name: string, max = 500) => { if (typeof value !== 'string' || value.length > max || /[\0\r\n]/.test(value)) return fail(`${name} 格式无效`); return value.trim(); };

export function validateProfileInput(value: unknown): ProfileInput {
  if (!record(value) || !harnesses.includes(value.harness as HarnessId)) return fail('不支持的 Harness');
  const harness = value.harness as HarnessId, name = string(value.name, 'Profile 名称', 100);
  if (!name) return fail('请输入 Profile 名称');
  if (!record(value.config)) return fail('Profile 配置格式无效');
  const config: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value.config)) {
    if (!fields[harness].includes(key)) return fail(`${harness} 不支持 ${key}`);
    if (entry === undefined || entry === null || entry === '') continue;
    if (['forceSubagentModel', 'fineGrainedToolStreaming'].includes(key)) {
      if (typeof entry !== 'boolean') return fail(`${key} 必须为布尔值`);
      config[key] = entry;
    } else if (['features', 'agentModels', 'modelAliases'].includes(key)) {
      if (!record(entry) || Object.keys(entry).length > 500) return fail(`${key} 格式无效`);
      const entries = Object.entries(entry).map(([name, item]) => {
        if (!/^[a-zA-Z0-9_.-]+$/.test(name) || ['__proto__', 'constructor', 'prototype'].includes(name)) return fail(`${key} 名称无效`);
        if (key === 'modelAliases' && !['opus', 'sonnet', 'haiku', 'fable'].includes(name)) return fail('不支持的模型别名');
        if (key === 'features') { if (typeof item !== 'boolean') return fail('Feature 状态必须为布尔值'); return [name, item]; }
        return [name, string(item, key)];
      });
      config[key] = Object.fromEntries(entries.filter(([, item]) => item !== ''));
    } else config[key] = string(entry, key);
  }
  if (config.authMode && !['inherit', 'api-key', ...(harness === 'claude-code' ? ['auth-token'] : [])].includes(String(config.authMode))) return fail('不支持的认证方式');
  if (config.baseUrl) {
    let url: URL; try { url = new URL(String(config.baseUrl)); } catch { return fail('Base URL 必须是完整的 HTTP 或 HTTPS 地址'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return fail('Base URL 不应包含认证信息，请使用凭据字段');
  }
  if (harness === 'claude-code' && config.effort && !['auto', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.effort))) return fail('Claude Code effort 无效');
  if (harness === 'pi' && config.effort && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(String(config.effort))) return fail('pi thinking level 无效');
  const credentials: ProfileInput['credentials'] = {};
  if (value.credentials !== undefined) {
    if (!record(value.credentials)) return fail('凭据格式无效');
    for (const [key, item] of Object.entries(value.credentials)) {
      if (key !== 'apiKey' && key !== 'authToken') return fail('不支持的凭据字段');
      if (key === 'authToken' && harness !== 'claude-code') return fail('此 Harness 不支持 Bearer Token 配置');
      credentials[key] = item === null ? null : string(item, '凭据', 8192) || null;
    }
  }
  return { harness, name, config: config as ProfileConfig, ...(value.revision !== undefined ? { revision: string(value.revision, 'revision', 200) } : {}), ...(value.credentials !== undefined ? { credentials } : {}) };
}

/** Public DTOs never contain stored credentials or arbitrary native config/layers. */
export class ProfileStore {
  private data: ProfileData = { version: 1, profiles: [], credentials: {}, native: {} };
  private writes: Promise<unknown> = Promise.resolve();
  constructor(readonly directory: string, private native = nativeProfiles, private resolveClaude = resolveClaudeProfile) {}
  async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      const path = join(this.directory, 'profiles.json');
      await chmod(path, 0o600);
      const data = JSON.parse(await readFile(path, 'utf8')) as ProfileData;
      if (data.version !== 1 || !Array.isArray(data.profiles) || !record(data.credentials) || !record(data.native) || data.pendingNative !== undefined && (!record(data.pendingNative) || Object.entries(data.pendingNative).some(([id, pending]) => !/^codex:[A-Za-z0-9_-]{1,80}$/.test(id) || pending !== true))) throw new Error();
      this.data = data;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('无法读取 Profiles 配置，请检查 profiles.json'); }
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> { const next = this.writes.catch(() => {}).then(work); this.writes = next; return next; }
  private async persist(data: ProfileData) {
    const path = join(this.directory, 'profiles.json'), temp = `${path}.${revision()}.tmp`;
    try { await writeFile(temp, JSON.stringify(data), { mode: 0o600 }); await rename(temp, path); this.data = data; }
    finally { await rm(temp, { force: true }); }
  }
  private public(profile: StoredProfile | HarnessProfile): HarnessProfile {
    const credentials = this.data.credentials[profile.id], native = this.data.native[profile.id];
    return structuredClone({
      ...profile, config: { ...profile.config, ...(native?.authMode ? { authMode: native.authMode } : {}) },
      revision: profile.source === 'codex' ? createHash('sha256').update(JSON.stringify([profile.revision, native?.revision ?? ''])).digest('hex') : profile.revision,
      // These flags describe the private credential fields in our editor. Native credentials still work through "inherit".
      credentials: { apiKey: Boolean(credentials?.apiKey), authToken: Boolean(credentials?.authToken) },
      ...(this.data.pendingNative?.[profile.id] ? { pending: true, error: incompleteSave } : {}),
    });
  }
  private pendingProfile(id: string): HarnessProfile { return { id, name: id.slice('codex:'.length), harness: 'codex', source: 'codex', config: {}, revision: `pending:${id}`, credentials: { apiKey: false, authToken: false } }; }
  list(): Promise<HarnessProfile[]> {
    return this.serialize(async () => {
      const profiles = [...this.data.profiles, ...await this.native.list()], known = new Set(profiles.map(profile => profile.id));
      // A crash between the marker and a new native file must still leave a visible repairable entry.
      for (const id of Object.keys(this.data.pendingNative ?? {})) if (!known.has(id)) profiles.push(this.pendingProfile(id));
      return profiles.map(profile => this.public(profile));
    });
  }
  async resolve(id: string | null | undefined, harness: HarnessId, cwd: string): Promise<ResolvedProfile | undefined> {
    if (id === undefined) return;
    // A native read can await RPC. Hold the queue until its private overlay is captured so an edit cannot mix old routing with a new key.
    return this.serialize(async () => {
      if (id === null) {
        if (harness === 'claude-code') return this.resolveClaude(cwd, { config: {} });
        if (harness === 'codex') return this.native.defaults ? this.native.defaults(cwd) : { config: {} };
        return { config: {} };
      }
      if (this.data.pendingNative?.[id]) return fail(incompleteSave, 409);
      const stored = this.data.profiles.find(profile => profile.id === id);
      if (stored ? stored.harness !== harness : id.startsWith('codex:') && harness !== 'codex') return fail('Profile 与 Harness 不匹配');
      if (!stored && !id.startsWith('codex:')) return fail('Profile 不存在', 404);
      const resolved = stored ? { config: stored.config } : await this.native.resolve(id, cwd);
      const config = { ...resolved.config, ...(this.data.native[id]?.authMode ? { authMode: this.data.native[id].authMode } : {}) };
      const credentials = this.data.credentials[id];
      if (config.authMode === 'api-key' && !credentials?.apiKey) return fail('这个 Profile 需要 API Key，请先配置凭据');
      if (config.authMode === 'auth-token' && !credentials?.authToken) return fail('这个 Profile 需要 Bearer Token，请先配置凭据');
      const snapshot = structuredClone({ ...resolved, config, ...(config.authMode === 'api-key' ? { apiKey: credentials!.apiKey } : config.authMode === 'auth-token' ? { authToken: credentials!.authToken } : {}) });
      return harness === 'claude-code' ? this.resolveClaude(cwd, snapshot) : snapshot;
    });
  }
  save(input: ProfileInput, id?: string) {
    // Both queued writes and returned DTOs must be independent of mutable request/consumer objects.
    input = structuredClone(input);
    return this.serialize(async () => {
      const native = input.harness === 'codex', nextId = id ?? (native ? `codex:${input.name}` : crypto.randomUUID()), recovering = Boolean(this.data.pendingNative?.[nextId]);
      if (native && !/^codex:[A-Za-z0-9_-]{1,80}$/.test(nextId)) return fail('Codex profile names use letters, numbers, hyphens and underscores');
      const existing = id ? native ? (await this.native.list()).find(profile => profile.id === id) : this.data.profiles.find(profile => profile.id === id) : undefined;
      const previous = existing ?? (id && native && recovering ? this.pendingProfile(id) : undefined);
      if (id && (!previous || previous.harness !== input.harness)) return fail('Profile 不存在', 404);
      if (id && native && id !== `codex:${input.name}`) return fail('Native Codex profile names cannot be renamed');
      if (previous && this.public(previous).revision !== input.revision) return fail('Profile 已在其他地方更新，请重新打开后再保存', 409);
      if (!native && this.data.profiles.some(profile => profile.id !== id && profile.harness === input.harness && profile.name === input.name)) return fail('这个 Harness 已有同名 Profile', 409);
      const required = input.config.authMode === 'api-key' ? 'apiKey' : input.config.authMode === 'auth-token' ? 'authToken' : undefined;
      if (recovering && required && !input.credentials?.[required]) return fail('请重新输入凭据以修复未完成的保存，或明确选择继承本机认证。', 409);
      const credentials: Credentials = { ...this.data.credentials[nextId] };
      for (const key of ['apiKey', 'authToken'] as const) if (input.credentials && key in input.credentials) { const value = input.credentials[key]; if (value) credentials[key] = value; else delete credentials[key]; }
      if (input.config.authMode === 'api-key' && !credentials.apiKey) return fail('请输入 API Key，或选择继承本机认证');
      if (input.config.authMode === 'auth-token' && !credentials.authToken) return fail('请输入 Bearer Token，或选择继承本机认证');
      let profile: StoredProfile | HarnessProfile;
      if (native) {
        const before = this.data;
        // Native TOML and private credentials cannot share an atomic rename. Persist intent first,
        // so a failed second write or process crash cannot pair new routing with an old credential.
        await this.persist({ ...before, pendingNative: { ...before.pendingNative, [nextId]: true } });
        try { profile = await this.native.save({ ...input, credentials: undefined, revision: existing?.revision }, existing ? id : undefined); }
        catch (error) {
          // Native saves mutate atomically and reject before replacement. Never erase a marker
          // from an earlier incomplete attempt; a failed cleanup must remain blocked as well.
          if (!recovering) await this.persist(before).catch(() => {});
          throw error;
        }
      } else profile = { id: nextId, harness: input.harness, name: input.name, source: 'app', config: input.config, revision: revision() };
      const data: ProfileData = { ...this.data, profiles: native ? this.data.profiles : [...this.data.profiles.filter(profile => profile.id !== nextId), profile], credentials: { ...this.data.credentials, [nextId]: credentials }, native: { ...this.data.native, ...(native ? { [nextId]: { revision: revision(), authMode: input.config.authMode } } : {}) } };
      await this.persist(native ? clearPending(data, nextId) : data);
      return this.public(profile);
    });
  }
  remove(id: string, expected: string | undefined) {
    return this.serialize(async () => {
      const existing = id.startsWith('codex:') ? (await this.native.list()).find(profile => profile.id === id) : this.data.profiles.find(profile => profile.id === id);
      const profile = existing ?? (this.data.pendingNative?.[id] ? this.pendingProfile(id) : undefined);
      if (!profile) return fail('Profile 不存在', 404);
      if (this.public(profile).revision !== expected) return fail('Profile 已更新，请重新打开后再删除', 409);
      if (existing?.source === 'codex') await this.native.remove(id, profile.revision);
      const credentials = { ...this.data.credentials }, native = { ...this.data.native };
      delete credentials[id]; delete native[id];
      await this.persist(clearPending({ ...this.data, profiles: this.data.profiles.filter(profile => profile.id !== id), credentials, native }, id));
    });
  }
}
