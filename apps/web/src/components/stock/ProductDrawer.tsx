import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';

import { api } from '../../api/client';
import type { Movement, Page, Product } from '../../api/types';
import { fmtDateTime, fmtMoney, fmtQuantity, fmtStock } from '../../lib/format';
import { inventoryKeys } from '../../lib/inventory';
import { useCurrentWorkspace } from '../../workspace/WorkspaceProvider';
import { Icon } from '../Icon';
import { Badge, Drawer, KeyValue, QueryState, Time } from '../ui';
import { MovementAmount, TypeBadge } from './MovementBits';

/** Detalhe do produto: saldo, cadastro e as últimas movimentações. */
export function ProductDrawer({
  productId,
  onClose,
  onEdit,
  onMove,
}: {
  productId: string | null;
  onClose: () => void;
  onEdit: (product: Product) => void;
  onMove: (product: Product, type: 'entrada' | 'saida') => void;
}) {
  const { workspaceId, base, can, currency } = useCurrentWorkspace();
  const open = productId !== null;

  const product = useQuery({
    queryKey: inventoryKeys.product(workspaceId, productId ?? ''),
    queryFn: () => api.get<Product>(`${base}/products/${productId}`),
    enabled: open,
  });
  const movements = useQuery({
    queryKey: [...inventoryKeys.movements(workspaceId), 'recent', productId],
    queryFn: () => api.get<Page<Movement>>(`${base}/movements`, { productId, pageSize: 8 }),
    enabled: open && can('movimentacoes.ver'),
  });

  const item = product.data;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={item?.name ?? 'Produto'}
      subtitle={item?.category ?? undefined}
      footer={
        item && (
          <>
            {can('produtos.editar') && (
              <button type="button" className="btn btn--ghost" onClick={() => onEdit(item)}>
                <Icon name="edit" size={16} /> Editar
              </button>
            )}
            <span className="spacer" />
            {can('movimentacoes.saida') && (
              <button type="button" className="btn btn--out" onClick={() => onMove(item, 'saida')} disabled={item.quantity <= 0}>
                <Icon name="minus" size={16} /> Saída
              </button>
            )}
            {can('movimentacoes.entrada') && (
              <button type="button" className="btn btn--in" onClick={() => onMove(item, 'entrada')}>
                <Icon name="plus" size={16} /> Entrada
              </button>
            )}
          </>
        )
      }
    >
      {!item ? (
        <QueryState loading={product.isLoading} error={product.error} onRetry={() => void product.refetch()} />
      ) : (
        <div className="stack stack--loose">
          <div className="row row--between" style={{ alignItems: 'flex-end' }}>
            <div>
              <div className="caption">Em estoque</div>
              <div className={`qty ${item.lowStock ? 'qty--low' : ''}`} style={{ fontSize: 30, lineHeight: 1.1 }}>
                {fmtQuantity(item.quantity)} <span className="qty__unit" style={{ fontSize: 15 }}>{item.unit || 'un'}</span>
              </div>
            </div>
            {item.outOfStock ? <Badge tone="error">Sem estoque</Badge> : item.lowStock ? <Badge tone="warning">Estoque baixo</Badge> : null}
          </div>

          <KeyValue
            items={[
              { label: 'Valor unitário', value: fmtMoney(item.unitValue, currency) },
              { label: 'Valor em estoque', value: fmtMoney(item.unitValue * item.quantity, currency) },
              { label: 'Estoque mínimo', value: item.minStock > 0 ? fmtStock(item.minStock, item.unit) : '—' },
              { label: 'SKU / código', value: item.sku ?? '—' },
              { label: 'Código de barras', value: item.barcode ? <span className="mono">{item.barcode}</span> : '—' },
              { label: 'Fornecedor', value: item.supplier ?? '—' },
              { label: 'Localização', value: item.location ?? '—' },
              { label: 'Atualizado', value: <Time value={item.updatedAt} /> },
            ]}
          />

          {item.description && (
            <div>
              <div className="caption">Descrição</div>
              <p style={{ whiteSpace: 'pre-wrap' }}>{item.description}</p>
            </div>
          )}

          {can('movimentacoes.ver') && (
            <div>
              <div className="row row--between" style={{ marginBottom: 8 }}>
                <div className="form-section" style={{ margin: 0 }}>Últimas movimentações</div>
                <Link to={`/app/historico?produto=${item.id}`} onClick={onClose} style={{ fontSize: 'var(--fs-label)' }}>
                  Ver todas
                </Link>
              </div>
              {movements.data && movements.data.items.length > 0 ? (
                <div className="list" style={{ margin: '0 calc(var(--card-padding) * -1)' }}>
                  {movements.data.items.map((movement) => (
                    <div key={movement.id} className="list__item">
                      <div className="list__main">
                        <div className="row" style={{ gap: 8 }}>
                          <TypeBadge movement={movement} />
                          <span className="list__sub">{fmtDateTime(movement.occurredAt)}</span>
                        </div>
                        {movement.note && <div className="list__sub truncate">{movement.note}</div>}
                      </div>
                      <div className="list__meta">
                        <MovementAmount movement={movement} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : movements.isLoading ? (
                <QueryState loading error={null} />
              ) : (
                <p className="muted">Nenhuma movimentação ainda.</p>
              )}
            </div>
          )}
        </div>
      )}
    </Drawer>
  );
}
