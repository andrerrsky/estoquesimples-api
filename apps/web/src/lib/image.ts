/**
 * Preparo de imagens no navegador, antes do envio.
 *
 * O objetivo é mandar para o servidor só o necessário: a foto do celular ou
 * da câmera (4 a 12 MB) vira um WebP de no máximo 1280 px e ~250 KB, com a
 * orientação corrigida e sem metadados (localização, modelo da câmera). A API
 * valida tudo de novo — isto aqui é economia de banda e de tempo, e o
 * aviso antecipado de um arquivo inválido; não é a barreira de segurança.
 */

export const IMAGE_MAX_EDGE = 1280;
/** Alvo de tamanho depois de otimizar. */
const TARGET_BYTES = 250 * 1024;
/** Arquivo escolhido maior que isto nem é aberto (evita travar o navegador). */
const MAX_PICKED_BYTES = 25 * 1024 * 1024;
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp']);

export class ImageError extends Error {}

export const IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

/** Confere o arquivo escolhido antes de gastar tempo com ele. */
export function checkPickedFile(file: File): void {
  if (!ACCEPTED.has(file.type)) {
    throw new ImageError(file.type === 'image/heic' || file.type === 'image/heif' ? 'Fotos em HEIC não são aceitas. Escolha uma em JPEG, PNG ou WebP (no iPhone, a opção "Mais compatível" da câmera).' : 'Escolha uma imagem em JPEG, PNG ou WebP.');
  }
  if (file.size === 0) throw new ImageError('O arquivo está vazio.');
  if (file.size > MAX_PICKED_BYTES) throw new ImageError('A imagem é grande demais (máximo de 25 MB).');
}

export interface PreparedImage {
  blob: Blob;
  width: number;
  height: number;
  /** Endereço temporário para mostrar a prévia; quem usa deve chamar `URL.revokeObjectURL`. */
  previewUrl: string;
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  checkPickedFile(file);

  let bitmap: ImageBitmap;
  try {
    // `from-image` aplica a orientação do EXIF: foto de celular em pé não fica deitada.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new ImageError('Não foi possível abrir essa imagem. O arquivo pode estar corrompido.');
  }

  try {
    let scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    for (let round = 0; round < 6; round += 1) {
      const width = Math.max(16, Math.round(bitmap.width * scale));
      const height = Math.max(16, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if (!context) throw new ImageError('Seu navegador não conseguiu preparar a imagem.');
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, width, height);

      for (const quality of [0.82, 0.7, 0.58]) {
        // WebP onde o navegador sabe gerar; senão (Safari antigo devolve PNG) JPEG.
        let blob = await toBlob(canvas, 'image/webp', quality);
        if (!blob || blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', quality);
        if (!blob) throw new ImageError('Não foi possível otimizar a imagem.');
        if (blob.size <= TARGET_BYTES || (round === 5 && quality === 0.58)) {
          return { blob, width, height, previewUrl: URL.createObjectURL(blob) };
        }
      }
      // Ainda grande: reduz as dimensões e tenta de novo.
      scale *= 0.85;
    }
    throw new ImageError('Não foi possível reduzir a imagem o bastante. Escolha uma foto menor.');
  } finally {
    bitmap.close();
  }
}
