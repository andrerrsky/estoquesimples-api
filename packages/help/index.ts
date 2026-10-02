/**
 * Central de ajuda: tipos e a lógica que a web e o painel compartilham
 * (busca e leitura do texto). O conteúdo está em `faq.json` (clientes) e
 * `faq-admin.json` (equipe do painel); o app Android lê uma cópia de
 * `faq.json` e implementa as mesmas regras em Java (`HelpActivity`).
 *
 * Formato do texto, de propósito mínimo para render igual nos três lugares:
 * cada item de `answer` é um parágrafo; começando com "• ", é um item de
 * lista; `**assim**` é negrito.
 */

export type HelpPlatform = 'android' | 'web';

export interface HelpCategory {
  id: string;
  title: string;
  summary: string;
}

export interface HelpArticle {
  id: string;
  category: string;
  question: string;
  answer: string[];
  /** Só para a busca: jeitos como as pessoas costumam perguntar. */
  keywords?: string[];
  /** Quando presente, o artigo só aparece nessas plataformas. */
  platforms?: HelpPlatform[];
}

export interface HelpContent {
  version: number;
  updatedAt: string;
  categories: HelpCategory[];
  articles: HelpArticle[];
}

/** Sem acento e sem caixa: "Sincronização" é achada por "sincronizacao". */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

/** Artigos que fazem sentido na plataforma; categorias que ficaram vazias saem. */
export function forPlatform(content: HelpContent, platform: HelpPlatform): HelpContent {
  const articles = content.articles.filter((article) => !article.platforms || article.platforms.includes(platform));
  const used = new Set(articles.map((article) => article.category));
  return { ...content, articles, categories: content.categories.filter((category) => used.has(category.id)) };
}

/**
 * Palavras da busca, já normalizadas; termos de uma letra só atrapalham.
 * O "s" final de palavras longas sai ("reembolsos" acha "reembolso"): a
 * comparação é por trecho, então o singular também encontra o plural.
 */
export function searchTerms(query: string): string[] {
  return fold(query)
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length >= 2)
    .map((term) => (term.length > 4 && term.endsWith('s') ? term.slice(0, -1) : term));
}

/**
 * Busca: todas as palavras digitadas precisam aparecer (na pergunta, na
 * resposta ou nas palavras-chave). Quem tem as palavras na pergunta vem
 * primeiro, depois nas palavras-chave, depois só no texto.
 */
export function searchArticles(articles: HelpArticle[], query: string): HelpArticle[] {
  const terms = searchTerms(query);
  if (terms.length === 0) return articles;

  const scored: Array<{ article: HelpArticle; score: number; order: number }> = [];
  articles.forEach((article, order) => {
    const question = fold(article.question);
    const keywords = fold((article.keywords ?? []).join(' '));
    const body = fold(article.answer.join(' '));
    let score = 0;
    for (const term of terms) {
      if (question.includes(term)) score += 5;
      else if (keywords.includes(term)) score += 3;
      else if (body.includes(term)) score += 1;
      else return;
    }
    scored.push({ article, score, order });
  });
  return scored.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.article);
}

export interface HelpInline {
  text: string;
  bold: boolean;
}

export type HelpBlock = { kind: 'paragraph'; parts: HelpInline[] } | { kind: 'list'; items: HelpInline[][] };

function inline(text: string): HelpInline[] {
  return text
    .split(/(\*\*[^*]+\*\*)/g)
    .filter((piece) => piece !== '')
    .map((piece) => (piece.startsWith('**') && piece.endsWith('**') ? { text: piece.slice(2, -2), bold: true } : { text: piece, bold: false }));
}

/** Parágrafos e listas (itens "• " seguidos viram uma lista só). */
export function parseAnswer(answer: string[]): HelpBlock[] {
  const blocks: HelpBlock[] = [];
  for (const line of answer) {
    if (line.startsWith('• ')) {
      const last = blocks[blocks.length - 1];
      const item = inline(line.slice(2));
      if (last && last.kind === 'list') last.items.push(item);
      else blocks.push({ kind: 'list', items: [item] });
    } else {
      blocks.push({ kind: 'paragraph', parts: inline(line) });
    }
  }
  return blocks;
}
