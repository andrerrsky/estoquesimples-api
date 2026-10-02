import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ApiError, errorMessage, sessionApi } from '../api/client';
import type { Invite, Member, RoleKey } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, Field, Menu, Meter, Modal, Notice, PageHeader, QueryState, useToast, type MenuItem } from '../components/ui';
import { fmtDate, initials, plural } from '../lib/format';
import { INVITABLE_ROLES, ROLE_DESCRIPTION, ROLE_LABEL } from '../lib/labels';
import { useCurrentWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-company.css';

/** Na API `invitedBy` é anulável (quem convidou pode ter saído); em `api/types.ts` está como `string`. */
type TeamInvite = Omit<Invite, 'invitedBy'> & { invitedBy: string | null };

/**
 * Ordem dos papéis, do maior para o menor — a mesma de `roles.rank` na API.
 * Serve só para a tela não oferecer o que a API vai recusar ("ninguém concede
 * papel igual ou superior ao seu"); quem decide é sempre o servidor.
 */
const ROLE_ORDER: RoleKey[] = ['proprietario', 'administrador', 'gerente', 'operador', 'consulta'];

/** `actor` está acima de `target`? Papel desconhecido: deixa a API responder. */
function outranks(actor: string, target: string): boolean {
  const a = ROLE_ORDER.indexOf(actor as RoleKey);
  const t = ROLE_ORDER.indexOf(target as RoleKey);
  return a === -1 || t === -1 ? true : a < t;
}

const roleLabel = (role: string): string => (ROLE_LABEL as Record<string, string>)[role] ?? role;

/**
 * Pessoas e convites da empresa. Equipe é recurso do plano Equipe: no
 * gratuito a tela mostra quem já está aqui (normalmente só o proprietário) e
 * explica o que a assinatura libera. Quem saiu do plano pago continua vendo
 * membros e convites antigos — esconder seria pior do que explicar.
 */
export function TeamPage() {
  const { workspace, workspaceId, base, can, entitlement, teamEnabled, refresh } = useCurrentWorkspace();
  const { user, logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const canView = can('membros.ver');
  const canInvite = can('membros.convidar');
  // Enquanto o plano não carregou, `teamEnabled` é falso só por falta de
  // dado: nada de oferecer assinatura a quem talvez já tenha.
  const freePlan = entitlement !== null && !teamEnabled;

  const members = useQuery({
    queryKey: ['team', workspaceId, 'members'],
    queryFn: () => api.get<{ members: Member[] }>(`${base}/members`).then((response) => response.members),
    enabled: canView,
  });
  const invites = useQuery({
    queryKey: ['team', workspaceId, 'invites'],
    queryFn: () => api.get<{ invites: TeamInvite[] }>(`${base}/invites`).then((response) => response.invites),
    enabled: canView,
  });

  const [inviteOpen, setInviteOpen] = useState(false);
  const [changingRole, setChangingRole] = useState<Member | null>(null);
  const [suspending, setSuspending] = useState<Member | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const [transferring, setTransferring] = useState<Member | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [cancelling, setCancelling] = useState<TeamInvite | null>(null);

  // Quem entra ou sai muda a contagem da empresa e o uso do plano.
  const reload = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['team', workspaceId] }), refresh()]);
  };

  const reactivate = useMutation({
    mutationFn: (member: Member) => api.patch(`${base}/members/${member.userId}/status`, { status: 'active' }),
    onSuccess: (_data, member) => {
      void reload();
      toast.success(`${member.name} voltou a ter acesso.`);
    },
    // No plano gratuito a API recusa (SUBSCRIPTION_REQUIRED) e a mensagem dela já explica.
    onError: (error) => toast.error(error),
  });

  // Convidar o mesmo e-mail de novo substitui o convite anterior e manda outro link.
  const resend = useMutation({
    mutationFn: (invite: TeamInvite) => api.post<TeamInvite>(`${base}/invites`, { email: invite.email, roleKey: invite.roleKey }),
    onSuccess: (created) => {
      void reload();
      toast.success(`Novo convite enviado para ${created.email}.`);
    },
    onError: (error) => toast.error(error),
  });

  const suspend = async (member: Member) => {
    await api.patch(`${base}/members/${member.userId}/status`, { status: 'suspended' });
    await reload();
    toast.push(`${member.name} está sem acesso até a reativação.`);
  };

  const remove = async (member: Member) => {
    await api.delete(`${base}/members/${member.userId}`);
    await reload();
    toast.push(`${member.name} saiu da equipe.`);
  };

  const cancelInvite = async (invite: TeamInvite) => {
    await api.delete(`${base}/invites/${invite.id}`);
    await reload();
    toast.push(`Convite para ${invite.email} cancelado.`);
  };

  // Sair da empresa é remover a si mesmo; a API encerra todas as sessões de
  // quem foi removido, inclusive esta. Melhor sair de forma limpa do que
  // esperar a próxima chamada falhar.
  const leave = async () => {
    if (!user) return;
    await api.delete(`${base}/members/${user.id}`);
    toast.push(`Você saiu de ${workspace.name}. Entre de novo para continuar usando sua conta.`);
    await logout().catch(() => undefined);
    navigate('/entrar', { replace: true });
  };

  const list = members.data ?? [];
  const activeCount = list.filter((member) => member.status === 'active').length;
  const others = list.filter((member) => member.role !== 'proprietario');
  // Aceitos e cancelados são história; pendentes e vencidos ainda pedem uma ação.
  const openInvites = (invites.data ?? []).filter((invite) => invite.status === 'pendente' || invite.status === 'expirado');

  const memberLimit = entitlement?.limits.members ?? null;
  const memberUsage = entitlement?.usage.members ?? activeCount;
  const limited = teamEnabled && memberLimit !== null && memberLimit > 0;
  const atLimit = limited && memberLimit !== null && memberUsage >= memberLimit;

  const memberMenu = (member: Member): Array<MenuItem | 'sep'> => {
    const self = member.userId === user?.id;
    const owner = member.role === 'proprietario';
    if (self) {
      return !owner && can('membros.remover') ? [{ label: 'Sair da empresa', icon: 'logout', danger: true, onClick: () => setLeaving(true) }] : [];
    }
    const manageable = !owner && outranks(workspace.role, member.role);
    const items: Array<MenuItem | 'sep'> = [];
    if (manageable && can('membros.alterar_papel')) items.push({ label: 'Alterar papel', icon: 'shield', onClick: () => setChangingRole(member) });
    if (manageable && can('membros.suspender')) {
      items.push(
        member.status === 'suspended'
          ? { label: 'Reativar acesso', icon: 'undo', onClick: () => reactivate.mutate(member) }
          : { label: 'Suspender acesso', icon: 'lock', onClick: () => setSuspending(member) },
      );
    }
    if (can('workspace.transferir') && member.status === 'active') {
      items.push({ label: 'Transferir propriedade', icon: 'transfer', onClick: () => setTransferring(member) });
    }
    if (manageable && can('membros.remover')) {
      if (items.length > 0) items.push('sep');
      items.push({ label: 'Remover da empresa', icon: 'trash', danger: true, onClick: () => setRemoving(member) });
    }
    return items;
  };

  if (!canView) {
    return (
      <div className="page">
        <PageHeader title="Equipe" subtitle={workspace.name} />
        <Card>
          <Empty icon="lock" title="Seu papel não dá acesso à equipe">
            Você participa de {workspace.name} como {roleLabel(workspace.role)}. Para ver ou convidar pessoas, peça a um administrador que altere o seu papel.
          </Empty>
        </Card>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader
        title="Equipe"
        subtitle={members.data ? `${plural(activeCount, 'pessoa', 'pessoas')} em ${workspace.name}` : workspace.name}
        actions={
          canInvite &&
          teamEnabled && (
            <button type="button" className="btn btn--primary" onClick={() => setInviteOpen(true)} disabled={atLimit}>
              <Icon name="plus" size={17} /> Convidar pessoa
            </button>
          )
        }
      />

      {freePlan && (others.length > 0 || openInvites.length > 0) && (
        <Notice
          tone="warning"
          title="A empresa está no plano gratuito"
          action={<Link to="/app/plano" className="btn btn--secondary btn--sm">Ver plano</Link>}
        >
          As pessoas abaixo continuam na equipe, mas no plano gratuito só o proprietário acessa o estoque na nuvem. Com o plano Equipe
          todas voltam a ver e movimentar o estoque. Ninguém foi removido.
        </Notice>
      )}

      {limited && memberLimit !== null && (
        <Card>
          <div className="row row--between">
            <span className="strong">Pessoas na empresa</span>
            <span className="muted num">
              {memberUsage} de {memberLimit}
            </span>
          </div>
          <Meter value={memberUsage} max={memberLimit} />
          {atLimit && (
            <p className="caption" style={{ marginTop: 8 }}>
              O plano permite até {memberLimit} pessoas. Para convidar mais alguém, remova uma pessoa ou fale com o suporte.
            </p>
          )}
        </Card>
      )}

      <Card flush title="Pessoas" subtitle="Quem tem acesso a esta empresa e o que cada um pode fazer.">
        {members.isLoading || (members.error && !members.data) ? (
          <QueryState loading={members.isLoading} error={members.error} onRetry={() => void members.refetch()} />
        ) : (
          <div className="list">
            {list.map((member) => {
              const menu = memberMenu(member);
              return (
                <div key={member.id} className="list__item co-row">
                  <span className="avatar">{initials(member.name)}</span>
                  <div className="list__main">
                    <div className="list__title row row--wrap" style={{ gap: 8 }}>
                      <span style={{ overflowWrap: 'anywhere' }}>{member.name}</span>
                      {member.userId === user?.id && <Badge tone="brand">você</Badge>}
                    </div>
                    <div className="list__sub" style={{ overflowWrap: 'anywhere' }}>{member.email}</div>
                  </div>
                  <div className="co-row__tags">
                    <Badge tone={member.role === 'proprietario' ? 'solid' : 'neutral'}>{roleLabel(member.role)}</Badge>
                    {member.status === 'suspended' && <Badge tone="warning">Acesso suspenso</Badge>}
                    <span className="caption hide-mobile">desde {fmtDate(member.joinedAt)}</span>
                  </div>
                  <div className="co-row__actions">
                    {menu.length > 0 ? (
                      <Menu
                        label={`Ações de ${member.name}`}
                        items={menu}
                        trigger={(props) => (
                          <button type="button" className="icon-btn" aria-label={`Ações de ${member.name}`} {...props}>
                            <Icon name="more" />
                          </button>
                        )}
                      />
                    ) : (
                      <span style={{ width: 38 }} aria-hidden="true" />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      {(teamEnabled || openInvites.length > 0) && (
        <Card flush title="Convites pendentes" subtitle="A pessoa recebe um link por e-mail. Só existe um convite válido por e-mail.">
          {invites.isLoading || (invites.error && !invites.data) ? (
            <QueryState loading={invites.isLoading} error={invites.error} onRetry={() => void invites.refetch()} />
          ) : openInvites.length === 0 ? (
            <Empty
              icon="mail"
              title="Nenhum convite aguardando resposta"
              actions={
                canInvite &&
                teamEnabled &&
                !atLimit && (
                  <button type="button" className="btn btn--secondary btn--sm" onClick={() => setInviteOpen(true)}>
                    Convidar pessoa
                  </button>
                )
              }
            >
              Convide alguém pelo e-mail e escolha o papel que essa pessoa terá na empresa.
            </Empty>
          ) : (
            <div className="list">
              {openInvites.map((invite) => (
                <div key={invite.id} className="list__item co-row">
                  <span className="co-row__icon">
                    <Icon name="mail" />
                  </span>
                  <div className="list__main">
                    <div className="list__title" style={{ overflowWrap: 'anywhere' }}>{invite.email}</div>
                    <div className="list__sub">
                      {roleLabel(invite.roleKey)} · {invite.status === 'expirado' ? `venceu em ${fmtDate(invite.expiresAt)}` : `vale até ${fmtDate(invite.expiresAt)}`}
                    </div>
                  </div>
                  <div className="co-row__tags">
                    {invite.status === 'expirado' ? <Badge tone="warning">Vencido</Badge> : <Badge tone="info">Aguardando</Badge>}
                  </div>
                  {canInvite && (
                    <div className="co-row__actions co-row__actions--wide">
                      {teamEnabled && (
                        <button type="button" className="btn btn--ghost btn--sm" disabled={resend.isPending} onClick={() => resend.mutate(invite)}>
                          Reenviar
                        </button>
                      )}
                      <button type="button" className="btn btn--ghost btn--sm" onClick={() => setCancelling(invite)}>
                        Cancelar
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      {freePlan && <TeamUpsell isOwner={workspace.isOwner} />}

      <InviteDialog open={inviteOpen} actorRole={workspace.role} onClose={() => setInviteOpen(false)} onSent={() => void reload()} />

      <RoleDialog member={changingRole} actorRole={workspace.role} onClose={() => setChangingRole(null)} onSaved={() => void reload()} />

      <TransferDialog
        member={transferring}
        onClose={() => setTransferring(null)}
        onDone={async () => {
          // O papel de quem transferiu mudou (proprietário → administrador):
          // o token em uso descreve permissões antigas.
          await sessionApi.renew();
          await reload();
        }}
      />

      <ConfirmDialog
        open={suspending !== null}
        onClose={() => setSuspending(null)}
        title="Suspender acesso?"
        description={
          suspending ? (
            <>
              {suspending.name} fica sem acesso a {workspace.name} até a reativação, e as sessões dessa pessoa são encerradas em todos os
              aparelhos. O papel e o histórico são mantidos.
            </>
          ) : undefined
        }
        confirmLabel="Suspender"
        danger
        onConfirm={() => (suspending ? suspend(suspending) : undefined)}
      />

      <ConfirmDialog
        open={removing !== null}
        onClose={() => setRemoving(null)}
        title="Remover da empresa?"
        description={
          removing ? (
            <>
              {removing.name} perde o acesso a {workspace.name}, e as sessões dessa pessoa são encerradas em todos os aparelhos. As
              movimentações que ela registrou continuam no histórico. Para voltar, será preciso um novo convite.
            </>
          ) : undefined
        }
        confirmLabel="Remover"
        danger
        onConfirm={() => (removing ? remove(removing) : undefined)}
      />

      <ConfirmDialog
        open={leaving}
        onClose={() => setLeaving(false)}
        title={`Sair de ${workspace.name}?`}
        description="Você perde o acesso a esta empresa e sua conta é desconectada de todos os aparelhos, inclusive deste navegador. Para voltar, alguém da empresa precisa convidar você de novo."
        confirmLabel="Sair da empresa"
        danger
        onConfirm={leave}
      />

      <ConfirmDialog
        open={cancelling !== null}
        onClose={() => setCancelling(null)}
        title="Cancelar convite?"
        description={cancelling ? <>O link enviado para {cancelling.email} deixa de funcionar.</> : undefined}
        confirmLabel="Cancelar convite"
        danger
        onConfirm={() => (cancelling ? cancelInvite(cancelling) : undefined)}
      />
    </div>
  );
}

/** O que o plano Equipe libera, para quem está no gratuito. Sem preço aqui: ele vem da API na tela Plano. */
function TeamUpsell({ isOwner }: { isOwner: boolean }) {
  return (
    <Card>
      <div className="upsell">
        <div className="stack">
          <div>
            <Badge tone="brand">Plano Equipe</Badge>
            <h2 className="upsell__title" style={{ marginTop: 10 }}>Trabalhe com outras pessoas no mesmo estoque</h2>
          </div>
          <p className="muted">
            No plano gratuito a empresa é só de quem a criou. Com o plano Equipe você convida pessoas por e-mail e escolhe o que cada uma
            pode fazer. Todas veem o mesmo estoque, no celular e no computador, e cada movimentação fica registrada com o nome de quem fez.
          </p>
          <div className="row row--wrap">
            <Link to="/app/plano" className="btn btn--primary">
              Conhecer o plano Equipe
            </Link>
          </div>
          {!isOwner && <p className="caption">Só o proprietário da empresa pode assinar.</p>}
        </div>
        <dl className="upsell__roles">
          {INVITABLE_ROLES.map((role) => (
            <div key={role}>
              <dt>{ROLE_LABEL[role]}</dt>
              <dd>{ROLE_DESCRIPTION[role]}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}

function RoleOptions({ value, onChange, roles }: { value: RoleKey | null; onChange: (role: RoleKey) => void; roles: RoleKey[] }) {
  const name = useId();
  return (
    <fieldset className="option-list">
      <legend className="field__label">Papel na empresa</legend>
      {roles.map((role) => (
        <label key={role} className={`option ${value === role ? 'option--selected' : ''}`}>
          <input type="radio" name={name} checked={value === role} onChange={() => onChange(role)} />
          <span className="option__body">
            <span className="option__title">{ROLE_LABEL[role]}</span>
            <span className="option__sub">{ROLE_DESCRIPTION[role]}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** Papéis que este usuário pode conceder: os abaixo do dele. A API confere de novo. */
const grantableRoles = (actorRole: string): RoleKey[] => INVITABLE_ROLES.filter((role) => outranks(actorRole, role));

function InviteDialog({ open, actorRole, onClose, onSent }: { open: boolean; actorRole: string; onClose: () => void; onSent: () => void }) {
  const { base } = useCurrentWorkspace();
  const toast = useToast();
  const roles = grantableRoles(actorRole);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<RoleKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setEmail('');
    // Operador é o papel do dia a dia (cadastra e movimenta, sem excluir).
    setRole(roles.includes('operador') ? 'operador' : (roles[roles.length - 1] ?? null));
    setBusy(false);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !role) return;
    setBusy(true);
    setError(null);
    try {
      const invite = await api.post<TeamInvite>(`${base}/invites`, { email: email.trim(), roleKey: role });
      toast.success(`Convite enviado para ${invite.email}. Vale até ${fmtDate(invite.expiresAt)}.`);
      onSent();
      onClose();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError ? error : null;
  const emailError = apiError?.fieldError('email');

  return (
    <Modal open={open} onClose={onClose} title="Convidar pessoa" description="Enviamos um link por e-mail. Quem ainda não tem conta cria a senha ao aceitar.">
      <form className="stack" onSubmit={submit}>
        {error !== null && !emailError && (
          <Notice
            tone="error"
            action={
              apiError?.isPlanBlocked ? (
                <Link to="/app/plano" className="btn btn--secondary btn--sm">Ver plano</Link>
              ) : apiError?.code === 'AUTH_EMAIL_NOT_VERIFIED' ? (
                <Link to="/app/conta" className="btn btn--secondary btn--sm">Confirmar e-mail</Link>
              ) : undefined
            }
          >
            {errorMessage(error)}
          </Notice>
        )}
        <Field label="E-mail da pessoa" error={emailError}>
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} maxLength={254} autoComplete="off" autoFocus required aria-invalid={emailError ? true : undefined} />
        </Field>
        {roles.length > 0 ? (
          <RoleOptions value={role} onChange={setRole} roles={roles} />
        ) : (
          <Notice tone="warning">O seu papel não permite conceder nenhum papel a outra pessoa.</Notice>
        )}
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || !role}>
            {busy ? 'Enviando…' : 'Enviar convite'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

function RoleDialog({ member, actorRole, onClose, onSaved }: { member: Member | null; actorRole: string; onClose: () => void; onSaved: () => void }) {
  const { base } = useCurrentWorkspace();
  const toast = useToast();
  const roles = grantableRoles(actorRole);
  const [role, setRole] = useState<RoleKey | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    setRole(INVITABLE_ROLES.includes(member.role) ? member.role : null);
    setBusy(false);
    setError(null);
  }, [member]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !member || !role) return;
    if (role === member.role) return onClose();
    setBusy(true);
    setError(null);
    try {
      await api.patch(`${base}/members/${member.userId}/role`, { role });
      toast.success(`${member.name} agora é ${ROLE_LABEL[role]}.`);
      onSaved();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={member !== null}
      onClose={onClose}
      title="Alterar papel"
      description={member ? <>O que {member.name} pode fazer nesta empresa. A mudança vale na hora, em todos os aparelhos da pessoa.</> : undefined}
    >
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <RoleOptions value={role} onChange={setRole} roles={roles} />
        <p className="caption">Para tornar alguém proprietário, use “Transferir propriedade” no menu da pessoa.</p>
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || !role}>
            {busy ? 'Salvando…' : 'Salvar papel'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Transferência de propriedade: a única forma de trocar o proprietário. Não
 * dá para desfazer sozinho (só o novo dono pode devolver), então a confirmação
 * é explícita e o botão só libera depois de marcada.
 */
function TransferDialog({ member, onClose, onDone }: { member: Member | null; onClose: () => void; onDone: () => Promise<void> }) {
  const { base, workspace } = useCurrentWorkspace();
  const toast = useToast();
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!member) return;
    setConfirmed(false);
    setBusy(false);
    setError(null);
  }, [member]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !member || !confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`${base}/transfer-ownership`, { newOwnerUserId: member.userId });
    } catch (caught) {
      setError(errorMessage(caught));
      setBusy(false);
      return;
    }
    // A transferência já valeu; se a atualização da tela falhar, recarregar resolve.
    await onDone().catch(() => undefined);
    toast.success(`A propriedade de ${workspace.name} agora é de ${member.name}. Seu papel passou a ser Administrador.`);
    setBusy(false);
    onClose();
  };

  return (
    <Modal open={member !== null} onClose={onClose} title="Transferir propriedade" description={member ? <>Passar a propriedade de {workspace.name} para {member.name} ({member.email}).</> : undefined}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <ul className="plain-list">
          <li>{member?.name} passa a ter controle total da empresa, inclusive da assinatura.</li>
          <li>Você continua na empresa com o papel de Administrador: gerencia estoque e equipe, mas não cuida mais do plano nem transfere a empresa.</li>
          <li>Só o novo proprietário pode devolver a propriedade a você.</li>
        </ul>
        <label className="checkbox">
          <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} />
          Entendi e quero transferir a empresa.
        </label>
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--danger-solid" disabled={busy || !confirmed}>
            {busy ? 'Transferindo…' : 'Transferir propriedade'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
