/** A single native SSE connection, with cancellation fully observed. No reconnect/replay. */
export async function* openCodeV1Events(url: URL, authorization: string, signal: AbortSignal): AsyncGenerator<unknown> {
  const response = await fetch(url, { headers: { Authorization: authorization, Accept: 'text/event-stream' }, signal });
  if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed (${response.status})`);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      // Native writes LF; also accept standard CRLF without inventing event boundaries.
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, match.index); buffer = buffer.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
        if (data) yield JSON.parse(data);
      }
    }
  } finally {
    // The pinned v1 SDK calls reader.cancel() without observing its promise. An
    // aborted fetch rejects that promise in Bun, terminating the process after Stop.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
