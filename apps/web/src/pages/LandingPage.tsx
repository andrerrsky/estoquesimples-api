import { useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { Icon, Logo, type IconName } from '../components/Icon';
import { ROLE_LABEL } from '../lib/labels';

import '../styles/pages-public.css';

const PLAY_URL = 'https://play.google.com/store/apps/details?id=br.com.gameloop.estoquesimples';

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
    <div className="lp-art" role="img" aria-label="Ilustração: a lista de produtos aberta no navegador e o mesmo produto, com a mesma quantidade, no aplicativo do celular. Um dos produtos aparece destacado por estar com estoque baixo.">
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
                {product.low && <Icon name="alert" size={14} style={{ verticalAlign: -2, marginRight: 4 }} />}
                {product.quantity} <span className="qty__unit">{product.unit}</span>
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
                {first.quantity} <small>{first.unit}</small>
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
                <Icon name="alert" size={14} style={{ verticalAlign: -1, marginRight: 3 }} />
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

/** Histórico em miniatura: entrada, saídas e um estorno, com as cores da tela real. */
function HistoryArt() {
  return (
    <div className="lp-panel" role="img" aria-label="Ilustração do histórico: uma entrada, duas saídas e o estorno de uma saída lançada por engano, cada linha com horário e quem lançou.">
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
    <div className="lp-panel" role="img" aria-label="Ilustração de um relatório: valor total em estoque, quantos produtos precisam de reposição e o valor por categoria, com um botão para exportar em CSV.">
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

function Point({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <li className="lp-point">
      <span className="feature__icon">
        <Icon name={icon} size={20} />
      </span>
      <div>
        <h3 className="feature__title">{title}</h3>
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
 * Página inicial pública (estoquesimples.com.br). Não busca nada na API: só
 * lê a sessão que o AuthProvider já retoma. Quem está com a conta aberta não
 * é redirecionado — pode querer ler a página —, mas os botões principais
 * passam a levar direto ao estoque.
 *
 * Tudo o que está escrito aqui existe no produto. Preço e limite de produtos
 * do plano gratuito ficam de fora de propósito: os dois são configuráveis no
 * servidor e aparecem dentro da aplicação, lidos da API.
 */
export function LandingPage() {
  const { status } = useAuth();
  const authed = status === 'authed';

  useEffect(() => {
    document.title = 'Estoque Simples · Controle de estoque no Android, na web e no computador';
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
          <Link to="/" className="lp-brand">
            <Logo size={34} /> Estoque Simples
          </Link>
          <nav className="lp-nav__links" aria-label="Seções da página">
            <a className="lp-nav__link" href="#recursos">Recursos</a>
            <a className="lp-nav__link" href="#plataformas">Plataformas</a>
            <a className="lp-nav__link" href="#planos">Planos</a>
          </nav>
          <div className="lp-nav__actions">
            {authed ? (
              <Link to="/app" className="btn btn--on-brand">Abrir meu estoque</Link>
            ) : (
              <>
                <Link to="/entrar" className="btn btn--outline-on-brand">Entrar</Link>
                <Link to="/criar-conta" className="btn btn--on-brand lp-nav__signup">Criar conta grátis</Link>
              </>
            )}
          </div>
        </div>
      </header>

      <main id="conteudo">
        <section className="landing__hero lp-on-brand" aria-labelledby="lp-titulo">
          <div className="landing__hero-inner">
            <div>
              <p className="lp-eyebrow">Controle de estoque para pequenos negócios</p>
              <h1 className="landing__title" id="lp-titulo">O mesmo estoque no celular, no tablet e no computador.</h1>
              <p className="landing__lead">
                Cadastre produtos, registre entradas e saídas e veja o que está acabando. Use no Android, no iPhone, no iPad ou no computador: o que você lança em um aparece em todos os outros.
              </p>
              <div className="landing__cta">
                {authed ? (
                  <>
                    <Link to="/app" className="btn btn--on-brand btn--lg">
                      Abrir meu estoque <Icon name="arrowRight" size={18} />
                    </Link>
                    <Link to="/plataformas" className="btn btn--outline-on-brand btn--lg">Onde usar</Link>
                  </>
                ) : (
                  <>
                    <Link to="/criar-conta" className="btn btn--on-brand btn--lg">Criar conta grátis</Link>
                    <Link to="/entrar" className="btn btn--outline-on-brand btn--lg">Já tenho conta</Link>
                  </>
                )}
              </div>
              <p className="lp-hero__note">{authed ? 'Você já entrou na sua conta neste navegador.' : 'Grátis para uma pessoa. Não pede cartão de crédito.'}</p>
            </div>
            <HeroArt />
          </div>
        </section>

        <section className="landing__section" id="recursos" aria-labelledby="lp-dia-a-dia">
          <div className="lp-split">
            <div>
              <p className="lp-kicker">No dia a dia</p>
              <h2 className="landing__h2" id="lp-dia-a-dia">Tudo o que entra e tudo o que sai fica registrado.</h2>
              <p className="lp-lead">Você sabe quanto tem de cada produto, o que mudou e quem lançou. Sem caderno e sem planilha para conferir no fim do dia.</p>
              <ul className="lp-points">
                <Point icon="tag" title="Produtos e categorias">
                  Cadastre com preço, unidade, código de barras e estoque mínimo. Separe por categoria, fornecedor e localização para achar tudo rápido.
                </Point>
                <Point icon="history" title="Entradas e saídas com histórico">
                  Cada movimentação guarda a quantidade, a data e quem lançou. Lançou errado? Faça o estorno: o histórico mostra o lançamento e a correção.
                </Point>
                <Point icon="alert" title="Aviso de estoque baixo">
                  Defina o mínimo de cada produto. Quem ficar abaixo dele aparece destacado na lista e entra no relatório de reposição.
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
                <p className="lp-kicker">Relatórios e planilhas</p>
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

        <section className="landing__section" id="plataformas" aria-labelledby="lp-plataformas">
          <div className="lp-platforms__head">
            <p className="lp-kicker">Plataformas</p>
            <h2 className="landing__h2" id="lp-plataformas">No Android, na web e instalado como aplicativo.</h2>
            <p className="lp-lead">A mesma conta e o mesmo estoque em qualquer lugar. Escolha o que combina com o seu aparelho.</p>
          </div>
          <div className="lp-platforms">
            <div className="card lp-platform">
              <span className="feature__icon"><Icon name="phone" size={22} /></span>
              <h3 className="feature__title lp-feature__title">Aplicativo Android</h3>
              <p>Guarda tudo no aparelho e funciona até sem internet. Quando a conexão volta, sincroniza com a sua conta. Tem fotos, leitura de código de barras pela câmera e aviso de estoque baixo.</p>
              <PlayLink className="btn btn--primary lp-platform__cta">
                Baixar na Google Play <Icon name="external" size={16} />
              </PlayLink>
            </div>
            <div className="card lp-platform">
              <span className="feature__icon"><Icon name="monitor" size={22} /></span>
              <h3 className="feature__title lp-feature__title">Versão web</h3>
              <p>Abre em qualquer navegador, sem instalar nada: no computador, no tablet ou no celular. Telas grandes, relatórios, importação de planilha e assinatura do plano por Pix, boleto ou cartão.</p>
              <Link to={authed ? '/app' : '/criar-conta'} className="btn btn--secondary lp-platform__cta">
                {authed ? 'Abrir meu estoque' : 'Criar conta e entrar'}
              </Link>
            </div>
            <div className="card lp-platform lp-platform--accent">
              <span className="feature__icon"><Icon name="layers" size={22} /></span>
              <h3 className="feature__title lp-feature__title">
                Web app <span className="badge badge--brand">iPhone e iPad</span>
              </h3>
              <p>Ainda não temos aplicativo para iPhone e iPad, mas você instala a versão web na tela inicial e usa como um aplicativo. Vale também para o computador.</p>
              <Link to="/plataformas" className="btn btn--secondary lp-platform__cta">
                Ver como instalar <Icon name="arrowRight" size={16} />
              </Link>
            </div>
          </div>

          <div className="lp-duo lp-duo--pair">
            <div className="card feature">
              <span className="feature__icon">
                <Icon name="barcode" size={20} />
              </span>
              <h3 className="feature__title lp-feature__title">Leitura de código de barras</h3>
              <p>Ache o produto pelo código: aponte a câmera, nos navegadores que oferecem esse recurso, ou use um leitor USB.</p>
            </div>
            <div className="card feature">
              <span className="feature__icon">
                <Icon name="users" size={20} />
              </span>
              <h3 className="feature__title lp-feature__title">
                Equipe com papéis e permissões <span className="badge badge--brand">Plano Equipe</span>
              </h3>
              <p>Convide pessoas por e-mail e escolha o papel de cada uma, de quem só consulta a quem administra a empresa.</p>
              <ul className="lp-roles" aria-label="Papéis disponíveis">
                {Object.values(ROLE_LABEL).map((role) => (
                  <li key={role} className="badge">{role}</li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        <div className="lp-band--tint">
          <section className="landing__section" id="planos" aria-labelledby="lp-planos">
            <div className="lp-plans">
              <div>
                <p className="lp-kicker">Planos</p>
                <h2 className="landing__h2" id="lp-planos">Comece grátis. Assine quando a equipe crescer.</h2>
                <p className="lp-lead">Mudar de plano não apaga nada: seus produtos e o histórico continuam guardados.</p>
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
                    <li className="lp-limit"><Icon name="info" /> Com limite de produtos na nuvem</li>
                  </ul>
                  {authed ? (
                    <Link to="/app" className="btn btn--secondary btn--block">Abrir meu estoque</Link>
                  ) : (
                    <Link to="/criar-conta" className="btn btn--secondary btn--block">Criar conta grátis</Link>
                  )}
                </div>

                <div className="card lp-plan lp-plan--featured">
                  <div>
                    <h3 className="lp-plan__name">
                      Equipe <span className="badge badge--solid">Assinatura</span>
                    </h3>
                    <p className="lp-plan__for">Para quem trabalha com mais gente.</p>
                  </div>
                  <ul className="check-list">
                    <li><Icon name="check" /> Tudo do plano Gratuito</li>
                    <li><Icon name="check" /> Produtos sem limite</li>
                    <li><Icon name="check" /> Equipe com papéis e permissões</li>
                    <li><Icon name="check" /> Análise avançada: giro dos produtos e previsão de quando cada um acaba</li>
                  </ul>
                  <p className="lp-plan__note">A assinatura é da empresa: uma pessoa assina e toda a equipe usa. O valor aparece dentro do aplicativo, em Plano.</p>
                  {authed ? (
                    <Link to="/app/plano" className="btn btn--primary btn--block">Ver o plano Equipe</Link>
                  ) : (
                    <Link to="/criar-conta" state={{ from: '/app/plano' }} className="btn btn--primary btn--block">Criar conta e ver valores</Link>
                  )}
                </div>
              </div>
            </div>
          </section>
        </div>

        <section className="lp-cta lp-on-brand" aria-labelledby="lp-comecar">
          <div className="lp-cta__inner">
            <div>
              <h2 id="lp-comecar">Comece pelo primeiro produto.</h2>
              <p>Crie a conta, cadastre o que está na prateleira e acompanhe daqui para a frente.</p>
            </div>
            <div className="landing__cta">
              {authed ? (
                <Link to="/app" className="btn btn--on-brand btn--lg">
                  Abrir meu estoque <Icon name="arrowRight" size={18} />
                </Link>
              ) : (
                <>
                  <Link to="/criar-conta" className="btn btn--on-brand btn--lg">Criar conta grátis</Link>
                  <Link to="/entrar" className="btn btn--outline-on-brand btn--lg">Entrar</Link>
                </>
              )}
            </div>
          </div>
        </section>
      </main>

      <footer className="landing__footer">
        <div className="lp-footer__inner">
          <div className="lp-footer__brand">
            <Logo size={26} /> Estoque Simples <span>© {new Date().getFullYear()}</span>
          </div>
          <ul className="lp-footer__links">
            <li><Link to="/termos">Termos de Uso</Link></li>
            <li><Link to="/privacidade">Política de Privacidade</Link></li>
            <li><Link to="/entrar">Entrar</Link></li>
            <li><Link to="/ajuda">Central de ajuda</Link></li>
            <li><Link to="/plataformas">Plataformas</Link></li>
          </ul>
        </div>
      </footer>
    </div>
  );
}
