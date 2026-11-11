import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { Icon, Logo, type IconName } from '../components/Icon';
import { PromoOffers } from '../components/PromoOffers';
import { track } from '../lib/analytics';
import { countdown, endDayLabel, hasPrices, landingCtaUrl, normalizeCoupon, promoTexts, readCoupon } from '../lib/promo';
import { usePromo } from '../lib/use-promo';

import '../styles/promo.css';

/**
 * Landing pública da campanha (/black-friday), no molde de /comece: rota da
 * SPA, sem menu que tire a pessoa daqui, título e descrição próprios. Tudo o
 * que é número vem de `GET /v1/public/promo` (preço, datas, código); sem
 * resposta, a página não inventa oferta. O CTA leva ao cadastro (ou ao Plano,
 * com sessão) com `?cupom=` e as UTMs da visita; o cupom também fica guardado
 * neste navegador (`captureCouponFromUrl` no App), então sobrevive ao cadastro.
 *
 * Fases: `upcoming` mostra "Começa em 20/11" sem botão de compra; `active`,
 * a contagem até o `endsAt` real; `ended` (ou sem campanha), "A oferta
 * terminou" com o caminho para os preços normais.
 */

const BENEFITS: Array<{ icon: IconName; title: string; text: string }> = [
  { icon: 'box', title: 'Produtos ilimitados', text: 'Cadastre o estoque inteiro, sem o teto de 50 do plano grátis.' },
  { icon: 'users', title: 'Equipe no mesmo estoque', text: 'Funcionários e sócios lançam do próprio celular, cada um com seu papel.' },
  { icon: 'cloud', title: 'Sincronização', text: 'O mesmo estoque no app e na web, atualizado para todo mundo.' },
  { icon: 'trend', title: 'Custo, margem e lucro', text: 'Veja quanto cada produto dá de lucro e onde está o dinheiro parado.' },
  { icon: 'layers', title: 'Lista de reposição', text: 'Saiba o que repor primeiro, antes de faltar na prateleira.' },
];

function faq(yearlyFull: string, monthlyFull: string) {
  return [
    {
      q: 'O que acontece depois do primeiro ano (ou do primeiro mês)?',
      a: `O anual renova por ${yearlyFull}/ano e o mensal passa a ${monthlyFull}/mês a partir da 2ª cobrança. Avisamos por e-mail antes da cobrança no preço normal.`,
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

export function BlackFridayPage() {
  const { status } = useAuth();
  const authed = status === 'authed';
  const { promo, phase, loading } = usePromo();
  const live = phase === 'active';
  const now = useNow(live);

  useEffect(() => {
    document.title = 'Black Friday: plano Equipe com 40% off · Estoque Simples';
    const restore = setMeta('description', 'Black Friday Estoque Simples: plano Equipe anual de R$ 199,90 por R$ 119,90 (equivale a R$ 9,99/mês). Produtos ilimitados, equipe e sincronização. Até 01/12.');
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
  const texts = prices ? promoTexts(prices) : null;
  const left = countdown(promo?.endsAt, now);
  const startDay = endDayLabel(promo?.startsAt) || '20/11';
  const endDay = endDayLabel(promo?.endsAt) || '01/12';
  const ended = !loading && (phase === 'ended' || phase === 'none' || (live && left.done) || !prices);

  const cta = (label: string, primary = true) =>
    live && !left.done ? (
      <Link to={ctaUrl} className={`btn ${primary ? 'btn--promo' : 'btn--promo-ghost'} btn--lg btn--block`}>
        {label}
      </Link>
    ) : (
      <span className="btn btn--promo-ghost btn--lg btn--block" aria-disabled="true">
        Começa em {startDay}
      </span>
    );

  return (
    <div className="bf">
      <header className="bf__top">
        <Link to="/" className="bf__brand">
          <Logo size={28} /> Estoque Simples
        </Link>
        <Link to={authed ? '/app' : '/entrar'} className="btn btn--promo-ghost btn--sm">
          {authed ? 'Abrir meu estoque' : 'Já tenho conta'}
        </Link>
      </header>

      <section className="bf__hero" aria-labelledby="bf-titulo">
        <div className="bf__wrap">
          <span className="bf__eyebrow">Black Friday{texts ? ` · ${texts.yearlyPct}% off` : ''}</span>
          <h1 className="bf__title" id="bf-titulo">Black Friday Estoque Simples</h1>
          {texts && !ended && (
            <p className="bf__headline">
              Plano Equipe anual: de <s>{texts.yearlyFull}</s> por
              <br />
              <strong>{texts.yearlyPromo}</strong>
              <br />
              equivale a {texts.yearlyPerMonth}/mês
            </p>
          )}
          {loading ? (
            <p className="bf__status">Carregando a oferta…</p>
          ) : ended ? (
            <p className="bf__status">A oferta terminou</p>
          ) : phase === 'upcoming' ? (
            <p className="bf__status">Começa em {startDay}</p>
          ) : (
            <>
              <p className="bf__status">A oferta termina em {endDay}, às 23h59</p>
              <ul className="bf__countdown" aria-label={`Faltam ${left.days} dias, ${left.hours} horas e ${left.minutes} minutos`}>
                <li><strong>{left.days}</strong><span>dias</span></li>
                <li><strong>{String(left.hours).padStart(2, '0')}</strong><span>horas</span></li>
                <li><strong>{String(left.minutes).padStart(2, '0')}</strong><span>min</span></li>
                <li><strong>{String(left.seconds).padStart(2, '0')}</strong><span>seg</span></li>
              </ul>
            </>
          )}
        </div>
      </section>

      <main className="bf__main">
        {ended ? (
          <section className="bf__ended" aria-label="Oferta encerrada">
            <h2 className="bf__section-title" style={{ margin: 0 }}>A oferta terminou</h2>
            <p className="muted" style={{ margin: 0 }}>A Black Friday acabou, mas dá para começar grátis e assinar o plano Equipe quando quiser.</p>
            <a href="/#planos" className="btn btn--primary">Ver os preços</a>
          </section>
        ) : prices ? (
          <PromoOffers prices={prices} yearlyAction={cta(`Garantir o anual por ${texts?.yearlyPromo ?? ''}`)} monthlyAction={cta('Começar no mensal', false)} />
        ) : null}

        <section aria-labelledby="bf-beneficios">
          <h2 className="bf__section-title" id="bf-beneficios">O que o plano Equipe libera</h2>
          <ul className="bf__benefits">
            {BENEFITS.map((item) => (
              <li key={item.title}>
                <Icon name={item.icon} size={20} />
                <span>
                  <strong>{item.title}</strong>
                  <br />
                  <span className="muted">{item.text}</span>
                </span>
              </li>
            ))}
          </ul>
          <p className="muted" style={{ marginTop: 12 }}>Uma assinatura vale para a empresa toda, no app e na web.</p>
        </section>

        {texts && (
          <section className="bf__faq" aria-labelledby="bf-duvidas">
            <h2 className="bf__section-title" id="bf-duvidas">Dúvidas</h2>
            {faq(texts.yearlyFull, texts.monthlyFull).map((item) => (
              <details key={item.q}>
                <summary>{item.q}</summary>
                <p>{item.a}</p>
              </details>
            ))}
          </section>
        )}

        {!ended && !loading && texts && <div style={{ maxWidth: 420, width: '100%', justifySelf: 'center' }}>{cta(authed ? 'Ir para o meu plano' : 'Criar conta e garantir o desconto')}</div>}
      </main>

      <footer className="bf__foot">
        <Link to="/">Início</Link> · <a href="/#planos">Preços</a> · <Link to="/termos">Termos</Link> · <Link to="/privacidade">Privacidade</Link>
      </footer>
    </div>
  );
}
