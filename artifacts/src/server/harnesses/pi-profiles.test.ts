import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HarnessTurn } from './types.js';
import { createPiSession, piProfileOptions, runPiSession } from './pi.js';

test('pi profiles isolate concurrent provider requests and preserve native credentials, catalog and metadata prefix', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-pi-profiles-')), agentDir = join(directory, 'agent');
  const calls: { path: string; authorization: string | null; body: Record<string, any> }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; calls.push({ path: new URL(request.url).pathname, authorization: request.headers.get('authorization'), body });
    const result = { id: 'local', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'local response' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } };
    return new Response(`data: ${JSON.stringify(result)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  try {
    await mkdir(agentDir);
    const model = (id: string) => ({ id, name: id, reasoning: true, thinkingLevelMap: { off: 'none', low: 'low', high: 'high', max: null }, input: ['text'], contextWindow: 32000, maxTokens: 2000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
    const models = JSON.stringify({ providers: { local: { baseUrl: `http://127.0.0.1:${server.port}/native/v1`, api: 'openai-completions', apiKey: 'native-config-key', models: [model('main'), model('secondary')] } } });
    const auth = JSON.stringify({ local: { type: 'api_key', key: 'native-auth-key' } });
    const settings = JSON.stringify({ defaultProvider: 'local', defaultModel: 'main', defaultThinkingLevel: 'off', compaction: { enabled: false }, retry: { enabled: false } });
    await writeFile(join(agentDir, 'models.json'), models); await writeFile(join(agentDir, 'auth.json'), auth); await writeFile(join(agentDir, 'settings.json'), settings);
    const native = await import('@earendil-works/pi-coding-agent'), sdk = { ...native, getAgentDir: () => agentDir }, environment = { ...process.env };
    const profile = (id: string, effort = 'low') => ({ config: { model: 'local/main', effort, baseUrl: `http://127.0.0.1:${server.port}/${id}/v1` }, apiKey: `${id}-key` });
    const turn = (id: string, extra: Partial<HarnessTurn> = {}): HarnessTurn => ({ cwd: directory, prompt: id, instructions: 'Stable profile instructions', profile: profile(id), signal: AbortSignal.timeout(20_000), onNativeSession() {}, approve: async () => false, ...extra });
    const run = async (value: HarnessTurn) => { for await (const _chunk of runPiSession(value, input => createPiSession(input, sdk))) { /* Drain deterministic local responses. */ } };
    let nativeId = '';
    await Promise.all([run(turn('one', { onNativeSession: id => { nativeId = id; } })), run(turn('two', { model: 'local/secondary', profile: profile('two', 'high') }))]);
    const one = calls.find(call => call.path.startsWith('/one/'))!, two = calls.find(call => call.path.startsWith('/two/'))!;
    expect(one.authorization).toBe('Bearer one-key'); expect(two.authorization).toBe('Bearer two-key');
    expect(one.body.model).toBe('main'); expect(two.body.model).toBe('secondary');
    expect(one.body.reasoning_effort).toBe('low'); expect(two.body.reasoning_effort).toBe('high');
    await run(turn('one', { nativeId, enrichment: true, prompt: 'metadata' }));
    const metadata = calls.at(-1)!;
    expect(metadata.path).toBe(one.path); expect(metadata.authorization).toBe(one.authorization); expect(metadata.body.tools).toEqual(one.body.tools);
    expect(metadata.body.messages.filter((message: { role: string }) => ['system', 'developer'].includes(message.role))).toEqual(one.body.messages.filter((message: { role: string }) => ['system', 'developer'].includes(message.role)));
    const options = await piProfileOptions(profile('one'), sdk), configured = options.models.filter(model => model.provider === 'local');
    expect(configured.map(model => model.id)).toEqual(['local/main', 'local/secondary']); expect(configured[0]!.efforts).not.toContain('max');
    expect(JSON.stringify(options)).not.toContain('one-key'); expect(calls).toHaveLength(3);
    await run(turn('inherit', { profile: { ...profile('inherit'), config: { ...profile('inherit').config, authMode: 'inherit' } } }));
    expect(calls.at(-1)!.authorization).toBe('Bearer native-auth-key');
    await run(turn('changed', { nativeId, profile: { ...profile('changed', 'high'), config: { ...profile('changed', 'high').config, model: 'local/secondary' } } }));
    expect(calls.at(-1)!.body.model).toBe('secondary'); expect(calls.at(-1)!.body.reasoning_effort).toBe('high');
    await run(turn('reset', { nativeId, profile: { config: {} } }));
    const reset = calls.at(-1)!;
    expect(reset.path).toBe('/native/v1/chat/completions'); expect(reset.authorization).toBe('Bearer native-auth-key'); expect(reset.body.model).toBe('main'); expect(reset.body.reasoning_effort).not.toBe('high');
    await run(turn('metadata after reset', { nativeId, profile: { config: {} }, enrichment: true }));
    expect(calls.at(-1)!.body.model).toBe('main'); expect(calls.at(-1)!.body.tools).toEqual(reset.body.tools);
    await expect(createPiSession(turn('one', { profile: profile('one', 'max') }), sdk)).rejects.toThrow('does not support thinking level max');
    expect(await readFile(join(agentDir, 'models.json'), 'utf8')).toBe(models); expect(await readFile(join(agentDir, 'auth.json'), 'utf8')).toBe(auth); expect(await readFile(join(agentDir, 'settings.json'), 'utf8')).toBe(settings);
    expect(process.env).toEqual(environment);
  } finally { server.stop(true); await rm(directory, { recursive: true, force: true }); }
}, 60_000);
