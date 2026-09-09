import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ResolvedProfile } from './types.js';
import { openCodeAdapter } from './opencode.js';

test.skipIf(!process.env.MACARON_OPENCODE_SMOKE_PATH)('native OpenCode profiles override and reset a resumed session without contaminating metadata or local configuration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-profiles-')), saved = { ...process.env };
  const calls: { path: string; authorization: string | null; body: Record<string, any> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body });
    const chunk = { id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'local answer' }, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const changed = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'MACARON_OPENCODE_PATH', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH'];
  try {
    process.env.HOME = directory;
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[name] = join(directory, name);
    process.env.MACARON_OPENCODE_PATH = process.env.MACARON_OPENCODE_SMOKE_PATH;
    process.env.OPENCODE_CONFIG = join(directory, 'unused.json'); process.env.OPENCODE_CONFIG_DIR = join(directory, 'native-config');
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'; process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    const nativeConfig = { model: 'local/main', small_model: 'local/main', enabled_providers: ['local'], provider: { local: { npm: '@ai-sdk/openai-compatible', name: 'Local', options: { baseURL: `http://127.0.0.1:${server.port}/native/v1`, apiKey: 'native-key', setCacheKey: true }, models: { main: { name: 'Main', limit: { context: 64000, output: 8192 } }, worker: { name: 'Worker', limit: { context: 64000, output: 8192 }, variants: { high: { reasoningEffort: 'high' } } } } } } };
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(nativeConfig);
    const profile: ResolvedProfile = { config: { model: 'local/worker', variant: 'high', baseUrl: `http://127.0.0.1:${server.port}/profile/v1` }, apiKey: 'profile-key' };
    let nativeId = '';
    const run = async (prompt: string, profile: ResolvedProfile, enrichment = false) => {
      for await (const _chunk of openCodeAdapter.run({ cwd: directory, nativeId: nativeId || undefined, profile, prompt, enrichment, instructions: 'Stable profile guidance', signal: AbortSignal.timeout(30_000), onNativeSession: id => { nativeId = id; }, approve: async () => false })) { /* Drain only the local scripted provider. */ }
      return calls.at(-1)!;
    };
    const main = await run('profile main', profile), parent = nativeId;
    expect(main.path).toBe('/profile/v1/chat/completions'); expect(main.authorization).toBe('Bearer profile-key'); expect(main.body.model).toBe('worker');
    const count = calls.length, catalog = await openCodeAdapter.profileOptions!(directory, profile);
    expect(calls).toHaveLength(count); expect(catalog.models.find(model => model.id === 'local/worker')!.efforts).toContain('high'); expect(JSON.stringify(catalog)).not.toContain('profile-key');
    const metadata = await run('metadata profile', profile, true);
    expect(metadata.path).toBe(main.path); expect(metadata.authorization).toBe(main.authorization); expect(metadata.body.model).toBe(main.body.model); expect(metadata.body.tools).toEqual(main.body.tools); expect(metadata.body.promptCacheKey).toBe(parent);
    const system = (call: typeof main) => call.body.messages.filter((message: { role: string }) => message.role === 'system');
    expect(system(metadata)).toEqual(system(main));
    const reset = await run('reset native', { config: {} });
    expect(reset.path).toBe('/native/v1/chat/completions'); expect(reset.authorization).toBe('Bearer native-key'); expect(reset.body.model).toBe('main');
    expect(JSON.stringify(reset.body.messages)).not.toContain('metadata profile');
    const resetMetadata = await run('metadata native', { config: {} }, true);
    expect(resetMetadata.path).toBe(reset.path); expect(resetMetadata.authorization).toBe(reset.authorization); expect(resetMetadata.body.model).toBe(reset.body.model); expect(resetMetadata.body.tools).toEqual(reset.body.tools); expect(system(resetMetadata)).toEqual(system(reset));
    // With no explicit model in config, native startup falls back to its recent-model state.
    const state = join(process.env.XDG_STATE_HOME!, 'opencode'); await mkdir(state, { recursive: true });
    await writeFile(join(state, 'model.json'), JSON.stringify({ recent: [{ providerID: 'local', modelID: 'main' }] }));
    const { model: _model, ...withoutModel } = nativeConfig; process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify(withoutModel);
    await run('profile again', profile);
    const recentReset = await run('reset to native recent', { config: {} });
    expect(recentReset.body.model).toBe('main'); expect(recentReset.authorization).toBe('Bearer native-key');
    expect(JSON.parse(await readFile(join(state, 'model.json'), 'utf8'))).toEqual({ recent: [{ providerID: 'local', modelID: 'main' }] });
    expect(nativeId).toBe(parent); expect(process.env.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(withoutModel));
  } finally {
    server.stop(true);
    for (const name of changed) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; }
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);
