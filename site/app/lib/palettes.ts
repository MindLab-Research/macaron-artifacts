import type { ThemeRegistration } from '@shikijs/types';

export const palettes = [{ id: 'neutral', label: 'Neutral' }, { id: 'vitesse-light', label: 'Vitesse Light' }, { id: 'vitesse-dark', label: 'Vitesse Dark' }, { id: 'github-light', label: 'GitHub Light' }, { id: 'github-dark', label: 'GitHub Dark' }, { id: 'nord', label: 'Nord' }] as const;
export type PaletteId = typeof palettes[number]['id'];
const loaders = { 'vitesse-light': () => import('@shikijs/themes/vitesse-light'), 'vitesse-dark': () => import('@shikijs/themes/vitesse-dark'), 'github-light': () => import('@shikijs/themes/github-light'), 'github-dark': () => import('@shikijs/themes/github-dark'), nord: () => import('@shikijs/themes/nord') };
export const syntaxThemes = { light: 'github-light', dark: 'github-dark', 'vitesse-light': 'vitesse-light', 'vitesse-dark': 'vitesse-dark', 'github-light': 'github-light', 'github-dark': 'github-dark', nord: 'nord' } as const;
export const loadPalette = async (id: Exclude<PaletteId, 'neutral'>) => (await loaders[id]()).default;

function luminance(hex: string) {
  const value = hex.replace('#', '');
  const expanded = value.length === 3 ? value.split('').map(channel => channel + channel).join('') : value;
  if (!/^[\da-f]{6}(?:[\da-f]{2})?$/i.test(expanded)) return null;
  const channels = [0, 2, 4].map(index => Number.parseInt(expanded.slice(index, index + 2), 16) / 255).map(channel => channel <= .04045 ? channel / 12.92 : ((channel + .055) / 1.055) ** 2.4);
  return channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
}
export function readableText(background: string, proposed: string) {
  const back = luminance(background), front = luminance(proposed);
  if (back === null || front === null || (Math.max(back, front) + .05) / (Math.min(back, front) + .05) >= 4.5) return proposed;
  return (back + .05) / .05 > 1.05 / (back + .05) ? '#000000' : '#ffffff';
}

export function paletteVariables(theme: ThemeRegistration): Record<string, string> {
  const colors = theme.colors ?? {}, dark = theme.type === 'dark';
  const background = colors['editor.background'] ?? theme.bg ?? (dark ? '#121212' : '#ffffff');
  const foreground = colors['editor.foreground'] ?? theme.fg ?? (dark ? '#eeeeee' : '#171717');
  const mix = (amount: number) => `color-mix(in srgb, ${foreground} ${amount}%, ${background})`;
  const primary = colors['button.background'] ?? foreground;
  const muted = colors.descriptionForeground ?? mix(62);
  return {
    background, foreground, card: colors['editorWidget.background'] ?? mix(3), 'card-foreground': foreground,
    popover: colors['menu.background'] ?? mix(5), 'popover-foreground': foreground,
    muted: mix(6), 'muted-foreground': muted, border: colors['panel.border'] ?? mix(15),
    primary, 'primary-foreground': readableText(primary, colors['button.foreground'] ?? background),
    secondary: mix(7), 'secondary-foreground': foreground, accent: colors['list.hoverBackground'] ?? mix(10), 'accent-foreground': foreground,
    ring: readableText(background, colors.focusBorder ?? primary), overlay: dark ? '#0008' : '#0003', destructive: colors.errorForeground ?? (dark ? '#ff6b83' : '#b91c1c'),
    info: colors['editorInfo.foreground'] ?? '#3b82f6', warning: colors['editorWarning.foreground'] ?? '#d97706', error: colors.errorForeground ?? '#dc2626', success: colors['gitDecoration.addedResourceForeground'] ?? '#16a34a', idea: primary,
  };
}
