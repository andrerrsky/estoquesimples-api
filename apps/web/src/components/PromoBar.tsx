import { useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { track } from '../lib/analytics';
import { barVisible, dismissBar, endDayLabel, promoTexts, readBarDismissed, saveCoupon } from '../lib/promo';
import { useWorkspaceOffer } from '../lib/use-promo';
import { Icon } from './Icon';

import '../styles/promo.css';

/**
 * Faixa fina da campanha no topo do app logado. Só para quem pode assinar e
 * tem a empresa elegível (ver `useWorkspaceOffer`); some na página Plano, que
 * tem o próprio cartão. Fechada, só volta no último dia, uma vez (lib/promo.ts).
 */
export function PromoBar() {
  const offer = useWorkspaceOffer();
  const { pathname } = useLocation();
  const code = offer?.code ?? null;
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!code) return;
    setDismissedAt(readBarDismissed(code));
    setLoaded(true);
  }, [code]);

  const visible = offer !== null && loaded && !pathname.startsWith('/app/plano') && barVisible(dismissedAt, offer.promo.endsAt);
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!visible || !offer || seen.current === offer.code) return;
    seen.current = offer.code;
    track('promo.banner_viewed', { surface: 'web_topo', campaign: offer.code });
  }, [visible, offer]);

  if (!visible || !offer) return null;
  const texts = promoTexts(offer.promo);
  const until = endDayLabel(offer.promo.endsAt);
  const label = offer.promo.label ?? 'Black Friday';

  return (
    <div className="promo-bar no-print" role="region" aria-label={`Oferta ${label}`}>
      <p className="promo-bar__text">
        <span className="promo-bar__tag">{label}<span className="sr-only">:</span></span>
        <span className="promo-bar__long">
          plano Equipe anual por <strong>{texts.yearlyPerMonth}/mês</strong> ({texts.yearlyPromo} à vista, de <s>{texts.yearlyFull}</s>). Cupom {offer.code}
          {until ? ` até ${until}.` : '.'}
        </span>
        <span className="promo-bar__short">
          Anual por <strong>{texts.yearlyPerMonth}/mês</strong> ({texts.yearlyPromo} à vista){until ? `. Até ${until}` : ''}
        </span>
      </p>
      <Link
        to={`/app/plano?cupom=${encodeURIComponent(offer.code)}&origem=bf_faixa`}
        className="promo-bar__cta"
        onClick={() => {
          saveCoupon(offer.code, offer.promo.endsAt);
          track('promo.banner_clicked', { surface: 'web_topo', campaign: offer.code });
        }}
      >
        Garantir desconto
      </Link>
      <button
        type="button"
        className="promo-bar__close"
        aria-label="Fechar oferta"
        onClick={() => {
          const now = Date.now();
          dismissBar(offer.code, now);
          setDismissedAt(now);
          track('promo.banner_dismissed', { surface: 'web_topo', campaign: offer.code });
        }}
      >
        <Icon name="x" size={16} />
      </button>
    </div>
  );
}
