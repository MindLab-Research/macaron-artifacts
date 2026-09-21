import { expect, test } from 'bun:test';
import { themeNames } from '@shikijs/themes';
import { createHighlighterCore } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { contrastRatio, themePalette } from './palette';
import { filterThemes, THEME_OPTIONS, highlighter, loadTheme, oppositeTheme, themeAppearance } from './themes';

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

test('real TSX tokens stay readable in every theme without changing cached themes or already readable colors', async () => {
  const source = '// status comment\nexport function Demo({ count }: { count: number }) {\n  const message = `Total: ${count}`;\n  return <button title={message} disabled={false}>{count + 42}</button>;\n}';
  const baseline = await createHighlighterCore({ langs: [], themes: [], engine: createJavaScriptRegexEngine() });
  await baseline.loadLanguage((await import('@shikijs/langs/tsx')).default);
  try {
    for (const id of themeNames) {
      const original = await loadTheme(id), snapshot = structuredClone(original), palette = themePalette(original, original.type === 'dark');
      // A separate engine proves the production highlighter changes only insufficient syntax contrast.
      await baseline.loadTheme(structuredClone(original));
      const native = baseline.codeToTokens(source, { lang: 'tsx', theme: id });
      const rendered = (await highlighter('tsx', id)).codeToTokens(source, { lang: 'tsx', theme: id });
      const characters = (tokens: typeof native.tokens, fallback: string) => tokens.flat().flatMap(token => [...token.content].map(text => ({ text, color: (token.color ?? fallback).toLowerCase(), style: token.fontStyle ?? 0 })));
      const before = characters(native.tokens, native.fg ?? palette['code-fg']), after = characters(rendered.tokens, rendered.fg ?? palette['code-fg']);
      expect(after.map(token => token.text).join(''), id).toBe(before.map(token => token.text).join(''));
      let preserved = 0, corrected = 0;
      for (const [index, token] of after.entries()) {
        expect(token.style, `${id}: ${token.text} font style`).toBe(before[index].style);
        if (!token.text.trim()) continue;
        expect(contrastRatio(token.color, palette.code), `${id}: ${token.text}`).toBeGreaterThanOrEqual(4.5);
        const previous = before[index].color;
        // Alpha colors may be flattened while retaining their rendered color; opaque colors need no such conversion.
        if (/^#[\da-f]{6}$/i.test(previous) && contrastRatio(previous, palette.code) >= 4.5) { expect(token.color, `${id}: readable ${token.text}`).toBe(previous); preserved++; }
        else if (previous !== token.color) corrected++;
      }
      if (id === 'nord' || id === 'slack-ochin') { expect(corrected, id).toBeGreaterThan(0); expect(preserved, id).toBeGreaterThan(0); }
      expect(await loadTheme(id), `${id}: original tokens and UI colors`).toEqual(snapshot);
      expect(themePalette(await loadTheme(id), original.type === 'dark'), `${id}: UI palette`).toEqual(palette);
    }
  } finally { baseline.dispose(); }
});
