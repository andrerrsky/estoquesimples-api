import type { Movement } from '../../api/types';
import { fmtQuantity } from '../../lib/format';
import { movementLabel } from '../../lib/labels';

type Tone = 'in' | 'out' | 'neutral';

/** Cor da movimentação, como no app: verde entra, vermelho sai, azul corrige. */
export function movementTone(movement: Pick<Movement, 'type' | 'quantity'>): Tone {
  if (movement.type === 'ajuste' || movement.type === 'edicao' || movement.type === 'cancelamento') return 'neutral';
  return movement.quantity >= 0 ? 'in' : 'out';
}

export function TypeBadge({ movement }: { movement: Pick<Movement, 'type' | 'quantity'> }) {
  return <span className={`type-badge type-badge--${movementTone(movement)}`}>{movementLabel(movement.type)}</span>;
}

export function MovementAmount({ movement }: { movement: Pick<Movement, 'type' | 'quantity' | 'unit'> }) {
  return (
    <span className={`movement movement--${movementTone(movement)}`}>
      {movement.quantity > 0 ? '+' : ''}
      {fmtQuantity(movement.quantity)} <span className="qty__unit">{movement.unit && movement.unit.trim() !== '' ? movement.unit : 'un'}</span>
    </span>
  );
}
