import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createOpencodeClient } from '@opencode-ai/sdk/v2/client';
import type { Agent, Config, ConfigProvidersResponses, PermissionRuleset, Provider, Session, SessionPromptAsyncData } from '@opencode-ai/sdk/v2/types';
import type { ProfileOptions } from '../../shared/profiles.js';
import type { ResolvedProfile } from './types.js';
import { abortable, abortError, record, safeError } from './common.js';

export type OpenCodePrompt = NonNullable<SessionPromptAsyncData['body']>;
export type OpenCodeDefaults = { model?: string; agent: string; variant?: string };
export interface OpenCodeConnection {
  getSession(id: string, signal: AbortSignal): Promise<Session>;
  createSession(signal: AbortSignal): Promise<Session>;
  forkSession(id: string, signal: AbortSignal): Promise<Session>;
  copyPermissions(id: string, permission: PermissionRuleset, signal: AbortSignal): Promise<void>;
  blockTools(id: string): Promise<void>;
  events(signal: AbortSignal): AsyncIterable<unknown>;
  prompt(id: string, prompt: OpenCodePrompt, signal: AbortSignal): Promise<void>;
  retry(id: string, messageID: string | undefined, text: string, signal: AbortSignal): Promise<void>;
  replyPermission(id: string, approved: boolean, signal: AbortSignal): Promise<void>;
  rejectQuestion(id: string, signal: AbortSignal): Promise<void>;
  abort(id: string, signal: AbortSignal): Promise<void>;
  deleteSession(id: string, signal: AbortSignal): Promise<void>;
  profileOptions(signal: AbortSignal): Promise<ProfileOptions>;
  defaults(signal: AbortSignal): Promise<OpenCodeDefaults>;
  close(): Promise<void>;
}

/** Apply only explicit overrides; native providers, tools and plugins keep their own configuration. */
export function openCodeProfileConfig(native: Config, profile?: ResolvedProfile, modelOverride?: string): Config {
  const config = structuredClone(native), selected = profile?.config;
  if (!selected) return config;
  const model = modelOverride || selected.model, provider = selected.provider || model?.split('/')[0], apiKey = selected.authMode === 'inherit' ? undefined : profile.apiKey;
  if (model) config.model = model;
  if (selected.agent) config.default_agent = selected.agent;
  for (const [agent, model] of Object.entries(selected.agentModels ?? {})) config.agent = { ...config.agent, [agent]: { ...config.agent?.[agent], model } };
  if (selected.baseUrl || apiKey) {
    if (!provider) throw new Error('Choose an OpenCode provider or provider/model before overriding its endpoint or API key');
    config.provider = { ...config.provider, [provider]: { ...config.provider?.[provider], options: { ...config.provider?.[provider]?.options, ...(selected.baseUrl ? { baseURL: selected.baseUrl } : {}), ...(apiKey ? { apiKey } : {}) } } };
  }
  return config;
}

/** Native provider records contain credentials and headers; deliberately project a small public catalog. */
export function openCodeProfileOptions(providers: Provider[], agents: Agent[]): ProfileOptions {
  return {
    models: providers.flatMap(provider => Object.values(provider.models).map(model => ({ id: `${provider.id}/${model.id}`, name: model.name, provider: provider.id, efforts: Object.entries(model.variants ?? {}).filter(([, value]) => value.disabled !== true).map(([name]) => name) }))),
    efforts: [], agents: agents.map(agent => ({ id: agent.name, name: agent.name, subagent: agent.mode === 'subagent' })),
  };
}

/** Match native Provider.defaultModel without copying its model ranking: the SDK supplies those default IDs. */
export function openCodeDefaultModel(config: Config, catalog: ConfigProvidersResponses[200], recent: unknown): string | undefined {
  if (config.model) return config.model;
  const entries = record(recent).recent;
  for (const entry of Array.isArray(entries) ? entries : []) {
    const { providerID, modelID } = record(entry), provider = catalog.providers.find(provider => provider.id === providerID);
    if (typeof modelID === 'string' && provider?.models[modelID]) return `${provider.id}/${modelID}`;
  }
  const configured = Object.keys(config.provider ?? {}), provider = catalog.providers.find(provider => !configured.length || configured.includes(provider.id));
  const model = provider && catalog.default[provider.id];
  return provider && model ? `${provider.id}/${model}` : undefined;
}

// Installed for both normal turns and metadata. Blocking at execution preserves the model's tool prefix.
// OpenCode loads duplicate skill names concurrently; persist the actual system prefix so a fresh fork server cannot reshuffle it.
export const openCodeGuardPlugin = `import { readFile } from 'node:fs/promises';
export default { id: 'macaron-artifacts-guard', async server({ client }) {
  const affinity = async (sessionID) => {
    const blocked = JSON.parse(await readFile(process.env.MACARON_OPENCODE_GUARD_FILE, 'utf8'));
    if (!blocked.includes(sessionID)) return;
    const result = await client.session.get({ path: { id: sessionID }, throwOnError: true });
    const parent = result.data.metadata?.macaronArtifactsPrefix?.sessionID;
    if (!parent || parent === sessionID) throw new Error('Metadata fork has no parent cache affinity');
    return parent;
  };
  return { 'tool.execute.before': async ({ sessionID }) => {
    const blocked = JSON.parse(await readFile(process.env.MACARON_OPENCODE_GUARD_FILE, 'utf8'));
    if (blocked.includes(sessionID)) throw new Error('Tools are disabled for metadata generation');
  }, 'experimental.chat.system.transform': async ({ sessionID, model }, output) => {
    if (!sessionID) return;
    const blocked = JSON.parse(await readFile(process.env.MACARON_OPENCODE_GUARD_FILE, 'utf8'));
    const result = await client.session.get({ path: { id: sessionID }, throwOnError: true });
    const metadata = result.data.metadata ?? {};
    const key = model.providerID + '/' + model.id;
    if (blocked.includes(sessionID)) {
      const prefix = metadata.macaronArtifactsPrefix;
      if (!prefix || prefix.model !== key || !Array.isArray(prefix.system)) throw new Error('Metadata fork has no matching system prefix');
      output.system.splice(0, output.system.length, ...prefix.system);
    } else {
      await client.session.update({ path: { id: sessionID }, body: { metadata: { ...metadata, macaronArtifactsPrefix: { model: key, sessionID, system: [...output.system] } } }, throwOnError: true });
    }
  }, 'chat.params': async ({ sessionID }, output) => {
    const parent = await affinity(sessionID);
    if (!parent) return;
    for (const key of ['promptCacheKey', 'prompt_cache_key', 'user']) if (output.options[key] === sessionID) output.options[key] = parent;
  }, 'chat.headers': async ({ sessionID, model }, output) => {
    const parent = await affinity(sessionID);
    if (!parent) return;
    const configured = new Headers({ ...model.headers, ...output.headers });
    const names = model.providerID.startsWith('opencode') ? ['x-opencode-session'] : ['x-session-affinity', 'X-Session-Id'];
    for (const key of names) if (!configured.has(key) || configured.get(key) === sessionID) output.headers[key] = parent;
  } };
} };
`;

export async function startOpenCode(cwd: string, signal: AbortSignal, profile?: ResolvedProfile, model?: string): Promise<OpenCodeConnection> {
  if (signal.aborted) throw abortError();
  const nativeConfig = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  if (!nativeConfig || typeof nativeConfig !== 'object' || Array.isArray(nativeConfig) || (nativeConfig.plugin !== undefined && !Array.isArray(nativeConfig.plugin))) throw new Error('Invalid OPENCODE_CONFIG_CONTENT');
  const configured = openCodeProfileConfig(nativeConfig, profile, model);
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-')), guard = join(directory, 'blocked.json'), plugin = join(directory, 'guard.mjs');
  try { await writeFile(guard, '[]', { mode: 0o600 }); await writeFile(plugin, openCodeGuardPlugin); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const config = { ...configured, plugin: [...(configured.plugin ?? []), pathToFileURL(plugin).href] };
  const password = crypto.randomUUID();
  const child = spawn(process.env.MACARON_OPENCODE_PATH || 'opencode', ['serve', '--hostname=127.0.0.1', '--port=0'], {
    cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), MACARON_OPENCODE_GUARD_FILE: guard, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password },
  });
  const lifetime = new AbortController();
  let closing = false, exited = false, output = '', rejectReady!: (error: Error) => void;
  const exit = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  const ready = new Promise<string>((resolve, reject) => {
    rejectReady = reject;
    child.stdout.on('data', (data: Buffer) => {
      output = (output + data.toString()).slice(-8192);
      const url = output.match(/opencode server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (url) resolve(url);
    });
    child.stderr.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-8192); });
    child.once('error', (error) => { reject(error); lifetime.abort(error); });
    child.once('close', (code) => { if (!closing) { const error = new Error(safeError(`OpenCode server exited (${code}): ${output}`)); reject(error); lifetime.abort(error); } });
  });
  const timer = setTimeout(() => rejectReady(new Error('OpenCode server startup timed out')), 15000);
  const close = async () => {
    closing = true;
    lifetime.abort();
    if (!exited) { child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 2000); try { await exit; } finally { clearTimeout(kill); } }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const baseUrl = await abortable(ready, signal);
    const client = createOpencodeClient({ baseUrl, directory: cwd, throwOnError: true, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
    const options = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, lifetime.signal]) });
    return {
      async defaults(signal) {
        const [configured, available] = await Promise.all([client.config.get({}, options(signal)), client.app.agents({}, options(signal))]);
        const agent = configured.data!.default_agent || 'build', definition = available.data!.find(item => item.name === agent);
        let model = definition?.model ? `${definition.model.providerID}/${definition.model.modelID}` : configured.data!.model;
        if (!model) {
          const [catalog, paths] = await Promise.all([client.config.providers({}, options(signal)), client.path.get({}, options(signal))]);
          let recent: unknown;
          try { recent = JSON.parse(await readFile(join(paths.data!.state, 'model.json'), 'utf8')); } catch { /* Native selection also ignores missing or malformed recent-model state. */ }
          model = openCodeDefaultModel(configured.data!, catalog.data!, recent);
          if (!model) throw new Error('OpenCode has no native default model; configure a provider or select a model');
        }
        return { model, agent, variant: definition?.variant };
      },
      async profileOptions(signal) {
        const [providers, agents] = await Promise.all([client.config.providers({}, options(signal)), client.app.agents({}, options(signal))]);
        return openCodeProfileOptions(providers.data!.providers, agents.data!);
      },
      async getSession(sessionID, signal) { return (await client.session.get({ sessionID }, options(signal))).data!; },
      // The shared metadata flow owns titles. Suppress OpenCode's concurrent small-model title call, which has a different system prefix.
      async createSession(signal) { return (await client.session.create({ title: 'Macaron Artifacts' }, options(signal))).data!; },
      async forkSession(sessionID, signal) { return (await client.session.fork({ sessionID }, options(signal))).data!; },
      async copyPermissions(sessionID, permission, signal) { await client.session.update({ sessionID, permission }, options(signal)); },
      async blockTools(sessionID) { await writeFile(guard, JSON.stringify([sessionID]), { mode: 0o600 }); },
      async *events(signal) {
        const result = await client.event.subscribe({}, { ...options(signal), sseMaxRetryAttempts: 1, onSseError(error) { if (!signal.aborted) throw error; } });
        yield* result.stream;
      },
      async prompt(sessionID, prompt, signal) { await client.session.promptAsync({ sessionID, ...prompt }, options(signal)); },
      async retry(sessionID, messageID, text, signal) { await client.v2.session.prompt({ sessionID, id: messageID, prompt: { text }, resume: true }, options(signal)); },
      async replyPermission(requestID, approved, signal) { await client.permission.reply({ requestID, reply: approved ? 'once' : 'reject' }, options(signal)); },
      async rejectQuestion(requestID, signal) { await client.question.reject({ requestID }, options(signal)); },
      async abort(sessionID, signal) { await client.session.abort({ sessionID }, options(signal)); },
      async deleteSession(sessionID, signal) { await client.session.delete({ sessionID }, options(signal)); },
      close,
    };
  } catch (error) { await close(); throw error; }
  finally { clearTimeout(timer); }
}
