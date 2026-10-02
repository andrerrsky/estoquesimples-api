import { useMutation, useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';

import { ApiError, api } from '../api/client';
import type { Conflict } from '../api/types';
import { Badge, Card, Empty, KeyValue, PageHeader, QueryState, Tabs, Time, useToast } from '../components/ui';
import { fmtDateTime, fmtMoney, fmtQuantity } from '../lib/format';
import { inventoryKeys, SYNC_HEADERS, useInvalidateInventory } from '../lib/inventory';
import { FIELD_LABEL } from '../lib/labels';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-stock.css';

type Status = Conflict['status'];
type Choice = 'meu' | 'servidor' | 'restaurar';

interface ConflictList {
  conflicts: Conflict[];
  pending: number;
}

const LIMIT = 100;
const STATUSES: Status[] = ['pendente', 'automatico', 'resolvido'];

/** O que foi decidido, nas palavras dos botões desta tela. */
const RESOLUTION_LABEL: Record<string, string> = {
  servidor: 'manter o que estava valendo',
  meu: 'usar a outra versão',
  restaurar: 'restaurar o produto',
};

/** Campos cujo nome é feminino, para a frase concordar ("a categoria foi alterada"). */
const FEMININE = new Set(['description', 'category', 'location', 'unit']);

const asRecord = (value: unknown): Record<string, unknown> => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const isBlank = (value: unknown) => value === null || value === undefined || value === '';
const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** Valor de um campo do produto como a pessoa o reconhece (dinheiro, quantidade, texto). */
function formatValue(field: string | null, value: unknown, currency: string): ReactNode {
  if (isBlank(value)) return <span className="faint">(vazio)</span>;
  if (typeof value === 'object') return <span className="faint">—</span>;
  if (field === 'unitValue') return fmtMoney(Number(value), currency);
  if (field === 'minStock') return fmtQuantity(Number(value));
  return String(value);
}

/** Dois valores são "o mesmo" para quem lê? (vazio = nulo; "3" = 3 nos campos numéricos) */
function sameValue(field: string, a: unknown, b: unknown): boolean {
  if (isBlank(a) && isBlank(b)) return true;
  if (field === 'unitValue' || field === 'minStock') return Number(a ?? 0) === Number(b ?? 0);
  return String(a ?? '') === String(b ?? '');
}

/**
 * Alterações que precisam de decisão. Acontece quando duas pessoas mudam o
 * mesmo produto ao mesmo tempo em aparelhos diferentes: o sistema junta
 * sozinho o que não se cruza e traz para cá só o que é escolha do negócio
 * (qual nome, qual preço, se um produto excluído volta). Nada se perde — a
 * versão que não foi aplicada fica guardada até alguém decidir. A decisão em
 * si é aplicada pela API; a tela mostra os dois lados e envia a escolha.
 */
export function ConflictsPage() {
  const { workspaceId, base, can, currency } = useCurrentWorkspace();
  const [params, setParams] = useSearchParams();
  const toast = useToast();
  const invalidate = useInvalidateInventory(workspaceId);
  const allowed = can('conflitos.ver');
  const canResolve = can('conflitos.resolver');

  const statusParam = params.get('situacao') as Status | null;
  const status: Status = statusParam && STATUSES.includes(statusParam) ? statusParam : 'pendente';

  const list = useQuery({
    queryKey: [...inventoryKeys.conflicts(workspaceId), 'list', status],
    queryFn: () => api.get<ConflictList>(`${base}/conflicts`, { status, limit: LIMIT }, { headers: SYNC_HEADERS }),
    enabled: allowed,
  });

  const resolve = useMutation({
    mutationFn: ({ conflict, choice }: { conflict: Conflict; choice: Choice }) =>
      api.post<{ id: string; status: string; resolution: Choice }>(`${base}/conflicts/${conflict.id}/resolve`, { escolha: choice }, { headers: SYNC_HEADERS }),
    onSuccess: (_result, { conflict, choice }) => {
      // As chaves de conflitos ficam sob as do estoque: uma invalidação
      // atualiza esta lista, o aviso da tela de estoque e os produtos.
      invalidate();
      toast.success(
        choice === 'restaurar'
          ? 'Produto restaurado. Ele voltou para a lista de estoque.'
          : choice === 'meu'
            ? 'Decisão registrada: a outra versão passou a valer.'
            : conflict.kind === 'exclusao_vs_edicao'
              ? 'Decisão registrada: o produto continua excluído.'
              : 'Decisão registrada: o valor atual foi mantido.',
      );
    },
    onError: (error) => {
      toast.error(error);
      // Outra pessoa decidiu antes (409) ou o registro sumiu (404): a lista está velha.
      if (error instanceof ApiError && (error.status === 409 || error.status === 404)) invalidate();
    },
  });

  const setStatus = (next: Status) => {
    setParams(
      (current) => {
        const updated = new URLSearchParams(current);
        if (next === 'pendente') updated.delete('situacao');
        else updated.set('situacao', next);
        return updated;
      },
      { replace: true },
    );
  };

  if (!allowed) {
    return (
      <div className="page page--narrow">
        <PageHeader title="Alterações para revisar" />
        <Card>
          <Empty icon="lock" title="Seu acesso não inclui esta tela">
            Peça a quem administra a empresa para liberar a revisão de alterações.
          </Empty>
        </Card>
      </div>
    );
  }

  const conflicts = list.data?.conflicts ?? [];
  const pending = list.data?.pending ?? 0;
  const busy = resolve.isPending ? resolve.variables?.conflict.id : null;

  const actions = (conflict: Conflict, buttons: Array<{ choice: Choice; label: string; primary?: boolean }>) =>
    conflict.status !== 'pendente' ? null : canResolve ? (
      <div className="conflict-actions">
        {buttons.map((button) => (
          <button
            key={button.choice}
            type="button"
            className={`btn ${button.primary ? 'btn--primary' : 'btn--secondary'}`}
            disabled={resolve.isPending}
            onClick={() => resolve.mutate({ conflict, choice: button.choice })}
          >
            {busy === conflict.id && resolve.variables?.choice === button.choice ? 'Aguarde…' : button.label}
          </button>
        ))}
      </div>
    ) : (
      <p className="caption">Seu acesso permite ver, mas não decidir. Peça a um administrador da empresa.</p>
    );

  const render = (conflict: Conflict) => {
    const discarded = asRecord(conflict.discardedValue);
    const kept = asRecord(conflict.keptValue);
    const name = conflict.entityName ?? (typeof discarded['name'] === 'string' ? discarded['name'] : null) ?? 'Produto';
    const isPending = conflict.status === 'pendente';

    const head = (tag: string) => (
      <div className="row row--between" style={{ alignItems: 'flex-start' }}>
        <div style={{ minWidth: 0 }}>
          <div className="card__title">{name}</div>
          <div className="caption">
            <Time value={conflict.createdAt} />
            {conflict.status === 'resolvido' && conflict.resolution && (
              <>
                {' · decisão: '}
                {RESOLUTION_LABEL[conflict.resolution] ?? conflict.resolution}
                {conflict.resolvedAt && <> em {fmtDateTime(conflict.resolvedAt)}</>}
              </>
            )}
          </div>
        </div>
        <Badge tone={isPending ? 'warning' : 'neutral'}>{tag}</Badge>
      </div>
    );

    // Produto excluído por uma pessoa enquanto outra o editava.
    if (conflict.kind === 'exclusao_vs_edicao') {
      const deletedAt = typeof kept['deletedAt'] === 'number' ? fmtDateTime(new Date(kept['deletedAt'])) : null;
      const edited = Object.keys(FIELD_LABEL)
        .filter((field) => !isBlank(discarded[field]))
        .map((field) => ({ label: capitalize(FIELD_LABEL[field] ?? field), value: formatValue(field, discarded[field], currency) }));
      return (
        <Card key={conflict.id}>
          <div className="stack">
            {head('Produto excluído')}
            <p>
              “{name}” foi excluído{deletedAt ? ` em ${deletedAt}` : ''} enquanto outra pessoa ainda o editava em outro aparelho.{' '}
              {isPending
                ? 'O produto está excluído, e a edição ficou guardada. Você pode trazê-lo de volta já com essa edição ou deixar como está.'
                : conflict.status === 'resolvido'
                  ? 'Alguém da equipe já decidiu o que fazer.'
                  : 'A exclusão foi mantida.'}
            </p>
            {edited.length > 0 && (
              <div className="version">
                <div className="version__label">Como o produto estava sendo salvo</div>
                <div style={{ marginTop: 8 }}>
                  <KeyValue items={edited} />
                </div>
              </div>
            )}
            {actions(conflict, [
              { choice: 'servidor', label: 'Manter excluído' },
              { choice: 'restaurar', label: 'Restaurar produto', primary: true },
            ])}
          </div>
        </Card>
      );
    }

    // Um campo específico (nome, preço…) alterado dos dois lados.
    if (conflict.field) {
      const label = FIELD_LABEL[conflict.field] ?? conflict.field;
      const feminine = FEMININE.has(conflict.field);
      return (
        <Card key={conflict.id}>
          <div className="stack">
            {head(capitalize(label))}
            <p>
              {feminine ? 'A' : 'O'} {label} de “{name}” foi {feminine ? 'alterada' : 'alterado'} em dois lugares ao mesmo tempo.{' '}
              {isPending
                ? 'A alteração que chegou primeiro está valendo; a outra não foi aplicada, mas ficou guardada. Escolha qual deve valer.'
                : conflict.status === 'automatico'
                  ? 'Ficou valendo a alteração que chegou primeiro; a outra está guardada aqui só para consulta.'
                  : 'Alguém da equipe já escolheu qual versão vale.'}
            </p>
            <div className="versions">
              <div className={`version ${isPending ? 'version--current' : ''}`}>
                <div className="version__label">{isPending ? 'Valendo agora' : conflict.status === 'automatico' ? 'Ficou valendo' : 'Estava valendo'}</div>
                <div className="version__value">{formatValue(conflict.field, conflict.keptValue, currency)}</div>
              </div>
              <div className="version">
                <div className="version__label">{isPending ? 'Outra alteração (não aplicada)' : conflict.status === 'automatico' ? 'Não aplicada' : 'Outra alteração'}</div>
                <div className="version__value">{formatValue(conflict.field, conflict.discardedValue, currency)}</div>
              </div>
            </div>
            {!isBlank(conflict.baseValue) && <p className="caption">Antes das duas alterações: {formatValue(conflict.field, conflict.baseValue, currency)}</p>}
            {actions(conflict, [
              { choice: 'meu', label: 'Usar a outra versão' },
              { choice: 'servidor', label: 'Manter o atual', primary: true },
            ])}
          </div>
        </Card>
      );
    }

    // Produto inteiro (aparelho com versão antiga do aplicativo, que não
    // informa o que mudou): mostra só os campos em que as versões diferem.
    // A API não reaplica a outra versão neste caso, então a única decisão
    // possível aqui é encerrar mantendo o que está valendo.
    const differences = Object.keys(FIELD_LABEL).filter((field) => !sameValue(field, kept[field], discarded[field]));
    return (
      <Card key={conflict.id}>
        <div className="stack">
          {head('Produto')}
          <p>
            “{name}” foi alterado em dois lugares ao mesmo tempo.{' '}
            {isPending
              ? 'A alteração que chegou primeiro está valendo; a outra não foi aplicada, mas ficou guardada para você conferir.'
              : 'A alteração que chegou primeiro ficou valendo.'}
          </p>
          {differences.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>O que mudou</th>
                    <th>{isPending ? 'Valendo agora' : 'Ficou valendo'}</th>
                    <th>Outra alteração</th>
                  </tr>
                </thead>
                <tbody>
                  {differences.map((field) => (
                    <tr key={field}>
                      <td className="muted">{capitalize(FIELD_LABEL[field] ?? field)}</td>
                      <td className="strong">{formatValue(field, kept[field], currency)}</td>
                      <td>{formatValue(field, discarded[field], currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">As duas versões têm os mesmos dados de cadastro.</p>
          )}
          {isPending && canResolve && (
            <p className="caption">
              Se algo da outra alteração deve valer, corrija o produto no <Link to={`/app/estoque?q=${encodeURIComponent(name)}`}>estoque</Link> e depois encerre aqui.
            </p>
          )}
          {actions(conflict, [{ choice: 'servidor', label: 'Manter o atual e encerrar', primary: true }])}
        </div>
      </Card>
    );
  };

  return (
    <div className="page page--narrow">
      <PageHeader
        title="Alterações para revisar"
        subtitle="Quando duas pessoas mudam o mesmo produto ao mesmo tempo, nada é perdido: o que não deu para juntar sozinho espera a sua decisão aqui."
      />

      <Tabs<Status>
        value={status}
        onChange={setStatus}
        items={[
          { key: 'pendente', label: pending > 0 ? `Pendentes (${pending})` : 'Pendentes' },
          { key: 'automatico', label: 'Resolvidos automaticamente' },
          { key: 'resolvido', label: 'Resolvidos' },
        ]}
      />

      {list.isLoading || (list.error && !list.data) ? (
        <Card flush>
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        </Card>
      ) : conflicts.length === 0 ? (
        <Card>
          {status === 'pendente' ? (
            <Empty icon="check" title="Nenhuma decisão pendente" actions={<Link to="/app/estoque" className="btn btn--secondary">Ir para o estoque</Link>}>
              Está tudo em dia. Se duas pessoas mudarem o nome ou o preço do mesmo produto ao mesmo tempo, a escolha aparece aqui.
            </Empty>
          ) : status === 'automatico' ? (
            <Empty icon="layers" title="Nada foi resolvido automaticamente">
              Quando duas pessoas mudam um dado descritivo do mesmo produto (categoria, fornecedor, localização…), fica valendo a alteração que chegou primeiro e a outra é registrada aqui.
            </Empty>
          ) : (
            <Empty icon="history" title="Nenhuma decisão registrada ainda">
              As alterações que alguém da equipe já revisou ficam guardadas aqui.
            </Empty>
          )}
        </Card>
      ) : (
        <>
          {conflicts.map(render)}
          {conflicts.length >= LIMIT && <p className="caption">Mostrando os {LIMIT} registros mais recentes.</p>}
        </>
      )}
    </div>
  );
}
