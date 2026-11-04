/**
 * Relatório de avaliações da Play Console (Download de relatórios › Avaliações).
 *
 * A API `reviews.list` só devolve avaliações com comentário dos últimos sete
 * dias. O histórico inteiro existe nos relatórios mensais que o Google gera
 * para cada app (`reviews_<pacote>_AAAAMM.csv`), baixados pela Play Console.
 * Este módulo lê esse CSV e o converte nas linhas que o painel guarda.
 *
 * O arquivo vem em UTF-16 com BOM (o painel decodifica antes de enviar) e tem
 * estas colunas, pelo cabeçalho em inglês: Package Name, App Version Code,
 * App Version Name, Reviewer Language, Device, Review Submit Millis Since
 * Epoch, Review Last Update Millis Since Epoch, Star Rating, Review Title,
 * Review Text, Developer Reply Millis Since Epoch, Developer Reply Text,
 * Review Link. O nome de quem avaliou não vem no relatório.
 */

export interface CsvReview {
  reviewId: string;
  packageName: string | null;
  starRating: number;
  text: string;
  language: string | null;
  device: string | null;
  appVersionCode: number | null;
  appVersionName: string | null;
  userCommentAt: Date | null;
  lastModifiedAt: Date | null;
  developerReplyText: string | null;
  developerReplyAt: Date | null;
  link: string | null;
}

export interface CsvParseResult {
  reviews: CsvReview[];
  /** Linhas sem texto (só estrelas): a Play Store não deixa responder. */
  withoutText: number;
  /** Linhas sem link da avaliação: sem o id não dá para evitar duplicatas. */
  withoutId: number;
  /** Linhas de outro pacote (o relatório certo é o do app). */
  otherPackage: number;
}

/** CSV no formato RFC 4180: aspas, aspas dobradas e quebras de linha dentro do campo. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += char;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((cells) => cells.some((cell) => cell.trim() !== ''));
}

/** O id que a API usa (`gp:AOqp…`) está no link da avaliação, em `reviewId=` ou `reviewid=`. */
export function reviewIdFromLink(link: string | null | undefined): string | null {
  if (!link) return null;
  const match = /review_?id=([^&#\s"]+)/i.exec(link);
  if (!match?.[1]) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function millis(value: string | undefined): Date | null {
  if (!value || !/^\d{9,15}$/.test(value.trim())) return null;
  return new Date(Number(value.trim()));
}

function isoDate(value: string | undefined): Date | null {
  if (!value?.trim()) return null;
  const date = new Date(value.trim());
  return Number.isNaN(date.getTime()) ? null : date;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export class CsvFormatError extends Error {}

export function parsePlayReviewsCsv(content: string, packageName: string | null): CsvParseResult {
  const rows = parseCsv(content.replace(/^﻿/, ''));
  const header = rows.shift();
  if (!header) throw new CsvFormatError('O arquivo está vazio.');
  const index = new Map(header.map((name, position) => [name.trim().toLowerCase(), position]));
  const column = (name: string) => index.get(name.toLowerCase());
  for (const required of ['Star Rating', 'Review Text', 'Review Link']) {
    if (column(required) === undefined) {
      throw new CsvFormatError(`Este não parece o relatório de avaliações da Play Console: falta a coluna "${required}".`);
    }
  }
  const get = (cells: string[], name: string) => {
    const position = column(name);
    return position === undefined ? undefined : cells[position];
  };

  const result: CsvParseResult = { reviews: [], withoutText: 0, withoutId: 0, otherPackage: 0 };
  for (const cells of rows) {
    const rowPackage = nonEmpty(get(cells, 'Package Name'));
    if (packageName && rowPackage && rowPackage !== packageName) {
      result.otherPackage += 1;
      continue;
    }
    const stars = Number(get(cells, 'Star Rating'));
    if (!Number.isInteger(stars) || stars < 1 || stars > 5) continue;
    const title = nonEmpty(get(cells, 'Review Title'));
    const body = nonEmpty(get(cells, 'Review Text'));
    // O relatório separa título e texto; a API devolve tudo junto (título, tab, texto).
    const text = title && body ? `${title}\t${body}` : (body ?? title);
    if (!text) {
      result.withoutText += 1;
      continue;
    }
    const link = nonEmpty(get(cells, 'Review Link'));
    const reviewId = reviewIdFromLink(link);
    if (!reviewId) {
      result.withoutId += 1;
      continue;
    }
    const versionCode = Number(get(cells, 'App Version Code'));
    const submitted = millis(get(cells, 'Review Submit Millis Since Epoch')) ?? isoDate(get(cells, 'Review Submit Date and Time'));
    const updated = millis(get(cells, 'Review Last Update Millis Since Epoch')) ?? isoDate(get(cells, 'Review Last Update Date and Time')) ?? submitted;
    const replyText = nonEmpty(get(cells, 'Developer Reply Text'));
    const replyAt = replyText ? (millis(get(cells, 'Developer Reply Millis Since Epoch')) ?? isoDate(get(cells, 'Developer Reply Date and Time'))) : null;
    result.reviews.push({
      reviewId,
      packageName: rowPackage,
      starRating: stars,
      text,
      language: nonEmpty(get(cells, 'Reviewer Language')),
      device: nonEmpty(get(cells, 'Device')),
      appVersionCode: Number.isInteger(versionCode) && versionCode > 0 ? versionCode : null,
      appVersionName: nonEmpty(get(cells, 'App Version Name')),
      userCommentAt: updated,
      lastModifiedAt: replyAt && updated && replyAt > updated ? replyAt : (updated ?? replyAt),
      developerReplyText: replyText,
      developerReplyAt: replyAt,
      link,
    });
  }
  return result;
}
