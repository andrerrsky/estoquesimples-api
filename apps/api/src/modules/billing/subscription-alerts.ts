import { and, eq, sql } from 'drizzle-orm';

import { auditLog, plans, platformAdmins, subscriptions, users, workspaces } from '../../platform/db/schema/index.js';
import type { Database, Transaction } from '../../platform/db/client.js';
import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { AuditAction, recordAudit } from '../audit/audit.service.js';

/**
 * Aviso por e-mail aos administradores do painel (papel owner, ativos) de que
 * uma assinatura foi confirmada: a primeira vez que ela passa a dar acesso
 * (`nova`) ou quando volta depois de suspensa/expirada (`reativada`).
 * Renovação (ativa → ativa) não avisa.
 *
 * Roda na fila: o webhook do Asaas e a chamada do app não esperam o envio, e
 * falha de envio é repetida. Cada aviso fica na auditoria
 * (`subscription.admin_notified`), o que impede repetir o de `nova` quando o
 * mesmo pagamento chega pelo webhook e pela reconciliação.
 */
export const SUBSCRIPTION_ADMIN_ALERT_JOB = 'billing.admin_subscription_alert';

const ENTITLED = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

export type SubscriptionAlertKind = 'nova' | 'reativada';

/** Decide se a transição merece aviso, e qual. */
export function subscriptionAlertKind(from: string | null, to: string): SubscriptionAlertKind | null {
  if (to !== 'ativa') return null;
  if (from && ENTITLED.has(from)) return null;
  return !from || from === 'pendente' ? 'nova' : 'reativada';
}

export async function enqueueSubscriptionAlert(executor: Database | Transaction, input: { subscriptionId: string; from: string | null; to: string }): Promise<void> {
  const kind = subscriptionAlertKind(input.from, input.to);
  if (!kind) return;
  await enqueueJob(executor, {
    kind: SUBSCRIPTION_ADMIN_ALERT_JOB,
    payload: { subscriptionId: input.subscriptionId, kind, from: input.from },
    uniqueKey: `${SUBSCRIPTION_ADMIN_ALERT_JOB}:${input.subscriptionId}:${kind}`,
  });
}

const money = (cents: number | null) => (cents === null ? null : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }));
const dateBr = (date: Date | null) => (date ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short' }).format(date) : null);
const CYCLE: Record<string, string> = { MONTHLY: 'mensal', YEARLY: 'anual' };
const BILLING: Record<string, string> = { PIX: 'Pix', BOLETO: 'boleto', CREDIT_CARD: 'cartão de crédito', UNDEFINED: 'a escolher' };

/** Envia o aviso. Lança se nenhum envio der certo, para a fila repetir. */
export async function sendSubscriptionAlert(services: AppServices, input: { subscriptionId: string; kind: SubscriptionAlertKind; from: string | null }): Promise<{ recipients: number; sent: number; skipped?: string }> {
  const { db } = services;
  if (input.kind === 'nova') {
    const already = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(and(eq(auditLog.action, AuditAction.SUBSCRIPTION_ADMIN_NOTIFIED), eq(auditLog.entityId, input.subscriptionId), sql`${auditLog.metadata}->>'kind' = 'nova'`))
      .limit(1);
    if (already.length > 0) return { recipients: 0, sent: 0, skipped: 'já avisada' };
  }

  const [row] = await db
    .select({
      id: subscriptions.id,
      workspaceId: subscriptions.workspaceId,
      provider: subscriptions.provider,
      state: subscriptions.state,
      planKey: subscriptions.planKey,
      planName: plans.name,
      cycle: subscriptions.billingCycle,
      billingType: subscriptions.billingType,
      priceCents: subscriptions.priceCents,
      periodEnd: subscriptions.currentPeriodEnd,
      workspaceName: workspaces.name,
      ownerId: users.id,
      ownerName: users.name,
      ownerEmail: users.email,
    })
    .from(subscriptions)
    .innerJoin(workspaces, eq(workspaces.id, subscriptions.workspaceId))
    .innerJoin(users, eq(users.id, workspaces.ownerUserId))
    .leftJoin(plans, eq(plans.key, subscriptions.planKey))
    .where(eq(subscriptions.id, input.subscriptionId))
    .limit(1);
  if (!row) return { recipients: 0, sent: 0, skipped: 'assinatura não encontrada' };
  // O estado mudou de novo antes da fila rodar (ex.: reembolso imediato): não avisa algo que já não vale.
  if (!ENTITLED.has(row.state)) return { recipients: 0, sent: 0, skipped: `estado ${row.state}` };

  const recipients = (
    await db
      .select({ email: platformAdmins.email })
      .from(platformAdmins)
      .where(and(eq(platformAdmins.role, 'owner'), eq(platformAdmins.status, 'active')))
  ).map((admin) => admin.email.toLowerCase());
  if (recipients.length === 0) return { recipients: 0, sent: 0, skipped: 'sem administrador owner' };

  const [count] = (await db.execute<{ live: number }>(sql`SELECT count(DISTINCT workspace_id)::int AS live FROM subscriptions WHERE state IN ('ativa', 'carencia', 'cancelada_mas_ativa')`)).rows;
  const plan = row.planName ?? row.planKey;
  const via = row.provider === 'asaas' ? 'web (Asaas)' : 'app Android (Google Play)';
  const price = money(row.priceCents);
  const panel = services.env.ADMIN_PANEL_URL;
  const headline = input.kind === 'nova' ? 'Nova assinatura confirmada' : 'Assinatura reativada';
  const subject = `${input.kind === 'nova' ? '🎉 ' : ''}${headline}: ${row.workspaceName}`.slice(0, 160);

  const lines = [
    input.kind === 'nova'
      ? `O pagamento de uma assinatura nova foi confirmado no Estoque Simples.`
      : `Uma assinatura voltou a valer depois de ${input.from === 'suspensa' ? 'ficar suspensa por falta de pagamento' : `ficar como "${input.from ?? '—'}"`}.`,
    '',
    `Empresa: ${row.workspaceName}`,
    `Responsável: ${row.ownerName} <${row.ownerEmail}>`,
    `Plano: ${plan}${row.cycle ? ` (${CYCLE[row.cycle] ?? row.cycle})` : ''}${price ? ` · ${price}` : ''}`,
    `Por onde: ${via}${row.billingType ? ` · ${BILLING[row.billingType] ?? row.billingType}` : ''}`,
    ...(row.periodEnd ? [`Vale até: ${dateBr(row.periodEnd)}`] : []),
    '',
    `Assinaturas ativas agora: ${count?.live ?? 0}`,
    '',
    panel ? `Ver no painel: ${panel}/assinaturas/${row.id}\nEmpresa: ${panel}/empresas/${row.workspaceId}` : 'Veja no painel, em Assinaturas.',
  ];
  const text = `${lines.join('\n')}\n`;

  let sent = 0;
  let lastError: unknown = null;
  for (const to of recipients) {
    try {
      await services.mailer.send({ to, subject, text, kind: 'subscription_alert' });
      sent += 1;
    } catch (error) {
      lastError = error;
      services.logger?.warn({ err: error }, 'falha ao avisar administrador de assinatura confirmada');
    }
  }
  if (sent === 0) throw lastError ?? new Error('nenhum aviso de assinatura enviado');

  await recordAudit(db, {
    workspaceId: row.workspaceId,
    actorUserId: null,
    action: AuditAction.SUBSCRIPTION_ADMIN_NOTIFIED,
    entityType: 'subscription',
    entityId: row.id,
    metadata: { kind: input.kind, recipients: recipients.length, sent },
    ipAddress: null,
  });
  return { recipients: recipients.length, sent };
}

export function registerSubscriptionAlertJobs(_services: AppServices): void {
  registerJobHandler(SUBSCRIPTION_ADMIN_ALERT_JOB, async (payload, context) => {
    const subscriptionId = typeof payload['subscriptionId'] === 'string' ? payload['subscriptionId'] : null;
    const kind = payload['kind'] === 'nova' || payload['kind'] === 'reativada' ? payload['kind'] : null;
    if (!subscriptionId || !kind) {
      context.logger.error({ payload }, 'aviso de assinatura sem dados; tarefa ignorada');
      return;
    }
    const from = typeof payload['from'] === 'string' ? payload['from'] : null;
    const result = await sendSubscriptionAlert(context.services, { subscriptionId, kind, from });
    context.logger.info({ subscriptionId, kind, ...result }, 'administradores avisados de assinatura confirmada');
  });
}
