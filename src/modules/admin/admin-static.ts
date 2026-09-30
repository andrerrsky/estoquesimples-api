import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ErrorCode } from '../../platform/http/errors.js';

/**
 * Serve a interface do painel (SPA compilada pelo Vite) em /admin.
 *
 * Servida pela própria API, na mesma origem, de propósito: o cookie de sessão
 * pode ser SameSite=Strict, não há CORS para configurar e não existe um
 * segundo serviço para manter. O custo é a API entregar alguns arquivos
 * estáticos, o que é desprezível para um painel usado por poucas pessoas.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function resolveAdminDist(): string | null {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(process.cwd(), 'admin/dist'),
    join(here, '../../../admin/dist'),
    join(here, '../../../../admin/dist'),
  ];
  return candidates.find((dir) => existsSync(join(dir, 'index.html'))) ?? null;
}

const PLACEHOLDER = `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Estoque Simples · Painel</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F7FA;color:#1A2330;display:grid;place-items:center;height:100vh;margin:0}
main{background:#fff;border:1px solid #E3E8EE;border-radius:14px;padding:32px;max-width:480px}</style></head>
<body><main><h1 style="font-size:20px;margin:0 0 8px">Painel não compilado</h1>
<p style="color:#5C6B7A;margin:0">A API está no ar, mas a interface do painel ainda não foi gerada. Rode <code>npm run build</code> (ou <code>npm run build --workspace admin</code>) e reinicie.</p></main></body></html>`;

export async function registerAdminStatic(app: FastifyInstance): Promise<void> {
  const distDir = resolveAdminDist();
  const indexHtml = distDir ? readFileSync(join(distDir, 'index.html'), 'utf8') : PLACEHOLDER;

  if (!distDir) {
    app.log.warn('painel administrativo sem build em admin/dist; servindo página de aviso');
  }

  if (distDir) {
    await app.register(fastifyStatic, {
      root: distDir,
      prefix: '/',
      // Assets do Vite têm hash no nome: podem ser cacheados por muito tempo.
      // O index.html nunca é cacheado (é servido pelo handler abaixo).
      maxAge: '30d',
      immutable: true,
      index: false,
      wildcard: false,
      decorateReply: true,
      serve: true,
      setHeaders: (reply) => {
        reply.setHeader('Content-Security-Policy', CSP);
      },
    });
  }

  const sendIndex = (reply: import('fastify').FastifyReply) =>
    reply
      .header('Content-Security-Policy', CSP)
      .header('Cache-Control', 'no-store')
      .header('X-Frame-Options', 'DENY')
      .type('text/html; charset=utf-8')
      .send(indexHtml);

  app.get('/', { schema: { hide: true } }, async (_request, reply) => sendIndex(reply));

  // Fallback da SPA: qualquer rota de navegação devolve o index; a API
  // administrativa continua respondendo 404 em JSON.
  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url.startsWith('/admin/api');
    if (!isApi && request.method === 'GET') {
      return sendIndex(reply);
    }
    return reply.code(404).send({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `Rota não encontrada: ${request.method} ${request.url}`,
        correlationId: request.id,
      },
    });
  });
}
