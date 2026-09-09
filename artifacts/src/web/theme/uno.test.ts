import { expect, test } from 'bun:test';
import { createGenerator } from '@unocss/core';
import { readFile } from 'node:fs/promises';
import { unoConfig } from './uno';

test('Wind4 owns the shell reset and scoped surfaces inherit it', async () => {
  const shell = await createGenerator(unoConfig());
  expect((await shell.generate('outline-none ring-2')).getLayer('base')).toMatch(/box-sizing:\s*border-box/);
  const surface = await createGenerator(unoConfig('.ui4a-surface'));
  const result = await surface.generate('outline-none ring-2 animate-in fade-in');
  expect(result.getLayer('base')).toBe('');
  for (const token of ['outline-none', 'ring-2', 'animate-in', 'fade-in']) expect(result.css).toContain(`.ui4a-surface :is(.${token})`);
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
