// A reconnecting SSE client built on fetch()+getReader() instead of the browser
// EventSource. EventSource can't set request headers, which forced the token
// onto the URL as `?token=` — where it leaks into proxy / access logs and
// referrers. fetch carries the token in an Authorization header (via authedFetch)
// and keeps the query clean, at the cost of re-implementing EventSource's
// auto-reconnect, which we do with a simple backoff loop.
import { authedFetch } from './auth';

export type EventStreamHandle = { close: () => void };

// Open `url` and deliver each SSE `data:` payload to onMessage until close().
// Reconnects with a fixed short delay on any drop (mirrors EventSource), unless
// closed. onMessage receives the raw data string (same as EventSource's e.data).
export function openEventStream(url: string, onMessage: (data: string) => void): EventStreamHandle {
  let closed = false;
  let controller: AbortController | null = null;

  const run = async () => {
    while (!closed) {
      controller = new AbortController();
      try {
        const resp = await authedFetch(url, { headers: { Accept: 'text/event-stream' }, signal: controller.signal });
        if (!resp.ok || !resp.body) throw new Error(`http ${resp.status}`);
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const events = buf.split(/\r?\n\r?\n/);
          buf = events.pop() || '';
          for (const ev of events) {
            const data = ev.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
            if (data) onMessage(data);
          }
        }
      } catch { /* fall through to reconnect */ }
      if (closed) return;
      await new Promise((r) => setTimeout(r, 2000));
    }
  };
  void run();

  return { close: () => { closed = true; controller?.abort(); } };
}
