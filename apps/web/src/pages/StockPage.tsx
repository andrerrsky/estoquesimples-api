import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';

import { api, errorMessage } from '../api/client';
import type { Conflict, Facets, Product, ProductList } from '../api/types';
import { BarcodeScanner, barcodeScanningSupported } from '../components/BarcodeScanner';
import { Icon } from '../components/Icon';
import { MovementDialog } from '../components/stock/MovementDialog';
import { ProductDrawer } from '../components/stock/ProductDrawer';
import { ProductForm } from '../components/stock/ProductForm';
import { Card, Chips, ConfirmDialog, Empty, Field, Menu, Modal, Notice, PageHeader, Pagination, QueryState, SearchInput, useToast, type MenuItem } from '../components/ui';
import { track } from '../lib/analytics';
import { fmtMoney, fmtQuantity, parseNumber, plural } from '../lib/format';
import { inventoryKeys, SYNC_HEADERS, useDebounced, useInvalidateInventory } from '../lib/inventory';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

const PAGE_SIZE = 50;

const SORTS = [
  { key: 'name.asc', label: 'Nome (A–Z)' },
  { key: 'name.desc', label: 'Nome (Z–A)' },
  { key: 'quantity.asc', label: 'Menor quantidade' },
  { key: 'quantity.desc', label: 'Maior quantidade' },
  { key: 'value.desc', label: 'Maior valor em estoque' },
  { key: 'updated.desc', label: 'Alterados recentemente' },
] as const;

type SortKey = (typeof SORTS)[number]['key'];
type BulkAction = 'adjust' | 'category' | 'supplier';

/**
 * Tela principal: a lista de produtos com busca, filtros e as ações do dia a
 * dia (entrada, saída, cadastro). Os filtros vivem na URL, então dá para
 * favoritar "estoque baixo" ou voltar do detalhe sem perder a posição.
 */
export function StockPage() {
  const { workspaceId, base, can, entitlement, currency } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);

  const urlQuery = params.get('q') ?? '';
  const lowOnly = params.get('filtro') === 'baixo';
  const category = params.get('categoria') ?? '';
  const sort = (SORTS.some((item) => item.key === params.get('ordem')) ? params.get('ordem') : 'name.asc') as SortKey;
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

  // A busca digitada vai para a URL depois da pausa; voltar/avançar do
  // navegador devolve o texto ao campo.
  useEffect(() => {
    if (debounced !== urlQuery) update({ q: debounced });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debounced]);
  useEffect(() => {
    setSearch((current) => (current.trim() === urlQuery ? current : urlQuery));
  }, [urlQuery]);

  const [sortField, sortOrder] = sort.split('.') as [string, string];
  const filters = { q: urlQuery, lowStock: lowOnly ? 'true' : undefined, category: category || undefined, sort: sortField, order: sortOrder, page, pageSize: PAGE_SIZE };

  const list = useQuery({
    queryKey: [...inventoryKeys.products(workspaceId), filters],
    queryFn: () => api.get<ProductList>(`${base}/products`, filters),
    placeholderData: keepPreviousData,
  });
  const facets = useQuery({ queryKey: inventoryKeys.facets(workspaceId), queryFn: () => api.get<Facets>(`${base}/products/facets`), staleTime: 60_000 });
  const conflicts = useQuery({
    queryKey: [...inventoryKeys.conflicts(workspaceId), 'pending-count'],
    queryFn: () => api.get<{ conflicts: Conflict[]; pending: number }>(`${base}/conflicts`, { status: 'pendente', limit: 1 }, { headers: SYNC_HEADERS }),
    enabled: can('conflitos.ver'),
    staleTime: 60_000,
  });

  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<Product | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [moving, setMoving] = useState<{ product: Product; type: 'entrada' | 'saida' } | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);
  const [scanning, setScanning] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);

  // A seleção vale para o que está na tela: mudar filtro ou página limpa.
  useEffect(() => setSelected(new Set()), [urlQuery, lowOnly, category, sort, page, workspaceId]);

  // Atalho vindo de outras telas: /app/estoque?novo=1 abre o cadastro.
  useEffect(() => {
    if (params.get('novo') === '1') {
      setEditing(null);
      setFormOpen(true);
      update({ novo: null }, false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  const restore = useMutation({
    mutationFn: (productId: string) => api.post<Product>(`${base}/products/${productId}/restore`),
    onSuccess: (product) => {
      invalidate();
      toast.success(`“${product.name}” voltou ao estoque.`);
    },
    onError: (error) => toast.error(error),
  });

  const remove = async (product: Product) => {
    await api.delete(`${base}/products/${product.id}`);
    invalidate();
    track('product.deleted');
    setDetailId(null);
    toast.push(`“${product.name}” excluído.`, can('produtos.excluir') ? { action: { label: 'Desfazer', onClick: () => restore.mutate(product.id) } } : {});
  };

  const openCreate = () => {
    setEditing(null);
    setFormOpen(true);
  };
  const openEdit = (product: Product) => {
    setDetailId(null);
    setEditing(product);
    setFormOpen(true);
  };
  const openMove = (product: Product, type: 'entrada' | 'saida') => {
    setDetailId(null);
    setMoving({ product, type });
  };

  const items = list.data?.items ?? [];
  const counts = list.data?.counts;
  const filtered = urlQuery !== '' || lowOnly || category !== '';
  const canSelect = can('produtos.editar');
  const allSelected = items.length > 0 && items.every((item) => selected.has(item.id));
  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const limit = entitlement?.limits.products ?? null;
  const used = entitlement?.usage.products ?? 0;

  const rowMenu = (product: Product): Array<MenuItem | 'sep'> => [
    { label: 'Ver detalhes', icon: 'eye', onClick: () => setDetailId(product.id) },
    ...(can('produtos.editar') ? [{ label: 'Editar', icon: 'edit' as const, onClick: () => openEdit(product) }] : []),
    ...(can('movimentacoes.ver') ? [{ label: 'Ver histórico', icon: 'history' as const, onClick: () => navigate(`/app/historico?produto=${product.id}`) }] : []),
    ...(can('produtos.excluir') ? ['sep' as const, { label: 'Excluir', icon: 'trash' as const, danger: true, onClick: () => setDeleting(product) }] : []),
  ];

  const moveButtons = (product: Product, small = true) => (
    <>
      {can('movimentacoes.saida') && (
        <button type="button" className={`btn btn--out ${small ? 'btn--sm' : ''}`} disabled={product.quantity <= 0} onClick={() => openMove(product, 'saida')} aria-label={`Saída de ${product.name}`}>
          <Icon name="minus" size={15} /> Saída
        </button>
      )}
      {can('movimentacoes.entrada') && (
        <button type="button" className={`btn btn--in ${small ? 'btn--sm' : ''}`} onClick={() => openMove(product, 'entrada')} aria-label={`Entrada de ${product.name}`}>
          <Icon name="plus" size={15} /> Entrada
        </button>
      )}
    </>
  );

  const quantityCell = (product: Product) => (
    <span className={`qty ${product.lowStock ? 'qty--low' : ''}`} title={product.lowStock ? `Estoque mínimo: ${fmtQuantity(product.minStock)}` : undefined}>
      {product.lowStock && <Icon name="alert" size={14} style={{ verticalAlign: -2, marginRight: 4 }} />}
      {fmtQuantity(product.quantity)} <span className="qty__unit">{product.unit || 'un'}</span>
    </span>
  );

  const meta = (product: Product) => (
    <div className="product-row__meta">
      {product.category && <span>{product.category}</span>}
      {product.sku && <span className="mono">{product.sku}</span>}
      {product.location && <span>{product.location}</span>}
    </div>
  );

  const sortHeader = (label: string, field: 'name' | 'quantity' | 'value') => {
    const active = sortField === field;
    const next: SortKey = field === 'name' ? (sort === 'name.asc' ? 'name.desc' : 'name.asc') : field === 'quantity' ? (sort === 'quantity.asc' ? 'quantity.desc' : 'quantity.asc') : 'value.desc';
    return (
      <button type="button" className="th-sort" onClick={() => update({ ordem: next === 'name.asc' ? null : next })} aria-label={`Ordenar por ${label.toLowerCase()}`}>
        {label}
        {active && <Icon name={sortOrder === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} />}
      </button>
    );
  };

  return (
    <div className="page">
      <PageHeader
        title="Estoque"
        subtitle={counts ? `${plural(counts.all, 'produto', 'produtos')}${counts.lowStock > 0 ? ` · ${counts.lowStock} com estoque baixo` : ''}` : undefined}
        actions={
          can('produtos.criar') && (
            <button type="button" className="btn btn--primary" onClick={openCreate}>
              <Icon name="plus" size={17} /> Novo produto
            </button>
          )
        }
      />

      {(conflicts.data?.pending ?? 0) > 0 && (
        <Notice tone="warning" title={`${plural(conflicts.data?.pending ?? 0, 'alteração precisa', 'alterações precisam')} da sua decisão`} action={<Link to="/app/conflitos" className="btn btn--secondary btn--sm">Revisar</Link>}>
          Duas pessoas mudaram o mesmo produto ao mesmo tempo. Nada foi perdido: escolha qual versão vale.
        </Notice>
      )}

      {limit !== null && used >= limit ? (
        <Notice tone="warning" title={`Limite de ${limit} produtos do plano gratuito atingido`} action={<Link to="/app/plano" className="btn btn--secondary btn--sm">Ver planos</Link>}>
          Para cadastrar mais produtos, assine o plano Equipe ou exclua produtos que não usa mais.
        </Notice>
      ) : limit !== null && used >= limit * 0.8 ? (
        <Notice tone="info" action={<Link to="/app/plano" className="btn btn--secondary btn--sm">Ver planos</Link>}>
          Você está usando {used} de {limit} produtos do plano gratuito.
        </Notice>
      ) : null}

      <div className="toolbar no-print">
        <SearchInput
          value={search}
          onChange={setSearch}
          placeholder="Buscar por nome, SKU ou código de barras"
          action={
            barcodeScanningSupported() ? (
              <button type="button" className="icon-btn" aria-label="Ler código de barras com a câmera" onClick={() => setScanning(true)}>
                <Icon name="barcode" />
              </button>
            ) : undefined
          }
        />
        <select className="select" value={category} onChange={(event) => update({ categoria: event.target.value })} aria-label="Categoria" style={{ width: 'auto', maxWidth: 220 }}>
          <option value="">Todas as categorias</option>
          {facets.data?.categories.map((item) => (
            <option key={item.value} value={item.value}>
              {item.value} ({item.count})
            </option>
          ))}
        </select>
        <select className="select" value={sort} onChange={(event) => update({ ordem: event.target.value === 'name.asc' ? null : event.target.value })} aria-label="Ordenar" style={{ width: 'auto' }}>
          {SORTS.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label}
            </option>
          ))}
        </select>
      </div>

      <Chips
        label="Filtro de estoque"
        value={lowOnly ? 'baixo' : 'todos'}
        onChange={(value) => update({ filtro: value === 'baixo' ? 'baixo' : null })}
        items={[
          { key: 'todos', label: 'Todos', count: counts?.all },
          { key: 'baixo', label: 'Estoque baixo', count: counts?.lowStock },
        ]}
      />

      {selected.size > 0 && (
        <div className="selection-bar no-print">
          <span>{plural(selected.size, 'selecionado', 'selecionados')}</span>
          <span className="spacer" />
          {can('movimentacoes.ajuste') && (
            <button type="button" className="btn btn--on-brand btn--sm" onClick={() => setBulk('adjust')}>Ajustar quantidade</button>
          )}
          <button type="button" className="btn btn--on-brand btn--sm" onClick={() => setBulk('category')}>Categoria</button>
          <button type="button" className="btn btn--on-brand btn--sm" onClick={() => setBulk('supplier')}>Fornecedor</button>
          <button type="button" className="btn btn--outline-on-brand btn--sm" onClick={() => setSelected(new Set())}>Limpar</button>
        </div>
      )}

      <Card flush>
        {list.isLoading || (list.error && !list.data) ? (
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          filtered ? (
            <Empty icon="search" title="Nenhum produto encontrado" actions={<button type="button" className="btn btn--secondary btn--sm" onClick={() => { setSearch(''); update({ q: null, filtro: null, categoria: null }); }}>Limpar filtros</button>}>
              {lowOnly && urlQuery === '' && category === '' ? 'Nenhum produto está abaixo do estoque mínimo.' : 'Confira o que foi digitado ou tente outro termo.'}
            </Empty>
          ) : (
            <Empty
              icon="box"
              title="Seu estoque está vazio"
              actions={
                can('produtos.criar') && (
                  <>
                    <button type="button" className="btn btn--primary" onClick={openCreate}>
                      <Icon name="plus" size={17} /> Cadastrar produto
                    </button>
                    <Link to="/app/importar" className="btn btn--secondary">Importar planilha</Link>
                  </>
                )
              }
            >
              Cadastre o primeiro produto ou importe uma planilha. Se você já usa o aplicativo Android, os produtos aparecem aqui depois da sincronização.
            </Empty>
          )
        ) : (
          <>
            <div className="table-wrap product-table" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              <table className="table">
                <thead>
                  <tr>
                    {canSelect && (
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          aria-label="Selecionar todos desta página"
                          checked={allSelected}
                          onChange={() => setSelected(allSelected ? new Set() : new Set(items.map((item) => item.id)))}
                        />
                      </th>
                    )}
                    <th>{sortHeader('Produto', 'name')}</th>
                    <th className="num">{sortHeader('Quantidade', 'quantity')}</th>
                    <th className="num">Valor unitário</th>
                    <th className="num">{sortHeader('Total', 'value')}</th>
                    <th aria-label="Ações" />
                  </tr>
                </thead>
                <tbody>
                  {items.map((product) => (
                    <tr key={product.id} className="clickable" onClick={() => setDetailId(product.id)}>
                      {canSelect && (
                        <td onClick={(event) => event.stopPropagation()}>
                          <input type="checkbox" aria-label={`Selecionar ${product.name}`} checked={selected.has(product.id)} onChange={() => toggle(product.id)} />
                        </td>
                      )}
                      <td style={{ maxWidth: 380 }}>
                        <div className="product-row__name">{product.name}</div>
                        {meta(product)}
                      </td>
                      <td className="num">{quantityCell(product)}</td>
                      <td className="num nowrap">{product.unitValue > 0 ? fmtMoney(product.unitValue, currency) : <span className="faint">—</span>}</td>
                      <td className="num nowrap">{product.unitValue > 0 ? fmtMoney(product.unitValue * product.quantity, currency) : <span className="faint">—</span>}</td>
                      <td onClick={(event) => event.stopPropagation()}>
                        <div className="row-actions">
                          {moveButtons(product)}
                          <Menu
                            label={`Ações de ${product.name}`}
                            items={rowMenu(product)}
                            trigger={(props) => (
                              <button type="button" className="icon-btn" aria-label={`Mais ações de ${product.name}`} {...props}>
                                <Icon name="more" />
                              </button>
                            )}
                          />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="product-cards" style={{ opacity: list.isPlaceholderData ? 0.6 : 1 }}>
              {items.map((product) => (
                <div key={product.id} className="product-card">
                  <div className="product-card__top">
                    <button type="button" onClick={() => setDetailId(product.id)} style={{ all: 'unset', cursor: 'pointer', minWidth: 0, flex: 1 }}>
                      <div className="product-row__name">{product.name}</div>
                      {meta(product)}
                      {product.unitValue > 0 && <div className="product-row__meta">{fmtMoney(product.unitValue, currency)} cada</div>}
                    </button>
                    <div style={{ textAlign: 'right' }}>{quantityCell(product)}</div>
                    <Menu
                      label={`Ações de ${product.name}`}
                      items={rowMenu(product)}
                      trigger={(props) => (
                        <button type="button" className="icon-btn" aria-label={`Mais ações de ${product.name}`} style={{ margin: '-6px -8px 0 -4px' }} {...props}>
                          <Icon name="more" />
                        </button>
                      )}
                    />
                  </div>
                  {(can('movimentacoes.entrada') || can('movimentacoes.saida')) && <div className="product-card__actions">{moveButtons(product, false)}</div>}
                </div>
              ))}
            </div>

            <Pagination page={page} pageSize={PAGE_SIZE} total={list.data?.total ?? 0} onPage={(next) => update({ pagina: next > 1 ? String(next) : null }, false)} />
          </>
        )}
      </Card>

      <ProductForm open={formOpen} product={editing} onClose={() => setFormOpen(false)} />
      <ProductDrawer productId={detailId} onClose={() => setDetailId(null)} onEdit={openEdit} onMove={openMove} />
      <MovementDialog product={moving?.product ?? null} type={moving?.type ?? 'entrada'} onClose={() => setMoving(null)} />

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Excluir produto?"
        description={deleting ? <>“{deleting.name}” sai da lista de estoque. O histórico de movimentações continua guardado.</> : undefined}
        confirmLabel="Excluir"
        danger
        onConfirm={() => (deleting ? remove(deleting) : undefined)}
      />

      <BulkDialog action={bulk} productIds={[...selected]} facets={facets.data} onClose={() => setBulk(null)} onDone={() => setSelected(new Set())} />

      <BarcodeScanner open={scanning} onClose={() => setScanning(false)} onDetected={setSearch} />
    </div>
  );
}

/** Edição em massa dos selecionados: ajuste de quantidade, categoria ou fornecedor. */
function BulkDialog({ action, productIds, facets, onClose, onDone }: { action: BulkAction | null; productIds: string[]; facets: Facets | undefined; onClose: () => void; onDone: () => void }) {
  const { workspaceId, base } = useCurrentWorkspace();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const listId = useId();
  const [direction, setDirection] = useState<'add' | 'remove'>('add');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (action === null) return;
    setDirection('add');
    setAmount('');
    setNote('');
    setValue('');
    setError(null);
  }, [action]);

  const undo = useMutation({
    mutationFn: (movementIds: string[]) => api.post<{ cancelled: number; failed: unknown[] }>(`${base}/movements/bulk-cancel`, { movementIds, note: 'Ajuste em massa desfeito' }),
    onSuccess: (result) => {
      invalidate();
      toast.push(`Ajuste desfeito em ${plural(result.cancelled, 'produto', 'produtos')}.`);
    },
    onError: (caught) => toast.error(caught),
  });

  const run = useMutation({
    mutationFn: (body: unknown) => api.post<{ affected: number; movementIds: string[]; failed: Array<{ id: string; message: string }> }>(`${base}/products/bulk`, body),
    onSuccess: (result) => {
      invalidate();
      track('bulk_edit.applied', { count: result.affected });
      const failed = result.failed.length > 0 ? ` ${plural(result.failed.length, 'não pôde ser alterado', 'não puderam ser alterados')}.` : '';
      toast.push(
        `${plural(result.affected, 'produto alterado', 'produtos alterados')}.${failed}`,
        result.movementIds.length > 0 ? { action: { label: 'Desfazer', onClick: () => undo.mutate(result.movementIds) } } : {},
      );
      onDone();
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (action === 'adjust') {
      const parsed = parseNumber(amount);
      if (parsed === null || Number.isNaN(parsed) || parsed <= 0) return setError('Informe uma quantidade maior que zero.');
      run.mutate({ productIds, action: { type: 'adjust', delta: direction === 'add' ? parsed : -parsed, ...(note.trim() ? { note: note.trim() } : {}) } });
    } else if (action) {
      if (value.trim() === '') return setError(action === 'category' ? 'Informe a categoria.' : 'Informe o fornecedor.');
      run.mutate({ productIds, action: { type: action, value: value.trim() } });
    }
  };

  const title = action === 'adjust' ? 'Ajustar quantidade' : action === 'category' ? 'Definir categoria' : 'Definir fornecedor';
  const options = action === 'category' ? facets?.categories : facets?.suppliers;

  return (
    <Modal open={action !== null} onClose={onClose} title={title} description={`Vale para ${plural(productIds.length, 'produto selecionado', 'produtos selecionados')}.`}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        {action === 'adjust' ? (
          <>
            <Chips
              label="Tipo de ajuste"
              value={direction}
              onChange={setDirection}
              items={[
                { key: 'add', label: 'Somar' },
                { key: 'remove', label: 'Subtrair' },
              ]}
            />
            <Field label="Quantidade" hint={direction === 'remove' ? 'Quem tiver menos do que isso fica com zero.' : undefined}>
              <input className="input num" value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoFocus placeholder="0" />
            </Field>
            <Field label="Motivo" optional>
              <input className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={200} placeholder="Ex.: contagem de inventário" />
            </Field>
          </>
        ) : (
          <Field label={action === 'category' ? 'Categoria' : 'Fornecedor'}>
            <input className="input" value={value} onChange={(event) => setValue(event.target.value)} maxLength={120} autoFocus list={`${listId}-options`} />
            <datalist id={`${listId}-options`}>{options?.map((item) => <option key={item.value} value={item.value} />)}</datalist>
          </Field>
        )}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={run.isPending}>
            {run.isPending ? 'Aplicando…' : 'Aplicar'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
