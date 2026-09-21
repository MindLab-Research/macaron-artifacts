import { presetWind4 } from '@unocss/preset-wind4';
import { presetAnimations } from 'unocss-preset-animations';

const roleColors = ['hover-fg', 'contrast', 'contrast-active', 'code', 'code-fg', 'code-block', 'code-block-fg', 'code-muted', 'code-focus', 'inline-code', 'inline-code-fg', 'bubble', 'bubble-fg', 'bubble-muted', 'bubble-link', 'bubble-focus', 'status', 'status-fg', 'secondary', 'secondary-fg', 'secondary-hover', 'secondary-border', 'secondary-border-rest', 'tab-active', 'tab-active-fg', 'sidebar-selection', 'sidebar-selection-fg', 'panel-border', 'input-focus', 'dropdown-border-rest', 'dropdown-focus'];
const contexts = ['sidebar', 'titlebar', 'panel', 'widget', 'menu'];
const controls = ['input-bg', 'input-fg', 'input-border', 'input-placeholder', 'input-focus', 'dropdown-bg', 'dropdown-fg', 'dropdown-border', 'dropdown-border-rest', 'dropdown-focus'];
// Portal menus establish their own color context; local inputs composite against the surface that actually owns them.
const contextRule = (name) => ({
  'background-color': `var(--${name}-bg)`, color: `var(--${name}-fg)`,
  ...Object.fromEntries(Object.entries({ surface: 'bg', fg: 'fg', muted: name === 'menu' ? 'fg' : 'muted', 'surface-2': 'fill', 'surface-3': 'hover', 'hover-fg': 'hover-fg', focus: 'focus', danger: 'danger', border: name === 'widget' ? 'divider' : 'border', ...Object.fromEntries(controls.map(key => [key, key])) }).map(([local, role]) => [`--${local}`, `var(--${name}-${role})`])),
  ...(['widget', 'menu'].includes(name) ? { border: `1px solid var(--${name}-border)`, 'box-shadow': name === 'menu' ? '0 6px 18px var(--widget-shadow)' : '0 12px 32px var(--widget-shadow)' } : {}),
});

// The shell and generated surfaces compile the same semantic names; runtime rules stay scoped.
/** @param {string} [scope] @returns {import('@unocss/core').UserConfig} */
export const unoConfig = (scope) => ({
  rules: [['theme-bubble', { 'background-color': 'var(--bubble)', color: 'var(--bubble-fg)', '--fg': 'var(--bubble-fg)', '--muted': 'var(--bubble-muted)', '--link': 'var(--bubble-link)', '--focus': 'var(--bubble-focus)' }], ...contexts.map(name => [`theme-${name}`, contextRule(name)]), ['theme-code', { 'background-color': 'var(--code)', color: 'var(--code-fg)', '--surface': 'var(--code)', '--fg': 'var(--code-fg)', '--muted': 'var(--code-muted)', '--focus': 'var(--code-focus)' }]],
  // ThemeProvider and exported HTML preserve data-theme, not the preset's default .dark/.light classes.
  presets: [presetWind4({ important: scope, dark: { dark: '[data-theme="dark"]', light: '[data-theme="light"]' }, preflights: { reset: !scope } }), presetAnimations()],
  theme: { colors: { ...Object.fromEntries(roleColors.map(key => [key, `var(--${key})`])), surface: 'var(--surface)', 'surface-2': 'var(--surface-2)', 'surface-3': 'var(--surface-3)', border: 'var(--border)', 'control-border': 'var(--control-border, var(--border))', 'input-bg': 'var(--input-bg, var(--surface))', 'input-fg': 'var(--input-fg, var(--fg))', 'input-border': 'var(--input-border, var(--border))', 'input-placeholder': 'var(--input-placeholder, var(--muted))', 'dropdown-bg': 'var(--dropdown-bg, var(--surface))', 'dropdown-fg': 'var(--dropdown-fg, var(--fg))', 'dropdown-border': 'var(--dropdown-border, var(--border))', focus: 'var(--focus, var(--accent))', link: 'var(--link, var(--accent))', fg: 'var(--fg)', muted: 'var(--muted)', accent: 'var(--accent)', 'accent-fg': 'var(--accent-fg)', 'accent-hover': 'var(--accent-hover, var(--accent))', danger: 'var(--danger)', 'danger-bg': 'var(--danger-bg, var(--danger))', 'danger-fg': 'var(--danger-fg, #fff)', 'danger-hover': 'var(--danger-hover, var(--danger))', success: 'var(--success)', warn: 'var(--warn)', ...Object.fromEntries(Array.from({ length: 6 }, (_, index) => [`series-${index + 1}`, `var(--series-${index + 1})`])) } },
  // Native roles may invert foreground and background. Crossfading both passes through unreadable intermediate colors.
  shortcuts: {
    interactive: 'transition-[opacity,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)]',
    'btn-icon': 'interactive grid place-items-center text-muted hover:bg-surface-3 hover:text-hover-fg active:scale-[0.98] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    'menu-item': 'interactive flex items-center gap-2 text-sm data-[focus]:bg-surface-3 data-[focus]:text-hover-fg',
    // Portal popovers must clear their owning dialog; confirmations stay above both.
    'z-content-overlay': 'z-10', 'z-sticky': 'z-20', 'z-floating-control': 'z-30', 'z-dialog': 'z-50', 'z-popover': 'z-60', 'z-confirm': 'z-70',
  },
});
