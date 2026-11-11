import type { ReactNode } from 'react';

import type { PromoPrices } from '../api/types';
import { promoTexts } from '../lib/promo';

import '../styles/promo.css';

/**
 * As duas ofertas da campanha lado a lado. O destaque é o valor por mês, que
 * é como o pequeno lojista compara preço: no anual, o equivalente mensal vai
 * grande e o total à vista vai colado logo abaixo (CDC: o valor cobrado nunca
 * fica escondido; ele também aparece no botão). O mensal vem como segunda
 * opção, com o preço depois do 1º mês na mesma linha. Usado na página Plano.
 */
export function PromoOffers({ prices, yearlyAction, monthlyAction }: { prices: PromoPrices; yearlyAction?: ReactNode; monthlyAction?: ReactNode }) {
  const t = promoTexts(prices);
  return (
    <div className="promo-offers">
      <section className="promo-offer promo-offer--featured" aria-label="Plano Equipe anual com desconto">
        <div className="promo-offer__name">
          Plano anual <span className="promo-offer__pill">Melhor preço da Black Friday</span>
        </div>
        <div className="promo-offer__price">
          {t.yearlyPerMonth}
          <small>/mês</small>
        </div>
        <div className="promo-offer__equiv">
          {t.yearlyPromo} à vista <s>{t.yearlyFull}</s>
        </div>
        <p className="promo-offer__fine">Cobrança única por 12 meses · {t.yearlyRenewal}</p>
        {yearlyAction}
      </section>

      <section className="promo-offer" aria-label="Plano Equipe mensal com desconto no primeiro mês">
        <div className="promo-offer__name">Plano mensal</div>
        <div className="promo-offer__price promo-offer__price--md">
          {t.monthlyFirst} <small>no {t.monthlyFirstLabel}</small>
        </div>
        <div className="promo-offer__from">Depois {t.monthlyFull}/mês</div>
        <p className="promo-offer__fine">{t.monthlyRenewal} Cancele quando quiser.</p>
        {monthlyAction}
      </section>
    </div>
  );
}
