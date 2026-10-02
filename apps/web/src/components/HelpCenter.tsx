import content from '@estoquesimples/help/faq.json';
import { fold, forPlatform, parseAnswer, searchArticles, searchTerms, type HelpArticle, type HelpContent, type HelpInline } from '@estoquesimples/help';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { track } from '../lib/analytics';
import { plural } from '../lib/format';
import { useDebounced } from '../lib/inventory';
import { Icon } from './Icon';
import { Chips } from './ui';

import '../styles/pages-help.css';

/** Só o que faz sentido para quem está no navegador. */
const HELP = forPlatform(content as HelpContent, 'web');
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

/**
 * Pergunta com os termos buscados em destaque. A comparação é sem acento;
 * como remover acento não muda o número de letras (o texto é normalizado
 * antes), as posições achadas valem também no texto original.
 */
function Highlighted({ text, terms }: { text: string; terms: string[] }) {
  if (terms.length === 0) return <>{text}</>;
  const original = text.normalize('NFC');
  const folded = fold(original);
  if (folded.length !== original.length) return <>{text}</>;

  const marks = new Array<boolean>(original.length).fill(false);
  for (const term of terms) {
    for (let at = folded.indexOf(term); at !== -1; at = folded.indexOf(term, at + term.length)) {
      marks.fill(true, at, at + term.length);
    }
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
 * Central de ajuda: perguntas e respostas com busca. O conteúdo vem de
 * `packages/help` (o mesmo que o app Android embute), então não há uma
 * segunda redação para manter. Busca, categoria e pergunta aberta ficam na
 * URL: dá para mandar o link de uma resposta para alguém.
 *
 * @param supportTo para onde vai "Falar com o suporte" (muda para visitante).
 */
export function HelpCenter({ supportTo, supportLabel, supportState }: { supportTo: string; supportLabel: string; supportState?: (articleId: string | null) => unknown }) {
  const [params, setParams] = useSearchParams();
  const urlQuery = params.get('q') ?? '';
  const category = HELP.categories.some((item) => item.id === params.get('categoria')) ? (params.get('categoria') as string) : ALL;
  const linked = params.get('artigo');

  const [query, setQuery] = useState(urlQuery);
  const [open, setOpen] = useState<Set<string>>(() => new Set(linked ? [linked] : []));
  const scrolled = useRef(false);

  const update = (changes: Record<string, string | null>) =>
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );

  // A URL acompanha a busca depois de uma pausa na digitação.
  const settled = useDebounced(query.trim(), 400);
  useEffect(() => {
    if (settled !== urlQuery) update({ q: settled });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  const terms = useMemo(() => searchTerms(query), [query]);
  const searching = terms.length > 0;
  const results = useMemo(() => (searching ? searchArticles(HELP.articles, query) : []), [searching, query]);
  const categoryTitle = useMemo(() => new Map(HELP.categories.map((item) => [item.id, item.title])), []);

  // Mede o que as pessoas procuram e não acham — só a contagem, nunca o texto.
  useEffect(() => {
    if (settled && searchTerms(settled).length > 0) track('help.searched', { results: searchArticles(HELP.articles, settled).length });
  }, [settled]);

  // Link direto para uma resposta: abre e leva até ela, uma vez.
  useEffect(() => {
    if (!linked || scrolled.current) return;
    scrolled.current = true;
    const frame = requestAnimationFrame(() => document.getElementById(`ajuda-${linked}`)?.scrollIntoView({ block: 'center' }));
    return () => cancelAnimationFrame(frame);
  }, [linked]);

  const toggle = (article: HelpArticle) => {
    const opening = !open.has(article.id);
    setOpen((current) => {
      const next = new Set(current);
      if (opening) next.add(article.id);
      else next.delete(article.id);
      return next;
    });
    update({ artigo: opening ? article.id : null });
    if (opening) track('help.article_opened', { article: article.id });
  };

  const item = (article: HelpArticle, showCategory: boolean) => {
    const expanded = open.has(article.id);
    return (
      <div key={article.id} id={`ajuda-${article.id}`} className={`faq ${expanded ? 'faq--open' : ''}`}>
        <h3 className="faq__heading">
          <button type="button" className="faq__question" aria-expanded={expanded} aria-controls={`resposta-${article.id}`} onClick={() => toggle(article)}>
            <span className="faq__text">
              {showCategory && <span className="faq__category">{categoryTitle.get(article.category)}</span>}
              <Highlighted text={article.question} terms={terms} />
            </span>
            <Icon name="chevronDown" size={18} className="faq__chevron" />
          </button>
        </h3>
        {expanded && (
          <div className="faq__answer" id={`resposta-${article.id}`}>
            <Answer article={article} />
            <p className="faq__more">
              Não era isso?{' '}
              <Link to={supportTo} state={supportState?.(article.id)}>
                {supportLabel}
              </Link>
            </p>
          </div>
        )}
      </div>
    );
  };

  const sections = HELP.categories.filter((section) => category === ALL || section.id === category);

  return (
    <div className="help">
      <div className="help__search">
        <Icon name="search" size={20} className="help__search-icon" />
        <input
          className="help__input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Buscar uma dúvida: reembolso, sincronizar, convidar…"
          aria-label="Buscar na central de ajuda"
          autoComplete="off"
        />
      </div>

      {searching ? (
        <section aria-live="polite">
          <div className="help__count">
            {results.length === 0 ? 'Nenhum resultado' : plural(results.length, 'resultado', 'resultados')} para “{query.trim()}”
            <button type="button" className="btn btn--link" onClick={() => { setQuery(''); update({ q: null }); }}>Limpar busca</button>
          </div>
          {results.length > 0 ? (
            <div className="faq-list">{results.map((article) => item(article, true))}</div>
          ) : (
            <div className="help__empty">
              <strong>Não achamos nada com essas palavras.</strong>
              <span>Tente um termo mais simples (por exemplo, “senha”, “pix” ou “equipe”) ou escreva para a gente.</span>
            </div>
          )}
        </section>
      ) : (
        <>
          <Chips
            label="Assunto"
            value={category}
            onChange={(value) => update({ categoria: value === ALL ? null : value })}
            items={[{ key: ALL, label: 'Todos os assuntos' }, ...HELP.categories.map((section) => ({ key: section.id, label: section.title }))]}
          />
          {sections.map((section) => (
            <section key={section.id} className="help__section" aria-labelledby={`assunto-${section.id}`}>
              <h2 className="help__title" id={`assunto-${section.id}`}>{section.title}</h2>
              <p className="help__summary">{section.summary}</p>
              <div className="faq-list">{HELP.articles.filter((article) => article.category === section.id).map((article) => item(article, false))}</div>
            </section>
          ))}
        </>
      )}

      <div className="help__contact">
        <div>
          <strong>Não encontrou o que procurava?</strong>
          <span>Escreva para a equipe do Estoque Simples. A resposta chega pela área de suporte e pelas notificações.</span>
        </div>
        <Link to={supportTo} state={supportState?.(null)} className="btn btn--primary">
          <Icon name="help" size={17} /> {supportLabel}
        </Link>
      </div>
    </div>
  );
}
