import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import { fmtNumber } from '../lib/format';
import { ROLE_LABEL, SUBSCRIPTION_STATE } from '../lib/labels';
import { errorMessage, Modal, Notice, Skeleton } from './ui';

interface Member {
  userId: string;
  name: string;
  email: string;
  role: string;
}

interface Blocker {
  reason: 'members' | 'paying_subscription' | 'play_renewing';
  workspaceId: string;
  workspaceName: string;
  message: string;
  members?: Member[];
}

interface PurgePreview {
  workspaces: Array<{ id: string; name: string; subscription: { provider: string; state: string; cancelsAtProvider: boolean } | null; members: Member[] }>;
  memberOf: Array<{ id: string; name: string; ownerId: string; ownerName: string }>;
  usageEvents: number;
  blockers: Blocker[];
}

const BLOCKER_TITLE: Record<Blocker['reason'], string> = {
  members: 'Tem gente na equipe',
  paying_subscription: 'Cliente pagante',
  play_renewing: 'Assinatura do Google Play ativa',
};

function BlockerList({ blockers, onNavigate }: { blockers: Blocker[]; onNavigate: () => void }) {
  return (
    <Notice tone="error" title="Não dá para excluir esta conta agora">
      <ul className="purge__list">
        {blockers.map((blocker) => (
          <li key={`${blocker.reason}-${blocker.workspaceId}`}>
            <strong>{BLOCKER_TITLE[blocker.reason]}</strong> em{' '}
            <Link to={`/empresas/${blocker.workspaceId}`} onClick={onNavigate}>
              {blocker.workspaceName}
            </Link>
            . {blocker.message}
            {blocker.members && blocker.members.length > 0 && (
              <ul className="purge__people">
                {blocker.members.map((member) => (
                  <li key={member.userId}>
                    <Link to={`/usuarios/${member.userId}`} onClick={onNavigate}>
                      {member.name}
                    </Link>{' '}
                    <span className="muted">
                      {member.email} · {ROLE_LABEL[member.role] ?? member.role}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </Notice>
  );
}

/**
 * Exclusão definitiva de conta de teste (só owner). Antes de pedir a
 * confirmação, mostra o que sai junto e, se houver, o que impede, com links
 * para as pessoas e empresas que dependem da conta.
 */
export function PurgeUserDialog({ open, onClose, userId, email, onDone }: { open: boolean; onClose: () => void; userId: string; email: string; onDone: (message: string) => void }) {
  const preview = useQuery({
    queryKey: ['user', userId, 'purge-preview'],
    queryFn: () => api.get<PurgePreview>(`/users/${userId}/purge-preview`),
    enabled: open,
    staleTime: 0,
  });
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lateBlockers, setLateBlockers] = useState<Blocker[] | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setTyped('');
      setBusy(false);
      setError(null);
      setLateBlockers(null);
    }
  }, [open]);

  const data = preview.data;
  const blockers = lateBlockers ?? data?.blockers ?? [];
  const ready = !!data && blockers.length === 0 && reason.trim().length >= 3 && typed.trim().toLowerCase() === email.toLowerCase();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.post<{ message: string }>(`/users/${userId}/purge`, { reason: reason.trim(), confirmEmail: typed.trim() });
      onDone(result.message);
    } catch (caught) {
      if (caught instanceof ApiError && Array.isArray(caught.extra['blockers'])) setLateBlockers(caught.extra['blockers'] as Blocker[]);
      else setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Excluir conta definitivamente" description="Para contas de teste. Apaga agora, sem os 30 dias de recuperação, e não dá para desfazer." wide>
      {preview.isLoading ? (
        <Skeleton lines={4} />
      ) : preview.isError ? (
        <Notice tone="error">{errorMessage(preview.error)}</Notice>
      ) : data ? (
        <form onSubmit={submit} className="stack">
          {blockers.length > 0 ? (
            <BlockerList blockers={blockers} onNavigate={onClose} />
          ) : (
            <Notice tone="warning" title="O que sai junto">
              <ul className="purge__list">
                {data.workspaces.length === 0 && <li>Nenhuma empresa própria.</li>}
                {data.workspaces.map((workspace) => (
                  <li key={workspace.id}>
                    Empresa <Link to={`/empresas/${workspace.id}`} onClick={onClose}>{workspace.name}</Link>, com produtos, fotos e movimentações
                    {workspace.subscription && (
                      <>
                        {' '}· assinatura {SUBSCRIPTION_STATE[workspace.subscription.state]?.label ?? workspace.subscription.state}
                        {workspace.subscription.cancelsAtProvider && ', que também é cancelada no Asaas'}
                      </>
                    )}
                  </li>
                ))}
                {data.memberOf.map((workspace) => (
                  <li key={workspace.id}>
                    Sai da equipe de <Link to={`/empresas/${workspace.id}`} onClick={onClose}>{workspace.name}</Link> (de <Link to={`/usuarios/${workspace.ownerId}`} onClick={onClose}>{workspace.ownerName}</Link>). A empresa e o estoque dela continuam.
                  </li>
                ))}
                <li>{fmtNumber(data.usageEvents)} evento(s) de uso, que deixam de contar nos números.</li>
              </ul>
            </Notice>
          )}
          {blockers.length === 0 && (
            <>
              <label className="field">
                <span className="field__label">Motivo</span>
                <textarea className="textarea" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Ex.: conta de teste do dono" maxLength={500} autoFocus />
                <span className="field__hint">Fica registrado na auditoria (sem o e-mail da conta).</span>
              </label>
              <label className="field">
                <span className="field__label">
                  Digite <code>{email}</code> para confirmar
                </span>
                <input className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" spellCheck={false} />
              </label>
            </>
          )}
          {error && <div className="field__error">{error}</div>}
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
              {blockers.length > 0 ? 'Fechar' : 'Cancelar'}
            </button>
            {blockers.length === 0 && (
              <button type="submit" className="btn btn--danger-solid" disabled={!ready || busy}>
                {busy ? 'Excluindo…' : 'Excluir de vez'}
              </button>
            )}
          </div>
        </form>
      ) : null}
    </Modal>
  );
}
