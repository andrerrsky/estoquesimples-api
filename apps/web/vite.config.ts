import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

import pkg from './package.json';

/**
 * A aplicação web é servida pela própria API na raiz do domínio público
 * (estoquesimples.com.br), na mesma origem de `/v1`. Em desenvolvimento o
 * Vite roda sozinho e repassa `/v1` para a API local (`npm run dev` na raiz).
 */
export default defineConfig({
  plugins: [react()],
  base: '/',
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
  },
  server: {
    port: 5173,
    proxy: {
      '/v1': { target: 'http://localhost:3000', changeOrigin: false },
    },
  },
});
