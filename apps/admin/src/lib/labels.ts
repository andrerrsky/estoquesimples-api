/**
 * Rótulos em português para os valores técnicos da API. Um valor que não
 * esteja aqui é exibido como veio: melhor um código cru do que um "—" que
 * esconde informação.
 */

export type Tone = 'neutral' | 'success' | 'warning' | 'error' | 'info' | 'brand';

export const USER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Ativa', tone: 'success' },
  suspended: { label: 'Suspensa', tone: 'error' },
  pending_deletion: { label: 'Exclusão pendente', tone: 'warning' },
};

export const MEMBER_STATUS: Record<string, { label: string; tone: Tone }> = {
  active: { label: 'Ativo', tone: 'success' },
  suspended: { label: 'Suspenso', tone: 'warning' },
  removed: { label: 'Removido', tone: 'neutral' },
};

/**
 * Os estados são os mesmos nos dois provedores. `hint` é o texto que vale
 * para qualquer um; quando o provedor é conhecido, `subscriptionHint` dá a
 * explicação própria dele (o que "pendente" ou "carência" significa muda).
 */
export const SUBSCRIPTION_STATE: Record<string, { label: string; tone: Tone; hint: string }> = {
  pendente: { label: 'Pendente', tone: 'warning', hint: 'Contratação iniciada e ainda não paga.' },
  ativa: { label: 'Ativa', tone: 'success', hint: 'Paga e renovando.' },
  carencia: { label: 'Carência', tone: 'warning', hint: 'Pagamento em atraso; o acesso continua durante a carência.' },
  suspensa: { label: 'Suspensa', tone: 'error', hint: 'Pagamento não identificado após a carência. Sem acesso.' },
  cancelada_mas_ativa: { label: 'Cancelada (ativa)', tone: 'info', hint: 'Renovação desligada; o acesso vale até o fim do período pago.' },
  expirada: { label: 'Expirada', tone: 'neutral', hint: 'Período terminou sem renovação.' },
  reembolsada: { label: 'Reembolsada', tone: 'error', hint: 'Revogada por reembolso ou estorno.' },
  substituida: { label: 'Substituída', tone: 'neutral', hint: 'Trocada por outra assinatura (upgrade, reassinatura ou troca de provedor).' },
  sem_assinatura: { label: 'Sem assinatura', tone: 'neutral', hint: 'Empresa sem assinatura vinculada.' },
};

const SUBSCRIPTION_HINT_BY_PROVIDER: Record<string, Record<string, string>> = {
  google_play: {
    pendente: 'Compra iniciada e ainda não concluída no Google.',
    carencia: 'Pagamento falhou; o Google ainda tenta cobrar e o acesso continua.',
    suspensa: 'Cobrança falhou após a carência (on hold) ou assinatura pausada. Sem acesso.',
    substituida: 'Trocada por outra compra (upgrade ou reassinatura).',
  },
  asaas: {
    pendente: 'Contratação feita na web; a primeira cobrança do Asaas ainda não foi paga. Sem pagamento, é cancelada sozinha depois de alguns dias.',
    carencia: 'A cobrança do Asaas venceu e não foi paga; o acesso continua até o fim da carência.',
    suspensa: 'Cobrança do Asaas em aberto após a carência, ou pagamento contestado. Sem acesso; pagar a fatura reativa.',
    cancelada_mas_ativa: 'Renovação cancelada na web; o acesso vale até o fim do período já pago.',
    expirada: 'Período pago terminou sem nova cobrança paga.',
    reembolsada: 'Pagamento estornado no Asaas; o acesso foi retirado na hora.',
    substituida: 'Substituída por outra assinatura da empresa (nova contratação na web ou compra pelo Google Play).',
  },
};

export function subscriptionHint(state: string, provider?: string | null): string {
  return (provider ? SUBSCRIPTION_HINT_BY_PROVIDER[provider]?.[state] : undefined) ?? SUBSCRIPTION_STATE[state]?.hint ?? '';
}

export const ENTITLED_STATES = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

/** De onde a assinatura vem: Google Play (app Android) ou Asaas (web). */
export const SUBSCRIPTION_PROVIDER: Record<string, { label: string; short: string; tone: Tone; hint: string }> = {
  google_play: { label: 'Google Play', short: 'Google Play', tone: 'neutral', hint: 'Comprada no app Android; preço e cobrança ficam na Play Console.' },
  asaas: { label: 'Asaas (web)', short: 'Web', tone: 'brand', hint: 'Contratada na web; a cobrança é do Asaas.' },
};

export function providerLabel(provider: string | null | undefined): string {
  if (!provider) return '—';
  return SUBSCRIPTION_PROVIDER[provider]?.label ?? provider;
}

export const BILLING_CYCLE: Record<string, string> = {
  MONTHLY: 'Mensal',
  YEARLY: 'Anual',
};

export const BILLING_TYPE: Record<string, string> = {
  PIX: 'Pix',
  BOLETO: 'Boleto',
  CREDIT_CARD: 'Cartão de crédito',
  UNDEFINED: 'A escolher na fatura',
};

/** Estado da cobrança como o Asaas informa. */
export const PAYMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  PENDING: { label: 'Aguardando pagamento', tone: 'warning' },
  AWAITING_RISK_ANALYSIS: { label: 'Em análise de risco', tone: 'warning' },
  OVERDUE: { label: 'Vencida', tone: 'error' },
  RECEIVED: { label: 'Recebida', tone: 'success' },
  CONFIRMED: { label: 'Confirmada', tone: 'success' },
  RECEIVED_IN_CASH: { label: 'Recebida em dinheiro', tone: 'success' },
  DUNNING_RECEIVED: { label: 'Recuperada', tone: 'success' },
  DUNNING_REQUESTED: { label: 'Em negativação', tone: 'warning' },
  REFUNDED: { label: 'Estornada', tone: 'error' },
  REFUND_REQUESTED: { label: 'Estorno solicitado', tone: 'error' },
  REFUND_IN_PROGRESS: { label: 'Estorno em andamento', tone: 'error' },
  CHARGEBACK_REQUESTED: { label: 'Contestada (chargeback)', tone: 'error' },
  CHARGEBACK_DISPUTE: { label: 'Em disputa de chargeback', tone: 'error' },
  AWAITING_CHARGEBACK_REVERSAL: { label: 'Aguardando reversão do chargeback', tone: 'warning' },
};

/** Eventos de webhook do Asaas (`subscription_events.event_type`). */
export const ASAAS_EVENT: Record<string, string> = {
  PAYMENT_CREATED: 'Cobrança criada',
  PAYMENT_UPDATED: 'Cobrança alterada',
  PAYMENT_CONFIRMED: 'Pagamento confirmado',
  PAYMENT_RECEIVED: 'Pagamento recebido',
  PAYMENT_OVERDUE: 'Cobrança vencida',
  PAYMENT_DELETED: 'Cobrança removida',
  PAYMENT_RESTORED: 'Cobrança restaurada',
  PAYMENT_REFUNDED: 'Pagamento estornado',
  PAYMENT_REFUND_IN_PROGRESS: 'Estorno em andamento',
  PAYMENT_RECEIVED_IN_CASH_UNDONE: 'Recebimento em dinheiro desfeito',
  PAYMENT_CHARGEBACK_REQUESTED: 'Chargeback solicitado',
  PAYMENT_CHARGEBACK_DISPUTE: 'Chargeback em disputa',
  PAYMENT_AWAITING_CHARGEBACK_REVERSAL: 'Aguardando reversão de chargeback',
  PAYMENT_AWAITING_RISK_ANALYSIS: 'Pagamento em análise de risco',
  PAYMENT_APPROVED_BY_RISK_ANALYSIS: 'Pagamento aprovado na análise de risco',
  PAYMENT_REPROVED_BY_RISK_ANALYSIS: 'Pagamento reprovado na análise de risco',
  PAYMENT_CREDIT_CARD_CAPTURE_REFUSED: 'Captura do cartão recusada',
  SUBSCRIPTION_CREATED: 'Assinatura criada',
  SUBSCRIPTION_UPDATED: 'Assinatura alterada',
  SUBSCRIPTION_INACTIVATED: 'Assinatura inativada',
  SUBSCRIPTION_DELETED: 'Assinatura removida',
};

/** Tipos da caixa de notificações (`notifications.type`), comum a app e web. */
export const NOTIFICATION_TYPE: Record<string, { label: string; tone: Tone }> = {
  'support.reply': { label: 'Resposta do suporte', tone: 'info' },
  'support.resolved': { label: 'Solicitação resolvida', tone: 'success' },
  'billing.payment_confirmed': { label: 'Pagamento confirmado', tone: 'success' },
  'billing.payment_overdue': { label: 'Pagamento em atraso', tone: 'warning' },
  'billing.subscription_suspended': { label: 'Plano suspenso', tone: 'error' },
  'billing.subscription_ended': { label: 'Plano encerrado', tone: 'neutral' },
  'billing.subscription_refunded': { label: 'Pagamento estornado', tone: 'error' },
  'team.invite_accepted': { label: 'Convite aceito', tone: 'success' },
  'team.member_joined': { label: 'Novo membro na equipe', tone: 'success' },
  campaign: { label: 'Campanha', tone: 'brand' },
};

export const ROLE_LABEL: Record<string, string> = {
  proprietario: 'Proprietário',
  administrador: 'Administrador',
  gerente: 'Gerente',
  operador: 'Operador',
  consulta: 'Somente consulta',
};

export const ROLE_OPTIONS = ['administrador', 'gerente', 'operador', 'consulta'];

export const ADMIN_ROLE: Record<string, { label: string; hint: string }> = {
  owner: { label: 'Owner', hint: 'Tudo, inclusive gerir administradores, planos e o interruptor de sincronização.' },
  support: { label: 'Suporte', hint: 'Opera contas e empresas: suspender, revogar sessões, reprocessar assinaturas.' },
  viewer: { label: 'Leitura', hint: 'Só consulta.' },
};

export const PLAN_LABEL: Record<string, string> = {
  gratuito: 'Gratuito',
  basico: 'Equipe',
};

export const MOVEMENT_TYPE: Record<string, string> = {
  entrada: 'Entrada',
  saida: 'Saída',
  ajuste: 'Ajuste',
  cadastro: 'Cadastro',
  importacao: 'Importação',
  edicao: 'Edição',
  cancelamento: 'Cancelamento',
  venda: 'Venda',
  compra: 'Compra',
};

export const CONFLICT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pendente: { label: 'Pendente', tone: 'warning' },
  automatico: { label: 'Automático', tone: 'neutral' },
  resolvido: { label: 'Resolvido', tone: 'success' },
};

export const JOB_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'Na fila', tone: 'info' },
  running: { label: 'Executando', tone: 'brand' },
  completed: { label: 'Concluída', tone: 'success' },
  failed: { label: 'Falhou', tone: 'error' },
};

export const JOB_KIND: Record<string, string> = {
  'billing.reconcile': 'Reconciliação de assinaturas (Google Play)',
  'billing.asaas_reconcile': 'Reconciliação de assinaturas da web (Asaas)',
  'sync.retention': 'Limpeza da sincronização',
  'ops.watchdog': 'Vigia do sistema',
  'analytics.retention': 'Retenção de eventos',
  'play.reviews_sync': 'Coleta de avaliações da Play Store',
  'push.send_campaign': 'Envio de campanha (push e caixa de notificações)',
  'support.notify_team': 'Aviso à equipe de solicitação nova (e-mail)',
};

/**
 * Descrições das ações de auditoria. A chave é o `action` gravado; o texto
 * é o que aparece na linha do tempo.
 */
export const AUDIT_ACTION: Record<string, { label: string; tone: Tone }> = {
  'user.registered': { label: 'Conta criada', tone: 'success' },
  'user.logged_in': { label: 'Login', tone: 'neutral' },
  'user.login_failed': { label: 'Senha incorreta', tone: 'warning' },
  'user.account_locked': { label: 'Conta bloqueada por tentativas', tone: 'error' },
  'user.logged_out': { label: 'Logout', tone: 'neutral' },
  'user.logged_out_all': { label: 'Todas as sessões encerradas', tone: 'warning' },
  'user.password_changed': { label: 'Senha alterada', tone: 'info' },
  'user.password_reset_requested': { label: 'Redefinição de senha pedida', tone: 'info' },
  'user.password_reset_completed': { label: 'Senha redefinida', tone: 'info' },
  'user.email_verified': { label: 'E-mail confirmado', tone: 'success' },
  'user.deletion_requested': { label: 'Exclusão da conta solicitada', tone: 'error' },
  'user.token_reuse_detected': { label: 'Reuso de token detectado', tone: 'error' },
  'device.registered': { label: 'Dispositivo registrado', tone: 'neutral' },
  'device.revoked': { label: 'Dispositivo revogado', tone: 'warning' },
  'workspace.created': { label: 'Empresa criada', tone: 'success' },
  'workspace.updated': { label: 'Empresa atualizada', tone: 'neutral' },
  'workspace.deleted': { label: 'Empresa excluída', tone: 'error' },
  'workspace.ownership_transferred': { label: 'Propriedade transferida', tone: 'warning' },
  'member.role_changed': { label: 'Papel de membro alterado', tone: 'info' },
  'member.removed': { label: 'Membro removido', tone: 'warning' },
  'member.suspended': { label: 'Membro suspenso', tone: 'warning' },
  'member.reactivated': { label: 'Membro reativado', tone: 'success' },
  'invite.created': { label: 'Convite enviado', tone: 'neutral' },
  'invite.resent': { label: 'Convite reenviado', tone: 'neutral' },
  'invite.cancelled': { label: 'Convite cancelado', tone: 'neutral' },
  'invite.accepted': { label: 'Convite aceito', tone: 'success' },
  'subscription.linked': { label: 'Assinatura vinculada', tone: 'success' },
  'subscription.state_changed': { label: 'Estado da assinatura mudou', tone: 'info' },
  'subscription.token_rejected': { label: 'Comprovante recusado', tone: 'error' },
  'subscription.reconciled': { label: 'Assinatura reconciliada', tone: 'neutral' },
  'sync.initial_upload_started': { label: 'Carga inicial iniciada', tone: 'neutral' },
  'sync.initial_upload_completed': { label: 'Carga inicial concluída', tone: 'success' },
  'sync.conflict_recorded': { label: 'Conflito registrado', tone: 'warning' },
  'sync.conflict_resolved': { label: 'Conflito resolvido', tone: 'success' },
  'sync.resync_required': { label: 'Ressincronização exigida', tone: 'warning' },
  'data.exported': { label: 'Dados exportados', tone: 'neutral' },
  'product.deleted': { label: 'Produto excluído', tone: 'neutral' },
  'product.restored': { label: 'Produto restaurado', tone: 'neutral' },
  'stock.adjusted': { label: 'Estoque ajustado', tone: 'neutral' },

  'admin.logged_in': { label: 'Login no painel', tone: 'neutral' },
  'admin.login_failed': { label: 'Senha incorreta no painel', tone: 'warning' },
  'admin.logged_out': { label: 'Logout do painel', tone: 'neutral' },
  'admin.created': { label: 'Administrador criado', tone: 'success' },
  'admin.updated': { label: 'Administrador alterado', tone: 'info' },
  'admin.password_reset': { label: 'Senha de administrador redefinida', tone: 'warning' },
  'admin.disabled': { label: 'Administrador desativado', tone: 'error' },
  'admin.reactivated': { label: 'Administrador reativado', tone: 'success' },
  'admin.sessions_revoked': { label: 'Sessões de administrador encerradas', tone: 'warning' },
  'user.updated': { label: 'Dados da conta alterados', tone: 'info' },
  'user.suspended': { label: 'Conta suspensa pelo suporte', tone: 'error' },
  'user.reactivated': { label: 'Conta reativada pelo suporte', tone: 'success' },
  'user.unlocked': { label: 'Bloqueio de login removido', tone: 'info' },
  'user.sessions_revoked': { label: 'Sessões encerradas pelo suporte', tone: 'warning' },
  'user.device_revoked': { label: 'Dispositivo revogado pelo suporte', tone: 'warning' },
  'user.password_reset_sent': { label: 'E-mail de redefinição enviado', tone: 'info' },
  'user.deletion_cancelled': { label: 'Exclusão da conta cancelada', tone: 'success' },
  'workspace.restored': { label: 'Empresa restaurada', tone: 'success' },
  'workspace.member_role_changed': { label: 'Papel alterado pelo suporte', tone: 'info' },
  'workspace.member_status_changed': { label: 'Situação de membro alterada pelo suporte', tone: 'info' },
  'workspace.member_removed': { label: 'Membro removido pelo suporte', tone: 'warning' },
  'workspace.invite_cancelled': { label: 'Convite cancelado pelo suporte', tone: 'neutral' },
  'subscription.refreshed': { label: 'Assinatura reconsultada no provedor', tone: 'info' },
  'subscription.event_retried': { label: 'Notificação de assinatura reprocessada', tone: 'info' },
  'plan.updated': { label: 'Plano alterado', tone: 'warning' },
  'plan.feature_updated': { label: 'Recurso de plano alterado', tone: 'warning' },
  'note.created': { label: 'Nota de suporte adicionada', tone: 'neutral' },
  'note.deleted': { label: 'Nota de suporte removida', tone: 'neutral' },
  'ops.sync_config_changed': { label: 'Sincronização reconfigurada', tone: 'error' },
  'ops.job_retried': { label: 'Tarefa recolocada na fila', tone: 'info' },
  'ops.job_cancelled': { label: 'Tarefa cancelada', tone: 'warning' },
  'review.replied': { label: 'Resposta publicada na Play Store', tone: 'info' },
  'review.draft_generated': { label: 'Rascunho de resposta gerado', tone: 'neutral' },
  'reviews.synced': { label: 'Avaliações buscadas no Google', tone: 'neutral' },
  'setting.updated': { label: 'Configuração alterada', tone: 'warning' },
  'setting.removed': { label: 'Configuração removida', tone: 'warning' },
  'push.campaign_created': { label: 'Campanha de push criada', tone: 'neutral' },
  'push.campaign_updated': { label: 'Campanha de push editada', tone: 'neutral' },
  'push.campaign_sent': { label: 'Campanha de push enviada', tone: 'warning' },
  'push.campaign_cancelled': { label: 'Campanha de push cancelada', tone: 'warning' },
  'push.campaign_deleted': { label: 'Campanha de push apagada', tone: 'neutral' },
  'push.test_sent': { label: 'Push de teste enviado', tone: 'neutral' },
  'support.replied': { label: 'Resposta de suporte enviada', tone: 'info' },
  'support.note_added': { label: 'Nota interna no atendimento', tone: 'neutral' },
  'support.status_changed': { label: 'Estado da solicitação alterado', tone: 'info' },
  'support.ticket_updated': { label: 'Solicitação reclassificada', tone: 'neutral' },
  'support.draft_generated': { label: 'Rascunho de resposta de suporte gerado', tone: 'neutral' },
};

export const SUPPORT_STATUS: Record<string, { label: string; tone: Tone; hint: string }> = {
  open: { label: 'Aguardando equipe', tone: 'warning', hint: 'O usuário escreveu e ninguém respondeu ainda.' },
  answered: { label: 'Respondida', tone: 'info', hint: 'A equipe respondeu; aguardando o usuário.' },
  resolved: { label: 'Resolvida', tone: 'success', hint: 'Encerrada pela equipe ou pelo usuário.' },
};

export const SUPPORT_CATEGORY: Record<string, string> = {
  question: 'Dúvida',
  problem: 'Problema',
  suggestion: 'Sugestão',
  billing: 'Assinatura e pagamento',
  account: 'Conta e sincronização',
  other: 'Outro',
};

export const SUPPORT_PRIORITY: Record<string, { label: string; tone: Tone }> = {
  low: { label: 'Baixa', tone: 'neutral' },
  normal: { label: 'Normal', tone: 'neutral' },
  high: { label: 'Alta', tone: 'error' },
};

export const NOTIFY_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending: { label: 'avisando…', tone: 'neutral' },
  push: { label: 'avisado por push', tone: 'success' },
  email: { label: 'avisado por e-mail', tone: 'info' },
  muted: { label: 'notificações desligadas', tone: 'warning' },
  none: { label: 'sem como avisar', tone: 'warning' },
  failed: { label: 'push falhou', tone: 'error' },
};

export function auditLabel(action: string): { label: string; tone: Tone } {
  return AUDIT_ACTION[action] ?? { label: action, tone: 'neutral' };
}

export const EVENT_DOMAIN_LABEL: Record<string, string> = {
  app: 'Aplicativo',
  screen: 'Telas',
  signup: 'Cadastro',
  user: 'Conta',
  workspace: 'Empresa',
  invite: 'Convites',
  product: 'Produtos',
  movement: 'Movimentações',
  bulk_edit: 'Edição em massa',
  barcode: 'Código de barras',
  search: 'Busca',
  low_stock: 'Estoque baixo',
  report: 'Relatórios',
  analysis: 'Análise',
  import: 'Importação',
  export: 'Exportação',
  backup: 'Backup',
  sync: 'Sincronização',
  paywall: 'Assinatura',
  purchase: 'Compra',
  subscription: 'Assinatura',
  notification: 'Notificações',
  support: 'Suporte',
};

export function eventDomain(name: string): string {
  const domain = name.split('.')[0] ?? name;
  return EVENT_DOMAIN_LABEL[domain] ?? domain;
}

export const PLATFORM_LABEL: Record<string, string> = {
  android: 'Android',
  ios: 'iOS',
  web: 'Web',
  server: 'API',
};

export const PLATFORM_TONE: Record<string, Tone> = {
  android: 'success',
  ios: 'neutral',
  web: 'brand',
  server: 'neutral',
};

/** Opções do recorte de plataforma, iguais em todas as telas. */
export const PLATFORM_FILTER: Array<{ key: string; label: string }> = [
  { key: '', label: 'Todas' },
  { key: 'android', label: 'Android' },
  { key: 'web', label: 'Web' },
];
