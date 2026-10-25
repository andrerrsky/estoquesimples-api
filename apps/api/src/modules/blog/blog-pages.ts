import type { AppServices } from '../../platform/http/context.js';
import { BLOG_CATEGORY_SLUGS } from './blog.categories.js';
import { BlogService } from './blog.service.js';
import { fontsReady } from './blog-cover.js';
import { feedXml, renderBlogIndex, renderBlogPost, sitemapXml } from './blog-ssr.js';

export interface RenderedPage {
  body: string;
  contentType: string;
  status: number;
  cacheControl: string;
}

/** Caminhos do site que a API responde com HTML/XML pronto (ver web-app.ts). */
export function isBlogPagePath(path: string): boolean {
  return path === '/blog' || path === '/sitemap.xml' || path === '/blog/feed.xml' || /^\/blog\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(path);
}

/**
 * Páginas do blog, sitemap e feed renderizados pela API. Qualquer falha
 * (banco fora, post inexistente) devolve `null` e a SPA assume, como em
 * qualquer outra rota.
 */
export class BlogPages {
  private readonly blog: BlogService;

  constructor(private readonly services: AppServices) {
    this.blog = new BlogService(services);
    // Descobre já na subida se há fonte para as capas geradas (as páginas consultam o resultado).
    void fontsReady();
  }

  async render(path: string, rawUrl: string, template: string, landingLastmod: string): Promise<RenderedPage | { redirect: string } | { unavailable: true } | null> {
    try {
      if (path === '/sitemap.xml') {
        const [posts, facets] = await Promise.all([this.blog.allPublished(), this.blog.facets()]);
        return { body: sitemapXml(posts, landingLastmod, Object.fromEntries(facets.categories.map((category) => [category.slug, category.count]))), contentType: 'application/xml; charset=utf-8', status: 200, cacheControl: 'public, max-age=600' };
      }
      if (path === '/blog/feed.xml') {
        const posts = await this.blog.allPublished(30);
        return { body: feedXml(posts), contentType: 'application/rss+xml; charset=utf-8', status: 200, cacheControl: 'public, max-age=600' };
      }
      const htmlCache = 'public, max-age=120, stale-while-revalidate=600';
      if (path === '/blog') {
        const query = new URL(rawUrl, 'http://x').searchParams;
        const categoria = query.get('categoria');
        if (categoria !== null && !BLOG_CATEGORY_SLUGS.includes(categoria)) {
          // Categoria inexistente ou com maiúsculas: a lista inteira ou a categoria certa, por 301.
          const lowered = categoria.toLowerCase();
          query.delete('categoria');
          if (BLOG_CATEGORY_SLUGS.includes(lowered)) query.set('categoria', lowered);
          const rest = query.toString();
          return { redirect: `/blog${rest ? `?${rest}` : ''}` };
        }
        const category = categoria;
        const mes = query.get('mes');
        const month = mes && /^\d{4}-(0[1-9]|1[0-2])$/.test(mes) ? mes : null;
        const q = query.get('q')?.trim().slice(0, 100) || null;
        const page = Math.max(1, Math.min(200, Number(query.get('pagina') ?? 1) || 1));
        // "?pagina=1" (ou inválido) é a própria lista: 301 para o endereço limpo.
        if (query.has('pagina') && page === 1) {
          query.delete('pagina');
          const rest = query.toString();
          return { redirect: `/blog${rest ? `?${rest}` : ''}` };
        }
        const [list, facets] = await Promise.all([
          this.blog.listPublished({ ...(category ? { category } : {}), ...(month ? { month } : {}), ...(q ? { q } : {}), page, pageSize: 12 }),
          this.blog.facets(),
        ]);
        // Página além da última: 301 para a última (sem "pagina" quando é a primeira).
        const pages = Math.max(1, Math.ceil(list.total / list.pageSize));
        if (page > pages) {
          query.delete('pagina');
          if (pages > 1) query.set('pagina', String(pages));
          const rest = query.toString();
          return { redirect: `/blog${rest ? `?${rest}` : ''}` };
        }
        return { body: renderBlogIndex(template, { ...list, category, month, q, facets }), contentType: 'text/html; charset=utf-8', status: 200, cacheControl: htmlCache };
      }
      const slug = path.slice('/blog/'.length);
      const post = await this.blog.getPublished(slug);
      if (!post) return null;
      const related = await this.blog.related(post);
      // O HTML do servidor é sempre o de quem não tem conta (o cookie de sessão
      // não chega aqui); a aplicação troca pelo post inteiro quando há sessão.
      return { body: renderBlogPost(template, this.blog.forReader(post, false), related), contentType: 'text/html; charset=utf-8', status: 200, cacheControl: htmlCache };
    } catch (error) {
      // Banco fora não é "post não existe": 503 pede ao buscador para voltar depois sem tirar a página do índice.
      this.services.logger?.error({ err: error, path }, 'página do blog não renderizada');
      return { unavailable: true };
    }
  }
}
