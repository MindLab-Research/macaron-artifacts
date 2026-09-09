import { expect, test } from 'bun:test';
import { themeNames } from '@shikijs/themes';
import { filterThemes, THEME_OPTIONS, loadTheme, oppositeTheme, themeAppearance } from './themes';

test('every installed Shiki theme is selectable and loads by its stable id', async () => {
  expect(THEME_OPTIONS.filter(theme => theme.id !== 'playground').map(theme => String(theme.id)).sort()).toEqual([...themeNames].sort());
  for (const option of THEME_OPTIONS) {
    const appearance = themeAppearance(option.id, false, 0);
    const theme = await loadTheme(appearance.syntax);
    expect(theme.name).toBe(appearance.syntax);
    if (option.id !== 'playground') expect(appearance.dark).toBe(theme.type === 'dark');
  }
});

test('mode follows theme metadata rather than the spelling of its name', () => {
  expect(themeAppearance('catppuccin-latte', true, 0).dark).toBe(false);
  expect(themeAppearance('rose-pine-dawn', true, 0).dark).toBe(false);
  expect(themeAppearance('vesper', false, 0).dark).toBe(true);
  expect(themeAppearance('playground', true, 1)).toEqual({ id: 'playground', dark: true, syntax: 'vitesse-dark', revision: 1 });
});

test('unknown theme ids fail explicitly without poisoning other theme loads', async () => {
  await expect(loadTheme('missing-theme')).rejects.toThrow('Unknown Shiki theme');
  expect((await loadTheme('github-light')).type).toBe('light');
});

test('named light variants switch within their theme family', () => {
  expect(oppositeTheme('catppuccin-latte', true)).toBe('catppuccin-mocha');
  expect(oppositeTheme('catppuccin-macchiato', false)).toBe('catppuccin-latte');
  expect(oppositeTheme('rose-pine', false)).toBe('rose-pine-dawn');
  expect(oppositeTheme('github-dark-high-contrast', false)).toBe('github-light-high-contrast');
  expect(oppositeTheme('horizon-bright', true)).toBe('horizon');
});

test('search accepts unaccented names and spaced theme ids', () => {
  expect(filterThemes('rose pine dawn').map(theme => theme.id)).toEqual(['rose-pine-dawn']);
  expect(filterThemes('CATPPUCCIN FRAPPE').map(theme => theme.id)).toEqual(['catppuccin-frappe']);
  expect(filterThemes('no-such-theme')).toEqual([]);
});
