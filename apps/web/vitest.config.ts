import { defineConfig } from 'vitest/config';

// Testes de lógica pura da web (Google Analytics, conversões), sem navegador:
// os testes montam um `window` mínimo (tests/fake-browser.ts).
export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify('0.0.0-teste') },
  test: { include: ['tests/**/*.test.ts'], environment: 'node' },
});
