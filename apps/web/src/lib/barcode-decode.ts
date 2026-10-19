/**
 * Leitura de código de barras a partir de uma imagem (quadro da câmera ou
 * foto). Usa o leitor nativo do navegador quando existe e entende os
 * formatos de produto (Chrome no Android e no Mac); nos outros (Safari no
 * iPhone e no iPad, Firefox, Chrome no Windows) usa a ZXing, em JavaScript,
 * empacotada com a aplicação: nada sai da página e a CSP continua `'self'`.
 *
 * Este módulo é carregado só quando alguém abre o leitor.
 */

import {
  BarcodeFormat,
  BinaryBitmap,
  DecodeHintType,
  HTMLCanvasElementLuminanceSource,
  HybridBinarizer,
  MultiFormatReader,
} from '@zxing/library';

export type Decode = (canvas: HTMLCanvasElement) => Promise<string | null>;

/** Formatos de produto e de etiqueta interna. */
const NATIVE_FORMATS = ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'code_93', 'itf', 'codabar', 'qr_code', 'data_matrix'];
const ZXING_FORMATS = [
  BarcodeFormat.EAN_13,
  BarcodeFormat.EAN_8,
  BarcodeFormat.UPC_A,
  BarcodeFormat.UPC_E,
  BarcodeFormat.CODE_128,
  BarcodeFormat.CODE_39,
  BarcodeFormat.CODE_93,
  BarcodeFormat.ITF,
  BarcodeFormat.CODABAR,
  BarcodeFormat.QR_CODE,
  BarcodeFormat.DATA_MATRIX,
];

interface NativeDetector {
  detect: (source: CanvasImageSource) => Promise<Array<{ rawValue: string }>>;
}
interface NativeDetectorClass {
  new (options?: { formats: string[] }): NativeDetector;
  getSupportedFormats?: () => Promise<string[]>;
}

async function nativeDecoder(): Promise<Decode | null> {
  const Detector = (window as unknown as { BarcodeDetector?: NativeDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    // No Chrome do Windows e do Linux o construtor existe, mas não lê nada:
    // só vale se ele disser que entende os formatos de produto.
    const supported = (await Detector.getSupportedFormats?.()) ?? [];
    const formats = NATIVE_FORMATS.filter((format) => supported.includes(format));
    if (!formats.includes('ean_13')) return null;
    const detector = new Detector({ formats });
    return async (canvas) => {
      const codes = await detector.detect(canvas);
      return codes[0]?.rawValue ?? null;
    };
  } catch {
    return null;
  }
}

function zxingDecoder(): Decode {
  const reader = new MultiFormatReader();
  const hints = new Map<DecodeHintType, unknown>([
    [DecodeHintType.POSSIBLE_FORMATS, ZXING_FORMATS],
    [DecodeHintType.TRY_HARDER, true],
  ]);
  reader.setHints(hints);
  return async (canvas) => {
    try {
      const bitmap = new BinaryBitmap(new HybridBinarizer(new HTMLCanvasElementLuminanceSource(canvas)));
      return reader.decodeWithState(bitmap).getText() || null;
    } catch {
      // NotFound/Checksum/Format: este quadro não tem um código legível.
      return null;
    } finally {
      reader.reset();
    }
  };
}

/** O melhor leitor disponível neste navegador. */
export async function createDecoder(): Promise<{ decode: Decode; engine: 'nativo' | 'zxing' }> {
  const native = await nativeDecoder();
  return native ? { decode: native, engine: 'nativo' } : { decode: zxingDecoder(), engine: 'zxing' };
}

/** Lê o código de uma foto (o caminho para quando a câmera ao vivo não abre). */
export async function decodeImageFile(file: File, decode: Decode): Promise<string | null> {
  const url = URL.createObjectURL(file);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('imagem ilegível'));
      element.src = url;
    });
    // Fotos de celular têm 12 MP: reduzir acelera muito e não atrapalha a leitura.
    const scale = Math.min(1, 1600 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return await decode(canvas);
  } finally {
    URL.revokeObjectURL(url);
  }
}
