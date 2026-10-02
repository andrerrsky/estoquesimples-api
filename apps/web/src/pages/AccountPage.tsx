import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { api, ApiError, errorMessage } from '../api/client';
import type { DeviceSummary, SessionSummary, User } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, Field, Notice, PageHeader, QueryState, Time, useToast } from '../components/ui';
import { APP_VERSION } from '../lib/device';
import { fmtDate } from '../lib/format';
import { useWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-company.css';

/**
 * Conta do usuário: perfil, senha, onde a conta está aberta e exclusão.
 * Funciona sem empresa selecionada (primeiro acesso), por isso não depende
 * de `useCurrentWorkspace()`.
 */
export function AccountPage() {
  const { user } = useAuth();
  if (!user) return null;

  return (
    <div className="page page--narrow">
      <PageHeader title="Minha conta" subtitle="Seus dados de acesso valem para o aplicativo e para o navegador." />
      <ProfileCard />
      <PasswordCard />
      <SessionsCard />
      <DeleteAccountCard />
      <Card title="Sobre">
        <div className="stack stack--tight">
          <div className="row row--between">
            <span className="muted">Versão da aplicação web</span>
            <span className="mono">{APP_VERSION}</span>
          </div>
          <div className="link-row" style={{ fontSize: 'var(--fs-supporting)' }}>
            <Link to="/termos">Termos de Uso</Link>
            <Link to="/privacidade">Política de Privacidade</Link>
            <Link to="/app/suporte">Ajuda e suporte</Link>
          </div>
        </div>
      </Card>
    </div>
  );
}

function ProfileCard() {
  const { user, reloadUser } = useAuth();
  const toast = useToast();
  const [name, setName] = useState(user?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.patch('/v1/me', { name: name.trim() });
      await reloadUser();
      toast.success('Nome atualizado.');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const resend = useMutation({
    mutationFn: () => api.post('/v1/auth/resend-verification'),
    onSuccess: () => setSent(true),
    onError: (caught) => toast.error(caught),
  });

  // A confirmação acontece em outra aba (link do e-mail) ou no aplicativo:
  // esta tela só fica sabendo quando relê o perfil.
  const check = useMutation({
    mutationFn: () => api.get<User>('/v1/me'),
    onSuccess: async (profile) => {
      if (!profile.emailVerified) return toast.push('A confirmação ainda não consta. Abra o link do e-mail mais recente e tente de novo.');
      await reloadUser();
      toast.success('E-mail confirmado.');
    },
    onError: (caught) => toast.error(caught),
  });

  if (!user) return null;
  const nameError = error instanceof ApiError ? error.fieldError('name') : undefined;
  const changed = name.trim() !== user.name && name.trim() !== '';

  return (
    <Card title="Perfil">
      <div className="stack">
        <form className="inline-form" onSubmit={save}>
          <Field label="Seu nome">
            <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoComplete="name" required aria-invalid={error !== null ? true : undefined} />
          </Field>
          <button type="submit" className="btn btn--secondary" disabled={busy || !changed}>
            {busy ? 'Salvando…' : 'Salvar'}
          </button>
        </form>
        {error !== null ? (
          <span className="field__error" role="alert" style={{ marginTop: -8 }}>{nameError ?? errorMessage(error)}</span>
        ) : (
          <span className="field__hint" style={{ marginTop: -8 }}>O nome aparece para a equipe e no histórico de movimentações.</span>
        )}

        <div>
          <div className="field__label">E-mail</div>
          <div className="row row--wrap" style={{ marginTop: 6, gap: 8 }}>
            <span style={{ overflowWrap: 'anywhere' }}>{user.email}</span>
            {user.emailVerified ? <Badge tone="success">Confirmado</Badge> : <Badge tone="warning">Não confirmado</Badge>}
          </div>
          <p className="caption" style={{ marginTop: 4 }}>O e-mail é o seu acesso e não pode ser trocado por aqui. Se precisar mudar, fale com o suporte.</p>
        </div>

        {!user.emailVerified && (
          <Notice tone="warning" title="Confirme seu e-mail">
            <p>
              {sent
                ? `Enviamos um novo link para ${user.email}. Abra o e-mail, toque no link e depois volte aqui. Links anteriores deixam de valer.`
                : 'Sem a confirmação você não consegue convidar pessoas para a empresa. Procure o e-mail que enviamos no cadastro ou peça um novo.'}
            </p>
            <div className="row row--wrap" style={{ marginTop: 10 }}>
              <button type="button" className="btn btn--secondary btn--sm" onClick={() => resend.mutate()} disabled={resend.isPending}>
                {resend.isPending ? 'Enviando…' : sent ? 'Enviar de novo' : 'Reenviar e-mail de confirmação'}
              </button>
              <button type="button" className="btn btn--ghost btn--sm" onClick={() => check.mutate()} disabled={check.isPending}>
                {check.isPending ? 'Conferindo…' : 'Já confirmei'}
              </button>
            </div>
          </Notice>
        )}
      </div>
    </Card>
  );
}

function PasswordInput({ label, value, onChange, autoComplete, error }: { label: string; value: string; onChange: (value: string) => void; autoComplete: string; error?: string | undefined }) {
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} error={error}>
      <div className="input-group input-group--suffix">
        <input className="input" type={visible ? 'text' : 'password'} value={value} onChange={(event) => onChange(event.target.value)} autoComplete={autoComplete} maxLength={200} required aria-invalid={error ? true : undefined} />
        <button type="button" className="icon-btn input-group__action" onClick={() => setVisible((current) => !current)} aria-label={visible ? 'Ocultar senha' : 'Mostrar senha'}>
          <Icon name={visible ? 'eyeOff' : 'eye'} size={17} />
        </button>
      </div>
    </Field>
  );
}

/** As regras de senha da API, mostradas enquanto a pessoa digita. Quem valida é a API. */
function PasswordRules({ password, email }: { password: string; email: string }) {
  const local = email.split('@')[0]?.toLowerCase() ?? '';
  const rules = [
    { ok: password.length >= 10, text: 'Pelo menos 10 caracteres' },
    { ok: password.length > 0 && !/^(.)\1+$/.test(password), text: 'Não pode ser um único caractere repetido' },
    { ok: password.length > 0 && !(local.length >= 4 && password.toLowerCase().includes(local)), text: 'Não pode conter o seu e-mail' },
  ];
  return (
    <ul className="rules">
      {rules.map((rule) => (
        <li key={rule.text} className={rule.ok ? 'ok' : ''}>
          <Icon name={rule.ok ? 'check' : 'minus'} size={14} /> {rule.text}
        </li>
      ))}
    </ul>
  );
}

function PasswordCard() {
  const { user } = useAuth();
  const toast = useToast();
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/auth/change-password', { currentPassword: current, newPassword: next, revokeOtherSessions: revokeOthers });
      setCurrent('');
      setNext('');
      // A API mantém a sessão de quem trocou a senha e, se pedido, encerra as
      // outras. Se algum dia esta também cair, a próxima chamada leva a pessoa
      // de volta à tela de entrada, onde ela usa a senha nova.
      void queryClient.invalidateQueries({ queryKey: ['account'] });
      toast.success(revokeOthers ? 'Senha alterada. Os outros aparelhos foram desconectados.' : 'Senha alterada.');
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const apiError = error instanceof ApiError ? error : null;
  const wrongCurrent = apiError?.code === 'AUTH_INVALID_CREDENTIALS' ? apiError.message : apiError?.fieldError('currentPassword');
  // A política pode apontar mais de um problema na senha nova.
  const weak = apiError?.details.filter((detail) => detail.field === 'newPassword').map((detail) => detail.message).join(' ') || undefined;

  return (
    <Card title="Senha" subtitle="A mesma senha vale em todas as plataformas: aplicativo Android, navegador e web app.">
      <form className="stack" onSubmit={submit}>
        {error !== null && !wrongCurrent && !weak && <Notice tone="error">{errorMessage(error)}</Notice>}
        <div className="form-grid">
          <PasswordInput label="Senha atual" value={current} onChange={setCurrent} autoComplete="current-password" error={wrongCurrent} />
          <PasswordInput label="Nova senha" value={next} onChange={setNext} autoComplete="new-password" error={weak} />
        </div>
        <PasswordRules password={next} email={user?.email ?? ''} />
        <label className="checkbox">
          <input type="checkbox" checked={revokeOthers} onChange={(event) => setRevokeOthers(event.target.checked)} />
          Desconectar os outros aparelhos e navegadores
        </label>
        <p className="caption">
          Este navegador continua conectado. {revokeOthers ? 'Nos outros lugares será preciso entrar de novo, com a senha nova.' : 'Os outros lugares continuam conectados até a sessão deles terminar.'}
        </p>
        <div className="row row--end">
          <button type="submit" className="btn btn--primary" disabled={busy || current === '' || next === ''}>
            {busy ? 'Alterando…' : 'Alterar senha'}
          </button>
        </div>
      </form>
    </Card>
  );
}

interface OpenSession {
  session: SessionSummary;
  device: DeviceSummary | undefined;
}

const PLATFORM_LABEL: Record<string, string> = { android: 'Aplicativo Android', ios: 'Aplicativo iOS', web: 'Navegador' };

/**
 * Sessões abertas (cada login é uma sessão) cruzadas com os aparelhos
 * registrados, que é de onde vem a plataforma. Aparelhos sem sessão aberta
 * aparecem no fim, só para poderem ser removidos da conta.
 */
function SessionsCard() {
  const { logout } = useAuth();
  const toast = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [ending, setEnding] = useState<OpenSession | null>(null);
  const [forgetting, setForgetting] = useState<DeviceSummary | null>(null);
  const [endingAll, setEndingAll] = useState(false);

  const sessions = useQuery({
    queryKey: ['account', 'sessions'],
    queryFn: () => api.get<{ sessions: SessionSummary[] }>('/v1/me/sessions').then((response) => response.sessions),
  });
  const devices = useQuery({
    queryKey: ['account', 'devices'],
    queryFn: () => api.get<{ devices: DeviceSummary[] }>('/v1/me/devices').then((response) => response.devices),
  });

  const reload = () => queryClient.invalidateQueries({ queryKey: ['account'] });

  const deviceById = new Map((devices.data ?? []).map((device) => [device.id, device]));
  // A API lista as sessões não encerradas, inclusive as que já venceram por
  // falta de uso; essas não estão "abertas" em lugar nenhum.
  const open: OpenSession[] = (sessions.data ?? [])
    .filter((session) => session.current || new Date(session.expiresAt).getTime() > Date.now())
    .map((session) => ({ session, device: session.deviceId ? deviceById.get(session.deviceId) : undefined }))
    .sort((a, b) => Number(b.session.current) - Number(a.session.current));
  const withSession = new Set(open.map((item) => item.session.deviceId));
  const idle = (devices.data ?? []).filter((device) => !withSession.has(device.id));
  const others = open.filter((item) => !item.session.current).length;

  const endSession = async (item: OpenSession) => {
    await api.delete(`/v1/me/sessions/${item.session.id}`);
    await reload();
    toast.push('Sessão encerrada.');
  };

  const forgetDevice = async (device: DeviceSummary) => {
    await api.delete(`/v1/me/devices/${device.id}`);
    await reload();
    toast.push('Aparelho removido da conta.');
  };

  // "Sair de todos" encerra também esta sessão: em vez de deixar a próxima
  // chamada falhar, a tela já leva para a entrada.
  const endAll = async () => {
    await api.post('/v1/auth/logout-all');
    toast.push('Sua conta foi desconectada de todos os aparelhos.');
    await logout().catch(() => undefined);
    navigate('/entrar', { replace: true });
  };

  const describe = (item: OpenSession): string => item.session.deviceModel ?? item.device?.model ?? PLATFORM_LABEL[item.device?.platform ?? ''] ?? 'Aparelho não identificado';

  return (
    <Card
      flush
      title="Onde sua conta está aberta"
      subtitle="Não reconhece algum? Encerre a sessão e troque a senha."
      actions={
        <button type="button" className="btn btn--danger btn--sm" onClick={() => setEndingAll(true)}>
          Sair de todos
        </button>
      }
    >
      {sessions.isLoading || (sessions.error && !sessions.data) ? (
        <QueryState loading={sessions.isLoading} error={sessions.error} onRetry={() => void sessions.refetch()} />
      ) : open.length === 0 ? (
        <Empty icon="monitor" title="Nenhuma sessão aberta" />
      ) : (
        <div className="list">
          {open.map((item) => {
            const platform = item.device?.platform;
            const version = item.session.appVersionName ?? item.device?.appVersionName;
            return (
              <div key={item.session.id} className="list__item co-row">
                <span className="co-row__icon">
                  <Icon name={platform === 'android' || platform === 'ios' ? 'phone' : 'monitor'} />
                </span>
                <div className="list__main">
                  <div className="list__title row row--wrap" style={{ gap: 8 }}>
                    <span style={{ overflowWrap: 'anywhere' }}>{describe(item)}</span>
                    {item.session.current && <Badge tone="brand">este navegador</Badge>}
                  </div>
                  <div className="list__sub">
                    {[platform ? PLATFORM_LABEL[platform] ?? platform : null, version ? `versão ${version}` : null].filter(Boolean).join(' · ')}
                    {platform || version ? ' · ' : ''}
                    {item.session.current ? 'em uso agora' : <>último uso: <Time value={item.session.lastUsedAt} /></>} · entrou em {fmtDate(item.session.createdAt)}
                  </div>
                </div>
                {!item.session.current && (
                  <div className="co-row__actions co-row__actions--wide">
                    <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEnding(item)}>
                      Encerrar
                    </button>
                  </div>
                )}
              </div>
            );
          })}
          {idle.map((device) => (
            <div key={device.id} className="list__item co-row">
              <span className="co-row__icon">
                <Icon name={device.platform === 'android' || device.platform === 'ios' ? 'phone' : 'monitor'} />
              </span>
              <div className="list__main">
                <div className="list__title" style={{ overflowWrap: 'anywhere' }}>{device.model ?? PLATFORM_LABEL[device.platform] ?? 'Aparelho não identificado'}</div>
                <div className="list__sub">
                  {PLATFORM_LABEL[device.platform] ?? device.platform}
                  {device.appVersionName ? ` · versão ${device.appVersionName}` : ''} · sem sessão aberta · último acesso: <Time value={device.lastSeenAt} />
                </div>
              </div>
              <div className="co-row__actions co-row__actions--wide">
                <button type="button" className="btn btn--ghost btn--sm" onClick={() => setForgetting(device)}>
                  Remover
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={ending !== null}
        onClose={() => setEnding(null)}
        title="Encerrar esta sessão?"
        description={ending ? <>{describe(ending)} é desconectado na hora e precisa da senha para entrar de novo. Nada é apagado do aparelho.</> : undefined}
        confirmLabel="Encerrar sessão"
        danger
        onConfirm={() => (ending ? endSession(ending) : undefined)}
      />

      <ConfirmDialog
        open={forgetting !== null}
        onClose={() => setForgetting(null)}
        title="Remover este aparelho?"
        description="Ele sai da lista de aparelhos da sua conta. Se você entrar por ele de novo, volta a aparecer."
        confirmLabel="Remover"
        danger
        onConfirm={() => (forgetting ? forgetDevice(forgetting) : undefined)}
      />

      <ConfirmDialog
        open={endingAll}
        onClose={() => setEndingAll(false)}
        title="Sair de todos os aparelhos?"
        description={
          others > 0
            ? `Sua conta é desconectada deste navegador e de mais ${others === 1 ? '1 lugar' : `${others} lugares`}. Em todos será preciso entrar de novo com e-mail e senha.`
            : 'Sua conta é desconectada deste navegador, o único lugar onde está aberta. Será preciso entrar de novo com e-mail e senha.'
        }
        confirmLabel="Sair de todos"
        danger
        onConfirm={endAll}
      />
    </Card>
  );
}

/**
 * Exclusão da conta, como a API faz hoje (`DELETE /v1/me`): pede a senha,
 * recusa enquanto a pessoa for proprietária de alguma empresa, bloqueia o
 * acesso na hora e abre um prazo de recuperação.
 */
function DeleteAccountCard() {
  const { logout } = useAuth();
  const { workspaces } = useWorkspace();
  const toast = useToast();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');

  useEffect(() => {
    if (open) setPassword('');
  }, [open]);

  const owned = workspaces.filter((item) => item.isOwner);

  const remove = async () => {
    if (password === '') throw new Error('Digite sua senha para confirmar.');
    const result = await api.delete<{ message: string; recoverableUntil: string }>('/v1/me', { password });
    toast.push(`Conta marcada para exclusão. Se mudar de ideia, fale com o suporte até ${fmtDate(result.recoverableUntil)}.`, { duration: 15_000 });
    // A API já encerrou todas as sessões; isto limpa o que sobrou no navegador.
    await logout().catch(() => undefined);
    navigate('/', { replace: true });
  };

  return (
    <Card className="card--danger" title="Excluir conta">
      <div className="stack">
        <ul className="plain-list">
          <li>A conta é bloqueada na hora e desconectada de todos os aparelhos.</li>
          <li>Ela fica em recuperação por 30 dias: nesse prazo o suporte consegue reativá-la. Depois, a exclusão é definitiva.</li>
          <li>O que está gravado no aplicativo do celular não é apagado.</li>
        </ul>

        {owned.length > 0 ? (
          <Notice tone="warning" title={owned.length === 1 ? 'Você é proprietário de uma empresa' : `Você é proprietário de ${owned.length} empresas`}>
            <p>
              Enquanto for proprietário de {owned.map((item) => item.name).join(', ')}, a conta não pode ser excluída: a empresa ficaria sem
              ninguém para cuidar dela e da assinatura. Antes, transfira a propriedade para outra pessoa da equipe (em Equipe, no menu da
              pessoa) ou peça ao suporte para excluir a empresa.
            </p>
            <div className="row row--wrap" style={{ marginTop: 10 }}>
              <Link to="/app/equipe" className="btn btn--secondary btn--sm">Abrir Equipe</Link>
              <Link to="/app/suporte" className="btn btn--ghost btn--sm">Falar com o suporte</Link>
            </div>
          </Notice>
        ) : (
          <div className="row">
            <button type="button" className="btn btn--danger" onClick={() => setOpen(true)}>
              Excluir minha conta
            </button>
          </div>
        )}
      </div>

      <ConfirmDialog
        open={open}
        onClose={() => setOpen(false)}
        title="Excluir sua conta?"
        description="Você perde o acesso agora, em todos os aparelhos. Para desistir, será preciso falar com o suporte dentro do prazo de recuperação."
        confirmLabel="Excluir conta"
        danger
        onConfirm={remove}
      >
        <Field label="Sua senha" hint="Pedimos a senha para ter certeza de que é você.">
          <input className="input" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" maxLength={200} />
        </Field>
      </ConfirmDialog>
    </Card>
  );
}
