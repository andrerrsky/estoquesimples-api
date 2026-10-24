import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api } from '../api/client';
import { Icon, Logo } from '../components/Icon';
import { PublicShell } from '../components/PublicShell';
import { Empty, Spinner, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { useDebounced } from '../lib/inventory';
import '../styles/pages-blog.css';

/** O que a API devolve (ver apps/api/src/modules/blog). */
export interface BlogPost {
  id: string;
  slug: string;
  title: string;
  seoTitle: string | null;
  excerpt: string;
  contentHtml: string;
  category: { slug: string; label: string };
  tags: string[];
  faq: Array<{ question: string; answer: string }>;
  publishedAt: string | null;
  updatedAt: string;
  coverUrl: string | null;
  coverAuto?: boolean;
  coverAlt: string | null;
  authorName: string;
  readingMinutes: number;
  aiGenerated: boolean;
  url: string;
}

interface BlogList {
  items: BlogPost[];
  total: number;
  page: number;
  pageSize: number;
}

interface Facets {
  months: Array<{ month: string; count: number }>;
  categories: Array<{ slug: string; label: string; description: string; count: number }>;
}

const SITE_TITLE = 'Blog do Estoque Simples';
const BLOG_DESCRIPTION = 'Dicas práticas de controle de estoque, vendas e gestão para pequenos negócios, mais as novidades do Estoque Simples.';

/**
 * A API já manda a página pronta para os buscadores, com os dados em
 * `#blog-data` (ver blog-ssr.ts): a primeira renderização usa esses dados
 * em vez de pedir de novo, e a navegação seguinte vai pela API JSON.
 */
function ssrData<T>(kind: 'index' | 'post'): T | null {
  try {
    const script = document.getElementById('blog-data');
    if (!script?.textContent) return null;
    const parsed = JSON.parse(script.textContent) as { kind: string; post?: { contentHtml: string } } & T;
    if (parsed.kind !== kind) return null;
    // O HTML do post não vem repetido no JSON: ele já está na página renderizada.
    if (parsed.post && !parsed.post.contentHtml) {
      parsed.post.contentHtml = document.querySelector('[data-ssr] .blog-post__content')?.innerHTML ?? '';
    }
    return parsed;
  } catch {
    return null;
  }
}

/** Metatags para a navegação dentro da SPA (o HTML inicial já vem certo do servidor). */
function useDocumentMeta(title: string, description: string, canonical: string) {
  useEffect(() => {
    document.title = title;
    const set = (selector: string, attribute: string, value: string) => {
      const element = document.head.querySelector<HTMLElement>(selector);
      if (element) element.setAttribute(attribute, value);
    };
    set('meta[name="description"]', 'content', description);
    set('link[rel="canonical"]', 'href', canonical);
    set('meta[property="og:title"]', 'content', title);
    set('meta[property="og:description"]', 'content', description);
    set('meta[property="og:url"]', 'content', canonical);
    return () => {
      document.title = 'Estoque Simples';
    };
  }, [title, description, canonical]);
}

function fmtLong(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
}
function fmtShort(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).replace('.', '') : '';
}
function monthLabel(month: string): string {
  const [year, m] = month.split('-');
  const date = new Date(Number(year), Number(m) - 1, 1);
  const label = date.toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return label.charAt(0).toUpperCase() + label.slice(1);
}

function PostCard({ post }: { post: BlogPost }) {
  return (
    <article className="blog-card">
      <Link className="blog-card__link" to={`/blog/${post.slug}`}>
        {post.coverUrl ? (
          <img className="blog-card__cover" src={post.coverUrl} alt={post.coverAlt ?? ''} loading="lazy" decoding="async" width={1200} height={630} />
        ) : (
          <div className="blog-card__cover blog-card__cover--placeholder" aria-hidden="true">
            <span>{post.category.label}</span>
          </div>
        )}
        <div className="blog-card__body">
          <div className="blog-card__meta">
            <span className="blog-card__category">{post.category.label}</span>
            <time dateTime={post.publishedAt ?? ''}>{fmtShort(post.publishedAt)}</time>
            <span>{post.readingMinutes} min de leitura</span>
          </div>
          <h2 className="blog-card__title">{post.title}</h2>
          <p className="blog-card__excerpt">{post.excerpt}</p>
        </div>
      </Link>
    </article>
  );
}

export function BlogIndexPage() {
  const [params, setParams] = useSearchParams();
  const category = params.get('categoria') ?? '';
  const month = params.get('mes') ?? '';
  const page = Math.max(1, Number(params.get('pagina') ?? 1) || 1);
  const q = params.get('q') ?? '';
  const [search, setSearch] = useState(q);
  const debounced = useDebounced(search.trim(), 400);

  useEffect(() => {
    if (debounced !== q) {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (debounced) next.set('q', debounced);
          else next.delete('q');
          next.delete('pagina');
          return next;
        },
        { replace: true },
      );
    }
  }, [debounced, q, setParams]);

  const initial = useMemo(() => ssrData<BlogList & { category: string | null; month: string | null; q: string | null; facets: Facets }>('index'), []);
  const sameAsSsr = initial && (initial.category ?? '') === category && (initial.month ?? '') === month && (initial.q ?? '') === q && initial.page === page;

  const list = useQuery({
    queryKey: ['blog', 'posts', category, month, q, page],
    queryFn: () => api.get<BlogList>('/v1/blog/posts', { category: category || undefined, month: month || undefined, q: q || undefined, page, pageSize: 12 }, { auth: false }),
    ...(sameAsSsr ? { initialData: { items: initial.items, total: initial.total, page: initial.page, pageSize: initial.pageSize } } : {}),
    placeholderData: (previous) => previous,
  });
  const facets = useQuery({
    queryKey: ['blog', 'facets'],
    queryFn: () => api.get<Facets>('/v1/blog/facets', undefined, { auth: false }),
    ...(initial ? { initialData: initial.facets } : {}),
    staleTime: 300_000,
  });

  const current = facets.data?.categories.find((item) => item.slug === category) ?? null;
  const title = current ? `${current.label}: dicas e guias | ${SITE_TITLE}` : `${SITE_TITLE}: dicas de estoque, vendas e gestão`;
  useDocumentMeta(title, current?.description ?? BLOG_DESCRIPTION, `https://estoquesimples.com.br/blog${category ? `?categoria=${category}` : ''}`);

  const setFilter = (patch: Record<string, string | null>) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      next.delete('pagina');
      return next;
    });
  };

  const pages = Math.max(1, Math.ceil((list.data?.total ?? 0) / 12));

  return (
    <PublicShell className="blog">
      <main className="blog-page">
        <nav className="blog-breadcrumb" aria-label="Você está em">
          <Link to="/">Início</Link>
          <span aria-hidden="true">›</span>
          <span aria-current="page">Blog</span>
        </nav>
        <header className="blog-hero">
          <p className="blog-hero__kicker">Blog</p>
          <h1 className="blog-hero__title">{current ? current.label : 'Dicas de estoque, vendas e gestão para o seu negócio'}</h1>
          <p className="blog-hero__lead">{current?.description ?? BLOG_DESCRIPTION}</p>
        </header>

        <div className="blog-filters">
          <div className="chips" role="group" aria-label="Categoria">
            <button type="button" className={`chip ${!category ? 'active' : ''}`} onClick={() => setFilter({ categoria: null })}>Todos</button>
            {facets.data?.categories.filter((item) => item.count > 0 || item.slug === category).map((item) => (
              <button key={item.slug} type="button" className={`chip ${category === item.slug ? 'active' : ''}`} onClick={() => setFilter({ categoria: item.slug })} title={item.description}>
                {item.label}
                {item.count > 0 && <span className="chip__count">{item.count}</span>}
              </button>
            ))}
          </div>
          <div className="blog-filters__row">
            <label className="blog-filters__field">
              <span className="sr-only">Mês</span>
              <select className="select select--sm" value={month} onChange={(event) => setFilter({ mes: event.target.value || null })} aria-label="Filtrar por mês">
                <option value="">Todas as datas</option>
                {facets.data?.months.map((item) => (
                  <option key={item.month} value={item.month}>{monthLabel(item.month)} ({item.count})</option>
                ))}
              </select>
            </label>
            <label className="blog-filters__field blog-filters__search">
              <Icon name="search" size={16} />
              <input className="input input--sm" type="search" placeholder="Buscar no blog" value={search} onChange={(event) => setSearch(event.target.value)} aria-label="Buscar no blog" />
            </label>
          </div>
        </div>

        {list.isLoading ? (
          <Spinner label="Carregando posts…" />
        ) : list.error ? (
          <Empty icon="alert" title="Não foi possível carregar o blog">Confira a internet e tente de novo.</Empty>
        ) : (list.data?.items.length ?? 0) === 0 ? (
          <Empty icon="book" title={q || category || month ? 'Nenhum post com esses filtros' : 'Nenhum post por aqui ainda'} actions={q || category || month ? <button type="button" className="btn btn--secondary" onClick={() => { setSearch(''); setParams({}); }}>Limpar filtros</button> : undefined} />
        ) : (
          <div className="blog-grid">{list.data?.items.map((post) => <PostCard key={post.id} post={post} />)}</div>
        )}

        {pages > 1 && (
          <nav className="blog-pagination" aria-label="Páginas">
            <button type="button" className="btn btn--secondary btn--sm" disabled={page <= 1} onClick={() => setParams((prev) => { const next = new URLSearchParams(prev); if (page - 1 > 1) next.set('pagina', String(page - 1)); else next.delete('pagina'); return next; })}>
              Mais recentes
            </button>
            <span className="muted">Página {page} de {pages}</span>
            <button type="button" className="btn btn--secondary btn--sm" disabled={page >= pages} onClick={() => setParams((prev) => { const next = new URLSearchParams(prev); next.set('pagina', String(page + 1)); return next; })}>
              Mais antigos
            </button>
          </nav>
        )}
      </main>
    </PublicShell>
  );
}

export function BlogPostPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const toast = useToast();
  const initial = useMemo(() => ssrData<{ post: BlogPost; related: BlogPost[] }>('post'), []);
  const query = useQuery({
    queryKey: ['blog', 'post', slug],
    queryFn: () => api.get<{ post: BlogPost; related: BlogPost[] }>(`/v1/blog/posts/${encodeURIComponent(slug)}`, undefined, { auth: false }),
    ...(initial && initial.post.slug === slug ? { initialData: initial } : {}),
    retry: false,
  });
  const post = query.data?.post ?? null;
  const related = query.data?.related ?? [];

  // Mesma regra do servidor (blog-ssr.ts): a marca só entra quando cabe nos ~60 caracteres.
  const base = post ? (post.seoTitle ?? post.title) : SITE_TITLE;
  useDocumentMeta(post && base.length <= 42 ? `${base} | Estoque Simples` : base, post?.excerpt ?? BLOG_DESCRIPTION, post ? `https://estoquesimples.com.br/blog/${post.slug}` : 'https://estoquesimples.com.br/blog');
  useEffect(() => {
    if (post) track('blog.post_viewed', { slug: post.slug, category: post.category.slug });
  }, [post]);
  useEffect(() => {
    window.scrollTo({ top: 0 });
  }, [slug]);

  const share = async () => {
    if (!post) return;
    try {
      if (navigator.share) {
        await navigator.share({ title: post.title, text: post.excerpt, url: post.url });
      } else {
        await navigator.clipboard.writeText(post.url);
        toast.success('Link copiado.');
      }
      track('blog.post_shared', { slug: post.slug });
    } catch {
      // a pessoa fechou o menu de compartilhar
    }
  };

  if (query.isLoading) {
    return (
      <PublicShell className="blog">
        <main className="blog-page blog-page--post"><Spinner label="Carregando…" /></main>
      </PublicShell>
    );
  }
  if (!post) {
    return (
      <PublicShell className="blog">
        <main className="blog-page blog-page--post">
          <Empty icon="book" title="Post não encontrado" actions={<button type="button" className="btn btn--primary" onClick={() => navigate('/blog')}>Ver todos os posts</button>}>
            Ele pode ter sido removido ou o endereço está errado.
          </Empty>
        </main>
      </PublicShell>
    );
  }

  const whatsapp = `https://wa.me/?text=${encodeURIComponent(`${post.title} ${post.url}`)}`;
  return (
    <PublicShell className="blog">
      <main className="blog-page blog-page--post">
        <nav className="blog-breadcrumb" aria-label="Você está em">
          <Link to="/">Início</Link>
          <span aria-hidden="true">›</span>
          <Link to="/blog">Blog</Link>
          <span aria-hidden="true">›</span>
          <Link to={`/blog?categoria=${post.category.slug}`}>{post.category.label}</Link>
        </nav>
        <article className="blog-post">
          <header className="blog-post__header">
            <Link className="blog-card__category" to={`/blog?categoria=${post.category.slug}`}>{post.category.label}</Link>
            <h1 className="blog-post__title">{post.title}</h1>
            <p className="blog-post__excerpt">{post.excerpt}</p>
            <div className="blog-post__meta">
              <Link className="blog-post__author" to="/" rel="author"><Logo size={28} /> {post.authorName}</Link>
              <time dateTime={post.publishedAt ?? ''}>{fmtLong(post.publishedAt)}</time>
              {post.publishedAt && post.updatedAt.slice(0, 10) > post.publishedAt.slice(0, 10) && (
                <span>Atualizado em <time dateTime={post.updatedAt}>{fmtLong(post.updatedAt)}</time></span>
              )}
              <span>{post.readingMinutes} min de leitura</span>
              <span className="blog-post__share">
                <a className="btn btn--secondary btn--sm" href={whatsapp} target="_blank" rel="noopener noreferrer" onClick={() => track('blog.post_shared', { slug: post.slug, via: 'whatsapp' })}>
                  <Icon name="share" size={15} /> WhatsApp
                </a>
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => void share()}>
                  <Icon name="copy" size={15} /> Compartilhar
                </button>
              </span>
            </div>
          </header>
          {post.coverUrl && <img className="blog-post__cover" src={post.coverUrl} alt={post.coverAlt ?? post.title} width={1200} height={630} decoding="async" fetchPriority="high" />}
          {/* HTML gerado e limpo pela API a partir do Markdown (só as tags do blog). */}
          <div className="blog-post__content" dangerouslySetInnerHTML={{ __html: post.contentHtml }} />
          {post.tags.length > 0 && (
            <ul className="blog-post__tags" aria-label="Assuntos">
              {post.tags.map((tag) => <li key={tag}>{tag}</li>)}
            </ul>
          )}
          {post.faq.length > 0 && (
            <section className="blog-faq" aria-labelledby="faq-titulo">
              <h2 id="faq-titulo">Perguntas frequentes</h2>
              {post.faq.map((item) => (
                <details key={item.question} className="blog-faq__item">
                  <summary>{item.question}</summary>
                  <p>{item.answer}</p>
                </details>
              ))}
            </section>
          )}
          <aside className="blog-cta" aria-label="Experimente o Estoque Simples">
            <p className="blog-cta__title">Controle o seu estoque pelo celular e pelo computador</p>
            <p>O Estoque Simples é grátis para uma pessoa. Cadastre produtos, lance entradas e saídas e saiba o que está acabando.</p>
            <Link className="btn btn--primary" to="/criar-conta">Criar conta grátis</Link> <Link className="btn btn--secondary" to="/plataformas">Onde usar</Link>
          </aside>
        </article>
        {related.length > 0 && (
          <section className="blog-related" aria-labelledby="related-titulo">
            <h2 id="related-titulo">Leia também</h2>
            <div className="blog-grid blog-grid--related">{related.map((item) => <PostCard key={item.id} post={item} />)}</div>
          </section>
        )}
      </main>
    </PublicShell>
  );
}
