import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, type Paginated } from '../api/client';
import { Badge, Card, DataTable, Empty, PageHeader, Pagination, StatTile, Tabs, Time, type Column } from '../components/ui';
import { fmtNumber } from '../lib/format';

interface KindRow {
  kind: string;
  label: string;
  total: number;
  sent: number;
  dry_run: number;
  failed: number;
  delivered: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  bounced: number;
  complained: number;
  activated_3d: number;
  returned_3d: number;
}

interface Summary {
  mode: 'off' | 'dry_run' | 'send';
  webhookConfigured: boolean;
  limits: { lifecycleDaily: number; totalDaily: number };
  today: { total: number; lifecycle: number };
  kinds: KindRow[];
}

interface EmailRow {
  id: string;
  userId: string;
  name: string;
  email: string;
  kind: string;
  label: string;
  status: 'sent' | 'dry_run' | 'failed';
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  openedAt: string | null;
  clickedAt: string | null;
  unsubscribedAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
}

interface Template {
  kind: string;
  label: string;
  subject: string;
  text: string;
}

const MODE_LABEL: Record<Summary['mode'], { label: string; tone: 'success' | 'warning' | 'neutral' }> = {
  send: { label: 'Enviando', tone: 'success' },
  dry_run: { label: 'Simulação (nada é enviado)', tone: 'warning' },
  off: { label: 'Desligado', tone: 'neutral' },
};

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

/**
 * Funil de e-mails automáticos do ciclo de vida (ativação, confirmação,
 * reengajamento, limite do plano): o que o sistema decidiu e enviou, e o que
 * aconteceu depois. Somente leitura; o modo (simulação/envio) e os tetos
 * diários ficam nas variáveis de ambiente (docs/emails-ciclo-de-vida.md).
 */
export function LifecyclePage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'funil' | 'envios' | 'textos'>('funil');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);

  const summary = useQuery({ queryKey: ['lifecycle-summary'], queryFn: () => api.get<Summary>('/lifecycle/summary') });
  const emails = useQuery({
    queryKey: ['lifecycle-emails', page, pageSize],
    queryFn: () => api.get<Paginated<EmailRow>>('/lifecycle/emails', { page, pageSize }),
    enabled: tab === 'envios',
    placeholderData: (previous) => previous,
  });
  const templates = useQuery({ queryKey: ['lifecycle-templates'], queryFn: () => api.get<{ items: Template[] }>('/lifecycle/templates'), enabled: tab === 'textos' });

  const data = summary.data;
  const totals = (data?.kinds ?? []).reduce(
    (acc, row) => ({
      decided: acc.decided + row.total,
      sent: acc.sent + row.sent,
      opened: acc.opened + row.opened,
      clicked: acc.clicked + row.clicked,
      activated: acc.activated + row.activated_3d,
      unsubscribed: acc.unsubscribed + row.unsubscribed,
      bounced: acc.bounced + row.bounced,
      complained: acc.complained + row.complained,
    }),
    { decided: 0, sent: 0, opened: 0, clicked: 0, activated: 0, unsubscribed: 0, bounced: 0, complained: 0 },
  );

  const kindColumns: Array<Column<KindRow>> = [
    { key: 'label', header: 'E-mail', render: (row) => <span className="cell-main">{row.label}</span> },
    { key: 'decided', header: 'Decididos', numeric: true, render: (row) => fmtNumber(row.total) },
    { key: 'sent', header: 'Enviados', numeric: true, render: (row) => (row.dry_run ? <span title={`${row.dry_run} em simulação`}>{fmtNumber(row.sent)} <span className="muted">(+{row.dry_run} sim.)</span></span> : fmtNumber(row.sent)) },
    { key: 'opened', header: 'Aberturas', numeric: true, render: (row) => `${fmtNumber(row.opened)} · ${pct(row.opened, row.sent)}` },
    { key: 'clicked', header: 'Cliques', numeric: true, render: (row) => `${fmtNumber(row.clicked)} · ${pct(row.clicked, row.sent)}` },
    { key: 'activated', header: 'Ativou em 3 dias', numeric: true, render: (row) => fmtNumber(row.activated_3d) },
    { key: 'returned', header: 'Voltou em 3 dias', numeric: true, render: (row) => fmtNumber(row.returned_3d) },
    { key: 'unsub', header: 'Descadastros', numeric: true, render: (row) => fmtNumber(row.unsubscribed) },
    { key: 'problems', header: 'Bounce / spam', numeric: true, render: (row) => `${fmtNumber(row.bounced)} / ${fmtNumber(row.complained)}` },
  ];

  const emailColumns: Array<Column<EmailRow>> = [
    { key: 'when', header: 'Quando', render: (row) => <Time value={row.createdAt} /> },
    {
      key: 'who',
      header: 'Conta',
      render: (row) => (
        <div>
          <div className="cell-main">{row.name}</div>
          <div className="cell-sub">{row.email}</div>
        </div>
      ),
    },
    { key: 'kind', header: 'E-mail', render: (row) => row.label },
    {
      key: 'status',
      header: 'Situação',
      render: (row) =>
        row.status === 'failed' ? (
          <Badge tone="error">falhou</Badge>
        ) : row.status === 'dry_run' ? (
          <Badge tone="warning">simulado</Badge>
        ) : (
          <Badge tone="success">enviado</Badge>
        ),
    },
    {
      key: 'interaction',
      header: 'Interação',
      render: (row) => (
        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
          {row.deliveredAt && <Badge plain>entregue</Badge>}
          {row.openedAt && <Badge tone="info">abriu</Badge>}
          {row.clickedAt && <Badge tone="success">clicou</Badge>}
          {row.unsubscribedAt && <Badge tone="warning">descadastrou</Badge>}
          {row.bouncedAt && <Badge tone="error">bounce</Badge>}
          {row.complainedAt && <Badge tone="error">spam</Badge>}
          {!row.deliveredAt && !row.openedAt && !row.clickedAt && !row.unsubscribedAt && !row.bouncedAt && !row.complainedAt && <span className="muted">—</span>}
        </div>
      ),
    },
  ];

  return (
    <div className="page">
      <PageHeader
        title="E-mails automáticos"
        subtitle="Funil de ativação e recuperação: o sistema decide sozinho, a cada hora, quem recebe cada e-mail."
        actions={data && <Badge tone={MODE_LABEL[data.mode].tone}>{MODE_LABEL[data.mode].label}</Badge>}
      />

      {data && data.mode !== 'send' && (
        <Card>
          <p style={{ margin: 0 }}>
            {data.mode === 'dry_run'
              ? 'Em simulação: o sistema registra quem receberia cada e-mail, sem enviar. Confira a aba Envios e, quando estiver tudo certo, ligue o envio (LIFECYCLE_EMAILS_MODE=send no Railway).'
              : 'Desligado: nenhum e-mail automático é decidido nem enviado.'}{' '}
            {!data.webhookConfigured && 'O webhook do Resend ainda não está configurado (RESEND_WEBHOOK_SECRET): sem ele não há entregas, aberturas, bounces nem supressão de endereços, e o envio não deve ser ligado.'}
          </p>
        </Card>
      )}

      <div className="grid grid--tiles">
        <StatTile label="Decididos" value={fmtNumber(totals.decided)} foot={`${fmtNumber(totals.sent)} enviados`} />
        <StatTile label="Taxa de abertura" value={pct(totals.opened, totals.sent)} foot="depende do rastreio de aberturas no Resend" />
        <StatTile label="Taxa de clique" value={pct(totals.clicked, totals.sent)} />
        <StatTile label="Ativaram em 3 dias" value={fmtNumber(totals.activated)} hint="Cadastrou produto até 3 dias depois do e-mail. Indicador otimista: parte ativaria de qualquer jeito." />
        <StatTile
          label="Hoje (cota)"
          value={data ? `${fmtNumber(data.today.lifecycle)} / ${fmtNumber(data.limits.lifecycleDaily)}` : '—'}
          foot={data ? `todos os e-mails: ${fmtNumber(data.today.total)} / ${fmtNumber(data.limits.totalDaily)}` : undefined}
          tone={totals.complained > 0 && totals.sent > 0 && totals.complained / totals.sent > 0.003 ? 'alert' : undefined}
        />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { key: 'funil', label: 'Funil por e-mail' },
          { key: 'envios', label: 'Envios' },
          { key: 'textos', label: 'Textos' },
        ]}
      />

      {tab === 'funil' && (
        <Card flush>
          <DataTable rows={data?.kinds ?? []} columns={kindColumns} rowKey={(row) => row.kind} loading={summary.isLoading} empty={<Empty icon="mail" title="Nada ainda">Os e-mails aparecem aqui quando o sistema decidir o primeiro envio.</Empty>} />
        </Card>
      )}

      {tab === 'envios' && (
        <Card flush>
          <DataTable
            rows={emails.data?.items ?? []}
            columns={emailColumns}
            rowKey={(row) => row.id}
            onRowClick={(row) => navigate(`/usuarios/${row.userId}`)}
            loading={emails.isLoading}
            empty={<Empty icon="mail" title="Nenhum envio ainda">Assim que alguém entrar numa etapa do funil, o envio (ou a simulação) aparece aqui.</Empty>}
          />
          {emails.data && (
            <Pagination page={emails.data.page} pageSize={emails.data.pageSize} total={emails.data.total} onPage={setPage} onPageSize={(size) => { setPageSize(size); setPage(1); }} />
          )}
        </Card>
      )}

      {tab === 'textos' && (
        <div className="stack">
          {(templates.data?.items ?? []).map((item) => (
            <Card key={item.kind} title={item.label} subtitle={`Assunto: ${item.subject}`}>
              <pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit', lineHeight: 1.5 }}>{item.text}</pre>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
