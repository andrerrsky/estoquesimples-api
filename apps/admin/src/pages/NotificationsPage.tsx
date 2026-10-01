import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Funnel, HorizontalBars } from '../charts/charts';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, errorMessage, KeyValue, Notice, PageHeader, Pagination, Skeleton, StatTile, Tabs, Time, useToast } from '../components/ui';
import { fmtNumber, fmtPercent } from '../lib/format';
import { useListParams } from '../lib/hooks';
import type { Tone } from '../lib/labels';

// ---------------------------------------------------------------------------
// Tipos e rótulos
// ---------------------------------------------------------------------------

type Audience =
  | { type: 'all' }
  | { type: 'signed_in' }
  | { type: 'anonymous' }
  | { type: 'subscription'; entitled: boolean }
  | { type: 'inactive'; days: number }
  | { type: 'app_version'; maxVersionCode: number }
  | { type: 'users'; emails: string[] }
  | { type: 'workspace'; workspaceId: string };

interface Stats {
  reachable: number;
  reachableSignedIn: number;
  reachableMuted: number;
  new7d: number;
  campaignsSent: number;
  targeted: number;
  accepted: number;
  delivered: number;
  opened: number;
  inProgress: number;
  fcmConfigured: boolean;
  projectId: string | null;
}

interface Campaign {
  id: string;
  title: string;
  body: string;
  action: { screen?: string | null; url?: string | null };
  audience: Audience & { activeWithinDays?: number };
  audienceLabel: string;
  status: 'draft' | 'queued' | 'sending' | 'sent' | 'failed' | 'cancelled';
  isTest: boolean;
  targeted: number;
  accepted: number;
  failed: number;
  delivered: number;
  opened: number;
  error: string | null;
  createdByEmail: string;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

interface Preview {
  total: number;
  signedIn: number;
  installs: number;
  users: number;
  versions: Array<{ version: string; count: number }>;
  label: string;
}

const STATUS: Record<Campaign['status'], { label: string; tone: Tone }> = {
  draft: { label: 'Rascunho', tone: 'neutral' },
  queued: { label: 'Na fila', tone: 'info' },
  sending: { label: 'Enviando', tone: 'brand' },
  sent: { label: 'Enviada', tone: 'success' },
  failed: { label: 'Falhou', tone: 'error' },
  cancelled: { label: 'Cancelada', tone: 'warning' },
};

const SCREEN_LABEL: Record<string, string> = {
  main: 'Lista de produtos',
  history: 'Histórico',
  reports: 'Relatórios',
  analysis: 'Análise de estoque',
  account: 'Conta e sincronização',
  subscription: 'Assinatura',
  team: 'Equipe',
  import: 'Importar / exportar',
};

const FAILURE_LABEL: Record<string, string> = {
  unregistered: 'Token cancelado (app desinstalado ou dados limpos)',
  invalid: 'Token inválido',
  rate_limited: 'Cota do FCM excedida',
  unavailable: 'FCM indisponível no momento',
  error: 'Erro do FCM',
};

type AudienceKind = Audience['type'];

const AUDIENCE_OPTIONS: Array<{ key: AudienceKind; label: string; hint: string }> = [
  { key: 'all', label: 'Todos os aparelhos', hint: 'Com ou sem conta.' },
  { key: 'signed_in', label: 'Com conta', hint: 'Aparelhos onde alguém fez login.' },
  { key: 'anonymous', label: 'Sem conta', hint: 'Usam o app só no modo local.' },
  { key: 'subscription', label: 'Por assinatura', hint: 'Com ou sem assinatura ativa.' },
  { key: 'inactive', label: 'Inativos', hint: 'Sem nenhuma atividade há N dias.' },
  { key: 'app_version', label: 'Versão antiga do app', hint: 'Para pedir atualização.' },
  { key: 'users', label: 'E-mails específicos', hint: 'Até 200 contas.' },
  { key: 'workspace', label: 'Uma empresa', hint: 'Todos os membros ativos.' },
];

function defaultAudience(kind: AudienceKind): Audience {
  switch (kind) {
    case 'subscription':
      return { type: 'subscription', entitled: false };
    case 'inactive':
      return { type: 'inactive', days: 30 };
    case 'app_version':
      return { type: 'app_version', maxVersionCode: 23 };
    case 'users':
      return { type: 'users', emails: [] };
    case 'workspace':
      return { type: 'workspace', workspaceId: '' };
    default:
      return { type: kind } as Audience;
  }
}

function audienceReady(audience: Audience): boolean {
  if (audience.type === 'users') return audience.emails.length > 0;
  if (audience.type === 'workspace') return /^[0-9a-f-]{36}$/i.test(audience.workspaceId);
  return true;
}

// ---------------------------------------------------------------------------
// Página
// ---------------------------------------------------------------------------

export function NotificationsPage() {
  const { can } = useAuth();
  const { values, set, page, pageSize } = useListParams();
  const tab = (values['tab'] as 'campaigns' | 'compose') ?? 'campaigns';
  const navigate = useNavigate();

  const stats = useQuery({ queryKey: ['push', 'stats'], queryFn: () => api.get<Stats>('/push/stats'), refetchInterval: 30_000 });
  const campaigns = useQuery({
    queryKey: ['push', 'campaigns', values, page, pageSize],
    queryFn: () => api.get<Paginated<Campaign>>('/push/campaigns', { status: values['status'], includeTests: values['includeTests'], page, pageSize }),
    placeholderData: (previous) => previous,
    refetchInterval: tab === 'campaigns' ? 15_000 : false,
  });
  const s = stats.data;
  const deliveryRate = s && s.accepted > 0 ? s.delivered / s.accepted : null;
  const openRate = s && s.delivered > 0 ? s.opened / s.delivered : null;

  return (
    <div className="page">
      <PageHeader
        title="Notificações push"
        subtitle={s?.projectId ? `Firebase Cloud Messaging · projeto ${s.projectId}` : 'Mensagens enviadas pelo Firebase Cloud Messaging'}
        actions={can('support') && tab !== 'compose' && <button type="button" className="btn btn--primary" onClick={() => set({ tab: 'compose' })}><Icon name="plus" /> Nova campanha</button>}
      />

      {s && !s.fcmConfigured && (
        <Notice tone="warning" title="Firebase não configurado">
          Falta a conta de serviço (a mesma do Google Play serve, com o papel “Firebase Cloud Messaging API Admin” e a API do FCM ativada no projeto).
        </Notice>
      )}
      {s && s.fcmConfigured && s.reachable === 0 && (
        <Notice tone="info" title="Nenhum aparelho registrado ainda">
          Os tokens chegam quando a versão do app com push registrado for publicada e aberta pelos usuários.
        </Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Aparelhos alcançáveis" value={fmtNumber(s?.reachable)} foot={`${fmtNumber(s?.reachableSignedIn ?? 0)} com conta · ${fmtNumber(s?.reachableMuted ?? 0)} com notificações desligadas`} hint="Tokens válidos vistos nos últimos 90 dias." />
        <StatTile label="Novos aparelhos (7d)" value={fmtNumber(s?.new7d)} foot="tokens registrados na semana" />
        <StatTile label="Campanhas enviadas" value={fmtNumber(s?.campaignsSent)} foot={s?.inProgress ? `${fmtNumber(s.inProgress)} em andamento` : 'sem envio em andamento'} />
        <StatTile label="Taxa de entrega" value={deliveryRate === null ? '—' : fmtPercent(deliveryRate)} foot={`${fmtNumber(s?.delivered ?? 0)} entregues de ${fmtNumber(s?.accepted ?? 0)} aceitas pelo FCM`} hint="Entregue = o app confirmou que recebeu." />
        <StatTile label="Taxa de abertura" value={openRate === null ? '—' : fmtPercent(openRate)} foot={`${fmtNumber(s?.opened ?? 0)} abertas de ${fmtNumber(s?.delivered ?? 0)} entregues`} />
      </div>

      <Tabs value={tab} onChange={(next) => set({ tab: next })} items={[{ key: 'campaigns', label: 'Campanhas', count: campaigns.data?.total }, { key: 'compose', label: 'Nova campanha' }]} />

      {tab === 'compose' ? (
        <Composer onDone={(id) => { set({ tab: 'campaigns' }); navigate(`/notificacoes/${id}`); }} />
      ) : (
        <Card flush>
          <div className="filters" style={{ padding: '14px 18px' }}>
            <select className="select select--sm" value={values['status'] ?? ''} onChange={(event) => set({ status: event.target.value })}>
              <option value="">Todas as situações</option>
              {Object.entries(STATUS).map(([key, info]) => (
                <option key={key} value={key}>{info.label}</option>
              ))}
            </select>
            <label className="checkbox"><input type="checkbox" checked={values['includeTests'] === 'true'} onChange={(event) => set({ includeTests: event.target.checked ? 'true' : '' })} /> mostrar testes</label>
          </div>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr><th>Campanha</th><th>Público</th><th>Situação</th><th className="num">Alvo</th><th className="num">Aceitas</th><th className="num">Entregues</th><th className="num">Abertas</th><th>Criada</th></tr>
              </thead>
              <tbody>
                {campaigns.isLoading ? (
                  <tr><td colSpan={8}><Skeleton /></td></tr>
                ) : (campaigns.data?.items.length ?? 0) === 0 ? (
                  <tr><td colSpan={8}><Empty icon="mail" title="Nenhuma campanha ainda">Crie a primeira em “Nova campanha”.</Empty></td></tr>
                ) : (
                  campaigns.data?.items.map((campaign) => (
                    <tr key={campaign.id} className="clickable" onClick={() => navigate(`/notificacoes/${campaign.id}`)}>
                      <td><div className="cell-main">{campaign.title}{campaign.isTest && <Badge tone="info" plain> teste</Badge>}</div><div className="cell-sub">{campaign.body}</div></td>
                      <td className="muted small">{campaign.audienceLabel}</td>
                      <td><Badge tone={STATUS[campaign.status].tone}>{STATUS[campaign.status].label}</Badge></td>
                      <td className="num">{fmtNumber(campaign.targeted)}</td>
                      <td className="num">{fmtNumber(campaign.accepted)}</td>
                      <td className="num">{fmtNumber(campaign.delivered)}</td>
                      <td className="num">{fmtNumber(campaign.opened)}{campaign.delivered > 0 && <span className="caption"> ({Math.round((campaign.opened / campaign.delivered) * 100)}%)</span>}</td>
                      <td><Time value={campaign.createdAt} /><div className="cell-sub">{campaign.createdByEmail}</div></td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {campaigns.data && <Pagination page={campaigns.data.page} pageSize={campaigns.data.pageSize} total={campaigns.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} />}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composição
// ---------------------------------------------------------------------------

function Composer({ onDone, initial }: { onDone: (campaignId: string) => void; initial?: Campaign }) {
  const toast = useToast();
  const { admin } = useAuth();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [body, setBody] = useState(initial?.body ?? '');
  const [screen, setScreen] = useState(initial?.action.screen ?? '');
  const [url, setUrl] = useState(initial?.action.url ?? '');
  const [kind, setKind] = useState<AudienceKind>(initial?.audience.type ?? 'all');
  const [audience, setAudience] = useState<Audience>(initial ? (({ activeWithinDays: _a, ...rest }) => rest as Audience)(initial.audience) : { type: 'all' });
  const [activeWithinDays, setActiveWithinDays] = useState(initial?.audience.activeWithinDays ?? 90);
  const [emailsText, setEmailsText] = useState(initial?.audience.type === 'users' ? initial.audience.emails.join('\n') : '');
  const [testEmail, setTestEmail] = useState(admin?.email ?? '');
  const [confirm, setConfirm] = useState(false);

  const payload = useMemo(
    () => ({ title: title.trim(), body: body.trim(), action: { screen: screen || null, url: url.trim() || null }, audience, activeWithinDays }),
    [title, body, screen, url, audience, activeWithinDays],
  );
  const ready = payload.title.length > 0 && payload.body.length > 0 && audienceReady(audience) && (!url.trim() || /^https?:\/\//.test(url.trim()));

  const preview = useQuery({
    queryKey: ['push', 'preview', audience, activeWithinDays],
    queryFn: () => api.post<Preview>('/push/audience/preview', { audience, activeWithinDays }),
    enabled: audienceReady(audience),
    placeholderData: (previous) => previous,
  });

  useEffect(() => {
    if (kind === 'users') {
      const emails = emailsText.split(/[\s,;]+/).map((item) => item.trim().toLowerCase()).filter((item) => item.includes('@'));
      setAudience({ type: 'users', emails: [...new Set(emails)].slice(0, 200) });
    }
  }, [emailsText, kind]);

  const changeKind = (next: AudienceKind) => {
    setKind(next);
    setAudience(defaultAudience(next));
  };

  const sendTest = useMutation({
    mutationFn: () => api.post<{ campaignId: string; targeted: number; accepted: number; failed: number }>('/push/test', { ...payload, email: testEmail.trim() }),
    onSuccess: (result) => toast.push(`Teste enviado: ${result.accepted} aparelho(s) aceito(s) pelo FCM${result.failed ? `, ${result.failed} falha(s)` : ''}.`, 'success'),
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  const saveDraft = useMutation({
    mutationFn: () => (initial ? api.put<Campaign>(`/push/campaigns/${initial.id}`, payload) : api.post<Campaign>('/push/campaigns', payload)),
    onSuccess: (campaign) => {
      toast.push('Rascunho salvo.', 'success');
      onDone(campaign.id);
    },
    onError: (error) => toast.push(errorMessage(error), 'error'),
  });

  return (
    <div className="grid grid--2-1">
      <div className="stack">
        <Card title="Mensagem" subtitle="O que aparece na notificação do aparelho">
          <div className="stack stack--tight">
            <label className="field">
              <span className="field__label">Título</span>
              <input className="input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={80} placeholder="Ex.: Relatórios em PDF ficaram melhores" />
              <span className="field__hint">{title.length}/80 · aparece em negrito; cabe uma linha.</span>
            </label>
            <label className="field">
              <span className="field__label">Mensagem</span>
              <textarea className="textarea" rows={3} value={body} onChange={(event) => setBody(event.target.value)} maxLength={500} placeholder="Ex.: Atualize o app para gerar relatórios por período e compartilhar direto no WhatsApp." />
              <span className="field__hint">{body.length}/500 · o Android mostra ~2 linhas fechado e o texto inteiro expandido.</span>
            </label>
            <div className="form-grid">
              <label className="field">
                <span className="field__label">Ao tocar, abrir</span>
                <select className="select" value={screen} onChange={(event) => setScreen(event.target.value)}>
                  <option value="">Tela inicial do app</option>
                  {Object.entries(SCREEN_LABEL).map(([key, label]) => (
                    <option key={key} value={key}>{label}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span className="field__label">Ou abrir um link (opcional)</span>
                <input className="input" value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://…" maxLength={500} />
                <span className="field__hint">Se preenchido, o link vale no lugar da tela.</span>
              </label>
            </div>
          </div>
        </Card>

        <Card title="Público" subtitle="Resolvido na hora do envio; a estimativa ao lado é de agora">
          <div className="chips" style={{ marginBottom: 12 }}>
            {AUDIENCE_OPTIONS.map((option) => (
              <button key={option.key} type="button" className={`chip ${kind === option.key ? 'active' : ''}`} title={option.hint} onClick={() => changeKind(option.key)}>{option.label}</button>
            ))}
          </div>
          <div className="form-grid">
            {audience.type === 'subscription' && (
              <label className="field">
                <span className="field__label">Assinatura</span>
                <select className="select" value={audience.entitled ? 'yes' : 'no'} onChange={(event) => setAudience({ type: 'subscription', entitled: event.target.value === 'yes' })}>
                  <option value="no">Sem assinatura ativa (oportunidade de conversão)</option>
                  <option value="yes">Com assinatura ativa</option>
                </select>
              </label>
            )}
            {audience.type === 'inactive' && (
              <label className="field">
                <span className="field__label">Sem atividade há (dias)</span>
                <input className="input" type="number" min={3} max={365} value={audience.days} onChange={(event) => setAudience({ type: 'inactive', days: Math.max(3, Math.min(365, Number(event.target.value) || 30)) })} />
                <span className="field__hint">Conta eventos do app, logins e sincronização.</span>
              </label>
            )}
            {audience.type === 'app_version' && (
              <label className="field">
                <span className="field__label">versionCode até</span>
                <input className="input" type="number" min={1} value={audience.maxVersionCode} onChange={(event) => setAudience({ type: 'app_version', maxVersionCode: Math.max(1, Number(event.target.value) || 1) })} />
                <span className="field__hint">Aparelhos com essa versão ou mais antiga.</span>
              </label>
            )}
            {audience.type === 'users' && (
              <label className="field field--full">
                <span className="field__label">E-mails (um por linha ou separados por vírgula)</span>
                <textarea className="textarea" rows={3} value={emailsText} onChange={(event) => setEmailsText(event.target.value)} placeholder="cliente@exemplo.com.br" />
                <span className="field__hint">{audience.emails.length} e-mail(s) reconhecido(s).</span>
              </label>
            )}
            {audience.type === 'workspace' && (
              <label className="field field--full">
                <span className="field__label">ID da empresa</span>
                <input className="input" value={audience.workspaceId} onChange={(event) => setAudience({ type: 'workspace', workspaceId: event.target.value.trim() })} placeholder="uuid (copie na tela da empresa)" />
              </label>
            )}
            <label className="field">
              <span className="field__label">Só aparelhos vistos nos últimos (dias)</span>
              <input className="input" type="number" min={1} max={365} value={activeWithinDays} onChange={(event) => setActiveWithinDays(Math.max(1, Math.min(365, Number(event.target.value) || 90)))} />
              <span className="field__hint">Evita gastar cota com tokens de aparelhos abandonados.</span>
            </label>
          </div>
        </Card>
      </div>

      <div className="stack">
        <Card title="Prévia" subtitle="Como aparece no Android">
          <DevicePreview title={title || 'Título da notificação'} body={body || 'A mensagem aparece aqui. Escreva algo curto e direto.'} />
        </Card>
        <Card title="Alcance estimado">
          {!audienceReady(audience) ? (
            <span className="muted small">Complete o público para estimar.</span>
          ) : preview.data ? (
            <div className="stack stack--tight">
              <div className="tile__value">{fmtNumber(preview.data.total)} <span className="muted" style={{ fontSize: 'var(--fs-supporting)', fontWeight: 500 }}>aparelho(s)</span></div>
              <div className="caption">{preview.data.label}</div>
              <div className="caption">{fmtNumber(preview.data.signedIn)} com conta · {fmtNumber(preview.data.users)} usuário(s) distinto(s)</div>
              {preview.data.versions.length > 0 && <HorizontalBars items={preview.data.versions.map((item) => ({ label: `v${item.version}`, value: item.count }))} />}
            </div>
          ) : (
            <Skeleton />
          )}
        </Card>
        <Card title="Enviar">
          <div className="stack stack--tight">
            <label className="field">
              <span className="field__label">Testar primeiro em um aparelho</span>
              <div className="row">
                <input className="input input--sm" value={testEmail} onChange={(event) => setTestEmail(event.target.value)} placeholder="e-mail de uma conta do app" style={{ flex: 1 }} />
                <button type="button" className="btn btn--ghost btn--sm" disabled={!ready || !testEmail.includes('@') || sendTest.isPending} onClick={() => sendTest.mutate()}>{sendTest.isPending ? 'Enviando…' : 'Enviar teste'}</button>
              </div>
              <span className="field__hint">Vai só para os aparelhos onde esse e-mail fez login; fica registrado como teste.</span>
            </label>
            <hr className="divider" />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button type="button" className="btn btn--ghost" disabled={!ready || saveDraft.isPending} onClick={() => saveDraft.mutate()}>Salvar rascunho</button>
              <button type="button" className="btn btn--primary" disabled={!ready || (preview.data?.total ?? 0) === 0} onClick={() => setConfirm(true)}><Icon name="zap" /> Enviar agora</button>
            </div>
          </div>
        </Card>
      </div>

      <ConfirmDialog
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Enviar campanha"
        description={<>Vai para <strong>{fmtNumber(preview.data?.total ?? 0)} aparelho(s)</strong> ({preview.data?.label}). Depois de aceita pelo FCM a mensagem não pode ser retirada.</>}
        confirmLabel="Enviar para todos"
        confirmWord="enviar"
        requireReason={false}
        onConfirm={async () => {
          const campaign = initial ? await api.put<Campaign>(`/push/campaigns/${initial.id}`, payload) : await api.post<Campaign>('/push/campaigns', payload);
          await api.post(`/push/campaigns/${campaign.id}/send`);
          toast.push('Campanha na fila de envio.', 'success');
          onDone(campaign.id);
        }}
      >
        <DevicePreview title={title} body={body} compact />
      </ConfirmDialog>
    </div>
  );
}

function DevicePreview({ title, body, compact }: { title: string; body: string; compact?: boolean }) {
  return (
    <div style={{ background: '#1f2937', borderRadius: 18, padding: compact ? 10 : 14 }}>
      <div style={{ background: '#fff', borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 10 }}>
        <div style={{ width: 22, height: 22, borderRadius: 6, background: 'var(--brand)', flex: 'none', display: 'grid', placeItems: 'center' }}>
          <svg width="14" height="14" viewBox="0 0 64 64" aria-hidden="true"><g transform="translate(32 34)"><polygon points="0,-16 16,-8 0,0 -16,-8" fill="#fff" /><polygon points="0,0 16,-8 16,10 0,18" fill="#fff" fillOpacity="0.82" /><polygon points="0,0 -16,-8 -16,10 0,18" fill="#fff" fillOpacity="0.64" /></g></svg>
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="caption" style={{ display: 'flex', justifyContent: 'space-between' }}><span>Estoque Simples</span><span>agora</span></div>
          <div style={{ fontWeight: 700, fontSize: 14, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', display: '-webkit-box', WebkitLineClamp: compact ? 2 : 6, WebkitBoxOrient: 'vertical', overflow: 'hidden', whiteSpace: 'pre-wrap' }}>{body}</div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe da campanha
// ---------------------------------------------------------------------------

export function CampaignDetailPage() {
  const { campaignId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deliveriesPage, setDeliveriesPage] = useState(1);
  const [deliveryStatus, setDeliveryStatus] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const queryKey = ['push', 'campaign', campaignId];
  const query = useQuery({
    queryKey,
    queryFn: () => api.get<Campaign & { failures: Array<{ error: string; count: number }>; timeline: Array<{ hour: string; delivered: number; opened: number }> }>(`/push/campaigns/${campaignId}`),
    refetchInterval: (data) => (data.state.data && ['queued', 'sending'].includes(data.state.data.status) ? 3_000 : false),
  });
  const deliveries = useQuery({
    queryKey: [...queryKey, 'deliveries', deliveriesPage, deliveryStatus],
    queryFn: () => api.get<Paginated<{ installId: string; userId: string | null; email: string | null; status: string; error: string | null; platform: string | null; appVersionCode: number | null; acceptedAt: string | null; deliveredAt: string | null; openedAt: string | null }>>(`/push/campaigns/${campaignId}/deliveries`, { page: deliveriesPage, pageSize: 50, status: deliveryStatus || undefined }),
    placeholderData: (previous) => previous,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey });
    void queryClient.invalidateQueries({ queryKey: ['push'] });
  };
  const campaign = query.data;

  if (query.isLoading) return <div className="page"><Skeleton lines={8} /></div>;
  if (!campaign) return <div className="page"><Notice tone="error">Campanha não encontrada.</Notice></div>;

  if (editing && campaign.status === 'draft') {
    return (
      <div className="page">
        <PageHeader crumbs={[{ label: 'Notificações', to: '/notificacoes' }, { label: campaign.title }]} title="Editar rascunho" actions={<button type="button" className="btn btn--ghost" onClick={() => setEditing(false)}>Cancelar</button>} />
        <Composer initial={campaign} onDone={(id) => { setEditing(false); refresh(); if (id !== campaignId) navigate(`/notificacoes/${id}`); }} />
      </div>
    );
  }

  const status = STATUS[campaign.status];
  const steps = [
    { key: 'targeted', label: 'Alvo', count: campaign.targeted },
    { key: 'accepted', label: 'Aceitas pelo FCM', count: campaign.accepted },
    { key: 'delivered', label: 'Entregues no app', count: campaign.delivered },
    { key: 'opened', label: 'Abertas', count: campaign.opened },
  ].map((step, index, all) => ({
    ...step,
    event: step.key,
    ofFirst: all[0] && all[0].count > 0 ? step.count / all[0].count : null,
    ofPrevious: index > 0 && (all[index - 1]?.count ?? 0) > 0 ? step.count / (all[index - 1]?.count ?? 1) : null,
  }));

  return (
    <div className="page">
      <PageHeader
        crumbs={[{ label: 'Notificações', to: '/notificacoes' }, { label: campaign.title }]}
        title={<span className="row">{campaign.title} <Badge tone={status.tone}>{status.label}</Badge>{campaign.isTest && <Badge tone="info" plain>teste</Badge>}</span>}
        subtitle={<>{campaign.audienceLabel} · criada por {campaign.createdByEmail} <Time value={campaign.createdAt} /></>}
        actions={
          can('support') && (
            <div className="row">
              {campaign.status === 'draft' && <button type="button" className="btn btn--secondary" onClick={() => setEditing(true)}><Icon name="edit" /> Editar e enviar</button>}
              {['queued', 'sending'].includes(campaign.status) && <button type="button" className="btn btn--danger" onClick={() => setCancelOpen(true)}>Cancelar envio</button>}
              {(campaign.status === 'draft' || campaign.isTest) && <button type="button" className="btn btn--ghost" onClick={() => setDeleteOpen(true)}><Icon name="trash" /> Apagar</button>}
            </div>
          )
        }
      />

      {campaign.status === 'failed' && <Notice tone="error" title="O envio falhou">{campaign.error ?? 'Erro desconhecido.'}</Notice>}
      {campaign.status === 'sending' && <Notice tone="info">Envio em andamento; os números atualizam sozinhos.</Notice>}

      <div className="grid grid--2-1">
        <Card title="Funil de entrega" subtitle="Aceita = o FCM recebeu; entregue e aberta = o app reportou">
          <Funnel steps={steps} />
          {campaign.failed > 0 && (
            <div style={{ marginTop: 16 }}>
              <div className="caption" style={{ marginBottom: 6 }}>{fmtNumber(campaign.failed)} falha(s) por motivo</div>
              <HorizontalBars items={campaign.failures.map((item) => ({ label: FAILURE_LABEL[item.error] ?? item.error, value: item.count }))} color="var(--series-2)" />
            </div>
          )}
        </Card>
        <div className="stack">
          <Card title="Mensagem">
            <DevicePreview title={campaign.title} body={campaign.body} />
            <div style={{ marginTop: 12 }}>
              <KeyValue
                items={[
                  { label: 'Ao tocar', value: campaign.action.url ? <a href={campaign.action.url} target="_blank" rel="noreferrer">{campaign.action.url}</a> : (SCREEN_LABEL[campaign.action.screen ?? ''] ?? 'Tela inicial') },
                  { label: 'Início', value: <Time value={campaign.startedAt} relative={false} /> },
                  { label: 'Conclusão', value: <Time value={campaign.completedAt} relative={false} /> },
                ]}
              />
            </div>
          </Card>
          {campaign.timeline.length > 0 && (
            <Card title="Entregas por hora" subtitle="Quando os aparelhos receberam e abriram">
              <HorizontalBars items={campaign.timeline.slice(-12).map((item) => ({ label: item.hour.slice(5), value: item.delivered, hint: `${item.opened} aberta(s)` }))} />
            </Card>
          )}
        </div>
      </div>

      <Card
        title="Aparelhos"
        subtitle="Uma linha por token alvo"
        flush
        actions={
          <select className="select select--sm" value={deliveryStatus} onChange={(event) => { setDeliveryStatus(event.target.value); setDeliveriesPage(1); }}>
            <option value="">Todos</option>
            <option value="opened">Abertas</option>
            <option value="delivered">Entregues</option>
            <option value="accepted">Aceitas (sem confirmação)</option>
            <option value="failed">Falhas</option>
            <option value="pending">Pendentes</option>
          </select>
        }
      >
        <div className="table-wrap">
          <table className="table table--compact">
            <thead><tr><th>Conta</th><th>Instalação</th><th>App</th><th>Situação</th><th>Aceita</th><th>Entregue</th><th>Aberta</th></tr></thead>
            <tbody>
              {deliveries.isLoading ? (
                <tr><td colSpan={7}><Skeleton /></td></tr>
              ) : (deliveries.data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={7}><Empty icon="phone" title="Nenhum aparelho nesta lista" /></td></tr>
              ) : (
                deliveries.data?.items.map((item) => (
                  <tr key={`${item.installId}-${item.status}`}>
                    <td>{item.email ? <Link to={`/usuarios/${item.userId}`}>{item.email}</Link> : <span className="muted">sem conta</span>}</td>
                    <td className="mono small">{item.installId.slice(0, 8)}</td>
                    <td className="muted">{item.platform ?? '—'}{item.appVersionCode ? ` v${item.appVersionCode}` : ''}</td>
                    <td>
                      <Badge tone={item.status === 'opened' ? 'success' : item.status === 'delivered' ? 'info' : item.status === 'failed' ? 'error' : 'neutral'}>{item.status}</Badge>
                      {item.error && <div className="caption">{FAILURE_LABEL[item.error] ?? item.error}</div>}
                    </td>
                    <td><Time value={item.acceptedAt} /></td>
                    <td><Time value={item.deliveredAt} /></td>
                    <td><Time value={item.openedAt} /></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        {deliveries.data && <Pagination page={deliveries.data.page} pageSize={deliveries.data.pageSize} total={deliveries.data.total} onPage={setDeliveriesPage} />}
      </Card>

      <ConfirmDialog open={cancelOpen} onClose={() => setCancelOpen(false)} title="Cancelar envio" description="Os aparelhos que ainda não receberam ficam de fora; o que o FCM já aceitou não pode ser retirado." confirmLabel="Cancelar envio" danger requireReason={false} onConfirm={async () => { await api.post(`/push/campaigns/${campaignId}/cancel`); toast.push('Envio cancelado.'); refresh(); }} />
      <ConfirmDialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Apagar campanha" confirmLabel="Apagar" danger requireReason={false} onConfirm={async () => { await api.delete(`/push/campaigns/${campaignId}`); toast.push('Campanha apagada.'); navigate('/notificacoes'); }} />
    </div>
  );
}
