import { createHash } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';

import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * Validação e normalização das imagens recebidas.
 *
 * Nada que chega do cliente é confiado: o tipo é decidido pelos bytes (não
 * pelo cabeçalho nem pela extensão), o arquivo é decodificado de verdade, e
 * o que sai daqui para o armazenamento é sempre um WebP estático, sem
 * metadados e dentro do limite de tamanho — um arquivo "válido" com conteúdo
 * extra escondido (polyglot) é reescrito pelo codificador e perde o extra.
 */

export type ImageKind = 'webp' | 'jpeg' | 'png';

const CONTENT_TYPE_OF: Record<ImageKind, string> = {
  webp: 'image/webp',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

/** Formato pelos primeiros bytes. Não aceita nada além de WebP, JPEG e PNG (nem SVG, nem GIF). */
export function sniffImage(bytes: Buffer): ImageKind | null {
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

export function contentTypeKind(contentType: string): ImageKind | null {
  const base = contentType.split(';')[0]?.trim().toLowerCase();
  return (Object.entries(CONTENT_TYPE_OF).find(([, type]) => type === base)?.[0] as ImageKind | undefined) ?? null;
}

export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');

export interface NormalizedImage {
  bytes: Buffer;
  hash: string;
  contentType: 'image/webp';
  width: number;
  height: number;
}

/** Lado mínimo e máximo aceitos na entrada, antes de qualquer redução. */
const MIN_EDGE = 16;
const MAX_INPUT_EDGE = 8000;
/** Teto de pixels decodificados: protege a memória contra "bombas de descompressão". */
const MAX_INPUT_PIXELS = 36_000_000;
/** Tamanho máximo do que é guardado, depois de reencodar. */
const MAX_STORED_BYTES = 1_048_576;

const invalid = (message: string): AppError => new AppError(422, ErrorCode.IMAGE_INVALID, message);

export async function normalizeImage(input: Buffer, declaredContentType: string, options: { maxEdge: number; maxBytes?: number }): Promise<NormalizedImage> {
  const sniffed = sniffImage(input);
  if (!sniffed) {
    throw new AppError(415, ErrorCode.IMAGE_UNSUPPORTED_TYPE, 'Formato não aceito. Envie uma imagem WebP, JPEG ou PNG.');
  }
  // O tipo declarado precisa concordar com o conteúdo: arquivo que diz ser
  // uma coisa e é outra é recusado em vez de "corrigido".
  if (contentTypeKind(declaredContentType) !== sniffed) {
    throw new AppError(415, ErrorCode.IMAGE_UNSUPPORTED_TYPE, 'O tipo informado não corresponde ao conteúdo do arquivo.');
  }

  const base = () => sharp(input, { limitInputPixels: MAX_INPUT_PIXELS, failOn: 'error', animated: false });

  let meta: Metadata;
  try {
    meta = await base().metadata();
  } catch {
    throw invalid('Não foi possível ler a imagem: o arquivo está corrompido.');
  }
  if (!meta.format || meta.format !== sniffed || !meta.width || !meta.height) throw invalid('A imagem está corrompida ou em formato inesperado.');
  if ((meta.pages ?? 1) > 1) throw invalid('Imagens animadas não são aceitas.');
  if (meta.width < MIN_EDGE || meta.height < MIN_EDGE) throw invalid('A imagem é pequena demais.');
  if (meta.width > MAX_INPUT_EDGE || meta.height > MAX_INPUT_EDGE) throw invalid('A imagem é grande demais. Reduza antes de enviar.');

  const longest = Math.max(meta.width, meta.height);

  // Já está no formato e no tamanho de guardar, sem metadados: só confere que
  // decodifica por inteiro (cabeçalho válido não basta) e guarda como veio —
  // evita recomprimir com perda uma imagem que o app já otimizou.
  if (sniffed === 'webp' && longest <= options.maxEdge && !meta.exif && !meta.xmp && !meta.icc && input.length <= (options.maxBytes ?? MAX_STORED_BYTES)) {
    try {
      await base().stats();
    } catch {
      throw invalid('Não foi possível ler a imagem: o arquivo está corrompido.');
    }
    return { bytes: input, hash: sha256(input), contentType: 'image/webp', width: meta.width, height: meta.height };
  }

  // Caso geral: aplica a orientação, reduz se passar do limite e reescreve em
  // WebP. O sharp descarta EXIF/XMP/localização por padrão.
  for (const quality of [82, 72, 60, 48]) {
    let result: { data: Buffer; info: OutputInfo };
    try {
      result = await base()
        .rotate()
        .resize({ width: options.maxEdge, height: options.maxEdge, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer({ resolveWithObject: true });
    } catch {
      throw invalid('Não foi possível processar a imagem: o arquivo está corrompido.');
    }
    if (result.data.length <= (options.maxBytes ?? MAX_STORED_BYTES)) {
      return { bytes: result.data, hash: sha256(result.data), contentType: 'image/webp', width: result.info.width, height: result.info.height };
    }
  }
  throw invalid('A imagem continua grande demais depois de otimizada. Use uma foto mais simples ou de menor resolução.');
}
