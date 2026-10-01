import type { Env } from '../../../platform/config/env.js';
import { AppError, ErrorCode } from '../../../platform/http/errors.js';
import type { Logger } from '../../../platform/observability/logger.js';

/**
 * Cliente da API v3 do Asaas, sobre `fetch`.
 *
 * Só o que a assinatura da web usa: pagador, assinatura e cobranças. A chave
 * fica no servidor (`ASAAS_API_KEY`) e nunca sai daqui; o navegador só recebe
 * a URL da fatura hospedada pelo Asaas, onde o pagamento acontece — dados de
 * cartão não passam pela nossa API.
 */

export type AsaasBillingType = 'UNDEFINED' | 'BOLETO' | 'CREDIT_CARD' | 'PIX';
export type AsaasCycle = 'MONTHLY' | 'YEARLY';

export interface AsaasCustomer {
  id: string;
  name: string;
  email: string | null;
  cpfCnpj: string | null;
  externalReference: string | null;
  deleted?: boolean;
}

export interface AsaasSubscription {
  id: string;
  customer: string;
  status: string;
  deleted: boolean;
  cycle: string;
  value: number;
  billingType: string;
  nextDueDate: string | null;
  description: string | null;
  externalReference: string | null;
}

export interface AsaasPayment {
  id: string;
  customer: string;
  subscription: string | null;
  status: string;
  value: number;
  netValue: number | null;
  billingType: string;
  dueDate: string | null;
  paymentDate: string | null;
  clientPaymentDate: string | null;
  confirmedDate?: string | null;
  invoiceUrl: string | null;
  transactionReceiptUrl: string | null;
  description: string | null;
  deleted: boolean;
}

export interface CreateCustomerInput {
  name: string;
  cpfCnpj: string;
  email?: string | null;
  mobilePhone?: string | null;
  externalReference: string;
}

export interface CreateSubscriptionInput {
  customer: string;
  billingType: AsaasBillingType;
  value: number;
  nextDueDate: string;
  cycle: AsaasCycle;
  description: string;
  externalReference: string;
  successUrl?: string | null;
}

export interface AsaasClient {
  readonly configured: boolean;
  readonly environment: 'sandbox' | 'production';
  findCustomerByExternalReference(reference: string): Promise<AsaasCustomer | null>;
  createCustomer(input: CreateCustomerInput): Promise<AsaasCustomer>;
  updateCustomer(id: string, input: Partial<CreateCustomerInput>): Promise<AsaasCustomer>;
  createSubscription(input: CreateSubscriptionInput): Promise<AsaasSubscription>;
  getSubscription(id: string): Promise<AsaasSubscription | null>;
  listCustomerSubscriptions(customerId: string): Promise<AsaasSubscription[]>;
  listSubscriptionPayments(subscriptionId: string): Promise<AsaasPayment[]>;
  deleteSubscription(id: string): Promise<void>;
}

const BASE_URL = {
  production: 'https://api.asaas.com/v3',
  sandbox: 'https://api-sandbox.asaas.com/v3',
} as const;

/** O Asaas pede ao menos 60 s em chamadas com cartão; as demais são rápidas. */
const TIMEOUT_MS = 25_000;

interface AsaasErrorBody {
  errors?: Array<{ code?: string; description?: string }>;
}

export class HttpAsaasClient implements AsaasClient {
  readonly environment: 'sandbox' | 'production';
  private readonly apiKey: string | null;

  constructor(
    env: Env,
    private readonly logger?: () => Logger | undefined,
  ) {
    this.apiKey = env.ASAAS_API_KEY ?? null;
    this.environment = env.ASAAS_ENVIRONMENT;
  }

  get configured(): boolean {
    return this.apiKey !== null;
  }

  private async request<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    path: string,
    options: { body?: unknown; query?: Record<string, string | number | undefined>; allowNotFound?: boolean } = {},
  ): Promise<T | null> {
    if (!this.apiKey) {
      throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'Pagamento pela web ainda não está configurado.');
    }

    const url = new URL(`${BASE_URL[this.environment]}${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          access_token: this.apiKey,
          'User-Agent': `EstoqueSimples/1.0 (Node.js; ${this.environment})`,
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        // GET com corpo devolve 403 no Asaas: o corpo só vai quando existe.
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
    } catch (error) {
      throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'Não foi possível falar com o provedor de pagamento agora. Tente de novo em instantes.', {
        cause: error,
      });
    } finally {
      clearTimeout(timer);
    }

    if (response.status === 404 && options.allowNotFound) return null;

    if (response.ok) {
      if (response.status === 204) return null;
      return (await response.json()) as T;
    }

    let detail: AsaasErrorBody = {};
    try {
      detail = (await response.json()) as AsaasErrorBody;
    } catch {
      // corpo não é JSON
    }
    const first = detail.errors?.[0];
    const description = first?.description ?? `HTTP ${response.status}`;
    this.logger?.()?.warn({ status: response.status, code: first?.code, path, method }, 'asaas recusou a chamada');

    if (response.status === 400) {
      // Regra de negócio ou validação do provedor (documento inválido, valor
      // abaixo do mínimo…): a descrição é em português e serve para a pessoa.
      throw new AppError(400, ErrorCode.VALIDATION_FAILED, description, { extra: { providerCode: first?.code ?? null } });
    }
    if (response.status === 401 || response.status === 403) {
      // Credencial errada, de outro ambiente ou bloqueada por IP: não adianta
      // o usuário insistir, e o texto do provedor não é para ele.
      throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O pagamento pela web está indisponível no momento. Já fomos avisados.', {
        extra: { providerStatus: response.status, providerCode: first?.code ?? null },
      });
    }
    if (response.status === 404) {
      throw new AppError(404, ErrorCode.NOT_FOUND, 'Registro não encontrado no provedor de pagamento.');
    }
    throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento está instável. Tente de novo em instantes.', {
      extra: { providerStatus: response.status },
    });
  }

  async findCustomerByExternalReference(reference: string): Promise<AsaasCustomer | null> {
    const list = await this.request<{ data: AsaasCustomer[] }>('GET', '/customers', {
      query: { externalReference: reference, limit: 10 },
    });
    return list?.data.find((customer) => !customer.deleted) ?? null;
  }

  async createCustomer(input: CreateCustomerInput): Promise<AsaasCustomer> {
    const created = await this.request<AsaasCustomer>('POST', '/customers', {
      body: {
        name: input.name,
        cpfCnpj: input.cpfCnpj,
        ...(input.email ? { email: input.email } : {}),
        ...(input.mobilePhone ? { mobilePhone: input.mobilePhone } : {}),
        externalReference: input.externalReference,
      },
    });
    if (!created) throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento não confirmou o cadastro.');
    return created;
  }

  async updateCustomer(id: string, input: Partial<CreateCustomerInput>): Promise<AsaasCustomer> {
    const updated = await this.request<AsaasCustomer>('PUT', `/customers/${encodeURIComponent(id)}`, {
      body: {
        ...(input.name ? { name: input.name } : {}),
        ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}),
        ...(input.email ? { email: input.email } : {}),
        ...(input.mobilePhone ? { mobilePhone: input.mobilePhone } : {}),
      },
    });
    if (!updated) throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento não confirmou a atualização.');
    return updated;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<AsaasSubscription> {
    const body = {
      customer: input.customer,
      billingType: input.billingType,
      value: input.value,
      nextDueDate: input.nextDueDate,
      cycle: input.cycle,
      description: input.description,
      externalReference: input.externalReference,
    };
    try {
      const created = await this.request<AsaasSubscription>('POST', '/subscriptions', {
        body: input.successUrl ? { ...body, callback: { successUrl: input.successUrl, autoRedirect: true } } : body,
      });
      if (!created) throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento não confirmou a assinatura.');
      return created;
    } catch (error) {
      // O Asaas só aceita `successUrl` do domínio cadastrado nos dados
      // comerciais da conta. Se recusar por isso, a assinatura é criada sem o
      // redirecionamento: a pessoa volta ao app por conta própria e o estado
      // chega pelo webhook de qualquer forma.
      const providerCode = error instanceof AppError ? String(error.extra?.['providerCode'] ?? '') : '';
      const message = error instanceof Error ? error.message : '';
      if (input.successUrl && error instanceof AppError && error.statusCode === 400 && /callback|successUrl|dom[ií]nio/i.test(`${providerCode} ${message}`)) {
        this.logger?.()?.warn({ successUrl: input.successUrl }, 'asaas recusou o successUrl; criando assinatura sem redirecionamento');
        const created = await this.request<AsaasSubscription>('POST', '/subscriptions', { body });
        if (!created) throw new AppError(503, ErrorCode.BILLING_UNAVAILABLE, 'O provedor de pagamento não confirmou a assinatura.');
        return created;
      }
      throw error;
    }
  }

  async getSubscription(id: string): Promise<AsaasSubscription | null> {
    return this.request<AsaasSubscription>('GET', `/subscriptions/${encodeURIComponent(id)}`, { allowNotFound: true });
  }

  async listCustomerSubscriptions(customerId: string): Promise<AsaasSubscription[]> {
    const list = await this.request<{ data: AsaasSubscription[] }>('GET', '/subscriptions', {
      query: { customer: customerId, limit: 100 },
    });
    return list?.data ?? [];
  }

  async listSubscriptionPayments(subscriptionId: string): Promise<AsaasPayment[]> {
    const payments: AsaasPayment[] = [];
    // Paginação defensiva: uma assinatura mensal de anos passa de 100 cobranças.
    for (let offset = 0; offset < 1000; offset += 100) {
      const page = await this.request<{ data: AsaasPayment[]; hasMore: boolean }>(
        'GET',
        `/subscriptions/${encodeURIComponent(subscriptionId)}/payments`,
        { query: { limit: 100, offset }, allowNotFound: true },
      );
      if (!page) break;
      payments.push(...page.data);
      if (!page.hasMore) break;
    }
    return payments;
  }

  async deleteSubscription(id: string): Promise<void> {
    await this.request('DELETE', `/subscriptions/${encodeURIComponent(id)}`, { allowNotFound: true });
  }
}

/**
 * Implementação de teste: um Asaas em memória. Os testes mudam o estado das
 * cobranças (`pay`, `overdue`, `refund`) e disparam o webhook como o
 * provedor faria.
 */
export class FakeAsaasClient implements AsaasClient {
  readonly configured = true;
  readonly environment = 'sandbox' as const;
  readonly customers = new Map<string, AsaasCustomer>();
  readonly subscriptions = new Map<string, AsaasSubscription>();
  readonly payments = new Map<string, AsaasPayment>();
  /** Quando preenchido, a próxima chamada falha com este erro (uma vez). */
  failNext: AppError | null = null;
  private sequence = 0;

  /** Volta ao estado inicial entre testes. */
  reset(): void {
    this.customers.clear();
    this.subscriptions.clear();
    this.payments.clear();
    this.failNext = null;
    this.sequence = 0;
  }

  private next(prefix: string): string {
    this.sequence += 1;
    return `${prefix}_${String(this.sequence).padStart(6, '0')}`;
  }

  private maybeFail(): void {
    if (this.failNext) {
      const error = this.failNext;
      this.failNext = null;
      throw error;
    }
  }

  async findCustomerByExternalReference(reference: string): Promise<AsaasCustomer | null> {
    this.maybeFail();
    return [...this.customers.values()].find((customer) => customer.externalReference === reference) ?? null;
  }

  async createCustomer(input: CreateCustomerInput): Promise<AsaasCustomer> {
    this.maybeFail();
    const customer: AsaasCustomer = {
      id: this.next('cus'),
      name: input.name,
      email: input.email ?? null,
      cpfCnpj: input.cpfCnpj,
      externalReference: input.externalReference,
    };
    this.customers.set(customer.id, customer);
    return customer;
  }

  async updateCustomer(id: string, input: Partial<CreateCustomerInput>): Promise<AsaasCustomer> {
    this.maybeFail();
    const current = this.customers.get(id);
    if (!current) throw new AppError(404, ErrorCode.NOT_FOUND, 'Cliente não encontrado.');
    const updated = { ...current, ...(input.name ? { name: input.name } : {}), ...(input.email ? { email: input.email } : {}), ...(input.cpfCnpj ? { cpfCnpj: input.cpfCnpj } : {}) };
    this.customers.set(id, updated);
    return updated;
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<AsaasSubscription> {
    this.maybeFail();
    const subscription: AsaasSubscription = {
      id: this.next('sub'),
      customer: input.customer,
      status: 'ACTIVE',
      deleted: false,
      cycle: input.cycle,
      value: input.value,
      billingType: input.billingType,
      nextDueDate: input.nextDueDate,
      description: input.description,
      externalReference: input.externalReference,
    };
    this.subscriptions.set(subscription.id, subscription);
    this.addPayment(subscription.id, input.nextDueDate);
    return subscription;
  }

  /** Gera a cobrança de um vencimento, como o Asaas faz a cada ciclo. */
  addPayment(subscriptionId: string, dueDate: string, status = 'PENDING'): AsaasPayment {
    const subscription = this.subscriptions.get(subscriptionId);
    if (!subscription) throw new Error('assinatura inexistente no Asaas de teste');
    const id = this.next('pay');
    const payment: AsaasPayment = {
      id,
      customer: subscription.customer,
      subscription: subscriptionId,
      status,
      value: subscription.value,
      netValue: subscription.value,
      billingType: subscription.billingType,
      dueDate,
      paymentDate: null,
      clientPaymentDate: null,
      invoiceUrl: `https://sandbox.asaas.com/i/${id.slice(4)}`,
      transactionReceiptUrl: null,
      description: subscription.description,
      deleted: false,
    };
    this.payments.set(id, payment);
    return payment;
  }

  setPaymentStatus(paymentId: string, status: string): AsaasPayment {
    const payment = this.payments.get(paymentId);
    if (!payment) throw new Error('cobrança inexistente no Asaas de teste');
    payment.status = status;
    if (status === 'RECEIVED' || status === 'CONFIRMED') payment.paymentDate = new Date().toISOString().slice(0, 10);
    return payment;
  }

  async getSubscription(id: string): Promise<AsaasSubscription | null> {
    this.maybeFail();
    return this.subscriptions.get(id) ?? null;
  }

  async listCustomerSubscriptions(customerId: string): Promise<AsaasSubscription[]> {
    this.maybeFail();
    return [...this.subscriptions.values()].filter((subscription) => subscription.customer === customerId);
  }

  async listSubscriptionPayments(subscriptionId: string): Promise<AsaasPayment[]> {
    this.maybeFail();
    return [...this.payments.values()].filter((payment) => payment.subscription === subscriptionId);
  }

  async deleteSubscription(id: string): Promise<void> {
    this.maybeFail();
    const subscription = this.subscriptions.get(id);
    if (!subscription) return;
    subscription.deleted = true;
    subscription.status = 'INACTIVE';
    // Remover a assinatura apaga as cobranças pendentes ou vencidas.
    for (const payment of this.payments.values()) {
      if (payment.subscription === id && (payment.status === 'PENDING' || payment.status === 'OVERDUE')) {
        payment.deleted = true;
      }
    }
  }
}
