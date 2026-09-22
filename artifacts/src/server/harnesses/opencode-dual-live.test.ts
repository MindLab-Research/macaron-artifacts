import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessAdapter } from './types.js';
import { openCodeAdapter } from './opencode.js';
import { openCodeV2Adapter } from './opencode-v2.js';

// One app environment, not independent per-generation homes: schemas must coexist.
test.skipIf(!process.env.MACARON_OPENCODE_SMOKE_PATH || !process.env.MACARON_OPENCODE_V2_SMOKE_PATH)('native v1 and v2 preserve each other in the same home and workspace', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-dual-')), saved = { ...process.env }, calls: any[] = [];
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as any; calls.push(body);
    if (!body.stream) return Response.json({ id: 'dual', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'both work' }, finish_reason: 'stop' }] });
    const event = (delta: unknown, finish: string | null = null) => ({ id: 'dual', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: finish }], ...(finish ? { usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } } : {}) });
    return new Response(`data: ${JSON.stringify(event({ role: 'assistant', content: 'both work' }))}\n\ndata: ${JSON.stringify(event({}, 'stop'))}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const changed = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'MACARON_OPENCODE_PATH', 'MACARON_OPENCODE_V2_PATH', 'OPENCODE_DB', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH'];
  try {
    process.env.HOME = directory;
    for (const key of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[key] = join(directory, key);
    Object.assign(process.env, { MACARON_OPENCODE_PATH: process.env.MACARON_OPENCODE_SMOKE_PATH, MACARON_OPENCODE_V2_PATH: process.env.MACARON_OPENCODE_V2_SMOKE_PATH, OPENCODE_DB: 'opencode.db', OPENCODE_CONFIG: join(directory, 'empty.json'), OPENCODE_CONFIG_DIR: join(directory, 'config'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' });
    await writeFile(process.env.OPENCODE_CONFIG!, '{}');
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'local/fake', small_model: 'local/fake', enabled_providers: ['local'], provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: 'fixture' }, models: { fake: { name: 'Fake', limit: { context: 64000, output: 8192 } } } } } });
    const ids = new Map<string, string>();
    const run = async (adapter: HarnessAdapter, prompt: string) => {
      console.info('dual-native turn', adapter.id, prompt);
      let answer = '';
      for await (const chunk of adapter.run({ cwd: directory, nativeId: ids.get(adapter.id), prompt, model: 'local/fake', instructions: 'Stable dual-generation native test', signal: AbortSignal.timeout(30000), onNativeSession: id => { if (ids.has(adapter.id)) expect(id).toBe(ids.get(adapter.id)!); ids.set(adapter.id, id); }, approve: async () => false, ask: async () => ({ cancelled: true }) })) if (chunk.type === 'text-delta') answer += chunk.delta;
      expect(answer).toBe('both work');
    };
    const db = (name: string) => join(process.env.XDG_DATA_HOME!, 'opencode', name);
    const hash = async (name: string) => createHash('sha256').update(await readFile(db(name))).digest('hex');
    await run(openCodeAdapter, 'V1_FIRST');
    const original = await hash('opencode.db');
    await run(openCodeV2Adapter, 'V2_FIRST');
    expect(await hash('opencode.db')).toBe(original);
    const v2 = await hash('macaron-artifacts-v2.db');
    await run(openCodeAdapter, 'V1_RESUME');
    expect(await hash('macaron-artifacts-v2.db')).toBe(v2);
    const v1Continuation = JSON.stringify(calls.at(-1).messages);
    expect(v1Continuation).toContain('V1_FIRST'); expect(v1Continuation).not.toContain('V2_FIRST');
    await run(openCodeV2Adapter, 'V2_RESUME');
    const v2Continuation = JSON.stringify(calls.at(-1).messages);
    expect(v2Continuation).toContain('V2_FIRST'); expect(v2Continuation).not.toContain('V1_FIRST');
    expect(ids.size).toBe(2);
  } finally {
    provider.stop(true);
    for (const key of changed) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
}, 150000);
