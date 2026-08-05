// The list of headless macaron servers this browser knows about. A "backend" is
// one such server; picking which one to drive is a pure client concern (like VS
// Code's remote picker) — the servers are stateless and don't know about each other.
//
// WHAT LIVES WHERE is the whole design:
//
//   localStorage  — the registry: {id, label, baseUrl}. Non-sensitive, and SHARED
//                   across tabs on purpose: your list of servers is the same list
//                   in every tab, and editing it in one tab should show up in the next.
//   sessionStorage — which backend is ACTIVE (this is apiBase) and its TOKEN (keyed
//                   by origin in auth.ts). Both are per-tab, so two tabs can drive
//                   two different servers, and two tabs on the SAME server keep
//                   their own credentials instead of clobbering each other.
//
// No token ever enters this module or localStorage. That is not an incidental
// detail — it's what lets the registry be a plain shared list with no
// cross-tab compare-and-swap, no migration tombstones, and no recovery state
// machine. Credential lifetime is already solved per-tab in auth.ts/apiBase.ts.

import { clearApiBase, getApiBase, setApiBase } from './apiBase';

export type Backend = {
  id: string;
  label: string;
  // '' means same-origin — the built-in local default, served by the server it
  // talks to. Otherwise an absolute origin like https://box.example.com.
  baseUrl: string;
};

export const LOCAL_BACKEND_ID = 'local';

const BACKENDS_KEY = 'macaron_backends';

function localDefault(): Backend {
  return { id: LOCAL_BACKEND_ID, label: 'Local', baseUrl: '' };
}

// Normalize one stored entry, rejecting anything malformed. A hand-edited or
// corrupted registry must not crash the app or produce a `baseUrl` that later
// throws inside URL parsing — a bad entry is simply dropped.
function normalize(raw: unknown): Backend | null {
  if (!raw || typeof raw !== 'object') return null;
  const { id, label, baseUrl } = raw as Record<string, unknown>;
  if (typeof id !== 'string' || !id) return null;
  if (typeof label !== 'string' || typeof baseUrl !== 'string') return null;
  if (baseUrl) {
    // Must be an origin, no path — same rule setApiBase enforces, checked here
    // so a stored value can't smuggle in a reroute that only fails at use time.
    try { const u = new URL(baseUrl); if (u.origin !== baseUrl) return null; } catch { return null; }
  }
  return { id, label, baseUrl };
}

// Read the registry. A read that throws (private mode) is indistinguishable from
// an empty one for our purposes: either way we have no user-defined servers to
// offer, and the built-in local default still works. Unlike a token, losing the
// list is not a security event — it's a cosmetic one.
export function loadBackends(): Backend[] {
  let parsed: unknown = null;
  try { parsed = JSON.parse(localStorage.getItem(BACKENDS_KEY) || 'null'); } catch { parsed = null; }
  const stored = Array.isArray(parsed) ? parsed.map(normalize).filter((b): b is Backend => !!b) : [];
  // The local default is synthetic and always present, so it is never stored and
  // never duplicated by a stored entry claiming its id.
  const rest = stored.filter((b) => b.id !== LOCAL_BACKEND_ID);
  const seen = new Set<string>();
  return [localDefault(), ...rest.filter((b) => !seen.has(b.id) && seen.add(b.id))];
}

// Persist the registry, minus the synthetic local default. Best-effort: a failed
// write (quota / private mode) loses a label edit, not a credential.
export function saveBackends(list: Backend[]): void {
  const stored = list.filter((b) => b.id !== LOCAL_BACKEND_ID).map(({ id, label, baseUrl }) => ({ id, label, baseUrl }));
  try { localStorage.setItem(BACKENDS_KEY, JSON.stringify(stored)); } catch { /* private mode / quota */ }
}

// Which backend this TAB is driving. Derived from apiBase (sessionStorage) rather
// than stored separately, so there is exactly one source of truth for where
// requests go — a second copy could disagree with the one authedFetch actually uses.
export function getActiveBackend(): Backend {
  const base = getApiBase();
  if (!base) return localDefault();
  return loadBackends().find((b) => b.baseUrl === base) || { id: base, label: base, baseUrl: base };
}

// Point THIS TAB at a backend. Switching clears nothing: the previous backend's
// token stays under its own origin key, so switching away and back does not
// require logging in again, and the new backend's token is whatever was minted
// for its origin.
export function activateBackend(id: string): void {
  const target = loadBackends().find((b) => b.id === id);
  if (!target) return;
  if (target.baseUrl) setApiBase(target.baseUrl);
  else clearApiBase();
}
