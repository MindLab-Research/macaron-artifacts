import { filterThemes, THEME_OPTIONS, type ThemeId } from './themes';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ThemeSlot = 'light' | 'dark';
export type ThemePreferences = { version: 2; mode: ThemeMode; light: ThemeId; dark: ThemeId };
export type ThemePreset = { id: string; label: string; light: ThemeId; dark: ThemeId };
export const DEFAULT_PREFERENCES: ThemePreferences = { version: 2, mode: 'system', light: 'playground', dark: 'playground' };

// Order is intentional: a family's first entry is its default counterpart when migrating a single saved theme.
export const THEME_PRESETS: ThemePreset[] = [
  { id: 'playground', label: 'Playground', light: 'playground', dark: 'playground' },
  { id: 'vitesse', label: 'Vitesse', light: 'vitesse-light', dark: 'vitesse-dark' },
  { id: 'vitesse-black', label: 'Vitesse Black', light: 'vitesse-light', dark: 'vitesse-black' },
  { id: 'github', label: 'GitHub', light: 'github-light', dark: 'github-dark' },
  { id: 'github-default', label: 'GitHub Default', light: 'github-light-default', dark: 'github-dark-default' },
  { id: 'github-dimmed', label: 'GitHub Dimmed', light: 'github-light-default', dark: 'github-dark-dimmed' },
  { id: 'github-high-contrast', label: 'GitHub High Contrast', light: 'github-light-high-contrast', dark: 'github-dark-high-contrast' },
  { id: 'catppuccin', label: 'Catppuccin', light: 'catppuccin-latte', dark: 'catppuccin-mocha' },
  { id: 'catppuccin-frappe', label: 'Catppuccin Frappe', light: 'catppuccin-latte', dark: 'catppuccin-frappe' },
  { id: 'catppuccin-macchiato', label: 'Catppuccin Macchiato', light: 'catppuccin-latte', dark: 'catppuccin-macchiato' },
  { id: 'rose-pine', label: 'Rose Pine', light: 'rose-pine-dawn', dark: 'rose-pine' },
  { id: 'rose-pine-moon', label: 'Rose Pine Moon', light: 'rose-pine-dawn', dark: 'rose-pine-moon' },
  { id: 'horizon', label: 'Horizon', light: 'horizon-bright', dark: 'horizon' },
  { id: 'one', label: 'One', light: 'one-light', dark: 'one-dark-pro' },
  { id: 'slack', label: 'Slack', light: 'slack-ochin', dark: 'slack-dark' },
  { id: 'kanagawa', label: 'Kanagawa', light: 'kanagawa-lotus', dark: 'kanagawa-wave' },
  { id: 'kanagawa-dragon', label: 'Kanagawa Dragon', light: 'kanagawa-lotus', dark: 'kanagawa-dragon' },
  { id: 'material', label: 'Material', light: 'material-theme-lighter', dark: 'material-theme' },
  { id: 'material-darker', label: 'Material Darker', light: 'material-theme-lighter', dark: 'material-theme-darker' },
  { id: 'material-ocean', label: 'Material Ocean', light: 'material-theme-lighter', dark: 'material-theme-ocean' },
  { id: 'material-palenight', label: 'Material Palenight', light: 'material-theme-lighter', dark: 'material-theme-palenight' },
  { id: 'vs-code', label: 'VS Code', light: 'light-plus', dark: 'dark-plus' },
  { id: 'ayu', label: 'Ayu', light: 'ayu-light', dark: 'ayu-dark' },
  { id: 'ayu-mirage', label: 'Ayu Mirage', light: 'ayu-light', dark: 'ayu-mirage' },
  { id: 'everforest', label: 'Everforest', light: 'everforest-light', dark: 'everforest-dark' },
  { id: 'gruvbox', label: 'Gruvbox', light: 'gruvbox-light-medium', dark: 'gruvbox-dark-medium' },
  { id: 'gruvbox-hard', label: 'Gruvbox Hard', light: 'gruvbox-light-hard', dark: 'gruvbox-dark-hard' },
  { id: 'gruvbox-soft', label: 'Gruvbox Soft', light: 'gruvbox-light-soft', dark: 'gruvbox-dark-soft' },
  { id: 'min', label: 'Min', light: 'min-light', dark: 'min-dark' },
  { id: 'night-owl', label: 'Night Owl', light: 'night-owl-light', dark: 'night-owl' },
  { id: 'solarized', label: 'Solarized', light: 'solarized-light', dark: 'solarized-dark' },
];

export const slotThemes = (slot: ThemeSlot, query = '') => filterThemes(query).filter(theme => theme.id === 'playground' || theme.type === slot);
export const themeSlot = (preferences: ThemePreferences, systemDark: boolean): ThemeSlot => preferences.mode === 'system' ? systemDark ? 'dark' : 'light' : preferences.mode;
export const matchingPreset = (preferences: ThemePreferences) => THEME_PRESETS.find(preset => preset.light === preferences.light && preset.dark === preferences.dark);
const validSlot = (id: unknown, slot: ThemeSlot): id is ThemeId => THEME_OPTIONS.some(theme => theme.id === id && (id === 'playground' || theme.type === slot));

export function readPreferences(raw: string | null, systemDark: boolean): ThemePreferences {
  const defaults = { ...DEFAULT_PREFERENCES };
  let saved: Record<string, unknown>;
  try {
    const value: unknown = JSON.parse(raw ?? 'null');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults;
    saved = value as Record<string, unknown>;
  } catch { return defaults; }
  if (saved.version === 2) return {
    version: 2,
    mode: saved.mode === 'system' || saved.mode === 'light' || saved.mode === 'dark' ? saved.mode : defaults.mode,
    light: validSlot(saved.light, 'light') ? saved.light : defaults.light,
    dark: validSlot(saved.dark, 'dark') ? saved.dark : defaults.dark,
  };
  if (saved.version !== undefined) return defaults;
  const selected = THEME_OPTIONS.find(theme => theme.id === saved.id);
  if (!selected) return defaults;
  const mode = selected.type ?? ((typeof saved.dark === 'boolean' ? saved.dark : systemDark) ? 'dark' : 'light');
  const pair = THEME_PRESETS.find(preset => preset[mode] === selected.id);
  // Legacy storage represented a fixed choice, even when its initial value originally came from the OS.
  return { version: 2, mode, light: pair?.light ?? 'vitesse-light', dark: pair?.dark ?? 'vitesse-dark', [mode]: selected.id };
}
