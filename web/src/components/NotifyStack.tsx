import { X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  dismissNotify,
  getNotifyItems,
  subscribeNotify,
  type NotifyItem,
} from '../lib/notify';

// Auto-dismiss duration for non-sticky notifications. Long enough that a
// glance at another window doesn't miss it; hovering the card pauses the
// timer so the user can read the full prompt at their own pace.
const AUTO_DISMISS_MS = 15000;

// Top-right stack of in-app notifications. Renderless when empty. Sits
// under App so `useNavigate` is available for click routing.
export function NotifyStack() {
  const [items, setItems] = useState<NotifyItem[]>(() => getNotifyItems());
  const navigate = useNavigate();

  useEffect(() => {
    // Snap to whatever the store holds now, then re-render on every emit.
    setItems(getNotifyItems());
    return subscribeNotify(() => setItems(getNotifyItems()));
  }, []);

  // Per-id timers for auto-dismiss. Sticky items (requireInteraction) skip.
  const timers = useRef(new Map<string, number>());
  // Ids the user is hovering — their timers are paused until pointer leaves.
  const [hovering, setHovering] = useState<Set<string>>(() => new Set());

  const schedule = (id: string) => {
    if (timers.current.has(id)) return;
    const t = window.setTimeout(() => {
      timers.current.delete(id);
      dismissNotify(id);
    }, AUTO_DISMISS_MS);
    timers.current.set(id, t);
  };
  const cancel = (id: string) => {
    const t = timers.current.get(id);
    if (t !== undefined) {
      window.clearTimeout(t);
      timers.current.delete(id);
    }
  };

  useEffect(() => {
    const known = new Set(items.map((i) => i.id));
    // Cancel timers for items that are gone.
    for (const id of Array.from(timers.current.keys())) {
      if (!known.has(id)) cancel(id);
    }
    // Schedule for any new item that doesn't yet have a timer (unless the
    // user is hovering it or it's sticky).
    for (const it of items) {
      if (it.requireInteraction) continue;
      if (hovering.has(it.id)) continue;
      schedule(it.id);
    }
  }, [items, hovering]);

  useEffect(() => {
    // Cleanup on unmount — clear all pending timers.
    const map = timers.current;
    return () => {
      for (const t of map.values()) window.clearTimeout(t);
      map.clear();
    };
  }, []);

  if (items.length === 0) return null;

  const handleClick = (it: NotifyItem) => {
    // Priority order for click target — see NotifyOptions for the rationale.
    // Codex passes `href` (its routes differ from Claude's `/w/:project/s/:sid`).
    if (it.href) {
      navigate(it.href);
    } else if (it.project && it.sid) {
      navigate(`/w/${encodeURIComponent(it.project)}/s/${encodeURIComponent(it.sid)}`);
    }
    try {
      it.onClick?.();
    } catch {
      /* swallow — click side-effects shouldn't crash the stack */
    }
    dismissNotify(it.id);
  };

  return (
    <div className="notify-stack" aria-live="polite">
      {items.map((it) => (
        <button
          type="button"
          key={it.id}
          className="notify-card"
          onClick={() => handleClick(it)}
          onMouseEnter={() => {
            cancel(it.id);
            setHovering((h) => { const n = new Set(h); n.add(it.id); return n; });
          }}
          onMouseLeave={() => {
            setHovering((h) => { const n = new Set(h); n.delete(it.id); return n; });
          }}
        >
          <span className="notify-card-close"
            onClick={(e) => {
              // Explicit dismiss shouldn't also fire the card click.
              e.stopPropagation();
              dismissNotify(it.id);
            }}
            aria-label="dismiss"
          >
            <X size={14} aria-hidden="true" />
          </span>
          <div className="notify-card-title">{it.title}</div>
          {it.body ? <div className="notify-card-body">{it.body}</div> : null}
        </button>
      ))}
    </div>
  );
}
