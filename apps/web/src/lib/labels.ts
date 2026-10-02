import type { MovementType, RoleKey, SubscriptionState } from '../api/types';

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand';

/** Rótulos das movimentações, como no app (`MovementDisplay`). */
export const MOVEMENT_LABEL: Record<string, string> = {
  entrada: 'Entrada',
  compra: 'Entrada',
  saida: 'Saída',
  venda: 'Saída',
  ajuste: 'Ajuste',
  edicao: 'Ajuste',
  cadastro: 'Cadastro',
  importacao: 'Importação',
  cancelamento: 'Estorno',
};

export function movementLabel(type: MovementType | string): string {
  return MOVEMENT_LABEL[type] ?? type;
}

export const ROLE_LABEL: Record<RoleKey, string> = {
  proprietario: 'Proprietário',
  administrador: 'Administrador',
  gerente: 'Gerente',
  operador: 'Operador',
  consulta: 'Somente consulta',
};

export const ROLE_DESCRIPTION: Record<RoleKey, string> = {
  proprietario: 'Controle total, inclusive assinatura, transferência e exclusão da empresa.',
  administrador: 'Gerencia produtos, movimentações e equipe. Não transfere nem exclui a empresa e não cuida da assinatura.',
  gerente: 'Gerencia produtos e movimentações. Vê quem está na equipe, mas não convida nem remove pessoas.',
  operador: 'Cadastra e edita produtos e registra entradas e saídas. Não exclui produtos nem gerencia a equipe.',
  consulta: 'Apenas visualiza o estoque. Não altera cadastros nem movimentações.',
};

export const INVITABLE_ROLES: RoleKey[] = ['administrador', 'gerente', 'operador', 'consulta'];

export const SUBSCRIPTION_STATE: Record<SubscriptionState, { label: string; tone: Tone }> = {
  sem_assinatura: { label: 'Plano gratuito', tone: 'neutral' },
  pendente: { label: 'Aguardando pagamento', tone: 'warning' },
  ativa: { label: 'Ativa', tone: 'success' },
  carencia: { label: 'Pagamento em atraso', tone: 'warning' },
  suspensa: { label: 'Suspensa', tone: 'error' },
  cancelada_mas_ativa: { label: 'Cancelada, ativa até o fim do período', tone: 'info' },
  expirada: { label: 'Encerrada', tone: 'neutral' },
  reembolsada: { label: 'Estornada', tone: 'error' },
  substituida: { label: 'Substituída', tone: 'neutral' },
};

export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Aguardando pagamento', tone: 'warning' },
  AWAITING_RISK_ANALYSIS: { label: 'Em análise', tone: 'info' },
  CONFIRMED: { label: 'Pago', tone: 'success' },
  RECEIVED: { label: 'Pago', tone: 'success' },
  RECEIVED_IN_CASH: { label: 'Pago', tone: 'success' },
  DUNNING_RECEIVED: { label: 'Pago', tone: 'success' },
  OVERDUE: { label: 'Vencido', tone: 'error' },
  REFUNDED: { label: 'Estornado', tone: 'neutral' },
  REFUND_REQUESTED: { label: 'Estorno solicitado', tone: 'neutral' },
  REFUND_IN_PROGRESS: { label: 'Estorno em andamento', tone: 'neutral' },
  CHARGEBACK_REQUESTED: { label: 'Contestado', tone: 'error' },
  CHARGEBACK_DISPUTE: { label: 'Em disputa', tone: 'error' },
  AWAITING_CHARGEBACK_REVERSAL: { label: 'Em disputa', tone: 'error' },
  DUNNING_REQUESTED: { label: 'Em cobrança', tone: 'warning' },
};

export const BILLING_TYPE: Record<string, string> = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  DEBIT_CARD: 'Cartão de débito',
  UNDEFINED: 'A escolher na fatura',
};

export const TICKET_STATUS: Record<string, { label: string; tone: Tone }> = {
  open: { label: 'Aguardando resposta', tone: 'warning' },
  answered: { label: 'Respondida', tone: 'brand' },
  resolved: { label: 'Resolvida', tone: 'neutral' },
};

export const TICKET_CATEGORY: Array<{ key: string; label: string }> = [
  { key: 'question', label: 'Dúvida' },
  { key: 'problem', label: 'Problema' },
  { key: 'suggestion', label: 'Sugestão' },
  { key: 'billing', label: 'Assinatura e pagamento' },
  { key: 'account', label: 'Conta e sincronização' },
  { key: 'other', label: 'Outro' },
];

/** Campos de produto em conflitos e mensagens. */
export const FIELD_LABEL: Record<string, string> = {
  name: 'nome',
  unitValue: 'preço',
  minStock: 'estoque mínimo',
  description: 'descrição',
  category: 'categoria',
  supplier: 'fornecedor',
  location: 'localização',
  unit: 'unidade',
  sku: 'SKU',
  barcode: 'código de barras',
};

export const CURRENCIES = ['R$', '$', '€', '£', '¥'];
