import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { Logo } from '../components/Icon';
import { track } from '../lib/analytics';
import { countdown, endDayLabel, hasPrices, landingCtaUrl, normalizeCoupon, promoTexts, readCoupon, type PromoTexts } from '../lib/promo';
import { usePromo } from '../lib/use-promo';

import '../styles/bf-landing.css';

/**
 * Landing pública da campanha (/black-friday), no molde de /comece: rota da
 * SPA, sem menu que tire a pessoa daqui, título e descrição próprios. Tudo o
 * que é número vem de `GET /v1/public/promo` (preço, datas, código); sem
 * resposta, a página não inventa oferta. O CTA leva ao cadastro (ou ao Plano,
 * com sessão) com `?cupom=` e as UTMs da visita; o cupom também fica guardado
 * neste navegador (`captureCouponFromUrl` no App), então sobrevive ao cadastro.
 *
 * Linguagem visual de varejo, não de "template": vídeo real de um mercadinho
 * no fundo, o preço numa etiqueta de prateleira (com código de barras, que é
 * o dia a dia de quem usa o app) e o que o plano libera impresso como um
 * cupom fiscal. Vídeo: Nathanael Arias no Pexels (licença Pexels, uso
 * comercial livre), reduzido para 720p e sem áudio em public/video/.
 *
 * Fases: `upcoming` mostra "Começa em 20/11" sem botão de compra; `active`,
 * a contagem até o `endsAt` real; `ended` (ou sem campanha), "A oferta
 * terminou" com o caminho para os preços normais.
 */

const RECEIPT: Array<[string, string]> = [
  ['Produtos no estoque', 'ilimitados'],
  ['Pessoas da equipe', 'cada uma com seu papel'],
  ['App Android + navegador', 'mesmo estoque'],
  ['Custo, margem e lucro', 'por produto'],
  ['Lista de reposição', 'pronta pro WhatsApp'],
  ['Análise de giro', 'o que vende e o que encalha'],
  ['Funciona sem internet', 'no app'],
];

function faq(t: PromoTexts) {
  return [
    {
      q: 'O que acontece depois do primeiro ano (ou do primeiro mês)?',
      a: `O anual renova por ${t.yearlyFull}/ano e o mensal passa a ${t.monthlyFull}/mês a partir da 2ª cobrança. Avisamos por e-mail antes da cobrança no preço normal.`,
    },
    { q: 'Posso cancelar?', a: 'Sim, a qualquer momento, pela página Plano. Sem fidelidade e sem multa: você usa até o fim do período pago e nada é apagado.' },
    { q: 'Quais as formas de pagamento?', a: 'Pix (o QR Code aparece na própria página e o plano é liberado na hora), cartão de crédito ou boleto.' },
    {
      q: 'Quem pode usar o desconto?',
      a: 'Empresas que ainda não têm assinatura do plano Equipe, uma vez por empresa e por CPF/CNPJ. O plano vale no app e na web, para toda a equipe.',
    },
  ];
}

function useNow(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [enabled]);
  return now;
}

function setMeta(name: string, content: string): () => void {
  let tag = document.head.querySelector<HTMLMetaElement>(`meta[name="${name}"]`);
  const created = !tag;
  const previous = tag?.content ?? null;
  if (!tag) {
    tag = document.createElement('meta');
    tag.name = name;
    document.head.appendChild(tag);
  }
  tag.content = content;
  return () => {
    if (created) tag?.remove();
    else if (tag && previous !== null) tag.content = previous;
  };
}

/** Separa "R$ 119,90" em ["R$", "119", "90"] para a etiqueta. */
function splitPrice(label: string): { currency: string; whole: string; cents: string } {
  const match = /^(\D*?)\s*([\d.]+),(\d{2})$/.exec(label.replace(/ /g, ' ').trim());
  if (!match) return { currency: '', whole: label, cents: '' };
  return { currency: match[1]?.trim() ?? 'R$', whole: match[2] ?? '', cents: match[3] ?? '' };
}

/** Código de barras decorativo: larguras fixas (derivadas do código), sem aleatório. */
function Barcode({ seed }: { seed: string }) {
  const bars = useMemo(() => {
    const out: number[] = [];
    const source = `${seed}ESTOQUESIMPLES`;
    for (let i = 0; i < 34; i += 1) out.push(((source.charCodeAt(i % source.length) + i * 7) % 3) + 1);
    return out;
  }, [seed]);
  return (
    <span className="bfx-barcode" aria-hidden="true">
      {bars.map((w, i) => (
        <i key={i} style={{ width: w, marginRight: i % 2 ? 2 : 1 }} />
      ))}
    </span>
  );
}

function PriceTag({
  tone,
  name,
  fromLabel,
  price,
  suffix,
  per,
  note,
  code,
  children,
}: {
  tone: 'yellow' | 'paper';
  name: string;
  fromLabel: ReactNode;
  price: string;
  /** Sufixo ao lado do preço ("/mês"); vazio quando o preço é o total. */
  suffix?: string;
  per: ReactNode;
  note: string;
  code: string;
  children?: ReactNode;
}) {
  const p = splitPrice(price);
  return (
    <article className={`bfx-tag bfx-tag--${tone}`}>
      <header className="bfx-tag__head">
        <span>{name}</span>
        <span className="bfx-tag__sku">{code}</span>
      </header>
      <p className="bfx-tag__from">{fromLabel}</p>
      <p className="bfx-tag__price" aria-label={`${price}${suffix ?? ''}`}>
        <span className="bfx-tag__cur">{p.currency}</span>
        <span className="bfx-tag__whole">{p.whole}</span>
        <span className="bfx-tag__cents">
          ,{p.cents}
          {suffix && <span className="bfx-tag__suffix">{suffix}</span>}
        </span>
      </p>
      <p className="bfx-tag__per">{per}</p>
      <footer className="bfx-tag__foot">
        <Barcode seed={`${code}${name}`} />
        <span>{note}</span>
      </footer>
      {children && <div className="bfx-tag__action">{children}</div>}
    </article>
  );
}

function BackgroundVideo() {
  const ref = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(true);

  // Quem pediu menos movimento no sistema vê só a imagem parada.
  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    let reduce = false;
    try {
      reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      reduce = false;
    }
    if (reduce) {
      video.pause();
      setPlaying(false);
    }
  }, []);

  const toggle = () => {
    const video = ref.current;
    if (!video) return;
    if (video.paused) {
      void video.play().catch(() => undefined);
      setPlaying(true);
    } else {
      video.pause();
      setPlaying(false);
    }
  };

  return (
    <>
      <video ref={ref} className="bfx-hero__video" autoPlay muted loop playsInline preload="metadata" poster="/video/bf-loja-poster.jpg" aria-hidden="true">
        <source src="/video/bf-loja.webm" type="video/webm" />
        <source src="/video/bf-loja.mp4" type="video/mp4" />
      </video>
      <button type="button" className="bfx-hero__pause" onClick={toggle} aria-label={playing ? 'Pausar o vídeo de fundo' : 'Tocar o vídeo de fundo'}>
        {playing ? (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M4 2.5v11l9-5.5z" /></svg>
        )}
      </button>
    </>
  );
}

export function BlackFridayPage() {
  const { status } = useAuth();
  const authed = status === 'authed';
  const { promo, phase, loading } = usePromo();
  const live = phase === 'active';
  const now = useNow(live);

  useEffect(() => {
    document.title = 'Black Friday: Estoque Simples por R$ 9,99/mês · Estoque Simples';
    const restore = setMeta('description', 'Black Friday Estoque Simples: plano Equipe por R$ 9,99/mês no anual (R$ 119,90 à vista, de R$ 199,90). Ou 1º mês por R$ 12,49. Cupom BF26 até 01/12.');
    return () => {
      document.title = 'Estoque Simples';
      restore();
    };
  }, []);

  const viewed = useRef(false);
  useEffect(() => {
    if (viewed.current || loading) return;
    viewed.current = true;
    const coupon = normalizeCoupon(new URLSearchParams(window.location.search).get('cupom')) ?? readCoupon();
    track('promo.landing_viewed', { campaign: promo?.code ?? 'none', coupon: coupon ?? null });
  }, [loading, promo]);

  const code = promo?.code ?? 'BF26';
  const ctaUrl = useMemo(() => (typeof window === 'undefined' ? '/criar-conta' : landingCtaUrl(window.location.search, authed, code)), [authed, code]);
  const prices = promo && hasPrices(promo) ? promo : null;
  const t = prices ? promoTexts(prices) : null;
  const left = countdown(promo?.endsAt, now);
  const startDay = endDayLabel(promo?.startsAt) || '20/11';
  const endDay = endDayLabel(promo?.endsAt) || '01/12';
  const ended = !loading && (phase === 'ended' || phase === 'none' || (live && left.done) || !prices);
  const open = live && !left.done;

  const cta = (label: string, variant: 'solid' | 'line' = 'solid') =>
    open ? (
      <Link to={ctaUrl} className={`bfx-btn bfx-btn--${variant}`}>
        {label} <span aria-hidden="true">→</span>
      </Link>
    ) : (
      <span className="bfx-btn bfx-btn--line bfx-btn--off" aria-disabled="true">
        Começa em {startDay}
      </span>
    );

  const clock = `${left.days}d ${String(left.hours).padStart(2, '0')}h ${String(left.minutes).padStart(2, '0')}m ${String(left.seconds).padStart(2, '0')}s`;

  return (
    <div className="bfx">
      <section className="bfx-hero" aria-labelledby="bf-titulo">
        <BackgroundVideo />
        <div className="bfx-hero__scrim" aria-hidden="true" />

        <header className="bfx-top">
          <Link to="/" className="bfx-top__brand">
            <Logo size={26} /> Estoque Simples
          </Link>
          <Link to={authed ? '/app' : '/entrar'} className="bfx-top__link">
            {authed ? 'Abrir meu estoque' : 'Entrar'}
          </Link>
        </header>

        <div className="bfx-hero__grid">
          <div className="bfx-hero__copy">
            <p className="bfx-kicker">
              <span className="bfx-kicker__dot" aria-hidden="true" /> Black Friday · {startDay} a {endDay}
            </p>
            {t && !ended ? (
              <h1 className="bfx-title" id="bf-titulo">
                Controle seu estoque por <mark>{t.yearlyPerMonth}/mês</mark>
              </h1>
            ) : (
              <h1 className="bfx-title" id="bf-titulo">Black Friday Estoque Simples</h1>
            )}
            {t && !ended && (
              <p className="bfx-lead">
                Plano Equipe anual de <s>{t.yearlyFull}</s> por {t.yearlyPromo} à vista com o cupom {code}. Prefere mensal? {t.monthlyFirstLabel} por{' '}
                {t.monthlyFirst}. Pra quem cansou de caderninho e planilha.
              </p>
            )}

            {loading ? (
              <p className="bfx-clock">Carregando a oferta…</p>
            ) : ended ? (
              <p className="bfx-clock">A oferta terminou.</p>
            ) : phase === 'upcoming' ? (
              <p className="bfx-clock">
                Começa em <strong>{startDay}</strong>, à meia-noite.
              </p>
            ) : (
              <p className="bfx-clock" aria-label={`A oferta termina em ${endDay}, às 23h59. Faltam ${left.days} dias e ${left.hours} horas.`}>
                Termina em <strong className="bfx-clock__digits">{clock}</strong>
              </p>
            )}

            {!ended && !loading && t && <div className="bfx-hero__cta">{cta(authed ? 'Garantir no meu plano' : 'Criar conta e garantir')}</div>}
          </div>

          {t && !ended && (
            <div className="bfx-hero__tag">
              <PriceTag
                tone="yellow"
                name="Plano Equipe · anual"
                code={code}
                fromLabel="no plano anual"
                price={t.yearlyPerMonth}
                suffix="/mês"
                per={
                  <>
                    {t.yearlyPromo} à vista · de <s>{t.yearlyFull}</s>
                  </>
                }
                note={`-${t.yearlyPct}%`}
              />
            </div>
          )}
        </div>
      </section>

      <main className="bfx-main">
        {ended ? (
          <section className="bfx-ended" aria-label="Oferta encerrada">
            <h2>A Black Friday acabou</h2>
            <p>Dá para começar grátis agora e assinar o plano Equipe quando a equipe crescer.</p>
            <a href="/#planos" className="bfx-btn bfx-btn--solid">
              Ver os preços <span aria-hidden="true">→</span>
            </a>
          </section>
        ) : t ? (
          <section className="bfx-offers" aria-labelledby="bf-ofertas">
            <div className="bfx-section-head">
              <h2 id="bf-ofertas">Duas etiquetas, escolha a sua</h2>
              <p>O desconto vale uma vez por empresa. Cancela quando quiser, sem multa.</p>
            </div>
            <div className="bfx-offers__row">
              <PriceTag
                tone="yellow"
                name="Plano anual · melhor preço"
                code={code}
                fromLabel="equivale a"
                price={t.yearlyPerMonth}
                suffix="/mês"
                per={
                  <>
                    {t.yearlyPromo} à vista · de <s>{t.yearlyFull}</s>
                  </>
                }
                note={`Cobrança única por 12 meses. ${t.yearlyRenewal}`}
              >
                {cta(`Assinar por ${t.yearlyPromo}`)}
              </PriceTag>
              <PriceTag
                tone="paper"
                name="Plano mensal"
                code={code}
                fromLabel={<>{t.monthlyFirstLabel} por</>}
                price={t.monthlyFirst}
                per={`depois ${t.monthlyFull}/mês`}
                note={t.monthlyRenewal}
              >
                {cta(`Começar por ${t.monthlyFirst}`, 'line')}
              </PriceTag>
            </div>
          </section>
        ) : null}

        <section className="bfx-receipt-wrap" aria-labelledby="bf-recibo">
          <div className="bfx-section-head">
            <h2 id="bf-recibo">O que vem no plano Equipe</h2>
            <p>Uma assinatura vale para a empresa toda, no celular e no computador.</p>
          </div>
          <div className="bfx-receipt" role="list">
            <p className="bfx-receipt__top" aria-hidden="true">
              ESTOQUE SIMPLES
              <br />
              PLANO EQUIPE · CUPOM {code}
            </p>
            {RECEIPT.map(([item, value]) => (
              <p className="bfx-receipt__line" role="listitem" key={item}>
                <span>{item}</span>
                <span className="bfx-receipt__dots" aria-hidden="true" />
                <span>{value}</span>
              </p>
            ))}
            {t && (
              <p className="bfx-receipt__total">
                <span>TOTAL NO ANO</span>
                <span>
                  <s>{t.yearlyFull}</s> {t.yearlyPromo}
                </span>
              </p>
            )}
            <p className="bfx-receipt__thanks" aria-hidden="true">
              obrigado pela preferência
            </p>
          </div>
        </section>

        {t && (
          <section className="bfx-faq" aria-labelledby="bf-duvidas">
            <h2 id="bf-duvidas">Perguntas de quem vai assinar</h2>
            <div>
              {faq(t).map((item) => (
                <details key={item.q}>
                  <summary>{item.q}</summary>
                  <p>{item.a}</p>
                </details>
              ))}
            </div>
          </section>
        )}

        {!ended && !loading && t && (
          <section className="bfx-closing">
            <p>
              Até <strong>{endDay}, 23h59</strong>. Depois volta a {t.yearlyFull}
            </p>
            {cta(authed ? 'Ir para o meu plano' : 'Criar conta e garantir o desconto')}
          </section>
        )}
      </main>

      <footer className="bfx-foot">
        <nav>
          <Link to="/">Início</Link>
          <a href="/#planos">Preços</a>
          <Link to="/termos">Termos</Link>
          <Link to="/privacidade">Privacidade</Link>
        </nav>
        <p>Vídeo: Nathanael Arias / Pexels</p>
      </footer>
    </div>
  );
}
