import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./tests/setup/global-setup.ts'],
    // Os testes compartilham um único Postgres e muitos deles truncam tabelas
    // entre casos. Rodar arquivos em paralelo faria um teste apagar os dados
    // de outro no meio da execução.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    include: ['tests/**/*.test.ts'],
    reporters: ['default'],
  },
});
