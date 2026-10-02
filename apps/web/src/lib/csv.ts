import type { ImportRow } from '../api/types';
import { parseNumber } from './format';

/**
 * Leitura de planilha (CSV) no navegador, com as mesmas regras do app
 * (`DataExchange`): delimitador `;` ou `,` detectado pelo cabeçalho, campos
 * entre aspas com quebras de linha, BOM ignorado e os mesmos apelidos de
 * coluna. O arquivo não sai do navegador: só as linhas interpretadas vão
 * para a API.
 */

export function parseCsv(text: string): string[][] {
  const source = text.replace(/^﻿/, '');
  const firstLine = source.split(/\r?\n/, 1)[0] ?? '';
  const count = (line: string, char: string) => {
    let total = 0;
    let quoted = false;
    for (const c of line) {
      if (c === '"') quoted = !quoted;
      else if (c === char && !quoted) total += 1;
    }
    return total;
  };
  const delimiter = count(firstLine, ';') > count(firstLine, ',') ? ';' : ',';

  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === delimiter) {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && source[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some((value) => value.trim() !== '')) rows.push(row);
      row = [];
    } else {
      cell += c;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== '')) rows.push(row);
  return rows;
}

const normalizeHeader = (value: string): string =>
  value
    .trim()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[\s.-]+/g, '_');

const ALIASES: Record<keyof ImportRow, string[]> = {
  id: ['id', 'uuid'],
  name: ['nome', 'name', 'produto'],
  description: ['descricao', 'description'],
  quantity: ['quantidade', 'quantity', 'qtd', 'estoque'],
  unitValue: ['valor', 'preco', 'unitvalue', 'unit_value', 'valor_unitario'],
  category: ['categoria', 'category'],
  sku: ['sku'],
  barcode: ['codigo_barras', 'codigo_de_barras', 'barcode', 'ean'],
  supplier: ['fornecedor', 'supplier'],
  location: ['localizacao', 'location'],
  minStock: ['estoque_minimo', 'min_stock', 'minstock'],
  unit: ['unidade', 'unit'],
};

/** Sem cabeçalho, as colunas são posicionais (a 4 é a antiga coluna de foto). */
const POSITIONAL: Array<keyof ImportRow | null> = ['name', 'description', 'quantity', 'unitValue', null, 'category', 'sku', 'barcode', 'supplier', 'location', 'minStock', 'unit'];

const LIMITS: Partial<Record<keyof ImportRow, number>> = { name: 200, description: 2000, category: 120, supplier: 120, location: 120, sku: 80, barcode: 80, unit: 30 };
const NUMERIC = new Set<keyof ImportRow>(['quantity', 'unitValue', 'minStock']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedSheet {
  rows: ImportRow[];
  /** Colunas reconhecidas, para mostrar na prévia. */
  columns: Array<keyof ImportRow>;
  hasHeader: boolean;
  /** Arquivo de movimentações (tem `change_type`): não é importado por aqui. */
  isMovements: boolean;
  skipped: number;
}

export function sheetToRows(table: string[][]): ParsedSheet {
  const header = table[0] ?? [];
  const normalized = header.map(normalizeHeader);
  const first = normalized[0] ?? '';
  const hasHeader = ['nome', 'name', 'produto', 'id', 'sku'].includes(first);
  const isMovements = normalized.some((value) => value === 'change_type' || value === 'changetype');

  const mapping: Array<keyof ImportRow | null> = hasHeader
    ? normalized.map((column) => (Object.keys(ALIASES) as Array<keyof ImportRow>).find((key) => ALIASES[key].includes(column)) ?? null)
    : POSITIONAL;

  const rows: ImportRow[] = [];
  let skipped = 0;
  for (const line of hasHeader ? table.slice(1) : table) {
    const row: ImportRow = {};
    line.forEach((raw, index) => {
      const field = mapping[index];
      if (!field) return;
      const value = raw.trim();
      if (value === '') return;
      if (NUMERIC.has(field)) {
        const parsed = parseNumber(value);
        if (parsed !== null && !Number.isNaN(parsed)) (row as Record<string, unknown>)[field] = field === 'quantity' ? parsed : Math.max(0, parsed);
      } else if (field === 'id') {
        if (UUID.test(value)) row.id = value.toLowerCase();
      } else {
        (row as Record<string, unknown>)[field] = value.slice(0, LIMITS[field] ?? 200);
      }
    });
    if (Object.keys(row).length === 0) {
      skipped += 1;
      continue;
    }
    rows.push(row);
  }
  return { rows, columns: [...new Set(mapping.filter((field): field is keyof ImportRow => field !== null))], hasHeader, isMovements, skipped };
}
