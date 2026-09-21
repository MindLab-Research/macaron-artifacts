import type { ThemeRegistration } from 'shiki/core';

type Color = { rgb: number[]; alpha: number };
const BLACK = '#000000';
const WHITE = '#ffffff';
const hex = (rgb: number[]) => `#${rgb.map(channel => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;

function parseColor(value: unknown): Color | undefined {
  if (value === 'transparent') return { rgb: [0, 0, 0], alpha: 0 };
  if (typeof value !== 'string' || !/^#(?:[\da-f]{3,4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)) return;
  const digits = value.slice(1);
  const full = digits.length <= 4 ? [...digits].map(channel => channel + channel).join('') : digits;
  return { rgb: [0, 2, 4].map(index => Number.parseInt(full.slice(index, index + 2), 16)), alpha: full.length === 8 ? Number.parseInt(full.slice(6), 16) / 255 : 1 };
}

/** Flatten alpha against the actual owning surface before measuring text contrast. */
function composite(value: unknown, background: string): string {
  const color = parseColor(value);
  if (!color) return background;
  const back = parseColor(background)!.rgb;
  return hex(color.rgb.map((channel, index) => channel * color.alpha + back[index] * (1 - color.alpha)));
}

function mix(color: string, target: string, amount: number): string {
  const start = parseColor(color)!.rgb;
  const end = parseColor(target)!.rgb;
  return hex(start.map((channel, index) => channel + (end[index] - channel) * amount));
}

/** Resting controls follow VS Code's quiet 15% secondary border; focus and HC keep the native token. */
function restingBorder(value: unknown, background: string, amount = .18): string {
  const color = parseColor(value);
  return color?.alpha === 0 ? 'transparent' : color ? mix(background, composite(value, background), amount) : 'transparent';
}

function luminance(color: string): number {
  const linear = parseColor(color)!.rgb.map(channel => channel / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return linear[0] * .2126 + linear[1] * .7152 + linear[2] * .0722;
}

export function contrastRatio(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
}

function minimumContrast(color: string, backgrounds: string[]): number {
  return Math.min(...backgrounds.map(background => contrastRatio(color, background)));
}

function adjustToward(color: string, target: string, valid: (value: string) => boolean): { color: string; amount: number } {
  if (valid(color)) return { color, amount: 0 };
  let low = 0;
  let high = 1;
  for (let step = 0; step < 16; step++) {
    const middle = (low + high) / 2;
    if (valid(mix(color, target, middle))) high = middle; else low = middle;
  }
  return { color: mix(color, target, high), amount: high };
}

function readable(color: string, backgrounds: string[], minimum = 4.5, fallback = BLACK): string {
  const valid = (value: string) => minimumContrast(value, backgrounds) >= minimum;
  if (valid(color)) return color;
  const candidates = [BLACK, WHITE, fallback].filter(valid).map(target => adjustToward(color, target, valid));
  return candidates.sort((a, b) => a.amount - b.amount)[0]?.color ?? fallback;
}

function buttonHover(background: string, foreground: string, proposed = mix(background, foreground, .08)): string {
  const hover = readable(proposed, [foreground]);
  if (hover !== background) return hover;
  const stronger = mix(background, luminance(background) < luminance(foreground) ? BLACK : WHITE, .12);
  return stronger !== background ? stronger : readable(mix(background, foreground, .08), [foreground]);
}

export function readableSyntaxTheme(theme: ThemeRegistration): ThemeRegistration {
  const background = themePalette(theme, theme.type === 'dark').code;
  const adjusted = new Map<string, string>();
  const color = (value: string | undefined) => {
    if (!value || !parseColor(value)) return value;
    if (!adjusted.has(value)) adjusted.set(value, readable(composite(value, background), [background]));
    return adjusted.get(value)!;
  };
  // Keep scopes and hues; only raise insufficient text contrast. The cached native theme remains untouched for UI tokens and previews.
  const settings = (items: ThemeRegistration['tokenColors']) => items?.map(item => ({ ...item, settings: { ...item.settings, ...(item.settings?.foreground ? { foreground: color(item.settings.foreground) } : {}) } }));
  return { ...theme, fg: color(theme.fg), colors: { ...theme.colors, ...(theme.colors?.['editor.foreground'] ? { 'editor.foreground': color(theme.colors['editor.foreground'])! } : {}) }, tokenColors: settings(theme.tokenColors), ...(theme.settings ? { settings: settings(theme.settings) } : {}) };
}

export function themePalette(theme: ThemeRegistration, dark: boolean): Record<string, string> {
  const colors = theme.colors ?? {};
  // Themes contain invalid and explicitly transparent values; only absence should invoke a fallback.
  const pick = (...values: unknown[]) => values.find(value => parseColor(value)) as string | undefined;
  const decoration = (...values: unknown[]) => (pick(...values) ?? 'transparent').toLowerCase();
  const surface = composite(pick(colors['editor.background'], theme.bg), dark ? '#0e0e11' : WHITE);
  const baseFg = readable(composite(pick(colors['editor.foreground'], theme.fg, colors.foreground, dark ? '#f2f2f5' : '#16161a'), surface), [surface]);
  const softFill = (background: string, ink: string) => adjustToward(mix(background, ink, .035), background, candidate => contrastRatio(ink, candidate) >= 4.5).color;
  const surface2 = softFill(surface, baseFg);
  const fg = readable(baseFg, [surface, surface2]);
  const foreground = (value: unknown, minimum = 4.5) => readable(composite(value, surface), [surface, surface2], minimum, fg);
  const muted = foreground(pick(colors.descriptionForeground, mix(surface, fg, .66)));
  const contrast = decoration(colors.contrastBorder), contrastActive = decoration(colors.contrastActiveBorder, colors.contrastBorder);
  const focus = (background: string, ink: string) => readable(composite(pick(colors.focusBorder, colors.contrastActiveBorder, colors['textLink.foreground'], ink), background), [background], 3, ink);
  const pair = (background: unknown, ink: unknown, parent = surface, fallback = fg) => {
    const bg = composite(background, parent);
    return { bg, fg: readable(composite(pick(ink, fallback), bg), [bg], 4.5, fallback) };
  };
  const inputColors = (background: string, ink: string) => {
    const input = pair(pick(colors['input.background'], mix(background, ink, .06)), colors['input.foreground'], background, ink);
    const dropdown = pair(pick(colors['dropdown.background'], input.bg), colors['dropdown.foreground'], background, input.fg);
    const explicitDropdownBorder = pick(colors['dropdown.border']);
    const dropdownBorder = decoration(explicitDropdownBorder, colors.contrastBorder, luminance(dropdown.bg) > .5 ? mix(dropdown.bg, dropdown.fg, .15) : 'transparent');
    return {
      'input-bg': input.bg, 'input-fg': input.fg, 'input-border': decoration(colors['input.border'], colors.contrastBorder),
      'input-placeholder': readable(composite(pick(colors['input.placeholderForeground'], mix(input.bg, input.fg, .66)), input.bg), [input.bg]), 'input-focus': focus(input.bg, input.fg),
      'dropdown-bg': dropdown.bg, 'dropdown-fg': dropdown.fg,
      'dropdown-border': dropdownBorder, 'dropdown-border-rest': explicitDropdownBorder ? restingBorder(explicitDropdownBorder, dropdown.bg) : dropdownBorder, 'dropdown-focus': focus(dropdown.bg, dropdown.fg),
    };
  };
  const hover = pair(pick(colors['list.hoverBackground'], mix(surface, fg, .06)), colors['list.hoverForeground']);
  let accent = composite(pick(colors['button.background'], colors['textLink.foreground'], fg), surface);
  const defaultLabel = contrastRatio(accent, fg) > contrastRatio(accent, surface) ? fg : surface;
  const accentFg = composite(pick(colors['button.foreground'], defaultLabel), accent);
  // Keep the intended button label (notably GitHub's white); correct the fill if needed.
  accent = readable(accent, [accentFg]);
  const accentHover = buttonHover(accent, accentFg, composite(pick(colors['button.hoverBackground'], mix(accent, accentFg, .08)), surface));
  const secondary = pair(pick(colors['button.secondaryBackground'], mix(surface, fg, .09)), colors['button.secondaryForeground']);
  const explicitSecondaryBorder = pick(colors['button.secondaryBorder'], colors['button.border']);
  const secondaryHover = readable(composite(pick(colors['button.secondaryHoverBackground'], mix(secondary.bg, secondary.fg, .08)), surface), [secondary.fg]);
  // Shiki's syntax colors target editor.background. Markdown's code container can have its own fill without repainting that syntax plane.
  const code = pair(surface, fg), codeBlock = pair(pick(colors['textCodeBlock.background'], surface2), fg);
  const inlineCode = pair(pick(colors['textPreformat.background'], mix(surface, fg, .075)), colors['textPreformat.foreground']);
  const bubble = pair(pick(colors['chat.requestBubbleBackground'], mix(surface, fg, .07)), fg);
  const status = pair(pick(colors['chat.statusBackground'], mix(surface, fg, .07)), fg);
  const tab = pair(pick(colors['tab.activeBackground'], surface), colors['tab.activeForeground']);
  const danger = foreground(pick(colors.errorForeground, colors['editorError.foreground'], colors['terminal.ansiRed'], dark ? '#ff6b83' : '#d9435f'));
  const dangerBg = readable(danger, [WHITE]);
  const palette: Record<string, string> = {
    surface, 'surface-2': surface2, 'surface-3': hover.bg, 'hover-fg': hover.fg, fg, muted,
    // panel.border is a structural pane boundary, not a universal outline for every card and row.
    border: decoration(colors.contrastBorder, mix(surface, fg, .12)), contrast, 'contrast-active': contrastActive,
    'control-border': decoration(colors['radio.inactiveBorder'], colors['button.secondaryBorder'], colors.contrastBorder, mix(surface, fg, .15)),
    ...inputColors(surface, fg),
    accent, 'accent-fg': accentFg, 'accent-hover': accentHover,
    secondary: secondary.bg, 'secondary-fg': secondary.fg, 'secondary-hover': secondaryHover, 'secondary-border': decoration(explicitSecondaryBorder, colors.contrastBorder), 'secondary-border-rest': explicitSecondaryBorder ? restingBorder(explicitSecondaryBorder, secondary.bg) : decoration(colors.contrastBorder),
    code: code.bg, 'code-fg': code.fg, 'code-muted': readable(composite(muted, code.bg), [code.bg]), 'code-focus': focus(code.bg, code.fg), 'code-block': codeBlock.bg, 'code-block-fg': codeBlock.fg,
    'inline-code': inlineCode.bg, 'inline-code-fg': inlineCode.fg, bubble: bubble.bg, 'bubble-fg': bubble.fg,
    'bubble-muted': readable(composite(muted, bubble.bg), [bubble.bg]), 'bubble-link': readable(composite(pick(colors['textLink.foreground'], accent), bubble.bg), [bubble.bg]), 'bubble-focus': focus(bubble.bg, bubble.fg),
    status: status.bg, 'status-fg': status.fg,
    'tab-active': tab.bg, 'tab-active-fg': tab.fg,
    link: foreground(pick(colors['textLink.foreground'], colors['textLink.activeForeground'], accent)), focus: focus(surface, fg),
    danger, 'danger-bg': dangerBg, 'danger-fg': WHITE, 'danger-hover': buttonHover(dangerBg, WHITE),
    success: foreground(pick(colors['gitDecoration.addedResourceForeground'], colors['terminal.ansiGreen'], dark ? '#34d399' : '#15803d')),
    warn: foreground(pick(colors['editorWarning.foreground'], colors['terminal.ansiYellow'], dark ? '#fbbf24' : '#a16207')),
    // Shadows keep their alpha; compositing them into editor.background would paint an opaque fringe.
    'widget-shadow': decoration(colors['widget.shadow'], dark ? '#0000005c' : '#00000029'),
  };
  const contexts = {
    sidebar: { background: pick(colors['sideBar.background'], surface2), foreground: pick(colors['sideBar.foreground'], colors.foreground, fg), border: colors['sideBar.border'] },
    titlebar: { background: pick(colors['titleBar.activeBackground'], surface), foreground: pick(colors['titleBar.activeForeground'], colors.foreground, fg), border: colors['titleBar.border'] },
    panel: { background: pick(colors['panel.background'], surface), foreground: pick(colors['panel.foreground'], fg), border: pick(colors['panel.border'], colors['editorGroup.border'], palette.border) },
    // Editor widgets (dialogs, command surfaces) use their dedicated 20% border token; widget.border is an explicit fallback for themes that define it.
    widget: { background: pick(colors['editorWidget.background'], surface2), foreground: pick(colors['editorWidget.foreground'], colors.foreground, fg), border: pick(colors['editorWidget.border'], colors['widget.border']) },
    menu: { background: pick(colors['menu.background'], colors['dropdown.background'], colors['editorWidget.background'], surface2), foreground: pick(colors['menu.foreground'], colors['dropdown.foreground'], colors.foreground, fg), border: colors['menu.border'] },
  };
  for (const [name, values] of Object.entries(contexts)) {
    const role = pair(values.background, values.foreground);
    const fill = softFill(role.bg, role.fg), ink = role.fg;
    const selection = name === 'menu';
    const hovered = pair(selection ? pick(colors['menu.selectionBackground'], colors['list.activeSelectionBackground'], mix(role.bg, ink, .08)) : pick(name === 'titlebar' ? colors['toolbar.hoverBackground'] : undefined, colors['list.hoverBackground'], mix(role.bg, ink, .06)), selection ? pick(colors['menu.selectionForeground'], colors['list.activeSelectionForeground'], ink) : pick(colors['list.hoverForeground'], ink), role.bg, ink);
    const entries = {
      bg: role.bg, fg: ink, fill, muted: readable(mix(role.bg, ink, .68), [role.bg, fill], 4.5, ink), hover: hovered.bg, 'hover-fg': hovered.fg,
      focus: focus(role.bg, ink), divider: decoration(colors.contrastBorder, mix(role.bg, ink, .12)), border: decoration(values.border, colors.contrastBorder),
      danger: readable(composite(pick(colors.errorForeground, danger), role.bg), [role.bg, fill]), ...inputColors(role.bg, ink),
    };
    for (const [key, value] of Object.entries(entries)) palette[`${name}-${key}`] = value;
  }
  const inactive = pick(colors['list.inactiveSelectionBackground']);
  const selected = pair(pick(inactive, colors['list.activeSelectionBackground'], palette['sidebar-hover']), pick(colors['list.inactiveSelectionForeground'], inactive ? undefined : colors['list.activeSelectionForeground'], palette['sidebar-fg']), palette['sidebar-bg'], palette['sidebar-fg']);
  palette['sidebar-selection'] = selected.bg; palette['sidebar-selection-fg'] = selected.fg;
  const series = ['blue', 'yellow', 'green', 'red', 'purple', 'cyan'];
  const terminal = ['Blue', 'Yellow', 'Green', 'Red', 'Magenta', 'Cyan'];
  const defaults = dark ? ['#60a5fa', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#2dd4bf'] : ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6'];
  for (const [index, name] of series.entries()) palette[`series-${index + 1}`] = foreground(pick(colors[`charts.${name}`], colors[`terminal.ansi${terminal[index]}`], defaults[index]), 3);
  return palette;
}
