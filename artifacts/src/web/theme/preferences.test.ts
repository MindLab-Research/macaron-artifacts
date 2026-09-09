import { expect, test } from 'bun:test';
import { DEFAULT_PREFERENCES, THEME_PRESETS, matchingPreset, readPreferences, slotThemes, themeSlot, type ThemePreferences } from './preferences';
import { THEME_OPTIONS } from './themes';

test('new preferences follow the OS with independently owned defaults', () => {
  const preferences = readPreferences(null, true);
  expect(preferences).toEqual(DEFAULT_PREFERENCES);
  expect(themeSlot(preferences, true)).toBe('dark');
  expect(themeSlot(preferences, false)).toBe('light');
  preferences.dark = 'vitesse-dark';
  expect(readPreferences(null, true).dark).toBe('playground');
});

test('saved mode and both themes survive storage without depending on current system mode', () => {
  for (const mode of ['system', 'light', 'dark'] as const) {
    const preferences: ThemePreferences = { version: 2, mode, light: 'github-light', dark: 'vitesse-black' };
    expect(readPreferences(JSON.stringify(preferences), false)).toEqual(preferences);
    expect(readPreferences(JSON.stringify(preferences), true)).toEqual(preferences);
    expect(themeSlot(preferences, false)).toBe(mode === 'system' ? 'light' : mode);
    expect(themeSlot(preferences, true)).toBe(mode === 'system' ? 'dark' : mode);
  }
});

test('invalid saved values cannot put an opposite-mode theme in a slot', () => {
  for (const raw of ['{', 'null', '[]', '42', '"dark"', '{"version":3,"id":"github-dark"}', '{"id":"not-a-theme"}']) expect(readPreferences(raw, true)).toEqual(DEFAULT_PREFERENCES);
  expect(readPreferences(JSON.stringify({ version: 2, mode: 'sepia', light: 'github-dark', dark: 'missing' }), true)).toEqual(DEFAULT_PREFERENCES);
  expect(readPreferences(JSON.stringify({ version: 2, mode: 'dark', light: 'github-light', dark: 'github-light' }), false)).toEqual({ ...DEFAULT_PREFERENCES, mode: 'dark', light: 'github-light' });
  expect(readPreferences(JSON.stringify({ version: 2, mode: 'light', dark: 'vitesse-black' }), true)).toEqual({ ...DEFAULT_PREFERENCES, mode: 'light', dark: 'vitesse-black' });
});

test('legacy preferences preserve named variants and migrate to an explicit family pair', () => {
  const cases = [
    ['catppuccin-macchiato', 'catppuccin-latte', 'dark'], ['vitesse-black', 'vitesse-light', 'dark'],
    ['github-dark-high-contrast', 'github-light-high-contrast', 'dark'], ['github-dark-dimmed', 'github-light-default', 'dark'],
    ['rose-pine-dawn', 'rose-pine', 'light'], ['kanagawa-dragon', 'kanagawa-lotus', 'dark'],
  ] as const;
  for (const [id, counterpart, mode] of cases) {
    const preferences = readPreferences(JSON.stringify({ id, dark: mode !== 'dark' }), mode !== 'dark');
    expect(preferences.mode).toBe(mode);
    expect(preferences[mode]).toBe(id);
    expect(preferences[mode === 'dark' ? 'light' : 'dark']).toBe(counterpart);
  }
});

test('legacy Playground preserves its visible mode while unpaired themes keep their exact selection', () => {
  expect(readPreferences('{"id":"playground","dark":true}', false)).toEqual({ ...DEFAULT_PREFERENCES, mode: 'dark' });
  expect(readPreferences('{"id":"playground","dark":false}', true)).toEqual({ ...DEFAULT_PREFERENCES, mode: 'light' });
  expect(readPreferences('{"id":"playground"}', true).mode).toBe('dark');
  expect(readPreferences('{"id":"playground"}', false).mode).toBe('light');
  expect(readPreferences('{"id":"vesper","dark":false}', false)).toEqual({ version: 2, mode: 'dark', light: 'vitesse-light', dark: 'vesper' });
  expect(readPreferences('{"id":"snazzy-light","dark":true}', true)).toEqual({ version: 2, mode: 'light', light: 'snazzy-light', dark: 'vitesse-dark' });
});

test('every preset has unique identity and a valid theme in each category', () => {
  expect(new Set(THEME_PRESETS.map(preset => preset.id)).size).toBe(THEME_PRESETS.length);
  expect(new Set(THEME_PRESETS.map(preset => `${preset.light}/${preset.dark}`)).size).toBe(THEME_PRESETS.length);
  for (const preset of THEME_PRESETS) {
    expect(slotThemes('light').some(theme => theme.id === preset.light)).toBe(true);
    expect(slotThemes('dark').some(theme => theme.id === preset.dark)).toBe(true);
    expect(matchingPreset({ version: 2, mode: 'system', light: preset.light, dark: preset.dark })).toBe(preset);
  }
});

test('preset detection reflects both slots and does not overwrite a custom combination', () => {
  const preferences: ThemePreferences = { ...DEFAULT_PREFERENCES, light: 'github-light', dark: 'vitesse-dark' };
  expect(matchingPreset(preferences)).toBeUndefined();
  expect(preferences).toEqual({ version: 2, mode: 'system', light: 'github-light', dark: 'vitesse-dark' });
});

test('slot filtering includes every installed theme exactly once and supports normalized search', () => {
  const light = slotThemes('light');
  const dark = slotThemes('dark');
  expect(light.filter(theme => theme.id !== 'playground').every(theme => theme.type === 'light')).toBe(true);
  expect(dark.filter(theme => theme.id !== 'playground').every(theme => theme.type === 'dark')).toBe(true);
  expect(light.filter(theme => theme.id === 'playground')).toHaveLength(1);
  expect(dark.filter(theme => theme.id === 'playground')).toHaveLength(1);
  expect([...light, ...dark.filter(theme => theme.id !== 'playground')].map(theme => theme.id).sort()).toEqual(THEME_OPTIONS.map(theme => theme.id).sort());
  expect(slotThemes('light', 'rose pine dawn').map(theme => theme.id)).toEqual(['rose-pine-dawn']);
  expect(slotThemes('dark', 'rose pine dawn')).toEqual([]);
  expect(slotThemes('dark', 'VITESSE BLACK').map(theme => theme.id)).toEqual(['vitesse-black']);
});
