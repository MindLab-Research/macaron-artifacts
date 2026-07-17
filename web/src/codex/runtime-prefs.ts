// Last-used per-turn runtime override for the Codex composer, persisted per
// workspace (like lib/history.ts). The new-thread route ('/') has no project,
// so it shares the '_' bucket; workspace tiles key on their project id.

import type { CodexRuntimeOverride } from './api';

const STORAGE_PREFIX = 'macaron.codex.runtime.';

function storageKey(project: string): string {
  return STORAGE_PREFIX + (project || '_');
}

export function loadRuntimePref(project: string): CodexRuntimeOverride {
  try {
    const raw = localStorage.getItem(storageKey(project));
    return raw ? (JSON.parse(raw) as CodexRuntimeOverride) : {};
  } catch {
    return {};
  }
}

export function saveRuntimePref(project: string, pref: CodexRuntimeOverride): void {
  try {
    // Never persist the danger tier: it applies to the current turn (kept in
    // the picker's in-memory state), but writing it to localStorage would
    // silently arm full-access on every later thread in this workspace. Drop
    // it so a reloaded thread falls back to the global sandbox default.
    const safe = pref.sandboxMode === 'danger-full-access' ? { ...pref, sandboxMode: undefined } : pref;
    localStorage.setItem(storageKey(project), JSON.stringify(safe));
  } catch {
    /* quota / private mode — ignore */
  }
}
