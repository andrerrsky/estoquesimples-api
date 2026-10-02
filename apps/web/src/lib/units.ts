/**
 * Unidades de medida: mesmas regras do app e da API
 * (apps/api/src/modules/inventory/units.ts). A API valida de novo; aqui é
 * para avisar antes de enviar.
 */

const normalize = (unit: string): string => unit.trim().toLowerCase().replace(/\./g, '');

const ACCEPTED = new Set([
  'un', 'kg', 'g', 'l', 'ml', 'caixa', 'pacote', 'dúzia', 'duzia', 'par', 'm', 'cm', 'saco', 'pote', 'fardo',
  'rolo', 'lata', 'garrafa', 'frasco', 'bandeja', 'kit', 'pct', 'cx', 'dz', 'sc',
  'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'peça', 'pecas', 'peças',
]);

const WHOLE = new Set([
  'un', 'und', 'unid', 'unidade', 'unidades', 'pc', 'pç', 'peça', 'pecas', 'peças', 'pct', 'pacote', 'pacotes',
  'cx', 'caixa', 'caixas', 'dz', 'dúzia', 'duzia', 'dúzias', 'sc', 'saco', 'sacos', 'pote', 'potes', 'fardo',
  'fardos', 'par', 'pares', 'rolo', 'rolos', 'lata', 'latas', 'garrafa', 'garrafas', 'frasco', 'frascos',
  'bandeja', 'bandejas', 'kit', 'kits',
]);

export const DEFAULT_UNITS = ['un', 'kg', 'g', 'L', 'ml', 'caixa', 'pacote', 'dúzia', 'par', 'm', 'saco', 'pote', 'fardo'];

export function isValidUnit(unit: string | null | undefined): boolean {
  if (!unit || unit.trim() === '') return true;
  return ACCEPTED.has(normalize(unit));
}

export function isWholeUnit(unit: string | null | undefined): boolean {
  if (!unit || unit.trim() === '') return true;
  return WHOLE.has(normalize(unit));
}

export function hasFraction(value: number): boolean {
  return Math.abs(value - Math.round(value)) > 1e-9;
}

export function fractionMessage(unit: string | null | undefined): string {
  return `Este produto é contado por ${unit && unit.trim() !== '' ? unit.trim() : 'unidade'}, sem fração: informe um número inteiro.`;
}

export const UNIT_ERROR = 'Escolha uma unidade da lista (un, kg, g, L, ml, caixa, pacote…).';
