import { BLOG_CATEGORIES, blogCategory } from './blog.categories.js';
import type { BlogPostView } from './blog.service.js';
import { fontsKnownMissing } from './blog-cover.js';
import { escapeHtml, previewHtml } from './markdown.js';

/**
 * Páginas do blog já renderizadas para quem não executa JavaScript: o Google
 * (que indexa o HTML inicial primeiro), o Bing, e as prévias de link do
 * WhatsApp, Telegram e LinkedIn. A API monta o HTML a partir do `index.html`
 * do build (mesmos CSS e scripts), troca as metatags e põe o conteúdo dentro
 * de `#root`; a aplicação React assume em seguida, sem pedir o post de novo
 * (ele vai junto em `#blog-data`).
 */

const SITE = 'https://estoquesimples.com.br';
const SITE_NAME = 'Estoque Simples';
const DEFAULT_IMAGE = `${SITE}/og.jpg`;
const BLOG_TITLE = 'Blog do Estoque Simples: dicas de estoque, vendas e gestão';
const BLOG_DESCRIPTION = 'Dicas práticas de controle de estoque, vendas e gestão para pequenos negócios, mais as novidades do Estoque Simples. Novos posts toda semana.';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples';

/**
 * Endereço canônico do post: sempre no domínio público, independente de
 * `WEB_APP_URL` (que serve para links de push e e-mail e pode apontar para
 * outro host em homologação). Canonical, sitemap e JSON-LD precisam
 * concordar entre si.
 */
export function postUrl(post: Pick<BlogPostView, 'slug'>): string {
  return `${SITE}/blog/${post.slug}`;
}

/** Título da aba/SERP: a marca só entra quando cabe nos ~60 caracteres que o Google mostra. */
function pageTitle(base: string): string {
  return base.length <= 42 && !/estoque simples/i.test(base) ? `${base} | Estoque Simples` : base;
}

export interface HeadMeta {
  title: string;
  description: string;
  canonical: string;
  type: 'website' | 'article';
  image: string;
  imageAlt: string;
  jsonLd: unknown[];
  article?: { publishedAt: string; modifiedAt: string; section: string; tags: string[] };
  noindex?: boolean;
}

function dateLong(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('pt-BR', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Sao_Paulo' });
}

function dateShort(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'America/Sao_Paulo' }).replace('.', '');
}

/** Substitui as metatags do index.html pelas da página. */
export function applyHead(template: string, meta: HeadMeta): string {
  const e = escapeHtml;
  let html = template
    .replace(/<title>[^<]*<\/title>/, `<title>${e(meta.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*" \/>/, `<meta name="description" content="${e(meta.description)}" />`)
    .replace(/<link rel="canonical" href="[^"]*" \/>/, `<link rel="canonical" href="${e(meta.canonical)}" />`)
    .replace(/<meta property="og:type" content="[^"]*" \/>/, `<meta property="og:type" content="${meta.type}" />`)
    .replace(/<meta property="og:url" content="[^"]*" \/>/, `<meta property="og:url" content="${e(meta.canonical)}" />`)
    .replace(/<meta property="og:title" content="[^"]*" \/>/, `<meta property="og:title" content="${e(meta.title)}" />`)
    .replace(/<meta property="og:description" content="[^"]*" \/>/, `<meta property="og:description" content="${e(meta.description)}" />`)
    .replace(/<meta property="og:image" content="[^"]*" \/>/, `<meta property="og:image" content="${e(meta.image)}" />`)
    .replace(/<meta property="og:image:alt" content="[^"]*" \/>/, `<meta property="og:image:alt" content="${e(meta.imageAlt)}" />`);
  // O JSON-LD do aplicativo é da página inicial; aqui entram os da página.
  html = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
  // Pré-carregamentos de partes que um artigo não usa (chat de suporte,
  // aviso de cookies): disputariam banda com a capa e o CSS; carregam
  // quando o código os importar.
  html = html.replace(/\s*<link rel="modulepreload"[^>]*\/assets\/(CookieConsent|SupportChat|support-chat)[^>]*>/g, '');
  const extra = [
    meta.noindex ? '<meta name="robots" content="noindex, follow" />' : '<meta name="robots" content="max-image-preview:large" />',
    `<link rel="alternate" type="application/rss+xml" title="Blog do Estoque Simples" href="${SITE}/blog/feed.xml" />`,
    meta.article
      ? [
          `<meta property="article:published_time" content="${e(meta.article.publishedAt)}" />`,
          `<meta property="article:modified_time" content="${e(meta.article.modifiedAt)}" />`,
          `<meta property="article:section" content="${e(meta.article.section)}" />`,
          `<meta property="article:author" content="${SITE}/" />`,
          ...meta.article.tags.map((tag) => `<meta property="article:tag" content="${e(tag)}" />`),
        ].join('\n    ')
      : '',
    `<meta name="twitter:title" content="${e(meta.title)}" />`,
    `<meta name="twitter:description" content="${e(meta.description)}" />`,
    `<meta name="twitter:image" content="${e(meta.image)}" />`,
    ...meta.jsonLd.map((item) => `<script type="application/ld+json">${JSON.stringify(item).replace(/</g, '\\u003c')}</script>`),
  ]
    .filter(Boolean)
    .join('\n    ');
  return html.replace('</head>', `    ${extra}\n  </head>`);
}

function organization() {
  return {
    '@type': 'Organization',
    '@id': `${SITE}/#org`,
    name: SITE_NAME,
    url: SITE,
    logo: { '@type': 'ImageObject', url: `${SITE}/icon-512.png`, width: 512, height: 512 },
    sameAs: [PLAY_STORE_URL],
  };
}

/** Autor dos posts: a equipe, entidade própria ligada à organização que publica. */
function author(name: string) {
  return { '@type': 'Organization', '@id': `${SITE}/#equipe`, name, url: SITE, parentOrganization: { '@id': `${SITE}/#org` } };
}

function breadcrumb(items: Array<{ name: string; url: string }>) {
  return {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((item, index) => ({ '@type': 'ListItem', position: index + 1, name: item.name, item: item.url })),
  };
}

function imageOf(post: BlogPostView): string {
  // Sem fonte no servidor a capa gerada não existe: a imagem padrão entra direto, sem redirecionamento.
  if (!post.coverUrl || (post.coverAuto && fontsKnownMissing())) return DEFAULT_IMAGE;
  return `${SITE}${post.coverUrl}`;
}

function imageObject(post: BlogPostView) {
  return { '@type': 'ImageObject', url: imageOf(post), width: 1200, height: 630 };
}

/** Capa gerada: as três proporções que o Google recomenda; capa enviada: só a 16:9. */
function imageList(post: BlogPostView) {
  if (!post.coverAuto || !post.coverUrl || fontsKnownMissing()) return imageObject(post);
  const base = `${SITE}${post.coverUrl.replace(/\.webp$/, '')}`;
  return [imageObject(post), { '@type': 'ImageObject', url: `${base}-4x3.webp`, width: 1200, height: 900 }, { '@type': 'ImageObject', url: `${base}-1x1.webp`, width: 1200, height: 1200 }];
}

/** Cartão de um post na listagem (mesma estrutura do componente React). */
function postCard(post: BlogPostView, heading: 'h2' | 'h3' = 'h2', options: { eager?: boolean } = {}): string {
  const e = escapeHtml;
  // Os primeiros cartões ficam acima da dobra: a imagem deles é o maior elemento pintado (LCP).
  const loading = options.eager ? 'loading="eager" fetchpriority="high"' : 'loading="lazy"';
  return `<article class="blog-card">
  <a class="blog-card__link" href="/blog/${e(post.slug)}">
    ${post.coverUrl && !(post.coverAuto && fontsKnownMissing()) ? `<img class="blog-card__cover" src="${e(post.coverUrl)}" alt="${e(post.coverAlt ?? '')}" ${loading} decoding="async" width="1200" height="630">` : `<div class="blog-card__cover blog-card__cover--placeholder" aria-hidden="true"><span>${e(post.category.label)}</span></div>`}
    <div class="blog-card__body">
      <div class="blog-card__meta"><span class="blog-card__category">${e(post.category.label)}</span>${post.membersOnly ? '<span class="blog-card__lock" title="Exclusivo para quem tem conta">🔒 Exclusivo</span>' : ''}<time datetime="${e(post.publishedAt ?? '')}">${e(dateShort(post.publishedAt))}</time><span>${post.readingMinutes} min de leitura</span></div>
      <${heading} class="blog-card__title">${e(post.title)}</${heading}>
      <p class="blog-card__excerpt">${e(post.excerpt)}</p>
    </div>
  </a>
</article>`;
}

/** Convite para quem não tem conta, no lugar do resto de um post exclusivo. */
function paywall(post: BlogPostView): string {
  const next = encodeURIComponent(`/blog/${post.slug}`);
  return `<aside class="blog-post__locked" aria-label="Conteúdo exclusivo">
      <div class="blog-post__locked-icon" aria-hidden="true">🔒</div>
      <h2>Continue lendo com uma conta grátis</h2>
      <p>Este post é exclusivo para quem usa o Estoque Simples. A conta é gratuita e leva um minuto; com ela você lê todos os posts do blog, inteiros.</p>
      <p class="blog-post__locked-actions"><a class="btn btn--primary" href="/criar-conta?next=${next}">Criar conta grátis</a> <a class="btn btn--secondary" href="/entrar?next=${next}">Já tenho conta</a></p>
    </aside>`;
}

function shell(inner: string, authedHint = false): string {
  // A barra do site: igual à das outras páginas públicas (a React troca o botão por "Abrir meu estoque" quando há sessão).
  return `<div class="blog" data-ssr="blog">
<header class="landing__nav">
  <a href="/" class="row strong" style="gap:10px;color:var(--text)"><img src="/icon.svg" alt="" width="28" height="28" style="border-radius:7px"> Estoque Simples</a>
  <span class="spacer"></span>
  <a href="${authedHint ? '/app' : '/entrar'}" class="btn btn--secondary btn--sm">Entrar</a>
</header>
${inner}
<footer class="blog-footer"><div class="blog-footer__inner"><span>© Estoque Simples</span><nav aria-label="Rodapé"><a href="/">Início</a><a href="/plataformas">Onde usar</a><a href="/ajuda">Central de ajuda</a><a href="/termos">Termos de Uso</a><a href="/privacidade">Política de Privacidade</a><a href="/blog/feed.xml">RSS</a></nav></div></footer>
</div>`;
}

export interface BlogIndexData {
  items: BlogPostView[];
  total: number;
  page: number;
  pageSize: number;
  category: string | null;
  month: string | null;
  q: string | null;
  facets: { months: Array<{ month: string; count: number }>; categories: Array<{ slug: string; label: string; description: string; count: number }> };
}

export function renderBlogIndex(template: string, data: BlogIndexData): string {
  const e = escapeHtml;
  const category = data.category ? blogCategory(data.category) : null;
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const params = new URLSearchParams();
  if (data.category) params.set('categoria', data.category);
  if (data.month) params.set('mes', data.month);
  if (data.q) params.set('q', data.q);
  const pageUrl = (page: number) => {
    const p = new URLSearchParams(params);
    if (page > 1) p.set('pagina', String(page));
    const query = p.toString();
    return `${SITE}/blog${query ? `?${query}` : ''}`;
  };
  const baseTitle = category ? `${category.label}: dicas e guias | Blog do Estoque Simples` : BLOG_TITLE;
  const baseDescription = category ? category.description : BLOG_DESCRIPTION;
  // Cada página da lista é um endereço próprio: título e descrição dizem qual.
  const title = data.page > 1 ? `${baseTitle} – Página ${data.page}` : baseTitle;
  const description = data.page > 1 ? `${baseDescription} Página ${data.page} de ${pages}.` : baseDescription;
  const canonical = pageUrl(data.page);
  const posts = data.items.map((post) => ({
    '@type': 'BlogPosting',
    '@id': `${postUrl(post)}#post`,
    headline: post.title,
    url: postUrl(post),
    datePublished: post.publishedAt,
    dateModified: post.updatedAt,
    image: imageObject(post),
    author: author(post.authorName),
  }));
  const head: HeadMeta = {
    title,
    description,
    canonical,
    type: 'website',
    image: DEFAULT_IMAGE,
    imageAlt: 'Blog do Estoque Simples',
    noindex: Boolean(data.q || data.month) || data.items.length === 0,
    jsonLd: [
      category
        ? {
            '@context': 'https://schema.org',
            '@type': 'CollectionPage',
            '@id': `${canonical}#page`,
            url: canonical,
            name: title,
            description,
            inLanguage: 'pt-BR',
            isPartOf: { '@type': 'Blog', '@id': `${SITE}/blog#blog`, name: 'Blog do Estoque Simples', url: `${SITE}/blog` },
            publisher: organization(),
            hasPart: posts,
          }
        : {
            '@context': 'https://schema.org',
            '@type': 'Blog',
            '@id': `${SITE}/blog#blog`,
            name: 'Blog do Estoque Simples',
            description: BLOG_DESCRIPTION,
            url: `${SITE}/blog`,
            inLanguage: 'pt-BR',
            publisher: organization(),
            blogPost: posts,
          },
      breadcrumb([{ name: 'Início', url: `${SITE}/` }, { name: 'Blog', url: `${SITE}/blog` }, ...(category ? [{ name: category.label, url: canonical }] : [])]),
    ],
  };

  // Só categorias com post (ou a selecionada): não se linka de todo lugar para páginas vazias.
  const counts = new Map(data.facets.categories.map((item) => [item.slug, item.count]));
  const chips = [{ slug: '', label: 'Todos' }, ...BLOG_CATEGORIES.filter((item) => (counts.get(item.slug) ?? 0) > 0 || item.slug === data.category)]
    .map((item) => {
      const active = (data.category ?? '') === item.slug;
      const href = item.slug ? `/blog?categoria=${item.slug}` : '/blog';
      return `<a class="chip${active ? ' active' : ''}" href="${href}"${active ? ' aria-current="page"' : ''}>${e(item.label)}</a>`;
    })
    .join('');
  const pagination =
    pages > 1
      ? `<nav class="blog-pagination" aria-label="Páginas">${data.page > 1 ? `<a class="btn btn--secondary btn--sm" rel="prev" href="${e(pageUrl(data.page - 1))}">Mais recentes</a>` : ''}<span class="muted">Página ${data.page} de ${pages}</span>${data.page < pages ? `<a class="btn btn--secondary btn--sm" rel="next" href="${e(pageUrl(data.page + 1))}">Mais antigos</a>` : ''}</nav>`
      : '';
  const inner = `<main class="blog-page">
  <nav class="blog-breadcrumb" aria-label="Você está em"><a href="/">Início</a><span aria-hidden="true">›</span>${category ? `<a href="/blog">Blog</a><span aria-hidden="true">›</span><span aria-current="page">${e(category.label)}</span>` : '<span aria-current="page">Blog</span>'}</nav>
  <header class="blog-hero"><p class="blog-hero__kicker">Blog</p><h1 class="blog-hero__title">${e(category ? category.label : 'Dicas de estoque, vendas e gestão para o seu negócio')}</h1><p class="blog-hero__lead">${e(description)}</p></header>
  <div class="blog-filters"><div class="chips">${chips}</div></div>
  ${data.items.length === 0 ? '<p class="blog-empty">Nenhum post por aqui ainda.</p>' : `<div class="blog-grid">${data.items.map((post, index) => postCard(post, 'h2', { eager: index < 2 })).join('\n')}</div>`}
  ${pagination}
</main>`;
  const linkTags = [data.page > 1 ? `<link rel="prev" href="${e(pageUrl(data.page - 1))}" />` : '', data.page < pages ? `<link rel="next" href="${e(pageUrl(data.page + 1))}" />` : ''].filter(Boolean).join('\n    ');
  const dataScript = `<script id="blog-data" type="application/json">${JSON.stringify({ kind: 'index', ...data }).replace(/</g, '\\u003c')}</script>`;
  return applyHead(template, head)
    .replace('</head>', `    ${linkTags}\n  </head>`)
    .replace('<div id="root"></div>', `<div id="root">${shell(inner)}</div>\n    ${dataScript}`);
}

export function renderBlogPost(template: string, post: BlogPostView, related: BlogPostView[]): string {
  const e = escapeHtml;
  const title = pageTitle(post.seoTitle ?? post.title);
  const url = postUrl(post);
  const publishedAt = post.publishedAt ?? post.createdAt;
  // Data de atualização visível só quando é outro dia: o JSON-LD e a página precisam contar a mesma história.
  const updatedVisible = post.updatedAt.slice(0, 10) > publishedAt.slice(0, 10);
  const head: HeadMeta = {
    title,
    description: post.excerpt,
    canonical: url,
    type: 'article',
    image: imageOf(post),
    imageAlt: post.coverAlt ?? post.title,
    article: { publishedAt, modifiedAt: post.updatedAt, section: post.category.label, tags: post.tags },
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        '@id': `${url}#post`,
        mainEntityOfPage: { '@type': 'WebPage', '@id': url },
        url,
        headline: post.title,
        alternativeHeadline: post.seoTitle ?? undefined,
        description: post.excerpt,
        image: imageList(post),
        datePublished: publishedAt,
        dateModified: post.updatedAt,
        author: author(post.authorName),
        publisher: organization(),
        articleSection: post.category.label,
        keywords: post.tags.join(', '),
        wordCount: post.contentHtml.replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length,
        inLanguage: 'pt-BR',
        // Post exclusivo: o Google indexa o começo e sabe que o resto pede conta (markup de conteúdo com acesso restrito).
        isAccessibleForFree: !post.membersOnly,
        ...(post.membersOnly ? { hasPart: { '@type': 'WebPageElement', isAccessibleForFree: false, cssSelector: '.blog-post__locked' } } : {}),
      },
      breadcrumb([
        { name: 'Início', url: `${SITE}/` },
        { name: 'Blog', url: `${SITE}/blog` },
        { name: post.category.label, url: `${SITE}/blog?categoria=${post.category.slug}` },
        { name: post.title, url },
      ]),
      ...(post.faq.length > 0
        ? [
            {
              '@context': 'https://schema.org',
              '@type': 'FAQPage',
              mainEntity: post.faq.map((item) => ({ '@type': 'Question', name: item.question, acceptedAnswer: { '@type': 'Answer', text: item.answer } })),
            },
          ]
        : []),
    ],
  };
  const faq =
    post.faq.length > 0
      ? `<section class="blog-faq" aria-labelledby="faq-titulo"><h2 id="faq-titulo">Perguntas frequentes</h2>${post.faq.map((item) => `<details class="blog-faq__item"><summary>${e(item.question)}</summary><p>${e(item.answer)}</p></details>`).join('')}</section>`
      : '';
  const relatedHtml =
    related.length > 0 ? `<section class="blog-related" aria-labelledby="related-titulo"><h2 id="related-titulo">Leia também</h2><div class="blog-grid blog-grid--related">${related.map((item) => postCard(item, 'h3')).join('')}</div></section>` : '';
  const inner = `<main class="blog-page blog-page--post">
  <nav class="blog-breadcrumb" aria-label="Você está em"><a href="/">Início</a><span aria-hidden="true">›</span><a href="/blog">Blog</a><span aria-hidden="true">›</span><a href="/blog?categoria=${e(post.category.slug)}">${e(post.category.label)}</a></nav>
  <article class="blog-post">
    <header class="blog-post__header">
      <a class="blog-card__category" href="/blog?categoria=${e(post.category.slug)}">${e(post.category.label)}</a>
      <h1 class="blog-post__title">${e(post.title)}</h1>
      <p class="blog-post__excerpt">${e(post.excerpt)}</p>
      <div class="blog-post__meta"><a class="blog-post__author" href="/" rel="author"><img src="/icon.svg" alt="" width="28" height="28"> ${e(post.authorName)}</a><time datetime="${e(publishedAt)}">${e(dateLong(publishedAt))}</time>${updatedVisible ? `<span>Atualizado em <time datetime="${e(post.updatedAt)}">${e(dateLong(post.updatedAt))}</time></span>` : ''}<span>${post.readingMinutes} min de leitura</span></div>
    </header>
    ${post.coverUrl && !(post.coverAuto && fontsKnownMissing()) ? `<img class="blog-post__cover" src="${e(post.coverUrl)}" alt="${e(post.coverAlt ?? post.title)}" width="1200" height="630" decoding="async" fetchpriority="high">` : ''}
    <div class="blog-post__content${post.locked ? ' blog-post__content--locked' : ''}">${post.contentHtml}</div>
    ${post.locked ? paywall(post) : ''}
    ${post.tags.length > 0 ? `<ul class="blog-post__tags" aria-label="Assuntos">${post.tags.map((tag) => `<li>${e(tag)}</li>`).join('')}</ul>` : ''}
    ${faq}
    <aside class="blog-cta" aria-label="Experimente o Estoque Simples"><p class="blog-cta__title">Controle o seu estoque pelo celular e pelo computador</p><p>O Estoque Simples é grátis para uma pessoa. Cadastre produtos, lance entradas e saídas e saiba o que está acabando.</p><a class="btn btn--primary" href="/criar-conta">Criar conta grátis</a> <a class="btn btn--secondary" href="/plataformas">Onde usar</a></aside>
  </article>
  ${relatedHtml}
</main>`;
  // O HTML do post já está na página; a React o lê de `.blog-post__content` em vez de carregá-lo duas vezes.
  const dataScript = `<script id="blog-data" type="application/json">${JSON.stringify({ kind: 'post', post: { ...post, contentHtml: '' }, related }).replace(/</g, '\\u003c')}</script>`;
  return applyHead(template, head).replace('<div id="root"></div>', `<div id="root">${shell(inner)}</div>\n    ${dataScript}`);
}

/** Sitemap com as páginas fixas e todos os posts publicados. */
export function sitemapXml(posts: BlogPostView[], landingLastmod: string, categoryCounts: Record<string, number> = {}): string {
  // Última alteração de cada lista: o post mais recentemente atualizado nela.
  const latest = (items: BlogPostView[]) => items.reduce<string | null>((max, post) => (max && max > post.updatedAt ? max : post.updatedAt), null)?.slice(0, 10);
  const fixed = [
    { loc: `${SITE}/`, lastmod: landingLastmod, priority: '1.0' },
    { loc: `${SITE}/blog`, lastmod: latest(posts) ?? landingLastmod, priority: '0.8' },
    { loc: `${SITE}/plataformas`, priority: '0.6' },
    { loc: `${SITE}/ajuda`, priority: '0.6' },
    { loc: `${SITE}/termos`, priority: '0.2' },
    { loc: `${SITE}/privacidade`, priority: '0.2' },
    // Só categorias com post: uma categoria vazia seria um "soft 404" no sitemap.
    ...BLOG_CATEGORIES.filter((category) => (categoryCounts[category.slug] ?? 0) > 0).map((category) => ({ loc: `${SITE}/blog?categoria=${category.slug}`, lastmod: latest(posts.filter((post) => post.category.slug === category.slug)), priority: '0.5' })),
  ];
  const urls = [
    ...fixed.map((item) => `  <url><loc>${item.loc}</loc>${'lastmod' in item && item.lastmod ? `<lastmod>${item.lastmod}</lastmod>` : ''}<priority>${item.priority}</priority></url>`),
    ...posts.map((post) => `  <url><loc>${escapeHtml(postUrl(post))}</loc><lastmod>${post.updatedAt.slice(0, 10)}</lastmod><priority>0.7</priority></url>`),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join('\n')}\n</urlset>\n`;
}

export function feedXml(posts: BlogPostView[]): string {
  const e = escapeHtml;
  // Leitores de RSS não sabem a origem: links e imagens do texto saem absolutos.
  const absolute = (html: string) => html.replace(/(href|src)="\/(?!\/)/g, `$1="${SITE}/`);
  const items = posts
    .slice(0, 30)
    .map(
      (post) => `  <item>
    <title>${e(post.title)}</title>
    <link>${e(postUrl(post))}</link>
    <guid isPermaLink="true">${e(postUrl(post))}</guid>
    <pubDate>${new Date(post.publishedAt ?? post.createdAt).toUTCString()}</pubDate>
    <dc:creator>${e(post.authorName)}</dc:creator>
    <category>${e(post.category.label)}</category>
    <description>${e(post.excerpt)}</description>
    <content:encoded><![CDATA[${absolute(post.membersOnly ? `${previewHtml(post.contentHtml)}<p><a href="${postUrl(post)}">Continue lendo com uma conta grátis no Estoque Simples.</a></p>` : post.contentHtml)}]]></content:encoded>
  </item>`,
    )
    .join('\n');
  const lastBuild = posts.reduce((latest, post) => (post.updatedAt > latest ? post.updatedAt : latest), posts[0]?.updatedAt ?? new Date().toISOString());
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel>
  <title>Blog do Estoque Simples</title>
  <link>${SITE}/blog</link>
  <atom:link href="${SITE}/blog/feed.xml" rel="self" type="application/rss+xml" />
  <description>${e(BLOG_DESCRIPTION)}</description>
  <language>pt-BR</language>
  <lastBuildDate>${new Date(lastBuild).toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
}
