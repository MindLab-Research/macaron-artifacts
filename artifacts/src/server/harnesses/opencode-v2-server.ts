import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OpenCode, type OpenCodeClient, type ModelRef } from '@opencode/client';
import type { ResolvedProfile } from './types.js';
import type { ProfileOptions } from '../../shared/profiles.js';
import { abortable, abortError, record, safeError, string } from './common.js';
import { requireOpenCodeBinary } from './opencode-binary.js';
import { openCodeV2GuardPlugin } from './opencode-v2-guard.js';

export function openCodeV2Model(value: string): ModelRef {
  const slash = value.indexOf('/');
  if (slash < 1 || slash === value.length - 1) throw new Error('OpenCode v2 models use provider/model format');
  return { providerID: value.slice(0, slash), id: value.slice(slash + 1) };
}

/** Overlay only selected fields; never write a user's native config, providers or auth. */
export function openCodeV2ProfileConfig(native: Record<string, unknown>, profile?: ResolvedProfile, override?: string): Record<string, unknown> {
  const config = structuredClone(native), selected = profile?.config;
  if (!selected) return config;
  const model = override || selected.model, provider = selected.provider || model?.split('/')[0];
  if (model) config.model = model;
  if (selected.agent) config.default_agent = selected.agent;
  if (selected.agentModels) {
    for (const [id, model] of Object.entries(selected.agentModels)) {
      // Native aliases replace whole entries: agents > mode > agent.
      const key = Object.hasOwn(record(config.agents), id) ? 'agents' : Object.hasOwn(record(config.mode), id) ? 'mode' : Object.hasOwn(record(config.agent), id) ? 'agent' : 'agents';
      const agents = record(config[key]);
      config[key] = { ...agents, [id]: { ...record(agents[id]), model } };
    }
  }
  const apiKey = selected.authMode === 'inherit' ? undefined : profile.apiKey;
  if (selected.baseUrl || apiKey) {
    if (!provider) throw new Error('Choose an OpenCode v2 provider or provider/model before overriding its endpoint or API key');
    // Preserve the authoritative inline shape; adding a competing alias would
    // replace the complete legacy provider and discard its package/models.
    const key = Object.hasOwn(record(config.providers), provider) || !Object.hasOwn(record(config.provider), provider) ? 'providers' : 'provider';
    const field = key === 'providers' ? 'settings' : 'options';
    const providers = record(config[key]), prior = record(providers[provider]);
    config[key] = { ...providers, [provider]: { ...prior, [field]: { ...record(prior[field]), ...(selected.baseUrl ? { baseURL: selected.baseUrl } : {}), ...(apiKey ? { apiKey } : {}) } } };
  }
  return config;
}

export interface OpenCodeV2Connection {
  client: OpenCodeClient;
  options(signal: AbortSignal): { signal: AbortSignal };
  guard(id: string, instructions: string, parent?: string): Promise<void>;
  profileOptions(signal: AbortSignal): Promise<ProfileOptions>;
  defaults(signal: AbortSignal): Promise<{ agent: string; model?: ModelRef }>;
  close(): Promise<void>;
}

export async function startOpenCodeV2(cwd: string, signal: AbortSignal, profile?: ResolvedProfile, model?: string): Promise<OpenCodeV2Connection> {
  if (signal.aborted) throw abortError();
  const binary = await requireOpenCodeBinary(2);
  const native = JSON.parse(process.env.OPENCODE_CONFIG_CONTENT || '{}');
  if (!native || typeof native !== 'object' || Array.isArray(native) || (native.plugins !== undefined && !Array.isArray(native.plugins))) throw new Error('Invalid OPENCODE_CONFIG_CONTENT for OpenCode v2');
  const configured = openCodeV2ProfileConfig(native, profile, model);
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-v2-')), guard = join(directory, 'sessions.json'), plugin = join(directory, 'plugin');
  const prefixDirectory = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'macaron-artifacts', 'opencode-v2-prefixes');
  try { await mkdir(plugin); await writeFile(guard, '{}', { mode: 0o600 }); await writeFile(join(plugin, 'index.mjs'), openCodeV2GuardPlugin); }
  catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  const config = { ...configured, plugins: [...(configured.plugins as unknown[] || []), pathToFileURL(plugin).href] };
  // Both native majors default to opencode.db but have incompatible schemas.
  // Keep v1's existing database untouched; v2 gets a stable sibling database,
  // while native auth/config/cache paths still resolve exactly as before.
  const password = crypto.randomUUID(), lifetime = new AbortController();
  const child = spawn(binary, ['serve', '--hostname=127.0.0.1', '--port=0'], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, OPENCODE_CONFIG_CONTENT: JSON.stringify(config), OPENCODE_DB: 'macaron-artifacts-v2.db', MACARON_OPENCODE_V2_GUARD_FILE: guard, MACARON_OPENCODE_V2_PREFIX_DIR: prefixDirectory, OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_SERVER_PASSWORD: password } });
  let closing = false, exited = false, output = '';
  const exit = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve(); }));
  const ready = new Promise<string>((resolve, reject) => {
    child.stdout.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-8192); const url = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1]; if (url) resolve(url); });
    child.stderr.on('data', (data: Buffer) => { output = (output + data.toString()).slice(-8192); });
    child.once('error', error => { reject(error); lifetime.abort(error); });
    child.once('close', code => { if (!closing) { const error = new Error(safeError(`OpenCode v2 server exited (${code}): ${output}`)); reject(error); lifetime.abort(error); } });
  });
  const close = async () => {
    closing = true; lifetime.abort();
    if (!exited) { child.kill('SIGTERM'); const kill = setTimeout(() => child.kill('SIGKILL'), 2000); try { await exit; } finally { clearTimeout(kill); } }
    await rm(directory, { recursive: true, force: true });
  };
  try {
    const baseUrl = await abortable(ready, AbortSignal.any([signal, AbortSignal.timeout(15000)]));
    const client = OpenCode.make({ baseUrl, headers: { Authorization: `Basic ${Buffer.from(`opencode:${password}`).toString('base64')}` } });
    const options = (signal: AbortSignal) => ({ signal: AbortSignal.any([signal, lifetime.signal]) });
    // Location services activate plugins/config asynchronously after server-ready.
    // Wait for our known plugin before reading catalogs/defaults or prompting.
    const deadline = AbortSignal.any([signal, AbortSignal.timeout(10000)]);
    while (true) {
      const plugins = await client.plugin.list({ location: { directory: cwd } }, options(deadline));
      const guardPlugin = plugins.data.find(value => value.id === 'macaron-artifacts-v2-guard');
      if (guardPlugin?.state.status === 'active') break;
      if (guardPlugin?.state.status === 'failed') throw new Error('OpenCode v2 metadata guard plugin failed to load');
      await abortable(new Promise<void>(resolve => setTimeout(resolve, 50)), deadline);
    }
    return {
      client, options, close,
      async guard(id, instructions, parent) {
        const plugins = await client.plugin.list({ location: { directory: cwd } }, options(signal));
        if (!plugins.data.some(value => value.id === 'macaron-artifacts-v2-guard' && value.state.status === 'active')) throw new Error('OpenCode v2 metadata guard plugin is not active');
        await writeFile(guard, JSON.stringify({ [id]: { instructions, ...(parent ? { parent } : {}) } }), { mode: 0o600 });
      },
      async profileOptions(signal) {
        const [models, agents] = await Promise.all([client.model.list({ location: { directory: cwd } }, options(signal)), client.agent.list({ location: { directory: cwd } }, options(signal))]);
        return { models: models.data.filter(item => item.enabled).map(item => ({ id: `${item.providerID}/${item.id}`, name: item.name, provider: item.providerID, efforts: item.variants.map(value => value.id) })), efforts: [], agents: agents.data.filter(item => !item.hidden).map(item => ({ id: item.id, name: item.name, subagent: item.mode === 'subagent' })) };
      },
      async defaults(signal) {
        const [entries, agents] = await Promise.all([client.config.get({ location: { directory: cwd } }, options(signal)), client.agent.list({ location: { directory: cwd } }, options(signal))]);
        const config = Object.assign({}, ...entries.filter(entry => entry.type === 'document').map(entry => record(entry).info));
        const agent = string(config.default_agent) || 'build', definition = agents.data.find(item => item.id === agent);
        const configuredModel = typeof config.model === 'string' ? openCodeV2Model(config.model) : config.model ? { providerID: config.model.providerID, id: config.model.model, ...(config.model.variant ? { variant: config.model.variant } : {}) } : undefined;
        let model = definition?.model || configuredModel;
        if (!model) {
          const nativeDefault = (await client.model.default({ location: { directory: cwd } }, options(signal))).data;
          if (!nativeDefault) throw new Error('OpenCode v2 has no native default model; configure a provider or select a model');
          model = { providerID: nativeDefault.providerID, id: nativeDefault.id };
        }
        return { agent, model };
      },
    };
  } catch (error) { await close(); throw error; }
}
