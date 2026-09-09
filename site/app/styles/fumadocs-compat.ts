import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import postcss from 'postcss';
import type { Plugin } from 'vite';

export function withoutVendorReset(css: string) {
  const root = postcss.parse(css);
  const resets = root.nodes.filter(node => node.type === 'atrule' && node.name === 'layer' && node.params === 'base' && node.nodes?.some(child => child.type === 'rule' && child.nodes.some(declaration => declaration.type === 'decl' && declaration.prop === 'box-sizing' && declaration.value === 'border-box')));
  if (resets.length !== 1) throw new Error('Fumadocs reset changed; review the precompiled stylesheet before upgrading.');
  resets[0].remove();
  return root.toString();
}

/** Fumadocs ships compiled components. Only its duplicate reset is removed; no Tailwind compiler processes application classes. */
export function fumadocsStyles(): Plugin {
  const id = 'virtual:fumadocs-compat.css';
  return {
    name: 'fumadocs-precompiled-styles',
    enforce: 'pre',
    // Route CSS can arrive before the shared reset in per-module builds; establish the same cascade order in every chunk.
    transform(code, id) { if (id.endsWith('.css')) return `@layer properties, theme, base, components, utilities;\n${code}`; },
    resolveId(source) { if (source === id) return `\0${id}`; },
    async load(source) {
      if (source !== `\0${id}`) return;
      const file = createRequire(import.meta.url).resolve('fumadocs-ui/style.css');
      this.addWatchFile(file);
      return withoutVendorReset(await readFile(file, 'utf8'));
    },
  };
}
