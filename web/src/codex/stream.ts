// SSE consumers for the /api/codex/threads endpoints. Parses `data:` frames
// into typed events the chat view can consume with simple callbacks.

import { authedFetch } from '../lib/auth';
import type { CodexPlanStatus, CodexApprovalKind, CodexDecision } from '@macaron/shared';
import type { CodexRuntimeOverride } from './api';

export type CodexStreamEvent =
  | { type: 'starting'; cwd?: string }
  | { type: 'meta'; sessionId: string; cwd?: string }
  | { type: 'user-text'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; text: string; isError: boolean }
  | { type: 'usage'; outputTokens: number; thinkingTokens?: number }
  | { type: 'event'; subtype: string }
  | { type: 'codex_plan'; steps: Array<{ step: string; status: CodexPlanStatus }>; explanation?: string | null }
  | { type: 'codex_approval_request'; id: string; kind: CodexApprovalKind; command?: string; cwd?: string; reason?: string | null; fileChanges?: Array<{ path: string; kind: string; diff?: string }>; grantRoot?: string | null; network?: { host: string; protocol: string; port?: number }; available: CodexDecision[] }
  | { type: 'codex_approval_resolved'; id: string; decision?: CodexDecision | 'stale' }
  | { type: 'error'; error: string }
  | { type: 'done'; exitCode: number }
  | { type: 'live-end'; reason?: string };

export type CodexStreamHandlers = {
  onMeta?: (sessionId: string, cwd?: string) => void;
  onUserText?: (text: string) => void;
  onDelta?: (text: string) => void;
  onReasoning?: (text: string) => void;
  onToolUse?: (ev: Extract<CodexStreamEvent, { type: 'tool_use' }>) => void;
  onToolResult?: (ev: Extract<CodexStreamEvent, { type: 'tool_result' }>) => void;
  onEvent?: (subtype: string) => void;
  onUsage?: (out: number, thinking?: number) => void;
  onCodexPlan?: (ev: Extract<CodexStreamEvent, { type: 'codex_plan' }>) => void;
  onCodexApproval?: (ev: Extract<CodexStreamEvent, { type: 'codex_approval_request' }>) => void;
  onCodexApprovalResolved?: (ev: Extract<CodexStreamEvent, { type: 'codex_approval_resolved' }>) => void;
  onError?: (msg: string) => void;
  onDone?: (exitCode: number) => void;
  onLiveEnd?: (reason?: string) => void;
};

type Body = { text: string; cwd?: string; images?: Array<{ mimeType: string; dataUrl: string }>; runtime?: CodexRuntimeOverride };

async function pump(resp: Response, h: CodexStreamHandlers): Promise<void> {
  if (!resp.ok || !resp.body) {
    const txt = await resp.text().catch(() => '');
    h.onError?.(`http ${resp.status}: ${txt.slice(0, 200)}`);
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
      let p: CodexStreamEvent;
      try { p = JSON.parse(data) as CodexStreamEvent; } catch { continue; }
      switch (p.type) {
        case 'meta': h.onMeta?.(p.sessionId, p.cwd); break;
        case 'user-text': h.onUserText?.(p.text); break;
        case 'delta': h.onDelta?.(p.text); break;
        case 'reasoning': h.onReasoning?.(p.text); break;
        case 'tool_use': h.onToolUse?.(p); break;
        case 'tool_result': h.onToolResult?.(p); break;
        case 'event': h.onEvent?.(p.subtype); break;
        case 'usage': h.onUsage?.(p.outputTokens, p.thinkingTokens); break;
        case 'codex_plan': h.onCodexPlan?.(p); break;
        case 'codex_approval_request': h.onCodexApproval?.(p); break;
        case 'codex_approval_resolved': h.onCodexApprovalResolved?.(p); break;
        case 'error': h.onError?.(p.error); break;
        case 'done': h.onDone?.(p.exitCode); break;
        case 'live-end': h.onLiveEnd?.(p.reason); break;
      }
    }
  }
}

export async function startCodexThread(body: Body, h: CodexStreamHandlers): Promise<void> {
  const resp = await authedFetch('/api/codex/threads', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}

export async function sendCodexMessage(sid: string, body: Body, h: CodexStreamHandlers): Promise<void> {
  const resp = await authedFetch(`/api/codex/threads/${encodeURIComponent(sid)}/message`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  await pump(resp, h);
}

// Passive viewer for the server-authoritative in-flight turn. The endpoint
// replays its buffered snapshot before forwarding new events, so remounting a
// thread after a refresh reconstructs the same live UI as the original POST.
export function subscribeCodexLive(sid: string, h: CodexStreamHandlers): () => void {
  const ac = new AbortController();
  authedFetch(`/api/codex/threads/${encodeURIComponent(sid)}/live`, { signal: ac.signal })
    .then((resp) => pump(resp, h))
    .catch(() => { /* aborted or disconnected; a remount replays the snapshot */ });
  return () => ac.abort();
}
