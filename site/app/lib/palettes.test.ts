import assert from 'node:assert/strict';
import test from 'node:test';
import { loadPalette, paletteFamily, palettes, paletteVariant, paletteVariables } from './palettes';
import { contrastRatio } from '../../../artifacts/src/web/theme/palette';

test('docs palette menu exposes only complete light and dark theme families', () => {
  assert.deepEqual(palettes.map(palette => palette.id), ['neutral', 'vitesse', 'github']);
  for (const palette of palettes) if (palette.id !== 'neutral') {
    assert.ok(palette.light.endsWith('-light'));
    assert.ok(palette.dark.endsWith('-dark'));
  }
});

test('docs palettes migrate legacy variant preferences and resolve the active appearance', () => {
  assert.equal(paletteFamily('vitesse-light'), 'vitesse');
  assert.equal(paletteFamily('github-dark'), 'github');
  assert.equal(paletteVariant('vitesse', 'light'), 'vitesse-light');
  assert.equal(paletteVariant('vitesse', 'dark'), 'vitesse-dark');
  assert.equal(paletteVariant('github', 'light'), 'github-light');
  assert.equal(paletteVariant('github', 'dark'), 'github-dark');
});

test('every docs theme keeps text, hover, selection, and focus readable on their owning surfaces', async () => {
  for (const id of ['github-light', 'github-dark', 'vitesse-light', 'vitesse-dark', 'nord'] as const) {
    const values = paletteVariables(await loadPalette(id));
    assert.ok(contrastRatio(values.background, values['sidebar-bg']) >= 1.14, `${id}: sidebar must be distinct without an outline`);
    assert.ok(contrastRatio(values['sidebar-selection'], values['sidebar-bg']) >= 1.14, `${id}: current page must remain distinct on the adjusted sidebar`);
    for (const [background, foreground] of [['background', 'foreground'], ['background', 'link'], ['muted', 'muted-foreground'], ['card', 'card-foreground'], ['primary', 'primary-foreground'], ['accent', 'accent-foreground'], ['sidebar-bg', 'sidebar-muted'], ['sidebar-hover', 'sidebar-hover-fg'], ['sidebar-selection', 'sidebar-selection-fg'], ['popover', 'popover-foreground'], ['menu-hover', 'menu-hover-fg'], ['code', 'code-fg'], ['inline-code', 'inline-code-fg']]) {
      assert.ok(contrastRatio(values[background], values[foreground]) >= 4.5, `${id}: ${foreground} on ${background}`);
    }
    for (const [background, focus] of [['background', 'ring'], ['sidebar-bg', 'sidebar-focus'], ['popover', 'menu-focus']]) assert.ok(contrastRatio(values[background], values[focus]) >= 3, `${id}: ${focus}`);
  }
});

test('GitHub keeps blue content links separate from green buttons and preserves native button labels', async () => {
  for (const id of ['github-light', 'github-dark'] as const) {
    const theme = await loadPalette(id), values = paletteVariables(theme);
    assert.ok(theme.colors);
    assert.equal(values.link, theme.colors['textLink.foreground']);
    assert.notEqual(values.primary, values.link);
    assert.equal(values['primary-foreground'], id === 'github-light' ? '#ffffff' : theme.colors['button.foreground']);
  }
});
