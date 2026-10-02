import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { api, download } from '../api/client';
import type { Movement, Page, Product } from '../api/types';
import { Icon } from '../components/Icon';
import { MovementAmount, TypeBadge } from '../components/stock/MovementBits';
import { Badge, Card, Chips, ConfirmDialog, Empty, Field, Notice, PageHeader, Pagination, QueryState, SearchInput, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { fmtDateTime, fmtStock, plural } from '../lib/format';
import { inventoryKeys, useDebounced, useInvalidateInventory } from '../lib/inventory';
import { movementLabel } from '../lib/labels';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-stock.css';

const PAGE_SIZE = 50;

/** Filtro da URL (`tipo`) → parâmetro `direction` da API. */
const DIRECTION = { entradas: 'in', saidas: 'out', ajustes: 'adjust' } as const;
type TypeFilter = 'todas' | keyof typeof DIRECTION;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Dia vindo da URL ("2026-03-14") → instante no fuso de quem está olhando.
 * Valor adulterado na URL é ignorado em vez de virar erro de validação.
 */
function dayBoundary(day: string, end: boolean): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return undefined;
  const date = new Date(`${day}T${end ? '23:59:59.999' : '00:00:00'}`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/**
 * Histórico de movimentações: tudo o que entrou, saiu ou foi corrigido, do
 * mais recente para o mais antigo. Os filtros vivem na URL (o estoque abre
 * esta tela já filtrada por produto). Nada é apagado aqui: estornar grava o
 * lançamento contrário e a movimentação original continua visível.
 */
export function HistoryPage() {
  const { workspaceId, base, can } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const allowed = can('movimentacoes.ver');

  const productParam = params.get('produto') ?? '';
  const productId = UUID.test(productParam) ? productParam.toLowerCase() : '';
  const urlQuery = params.get('q') ?? '';
  const typeParam = params.get('tipo') ?? '';
  const type: TypeFilter = typeParam in DIRECTION ? (typeParam as keyof typeof DIRECTION) : 'todas';
  const fromDay = params.get('de') ?? '';
  const toDay = params.get('ate') ?? '';
  const page = Math.max(1, Number(params.get('pagina')) || 1);

  const [search, setSearch] = useState(urlQuery);
  const debounced = useDebounced(search.trim());

  const update = (changes: Record<string, string | null>, resetPage = true) => {
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        if (resetPage) next.delete('pagina');
        for (const [key, value] of Object.entries(changes)) {
          if (value === null || value === '') next.delete(key);
          else next.set(key, value);
        }
        return next;
      },
      { replace: true },
    );
  };

  // Mesma ida e volta da busca do estoque: o texto vai para a URL depois da
  // pausa, e voltar/avançar do navegador devolve o texto ao campo.
  useEffect(() => {
    if (debounced !== urlQuery) update({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    setSearch((current) => (current.trim() === urlQuery ? current : urlQuery));
  }, [urlQuery]);

  const list = useQuery({
    // Na chave vão os valores da URL (texto); as datas são derivadas deles.
    queryKey: [...inventoryKeys.movements(workspaceId), 'list', { productId, q: urlQuery, type, fromDay, toDay, page }],
    queryFn: () =>
      api.get<Page<Movement>>(`${base}/movements`, {
        productId: productId || undefined,
        q: urlQuery || undefined,
        direction: type === 'todas' ? undefined : DIRECTION[type],
        from: dayBoundary(fromDay, false),
        to: dayBoundary(toDay, true),
        page,
        pageSize: PAGE_SIZE,
      }),
    placeholderData: keepPreviousData,
    enabled: allowed,
  });

  // Nome do produto filtrado. Produto já excluído responde 404 aqui; nesse
  // caso o nome vem das próprias movimentações, que guardam o nome da época.
  const product = useQuery({
    queryKey: inventoryKeys.product(workspaceId, productId),
    queryFn: () => api.get<Product>(`${base}/products/${productId}`),
    enabled: allowed && productId !== '' && can('produtos.ver'),
  });

  const [cancelling, setCancelling] = useState<Movement | null>(null);
  const [cancelNote, setCancelNote] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    if (cancelling) setCancelNote('');
  }, [cancelling]);

  const cancel = async (movement: Movement) => {
    const note = cancelNote.trim();
    const result = await api.post<{ movementId: string; product: Product }>(`${base}/movements/${movement.id}/cancel`, note ? { note } : {});
    invalidate();
    track('movement.cancelled');
    toast.success(`Movimentação estornada. Estoque de “${result.product.name}”: ${fmtStock(result.product.quantity, result.product.unit)}.`);
  };

  const exportCsv = async () => {
    setExporting(true);
    try {
      // A exportação da API não aceita filtros: sai o histórico inteiro.
      await download(`${base}/export/movimentacoes.csv`, 'movimentacoes.csv');
      track('export.completed', { format: 'csv' });
    } catch (error) {
      toast.error(error);
    } finally {
      setExporting(false);
    }
  };

  if (!allowed) {
    return (
      <div className="page">
        <PageHeader title="Histórico" />
        <Card>
          <Empty icon="lock" title="Seu acesso não inclui o histórico">
            Peça a quem administra a empresa para liberar a visualização das movimentações.
          </Empty>
        </Card>
      </div>
    );
  }

  const items = list.data?.items ?? [];
  const total = list.data?.total ?? 0;
  const filtered = productId !== '' || urlQuery !== '' || type !== 'todas' || fromDay !== '' || toDay !== '';
  const productName = product.data?.name ?? items[0]?.productName ?? null;
  const canCancel = can('movimentacoes.cancelar');
  const today = new Date().toLocaleDateString('en-CA');

  const clearFilters = () => {
    setSearch('');
    update({ produto: null, q: null, tipo: null, de: null, ate: null });
  };

  const flags = (movement: Movement) => (
    <>
      {movement.reversedBy && <Badge>Estornada</Badge>}
      {movement.productDeleted && <Badge>Produto excluído</Badge>}
    </>
  );

  const lateEntry = (movement: Movement) =>
    movement.lateEntry && (
      <span className="caption" title={`Registrada em ${fmtDateTime(movement.recordedAt)}`}>
        lançada depois
      </span>
    );

  const cancelButton = (movement: Movement, compact: boolean) =>
    canCancel &&
    movement.canCancel &&
    (compact ? (
      <button type="button" className="icon-btn" aria-label={`Estornar ${movementLabel(movement.type).toLowerCase()} de ${movement.productName}`} onClick={() => setCancelling(movement)}>
        <Icon name="undo" />
      </button>
    ) : (
      <button type="button" className="btn btn--ghost btn--sm" aria-label={`Estornar ${movementLabel(movement.type).toLowerCase()} de ${movement.productName}`} onClick={() => setCancelling(movement)}>
        <Icon name="undo" size={15} /> Estornar
      </button>
    ));

  return (
    <div className="page">
      <PageHeader
        title="Histórico"
        subtitle={list.data ? `${plural(total, 'movimentação', 'movimentações')}${filtered ? ' com estes filtros' : ''}` : undefined}
        actions={
          <button type="button" className="btn btn--secondary" onClick={() => void exportCsv()} disabled={exporting} title="Baixa o histórico completo, sem os filtros da tela">
            <Icon name="download" size={17} /> {exporting ? 'Preparando…' : 'Exportar tudo (CSV)'}
          </button>
        }
      />

      {productId !== '' && (
        <Notice
          tone="info"
          action={
            <button type="button" className="btn btn--secondary btn--sm" onClick={() => update({ produto: null })}>
              Ver todos os produtos
            </button>
          }
        >
          Mostrando só as movimentações de <strong>{productName ? `“${productName}”` : 'um produto'}</strong>.
        </Notice>
      )}

      <div className="toolbar no-print">
        <SearchInput value={search} onChange={setSearch} placeholder="Buscar pelo nome do produto" />
        <div className="date-range">
          <label className="date-range__field">
            De
            <input className="input" type="date" value={fromDay} max={toDay || today} onChange={(event) => update({ de: event.target.value })} />
          </label>
          <label className="date-range__field">
            Até
            <input className="input" type="date" value={toDay} min={fromDay || undefined} max={today} onChange={(event) => update({ ate: event.target.value })} />
          </label>
        </div>
      </div>

      <Chips<TypeFilter>
        label="Tipo de movimentação"
        value={type}
        onChange={(value) => update({ tipo: value === 'todas' ? null : value })}
        items={[
          { key: 'todas', label: 'Todas' },
          { key: 'entradas', label: 'Entradas' },
          { key: 'saidas', label: 'Saídas' },
          { key: 'ajustes', label: 'Ajustes' },
        ]}
      />

      <Card flush>
        {list.isLoading || (list.error && !list.data) ? (
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <Empty icon="search" title="Nenhuma movimentação encontrada" actions={<button type="button" className="btn btn--secondary btn--sm" onClick={clearFilters}>Limpar filtros</button>}>
              Confira o período e os filtros escolhidos.
            </Empty>
          ) : (
            <Empty icon="history" title="Nenhuma movimentação ainda" actions={<Link to="/app/estoque" className="btn btn--secondary">Ir para o estoque</Link>}>
              Entradas, saídas e ajustes aparecem aqui assim que forem registrados.
            </Empty>
          )
        ) : (
          <>
            <div className="table-wrap hide-mobile" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Data</th>
                    <th>Tipo</th>
                    <th>Produto</th>
                    <th className="num">Quantidade</th>
                    <th className="num">Estoque depois</th>
                    <th>Quem</th>
                    <th aria-label="Ações" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((movement) => (
                    <tr key={movement.id} className={movement.reversedBy ? 'is-reversed' : undefined}>
                      <td className="nowrap">
                        <div>{fmtDateTime(movement.occurredAt)}</div>
                        {lateEntry(movement)}
                      </td>
                      <td>
                        <TypeBadge movement={movement} />
                      </td>
                      <td style={{ maxWidth: 340 }}>
                        <div className="row row--wrap" style={{ gap: 6 }}>
                          <span className="product-row__name">{movement.productName}</span>
                          {flags(movement)}
                        </div>
                        {movement.note && <div className="product-row__meta">{movement.note}</div>}
                      </td>
                      <td className="num">
                        <MovementAmount movement={movement} />
                      </td>
                      <td className="num nowrap">{movement.balanceAfter === null ? <span className="faint">—</span> : fmtStock(movement.balanceAfter, movement.unit)}</td>
                      <td className="muted">{movement.createdByName ?? '—'}</td>
                      <td>
                        <div className="row-actions">{cancelButton(movement, false)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="list show-mobile" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              {items.map((movement) => (
                <div key={movement.id} className={`list__item history-item ${movement.reversedBy ? 'is-reversed' : ''}`}>
                  <div className="list__main">
                    <div className="row row--wrap" style={{ gap: 6 }}>
                      <TypeBadge movement={movement} />
                      {flags(movement)}
                    </div>
                    <div className="list__title" style={{ marginTop: 4 }}>{movement.productName}</div>
                    {movement.note && <div className="list__sub">{movement.note}</div>}
                    <div className="list__sub">
                      {fmtDateTime(movement.occurredAt)}
                      {movement.createdByName && ` · ${movement.createdByName}`}
                      {movement.lateEntry && <> · {lateEntry(movement)}</>}
                    </div>
                  </div>
                  <div className="list__meta">
                    <MovementAmount movement={movement} />
                    {movement.balanceAfter !== null && <span className="nowrap">ficou {fmtStock(movement.balanceAfter, movement.unit)}</span>}
                    {cancelButton(movement, true)}
                  </div>
                </div>
              ))}
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={total} onPage={(next) => update({ pagina: next > 1 ? String(next) : null }, false)} />
          </>
        )}
      </Card>

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Estornar movimentação?"
        description={
          cancelling ? (
            <>
              {movementLabel(cancelling.type)} de <strong>{fmtStock(Math.abs(cancelling.quantity), cancelling.unit)}</strong> em “{cancelling.productName}”: o estoque volta ao que era antes, com
              um lançamento contrário. A movimentação original continua no histórico, marcada como estornada.
            </>
          ) : undefined
        }
        confirmLabel="Estornar"
        danger
        onConfirm={() => (cancelling ? cancel(cancelling) : undefined)}
      >
        <Field label="Motivo" optional>
          <input className="input" value={cancelNote} onChange={(event) => setCancelNote(event.target.value)} maxLength={500} placeholder="Ex.: lançamento em duplicidade" />
        </Field>
      </ConfirmDialog>
    </div>
  );
}
