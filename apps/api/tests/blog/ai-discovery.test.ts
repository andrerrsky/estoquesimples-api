import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { llmsTxt, postMarkdown, previewMarkdown } from '../../src/modules/blog/ai-discovery.js';
import { isPublicAppPage, privateAppHtml, publicPageHtml } from '../../src/modules/blog/public-pages.js';
import { createTestApp, resetDatabase, type TestContext } from '../helpers/test-app.js';

const WEB = { host: 'web.test' };

let context: TestContext;

beforeAll(async () => {
  context = await createTestApp();
});

afterAll(async () => {
  await context.close();
});

beforeEach(async () => {
  await resetDatabase(context);
});

const MD = [
  'Abertura que responde a dúvida: conte o estoque toda semana. Veja também [o guia de estoque mínimo](/blog/estoque-minimo).',
  '',
  '## Primeira seção',
  '',
  'Texto da primeira seção.',
  '',
  '## Segunda seção',
  '',
  'Conteúdo que só quem tem conta lê.',
].join('\n');

async function insertPost(slug: string, options: { membersOnly?: boolean; status?: 'published' | 'draft' } = {}): Promise<void> {
  const faq = JSON.stringify([{ question: 'Com que frequência contar?', answer: 'Uma vez por semana nos itens que mais vendem.' }]);
  await context.services.db.execute(sql`
    INSERT INTO blog_posts (slug, title, excerpt, content_md, content_html, category, status, published_at, faq, tags, members_only)
    VALUES (${slug}, ${`Título de ${slug}`}, ${'Resumo do post para o teste de IA.'}, ${MD}, ${'<p>Abertura</p><h2>Primeira seção</h2><p>Texto</p><h2>Segunda seção</h2><p>Conteúdo</p>'},
            'gestao-do-negocio', ${options.status ?? 'published'}, now(), ${faq}::jsonb, '["estoque","contagem"]'::jsonb, ${options.membersOnly ?? false})`);
}

describe('arquivos para assistentes de IA', () => {
  it('llms.txt lista o produto, as páginas, a ajuda e os posts publicados com link para o Markdown', async () => {
    await insertPost('contagem-de-estoque');
    await insertPost('rascunho-secreto', { status: 'draft' });
    const response = await context.app.inject({ method: 'GET', url: '/llms.txt', headers: WEB });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    const body = response.body;
    expect(body.startsWith('# Estoque Simples\n\n> ')).toBe(true);
    expect(body).toContain('## Sobre o produto');
    expect(body).toContain('[Central de ajuda](https://estoquesimples.com.br/ajuda)');
    expect(body).toContain('## Central de ajuda');
    expect(body).toContain('[Título de contagem-de-estoque](https://estoquesimples.com.br/blog/contagem-de-estoque.md)');
    expect(body).not.toContain('rascunho-secreto');
  });

  it('llms-full.txt traz a ajuda inteira e o texto dos posts, com títulos rebaixados', async () => {
    await insertPost('contagem-de-estoque');
    const body = (await context.app.inject({ method: 'GET', url: '/llms-full.txt', headers: WEB })).body;
    expect(body).toContain('#### O que é o Estoque Simples?');
    expect(body).toContain('### Título de contagem-de-estoque');
    expect(body).toContain('#### Segunda seção');
    expect(body).toContain('](https://estoquesimples.com.br/blog/estoque-minimo)');
  });

  it('o post em Markdown: metadados, links absolutos, FAQ, canonical e noindex; exclusivo só com o começo', async () => {
    await insertPost('contagem-de-estoque');
    await insertPost('so-com-conta', { membersOnly: true });

    const open = await context.app.inject({ method: 'GET', url: '/blog/contagem-de-estoque.md', headers: WEB });
    expect(open.statusCode).toBe(200);
    expect(open.headers['content-type']).toContain('text/markdown');
    expect(open.headers['x-robots-tag']).toBe('noindex, follow');
    expect(open.headers.link).toBe('<https://estoquesimples.com.br/blog/contagem-de-estoque>; rel="canonical"');
    expect(open.body).toContain('# Título de contagem-de-estoque');
    expect(open.body).toContain('- Endereço: https://estoquesimples.com.br/blog/contagem-de-estoque');
    expect(open.body).toContain('Conteúdo que só quem tem conta lê.');
    expect(open.body).toContain('### Com que frequência contar?');

    const locked = (await context.app.inject({ method: 'GET', url: '/blog/so-com-conta.md', headers: WEB })).body;
    expect(locked).toContain('Texto da primeira seção.');
    expect(locked).not.toContain('Conteúdo que só quem tem conta lê.');
    expect(locked).not.toContain('Com que frequência contar?');
    expect(locked).toContain('continua para quem tem conta grátis');

    expect((await context.app.inject({ method: 'GET', url: '/blog/nao-existe.md', headers: WEB })).statusCode).toBe(404);
  });

  it('funções puras: prévia do exclusivo e índice vazio', () => {
    expect(previewMarkdown(MD)).toContain('## Primeira seção');
    expect(previewMarkdown(MD)).not.toContain('## Segunda seção');
    expect(llmsTxt([])).not.toContain('## Blog');
    const md = postMarkdown({
      id: 'x', slug: 'a', title: 'A', excerpt: 'Resumo', contentMd: 'Texto com [link](/ajuda).', contentHtml: '', category: { slug: 'vendas', label: 'Vendas' }, tags: [], faq: [],
      status: 'published', publishedAt: '2026-11-01T10:00:00.000Z', createdAt: '2026-11-01T10:00:00.000Z', updatedAt: '2026-11-03T10:00:00.000Z', authorName: 'Equipe', membersOnly: false,
    } as never);
    expect(md).toContain('Publicado em: 2026-11-01 (atualizado em 2026-11-03)');
    expect(md).toContain('[link](https://estoquesimples.com.br/ajuda)');
  });
});

describe('cabeçalho das páginas públicas da aplicação', () => {
  const template = [
    '<html><head><title>Home</title>',
    '<meta name="description" content="Home" />',
    '<link rel="canonical" href="https://estoquesimples.com.br/" />',
    '<meta property="og:type" content="website" />',
    '<meta property="og:url" content="https://estoquesimples.com.br/" />',
    '<meta property="og:title" content="Home" />',
    '<meta property="og:description" content="Home" />',
    '<meta property="og:image" content="x" />',
    '<meta property="og:image:alt" content="x" />',
    '<script type="application/ld+json">{"@type":"SoftwareApplication"}</script>',
    '</head><body><div id="root"></div></body></html>',
  ].join('\n');

  it('a ajuda sai com título, canonical próprio e as perguntas como FAQPage', () => {
    const html = publicPageHtml(template, '/ajuda')!;
    expect(html).toContain('<link rel="canonical" href="https://estoquesimples.com.br/ajuda" />');
    expect(html).toContain('<title>Central de ajuda do Estoque Simples: perguntas e respostas</title>');
    expect(html).not.toContain('SoftwareApplication');
    const blocks = [...html.matchAll(/<script type="application\/ld\+json">(.*?)<\/script>/g)].map((match) => JSON.parse(match[1]!));
    const faq = blocks.find((block) => block['@type'] === 'FAQPage');
    expect(faq.mainEntity.length).toBeGreaterThan(10);
    expect(faq.mainEntity[0].acceptedAnswer.text).not.toContain('**');
  });

  it('rotas privadas sem canonical da home e com noindex; só as públicas conhecidas têm cabeçalho próprio', () => {
    const html = privateAppHtml(template);
    expect(html).not.toContain('rel="canonical"');
    expect(html).toContain('<meta name="robots" content="noindex, follow" />');
    expect(isPublicAppPage('/plataformas')).toBe(true);
    expect(isPublicAppPage('/app/estoque')).toBe(false);
    expect(publicPageHtml(template, '/app/estoque')).toBeNull();
  });
});
