// SSE consumers for the /api/kimi/threads endpoints. Parses `data:` frames
// into typed events the chat view can consume with simple callbacks.

import { authedFetch } from '../lib/auth';

export type KimiStreamEvent =
  | { type: 'starting'; cwd?: string }
  | { type: 'meta'; sessionId: string; cwd?: string }
  | { type: 'user-text'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; subtype: string }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number }
  | { type: 'live-end'; reason?: string };

export type KimiStreamHandlers = {
  onMeta?: (sessionId: string, cwd?: string) => void;
  onUserText?: (text: string) => void;
  onDelta?: (text: string) => void;
  onToolUse?: (ev: Extract<KimiStreamEvent, { type: 'tool_use' }>) => void;
  onToolResult?: (ev: Extract<KimiStreamEvent, { type: 'tool_result' }>) => void;
  onEvent?: (subtype: string) => void;
  onUsage?: (out: number, thinking?: number) => void;
  onError?: (msg: string) => void;
  onDone?: (exitCode: number) => void;
  onLiveEnd?: (reason?: string) => void;
};

// Text-only on purpose: `kimi -p` has no verified headless image input (see
// KimiComposer), so the client never sends `images`.
type Body = { text: string; cwd?: string };

async function pump(resp: Response, h: KimiStreamHandlers): Promise<void> {
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    h.onError?.(`http ${resp.status}: ${txt.slice(0, 200)}`);
    h.onDone?.(-1); // so callers waiting on onDone (setSending(false)) don't hang
    return;
  }
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
      const data = ev
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n')
        .trim();
      if (!data || data === '[DONE]') continue;
      let p: KimiStreamEvent;
      try { p = JSON.parse(data) as KimiStreamEvent; } catch { continue; }
      switch (p.type) {
        case 'meta': h.onMeta?.(p.sessionId, p.cwd); break;
        case 'user-text': h.onUserText?.(p.text); break;
        case 'delta': h.onDelta?.(p.text); break;
        case 'tool_use': h.onToolUse?.(p); break;
        case 'tool_result': h.onToolResult?.(p); break;
        case 'event': h.onEvent?.(p.subtype); break;
        case 'usage': h.onUsage?.(p.outputTokens, p.thinkingTokens); break;
        case 'error': h.onError?.(p.error); break;
        case 'done': h.onDone?.(p.exitCode); break;
        case 'live-end': h.onLiveEnd?.(p.reason); break;
      }
    }
  }
}

export async function startKimiThread(body: Body, h: KimiStreamHandlers): Promise<void> {
  const resp = await authedFetch('/api/kimi/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}

export async function sendKimiMessage(sid: string, body: Body, h: KimiStreamHandlers): Promise<void> {
  const resp = await authedFetch(`/api/kimi/threads/${encodeURIComponent(sid)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}

// Passive viewer for the server-authoritative in-flight turn. The endpoint
// replays its buffered snapshot before forwarding new events, so remounting a
// thread after a refresh reconstructs the same live UI as the original POST.
export function subscribeKimiLive(sid: string, h: KimiStreamHandlers): () => void {
  const ac = new AbortController();
  authedFetch(`/api/kimi/threads/${encodeURIComponent(sid)}/live`, { signal: ac.signal })
    .then((resp) => pump(resp, h))
    .catch(() => { /* aborted or disconnected; a remount replays the snapshot */ });
  return () => ac.abort();
}
