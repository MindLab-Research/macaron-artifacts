import { expect, test } from 'bun:test';
import { bundledThemes, bundledThemesInfo, type BundledTheme } from 'shiki/themes';
import { contrastRatio, themePalette } from './palette';

for (const { id, type } of bundledThemesInfo) {
  test(`${id} has complete opaque tokens and readable UI states`, async () => {
    const theme = (await bundledThemes[id as BundledTheme]()).default;
    const palette = themePalette(theme, type === 'dark');
    expect(Object.keys(palette)).toHaveLength(31);
    for (const value of Object.values(palette)) expect(value).toMatch(/^#[\da-f]{6}$/);
    for (const background of ['surface', 'surface-2', 'surface-3']) {
      for (const color of ['fg', 'muted', 'link', 'danger', 'success', 'warn']) expect(contrastRatio(palette[color], palette[background])).toBeGreaterThanOrEqual(4.5);
      for (const color of ['focus', ...Array.from({ length: 6 }, (_, index) => `series-${index + 1}`)]) expect(contrastRatio(palette[color], palette[background])).toBeGreaterThanOrEqual(3);
    }
    expect(contrastRatio(palette['input-fg'], palette['input-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette['input-placeholder'], palette['input-bg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette['dropdown-fg'], palette['dropdown-bg'])).toBeGreaterThanOrEqual(4.5);
    for (const background of ['input-bg', 'dropdown-bg']) expect(contrastRatio(palette.focus, palette[background])).toBeGreaterThanOrEqual(3);
    expect(contrastRatio(palette.accent, palette['accent-fg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette['accent-hover'], palette['accent-fg'])).toBeGreaterThanOrEqual(4.5);
    expect(palette['accent-hover']).not.toBe(palette.accent);
    expect(contrastRatio(palette['danger-bg'], palette['danger-fg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette['danger-hover'], palette['danger-fg'])).toBeGreaterThanOrEqual(4.5);
    expect(palette['danger-hover']).not.toBe(palette['danger-bg']);
    expect(palette['surface-3']).not.toBe(palette.surface);
    expect(palette['surface-3']).not.toBe(palette['surface-2']);
  });
}

test('GitHub Light retains its white button label and green background', async () => {
  const theme = (await bundledThemes['github-light']()).default;
  const palette = themePalette(theme, false);
  expect(palette['accent-fg']).toBe('#ffffff');
  expect(palette.accent).not.toBe(theme.colors!['button.background']);
  const [red, green, blue] = [1, 3, 5].map(index => Number.parseInt(palette.accent.slice(index, index + 2), 16));
  expect(green).toBeGreaterThan(red);
  expect(green).toBeGreaterThan(blue);
});

test('component borders preserve their theme values independently of focus and contrast colors', async () => {
  const vitesse = themePalette((await bundledThemes['vitesse-dark']()).default, true);
  expect(vitesse['input-border']).toBe('#191919');
  expect(vitesse['input-bg']).toBe('#181818');
  expect(vitesse['dropdown-border']).toBe('#191919');
  const ayu = themePalette((await bundledThemes['ayu-dark']()).default, true);
  expect(contrastRatio(ayu['input-border'], ayu['input-bg'])).toBeLessThan(1.5);
  const custom = themePalette({ colors: { 'input.background': '#202020', 'input.border': '#ffffff20', 'dropdown.border': '#334455', contrastBorder: '#ffffff' } }, true);
  expect(custom['input-border']).toBe('#3c3c3c');
  expect(custom['dropdown-border']).toBe('#334455');
  const absent = themePalette({ colors: { contrastBorder: '#ffffff' } }, true);
  expect(absent['input-border']).toBe(absent['input-bg']);
});

test('missing or invalid editor tokens receive complete light and dark fallbacks', () => {
  for (const dark of [false, true]) {
    const empty = themePalette({}, dark);
    const invalid = themePalette({ colors: { 'editor.background': 'invalid', 'button.background': '' } }, dark);
    expect(invalid).toEqual(empty);
    expect(empty.surface).toBe(dark ? '#0e0e11' : '#ffffff');
    expect(contrastRatio(empty.fg, empty.surface)).toBeGreaterThanOrEqual(4.5);
  }
});

test('short hex, alpha and transparent backgrounds are composited before contrast correction', () => {
  const palette = themePalette({ colors: { 'editor.background': '#fff0', 'editor.foreground': '#000', 'editorWidget.background': '#0001', 'list.hoverBackground': 'transparent', 'button.background': '#0008', 'button.foreground': '#fff' } }, false);
  expect(palette.surface).toBe('#ffffff');
  expect(palette['surface-2']).toBe('#eeeeee');
  expect(palette['surface-3']).not.toBe(palette['surface-2']);
  expect(palette['accent-fg']).toBe('#ffffff');
  for (const value of Object.values(palette)) expect(value).toMatch(/^#[\da-f]{6}$/);
});

test('bright danger text remains separate from the readable destructive button fill', () => {
  const palette = themePalette({ colors: { errorForeground: '#ff6b83' } }, true);
  expect(palette.danger).toBe('#ff6b83');
  expect(palette['danger-bg']).not.toBe(palette.danger);
  expect(palette['danger-fg']).toBe('#ffffff');
  expect(contrastRatio(palette['danger-bg'], palette['danger-fg'])).toBeGreaterThanOrEqual(4.5);
});

test('mixed or absent surface and foreground tokens cannot bypass readability fallbacks', () => {
  const values = [undefined, 'invalid', 'transparent', '#0000', '#fff8', '#777', '#888', '#000', '#fff'];
  for (const background of values) for (const foreground of values) for (const secondary of values) {
    const palette = themePalette({ colors: { 'editor.background': background!, 'editor.foreground': foreground!, 'editorWidget.background': secondary!, 'list.hoverBackground': foreground!, 'button.foreground': foreground!, 'button.background': background! } }, false);
    for (const surface of ['surface', 'surface-2', 'surface-3']) for (const color of ['fg', 'muted', 'link', 'danger']) expect(contrastRatio(palette[color], palette[surface])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette.accent, palette['accent-fg'])).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(palette['accent-hover'], palette['accent-fg'])).toBeGreaterThanOrEqual(4.5);
  }
});

test('pure black and white button fills still receive a distinct hover color', () => {
  for (const [background, foreground] of [['#000', '#fff'], ['#fff', '#000']]) {
    const palette = themePalette({ colors: { 'button.background': background, 'button.foreground': foreground, 'button.hoverBackground': background } }, false);
    expect(palette['accent-hover']).not.toBe(palette.accent);
    expect(contrastRatio(palette['accent-hover'], palette['accent-fg'])).toBeGreaterThanOrEqual(4.5);
  }
});
