import { timingSafeEqual } from 'node:crypto';

import { and, desc, eq, inArray, sql } from 'drizzle-orm';

import {
  billingCustomers,
  billingPayments,
  plans,
  subscriptionEvents,
  subscriptions,
  workspaces,
} from '../../../platform/db/schema/index.js';
import type { AppServices } from '../../../platform/http/context.js';
import { AppError, ErrorCode, conflict, notFound } from '../../../platform/http/errors.js';
import { recordBillingEvent } from '../../../platform/observability/metrics.js';
import { trackServerEvent } from '../../analytics/analytics.service.js';
import { AuditAction, recordAudit } from '../../audit/audit.service.js';
import type { RequestMeta } from '../../auth/auth.service.js';
import { NotificationService, NotificationType } from '../../notifications/notifications.service.js';
import type { AsaasBillingType, AsaasPayment, AsaasSubscription } from './asaas-client.js';
import {
  deriveAsaasState,
  isOpenStatus,
  isPaidStatus,
  todayBrazil,
  type AsaasCycle,
  type DerivedState,
} from './asaas-state.js';
import { documentHint, documentType, onlyDigits } from './document.js';

/** Plano vendido na web. O mesmo plano pago do Google Play. */
export const WEB_PLAN_KEY = 'basico';

const LIVE_STATES = ['pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa'] as const;
const ENTITLED = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

export interface CheckoutInput {
  name: string;
  cpfCnpj: string;
  email?: string | null | undefined;
  mobilePhone?: string | null | undefined;
  cycle: AsaasCycle;
  billingType: AsaasBillingType;
}

type SubscriptionRow = typeof subscriptions.$inferSelect;

const cents = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.round(value * 100);

/**
 * Assinatura pela web, cobrada pelo Asaas.
 *
 * Mesmo desenho da integração com o Google Play: o que chega por webhook
 * nunca é fonte de verdade, só dispara uma nova consulta ao provedor, e
 * existe um único caminho que grava estado (`refreshSubscription`). Daí saem
 * as garantias que importam: webhooks duplicados são ignorados pelo id do
 * evento, os fora de ordem convergem para o estado atual, e o que se perde
 * é recuperado pela reconciliação periódica.
 */
export class AsaasBillingService {
  constructor(private readonly services: AppServices) {}

  private get db() {
    return this.services.db;
  }

  private get asaas() {
    return this.services.asaas;
  }

  private get env() {
    return this.services.env;
  }

  // -------------------------------------------------------------------------
  // Visão da empresa (tela "Plano" da web)
  // -------------------------------------------------------------------------

  async pricing(): Promise<{ monthlyCents: number | null; yearlyCents: number | null }> {
    const rows = await this.db
      .select({ monthly: plans.webPriceMonthlyCents, yearly: plans.webPriceYearlyCents, isActive: plans.isActive })
      .from(plans)
      .where(eq(plans.key, WEB_PLAN_KEY))
      .limit(1);
    const plan = rows[0];
    if (!plan || !plan.isActive) return { monthlyCents: null, yearlyCents: null };
    return { monthlyCents: plan.monthly, yearlyCents: plan.yearly };
  }

  private async liveSubscription(workspaceId: string): Promise<SubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.workspaceId, workspaceId), inArray(subscriptions.state, [...LIVE_STATES])))
      .limit(1);
    return rows[0] ?? null;
  }

  async overview(workspaceId: string) {
    const [pricing, live, customerRows, paymentRows, history] = await Promise.all([
      this.pricing(),
      this.liveSubscription(workspaceId),
      this.db.select().from(billingCustomers).where(eq(billingCustomers.workspaceId, workspaceId)).limit(1),
      this.db
        .select()
        .from(billingPayments)
        .where(and(eq(billingPayments.workspaceId, workspaceId), eq(billingPayments.deleted, false)))
        .orderBy(desc(billingPayments.dueDate), desc(billingPayments.createdAt))
        .limit(36),
      this.db
        .select({
          id: subscriptions.id,
          provider: subscriptions.provider,
          state: subscriptions.state,
          billingCycle: subscriptions.billingCycle,
          startedAt: subscriptions.startedAt,
          currentPeriodEnd: subscriptions.currentPeriodEnd,
          canceledAt: subscriptions.canceledAt,
          createdAt: subscriptions.createdAt,
        })
        .from(subscriptions)
        .where(eq(subscriptions.workspaceId, workspaceId))
        .orderBy(desc(subscriptions.createdAt))
        .limit(10),
    ]);
    const customer = customerRows[0];
    const openPayment = live?.provider === 'asaas'
      ? paymentRows.filter((p) => p.subscriptionId === live.id && isOpenStatus(p.status)).sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0]
      : undefined;

    return {
      // A web só vende quando há chave do Asaas e preço cadastrado no plano.
      checkoutAvailable: this.asaas.configured && (pricing.monthlyCents !== null || pricing.yearlyCents !== null),
      pricing,
      graceDays: this.env.ASAAS_GRACE_DAYS,
      subscription: live
        ? {
            id: live.id,
            provider: live.provider,
            state: live.state,
            planKey: live.planKey,
            billingCycle: live.billingCycle,
            billingType: live.billingType,
            priceCents: live.priceCents,
            autoRenewing: live.autoRenewing,
            startedAt: live.startedAt?.toISOString() ?? null,
            currentPeriodEnd: live.currentPeriodEnd?.toISOString() ?? null,
            graceUntil: live.graceUntil?.toISOString() ?? null,
            nextDueDate: live.nextDueDate,
            canceledAt: live.canceledAt?.toISOString() ?? null,
            // Assinatura do Google Play é gerenciada na Play Store.
            managedBy: live.provider === 'google_play' ? 'google_play' : 'web',
          }
        : null,
      openPayment: openPayment ? this.paymentView(openPayment) : null,
      customer: customer
        ? { name: customer.name, email: customer.email, documentType: customer.documentType, documentHint: customer.documentHint }
        : null,
      payments: paymentRows.map((row) => this.paymentView(row)),
      history: history.map((row) => ({
        id: row.id,
        provider: row.provider,
        state: row.state,
        billingCycle: row.billingCycle,
        startedAt: row.startedAt?.toISOString() ?? null,
        currentPeriodEnd: row.currentPeriodEnd?.toISOString() ?? null,
        canceledAt: row.canceledAt?.toISOString() ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
    };
  }

  private paymentView(row: typeof billingPayments.$inferSelect) {
    return {
      id: row.id,
      status: row.status,
      billingType: row.billingType,
      valueCents: row.valueCents,
      description: row.description,
      dueDate: row.dueDate,
      paidAt: row.paidAt?.toISOString() ?? null,
      invoiceUrl: row.invoiceUrl,
      receiptUrl: row.receiptUrl,
    };
  }

  // -------------------------------------------------------------------------
  // Contratação
  // -------------------------------------------------------------------------

  /**
   * Cria (ou retoma) a assinatura da empresa no Asaas e devolve a fatura da
   * primeira cobrança. O pagamento acontece na página do Asaas: a API nunca
   * vê dados de cartão.
   *
   * Idempotente por empresa: repetir a chamada com uma assinatura ainda
   * pendente devolve a mesma cobrança em vez de criar outra.
   */
  async startCheckout(workspaceId: string, userId: string, input: CheckoutInput, meta: RequestMeta) {
    if (!this.asaas.configured) {
      throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'A assinatura pela web ainda não está disponível.');
    }
    const docType = documentType(input.cpfCnpj);
    if (!docType) {
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, 'Informe um CPF ou CNPJ válido.', {
        details: [{ field: 'cpfCnpj', message: 'CPF ou CNPJ inválido.' }],
      });
    }
    const pricing = await this.pricing();
    const priceCents = input.cycle === 'YEARLY' ? pricing.yearlyCents : pricing.monthlyCents;
    if (priceCents === null) {
      throw new AppError(409, ErrorCode.CONFLICT, 'Este ciclo de cobrança não está disponível no momento.');
    }

    // Estado atual junto ao provedor antes de decidir: a linha local pode
    // estar um webhook atrasada.
    let live = await this.liveSubscription(workspaceId);
    if (live?.provider === 'asaas') {
      await this.refreshSubscription(live.id);
      live = await this.liveSubscription(workspaceId);
    }

    let carryPaidUntil: Date | null = null;
    if (live) {
      if (live.provider === 'google_play') {
        throw conflict(
          ErrorCode.CONFLICT,
          'Esta empresa já tem assinatura pelo Google Play. Gerencie por lá (Play Store > Pagamentos e assinaturas).',
        );
      }
      if (live.state === 'pendente') {
        const sameChoice = live.billingCycle === input.cycle && live.billingType === input.billingType;
        if (sameChoice) return this.checkoutResult(live);
        // Mudou de ideia sobre ciclo ou forma de pagamento antes de pagar:
        // a pendente é cancelada e uma nova nasce com a escolha atual.
        await this.cancelAtProvider(live.providerSubscriptionId);
        await this.refreshSubscription(live.id);
      } else if (live.state === 'cancelada_mas_ativa') {
        // Reativação antes do fim do período pago: a nova assinatura começa a
        // cobrar quando o período atual acabar, sem cobrar duas vezes.
        carryPaidUntil = live.currentPeriodEnd;
        await this.db.update(subscriptions).set({ state: 'substituida' }).where(eq(subscriptions.id, live.id));
      } else {
        // ativa, em carência ou suspensa: nada a contratar; se há cobrança em
        // aberto, é ela que a pessoa precisa pagar.
        const result = await this.checkoutResult(live);
        if (result.payment) return result;
        throw conflict(
          ErrorCode.CONFLICT,
          live.state === 'suspensa'
            ? 'A assinatura desta empresa está suspensa por uma contestação de pagamento em análise. Fale com o suporte.'
            : 'O plano Equipe já está ativo nesta empresa.',
        );
      }
    }

    const customerId = await this.ensureCustomer(workspaceId, userId, input, docType);

    const nextDueDate = carryPaidUntil && carryPaidUntil.getTime() > Date.now() ? todayBrazil(carryPaidUntil) : todayBrazil();
    const cycleLabel = input.cycle === 'YEARLY' ? 'anual' : 'mensal';

    // Uma tentativa anterior pode ter criado a assinatura no Asaas e perdido
    // a resposta (timeout). Antes de criar outra, procura a que já existe.
    const existing = (await this.asaas.listCustomerSubscriptions(customerId)).find(
      (item) => !item.deleted && item.status === 'ACTIVE' && item.externalReference === workspaceId,
    );
    const remote: AsaasSubscription =
      existing ??
      (await this.asaas.createSubscription({
        customer: customerId,
        billingType: input.billingType,
        value: priceCents / 100,
        nextDueDate,
        cycle: input.cycle,
        description: `Estoque Simples · plano Equipe (${cycleLabel})`,
        externalReference: workspaceId,
        successUrl: this.env.WEB_APP_URL ? `${this.env.WEB_APP_URL}/app/plano?pagamento=concluido` : null,
      }));

    let row: SubscriptionRow | undefined;
    try {
      const inserted = await this.db.transaction(async (tx) => {
        const created = await tx
          .insert(subscriptions)
          .values({
            workspaceId,
            purchaserUserId: userId,
            planKey: WEB_PLAN_KEY,
            provider: 'asaas',
            providerSubscriptionId: remote.id,
            providerCustomerId: customerId,
            billingCycle: input.cycle,
            billingType: remote.billingType,
            priceCents,
            nextDueDate: remote.nextDueDate,
            state: 'pendente',
            autoRenewing: true,
            startedAt: null,
            currentPeriodEnd: carryPaidUntil,
            raw: { subscription: scrubAsaasObject(remote), carryPaidUntil: carryPaidUntil?.toISOString() ?? null },
          })
          .onConflictDoNothing({ target: [subscriptions.provider, subscriptions.providerSubscriptionId], where: sql`${subscriptions.providerSubscriptionId} IS NOT NULL` })
          .returning();
        const createdRow = created[0];
        if (createdRow) {
          await recordAudit(tx, {
            workspaceId,
            actorUserId: userId,
            action: AuditAction.SUBSCRIPTION_LINKED,
            entityType: 'subscription',
            entityId: createdRow.id,
            metadata: { provider: 'asaas', planKey: WEB_PLAN_KEY, cycle: input.cycle, billingType: input.billingType },
            ipAddress: meta.ipAddress,
          });
        }
        return createdRow;
      });
      row = inserted ?? (await this.findByProviderId(remote.id)) ?? undefined;
    } catch (error) {
      // Índice de "uma assinatura viva por empresa": outra requisição ganhou a
      // corrida. A assinatura recém-criada no Asaas sobra e precisa sair.
      if (!existing) await this.cancelAtProvider(remote.id).catch(() => undefined);
      const winner = await this.liveSubscription(workspaceId);
      if (winner?.provider === 'asaas') return this.checkoutResult(winner);
      throw error;
    }
    if (!row) throw new AppError(500, ErrorCode.INTERNAL, 'Não foi possível registrar a assinatura.');

    await trackServerEvent(this.services, {
      name: 'subscription.checkout_started',
      userId,
      workspaceId,
      properties: { provider: 'asaas', cycle: input.cycle, billingType: input.billingType },
    });

    // Já busca as cobranças: a primeira nasce junto com a assinatura.
    await this.refreshSubscription(row.id);
    const fresh = (await this.findById(row.id)) ?? row;
    return this.checkoutResult(fresh);
  }

  private async checkoutResult(row: SubscriptionRow) {
    const payments = await this.db
      .select()
      .from(billingPayments)
      .where(and(eq(billingPayments.subscriptionId, row.id), eq(billingPayments.deleted, false)))
      .orderBy(billingPayments.dueDate);
    const open = payments.find((payment) => isOpenStatus(payment.status));
    return {
      subscriptionId: row.id,
      state: row.state,
      payment: open ? this.paymentView(open) : null,
    };
  }

  private async ensureCustomer(workspaceId: string, userId: string, input: CheckoutInput, docType: 'CPF' | 'CNPJ'): Promise<string> {
    const digits = onlyDigits(input.cpfCnpj);
    const local = await this.db.select().from(billingCustomers).where(eq(billingCustomers.workspaceId, workspaceId)).limit(1);
    const known = local[0];

    if (known) {
      // Dados podem ter sido corrigidos (nome, e-mail, documento).
      await this.asaas.updateCustomer(known.providerCustomerId, {
        name: input.name,
        cpfCnpj: digits,
        email: input.email ?? null,
        mobilePhone: input.mobilePhone ?? null,
      });
      await this.db
        .update(billingCustomers)
        .set({ name: input.name, email: input.email ?? null, documentType: docType, documentHint: documentHint(digits) })
        .where(eq(billingCustomers.id, known.id));
      return known.providerCustomerId;
    }

    // O Asaas aceita clientes duplicados: procurar pelo vínculo com a empresa
    // antes de criar evita um segundo cadastro após um timeout.
    const remote =
      (await this.asaas.findCustomerByExternalReference(workspaceId)) ??
      (await this.asaas.createCustomer({
        name: input.name,
        cpfCnpj: digits,
        email: input.email ?? null,
        mobilePhone: input.mobilePhone ?? null,
        externalReference: workspaceId,
      }));

    await this.db
      .insert(billingCustomers)
      .values({
        workspaceId,
        provider: 'asaas',
        providerCustomerId: remote.id,
        name: input.name,
        email: input.email ?? null,
        documentType: docType,
        documentHint: documentHint(digits),
        createdBy: userId,
      })
      .onConflictDoNothing();
    return remote.id;
  }

  // -------------------------------------------------------------------------
  // Cancelamento
  // -------------------------------------------------------------------------

  /**
   * Cancela a renovação. O acesso continua até o fim do período já pago
   * (`cancelada_mas_ativa`); sem período pago, a assinatura encerra na hora.
   */
  async cancel(workspaceId: string, userId: string, meta: RequestMeta) {
    const live = await this.liveSubscription(workspaceId);
    if (!live) throw notFound('Esta empresa não tem assinatura ativa.');
    if (live.provider !== 'asaas') {
      throw conflict(ErrorCode.CONFLICT, 'Esta assinatura é do Google Play. Cancele por lá (Play Store > Pagamentos e assinaturas).');
    }
    await this.cancelAtProvider(live.providerSubscriptionId);
    await this.db.update(subscriptions).set({ canceledAt: new Date(), cancelReason: 'usuario' }).where(eq(subscriptions.id, live.id));
    await recordAudit(this.db, {
      workspaceId,
      actorUserId: userId,
      action: AuditAction.SUBSCRIPTION_STATE_CHANGED,
      entityType: 'subscription',
      entityId: live.id,
      metadata: { provider: 'asaas', event: 'cancelamento_solicitado' },
      ipAddress: meta.ipAddress,
    });
    await this.refreshSubscription(live.id);
    await trackServerEvent(this.services, {
      name: 'subscription.cancel_requested',
      userId,
      workspaceId,
      properties: { provider: 'asaas' },
    });
    return this.overview(workspaceId);
  }

  /** Remove a assinatura no Asaas (e as cobranças em aberto dela). */
  async cancelAtProvider(providerSubscriptionId: string | null): Promise<void> {
    if (!providerSubscriptionId) return;
    await this.asaas.deleteSubscription(providerSubscriptionId);
  }

  // -------------------------------------------------------------------------
  // Estado: único caminho de escrita
  // -------------------------------------------------------------------------

  private async findById(id: string): Promise<SubscriptionRow | null> {
    const rows = await this.db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    return rows[0] ?? null;
  }

  private async findByProviderId(providerSubscriptionId: string): Promise<SubscriptionRow | null> {
    const rows = await this.db
      .select()
      .from(subscriptions)
      .where(and(eq(subscriptions.provider, 'asaas'), eq(subscriptions.providerSubscriptionId, providerSubscriptionId)))
      .limit(1);
    return rows[0] ?? null;
  }

  /**
   * Reconsulta o Asaas e grava o estado atual da assinatura e das cobranças.
   * Usada pelo webhook, pela reconciliação, pelo checkout e pelo painel.
   */
  async refreshSubscription(subscriptionId: string): Promise<{ state: string; changed: boolean }> {
    const current = await this.findById(subscriptionId);
    if (!current || current.provider !== 'asaas' || !current.providerSubscriptionId) {
      throw notFound('Assinatura não encontrada.');
    }
    // Estados terminais não voltam: reembolso e substituição são definitivos.
    if (current.state === 'substituida') return { state: current.state, changed: false };

    const [remote, payments] = await Promise.all([
      this.asaas.getSubscription(current.providerSubscriptionId),
      this.asaas.listSubscriptionPayments(current.providerSubscriptionId),
    ]);

    const cycle: AsaasCycle = (remote?.cycle ?? current.billingCycle) === 'YEARLY' ? 'YEARLY' : 'MONTHLY';
    const raw = (current.raw ?? {}) as { carryPaidUntil?: string | null };
    const derived = deriveAsaasState({
      subscription: {
        status: remote?.status ?? null,
        deleted: remote ? remote.deleted : true,
        cycle,
        nextDueDate: remote?.nextDueDate ?? null,
      },
      payments: payments.map((payment) => ({ id: payment.id, status: payment.status, dueDate: payment.dueDate, deleted: payment.deleted })),
      now: new Date(),
      graceDays: this.env.ASAAS_GRACE_DAYS,
      carryPaidUntil: raw.carryPaidUntil ? new Date(raw.carryPaidUntil) : null,
    });

    const previousState = current.state;
    const firstPaid = payments
      .filter((payment) => !payment.deleted && isPaidStatus(payment.status))
      .sort((a, b) => String(a.dueDate).localeCompare(String(b.dueDate)))[0];

    await this.db.transaction(async (tx) => {
      for (const payment of payments) {
        await this.upsertPayment(tx, current, payment);
      }
      await tx
        .update(subscriptions)
        .set({
          state: derived.state,
          autoRenewing: derived.autoRenewing,
          currentPeriodEnd: derived.currentPeriodEnd,
          graceUntil: derived.graceUntil,
          nextDueDate: remote?.nextDueDate ?? null,
          billingType: remote?.billingType ?? current.billingType,
          billingCycle: cycle,
          startedAt: current.startedAt ?? (firstPaid ? new Date() : null),
          canceledAt:
            current.canceledAt ?? (derived.state === 'cancelada_mas_ativa' || derived.state === 'expirada' ? new Date() : null),
          lastVerifiedAt: new Date(),
          raw: { ...raw, subscription: remote ? scrubAsaasObject(remote) : { deleted: true } },
        })
        .where(eq(subscriptions.id, current.id));

      if (previousState !== derived.state) {
        await recordAudit(tx, {
          workspaceId: current.workspaceId,
          action: AuditAction.SUBSCRIPTION_STATE_CHANGED,
          entityType: 'subscription',
          entityId: current.id,
          metadata: { provider: 'asaas', from: previousState, to: derived.state },
        });
      }
    });

    if (previousState !== derived.state) {
      await trackServerEvent(this.services, {
        name: 'subscription.state_changed',
        userId: current.purchaserUserId,
        workspaceId: current.workspaceId,
        properties: { provider: 'asaas', from: previousState, to: derived.state },
      });
      await this.notifyTransition(current, previousState, derived);
    }

    // Reembolso com a assinatura ainda ativa no Asaas: sem isto ele seguiria
    // gerando cobranças de algo que a pessoa não tem mais.
    if (derived.state === 'reembolsada' && remote && !remote.deleted) {
      await this.cancelAtProvider(current.providerSubscriptionId).catch((error: unknown) => {
        this.services.logger?.error({ err: error, subscriptionId }, 'falha ao cancelar no Asaas após reembolso');
      });
    }

    return { state: derived.state, changed: previousState !== derived.state };
  }

  private async upsertPayment(
    tx: Parameters<Parameters<AppServices['db']['transaction']>[0]>[0],
    subscription: SubscriptionRow,
    payment: AsaasPayment,
  ): Promise<void> {
    const paidAt = isPaidStatus(payment.status)
      ? new Date(`${payment.clientPaymentDate ?? payment.paymentDate ?? payment.confirmedDate ?? todayBrazil()}T12:00:00-03:00`)
      : null;
    const values = {
      workspaceId: subscription.workspaceId,
      subscriptionId: subscription.id,
      provider: 'asaas',
      providerPaymentId: payment.id,
      status: payment.status,
      billingType: payment.billingType,
      valueCents: cents(payment.value) ?? 0,
      netValueCents: cents(payment.netValue),
      description: payment.description,
      dueDate: payment.dueDate,
      paidAt,
      invoiceUrl: payment.invoiceUrl,
      receiptUrl: payment.transactionReceiptUrl,
      deleted: payment.deleted,
      // Só o necessário para suporte; nada de dados de cartão.
      raw: { status: payment.status, billingType: payment.billingType, dueDate: payment.dueDate, paymentDate: payment.paymentDate },
    };
    await tx
      .insert(billingPayments)
      .values(values)
      .onConflictDoUpdate({
        target: [billingPayments.provider, billingPayments.providerPaymentId],
        set: {
          status: values.status,
          billingType: values.billingType,
          valueCents: values.valueCents,
          netValueCents: values.netValueCents,
          description: values.description,
          dueDate: values.dueDate,
          // Mantém a data já gravada: reprocessar não pode "repagar" hoje.
          paidAt: paidAt ? sql`coalesce(${billingPayments.paidAt}, ${paidAt})` : null,
          invoiceUrl: values.invoiceUrl,
          receiptUrl: values.receiptUrl,
          deleted: values.deleted,
          raw: values.raw,
        },
      });
  }

  /** Avisa o proprietário (caixa de notificações + push) das mudanças que importam. */
  private async notifyTransition(subscription: SubscriptionRow, from: string, derived: DerivedState): Promise<void> {
    const owner = await this.db
      .select({ ownerUserId: workspaces.ownerUserId, name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, subscription.workspaceId))
      .limit(1);
    const userId = owner[0]?.ownerUserId ?? subscription.purchaserUserId;
    if (!userId) return;

    const to = derived.state;
    const dateBr = (date: Date | null) =>
      date ? new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo' }).format(date) : '';
    let message: { type: string; title: string; body: string } | null = null;

    if (to === 'ativa' && (from === 'pendente' || !ENTITLED.has(from))) {
      message = {
        type: NotificationType.BILLING_PAYMENT_CONFIRMED,
        title: 'Pagamento confirmado',
        body: `O plano Equipe está ativo${derived.currentPeriodEnd ? ` até ${dateBr(derived.currentPeriodEnd)}` : ''}. Já dá para convidar sua equipe.`,
      };
    } else if (to === 'carencia') {
      message = {
        type: NotificationType.BILLING_PAYMENT_OVERDUE,
        title: 'Pagamento em atraso',
        body: `A mensalidade do plano Equipe não foi paga. O acesso da equipe continua até ${dateBr(derived.graceUntil)}; regularize em Plano.`,
      };
    } else if (to === 'suspensa') {
      message = {
        type: NotificationType.BILLING_SUBSCRIPTION_SUSPENDED,
        title: 'Plano Equipe suspenso',
        body: 'O pagamento não foi identificado e a empresa voltou ao plano gratuito. Nada foi apagado; pague a fatura em aberto para reativar.',
      };
    } else if (to === 'expirada' && from !== 'pendente') {
      message = {
        type: NotificationType.BILLING_SUBSCRIPTION_ENDED,
        title: 'Plano Equipe encerrado',
        body: 'A empresa voltou ao plano gratuito. Seus dados continuam aqui; você pode assinar de novo quando quiser.',
      };
    } else if (to === 'reembolsada') {
      message = {
        type: NotificationType.BILLING_SUBSCRIPTION_REFUNDED,
        title: 'Pagamento estornado',
        body: 'O pagamento do plano Equipe foi estornado e a empresa voltou ao plano gratuito.',
      };
    }
    if (!message) return;

    try {
      await new NotificationService(this.services).notify({
        userId,
        workspaceId: subscription.workspaceId,
        type: message.type,
        title: message.title,
        body: message.body,
        data: { workspaceId: subscription.workspaceId, screen: 'subscription' },
        dedupeKey: `billing:${subscription.id}:${to}:${derived.currentPeriodEnd?.toISOString().slice(0, 10) ?? 'sem-periodo'}`,
      });
    } catch (error) {
      this.services.logger?.warn({ err: error, subscriptionId: subscription.id }, 'aviso de assinatura não enviado');
    }
  }

  // -------------------------------------------------------------------------
  // Webhook
  // -------------------------------------------------------------------------

  /** Compara o token do cabeçalho em tempo constante. */
  isWebhookTokenValid(presented: string | undefined): boolean {
    const expected = this.env.ASAAS_WEBHOOK_TOKEN;
    if (!expected || !presented) return false;
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /**
   * Registra e processa um evento do Asaas.
   *
   * O evento é gravado antes de qualquer processamento, com o id do Asaas
   * como chave única: reentrega vira no-op. Se o processamento falhar, a
   * linha fica sem `processed_at` e a reconciliação tenta de novo — o
   * webhook responde 200 de qualquer forma, porque o Asaas pausa a fila
   * inteira depois de falhas seguidas.
   */
  async handleWebhook(payload: Record<string, unknown>): Promise<{ recorded: boolean; duplicated: boolean; processed: boolean }> {
    const eventId = typeof payload['id'] === 'string' ? payload['id'] : null;
    const eventType = typeof payload['event'] === 'string' ? payload['event'] : null;
    if (!eventId || !eventType) {
      recordBillingEvent('ignorado');
      return { recorded: false, duplicated: false, processed: false };
    }

    const payment = (payload['payment'] ?? null) as { subscription?: unknown } | null;
    const subscription = (payload['subscription'] ?? null) as { id?: unknown } | null;
    const providerSubscriptionId =
      typeof payment?.subscription === 'string' ? payment.subscription : typeof subscription?.id === 'string' ? subscription.id : null;

    const inserted = await this.db
      .insert(subscriptionEvents)
      .values({
        notificationId: `asaas:${eventId}`,
        provider: 'asaas',
        eventType,
        providerSubscriptionId,
        payload: scrubAsaasPayload(payload),
      })
      .onConflictDoNothing({ target: subscriptionEvents.notificationId })
      .returning({ id: subscriptionEvents.id });

    const event = inserted[0];
    if (!event) {
      recordBillingEvent('ignorado');
      return { recorded: true, duplicated: true, processed: false };
    }

    try {
      const processed = await this.processEvent(event.id, providerSubscriptionId);
      recordBillingEvent(processed ? 'aceito' : 'ignorado');
      return { recorded: true, duplicated: false, processed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(subscriptionEvents)
        .set({ processError: message.slice(0, 1000), attempts: sql`${subscriptionEvents.attempts} + 1` })
        .where(eq(subscriptionEvents.id, event.id));
      recordBillingEvent('erro');
      this.services.logger?.error({ err: error, eventId, eventType }, 'falha ao processar webhook do Asaas; ficará para a reconciliação');
      return { recorded: true, duplicated: false, processed: false };
    }
  }

  /** @returns se o evento alterou (ou confirmou) uma assinatura nossa. */
  private async processEvent(eventRowId: string, providerSubscriptionId: string | null): Promise<boolean> {
    if (!providerSubscriptionId) {
      // Cobrança avulsa da conta Asaas, sem relação com assinatura do app.
      await this.db
        .update(subscriptionEvents)
        .set({ processedAt: new Date(), processError: 'evento sem assinatura' })
        .where(eq(subscriptionEvents.id, eventRowId));
      return false;
    }

    const row = await this.findByProviderId(providerSubscriptionId);
    if (!row) {
      // O webhook pode chegar antes de a assinatura ser gravada aqui (o Asaas
      // é rápido). Fica pendente: a reconciliação reprocessa em minutos e
      // desiste depois de algumas tentativas.
      await this.db
        .update(subscriptionEvents)
        .set({ attempts: sql`${subscriptionEvents.attempts} + 1`, processError: 'assinatura ainda não registrada' })
        .where(eq(subscriptionEvents.id, eventRowId));
      return false;
    }

    await this.refreshSubscription(row.id);
    await this.db
      .update(subscriptionEvents)
      .set({ processedAt: new Date(), subscriptionId: row.id, processError: null })
      .where(eq(subscriptionEvents.id, eventRowId));
    return true;
  }

  // -------------------------------------------------------------------------
  // Reconciliação
  // -------------------------------------------------------------------------

  /** Reprocessa eventos pendentes; desiste dos que nunca vão casar. */
  async retryPendingEvents(limit = 100): Promise<{ processed: number; abandoned: number }> {
    const pending = await this.db
      .select({
        id: subscriptionEvents.id,
        providerSubscriptionId: subscriptionEvents.providerSubscriptionId,
        attempts: subscriptionEvents.attempts,
      })
      .from(subscriptionEvents)
      .where(and(eq(subscriptionEvents.provider, 'asaas'), sql`${subscriptionEvents.processedAt} IS NULL`))
      .orderBy(subscriptionEvents.receivedAt)
      .limit(limit);

    let processed = 0;
    let abandoned = 0;
    for (const event of pending) {
      if (event.attempts >= 8) {
        await this.db
          .update(subscriptionEvents)
          .set({ processedAt: new Date(), processError: 'abandonado: assinatura desconhecida ou falha persistente' })
          .where(eq(subscriptionEvents.id, event.id));
        abandoned += 1;
        continue;
      }
      try {
        if (await this.processEvent(event.id, event.providerSubscriptionId)) processed += 1;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.db
          .update(subscriptionEvents)
          .set({ processError: message.slice(0, 1000), attempts: sql`${subscriptionEvents.attempts} + 1` })
          .where(eq(subscriptionEvents.id, event.id));
      }
    }
    return { processed, abandoned };
  }

  /**
   * Reprocessa um único evento pendente, a pedido do suporte (painel). Mesmo
   * caminho da reconciliação — o evento só dispara a consulta ao Asaas — e a
   * mesma contabilidade de tentativas. Devolve como a linha ficou, para o
   * painel dizer a verdade: `processed` só quando o evento saiu da fila.
   */
  async retryEvent(eventRowId: string): Promise<{ processed: boolean; error: string | null }> {
    const rows = await this.db
      .select({
        id: subscriptionEvents.id,
        provider: subscriptionEvents.provider,
        providerSubscriptionId: subscriptionEvents.providerSubscriptionId,
        processedAt: subscriptionEvents.processedAt,
      })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.id, eventRowId))
      .limit(1);
    const event = rows[0];
    if (!event || event.provider !== 'asaas') throw notFound('Evento não encontrado.');
    if (event.processedAt) throw conflict(ErrorCode.CONFLICT, 'Este evento já foi processado.');

    try {
      await this.processEvent(event.id, event.providerSubscriptionId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.db
        .update(subscriptionEvents)
        .set({ processError: message.slice(0, 1000), attempts: sql`${subscriptionEvents.attempts} + 1` })
        .where(eq(subscriptionEvents.id, event.id));
    }

    const after = await this.db
      .select({ processedAt: subscriptionEvents.processedAt, processError: subscriptionEvents.processError })
      .from(subscriptionEvents)
      .where(eq(subscriptionEvents.id, event.id))
      .limit(1);
    const processed = after[0]?.processedAt != null;
    return { processed, error: processed ? null : (after[0]?.processError ?? 'evento continua pendente') };
  }

  /**
   * Revalida as assinaturas vivas do Asaas e aplica as regras de prazo:
   * pendente que nunca foi paga e suspensa há muito tempo são canceladas no
   * provedor, para ele parar de gerar cobranças de algo que ninguém usa.
   */
  async reconcile(limit = 200): Promise<{ checked: number; updated: number; failed: number; cancelled: number }> {
    const staleBefore = new Date(Date.now() - 6 * 3_600_000);
    const candidates = await this.db
      .select()
      .from(subscriptions)
      .where(
        and(
          eq(subscriptions.provider, 'asaas'),
          inArray(subscriptions.state, [...LIVE_STATES]),
          sql`(${subscriptions.lastVerifiedAt} < ${staleBefore}
               OR ${subscriptions.state} IN ('pendente', 'carencia', 'suspensa')
               OR ${subscriptions.currentPeriodEnd} < now() + interval '2 days')`,
        ),
      )
      .orderBy(subscriptions.lastVerifiedAt)
      .limit(limit);

    let updated = 0;
    let failed = 0;
    let cancelled = 0;
    const now = Date.now();

    for (const candidate of candidates) {
      try {
        const result = await this.refreshSubscription(candidate.id);
        if (result.changed) updated += 1;

        const pendingTooLong =
          result.state === 'pendente' && now - candidate.createdAt.getTime() > this.env.ASAAS_PENDING_EXPIRE_DAYS * 86_400_000;
        const reference = candidate.graceUntil ?? candidate.currentPeriodEnd;
        const suspendedTooLong =
          result.state === 'suspensa' && reference !== null && now - reference.getTime() > this.env.ASAAS_SUSPENDED_CANCEL_DAYS * 86_400_000;

        if (pendingTooLong || suspendedTooLong) {
          await this.cancelAtProvider(candidate.providerSubscriptionId);
          await this.db
            .update(subscriptions)
            .set({ cancelReason: pendingTooLong ? 'pendente_sem_pagamento' : 'suspensa_sem_pagamento', canceledAt: new Date() })
            .where(eq(subscriptions.id, candidate.id));
          await this.refreshSubscription(candidate.id);
          cancelled += 1;
        }
      } catch (error) {
        failed += 1;
        this.services.logger?.error({ err: error, subscriptionId: candidate.id }, 'falha ao reconciliar assinatura do Asaas');
      }
    }
    return { checked: candidates.length, updated, failed, cancelled };
  }
}

/** Campos que o Asaas devolve e que não devem ficar guardados em lugar nenhum. */
const ASAAS_SENSITIVE_KEYS = ['creditCard', 'creditCardToken', 'creditCardHolderInfo', 'pixTransaction', 'nossoNumero', 'bankSlipUrl'];

/**
 * Cópia de um objeto do Asaas (assinatura ou cobrança) sem dados de cartão.
 * O Asaas devolve o token e os últimos dígitos do cartão nas assinaturas
 * pagas com cartão; nada disso é necessário aqui.
 */
export function scrubAsaasObject<T>(value: T): T {
  if (!value || typeof value !== 'object') return value;
  const clone = JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  for (const key of ASAAS_SENSITIVE_KEYS) delete clone[key];
  return clone as T;
}

/** Remove do payload do webhook o que não precisamos guardar (dados de cartão, conta). */
export function scrubAsaasPayload(payload: Record<string, unknown>): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
  for (const key of ['payment', 'subscription']) {
    if (clone[key] && typeof clone[key] === 'object') clone[key] = scrubAsaasObject(clone[key]);
  }
  delete clone['account'];
  return clone;
}
