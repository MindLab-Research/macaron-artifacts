import { reactRouter } from '@react-router/dev/vite';
import UnoCSS from 'unocss/vite';
import { defineConfig } from 'vite';
import mdx from 'fumadocs-mdx/vite';
import { resolveCommitSha } from './app/lib/commit-sha';
import { fumadocsStyles } from './app/styles/fumadocs-compat';

export default defineConfig({
  // Per-module output is compatible with React Router's separate Vite environments; global mode loses its css-post lookup during prerender builds.
  plugins: [mdx(), fumadocsStyles(), UnoCSS({ mode: 'per-module' }), reactRouter()],
  // Base UI's ESM store imports this transitive CommonJS shim; pnpm does not expose it at the site root.
  optimizeDeps: { include: ['fumadocs-ui > @base-ui/react > @base-ui/utils > use-sync-external-store/shim', 'fumadocs-ui > @base-ui/react > @base-ui/utils > use-sync-external-store/shim/with-selector'] },
  // Pin install commands to the commit being built, resolved once at config load.
  define: {
    __COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
  },
  resolve: {
    tsconfigPaths: true,
  },
});
