/**
 * Catálogo de eventos de uso do produto.
 *
 * É a lista que o app Android e a futura versão web devem emitir, e a que o
 * painel usa para nomear as coisas. Um evento fora do catálogo continua sendo
 * aceito (o nome só precisa respeitar o formato `dominio.acao`) — o catálogo
 * documenta, não restringe, para que uma versão nova do app possa começar a
 * emitir algo antes de a API ser atualizada.
 *
 * Convenções:
 *   - nome em minúsculas, `dominio.acao`, no passado quando é um fato
 *     (`product.created`) e no presente quando é uma tela (`screen.viewed`);
 *   - `properties` só leva o que ajuda a entender o uso: tipo de movimento,
 *     nome da tela, quantidade de itens. Nunca nome de produto, valores em
 *     dinheiro do cliente, e-mail ou qualquer dado pessoal.
 */
export const AnalyticsEventName = {
  // Ciclo de vida do app
  APP_OPENED: 'app.opened',
  SCREEN_VIEWED: 'screen.viewed',

  // Conta (emitidos pela API; o app pode emitir os de intenção)
  SIGNUP_STARTED: 'signup.started',
  USER_REGISTERED: 'user.registered',
  USER_LOGGED_IN: 'user.logged_in',
  USER_EMAIL_VERIFIED: 'user.email_verified',
  USER_DELETION_REQUESTED: 'user.deletion_requested',

  // Empresa e equipe
  WORKSPACE_CREATED: 'workspace.created',
  INVITE_SENT: 'invite.sent',
  INVITE_ACCEPTED: 'invite.accepted',

  // Estoque (emitidos pelo app; a API emite os de sincronização)
  PRODUCT_CREATED: 'product.created',
  PRODUCT_UPDATED: 'product.updated',
  PRODUCT_DELETED: 'product.deleted',
  MOVEMENT_CREATED: 'movement.created',
  MOVEMENT_CANCELLED: 'movement.cancelled',
  BULK_EDIT_APPLIED: 'bulk_edit.applied',
  BARCODE_SCANNED: 'barcode.scanned',
  SEARCH_PERFORMED: 'search.performed',
  LOW_STOCK_FILTER_USED: 'low_stock.filter_used',

  // Relatórios, importação e exportação
  REPORT_GENERATED: 'report.generated',
  ANALYSIS_VIEWED: 'analysis.viewed',
  IMPORT_COMPLETED: 'import.completed',
  EXPORT_COMPLETED: 'export.completed',
  BACKUP_CREATED: 'backup.created',
  BACKUP_RESTORED: 'backup.restored',

  // Sincronização (emitidos pela API)
  SYNC_INITIAL_UPLOAD_COMPLETED: 'sync.initial_upload_completed',
  SYNC_PUSHED: 'sync.pushed',
  SYNC_PULLED: 'sync.pulled',
  SYNC_CONFLICT_RESOLVED: 'sync.conflict_resolved',

  // Assinatura
  PAYWALL_VIEWED: 'paywall.viewed',
  PURCHASE_STARTED: 'purchase.started',
  PURCHASE_FAILED: 'purchase.failed',
  SUBSCRIPTION_LINKED: 'subscription.linked',
  SUBSCRIPTION_STATE_CHANGED: 'subscription.state_changed',
  SUBSCRIPTION_CHECKOUT_STARTED: 'subscription.checkout_started',
  SUBSCRIPTION_CANCEL_REQUESTED: 'subscription.cancel_requested',

  // Notificações
  LOW_STOCK_NOTIFIED: 'low_stock.notified',
  NOTIFICATION_OPENED: 'notification.opened',

  // Suporte (emitidos pela API)
  SUPPORT_TICKET_OPENED: 'support.ticket_opened',
  SUPPORT_MESSAGE_SENT: 'support.message_sent',
  SUPPORT_TICKET_RESOLVED: 'support.ticket_resolved',
  SUPPORT_TICKET_SUBMITTED: 'support.ticket_submitted',
} as const;

export type AnalyticsEventNameValue = (typeof AnalyticsEventName)[keyof typeof AnalyticsEventName];

export interface AnalyticsEventDefinition {
  name: AnalyticsEventNameValue;
  /** Quem emite: o app, a API, ou os dois. */
  source: 'app' | 'server' | 'both';
  description: string;
  /** Propriedades esperadas, para documentação e para o painel rotular. */
  properties?: Record<string, string>;
}

export const ANALYTICS_EVENT_CATALOG: AnalyticsEventDefinition[] = [
  { name: 'app.opened', source: 'app', description: 'Aplicativo aberto (cold ou warm start).', properties: { coldStart: 'boolean' } },
  { name: 'screen.viewed', source: 'app', description: 'Tela exibida.', properties: { screen: 'nome da Activity/tela' } },
  { name: 'signup.started', source: 'app', description: 'Usuário abriu o cadastro.' },
  { name: 'user.registered', source: 'server', description: 'Conta criada.', properties: { origin: 'direto | convite' } },
  { name: 'user.logged_in', source: 'server', description: 'Login efetuado.' },
  { name: 'user.email_verified', source: 'server', description: 'E-mail confirmado.' },
  { name: 'user.deletion_requested', source: 'server', description: 'Exclusão de conta solicitada.' },
  { name: 'workspace.created', source: 'server', description: 'Empresa criada.' },
  { name: 'invite.sent', source: 'server', description: 'Convite enviado.', properties: { roleKey: 'papel' } },
  { name: 'invite.accepted', source: 'server', description: 'Convite aceito.', properties: { roleKey: 'papel', newAccount: 'boolean' } },
  { name: 'product.created', source: 'app', description: 'Produto cadastrado.', properties: { withPhoto: 'boolean', withBarcode: 'boolean' } },
  { name: 'product.updated', source: 'app', description: 'Produto editado.' },
  { name: 'product.deleted', source: 'app', description: 'Produto excluído.' },
  { name: 'movement.created', source: 'app', description: 'Movimentação registrada.', properties: { type: 'entrada | saida | ajuste' } },
  { name: 'movement.cancelled', source: 'app', description: 'Movimentação cancelada.' },
  { name: 'bulk_edit.applied', source: 'app', description: 'Edição em massa aplicada.', properties: { count: 'itens' } },
  { name: 'barcode.scanned', source: 'app', description: 'Código de barras lido.', properties: { found: 'boolean' } },
  { name: 'search.performed', source: 'app', description: 'Busca na lista de produtos.', properties: { results: 'quantidade' } },
  { name: 'low_stock.filter_used', source: 'app', description: 'Filtro "Estoque baixo" acionado.' },
  { name: 'report.generated', source: 'app', description: 'Relatório gerado.', properties: { format: 'pdf | texto' } },
  { name: 'analysis.viewed', source: 'app', description: 'Análise de estoque aberta.' },
  { name: 'import.completed', source: 'app', description: 'Importação concluída.', properties: { format: 'csv | backup', count: 'itens' } },
  { name: 'export.completed', source: 'both', description: 'Exportação concluída.', properties: { format: 'csv | json | pdf' } },
  { name: 'backup.created', source: 'app', description: 'Backup local criado.' },
  { name: 'backup.restored', source: 'app', description: 'Backup local restaurado.' },
  { name: 'sync.initial_upload_completed', source: 'server', description: 'Carga inicial concluída.', properties: { products: 'n', movements: 'n' } },
  { name: 'sync.pushed', source: 'server', description: 'Lote enviado ao servidor.', properties: { operations: 'n', rejected: 'n', conflicts: 'n' } },
  { name: 'sync.pulled', source: 'server', description: 'Alterações baixadas.', properties: { changes: 'n' } },
  { name: 'sync.conflict_resolved', source: 'server', description: 'Conflito resolvido pelo usuário.', properties: { choice: 'meu | servidor | restaurar' } },
  { name: 'paywall.viewed', source: 'app', description: 'Tela de assinatura exibida.', properties: { trigger: 'de onde veio' } },
  { name: 'purchase.started', source: 'app', description: 'Fluxo de compra iniciado.' },
  { name: 'purchase.failed', source: 'app', description: 'Compra não concluída.', properties: { reason: 'código do Billing' } },
  { name: 'subscription.linked', source: 'server', description: 'Assinatura vinculada à empresa.', properties: { planKey: 'plano', state: 'estado' } },
  { name: 'subscription.state_changed', source: 'server', description: 'Estado da assinatura mudou.', properties: { from: 'estado', to: 'estado' } },
  { name: 'low_stock.notified', source: 'app', description: 'Notificação de estoque baixo exibida.', properties: { count: 'produtos' } },
  { name: 'notification.opened', source: 'app', description: 'Notificação tocada.' },
  { name: 'support.ticket_opened', source: 'server', description: 'Solicitação de suporte aberta pelo app.', properties: { category: 'question | problem | suggestion | billing | account | other', signedIn: 'boolean' } },
  { name: 'support.message_sent', source: 'server', description: 'Usuário escreveu numa solicitação já aberta.' },
  { name: 'support.ticket_resolved', source: 'server', description: 'Solicitação encerrada.', properties: { by: 'user | admin' } },
  { name: 'support.ticket_submitted', source: 'app', description: 'Usuário tocou em enviar na tela de nova solicitação.', properties: { category: 'categoria escolhida' } },
  { name: 'subscription.checkout_started', source: 'server', description: 'Contratação do plano iniciada pela web (Asaas).', properties: { provider: 'asaas', cycle: 'MONTHLY | YEARLY', billingType: 'forma de pagamento' } },
  { name: 'subscription.cancel_requested', source: 'server', description: 'Proprietário cancelou a renovação pela web.', properties: { provider: 'asaas' } },
];

/** Formato aceito para nomes de evento (o mesmo CHECK do banco). */
export const EVENT_NAME_PATTERN = /^[a-z0-9_]+(\.[a-z0-9_]+)*$/;

/**
 * Funil padrão do produto: da instalação à assinatura. Cada etapa é um
 * evento; o painel conta usuários (ou instalações) que passaram por cada uma
 * no período. Extensível: acrescentar uma etapa é acrescentar uma linha.
 */
export const DEFAULT_FUNNEL: Array<{ key: string; label: string; event: AnalyticsEventNameValue }> = [
  { key: 'opened', label: 'Abriu o app', event: 'app.opened' },
  { key: 'registered', label: 'Criou conta', event: 'user.registered' },
  { key: 'workspace', label: 'Criou empresa', event: 'workspace.created' },
  { key: 'uploaded', label: 'Enviou o estoque', event: 'sync.initial_upload_completed' },
  { key: 'subscribed', label: 'Assinou', event: 'subscription.linked' },
];
