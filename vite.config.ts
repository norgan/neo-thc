import { defineConfig } from 'vite';

export default defineConfig({
  root: 'web',
  esbuild: { jsx: 'automatic' },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
    proxy: { '/api': { target: 'http://127.0.0.1:4318', changeOrigin: false } },
  },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
