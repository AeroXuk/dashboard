import { defineConfig } from 'vite';

const api = `http://localhost:${process.env.PORT ?? 3000}`;

export default defineConfig({
  root: 'web',
  build: { outDir: '../dist/web', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: { '/api': api, '/icons': api },
  },
});
