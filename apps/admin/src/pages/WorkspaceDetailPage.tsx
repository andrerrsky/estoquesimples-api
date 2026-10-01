import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { NotesPanel } from '../components/Notes';
import { TimelinePanel } from '../components/Timeline';
import {
  ActionMenu,
  Badge,
  Card,
  ConfirmDialog,
  CopyId,
  Empty,
  errorMessage,
  Json,
  KeyValue,
  Modal,
  Notice,
  PageHeader,
  Pagination,
  Skeleton,
  StatTile,
  Tabs,
  Time,
  useToast,
} from '../components/ui';
import { fmtCurrency, fmtDecimal, fmtNumber } from '../lib/format';
import { CONFLICT_STATUS, MEMBER_STATUS, MOVEMENT_TYPE, PLAN_LABEL, ROLE_LABEL, ROLE_OPTIONS, SUBSCRIPTION_STATE, USER_STATUS } from '../lib/labels';

interface WorkspaceDetail {
  id: string;
  name: string;
  settings: Record<string, unknown>;
  changeSeq: number;
  tombstoneHorizonSeq: number;
  seededAt: string | null;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  owner: { id: string; email: string; name: string; status: string } | null;
  members: Array<{ id: string; userId: string; email: string; name: string; userStatus: string; role: string; status: string; joinedAt: string; removedAt: string | null }>;
  pendingInvites: Array<{ id: string; email: string; roleKey: string; expiresAt: string; createdAt: string; expired: boolean }>;
  subscriptions: Array<{ id: string; planKey: string; state: string; autoRenewing: boolean; acknowledged: boolean; startedAt: string | null; currentPeriodEnd: string | null; graceUntil: string | null; canceledAt: string | null; lastVerifiedAt: string; purchaserUserId: string | null; purchaserEmail: string | null; productId: string; basePlanId: string | null; createdAt: string }>;
  counts: { products: number; productsDeleted: number; movements: number; movements30d: number; conflictsPending: number; conflictsTotal: number; syncOps7d: number; lowStock: number };
  syncDevices: Array<{ deviceId: string; userId: string | null; userEmail: string | null; model: string | null; appVersionName: string | null; cursor: number; lag: number; lastPushAt: string | null; lastPullAt: string | null; updatedAt: string }>;
  initialUploads: Array<{ id: string; status: string; declaredProducts: number; declaredMovements: number; receivedProducts: number; receivedMovements: number; createdAt: string; completedAt: string | null }>;
}

type Tab = 'resumo' | 'membros' | 'assinatura' | 'estoque' | 'sync' | 'historico' | 'notas';
type Dialog =
  | null
  | 'rename'
  | 'delete'
  | 'restore'
  | 'transfer'
  | { kind: 'role'; userId: string; current: string }
  | { kind: 'status'; userId: string; status: 'active' | 'suspended' }
  | { kind: 'remove'; userId: string }
  | { kind: 'invite'; inviteId: string };

export function WorkspaceDetailPage() {
  const { workspaceId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<Tab>('resumo');
  const [dialog, setDialog] = useState<Dialog>(null);

  const queryKey = ['workspace', workspaceId];
  const query = useQuery({ queryKey, queryFn: () => api.get<WorkspaceDetail>(`/workspaces/${workspaceId}`) });
  const ws = query.data;

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
  };

  const post = (path: string, extra: Record<string, unknown> = {}) => async (reason: string) => {
    const result = await api.post<{ message: string }>(`/workspaces/${workspaceId}/${path}`, { reason, ...extra });
    toast.push(result.message, 'success');
    refresh();
  };
  const put = (path: string, extra: Record<string, unknown> = {}) => async (reason: string) => {
    const result = await api.put<{ message: string }>(`/workspaces/${workspaceId}/${path}`, { reason, ...extra });
    toast.push(result.message, 'success');
    refresh();
  };

  if (query.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!ws) return <div className="page"><Notice tone="error">Empresa não encontrada.</Notice></div>;

  const live = ws.subscriptions.find((sub) => ['pendente', 'ativa', 'carencia', 'suspensa', 'cancelada_mas_ativa'].includes(sub.state));
  const activeMembers = ws.members.filter((member) => member.status !== 'removed');
  const staleDevices = ws.syncDevices.filter((device) => device.lag > 0);

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Empresas', to: '/empresas' }, { label: ws.name }]}
        title={
          <span className="row">
            {ws.name}
            {ws.deletedAt && <Badge tone="error">excluída</Badge>}
            {live ? <Badge tone={SUBSCRIPTION_STATE[live.state]?.tone}>{SUBSCRIPTION_STATE[live.state]?.label}</Badge> : <Badge>sem assinatura</Badge>}
          </span>
        }
        subtitle={
          <span className="row">
            dono: {ws.owner ? <Link to={`/usuarios/${ws.owner.id}`}>{ws.owner.email}</Link> : '—'} · <CopyId id={ws.id} />
          </span>
        }
        actions={
          can('support') && (
            <ActionMenu
              items={[
                { label: 'Renomear empresa', icon: 'edit', onClick: () => setDialog('rename') },
                { label: 'Transferir propriedade', icon: 'users', disabled: activeMembers.length < 2, onClick: () => setDialog('transfer') },
                'sep',
                ws.deletedAt
                  ? { label: 'Restaurar empresa', icon: 'refresh', onClick: () => setDialog('restore') }
                  : { label: 'Excluir empresa', icon: 'trash', danger: true, onClick: () => setDialog('delete') },
              ]}
            />
          )
        }
      />

      {ws.deletedAt && (
        <Notice tone="error" title="Empresa excluída">
          Excluída em <Time value={ws.deletedAt} relative={false} />. Os membros não têm mais acesso; os dados continuam no banco e podem ser restaurados.
        </Notice>
      )}
      {ws.counts.conflictsPending > 0 && (
        <Notice tone="warning" title={`${fmtNumber(ws.counts.conflictsPending)} conflito(s) de sincronização aguardando decisão`}>
          Enquanto não forem resolvidos no aplicativo, os aparelhos seguem com dados divergentes. <button type="button" className="btn btn--link" onClick={() => setTab('sync')}>Ver conflitos</button>
        </Notice>
      )}
      {staleDevices.length > 0 && (
        <Notice tone="info" title={`${staleDevices.length} aparelho(s) atrás do servidor`}>
          Aparelhos que ainda não baixaram as últimas alterações. Normal se estão offline; suspeito se o cliente diz que está com internet.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Membros ativos" value={fmtNumber(activeMembers.filter((m) => m.status === 'active').length)} foot={`${fmtNumber(ws.pendingInvites.length)} convite(s) pendente(s)`} />
        <StatTile label="Produtos" value={fmtNumber(ws.counts.products)} foot={`${fmtNumber(ws.counts.lowStock)} com estoque baixo`} tone={ws.counts.lowStock > 0 && ws.counts.lowStock / Math.max(1, ws.counts.products) > 0.5 ? 'alert' : undefined} />
        <StatTile label="Movimentações" value={fmtNumber(ws.counts.movements)} foot={`${fmtNumber(ws.counts.movements30d)} nos últimos 30 dias`} />
        <StatTile label="Sincronização" value={ws.seededAt ? fmtNumber(ws.counts.syncOps7d) : '—'} foot={ws.seededAt ? 'operações em 7 dias' : 'carga inicial não feita'} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'resumo', label: 'Resumo' },
          { key: 'membros', label: 'Membros', count: activeMembers.length },
          { key: 'assinatura', label: 'Assinatura', count: ws.subscriptions.length },
          { key: 'estoque', label: 'Estoque' },
          { key: 'sync', label: 'Sincronização', count: ws.counts.conflictsPending || undefined },
          { key: 'historico', label: 'Histórico' },
          { key: 'notas', label: 'Notas' },
        ]}
      />

      {tab === 'resumo' && (
        <div className="grid grid--2">
          <Card title="Empresa">
            <KeyValue
              items={[
                { label: 'Nome', value: ws.name },
                { label: 'Proprietário', value: ws.owner ? <><Link to={`/usuarios/${ws.owner.id}`}>{ws.owner.name}</Link> <span className="muted">({ws.owner.email})</span> {ws.owner.status !== 'active' && <Badge tone={USER_STATUS[ws.owner.status]?.tone}>{USER_STATUS[ws.owner.status]?.label}</Badge>}</> : '—' },
                { label: 'Criada em', value: <Time value={ws.createdAt} relative={false} /> },
                { label: 'Carga inicial', value: ws.seededAt ? <Time value={ws.seededAt} relative={false} /> : <span className="muted">ainda não enviou o estoque para a nuvem</span> },
                { label: 'Sequência de alterações', value: <span title="Contador monotônico usado como cursor de sincronização.">{fmtNumber(ws.changeSeq)}</span> },
                { label: 'Identificador', value: <CopyId id={ws.id} /> },
              ]}
            />
            {Object.keys(ws.settings).length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div className="caption" style={{ marginBottom: 4 }}>Configurações</div>
                <Json value={ws.settings} />
              </div>
            )}
          </Card>
          <Card title="Assinatura atual">
            {live ? (
              <KeyValue
                items={[
                  { label: 'Estado', value: <><Badge tone={SUBSCRIPTION_STATE[live.state]?.tone}>{SUBSCRIPTION_STATE[live.state]?.label}</Badge> <span className="caption">{SUBSCRIPTION_STATE[live.state]?.hint}</span></> },
                  { label: 'Plano', value: PLAN_LABEL[live.planKey] ?? live.planKey },
                  { label: 'Renovação automática', value: live.autoRenewing ? 'ligada' : 'desligada' },
                  { label: 'Fim do período', value: <Time value={live.currentPeriodEnd} relative={false} /> },
                  { label: 'Carência até', value: <Time value={live.graceUntil} relative={false} /> },
                  { label: 'Comprada por', value: live.purchaserEmail ? <Link to={`/usuarios/${live.purchaserUserId}`}>{live.purchaserEmail}</Link> : '—' },
                  { label: 'Verificada no Google', value: <Time value={live.lastVerifiedAt} /> },
                  { label: 'Detalhes', value: <Link to={`/assinaturas/${live.id}`}>abrir assinatura</Link> },
                ]}
              />
            ) : (
              <Empty icon="card" title="Sem assinatura ativa">A empresa usa o aplicativo em modo local, sem sincronização.</Empty>
            )}
          </Card>
          <Card title="Membros" actions={<button type="button" className="btn btn--link small" onClick={() => setTab('membros')}>gerenciar</button>}>
            <MembersList ws={ws} compact />
          </Card>
          <Card title="Aparelhos sincronizando">
            <SyncDevices ws={ws} />
          </Card>
        </div>
      )}

      {tab === 'membros' && (
        <div className="stack">
          <Card title="Membros" subtitle="Quem participa da empresa e com que papel">
            <MembersList
              ws={ws}
              onRole={can('support') ? (userId, current) => setDialog({ kind: 'role', userId, current }) : undefined}
              onStatus={can('support') ? (userId, status) => setDialog({ kind: 'status', userId, status }) : undefined}
              onRemove={can('support') ? (userId) => setDialog({ kind: 'remove', userId }) : undefined}
            />
          </Card>
          <Card title="Convites pendentes">
            {ws.pendingInvites.length === 0 ? (
              <Empty icon="mail" title="Nenhum convite pendente" />
            ) : (
              <div className="list">
                {ws.pendingInvites.map((invite) => (
                  <div key={invite.id} className="list__item">
                    <div className="list__main">
                      <div className="list__title">{invite.email}</div>
                      <div className="list__sub">{ROLE_LABEL[invite.roleKey] ?? invite.roleKey} · enviado <Time value={invite.createdAt} /> · {invite.expired ? 'expirado' : <>expira <Time value={invite.expiresAt} /></>}</div>
                    </div>
                    {invite.expired && <Badge tone="warning">expirado</Badge>}
                    {can('support') && (
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setDialog({ kind: 'invite', inviteId: invite.id })}>Cancelar</button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      )}

      {tab === 'assinatura' && (
        <Card title="Histórico de assinaturas" subtitle="Uma empresa tem no máximo uma assinatura viva; as anteriores ficam para consulta">
          {ws.subscriptions.length === 0 ? (
            <Empty icon="card" title="Nenhuma assinatura vinculada" />
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Estado</th>
                    <th>Plano</th>
                    <th>Comprada por</th>
                    <th>Início</th>
                    <th>Fim do período</th>
                    <th>Verificada</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {ws.subscriptions.map((sub) => (
                    <tr key={sub.id}>
                      <td><Badge tone={SUBSCRIPTION_STATE[sub.state]?.tone}>{SUBSCRIPTION_STATE[sub.state]?.label ?? sub.state}</Badge></td>
                      <td>{PLAN_LABEL[sub.planKey] ?? sub.planKey} <span className="muted small">{sub.productId}{sub.basePlanId ? ` / ${sub.basePlanId}` : ''}</span></td>
                      <td>{sub.purchaserEmail ?? <span className="muted">—</span>}</td>
                      <td><Time value={sub.startedAt} relative={false} /></td>
                      <td><Time value={sub.currentPeriodEnd} relative={false} /></td>
                      <td><Time value={sub.lastVerifiedAt} /></td>
                      <td><Link to={`/assinaturas/${sub.id}`}>detalhes</Link></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {tab === 'estoque' && <InventoryTab workspaceId={workspaceId} />}

      {tab === 'sync' && (
        <div className="stack">
          <Card title="Aparelhos" subtitle="Onde cada aparelho parou de ler; atraso é a diferença para o contador da empresa">
            <SyncDevices ws={ws} />
          </Card>
          <Card title="Cargas iniciais">
            {ws.initialUploads.length === 0 ? (
              <Empty icon="sync" title="Nenhuma carga inicial" />
            ) : (
              <div className="table-wrap">
                <table className="table table--compact">
                  <thead>
                    <tr><th>Situação</th><th>Produtos</th><th>Movimentações</th><th>Início</th><th>Conclusão</th></tr>
                  </thead>
                  <tbody>
                    {ws.initialUploads.map((upload) => (
                      <tr key={upload.id}>
                        <td><Badge tone={upload.status === 'concluida' ? 'success' : upload.status === 'em_andamento' ? 'info' : 'neutral'}>{upload.status.replace('_', ' ')}</Badge></td>
                        <td>{fmtNumber(upload.receivedProducts)} / {fmtNumber(upload.declaredProducts)}</td>
                        <td>{fmtNumber(upload.receivedMovements)} / {fmtNumber(upload.declaredMovements)}</td>
                        <td><Time value={upload.createdAt} relative={false} /></td>
                        <td><Time value={upload.completedAt} relative={false} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <ConflictsCard workspaceId={workspaceId} />
        </div>
      )}

      {tab === 'historico' && (
        <Card title="Histórico" subtitle="Auditoria da empresa e ações do suporte sobre ela">
          <TimelinePanel path={`/workspaces/${workspaceId}/timeline`} queryKey={queryKey} />
        </Card>
      )}

      {tab === 'notas' && (
        <Card title="Notas de suporte">
          <NotesPanel path={`/workspaces/${workspaceId}/notes`} queryKey={queryKey} />
        </Card>
      )}

      <RenameDialog open={dialog === 'rename'} onClose={() => setDialog(null)} ws={ws} onSaved={refresh} />
      <ConfirmDialog
        open={dialog === 'delete'}
        onClose={() => setDialog(null)}
        title="Excluir empresa"
        description="Todos os membros perdem o acesso na hora. Os dados ficam no banco e a exclusão pode ser desfeita com “Restaurar”. Os dados locais nos aparelhos não são apagados."
        confirmLabel="Excluir empresa"
        danger
        confirmWord="excluir"
        onConfirm={post('delete')}
      />
      <ConfirmDialog open={dialog === 'restore'} onClose={() => setDialog(null)} title="Restaurar empresa" description="Os membros voltam a ter acesso." confirmLabel="Restaurar" onConfirm={post('restore')} />
      <TransferDialog open={dialog === 'transfer'} onClose={() => setDialog(null)} ws={ws} onConfirm={(newOwnerUserId, reason) => post('transfer-ownership', { newOwnerUserId })(reason)} />
      <RoleDialog
        open={typeof dialog === 'object' && dialog?.kind === 'role'}
        onClose={() => setDialog(null)}
        current={typeof dialog === 'object' && dialog?.kind === 'role' ? dialog.current : ''}
        onConfirm={(role, reason) => (typeof dialog === 'object' && dialog?.kind === 'role' ? put(`members/${dialog.userId}/role`, { role })(reason) : Promise.resolve())}
      />
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog?.kind === 'status'}
        onClose={() => setDialog(null)}
        title={typeof dialog === 'object' && dialog?.kind === 'status' && dialog.status === 'suspended' ? 'Suspender membro' : 'Reativar membro'}
        description="Suspender encerra as sessões da pessoa nesta empresa; ela continua com a conta e as outras empresas."
        confirmLabel="Confirmar"
        danger={typeof dialog === 'object' && dialog?.kind === 'status' && dialog.status === 'suspended'}
        onConfirm={(reason) => (typeof dialog === 'object' && dialog?.kind === 'status' ? put(`members/${dialog.userId}/status`, { status: dialog.status })(reason) : Promise.resolve())}
      />
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog?.kind === 'remove'}
        onClose={() => setDialog(null)}
        title="Remover membro"
        description="A pessoa perde o acesso a esta empresa imediatamente. Pode ser convidada de novo depois."
        confirmLabel="Remover"
        danger
        onConfirm={(reason) => (typeof dialog === 'object' && dialog?.kind === 'remove' ? post(`members/${dialog.userId}/remove`)(reason) : Promise.resolve())}
      />
      <ConfirmDialog
        open={typeof dialog === 'object' && dialog?.kind === 'invite'}
        onClose={() => setDialog(null)}
        title="Cancelar convite"
        description="O link enviado por e-mail deixa de funcionar."
        confirmLabel="Cancelar convite"
        onConfirm={(reason) => (typeof dialog === 'object' && dialog?.kind === 'invite' ? post(`invites/${dialog.inviteId}/cancel`)(reason) : Promise.resolve())}
      />
    </div>
  );
}

function MembersList({
  ws,
  compact,
  onRole,
  onStatus,
  onRemove,
}: {
  ws: WorkspaceDetail;
  compact?: boolean;
  onRole?: (userId: string, current: string) => void;
  onStatus?: (userId: string, status: 'active' | 'suspended') => void;
  onRemove?: (userId: string) => void;
}) {
  const rows = compact ? ws.members.filter((m) => m.status !== 'removed').slice(0, 6) : ws.members;
  if (rows.length === 0) return <Empty icon="users" title="Nenhum membro" />;
  return (
    <div className="list">
      {rows.map((member) => {
        const isOwner = member.role === 'proprietario';
        return (
          <div key={member.id} className="list__item">
            <div className="list__main">
              <div className="list__title">
                <Link to={`/usuarios/${member.userId}`}>{member.name}</Link>
                {member.userStatus !== 'active' && <Badge tone={USER_STATUS[member.userStatus]?.tone}> conta {USER_STATUS[member.userStatus]?.label.toLowerCase()}</Badge>}
              </div>
              <div className="list__sub">{member.email} · desde <Time value={member.joinedAt} /></div>
            </div>
            <Badge tone={isOwner ? 'brand' : 'neutral'} plain>{ROLE_LABEL[member.role] ?? member.role}</Badge>
            {member.status !== 'active' && <Badge tone={MEMBER_STATUS[member.status]?.tone}>{MEMBER_STATUS[member.status]?.label}</Badge>}
            {!compact && !isOwner && member.status !== 'removed' && (onRole || onStatus || onRemove) && (
              <ActionMenu
                label="Ações"
                items={[
                  ...(onRole ? [{ label: 'Alterar papel', icon: 'edit' as const, onClick: () => onRole(member.userId, member.role) }] : []),
                  ...(onStatus
                    ? [member.status === 'suspended'
                        ? { label: 'Reativar', icon: 'play' as const, onClick: () => onStatus(member.userId, 'active') }
                        : { label: 'Suspender', icon: 'pause' as const, onClick: () => onStatus(member.userId, 'suspended') }]
                    : []),
                  ...(onRemove ? ['sep' as const, { label: 'Remover da empresa', icon: 'trash' as const, danger: true, onClick: () => onRemove(member.userId) }] : []),
                ]}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function SyncDevices({ ws }: { ws: WorkspaceDetail }) {
  if (ws.syncDevices.length === 0) return <Empty icon="sync" title="Nenhum aparelho sincronizou ainda" />;
  return (
    <div className="table-wrap">
      <table className="table table--compact">
        <thead>
          <tr><th>Aparelho</th><th>Usuário</th><th className="num">Cursor</th><th className="num">Atraso</th><th>Último envio</th><th>Última leitura</th></tr>
        </thead>
        <tbody>
          {ws.syncDevices.map((device) => (
            <tr key={device.deviceId}>
              <td>{device.model ?? <span className="muted">—</span>}{device.appVersionName && <span className="muted small"> · v{device.appVersionName}</span>}</td>
              <td>{device.userEmail ? <Link to={`/usuarios/${device.userId}`}>{device.userEmail}</Link> : '—'}</td>
              <td className="num">{fmtNumber(device.cursor)}</td>
              <td className="num">{device.lag > 0 ? <Badge tone={device.lag > 100 ? 'warning' : 'info'}>{fmtNumber(device.lag)} atrás</Badge> : <Badge tone="success">em dia</Badge>}</td>
              <td><Time value={device.lastPushAt} /></td>
              <td><Time value={device.lastPullAt} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function InventoryTab({ workspaceId }: { workspaceId: string }) {
  const [view, setView] = useState<'products' | 'movements'>('products');
  const [page, setPage] = useState(1);
  const [q, setQ] = useState('');
  const [includeDeleted, setIncludeDeleted] = useState(false);

  const products = useQuery({
    queryKey: ['workspace', workspaceId, 'products', page, q, includeDeleted],
    queryFn: () => api.get<Paginated<{ id: string; name: string; quantity: number; minStock: number; unit: string | null; category: string | null; sku: string | null; barcode: string | null; unitValue: number; rev: number; updatedAt: string; deletedAt: string | null }>>(`/workspaces/${workspaceId}/products`, { page, pageSize: 50, q, includeDeleted }),
    enabled: view === 'products',
    placeholderData: (previous) => previous,
  });
  const movements = useQuery({
    queryKey: ['workspace', workspaceId, 'movements', page],
    queryFn: () => api.get<Paginated<{ id: string; productId: string | null; productName: string | null; type: string; quantity: number; note: string | null; occurredAt: string; recordedAt: string; createdByEmail: string | null; deviceModel: string | null; reversesMovementId: string | null }>>(`/workspaces/${workspaceId}/movements`, { page, pageSize: 50 }),
    enabled: view === 'movements',
    placeholderData: (previous) => previous,
  });

  return (
    <Card flush>
      <div className="filters" style={{ padding: '14px 18px' }}>
        <div className="chips">
          <button type="button" className={`chip ${view === 'products' ? 'active' : ''}`} onClick={() => { setView('products'); setPage(1); }}>Produtos</button>
          <button type="button" className={`chip ${view === 'movements' ? 'active' : ''}`} onClick={() => { setView('movements'); setPage(1); }}>Movimentações</button>
        </div>
        {view === 'products' && (
          <>
            <input className="input input--sm input--search" placeholder="Nome, SKU ou código de barras" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }} />
            <label className="checkbox"><input type="checkbox" checked={includeDeleted} onChange={(event) => setIncludeDeleted(event.target.checked)} /> incluir excluídos</label>
          </>
        )}
        <div className="filters__spacer" />
        <span className="caption">Somente leitura: o estoque é do cliente.</span>
      </div>
      {view === 'products' ? (
        <>
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr><th>Produto</th><th>Categoria</th><th className="num">Quantidade</th><th className="num">Mínimo</th><th className="num">Valor unit.</th><th>Atualizado</th></tr>
              </thead>
              <tbody>
                {products.isLoading ? (
                  <tr><td colSpan={6}><Skeleton /></td></tr>
                ) : (products.data?.items.length ?? 0) === 0 ? (
                  <tr><td colSpan={6}><Empty icon="package" title="Nenhum produto na nuvem" /></td></tr>
                ) : (
                  products.data?.items.map((product) => {
                    const low = product.quantity <= product.minStock;
                    return (
                      <tr key={product.id}>
                        <td>
                          <div className="cell-main">{product.name}{product.deletedAt && <Badge tone="error"> excluído</Badge>}</div>
                          <div className="cell-sub">{[product.sku && `SKU ${product.sku}`, product.barcode].filter(Boolean).join(' · ') || '—'}</div>
                        </td>
                        <td className="muted">{product.category ?? '—'}</td>
                        <td className="num" style={{ color: low ? 'var(--warning)' : undefined, fontWeight: low ? 600 : undefined }}>{fmtDecimal(product.quantity)} {product.unit ?? ''}</td>
                        <td className="num muted">{fmtDecimal(product.minStock)}</td>
                        <td className="num money">{fmtCurrency(product.unitValue)}</td>
                        <td><Time value={product.updatedAt} /></td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {products.data && <Pagination page={products.data.page} pageSize={products.data.pageSize} total={products.data.total} onPage={setPage} />}
        </>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table table--compact">
              <thead>
                <tr><th>Quando</th><th>Produto</th><th>Tipo</th><th className="num">Quantidade</th><th>Por</th><th>Observação</th></tr>
              </thead>
              <tbody>
                {movements.isLoading ? (
                  <tr><td colSpan={6}><Skeleton /></td></tr>
                ) : (movements.data?.items.length ?? 0) === 0 ? (
                  <tr><td colSpan={6}><Empty icon="list" title="Nenhuma movimentação na nuvem" /></td></tr>
                ) : (
                  movements.data?.items.map((movement) => (
                    <tr key={movement.id}>
                      <td className="nowrap"><Time value={movement.occurredAt} relative={false} /></td>
                      <td>{movement.productName ?? <span className="muted">produto removido</span>}</td>
                      <td><Badge tone="brand" plain>{MOVEMENT_TYPE[movement.type] ?? movement.type}</Badge>{movement.reversesMovementId && <span className="caption"> cancela outra</span>}</td>
                      <td className="num" style={{ color: movement.quantity > 0 ? 'var(--success)' : movement.quantity < 0 ? 'var(--error)' : 'var(--brand)', fontWeight: 600 }}>
                        {movement.quantity > 0 ? '+' : ''}{fmtDecimal(movement.quantity)}
                      </td>
                      <td className="muted">{movement.createdByEmail ?? '—'}{movement.deviceModel && <span className="caption"> · {movement.deviceModel}</span>}</td>
                      <td className="muted">{movement.note ?? '—'}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {movements.data && <Pagination page={movements.data.page} pageSize={movements.data.pageSize} total={movements.data.total} onPage={setPage} />}
        </>
      )}
    </Card>
  );
}

function ConflictsCard({ workspaceId }: { workspaceId: string }) {
  const [status, setStatus] = useState<string>('pendente');
  const [page, setPage] = useState(1);
  const query = useQuery({
    queryKey: ['workspace', workspaceId, 'conflicts', status, page],
    queryFn: () => api.get<Paginated<{ id: string; entityType: string; entityId: string; field: string | null; kind: string; status: string; baseValue: unknown; keptValue: unknown; discardedValue: unknown; createdAt: string; resolvedAt: string | null; resolution: string | null; createdByEmail: string | null; productName: string | null }>>(`/workspaces/${workspaceId}/conflicts`, { status: status || undefined, page, pageSize: 25 }),
    placeholderData: (previous) => previous,
  });
  return (
    <Card
      title="Conflitos"
      subtitle="Dois aparelhos alteraram o mesmo registro; nada é descartado sem rastro"
      actions={
        <select className="select select--sm" value={status} onChange={(event) => { setStatus(event.target.value); setPage(1); }}>
          <option value="pendente">Pendentes</option>
          <option value="automatico">Resolvidos automaticamente</option>
          <option value="resolvido">Resolvidos pelo usuário</option>
          <option value="">Todos</option>
        </select>
      }
    >
      {query.isLoading ? (
        <Skeleton />
      ) : (query.data?.items.length ?? 0) === 0 ? (
        <Empty icon="check" title="Nenhum conflito" />
      ) : (
        <div className="table-wrap">
          <table className="table table--compact">
            <thead>
              <tr><th>Quando</th><th>Registro</th><th>Campo</th><th>Situação</th><th>Base</th><th>Manteve</th><th>Descartou</th></tr>
            </thead>
            <tbody>
              {query.data?.items.map((conflict) => (
                <tr key={conflict.id}>
                  <td className="nowrap"><Time value={conflict.createdAt} relative={false} /></td>
                  <td>{conflict.productName ?? <span className="mono small">{conflict.entityId.slice(0, 8)}</span>}<div className="cell-sub">{conflict.kind === 'exclusao_vs_edicao' ? 'exclusão × edição' : 'campo'}{conflict.createdByEmail && ` · ${conflict.createdByEmail}`}</div></td>
                  <td className="mono small">{conflict.field ?? '—'}</td>
                  <td><Badge tone={CONFLICT_STATUS[conflict.status]?.tone}>{CONFLICT_STATUS[conflict.status]?.label}</Badge>{conflict.resolution && <div className="caption">{conflict.resolution}</div>}</td>
                  <td className="mono small">{JSON.stringify(conflict.baseValue)}</td>
                  <td className="mono small">{JSON.stringify(conflict.keptValue)}</td>
                  <td className="mono small">{JSON.stringify(conflict.discardedValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {query.data && query.data.total > 25 && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={setPage} />}
    </Card>
  );
}

function RenameDialog({ open, onClose, ws, onSaved }: { open: boolean; onClose: () => void; ws: WorkspaceDetail; onSaved: () => void }) {
  const toast = useToast();
  const [name, setName] = useState(ws.name);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.patch<{ message: string }>(`/workspaces/${ws.id}`, { name: name.trim(), reason });
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
    <Modal open={open} onClose={onClose} title="Renomear empresa">
      <form onSubmit={submit} className="stack">
        <label className="field"><span className="field__label">Nome</span><input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required /></label>
        <label className="field"><span className="field__label">Motivo</span><textarea className="textarea" rows={2} value={reason} onChange={(event) => setReason(event.target.value)} maxLength={500} required /></label>
        {error && <div className="field__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || reason.trim().length < 3}>Salvar</button>
        </div>
      </form>
    </Modal>
  );
}

function TransferDialog({ open, onClose, ws, onConfirm }: { open: boolean; onClose: () => void; ws: WorkspaceDetail; onConfirm: (userId: string, reason: string) => Promise<void> }) {
  const [target, setTarget] = useState('');
  const candidates = ws.members.filter((member) => member.status === 'active' && member.role !== 'proprietario' && member.userStatus === 'active');
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Transferir propriedade"
      description="O membro escolhido vira proprietário; o dono atual passa a administrador e continua com acesso."
      confirmLabel="Transferir"
      danger
      confirmWord="transferir"
      onConfirm={(reason) => onConfirm(target, reason)}
    >
      <label className="field">
        <span className="field__label">Novo proprietário</span>
        <select className="select" value={target} onChange={(event) => setTarget(event.target.value)} required>
          <option value="">Escolha um membro ativo…</option>
          {candidates.map((member) => (
            <option key={member.userId} value={member.userId}>{member.name} ({member.email})</option>
          ))}
        </select>
      </label>
    </ConfirmDialog>
  );
}

function RoleDialog({ open, onClose, current, onConfirm }: { open: boolean; onClose: () => void; current: string; onConfirm: (role: string, reason: string) => Promise<void> }) {
  const [role, setRole] = useState(current);
  return (
    <ConfirmDialog open={open} onClose={onClose} title="Alterar papel do membro" description="O token do membro é invalidado e ele passa a operar com o novo papel na próxima renovação." confirmLabel="Alterar" onConfirm={(reason) => onConfirm(role, reason)}>
      <label className="field">
        <span className="field__label">Papel</span>
        <select className="select" value={role || current} onChange={(event) => setRole(event.target.value)}>
          {ROLE_OPTIONS.map((option) => (
            <option key={option} value={option}>{ROLE_LABEL[option]}</option>
          ))}
        </select>
      </label>
    </ConfirmDialog>
  );
}
