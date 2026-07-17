import type { UnocssLintToolkit } from '@genui/diagnostics/lint';
import type { Rule, UserShortcuts } from '@unocss/core';
import type { Theme } from '@unocss/preset-wind3';

const hsl = (name: string) => `hsl(var(--${name}))`;
const withForeground = (name: string) => ({ DEFAULT: hsl(name), foreground: hsl(`${name}-foreground`) });

// Keep this host configuration aligned with web/src/macaron-vendor/lib/standalone-uno.ts.
// The lint implementation stays in @genui/diagnostics/lint; this file only supplies the host's theme extensions.
const unoTheme: Theme = {
  colors: {
    border: hsl('border'),
    input: hsl('input'),
    ring: hsl('ring'),
    background: hsl('background'),
    foreground: hsl('foreground'),
    primary: withForeground('primary'),
    secondary: withForeground('secondary'),
    destructive: withForeground('destructive'),
    muted: withForeground('muted'),
    accent: withForeground('accent'),
    popover: withForeground('popover'),
    card: withForeground('card'),
  },
  borderRadius: {
    lg: 'var(--radius)',
    md: 'calc(var(--radius) - 2px)',
    sm: 'calc(var(--radius) - 4px)',
  },
  fontFamily: {
    sans: '"Geist Variable", "Noto Sans SC", system-ui, sans-serif',
    mono: '"Geist Mono Variable", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  animation: {
    keyframes: {
      'accordion-down': '{from{height:0}to{height:var(--radix-accordion-content-height)}}',
      'accordion-up': '{from{height:var(--radix-accordion-content-height)}to{height:0}}',
    },
    durations: { 'accordion-down': '0.2s', 'accordion-up': '0.2s' },
    timingFns: { 'accordion-down': 'ease-out', 'accordion-up': 'ease-out' },
  },
};

const unoShortcuts: UserShortcuts<Theme> = {
  'bg-macaron-gradient': 'bg-[linear-gradient(97.87deg,#FFC400_0.21%,#FF5A70_50.21%,#F63B3B_100.21%)]',
  'bg-macaron-gradient-new': 'bg-[linear-gradient(98deg,#FFC300_0.21%,#FF5A70_50.21%,#F63B3B_100.21%)]',
};

const unoRules: Rule<Theme>[] = [[/^transition-\[padding-left\]$/, () => ({ 'transition-property': 'padding-left' })]];

let toolkitPromise: Promise<UnocssLintToolkit> | undefined;

export const loadGenUIUnocssToolkit = (): Promise<UnocssLintToolkit> =>
  (toolkitPromise ??= Promise.all([
    import('@unocss/core'),
    import('@unocss/autocomplete'),
    import('@unocss/preset-wind3'),
    import('unocss-preset-animations'),
  ]).then(async ([core, autocomplete, wind3, animations]) => {
    const generator = await core.createGenerator(
      { theme: unoTheme, shortcuts: unoShortcuts, rules: unoRules },
      {
        presets: [wind3.default({ dark: 'class', preflight: false }), animations.presetAnimations()],
        separators: [],
      },
    );
    return { generator, autocomplete: autocomplete.createAutocomplete(generator) };
  }));
