# macaron-vendor

Copied from `MindLab-Research/macaron-genui-demo@v1`:

| Local path | Source |
|---|---|
| `macaron/source.tsx` | `src/macaron/source.tsx` — the real `$macaron/ui` |
| `genui/charts.tsx` | `src/genui/charts.tsx` — `$macaron/ui/charts` |
| `genui/katex.tsx` | `src/genui/katex.tsx` — `$macaron/ui/katex` |
| `genui/lucide-react.tsx` | `src/genui/lucide-react.tsx` — passthrough |
| `components/ui/*.tsx` | `src/components/ui/*.tsx` — shadcn primitives |
| `lib/style.ts` | `src/lib/style.ts` — `cn()` helper |
| `lib/standalone-uno.ts` | `lib/genui-cli/src/standalone-uno.ts` — UnoCSS theme |
| `base.css` | `lib/genui-cli/src/standalone-base.css` — CSS variables |

The Vite alias `@` is configured to point at this directory (see `vite.config.ts`),
so `@/components/ui/button` resolves locally.

## When `@macaron/ui` is published to npm

1. `npm install @macaron/ui` (or whatever name they pick)
2. Remove the `@` alias from `vite.config.ts`
3. Delete this whole `macaron-vendor/` directory
4. Update imports in `web/src/main.tsx`:
   - `import * as MacaronUI from './macaron-vendor/macaron/source'` → `import * as MacaronUI from '@macaron/ui'`
   - `import * as MacaronCharts from './macaron-vendor/genui/charts'` → `import * as MacaronCharts from '@macaron/ui/charts'`
5. The shim files under `web/public/genui-shim/` need no change — they re-export from `window.__macaron_*` globals.
