import { createHash } from 'node:crypto';

import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { resolveAuth } from '../../platform/http/authenticate.js';
import { notFound } from '../../platform/http/errors.js';
import { errorSchema } from '../auth/auth.schemas.js';
import { blogListQuerySchema, blogSlugSchema } from './blog.schemas.js';
import { BlogService } from './blog.service.js';
import { renderCover, type CoverAspect } from './blog-cover.js';

/**
 * Leitura pública do blog: a web (SPA), o app Android e o painel leem daqui.
 * Sem login: é conteúdo público. As páginas HTML para os buscadores saem de
 * `platform/http/web-app.ts` (ver blog-ssr.ts), com o mesmo serviço.
 */
export async function registerBlogRoutes(app: FastifyInstance): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new BlogService(app.services);
  const cache = { 'Cache-Control': 'public, max-age=60, stale-while-revalidate=300' };

  routes.get(
    '/blog/posts',
    {
      schema: { tags: ['blog'], summary: 'Posts publicados (com filtros por categoria, mês e busca)', querystring: blogListQuerySchema, response: { 200: z.any(), 400: errorSchema } },
    },
    async (request, reply) => {
      const result = await service.listPublished(request.query);
      return reply.headers(cache).send(result);
    },
  );

  routes.get(
    '/blog/facets',
    { schema: { tags: ['blog'], summary: 'Categorias e meses com posts', response: { 200: z.any() } } },
    async (_request, reply) => reply.headers(cache).send(await service.facets()),
  );

  routes.get(
    '/blog/posts/:slug',
    {
      schema: { tags: ['blog'], summary: 'Um post publicado, com o HTML do texto e posts relacionados', params: z.object({ slug: blogSlugSchema }), response: { 200: z.any(), 404: errorSchema } },
    },
    async (request, reply) => {
      const post = await service.getPublished(request.params.slug);
      if (!post) throw notFound('Post não encontrado.');
      const related = await service.related(post);
      // Sessão opcional: um post exclusivo sai inteiro para quem tem conta e só o começo para o resto.
      let signedIn = false;
      if (post.membersOnly && request.headers.authorization) {
        signedIn = await resolveAuth(app.services, request.headers.authorization).then(() => true, () => false);
      }
      return reply.headers({ ...cache, ...(post.membersOnly ? { 'Cache-Control': 'private, max-age=0', Vary: 'Authorization' } : {}) }).send({ post: service.forReader(post, signedIn), related });
    },
  );

  routes.get(
    '/blog/covers/auto/:file',
    {
      schema: { tags: ['blog'], summary: 'Capa gerada para um post sem imagem (título e categoria); sufixo -4x3 ou -1x1 para as outras proporções', params: z.object({ file: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?:-(4x3|1x1))?\.webp$/) }), response: { 304: z.string(), 404: errorSchema } },
    },
    async (request, reply) => {
      const name = request.params.file.slice(0, -'.webp'.length);
      const variant = /-(4x3|1x1)$/.exec(name);
      const aspect: CoverAspect = variant ? (variant[1] as CoverAspect) : '16x9';
      const slug = variant ? name.slice(0, -variant[0].length) : name;
      const post = await service.getPublished(slug);
      if (!post) throw notFound('Post não encontrado.');
      const key = `${post.id}:${post.updatedAt}:${aspect}`;
      const etag = `W/"${createHash('sha1').update(key).digest('base64url')}"`;
      const cacheControl = 'public, max-age=86400, stale-while-revalidate=604800';
      if (String(request.headers['if-none-match'] ?? '').includes(etag)) return reply.code(304).header('ETag', etag).header('Cache-Control', cacheControl).send('');
      const bytes = await renderCover(key, { title: post.title, category: post.category.label, aspect });
      // Sem fontes no servidor a capa sairia sem texto: vale a imagem padrão do site.
      if (!bytes) return reply.redirect('/og.jpg', 302);
      return reply
        .header('Content-Type', 'image/webp')
        .header('ETag', etag)
        .header('Cache-Control', cacheControl)
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .header('X-Content-Type-Options', 'nosniff')
        .send(bytes as never);
    },
  );

  routes.get(
    '/blog/covers/:file',
    {
      schema: { tags: ['blog'], summary: 'Imagem de capa de um post', params: z.object({ file: z.string().regex(/^[0-9a-f]{64}\.webp$/) }), response: { 304: z.string(), 404: errorSchema, 503: errorSchema } },
    },
    async (request, reply) => {
      const hash = request.params.file.slice(0, 64);
      const etag = `"${hash.slice(0, 32)}"`;
      if (String(request.headers['if-none-match'] ?? '').includes(etag)) return reply.code(304).header('ETag', etag).header('Cache-Control', 'public, max-age=31536000, immutable').send('');
      const bytes = await service.readCover(hash);
      if (!bytes) throw notFound('Imagem não encontrada.');
      return reply
        .header('Content-Type', 'image/webp')
        .header('ETag', etag)
        .header('Cache-Control', 'public, max-age=31536000, immutable')
        .header('Cross-Origin-Resource-Policy', 'cross-origin')
        .header('X-Content-Type-Options', 'nosniff')
        .send(bytes as never);
    },
  );
}
