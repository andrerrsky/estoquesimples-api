import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, errorMessage, sessionApi } from '../api/client';
import type { BrandLogo, BrandTheme, InvitePreview } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { FullScreenLoading } from '../components/AppShell';
import { BrandMark } from '../components/BrandMark';
import { Icon } from '../components/Icon';
import { Field, Notice, Spinner } from '../components/ui';
import { track } from '../lib/analytics';
import { originContent, setChosenSegment } from '../lib/attribution';
import { isInAppBrowser, markOneTapShown, oneTapAllowed, setupGoogle } from '../lib/google-signin';
import { applyRememberedLogin, readRememberedLogin } from '../lib/remembered-login';
import { clearPublicBrand, setBrand, useBrand } from '../lib/brand';
import { fmtDate } from '../lib/format';
import { ROLE_LABEL } from '../lib/labels';
import { useWorkspace } from '../workspace/WorkspaceProvider';

/** Subtítulo da página de entrada de uma empresa quando ela não escreveu o seu (mesmo texto da tela /app/marca). */
const DEFAULT_BRAND_LOGIN_SUBTITLE = 'Painel de controle de estoque';

/** Texto do lado colorido na página de entrada de uma empresa (`/<slug>/entrar`). */
interface BrandAside {
  title: string;
  subtitle: string;
}

/** Moldura das telas de entrada: a marca à esquerda, o formulário à direita. */
function AuthLayout({ title, subtitle, children, footer, aside }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode; aside?: BrandAside }) {
  const brand = useBrand();
  return (
    <div className="auth">
      <aside className="auth__aside">
        <Link to="/" className="auth__brand">
          <BrandMark size={36} />
        </Link>
        {aside ? (
          <div>
            <p className="auth__headline">{aside.title}</p>
            <p className="auth__lead">{aside.subtitle}</p>
          </div>
        ) : (
          <div>
            <p className="auth__headline">Seu estoque em dia, em qualquer aparelho.</p>
            <ul className="auth__points">
              <li><Icon name="check" /> Produtos, entradas e saídas com histórico de tudo</li>
              <li><Icon name="check" /> Os mesmos dados no Android, na web e no iPhone (como web app)</li>
              <li><Icon name="check" /> Grátis para você; plano Equipe para trabalhar em grupo</li>
            </ul>
          </div>
        )}
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

/** Marcado ao enviar o cadastro: a primeira tela depois dele é a de boas-vindas. */
export const WELCOME_KEY = 'es_boas_vindas';

function welcomePending(): boolean {
  try {
    return sessionStorage.getItem(WELCOME_KEY) === '1';
  } catch {
    return false;
  }
}

function setWelcomePending(pending: boolean): void {
  try {
    if (pending) sessionStorage.setItem(WELCOME_KEY, '1');
    else sessionStorage.removeItem(WELCOME_KEY);
  } catch {
    // sem armazenamento: vai direto para o estoque, que também funciona
  }
}

function useRedirectIfAuthed(): ReactNode | null {
  const { status } = useAuth();
  const location = useLocation();
  if (status === 'loading') return <FullScreenLoading />;
  if (status === 'authed') {
    if (welcomePending()) return <Navigate to="/boas-vindas" replace />;
    // Vem do estado da navegação ou, para links comuns (a página inicial
    // não usa o roteador), da URL: /criar-conta?depois=/app/plano.
    const from = (location.state as { from?: string } | null)?.from ?? new URLSearchParams(location.search).get('depois');
    return <Navigate to={from && from.startsWith('/app') ? from : '/app'} replace />;
  }
  return null;
}

/** Entrada pela URL da empresa: depois de entrar, abre a empresa de onde a pessoa veio (se participa dela). */
export const BRAND_HINT_KEY = 'es_web_brand_hint';

/**
 * Tira o token do endereço assim que a página o lê: na URL ele ficaria no
 * histórico do navegador e iria para o Google Analytics (page_location).
 */
function useStripTokenFromUrl(): void {
  useEffect(() => {
    if (!new URLSearchParams(window.location.search).has('token')) return;
    const params = new URLSearchParams(window.location.search);
    params.delete('token');
    const rest = params.toString();
    window.history.replaceState(window.history.state, '', `${window.location.pathname}${rest ? `?${rest}` : ''}${window.location.hash}`);
  }, []);
}

/** Client ID do Google se o login com Google estiver ligado; `undefined` enquanto consulta. */
function useGoogleClientId(): string | null | undefined {
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    void sessionApi.config().then((config) => {
      if (alive) setClientId(config.googleClientId);
    });
    return () => {
      alive = false;
    };
  }, []);
  return clientId;
}

const GOOGLE_G = (
  <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true" focusable="false">
    <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
    <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
    <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
    <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
  </svg>
);

/**
 * "Continuar com o Google" + divisor. Serve para entrar e para criar conta (a
 * API decide: conta ligada, mesmo e-mail ou conta nova). Não aparece nada
 * (nem o divisor) quando o login com Google está desligado na API, no
 * navegador embutido de apps (o Google bloqueia login ali) ou se o botão não
 * carregar; `onAvailable` avisa a tela, que então mostra o formulário de
 * e-mail aberto. `oneTap`: oferece, depois de alguns segundos, a conta Google
 * já conectada no navegador (no máximo a cada 7 dias).
 */
export function GoogleSignIn({
  oneTap = false,
  signup = false,
  divider = 'ou com e-mail',
  onAvailable,
}: {
  oneTap?: boolean;
  /** Cadastro: mostra o aviso de Termos e Privacidade junto do botão. */
  signup?: boolean;
  divider?: string;
  onAvailable?: (available: boolean) => void;
}) {
  const { loginWithGoogle, status } = useAuth();
  const clientId = useGoogleClientId();
  const slot = useRef<HTMLDivElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'off'>('loading');
  const inApp = useMemo(() => isInAppBrowser(), []);

  useEffect(() => {
    if (clientId === null || inApp) {
      setState('off');
      if (inApp && clientId) track('signup.google_unavailable', { reason: 'in_app', page: window.location.pathname });
    }
  }, [clientId, inApp]);

  useEffect(() => {
    if (state !== 'loading') onAvailable?.(state === 'ready');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (!clientId || inApp || !slot.current) return undefined;
    let cancelled = false;
    let oneTapTimer: number | undefined;
    const onCredential = async (credential: string, fromOneTap: boolean) => {
      if (fromOneTap) track('signup.google_onetap', { page: window.location.pathname });
      setBusy(true);
      setError(null);
      try {
        await loginWithGoogle(credential, () => setWelcomePending(true));
      } catch (caught) {
        setError(caught);
        setBusy(false);
      }
    };
    setupGoogle(clientId, (credential, fromOneTap) => void onCredential(credential, fromOneTap))
      .then((id) => {
        if (cancelled || !slot.current) return;
        // Desenhar de novo no mesmo lugar acumula botões: limpa antes.
        slot.current.replaceChildren();
        const width = Math.round(Math.min(400, Math.max(240, slot.current.offsetWidth)));
        id.renderButton(slot.current, {
          type: 'standard',
          // No cadastro o Google é o caminho principal (azul cheio); na entrada, contorno.
          theme: signup ? 'filled_blue' : 'outline',
          size: 'large',
          shape: 'rectangular',
          text: 'continue_with',
          logo_alignment: 'center',
          width,
          locale: 'pt-BR',
          click_listener: () => track('signup.google_clicked', { page: window.location.pathname }),
        });
        setState('ready');
        if (oneTap && status === 'guest' && oneTapAllowed()) {
          // Não no instante em que a página abre: a pessoa primeiro vê onde está.
          oneTapTimer = window.setTimeout(() => {
            if (cancelled) return;
            markOneTapShown();
            id.prompt();
          }, 3000);
        }
      })
      .catch(() => {
        if (cancelled) return;
        track('signup.google_unavailable', { reason: 'load_failed', page: window.location.pathname });
        setState('off');
      });
    return () => {
      cancelled = true;
      if (oneTapTimer) window.clearTimeout(oneTapTimer);
      window.google?.accounts.id.cancel();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId, inApp]);

  if (state === 'off') return null;
  const errorText =
    error === null
      ? null
      : error instanceof ApiError && error.code === 'AUTH_ACCOUNT_SUSPENDED'
        ? 'Esta conta está suspensa. Fale com o suporte.'
        : errorMessage(error);
  return (
    <div className="google-signin">
      {errorText && (
        <div ref={errorRef} tabIndex={-1} role="alert">
          <Notice tone="error">{errorText}</Notice>
        </div>
      )}
      <div className="google-signin__slot" aria-busy={busy || undefined}>
        <div ref={slot} className="google-signin__button" />
        {busy && (
          <div role="status" aria-live="polite">
            <Spinner label="Entrando com o Google…" />
          </div>
        )}
      </div>
      {state === 'ready' && (
        <>
          <p className="google-signin__note">
            Do Google usamos só o seu nome e e-mail; nada é publicado na sua conta.
            {signup && (
              <>
                {' '}
                Ao continuar, você concorda com os <Link to="/termos">Termos de Uso</Link> e a <Link to="/privacidade">Política de Privacidade</Link>.
              </>
            )}
          </p>
          <div className="divider-or" role="separator">
            <span>{divider}</span>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Cadastro com o Google como caminho principal: quando o botão do Google
 * está disponível, o formulário de e-mail fica recolhido atrás de "Criar
 * conta com e-mail" (três campos e regras de senha a menos na primeira
 * impressão). Sem o Google (desligado, navegador de app, falha), o
 * formulário já aparece aberto.
 */
export function SignupChoices({ autoFocus = true, submitLabel }: { autoFocus?: boolean; submitLabel?: string }) {
  const [google, setGoogle] = useState<boolean | null>(null);
  const [showEmail, setShowEmail] = useState(false);
  // Google lento para responder: não deixa a tela sem nada; abre o formulário.
  useEffect(() => {
    const timer = window.setTimeout(() => setShowEmail((current) => current || google === null), 2500);
    return () => window.clearTimeout(timer);
  }, [google]);
  const open = google === false || showEmail;
  return (
    <>
      <GoogleSignIn oneTap signup divider={open ? 'ou com e-mail' : 'ou'} onAvailable={setGoogle} />
      {open ? (
        <RegisterForm autoFocus={autoFocus && google === false ? true : showEmail} {...(submitLabel ? { submitLabel } : {})} />
      ) : (
        google === true && (
          <button
            type="button"
            className="btn btn--secondary btn--lg btn--block"
            onClick={() => {
              setShowEmail(true);
              track('signup.email_expanded', { page: window.location.pathname });
            }}
          >
            <Icon name="mail" size={18} /> Criar conta com e-mail
          </button>
        )
      )}
    </>
  );
}

export function LoginPage({ brandSlug, aside, companyName }: { brandSlug?: string; aside?: BrandAside; companyName?: string | null }) {
  const googleOn = Boolean(useGoogleClientId());
  const { login } = useAuth();
  const brand = useBrand();
  const redirect = useRedirectIfAuthed();
  const location = useLocation();
  const [saved] = useState(readRememberedLogin);
  // Vindo do cadastro com um e-mail que já tem conta, o campo chega preenchido.
  const [email, setEmail] = useState((location.state as { email?: string } | null)?.email ?? saved?.email ?? '');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(saved !== null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (redirect) return redirect;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      // Só depois de entrar: um login recusado não guarda nem apaga nada.
      applyRememberedLogin(remember, { email: email.trim() });
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
    <AuthLayout aside={aside} title="Entrar" subtitle={(brand?.displayName ?? companyName) ? `Acesse o estoque de ${brand?.displayName ?? companyName} com a sua conta.` : 'Entre com o Google ou com o e-mail e a senha.'} footer={<>Ainda não tem conta? <Link to="/criar-conta">Criar conta grátis</Link></>}>
      {!brandSlug && <GoogleSignIn />}
      <form className="stack" onSubmit={submit}>
        {error && (
          <Notice tone="error">
            {error}
            {googleOn && ' Se você criou a conta com o Google, toque em “Continuar com o Google” acima.'}
          </Notice>
        )}
        <Field label="E-mail">
          <input className="input" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" autoFocus={saved === null} required />
        </Field>
        <PasswordField value={password} onChange={setPassword} autoComplete="current-password" />
        <label className="checkbox">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          Lembrar meu e-mail
        </label>
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
  loginTitle?: string | null;
  loginSubtitle?: string | null;
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
  // `active`: aplica cores e logotipo. Sem eles, a página da empresa existe do mesmo
  // jeito (plano em dia, identificador salvo): visual padrão com o nome dela.
  const active = !!data?.active && !!data.slug;
  const page = !!data?.slug && !!data.displayName;
  const statusRef = useRef(status);
  statusRef.current = status;

  useEffect(() => {
    if (!data) return;
    // Identificador antigo: segue para o atual.
    if (page && data.slug && data.slug !== slug) navigate(`/${data.slug}/entrar`, { replace: true });
    if (!active) {
      clearPublicBrand();
      return;
    }
    setBrand({ eligible: true, active: true, slug: data.slug, version: data.version, displayName: data.displayName, loginPath: `/${data.slug}/entrar`, theme: data.theme, logo: data.logo }, 'public');
    track('brand.login_viewed');
  }, [data, active, page, slug, navigate]);

  // Ao sair da tela sem ter entrado, a marca pública não vaza para as outras telas.
  useEffect(() => () => {
    if (statusRef.current !== 'authed') clearPublicBrand();
  }, []);

  if (query.isLoading) return <FullScreenLoading />;
  // Texto do lado colorido: o que a empresa escreveu em /app/marca ou, por padrão, o nome dela.
  const aside = page && data ? { title: data.loginTitle || data.displayName || 'Estoque Simples', subtitle: data.loginSubtitle || DEFAULT_BRAND_LOGIN_SUBTITLE } : undefined;
  return <LoginPage brandSlug={page ? (data?.slug ?? slug) : undefined} aside={aside} companyName={page ? data?.displayName : null} />;
}

/**
 * Formulário de cadastro, o mesmo em /criar-conta e na página dos anúncios
 * (/comece). `signup.started` sai na **primeira digitação** em qualquer campo
 * (nos dois lugares), para a métrica valer igual: abrir a página não conta.
 */
export function RegisterForm({ autoFocus = true, submitLabel = 'Criar conta' }: { autoFocus?: boolean; submitLabel?: string }) {
  const { register } = useAuth();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | Error | null>(null);
  const started = useRef(false);

  const markStarted = () => {
    if (started.current) return;
    started.current = true;
    track('signup.started', { page: window.location.pathname });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    markStarted();
    setBusy(true);
    setError(null);
    setWelcomePending(true);
    try {
      await register(name.trim(), email.trim(), password);
    } catch (caught) {
      setWelcomePending(false);
      setError(caught as Error);
    } finally {
      setBusy(false);
    }
  };

  const passwordError = error instanceof ApiError ? error.fieldError('password') : undefined;

  return (
    <form className="stack" onSubmit={submit} onInputCapture={markStarted}>
      {error && !passwordError && (
        <Notice tone="error">
          {error instanceof ApiError && error.code === 'AUTH_EMAIL_IN_USE' ? (
            <>
              Já existe uma conta com este e-mail.{' '}
              <Link to="/entrar" state={{ email: email.trim() }} className="notice__link">
                Entrar com ele
              </Link>
            </>
          ) : (
            errorMessage(error)
          )}
        </Notice>
      )}
      <Field label="Seu nome">
        <input className="input" value={name} onChange={(event) => setName(event.target.value)} autoComplete="name" maxLength={120} autoFocus={autoFocus} required />
      </Field>
      <Field label="E-mail">
        <input className="input" type="email" inputMode="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" required />
      </Field>
      <PasswordField value={password} onChange={setPassword} autoComplete="new-password" error={passwordError} />
      <PasswordRules password={password} email={email} />
      <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
        {busy ? 'Criando…' : submitLabel}
      </button>
      <p className="caption" style={{ textAlign: 'center' }}>
        Ao criar a conta, você declara ter lido e concordado com os <Link to="/termos">Termos de Uso</Link> e a <Link to="/privacidade">Política de Privacidade</Link>.
      </p>
    </form>
  );
}

export function RegisterPage() {
  const redirect = useRedirectIfAuthed();
  if (redirect) return redirect;
  return (
    <AuthLayout title="Criar conta" subtitle="Grátis, sem cartão. Seu estoque fica guardado na nuvem." footer={<>Já tem conta? <Link to="/entrar">Entrar</Link></>}>
      <SignupChoices />
    </AuthLayout>
  );
}

/** Página dos anúncios: o mesmo redirecionamento de quem já entrou (vai para as boas-vindas ou o estoque). */
export { useRedirectIfAuthed };

const SEGMENT_OPTIONS: Array<{ key: string; label: string; example: string }> = [
  { key: 'salao', label: 'Salão de beleza', example: 'Salão da Ana' },
  { key: 'roupas', label: 'Loja de roupas', example: 'Moda da Carla' },
  { key: 'mercearia', label: 'Mercearia', example: 'Mercearia São José' },
  { key: 'cosmeticos', label: 'Cosméticos', example: 'Beleza & Cia' },
  { key: 'outro', label: 'Outro', example: 'Loja do Bairro' },
];

/**
 * Primeira tela depois do cadastro web: só o nome da empresa, sem menu nem
 * avisos. A empresa já existe ("Minha empresa", criada pela API no
 * cadastro), então "Pular" não trava ninguém; aqui ela só ganha o nome. Se a
 * visita não veio de um anúncio por segmento, a pessoa pode tocar no tipo de
 * negócio (opcional), que personaliza a dica do estoque vazio.
 *
 * Reversão combinada (docs/aquisicao-e-conversao.md): se `onboarding.viewed`
 * sem nenhum passo seguinte em 24 h passar de 10% com ≥ 30 cadastros, esta
 * tela sai e o nome passa a ser editado só no estoque.
 */
export function WelcomePage() {
  const { status, user, reloadUser } = useAuth();
  const fromGoogle = user?.signupMethod === 'google';
  const noPassword = user?.hasPassword === false;
  // Do Google vêm nome e e-mail: o nome fica em modo leitura, com "alterar".
  const [personName, setPersonName] = useState(user?.name ?? '');
  const [editingName, setEditingName] = useState(false);
  useEffect(() => {
    if (user && personName === '') setPersonName(user.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);
  // O app Android ainda entra só com e-mail e senha: quem veio pelo Google pode criar uma aqui.
  const [wantsPassword, setWantsPassword] = useState(false);
  const [appPassword, setAppPassword] = useState('');
  const { workspaces, loading, refresh, select } = useWorkspace();
  const navigate = useNavigate();
  const fromAd = originContent();
  const adSegment = fromAd && SEGMENT_OPTIONS.some((option) => option.key === fromAd) ? fromAd : null;
  const [segment, setSegment] = useState<string | null>(adSegment);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const viewed = useRef(false);

  const owned = workspaces.find((item) => item.isOwner) ?? workspaces[0] ?? null;

  useEffect(() => {
    setWelcomePending(false);
    if (status === 'authed' && !viewed.current) {
      viewed.current = true;
      track('onboarding.viewed', { segment: adSegment, method: fromGoogle ? 'google' : 'email' });
    }
  }, [status, adSegment, fromGoogle]);

  useEffect(() => {
    if (error !== null) errorRef.current?.focus();
  }, [error]);

  if (status === 'loading' || (status === 'authed' && loading)) return <FullScreenLoading />;
  if (status !== 'authed') return <Navigate to="/entrar" replace />;

  const example = SEGMENT_OPTIONS.find((option) => option.key === segment)?.example ?? 'Loja da Ana';
  const passwordError = error instanceof ApiError ? error.details.filter((detail) => detail.field === 'newPassword').map((detail) => detail.message).join(' ') || undefined : undefined;

  /** Salva o que foi preenchido (nome da pessoa, senha do app, nome da empresa) e abre o estoque. */
  const save = async (withCompany: boolean) => {
    if (busy) return;
    const chosen = withCompany ? name.trim() : '';
    setChosenSegment(adSegment ? null : segment);
    setBusy(true);
    setError(null);
    try {
      if (fromGoogle && personName.trim() && personName.trim() !== user?.name) {
        await api.patch('/v1/me', { name: personName.trim() });
      }
      if (noPassword && wantsPassword && appPassword) {
        await api.post('/v1/auth/change-password', { newPassword: appPassword, revokeOtherSessions: false });
      }
      if (chosen && owned && chosen !== owned.name) await api.patch(`/v1/workspaces/${owned.id}`, { name: chosen });
      await Promise.all([refresh(), reloadUser().catch(() => undefined)]);
      track(chosen ? 'onboarding.name_set' : 'onboarding.name_skipped', { segment, method: fromGoogle ? 'google' : 'email' });
      if (owned) select(owned.id);
      navigate('/app/estoque?primeiro=1', { replace: true });
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void save(true);
  };

  const first = user?.name.trim().split(/\s+/)[0];
  return (
    <AuthLayout
      title={first ? `Boas-vindas, ${first}!` : 'Boas-vindas!'}
      subtitle={fromGoogle ? 'Sua conta foi criada com o Google. Falta só o nome da empresa.' : 'Sua conta está pronta. Só uma pergunta antes de começar.'}
    >
      <form className="stack" onSubmit={submit}>
        {error !== null && !passwordError && (
          <div ref={errorRef} tabIndex={-1} role="alert">
            <Notice tone="error">{errorMessage(error)}</Notice>
          </div>
        )}
        {fromGoogle && user && (
          <div className="welcome-account">
            <span className="welcome-account__icon">{GOOGLE_G}</span>
            <span className="welcome-account__who">
              <strong>Conta Google conectada</strong>
              {editingName ? null : (
                <span className="welcome-account__email">
                  {personName || user.name} · {user.email}
                </span>
              )}
            </span>
            {!editingName && (
              <button type="button" className="btn btn--link btn--sm" onClick={() => setEditingName(true)} aria-label="Alterar o seu nome">
                alterar
              </button>
            )}
          </div>
        )}
        {fromGoogle && editingName && (
          <Field label="Seu nome">
            <input className="input" value={personName} onChange={(event) => setPersonName(event.target.value)} maxLength={120} autoComplete="name" autoFocus />
          </Field>
        )}
        <Field label="Nome da empresa (opcional)" hint={`Pode ser o nome da loja, do salão ou o seu. Ex.: ${example}. Dá para mudar depois.`}>
          <input className="input" value={name} onChange={(event) => setName(event.target.value)} maxLength={120} autoFocus={!editingName} enterKeyHint="go" />
        </Field>
        {!adSegment && (
          <div className="stack" style={{ gap: 8 }}>
            <span className="caption">Seu negócio é… (opcional)</span>
            <div className="segment-picker" role="group" aria-label="Tipo de negócio (opcional)">
              {SEGMENT_OPTIONS.map((option) => (
                <button
                  key={option.key}
                  type="button"
                  className={`segment-picker__chip${segment === option.key ? ' segment-picker__chip--active' : ''}`}
                  aria-pressed={segment === option.key}
                  onClick={() => setSegment(segment === option.key ? null : option.key)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {fromGoogle && noPassword && (
          <div className="welcome-app">
            <label className="checkbox">
              <input type="checkbox" checked={wantsPassword} onChange={(event) => setWantsPassword(event.target.checked)} />
              Vou usar o aplicativo Android: criar uma senha agora
            </label>
            {wantsPassword && (
              <>
                <p className="caption">O aplicativo entra com e-mail e senha. Na web, você continua entrando com o Google.</p>
                <PasswordField label="Senha para o aplicativo" value={appPassword} onChange={setAppPassword} autoComplete="new-password" error={passwordError} />
                <PasswordRules password={appPassword} email={user?.email ?? ''} />
              </>
            )}
          </div>
        )}
        <button type="submit" className="btn btn--primary btn--lg btn--block" disabled={busy}>
          {busy ? 'Salvando…' : 'Começar'}
        </button>
        <button type="button" className="btn btn--link" onClick={() => void save(false)} disabled={busy}>
          Pular por agora
        </button>
        {fromGoogle && (
          <p className="caption" style={{ textAlign: 'center' }}>
            Ao continuar, você concorda com os <Link to="/termos">Termos de Uso</Link> e a <Link to="/privacidade">Política de Privacidade</Link>.
          </p>
        )}
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
  useStripTokenFromUrl();
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
  const [token] = useState(() => params.get('token'));
  useStripTokenFromUrl();
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

/** Destinos que o app pode pedir ao abrir a web (nada fora da área interna). */
function safeAppPath(value: string | null): string {
  if (!value || !value.startsWith('/app') || value.startsWith('//') || /[\\\s]/.test(value)) return '/app';
  return value;
}

/**
 * "Abrir na web" do app: o app manda um código de uso único no fragmento da
 * URL (#codigo=…&para=/app/plano&empresa=…). O fragmento é lido e apagado da
 * barra de endereço na hora — não fica no histórico nem vai para servidor
 * nenhum — e o código vira uma sessão web desta mesma pessoa.
 */
export function AppHandoffPage() {
  const { status, loginWithAppCode } = useAuth();
  const navigate = useNavigate();
  const [params] = useState(() => new URLSearchParams(window.location.hash.replace(/^#/, '')));
  const [error, setError] = useState<string | null>(null);
  const started = useRef(false);

  useEffect(() => {
    // Some da barra (e do histórico) antes de qualquer outra coisa.
    if (window.location.hash) window.history.replaceState(null, '', window.location.pathname);
  }, []);

  useEffect(() => {
    if (status === 'loading' || started.current) return;
    started.current = true;
    const code = params.get('codigo');
    if (!code) {
      setError('O link está incompleto. Abra a versão web de novo pelo app.');
      return;
    }
    const workspaceId = params.get('empresa');
    if (workspaceId && /^[0-9a-f-]{36}$/i.test(workspaceId)) {
      try {
        localStorage.setItem('es_web_workspace', workspaceId);
      } catch {
        // sem armazenamento: abre na primeira empresa da conta
      }
    }
    loginWithAppCode(code)
      .then(() => {
        navigate(safeAppPath(params.get('para')), { replace: true });
      })
      .catch((reason: unknown) => setError(errorMessage(reason)));
  }, [status, params, loginWithAppCode, navigate]);

  if (!error) return <FullScreenLoading />;
  return (
    <AuthLayout title="Não foi possível entrar" subtitle="O acesso que veio do app vale por 2 minutos e uma vez só.">
      <Notice tone="error">{error}</Notice>
      <Link className="btn btn--primary btn--lg btn--block" to={status === 'authed' ? '/app' : '/entrar'}>
        {status === 'authed' ? 'Ir para o estoque' : 'Entrar com e-mail e senha'}
      </Link>
    </AuthLayout>
  );
}
