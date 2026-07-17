// In-app notification store. Replaced the browser Notification API path so
// notifications render inside the WebUI (top-right stack) and clicks route
// through react-router — otherwise a browser-permission gate silently drops
// half of them and the click can only refocus the window, not the session.
//
// Shape kept identical to the old API so existing callers work; new optional
// `project` + `sid` fields tell the renderer where to jump on click.

export type NotifyOptions = {
  title: string;
  body?: string;
  // De-dupe key. Same tag replaces the prior card rather than stacking.
  tag?: string;
  // Sticky: don't auto-dismiss. Used for permission requests that need an
  // explicit user action.
  requireInteraction?: boolean;
  // Where clicking the card should take the user. Priority order:
  //   1. `href` — explicit route (used by Codex, whose routes differ from Claude's)
  //   2. `project + sid` — Claude convention, navigates to `/w/:project/s/:sid`
  //      (the Workspace route auto-adds the session to canvas + focuses it)
  //   3. neither set — click just fires onClick / dismisses
  href?: string;
  project?: string;
  sid?: string;
  // Extra side-effect on click (e.g. focus a canvas tile that's already on
  // screen). Runs after the navigation.
  onClick?: () => void;
};

export type NotifyItem = NotifyOptions & {
  id: string;
  createdAt: number;
};

// --- Subscribable store ---
// Kept as a plain module-level array + listener set so the API surface
// (`notify(...)`) stays a bare function callable from any module without a
// Provider dependency. Component subscribes via `subscribeNotify`.

let items: NotifyItem[] = [];
const listeners = new Set<() => void>();

function emit() {
  for (const l of listeners) l();
}

export function getNotifyItems(): NotifyItem[] {
  return items;
}

export function subscribeNotify(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function dismissNotify(id: string): void {
  const next = items.filter((n) => n.id !== id);
  if (next.length === items.length) return;
  items = next;
  emit();
}

export function clearNotify(): void {
  if (items.length === 0) return;
  items = [];
  emit();
}

// Monotonic counter — Date.now() would collide when two notifications land
// in the same millisecond (permission_request + tool_use fire back-to-back).
let seq = 0;

export function notify(opts: NotifyOptions): void {
  const id = `n-${++seq}`;
  const item: NotifyItem = { ...opts, id, createdAt: Date.now() };
  // Same-tag dedupe: drop any prior item sharing this tag before pushing.
  if (opts.tag) {
    items = items.filter((n) => n.tag !== opts.tag);
  }
  items = [...items, item];
  emit();
}

// --- Legacy API kept as no-op ---
// `ensureNotificationPermission` used to prompt for browser Notification
// permission; not needed anymore but old call sites might still invoke it.
export async function ensureNotificationPermission(): Promise<'granted'> {
  return 'granted';
}
