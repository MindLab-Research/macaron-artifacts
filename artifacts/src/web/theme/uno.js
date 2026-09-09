import { presetWind4 } from '@unocss/preset-wind4';
import { presetAnimations } from 'unocss-preset-animations';

// The shell and generated surfaces compile the same semantic names; runtime rules stay scoped.
/** @param {string} [scope] @returns {import('@unocss/core').UserConfig} */
export const unoConfig = (scope) => ({
  presets: [presetWind4({ important: scope, preflights: { reset: !scope } }), presetAnimations()],
  theme: { colors: { surface: 'var(--surface)', 'surface-2': 'var(--surface-2)', 'surface-3': 'var(--surface-3)', border: 'var(--border)', 'control-border': 'var(--control-border, var(--border))', 'input-bg': 'var(--input-bg, var(--surface))', 'input-fg': 'var(--input-fg, var(--fg))', 'input-border': 'var(--input-border, var(--border))', 'input-placeholder': 'var(--input-placeholder, var(--muted))', 'dropdown-bg': 'var(--dropdown-bg, var(--surface))', 'dropdown-fg': 'var(--dropdown-fg, var(--fg))', 'dropdown-border': 'var(--dropdown-border, var(--border))', focus: 'var(--focus, var(--accent))', link: 'var(--link, var(--accent))', fg: 'var(--fg)', muted: 'var(--muted)', accent: 'var(--accent)', 'accent-fg': 'var(--accent-fg)', 'accent-hover': 'var(--accent-hover, var(--accent))', danger: 'var(--danger)', 'danger-bg': 'var(--danger-bg, var(--danger))', 'danger-fg': 'var(--danger-fg, #fff)', 'danger-hover': 'var(--danger-hover, var(--danger))', success: 'var(--success)', warn: 'var(--warn)', ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`series-${index + 1}`, `var(--series-${index + 1})`])) } },
  shortcuts: { interactive: 'transition-[color,background-color,border-color,opacity,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]' },
});
