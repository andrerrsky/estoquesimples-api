import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';

import { resolveAppDist } from './app-dist.js';
import { ErrorCode } from './errors.js';

/**
 * Entrega a aplicação web (apps/web) nos hosts públicos do produto.
 *
 * A mesma instância atende dois endereços: `api.…` (API, painel, docs) e o
 * domínio do produto (`estoquesimples.com.br`). Neste último só existem a
 * interface e `/v1` — a web chama a API na própria origem, sem CORS e com o
 * cookie de sessão `SameSite=Strict`. Painel, documentação e métricas não
 * respondem por este host.
 *
 * O roteamento é por `Host`, num gancho anterior às rotas: assim `/` pode
 * ser a página inicial aqui e a identificação da API lá, sem conflito.
 */

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.woff2': 'font/woff2',
};

const COMPRESSIBLE = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.txt', '.xml']);

interface StaticFile {
  contentType: string;
  cacheControl: string;
  raw: Buffer;
  gzip: Buffer | null;
  brotli: Buffer | null;
}

/** Carrega o build inteiro em memória: são poucos arquivos e não mudam até o próximo deploy. */
function loadFiles(distDir: string): Map<string, StaticFile> {
  const files = new Map<string, StaticFile>();
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const absolute = join(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
        continue;
      }
      const extension = extname(entry).toLowerCase();
      const urlPath = `/${relative(distDir, absolute).split(sep).join('/')}`;
      const raw = readFileSync(absolute);
      const compress = COMPRESSIBLE.has(extension) && raw.length > 1024;
      files.set(urlPath, {
        contentType: CONTENT_TYPES[extension] ?? 'application/octet-stream',
        // Arquivos do Vite têm hash no nome e podem ficar imutáveis; o resto
        // (index.html, robots.txt, páginas legais) precisa ser revalidado.
        cacheControl: urlPath.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
        raw,
        gzip: compress ? gzipSync(raw, { level: 9 }) : null,
        brotli: compress ? brotliCompressSync(raw) : null,
      });
    }
  };
  walk(distDir);
  return files;
}

const PLACEHOLDER = Buffer.from(
  `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Estoque Simples</title>
<style>body{font-family:system-ui,sans-serif;background:#F4F7FA;color:#1A2330;display:grid;place-items:center;height:100vh;margin:0}
main{background:#fff;border:1px solid #E3E8EE;border-radius:14px;padding:32px;max-width:480px}</style></head>
<body><main><h1 style="font-size:20px;margin:0 0 8px">Estoque Simples</h1>
<p style="color:#5C6B7A;margin:0">A aplicação web ainda não foi compilada nesta instância. Rode <code>npm run build</code> na raiz do repositório e reinicie.</p></main></body></html>`,
);

function hostOf(request: FastifyRequest): string {
  const header = request.headers.host ?? '';
  return header.split(':')[0]?.toLowerCase() ?? '';
}

export function isWebAppHost(app: FastifyInstance, request: FastifyRequest): boolean {
  return app.services.env.WEB_APP_HOSTS.includes(hostOf(request));
}

export async function registerWebApp(app: FastifyInstance): Promise<void> {
  const hosts = new Set(app.services.env.WEB_APP_HOSTS);
  if (hosts.size === 0) return;
  const secure = app.services.env.NODE_ENV === 'production' || app.services.env.NODE_ENV === 'staging';

  const distDir = resolveAppDist('web');
  const files = distDir ? loadFiles(distDir) : new Map<string, StaticFile>();
  if (!distDir) {
    app.log.warn('aplicação web sem build em apps/web/dist; servindo página de aviso');
  }
  const index: StaticFile = files.get('/index.html') ?? {
    contentType: 'text/html; charset=utf-8',
    cacheControl: 'no-store',
    raw: PLACEHOLDER,
    gzip: null,
    brotli: null,
  };

  const send = (request: FastifyRequest, reply: FastifyReply, file: StaticFile, status = 200): FastifyReply => {
    const accepts = String(request.headers['accept-encoding'] ?? '');
    let body = file.raw;
    if (file.brotli && /\bbr\b/.test(accepts)) {
      body = file.brotli;
      reply.header('Content-Encoding', 'br');
    } else if (file.gzip && /\bgzip\b/.test(accepts)) {
      body = file.gzip;
      reply.header('Content-Encoding', 'gzip');
    }
    // Esta resposta sai antes dos plugins (helmet), então os cabeçalhos de
    // segurança da página são postos aqui. HSTS só onde há HTTPS de verdade.
    if (secure) reply.header('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
    return reply
      .code(status)
      .header('Content-Type', file.contentType)
      .header('Cache-Control', file.cacheControl)
      .header('Vary', 'Accept-Encoding')
      .header('Content-Security-Policy', CSP)
      .header('X-Frame-Options', 'DENY')
      .header('X-Content-Type-Options', 'nosniff')
      .header('Referrer-Policy', 'strict-origin-when-cross-origin')
      .send(request.method === 'HEAD' ? '' : body);
  };

  app.addHook('onRequest', async (request, reply) => {
    const host = hostOf(request);
    if (!hosts.has(host)) return;

    const path = (request.raw.url ?? '/').split('?')[0] ?? '/';

    // `www` é só um apelido: o endereço canônico é o domínio sem prefixo.
    if (host.startsWith('www.') && hosts.has(host.slice(4))) {
      return reply.redirect(`https://${host.slice(4)}${request.raw.url ?? '/'}`, 301);
    }

    // A API da web é a mesma do app, na mesma origem.
    if (path === '/v1' || path.startsWith('/v1/')) return;
    // O orquestrador confere a saúde por qualquer host.
    if (path === '/health' || path === '/ready') return;

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return reply.code(404).send({
        error: { code: ErrorCode.NOT_FOUND, message: 'Rota não encontrada.', correlationId: request.id },
      });
    }

    const file = files.get(path);
    if (file) return send(request, reply, file);

    // Arquivo com extensão que não existe é 404 de verdade (um asset antigo
    // depois de um deploy); devolver o index faria o navegador tentar
    // executar HTML como script.
    if (/\.[a-z0-9]{2,5}$/i.test(path)) {
      return reply.code(404).header('Cache-Control', 'no-store').type('text/plain; charset=utf-8').send('Não encontrado.');
    }

    // Qualquer outra rota é da SPA: o roteador do cliente decide.
    return send(request, reply, { ...index, cacheControl: 'no-store' });
  });
}
