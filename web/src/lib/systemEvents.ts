// Singleton client for the server's system event stream (/api/events). One
// EventSource is shared across every component that cares about "the session
// list changed on disk" — the Dashboard, the sidebar, the workspace canvas —
// so a terminal-started `claude`/`codex` run surfaces live instead of waiting
// for each view's slow interval poll. EventSource reconnects on its own if the
// server restarts, so there's no manual retry loop here.

import type { SystemEvent } from '@macaron/shared';
import { openEventStream, type EventStreamHandle } from './eventStream';

type Listener = (ev: SystemEvent) => void;

let source: EventStreamHandle | null = null;
const listeners = new Set<Listener>();

function ensureSource(): void {
  if (source) return;
  // fetch-based SSE so the token rides an Authorization header, never the URL.
  source = openEventStream('/api/events', (data) => {
    let payload: SystemEvent | { type: string };
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if ((payload as SystemEvent).type === 'sessions-changed') {
      for (const l of listeners) l(payload as SystemEvent);
    }
  });
}

export function subscribeSystemEvents(cb: Listener): () => void {
  listeners.add(cb);
  ensureSource();
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && source) {
      source.close();
      source = null;
    }
  };
}
