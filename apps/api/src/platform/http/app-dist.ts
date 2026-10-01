import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Localiza o build de uma das interfaces do monorepo (`apps/admin/dist`,
 * `apps/web/dist`).
 *
 * A API serve as duas na mesma origem, então precisa achá-las de onde quer
 * que tenha sido iniciada: da raiz do repositório (produção, `npm start`),
 * de `apps/api` (desenvolvimento e testes) ou do próprio arquivo compilado.
 */
export function resolveAppDist(app: 'admin' | 'web'): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'apps', app, 'dist'),
    join(process.cwd(), '..', app, 'dist'),
    // apps/api/{src,dist}/platform/http -> apps/<app>/dist
    join(here, '../../../..', app, 'dist'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}
