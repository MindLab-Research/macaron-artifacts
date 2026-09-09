import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import UnoCSS from 'unocss/vite';

export default defineConfig({
  plugins: [react(), UnoCSS()],
  server: { port: Number(process.env.WEB_PORT || 43861), strictPort: true, proxy: { '/api': `http://127.0.0.1:${process.env.MACARON_PORT || 43860}` } },
  build: { outDir: 'dist/web' },
  optimizeDeps: { exclude: ['partial-react', '@esm.sh/tsx'], include: ['react-dom/server'] },
});
