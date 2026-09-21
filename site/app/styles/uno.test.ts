import assert from 'node:assert/strict';
import { glob, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { createGenerator } from 'unocss';
import config from '../../uno.config';
import { withoutVendorReset } from './fumadocs-compat';
import { loadPalette, paletteVariables, readableText } from '../lib/palettes';

test('Wind4 owns site utilities and preserves keyboard rings, shadows and responsive sizes', async () => {
  const uno = await createGenerator(config);
  const result = await uno.generate('site:p-4 site:focus-visible:ring-2 site:focus-visible:ring-fd-ring site:shadow-lg site:sm:text-5xl site:hovered:bg-fd-accent p-4');
  assert.ok(result.matched.has('site:p-4'));
  assert.ok(!result.matched.has('p-4'));
  for (const name of ['site:focus-visible:ring-2', 'site:focus-visible:ring-fd-ring', 'site:shadow-lg', 'site:sm:text-5xl', 'site:hovered:bg-fd-accent']) assert.ok(result.matched.has(name), name);
  assert.match(result.css, /--un-ring-color/);
  assert.match(result.css, /box-shadow/);
});

test('every extracted local utility has a Wind4 rule', async () => {
  const uno = await createGenerator(config), tokens = new Set<string>();
  for await (const path of glob('app/**/*.tsx')) await uno.applyExtractors(await readFile(path, 'utf8'), path, tokens);
  assert.ok(tokens.size > 100);
  for (const token of tokens) assert.ok(await uno.parseToken(token), `Unsupported local utility: ${token}`);
});

test('vendor compatibility retains Fumadocs components and removes its sole reset', async () => {
  const css = await readFile(createRequire(import.meta.url).resolve('fumadocs-ui/style.css'), 'utf8');
  const converted = withoutVendorReset(css);
  assert.ok(converted.length < css.length);
  assert.equal((converted.match(/box-sizing: border-box/g) ?? []).length, (css.match(/box-sizing: border-box/g) ?? []).length - 1);
  assert.match(converted, /\.prose/);
  assert.match(converted, /\.fd-steps/);
  assert.match(converted, /--tw-ring-shadow/);
});

test('Shiki palettes carry readable controls and complete Fumadocs surface tokens', async () => {
  const palette = paletteVariables(await loadPalette('github-light'));
  assert.equal(palette.background, '#ffffff');
  assert.equal(palette['primary-foreground'], '#ffffff');
  for (const key of ['foreground', 'muted-foreground', 'border', 'ring', 'popover', 'accent']) assert.ok(palette[key]);
  assert.equal(readableText('#159739', '#ffffff'), '#000000');
});
