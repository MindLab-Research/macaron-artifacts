import { expect, test } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChatChunk } from '../../shared/types.js';
import { openCodeAdapter } from './opencode.js';

// Opt-in, offline native smoke: the real CLI and SDK talk to a local deterministic model endpoint.
test.skipIf(!process.env.MACARON_OPENCODE_SMOKE_PATH)('OpenCode native streaming, fork prefix and metadata tool guard', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'macaron-opencode-live-')), calls: Array<Record<string, any>> = [], requestHeaders = new Map<object, Headers>(), saved = { ...process.env };
  const marker = join(directory, 'metadata-side-effect');
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const body = await request.json() as Record<string, any>; calls.push(body); requestHeaders.set(body, request.headers);
    const messages = body.messages as Array<Record<string, any>>, last = messages.at(-1);
    const metadata = messages.some(message => message.role === 'user' && message.content === 'metadata');
    const tool = metadata && last?.role !== 'tool';
    const chunks = tool ? [{ tool_calls: [{ index: 0, id: 'metadata-tool', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: `touch ${marker}`, description: 'Create marker' }) } }] }] : [{ content: 'native ' }, { content: metadata ? 'metadata' : 'works' }];
    if (!body.stream) return Response.json({ id: 'completion', object: 'chat.completion', model: 'fake', choices: [{ index: 0, message: { role: 'assistant', content: 'Native smoke' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    return new Response(new ReadableStream({ start(controller) {
      for (const delta of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: 'completion', object: 'chat.completion.chunk', model: 'fake', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })}\n\ndata: [DONE]\n\n`));
      controller.close();
    } }), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  try {
    process.env.MACARON_OPENCODE_PATH = process.env.MACARON_OPENCODE_SMOKE_PATH;
    process.env.XDG_CONFIG_HOME = join(directory, 'config'); process.env.XDG_DATA_HOME = join(directory, 'data'); process.env.XDG_CACHE_HOME = join(directory, 'cache');
    process.env.OPENCODE_DISABLE_DEFAULT_PLUGINS = 'true'; process.env.OPENCODE_DISABLE_MODELS_FETCH = 'true';
    process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ model: 'local/fake', small_model: 'local/fake', provider: { local: { npm: '@ai-sdk/openai-compatible', name: 'local', options: { baseURL: `http://127.0.0.1:${server.port}/v1`, apiKey: 'local-only', setCacheKey: true }, models: { fake: { name: 'fake', limit: { context: 64000, output: 8192 } } } } } });
    let nativeId = '';
    const run = async (prompt: string, enrichment = false) => {
      const chunks: ChatChunk[] = [];
      for await (const chunk of openCodeAdapter.run({ cwd: directory, nativeId: nativeId || undefined, model: 'local/fake', prompt, enrichment, instructions: 'Stable system instructions', signal: AbortSignal.timeout(30000), onNativeSession: id => { nativeId = id; }, approve: async () => true })) chunks.push(chunk);
      return chunks;
    };
    const main = await run('main'), originalID = nativeId;
    expect(main.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.delta)).toEqual(['native ', 'works']);
    const metadata = await run('metadata', true);
    expect(nativeId).toBe(originalID);
    expect(metadata.some(chunk => chunk.type === 'tool-output-error' && chunk.errorText.includes('Tools are disabled'))).toBe(true);
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
    const mainRequest = calls.find(body => body.messages.some((message: Record<string, unknown>) => message.role === 'user' && message.content === 'main') && body.tools?.length)!;
    const metadataRequest = calls.find(body => body.messages.some((message: Record<string, unknown>) => message.role === 'user' && message.content === 'metadata') && body.tools?.length)!;
    expect(mainRequest).toBeDefined(); expect(metadataRequest).toBeDefined();
    expect(mainRequest.promptCacheKey).toBe(originalID);
    expect(metadataRequest.promptCacheKey).toBe(originalID);
    for (const header of ['x-session-affinity', 'X-Session-Id']) expect(requestHeaders.get(metadataRequest)!.get(header)).toBe(requestHeaders.get(mainRequest)!.get(header));
    expect(metadataRequest.tools).toEqual(mainRequest.tools);
    expect(mainRequest.tools.map((tool: Record<string, any>) => tool.function.name)).toEqual(mainRequest.tools.map((tool: Record<string, any>) => tool.function.name).toSorted((a: string, b: string) => a.localeCompare(b)));
    expect(metadataRequest.messages.filter((message: Record<string, unknown>) => message.role === 'system')).toEqual(mainRequest.messages.filter((message: Record<string, unknown>) => message.role === 'system'));
    expect(metadataRequest.messages.some((message: Record<string, unknown>) => message.role === 'assistant' && message.content === 'native works')).toBe(true);
    await run('continue');
    const continuation = calls.find(body => body.messages.some((message: Record<string, unknown>) => message.role === 'user' && message.content === 'continue'))!;
    expect(continuation.messages.some((message: Record<string, unknown>) => message.content === 'metadata')).toBe(false);
    expect(continuation.messages.some((message: Record<string, unknown>) => message.role === 'assistant' && message.content === 'native works')).toBe(true);
  } finally {
    server.stop(true);
    for (const key of ['MACARON_OPENCODE_PATH', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME', 'XDG_CACHE_HOME', 'OPENCODE_CONFIG_CONTENT', 'OPENCODE_DISABLE_DEFAULT_PLUGINS', 'OPENCODE_DISABLE_MODELS_FETCH']) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
    await rm(directory, { recursive: true, force: true });
  }
}, 70000);
