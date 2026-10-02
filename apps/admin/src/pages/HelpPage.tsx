import adminContent from '@estoquesimples/help/faq-admin.json';
import customerContent from '@estoquesimples/help/faq.json';
import { fold, parseAnswer, searchArticles, searchTerms, type HelpArticle, type HelpContent, type HelpInline } from '@estoquesimples/help';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { Icon } from '../components/Icon';
import { Chips, PageHeader, PlatformBadge, Tabs, useToast } from '../components/ui';
import { useListParams } from '../lib/hooks';

type Source = 'painel' | 'clientes';

const CONTENT: Record<Source, HelpContent> = {
  painel: adminContent as HelpContent,
  clientes: customerContent as HelpContent,
};
const SOURCE_LABEL: Record<Source, string> = { painel: 'Painel e atendimento', clientes: 'Dúvidas dos clientes' };
const ALL = 'todas';

function Inline({ parts }: { parts: HelpInline[] }) {
  return <>{parts.map((part, index) => (part.bold ? <strong key={index}>{part.text}</strong> : <span key={index}>{part.text}</span>))}</>;
}

function Answer({ article }: { article: HelpArticle }) {
  const blocks = useMemo(() => parseAnswer(article.answer), [article]);
  return (
    <>
      {blocks.map((block, index) =>
        block.kind === 'list' ? (
          <ul key={index}>
            {block.items.map((item, itemIndex) => (
              <li key={itemIndex}><Inline parts={item} /></li>
            ))}
          </ul>
        ) : (
          <p key={index}><Inline parts={block.parts} /></p>
        ),
      )}
    </>
  );
}

/** Texto da resposta sem marcação, pronto para colar numa solicitação. */
function plainAnswer(article: HelpArticle): string {
  return article.answer.map((line) => line.replace(/\*\*/g, '')).join('\n');
}

/** Termos buscados em destaque (comparação sem acento; ver a versão da web). */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const original = text.normalize('NFC');
  const folded = fold(original);
  if (folded.length !== original.length) return <>{text}</>;
  const marks = new Array<boolean>(original.length).fill(false);
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) marks.fill(true, at, at + term.length);
  }
  const pieces: ReactNode[] = [];
  let start = 0;
  for (let index = 1; index <= original.length; index += 1) {
    if (index === original.length || marks[index] !== marks[start]) {
      const piece = original.slice(start, index);
      pieces.push(marks[start] ? <mark key={start}>{piece}</mark> : piece);
      start = index;
    }
  }
  return <>{pieces}</>;
}

/**
 * Ajuda do painel. Duas coleções, da mesma fonte (`packages/help`):
 *
 *  - "Painel e atendimento": como a equipe faz as coisas por aqui
 *    (`faq-admin.json`, que só existe no painel);
 *  - "Dúvidas dos clientes": exatamente o que o cliente lê no app e na web
 *    (`faq.json`). Quem atende responde com as mesmas palavras — e pode
 *    copiar a resposta para a solicitação.
 *
 * A busca procura nas duas ao mesmo tempo.
 */
export function HelpPage() {
  const { values, set } = useListParams();
  const toast = useToast();
  const source: Source = values['aba'] === 'clientes' ? 'clientes' : 'painel';
  const content = CONTENT[source];
  const category = content.categories.some((item) => item.id === values['categoria']) ? (values['categoria'] as string) : ALL;
  const linked = values['artigo'] ?? null;

  const [query, setQuery] = useState(values['q'] ?? '');
  const [open, setOpen] = useState<Set<string>>(() => new Set(linked ? [linked] : []));
  const scrolled = useRef(false);

  const terms = useMemo(() => searchTerms(query), [query]);
  const searching = terms.length > 0;

  // A busca fica na URL (com uma pausa), para o link poder ser compartilhado.
  useEffect(() => {
    const timer = setTimeout(() => {
      if ((values['q'] ?? '') !== query.trim()) set({ q: query.trim() }, { resetPage: false });
    }, 400);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  useEffect(() => {
    if (!linked || scrolled.current) return;
    scrolled.current = true;
    const frame = requestAnimationFrame(() => document.getElementById(`ajuda-${linked}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [linked]);

  const results = useMemo(() => {
    if (!searching) return [];
    // As duas coleções juntas; a do painel primeiro quando o empate é total.
    const all = (['painel', 'clientes'] as Source[]).flatMap((key) => CONTENT[key].articles.map((article) => ({ ...article, source: key })));
    const ranked = searchArticles(all, query) as Array<HelpArticle & { source: Source }>;
    return ranked;
  }, [searching, query]);

  const toggle = (article: HelpArticle) => {
    const opening = !open.has(article.id);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(article.id);
      else next.delete(article.id);
      return next;
    });
    set({ artigo: opening ? article.id : null }, { resetPage: false });
  };

  const copy = (article: HelpArticle) => {
    void navigator.clipboard
      ?.writeText(plainAnswer(article))
      .then(() => toast.push('Resposta copiada. Revise antes de enviar ao cliente.', 'success'))
      .catch(() => toast.push('Não foi possível copiar.', 'error'));
  };

  const item = (article: HelpArticle, from: Source, label?: string) => {
    const expanded = open.has(article.id);
    return (
      <div key={`${from}-${article.id}`} id={`ajuda-${article.id}`} className={`faq ${expanded ? 'faq--open' : ''}`}>
        <h3 className="faq__heading">
          <button type="button" className="faq__question" aria-expanded={expanded} aria-controls={`resposta-${article.id}`} onClick={() => toggle(article)}>
            <span className="faq__text">
              {label && <span className="faq__category">{label}</span>}
              <Highlighted text={article.question} terms={terms} />
            </span>
            {article.platforms?.map((platform) => <PlatformBadge key={platform} platform={platform} />)}
            <Icon name="chevronDown" size={18} className="faq__chevron" />
          </button>
        </h3>
        {expanded && (
          <div className="faq__answer" id={`resposta-${article.id}`}>
            <Answer article={article} />
            {from === 'clientes' && (
              <div className="faq__tools">
                <button type="button" className="btn btn--secondary btn--sm" onClick={() => copy(article)}>
                  Copiar resposta
                </button>
                <span className="caption muted">É o mesmo texto que o cliente vê na central de ajuda do app e da web.</span>
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const categoryTitle = (from: Source, id: string) => CONTENT[from].categories.find((entry) => entry.id === id)?.title ?? '';
  const sections = content.categories.filter((section) => category === ALL || section.id === category);

  return (
    <div className="page page--narrow">
      <PageHeader
        title="Ajuda"
        subtitle="Como fazer as coisas pelo painel e o que responder ao cliente. A segunda aba é o mesmo conteúdo da central de ajuda do app e da web."
        actions={<Link to="/suporte" className="btn btn--secondary">Ir para o atendimento</Link>}
      />

      <div className="help">
        <div className="help__search">
          <Icon name="search" size={20} className="help__search-icon" />
          <input
            className="help__input"
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar: reembolso, desbloquear, preço, webhook…"
            aria-label="Buscar na ajuda"
            autoComplete="off"
          />
        </div>

        {searching ? (
          <section aria-live="polite">
            <div className="help__count">
              <span>{results.length === 0 ? 'Nenhum resultado' : `${results.length} ${results.length === 1 ? 'resultado' : 'resultados'}`} para “{query.trim()}”, nas duas abas</span>
              <button type="button" className="btn btn--link" onClick={() => setQuery('')}>Limpar busca</button>
            </div>
            {results.length > 0 ? (
              <div className="faq-list">{results.map((article) => item(article, article.source, `${SOURCE_LABEL[article.source]} · ${categoryTitle(article.source, article.category)}`))}</div>
            ) : (
              <div className="help__empty">
                <strong>Nada com essas palavras.</strong>
                <span>Tente um termo mais simples. Se for um procedimento que falta aqui, vale acrescentar em packages/help.</span>
              </div>
            )}
          </section>
        ) : (
          <>
            <Tabs
              value={source}
              onChange={(value) => set({ aba: value === 'painel' ? null : value, categoria: null }, { resetPage: false })}
              items={[
                { key: 'painel', label: SOURCE_LABEL.painel, count: CONTENT.painel.articles.length },
                { key: 'clientes', label: SOURCE_LABEL.clientes, count: CONTENT.clientes.articles.length },
              ]}
            />
            <Chips
              value={category}
              onChange={(value) => set({ categoria: value === ALL ? null : value }, { resetPage: false })}
              items={[{ key: ALL, label: 'Todos os assuntos' }, ...content.categories.map((section) => ({ key: section.id, label: section.title }))]}
            />
            {sections.map((section) => (
              <section key={section.id} className="help__section" aria-labelledby={`assunto-${section.id}`}>
                <h2 className="help__title" id={`assunto-${section.id}`}>{section.title}</h2>
                <p className="help__summary">{section.summary}</p>
                <div className="faq-list">{content.articles.filter((article) => article.category === section.id).map((article) => item(article, source))}</div>
              </section>
            ))}
          </>
        )}

        <p className="caption muted">
          Conteúdo atualizado em {content.updatedAt.split('-').reverse().join('/')}. A fonte é <span className="mono">packages/help</span> no repositório: alterar lá muda o painel, a web e o app.
        </p>
      </div>
    </div>
  );
}
