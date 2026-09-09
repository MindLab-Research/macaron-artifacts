import { reactRouter } from '@react-router/dev/vite';
import UnoCSS from 'unocss/vite';
import { defineConfig } from 'vite';
import mdx from 'fumadocs-mdx/vite';
import { resolveCommitSha } from './app/lib/commit-sha';
import { fumadocsStyles } from './app/styles/fumadocs-compat';

export default defineConfig({
  // Per-module output is compatible with React Router's separate Vite environments; global mode loses its css-post lookup during prerender builds.
  plugins: [mdx(), fumadocsStyles(), UnoCSS({ mode: 'per-module' }), reactRouter()],
  // Pin install commands to the commit being built, resolved once at config load.
  define: {
    __COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
  },
  resolve: {
    tsconfigPaths: true,
  },
});
