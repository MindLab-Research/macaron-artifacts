import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedProfile } from './types.js';
import { openCodeV2Adapter } from './opencode-v2.js';

test.skipIf(!process.env.MACARON_OPENCODE_V2_SMOKE_PATH)('native v2 profiles discover, override and reset across server restarts; forks retain prefix and parent history', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-v2-profiles-')), saved = { ...process.env };
  const calls: { path: string; authorization: string | null; body: Record<string, any> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body });
    const chunk = { id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'local answer' }, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const changed = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'MACARON_OPENCODE_V2_PATH', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH'];
  try {
    process.env.HOME = directory;
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[name] = join(directory, name);
    process.env.MACARON_OPENCODE_V2_PATH = process.env.MACARON_OPENCODE_V2_SMOKE_PATH;
    process.env.OPENCODE_CONFIG = join(directory, 'native.json'); process.env.OPENCODE_CONFIG_DIR = join(directory, 'native-config');
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'; process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    const nativeConfig = { model: 'local/main', enabled_providers: ['local'], providers: { local: { package: '@ai-sdk/openai-compatible', name: 'Local', settings: { baseURL: `http://127.0.0.1:${server.port}/native/v1`, apiKey: 'native-key', setCacheKey: true }, models: { main: { name: 'Main', limit: { context: 64000, output: 8192 } }, worker: { name: 'Worker', limit: { context: 64000, output: 8192 }, variants: [{ id: 'high', settings: { reasoningEffort: 'high' } }] } } } } };
    const bytes = JSON.stringify(nativeConfig); await writeFile(process.env.OPENCODE_CONFIG, bytes); process.env.OPENCODE_CONFIG_CONTENT = '{}';
    const profile: ResolvedProfile = { config: { model: 'local/worker', variant: 'high', baseUrl: `http://127.0.0.1:${server.port}/profile/v1`, agentModels: { explore: 'local/worker' } }, apiKey: 'profile-key' };
    let nativeId = '';
    const run = async (prompt: string, profile: ResolvedProfile, enrichment = false) => {
      for await (const _chunk of openCodeV2Adapter.run({ cwd: directory, nativeId: nativeId || undefined, profile, prompt, enrichment, instructions: 'Stable profile guidance', signal: AbortSignal.timeout(30000), onNativeSession: id => { nativeId = id; }, ask: async () => ({ cancelled: true as const }), approve: async () => false })) {}
      return calls.at(-1)!;
    };
    const main = await run('profile main', profile), parent = nativeId;
    expect(main.path).toBe('/profile/v1/chat/completions'); expect(main.authorization).toBe('Bearer profile-key'); expect(main.body.model).toBe('worker');
    const count = calls.length, catalog = await openCodeV2Adapter.profileOptions!(directory, profile);
    expect(calls).toHaveLength(count); expect(catalog.models.map(model => model.id)).toContain('local/worker'); expect(catalog.models.find(model => model.id === 'local/worker')!.efforts).toContain('high'); expect(JSON.stringify(catalog)).not.toContain('profile-key');
    const metadata = await run('metadata profile', profile, true);
    expect(metadata.path).toBe(main.path); expect(metadata.authorization).toBe(main.authorization); expect(metadata.body.model).toBe(main.body.model); expect(metadata.body.tools).toEqual(main.body.tools);
    const system = (call: typeof main) => call.body.messages.filter((message: { role: string }) => message.role === 'system');
    expect(system(metadata)).toEqual(system(main));
    const reset = await run('reset native', { config: {} });
    expect(reset.path).toBe('/native/v1/chat/completions'); expect(reset.authorization).toBe('Bearer native-key'); expect(reset.body.model).toBe('main');
    expect(JSON.stringify(reset.body.messages)).not.toContain('metadata profile');
    const resetMetadata = await run('metadata native', { config: {} }, true);
    expect(resetMetadata.path).toBe(reset.path); expect(resetMetadata.authorization).toBe(reset.authorization); expect(resetMetadata.body.model).toBe(reset.body.model); expect(resetMetadata.body.tools).toEqual(reset.body.tools); expect(system(resetMetadata)).toEqual(system(reset));
    expect(nativeId).toBe(parent); expect(await readFile(process.env.OPENCODE_CONFIG, 'utf8')).toBe(bytes); expect(process.env.OPENCODE_CONFIG_CONTENT).toBe('{}');
    // Reset with no configured default must use the native /model/default choice,
    // not retain a previous profile's model or mutate the user's configuration.
    const { model: _model, ...withoutModel } = nativeConfig;
    const withoutBytes = JSON.stringify(withoutModel); await writeFile(process.env.OPENCODE_CONFIG, withoutBytes);
    await run('override again', profile);
    const nativeDefault = await run('reset without configured model', { config: {} });
    expect(nativeDefault.body.model).toBe('main'); expect(nativeDefault.authorization).toBe('Bearer native-key');
    expect(await readFile(process.env.OPENCODE_CONFIG, 'utf8')).toBe(withoutBytes);
  } finally {
    server.stop(true);
    for (const name of changed) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await rm(directory, { recursive: true, force: true });
  }
}, 120000);
