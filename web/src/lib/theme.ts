// Theme store: light / dark / system, persisted to localStorage.
// The pre-paint script in index.html sets data-theme before React mounts to
// avoid FOUC; this module keeps it in sync at runtime and on OS changes.
// Keep the storage key and resolution rule in lockstep with index.html.

import { useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'macaron-theme';
const mql = typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)') : null;

function read(): Theme {
  // Guard storage like index.html's pre-paint script does: this runs at
  // module-eval via `current = read()`, so a SecurityError (private mode /
  // storage disabled) would otherwise abort the whole bundle before mount.
  try {
    const t = localStorage.getItem(STORAGE_KEY);
    return t === 'light' || t === 'dark' ? t : 'system';
  } catch {
    return 'system';
  }
}

export function resolveTheme(theme: Theme): ResolvedTheme {
  if (theme === 'system') return mql?.matches ? 'dark' : 'light';
  return theme;
}

let current: Theme = typeof window !== 'undefined' ? read() : 'system';
const listeners = new Set<() => void>();

function apply() {
  document.documentElement.setAttribute('data-theme', resolveTheme(current));
}

export function setTheme(theme: Theme) {
  current = theme;
  // Apply + notify even if persistence throws, so the toggle never dead-ends
  // on a storage write failure (quota exceeded / private mode).
  try {
    if (theme === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* storage unavailable — keep the in-memory theme */
  }
  apply();
  listeners.forEach((l) => l());
}

export function getTheme(): Theme {
  return current;
}

// Re-apply when the OS preference flips while on 'system', and stay in sync
// across tabs when another tab changes the stored theme.
mql?.addEventListener('change', () => {
  if (current === 'system') apply();
  listeners.forEach((l) => l());
});
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key !== STORAGE_KEY && e.key !== null) return;
    current = read();
    apply();
    listeners.forEach((l) => l());
  });
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Snapshot must encode everything the render reads. getTheme() alone returns
// only the setting, so an OS light<->dark flip while on 'system' keeps the
// snapshot === 'system' and React bails out of the re-render — leaving any
// `resolved`-derived UI (the Settings hint today) stale against the DOM that
// apply() already re-themed. Fold `resolved` into the snapshot string so its
// identity changes on an OS flip.
function getSnapshot(): string {
  const t = getTheme();
  return t === 'system' ? `system:${resolveTheme(t)}` : t;
}

/** React hook: current theme setting + the resolved light/dark it maps to. */
export function useTheme(): { theme: Theme; resolved: ResolvedTheme } {
  useSyncExternalStore(subscribe, getSnapshot, () => 'system:light');
  const theme = getTheme();
  return { theme, resolved: resolveTheme(theme) };
}
