import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

/**
 * A interface é servida pela própria API em /admin, então o `base` precisa
 * bater com esse prefixo. Em desenvolvimento o Vite roda sozinho e repassa
 * /admin/api para a API local (`npm run dev` na raiz do monorepo).
 */
export default defineConfig({
  plugins: [react()],
  base: '/admin/',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5174,
    proxy: {
      '/admin/api': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
