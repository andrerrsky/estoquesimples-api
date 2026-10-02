import { useMutation } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';

import { api, errorMessage } from '../../api/client';
import type { Product } from '../../api/types';
import { track } from '../../lib/analytics';
import { newId } from '../../lib/device';
import { fmtDayMonth, fmtStock, parseNumber } from '../../lib/format';
import { useInvalidateInventory } from '../../lib/inventory';
import { fractionMessage, hasFraction, isWholeUnit } from '../../lib/units';
import { useCurrentWorkspace } from '../../workspace/WorkspaceProvider';
import { Field, Modal, Notice, useToast } from '../ui';

/**
 * Entrada ou saída de estoque. Depois de registrar, o aviso traz "Desfazer"
 * por 15 segundos — que grava o estorno, como no app, em vez de apagar.
 */
export function MovementDialog({ product, type, onClose }: { product: Product | null; type: 'entrada' | 'saida'; onClose: () => void }) {
  const { workspaceId, base } = useCurrentWorkspace();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const [quantity, setQuantity] = useState('');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [movementId, setMovementId] = useState(newId);
  const open = product !== null;
  const today = new Date().toLocaleDateString('en-CA');

  useEffect(() => {
    if (!open) return;
    setQuantity('');
    setNote('');
    setDate('');
    setError(null);
    setMovementId(newId());
  }, [open, type, product?.id]);

  const undo = useMutation({
    mutationFn: (id: string) => api.post<{ product: Product }>(`${base}/movements/${id}/cancel`, { note: 'Desfeita logo após o registro' }),
    onSuccess: (result) => {
      invalidate();
      toast.push(`Desfeito. Estoque de volta a ${fmtStock(result.product.quantity, result.product.unit)}.`);
    },
    onError: (caught) => toast.error(caught),
  });

  const save = useMutation({
    mutationFn: (amount: number) =>
      api.post<{ movementId: string; product: Product }>(`${base}/movements`, {
        id: movementId,
        productId: product?.id,
        type,
        quantity: amount,
        ...(note.trim() ? { note: note.trim() } : {}),
        // Dia escolhido entra ao meio-dia, como no app; hoje é "agora".
        ...(date && date !== today ? { occurredAt: new Date(`${date}T12:00:00`).toISOString() } : {}),
      }),
    onSuccess: (result, amount) => {
      invalidate();
      track('movement.created', { type });
      const when = date && date !== today ? ` em ${fmtDayMonth(date)}` : '';
      toast.push(`${type === 'entrada' ? 'Entrada' : 'Saída'} de ${fmtStock(amount, result.product.unit)}${when} registrada. Estoque agora: ${fmtStock(result.product.quantity, result.product.unit)}.`, {
        action: { label: 'Desfazer', onClick: () => undo.mutate(result.movementId) },
      });
      onClose();
    },
    onError: (caught) => setError(errorMessage(caught)),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!product) return;
    const amount = parseNumber(quantity);
    if (amount === null || Number.isNaN(amount) || amount <= 0) return setError('A quantidade deve ser maior que zero.');
    if (isWholeUnit(product.unit) && hasFraction(amount)) return setError(fractionMessage(product.unit));
    if (type === 'saida' && amount > product.quantity) return setError('Quantidade insuficiente em estoque.');
    setError(null);
    save.mutate(amount);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={type === 'entrada' ? 'Entrada de estoque' : 'Saída de estoque'}
      description={product ? <><strong>{product.name}</strong> · em estoque: {fmtStock(product.quantity, product.unit)}</> : undefined}
    >
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="Quantidade">
          <input className="input num" value={quantity} onChange={(event) => setQuantity(event.target.value)} inputMode="decimal" autoFocus placeholder="0" style={{ fontSize: 20, fontWeight: 700 }} />
        </Field>
        <Field label="Observação" optional>
          <input className="input" value={note} onChange={(event) => setNote(event.target.value)} maxLength={500} placeholder={type === 'saida' ? 'Ex.: venda no balcão' : 'Ex.: compra do fornecedor'} />
        </Field>
        <Field label="Data" hint="Em branco registra agora. Escolha um dia para lançar depois do fato." optional>
          <input className="input" type="date" value={date} max={today} onChange={(event) => setDate(event.target.value)} />
        </Field>
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={save.isPending}>
            {save.isPending ? 'Registrando…' : type === 'entrada' ? 'Registrar entrada' : 'Registrar saída'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
