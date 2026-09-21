import { expect, test } from 'bun:test';
import { bundledThemes, bundledThemesInfo, type BundledTheme } from 'shiki/themes';
import { contrastRatio, themePalette } from './palette';

const CONTEXTS = ['titlebar', 'sidebar', 'panel', 'widget', 'menu'];
const PAIRS = [
  ['surface', 'fg'], ['surface-2', 'fg'], ['surface-3', 'hover-fg'], ['code', 'code-fg'], ['code-block', 'code-block-fg'], ['inline-code', 'inline-code-fg'], ['bubble', 'bubble-fg'],
  ['bubble', 'bubble-muted'], ['bubble', 'bubble-link'], ['status', 'status-fg'], ['secondary', 'secondary-fg'], ['secondary-hover', 'secondary-fg'], ['tab-active', 'tab-active-fg'],
  ['input-bg', 'input-fg'], ['input-bg', 'input-placeholder'], ['dropdown-bg', 'dropdown-fg'], ['accent', 'accent-fg'], ['accent-hover', 'accent-fg'],
  ['danger-bg', 'danger-fg'], ['danger-hover', 'danger-fg'], ['sidebar-selection', 'sidebar-selection-fg'],
];
const opaque = /^#[\da-f]{6}$/i;
const decoration = /^(?:transparent|#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8}))$/i;
const isDecoration = (key: string) => /(?:^|-)(?:border|divider|shadow)(?:-rest)?$/.test(key) || key === 'contrast' || key === 'contrast-active';

function readablePair(palette: Record<string, string>, background: string, foreground: string, minimum = 4.5) {
  expect(palette[background], background).toMatch(opaque);
  expect(palette[foreground], foreground).toMatch(opaque);
  expect(contrastRatio(palette[foreground], palette[background]), `${foreground} on ${background}`).toBeGreaterThanOrEqual(minimum);
}

function readableRoles(palette: Record<string, string>) {
  for (const [background, foreground] of PAIRS) readablePair(palette, background, foreground);
  for (const color of ['muted', 'link', 'danger', 'success', 'warn']) readablePair(palette, 'surface', color);
  for (const color of ['focus', ...Array.from({ length: 6 }, (_, index) => `series-${index + 1}`)]) readablePair(palette, 'surface', color, 3);
  readablePair(palette, 'input-bg', 'input-focus', 3); readablePair(palette, 'dropdown-bg', 'dropdown-focus', 3);
  for (const context of CONTEXTS) {
    readablePair(palette, `${context}-bg`, `${context}-fg`); readablePair(palette, `${context}-bg`, `${context}-muted`);
    readablePair(palette, `${context}-fill`, `${context}-fg`); readablePair(palette, `${context}-hover`, `${context}-hover-fg`);
    readablePair(palette, `${context}-bg`, `${context}-focus`, 3);
    for (const key of ['border', 'divider']) expect(palette[`${context}-${key}`], `${context}-${key}`).toMatch(decoration);
    if (context === 'menu' && !(`${context}-input-bg` in palette)) continue;
    readablePair(palette, `${context}-input-bg`, `${context}-input-fg`); readablePair(palette, `${context}-input-bg`, `${context}-input-placeholder`);
    readablePair(palette, `${context}-input-bg`, `${context}-input-focus`, 3); readablePair(palette, `${context}-dropdown-bg`, `${context}-dropdown-fg`);
    readablePair(palette, `${context}-dropdown-bg`, `${context}-dropdown-focus`, 3);
  }
}

for (const { id, type } of bundledThemesInfo) {
  test(`${id} keeps each UI role readable without flattening its surfaces`, async () => {
    const palette = themePalette((await bundledThemes[id as BundledTheme]()).default, type === 'dark');
    for (const [key, value] of Object.entries(palette)) expect(value, key).toMatch(isDecoration(key) ? decoration : opaque);
    readableRoles(palette);
    expect(palette['accent-hover']).not.toBe(palette.accent);
    expect(palette['danger-hover']).not.toBe(palette['danger-bg']);
  });
}

test('GitHub Light retains its white button label and green background', async () => {
  const theme = (await bundledThemes['github-light']()).default;
  const palette = themePalette(theme, false);
  expect(palette['accent-fg']).toBe('#ffffff');
  const [red, green, blue] = [1, 3, 5].map(index => Number.parseInt(palette.accent.slice(index, index + 2), 16));
  expect(green).toBeGreaterThan(red); expect(green).toBeGreaterThan(blue);
});

test('syntax keeps its editor background while Markdown code containers retain their own token', async () => {
  for (const [id, container, syntaxColor] of [
    ['nord', '#4c566a', '#81a1c1'], ['github-dark-default', '#343941', '#8b949e'], ['github-dark-dimmed', '#3c434d', '#f47067'], ['night-owl', '#4f4f4f', '#f78c6c'],
  ] as const) {
    const palette = themePalette((await bundledThemes[id]()).default, true);
    expect(palette.code).toBe(palette.surface); expect(palette['code-block']).toBe(container);
    // These original Shiki colors are readable in the editor but fail on textCodeBlock.background.
    expect(contrastRatio(syntaxColor, palette.code)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(syntaxColor, palette['code-block'])).toBeLessThan(4.5);
  }
});

test('light Slack Ochin preserves its dark sidebar and paired foreground', async () => {
  const palette = themePalette((await bundledThemes['slack-ochin']()).default, false);
  expect(palette.surface).toBe('#ffffff'); expect(palette['sidebar-bg']).toBe('#2d3e4c'); expect(palette['sidebar-fg']).toBe('#dcdedf');
  expect(contrastRatio(palette.fg, palette['sidebar-bg'])).toBeLessThan(4.5);
  readablePair(palette, 'sidebar-bg', 'sidebar-fg');
});

test('Nord keeps dark text on its light selection instead of reusing editor text', async () => {
  const palette = themePalette((await bundledThemes.nord()).default, true);
  expect(palette['menu-hover']).toBe('#88c0d0'); expect(palette['menu-hover-fg']).toBe('#2e3440');
  // The selected conversation remains an inactive list selection while focus is in the chat.
  expect(palette['sidebar-selection']).toBe('#434c5e'); expect(palette['sidebar-selection-fg']).toBe('#d8dee9');
  readablePair(palette, 'menu-hover', 'menu-hover-fg'); readablePair(palette, 'sidebar-selection', 'sidebar-selection-fg');
});

test('inactive sidebar selection inherits the sidebar foreground when only an active foreground exists', async () => {
  const palette = themePalette((await bundledThemes.vesper()).default, true);
  expect(palette['sidebar-selection']).toBe('#232323');
  expect(palette['sidebar-selection-fg']).toBe(palette['sidebar-fg']);
});

test('Catppuccin honors borderless sidebar and input tokens while keeping panel boundaries separate', async () => {
  const palette = themePalette((await bundledThemes['catppuccin-mocha']()).default, true);
  expect(palette.surface).toBe('#1e1e2e'); expect(palette['sidebar-bg']).toBe('#181825'); expect(palette['titlebar-bg']).toBe('#11111b');
  for (const key of ['sidebar-border', 'input-border']) expect(palette[key]).toMatch(/^(?:transparent|#0000(?:0000)?)$/);
  expect(palette['panel-border']).toBe('#585b70');
});

test('transparent role borders and shadows are not replaced by decorative fallbacks', async () => {
  const rose = themePalette((await bundledThemes['rose-pine']()).default, true);
  expect(rose['panel-border']).toMatch(/^(?:transparent|#0000(?:0000)?)$/);
  expect(rose['widget-fg']).not.toBe(rose.fg);
  const houston = themePalette((await bundledThemes.houston()).default, true);
  expect(houston['dropdown-border']).toMatch(/^(?:transparent|#0000(?:0000)?)$/);
  expect(houston["widget-shadow"]).toMatch(/^(?:transparent|#(?:[\da-f]{6}00|[\da-f]{3}0))$/i);
});

test('an explicitly transparent hover retains its background and can use its own foreground', async () => {
  for (const [id, dark] of [['everforest-dark', true], ['everforest-light', false]] as const) {
    const palette = themePalette((await bundledThemes[id]()).default, dark);
    expect(palette['sidebar-hover']).toBe(palette['sidebar-bg']);
    expect(palette['widget-hover']).toBe(palette['widget-bg']);
  }
});

test('role alpha colors composite over their own backgrounds', () => {
  const palette = themePalette({ colors: {
    'editor.background': '#101010', 'editor.foreground': '#fff', 'sideBar.background': '#f0f0f0', 'sideBar.foreground': '#000',
    'editorWidget.background': '#202020', 'editorWidget.foreground': '#fff', 'menu.background': '#303030', 'menu.foreground': '#fff',
    'list.hoverBackground': '#ffffff20', 'list.activeSelectionBackground': '#008000', 'list.activeSelectionForeground': '#fff', 'input.background': '#ffffff20', 'dropdown.background': '#ffffff20',
    'menu.selectionBackground': '#ffffff20', 'menu.selectionForeground': '#fff',
  } }, true);
  expect(palette['sidebar-hover']).toBe('#f2f2f2'); expect(palette['widget-hover']).toBe('#3c3c3c'); expect(palette['menu-hover']).toBe('#4a4a4a');
  expect(palette['sidebar-input-bg']).toBe('#f2f2f2'); expect(palette['widget-input-bg']).toBe('#3c3c3c');
  expect(palette['sidebar-dropdown-bg']).toBe('#f2f2f2'); expect(palette['widget-dropdown-bg']).toBe('#3c3c3c');
});

test('component borders preserve explicit values and use contrast borders only as a fallback', async () => {
  const vitesse = themePalette((await bundledThemes['vitesse-dark']()).default, true);
  expect(vitesse['input-border']).toBe('#191919'); expect(vitesse['input-bg']).toBe('#181818'); expect(vitesse['dropdown-border']).toBe('#191919');
  const custom = themePalette({ colors: { 'input.background': '#202020', 'input.border': '#ffffff20', 'dropdown.border': '#334455', contrastBorder: '#ffffff' } }, true);
  expect(custom['input-border']).toBe('#ffffff20'); expect(custom['dropdown-border']).toBe('#334455');
  const widget = themePalette({ colors: { 'editorWidget.border': '#ffffff20', 'widget.border': '#ff00ff' } }, true);
  expect(widget['widget-border']).toBe('#ffffff20');
  const catppuccin = themePalette((await bundledThemes['catppuccin-mocha']()).default, true);
  expect(catppuccin['secondary-border-rest']).not.toBe(catppuccin['secondary-border']);
  expect(catppuccin['dropdown-border-rest']).not.toBe(catppuccin['dropdown-border']);
  expect(contrastRatio(catppuccin['secondary-border-rest'], catppuccin.secondary)).toBeLessThan(contrastRatio(catppuccin['secondary-border'], catppuccin.secondary));
  expect(contrastRatio(catppuccin['dropdown-border-rest'], catppuccin['dropdown-bg'])).toBeLessThan(contrastRatio(catppuccin['dropdown-border'], catppuccin['dropdown-bg']));
  const contrast = themePalette({ colors: { contrastBorder: '#ffffff', contrastActiveBorder: '#ffff00' } }, true);
  expect(contrast.contrast).toBe('#ffffff'); expect(contrast['contrast-active']).toBe('#ffff00');
  expect(contrast['input-border']).toBe('#ffffff'); expect(contrast['dropdown-border']).toBe('#ffffff');
  const transparent = themePalette({ colors: { 'input.border': 'transparent', 'dropdown.border': '#0000', contrastBorder: '#ffffff' } }, true);
  expect(transparent['input-border']).toMatch(/^(?:transparent|#0000(?:0000)?)$/);
  expect(transparent['dropdown-border']).toMatch(/^(?:transparent|#0000(?:0000)?)$/);
});

test('contrast tokens never switch the palette to a different color mode', async () => {
  for (const id of ['night-owl', 'plastic'] as const) {
    const theme = (await bundledThemes[id]()).default;
    const withoutContrast = { ...theme, colors: { ...theme.colors } }; delete withoutContrast.colors.contrastBorder;
    const palette = themePalette(theme, true); const ordinary = themePalette(withoutContrast, true);
    for (const key of ['surface', 'fg', 'sidebar-bg', 'sidebar-fg', 'widget-bg', 'widget-fg']) expect(palette[key]).toBe(ordinary[key]);
  }
});

test('high contrast role pairs and focus stay readable across opposite backgrounds', () => {
  for (const [editor, ink, side, sideInk] of [['#000000', '#ffffff', '#ffffff', '#000000'], ['#ffffff', '#000000', '#000000', '#ffffff']]) {
    const palette = themePalette({ colors: {
      'editor.background': editor, 'editor.foreground': ink, 'sideBar.background': side, 'sideBar.foreground': sideInk,
      'editorWidget.background': side, 'editorWidget.foreground': sideInk, contrastBorder: '#ffff00', contrastActiveBorder: '#00ffff', focusBorder: '#ffff00',
    } }, editor === '#000000');
    expect(palette.surface).toBe(editor); expect(palette['sidebar-bg']).toBe(side); expect(palette['widget-bg']).toBe(side);
    expect(palette.contrast).toBe('#ffff00'); expect(palette['contrast-active']).toBe('#00ffff'); readableRoles(palette);
  }
});

test('missing or invalid editor tokens receive complete light and dark fallbacks', () => {
  for (const dark of [false, true]) {
    const empty = themePalette({}, dark);
    const invalid = themePalette({ colors: { 'editor.background': 'invalid', 'button.background': '' } }, dark);
    expect(invalid).toEqual(empty); expect(empty.surface).toBe(dark ? '#0e0e11' : '#ffffff'); readableRoles(empty);
  }
});

test('short hex and transparent editor backgrounds retain valid opaque content colors', () => {
  const palette = themePalette({ colors: { 'editor.background': '#fff0', 'editor.foreground': '#000', 'editorWidget.background': '#0001', 'list.hoverBackground': 'transparent', 'button.background': '#0008', 'button.foreground': '#fff' } }, false);
  expect(palette.surface).toBe('#ffffff'); expect(palette['widget-bg']).toBe('#eeeeee'); expect(palette['widget-hover']).toBe(palette['widget-bg']);
  expect(palette['accent-fg']).toBe('#ffffff'); readableRoles(palette);
});

test('bright danger text remains separate from the readable destructive button fill', () => {
  const palette = themePalette({ colors: { errorForeground: '#ff6b83' } }, true);
  expect(palette.danger).toBe('#ff6b83'); expect(palette['danger-bg']).not.toBe(palette.danger); expect(palette['danger-fg']).toBe('#ffffff');
  readablePair(palette, 'danger-bg', 'danger-fg');
});

test('mixed or absent tokens cannot bypass readability within their actual role', () => {
  const values = [undefined, 'invalid', 'transparent', '#0000', '#fff8', '#777', '#888', '#000', '#fff'];
  for (const background of values) for (const foreground of values) for (const secondary of values) {
    const palette = themePalette({ colors: { 'editor.background': background!, 'editor.foreground': foreground!, 'editorWidget.background': secondary!, 'list.hoverBackground': foreground!, 'button.foreground': foreground!, 'button.background': background! } }, false);
    readableRoles(palette);
  }
});

test('pure black and white button fills still receive a distinct hover color', () => {
  for (const [background, foreground] of [['#000', '#fff'], ['#fff', '#000']]) {
    const palette = themePalette({ colors: { 'button.background': background, 'button.foreground': foreground, 'button.hoverBackground': background } }, false);
    expect(palette['accent-hover']).not.toBe(palette.accent); readablePair(palette, 'accent-hover', 'accent-fg');
  }
});
