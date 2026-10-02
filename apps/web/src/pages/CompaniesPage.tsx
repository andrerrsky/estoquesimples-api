import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import { api, ApiError, errorMessage } from '../api/client';
import type { WorkspaceDetail } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, Card, Field, Modal, Notice, PageHeader, useToast } from '../components/ui';
import { fmtDate, plural } from '../lib/format';
import { CURRENCIES, ROLE_LABEL } from '../lib/labels';
import { useWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-company.css';

const roleLabel = (role: string): string => (ROLE_LABEL as Record<string, string>)[role] ?? role;

/**
 * Cria a empresa e já entra nela.
 *
 * Não é preciso renovar a sessão depois de criar: o token de acesso não
 * carrega papéis nem empresas. A API resolve a participação no banco a cada
 * chamada, e `permission_version` só muda quando o papel de alguém é alterado
 * — criar empresa não mexe nela. Basta reler a lista.
 */
function useCreateCompany() {
  const { refresh, select } = useWorkspace();
  const navigate = useNavigate();
  return async (name: string) => {
    const created = await api.post<{ id: string; name: string; createdAt: string }>('/v1/workspaces', { name });
    await refresh();
    select(created.id);
    navigate('/app/estoque');
    return created;
  };
}

/**
 * Empresas do usuário: escolher em qual trabalhar, criar outra e ajustar os
 * dados da que está em uso. Também é a primeira tela de quem acabou de criar
 * a conta e ainda não tem empresa — por isso usa `useWorkspace()`, que aceita
 * a ausência de empresa selecionada.
 */
export function CompaniesPage() {
  const { workspaces, workspace, workspaceId, can, select } = useWorkspace();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);

  if (workspaces.length === 0) return <FirstCompany />;

  const open = (id: string) => {
    select(id);
    navigate('/app/estoque');
  };

  return (
    <div className="page page--narrow">
      <PageHeader
        title="Empresas"
        subtitle="Cada empresa tem o seu estoque, a sua equipe e o seu plano."
        actions={
          <button type="button" className="btn btn--primary" onClick={() => setCreating(true)}>
            <Icon name="plus" size={17} /> Nova empresa
          </button>
        }
      />

      <Card flush>
        <div className="list">
          {workspaces.map((item) => {
            const current = item.id === workspaceId;
            return (
              <div key={item.id} className={`list__item co-row ${current ? 'co-row--current' : ''}`}>
                <span className="co-row__icon">
                  <Icon name="building" />
                </span>
                <div className="list__main">
                  <div className="list__title row row--wrap" style={{ gap: 8 }}>
                    <span style={{ overflowWrap: 'anywhere' }}>{item.name}</span>
                    {current && <Badge tone="brand">em uso</Badge>}
                    {item.status === 'suspended' && <Badge tone="warning">acesso suspenso</Badge>}
                  </div>
                  <div className="list__sub">
                    {roleLabel(item.role)} · {plural(item.memberCount, 'pessoa', 'pessoas')} · criada em {fmtDate(item.createdAt)}
                  </div>
                </div>
                <div className="co-row__actions co-row__actions--wide">
                  {item.status === 'suspended' ? (
                    // A API recusa abrir (MEMBER_SUSPENDED); só quem administra a empresa reativa.
                    <span className="caption">Fale com quem administra a empresa</span>
                  ) : (
                    <button type="button" className={`btn btn--sm ${current ? 'btn--ghost' : 'btn--secondary'}`} onClick={() => open(item.id)}>
                      {current ? 'Abrir estoque' : 'Usar esta empresa'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {workspace && (can('workspace.configurar') ? <CompanySettings key={workspace.id} workspace={workspace} /> : (
        <Notice tone="info">
          Você participa de {workspace.name} como {roleLabel(workspace.role)}. Esse papel não permite alterar o nome nem a moeda da empresa.
        </Notice>
      ))}

      <p className="caption">
        Usa o aplicativo Android com outra empresa nesta mesma conta? Ela aparece aqui depois que o aplicativo sincronizar.
      </p>

      <CreateCompanyDialog open={creating} onClose={() => setCreating(false)} />
    </div>
  );
}

/** Primeiro acesso: ainda não existe empresa, então criar uma é a única coisa a fazer. */
function FirstCompany() {
  const create = useCreateCompany();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await create(name.trim());
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };

  const nameError = error instanceof ApiError ? error.fieldError('name') : undefined;

  return (
    <div className="page page--narrow">
      <Card>
        <form className="onboard" onSubmit={submit}>
          <span className="feature__icon">
            <Icon name="building" size={22} />
          </span>
          <div>
            <h1 className="onboard__title">Para começar, dê um nome à sua empresa</h1>
            <p className="muted" style={{ marginTop: 6 }}>
              É nela que ficam os produtos, as entradas e as saídas. Pode ser o nome da loja, do depósito ou o seu. Dá para mudar depois.
            </p>
          </div>
          {error !== null && !nameError && <Notice tone="error">{errorMessage(error)}</Notice>}
          <Field label="Nome da empresa" error={nameError}>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} placeholder="Ex.: Mercearia da Ana" autoFocus required aria-invalid={nameError ? true : undefined} />
          </Field>
          <button type="submit" className="btn btn--primary btn--lg" disabled={busy || name.trim() === ''}>
            {busy ? 'Criando…' : 'Criar empresa e abrir o estoque'}
          </button>
        </form>
      </Card>

      <Notice tone="info" title="Já usa o aplicativo Android com esta conta?">
        Então não precisa criar outra empresa: abra o aplicativo no celular e deixe sincronizar. A empresa de lá aparece aqui, com os
        mesmos produtos. Se foi convidado para a empresa de outra pessoa, abra o link do convite que chegou por e-mail.
      </Notice>
    </div>
  );
}

function CreateCompanyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const create = useCreateCompany();
  const toast = useToast();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setBusy(false);
    setError(null);
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await create(name.trim());
      toast.success(`Empresa “${created.name}” criada. Você já está nela.`);
      onClose();
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };

  const nameError = error instanceof ApiError ? error.fieldError('name') : undefined;

  return (
    <Modal open={open} onClose={onClose} title="Nova empresa" description="Uma empresa nova começa com o estoque vazio e no plano gratuito. Você é o proprietário dela.">
      <form className="stack" onSubmit={submit}>
        {error !== null && !nameError && <Notice tone="error">{errorMessage(error)}</Notice>}
        <Field label="Nome da empresa" error={nameError}>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus required aria-invalid={nameError ? true : undefined} />
        </Field>
        <div className="row row--end">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>Cancelar</button>
          <button type="submit" className="btn btn--primary" disabled={busy || name.trim() === ''}>
            {busy ? 'Criando…' : 'Criar empresa'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Nome e símbolo de moeda da empresa em uso (`workspace.configurar`). */
function CompanySettings({ workspace }: { workspace: WorkspaceDetail }) {
  const { refresh, currency } = useWorkspace();
  const toast = useToast();
  const [name, setName] = useState(workspace.name);
  const [symbol, setSymbol] = useState(currency);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // O símbolo gravado pode ter vindo do aplicativo e não estar na lista.
  const symbols = CURRENCIES.includes(currency) ? CURRENCIES : [currency, ...CURRENCIES];
  const changed = name.trim() !== workspace.name || symbol !== currency;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || !changed) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch(`/v1/workspaces/${workspace.id}`, {
        ...(name.trim() !== workspace.name ? { name: name.trim() } : {}),
        // A API substitui `settings` inteiro: as outras chaves vão junto para
        // não serem apagadas.
        ...(symbol !== currency ? { settings: { ...workspace.settings, currencySymbol: symbol } } : {}),
      });
      await refresh();
      toast.success('Dados da empresa atualizados.');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const nameError = error instanceof ApiError ? error.fieldError('name') : undefined;

  return (
    <Card title="Dados da empresa em uso" subtitle="O nome aparece para toda a equipe. A moeda é só o símbolo mostrado nos valores; nada é convertido.">
      <form className="stack" onSubmit={submit}>
        {error !== null && !nameError && <Notice tone="error">{errorMessage(error)}</Notice>}
        <div className="form-grid">
          <Field label="Nome da empresa" error={nameError}>
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} required aria-invalid={nameError ? true : undefined} />
          </Field>
          <Field label="Símbolo da moeda">
            <select className="select" value={symbol} onChange={(event) => setSymbol(event.target.value)}>
              {symbols.map((item) => (
                <option key={item} value={item}>
                  {item}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="row row--end">
          <button type="submit" className="btn btn--primary" disabled={busy || !changed || name.trim() === ''}>
            {busy ? 'Salvando…' : 'Salvar alterações'}
          </button>
        </div>
      </form>
    </Card>
  );
}
