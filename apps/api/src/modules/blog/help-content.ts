import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Central de ajuda (packages/help/faq.json), lida uma vez. Usada pela IA do
 * blog (para fundamentar o texto) e pelo que o site publica para buscadores:
 * llms.txt, llms-full.txt e o FAQ estruturado de /ajuda. Sem o arquivo, tudo
 * segue sem a ajuda em vez de falhar.
 */

export interface HelpCategory {
  id: string;
  title: string;
  summary: string;
}

export interface HelpArticle {
  id: string;
  category: string;
  question: string;
  /** Um parágrafo por item; "• " no começo é item de lista; `**assim**` é negrito. */
  answer: string[];
  keywords?: string[];
  platforms?: Array<'android' | 'web'>;
}

export interface HelpContent {
  updatedAt: string | null;
  categories: HelpCategory[];
  articles: HelpArticle[];
}

let cache: HelpContent | null = null;

export function helpContent(): HelpContent {
  if (cache) return cache;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '../../../../../packages/help/faq.json'), join(process.cwd(), 'packages/help/faq.json'), join(process.cwd(), '../../packages/help/faq.json')];
  for (const path of candidates) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<HelpContent>;
      cache = { updatedAt: parsed.updatedAt ?? null, categories: parsed.categories ?? [], articles: parsed.articles ?? [] };
      return cache;
    } catch {
      // próximo candidato
    }
  }
  cache = { updatedAt: null, categories: [], articles: [] };
  return cache;
}

/** A resposta como texto corrido (para o JSON-LD): sem marcação, parágrafos separados por espaço. */
export function answerText(article: HelpArticle): string {
  return article.answer.map((line) => line.replace(/^•\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1')).join(' ');
}

/** A resposta em Markdown (para o llms-full.txt). */
export function answerMarkdown(article: HelpArticle): string {
  return article.answer.map((line) => (line.startsWith('• ') ? `- ${line.slice(2)}` : line)).join('\n\n').replace(/\n\n(- )/g, '\n$1');
}

function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}+/gu, '').toLowerCase();
}

/**
 * Os artigos da ajuda com mais palavras em comum com o texto dado ("RAG"
 * simples, sem vetor: a base é pequena e cabe no prompt). A IA do blog usa
 * para fundamentar a pauta; a do atendimento, para responder a dúvida com o
 * que a central de ajuda já diz — as duas partem da mesma fonte.
 */
export function relatedHelpArticles(text: string, limit = 5): HelpArticle[] {
  const terms = new Set(
    fold(text)
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length > 3),
  );
  return helpContent()
    .articles.map((article) => {
      const haystack = fold(`${article.question} ${article.answer.join(' ')} ${(article.keywords ?? []).join(' ')}`);
      let score = 0;
      for (const term of terms) if (haystack.includes(term)) score += 1;
      return { article, score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((item) => item.article);
}
