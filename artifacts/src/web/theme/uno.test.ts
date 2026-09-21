import { expect, test } from 'bun:test';
import { createGenerator } from '@unocss/core';
import { readFile } from 'node:fs/promises';
import { unoConfig } from './uno';
import { themePalette } from './palette';

test('Wind4 owns the shell reset and scoped surfaces inherit it', async () => {
  const shell = await createGenerator(unoConfig());
  expect((await shell.generate('outline-none ring-2')).getLayer('base')).toMatch(/box-sizing:\s*border-box/);
  const surface = await createGenerator(unoConfig('.ui4a-surface'));
  const result = await surface.generate('outline-none ring-2 animate-in fade-in');
  expect(result.getLayer('base')).toBe('');
  for (const token of ['outline-none', 'ring-2', 'animate-in', 'fade-in']) expect(result.css).toContain(`.ui4a-surface :is(.${token})`);
});

test.each([['shell', undefined], ['UI4A', '.ui4a-surface']] as const)('%s theme variants follow the data-theme attribute', async (_, scope) => {
  const generator = await createGenerator(unoConfig(scope));
  const { css, matched } = await generator.generate('dark:bg-accent light:bg-surface dark:hover:text-accent-fg', { preflights: false });
  expect(matched.size).toBe(3);
  for (const selector of ['[data-theme="dark"] .dark\\:bg-accent', '[data-theme="light"] .light\\:bg-surface', '[data-theme="dark"] .dark\\:hover\\:text-accent-fg:hover']) {
    expect(css).toContain(scope ? `${scope} :is(${selector})` : selector);
  }
  expect(css).not.toMatch(/(?:\.dark|\.light)\s+\./);
  expect(css).not.toContain('prefers-color-scheme');
});

test('late streaming utilities include their Wind4 theme and ring dependencies', async () => {
  const surface = await createGenerator(unoConfig('.ui4a-surface'));
  await surface.generate('p-2');
  const result = await surface.generate('bg-rose-700 text-7xl ring-2 ring-rose-700 shadow-xl');
  const preflights = result.getLayers(['properties', 'theme']);
  expect(preflights).toContain('--colors-rose-700:');
  expect(preflights).toContain('--text-7xl-fontSize:');
  expect(preflights).toContain('--un-ring-offset-width');
  expect(result.getLayers(undefined, ['properties', 'theme'])).not.toMatch(/box-sizing:\s*border-box/);
});

test('workbench color contexts and their interactive states stay scoped in generated UI', async () => {
  const generator = await createGenerator(unoConfig('.ui4a-surface'));
  const tokens = ['theme-sidebar', 'theme-titlebar', 'theme-widget', 'theme-menu', 'theme-panel', 'theme-code', 'bg-sidebar-selection', 'text-sidebar-selection-fg', 'border-secondary-border-rest', 'border-dropdown-border-rest', 'data-[focus]:text-hover-fg', 'focus:border-input-focus'];
  const { css, matched } = await generator.generate(tokens.join(' '), { preflights: false });
  for (const token of tokens) expect(matched.has(token)).toBe(true);
  for (const role of ['sidebar', 'titlebar', 'widget', 'menu', 'panel', 'code']) expect(css).toContain(`.ui4a-surface :is(.theme-${role})`);
  expect(css).toContain('--input-bg:var(--widget-input-bg)');
  expect(css).toContain('--hover-fg:var(--menu-hover-fg)');
  for (const role of ['sidebar', 'titlebar', 'widget', 'menu', 'panel']) expect(css).toContain(`--dropdown-border-rest:var(--${role}-dropdown-border-rest)`);
});

test('Playground defines every palette token cleared when leaving a native theme', async () => {
  const css = await readFile(new URL('./tokens.css', import.meta.url), 'utf8');
  const defaults = new Set([...css.matchAll(/--([\w-]+)\s*:/g)].map(match => match[1]));
  // applyTheme keeps success/warn inline; every other token must survive their removal.
  for (const key of Object.keys(themePalette({ name: 'fallback', type: 'light', colors: {} }, false))) {
    if (!['success', 'warn'].includes(key)) expect(defaults.has(key), key).toBe(true);
  }
});

test('Headless UI form states compile into Wind4 utilities', async () => {
  const generator = await createGenerator(unoConfig());
  for (const file of ['NewSessionDialog.tsx', 'Select.tsx', 'Sidebar.tsx', 'ThemePicker.tsx', 'ui4a-ui.tsx']) {
    const source = await readFile(new URL(`../components/${file}`, import.meta.url), 'utf8');
    const tokens = [...source.matchAll(/\bdata-(?:\[[\w-]+\]|[\w-]+):(?:[\w-]+:)*[\w-]+/g)].map(match => match[0]);
    expect(tokens.length).toBeGreaterThan(0);
    const { matched } = await generator.generate(tokens.join(' '));
    for (const token of tokens) expect(matched.has(token)).toBe(true);
  }
});

test('selected hover preserves the accent pair and compiles its higher-specificity selector', async () => {
  const generator = await createGenerator(unoConfig());
  const token = 'data-[checked]:hover:bg-accent-hover';
  const output = await generator.generate(token, { preflights: false });
  expect(output.matched.has(token)).toBe(true);
  expect(output.css).toContain(':hover[data-checked]');
  expect(output.css).toContain('var(--accent-hover, var(--accent))');
});
