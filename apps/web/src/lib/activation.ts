/**
 * Eventos ao salvar um produto. `product.created` vai ao analytics próprio e
 * ao GA a cada cadastro; `product.first_created` sai **só** quando a API diz
 * que é o primeiro produto que a empresa já teve (`firstProduct`), como sinal
 * de ativação. É evento de observação no GA4: virar meta de lance no Google
 * Ads é decisão do proprietário, depois de ver os números.
 */
export interface SavedProductEvents {
  /** Vai para `track()` (analytics próprio + GA). */
  track: 'product.created' | 'product.updated';
  /** Só para o GA (a API já sabe qual foi o primeiro produto). */
  ga: 'product.first_created' | null;
}

export function productSavedEvents(isNew: boolean, saved: { firstProduct?: boolean } | null | undefined): SavedProductEvents {
  if (!isNew) return { track: 'product.updated', ga: null };
  return { track: 'product.created', ga: saved?.firstProduct === true ? 'product.first_created' : null };
}
