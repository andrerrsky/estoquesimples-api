/**
 * Contas sobre movimentações que a tela precisa fazer antes de confirmar algo.
 */

/**
 * Saldo que o produto terá se esta movimentação for estornada.
 *
 * `quantity` vem com sinal (negativo reduziu o estoque), e estornar aplica o
 * contrário — por isso a subtração vale para os dois lados: estornar uma
 * entrada de +10 tira 10, estornar uma saída de -10 devolve 10.
 *
 * O resultado nunca é negativo: o estoque não guarda saldo abaixo de zero, e
 * mostrar "-3 un" na confirmação assustaria sem motivo.
 */
export function saldoAposEstorno(atual: number, quantity: number): number {
  return Math.max(0, atual - quantity);
}
