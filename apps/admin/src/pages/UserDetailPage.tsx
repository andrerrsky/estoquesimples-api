import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { NotesPanel } from '../components/Notes';
import { EventsPanel, TimelinePanel } from '../components/Timeline';
import {
  ActionMenu,
  Badge,
  Card,
  ConfirmDialog,
  CopyId,
  Empty,
  errorMessage,
  KeyValue,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  PlatformBadge,
  PlatformBadges,
  ProviderBadge,
  Skeleton,
  StatTile,
  Tabs,
  Time,
  useToast,
} from '../components/ui';
import { fmtNumber } from '../lib/format';
import { MEMBER_STATUS, NOTIFICATION_TYPE, PLAN_LABEL, PLATFORM_LABEL, ROLE_LABEL, SUBSCRIPTION_STATE, USER_STATUS } from '../lib/labels';

interface UserDetail {
  id: string;
  email: string;
  name: string;
  status: string;
  emailVerified: boolean;
  emailVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletionRequestedAt: string | null;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  permissionVersion: number;
  lastActivityAt: string | null;
  /** Plataformas com aparelho (ou navegador) não revogado. */
  platforms: string[];
  workspaces: Array<{ id: string; name: string; role: string; memberStatus: string; isOwner: boolean; joinedAt: string; subscriptionState: string | null; subscriptionProvider: string | null; planKey: string | null; deletedAt: string | null }>;
  devices: Array<{ id: string; installId: string; platform: string; model: string | null; osVersion: string | null; appVersionName: string | null; appVersionCode: number | null; lastSeenAt: string; createdAt: string; revokedAt: string | null }>;
  sessions: Array<{ id: string; deviceId: string | null; deviceModel: string | null; platform: string | null; ipAddress: string | null; userAgent: string | null; createdAt: string; lastUsedAt: string; expiresAt: string }>;
  purchasedSubscriptions: Array<{ id: string; workspaceId: string; workspaceName: string; planKey: string; provider: string; state: string; startedAt: string | null; currentPeriodEnd: string | null }>;
  counts: { auditEvents30d: number; analyticsEvents30d: number; loginFailures7d: number };
}

type Tab = 'resumo' | 'empresas' | 'aparelhos' | 'assinaturas' | 'avisos' | 'eventos' | 'historico' | 'notas';

interface NotificationRow {
  id: string;
  type: string;
  title: string;
  body: string;
  workspaceId: string | null;
  workspaceName: string | null;
  readAt: string | null;
  createdAt: string;
}
type Dialog = null | 'suspend' | 'reactivate' | 'verify' | 'revoke' | 'cancelDeletion' | 'edit' | { device: string };

export function UserDetailPage() {
  const { userId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('resumo');
  const [dialog, setDialog] = useState<Dialog>(null);

  const queryKey = ['user', userId];
  const query = useQuery({ queryKey, queryFn: () => api.get<UserDetail>(`/users/${userId}`) });
  const user = query.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['users'] });
  };

  const simple = useMutation({
    mutationFn: ({ path, body }: { path: string; body?: unknown }) => api.post<{ message: string }>(`/users/${userId}/${path}`, body),
    onSuccess: (result) => {
      toast.push(result.message, 'success');
      refresh();
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const act = (path: string) => async (reason: string) => {
    const result = await api.post<{ message: string }>(`/users/${userId}/${path}`, { reason });
    toast.push(result.message, 'success');
    refresh();
  };

  if (query.isLoading) {
    return (
      <div className="page">
        <Skeleton lines={8} />
      </div>
    );
  }
  if (!user) {
    return (
      <div className="page">
        <Notice tone="error">Conta não encontrada.</Notice>
      </div>
    );
  }

  const locked = user.lockedUntil && new Date(user.lockedUntil) > new Date();
  const status = USER_STATUS[user.status];

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Usuários', to: '/usuarios' }, { label: user.name }]}
        title={
          <span className="row">
            {user.name}
            <Badge tone={status?.tone}>{status?.label ?? user.status}</Badge>
            {!user.emailVerified && <Badge tone="warning">e-mail não confirmado</Badge>}
            {locked && <Badge tone="error">login bloqueado</Badge>}
          </span>
        }
        subtitle={
          <span className="row">
            {user.email} · <CopyId id={user.id} /> · <PlatformBadges platforms={user.platforms} empty="sem aparelho registrado" />
          </span>
        }
        actions={
          can('support') && (
            <ActionMenu
              items={[
                { label: 'Editar nome ou e-mail', icon: 'edit', onClick: () => setDialog('edit') },
                { label: 'Enviar redefinição de senha', icon: 'mail', onClick: () => simple.mutate({ path: 'send-password-reset' }) },
                { label: 'Confirmar e-mail manualmente', icon: 'check', disabled: user.emailVerified, onClick: () => setDialog('verify') },
                { label: 'Remover bloqueio de login', icon: 'unlock', disabled: !locked, onClick: () => simple.mutate({ path: 'unlock' }) },
                'sep',
                { label: 'Encerrar todas as sessões', icon: 'logout', onClick: () => setDialog('revoke') },
                user.status === 'suspended'
                  ? { label: 'Reativar conta', icon: 'play', onClick: () => setDialog('reactivate') }
                  : { label: 'Suspender conta', icon: 'pause', danger: true, disabled: user.status === 'pending_deletion', onClick: () => setDialog('suspend') },
                ...(user.status === 'pending_deletion'
                  ? [{ label: 'Cancelar exclusão da conta', icon: 'refresh' as const, onClick: () => setDialog('cancelDeletion') }]
                  : []),
              ]}
            />
          )
        }
      />

      {user.status === 'pending_deletion' && (
        <Notice tone="warning" title="Exclusão solicitada pelo próprio usuário">
          Pedida em <Time value={user.deletionRequestedAt} relative={false} />. As sessões foram encerradas e a conta não entra mais. Ainda não existe rotina que apague os dados definitivamente; cancelar reativa a conta.
        </Notice>
      )}
      {user.counts.loginFailures7d >= 5 && (
        <Notice tone="warning" title="Muitas falhas de login">
          {fmtNumber(user.counts.loginFailures7d)} tentativas com senha errada nos últimos 7 dias. Pode ser o cliente sem lembrar a senha, ou alguém tentando entrar.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Empresas" value={fmtNumber(user.workspaces.filter((w) => w.memberStatus !== 'removed' && !w.deletedAt).length)} foot={`${user.workspaces.filter((w) => w.isOwner).length} como proprietário`} />
        <StatTile
          label="Aparelhos"
          value={fmtNumber(user.devices.filter((d) => !d.revokedAt).length)}
          foot={`${user.platforms.length > 0 ? `${user.platforms.map((platform) => PLATFORM_LABEL[platform] ?? platform).join(' + ')} · ` : ''}${user.sessions.length} sessão(ões) ativa(s)`}
          hint="O navegador da versão web também conta como aparelho."
        />
        <StatTile label="Última atividade" value={<Time value={user.lastActivityAt} />} foot={<>conta criada <Time value={user.createdAt} /></>} />
        <StatTile label="Eventos (30d)" value={fmtNumber(user.counts.analyticsEvents30d)} foot={`${fmtNumber(user.counts.auditEvents30d)} ações auditadas`} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'resumo', label: 'Resumo' },
          { key: 'empresas', label: 'Empresas', count: user.workspaces.length },
          { key: 'aparelhos', label: 'Aparelhos e sessões', count: user.devices.length },
          { key: 'assinaturas', label: 'Compras', count: user.purchasedSubscriptions.length },
          { key: 'avisos', label: 'Notificações' },
          { key: 'eventos', label: 'Eventos' },
          { key: 'historico', label: 'Histórico' },
          { key: 'notas', label: 'Notas' },
        ]}
      />

      {tab === 'resumo' && (
        <div className="grid grid--2">
          <Card title="Conta">
            <KeyValue
              items={[
                { label: 'Nome', value: user.name },
                { label: 'E-mail', value: user.email },
                { label: 'E-mail confirmado', value: user.emailVerifiedAt ? <Time value={user.emailVerifiedAt} relative={false} /> : <Badge tone="warning">pendente</Badge> },
                { label: 'Situação', value: <Badge tone={status?.tone}>{status?.label ?? user.status}</Badge> },
                { label: 'Criada em', value: <Time value={user.createdAt} relative={false} /> },
                { label: 'Atualizada em', value: <Time value={user.updatedAt} relative={false} /> },
                { label: 'Identificador', value: <CopyId id={user.id} /> },
              ]}
            />
          </Card>
          <Card title="Segurança">
            <KeyValue
              items={[
                { label: 'Falhas de login (7d)', value: fmtNumber(user.counts.loginFailures7d) },
                { label: 'Tentativas acumuladas', value: fmtNumber(user.failedLoginAttempts) },
                { label: 'Bloqueio até', value: locked ? <Time value={user.lockedUntil} relative={false} /> : <span className="muted">sem bloqueio</span> },
                { label: 'Sessões ativas', value: fmtNumber(user.sessions.length) },
                { label: 'Versão de permissão', value: <span title="Incrementada a cada mudança de senha ou papel; tokens antigos são recusados.">{user.permissionVersion}</span> },
              ]}
            />
          </Card>
          <Card title="Empresas" actions={<button type="button" className="btn btn--link small" onClick={() => setTab('empresas')}>ver tudo</button>}>
            <WorkspacesList user={user} compact />
          </Card>
          <Card title="Aparelhos">
            <DevicesList user={user} compact />
          </Card>
        </div>
      )}

      {tab === 'empresas' && (
        <Card>
          <WorkspacesList user={user} />
        </Card>
      )}

      {tab === 'aparelhos' && (
        <div className="stack">
          <Card title="Aparelhos" subtitle="Instalações do app e navegadores da web que já entraram com esta conta">
            <DevicesList user={user} onRevoke={can('support') ? (device) => setDialog({ device }) : undefined} />
          </Card>
          <Card title="Sessões ativas" subtitle="Cada login abre uma sessão; o token de acesso expira em minutos e é renovado por ela">
            {user.sessions.length === 0 ? (
              <Empty icon="lock" title="Nenhuma sessão ativa" />
            ) : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead>
                    <tr>
                      <th>Aparelho</th>
                      <th>Plataforma</th>
                      <th>IP</th>
                      <th>Cliente</th>
                      <th>Início</th>
                      <th>Último uso</th>
                      <th>Expira</th>
                    </tr>
                  </thead>
                  <tbody>
                    {user.sessions.map((session) => (
                      <tr key={session.id}>
                        <td>{session.deviceModel ?? <span className="muted">—</span>}</td>
                        <td>{session.platform ? <PlatformBadge platform={session.platform} /> : <span className="muted" title="Login feito sem informar o aparelho.">não informada</span>}</td>
                        <td className="mono">{session.ipAddress ?? '—'}</td>
                        <td className="muted" title={session.userAgent ?? ''}>{session.userAgent ? session.userAgent.slice(0, 40) : '—'}</td>
                        <td><Time value={session.createdAt} /></td>
                        <td><Time value={session.lastUsedAt} /></td>
                        <td><Time value={session.expiresAt} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'assinaturas' && (
        <Card title="Compras feitas por esta conta" subtitle="A assinatura pertence à empresa; aqui aparece o que esta pessoa comprou no app (Google Play) ou contratou na web (Asaas)">
          {user.purchasedSubscriptions.length === 0 ? (
            <Empty icon="card" title="Nenhuma compra" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Empresa</th>
                    <th>Origem</th>
                    <th>Plano</th>
                    <th>Estado</th>
                    <th>Início</th>
                    <th>Fim do período</th>
                  </tr>
                </thead>
                <tbody>
                  {user.purchasedSubscriptions.map((sub) => (
                    <tr key={sub.id}>
                      <td><Link to={`/assinaturas/${sub.id}`}>{sub.workspaceName}</Link></td>
                      <td><ProviderBadge provider={sub.provider} /></td>
                      <td>{PLAN_LABEL[sub.planKey] ?? sub.planKey}</td>
                      <td><Badge tone={SUBSCRIPTION_STATE[sub.state]?.tone}>{SUBSCRIPTION_STATE[sub.state]?.label ?? sub.state}</Badge></td>
                      <td><Time value={sub.startedAt} relative={false} /></td>
                      <td><Time value={sub.currentPeriodEnd} relative={false} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'avisos' && (
        <Card title="Caixa de notificações" subtitle="O que esta conta recebeu: a mesma caixa aparece na web e vira push no app Android">
          <NotificationsPanel userId={userId} />
        </Card>
      )}

      {tab === 'eventos' && (
        <Card title="Eventos de uso" subtitle="O que esta conta fez no app e na web, e o que a API registrou">
          <EventsPanel path={`/users/${userId}/events`} queryKey={queryKey} />
        </Card>
      )}

      {tab === 'historico' && (
        <Card title="Histórico" subtitle="Auditoria da conta e ações do suporte sobre ela, mais recentes primeiro">
          <TimelinePanel path={`/users/${userId}/timeline`} queryKey={queryKey} />
        </Card>
      )}

      {tab === 'notas' && (
        <Card title="Notas de suporte">
          <NotesPanel path={`/users/${userId}/notes`} queryKey={queryKey} />
        </Card>
      )}

      <ConfirmDialog
        open={dialog === 'suspend'}
        onClose={() => setDialog(null)}
        title="Suspender conta"
        description="A pessoa perde o acesso imediatamente em todos os aparelhos. Os dados locais no celular não são afetados. Pode ser revertido."
        confirmLabel="Suspender"
        danger
        onConfirm={act('suspend')}
      />
      <ConfirmDialog open={dialog === 'reactivate'} onClose={() => setDialog(null)} title="Reativar conta" description="A pessoa volta a poder entrar com a senha atual." confirmLabel="Reativar" onConfirm={act('reactivate')} />
      <ConfirmDialog
        open={dialog === 'verify'}
        onClose={() => setDialog(null)}
        title="Confirmar e-mail manualmente"
        description="Use apenas se você verificou por outro canal que o endereço pertence a esta pessoa. Libera convites e outras ações que exigem e-mail confirmado."
        confirmLabel="Confirmar e-mail"
        onConfirm={act('verify-email')}
      />
      <ConfirmDialog
        open={dialog === 'revoke'}
        onClose={() => setDialog(null)}
        title="Encerrar todas as sessões"
        description="Todos os aparelhos precisarão fazer login de novo. Útil quando o cliente perdeu um aparelho ou suspeita de acesso indevido."
        confirmLabel="Encerrar sessões"
        onConfirm={act('revoke-sessions')}
      />
      <ConfirmDialog
        open={dialog === 'cancelDeletion'}
        onClose={() => setDialog(null)}
        title="Cancelar exclusão da conta"
        description="A conta volta a ficar ativa. Faça isso apenas a pedido da própria pessoa."
        confirmLabel="Cancelar exclusão"
        onConfirm={act('cancel-deletion')}
      />
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog !== null}
        onClose={() => setDialog(null)}
        title="Revogar aparelho"
        description="As sessões deste aparelho são encerradas. Ele pode entrar de novo com a senha."
        confirmLabel="Revogar"
        danger
        onConfirm={async (reason) => {
          if (typeof dialog === 'object' && dialog) {
            const result = await api.post<{ message: string }>(`/users/${userId}/devices/${dialog.device}/revoke`, { reason });
            toast.push(result.message, 'success');
            refresh();
          }
        }}
      />
      <EditUserDialog open={dialog === 'edit'} onClose={() => setDialog(null)} user={user} onSaved={refresh} />
    </div>
  );
}

function WorkspacesList({ user, compact }: { user: UserDetail; compact?: boolean }) {
  const rows = compact ? user.workspaces.filter((w) => w.memberStatus !== 'removed').slice(0, 5) : user.workspaces;
  if (rows.length === 0) return <Empty icon="building" title="Não participa de nenhuma empresa" />;
  return (
    <div className="list">
      {rows.map((workspace) => (
        <div key={workspace.id} className="list__item">
          <div className="list__main">
            <div className="list__title">
              <Link to={`/empresas/${workspace.id}`}>{workspace.name}</Link>
              {workspace.deletedAt && <Badge tone="error"> excluída</Badge>}
            </div>
            <div className="list__sub">
              {ROLE_LABEL[workspace.role] ?? workspace.role}
              {workspace.isOwner && ' · dono'} · desde <Time value={workspace.joinedAt} />
            </div>
          </div>
          {workspace.memberStatus !== 'active' && <Badge tone={MEMBER_STATUS[workspace.memberStatus]?.tone}>{MEMBER_STATUS[workspace.memberStatus]?.label}</Badge>}
          {workspace.subscriptionState ? (
            <>
              <ProviderBadge provider={workspace.subscriptionProvider} short />
              <Badge tone={SUBSCRIPTION_STATE[workspace.subscriptionState]?.tone}>{SUBSCRIPTION_STATE[workspace.subscriptionState]?.label ?? workspace.subscriptionState}</Badge>
            </>
          ) : (
            <span className="list__meta">sem assinatura</span>
          )}
        </div>
      ))}
    </div>
  );
}

function DevicesList({ user, compact, onRevoke }: { user: UserDetail; compact?: boolean; onRevoke?: (deviceId: string) => void }) {
  const rows = compact ? user.devices.filter((d) => !d.revokedAt).slice(0, 4) : user.devices;
  if (rows.length === 0) return <Empty icon="phone" title="Nenhum aparelho registrado" />;
  return (
    <div className="list">
      {rows.map((device) => (
        <div key={device.id} className="list__item">
          <div className="timeline__dot"><Icon name="phone" /></div>
          <div className="list__main">
            <div className="list__title">
              {device.model ?? (device.platform === 'web' ? 'Navegador' : PLATFORM_LABEL[device.platform] ?? device.platform)}
              {device.revokedAt && <Badge tone="error"> revogado</Badge>}
            </div>
            <div className="list__sub">
              {device.osVersion ? (device.platform === 'android' ? `Android ${device.osVersion}` : device.osVersion) : PLATFORM_LABEL[device.platform] ?? device.platform}
              {device.appVersionName && ` · app ${device.appVersionName}`}
              {device.appVersionCode !== null && ` (${device.appVersionCode})`} · visto <Time value={device.lastSeenAt} />
            </div>
          </div>
          <PlatformBadge platform={device.platform} />
          {onRevoke && !device.revokedAt && (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onRevoke(device.id)}>
              Revogar
            </button>
          )}
        </div>
      ))}
    </div>
  );
}

/** Caixa de notificações da conta, somente leitura: responde "o cliente foi avisado?". */
function NotificationsPanel({ userId }: { userId: string }) {
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['user', userId, 'notifications', page],
    queryFn: () => api.get<Paginated<NotificationRow> & { unread: number }>(`/users/${userId}/notifications`, { page, pageSize: 25 }),
    placeholderData: (previous) => previous,
  });
  if (query.isLoading) return <Skeleton lines={5} />;
  const items = query.data?.items ?? [];
  if (items.length === 0) {
    return (
      <Empty icon="mail" title="Nenhuma notificação">
        Avisos de pagamento, respostas do suporte e campanhas aparecem aqui quando a conta os recebe.
      </Empty>
    );
  }
  return (
    <div>
      <div className="caption" style={{ marginBottom: 8 }}>
        {fmtNumber(query.data?.total ?? 0)} no total · {fmtNumber(query.data?.unread ?? 0)} não lida(s)
      </div>
      <div className="list">
        {items.map((item) => {
          const type = NOTIFICATION_TYPE[item.type];
          return (
            <div key={item.id} className="list__item" style={{ alignItems: 'flex-start' }}>
              <div className="list__main">
                <div className="list__title">{item.title}</div>
                {item.body && <div className="list__sub">{item.body}</div>}
                <div className="list__sub">
                  <Time value={item.createdAt} relative={false} />
                  {item.workspaceName && <> · <Link to={`/empresas/${item.workspaceId}`}>{item.workspaceName}</Link></>}
                </div>
              </div>
              <Badge tone={type?.tone ?? 'neutral'} plain>{type?.label ?? item.type}</Badge>
              {item.readAt ? <span className="list__meta" title={`Lida em ${new Date(item.readAt).toLocaleString('pt-BR')}`}>lida</span> : <Badge tone="warning">não lida</Badge>}
            </div>
          );
        })}
      </div>
      {query.data && query.data.total > query.data.pageSize && (
        <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />
      )}
    </div>
  );
}

function EditUserDialog({ open, onClose, user, onSaved }: { open: boolean; onClose: () => void; user: UserDetail; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(user.name);
  const [email, setEmail] = useState(user.email);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body: Record<string, string> = { reason };
      if (name.trim() !== user.name) body['name'] = name.trim();
      if (email.trim().toLowerCase() !== user.email) body['email'] = email.trim().toLowerCase();
      const result = await api.patch<{ message: string }>(`/users/${user.id}`, body);
      toast.push(result.message, 'success');
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Editar conta" description="Trocar o e-mail invalida a confirmação anterior; confirme manualmente depois se tiver verificado por outro canal.">
      <form onSubmit={submit} className="stack">
        <label className="field">
          <span className="field__label">Nome</span>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required />
        </label>
        <label className="field">
          <span className="field__label">E-mail</span>
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
        </label>
        <label className="field">
          <span className="field__label">Motivo</span>
          <textarea className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={500} required />
        </label>
        {error && <div className="field__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || reason.trim().length < 3}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}
