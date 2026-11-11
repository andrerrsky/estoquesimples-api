import type { ReactNode } from 'react';

import type { PromoPrices } from '../api/types';
import { promoTexts } from '../lib/promo';

import '../styles/promo.css';

/**
 * As duas ofertas da campanha lado a lado: anual em destaque (total tão
 * visível quanto o equivalente por mês) e mensal secundário, cada uma com a
 * regra de renovação escrita por extenso. Usado na página Plano e na landing.
 */
export function PromoOffers({ prices, yearlyAction, monthlyAction }: { prices: PromoPrices; yearlyAction?: ReactNode; monthlyAction?: ReactNode }) {
  const t = promoTexts(prices);
  return (
    <div className="promo-offers">
      <section className="promo-offer promo-offer--featured" aria-label="Plano Equipe anual com desconto">
        <div className="promo-offer__name">
          Equipe anual <span className="promo-offer__pill">{t.yearlyPct}% off</span>
        </div>
        <div className="promo-offer__from">
          De <s>{t.yearlyFull}</s> por
        </div>
        <div className="promo-offer__price">
          {t.yearlyPromo} <small>no ano</small>
        </div>
        <div className="promo-offer__equiv">equivale a {t.yearlyPerMonth}/mês</div>
        <p className="promo-offer__fine">Pagamento único de {t.yearlyPromo} pelos 12 meses. {t.yearlyRenewal}</p>
        {yearlyAction}
      </section>

      <section className="promo-offer" aria-label="Plano Equipe mensal com desconto no primeiro mês">
        <div className="promo-offer__name">Equipe mensal</div>
        <div className="promo-offer__from">
          {t.monthlyFirstLabel} por
        </div>
        <div className="promo-offer__price">
          {t.monthlyFirst}
        </div>
        <div className="promo-offer__from">depois {t.monthlyFull}/mês</div>
        <p className="promo-offer__fine">{t.monthlyRenewal} Cancele quando quiser.</p>
        {monthlyAction}
      </section>
    </div>
  );
}
