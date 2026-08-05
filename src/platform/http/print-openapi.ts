import { buildApp } from '../../app.js';
import { loadEnv } from '../config/env.js';

/**
 * Emite o documento OpenAPI no stdout.
 *
 * Gerado a partir dos mesmos schemas Zod que validam as requisições, então a
 * documentação não tem como divergir do comportamento real da API.
 * Uso: `npm run openapi > openapi.json`
 */
async function main(): Promise<void> {
  const env = loadEnv({
    ...process.env,
    NODE_ENV: 'development',
    LOG_LEVEL: 'silent',
    // A geração do documento não abre conexão com o banco; a URL só precisa
    // existir para a configuração validar.
    DATABASE_URL: process.env['DATABASE_URL'] ?? 'postgres://localhost:5432/placeholder',
  } as NodeJS.ProcessEnv);

  const { app, close } = await buildApp({ env });
  await app.ready();
  console.log(JSON.stringify(app.swagger(), null, 2));
  await close();
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
