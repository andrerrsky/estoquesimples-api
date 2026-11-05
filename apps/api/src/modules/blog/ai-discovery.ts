import { BLOG_CATEGORIES } from './blog.categories.js';
import type { BlogPostView } from './blog.service.js';
import { postUrl } from './blog-ssr.js';
import { answerMarkdown, helpContent, type HelpArticle } from './help-content.js';
import { PRODUCT_FACT_LINES } from './product-facts.js';

/**
 * Arquivos para buscadores e assistentes de IA (ChatGPT, Claude, Perplexity,
 * Gemini, Copilot), que leem texto e não executam JavaScript:
 *
 *  - `/llms.txt`: o índice do site no formato de llmstxt.org — o que é o
 *    produto, as páginas principais e todos os posts, cada um apontando para
 *    a versão em Markdown;
 *  - `/llms-full.txt`: tudo num arquivo só — fatos do produto, a central de
 *    ajuda inteira e o texto de cada post;
 *  - `/blog/<slug>.md`: o post em Markdown limpo, sem menu nem scripts.
 *
 * Post exclusivo para quem tem conta entra só com o começo, como no HTML
 * público. Tudo vem do banco e de packages/help a cada pedido (com cache
 * curto na resposta): post novo aparece aqui no mesmo minuto.
 */

const SITE = 'https://estoquesimples.com.br';
const SUMMARY =
  'Controle de estoque para pequenos negócios brasileiros, no aplicativo Android e na versão web (estoquesimples.com.br), com os mesmos dados nos dois. Grátis para uma pessoa; plano Equipe para trabalhar em grupo.';

/** Links e imagens relativos do Markdown viram absolutos: o arquivo é lido fora do site. */
function absolute(markdown: string): string {
  return markdown.replace(/\]\(\/(?!\/)/g, `](${SITE}/`);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

/** Começo de um post exclusivo: a abertura e a primeira seção, como no HTML público (previewHtml). */
export function previewMarkdown(markdown: string): string {
  const sections = markdown.split(/\n(?=## )/);
  return sections.slice(0, Math.min(2, sections.length)).join('\n').trim();
}

export function markdownPath(post: Pick<BlogPostView, 'slug'>): string {
  return `/blog/${post.slug}.md`;
}

/** Um post em Markdown, com um cabeçalho de metadados que um assistente consegue citar. */
export function postMarkdown(post: BlogPostView): string {
  const url = postUrl(post);
  const body = post.contentMd ?? '';
  const locked = post.membersOnly;
  const published = day(post.publishedAt ?? post.createdAt);
  const updated = day(post.updatedAt);
  const lines = [
    `# ${post.title}`,
    '',
    `> ${post.excerpt}`,
    '',
    `- Endereço: ${url}`,
    `- Publicado em: ${published}${updated > published ? ` (atualizado em ${updated})` : ''}`,
    `- Categoria: ${post.category.label}${post.tags.length > 0 ? ` · Assuntos: ${post.tags.join(', ')}` : ''}`,
    `- Autoria: ${post.authorName} (${SITE})`,
    '',
    absolute(locked ? previewMarkdown(body) : body).trim(),
  ];
  if (locked) {
    lines.push('', `*Este post continua para quem tem conta grátis no Estoque Simples: ${url}*`);
  } else if (post.faq.length > 0) {
    lines.push('', '## Perguntas frequentes', '');
    for (const item of post.faq) lines.push(`### ${item.question}`, '', item.answer, '');
  }
  lines.push('', '---', `Fonte: Blog do Estoque Simples, ${url}`);
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

const PAGES: Array<{ title: string; path: string; about: string }> = [
  { title: 'Página inicial', path: '/', about: 'o que é o Estoque Simples, recursos, planos e como começar' },
  { title: 'Onde usar', path: '/plataformas', about: 'app Android, navegador no computador e iPhone ou iPad como web app na tela inicial' },
  { title: 'Central de ajuda', path: '/ajuda', about: 'perguntas e respostas sobre uso, sincronização, equipe, plano e pagamento' },
  { title: 'Criar conta grátis', path: '/criar-conta', about: 'cadastro na versão web; a mesma conta vale no app Android' },
  { title: 'Blog', path: '/blog', about: 'dicas de controle de estoque, vendas e gestão para pequenos negócios' },
];

function visibleOnWeb(article: HelpArticle): boolean {
  return !article.platforms || article.platforms.includes('web');
}

/** `/llms.txt`: o índice para assistentes de IA. */
export function llmsTxt(posts: BlogPostView[]): string {
  const help = helpContent();
  const lines = [
    '# Estoque Simples',
    '',
    `> ${SUMMARY}`,
    '',
    'Site oficial do Estoque Simples. Cada post do blog também existe em Markdown (o mesmo endereço terminado em `.md`), e o texto completo de tudo está em [llms-full.txt](' + SITE + '/llms-full.txt).',
    '',
    '## Sobre o produto',
    '',
    ...PRODUCT_FACT_LINES.map((line) => `- ${line}`),
    '',
    '## Páginas principais',
    '',
    ...PAGES.map((page) => `- [${page.title}](${SITE}${page.path}): ${page.about}`),
  ];
  if (help.categories.length > 0) {
    lines.push('', '## Central de ajuda', '', `Respostas completas em [llms-full.txt](${SITE}/llms-full.txt) e em [${SITE}/ajuda](${SITE}/ajuda).`, '');
    for (const category of help.categories) {
      const count = help.articles.filter((article) => article.category === category.id && visibleOnWeb(article)).length;
      if (count > 0) lines.push(`- ${category.title}: ${category.summary} (${count} ${count === 1 ? 'pergunta' : 'perguntas'})`);
    }
  }
  if (posts.length > 0) {
    lines.push('', '## Blog', '');
    for (const category of BLOG_CATEGORIES) {
      const inCategory = posts.filter((post) => post.category.slug === category.slug);
      if (inCategory.length === 0) continue;
      lines.push(`### ${category.label}`, '');
      for (const post of inCategory) lines.push(`- [${post.title}](${SITE}${markdownPath(post)}): ${post.excerpt}`);
      lines.push('');
    }
  }
  lines.push(
    '## Opcional',
    '',
    `- [Texto completo para IAs](${SITE}/llms-full.txt): fatos do produto, central de ajuda e todos os posts`,
    `- [Feed RSS do blog](${SITE}/blog/feed.xml)`,
    `- [Sitemap](${SITE}/sitemap.xml)`,
    `- [Termos de Uso](${SITE}/termos)`,
    `- [Política de Privacidade](${SITE}/privacidade)`,
    `- [App na Google Play](https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples)`,
  );
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

/** `/llms-full.txt`: produto, ajuda e posts num arquivo só. */
export function llmsFullTxt(posts: BlogPostView[]): string {
  const help = helpContent();
  const parts = [
    `# Estoque Simples: texto completo para assistentes de IA\n\n> ${SUMMARY}\n\nFonte: ${SITE}. Índice resumido em ${SITE}/llms.txt.`,
    `## Sobre o produto\n\n${PRODUCT_FACT_LINES.map((line) => `- ${line}`).join('\n')}`,
  ];
  const articles = help.articles.filter(visibleOnWeb);
  if (articles.length > 0) {
    const blocks = [`## Central de ajuda\n\nPerguntas e respostas oficiais (${SITE}/ajuda)${help.updatedAt ? `, revisadas em ${help.updatedAt}` : ''}.`];
    for (const category of help.categories) {
      const inCategory = articles.filter((article) => article.category === category.id);
      if (inCategory.length === 0) continue;
      blocks.push(`### ${category.title}\n\n${inCategory.map((article) => `#### ${article.question}\n\n${answerMarkdown(article)}`).join('\n\n')}`);
    }
    parts.push(blocks.join('\n\n'));
  }
  if (posts.length > 0) {
    parts.push(`## Blog\n\n${posts.length} ${posts.length === 1 ? 'post publicado' : 'posts publicados'}, do mais novo ao mais antigo.`);
    // Dentro do arquivo único, cada post desce um nível ("# " vira "### ").
    for (const post of posts) parts.push(postMarkdown(post).replace(/^(#{1,4}) /gm, (_, hashes: string) => `${'#'.repeat(Math.min(6, hashes.length + 2))} `).trim());
  }
  return `${parts.join('\n\n---\n\n')}\n`;
}
