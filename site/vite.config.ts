import { reactRouter } from '@react-router/dev/vite';
import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vite';
import mdx from 'fumadocs-mdx/vite';
import { resolveCommitSha } from './app/lib/commit-sha';

export default defineConfig({
  plugins: [mdx(), tailwindcss(), reactRouter()],
  // Pin install commands to the commit being built, resolved once at config load.
  define: {
    __COMMIT_SHA__: JSON.stringify(resolveCommitSha()),
  },
  resolve: {
    tsconfigPaths: true,
  },
  // @lobehub/icons ships ESM with extensionless relative imports (`../style`),
  // which Node's SSR resolver rejects. Let Vite bundle it so those resolve.
  ssr: {
    noExternal: ['@lobehub/icons'],
  },
});
