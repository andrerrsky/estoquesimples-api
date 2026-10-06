import { sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../platform/db/client.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import type { EntitlementSnapshot } from './billing.service.js';

/**
 * Chaves de recurso dos planos (linhas de `plan_features`). Os números ficam
 * no banco e são editáveis pelo painel; aqui só o que o código precisa saber
 * para aplicar cada um.
 */
export const Feature = {
  SYNC: 'sync.nuvem',
  PRODUCTS: 'produtos.sincronizados',
  MEMBERS: 'equipe.membros',
  DEVICES: 'sync.dispositivos',
  ANALYSIS: 'analise.avancada',
  /** Cota de imagens da empresa, em MB (limit_value; NULL = sem limite). */
  IMAGES_MB: 'imagens.armazenamento_mb',
} as const;

/** Teto de um recurso: `null` quando o plano não limita. */
export function limitOf(entitlement: EntitlementSnapshot, feature: string): number | null {
  const row = entitlement.features[feature];
  if (!row || !row.enabled) return 0;
  return row.limit;
}

export function featureEnabled(entitlement: EntitlementSnapshot, feature: string): boolean {
  return entitlement.features[feature]?.enabled ?? false;
}

export async function countLiveProducts(executor: Database | Transaction, workspaceId: string): Promise<number> {
  const rows = await executor.execute<{ total: number }>(
    sql`SELECT count(*)::int AS total FROM products WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL`,
  );
  return rows.rows[0]?.total ?? 0;
}

export async function countActiveMembers(executor: Database | Transaction, workspaceId: string): Promise<number> {
  const rows = await executor.execute<{ total: number }>(
    sql`SELECT count(*)::int AS total FROM workspace_members WHERE workspace_id = ${workspaceId} AND status = 'active'`,
  );
  return rows.rows[0]?.total ?? 0;
}

/**
 * Erro padrão de teto atingido. O app mostra a mensagem e usa `extra` para
 * montar o aviso ("63 de 50"); o painel vê o mesmo nos logs.
 */
export function planLimitReached(input: {
  feature: string;
  limit: number;
  current: number;
  planKey: string;
  message: string;
}): AppError {
  return new AppError(403, ErrorCode.PLAN_LIMIT_REACHED, input.message, {
    extra: { feature: input.feature, limit: input.limit, current: input.current, planKey: input.planKey },
  });
}

export function productLimitMessage(limit: number, current: number): string {
  return (
    `O plano gratuito sincroniza até ${limit} produtos e este envio deixaria a nuvem com ${current}. ` +
    'Nada foi apagado do aparelho: assine o plano Equipe para sincronizar sem limite ou reduza o estoque.'
  );
}
