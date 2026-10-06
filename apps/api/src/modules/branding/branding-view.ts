import { eq } from 'drizzle-orm';

import type { Database, Transaction } from '../../platform/db/client.js';
import { workspaceBrandings, workspaces, type WorkspaceBranding } from '../../platform/db/schema/index.js';
import { colorProblems, deriveTheme, type BrandTheme } from './brand-rules.js';

export interface BrandLogoView {
  /** Caminho público (relativo à origem da API). O `v` é o hash: trocar o logotipo troca a URL. */
  url: string;
  hash: string;
  width: number;
  height: number;
}

/**
 * O que os clientes aplicam. `active=false` significa: use o visual padrão
 * do Estoque Simples (sem plano, sem configuração, bloqueada ou inválida).
 */
export interface BrandingView {
  /** O plano em vigor inclui o recurso. */
  eligible: boolean;
  active: boolean;
  slug: string | null;
  version: number;
  displayName: string | null;
  loginPath: string | null;
  theme: BrandTheme | null;
  logo: BrandLogoView | null;
}

export const INACTIVE_BRANDING: BrandingView = {
  eligible: false,
  active: false,
  slug: null,
  version: 0,
  displayName: null,
  loginPath: null,
  theme: null,
  logo: null,
};

export const logoUrl = (slug: string, hash: string): string => `/v1/public/brand/${slug}/logo?v=${hash}`;

const hasCustomization = (row: WorkspaceBranding): boolean =>
  row.primaryColor !== null || row.accentColor !== null || row.textColor !== null || row.font !== 'default' || row.logoHash !== null;

/** Paleta efetiva de uma configuração. Se por algum motivo ela não passa nas regras, devolve `null` (padrão). */
function themeOf(row: WorkspaceBranding): BrandTheme | null {
  const colors = { primary: row.primaryColor, accent: row.accentColor, text: row.textColor };
  // Defesa em profundidade: a API valida ao salvar, mas as regras podem ficar
  // mais rígidas depois; configuração que não passa mais volta ao padrão em
  // vez de aparecer ilegível.
  if (colorProblems(colors).length > 0) return null;
  return deriveTheme({ ...colors, font: row.font === 'serif' ? 'serif' : 'default' });
}

/**
 * Monta a visão efetiva da marca de uma empresa. Chamada pelo cálculo de
 * direitos (`BillingService.getEntitlement`): `eligible` vem do plano em
 * vigor, então perder a assinatura desliga a marca na leitura seguinte, sem
 * job e sem apagar a configuração.
 */
export async function loadEffectiveBranding(executor: Database | Transaction, workspaceId: string, eligible: boolean): Promise<BrandingView> {
  const [found] = await executor
    .select({ row: workspaceBrandings, name: workspaces.name })
    .from(workspaceBrandings)
    .innerJoin(workspaces, eq(workspaces.id, workspaceBrandings.workspaceId))
    .where(eq(workspaceBrandings.workspaceId, workspaceId))
    .limit(1);
  if (!found) return { ...INACTIVE_BRANDING, eligible };
  const { row } = found;

  const theme = eligible && !row.blockedAt && row.slug && hasCustomization(row) ? themeOf(row) : null;
  if (!theme || !row.slug) return { ...INACTIVE_BRANDING, eligible, slug: row.slug, version: row.version };

  return {
    eligible,
    active: true,
    slug: row.slug,
    version: row.version,
    displayName: found.name,
    loginPath: `/${row.slug}/entrar`,
    theme,
    logo:
      row.logoHash && row.logoWidth && row.logoHeight
        ? { url: logoUrl(row.slug, row.logoHash), hash: row.logoHash, width: row.logoWidth, height: row.logoHeight }
        : null,
  };
}

