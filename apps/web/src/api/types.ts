/**
 * Contratos da API usados pela aplicação web. Espelham os schemas do
 * backend (apps/api/src/modules/**); quando um contrato mudar lá, muda aqui.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  emailVerified: boolean;
  status?: string;
  createdAt: string;
}

export interface WebAuth {
  accessToken: string;
  /** Segundos até o access token expirar. */
  expiresIn: number;
  refreshExpiresAt: string;
  sessionId: string;
  deviceId: string | null;
  user: User;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  role: RoleKey;
  /** `suspended`: a pessoa segue na empresa, mas sem acesso até ser reativada. */
  status: 'active' | 'suspended';
  isOwner: boolean;
  memberCount: number;
  createdAt: string;
}

export interface WorkspaceDetail {
  id: string;
  name: string;
  settings: { currencySymbol?: string } & Record<string, unknown>;
  ownerUserId: string;
  createdAt: string;
  role: RoleKey;
  isOwner: boolean;
  permissions: string[];
}

export type RoleKey = 'proprietario' | 'administrador' | 'gerente' | 'operador' | 'consulta';

export interface Entitlement {
  workspaceId: string;
  /** Assinatura paga valendo (plano Equipe). */
  active: boolean;
  planKey: string;
  state: SubscriptionState;
  /** Origem da assinatura em vigor; `null` no plano gratuito. */
  provider: 'google_play' | 'asaas' | null;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  autoRenewing: boolean;
  features: Record<string, { enabled: boolean; limit: number | null }>;
  syncAllowed: boolean;
  limits: { products: number | null; members: number | null };
  usage: { products: number; members: number };
}

export type SubscriptionState =
  | 'sem_assinatura'
  | 'pendente'
  | 'ativa'
  | 'carencia'
  | 'suspensa'
  | 'cancelada_mas_ativa'
  | 'expirada'
  | 'reembolsada'
  | 'substituida';

export interface Product {
  id: string;
  name: string;
  description: string | null;
  quantity: number;
  unitValue: number;
  minStock: number;
  unit: string | null;
  category: string | null;
  supplier: string | null;
  location: string | null;
  sku: string | null;
  barcode: string | null;
  /** Imagem do produto (SHA-256 do conteúdo); `null` = sem foto. */
  photoHash: string | null;
  rev: number;
  lowStock: boolean;
  outOfStock: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export type ProductFields = Pick<
  Product,
  'name' | 'description' | 'unitValue' | 'minStock' | 'unit' | 'category' | 'supplier' | 'location' | 'sku' | 'barcode' | 'photoHash'
>;

export interface UploadedImage {
  hash: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
  created: boolean;
}

export interface ProductList {
  items: Product[];
  page: number;
  pageSize: number;
  total: number;
  counts: { all: number; lowStock: number };
}

export interface Facets {
  categories: Array<{ value: string; count: number }>;
  suppliers: Array<{ value: string; count: number }>;
  units: Array<{ value: string; count: number }>;
  locations: Array<{ value: string; count: number }>;
  uncategorized: number;
  defaultUnits: string[];
}

export type MovementType =
  | 'entrada'
  | 'saida'
  | 'ajuste'
  | 'cadastro'
  | 'importacao'
  | 'edicao'
  | 'cancelamento'
  | 'venda'
  | 'compra';

export interface Movement {
  id: string;
  productId: string | null;
  productName: string;
  productDeleted: boolean;
  unit: string | null;
  type: MovementType | (string & {});
  /** Com sinal: negativo reduz o estoque. */
  quantity: number;
  note: string | null;
  occurredAt: string;
  recordedAt: string;
  lateEntry: boolean;
  reversesMovementId: string | null;
  reversedBy: string | null;
  balanceAfter: number | null;
  createdByName: string | null;
  canCancel: boolean;
}

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export type ReportPeriod = 'today' | '7d' | '30d' | '90d' | 'all';

export interface ReportSummary {
  period: ReportPeriod;
  products: number;
  stockValue: number;
  toRestock: number;
  outOfStock: number;
  itemsByUnit: Array<{ unit: string; quantity: number }>;
  topValue: Array<{ id: string; name: string; quantity: number; unitValue: number; unit: string | null; total: number }>;
  lowStock: Array<{ id: string; name: string; quantity: number; minStock: number; unit: string | null; supplier: string | null; location: string | null }>;
  byCategory: Array<{ category: string; products: number; quantity: number; value: number }>;
  movements: {
    entries: { count: number; quantity: number; value: number };
    exits: { count: number; quantity: number; value: number };
    others: { count: number; value: number };
  };
  daily: Array<{ day: string; entries: number; exits: number }>;
}

export interface AnalysisItem {
  id: string;
  name: string;
  unit: string | null;
  stock: number;
  minStock: number;
  outflow: number;
  inflow: number;
  days: number;
  avgDaily: number;
  daysUntilStockOut: number | null;
  stockOutDate: string | null;
  turnover: number | null;
  speed: 'rapido' | 'medio' | 'lento' | 'parado';
  priority: 'urgente' | 'breve' | 'atencao' | null;
}

export interface Analysis {
  windowDays: number;
  summary: { analyzed: number; withMovement: number; urgent: number; soon: number; attention: number; fast: number; slow: number };
  items: AnalysisItem[];
}

export interface ImportRow {
  id?: string;
  name?: string;
  description?: string;
  quantity?: number;
  unitValue?: number;
  minStock?: number;
  unit?: string;
  category?: string;
  supplier?: string;
  location?: string;
  sku?: string;
  barcode?: string;
}

export interface ImportResult {
  created: number;
  updated: number;
  unchanged: number;
  errors: number;
  lines: Array<{ index: number; name: string; outcome: 'created' | 'updated' | 'unchanged' | 'error'; message: string | null }>;
}

export interface Conflict {
  id: string;
  entityType: string;
  entityId: string;
  entityName: string | null;
  field: string | null;
  kind: 'campo' | 'exclusao_vs_edicao';
  status: 'pendente' | 'automatico' | 'resolvido';
  baseValue: unknown;
  keptValue: unknown;
  discardedValue: unknown;
  createdAt: string;
  /** Decisão tomada: `meu`, `servidor` ou `restaurar`. */
  resolution: string | null;
  resolvedAt: string | null;
}

export interface Member {
  id: string;
  userId: string;
  name: string;
  email: string;
  role: RoleKey;
  status: 'active' | 'suspended';
  joinedAt: string;
}

export interface Invite {
  id: string;
  email: string;
  roleKey: RoleKey;
  status: 'pendente' | 'aceito' | 'cancelado' | 'expirado';
  invitedBy: string | null;
  expiresAt: string;
  createdAt: string;
  acceptedAt: string | null;
}

export interface InvitePreview {
  workspaceName: string;
  roleKey: RoleKey;
  email: string;
  expiresAt: string;
  hasAccount: boolean;
}

export interface PaymentView {
  id: string;
  status: string;
  billingType: string | null;
  valueCents: number;
  description: string | null;
  dueDate: string | null;
  paidAt: string | null;
  invoiceUrl: string | null;
  receiptUrl: string | null;
}

export interface BillingOverview {
  checkoutAvailable: boolean;
  pricing: { monthlyCents: number | null; yearlyCents: number | null };
  graceDays: number;
  subscription: {
    id: string;
    provider: 'asaas' | 'google_play';
    state: SubscriptionState;
    planKey: string;
    billingCycle: 'MONTHLY' | 'YEARLY' | null;
    billingType: string | null;
    priceCents: number | null;
    autoRenewing: boolean;
    startedAt: string | null;
    currentPeriodEnd: string | null;
    graceUntil: string | null;
    nextDueDate: string | null;
    canceledAt: string | null;
    managedBy: 'web' | 'google_play';
  } | null;
  openPayment: PaymentView | null;
  customer: { name: string; email: string | null; documentType: 'CPF' | 'CNPJ'; documentHint: string } | null;
  payments: PaymentView[];
  history: Array<{
    id: string;
    provider: string;
    state: SubscriptionState;
    billingCycle: string | null;
    startedAt: string | null;
    currentPeriodEnd: string | null;
    canceledAt: string | null;
    createdAt: string;
  }>;
}

export interface CheckoutResult {
  subscriptionId: string;
  state: SubscriptionState;
  payment: PaymentView | null;
}

export interface AppNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data: Record<string, unknown>;
  workspaceId: string | null;
  read: boolean;
  createdAt: string;
}

export interface NotificationList {
  items: AppNotification[];
  hasMore: boolean;
  unread: number;
}

export type TicketCategory = 'question' | 'problem' | 'suggestion' | 'billing' | 'account' | 'other';

export interface Ticket {
  id: string;
  number: number;
  subject: string;
  category: TicketCategory;
  categoryLabel: string;
  status: 'open' | 'answered' | 'resolved';
  messageCount: number;
  lastMessageAt: string;
  lastMessageBy: 'user' | 'admin' | 'system';
  unread: boolean;
  createdAt: string;
  resolvedAt: string | null;
}

export interface TicketMessage {
  id: string;
  author: 'user' | 'support' | 'system';
  authorName: string | null;
  body: string;
  createdAt: string;
}

export interface SessionSummary {
  id: string;
  current: boolean;
  deviceId: string | null;
  deviceModel: string | null;
  appVersionName: string | null;
  createdAt: string;
  lastUsedAt: string;
  expiresAt: string;
}

export interface DeviceSummary {
  id: string;
  installId: string;
  platform: string;
  model: string | null;
  appVersionName: string | null;
  appVersionCode: number | null;
  lastSeenAt: string;
  createdAt: string;
}
