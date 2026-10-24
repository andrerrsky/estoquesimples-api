import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { desc, eq, isNotNull } from 'drizzle-orm';

import { blogPosts } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { OpenAiClient } from '../reviews/openai-client.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import { BLOG_CATEGORIES, BLOG_CATEGORY_SLUGS } from './blog.categories.js';
import { blogPostBodySchema, type BlogPostBody } from './blog.schemas.js';
import { BlogService } from './blog.service.js';
import { renderMarkdown, slugify } from './markdown.js';

/**
 * Posts escritos pela OpenAI, duas vezes por semana.
 *
 * Para a IA não fugir do assunto, ela não recebe liberdade: recebe uma pauta
 * (escolhida de um banco fixo, sem repetir), os fatos do produto (o que o app
 * faz e o que não faz), trechos da central de ajuda relacionados à pauta
 * (a "base de conhecimento" que fundamenta o texto, estilo RAG) e as regras
 * de SEO e de estilo do blog. A resposta vem em JSON e passa pela mesma
 * validação de um post escrito à mão, mais checagens de tamanho e de
 * aderência; se reprovar, uma segunda tentativa recebe os motivos.
 */

export interface AiTopic {
  /** Chave estável, guardada em `ai_topic` para não repetir. */
  key: string;
  category: (typeof BLOG_CATEGORY_SLUGS)[number];
  /** Tamanho-alvo em palavras para pautas concorridas (padrão: ~950). */
  targetWords?: number;
  /** Pauta, como um editor pediria. */
  brief: string;
  /** Termo que as pessoas buscam no Google. */
  keyword: string;
}

/** Banco de pautas. Quando acabar, a IA propõe uma pauta nova a partir dos mesmos temas. */
export const AI_TOPICS: readonly AiTopic[] = [
  { key: 'estoque-minimo', category: 'controle-de-estoque', keyword: 'estoque mínimo', brief: 'Como definir o estoque mínimo de cada produto para não faltar nem sobrar, com exemplos de mercearia e loja de roupas.' },
  { key: 'contagem-de-estoque', category: 'controle-de-estoque', targetWords: 1600, keyword: 'como fazer contagem de estoque', brief: 'Passo a passo para fazer a contagem (inventário) do estoque de um pequeno negócio sem fechar a loja por um dia inteiro.' },
  { key: 'planilha-vs-app', category: 'controle-de-estoque', keyword: 'planilha de controle de estoque', brief: 'Planilha de estoque: quando ela resolve, quando ela quebra e o que muda ao passar para um aplicativo no celular.' },
  { key: 'codigo-de-barras', category: 'controle-de-estoque', keyword: 'código de barras no estoque', brief: 'Como usar código de barras para cadastrar e dar baixa no estoque com a câmera do celular, mesmo sem leitor.' },
  { key: 'estoque-parado', category: 'financas', keyword: 'estoque parado', brief: 'Estoque parado é dinheiro parado: como identificar, o que fazer com produtos encalhados e como evitar comprar errado.' },
  { key: 'giro-de-estoque', category: 'financas', targetWords: 1600, keyword: 'giro de estoque', brief: 'O que é giro de estoque, como calcular de um jeito simples e o que um giro baixo diz sobre as compras do negócio.' },
  { key: 'reposicao', category: 'financas', targetWords: 1600, keyword: 'reposição de estoque', brief: 'Quando e quanto comprar: um método simples de reposição para quem não tem comprador nem sistema caro.' },
  { key: 'curva-abc', category: 'financas', targetWords: 1600, keyword: 'curva ABC estoque', brief: 'Curva ABC explicada para quem tem uma loja pequena: quais produtos merecem atenção e quais só ocupam prateleira.' },
  { key: 'perdas-e-quebras', category: 'gestao-do-negocio', keyword: 'perdas no estoque', brief: 'Perdas, quebras e validade vencida: como medir e reduzir num mercadinho, padaria ou pet shop.' },
  { key: 'organizar-deposito', category: 'gestao-do-negocio', keyword: 'como organizar o estoque da loja', brief: 'Como organizar fisicamente o estoque e o depósito de uma loja pequena: endereços, PEPS e rotina de arrumação.' },
  { key: 'equipe-no-estoque', category: 'gestao-do-negocio', keyword: 'controle de estoque com funcionários', brief: 'Como dividir o controle do estoque com a equipe sem perder o controle: quem cadastra, quem dá baixa, quem só consulta.' },
  { key: 'abrir-mercearia', category: 'gestao-do-negocio', keyword: 'como montar uma mercearia', brief: 'Estoque inicial de uma mercearia ou minimercado: o que comprar primeiro, quanto, e como acompanhar nas primeiras semanas.' },
  { key: 'pet-shop', category: 'gestao-do-negocio', keyword: 'controle de estoque pet shop', brief: 'Controle de estoque para pet shop: ração por peso, validade, produtos de giro lento e o que acompanhar toda semana.' },
  { key: 'loja-de-roupas', category: 'gestao-do-negocio', keyword: 'controle de estoque loja de roupas', brief: 'Estoque de loja de roupas: tamanhos, cores, coleções e como saber o que repor antes de acabar.' },
  { key: 'vendas-whatsapp', category: 'vendas', keyword: 'vender pelo WhatsApp', brief: 'Vender pelo WhatsApp sem vender o que não tem: como o estoque atualizado evita cancelamento e cliente irritado.' },
  { key: 'marketplace-estoque', category: 'vendas', keyword: 'controle de estoque para marketplace', brief: 'Vender na loja física e em marketplace ao mesmo tempo: como não vender duas vezes o mesmo produto.' },
  { key: 'promocao-encalhado', category: 'vendas', keyword: 'como vender produto encalhado', brief: 'Promoções inteligentes para girar o que está encalhado sem destruir a margem.' },
  { key: 'atendimento-balcao', category: 'vendas', keyword: 'atendimento no balcão', brief: 'Como responder "tem?" na hora: atendimento no balcão com o estoque no celular.' },
  { key: 'black-friday-estoque', category: 'vendas', keyword: 'estoque para Black Friday', brief: 'Preparar o estoque para datas de pico (Black Friday, Natal, Dia das Mães) num negócio pequeno.' },
  { key: 'precificacao', category: 'financas', targetWords: 1600, keyword: 'como precificar produtos', brief: 'Como precificar produtos de revenda: custo, margem, impostos e o papel do valor do estoque nessa conta.' },
  { key: 'capital-de-giro', category: 'financas', targetWords: 1600, keyword: 'capital de giro estoque', brief: 'Capital de giro e estoque: por que comprar demais aperta o caixa e como achar o ponto de equilíbrio.' },
  { key: 'validade', category: 'controle-de-estoque', keyword: 'controle de validade', brief: 'Como controlar a validade dos produtos e vender primeiro o que vence primeiro (PEPS) sem sistema complicado.' },
  { key: 'fornecedores', category: 'gestao-do-negocio', keyword: 'como escolher fornecedor', brief: 'Fornecedores: como comparar, negociar prazo e registrar de quem veio cada produto para repor sem susto.' },
  { key: 'historico-movimentacoes', category: 'como-fazer', keyword: 'histórico de estoque', brief: 'Por que registrar toda entrada e saída e como usar o histórico para descobrir onde o estoque some.' },
  { key: 'relatorios-estoque', category: 'como-fazer', keyword: 'relatório de estoque', brief: 'Os relatórios que todo dono de loja deveria olhar uma vez por semana e como gerar em PDF no Estoque Simples.' },
  { key: 'importar-planilha', category: 'como-fazer', keyword: 'importar estoque de planilha', brief: 'Como migrar o estoque de uma planilha para o aplicativo em minutos, sem digitar tudo de novo.' },
  { key: 'estoque-no-computador', category: 'como-fazer', keyword: 'controle de estoque no computador e celular', brief: 'Usar o mesmo estoque no celular e no computador: quando cada um ajuda mais e como instalar o web app.' },
  { key: 'fotos-de-produtos', category: 'como-fazer', keyword: 'foto de produto no estoque', brief: 'Fotos dos produtos no estoque: por que ajudam na hora de achar e conferir, e como tirar fotos boas com o celular.' },
  { key: 'backup-estoque', category: 'como-fazer', keyword: 'backup do estoque', brief: 'Perdeu o celular? Como garantir que o estoque não se perde junto: nuvem, backup e exportação.' },
  { key: 'estoque-baixo-aviso', category: 'como-fazer', keyword: 'aviso de estoque baixo', brief: 'Como configurar o aviso de estoque baixo e deixar o celular lembrar você de repor.' },
  { key: 'lanchonete', category: 'gestao-do-negocio', keyword: 'controle de estoque lanchonete', brief: 'Controle de estoque para lanchonete e food truck: insumos, porções e o que medir para não desperdiçar.' },
  { key: 'papelaria-escolar', category: 'vendas', keyword: 'estoque volta às aulas', brief: 'Papelaria e volta às aulas: planejar o estoque sazonal e saber o que sobra para o ano seguinte.' },
  { key: 'distribuidora', category: 'gestao-do-negocio', keyword: 'controle de estoque distribuidora', brief: 'Pequena distribuidora: controlar estoque em caixas e unidades, separar pedidos e não prometer o que não tem.' },
  { key: 'erros-comuns', category: 'controle-de-estoque', keyword: 'erros no controle de estoque', brief: 'Os erros mais comuns no controle de estoque de pequenos negócios e como corrigir cada um.' },
  { key: 'rotina-semanal', category: 'gestao-do-negocio', keyword: 'rotina de controle de estoque', brief: 'Uma rotina semanal de 30 minutos para manter o estoque em dia, com checklist.' },
  { key: 'unidades-de-medida', category: 'como-fazer', keyword: 'estoque por peso e unidade', brief: 'Produtos vendidos por peso, litro, caixa ou unidade: como cadastrar e dar baixa sem confundir.' },
] as const;

const SITE = 'https://estoquesimples.com.br';

/** O que o app faz e o que não faz: a IA só pode afirmar o que está aqui. */
const PRODUCT_FACTS = `FATOS SOBRE O ESTOQUE SIMPLES (só afirme o que está aqui):
- É um controle de estoque brasileiro para pequenos negócios: mercearia, loja de roupas, pet shop, papelaria, distribuidora, lanchonete, revenda, salão.
- Existe como aplicativo Android (Google Play) e como versão web em estoquesimples.com.br (navegador no computador, tablet e celular, inclusive iPhone e iPad como web app na tela inicial). Não existe app na App Store.
- Cadastro de produtos com nome, categoria, fornecedor, localização, unidade (un, kg, L, caixa…), valor unitário, estoque mínimo, código de barras e foto.
- Entradas e saídas em poucos toques; o saldo se atualiza na hora; todo movimento fica no histórico com data e quem lançou; é possível estornar.
- Aviso de estoque baixo: na lista, nos relatórios e, no Android, uma notificação diária no aparelho; na web, avisos opcionais no navegador.
- Leitor de código de barras pela câmera (Android e navegadores com câmera) e por leitor USB no computador.
- Relatórios: valor do estoque, produtos abaixo do mínimo, movimentações por período, em PDF para compartilhar. Análise avançada (tendências, giro) no plano Equipe.
- Importar e exportar por planilha (CSV/Excel) e JSON; backup; os dados ficam na nuvem com conta grátis.
- Plano Gratuito: uma pessoa, nuvem incluída, com teto de produtos. Plano Equipe (assinatura mensal, cancelável quando quiser): várias pessoas no mesmo estoque com papéis (quem cadastra, quem movimenta, quem só consulta), produtos sem limite na nuvem, análise avançada e identidade visual da empresa. Assinatura pela Google Play ou, na web, por Pix, boleto ou cartão.
- O app Android funciona sem internet; a versão web precisa de internet.
- NÃO faz: emissão de nota fiscal, PDV/frente de caixa, integração automática com marketplaces, controle de lotes/validade por data (a validade pode ser anotada na descrição), multi-depósito, contas a pagar.
- Não cite preços. Não prometa recursos futuros.`;

const DEFAULT_TARGET_WORDS = 950;

const STYLE_RULES = `ESTILO E SEO:
- Português do Brasil, tom de uma pessoa da equipe conversando com quem empreende: direto, útil, sem jargão, sem emojis, sem "neste artigo vamos", sem frases de preenchimento.
- Público: dono ou dona de um pequeno negócio com estoque físico, que vende na loja e muitas vezes também pelo WhatsApp ou marketplace. Exemplos concretos com nomes de produtos reais do dia a dia (ex.: "Café torrado 500 g").
- Tamanho: o indicado em META DE PALAVRAS (±15%). Abra respondendo a dúvida nas primeiras 2 frases (sem introdução longa). Em pautas com conta (curva ABC, giro, precificação, capital de giro, reposição), inclua um exemplo resolvido com números, em uma pequena tabela Markdown ou passo a passo.
- Estrutura em Markdown: de 3 a 5 seções com "## " (sem "# "); use listas e passos numerados onde ajudar; subtítulos descritivos que uma pessoa buscaria no Google.
- A palavra-chave da pauta aparece no título, no resumo (excerpt), no primeiro parágrafo e em pelo menos um "## ", de forma natural (nunca repetida de propósito).
- Links internos em Markdown, só destes: 1 a 3 links para posts já publicados da lista POSTS PUBLICADOS (formato [texto](/blog/slug), onde o assunto se cruza) e, se fizer sentido, um destes: [criar conta grátis](/criar-conta), [onde usar: celular e computador](/plataformas), [central de ajuda](/ajuda). Nenhum link externo. Nenhum link inventado.
- Mencione o Estoque Simples de forma natural, como ferramenta que resolve parte do problema (1 a 3 vezes), sem virar propaganda: o texto precisa ser útil mesmo para quem não usa o app.
- Termine com uma seção "## Resumo" de 3 a 4 itens em lista.
- Nada de afirmações inventadas sobre números de mercado, leis ou pesquisas. Nada de "garantido", "100%", "o melhor".`;

interface AiDraft {
  title: string;
  coverAlt?: string;
  seoTitle?: string;
  excerpt: string;
  category: string;
  tags: string[];
  contentMd: string;
  faq: Array<{ question: string; answer: string }>;
}

interface HelpArticle {
  id: string;
  category: string;
  question: string;
  answer: string[];
  keywords?: string[];
}

/** A central de ajuda (packages/help/faq.json), lida uma vez; sem ela a IA segue só com os fatos. */
let helpCache: HelpArticle[] | null = null;
function helpArticles(): HelpArticle[] {
  if (helpCache) return helpCache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../../../../../packages/help/faq.json'), join(process.cwd(), 'packages/help/faq.json'), join(process.cwd(), '../../packages/help/faq.json')];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as { articles?: HelpArticle[] };
      helpCache = parsed.articles ?? [];
      return helpCache;
    } catch {
      // próximo candidato
    }
  }
  helpCache = [];
  return helpCache;
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/** Os artigos da ajuda mais ligados à pauta (por palavras em comum), para fundamentar o texto. */
export function groundingFor(topic: AiTopic, limit = 5): string {
  const terms = new Set(
    fold(`${topic.brief} ${topic.keyword} ${topic.category}`)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  const scored = helpArticles()
    .map((article) => {
      const haystack = fold(`${article.question} ${article.answer.join(' ')} ${(article.keywords ?? []).join(' ')}`);
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { article, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
  if (scored.length === 0) return '(nenhum artigo da ajuda diretamente relacionado)';
  return scored.map(({ article }) => `- ${article.question}\n  ${article.answer.join(' ').slice(0, 600)}`).join('\n');
}

export class BlogAiWriter {
  private readonly blog: BlogService;

  constructor(private readonly services: AppServices) {
    this.blog = new BlogService(services);
  }

  /** Próxima pauta do banco ainda não usada; esgotado o banco, uma pauta proposta pelo modelo. */
  async nextTopic(client: OpenAiClient): Promise<AiTopic> {
    const used = await this.services.db.select({ topic: blogPosts.aiTopic }).from(blogPosts).where(isNotNull(blogPosts.aiTopic));
    const usedKeys = new Set(used.map((row) => row.topic));
    // Pauta cuja palavra-chave já está no endereço de um post (escrito à mão
    // ou não) também conta como usada: dois posts para a mesma busca disputam
    // entre si em vez de somar.
    const slugs = (await this.services.db.select({ slug: blogPosts.slug }).from(blogPosts)).map((row) => row.slug);
    const pending = AI_TOPICS.filter((topic) => {
      if (usedKeys.has(topic.key)) return false;
      const keywordSlug = slugify(topic.keyword);
      return !(keywordSlug.length >= 6 && slugs.some((slug) => slug.includes(keywordSlug)));
    });
    if (pending.length > 0) {
      // Alterna as categorias: a próxima pauta é a da categoria há mais tempo sem post.
      const recent = await this.services.db.select({ category: blogPosts.category }).from(blogPosts).orderBy(desc(blogPosts.createdAt)).limit(12);
      const lastIndex = new Map<string, number>();
      recent.forEach((row, index) => {
        if (!lastIndex.has(row.category)) lastIndex.set(row.category, index);
      });
      pending.sort((a, b) => (lastIndex.get(b.category) ?? 99) - (lastIndex.get(a.category) ?? 99));
      return pending[0]!;
    }
    const titles = used.length > 0 ? (await this.services.db.select({ title: blogPosts.title }).from(blogPosts).orderBy(desc(blogPosts.createdAt)).limit(60)).map((row) => row.title) : [];
    const proposal = await client.completeJson(
      `Você é editor do blog do Estoque Simples (controle de estoque para pequenos negócios). Proponha UMA pauta nova, útil e buscada no Google, dentro dos temas: controle de estoque, gestão de pequeno negócio com estoque, vendas (loja física, WhatsApp, marketplace), finanças do estoque, ou como fazer no app. Responda em JSON: {"key": "slug-curto", "category": uma de ${JSON.stringify(BLOG_CATEGORY_SLUGS)}, "keyword": "termo de busca", "brief": "pauta em uma frase"}.`,
      `Pautas já publicadas (não repita nem varie de leve):\n${titles.map((title) => `- ${title}`).join('\n')}`,
      400,
    );
    const parsed = proposal as Partial<AiTopic>;
    if (!parsed.key || !parsed.brief || !parsed.keyword || !BLOG_CATEGORY_SLUGS.includes(parsed.category ?? '')) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI não propôs uma pauta válida.');
    }
    return { key: `ia-${parsed.key.slice(0, 40)}`, category: parsed.category as AiTopic['category'], brief: parsed.brief, keyword: parsed.keyword };
  }

  private systemPrompt(): string {
    const categories = BLOG_CATEGORIES.map((category) => `- ${category.slug}: ${category.label} (${category.description})`).join('\n');
    return `Você escreve os posts do blog do Estoque Simples (${SITE}/blog), assinados por "Equipe Estoque Simples".

${PRODUCT_FACTS}

CATEGORIAS (use o slug):
${categories}

${STYLE_RULES}

FORMATO DA RESPOSTA: um único objeto JSON, sem texto fora dele, com estas chaves:
{
  "title": "título do post (40 a 65 caracteres, com a palavra-chave no começo, sem dois-pontos no fim, sem ponto final)",
  "seoTitle": "título para o Google com no máximo 55 caracteres, com a palavra-chave, sem a marca (o site acrescenta \" | Estoque Simples\" quando cabe); pode ser igual ao title quando ele cabe",
  "excerpt": "resumo para o Google e para a lista do blog (120 a 160 caracteres, uma ou duas frases, com a palavra-chave)",
  "category": "slug da categoria",
  "tags": ["3 a 6 tags curtas, minúsculas"],
  "coverAlt": "texto alternativo da capa, que é um cartão com o título do post e a categoria sobre fundo azul (até 120 caracteres; descreva isso, sem inventar cena)",
  "contentMd": "o post em Markdown, conforme as regras",
  "faq": [{"question": "pergunta que as pessoas fazem sobre o tema", "answer": "resposta direta de 1 a 3 frases"}]  (3 itens)
}`;
  }

  private userPrompt(topic: AiTopic, published: Array<{ slug: string; title: string }>, problems: string[] = []): string {
    return [
      `PAUTA: ${topic.brief}`,
      `PALAVRA-CHAVE: ${topic.keyword}`,
      `CATEGORIA SUGERIDA: ${topic.category}`,
      `META DE PALAVRAS: ${topic.targetWords ?? DEFAULT_TARGET_WORDS}`,
      '',
      'TRECHOS DA CENTRAL DE AJUDA RELACIONADOS (use como base do que o app faz; não copie literalmente):',
      groundingFor(topic),
      '',
      published.length > 0
        ? `POSTS PUBLICADOS (não repita o assunto nem o título; linke 1 a 3 que se cruzem com a pauta, como [texto](/blog/slug)):\n${published.map((post) => `- /blog/${post.slug} — ${post.title}`).join('\n')}`
        : '',
      problems.length > 0 ? `\nA TENTATIVA ANTERIOR FOI REPROVADA. Corrija:\n${problems.map((problem) => `- ${problem}`).join('\n')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /**
   * Confere o que a validação de post comum não vê: tamanho, estrutura e
   * aderência à pauta. `published` são os posts já no ar (slug e título):
   * links para eles são exigidos quando existem, e um título que disputa a
   * mesma palavra-chave de um post publicado é recusado (canibalização).
   */
  static check(draft: AiDraft, topic: AiTopic, published: Array<{ slug: string; title: string }> = []): string[] {
    const problems: string[] = [];
    const md = draft.contentMd ?? '';
    const rendered = renderMarkdown(md);
    const target = topic.targetWords ?? DEFAULT_TARGET_WORDS;
    const minWords = Math.round(target * 0.75);
    const maxWords = Math.round(target * 1.3);
    if (rendered.words < minWords) problems.push(`O texto tem ${rendered.words} palavras; escreva por volta de ${target} (no mínimo ${minWords}).`);
    if (rendered.words > maxWords) problems.push(`O texto tem ${rendered.words} palavras; encurte para por volta de ${target} (no máximo ${maxWords}).`);
    const h2 = rendered.headings.filter((heading) => heading.level === 2).length;
    if (h2 < 3) problems.push('Use pelo menos 3 seções com "## ".');
    if (!/##\s+Resumo/i.test(md)) problems.push('Termine com a seção "## Resumo" em lista.');
    // Pautas com conta precisam do exemplo resolvido: números com unidade, prazo ou valor.
    if ((topic.targetWords ?? 0) >= 1600 && (!/\d+(?:[.,]\d+)?\s*(un|unidades|r\$|%|dias|semanas|meses|reais)/i.test(md) || (md.match(/\d/g) ?? []).length < 12)) {
      problems.push('Inclua um exemplo resolvido com números (quantidades, prazos, R$), em tabela Markdown ou passo a passo.');
    }
    // Palavra-chave: todas as palavras relevantes dela, no título, no resumo, no primeiro parágrafo e em um "##".
    const keywordWords = fold(topic.keyword).split(/\s+/).filter((word) => word.length > 2);
    const hasKeyword = (text: string) => keywordWords.every((word) => fold(text).includes(word));
    const firstParagraph = md.split(/\n\s*\n/).map((block) => block.trim()).find((block) => block && !block.startsWith('#')) ?? '';
    if (!hasKeyword(draft.title ?? '')) problems.push(`A palavra-chave "${topic.keyword}" precisa aparecer no título.`);
    if (!hasKeyword(draft.excerpt ?? '')) problems.push(`A palavra-chave "${topic.keyword}" precisa aparecer no resumo (excerpt).`);
    if (!hasKeyword(firstParagraph)) problems.push(`A palavra-chave "${topic.keyword}" precisa aparecer no primeiro parágrafo.`);
    if (!rendered.headings.some((heading) => hasKeyword(heading.text))) problems.push(`A palavra-chave "${topic.keyword}" precisa aparecer em pelo menos um "## ".`);
    if (!/estoque simples/i.test(md)) problems.push('Mencione o Estoque Simples pelo menos uma vez, de forma natural.');
    const internalLinks = [...md.matchAll(/\]\(\/(criar-conta|plataformas|ajuda|blog(?:\/([a-z0-9-]+))?)\)/g)];
    if (internalLinks.length === 0) problems.push('Inclua pelo menos um link interno em Markdown (/blog/slug de um post publicado, /criar-conta, /plataformas ou /ajuda).');
    const postLinks = internalLinks.map((match) => match[2]).filter((slug): slug is string => Boolean(slug));
    const unknown = postLinks.filter((slug) => !published.some((post) => post.slug === slug));
    if (unknown.length > 0) problems.push(`Estes posts não existem, remova os links: ${unknown.map((slug) => `/blog/${slug}`).join(', ')}.`);
    if (published.length >= 3 && postLinks.length === 0) problems.push('Linke pelo menos um post da lista POSTS PUBLICADOS, no formato [texto](/blog/slug).');
    if (/\]\(\/(?!criar-conta|plataformas|ajuda|blog)/.test(md)) problems.push('Use só os links internos permitidos.');
    const keywordSlug = slugify(topic.keyword);
    const rival = published.find((post) => keywordSlug.length >= 6 && post.slug.includes(keywordSlug));
    if (rival) problems.push(`Já existe um post para "${topic.keyword}" (${rival.title}); mude o ângulo e a palavra-chave para não disputar a mesma busca.`);
    if (/\]\((https?:)?\/\//.test(md)) problems.push('Remova os links externos.');
    if (/garantid|100%|o melhor app/i.test(draft.contentMd ?? '')) problems.push('Remova promessas como "garantido", "100%" ou "o melhor".');
    if (/nota fiscal|emite nf|frente de caixa|pdv/i.test(draft.contentMd ?? '') && /estoque simples[^.]{0,80}(nota fiscal|nf-e|pdv|frente de caixa)/i.test(draft.contentMd ?? '')) {
      problems.push('Não afirme que o Estoque Simples emite nota fiscal ou tem PDV.');
    }
    if ((draft.title ?? '').length < 35 || (draft.title ?? '').length > 65) problems.push(`O título tem ${(draft.title ?? '').length} caracteres; precisa ter entre 35 e 65.`);
    if ((draft.seoTitle ?? draft.title ?? '').length > 60) problems.push(`O seoTitle tem ${(draft.seoTitle ?? draft.title ?? '').length} caracteres; no máximo 60 (ideal até 55).`);
    if ((draft.excerpt ?? '').length < 110 || (draft.excerpt ?? '').length > 165) problems.push(`O resumo (excerpt) tem ${(draft.excerpt ?? '').length} caracteres; precisa ter entre 110 e 165 (ideal 120 a 160).`);
    if (!Array.isArray(draft.faq) || draft.faq.length < 3) problems.push('Inclua 3 perguntas e respostas em "faq".');
    return problems;
  }

  /**
   * Escreve e grava um post (rascunho ou publicado, conforme a configuração).
   * @returns o post, ou `null` quando a geração está desligada ou sem chave.
   */
  async writePost(options: { publish?: boolean; topic?: AiTopic } = {}) {
    const settings = await this.blog.settings();
    const apiKey = await readOpenAiKey(this.services);
    if (!apiKey) throw new AppError(409, ErrorCode.CONFLICT, 'Configure a chave da OpenAI (Avaliações › OpenAI) para a IA escrever posts.');
    const model = this.services.env.OPENAI_MODEL;
    const client = new OpenAiClient(apiKey, model);
    const topic = options.topic ?? (await this.nextTopic(client));
    const published = (await this.blog.allPublished(60)).map((post) => ({ slug: post.slug, title: post.title }));

    let problems: string[] = [];
    let body: BlogPostBody | null = null;
    for (let attempt = 0; attempt < 2 && !body; attempt += 1) {
      const raw = (await client.completeJson(this.systemPrompt(), this.userPrompt(topic, published, problems), 3600, 0.7)) as AiDraft;
      const draft: AiDraft = { ...raw, tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [], faq: Array.isArray(raw.faq) ? raw.faq : [] };
      problems = BlogAiWriter.check(draft, topic, published);
      const parsed = blogPostBodySchema.safeParse({
        title: draft.title,
        seoTitle: draft.seoTitle?.slice(0, 70) ?? null,
        excerpt: draft.excerpt,
        contentMd: draft.contentMd,
        category: BLOG_CATEGORY_SLUGS.includes(draft.category) ? draft.category : topic.category,
        coverAlt: typeof draft.coverAlt === 'string' && draft.coverAlt.trim() ? draft.coverAlt.trim().slice(0, 200) : null,
        tags: draft.tags.slice(0, 6).map((tag) => tag.toLowerCase().slice(0, 40)),
        faq: draft.faq.slice(0, 4).map((item) => ({ question: String(item.question ?? '').slice(0, 200), answer: String(item.answer ?? '').slice(0, 1000) })),
      });
      if (!parsed.success) problems.push(...parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`));
      if (problems.length === 0 && parsed.success) body = parsed.data;
      else this.services.logger?.warn({ attempt, problems, topic: topic.key }, 'post da IA reprovado na validação');
    }
    if (!body) {
      throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, `A OpenAI não produziu um post válido para "${topic.key}": ${problems.join(' ')}`);
    }

    const created = await this.blog.create(null, body, { ai: { model, topic: topic.key } });
    const publish = options.publish ?? settings.aiAutoPublish;
    return publish ? this.blog.publish(null, created.id) : created;
  }
}

/** Nomes das pautas, para o painel mostrar o que ainda está por vir. */
export async function topicStatus(services: AppServices): Promise<Array<AiTopic & { used: boolean }>> {
  const used = new Set((await services.db.select({ topic: blogPosts.aiTopic }).from(blogPosts).where(isNotNull(blogPosts.aiTopic))).map((row) => row.topic));
  return AI_TOPICS.map((topic) => ({ ...topic, used: used.has(topic.key) }));
}

export { eq };
