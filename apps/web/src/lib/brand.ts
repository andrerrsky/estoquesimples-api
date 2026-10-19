import { useSyncExternalStore } from 'react';

import type { BrandTheme, BrandingView } from '../api/types';

/**
 * Identidade visual da empresa, aplicada como *tokens* sobre a interface
 * única do produto — nunca como outro layout. A API decide se vale
 * (`active`); aqui só se aplica o que ela devolveu, e qualquer falha volta ao
 * visual padrão (os tokens de `packages/design/tokens.css` voltam a valer
 * assim que as variáveis inline saem).
 *
 * Fonte da marca:
 *  - `workspace`: o retrato de direitos da empresa em uso (área autenticada);
 *  - `public`: a tela de entrada `/<slug>/entrar`, antes de haver sessão.
 * Só a primeira é guardada no navegador (para o app já abrir com a marca,
 * sem piscar o azul padrão) e é apagada ao sair.
 */

export interface ActiveBrand {
  slug: string;
  displayName: string | null;
  version: number;
  theme: BrandTheme;
  logoUrl: string | null;
}

type Source = 'workspace' | 'public';

const STORAGE_KEY = 'es_web_brand';
const DEFAULT_THEME_COLOR = '#1C679D';
const SERIF = 'Georgia, "Iowan Old Style", "Times New Roman", serif';
const VARIABLES = ['--brand', '--brand-dark', '--brand-pressed', '--brand-soft', '--brand-tint', '--on-brand', '--accent', '--series-1', '--info', '--text', '--text-muted', '--focus-ring', '--font'] as const;

let current: ActiveBrand | null = null;
let source: Source | null = null;
/** Tela de edição mostrando uma prévia: nada de fora a derruba. */
let previewing = false;
/**
 * O que o servidor disse por último, mesmo durante uma prévia. Era isto que
 * faltava: salvar a marca (ou remover o logotipo) acontece COM a prévia na
 * tela, então a confirmação do servidor era ignorada e, ao sair da tela de
 * edição, a prévia devolvia a marca de antes — a nova só aparecia depois de
 * sair e entrar de novo.
 */
let committed: { brand: ActiveBrand | null; source: Source | null } | null = null;
const listeners = new Set<() => void>();

const HEX = /^#[0-9a-f]{6}$/i;

/** Defesa em profundidade: o tema vem da API, mas só entra no CSS o que é cor válida. */
function valid(theme: BrandTheme | null | undefined): theme is BrandTheme {
  if (!theme) return false;
  return [theme.primary, theme.primaryDark, theme.primaryPressed, theme.primarySoft, theme.primaryTint, theme.onPrimary, theme.accent, theme.text, theme.textMuted].every((color) => HEX.test(color));
}

function rgba(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function paint(brand: ActiveBrand | null): void {
  const root = document.documentElement;
  if (!brand) {
    for (const name of VARIABLES) root.style.removeProperty(name);
    delete root.dataset.brand;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', DEFAULT_THEME_COLOR);
    return;
  }
  const { theme } = brand;
  const set = (name: (typeof VARIABLES)[number], value: string) => root.style.setProperty(name, value);
  set('--brand', theme.primary);
  set('--brand-dark', theme.primaryDark);
  set('--brand-pressed', theme.primaryPressed);
  set('--brand-soft', theme.primarySoft);
  set('--brand-tint', theme.primaryTint);
  set('--on-brand', theme.onPrimary);
  set('--accent', theme.accent);
  set('--series-1', theme.accent);
  set('--info', theme.accent);
  set('--text', theme.text);
  set('--text-muted', theme.textMuted);
  set('--focus-ring', `0 0 0 3px ${rgba(theme.primary, 0.3)}`);
  if (theme.font === 'serif') set('--font', SERIF);
  else root.style.removeProperty('--font');
  root.dataset.brand = brand.slug;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.primary);
}

function emit(): void {
  for (const listener of listeners) listener();
}

function fromView(view: BrandingView | null | undefined): ActiveBrand | null {
  if (!view?.active || !view.slug || !valid(view.theme)) return null;
  return { slug: view.slug, displayName: view.displayName, version: view.version, theme: view.theme, logoUrl: view.logo?.url ?? null };
}

function persist(brand: ActiveBrand | null): void {
  try {
    if (brand) localStorage.setItem(STORAGE_KEY, JSON.stringify(brand));
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // sem armazenamento: só perde o "abrir já com a marca"
  }
}

function sameBrand(a: ActiveBrand | null, b: ActiveBrand | null): boolean {
  if (!a || !b) return a === b;
  return a.slug === b.slug && a.version === b.version && a.logoUrl === b.logoUrl && JSON.stringify(a.theme) === JSON.stringify(b.theme);
}

/** Troca a marca ativa. `null` volta ao visual padrão. */
export function setBrand(view: BrandingView | null | undefined, from: Source): void {
  const next = fromView(view);
  if (previewing) {
    // Não mexe na tela (a prévia continua), mas guarda: é isto que volta ao sair da edição.
    if (from === 'workspace') {
      committed = { brand: next, source: next ? from : null };
      persist(next);
    }
    return;
  }
  // Uma tela pública não derruba a marca de uma sessão já carregada.
  if (from === 'public' && source === 'workspace' && current) return;
  if (sameBrand(next, current) && (source === from || (!next && !current))) return;
  current = next;
  source = next ? from : null;
  paint(next);
  if (from === 'workspace') persist(next);
  emit();
}

/** Sai da marca da tela pública (ao deixar `/<slug>/entrar` sem ter entrado). */
export function clearPublicBrand(): void {
  if (source !== 'public') return;
  current = null;
  source = null;
  paint(null);
  emit();
}

/** Logout / sessão encerrada: nada da empresa fica no navegador. */
export function dropWorkspaceBrand(): void {
  persist(null);
  if (source !== 'workspace') return;
  current = null;
  source = null;
  paint(null);
  emit();
}

/** Antes do primeiro render: abre já com a última marca da empresa (a API confirma ou desfaz em seguida). */
export function bootBrand(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as Partial<ActiveBrand>;
    if (typeof saved.slug === 'string' && valid(saved.theme)) {
      current = { slug: saved.slug, displayName: saved.displayName ?? null, version: Number(saved.version) || 0, theme: saved.theme, logoUrl: typeof saved.logoUrl === 'string' && saved.logoUrl.startsWith('/v1/public/brand/') ? saved.logoUrl : null };
      source = 'workspace';
      paint(current);
    }
  } catch {
    dropWorkspaceBrand();
  }
}

/** Pré-visualização na tela de edição: aplica sem guardar e devolve quem desfaz. */
export function previewBrand(theme: BrandTheme | null, logoUrl: string | null, slug: string): () => void {
  const before = current;
  const beforeSource = source;
  committed = null;
  previewing = true;
  if (theme && valid(theme)) {
    current = { slug, displayName: null, version: -1, theme, logoUrl };
    source = 'public';
    paint(current);
  } else {
    current = null;
    source = null;
    paint(null);
  }
  emit();
  return () => {
    previewing = false;
    // Se o servidor confirmou algo durante a prévia (salvou, trocou ou tirou
    // o logotipo), vale o que ele disse; senão, volta ao que estava antes.
    const restore = committed ?? { brand: before, source: beforeSource };
    committed = null;
    current = restore.brand;
    source = restore.source;
    paint(current);
    emit();
  };
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Marca aplicada agora (ou `null` = padrão). */
export function useBrand(): ActiveBrand | null {
  return useSyncExternalStore(subscribe, () => current, () => null);
}
