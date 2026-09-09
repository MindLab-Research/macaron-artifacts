import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { applyTheme, loadTheme, themeAppearance, type Appearance, type ThemeId } from './themes';
import { DEFAULT_PREFERENCES, readPreferences, themeSlot, type ThemeMode, type ThemePreferences, type ThemeSlot } from './preferences';

const STORAGE = 'macaron-artifacts:appearance';
function initialPreferences(): ThemePreferences {
  try { return readPreferences(localStorage.getItem(STORAGE), matchMedia('(prefers-color-scheme: dark)').matches); } catch { return DEFAULT_PREFERENCES; }
}
type ThemeContextValue = {
  appearance: Appearance; preferences: ThemePreferences; activeSlot: ThemeSlot;
  setMode: (mode: ThemeMode) => void; select: (slot: ThemeSlot, id: ThemeId) => void;
  pair: (light: ThemeId, dark: ThemeId) => void; preview: (slot: ThemeSlot, id: ThemeId | null) => void; error?: string;
};
const ThemeContext = createContext<ThemeContextValue | null>(null);

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preferences, setPreferences] = useState(initialPreferences);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [previewState, setPreviewState] = useState<{ slot: ThemeSlot; id: ThemeId } | null>(null);
  const [revision, setRevision] = useState(0);
  const activeSlot = themeSlot(preferences, systemDark);
  const previewId = previewState?.slot === activeSlot ? previewState.id : null;
  const selectedId = preferences[activeSlot];
  const next = useMemo(() => themeAppearance(previewId ?? selectedId, activeSlot === 'dark', revision), [previewId, selectedId, activeSlot, revision]);
  const [appearance, setAppearance] = useState(next);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => { setSystemDark(media.matches); setPreviewState(null); };
    media.addEventListener('change', change); change();
    return () => media.removeEventListener('change', change);
  }, []);
  useEffect(() => {
    // Save both slots even when only the inactive one changed. Hover state is never persisted.
    try { localStorage.setItem(STORAGE, JSON.stringify(preferences)); } catch { /* Nonessential preference storage. */ }
  }, [preferences]);
  useEffect(() => {
    let current = true;
    void loadTheme(next.syntax).then(theme => {
      if (!current) return;
      // Commit palette, mode and syntax together; late hover imports cannot repaint a newer choice.
      applyTheme(theme, next.id === 'playground', next.dark);
      document.documentElement.dataset.palette = next.id;
      document.documentElement.dataset.themePreview = String(previewId !== null);
      setAppearance(next); setError(undefined);
    }, reason => { if (current) setError(reason instanceof Error ? reason.message : '主题加载失败'); });
    return () => { current = false; };
  }, [next, previewId]);
  const preview = useCallback((slot: ThemeSlot, id: ThemeId | null) => {
    // A closing picker may only clear its own preview, never the other slot's newer preview.
    setPreviewState(previous => id ? { slot, id } : previous?.slot === slot ? null : previous);
  }, []);
  const commit = useCallback((update: (previous: ThemePreferences) => ThemePreferences) => { setPreviewState(null); setPreferences(update); setRevision(value => value + 1); }, []);
  const setMode = useCallback((mode: ThemeMode) => commit(previous => ({ ...previous, mode })), [commit]);
  const select = useCallback((slot: ThemeSlot, id: ThemeId) => commit(previous => ({ ...previous, [slot]: id })), [commit]);
  const pair = useCallback((light: ThemeId, dark: ThemeId) => commit(previous => ({ ...previous, light, dark })), [commit]);
  return <ThemeContext value={{ appearance, preferences, activeSlot, setMode, select, pair, preview, error }}>{children}</ThemeContext>;
}
export function useTheme() { const context = use(ThemeContext); if (!context) throw new Error('ThemeProvider is missing'); return context; }
