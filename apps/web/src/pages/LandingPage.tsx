import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';

import { useAuthOptional } from '../auth/context';
import { Icon, Logo, type IconName } from '../components/Icon';
import { ROLE_LABEL } from '../lib/labels';

import '../styles/pages-public.css';

/**
 * Vídeo e capa ficam em public/assets/video com nome fixo (e cache de um
 * ano, como tudo em /assets): o Google indexa o vídeo por essa URL e ela
 * não pode mudar a cada build. Mudou o vídeo? Troque o nome do arquivo.
 */
const videoApresentacao = '/assets/video/apresentacao.mp4';
const videoCapa = '/assets/video/apresentacao-capa.webp';

const PLAY_URL = 'https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples';

/** O vídeo de apresentação, também descrito ao Google em JSON-LD (scripts/prerender.mjs). */
export const VIDEO = {
  src: videoApresentacao,
  poster: videoCapa,
  name: 'Estoque Simples: como funciona no dia a dia',
  description: 'Cadastro de produtos, entradas e saídas, aviso de estoque baixo, relatórios, a conta grátis e o plano Equipe, tudo nas telas reais do aplicativo.',
  /** ISO 8601; o arquivo tem 1 min 40 s. */
  duration: 'PT1M40S',
  uploadDate: '2026-10-17',
};

/**
 * Avaliação pública do app na Google Play. A página não consulta nada ao
 * vivo (CSP só permite a própria origem), então o número é copiado da
 * listagem a cada versão: `ratingValue` e `ratingCount` em
 * play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples.
 * Conferido em 17/10/2026: 4,50 com 3.096 avaliações. Arredondado para
 * baixo de propósito, para a página nunca prometer mais do que a loja mostra.
 */
export const PLAY_RATING = {
  /** Como aparece na página. */
  stars: '4,5',
  count: 'mais de 3 mil avaliações',
  /** Como vai no JSON-LD (scripts/prerender.mjs); mesmos números, formato da schema.org. */
  ratingValue: '4.5',
  ratingCount: '3096',
};

/**
 * Dados de exemplo das ilustrações. São os mesmos quatro produtos em todas
 * (lista, celular, histórico, relatório), para a página contar uma história
 * só. Não são números de clientes nem de uso: é uma mercearia inventada.
 */
const SAMPLE_PRODUCTS = [
  { name: 'Café torrado 500 g', meta: 'Mercearia', quantity: '42', unit: 'un', low: false, featured: true },
  { name: 'Filtro de papel nº 103', meta: 'Utilidades · mínimo 10', quantity: '4', unit: 'cx', low: true, featured: false },
  { name: 'Açúcar cristal 1 kg', meta: 'Mercearia', quantity: '18', unit: 'un', low: false, featured: false },
  { name: 'Leite integral 1 L', meta: 'Bebidas', quantity: '60', unit: 'un', low: false, featured: false },
];

const SAMPLE_MOVEMENTS = [
  { label: 'Entrada', tone: 'in', name: 'Café torrado 500 g', sub: '09:14 · Marina', amount: '+12 un', reversed: false },
  { label: 'Saída', tone: 'out', name: 'Açúcar cristal 1 kg', sub: '10:02 · João', amount: '-3 un', reversed: false },
  { label: 'Saída', tone: 'out', name: 'Leite integral 1 L', sub: '10:40 · João · estornada', amount: '-6 un', reversed: true },
  { label: 'Estorno', tone: 'neutral', name: 'Leite integral 1 L', sub: '10:52 · João', amount: '+6 un', reversed: false },
];

const SAMPLE_CATEGORIES = [
  { name: 'Mercearia', value: 'R$ 883,62', share: 100 },
  { name: 'Bebidas', value: 'R$ 329,40', share: 37 },
  { name: 'Utilidades', value: 'R$ 26,00', share: 3 },
];

/**
 * Quando a página roda na entrada leve (`landing-main.tsx`), sem o
 * AuthProvider, é por aqui que ela fica sabendo se há sessão: `null` =
 * ainda não se sabe (trata como visitante).
 */
export const LandingSessionContext = createContext<boolean | null>(null);

/** Atalhos das seções: na barra em telas largas e numa linha que quebra no celular. */
const SECTIONS = [
  { href: '#video', label: 'Vídeo' },
  { href: '#recursos', label: 'Recursos' },
  { href: '#plataformas', label: 'Plataformas' },
  { href: '#planos', label: 'Planos' },
  { href: '#duvidas', label: 'Dúvidas' },
];

/**
 * A quantidade do produto em destaque, nos dois aparelhos: uma vez, logo
 * depois de a página abrir, uma "Saída" é lançada na lista e o número muda
 * nos dois lugares (de 42 para 30, e fica). É a frase da abertura ("com a
 * mesma conta") acontecendo, só com CSS; parado para quem pede menos
 * movimento.
 */
function AnimatedQty({ before, after, unit, small }: { before: string; after: string; unit: string; small?: boolean }) {
  const Unit = small ? 'small' : 'span';
  return (
    <>
      <span className="lp-anim-qty">
        <span className="lp-anim-qty__before">{before}</span>
        <span className="lp-anim-qty__after" aria-hidden="true">{after}</span>
      </span>{' '}
      <Unit className={small ? undefined : 'qty__unit'}>{unit}</Unit>
    </>
  );
}

/** Miniatura dos botões de movimentação do estoque (só desenho, não clica). */
function MoveButtons() {
  return (
    <>
      <span className="lp-mini lp-mini--out">
        <Icon name="minus" size={13} /> Saída
      </span>
      <span className="lp-mini lp-mini--in">
        <Icon name="plus" size={13} /> Entrada
      </span>
    </>
  );
}

/**
 * Ilustração da abertura, feita de HTML com as peças da própria aplicação: a
 * lista do estoque no navegador e, na frente, o mesmo produto com a mesma
 * quantidade no celular. É o argumento da página ("os mesmos dados") em
 * imagem, sem foto de banco nem captura de tela que envelhece.
 */
function HeroArt() {
  const [first, second] = SAMPLE_PRODUCTS;
  return (
    <div className="lp-art" role="img" aria-label="Lista de produtos no computador e o mesmo produto, com a mesma quantidade, no celular. Um item aparece destacado por estoque baixo.">
      <div className="lp-desk">
        <div className="lp-desk__bar">
          <span className="lp-desk__url">
            <Icon name="lock" size={11} /> estoquesimples.com.br/app/estoque
          </span>
        </div>
        <div className="lp-desk__body">
          <div className="lp-desk__head">
            <div>
              <div className="lp-desk__title">Estoque</div>
              <div className="lp-desk__sub">4 produtos · 1 com estoque baixo</div>
            </div>
            <span className="btn btn--primary btn--sm">
              <Icon name="plus" size={15} /> Novo produto
            </span>
          </div>
          <div className="lp-desk__chips">
            <span className="lp-chip lp-chip--active">
              Todos <span>4</span>
            </span>
            <span className="lp-chip">
              Estoque baixo <span>1</span>
            </span>
          </div>
          {SAMPLE_PRODUCTS.map((product) => (
            <div key={product.name} className={`preview__row lp-row ${product.featured ? 'lp-row--featured' : ''}`}>
              <div className="lp-row__main">
                <div className="lp-row__name">{product.name}</div>
                <div className="lp-row__meta">{product.meta}</div>
              </div>
              <span className={`qty ${product.low ? 'qty--low' : ''}`}>
                {product.low && <Icon name="alert" size={14} style={{ verticalAlign: -2, marginRight: 4, color: 'var(--warning)' }} />}
                {product.featured ? (
                  <AnimatedQty before={product.quantity} after="30" unit={product.unit} />
                ) : (
                  <>
                    {product.quantity} <span className="qty__unit">{product.unit}</span>
                  </>
                )}
              </span>
              <div className="lp-row__actions">
                <MoveButtons />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="lp-phone">
        <div className="lp-phone__bar">Estoque Simples</div>
        <div className="lp-phone__body">
          {first && (
            <div className="lp-phone__card">
              <div className="lp-phone__name">{first.name}</div>
              <div className="lp-phone__meta">{first.meta}</div>
              <div className="lp-phone__qty">
                <AnimatedQty before={first.quantity} after="30" unit={first.unit} small />
              </div>
              <div className="lp-phone__actions">
                <MoveButtons />
              </div>
            </div>
          )}
          {second && (
            <div className="lp-phone__card">
              <div className="lp-phone__name">{second.name}</div>
              <div className="lp-phone__qty lp-phone__qty--low">
                <Icon name="alert" size={14} style={{ verticalAlign: -1, marginRight: 3, color: 'var(--warning)' }} />
                {second.quantity} <small>{second.unit}</small>
              </div>
            </div>
          )}
        </div>
        <div className="lp-phone__nav">
          <Icon name="box" size={15} />
          <Icon name="history" size={15} />
          <Icon name="chart" size={15} />
          <Icon name="menu" size={15} />
        </div>
      </div>
    </div>
  );
}

/**
 * Vídeo de apresentação (o mesmo da Google Play e do YouTube), servido pela
 * própria origem: a CSP não permite iframe nem mídia de terceiros. Só começa
 * a baixar quando a pessoa aperta play (`preload="none"`) e tem legenda, para
 * quem assiste sem som. As telas do vídeo são do app com dados de exemplo.
 */
function VideoSection() {
  return (
    <section className="landing__section lp-video" id="video" aria-labelledby="lp-video">
      <div className="lp-video__head">
        <p className="lp-kicker">Veja em menos de 2 minutos</p>
        <h2 className="landing__h2" id="lp-video">Como o controle de estoque funciona no dia a dia.</h2>
        <p className="lp-lead">Cadastro, entradas e saídas, aviso de estoque baixo, relatórios, a conta grátis e o plano Equipe, tudo nas telas reais do aplicativo.</p>
      </div>
      <div className="lp-video__frame">
        <video
          className="lp-video__player"
          controls
          playsInline
          preload="none"
          poster={videoCapa}
          aria-label="Vídeo de apresentação do Estoque Simples, com narração e legendas"
        >
          <source src={videoApresentacao} type="video/mp4" />
          <track kind="captions" src="/video/apresentacao.vtt" srcLang="pt-BR" label="Português" default />
          Seu navegador não toca vídeos. <a href={videoApresentacao}>Baixe o vídeo</a>.
        </video>
      </div>
    </section>
  );
}

/** Histórico em miniatura: entrada, saídas e um estorno, com as cores da tela real. */
function HistoryArt() {
  return (
    <div className="lp-panel" role="img" aria-label="Histórico: uma entrada, duas saídas e o estorno de uma saída lançada por engano, cada linha com horário e quem lançou.">
      <div className="card card--flush">
        <div className="lp-panel__head">
          Histórico <span>hoje</span>
        </div>
        <div className="list">
          {SAMPLE_MOVEMENTS.map((movement) => (
            <div key={`${movement.name}-${movement.sub}`} className={`list__item lp-move ${movement.reversed ? 'lp-move--reversed' : ''}`}>
              <span className={`type-badge type-badge--${movement.tone}`}>{movement.label}</span>
              <div className="list__main">
                <div className="list__title">{movement.name}</div>
                <div className="list__sub">{movement.sub}</div>
              </div>
              <span className={`movement movement--${movement.tone}`}>{movement.amount}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/** Relatório em miniatura: os dois números que mais importam e a divisão por categoria. */
function ReportArt() {
  return (
    <div className="lp-panel" role="img" aria-label="Relatório: valor total em estoque, quantos produtos precisam de reposição e o valor por categoria, com um botão para exportar em CSV.">
      <div className="lp-tiles">
        <div className="tile">
          <div className="tile__label">Valor em estoque</div>
          <div className="tile__value">R$ 1.239,02</div>
          <div className="tile__foot">4 produtos</div>
        </div>
        <div className="tile tile--alert">
          <div className="tile__label">Para repor</div>
          <div className="tile__value">1</div>
          <div className="tile__foot">abaixo do mínimo</div>
        </div>
      </div>
      <div className="card">
        <div className="card__header">
          <div className="card__title">Valor por categoria</div>
        </div>
        <div className="hbars">
          {SAMPLE_CATEGORIES.map((category) => (
            <div key={category.name} className="hbar">
              <span>{category.name}</span>
              <span className="num strong">{category.value}</span>
              <div className="hbar__track">
                <div className="hbar__fill" style={{ width: `${category.share}%` }} />
              </div>
            </div>
          ))}
        </div>
        <div className="lp-panel__foot">
          <span className="btn btn--secondary btn--sm">
            <Icon name="download" size={15} /> Exportar CSV
          </span>
        </div>
      </div>
    </div>
  );
}

/** Um recurso: ícone de traço na cor da marca, sem caixa, e o texto ao lado. */
function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="lp-point">
      <Icon name={icon} size={22} className="lp-point__icon" aria-hidden="true" />
      <div>
        <h3 className="lp-point__title">{title}</h3>
        <p>{children}</p>
      </div>
    </li>
  );
}

function PlayLink({ className, children }: { className: string; children: ReactNode }) {
  return (
    <a href={PLAY_URL} target="_blank" rel="noopener noreferrer" className={className}>
      {children}
      <span className="sr-only"> (abre em outra aba)</span>
    </a>
  );
}

/**
 * "4,5 ★ na Google Play": a única prova social da página, com número real.
 * As estrelas preenchem 90% (4,5 de 5), não cinco inteiras: o desenho não
 * pode prometer mais do que o número ao lado.
 */
function PlayRating({ className }: { className?: string }) {
  return (
    <PlayLink className={`lp-rating ${className ?? ''}`}>
      <span className="lp-rating__score">
        <span className="lp-rating__stars" aria-hidden="true">
          ★★★★★<span className="lp-rating__fill" style={{ width: '90%' }}>★★★★★</span>
        </span>
        <strong>
          <span className="sr-only">nota </span>
          {PLAY_RATING.stars}
          <span className="sr-only"> de 5</span>
        </strong>
      </span>
      <span>na Google Play · {PLAY_RATING.count}</span>
    </PlayLink>
  );
}

/**
 * As dúvidas que mais seguram quem está decidindo. As respostas são resumos
 * da central de ajuda (packages/help/faq.json, artigos sem-internet,
 * seguranca, cancelar, limites-gratuito): mudou lá, confira aqui.
 */
const FAQ = [
  {
    id: 'sem-internet',
    question: 'Funciona sem internet?',
    answer: 'No aplicativo Android, sim: você cadastra, movimenta e consulta normalmente, e o que foi feito sobe para a nuvem quando a conexão voltar. A versão web precisa de internet.',
  },
  {
    id: 'seguranca',
    question: 'Meus dados ficam seguros? E se eu trocar de celular?',
    answer: 'Com uma conta, o estoque fica guardado na nuvem: entre no aparelho novo e ele está lá (antes de trocar, confira em Conta e nuvem se não ficou nada pendente de envio). A comunicação é cifrada, a senha é guardada de um jeito que nem a nossa equipe consegue ler, e só quem faz parte da empresa vê o estoque dela.',
  },
  {
    id: 'cancelar',
    question: 'Posso cancelar a assinatura quando quiser?',
    answer: 'Sim, no mesmo lugar em que assinou: em Plano, na web, ou nas assinaturas da sua conta na Google Play. O plano continua valendo até o fim do período já pago e depois a empresa volta ao gratuito, sem apagar nada.',
  },
  {
    id: 'limites-gratuito',
    question: 'Quantos produtos cabem no plano gratuito?',
    answer: 'No celular, sem usar a nuvem, não há limite. Na nuvem há um teto de produtos, e o número aparece em Plano, na web, ou em Conta e nuvem, no aplicativo, junto com quantos você já usa.',
  },
];

function FaqSection() {
  return (
    <section className="landing__section lp-faq" id="duvidas" aria-labelledby="lp-duvidas">
      <div className="lp-faq__head">
        <h2 className="landing__h2" id="lp-duvidas">O que mais perguntam antes de criar a conta.</h2>
        <a href="/ajuda" className="lp-textlink">
          Ver todas as perguntas na Central de ajuda <Icon name="arrowRight" size={16} />
        </a>
      </div>
      <div className="lp-faq__list">
        {FAQ.map((item) => (
          <details key={item.id} className="lp-faq__item">
            <summary className="lp-faq__q">
              {item.question}
              <Icon name="chevronDown" size={20} className="lp-faq__chevron" aria-hidden="true" />
            </summary>
            <p className="lp-faq__a">{item.answer}</p>
          </details>
        ))}
      </div>
    </section>
  );
}

/**
 * Abre o chat de suporte. Na página inicial o balão é o de `landing-extras`,
 * que escuta o evento; na aplicação completa é o `SupportChat`, clicado pelo
 * balão visível. Já aberto, o foco vai para a conversa.
 */
function openSupportChat(): void {
  const input = document.querySelector<HTMLInputElement>('.chat__input');
  if (input) {
    input.focus();
    return;
  }
  document.dispatchEvent(new CustomEvent('estoque:abrir-chat'));
  const launcher = [...document.querySelectorAll<HTMLButtonElement>('.chat-launcher')].find((candidate) => candidate.offsetParent !== null);
  if (launcher && launcher.getAttribute('aria-expanded') !== 'true' && launcher.closest('#extras') === null) launcher.click();
}

/** O balão do chat já está na página? (avisado por `landing-extras`, ou já presente na aplicação) */
function useChatReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const check = () => setReady(document.querySelector('.chat-launcher') !== null);
    check();
    document.addEventListener('estoque:chat-pronto', check);
    return () => document.removeEventListener('estoque:chat-pronto', check);
  }, []);
  return ready;
}

/**
 * Página inicial pública (estoquesimples.com.br). Não busca nada na API: só
 * lê a sessão que o AuthProvider já retoma. Quem está com a conta aberta não
 * é redirecionado — pode querer ler a página —, mas os botões principais
 * passam a levar direto ao estoque.
 *
 * Também é renderizada no build, sem navegador (`src/entry-prerender.tsx`),
 * para o HTML de `/` chegar pronto a buscadores e a quem compartilha o link;
 * no navegador a entrada leve (`landing-main.tsx`) hidrata esse HTML sem o
 * resto da aplicação. Por isso os links são <a> comuns (não há roteador) e
 * nada aqui pode depender de `window` na renderização, só em efeitos.
 *
 * Tudo o que está escrito aqui existe no produto. Preço e limite de produtos
 * do plano gratuito ficam de fora de propósito: os dois são configuráveis no
 * servidor e aparecem dentro da aplicação, lidos da API.
 */
export function LandingPage() {
  const fromShell = useAuthOptional()?.status === 'authed';
  const fromLanding = useContext(LandingSessionContext);
  const authed = fromLanding ?? fromShell;

  // O ano sai fixo do build e só é corrigido depois do mount: assim o HTML
  // pré-renderizado e o primeiro render do cliente são iguais na virada do ano.
  const [year, setYear] = useState(2026);
  useEffect(() => setYear(new Date().getFullYear()), []);
  const chatReady = useChatReady();

  useEffect(() => {
    document.title = 'Estoque Simples · Controle de estoque no celular e na web';
    return () => {
      document.title = 'Estoque Simples';
    };
  }, []);

  return (
    <div className="lp">
      <a className="lp-skip" href="#conteudo">
        Pular para o conteúdo
      </a>

      <header className="landing__hero lp-on-brand">
        <div className="landing__nav">
          <a href="/" className="lp-brand">
            <Logo size={34} /> Estoque Simples
          </a>
          <nav className="lp-nav__links" aria-label="Seções da página">
            {SECTIONS.map((section) => (
              <a key={section.href} className="lp-nav__link" href={section.href}>{section.label}</a>
            ))}
          </nav>
          <div className="lp-nav__actions">
            {authed ? (
              <a href="/app" className="btn btn--on-brand">Abrir meu estoque</a>
            ) : (
              <>
                <a href="/entrar" className="btn btn--outline-on-brand">Entrar</a>
                <a href="/criar-conta" className="btn btn--on-brand lp-nav__signup">Criar conta grátis</a>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="conteudo">
        <section className="landing__hero lp-on-brand">
          <div className="landing__hero-inner">
            <div className="lp-hero__text">
              <p className="lp-eyebrow">Controle de estoque para mercearia, loja, pet shop e qualquer balcão</p>
              <h1 className="landing__title" id="lp-titulo">Saiba o que tem na prateleira sem contar tudo de novo.</h1>
              <p className="landing__lead">
                Cadastre os produtos, lance o que entra e o que sai e veja o que está acabando. No celular e no computador, com a mesma conta.
              </p>
              <div className="landing__cta">
                {authed ? (
                  <>
                    <a href="/app" className="btn btn--on-brand btn--lg">
                      Abrir meu estoque <Icon name="arrowRight" size={18} />
                    </a>
                    <a href="/plataformas" className="btn btn--outline-on-brand btn--lg">Onde usar</a>
                  </>
                ) : (
                  <>
                    <a href="/criar-conta" className="btn btn--on-brand btn--lg">Criar conta grátis</a>
                    <a href="/entrar" className="btn btn--outline-on-brand btn--lg">Já tenho conta</a>
                  </>
                )}
              </div>
              <p className="lp-hero__note">{authed ? 'Você já entrou na sua conta neste navegador.' : 'Grátis para uma pessoa, sem cartão de crédito.'}</p>
              <PlayRating className="lp-rating--on-brand" />
            </div>
            <HeroArt />
          </div>
        </section>

        {/* No celular a barra não tem espaço para os atalhos: eles vêm aqui, numa linha rolável. */}
        <nav className="lp-sections" aria-label="Seções da página">
          {SECTIONS.map((section) => (
            <a key={section.href} className="lp-chip" href={section.href}>{section.label}</a>
          ))}
        </nav>

        <VideoSection />

        <section className="landing__section" id="recursos" aria-labelledby="lp-dia-a-dia">
          <div className="lp-split">
            <div>
              <h2 className="landing__h2" id="lp-dia-a-dia">Tudo o que entra e tudo o que sai fica registrado.</h2>
              <p className="lp-lead">Você sabe quanto tem de cada produto, o que mudou e, na web, quem lançou. Sem caderno e sem planilha para conferir no fim do dia.</p>
              <ul className="lp-points">
                <Point icon="tag" title="Produtos e categorias">
                  Cadastre com preço, unidade, código de barras e estoque mínimo. Separe por categoria, fornecedor e localização para achar tudo rápido.
                </Point>
                <Point icon="history" title="Entradas e saídas com histórico">
                  Cada movimentação guarda a quantidade, a data e, na web, quem lançou. Lançou errado? Faça o estorno: o histórico mostra o lançamento e a correção.
                </Point>
                <Point icon="alert" title="Aviso de estoque baixo">
                  Defina o mínimo de cada produto. O que ficar abaixo dele aparece destacado na lista e entra no relatório de reposição.
                </Point>
              </ul>
            </div>
            <div className="lp-split__art">
              <HistoryArt />
            </div>
          </div>
        </section>

        <div className="lp-band--tint">
          <section className="landing__section" aria-labelledby="lp-relatorios">
            <div className="lp-split lp-split--reverse">
              <div>
                <h2 className="landing__h2" id="lp-relatorios">Números prontos para decidir o que comprar.</h2>
                <p className="lp-lead">O resumo do estoque se monta sozinho a partir do que você lança. E, quando precisar, os dados entram e saem em planilha.</p>
                <ul className="lp-points">
                  <Point icon="chart" title="Relatórios do estoque">
                    Valor total em estoque, o que precisa de reposição, entradas e saídas por período e a divisão por categoria.
                  </Point>
                  <Point icon="download" title="Exportação em CSV">
                    Baixe a lista de produtos e as movimentações em CSV e abra no Excel ou no Google Planilhas.
                  </Point>
                  <Point icon="upload" title="Importação de planilha">
                    Já tem os produtos numa planilha? Salve em CSV e importe todos de uma vez, em vez de digitar um por um.
                  </Point>
                </ul>
              </div>
              <div className="lp-split__art">
                <ReportArt />
              </div>
            </div>
          </section>
        </div>

        <section className="landing__section landing__section--dense" id="plataformas" aria-labelledby="lp-plataformas">
          <div className="lp-platforms__head">
            <p className="lp-kicker">Plataformas</p>
            <h2 className="landing__h2" id="lp-plataformas">No Android e em qualquer navegador, com a mesma conta.</h2>
            <p className="lp-lead">O estoque é um só. Escolha o que combina com o seu aparelho.</p>
          </div>
          <div className="lp-platforms">
            <div className="lp-platform lp-platform--android">
              <div className="lp-platform__art" aria-hidden="true">
                <div className="lp-phone lp-phone--static">
                  <div className="lp-phone__bar">Estoque Simples</div>
                  <div className="lp-phone__body">
                    <div className="lp-phone__search">
                      <Icon name="search" size={12} /> Buscar ou ler código <Icon name="barcode" size={13} />
                    </div>
                    <div className="lp-phone__card">
                      <div className="lp-phone__name">Leite integral 1 L</div>
                      <div className="lp-phone__qty">
                        60 <small>un</small>
                      </div>
                    </div>
                  </div>
                  <div className="lp-phone__nav">
                    <Icon name="box" size={15} />
                    <Icon name="history" size={15} />
                    <Icon name="chart" size={15} />
                    <Icon name="menu" size={15} />
                  </div>
                </div>
              </div>
              <div>
                <h3 className="lp-platform__title">Aplicativo Android</h3>
                <p>Guarda tudo no aparelho e funciona até sem internet. Quando a conexão volta, sincroniza com a sua conta. Tem fotos, leitura de código de barras pela câmera e aviso de estoque baixo.</p>
                <PlayLink className="btn btn--primary lp-platform__cta">
                  Baixar na Google Play <Icon name="external" size={16} />
                </PlayLink>
                <PlayRating />
              </div>
            </div>
            <div className="lp-platform lp-platform--web">
              <h3 className="lp-platform__title">No navegador: computador, iPhone e iPad</h3>
              <p>Abre em qualquer navegador, sem instalar nada: cadastro, conferência, relatórios e a assinatura do plano por Pix, boleto ou cartão. No computador, tudo isso em tela grande.</p>
              <p>No iPhone e no iPad, adicione à tela inicial e use como aplicativo. Ainda não temos app na App Store.</p>
              <div className="lp-platform__actions">
                <a href={authed ? '/app' : '/criar-conta'} className="btn btn--secondary lp-platform__cta">
                  {authed ? 'Abrir meu estoque' : 'Criar conta e entrar'}
                </a>
                <a href="/plataformas" className="lp-textlink">
                  Como instalar na tela inicial <Icon name="arrowRight" size={16} />
                </a>
              </div>
            </div>
          </div>

          <div className="lp-extras">
            <Icon name="barcode" size={22} className="lp-point__icon" aria-hidden="true" />
            <div>
              <h3 className="lp-point__title">Leitura de código de barras nos dois</h3>
              <p>No aplicativo, aponte a câmera do celular. No computador, um leitor USB funciona direto no campo de busca (em alguns navegadores, a câmera também).</p>
            </div>
          </div>
        </section>

        <div className="lp-band--tint">
          <section className="landing__section landing__section--roomy" id="planos" aria-labelledby="lp-planos">
            <div className="lp-plans">
              <div>
                <p className="lp-kicker">Planos</p>
                <h2 className="landing__h2" id="lp-planos">Comece grátis. Assine quando a equipe crescer.</h2>
                <p className="lp-lead">A conta gratuita não tem prazo. Mudar de plano não apaga nada: seus produtos e o histórico continuam guardados.</p>
              </div>

              <div className="lp-plans__cards">
                <div className="card lp-plan">
                  <div>
                    <h3 className="lp-plan__name">Gratuito</h3>
                    <p className="lp-plan__for">Para quem cuida do estoque sozinho.</p>
                  </div>
                  <ul className="check-list">
                    <li><Icon name="check" /> Estoque na nuvem para uma pessoa</li>
                    <li><Icon name="check" /> Produtos, entradas e saídas, histórico e relatórios</li>
                    <li><Icon name="check" /> Importação e exportação em CSV</li>
                    <li><Icon name="check" /> Android e web (no iPhone, iPad e computador) com a mesma conta</li>
                    <li className="lp-limit"><Icon name="info" /> Com limite de produtos e de espaço para fotos na nuvem</li>
                  </ul>
                  <p className="lp-plan__note">Sem prazo e sem cartão. Quando a equipe crescer, você muda de plano sem perder nada.</p>
                  {authed ? (
                    <a href="/app" className="btn btn--secondary btn--block">Abrir meu estoque</a>
                  ) : (
                    <a href="/criar-conta" className="btn btn--secondary btn--block">Criar conta grátis</a>
                  )}
                </div>

                <div className="card lp-plan lp-plan--featured">
                  <div>
                    <div className="lp-plan__head">
                      <h3 className="lp-plan__name">Equipe</h3>
                      <span className="badge badge--solid">Assinatura</span>
                    </div>
                    <p className="lp-plan__for">Para quem trabalha com mais gente.</p>
                  </div>
                  <ul className="check-list">
                    <li><Icon name="check" /> Tudo do plano Gratuito</li>
                    <li><Icon name="check" /> Produtos sem limite</li>
                    <li>
                      <Icon name="check" />
                      <div>
                        Equipe com papéis e permissões: convide por e-mail e escolha o que cada pessoa pode fazer
                        {/* Proprietário fica de fora: não se atribui por convite, só por transferência. */}
                        <ul className="lp-roles" aria-label="Papéis que você pode atribuir">
                          {Object.entries(ROLE_LABEL)
                            .filter(([key]) => key !== 'proprietario')
                            .map(([key, role]) => (
                              <li key={key} className="badge">{role}</li>
                            ))}
                        </ul>
                      </div>
                    </li>
                    <li><Icon name="check" /> Análise avançada: giro dos produtos e previsão de quando cada um acaba</li>
                    <li><Icon name="check" /> Sua marca: cores, logotipo e página de entrada própria da empresa</li>
                    <li><Icon name="check" /> Mais espaço para fotos dos produtos</li>
                  </ul>
                  <p className="lp-plan__note">Uma pessoa assina e toda a equipe usa. O valor está em Plano, na web, e em Plano Equipe, no aplicativo; você só assina quando quiser.</p>
                  {authed ? (
                    <a href="/app/plano" className="btn btn--primary btn--block">Ver o plano Equipe</a>
                  ) : (
                    <a href="/criar-conta?depois=/app/plano" className="btn btn--primary btn--block">Criar conta e ver valores</a>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        <FaqSection />

        <section className="lp-cta lp-on-brand">
          <div className="lp-cta__inner">
            <div>
              <h2 id="lp-comecar">Comece pelo primeiro produto.</h2>
              <p>Crie a conta, cadastre o que está na prateleira e acompanhe daqui para a frente.</p>
            </div>
            <div className="landing__cta">
              {authed ? (
                <a href="/app" className="btn btn--on-brand btn--lg">
                  Abrir meu estoque <Icon name="arrowRight" size={18} />
                </a>
              ) : (
                <>
                  <a href="/criar-conta" className="btn btn--on-brand btn--lg">Criar conta grátis</a>
                  <a href="/entrar" className="btn btn--outline-on-brand btn--lg">Entrar</a>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="lp-footer__inner">
          <div className="lp-footer__brand">
            <Logo size={26} /> Estoque Simples <span>© {year}</span>
          </div>
          <ul className="lp-footer__links">
            <li><a href="/ajuda">Central de ajuda</a></li>
            {/* Só quando o chat está na página (telas largas): no celular o
                visitante não tem canal sem conta, e a Central de ajuda já está ao lado. */}
            {chatReady && (
              <li>
                <button type="button" className="lp-footer__button" onClick={openSupportChat}>
                  Fale com o suporte
                </button>
              </li>
            )}
            <li><a href="/plataformas">Onde usar</a></li>
            <li><a href="/termos">Termos de Uso</a></li>
            <li><a href="/privacidade">Política de Privacidade</a></li>
            <li><a href="/entrar">Entrar</a></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
