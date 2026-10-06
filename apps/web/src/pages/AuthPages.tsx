import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, errorMessage, sessionApi } from '../api/client';
import type { BrandLogo, BrandTheme, InvitePreview } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { FullScreenLoading } from '../components/AppShell';
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { Field, Notice, Spinner } from '../components/ui';
import { track } from '../lib/analytics';
import { clearPublicBrand, setBrand, useBrand } from '../lib/brand';
import { fmtDate } from '../lib/format';
import { ROLE_LABEL } from '../lib/labels';
import { useWorkspace } from '../workspace/WorkspaceProvider';

/** Moldura das telas de entrada: a marca à esquerda, o formulário à direita. */
function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  const brand = useBrand();
  return (
    <div className="auth">
      <aside className="auth__aside">
        <Link to="/" className="auth__brand">
          <BrandMark size={36} />
        </Link>
        <div>
          <p className="auth__headline">Seu estoque em dia, em qualquer aparelho.</p>
          <ul className="auth__points">
            <li><Icon name="check" /> Produtos, entradas e saídas com histórico de tudo</li>
            <li><Icon name="check" /> Os mesmos dados no Android, na web e no iPhone (como web app)</li>
            <li><Icon name="check" /> Grátis para você; plano Equipe para trabalhar em grupo</li>
          </ul>
        </div>
        <p className="auth__foot">
          {brand && <><span className="auth__brand--partner">Estoque Simples</span> · </>}
          <Link to="/termos">Termos de Uso</Link> · <Link to="/privacidade">Política de Privacidade</Link>
        </p>
      </aside>
      <main className="auth__main">
        <div className="auth__form">
          <Link to="/" className="auth__mobile-brand">
            <BrandMark size={30} />
          </Link>
          <div>
            <h1 className="auth__title">{title}</h1>
            {subtitle && <p className="muted" style={{ marginTop: 6 }}>{subtitle}</p>}
          </div>
          {children}
          {footer && <div className="muted" style={{ fontSize: 'var(--fs-supporting)', textAlign: 'center' }}>{footer}</div>}
        </div>
      </main>
    </div>
  );
}

function PasswordField({ value, onChange, label = 'Senha', autoComplete, error }: { value: string; onChange: (value: string) => void; label?: string; autoComplete: string; error?: string | undefined }) {
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

function useRedirectIfAuthed(): ReactNode | null {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoading />;
  if (status === 'authed') {
    const from = (location.state as { from?: string } | null)?.from;
    return <Navigate to={from && from.startsWith('/app') ? from : '/app'} replace />;
  }
  return null;
}

/** Entrada pela URL da empresa: depois de entrar, abre a empresa de onde a pessoa veio (se participa dela). */
export const BRAND_HINT_KEY = 'es_web_brand_hint';

export function LoginPage({ brandSlug }: { brandSlug?: string }) {
  const { login } = useAuth();
  const brand = useBrand();
  const redirect = useRedirectIfAuthed();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (redirect) return redirect;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      if (brandSlug) {
        try {
          sessionStorage.setItem(BRAND_HINT_KEY, brandSlug);
        } catch {
          // sem sessionStorage: abre a última empresa usada
        }
      }
    } catch (caught) {
      setError(caught instanceof ApiError && caught.code === 'AUTH_ACCOUNT_LOCKED' ? 'Muitas tentativas seguidas. Aguarde alguns minutos e tente de novo.' : errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Entrar" subtitle={brand?.displayName ? `Acesse o estoque de ${brand.displayName} com a sua conta.` : 'Use a mesma conta do aplicativo.'} footer={<>Ainda não tem conta? <Link to="/criar-conta">Criar conta grátis</Link></>}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{error}</Notice>}
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus required />
        </Field>
        <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <Link to="/esqueci-a-senha" style={{ textAlign: 'center', fontSize: 'var(--fs-supporting)' }}>Esqueci minha senha</Link>
      </form>
    </AuthLayout>
  );
}

interface PublicBrand {
  active: boolean;
  slug: string | null;
  displayName: string | null;
  version: number;
  theme: BrandTheme | null;
  logo: BrandLogo | null;
}

/**
 * `/<identificador>/entrar`: a MESMA tela de entrada, com o tema e o
 * logotipo da empresa por cima. A autenticação é a central do produto. Se o
 * identificador não existe, a empresa não tem direito ao recurso ou algo
 * falha, a pessoa vê a tela padrão (sem aviso: de fora, tudo isso é igual).
 */
export function BrandedLoginPage() {
  const { slug = '' } = useParams();
  const navigate = useNavigate();
  const { status } = useAuth();
  const query = useQuery({
    queryKey: ['public-brand', slug],
    // Sem sessão e sem renovar token: é uma rota pública. Qualquer falha = tela padrão.
    queryFn: async (): Promise<PublicBrand | null> => {
      try {
        const response = await fetch(`/v1/public/brand/${encodeURIComponent(slug)}`, { headers: { accept: 'application/json' } });
        return response.ok ? ((await response.json()) as PublicBrand) : null;
      } catch {
        return null;
      }
    },
    staleTime: 60_000,
    retry: false,
  });
  const data = query.data;
  const active = !!data?.active && !!data.slug;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!data) return;
    if (!active) {
      clearPublicBrand();
      return;
    }
    // Identificador antigo: segue para o atual.
    if (data.slug && data.slug !== slug) navigate(`/${data.slug}/entrar`, { replace: true });
    setBrand({ eligible: true, active: true, slug: data.slug, version: data.version, displayName: data.displayName, loginPath: `/${data.slug}/entrar`, theme: data.theme, logo: data.logo }, 'public');
    track('brand.login_viewed');
  }, [data, active, slug, navigate]);

  // Ao sair da tela sem ter entrado, a marca pública não vaza para as outras telas.
  useEffect(() => () => {
    if (statusRef.current !== 'authed') clearPublicBrand();
  }, []);

  if (query.isLoading) return <FullScreenLoading />;
  return <LoginPage brandSlug={active ? (data?.slug ?? slug) : undefined} />;
}

export function RegisterPage() {
  const { register } = useAuth();
  const redirect = useRedirectIfAuthed();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const started = useRef(false);

  useEffect(() => {
    if (!started.current) {
      started.current = true;
      track('signup.started');
    }
  }, []);

  if (redirect) return redirect;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register(name.trim(), email.trim(), password);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  };

  const passwordError = error instanceof ApiError ? error.fieldError('password') : undefined;

  return (
    <AuthLayout title="Criar conta" subtitle="Grátis, sem cartão. Seu estoque fica guardado na nuvem." footer={<>Já tem conta? <Link to="/entrar">Entrar</Link></>}>
      <form className="stack" onSubmit={submit}>
        {error && !passwordError && <Notice tone="error">{errorMessage(error)}</Notice>}
        <Field label="Seu nome">
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} autoFocus required />
        </Field>
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" required />
        </Field>
        <PasswordField value={password} onChange={setPassword} autoComplete="new-password" error={passwordError} />
        <PasswordRules password={password} email={email} />
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Criando…' : 'Criar conta'}
        </button>
        <p className="caption" style={{ textAlign: 'center' }}>
          Ao criar a conta, você declara ter lido e concordado com os <Link to="/termos">Termos de Uso</Link> e a <Link to="/privacidade">Política de Privacidade</Link>.
        </p>
      </form>
    </AuthLayout>
  );
}

export function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/auth/forgot-password', { email: email.trim() }, { auth: false });
      setSent(true);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout title="Redefinir senha" subtitle="Enviamos um link para o seu e-mail." footer={<Link to="/entrar">Voltar para a entrada</Link>}>
      {sent ? (
        <Notice tone="success" title="Confira seu e-mail">
          Se houver uma conta com <strong>{email}</strong>, o link para criar uma nova senha chega em instantes. Ele vale por 30 minutos.
        </Notice>
      ) : (
        <form className="stack" onSubmit={submit}>
          {error && <Notice tone="error">{error}</Notice>}
          <Field label="E-mail da conta">
            <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus required />
          </Field>
          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? 'Enviando…' : 'Enviar link'}
          </button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [token, setToken] = useState(params.get('token') ?? '');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/v1/auth/reset-password', { token: token.trim(), newPassword: password }, { auth: false });
      setDone(true);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <AuthLayout title="Senha redefinida">
        <Notice tone="success">Sua senha foi trocada e as sessões abertas foram encerradas.</Notice>
        <button type="button" className="btn btn--primary btn--lg btn--block" onClick={() => navigate('/entrar')}>Entrar com a nova senha</button>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Criar nova senha" footer={<Link to="/entrar">Voltar para a entrada</Link>}>
      <form className="stack" onSubmit={submit}>
        {error && <Notice tone="error">{errorMessage(error)}</Notice>}
        {!params.get('token') && (
          <Field label="Código recebido por e-mail">
            <input className="input mono" value={token} onChange={(event) => setToken(event.target.value)} required />
          </Field>
        )}
        <PasswordField label="Nova senha" value={password} onChange={setPassword} autoComplete="new-password" error={error instanceof ApiError ? error.fieldError('newPassword') ?? error.fieldError('password') : undefined} />
        <PasswordRules password={password} email="" />
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Salvando…' : 'Salvar nova senha'}
        </button>
      </form>
    </AuthLayout>
  );
}

/** Aberta pelo link do e-mail de confirmação. */
export function VerifyEmailPage() {
  const [params] = useSearchParams();
  const { status, reloadUser } = useAuth();
  const token = params.get('token');
  const [state, setState] = useState<'working' | 'done' | 'error'>('working');
  const [message, setMessage] = useState('');
  const sent = useRef(false);

  useEffect(() => {
    if (!token || sent.current || status === 'loading') return;
    sent.current = true;
    api
      .post('/v1/auth/verify-email', { token }, { auth: false })
      .then(async () => {
        if (status === 'authed') await reloadUser().catch(() => undefined);
        setState('done');
      })
      .catch((error: unknown) => {
        setMessage(errorMessage(error));
        setState('error');
      });
  }, [token, status, reloadUser]);

  return (
    <AuthLayout title="Confirmação de e-mail">
      {!token ? (
        <Notice tone="error">O link está incompleto. Abra de novo pelo e-mail que enviamos.</Notice>
      ) : state === 'working' ? (
        <Spinner label="Confirmando…" />
      ) : state === 'done' ? (
        <Notice tone="success" title="E-mail confirmado">Agora você pode convidar pessoas e recuperar a senha por este endereço.</Notice>
      ) : (
        <Notice tone="error" title="Não foi possível confirmar">{message} Peça um novo código em Minha conta.</Notice>
      )}
      <Link className="btn btn--primary btn--lg btn--block" to={status === 'authed' ? '/app' : '/entrar'}>
        {status === 'authed' ? 'Ir para o estoque' : 'Entrar'}
      </Link>
    </AuthLayout>
  );
}

/** Aceite de convite: quem tem conta entra nela; quem não tem cria a senha aqui. */
export function InvitePage() {
  const { token = '' } = useParams();
  const { status, user, login, reloadUser, logout } = useAuth();
  const workspace = useWorkspace();
  const navigate = useNavigate();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);

  const preview = useQuery({
    queryKey: ['invite', token],
    queryFn: () => api.get<InvitePreview>(`/v1/invites/${encodeURIComponent(token)}`, undefined, { auth: false }),
    retry: false,
  });

  if (status === 'loading' || preview.isLoading) return <FullScreenLoading />;

  if (preview.error || !preview.data) {
    return (
      <AuthLayout title="Convite indisponível">
        <Notice tone="error">{errorMessage(preview.error)}</Notice>
        <p className="muted">Peça a quem convidou para enviar um novo convite.</p>
        <Link className="btn btn--secondary btn--block" to="/entrar">Ir para a entrada</Link>
      </AuthLayout>
    );
  }

  const invite = preview.data;
  const sameAccount = user?.email.toLowerCase() === invite.email.toLowerCase();

  const finish = async (workspaceId: string) => {
    // O papel mudou: o token em uso descreve permissões antigas.
    await sessionApi.renew();
    await reloadUser().catch(() => undefined);
    await workspace.refresh();
    workspace.select(workspaceId);
    navigate('/app/estoque', { replace: true });
  };

  const accept = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (invite.hasAccount && status !== 'authed') {
        await login(invite.email, password);
      }
      const result = await sessionApi.acceptInvite(token, invite.hasAccount ? undefined : { name: name.trim(), password });
      await finish(result.workspaceId);
    } catch (caught) {
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthLayout
      title={`Convite para ${invite.workspaceName}`}
      subtitle={<>Você entra como <strong>{ROLE_LABEL[invite.roleKey] ?? invite.roleKey}</strong>. O convite é para <strong>{invite.email}</strong> e vale até {fmtDate(invite.expiresAt)}.</>}
    >
      {status === 'authed' && !sameAccount ? (
        <>
          <Notice tone="warning">Você está na conta <strong>{user?.email}</strong>, mas o convite é para outro e-mail.</Notice>
          <button type="button" className="btn btn--secondary btn--block" onClick={() => void logout()}>Sair e entrar com {invite.email}</button>
        </>
      ) : (
        <form className="stack" onSubmit={accept}>
          {error && <Notice tone="error">{errorMessage(error)}</Notice>}
          {status !== 'authed' && invite.hasAccount && (
            <>
              <p className="muted">Já existe uma conta com este e-mail. Digite a senha dela para aceitar.</p>
              <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
            </>
          )}
          {!invite.hasAccount && (
            <>
              <Field label="Seu nome">
                <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} autoFocus required />
              </Field>
              <PasswordField label="Crie uma senha" value={password} onChange={setPassword} autoComplete="new-password" error={error instanceof ApiError ? error.fieldError('password') : undefined} />
              <PasswordRules password={password} email={invite.email} />
            </>
          )}
          <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
            {busy ? 'Entrando…' : 'Aceitar convite'}
          </button>
          <p className="caption" style={{ textAlign: 'center' }}>
            Ao continuar, você concorda com os <Link to="/termos">Termos de Uso</Link> e a <Link to="/privacidade">Política de Privacidade</Link>.
          </p>
        </form>
      )}
    </AuthLayout>
  );
}
