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

/** Flatten editor alpha colors once so a token has the same contrast on every host surface. */
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

export function themePalette(theme: ThemeRegistration, dark: boolean): Record<string, string> {
  const colors = theme.colors ?? {};
  // Shipped themes also contain null, empty strings and even arrays despite the declared color type.
  const pick = (...values: unknown[]) => values.find(value => parseColor(value)) as string | undefined;
  const surface = composite(pick(colors['editor.background'], theme.bg), dark ? '#0e0e11' : WHITE);
  const baseFg = readable(composite(pick(colors['editor.foreground'], theme.fg, colors.foreground, dark ? '#f2f2f5' : '#16161a'), surface), [surface]);
  const ink = contrastRatio(surface, BLACK) > contrastRatio(surface, WHITE) ? BLACK : WHITE;
  const readableSurface = (value: string) => adjustToward(value, surface, candidate => contrastRatio(ink, candidate) >= 4.5).color;
  const surface2 = readableSurface(composite(pick(colors['editorWidget.background'], mix(surface, baseFg, .04)), surface));
  let hover = composite(pick(colors['list.hoverBackground'], mix(surface2, baseFg, .06)), surface2);
  if (Math.min(contrastRatio(hover, surface), contrastRatio(hover, surface2)) < 1.04) hover = mix(surface2, baseFg, .08);
  const surface3 = readableSurface(hover);
  const surfaces = [surface, surface2, surface3];
  const fg = readable(baseFg, surfaces, 4.5, ink);
  const foreground = (value: unknown, minimum = 4.5) => readable(composite(value, surface), surfaces, minimum, fg);
  const muted = foreground(pick(colors.descriptionForeground, colors['input.placeholderForeground'], mix(surface, fg, .62)));
  const inputBg = readableSurface(composite(pick(colors['input.background'], surface2), surface));
  const inputFg = readable(composite(pick(colors['input.foreground'], fg), inputBg), [inputBg]);
  const dropdownBg = readableSurface(composite(pick(colors['dropdown.background'], inputBg), surface));
  const dropdownFg = readable(composite(pick(colors['dropdown.foreground'], fg), dropdownBg), [dropdownBg]);
  let accent = composite(pick(colors['button.background'], colors['textLink.foreground'], fg), surface);
  const defaultLabel = contrastRatio(accent, fg) > contrastRatio(accent, surface) ? fg : surface;
  const accentFg = composite(pick(colors['button.foreground'], defaultLabel), accent);
  // Keep the theme's intended button label (notably GitHub's white); adjust its background instead.
  accent = readable(accent, [accentFg]);
  const accentHover = buttonHover(accent, accentFg, composite(pick(colors['button.hoverBackground'], mix(accent, accentFg, .08)), surface));
  const danger = foreground(pick(colors.errorForeground, colors['editorError.foreground'], colors['terminal.ansiRed'], dark ? '#ff6b83' : '#d9435f'));
  const dangerBg = readable(danger, [WHITE]);
  const palette: Record<string, string> = {
    surface, 'surface-2': surface2, 'surface-3': surface3, fg, muted,
    border: composite(pick(colors['panel.border'], colors['widget.border'], mix(surface, fg, .14)), surface),
    // VS Code uses optional input borders, component-specific dropdown borders and low-alpha radio borders.
    // Resting decoration must not inherit focus/contrastBorder or the text contrast correction.
    'control-border': composite(pick(colors['radio.inactiveBorder'], colors['button.secondaryBorder'], mix(surface, fg, .15)), surface),
    'input-bg': inputBg, 'input-fg': inputFg,
    'input-border': composite(pick(colors['input.border']), inputBg),
    'input-placeholder': readable(composite(pick(colors['input.placeholderForeground'], muted), inputBg), [inputBg]),
    'dropdown-bg': dropdownBg, 'dropdown-fg': dropdownFg,
    'dropdown-border': composite(pick(colors['dropdown.border'], dark ? dropdownBg : mix(dropdownBg, dropdownFg, .15)), dropdownBg),
    accent, 'accent-fg': accentFg, 'accent-hover': accentHover,
    link: foreground(pick(colors['textLink.foreground'], colors['textLink.activeForeground'], accent)),
    focus: readable(composite(pick(colors.focusBorder, colors['textLink.foreground'], accent), surface), [...surfaces, inputBg, dropdownBg], 3, fg),
    danger, 'danger-bg': dangerBg, 'danger-fg': WHITE, 'danger-hover': buttonHover(dangerBg, WHITE),
    success: foreground(pick(colors['gitDecoration.addedResourceForeground'], colors['terminal.ansiGreen'], dark ? '#34d399' : '#15803d')),
    warn: foreground(pick(colors['editorWarning.foreground'], colors['terminal.ansiYellow'], dark ? '#fbbf24' : '#a16207')),
  };
  const series = ['blue', 'yellow', 'green', 'red', 'purple', 'cyan'];
  const terminal = ['Blue', 'Yellow', 'Green', 'Red', 'Magenta', 'Cyan'];
  const defaults = dark ? ['#60a5fa', '#fbbf24', '#34d399', '#f472b6', '#a78bfa', '#2dd4bf'] : ['#3b82f6', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#14b8a6'];
  for (const [index, name] of series.entries()) palette[`series-${index + 1}`] = foreground(pick(colors[`charts.${name}`], colors[`terminal.ansi${terminal[index]}`], defaults[index]), 3);
  return palette;
}
