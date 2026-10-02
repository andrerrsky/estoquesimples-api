import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { HorizontalBars } from '../charts/charts';
import { Icon } from '../components/Icon';
import {
  Badge,
  Card,
  Chips,
  ConfirmDialog,
  CopyId,
  Empty,
  errorMessage,
  KeyValue,
  Notice,
  PageHeader,
  Pagination,
  PlatformBadge,
  Skeleton,
  StatTile,
  Time,
  useToast,
} from '../components/ui';
import { fmtDateTime, fmtNumber, fmtRelative, pluralize, shortId } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { NOTIFY_STATUS, PLAN_LABEL, ROLE_LABEL, SUBSCRIPTION_STATE, SUPPORT_CATEGORY, SUPPORT_PRIORITY, SUPPORT_STATUS, USER_STATUS } from '../lib/labels';

interface Stats {
  open: number;
  answered: number;
  unassigned: number;
  openStale: number;
  resolved7d: number;
  new7d: number;
  total: number;
  avgFirstResponseMinutes: number | null;
  byCategory: Array<{ category: string; count: number }>;
  openAiConfigured: boolean;
  fcmConfigured: boolean;
}

interface Ticket {
  id: string;
  number: number;
  subject: string;
  category: string;
  status: string;
  priority: string;
  userId: string | null;
  userEmail: string | null;
  userName: string | null;
  contactEmail: string | null;
  contactName: string | null;
  installId: string;
  workspaceId: string | null;
  deviceSummary: string | null;
  /** De onde a solicitação foi aberta: `android` (padrão das versões antigas do app) ou `web`. */
  platform: string;
  appVersionCode: number | null;
  assignedTo: string | null;
  assignedToEmail: string | null;
  messageCount: number;
  lastMessageAt: string;
  lastMessageBy: string;
  unread: boolean;
  firstResponseAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
}

interface Message {
  id: string;
  author: 'user' | 'admin' | 'system';
  adminId: string | null;
  adminName: string | null;
  body: string;
  internal: boolean;
  notifyStatus: string | null;
  notifyDetail: string | null;
  createdAt: string;
}

interface TicketDetail extends Ticket {
  device: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
  workspaceName: string | null;
  user: {
    id: string;
    name: string;
    email: string;
    status: string;
    createdAt: string | null;
    workspaces: Array<{ id: string; name: string; role: string; plan: string | null; state: string | null }>;
  } | null;
  otherTickets: number;
  reachableDevices: number;
  mutedDevices: number;
  messages: Message[];
}

const REPLY_MAX = 4000;

function fmtMinutes(minutes: number | null): string {
  if (minutes === null) return '—';
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 60 * 48) return `${Math.round(minutes / 60)} h`;
  return `${Math.round(minutes / 60 / 24)} d`;
}

function whoLabel(ticket: Ticket): string {
  return ticket.userName || ticket.userEmail || ticket.contactName || ticket.contactEmail || `instalação ${shortId(ticket.installId)}`;
}

// ---------------------------------------------------------------------------
// Fila
// ---------------------------------------------------------------------------

export function SupportPage() {
  const { values, set, page, pageSize } = useListParams({ status: 'unresolved' });
  const status = values['status'] ?? 'unresolved';

  const stats = useQuery({ queryKey: ['support', 'stats'], queryFn: () => api.get<Stats>('/support/stats'), refetchInterval: 60_000 });
  const list = useQuery({
    queryKey: ['support', 'list', values, page, pageSize],
    queryFn: () =>
      api.get<Paginated<Ticket>>('/support/tickets', {
        status: status === 'all' ? undefined : status,
        category: values['category'],
        priority: values['priority'],
        assigned: values['assigned'],
        platform: values['platform'],
        q: values['q'],
        page,
        pageSize,
      }),
    placeholderData: (previous) => previous,
    refetchInterval: 30_000,
  });

  const s = stats.data;

  return (
    <div className="page">
      <PageHeader title="Atendimento" subtitle="Solicitações abertas pelo app Android e pela web; a resposta cai na caixa de notificações e vira push no aparelho" />

      {s && !s.fcmConfigured && (
        <Notice tone="warning" title="Firebase não configurado">As respostas são gravadas e aparecem na conversa (app e web), mas sem push: o aviso ativo fica só por e-mail, quando houver.</Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Aguardando equipe" value={fmtNumber(s?.open)} foot={s && s.openStale > 0 ? `${fmtNumber(s.openStale)} há mais de 24 h` : 'nenhuma parada há mais de 24 h'} tone={(s?.openStale ?? 0) > 0 ? 'alert' : (s?.open ?? 0) > 0 ? 'accent' : undefined} />
        <StatTile label="Aguardando usuário" value={fmtNumber(s?.answered)} foot="respondidas, sem retorno ainda" />
        <StatTile label="Sem responsável" value={fmtNumber(s?.unassigned)} foot="entre as não resolvidas" />
        <StatTile label="1ª resposta (30 d)" value={fmtMinutes(s?.avgFirstResponseMinutes ?? null)} foot="tempo médio até a primeira resposta" />
        <StatTile label="Últimos 7 dias" value={fmtNumber(s?.new7d)} foot={`${fmtNumber(s?.resolved7d ?? 0)} resolvidas · ${fmtNumber(s?.total ?? 0)} no total`} />
      </div>

      <div className="grid grid--2-1">
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <Chips
              value={status}
              onChange={(next) => set({ status: next })}
              items={[
                { key: 'unresolved', label: 'Em aberto' },
                { key: 'open', label: 'Aguardando equipe' },
                { key: 'answered', label: 'Aguardando usuário' },
                { key: 'resolved', label: 'Resolvidas' },
                { key: 'all', label: 'Todas' },
              ]}
            />
            <select className="select select--sm" value={values['assigned'] ?? ''} onChange={(event) => set({ assigned: event.target.value })} aria-label="Responsável">
              <option value="">Qualquer responsável</option>
              <option value="me">Minhas</option>
              <option value="none">Sem responsável</option>
            </select>
            <select className="select select--sm" value={values['category'] ?? ''} onChange={(event) => set({ category: event.target.value })} aria-label="Categoria">
              <option value="">Todas as categorias</option>
              {Object.entries(SUPPORT_CATEGORY).map(([key, label]) => (
                <option key={key} value={key}>{label}</option>
              ))}
            </select>
            <select className="select select--sm" value={values['priority'] ?? ''} onChange={(event) => set({ priority: event.target.value })} aria-label="Prioridade">
              <option value="">Qualquer prioridade</option>
              {Object.entries(SUPPORT_PRIORITY).map(([key, info]) => (
                <option key={key} value={key}>{info.label}</option>
              ))}
            </select>
            <select className="select select--sm" value={values['platform'] ?? ''} onChange={(event) => set({ platform: event.target.value })} aria-label="Plataforma">
              <option value="">App e web</option>
              <option value="android">Só app Android</option>
              <option value="web">Só web</option>
            </select>
            <input
              className="input input--sm input--search"
              placeholder="Assunto, e-mail, #número ou texto"
              defaultValue={values['q'] ?? ''}
              onKeyDown={(event) => {
                if (event.key === 'Enter') set({ q: (event.target as HTMLInputElement).value });
              }}
            />
          </div>
          {list.isLoading ? (
            <div style={{ padding: 18 }}><Skeleton lines={6} /></div>
          ) : (list.data?.items.length ?? 0) === 0 ? (
            <Empty icon="check" title={status === 'unresolved' ? 'Nenhuma solicitação em aberto' : 'Nenhuma solicitação com esses filtros'}>
              {status === 'unresolved' && 'Quando alguém abrir uma solicitação pelo app ou pela web, ela aparece aqui.'}
            </Empty>
          ) : (
            <div>
              {list.data?.items.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} />)}
            </div>
          )}
          {list.data && <Pagination page={list.data.page} pageSize={list.data.pageSize} total={list.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} />}
        </Card>

        <div className="stack">
          <Card title="Em aberto por categoria">
            {s ? (
              s.byCategory.length === 0 ? (
                <div className="muted">Nada em aberto.</div>
              ) : (
                <HorizontalBars items={s.byCategory.map((item) => ({ label: SUPPORT_CATEGORY[item.category] ?? item.category, value: item.count }))} />
              )
            ) : (
              <Skeleton />
            )}
          </Card>
          <Card title="Como funciona">
            <div className="stack stack--tight" style={{ fontSize: 'var(--fs-supporting)' }}>
              <div>O app envia junto o modelo do aparelho, a versão do Android e do app e um diagnóstico (sessão, empresa, assinatura, sincronização). Pela web vêm o navegador, o sistema e a versão da aplicação.</div>
              <div>Ao responder, o aparelho recebe um push que abre a conversa. Sem aparelho com push — caso de quem usa só a web — o aviso vai por e-mail, e a resposta fica na conversa e na caixa de notificações.</div>
              <div>Quem não tem conta é identificado pela instalação; se criar conta depois, as solicitações passam a ser dela.</div>
              <div>Notas internas ficam só aqui e não avisam ninguém.{s?.openAiConfigured ? ' O rascunho por IA usa a chave da OpenAI configurada em Avaliações.' : ' Configure a chave da OpenAI em Avaliações para gerar rascunhos.'}</div>
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

function TicketRow({ ticket }: { ticket: Ticket }) {
  const status = SUPPORT_STATUS[ticket.status] ?? { label: ticket.status, tone: 'neutral' as const };
  const priority = SUPPORT_PRIORITY[ticket.priority];
  return (
    <Link to={`/suporte/${ticket.id}`} className="ticket-row">
      <div className="ticket-row__title">
        {ticket.unread && <span className="ticket-row__unread" aria-label="Não lida" />}
        <span className="muted" style={{ fontWeight: 500 }}>#{ticket.number}</span>
        <span className="ticket-row__subject">{ticket.subject}</span>
      </div>
      <div className="ticket-row__side">
        <PlatformBadge platform={ticket.platform} />
        {priority && ticket.priority === 'high' && <Badge tone={priority.tone}>{priority.label}</Badge>}
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="caption"><Time value={ticket.lastMessageAt} /></span>
      </div>
      <div className="ticket-row__sub">
        <span>{whoLabel(ticket)}{ticket.userId === null && ' · sem conta'}</span>
        <span>{SUPPORT_CATEGORY[ticket.category] ?? ticket.category}</span>
        {ticket.deviceSummary && <span>{ticket.deviceSummary}</span>}
        <span>{pluralize(ticket.messageCount, 'mensagem', 'mensagens')}</span>
        {ticket.assignedToEmail && <span>com {ticket.assignedToEmail}</span>}
      </div>
    </Link>
  );
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

export function TicketDetailPage() {
  const { ticketId = '' } = useParams();
  const { admin, can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [instructions, setInstructions] = useState('');
  const [dialog, setDialog] = useState<null | 'resolve' | 'reopen'>(null);
  const [resolveNote, setResolveNote] = useState('');
  const endRef = useRef<HTMLDivElement>(null);

  const queryKey = ['support', 'ticket', ticketId];
  const query = useQuery({ queryKey, queryFn: () => api.get<TicketDetail>(`/support/tickets/${ticketId}`), refetchInterval: 30_000 });
  const stats = useQuery({ queryKey: ['support', 'stats'], queryFn: () => api.get<Stats>('/support/stats') });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['support'] });
  };

  const ticket = query.data;
  const messageCount = ticket?.messages.length ?? 0;
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messageCount]);

  const send = useMutation({
    mutationFn: () => api.post<{ ticket: Ticket; message: Message }>(`/support/tickets/${ticketId}/messages`, { body: text.trim(), internal }),
    onSuccess: (result) => {
      setText('');
      if (result.message.internal) {
        toast.push('Nota interna registrada.');
      } else {
        const notify = NOTIFY_STATUS[result.message.notifyStatus ?? ''];
        toast.push(`Resposta enviada${notify ? ` · ${notify.label}` : ''}.`, notify?.tone === 'success' || notify?.tone === 'info' ? 'success' : 'default');
      }
      refresh();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const draft = useMutation({
    mutationFn: () => api.post<{ text: string; model: string }>(`/support/tickets/${ticketId}/draft`, { instructions: instructions.trim() || undefined }),
    onSuccess: (result) => {
      setText(result.text);
      setInternal(false);
      toast.push('Rascunho gerado. Revise antes de enviar.');
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const setStatus = useMutation({
    mutationFn: (input: { status: string; note?: string }) => api.post<Ticket>(`/support/tickets/${ticketId}/status`, input),
    onSuccess: (result) => {
      setDialog(null);
      setResolveNote('');
      toast.push(result.status === 'resolved' ? 'Solicitação resolvida; o usuário foi avisado.' : 'Solicitação reaberta.', 'success');
      refresh();
    },
  });

  const patch = useMutation({
    mutationFn: (input: { priority?: string; category?: string; assign?: 'me' | 'none' }) => api.patch<Ticket>(`/support/tickets/${ticketId}`, input),
    onSuccess: () => refresh(),
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (text.trim().length === 0 || send.isPending) return;
    send.mutate();
  };

  if (query.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!ticket) return <div className="page"><Notice tone="error">Solicitação não encontrada.</Notice></div>;

  const status = SUPPORT_STATUS[ticket.status] ?? { label: ticket.status, tone: 'neutral' as const, hint: '' };
  const priority = SUPPORT_PRIORITY[ticket.priority];
  const device = ticket.device as { model?: string; manufacturer?: string; osVersion?: string; sdkInt?: number; appVersionName?: string; appVersionCode?: number; locale?: string; timezone?: string };
  // Na web, `model` é o navegador e `osVersion` o sistema; no app, o aparelho e a versão do Android.
  const fromWeb = ticket.platform === 'web';
  const order = Object.keys(DIAGNOSTIC_LABEL);
  const diagnostics = Object.entries(ticket.diagnostics)
    .filter(([key]) => key !== 'workspaceId')
    .sort(([a], [b]) => (order.indexOf(a) === -1 ? 99 : order.indexOf(a)) - (order.indexOf(b) === -1 ? 99 : order.indexOf(b)));
  const mine = ticket.assignedTo !== null && ticket.assignedTo === admin?.id;

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Atendimento', to: '/suporte' }, { label: `#${ticket.number}` }]}
        title={
          <span className="row">
            <span className="muted" style={{ fontWeight: 500 }}>#{ticket.number}</span> {ticket.subject}
            <Badge tone={status.tone}>{status.label}</Badge>
            <PlatformBadge platform={ticket.platform} />
            {priority && ticket.priority !== 'normal' && <Badge tone={priority.tone}>prioridade {priority.label.toLowerCase()}</Badge>}
          </span>
        }
        subtitle={
          <>
            {SUPPORT_CATEGORY[ticket.category] ?? ticket.category} · aberta <Time value={ticket.createdAt} /> por {whoLabel(ticket)}
            {ticket.assignedToEmail && <> · com {mine ? 'você' : ticket.assignedToEmail}</>}
          </>
        }
        actions={
          can('support') && (
            <div className="row">
              {!mine && <button type="button" className="btn btn--secondary" onClick={() => patch.mutate({ assign: 'me' })} disabled={patch.isPending}>Assumir</button>}
              {mine && <button type="button" className="btn btn--ghost" onClick={() => patch.mutate({ assign: 'none' })} disabled={patch.isPending}>Liberar</button>}
              {ticket.status !== 'resolved' ? (
                <button type="button" className="btn btn--primary" onClick={() => setDialog('resolve')}><Icon name="check" /> Resolver</button>
              ) : (
                <button type="button" className="btn btn--secondary" onClick={() => setDialog('reopen')}>Reabrir</button>
              )}
            </div>
          )
        }
      />

      {ticket.status === 'resolved' && (
        <Notice tone="success" title={`Resolvida ${ticket.resolvedBy === 'user' ? 'pelo usuário' : 'pela equipe'}`}>
          {fmtDateTime(ticket.resolvedAt)}. Se o usuário escrever de novo, ela volta para a fila.
        </Notice>
      )}
      {ticket.reachableDevices === 0 && ticket.status !== 'resolved' && (
        <Notice tone="warning" title="Nenhum aparelho para avisar por push">
          {fromWeb && 'Solicitação aberta pela web, que não recebe push. '}
          {ticket.userEmail || ticket.contactEmail ? 'A resposta será avisada por e-mail.' : `Esta pessoa não deixou e-mail: ela só verá a resposta ao abrir ${fromWeb ? 'a web' : 'o app'}.`}
        </Notice>
      )}

      <div className="grid grid--2-1">
        <div className="stack">
          <Card title="Conversa" subtitle={`${pluralize(ticket.messages.length, 'mensagem', 'mensagens')} · usuário à esquerda, equipe à direita`}>
            <div className="thread">
              {ticket.messages.map((message) => <MessageBubble key={message.id} message={message} />)}
              <div ref={endRef} />
            </div>
          </Card>

          {can('support') && (
            <Card title={internal ? 'Nota interna' : 'Responder'} subtitle={internal ? 'Fica só no painel; o usuário não é avisado' : ticket.reachableDevices > 0 ? 'O aparelho recebe um push com o começo da resposta' : 'Sem aparelho com push: a resposta fica na conversa e o aviso vai por e-mail, se houver'}>
              <form onSubmit={submit} className="stack stack--tight">
                <textarea
                  className="textarea"
                  rows={6}
                  maxLength={REPLY_MAX}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                  placeholder={internal ? 'Ex.: cliente usa a versão 24; pedir para atualizar antes de investigar.' : 'Escreva a resposta ou gere um rascunho com a IA…'}
                  onKeyDown={(event) => {
                    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') submit(event);
                  }}
                />
                <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap', gap: 10 }}>
                  <div className="row" style={{ flexWrap: 'wrap' }}>
                    <label className="checkbox">
                      <input type="checkbox" checked={internal} onChange={(event) => setInternal(event.target.checked)} /> Nota interna
                    </label>
                    {stats.data?.openAiConfigured && !internal && (
                      <>
                        <input
                          className="input input--sm"
                          style={{ width: 260 }}
                          placeholder="Orientação para a IA (opcional)"
                          value={instructions}
                          onChange={(event) => setInstructions(event.target.value)}
                          maxLength={500}
                        />
                        <button type="button" className="btn btn--ghost btn--sm" onClick={() => draft.mutate()} disabled={draft.isPending}>
                          <Icon name="sparkle" /> {draft.isPending ? 'Gerando…' : 'Gerar rascunho com IA'}
                        </button>
                      </>
                    )}
                  </div>
                  <div className="row">
                    <span className="caption">{fmtNumber(text.length)}/{fmtNumber(REPLY_MAX)}</span>
                    <button type="submit" className={`btn ${internal ? 'btn--secondary' : 'btn--primary'}`} disabled={send.isPending || text.trim().length === 0}>
                      <Icon name={internal ? 'note' : 'send'} /> {send.isPending ? 'Enviando…' : internal ? 'Guardar nota' : 'Enviar resposta'}
                    </button>
                  </div>
                </div>
              </form>
            </Card>
          )}
        </div>

        <div className="stack">
          <Card title="Quem">
            {ticket.user ? (
              <KeyValue
                items={[
                  { label: 'Conta', value: <Link to={`/usuarios/${ticket.user.id}`}>{ticket.user.name || ticket.user.email}</Link> },
                  { label: 'E-mail', value: ticket.user.email },
                  { label: 'Situação', value: <Badge tone={USER_STATUS[ticket.user.status]?.tone ?? 'neutral'}>{USER_STATUS[ticket.user.status]?.label ?? ticket.user.status}</Badge> },
                  { label: 'Cliente desde', value: ticket.user.createdAt ? fmtRelative(ticket.user.createdAt) : '—' },
                  {
                    label: 'Empresas',
                    value:
                      ticket.user.workspaces.length === 0 ? (
                        <span className="muted">nenhuma</span>
                      ) : (
                        <div className="stack stack--tight">
                          {ticket.user.workspaces.map((workspace) => (
                            <div key={workspace.id} className="row" style={{ flexWrap: 'wrap' }}>
                              <Link to={`/empresas/${workspace.id}`}>{workspace.name}</Link>
                              <span className="caption">{ROLE_LABEL[workspace.role] ?? workspace.role}</span>
                              {workspace.state ? (
                                <Badge tone={SUBSCRIPTION_STATE[workspace.state]?.tone ?? 'neutral'}>{PLAN_LABEL[workspace.plan ?? ''] ?? workspace.plan} · {SUBSCRIPTION_STATE[workspace.state]?.label ?? workspace.state}</Badge>
                              ) : (
                                <Badge>sem assinatura</Badge>
                              )}
                            </div>
                          ))}
                        </div>
                      ),
                  },
                  { label: 'Outras solicitações', value: fmtNumber(ticket.otherTickets) },
                ]}
              />
            ) : (
              <KeyValue
                items={[
                  { label: 'Conta', value: <Badge tone="warning">sem conta</Badge> },
                  { label: 'Nome', value: ticket.contactName ?? <span className="muted">não informado</span> },
                  { label: 'E-mail para contato', value: ticket.contactEmail ?? <span className="muted">não informado</span> },
                  { label: 'Instalação', value: <CopyId id={ticket.installId} /> },
                  { label: 'Outras solicitações', value: fmtNumber(ticket.otherTickets) },
                ]}
              />
            )}
          </Card>

          <Card title={fromWeb ? 'Navegador' : 'Aparelho'}>
            <KeyValue
              items={[
                { label: 'Plataforma', value: <PlatformBadge platform={ticket.platform} /> },
                { label: fromWeb ? 'Navegador' : 'Modelo', value: [device.manufacturer, device.model].filter(Boolean).join(' ') || '—' },
                { label: fromWeb ? 'Sistema' : 'Android', value: device.osVersion ? `${device.osVersion}${device.sdkInt ? ` (API ${device.sdkInt})` : ''}` : '—' },
                { label: fromWeb ? 'Versão da web' : 'Versão do app', value: device.appVersionName ? `${device.appVersionName}${device.appVersionCode ? ` (${device.appVersionCode})` : ''}` : '—' },
                { label: 'Idioma / fuso', value: [device.locale, device.timezone].filter(Boolean).join(' · ') || '—' },
                {
                  label: 'Push',
                  value:
                    ticket.reachableDevices > 0 ? (
                      <Badge tone={ticket.mutedDevices >= ticket.reachableDevices ? 'warning' : 'success'}>
                        {pluralize(ticket.reachableDevices, 'aparelho', 'aparelhos')}{ticket.mutedDevices > 0 ? ` · ${ticket.mutedDevices} sem permissão` : ''}
                      </Badge>
                    ) : (
                      <Badge tone="warning">nenhum aparelho registrado</Badge>
                    ),
                },
              ]}
            />
          </Card>

          <Card title="Diagnóstico" subtitle={`Estado ${fromWeb ? 'da web' : 'do app'} no momento da abertura`}>
            {diagnostics.length === 0 ? (
              <div className="muted">{fromWeb ? 'A web' : 'O app'} não enviou diagnóstico.</div>
            ) : (
              <KeyValue items={diagnostics.map(([key, value]) => ({ label: DIAGNOSTIC_LABEL[key] ?? key, value: formatDiagnostic(key, value) }))} />
            )}
            {ticket.workspaceName && <div className="caption" style={{ marginTop: 10 }}>Empresa no momento: <Link to={`/empresas/${ticket.workspaceId}`}>{ticket.workspaceName}</Link></div>}
          </Card>

          {can('support') && (
            <Card title="Classificação">
              <div className="form-grid">
                <label className="field">
                  <span className="field__label">Prioridade</span>
                  <select className="select" value={ticket.priority} onChange={(event) => patch.mutate({ priority: event.target.value })} disabled={patch.isPending}>
                    {Object.entries(SUPPORT_PRIORITY).map(([key, info]) => (
                      <option key={key} value={key}>{info.label}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">Categoria</span>
                  <select className="select" value={ticket.category} onChange={(event) => patch.mutate({ category: event.target.value })} disabled={patch.isPending}>
                    {Object.entries(SUPPORT_CATEGORY).map(([key, label]) => (
                      <option key={key} value={key}>{label}</option>
                    ))}
                  </select>
                </label>
              </div>
              <KeyValue
                items={[
                  { label: 'Responsável', value: ticket.assignedToEmail ?? <span className="muted">ninguém</span> },
                  { label: '1ª resposta', value: ticket.firstResponseAt ? fmtDateTime(ticket.firstResponseAt) : <span className="muted">ainda não</span> },
                  { label: 'Última mensagem', value: <>{fmtDateTime(ticket.lastMessageAt)} · {ticket.lastMessageBy === 'user' ? 'usuário' : ticket.lastMessageBy === 'admin' ? 'equipe' : 'sistema'}</> },
                  { label: 'Identificador', value: <CopyId id={ticket.id} /> },
                ]}
              />
            </Card>
          )}
        </div>
      </div>

      <ConfirmDialog
        open={dialog === 'resolve'}
        onClose={() => setDialog(null)}
        title="Resolver esta solicitação?"
        description="O usuário recebe um push avisando que foi encerrada. Se ele escrever de novo, ela reabre sozinha."
        confirmLabel="Resolver"
        requireReason={false}
        onConfirm={async () => {
          await setStatus.mutateAsync({ status: 'resolved', note: resolveNote.trim() || undefined });
        }}
      >
        <label className="field">
          <span className="field__label">Observação para o usuário (opcional)</span>
          <textarea className="textarea" value={resolveNote} onChange={(event) => setResolveNote(event.target.value)} maxLength={500} rows={3} placeholder="Ex.: corrigido na versão 26, já disponível na Play Store." />
          <span className="field__hint">Vai no push e na conversa, como mensagem do sistema.</span>
        </label>
      </ConfirmDialog>
      <ConfirmDialog
        open={dialog === 'reopen'}
        onClose={() => setDialog(null)}
        title="Reabrir esta solicitação?"
        description="Ela volta para a fila como aguardando equipe."
        confirmLabel="Reabrir"
        requireReason={false}
        onConfirm={async () => {
          await setStatus.mutateAsync({ status: 'open' });
        }}
      />
    </div>
  );
}

const DIAGNOSTIC_LABEL: Record<string, string> = {
  path: 'Tela em que estava (web)',
  workspaceId: 'Empresa (id)',
  signedIn: 'Com sessão',
  email: 'E-mail da sessão',
  workspaceName: 'Empresa',
  role: 'Papel na empresa',
  subscriptionState: 'Assinatura',
  planKey: 'Plano',
  isPro: 'Versão PRO antiga',
  canSync: 'Sincronização liberada',
  lastSyncAt: 'Última sincronização',
  lastSyncError: 'Último erro de sincronização',
  pendingOperations: 'Operações pendentes',
  failedOperations: 'Operações com falha',
  pendingConflicts: 'Conflitos pendentes',
  products: 'Produtos',
  movements: 'Movimentações',
  notificationsEnabled: 'Notificações permitidas',
  initialUploadDone: 'Carga inicial concluída',
};

function formatDiagnostic(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (key === 'subscriptionState' && typeof value === 'string') return SUBSCRIPTION_STATE[value]?.label ?? value;
  if (key === 'planKey' && typeof value === 'string') return PLAN_LABEL[value] ?? value;
  if (key === 'role' && typeof value === 'string') return ROLE_LABEL[value] ?? value;
  if (/At$/.test(key) && typeof value === 'number' && value > 0) return fmtDateTime(new Date(value));
  if (/At$/.test(key) && typeof value === 'string') return fmtDateTime(value);
  if (typeof value === 'number') return fmtNumber(value);
  return String(value);
}

function MessageBubble({ message }: { message: Message }) {
  if (message.author === 'system') {
    return <div className="msg msg--system">{message.body} · {fmtRelative(message.createdAt)}</div>;
  }
  const cls = message.author === 'user' ? 'msg--user' : message.internal ? 'msg--internal' : 'msg--admin';
  const notify = message.notifyStatus ? NOTIFY_STATUS[message.notifyStatus] : null;
  return (
    <div className={`msg ${cls}`}>
      <div className="msg__meta">
        <span className="strong" style={{ color: 'var(--text)' }}>{message.author === 'user' ? 'Usuário' : message.adminName ?? 'Equipe'}</span>
        {message.internal && <Badge tone="warning" plain>nota interna</Badge>}
        <Time value={message.createdAt} />
      </div>
      {message.body}
      {notify && !message.internal && (
        <div className="msg__foot" title={message.notifyDetail ?? undefined}>
          <Badge tone={notify.tone} plain>{notify.label}</Badge>
          {message.notifyDetail && <span> · {message.notifyDetail}</span>}
        </div>
      )}
    </div>
  );
}
