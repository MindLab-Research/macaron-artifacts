import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startOpenCodeV2 } from './opencode-v2-server.js';
import { runOpenCodeV2Connection } from './opencode-v2.js';

// Exercise native normalization, not just the shape of our generated overlay.
for (const source of ['inline', 'file'] as const) for (const shape of ['legacy', 'canonical', 'mixed', 'mode'] as const) {
  test.skipIf(!process.env.MACARON_OPENCODE_V2_SMOKE_PATH)(`native v2 ${source} ${shape} profile retains provider and agent definitions`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'macaron-v2-legacy-')), saved = { ...process.env };
    const calls: { path: string; authorization: string | null; model: unknown }[] = [];
    const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as { model: string };
      calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), model: body.model });
      const chunk = { id: 'local', object: 'chat.completion.chunk', model: body.model, choices: [{ index: 0, delta: { role: 'assistant', content: 'profile answer' }, finish_reason: null }] };
      const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 } };
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    } });
    const changed = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'MACARON_OPENCODE_V2_PATH', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH'];
    try {
      process.env.HOME = directory;
      for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[name] = join(directory, name);
      Object.assign(process.env, { MACARON_OPENCODE_V2_PATH: process.env.MACARON_OPENCODE_V2_SMOKE_PATH, OPENCODE_CONFIG: join(directory, 'native.json'), OPENCODE_CONFIG_DIR: join(directory, 'config-dir'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' });
      const models = { main: { name: 'Main', limit: { context: 64000, output: 8192 } }, worker: { name: 'Worker', limit: { context: 64000, output: 8192 } } };
      const settings = { baseURL: `http://127.0.0.1:${provider.port}/native/v1`, apiKey: 'native-key' };
      const agent = { prompt: 'Preserved scout instructions', description: 'Preserved description', mode: 'subagent', temperature: 0.3 };
      const canonicalAgent = { system: agent.prompt, description: agent.description, mode: agent.mode, request: { body: { temperature: 0.3 } } };
      const native: Record<string, unknown> = { model: 'local/main', enabled_providers: ['local'] };
      if (shape !== 'canonical') Object.assign(native, { provider: { local: { npm: '@ai-sdk/openai-compatible', options: settings, models } }, agent: { scout: agent } });
      if (shape === 'canonical' || shape === 'mixed') Object.assign(native, { providers: { local: { package: '@ai-sdk/openai-compatible', settings, models } }, agents: { scout: canonicalAgent } });
      if (shape === 'mixed') Object.assign(native, { provider: { local: { npm: 'ignored-package', models: { ignored: {} } } }, agent: { scout: { prompt: 'Ignored legacy instructions' } } });
      if (shape === 'mode') Object.assign(native, { agent: { scout: { prompt: 'Ignored lower-priority instructions' } }, mode: { scout: agent } });
      const bytes = JSON.stringify(native), fileBytes = source === 'file' ? bytes : '{}', inlineBytes = source === 'inline' ? bytes : '{}';
      await writeFile(process.env.OPENCODE_CONFIG!, fileBytes); process.env.OPENCODE_CONFIG_CONTENT = inlineBytes;
      const profile = { config: { model: 'local/main', baseUrl: `http://127.0.0.1:${provider.port}/profile/v1`, agentModels: { scout: 'local/worker' } }, apiKey: 'profile-key' };
      const signal = AbortSignal.timeout(30000), connection = await startOpenCodeV2(directory, signal, profile);
      try {
        const catalog = await connection.profileOptions(signal);
        expect(catalog.models.map(item => item.id)).toContain('local/main');
        expect(catalog.models.map(item => item.id)).toContain('local/worker');
        const agents = await connection.client.agent.list({ location: { directory } }, connection.options(signal));
        const scout = agents.data.find(item => item.id === 'scout');
        expect(scout).toMatchObject({ system: agent.prompt, description: agent.description, mode: shape === 'mode' ? 'primary' : 'subagent', model: { providerID: 'local', id: 'worker' }, request: { body: { temperature: 0.3 } } });
        for await (const _ of runOpenCodeV2Connection({ cwd: directory, profile, prompt: 'hello', instructions: 'local integration', signal, onNativeSession() {}, approve: async () => false, ask: async () => ({ cancelled: true as const }) }, connection)) {}
        expect(calls).toEqual([{ path: '/profile/v1/chat/completions', authorization: 'Bearer profile-key', model: 'main' }]);
        expect(await readFile(process.env.OPENCODE_CONFIG!, 'utf8')).toBe(fileBytes);
        expect(process.env.OPENCODE_CONFIG_CONTENT).toBe(inlineBytes);
      } finally { await connection.close(); }
    } finally {
      provider.stop(true);
      for (const key of changed) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
      await rm(directory, { recursive: true, force: true });
    }
  }, 60000);
}
