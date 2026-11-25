import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../api/client';
import type { BatchPage } from '../api/types';
import { Badge, Card, Chips, Empty, Notice, PageHeader, Pagination, QueryState, Tile } from '../components/ui';
import { fmtDate, fmtStock } from '../lib/format';
import { inventoryKeys } from '../lib/inventory';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

const JANELAS = { '7': 7, '30': 30, '90': 90 } as const;
type Janela = keyof typeof JANELAS;

/** Quanto falta, em palavras de prateleira. */
function prazo(days: number | null): { label: string; tone: 'error' | 'warning' | 'neutral' } {
  if (days === null) return { label: 'Sem validade', tone: 'neutral' };
  if (days < 0) return { label: days === -1 ? 'Venceu ontem' : `Venceu há ${Math.abs(days)} dias`, tone: 'error' };
  if (days === 0) return { label: 'Vence hoje', tone: 'error' };
  if (days === 1) return { label: 'Vence amanhã', tone: 'warning' };
  return { label: `Faltam ${days} dias`, tone: days <= 30 ? 'warning' : 'neutral' };
}

/**
 * Validades: os lotes em estoque, o que vence primeiro na frente.
 *
 * Nada aqui é editável — lote não é cadastro, é o que as entradas contaram.
 * Para corrigir, a pessoa estorna a entrada e lança de novo, que é a mesma
 * regra do resto do estoque: movimentação é fato, não campo.
 */
export function ExpiryPage() {
  const { workspaceId, base, tracksBatches } = useCurrentWorkspace();
  const [janela, setJanela] = useState<Janela>('30');
  const [somenteProximos, setSomenteProximos] = useState(true);
  const [page, setPage] = useState(1);

  const list = useQuery({
    queryKey: [...inventoryKeys.batches(workspaceId), janela, somenteProximos, page],
    queryFn: () =>
      api.get<BatchPage>(
        `${base}/batches?window=${JANELAS[janela]}&filter=${somenteProximos ? 'expiring' : 'all'}&page=${page}&pageSize=50`,
      ),
    placeholderData: (previous) => previous,
  });

  if (!tracksBatches) {
    return (
      <div className="stack">
        <PageHeader title="Validades" />
        <Empty
          icon="box"
          title="Controle de lote e validade desligado"
          actions={<Link to="/app/opcoes" className="btn btn--primary">Ir para Opções</Link>}
        >
          Ligue em Opções para registrar lote, fabricação e validade nas entradas e acompanhar aqui o que vence primeiro.
        </Empty>
      </div>
    );
  }

  const items = list.data?.items ?? [];
  const resumo = list.data?.summary;

  return (
    <div className="stack">
      <PageHeader title="Validades" subtitle="Lotes em estoque, o que vence primeiro na frente" />

      {resumo && (
        <div className="grid grid--tiles">
          <Tile label="Vencidos" value={String(resumo.expired)} foot={resumo.expiredQuantity > 0 ? `${fmtStock(resumo.expiredQuantity, null)} em estoque` : undefined} alert={resumo.expired > 0} />
          <Tile label={`Vencem em ${JANELAS[janela]} dias`} value={String(resumo.expiringSoon)} alert={resumo.expiringSoon > 0} />
          <Tile label="Lotes acompanhados" value={String(resumo.tracked)} foot={`${fmtStock(resumo.trackedQuantity, null)} em estoque`} />
        </div>
      )}

      {resumo && resumo.withoutBatch > 0 && (
        <Notice tone="info">
          {fmtStock(resumo.withoutBatch, null)} em estoque entraram sem lote informado e não aparecem na lista. As próximas
          entradas com lote passam a ser acompanhadas.
        </Notice>
      )}

      <div className="row row--wrap">
        <Chips
          label="Prazo"
          value={janela}
          onChange={(value) => {
            setJanela(value);
            setPage(1);
          }}
          items={[
            { key: '7', label: '7 dias' },
            { key: '30', label: '30 dias' },
            { key: '90', label: '90 dias' },
          ]}
        />
        <Chips
          label="Mostrar"
          value={somenteProximos ? 'proximos' : 'todos'}
          onChange={(value) => {
            setSomenteProximos(value === 'proximos');
            setPage(1);
          }}
          items={[
            { key: 'proximos', label: 'Só o que vence' },
            { key: 'todos', label: 'Todos os lotes' },
          ]}
        />
      </div>

      <Card flush>
        {list.isLoading || (list.error && !list.data) ? (
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          <Empty icon="box" title={somenteProximos ? 'Nada vencendo nesse prazo' : 'Nenhum lote em estoque'}>
            {somenteProximos
              ? 'Aumente o prazo ou veja todos os lotes.'
              : 'Registre o lote e a validade nas entradas de estoque para acompanhar aqui.'}
          </Empty>
        ) : (
          <>
            <div className="table-wrap" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Validade</th>
                    <th>Produto</th>
                    <th>Lote</th>
                    <th>Fabricação</th>
                    <th className="num">Em estoque</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((batch) => {
                    const quanto = prazo(batch.daysToExpire);
                    return (
                      <tr key={`${batch.productId}-${batch.batchCode ?? ''}-${batch.expiresOn ?? ''}`}>
                        <td className="nowrap">
                          <div>{fmtDate(batch.expiresOn)}</div>
                          <Badge tone={quanto.tone}>{quanto.label}</Badge>
                        </td>
                        <td>
                          <Link to={`/app/historico?produto=${batch.productId}`}>{batch.productName ?? '—'}</Link>
                        </td>
                        <td>{batch.batchCode ?? '—'}</td>
                        <td className="nowrap">{fmtDate(batch.manufacturedOn)}</td>
                        <td className="num nowrap">{fmtStock(batch.quantity, batch.unit)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <Pagination page={page} pageSize={list.data?.pageSize ?? 50} total={list.data?.total ?? 0} onPage={setPage} />
          </>
        )}
      </Card>
    </div>
  );
}
