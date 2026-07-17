// Parse OpenAI-style SSE (Macaron, used by GenUI).
import { authedFetch } from './auth';

export type OpenAIStreamHandlers = {
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolArgs?: (text: string, toolName?: string) => void;
  onError?: (msg: string) => void;
  onDone?: () => void;
  signal?: AbortSignal;
};

export async function streamOpenAI(
  url: string,
  body: unknown,
  h: OpenAIStreamHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: h.signal,
    });
  } catch (e) {
    h.onError?.(`request failed: ${(e as Error).message}`);
    return;
  }
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    h.onError?.(`http ${resp.status}: ${txt.slice(0, 300)}`);
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
      if (!data) continue;
      if (data === '[DONE]') {
        h.onDone?.();
        return;
      }
      try {
        const payload = JSON.parse(data);
        if (payload.error) {
          h.onError?.(payload.error);
          continue;
        }
        const ch = payload.choices?.[0]?.delta;
        if (ch?.content) h.onDelta?.(ch.content);
        if (ch?.reasoning_content) h.onReasoning?.(ch.reasoning_content);
        const tc = ch?.tool_calls?.[0];
        if (tc?.function?.arguments) h.onToolArgs?.(tc.function.arguments, tc.function?.name);
      } catch {
        /* ignore */
      }
    }
  }
  h.onDone?.();
}

// Parse our session-message protocol ({type:'delta'|'meta'|'event'|'error'|'done'}).
export type SessionStreamHandlers = {
  onDelta?: (text: string) => void;
  onMeta?: (m: { cwd: string; sessionId: string; startedAt?: number }) => void;
  onStarting?: (m: { cwd: string }) => void;
  onEvent?: (e: { event: string; subtype?: string | null }) => void;
  onToolUse?: (t: { id: string; name: string; input: unknown }) => void;
  onToolInputDelta?: (t: { id: string; name: string; partial_json: string; accumulated: string }) => void;
  onToolInputDone?: (t: { id: string; name: string; final_json: string }) => void;
  onToolResult?: (t: { tool_use_id: string; text: string; isError: boolean }) => void;
  onPermissionRequest?: (p: { id: string; toolName: string; input: unknown; suggestion?: { label: string } }) => void;
  onPermissionResolved?: (p: { id: string; decision: 'allow' | 'deny' }) => void;
  onUsage?: (u: { outputTokens: number; thinkingTokens?: number }) => void;
  onError?: (msg: string) => void;
  onDone?: (terminalSeen: boolean) => void;
  onFollowupDelta?: (text: string) => void;
};

export async function streamSession(
  url: string,
  body: unknown,
  h: SessionStreamHandlers,
): Promise<void> {
  let terminalSeen = false;
  let doneNotified = false;
  const notifyDone = (terminal: boolean) => {
    if (terminal) terminalSeen = true;
    if (doneNotified) return;
    doneNotified = true;
    h.onDone?.(terminalSeen);
  };
  const finishWithError = (msg: string) => {
    // The main turn can finish before the server's optional follow-up stream.
    // A later socket close must not report a second completion/error into a
    // newer turn that the user already started.
    if (doneNotified) return;
    h.onError?.(msg);
    notifyDone(false);
  };
  let resp: Response;
  try {
    resp = await authedFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    finishWithError((e as Error).message);
    return;
  }
  if (!resp.ok || !resp.body) {
    finishWithError(`http ${resp.status}`);
    return;
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
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
        if (!data) continue;
        if (data === '[DONE]') {
          notifyDone(false);
          return;
        }
        try {
          const p = JSON.parse(data);
          if (p.type === 'delta') h.onDelta?.(p.text);
          else if (p.type === 'meta') h.onMeta?.(p);
          else if (p.type === 'starting') h.onStarting?.(p);
          else if (p.type === 'event') h.onEvent?.(p);
          else if (p.type === 'tool_use') h.onToolUse?.(p);
          else if (p.type === 'tool_input_delta') h.onToolInputDelta?.(p);
          else if (p.type === 'tool_input_done') h.onToolInputDone?.(p);
          else if (p.type === 'tool_result') h.onToolResult?.(p);
          else if (p.type === 'permission_request') h.onPermissionRequest?.(p);
          else if (p.type === 'permission_resolved') h.onPermissionResolved?.(p);
          else if (p.type === 'usage') h.onUsage?.(p);
          else if (p.type === 'error') {
            if (!doneNotified) h.onError?.(p.error);
          }
          else if (p.type === 'warn') console.warn('[claude]', p.text);
          // The server keeps the stream open after `done` to append follow-up
          // suggestions, so fire onDone on the business event — the turn is
          // over the moment it arrives, not when the socket closes. The
          // transport close remains the fallback only when no terminal event
          // was seen; notifyDone guarantees one completion callback per POST.
          else if (p.type === 'done') {
            notifyDone(true);
          }
          else if (p.type === 'followup_delta') h.onFollowupDelta?.(p.text);
        } catch {
          /* ignore */
        }
      }
    }
  } catch (e) {
    finishWithError((e as Error).message);
    return;
  }
  notifyDone(false);
}
