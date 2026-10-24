import sharp from 'sharp';

import { escapeHtml } from './markdown.js';

/**
 * Capa automática de um post (1200×630, WebP) para quem não enviou imagem:
 * o Google e as prévias de link pedem uma imagem própria por artigo, e a
 * mesma `og.jpg` em todos os posts conta como repetida. A capa é um SVG
 * com o título, a categoria e a marca, rasterizado pelo sharp e guardado em
 * memória (um post publicado muda pouco).
 *
 * O texto depende de uma fonte do sistema. Onde não há nenhuma (imagem de
 * container sem fontconfig), o SVG sairia sem letras: `available()` testa
 * uma vez e, negativo, quem chama usa a imagem padrão do site.
 */

/** Proporções que o Google pede para artigos: 16:9 (prévias de link), 4:3 e 1:1. */
export const COVER_SIZES = { '16x9': { width: 1200, height: 630 }, '4x3': { width: 1200, height: 900 }, '1x1': { width: 1200, height: 1200 } } as const;
export type CoverAspect = keyof typeof COVER_SIZES;
const CACHE_MAX = 200;
const FONT = "'Plus Jakarta Sans', Inter, 'Helvetica Neue', Helvetica, Arial, 'DejaVu Sans', 'Liberation Sans', sans-serif";

const cache = new Map<string, Buffer>();
let fontsAvailable: Promise<boolean> | null = null;
let fontsState: boolean | null = null;

/** `true` quando já se sabe que o servidor não desenha texto (ver fontsReady). */
export function fontsKnownMissing(): boolean {
  return fontsState === false;
}

/** Quebra o título em até `maxLines` linhas de ~`perLine` caracteres, com reticências se não couber. */
function wrap(text: string, perLine: number, maxLines: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > perLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current);
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines);
    kept[maxLines - 1] = `${kept[maxLines - 1]!.replace(/[,;:.]?\s*\S*$/, '')}…`;
    return kept;
  }
  return lines;
}

export function coverSvg(input: { title: string; category: string; aspect?: CoverAspect; brandColor?: string; brandDark?: string }): string {
  const e = escapeHtml;
  const { width: WIDTH, height: HEIGHT } = COVER_SIZES[input.aspect ?? '16x9'];
  const brand = input.brandColor ?? '#1c679d';
  const dark = input.brandDark ?? '#124a73';
  const long = input.title.length > 60;
  const fontSize = long ? 54 : 62;
  const maxLines = HEIGHT > 700 ? 5 : 3;
  const lines = wrap(input.title, long ? 30 : 26, maxLines);
  const lineHeight = fontSize * 1.15;
  const blockHeight = lines.length * lineHeight;
  const startY = HEIGHT / 2 + 15 - blockHeight / 2 + fontSize * 0.8;
  const tspans = lines.map((line, index) => `<tspan x="80" y="${Math.round(startY + index * lineHeight)}">${e(line)}</tspan>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${brand}"/><stop offset="1" stop-color="${dark}"/></linearGradient>
    <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></linearGradient>
  </defs>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <circle cx="${WIDTH - 160}" cy="120" r="320" fill="url(#glow)"/>
  <circle cx="160" cy="${HEIGHT - 10}" r="220" fill="url(#glow)"/>
  <g transform="translate(80 72)">
    <rect width="44" height="44" rx="11" fill="#ffffff" fill-opacity="0.16"/>
    <path d="M22 9 L34 16 L34 30 L22 37 L10 30 L10 16 Z" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
    <path d="M10 16 L22 23 L34 16 M22 23 L22 37" fill="none" stroke="#ffffff" stroke-width="2.5" stroke-linejoin="round"/>
    <text x="58" y="31" font-family="${FONT}" font-size="26" font-weight="700" fill="#ffffff">Estoque Simples</text>
  </g>
  <text x="80" y="176" font-family="${FONT}" font-size="22" font-weight="700" letter-spacing="2" fill="#ffffff" fill-opacity="0.82">${e(input.category.toUpperCase())}</text>
  <text font-family="${FONT}" font-size="${fontSize}" font-weight="800" fill="#ffffff" letter-spacing="-1">${tspans}</text>
  <text x="80" y="${HEIGHT - 64}" font-family="${FONT}" font-size="24" font-weight="600" fill="#ffffff" fill-opacity="0.82">estoquesimples.com.br/blog</text>
</svg>`;
}

/** Há fonte para desenhar texto? Testado uma vez por processo. */
export function fontsReady(): Promise<boolean> {
  if (!fontsAvailable) {
    fontsAvailable = (async () => {
      try {
        const probe = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"><text x="10" y="55" font-family="${FONT}" font-size="48" fill="#000">Ag</text></svg>`;
        const { data } = await sharp(Buffer.from(probe)).flatten({ background: '#fff' }).greyscale().raw().toBuffer({ resolveWithObject: true });
        let dark = 0;
        for (const value of data) if (value < 128) dark += 1;
        fontsState = dark > 100;
      } catch {
        fontsState = false;
      }
      return fontsState;
    })();
  }
  return fontsAvailable;
}

/** WebP da capa, do cache ou renderizado; `null` sem fontes ou em erro. */
export async function renderCover(key: string, input: { title: string; category: string; aspect?: CoverAspect }): Promise<Buffer | null> {
  const cached = cache.get(key);
  if (cached) return cached;
  if (!(await fontsReady())) return null;
  try {
    const { width, height } = COVER_SIZES[input.aspect ?? '16x9'];
    // O SVG já tem o tamanho final; o resize garante os pixels declarados nas metatags.
    const bytes = await sharp(Buffer.from(coverSvg(input))).resize(width, height).webp({ quality: 82 }).toBuffer();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(key, bytes);
    return bytes;
  } catch {
    return null;
  }
}

/** Esquece a capa de um post (título ou categoria mudou). */
export function forgetCover(key: string): void {
  cache.delete(key);
}
