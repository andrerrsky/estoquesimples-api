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

export const SUBSCRIPTION_STATE: Record<string, { label: string; tone: Tone; hint: string }> = {
  pendente: { label: 'Pendente', tone: 'warning', hint: 'Compra iniciada e ainda não concluída no Google.' },
  ativa: { label: 'Ativa', tone: 'success', hint: 'Paga e renovando.' },
  carencia: { label: 'Carência', tone: 'warning', hint: 'Pagamento falhou; o Google ainda tenta cobrar e o acesso continua.' },
  suspensa: { label: 'Suspensa', tone: 'error', hint: 'Cobrança falhou após a carência (on hold) ou assinatura pausada. Sem acesso.' },
  cancelada_mas_ativa: { label: 'Cancelada (ativa)', tone: 'info', hint: 'Renovação desligada; o acesso vale até o fim do período pago.' },
  expirada: { label: 'Expirada', tone: 'neutral', hint: 'Período terminou sem renovação.' },
  reembolsada: { label: 'Reembolsada', tone: 'error', hint: 'Revogada por reembolso ou estorno.' },
  substituida: { label: 'Substituída', tone: 'neutral', hint: 'Trocada por outra compra (upgrade ou reassinatura).' },
  sem_assinatura: { label: 'Sem assinatura', tone: 'neutral', hint: 'Empresa sem assinatura vinculada.' },
};

export const ENTITLED_STATES = new Set(['ativa', 'carencia', 'cancelada_mas_ativa']);

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
  basico: 'Básico',
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
  'billing.reconcile': 'Reconciliação de assinaturas',
  'sync.retention': 'Limpeza da sincronização',
  'ops.watchdog': 'Vigia do sistema',
  'analytics.retention': 'Retenção de eventos',
  'play.reviews_sync': 'Coleta de avaliações da Play Store',
  'push.send_campaign': 'Envio de campanha de push',
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
  'subscription.refreshed': { label: 'Assinatura reconsultada no Google', tone: 'info' },
  'subscription.event_retried': { label: 'Notificação reprocessada', tone: 'info' },
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
