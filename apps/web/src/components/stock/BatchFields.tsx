import { Field } from '../ui';

/** Lote informado numa entrada; vazio significa "sem lote". */
export interface BatchInput {
  batchCode: string;
  manufacturedOn: string;
  expiresOn: string;
}

export const EMPTY_BATCH: BatchInput = { batchCode: '', manufacturedOn: '', expiresOn: '' };

/** Só o que foi preenchido vai no corpo da requisição. */
export function batchPayload(batch: BatchInput): Record<string, string> {
  const payload: Record<string, string> = {};
  if (batch.batchCode.trim()) payload['batchCode'] = batch.batchCode.trim();
  if (batch.manufacturedOn) payload['manufacturedOn'] = batch.manufacturedOn;
  if (batch.expiresOn) payload['expiresOn'] = batch.expiresOn;
  return payload;
}

/**
 * Lote, fabricação e validade da mercadoria que está entrando.
 *
 * Aparece só para quem ligou o controle de validade em Opções: numa loja de
 * roupa esses três campos seriam três perguntas sem resposta em cada entrada.
 * Tudo é opcional — uma entrada sem lote continua valendo, e o saldo dela
 * aparece como "sem lote" nas validades.
 */
export function BatchFields({ value, onChange }: { value: BatchInput; onChange: (batch: BatchInput) => void }) {
  const set = (field: keyof BatchInput) => (event: { target: { value: string } }) =>
    onChange({ ...value, [field]: event.target.value });

  return (
    <>
      <Field label="Lote" optional hint="Como vem no pacote ou na nota do fornecedor.">
        <input className="input" value={value.batchCode} onChange={set('batchCode')} maxLength={60} placeholder="Ex.: L2026-11" />
      </Field>
      <div className="grid grid--2">
        <Field label="Fabricação" optional>
          <input className="input" type="date" value={value.manufacturedOn} onChange={set('manufacturedOn')} />
        </Field>
        <Field label="Validade" optional hint="O que vence primeiro sai primeiro nas contas.">
          <input className="input" type="date" value={value.expiresOn} onChange={set('expiresOn')} />
        </Field>
      </div>
    </>
  );
}
