import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';

import { api, ApiError, errorMessage } from '../../api/client';
import type { Facets, Product, ProductList } from '../../api/types';
import { track } from '../../lib/analytics';
import { newId } from '../../lib/device';
import { fmtQuantity, fold, numberInput, parseNumber } from '../../lib/format';
import { inventoryKeys, useDebounced, useInvalidateInventory } from '../../lib/inventory';
import { fractionMessage, hasFraction, isValidUnit, isWholeUnit, UNIT_ERROR } from '../../lib/units';
import { useCurrentWorkspace } from '../../workspace/WorkspaceProvider';
import { BarcodeScanner, barcodeScanningSupported } from '../BarcodeScanner';
import { Icon } from '../Icon';
import { ConfirmDialog, Drawer, Field, Notice, useToast } from '../ui';

interface FormState {
  name: string;
  sku: string;
  barcode: string;
  category: string;
  description: string;
  quantity: string;
  unit: string;
  unitValue: string;
  minStock: string;
  supplier: string;
  location: string;
}

const EMPTY: FormState = { name: '', sku: '', barcode: '', category: '', description: '', quantity: '', unit: 'un', unitValue: '', minStock: '', supplier: '', location: '' };

function fromProduct(product: Product): FormState {
  return {
    name: product.name,
    sku: product.sku ?? '',
    barcode: product.barcode ?? '',
    category: product.category ?? '',
    description: product.description ?? '',
    quantity: numberInput(product.quantity) || '0',
    unit: product.unit ?? 'un',
    unitValue: numberInput(product.unitValue),
    minStock: numberInput(product.minStock),
    supplier: product.supplier ?? '',
    location: product.location ?? '',
  };
}

type Errors = Partial<Record<keyof FormState, string>>;

/**
 * Cadastro e edição de produto, num painel lateral. As regras são as do app:
 * nome obrigatório e único, quantidade não negativa, unidade da lista e sem
 * fração para itens contados por unidade. Mudar a quantidade na edição vira
 * um ajuste no histórico, e a pessoa é avisada antes de salvar.
 */
export function ProductForm({ open, product, onClose, onSaved }: { open: boolean; product: Product | null; onClose: () => void; onSaved?: (product: Product) => void }) {
  const { workspaceId, base, currency, can } = useCurrentWorkspace();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const listId = useId();
  const editing = product !== null;

  const [form, setForm] = useState<FormState>(EMPTY);
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [draftId, setDraftId] = useState(newId);
  const [confirmQuantity, setConfirmQuantity] = useState(false);
  const [adjustNote, setAdjustNote] = useState('');
  const [scanning, setScanning] = useState(false);

  useEffect(() => {
    if (!open) return;
    setForm(product ? fromProduct(product) : EMPTY);
    setErrors({});
    setServerError(null);
    setAdjustNote('');
    setDraftId(newId());
  }, [open, product]);

  const facets = useQuery({ queryKey: inventoryKeys.facets(workspaceId), queryFn: () => api.get<Facets>(`${base}/products/facets`), enabled: open, staleTime: 60_000 });

  // Aviso de nome parecido, como no app: evita cadastrar duas vezes o mesmo item.
  const nameQuery = useDebounced(form.name.trim(), 400);
  const similar = useQuery({
    queryKey: [...inventoryKeys.products(workspaceId), 'similar', nameQuery],
    queryFn: () => api.get<ProductList>(`${base}/products`, { q: nameQuery.slice(0, 40), pageSize: 6 }),
    enabled: open && !editing && fold(nameQuery).replace(/[^a-z0-9]/g, '').length >= 4,
    staleTime: 30_000,
  });
  const similarName = useMemo(() => {
    const strip = (value: string) => fold(value).replace(/[^a-z0-9]/g, '');
    const mine = strip(nameQuery);
    if (mine.length < 4) return null;
    return similar.data?.items.find((item) => {
      const other = strip(item.name);
      return other === mine || other.includes(mine) || mine.includes(other) || other.slice(0, 8) === mine.slice(0, 8);
    })?.name ?? null;
  }, [similar.data, nameQuery]);

  const set = (field: keyof FormState) => (value: string) => {
    setForm((current) => ({ ...current, [field]: value }));
    setErrors((current) => ({ ...current, [field]: undefined }));
  };

  const validate = (): { ok: boolean; quantity: number; unitValue: number; minStock: number } => {
    const next: Errors = {};
    const quantity = parseNumber(form.quantity);
    const unitValue = parseNumber(form.unitValue) ?? 0;
    const minStock = parseNumber(form.minStock) ?? 0;
    if (form.name.trim() === '') next.name = 'Informe o nome do produto.';
    if (quantity === null) next.quantity = 'Informe a quantidade.';
    else if (Number.isNaN(quantity)) next.quantity = 'Quantidade inválida.';
    else if (quantity < 0) next.quantity = 'A quantidade não pode ser negativa.';
    else if (isWholeUnit(form.unit) && hasFraction(quantity)) next.quantity = fractionMessage(form.unit);
    if (!isValidUnit(form.unit)) next.unit = UNIT_ERROR;
    if (Number.isNaN(unitValue) || unitValue < 0) next.unitValue = 'Valor inválido.';
    if (Number.isNaN(minStock) || minStock < 0) next.minStock = 'Quantidade inválida.';
    setErrors(next);
    return { ok: Object.keys(next).length === 0, quantity: quantity ?? 0, unitValue, minStock };
  };

  const save = useMutation({
    mutationFn: async (values: { quantity: number; unitValue: number; minStock: number }) => {
      const fields = {
        name: form.name.trim(),
        description: form.description.trim() || null,
        unitValue: values.unitValue,
        minStock: values.minStock,
        unit: form.unit.trim() || 'un',
        category: form.category.trim() || null,
        supplier: form.supplier.trim() || null,
        location: form.location.trim() || null,
        sku: form.sku.trim() || null,
        barcode: form.barcode.trim() || null,
      };
      if (!product) {
        // `id` gerado aqui: se a resposta se perder, repetir não duplica.
        return api.post<Product>(`${base}/products`, { id: draftId, ...fields, quantity: values.quantity });
      }
      const changes: Record<string, unknown> = {};
      const original: Record<string, string | number | null> = {};
      for (const [key, value] of Object.entries(fields)) {
        const before = product[key as keyof typeof fields];
        if ((before ?? null) !== (value ?? null)) {
          changes[key] = value;
          original[key] = before ?? null;
        }
      }
      const quantityChanged = values.quantity !== product.quantity;
      return api.patch<Product>(`${base}/products/${product.id}`, {
        rev: product.rev,
        changes,
        base: original,
        ...(quantityChanged ? { quantity: { target: values.quantity, ...(adjustNote.trim() ? { note: adjustNote.trim() } : {}) } } : {}),
      });
    },
    onSuccess: (saved) => {
      invalidate();
      track(product ? 'product.updated' : 'product.created');
      toast.success(product ? 'Produto atualizado.' : 'Produto cadastrado.');
      onSaved?.(saved);
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError && error.code === 'DUPLICATE_NAME') {
        setErrors((current) => ({ ...current, name: 'Já existe um produto com este nome.' }));
        return;
      }
      if (error instanceof ApiError && error.code === 'SYNC_CONFLICT') {
        invalidate();
        setServerError(`${error.message} Feche e abra o produto de novo para ver a versão atual.`);
        return;
      }
      setServerError(errorMessage(error));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setServerError(null);
    const result = validate();
    if (!result.ok) return;
    if (product && result.quantity !== product.quantity) {
      setConfirmQuantity(true);
      return;
    }
    save.mutate(result);
  };

  const units = [...new Set([...(facets.data?.defaultUnits ?? []), ...(facets.data?.units.map((item) => item.value) ?? [])])];

  return (
    <>
      <Drawer
        open={open}
        onClose={onClose}
        title={editing ? 'Editar produto' : 'Novo produto'}
        subtitle={editing ? product.name : 'Campos com * são obrigatórios'}
        footer={
          <>
            <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
            <button type="submit" form={`${listId}-form`} className="btn btn--primary" disabled={save.isPending}>
              {save.isPending ? 'Salvando…' : 'Salvar'}
            </button>
          </>
        }
      >
        <form id={`${listId}-form`} className="stack" onSubmit={submit} noValidate>
          {serverError && <Notice tone="error">{serverError}</Notice>}

          <div className="form-section">Informações básicas</div>
          <Field label="Nome do produto *" error={errors.name} hint={similarName ? `Parecido com “${similarName}”, já cadastrado. Se for o mesmo, registre uma entrada nele.` : undefined}>
            <input className="input" value={form.name} onChange={(event) => set('name')(event.target.value)} maxLength={200} autoFocus aria-invalid={errors.name ? true : undefined} />
          </Field>
          <div className="form-grid">
            <Field label="SKU / código">
              <input className="input" value={form.sku} onChange={(event) => set('sku')(event.target.value)} maxLength={80} />
            </Field>
            <Field label="Código de barras">
              <div className="input-group input-group--suffix">
                <input className="input" value={form.barcode} onChange={(event) => set('barcode')(event.target.value)} maxLength={80} inputMode="numeric" />
                {barcodeScanningSupported() && (
                  <button type="button" className="icon-btn input-group__action" aria-label="Ler com a câmera" onClick={() => setScanning(true)}>
                    <Icon name="barcode" />
                  </button>
                )}
              </div>
            </Field>
            <Field label="Categoria" full>
              <input className="input" value={form.category} onChange={(event) => set('category')(event.target.value)} maxLength={120} list={`${listId}-categories`} />
              <datalist id={`${listId}-categories`}>{facets.data?.categories.map((item) => <option key={item.value} value={item.value} />)}</datalist>
            </Field>
            <Field label="Descrição" full>
              <textarea className="textarea" value={form.description} onChange={(event) => set('description')(event.target.value)} maxLength={2000} rows={2} />
            </Field>
          </div>

          <div className="form-section">Estoque e valores</div>
          <div className="form-grid">
            <Field label={editing ? 'Quantidade em estoque *' : 'Quantidade inicial *'} error={errors.quantity} hint={editing ? (can('movimentacoes.ajuste') ? 'Alterar aqui registra um ajuste no histórico.' : 'Seu papel não permite ajustar a quantidade.') : undefined}>
              <input className="input num" disabled={editing && !can('movimentacoes.ajuste')} value={form.quantity} onChange={(event) => set('quantity')(event.target.value)} inputMode="decimal" placeholder="0" aria-invalid={errors.quantity ? true : undefined} />
            </Field>
            <Field label="Unidade" error={errors.unit}>
              <input className="input" value={form.unit} onChange={(event) => set('unit')(event.target.value)} maxLength={30} list={`${listId}-units`} aria-invalid={errors.unit ? true : undefined} />
              <datalist id={`${listId}-units`}>{units.map((unit) => <option key={unit} value={unit} />)}</datalist>
            </Field>
            <Field label="Valor unitário" error={errors.unitValue}>
              <div className="input-affix">
                <span className="input-affix__label">{currency}</span>
                <input className="input num" value={form.unitValue} onChange={(event) => set('unitValue')(event.target.value)} inputMode="decimal" placeholder="0,00" />
              </div>
            </Field>
            <Field label="Estoque mínimo" error={errors.minStock} hint="Avisa quando o estoque chegar a este número.">
              <input className="input num" value={form.minStock} onChange={(event) => set('minStock')(event.target.value)} inputMode="decimal" placeholder="0" />
            </Field>
          </div>

          <div className="form-section">Informações adicionais</div>
          <div className="form-grid">
            <Field label="Fornecedor">
              <input className="input" value={form.supplier} onChange={(event) => set('supplier')(event.target.value)} maxLength={120} list={`${listId}-suppliers`} />
              <datalist id={`${listId}-suppliers`}>{facets.data?.suppliers.map((item) => <option key={item.value} value={item.value} />)}</datalist>
            </Field>
            <Field label="Localização no estoque">
              <input className="input" value={form.location} onChange={(event) => set('location')(event.target.value)} maxLength={120} list={`${listId}-locations`} />
              <datalist id={`${listId}-locations`}>{facets.data?.locations.map((item) => <option key={item.value} value={item.value} />)}</datalist>
            </Field>
          </div>
        </form>
      </Drawer>

      <ConfirmDialog
        open={confirmQuantity}
        onClose={() => setConfirmQuantity(false)}
        title="Quantidade alterada"
        description={product ? `De ${fmtQuantity(product.quantity)} para ${fmtQuantity(parseNumber(form.quantity) ?? 0)}. Isso fica registrado no histórico como um ajuste. Nada foi salvo ainda.` : undefined}
        confirmLabel="Salvar"
        onConfirm={async () => {
          const result = validate();
          if (result.ok) await save.mutateAsync(result).catch(() => undefined);
        }}
      >
        <Field label="Motivo do ajuste" optional>
          <input className="input" value={adjustNote} onChange={(event) => setAdjustNote(event.target.value)} maxLength={200} placeholder="Ex.: contagem de inventário" />
        </Field>
      </ConfirmDialog>

      <BarcodeScanner open={scanning} onClose={() => setScanning(false)} onDetected={set('barcode')} />
    </>
  );
}
