import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk } from '../../shared/types.js';
import type { HarnessTurn } from './types.js';
import { openCodeV2Adapter } from './opencode-v2.js';
import { startOpenCodeV2 } from './opencode-v2-server.js';

test.skipIf(!process.env.MACARON_OPENCODE_V2_SMOKE_PATH)('native v2 streaming, guarded fork, approvals/forms, failed-turn retry and cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-v2-live-')), saved = { ...process.env }, calls: Record<string, any>[] = [];
  const marker = join(directory, 'forbidden'), accepted = join(directory, 'accepted'), waiting = Promise.withResolvers<void>();
  let failOnce = true, nativeId = '', approvals = 0, questions = 0;
  const provider = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; calls.push(body);
    const user = [...body.messages].reverse().find((message: any) => message.role === 'user');
    const text = JSON.stringify(user?.content), toolDone = body.messages.at(-1)?.role === 'tool';
    if (text.includes('CANCEL')) { waiting.resolve(); return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(': pending\n\n')); } }), { headers: { 'content-type': 'text/event-stream' } }); }
    if (text.includes('RETRY') && failOnce) { failOnce = false; return Response.json({ error: { message: 'deliberate native retry failure', type: 'invalid_request_error' } }, { status: 400 }); }
    const meta = text.includes('METADATA'), ask = text.includes('QUESTION'), useTool = !toolDone && (meta || ask || text.includes('TOOL'));
    const args = ask ? { questions: [{ question: 'Choose a color', header: 'Color', options: [{ label: 'Blue', description: 'Blue choice' }], multiple: false }] } : { command: `touch ${meta ? marker : accepted}` };
    const delta = useTool ? { tool_calls: [{ index: 0, id: 'native-call', type: 'function', function: { name: ask ? 'question' : 'shell', arguments: JSON.stringify(args) } }] } : { role: 'assistant', content: 'native answer' };
    const chunk = { id: 'local', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: null }] };
    const end = { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: useTool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4, total_tokens: 24 } };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: ${JSON.stringify(end)}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  } });
  const changed = ['HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'MACARON_OPENCODE_V2_PATH', 'OPENCODE_CONFIG', 'OPENCODE_CONFIG_DIR', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH'];
  try {
    process.env.HOME = directory;
    for (const name of ['XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME']) process.env[name] = join(directory, name);
    Object.assign(process.env, { MACARON_OPENCODE_V2_PATH: process.env.MACARON_OPENCODE_V2_SMOKE_PATH, OPENCODE_CONFIG: join(directory, 'empty.json'), OPENCODE_CONFIG_DIR: join(directory, 'config-dir'), OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true', OPENCODE_DISABLE_MODELS_FETCH: 'true' });
    await writeFile(process.env.OPENCODE_CONFIG!, '{}');
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'local/fake', enabled_providers: ['local'], permission: { shell: 'ask' }, provider: { local: { npm: '@ai-sdk/openai-compatible', options: { baseURL: `http://127.0.0.1:${provider.port}/v1`, apiKey: 'fixture', setCacheKey: true }, models: { fake: { name: 'Fake', limit: { context: 64000, output: 8192 } } } } } });
    const run = async (prompt: string, overrides: Partial<HarnessTurn> = {}) => {
      const chunks: ChatChunk[] = [];
      for await (const chunk of openCodeV2Adapter.run({ cwd: directory, nativeId: nativeId || undefined, instructions: 'Stable native v2 live guidance', model: 'local/fake', prompt, signal: AbortSignal.timeout(30000), onNativeSession: id => { nativeId = id; }, approve: async request => { expect(request.tool).toBe('shell'); expect(request.input).toMatchObject({ action: 'shell' }); approvals++; return true; }, ask: async request => { questions++; return { answers: Object.fromEntries(request.questions.map(question => [question.id, ['Blue']])) }; }, ...overrides })) chunks.push(chunk);
      return chunks;
    };
    const main = await run('MAIN'); expect(main.some(chunk => chunk.type === 'text-delta' && chunk.delta === 'native answer')).toBe(true); expect(main.some(chunk => chunk.type === 'data-usage')).toBe(true);
    const parent = nativeId; await run('CONTINUE'); expect(nativeId).toBe(parent);
    const before = calls.at(-1)!, count = calls.length, metadata = await run('METADATA', { enrichment: true });
    expect(metadata.some(chunk => chunk.type === 'tool-output-error' && chunk.errorText.includes('Tools are disabled'))).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' }); expect(nativeId).toBe(parent);
    expect(calls[count].tools).toEqual(before.tools); expect(calls[count].messages.filter((message: any) => message.role === 'system')).toEqual(before.messages.filter((message: any) => message.role === 'system'));
    await run('AFTER'); expect(JSON.stringify(calls.at(-1)!.messages)).not.toContain('METADATA');
    await run('TOOL'); await readFile(accepted); expect(approvals).toBeGreaterThan(0);
    await run('QUESTION'); expect(questions).toBe(1);
    await expect(run('RETRY', { messageId: 'retry-message' })).rejects.toThrow('deliberate native retry failure');
    const failedRequest = calls.at(-1)!; await run('RETRY', { retry: true, messageId: 'retry-message' });
    expect(calls.at(-1)!.messages.filter((message: any) => message.role === 'user')).toEqual(failedRequest.messages.filter((message: any) => message.role === 'user'));
    const controller = new AbortController(), pending = run('CANCEL', { signal: controller.signal }); void pending.catch(() => {});
    await waiting.promise; controller.abort(); await expect(pending).rejects.toThrow(/interrupt|abort/i);
    // Read back the exact native session list: the disposable metadata fork is gone.
    const connection = await startOpenCodeV2(directory, AbortSignal.timeout(10000));
    try { const list = await connection.client.session.list({ directory }, connection.options(AbortSignal.timeout(5000))); expect(list.data.map(session => session.id)).toEqual([parent]); }
    finally { await connection.close(); }
  } finally {
    provider.stop(true); for (const key of changed) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
}, 180000);
