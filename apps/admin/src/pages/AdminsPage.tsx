import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { ActionMenu, Badge, Card, ConfirmDialog, Empty, errorMessage, Modal, Notice, PageHeader, Skeleton, Time, useToast } from '../components/ui';
import { ADMIN_ROLE } from '../lib/labels';

interface Admin {
  id: string;
  email: string;
  name: string;
  role: 'owner' | 'support' | 'viewer';
  status: 'active' | 'disabled';
  lastLoginAt: string | null;
  createdAt: string;
}

type Dialog = null | 'create' | { kind: 'role'; admin: Admin } | { kind: 'disable'; admin: Admin } | { kind: 'enable'; admin: Admin } | { kind: 'password'; admin: Admin } | { kind: 'sessions'; admin: Admin };

export function AdminsPage() {
  const { admin: me, can } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [role, setRole] = useState<Admin['role']>('support');
  const [password, setPassword] = useState('');

  const query = useQuery({ queryKey: ['admins'], queryFn: () => api.get<{ items: Admin[] }>('/admins'), enabled: can('owner') });
  const refresh = () => void queryClient.invalidateQueries({ queryKey: ['admins'] });

  if (!can('owner')) return <Navigate to="/" replace />;

  return (
    <div className="page">
      <PageHeader
        title="Administradores"
        subtitle="Quem acessa este painel. Contas separadas das do aplicativo, com papéis e trilha própria."
        actions={<button type="button" className="btn btn--primary" onClick={() => setDialog('create')}><Icon name="plus" /> Novo administrador</button>}
      />
      <Notice tone="info">
        <strong>Owner</strong> faz tudo, inclusive gerir esta lista; <strong>Suporte</strong> opera contas e assinaturas; <strong>Leitura</strong> só consulta. Não é possível rebaixar ou desativar o último owner ativo, nem a si mesmo.
      </Notice>
      <Card flush>
        {query.isLoading ? (
          <div style={{ padding: 18 }}><Skeleton /></div>
        ) : (query.data?.items.length ?? 0) === 0 ? (
          <Empty icon="shield" title="Nenhum administrador" />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Administrador</th><th>Papel</th><th>Situação</th><th>Último acesso</th><th>Criado</th><th></th></tr></thead>
              <tbody>
                {query.data?.items.map((admin) => (
                  <tr key={admin.id}>
                    <td><div className="cell-main">{admin.name}{admin.id === me?.id && <span className="caption"> (você)</span>}</div><div className="cell-sub">{admin.email}</div></td>
                    <td><Badge tone={admin.role === 'owner' ? 'brand' : 'neutral'} plain>{ADMIN_ROLE[admin.role]?.label}</Badge></td>
                    <td><Badge tone={admin.status === 'active' ? 'success' : 'error'}>{admin.status === 'active' ? 'ativo' : 'desativado'}</Badge></td>
                    <td><Time value={admin.lastLoginAt} /></td>
                    <td><Time value={admin.createdAt} /></td>
                    <td>
                      <ActionMenu
                        items={[
                          { label: 'Alterar papel', icon: 'edit', disabled: admin.id === me?.id, onClick: () => { setRole(admin.role); setDialog({ kind: 'role', admin }); } },
                          { label: 'Redefinir senha', icon: 'key', onClick: () => { setPassword(''); setDialog({ kind: 'password', admin }); } },
                          { label: 'Encerrar sessões', icon: 'logout', onClick: () => setDialog({ kind: 'sessions', admin }) },
                          'sep',
                          admin.status === 'active'
                            ? { label: 'Desativar acesso', icon: 'pause', danger: true, disabled: admin.id === me?.id, onClick: () => setDialog({ kind: 'disable', admin }) }
                            : { label: 'Reativar acesso', icon: 'play', onClick: () => setDialog({ kind: 'enable', admin }) },
                        ]}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <CreateAdminDialog open={dialog === 'create'} onClose={() => setDialog(null)} onCreated={refresh} />

      <ConfirmDialog open={typeof dialog === 'object' && dialog?.kind === 'role'} onClose={() => setDialog(null)} title="Alterar papel" requireReason={false} confirmLabel="Alterar" onConfirm={async () => {
        if (typeof dialog !== 'object' || dialog?.kind !== 'role') return;
        await api.patch(`/admins/${dialog.admin.id}`, { role });
        toast.push('Papel atualizado.', 'success');
        refresh();
      }}>
        <label className="field">
          <span className="field__label">Papel</span>
          <select className="select" value={role} onChange={(event) => setRole(event.target.value as Admin['role'])}>
            {(['owner', 'support', 'viewer'] as const).map((key) => <option key={key} value={key}>{ADMIN_ROLE[key]?.label} — {ADMIN_ROLE[key]?.hint}</option>)}
          </select>
        </label>
      </ConfirmDialog>

      <ConfirmDialog open={typeof dialog === 'object' && dialog?.kind === 'disable'} onClose={() => setDialog(null)} title="Desativar acesso" description="As sessões são encerradas e a pessoa não entra mais. Pode ser reativado." requireReason={false} confirmLabel="Desativar" danger onConfirm={async () => {
        if (typeof dialog !== 'object' || dialog?.kind !== 'disable') return;
        await api.patch(`/admins/${dialog.admin.id}`, { status: 'disabled' });
        toast.push('Acesso desativado.', 'success');
        refresh();
      }} />
      <ConfirmDialog open={typeof dialog === 'object' && dialog?.kind === 'enable'} onClose={() => setDialog(null)} title="Reativar acesso" requireReason={false} confirmLabel="Reativar" onConfirm={async () => {
        if (typeof dialog !== 'object' || dialog?.kind !== 'enable') return;
        await api.patch(`/admins/${dialog.admin.id}`, { status: 'active' });
        toast.push('Acesso reativado.', 'success');
        refresh();
      }} />
      <ConfirmDialog open={typeof dialog === 'object' && dialog?.kind === 'sessions'} onClose={() => setDialog(null)} title="Encerrar sessões" description="Todas as sessões abertas deste administrador são encerradas." requireReason={false} confirmLabel="Encerrar" onConfirm={async () => {
        if (typeof dialog !== 'object' || dialog?.kind !== 'sessions') return;
        const result = await api.post<{ revokedSessions: number }>(`/admins/${dialog.admin.id}/revoke-sessions`);
        toast.push(`${result.revokedSessions} sessão(ões) encerrada(s).`, 'success');
      }} />
      <ConfirmDialog open={typeof dialog === 'object' && dialog?.kind === 'password'} onClose={() => setDialog(null)} title="Redefinir senha" description="Mínimo de 10 caracteres. As sessões atuais são encerradas." requireReason={false} confirmLabel="Redefinir" onConfirm={async () => {
        if (typeof dialog !== 'object' || dialog?.kind !== 'password') return;
        await api.post(`/admins/${dialog.admin.id}/reset-password`, { password });
        toast.push('Senha redefinida.', 'success');
      }}>
        <label className="field"><span className="field__label">Nova senha</span><input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={10} autoComplete="new-password" /></label>
      </ConfirmDialog>
    </div>
  );
}

function CreateAdminDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const toast = useToast();
  const [form, setForm] = useState({ name: '', email: '', password: '', role: 'support' as Admin['role'] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/admins', form);
      toast.push('Administrador criado.', 'success');
      setForm({ name: '', email: '', password: '', role: 'support' });
      onCreated();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title="Novo administrador">
      <form onSubmit={submit} className="stack">
        <label className="field"><span className="field__label">Nome</span><input className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} required maxLength={120} /></label>
        <label className="field"><span className="field__label">E-mail</span><input className="input" type="email" value={form.email} onChange={(event) => setForm({ ...form, email: event.target.value })} required /></label>
        <label className="field"><span className="field__label">Senha inicial</span><input className="input" type="password" value={form.password} onChange={(event) => setForm({ ...form, password: event.target.value })} required minLength={10} autoComplete="new-password" /><span className="field__hint">Mínimo de 10 caracteres. Peça para trocar no primeiro acesso.</span></label>
        <label className="field">
          <span className="field__label">Papel</span>
          <select className="select" value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value as Admin['role'] })}>
            {(['owner', 'support', 'viewer'] as const).map((key) => <option key={key} value={key}>{ADMIN_ROLE[key]?.label} — {ADMIN_ROLE[key]?.hint}</option>)}
          </select>
        </label>
        {error && <div className="field__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy}>Criar</button>
        </div>
      </form>
    </Modal>
  );
}
