import { expect, test } from 'bun:test';
import { openCodeV1Events } from './opencode-v1-sse.js';

test('native v1 SSE retains frame boundaries and observes cancellation promises', async () => {
  const encoder = new TextEncoder(), controller = new AbortController();
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response(new ReadableStream({ start(stream) { stream.enqueue(encoder.encode('data: {"type":"server.connected"}\r\n\r\ndata: {"type":"message.part.delta",\r\ndata: "properties":{"delta":"native chunk"}}\r\n\r\n')); } }), { headers: { 'Content-Type': 'text/event-stream' } }) });
  try {
    const iterator = openCodeV1Events(new URL(`http://127.0.0.1:${server.port}/event`), 'Basic fixture', controller.signal);
    expect((await iterator.next()).value).toEqual({ type: 'server.connected' });
    expect((await iterator.next()).value).toEqual({ type: 'message.part.delta', properties: { delta: 'native chunk' } });
    const pending = iterator.next(); void pending.catch(() => {}); controller.abort();
    await expect(pending).rejects.toThrow();
    await iterator.return(undefined);
  } finally { controller.abort(); server.stop(true); }
});
