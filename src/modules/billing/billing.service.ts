import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';

import { scrubPurchasePayload } from '../../platform/crypto/purchase-token.js';
import type { Transaction } from '../../platform/db/client.js';
import {
  planFeatures,
  plans,
  subscriptionEvents,
  subscriptions,
  workspaces,
} from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode, conflict, notFound } from '../../platform/http/errors.js';
import { recordBillingEvent } from '../../platform/observability/metrics.js';
import { AuditAction, recordAudit, recordAuditSafe } from '../audit/audit.service.js';
import type { RequestMeta } from '../auth/auth.service.js';
import type { SubscriptionPurchaseV2 } from './play-client.js';

/** Estados em que a empresa tem direito a sincronizar. */
export const LIVE_STATES = [
  'pendente',
  'ativa',
  'carencia',
  'suspensa',
  'cancelada_mas_ativa',
] as const;

const ENTITLED_STATES = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

/**
 * Tradução do estado do Google para o nosso vocabulário.
 *
 * `SUBSCRIPTION_STATE_CANCELED` merece atenção: significa que a renovação
 * automática foi desligada, e **não** que o acesso acabou. O período já pago
 * continua valendo, então mapeamos para `cancelada_mas_ativa`. Tratar isso
 * como cancelamento imediato tiraria da pessoa um serviço que ela pagou.
 */
export function mapGoogleState(purchase: SubscriptionPurchaseV2): string {
  switch (purchase.subscriptionState) {
    case 'SUBSCRIPTION_STATE_PENDING':
    case 'SUBSCRIPTION_STATE_PENDING_PURCHASE_CANCELED':
      return 'pendente';
    case 'SUBSCRIPTION_STATE_ACTIVE':
      return 'ativa';
    case 'SUBSCRIPTION_STATE_IN_GRACE_PERIOD':
      return 'carencia';
    case 'SUBSCRIPTION_STATE_ON_HOLD':
    case 'SUBSCRIPTION_STATE_PAUSED':
      return 'suspensa';
    case 'SUBSCRIPTION_STATE_CANCELED':
      return 'cancelada_mas_ativa';
    case 'SUBSCRIPTION_STATE_EXPIRED':
      return 'expirada';
    default:
      return 'pendente';
  }
}

/** Tipos de notificação RTDN relevantes (androidpublisher). */
export const RtdnType = {
  RECOVERED: 1,
  RENEWED: 2,
  CANCELED: 3,
  PURCHASED: 4,
  ON_HOLD: 5,
  IN_GRACE_PERIOD: 6,
  RESTARTED: 7,
  PRICE_CHANGE_CONFIRMED: 8,
  DEFERRED: 9,
  PAUSED: 10,
  PAUSE_SCHEDULE_CHANGED: 11,
  REVOKED: 12,
  EXPIRED: 13,
} as const;

export interface EntitlementSnapshot {
  workspaceId: string;
  active: boolean;
  planKey: string;
  state: string;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  autoRenewing: boolean;
  features: Record<string, { enabled: boolean; limit: number | null }>;
  /** Até quando o app pode confiar neste retrato sem falar com a API. */
  offlineValidUntil: string;
  checkedAt: string;
}

interface ParsedPurchase {
  state: string;
  productId: string;
  basePlanId: string | null;
  offerId: string | null;
  autoRenewing: boolean;
  acknowledged: boolean;
  startedAt: Date | null;
  currentPeriodEnd: Date | null;
  canceledAt: Date | null;
  linkedPurchaseToken: string | null;
}

function parsePurchase(purchase: SubscriptionPurchaseV2): ParsedPurchase {
  const lineItem = purchase.lineItems?.[0];
  const expiry = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null;
  const cancelTime =
    purchase.canceledStateContext?.userInitiatedCancellation?.cancelTime ?? null;

  return {
    state: mapGoogleState(purchase),
    productId: lineItem?.productId ?? 'assinatura',
    basePlanId: lineItem?.offerDetails?.basePlanId ?? null,
    offerId: lineItem?.offerDetails?.offerId ?? null,
    autoRenewing: lineItem?.autoRenewingPlan?.autoRenewEnabled ?? false,
    acknowledged: purchase.acknowledgementState === 'ACKNOWLEDGEMENT_STATE_ACKNOWLEDGED',
    startedAt: purchase.startTime ? new Date(purchase.startTime) : null,
    currentPeriodEnd: expiry,
    canceledAt: cancelTime ? new Date(cancelTime) : null,
    linkedPurchaseToken: purchase.linkedPurchaseToken ?? null,
  };
}

export class BillingService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private get cipher() {
    return this.services.purchaseTokens;
  }

  private sealToken(token: string): { hash: string; enc: string } {
    return { hash: this.cipher.hash(token), enc: this.cipher.encrypt(token) };
  }

  private sealLinked(token: string | null): {
    hash: string | null;
    enc: string | null;
  } {
    if (!token) return { hash: null, enc: null };
    return this.sealToken(token);
  }

  // -------------------------------------------------------------------------
  // Vinculação de compra
  // -------------------------------------------------------------------------

  /**
   * Vincula um comprovante de compra a uma empresa.
   *
   * O comprovante nunca é aceito pelo que o app diz: a API pergunta ao Google
   * qual é o estado real daquele token. Um cliente comprometido pode enviar
   * qualquer coisa no corpo da requisição, e a única informação confiável é a
   * que vem da Play Developer API.
   */
  async linkPurchase(
    workspaceId: string,
    userId: string,
    purchaseToken: string,
    meta: RequestMeta,
  ): Promise<EntitlementSnapshot> {
    const purchase = await this.services.playClient.getSubscription(purchaseToken);
    const parsed = parsePurchase(purchase);
    const planKey = await this.resolvePlanKey(parsed.productId, parsed.basePlanId);
    const sealed = this.sealToken(purchaseToken);
    const linked = this.sealLinked(parsed.linkedPurchaseToken);

    await this.db.transaction(async (tx) => {
      // Checagem DENTRO da transação, com lock da linha do token. Fora dela,
      // duas chamadas concorrentes de workspaces distintos passavam ambas e
      // o onConflictDoUpdate reescrevia workspace_id — roubo de assinatura.
      const existing = await tx.execute<{ id: string; workspace_id: string }>(
        sql`SELECT id, workspace_id FROM subscriptions
            WHERE purchase_token_hash = ${sealed.hash}
            FOR UPDATE`,
      );
      const alreadyLinked = existing.rows[0];
      if (alreadyLinked && alreadyLinked.workspace_id !== workspaceId) {
        await recordAuditSafe(tx, {
          workspaceId,
          actorUserId: userId,
          action: AuditAction.SUBSCRIPTION_TOKEN_REJECTED,
          entityType: 'subscription',
          entityId: alreadyLinked.id,
          metadata: { reason: 'token_vinculado_a_outra_empresa' },
          ipAddress: meta.ipAddress,
        });
        throw conflict(
          ErrorCode.PURCHASE_TOKEN_IN_USE,
          'Esta assinatura já está vinculada a outra empresa.',
        );
      }

      // Encerra qualquer assinatura viva anterior desta empresa. Sem isto, o
      // índice de "uma assinatura viva por empresa" recusaria a nova compra.
      await this.supersedeLiveSubscriptions(tx, workspaceId, sealed.hash);

      // Cadeia de tokens: numa troca de plano o Google emite um token novo
      // apontando para o antigo. O anterior precisa sair do ar, senão a
      // empresa fica com duas assinaturas.
      if (linked.hash) {
        await tx
          .update(subscriptions)
          .set({ state: 'substituida' })
          .where(
            and(
              eq(subscriptions.purchaseTokenHash, linked.hash),
              inArray(subscriptions.state, [...LIVE_STATES]),
            ),
          );
      }

      const values = {
        workspaceId,
        purchaserUserId: userId,
        planKey,
        purchaseTokenHash: sealed.hash,
        purchaseTokenEnc: sealed.enc,
        googleProductId: parsed.productId,
        googleBasePlanId: parsed.basePlanId,
        googleOfferId: parsed.offerId,
        state: parsed.state,
        autoRenewing: parsed.autoRenewing,
        acknowledged: parsed.acknowledged,
        startedAt: parsed.startedAt,
        currentPeriodEnd: parsed.currentPeriodEnd,
        canceledAt: parsed.canceledAt,
        linkedPurchaseTokenHash: linked.hash,
        linkedPurchaseTokenEnc: linked.enc,
        lastVerifiedAt: new Date(),
        raw: scrubPurchasePayload(purchase),
      };

      // No conflito, nunca sobrescrever workspace_id — só atualizar o estado
      // quando o token já pertence a esta empresa.
      const inserted = await tx
        .insert(subscriptions)
        .values(values)
        .onConflictDoUpdate({
          target: subscriptions.purchaseTokenHash,
          set: {
            purchaserUserId: values.purchaserUserId,
            planKey: values.planKey,
            purchaseTokenEnc: values.purchaseTokenEnc,
            googleProductId: values.googleProductId,
            googleBasePlanId: values.googleBasePlanId,
            googleOfferId: values.googleOfferId,
            state: values.state,
            autoRenewing: values.autoRenewing,
            acknowledged: values.acknowledged,
            startedAt: values.startedAt,
            currentPeriodEnd: values.currentPeriodEnd,
            canceledAt: values.canceledAt,
            linkedPurchaseTokenHash: values.linkedPurchaseTokenHash,
            linkedPurchaseTokenEnc: values.linkedPurchaseTokenEnc,
            lastVerifiedAt: values.lastVerifiedAt,
            raw: values.raw,
          },
          setWhere: sql`${subscriptions.workspaceId} = ${workspaceId}`,
        })
        .returning({ id: subscriptions.id });

      if (inserted.length === 0) {
        throw conflict(
          ErrorCode.PURCHASE_TOKEN_IN_USE,
          'Esta assinatura já está vinculada a outra empresa.',
        );
      }

      await recordAudit(tx, {
        workspaceId,
        actorUserId: userId,
        action: AuditAction.SUBSCRIPTION_LINKED,
        entityType: 'subscription',
        entityId: inserted[0]?.id ?? null,
        metadata: { planKey, state: parsed.state, productId: parsed.productId },
        ipAddress: meta.ipAddress,
      });
    });

    // A confirmação precisa acontecer em até três dias, senão o Google
    // reembolsa a compra automaticamente. Fica fora da transação porque é uma
    // chamada de rede: falhar aqui não pode desfazer a vinculação, e a
    // reconciliação diária tenta de novo.
    if (!parsed.acknowledged) {
      try {
        await this.services.playClient.acknowledge(purchaseToken, parsed.productId);
        await this.db
          .update(subscriptions)
          .set({ acknowledged: true })
          .where(eq(subscriptions.purchaseTokenHash, sealed.hash));
      } catch (error) {
        this.services.logger?.error(
          { err: error, workspaceId },
          'falha ao confirmar a compra no Google Play',
        );
      }
    }

    return this.getEntitlement(workspaceId);
  }

  private async supersedeLiveSubscriptions(
    tx: Transaction,
    workspaceId: string,
    exceptTokenHash: string,
  ): Promise<void> {
    await tx
      .update(subscriptions)
      .set({ state: 'substituida' })
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
          inArray(subscriptions.state, [...LIVE_STATES]),
          sql`${subscriptions.purchaseTokenHash} <> ${exceptTokenHash}`,
        ),
      );
  }

  private async resolvePlanKey(productId: string, basePlanId: string | null): Promise<string> {
    const rows = await this.db
      .select({ key: plans.key })
      .from(plans)
      .where(
        and(
          eq(plans.googleProductId, productId),
          basePlanId
            ? or(eq(plans.googleBasePlanId, basePlanId), sql`${plans.googleBasePlanId} IS NULL`)
            : sql`true`,
        ),
      )
      .limit(1);

    const key = rows[0]?.key;
    if (!key) {
      throw new AppError(
        400,
        ErrorCode.PURCHASE_TOKEN_INVALID,
        'Produto de assinatura desconhecido.',
        { extra: { productId, basePlanId } },
      );
    }
    return key;
  }

  // -------------------------------------------------------------------------
  // Direitos
  // -------------------------------------------------------------------------

  /**
   * Monta o retrato de direitos da empresa.
   *
   * O app guarda este retrato e continua funcionando sem rede por
   * `ENTITLEMENT_OFFLINE_MAX_DAYS`. É um equilíbrio consciente: exigir
   * verificação online a cada sincronização deixaria quem tem internet ruim
   * sem o serviço que pagou, e uma tolerância infinita permitiria usar de
   * graça indefinidamente ficando offline.
   */
  async getEntitlement(workspaceId: string): Promise<EntitlementSnapshot> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
          inArray(subscriptions.state, [...LIVE_STATES]),
        ),
      )
      .limit(1);

    const subscription = rows[0];
    const planKey = subscription?.planKey ?? 'gratuito';

    const featureRows = await this.db
      .select()
      .from(planFeatures)
      .where(eq(planFeatures.planKey, planKey));

    const features: EntitlementSnapshot['features'] = {};
    for (const feature of featureRows) {
      features[feature.featureKey] = { enabled: feature.enabled, limit: feature.limitValue };
    }

    const now = new Date();
    const active = this.isEntitled(subscription, now);

    return {
      workspaceId,
      active,
      planKey: active ? planKey : 'gratuito',
      state: subscription?.state ?? 'sem_assinatura',
      currentPeriodEnd: subscription?.currentPeriodEnd?.toISOString() ?? null,
      graceUntil: subscription?.graceUntil?.toISOString() ?? null,
      autoRenewing: subscription?.autoRenewing ?? false,
      features: active ? features : {},
      offlineValidUntil: new Date(
        now.getTime() + this.services.env.ENTITLEMENT_OFFLINE_MAX_DAYS * 86_400_000,
      ).toISOString(),
      checkedAt: now.toISOString(),
    };
  }

  /**
   * `suspensa` (on hold) e `pendente` não dão direito: no primeiro caso o
   * pagamento falhou e o período de carência já passou; no segundo, a compra
   * ainda não foi concluída.
   */
  private isEntitled(
    subscription: typeof subscriptions.$inferSelect | undefined,
    now: Date,
  ): boolean {
    if (!subscription) return false;
    if (!ENTITLED_STATES.has(subscription.state)) return false;

    // O estado pode estar desatualizado se uma notificação se perdeu. Comparar
    // com a data de expiração evita liberar acesso indevidamente enquanto a
    // reconciliação não roda.
    const limit = subscription.graceUntil ?? subscription.currentPeriodEnd;
    if (limit && limit.getTime() < now.getTime()) return false;

    return true;
  }

  async hasActiveEntitlement(workspaceId: string): Promise<boolean> {
    const entitlement = await this.getEntitlement(workspaceId);
    return entitlement.active;
  }

  async listSubscriptions(workspaceId: string) {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.workspaceId, workspaceId))
      .orderBy(sql`${subscriptions.createdAt} DESC`)
      .limit(20);

    return rows.map((row) => ({
      id: row.id,
      planKey: row.planKey,
      state: row.state,
      autoRenewing: row.autoRenewing,
      startedAt: row.startedAt?.toISOString() ?? null,
      currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
      lastVerifiedAt: row.lastVerifiedAt.toISOString(),
      // O token nunca sai da API: é credencial, não dado de exibição.
      productId: row.googleProductId,
    }));
  }

  // -------------------------------------------------------------------------
  // Notificações do Google
  // -------------------------------------------------------------------------

  /**
   * Registra e processa uma notificação RTDN.
   *
   * Duas regras que evitam a maior parte dos problemas de billing:
   *  1. o conteúdo da notificação **nunca** é fonte de verdade — ela apenas
   *     dispara uma nova consulta ao Google;
   *  2. o processamento é idempotente por `notificationId`, porque o Pub/Sub
   *     entrega ao menos uma vez e reentregas são rotina.
   *
   * Como consequência da regra 1, notificações fora de ordem deixam de ser um
   * problema: qualquer que seja a ordem de chegada, todas convergem para o
   * estado atual consultado na hora.
   */
  async handleNotification(input: {
    notificationId: string;
    notificationType: number | null;
    purchaseToken: string | null;
    payload: Record<string, unknown>;
  }): Promise<{ processed: boolean; duplicated: boolean }> {
    const sealed = input.purchaseToken ? this.sealToken(input.purchaseToken) : null;

    const inserted = await this.db
      .insert(subscriptionEvents)
      .values({
        notificationId: input.notificationId,
        notificationType: input.notificationType,
        purchaseTokenHash: sealed?.hash ?? null,
        purchaseTokenEnc: sealed?.enc ?? null,
        payload: scrubPurchasePayload(input.payload),
      })
      .onConflictDoNothing({ target: subscriptionEvents.notificationId })
      .returning({ id: subscriptionEvents.id });

    const event = inserted[0];
    if (!event) {
      // Reentrega de algo que já processamos.
      recordBillingEvent('ignorado');
      return { processed: false, duplicated: true };
    }

    if (!input.purchaseToken) {
      await this.db
        .update(subscriptionEvents)
        .set({ processedAt: new Date(), processError: 'notificação sem purchaseToken' })
        .where(eq(subscriptionEvents.id, event.id));
      recordBillingEvent('ignorado');
      return { processed: false, duplicated: false };
    }

    try {
      const subscriptionId = await this.refreshFromGoogle(
        input.purchaseToken,
        input.notificationType,
      );
      await this.db
        .update(subscriptionEvents)
        .set({ processedAt: new Date(), subscriptionId })
        .where(eq(subscriptionEvents.id, event.id));
      recordBillingEvent('aceito');
      return { processed: true, duplicated: false };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // O evento fica sem `processed_at` e a reconciliação o retoma depois.
      await this.db
        .update(subscriptionEvents)
        .set({ processError: message.slice(0, 1000) })
        .where(eq(subscriptionEvents.id, event.id));
      recordBillingEvent('erro');
      throw error;
    }
  }

  /**
   * Reconsulta o Google e grava o estado atual do token.
   *
   * Usada tanto pelo webhook quanto pela reconciliação: existe um único
   * caminho que escreve estado de assinatura, então não há como as duas
   * origens divergirem.
   */
  async refreshFromGoogle(
    purchaseToken: string,
    notificationType: number | null = null,
  ): Promise<string | null> {
    const tokenHash = this.cipher.hash(purchaseToken);
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.purchaseTokenHash, tokenHash))
      .limit(1);

    const current = rows[0];
    if (!current) {
      // Notificação de um token que nunca foi vinculado a uma empresa. Pode
      // acontecer se a compra ocorreu mas o app não chegou a chamar a API.
      // Guardar o evento já basta: quando o app vincular, buscamos o estado.
      return null;
    }

    const purchase = await this.services.playClient.getSubscription(purchaseToken);
    const parsed = parsePurchase(purchase);
    const linked = this.sealLinked(parsed.linkedPurchaseToken);

    // Revogação (reembolso ou chargeback) tira o acesso na hora, mesmo que o
    // período pago ainda não tenha terminado.
    const state =
      notificationType === RtdnType.REVOKED ? 'reembolsada' : parsed.state;

    const previousState = current.state;

    await this.db.transaction(async (tx) => {
      await tx
        .update(subscriptions)
        .set({
          state,
          autoRenewing: parsed.autoRenewing,
          acknowledged: parsed.acknowledged,
          currentPeriodEnd: parsed.currentPeriodEnd,
          canceledAt: parsed.canceledAt,
          googleBasePlanId: parsed.basePlanId,
          googleOfferId: parsed.offerId,
          linkedPurchaseTokenHash: linked.hash,
          linkedPurchaseTokenEnc: linked.enc,
          // Regrava o ciphertext: promove legado `v0:` para AES-GCM.
          purchaseTokenEnc: this.cipher.encrypt(purchaseToken),
          latestNotificationType: notificationType,
          lastVerifiedAt: new Date(),
          raw: scrubPurchasePayload(purchase),
        })
        .where(eq(subscriptions.id, current.id));

      if (linked.hash) {
        await tx
          .update(subscriptions)
          .set({ state: 'substituida', supersededBy: current.id })
          .where(
            and(
              eq(subscriptions.purchaseTokenHash, linked.hash),
              inArray(subscriptions.state, [...LIVE_STATES]),
            ),
          );
      }

      if (previousState !== state) {
        await recordAudit(tx, {
          workspaceId: current.workspaceId,
          action: AuditAction.SUBSCRIPTION_STATE_CHANGED,
          entityType: 'subscription',
          entityId: current.id,
          metadata: { from: previousState, to: state, notificationType },
        });
      }
    });

    return current.id;
  }

  // -------------------------------------------------------------------------
  // Reconciliação
  // -------------------------------------------------------------------------

  /**
   * Revalida assinaturas que estão perto de vencer ou que não são conferidas
   * há muito tempo.
   *
   * Notificações se perdem — por indisponibilidade do Pub/Sub, por deploy no
   * meio da entrega, por erro nosso. Sem esta varredura, uma assinatura
   * cancelada continuaria valendo indefinidamente, e uma renovada apareceria
   * como vencida para um cliente que pagou.
   */
  async reconcile(options: { limit?: number; staleMinutes?: number } = {}): Promise<{
    checked: number;
    updated: number;
    failed: number;
  }> {
    const limit = options.limit ?? 200;
    const staleMinutes = options.staleMinutes ?? this.services.env.BILLING_RECONCILE_INTERVAL_MINUTES;
    const staleBefore = new Date(Date.now() - staleMinutes * 60_000);

    const candidates = await this.db
      .select({
        purchaseTokenHash: subscriptions.purchaseTokenHash,
        purchaseTokenEnc: subscriptions.purchaseTokenEnc,
        state: subscriptions.state,
        workspaceId: subscriptions.workspaceId,
      })
      .from(subscriptions)
      .where(
        and(
          inArray(subscriptions.state, [...LIVE_STATES]),
          or(
            lt(subscriptions.lastVerifiedAt, staleBefore),
            // Perto de vencer: conferir com mais frequência reduz a janela em
            // que uma renovação bem-sucedida ainda apareceria como vencida.
            sql`${subscriptions.currentPeriodEnd} < now() + interval '2 days'`,
          ),
        ),
      )
      .limit(limit);

    let updated = 0;
    let failed = 0;

    for (const candidate of candidates) {
      try {
        const before = candidate.state;
        const plaintext = this.cipher.decrypt(candidate.purchaseTokenEnc);
        await this.refreshFromGoogle(plaintext);
        const after = await this.db
          .select({ state: subscriptions.state })
          .from(subscriptions)
          .where(eq(subscriptions.purchaseTokenHash, candidate.purchaseTokenHash))
          .limit(1);

        if (after[0]?.state !== before) updated += 1;
      } catch (error) {
        failed += 1;
        this.services.logger?.error(
          { err: error, workspaceId: candidate.workspaceId },
          'falha ao reconciliar assinatura',
        );
      }
    }

    return { checked: candidates.length, updated, failed };
  }

  /**
   * Revalida sob demanda a assinatura viva de uma empresa. Atalho de suporte
   * para quando uma notificação se perdeu e o cliente está sem acesso.
   */
  async refreshWorkspaceSubscription(workspaceId: string): Promise<EntitlementSnapshot> {
    const rows = await this.db
      .select({ purchaseTokenEnc: subscriptions.purchaseTokenEnc })
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.workspaceId, workspaceId),
          inArray(subscriptions.state, [...LIVE_STATES]),
        ),
      )
      .limit(1);

    const enc = rows[0]?.purchaseTokenEnc;
    if (enc) await this.refreshFromGoogle(this.cipher.decrypt(enc));

    return this.getEntitlement(workspaceId);
  }

  /** Reprocessa notificações que ficaram sem conclusão por erro transitório. */
  async retryFailedEvents(limit = 50): Promise<number> {
    const pending = await this.db
      .select({
        id: subscriptionEvents.id,
        purchaseTokenEnc: subscriptionEvents.purchaseTokenEnc,
        notificationType: subscriptionEvents.notificationType,
      })
      .from(subscriptionEvents)
      .where(sql`${subscriptionEvents.processedAt} IS NULL`)
      .limit(limit);

    let processed = 0;
    for (const event of pending) {
      if (!event.purchaseTokenEnc) continue;
      try {
        const plaintext = this.cipher.decrypt(event.purchaseTokenEnc);
        const subscriptionId = await this.refreshFromGoogle(
          plaintext,
          event.notificationType,
        );
        await this.db
          .update(subscriptionEvents)
          .set({
            processedAt: new Date(),
            subscriptionId,
            processError: null,
            purchaseTokenEnc: this.cipher.encrypt(plaintext),
          })
          .where(eq(subscriptionEvents.id, event.id));
        processed += 1;
      } catch {
        // Continua pendente para a próxima rodada.
      }
    }
    return processed;
  }

  async assertWorkspaceExists(workspaceId: string): Promise<void> {
    const rows = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (rows.length === 0) throw notFound('Empresa não encontrada.');
  }
}
