/**
 * Regras da identidade visual: identificador (slug), cores, contraste e a
 * paleta derivada. Funções puras, sem banco — a API é a única autoridade, e
 * os clientes (web e Android) só aplicam o que ela devolve.
 *
 * O produto continua sendo um só: estas regras definem o *pouco* que uma
 * empresa pode mudar (cor principal, cor de destaque, cor do texto, fonte e
 * logotipo) e garantem que, mudando, o app continue legível.
 */

// ---------------------------------------------------------------------------
// Identificador da empresa (URL /<slug>/entrar)
// ---------------------------------------------------------------------------

export const SLUG_MIN = 3;
export const SLUG_MAX = 32;

/**
 * Nomes que não podem virar identificador: rotas do produto, do painel e da
 * API, nomes que sugerem autoridade (suporte, oficial) e coisas que
 * facilitariam golpe de phishing em uma tela de login com a nossa cara.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  'app', 'api', 'admin', 'v1', 'docs', 'health', 'ready', 'metrics', 'ops', 'assets', 'static', 'public', 'www',
  'entrar', 'login', 'logout', 'sair', 'criar-conta', 'cadastro', 'registrar', 'esqueci-a-senha', 'redefinir-senha',
  'confirmar-email', 'convite', 'termos', 'privacidade', 'ajuda', 'plataformas', 'suporte', 'contato', 'planos',
  'plano', 'precos', 'preco', 'sobre', 'blog', 'status', 'conta', 'empresa', 'empresas', 'estoque', 'produtos',
  'relatorios', 'historico', 'equipe', 'conflitos', 'notificacoes', 'importar', 'exportar',
  'estoquesimples', 'estoque-simples', 'estoquesimples-app', 'oficial', 'official', 'seguranca', 'security',
  'pagamento', 'pagamentos', 'cobranca', 'asaas', 'google', 'apple', 'android', 'ios', 'play', 'root', 'sistema',
  'system', 'null', 'undefined', 'test', 'teste', 'demo', 'manifest', 'robots', 'sitemap', 'favicon', 'index',
]);

/** Minúsculas, sem acentos, só `a-z 0-9` e hífen (sem hífen nas pontas nem repetido). */
export function normalizeSlug(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
}

/** `null` quando o identificador (já normalizado) é aceitável; senão, o motivo. */
export function slugProblem(slug: string): string | null {
  if (slug.length < SLUG_MIN) return `O identificador precisa ter pelo menos ${SLUG_MIN} caracteres.`;
  if (slug.length > SLUG_MAX) return `O identificador pode ter no máximo ${SLUG_MAX} caracteres.`;
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Use apenas letras minúsculas, números e hífen (sem hífen no início, no fim ou repetido).';
  if (/^\d+$/.test(slug)) return 'O identificador não pode ser só números.';
  if (RESERVED_SLUGS.has(slug)) return 'Este identificador é reservado. Escolha outro.';
  return null;
}

// ---------------------------------------------------------------------------
// Cores
// ---------------------------------------------------------------------------

export type Rgb = readonly [number, number, number];

export const HEX_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const toRgb = (hex: string): Rgb => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];

export const toHex = (rgb: Rgb): string =>
  '#' + rgb.map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0')).join('');

/** Luminância relativa (WCAG 2.x). */
function luminance([r, g, b]: Rgb): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Razão de contraste WCAG entre duas cores (1 a 21). */
export function contrast(a: string, b: string): number {
  const la = luminance(toRgb(a));
  const lb = luminance(toRgb(b));
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

/** Mistura `amount` (0–1) de `other` em `base`. */
export function mix(base: string, other: string, amount: number): string {
  const a = toRgb(base);
  const b = toRgb(other);
  return toHex([a[0] + (b[0] - a[0]) * amount, a[1] + (b[1] - a[1]) * amount, a[2] + (b[2] - a[2]) * amount]);
}

const WHITE = '#ffffff';
const BLACK = '#000000';
/** Fundo das telas do produto (`--surface`). */
const SURFACE = '#f4f7fa';

/** Identidade padrão do Estoque Simples (packages/design/tokens.css). */
export const DEFAULT_THEME = {
  primary: '#1c679d',
  text: '#1a2330',
} as const;

/** Contraste mínimo exigido (WCAG 2.2): AA para a cor principal/destaque, AAA para o texto. */
export const MIN_CONTRAST = { primary: 4.5, accent: 4.5, text: 7 } as const;

/**
 * Escurece a cor até atingir o contraste pedido contra o branco, para
 * sugerir uma alternativa próxima em vez de só recusar.
 */
export function darkenToContrast(hex: string, minimum: number): string {
  let candidate = hex.toLowerCase();
  for (let step = 1; step <= 40 && contrast(candidate, WHITE) < minimum; step += 1) {
    candidate = mix(hex, BLACK, step * 0.025);
  }
  return candidate;
}

export type BrandFont = 'default' | 'serif';
export const FONTS: readonly BrandFont[] = ['default', 'serif'];

export interface BrandColorsInput {
  primary: string | null;
  accent: string | null;
  text: string | null;
}

export interface ColorProblem {
  field: 'primary' | 'accent' | 'text';
  message: string;
  suggestion?: string;
}

const FIELD_LABEL = { primary: 'A cor principal', accent: 'A cor de destaque', text: 'A cor do texto' } as const;

/** Valida formato e contraste. Lista vazia = tudo certo. */
export function colorProblems(colors: BrandColorsInput): ColorProblem[] {
  const problems: ColorProblem[] = [];
  for (const field of ['primary', 'accent', 'text'] as const) {
    const value = colors[field];
    if (value === null) continue;
    if (!HEX_PATTERN.test(value)) {
      problems.push({ field, message: `${FIELD_LABEL[field]} precisa estar no formato #RRGGBB.` });
      continue;
    }
    const ratio = Math.min(contrast(value, WHITE), field === 'text' ? contrast(value, SURFACE) : Infinity);
    const minimum = MIN_CONTRAST[field];
    if (ratio < minimum) {
      const dark = darkenToContrast(value, minimum + (field === 'text' ? 0.3 : 0));
      problems.push({
        field,
        message:
          field === 'text'
            ? `${FIELD_LABEL[field]} tem contraste ${ratio.toFixed(1)}:1 com o fundo; o mínimo é ${minimum}:1 para o texto continuar legível.`
            : `${FIELD_LABEL[field]} tem contraste ${ratio.toFixed(1)}:1 com o branco; o mínimo é ${minimum}:1 porque ela é usada como fundo de textos brancos e como cor de texto.`,
        suggestion: dark,
      });
    }
  }
  return problems;
}

/** Paleta pronta para aplicar. Nomes alinhados aos tokens do produto. */
export interface BrandTheme {
  primary: string;
  primaryDark: string;
  primaryPressed: string;
  primarySoft: string;
  primaryTint: string;
  /** Texto sobre a cor principal (sempre branco: a principal exige contraste com branco). */
  onPrimary: string;
  accent: string;
  text: string;
  textMuted: string;
  font: BrandFont;
}

export interface ThemeInput extends BrandColorsInput {
  font: BrandFont;
}

/**
 * Deriva a paleta. As variações (escura, pressionada, suave) saem da cor
 * principal por mistura, para que qualquer cor válida produza um conjunto
 * coerente; o texto secundário nasce do texto, mais claro, sem perder 4.5:1.
 */
export function deriveTheme(input: ThemeInput): BrandTheme {
  const primary = (input.primary ?? '#1c679d').toLowerCase();
  const accent = (input.accent ?? input.primary ?? '#1c679d').toLowerCase();
  const text = (input.text ?? DEFAULT_THEME.text).toLowerCase();

  let textMuted = input.text ? text : '#5c6b7a';
  if (input.text) {
    // A mais clara das misturas que ainda passa de 4.5:1 sobre o fundo das telas.
    for (let amount = 0.5; amount >= 0; amount -= 0.05) {
      const candidate = mix(text, WHITE, amount);
      if (contrast(candidate, SURFACE) >= 4.6) {
        textMuted = candidate;
        break;
      }
    }
  }

  return {
    primary,
    primaryDark: mix(primary, BLACK, 0.2),
    primaryPressed: mix(primary, BLACK, 0.1),
    primarySoft: mix(primary, WHITE, 0.9),
    primaryTint: mix(primary, WHITE, 0.94),
    onPrimary: WHITE,
    accent,
    text,
    textMuted,
    font: input.font,
  };
}
