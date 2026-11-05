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
