import { defineConfig, extractorDefault, presetWind4 } from 'unocss';

const names = ['background', 'foreground', 'muted', 'muted-foreground', 'popover', 'popover-foreground', 'card', 'card-foreground', 'border', 'primary', 'primary-foreground', 'secondary', 'secondary-foreground', 'accent', 'accent-foreground', 'ring', 'overlay', 'info', 'warning', 'error', 'success', 'idea', 'destructive'];

export default defineConfig({
  presets: [presetWind4({ preflights: { theme: true } })],
  // A dependency's md:p-6 must never lose to the application's unrelated p-4. The site: variant keeps local utilities out of the vendor namespace.
  variants: [
    matcher => matcher.startsWith('site:') ? { matcher: matcher.slice(5) } : undefined,
    matcher => matcher.startsWith('hovered:') ? { matcher: matcher.slice(8), selector: selector => `${selector}:hover` } : undefined,
  ],
  theme: { colors: { ...Object.fromEntries(names.map(name => [`fd-${name}`, `var(--color-fd-${name})`])), genui: 'var(--genui)' } },
  content: { pipeline: { include: [/\.[jt]sx?($|\?)/, /\.mdx?($|\?)/] } },
  // Do not regenerate Fumadocs' utility classes from its bundled source.
  extractorDefault: { name: 'site-utilities', async extract(context) { return [...(await extractorDefault.extract?.(context) ?? [])].filter(token => token.startsWith('site:')); } },
  outputToCssLayers: { cssLayerName: layer => layer === 'base' ? 'base' : layer === 'theme' ? 'theme' : layer === 'properties' ? 'properties' : 'utilities' },
});
