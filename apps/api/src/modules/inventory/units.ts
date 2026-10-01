/**
 * Unidades de medida — mesmas regras do app Android (`Unidades.java`), para
 * que a web aceite e recuse exatamente o que o aparelho aceita e recusa.
 */

const normalize = (unit: string): string => unit.trim().toLowerCase().replace(/\./g, '');

/** Unidades aceitas no cadastro (comparação sem caixa e sem pontos). */
const ACCEPTED = new Set([
  'un', 'kg', 'g', 'l', 'ml', 'caixa', 'pacote', 'dúzia', 'duzia', 'par', 'm', 'cm', 'saco', 'pote', 'fardo',
  'rolo', 'lata', 'garrafa', 'frasco', 'bandeja', 'kit', 'pct', 'cx', 'dz', 'sc',
  // Formas por extenso que o app também reconhece como unidade inteira.
  'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'peça', 'pecas', 'peças',
]);

/** Contadas por inteiro: fração não faz sentido (vazio conta como "un"). */
const WHOLE = new Set([
  'un', 'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'peça', 'pecas', 'peças', 'pct', 'pacote', 'pacotes',
  'cx', 'caixa', 'caixas', 'dz', 'dúzia', 'duzia', 'dúzias', 'sc', 'saco', 'sacos', 'pote', 'potes', 'fardo',
  'fardos', 'par', 'pares', 'rolo', 'rolos', 'lata', 'latas', 'garrafa', 'garrafas', 'frasco', 'frascos',
  'bandeja', 'bandejas', 'kit', 'kits',
]);

/** Sugestões na ordem que o app mostra. */
export const DEFAULT_UNITS = ['un', 'kg', 'g', 'L', 'ml', 'caixa', 'pacote', 'dúzia', 'par', 'm', 'saco', 'pote', 'fardo'];

export function isValidUnit(unit: string | null | undefined): boolean {
  if (unit === null || unit === undefined || unit.trim() === '') return true;
  return ACCEPTED.has(normalize(unit));
}

export function isWholeUnit(unit: string | null | undefined): boolean {
  if (unit === null || unit === undefined || unit.trim() === '') return true;
  return WHOLE.has(normalize(unit));
}

export function hasFraction(value: number): boolean {
  return Math.abs(value - Math.round(value)) > 1e-9;
}

export function fractionMessage(unit: string | null | undefined): string {
  const label = unit && unit.trim() !== '' ? unit.trim() : 'unidade';
  return `Este produto é contado por ${label}, sem fração: informe um número inteiro.`;
}
