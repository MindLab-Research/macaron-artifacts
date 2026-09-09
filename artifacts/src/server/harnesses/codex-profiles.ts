import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import type { HarnessProfile, ProfileConfig, ProfileInput, ProfileOptions } from '../../shared/profiles.js';
import { record, string } from './common.js';
import { editCodexToml, parseCodexToml } from './codex-profile-toml.js';
import { CodexRpc, type CodexConnection, type CodexRpcOptions } from './codex-rpc.js';
import type { ResolvedProfile } from './types.js';

const namePattern = /^[A-Za-z0-9_-]{1,80}$/, prefix = 'codex:', writes = new Map<string, Promise<unknown>>();
const fields = { model: ['model'], effort: ['model_reasoning_effort'], subagentModel: ['agents', 'default_subagent_model'], subagentEffort: ['agents', 'default_subagent_reasoning_effort'], provider: ['model_provider'] } as const;
const projectBlocked = new Set(['openai_base_url', 'chatgpt_base_url', 'apps_mcp_product_sku', 'model_provider', 'model_providers', 'notify', 'profile', 'profiles', 'experimental_realtime_ws_base_url', 'otel']);
const nativeHome = () => resolve(process.env.CODEX_HOME || join(homedir(), '.codex'));
function problem(message: string, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }
function revision(source: string) { return createHash('sha256').update(source).digest('hex'); }
function profileName(id: string) { const name = id.startsWith(prefix) ? id.slice(prefix.length) : ''; if (!namePattern.test(name)) throw problem('Invalid Codex profile id'); return name; }
function object(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date); }
function withoutNulls(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined).map(([key, item]) => [key, object(item) ? withoutNulls(item) : item])); }
function merge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
  const result = Object.assign(Object.create(null), base) as Record<string, unknown>;
  for (const [key, value] of Object.entries(override)) result[key] = object(value) && object(result[key]) ? merge(result[key], value) : value;
  return result;
}
function at(config: Record<string, unknown>, path: readonly string[]): unknown { return path.reduce<unknown>((value, key) => record(value)[key], config); }
function featureEnabledKey(name: string) { return name === 'context_management' ? 'experimental_mode' : 'enabled'; }
function featureValues(features: unknown): Record<string, boolean> {
  const output: Record<string, boolean> = {};
  for (const [key, value] of Object.entries(record(features))) { const enabled = object(value) ? value[featureEnabledKey(key)] : value; if (typeof enabled === 'boolean') Object.defineProperty(output, key, { value: enabled, enumerable: true, configurable: true, writable: true }); }
  return output;
}
function publicConfig(config: Record<string, unknown>, inheritedProvider = 'openai'): ProfileConfig {
  const output: ProfileConfig = {};
  for (const [field, path] of Object.entries(fields)) { const value = string(at(config, path)); if (value) Object.assign(output, { [field]: value }); }
  const provider = string(config.model_provider) || inheritedProvider, definition = record(record(config.model_providers)[provider]);
  const baseUrl = provider === 'openai' ? string(config.openai_base_url) : string(definition.base_url);
  if (baseUrl) output.baseUrl = baseUrl;
  const features = featureValues(config.features); if (Object.keys(features).length) output.features = features;
  return output;
}
function credentialState(config: Record<string, unknown>) {
  const provider = record(record(config.model_providers)[string(config.model_provider) || 'openai']);
  return { apiKey: Boolean(string(provider.experimental_bearer_token) || process.env[string(provider.env_key)]), authToken: false };
}
async function sourceFile(path: string, follow = false): Promise<string | undefined> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | (follow ? 0 : constants.O_NOFOLLOW));
    const stat = await file.stat(); if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw problem('Codex profile must be a regular TOML file smaller than 2 MB');
    return await file.readFile('utf8');
  } catch (error) {
    if (record(error).code === 'ENOENT') return undefined;
    if (record(error).code === 'ELOOP') throw problem('Symbolic link Codex profiles cannot be edited');
    throw error;
  } finally { await file?.close(); }
}
async function serialized<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = writes.get(path), work = (previous || Promise.resolve()).catch(() => {}).then(action); writes.set(path, work);
  try { return await work; } finally { if (writes.get(path) === work) writes.delete(path); }
}
function assertRevision(source: string | undefined, expected?: string) {
  if (source === undefined || revision(source) !== expected) throw problem('Codex profile changed; reload before saving', 409);
}
function resolvePaths(config: Record<string, unknown>, home: string) {
  const output = merge({}, config);
  for (const key of ['model_catalog_json', 'model_instructions_file', 'experimental_compact_prompt_file', 'log_dir', 'sqlite_home']) if (typeof output[key] === 'string' && !isAbsolute(output[key])) output[key] = resolve(home, output[key]);
  if (object(output.agents)) {
    output.agents = merge({}, output.agents);
    for (const [name, role] of Object.entries(record(output.agents))) if (object(role) && typeof role.config_file === 'string') record(output.agents)[name] = { ...role, config_file: resolve(home, role.config_file) };
  }
  return output;
}

export async function initializeCodex(connection: CodexConnection) {
  await connection.request('initialize', { clientInfo: { name: 'macaron_artifacts', title: 'Macaron Artifacts', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  connection.notify('initialized', {});
}

async function captureCodexDefaults(effective: Record<string, unknown>, selected: Record<string, unknown>, connection: CodexConnection): Promise<ResolvedProfile> {
  const config = publicConfig(effective), provider = config.provider || 'openai';
  let nativeConfig = selected;
  config.provider = provider;
  if (!config.model || !config.effort) {
    let cursor: string | undefined, found: Record<string, unknown> | undefined;
    const cursors = new Set<string>();
    do {
      const response = await connection.request('model/list', { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) });
      found = (Array.isArray(response.data) ? response.data : []).map(record).find(model => config.model ? [model.model, model.id].includes(config.model) : model.isDefault === true);
      cursor = string(response.nextCursor) || undefined;
      if (cursor && cursors.has(cursor)) throw problem('Codex returned a repeated model pagination cursor');
      if (cursor) cursors.add(cursor);
    } while (!found && cursor);
    config.model ||= string(found?.model) || string(found?.id);
    config.effort ||= string(found?.defaultReasoningEffort);
  }
  if (!config.model) throw problem('Cannot determine the native Codex model. Choose a model for this profile.');
  if (!config.effort) throw problem('Cannot determine this custom model\'s default effort. Choose an effort level for this profile.');
  if (object(effective.features)) nativeConfig = merge(nativeConfig, { features: withoutNulls(effective.features) });
  // A fresh app-server must know the restored provider after a prior turn used a private profile provider.
  const definition = withoutNulls(record(record(effective.model_providers)[provider]));
  if (Object.keys(definition).length) nativeConfig = merge(nativeConfig, { model_providers: { [provider]: definition } });
  return { config, nativeConfig };
}

/** The current app-server rejects --profile. Read native files, then preserve Codex's higher-priority trusted project layers. */
export function createCodexProfiles(home = nativeHome(), connect: (options?: CodexRpcOptions) => CodexConnection = options => new CodexRpc(process.env.MACARON_CODEX_PATH || 'codex', options)) {
  const filePath = (id: string) => join(home, `${profileName(id)}.config.toml`);
  const baseConfig = async () => parseCodexToml(await sourceFile(join(home, 'config.toml'), true) || '');
  const entry = (name: string, source: string, base: Record<string, unknown> = {}): HarnessProfile => {
    const common = { id: `${prefix}${name}`, harness: 'codex' as const, name, source: 'codex' as const, revision: revision(source) };
    try { const config = parseCodexToml(source); return { ...common, config: publicConfig(config, string(base.model_provider) || 'openai'), credentials: credentialState(merge(base, config)) }; }
    catch { return { ...common, config: {}, credentials: { apiKey: false, authToken: false }, error: 'This profile contains invalid TOML' }; }
  };
  return {
    async list(): Promise<HarnessProfile[]> {
      let names;
      try { names = await readdir(home, { withFileTypes: true }); } catch (error) { if (record(error).code === 'ENOENT') return []; throw error; }
      const base = await baseConfig().catch(() => ({}));
      const profiles = await Promise.all(names.filter(item => item.isFile() && item.name.endsWith('.config.toml') && namePattern.test(item.name.slice(0, -12))).map(async item => {
        const source = await sourceFile(join(home, item.name)); return source === undefined ? undefined : entry(item.name.slice(0, -12), source, base);
      }));
      return profiles.filter((profile): profile is HarnessProfile => Boolean(profile)).sort((a, b) => a.name.localeCompare(b.name));
    },
    async save(input: ProfileInput, id?: string): Promise<HarnessProfile> {
      if (input.harness !== 'codex' || !namePattern.test(input.name)) throw problem('Codex profile names use letters, numbers, hyphens and underscores');
      if (id && profileName(id) !== input.name) throw problem('Native Codex profile names cannot be renamed');
      const path = filePath(id || `${prefix}${input.name}`);
      return serialized(path, async () => {
        const previous = await sourceFile(path);
        if (id && previous === undefined) throw problem('Codex profile not found', 404);
        if (!id && previous !== undefined) throw problem('A Codex profile with this name already exists', 409);
        if (id) assertRevision(previous, input.revision);
        const existing = parseCodexToml(previous || ''), base = await baseConfig(), config = input.config;
        let source = previous || '';
        for (const [field, keys] of Object.entries(fields)) source = editCodexToml(source, [...keys], config[field as keyof typeof fields] || undefined);
        const provider = config.provider || string(base.model_provider) || 'openai';
        if (provider === 'openai') source = editCodexToml(source, ['openai_base_url'], config.baseUrl || undefined);
        else {
          source = editCodexToml(source, ['model_providers', provider, 'base_url'], config.baseUrl || undefined);
          if (config.baseUrl && !at(existing, ['model_providers', provider, 'name'])) source = editCodexToml(source, ['model_providers', provider, 'name'], provider);
        }
        for (const feature of new Set([...Object.keys(featureValues(existing.features)), ...Object.keys(config.features || {})])) {
          if (!/^[a-z][a-z0-9_]*$/.test(feature)) throw problem('Invalid Codex feature name');
          const inherited = record(base.features)[feature], current = record(existing.features)[feature];
          const path = ['features', feature, ...(object(current) || (current === undefined && object(inherited)) ? [featureEnabledKey(feature)] : [])];
          source = editCodexToml(source, path, config.features?.[feature]);
        }
        if (config.features?.rollout_budget && !(Number(at(merge(base, parseCodexToml(source)), ['features', 'rollout_budget', 'limit_tokens'])) > 0)) throw problem('Set features.rollout_budget.limit_tokens in the native profile before enabling rollout budgets');
        parseCodexToml(source);
        await mkdir(home, { recursive: true, mode: 0o700 });
        const temporary = join(home, `.${input.name}.${randomUUID()}.tmp`), file = await open(temporary, 'wx', 0o600);
        try { await file.writeFile(source, 'utf8'); await file.sync(); } finally { await file.close(); }
        try {
          if (id) { assertRevision(await sourceFile(path), input.revision); await rename(temporary, path); }
          else { try { await link(temporary, path); } catch (error) { if (record(error).code === 'EEXIST') throw problem('A Codex profile with this name already exists', 409); throw error; } }
        } finally { await rm(temporary, { force: true }).catch(() => {}); }
        return entry(input.name, source, base);
      });
    },
    async delete(id: string, expected?: string): Promise<void> {
      const path = filePath(id);
      await serialized(path, async () => { const source = await sourceFile(path); if (source === undefined) throw problem('Codex profile not found', 404); assertRevision(source, expected); await rm(path); });
    },
    async resolve(id: string, cwd: string): Promise<ResolvedProfile> {
      const source = await sourceFile(filePath(id)); if (source === undefined) throw problem('Codex profile not found', 404);
      const selected = resolvePaths(parseCodexToml(source), home), runtime = codexProfileRuntime({ config: publicConfig(selected), nativeConfig: selected });
      const connection = connect({ cwd, env: runtime.env, config: runtime.startup, secrets: runtime.secrets });
      try {
        await initializeCodex(connection);
        const result = await connection.request('config/read', { cwd, includeLayers: true });
        let nativeConfig = selected;
        // config/read returns layers from highest to lowest precedence. Disabled/untrusted layers must never become session overrides.
        const layers = Array.isArray(result.layers) ? [...result.layers].reverse() : [];
        for (const layer of layers) {
          const data = record(layer), name = record(data.name);
          if (name.type !== 'project' || data.disabledReason) continue;
          const project = Object.fromEntries(Object.entries(record(data.config)).filter(([key]) => !projectBlocked.has(key)));
          nativeConfig = merge(nativeConfig, resolvePaths(project, string(name.dotCodexFolder) || cwd));
        }
        const snapshot = await captureCodexDefaults(merge(record(result.config), nativeConfig), nativeConfig, connection);
        return { ...snapshot, nativeProfile: profileName(id) };
      } finally { await connection.close(); }
    },
    async defaults(cwd: string): Promise<ResolvedProfile> {
      const connection = connect({ cwd });
      try {
        await initializeCodex(connection);
        const result = await connection.request('config/read', { cwd, includeLayers: false });
        return await captureCodexDefaults(record(result.config), {}, connection);
      } finally { await connection.close(); }
    },
  };
}

export const listCodexProfiles = () => createCodexProfiles().list();
export const saveCodexProfile = (input: ProfileInput, id?: string) => createCodexProfiles().save(input, id);
export const deleteCodexProfile = (id: string, revision?: string) => createCodexProfiles().delete(id, revision);
export const resolveCodexProfile = (id: string, cwd: string) => createCodexProfiles().resolve(id, cwd);
export const resolveCodexDefaultProfile = (cwd: string) => createCodexProfiles().defaults(cwd);

/** Private credentials travel only in the child environment and local RPC, never argv or the shared Codex login store. */
export function codexProfileRuntime(profile?: ResolvedProfile): { config: Record<string, unknown>; env: NodeJS.ProcessEnv; secrets: string[]; startup: Record<string, unknown> } {
  let config = merge({}, profile?.nativeConfig || {});
  const env = { ...process.env }, secrets: string[] = [], secretVariables: string[] = [];
  const settings = profile?.config || {}, inheritedProvider = settings.provider || string(config.model_provider) || 'openai';
  for (const [field, path] of Object.entries(fields)) {
    const value = settings[field as keyof typeof fields];
    if (value) { let nested: Record<string, unknown> = { [path.at(-1)!]: value }; for (const key of path.slice(0, -1).reverse()) nested = { [key]: nested }; config = merge(config, nested); }
  }
  if (settings.features) {
    const features = merge({}, record(config.features));
    for (const [key, value] of Object.entries(settings.features)) features[key] = object(features[key]) ? { ...features[key], [featureEnabledKey(key)]: value } : value;
    config.features = features;
  }
  if (settings.baseUrl) config = inheritedProvider === 'openai' ? merge(config, { openai_base_url: settings.baseUrl }) : merge(config, { model_providers: { [inheritedProvider]: { base_url: settings.baseUrl } } });
  const providers = merge({}, record(config.model_providers));
  for (const [id, definition] of Object.entries(providers)) {
    const entry = { ...record(definition) }, token = string(entry.experimental_bearer_token);
    if (token) { const key = `MACARON_CODEX_NATIVE_KEY_${revision(id).slice(0, 12).toUpperCase()}`; env[key] = token; secrets.push(token); secretVariables.push(key); delete entry.experimental_bearer_token; entry.env_key = key; }
    providers[id] = entry;
  }
  if (profile?.apiKey) {
    const provider = inheritedProvider === 'openai' ? 'macaron-artifacts' : inheritedProvider, key = 'MACARON_CODEX_PROFILE_API_KEY';
    const definition = { ...record(providers[inheritedProvider]), name: string(record(providers[inheritedProvider]).name) || 'Macaron Artifacts', base_url: settings.baseUrl || string(record(providers[inheritedProvider]).base_url) || string(config.openai_base_url) || 'https://api.openai.com/v1', env_key: key, requires_openai_auth: false };
    delete (definition as Record<string, unknown>).auth; delete (definition as Record<string, unknown>).experimental_bearer_token;
    for (const field of ['http_headers', 'env_http_headers']) if (object((definition as Record<string, unknown>)[field])) (definition as Record<string, unknown>)[field] = Object.fromEntries(Object.entries(record((definition as Record<string, unknown>)[field])).filter(([header]) => !/^(authorization|x-api-key|api-key)$/i.test(header)));
    providers[provider] = definition; config.model_provider = provider; env[key] = profile.apiKey; secrets.push(profile.apiKey); secretVariables.push(key);
  }
  if (Object.keys(providers).length) config.model_providers = providers;
  if (secretVariables.length) config = merge(config, { shell_environment_policy: { filters: Object.fromEntries(secretVariables.map(key => [key, 'exclude'])) } });
  const startup: Record<string, unknown> = {};
  for (const key of ['model', 'model_provider', 'model_catalog_json', 'openai_base_url']) if (typeof config[key] === 'string') startup[key] = config[key];
  const provider = string(config.model_provider) || inheritedProvider, definition = record(providers[provider]);
  // Discovery needs the selected provider/catalog, not arbitrary profile payloads (which may contain secrets in headers or commands).
  if (provider !== 'openai' && Object.keys(definition).length) startup.model_providers = { [provider]: Object.fromEntries(['name', 'base_url', 'env_key', 'requires_openai_auth', 'wire_api'].filter(key => definition[key] !== undefined && definition[key] !== null).map(key => [key, definition[key]])) };
  const featureOverrides = (value: Record<string, unknown>, path: string) => { for (const [key, item] of Object.entries(value)) { if (typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item))) startup[`${path}.${key}`] = item; else if (object(item)) featureOverrides(item, `${path}.${key}`); } };
  featureOverrides(record(config.features), 'features');
  return { config, env, secrets, startup };
}

export async function readCodexProfileOptions(connection: CodexConnection, cwd: string, profile?: ResolvedProfile): Promise<ProfileOptions> {
  await initializeCodex(connection);
  const page = async (method: string) => {
    const values: unknown[] = [], cursors = new Set<string>(); let cursor: string | undefined;
    do {
      const result = await connection.request(method, { limit: 100, ...(cursor ? { cursor } : {}), ...(method === 'model/list' ? { includeHidden: false } : {}) });
      if (Array.isArray(result.data)) values.push(...result.data);
      cursor = string(result.nextCursor) || undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codex returned a repeated pagination cursor');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return values;
  };
  const [modelResult, featureResult, limits, configResult] = await Promise.allSettled([page('model/list'), page('experimentalFeature/list'), connection.request('configRequirements/read', {}), connection.request('config/read', { cwd, includeLayers: false })]);
  const models = modelResult.status === 'fulfilled' ? modelResult.value : [], features = featureResult.status === 'fulfilled' ? featureResult.value : [];
  const requirements = record(limits.status === 'fulfilled' ? limits.value.requirements : undefined), pinned = record(requirements.featureRequirements);
  const config = configResult.status === 'fulfilled' ? record(configResult.value.config) : {};
  const needsBudgetLimit = !(Number(at(config, ['features', 'rollout_budget', 'limit_tokens'])) > 0);
  const options: ProfileOptions = {
    models: models.map(record).filter(model => !model.hidden).map(model => ({ id: string(model.model) || string(model.id), name: string(model.displayName) || string(model.model), efforts: (Array.isArray(model.supportedReasoningEfforts) ? model.supportedReasoningEfforts : []).map(value => string(record(value).reasoningEffort)).filter(Boolean) })),
    efforts: [],
    features: features.map(record).filter(feature => !['removed', 'deprecated'].includes(string(feature.stage)) || Object.hasOwn(profile?.config.features || {}, string(feature.name))).map(feature => {
      const id = string(feature.name), requiresLimit = id === 'rollout_budget' && needsBudgetLimit;
      return { id, name: string(feature.displayName) || id, description: requiresLimit ? 'Set features.rollout_budget.limit_tokens in the native profile before enabling.' : string(feature.description) || undefined, stage: string(feature.stage), enabled: Object.hasOwn(pinned, id) ? Boolean(pinned[id]) : Boolean(feature.enabled), defaultEnabled: Boolean(feature.defaultEnabled), locked: Object.hasOwn(pinned, id) || ['removed', 'deprecated'].includes(string(feature.stage)) || requiresLimit };
    }),
  };
  options.efforts = [...new Set(options.models.flatMap(model => model.efforts || []))];
  const unavailable = [modelResult.status === 'rejected' && 'models', featureResult.status === 'rejected' && 'features', limits.status === 'rejected' && 'managed requirements'].filter(Boolean);
  if (unavailable.length) options.error = `Could not load Codex ${unavailable.join(', ')}. Existing settings are preserved.`;
  return options;
}
