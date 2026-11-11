import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Badge, Card, ConfirmDialog, DataTable, Empty, KeyValue, Notice, PageHeader, Pagination, Skeleton, StatTile, Time, useToast, type Column } from '../components/ui';
import { fmtCents, fmtDateTime, fmtNumber, parseReaisToCents } from '../lib/format';
import { useListParams } from '../lib/hooks';
import { BILLING_CYCLE, COUPON_REDEMPTION_STATE, COUPON_STATUS, SUBSCRIPTION_STATE } from '../lib/labels';

interface Coupon {
  id: string;
  code: string;
  label: string;
  startsAt: string;
  /** Inclusivo: vale até este instante (23:59:59 do último dia). */
  endsAt: string;
  active: boolean;
  status: 'agendado' | 'no_ar' | 'encerrado' | 'desativado';
  /** Total do 1º ano com desconto; null = anual fora da oferta. */
  yearlyPriceCents: number | null;
  /** Valor de cada mensalidade promocional; null = mensal fora da oferta. */
  monthlyFirstCents: number | null;
  monthlyPromoCycles: number;
  createdAt: string;
  updatedAt: string;
  reserved: number;
  redeemed: number;
  /** 1ª cobrança (valor promocional) dos resgates pagos. */
  redeemedRevenueCents: number;
}

interface FullPricing {
  monthlyCents: number | null;
  yearlyCents: number | null;
}

interface Redemption {
  id: string;
  state: string;
  cycle: string;
  valueCents: number;
  workspaceId: string | null;
  workspaceName: string | null;
  workspaceDeleted: boolean;
  subscriptionId: string | null;
  subscriptionState: string | null;
  createdAt: string;
  redeemedAt: string | null;
}

// ---------------------------------------------------------------------------
// Horário de Brasília nos campos. O Brasil não tem horário de verão desde
// 2019, então o fuso é fixo em -03:00; a API recebe o instante com o fuso
// explícito e nunca depende do relógio de quem está no painel.
// ---------------------------------------------------------------------------

const BRT_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

/** ISO → valor de `<input type="datetime-local" step="1">` no horário de Brasília. */
function toBrasiliaInput(value: string): string {
  const parts = Object.fromEntries(BRT_PARTS.formatToParts(new Date(value)).map((part) => [part.type, part.value]));
  return `${parts['year']}-${parts['month']}-${parts['day']}T${parts['hour']}:${parts['minute']}:${parts['second']}`;
}

/** Valor do campo (Brasília) → ISO com fuso; null se vazio ou inválido. */
function fromBrasiliaInput(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})(?::(\d{2}))?$/.exec(value.trim());
  if (!match) return null;
  return `${match[1]}T${match[2]}:${match[3] ?? '00'}-03:00`;
}

/** "20/11/2026 00:00:00" no horário de Brasília. */
function fmtBrasilia(value: string): string {
  return `${toBrasiliaInput(value).replace(/^(\d{4})-(\d{2})-(\d{2})T/, '$3/$2/$1 ')}`;
}

function Period({ coupon }: { coupon: Pick<Coupon, 'startsAt' | 'endsAt'> }) {
  return (
    <span title="Horário de Brasília">
      {fmtBrasilia(coupon.startsAt)} → {fmtBrasilia(coupon.endsAt)}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const info = COUPON_STATUS[status];
  return (
    <span title={info?.hint}>
      <Badge tone={info?.tone}>{info?.label ?? status}</Badge>
    </span>
  );
}

function PromoPrices({ coupon, full }: { coupon: Coupon; full: FullPricing | undefined }) {
  return (
    <div className="stack stack--tight">
      <div>
        Anual:{' '}
        {coupon.yearlyPriceCents !== null ? (
          <><strong>{fmtCents(coupon.yearlyPriceCents)}</strong> <span className="caption">no 1º ano{full?.yearlyCents ? ` · de ${fmtCents(full.yearlyCents)}` : ''}</span></>
        ) : (
          <span className="muted">fora da oferta</span>
        )}
      </div>
      <div>
        Mensal:{' '}
        {coupon.monthlyFirstCents !== null ? (
          <>
            <strong>{fmtCents(coupon.monthlyFirstCents)}</strong>{' '}
            <span className="caption">
              {coupon.monthlyPromoCycles === 1 ? 'no 1º mês' : `nos ${coupon.monthlyPromoCycles} primeiros meses`}
              {full?.monthlyCents ? ` · de ${fmtCents(full.monthlyCents)}` : ''}
            </span>
          </>
        ) : (
          <span className="muted">fora da oferta</span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

interface CreateDraft {
  code: string;
  label: string;
  startsAt: string;
  endsAt: string;
  yearly: string;
  monthly: string;
  cycles: string;
}

const EMPTY_CREATE: CreateDraft = { code: '', label: '', startsAt: '', endsAt: '', yearly: '', monthly: '', cycles: '1' };

export function CouponsPage() {
  const { can } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { set, page, pageSize } = useListParams();
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<CreateDraft>(EMPTY_CREATE);

  const query = useQuery({
    queryKey: ['coupons', page, pageSize],
    queryFn: () => api.get<Paginated<Coupon> & { fullPricing: FullPricing }>('/coupons', { page, pageSize }),
    placeholderData: (previous) => previous,
  });
  const full = query.data?.fullPricing;

  const columns: Array<Column<Coupon>> = [
    {
      key: 'code',
      header: 'Cupom',
      render: (row) => (
        <div>
          <div className="cell-main"><code>{row.code}</code></div>
          <div className="cell-sub">{row.label}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Situação', render: (row) => <StatusBadge status={row.status} /> },
    { key: 'period', header: 'Vigência (Brasília)', render: (row) => <span className="small"><Period coupon={row} /></span> },
    { key: 'prices', header: 'Preços promocionais', render: (row) => <span className="small"><PromoPrices coupon={row} full={full} /></span> },
    { key: 'reserved', header: 'Reservados', numeric: true, render: (row) => fmtNumber(row.reserved) },
    { key: 'redeemed', header: 'Resgatados', numeric: true, render: (row) => fmtNumber(row.redeemed) },
    { key: 'revenue', header: 'Receita da 1ª cobrança', numeric: true, render: (row) => fmtCents(row.redeemedRevenueCents) },
  ];

  const readPrice = (text: string, label: string): number | null => {
    const cents = parseReaisToCents(text);
    if (cents === undefined) throw new Error(`${label}: valor inválido. Use reais com vírgula, por exemplo 119,90.`);
    return cents;
  };

  return (
    <div className="page">
      <PageHeader
        title="Cupons"
        subtitle="Cupons promocionais da assinatura pela web (Asaas). O preço cheio é sempre o de Planos."
        crumbs={[{ label: 'Assinaturas', to: '/assinaturas' }, { label: 'Cupons' }]}
        actions={
          can('owner') && (
            <button type="button" className="btn btn--primary" onClick={() => { setDraft(EMPTY_CREATE); setCreating(true); }}>
              Novo cupom
            </button>
          )
        }
      />
      <Notice tone="info">
        Um uso por empresa e um por CPF/CNPJ. O uso nasce <strong>reservado</strong> no checkout e só vira <strong>resgatado</strong> quando a 1ª cobrança é paga. Desativar um cupom é o freio de emergência: o checkout recusa na hora e ele some das faixas e da landing em até 1 minuto (cache de <code>/public/promo</code>).
      </Notice>

      <Card flush>
        <DataTable
          rows={query.data?.items ?? []}
          columns={columns}
          rowKey={(row) => row.id}
          onRowClick={(row) => navigate(`/cupons/${row.id}`)}
          loading={query.isLoading}
          empty={<Empty icon="tag" title="Nenhum cupom cadastrado" />}
        />
        {query.data && <Pagination page={query.data.page} pageSize={query.data.pageSize} total={query.data.total} onPage={(next) => set({ page: next }, { resetPage: false })} onPageSize={(size) => set({ pageSize: size })} />}
      </Card>

      <ConfirmDialog
        open={creating}
        onClose={() => setCreating(false)}
        title="Novo cupom"
        description="Os preços não podem ser alterados depois de criado (anúncios e e-mails citam os valores)."
        confirmLabel="Criar cupom"
        onConfirm={async (reason) => {
          const code = draft.code.trim().toUpperCase();
          if (!/^[A-Z0-9]{4,32}$/.test(code)) throw new Error('Código: só letras e números, de 4 a 32 caracteres.');
          const startsAt = fromBrasiliaInput(draft.startsAt);
          const endsAt = fromBrasiliaInput(draft.endsAt);
          if (!startsAt || !endsAt) throw new Error('Informe o início e o fim da vigência.');
          const cycles = Number(draft.cycles);
          if (!Number.isInteger(cycles) || cycles < 1 || cycles > 12) throw new Error('Mensalidades promocionais: de 1 a 12.');
          const created = await api.post<Coupon>('/coupons', {
            code,
            label: draft.label.trim(),
            startsAt,
            endsAt,
            yearlyPriceCents: readPrice(draft.yearly, 'Preço anual'),
            monthlyFirstCents: readPrice(draft.monthly, 'Preço do 1º mês'),
            monthlyPromoCycles: cycles,
            reason,
          });
          toast.push(`Cupom ${created.code} criado.`, 'success');
          void queryClient.invalidateQueries({ queryKey: ['coupons'] });
          navigate(`/cupons/${created.id}`);
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Código</span>
            <input className="input" value={draft.code} onChange={(event) => setDraft({ ...draft, code: event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} maxLength={32} placeholder="NATAL26" autoComplete="off" />
            <span className="field__hint">Letras maiúsculas e números, de 4 a 32.</span>
          </label>
          <label className="field">
            <span className="field__label">Rótulo</span>
            <input className="input" value={draft.label} onChange={(event) => setDraft({ ...draft, label: event.target.value })} maxLength={80} placeholder="Natal" />
            <span className="field__hint">Aparece nas faixas e na landing.</span>
          </label>
          <label className="field">
            <span className="field__label">Início (Brasília)</span>
            <input className="input" type="datetime-local" step={1} value={draft.startsAt} onChange={(event) => setDraft({ ...draft, startsAt: event.target.value })} />
          </label>
          <label className="field">
            <span className="field__label">Fim (Brasília, inclusivo)</span>
            <input className="input" type="datetime-local" step={1} value={draft.endsAt} onChange={(event) => setDraft({ ...draft, endsAt: event.target.value })} />
            <span className="field__hint">Ex.: último dia às 23:59:59.</span>
          </label>
          <label className="field">
            <span className="field__label">Anual promocional (R$, total do 1º ano)</span>
            <input className="input" inputMode="decimal" value={draft.yearly} onChange={(event) => setDraft({ ...draft, yearly: event.target.value })} placeholder="vazio = anual fora da oferta" maxLength={14} />
            <span className="field__hint">Cheio hoje: {fmtCents(full?.yearlyCents)}. Mínimo R$ 5,00 e menor que o cheio.</span>
          </label>
          <label className="field">
            <span className="field__label">Mensalidade promocional (R$)</span>
            <input className="input" inputMode="decimal" value={draft.monthly} onChange={(event) => setDraft({ ...draft, monthly: event.target.value })} placeholder="vazio = mensal fora da oferta" maxLength={14} />
            <span className="field__hint">Cheio hoje: {fmtCents(full?.monthlyCents)}. Mínimo R$ 5,00 e menor que o cheio.</span>
          </label>
          <label className="field">
            <span className="field__label">Mensalidades com o preço promocional</span>
            <input className="input" type="number" min={1} max={12} value={draft.cycles} onChange={(event) => setDraft({ ...draft, cycles: event.target.value })} />
            <span className="field__hint">O anual é sempre 1 ciclo.</span>
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detalhe
// ---------------------------------------------------------------------------

type DetailDialog = null | 'deactivate' | 'activate' | 'period';

export function CouponDetailPage() {
  const { couponId = '' } = useParams();
  const { can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<DetailDialog>(null);
  const [period, setPeriod] = useState({ startsAt: '', endsAt: '' });
  const [page, setPage] = useState(1);
  const [stateFilter, setStateFilter] = useState('');

  const query = useQuery({ queryKey: ['coupons', 'detail', couponId], queryFn: () => api.get<Coupon & { fullPricing: FullPricing }>(`/coupons/${couponId}`) });
  const redemptions = useQuery({
    queryKey: ['coupons', 'redemptions', couponId, page, stateFilter],
    queryFn: () => api.get<Paginated<Redemption>>(`/coupons/${couponId}/redemptions`, { page, pageSize: 50, state: stateFilter || undefined }),
    placeholderData: (previous) => previous,
  });
  const coupon = query.data;

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['coupons'] });

  const columns: Array<Column<Redemption>> = [
    {
      key: 'workspace',
      header: 'Empresa',
      render: (row) =>
        row.workspaceId ? (
          <>
            <Link to={`/empresas/${row.workspaceId}`} onClick={(event) => event.stopPropagation()}>{row.workspaceName ?? row.workspaceId.slice(0, 8)}</Link>
            {row.workspaceDeleted && <span className="caption"> · excluída</span>}
          </>
        ) : (
          <span className="muted">empresa apagada</span>
        ),
    },
    {
      key: 'state',
      header: 'Uso',
      render: (row) => (
        <span title={COUPON_REDEMPTION_STATE[row.state]?.hint}>
          <Badge tone={COUPON_REDEMPTION_STATE[row.state]?.tone}>{COUPON_REDEMPTION_STATE[row.state]?.label ?? row.state}</Badge>
        </span>
      ),
    },
    { key: 'cycle', header: 'Ciclo', render: (row) => BILLING_CYCLE[row.cycle] ?? row.cycle },
    { key: 'value', header: 'Valor', numeric: true, render: (row) => fmtCents(row.valueCents) },
    { key: 'created', header: 'Checkout', render: (row) => <Time value={row.createdAt} relative={false} /> },
    { key: 'redeemed', header: '1ª cobrança paga', render: (row) => <Time value={row.redeemedAt} relative={false} /> },
    {
      key: 'subscription',
      header: 'Assinatura',
      render: (row) =>
        row.subscriptionId ? (
          <Link to={`/assinaturas/${row.subscriptionId}`} onClick={(event) => event.stopPropagation()}>
            {row.subscriptionState ? SUBSCRIPTION_STATE[row.subscriptionState]?.label ?? row.subscriptionState : 'ver'}
          </Link>
        ) : (
          <span className="muted">—</span>
        ),
    },
  ];

  if (query.isLoading) {
    return <div className="page"><Skeleton lines={8} /></div>;
  }
  if (!coupon) {
    return (
      <div className="page">
        <PageHeader title="Cupom" crumbs={[{ label: 'Cupons', to: '/cupons' }]} />
        <Empty icon="tag" title="Cupom não encontrado" />
      </div>
    );
  }

  const owner = can('owner');
  const canChangeStart = coupon.status === 'agendado' || (coupon.status === 'desativado' && Date.now() < Date.parse(coupon.startsAt));

  return (
    <div className="page">
      <PageHeader
        title={<span className="row"><code>{coupon.code}</code> <StatusBadge status={coupon.status} /></span>}
        subtitle={coupon.label}
        crumbs={[{ label: 'Cupons', to: '/cupons' }, { label: coupon.code }]}
        actions={
          owner && (
            <>
              <button type="button" className="btn btn--ghost" onClick={() => { setPeriod({ startsAt: toBrasiliaInput(coupon.startsAt), endsAt: toBrasiliaInput(coupon.endsAt) }); setDialog('period'); }}>
                Mudar vigência
              </button>
              {coupon.active ? (
                <button type="button" className="btn btn--danger" onClick={() => setDialog('deactivate')}>Desativar</button>
              ) : (
                <button type="button" className="btn btn--primary" onClick={() => setDialog('activate')}>Ativar</button>
              )}
            </>
          )
        }
      />

      {coupon.status === 'desativado' && (
        <Notice tone="warning" title="Cupom desativado">O checkout recusa este cupom e ele não aparece nas faixas nem na landing.</Notice>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Resgatados" value={fmtNumber(coupon.redeemed)} foot="1ª cobrança paga" />
        <StatTile label="Reservados" value={fmtNumber(coupon.reserved)} foot="checkout feito, ainda não pago" />
        <StatTile label="Receita da 1ª cobrança" value={fmtCents(coupon.redeemedRevenueCents)} foot="soma dos resgatados, valor promocional" />
      </div>

      <div className="grid grid--2">
        <Card title="Vigência" subtitle="Horário de Brasília. O fim é inclusivo até o último segundo.">
          <KeyValue
            items={[
              { label: 'Início', value: fmtBrasilia(coupon.startsAt) },
              { label: 'Fim', value: fmtBrasilia(coupon.endsAt) },
              { label: 'Situação', value: <><StatusBadge status={coupon.status} /> <span className="caption">{COUPON_STATUS[coupon.status]?.hint}</span></> },
              { label: 'Criado', value: fmtDateTime(coupon.createdAt) },
              { label: 'Alterado', value: fmtDateTime(coupon.updatedAt) },
            ]}
          />
        </Card>
        <Card title="Preços promocionais" subtitle="Somente leitura">
          <PromoPrices coupon={coupon} full={coupon.fullPricing} />
          <div style={{ marginTop: 12 }}>
            <Notice tone="info">Os preços não são editáveis pelo painel: anúncios e e-mails já citam esses valores. Depois do período promocional, a assinatura volta sozinha ao preço cheio de Planos.</Notice>
          </div>
        </Card>
      </div>

      <Card flush title="Resgates" subtitle="Sem documento: o CPF/CNPJ só existe como hash no servidor e não aparece aqui.">
        <div className="filters" style={{ padding: '14px 18px' }}>
          <select className="select select--sm" value={stateFilter} onChange={(event) => { setStateFilter(event.target.value); setPage(1); }} aria-label="Uso">
            <option value="">Todos os usos</option>
            {Object.entries(COUPON_REDEMPTION_STATE).map(([key, info]) => <option key={key} value={key}>{info.label}</option>)}
          </select>
        </div>
        <DataTable rows={redemptions.data?.items ?? []} columns={columns} rowKey={(row) => row.id} loading={redemptions.isLoading} empty={<Empty icon="tag" title="Nenhum uso deste cupom ainda" />} />
        {redemptions.data && <Pagination page={redemptions.data.page} pageSize={redemptions.data.pageSize} total={redemptions.data.total} onPage={setPage} />}
      </Card>

      <ConfirmDialog
        open={dialog === 'deactivate'}
        onClose={() => setDialog(null)}
        title={`Desativar ${coupon.code}`}
        description="O checkout passa a recusar o cupom na hora; faixas e landing deixam de mostrá-lo em até 1 minuto. Faturas já abertas com o cupom continuam valendo. Dá para ativar de novo depois."
        confirmLabel="Desativar"
        danger
        confirmWord={coupon.code}
        onConfirm={async (reason) => {
          await api.post(`/coupons/${coupon.id}/deactivate`, { reason });
          toast.push('Cupom desativado.', 'success');
          refresh();
        }}
      />

      <ConfirmDialog
        open={dialog === 'activate'}
        onClose={() => setDialog(null)}
        title={`Ativar ${coupon.code}`}
        description="Dentro da vigência, o cupom volta às faixas e o checkout volta a aceitar."
        confirmLabel="Ativar"
        onConfirm={async (reason) => {
          await api.post(`/coupons/${coupon.id}/activate`, { reason });
          toast.push('Cupom ativado.', 'success');
          refresh();
        }}
      />

      <ConfirmDialog
        open={dialog === 'period'}
        onClose={() => setDialog(null)}
        title={`Vigência de ${coupon.code}`}
        description="Prorrogue ou encerre antes mudando o fim. O início só muda enquanto o cupom não começou."
        confirmLabel="Salvar"
        onConfirm={async (reason) => {
          const body: Record<string, unknown> = { reason };
          const startsAt = fromBrasiliaInput(period.startsAt);
          const endsAt = fromBrasiliaInput(period.endsAt);
          if (!endsAt) throw new Error('Informe o fim da vigência.');
          if (canChangeStart) {
            if (!startsAt) throw new Error('Informe o início da vigência.');
            if (Date.parse(startsAt) !== Date.parse(coupon.startsAt)) body['startsAt'] = startsAt;
          }
          if (Date.parse(endsAt) <= Date.parse(startsAt ?? coupon.startsAt)) throw new Error('O fim precisa ficar depois do início.');
          if (Date.parse(endsAt) !== Date.parse(coupon.endsAt)) body['endsAt'] = endsAt;
          await api.patch(`/coupons/${coupon.id}`, body);
          toast.push('Vigência atualizada.', 'success');
          refresh();
        }}
      >
        <div className="form-grid">
          <label className="field">
            <span className="field__label">Início (Brasília)</span>
            <input className="input" type="datetime-local" step={1} value={period.startsAt} disabled={!canChangeStart} onChange={(event) => setPeriod({ ...period, startsAt: event.target.value })} />
            {!canChangeStart && <span className="field__hint">O cupom já começou: o início não muda mais.</span>}
          </label>
          <label className="field">
            <span className="field__label">Fim (Brasília, inclusivo)</span>
            <input className="input" type="datetime-local" step={1} value={period.endsAt} onChange={(event) => setPeriod({ ...period, endsAt: event.target.value })} />
          </label>
        </div>
      </ConfirmDialog>
    </div>
  );
}
