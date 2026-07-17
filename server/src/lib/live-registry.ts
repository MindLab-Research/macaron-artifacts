import type { FastifyReply } from 'fastify';
import type { SessionStreamEvent } from '@macaron/shared';
import { sseSend } from './sse.js';

// Per-sessionId registry. Spawned `claude -p` processes write here so that
// freshly-navigated Session pages can subscribe to live deltas via SSE.

type LiveSession = {
  events: SessionStreamEvent[];
  subs: Set<FastifyReply>;
  ended: boolean;
  gc?: NodeJS.Timeout;
};

const LIVE_RING = 4000;
const KEEP_AROUND_MS = 60_000;
const sessions = new Map<string, LiveSession>();

export function liveStart(sid: string, meta: { cwd: string; startedAt?: number }): number {
  // A resume on a stable sid (the codex route) can re-liveStart while a prior
  // turn's liveEnd delete timer is still pending — clear it so the fresh entry
  // isn't reaped mid-turn.
  clearTimeout(sessions.get(sid)?.gc);
  const startedAt = meta.startedAt ?? Date.now();
  sessions.set(sid, {
    events: [{ type: 'meta', cwd: meta.cwd, sessionId: sid, startedAt }],
    subs: new Set(),
    ended: false,
  });
  return startedAt;
}

export function livePush(sid: string, payload: SessionStreamEvent): void {
  const ls = sessions.get(sid);
  if (!ls || ls.ended) return;
  ls.events.push(payload);
  if (ls.events.length > LIVE_RING) {
    // The replay identity is not disposable ring data. A long turn can easily
    // exceed LIVE_RING through tool_input_delta events; dropping meta/user-text
    // would leave a reattaching client unable to match the live turn to JSONL.
    let pinned = ls.events[0]?.type === 'meta' ? 1 : 0;
    if (ls.events[pinned]?.type === 'user-text') pinned += 1;
    ls.events.splice(pinned, ls.events.length - LIVE_RING);
  }
  for (const sub of ls.subs) {
    try {
      sseSend(sub, payload);
    } catch {
      ls.subs.delete(sub);
    }
  }
}

export function liveEnd(sid: string, payload: SessionStreamEvent): void {
  const ls = sessions.get(sid);
  if (!ls) return;
  ls.ended = true;
  ls.events.push(payload);
  for (const sub of ls.subs) {
    try {
      sseSend(sub, payload);
      sub.raw.write('data: [DONE]\n\n');
      sub.raw.end();
    } catch {
      /* already closed */
    }
  }
  ls.subs.clear();
  // Delete only if this exact entry is still current: a later liveStart on the
  // same sid installs a fresh entry, and that turn must outlive this timer.
  ls.gc = setTimeout(() => { if (sessions.get(sid) === ls) sessions.delete(sid); }, KEEP_AROUND_MS);
  // A replay-cache expiry should never keep a shutting-down server or a test
  // worker alive by itself. While the server is running, the timer still fires.
  ls.gc.unref();
}

export function liveGet(sid: string): LiveSession | undefined {
  return sessions.get(sid);
}
