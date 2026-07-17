// Client helpers for the PTY terminal tiles. A terminal tile reuses the
// canvas' opaque-string sid slot: its sid is `term:<uuid>`, and the server
// keys the PTY by the `<uuid>` part. Input/resize/kill go over POST; the
// output stream is a sibling SSE endpoint (see Terminal.tsx).
//
// /api/terminal/* is auth-gated (server/src/lib/auth.ts): POSTs ride the token
// via authedFetch's Authorization header, and the output stream is read with
// fetch()+getReader() (see openEventStream) so its token rides a header too —
// never a `?token=` query param that would leak into logs/referrers.
import { authedFetch } from './auth';

const TERMINAL_PREFIX = 'term:';

export function isTerminalSid(sid: string): boolean {
  return sid.startsWith(TERMINAL_PREFIX);
}

export function newTerminalSid(): string {
  const uuid =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
  return TERMINAL_PREFIX + uuid;
}

export function terminalId(sid: string): string {
  return sid.slice(TERMINAL_PREFIX.length);
}

function base(project: string, sid: string): string {
  return `/api/terminal/${encodeURIComponent(project)}/${encodeURIComponent(terminalId(sid))}`;
}

export function terminalStreamUrl(project: string, sid: string, cols: number, rows: number): string {
  // Path only — openEventStream's authedFetch retargets /api paths at the
  // configured server, so resolution happens in exactly one place.
  return `${base(project, sid)}/stream?cols=${cols}&rows=${rows}`;
}

// Keystrokes must arrive in order. Chain each input POST behind the previous
// one per terminal so a fast typist can't have the browser reorder them.
const inputChains = new Map<string, Promise<unknown>>();

export function sendTerminalInput(project: string, sid: string, data: string): void {
  const url = `${base(project, sid)}/input`;
  const prev = inputChains.get(sid) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() =>
      authedFetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data }),
      }).catch(() => {}),
    );
  inputChains.set(sid, next);
}

export function sendTerminalResize(project: string, sid: string, cols: number, rows: number): void {
  void authedFetch(`${base(project, sid)}/resize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ cols, rows }),
  }).catch(() => {});
}

export function killTerminal(project: string, sid: string): void {
  void authedFetch(`${base(project, sid)}/kill`, { method: 'POST' }).catch(() => {});
  inputChains.delete(sid);
}
