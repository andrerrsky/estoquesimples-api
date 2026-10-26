import { useEffect, useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../components/ui';
import { Icon } from '../components/Icon';

/**
 * "Lembrar de mim" guarda só o e-mail neste navegador. A senha nunca vai
 * para o localStorage (texto aberto ao alcance de qualquer script ou
 * extensão): o gerenciador de senhas do navegador cuida disso.
 */
const REMEMBER_KEY = 'es_admin_remember';

function readRemembered(): { email: string } | null {
  try {
    const raw = window.localStorage.getItem(REMEMBER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { email?: unknown; password?: unknown };
    if (typeof parsed.email !== 'string') return null;
    // Versões antigas guardavam a senha também: regrava só o e-mail.
    if ('password' in parsed) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: parsed.email }));
    return { email: parsed.email };
  } catch {
    return null;
  }
}

function writeRemembered(value: { email: string } | null): void {
  try {
    if (value) window.localStorage.setItem(REMEMBER_KEY, JSON.stringify({ email: value.email }));
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // Armazenamento indisponível (modo privado, cota): o login segue sem lembrar.
  }
}

export function LoginPage() {
  const { admin, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Senha conferida; falta o código do autenticador. */
  const [needsCode, setNeedsCode] = useState(false);
  const [code, setCode] = useState('');

  useEffect(() => {
    const saved = readRemembered();
    if (saved) {
      setEmail(saved.email);
      setRemember(true);
    }
  }, []);

  const toggleRemember = (checked: boolean) => {
    setRemember(checked);
    if (!checked) writeRemembered(null);
  };

  if (!loading && admin) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password, needsCode ? code.trim() : undefined);
      if (remember) writeRemembered({ email: email.trim() });
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'ADMIN_MFA_REQUIRED') {
        setNeedsCode(true);
      } else if (caught instanceof ApiError && caught.code === 'AUTH_ACCOUNT_LOCKED') {
        const seconds = Number(caught.extra['retryAfterSeconds'] ?? 0);
        setError(`Muitas tentativas. Tente de novo em ${Math.ceil(seconds / 60) || 1} minuto(s).`);
      } else {
        setError(errorMessage(caught));
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <aside className="login__aside">
        <div className="row" style={{ gap: 12 }}>
          <svg width="40" height="40" viewBox="0 0 64 64" aria-hidden="true">
            <rect width="64" height="64" rx="14" fill="rgba(255,255,255,.14)" />
            <g transform="translate(32 34)">
              <polygon points="0,-16 16,-8 0,0 -16,-8" fill="#fff" />
              <polygon points="0,0 16,-8 16,10 0,18" fill="#fff" fillOpacity="0.82" />
              <polygon points="0,0 -16,-8 -16,10 0,18" fill="#fff" fillOpacity="0.64" />
            </g>
          </svg>
          <div>
            <div className="strong" style={{ fontSize: 16 }}>Estoque Simples</div>
            <div style={{ color: 'var(--on-brand-muted)', fontSize: 13 }}>Painel administrativo</div>
          </div>
        </div>
        <div>
          <h1>Acompanhe o produto e dê suporte a quem usa.</h1>
          <p>
            Contas, empresas, assinaturas, uso do aplicativo e operação da API num só lugar. Toda ação que altera
            dados de clientes fica registrada com quem fez, quando e por quê.
          </p>
        </div>
        <div style={{ color: 'var(--on-brand-muted)', fontSize: 12 }}>Acesso restrito a administradores autorizados.</div>
      </aside>
      <main className="login__main">
        <form className="login__card" onSubmit={submit}>
          <div>
            <h2>Entrar</h2>
            <p className="muted small" style={{ marginTop: 4 }}>
              Use as credenciais de administrador do painel, não as do aplicativo.
            </p>
          </div>
          <label className="field">
            <span className="field__label">E-mail</span>
            <input className="input" type="email" autoComplete="username" value={email} onChange={(event) => setEmail(event.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span className="field__label">Senha</span>
            <div className="password-input">
              <input className="input" type={showPassword ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              <button
                type="button"
                className="password-input__toggle"
                aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                aria-pressed={showPassword}
                onClick={(event) => {
                  // O campo está dentro de um <label>: o clique não pode focar outra coisa.
                  event.preventDefault();
                  setShowPassword((current) => !current);
                }}
              >
                <Icon name={showPassword ? 'eyeOff' : 'eye'} size={18} />
              </button>
            </div>
          </label>
          {needsCode && (
            <label className="field">
              <span className="field__label">Código do autenticador</span>
              <input
                className="input"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="6 dígitos ou código de recuperação"
                value={code}
                onChange={(event) => setCode(event.target.value)}
                maxLength={20}
                autoFocus
                required
              />
              <span className="field__hint">Abra o aplicativo autenticador (Google Authenticator, 1Password…) e digite o código do Estoque Simples Painel.</span>
            </label>
          )}
          <label className="checkbox">
            <input type="checkbox" checked={remember} onChange={(event) => toggleRemember(event.target.checked)} />
            Lembrar meu e-mail neste navegador
          </label>
          {error && <div className="notice notice--error">{error}</div>}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Entrando…' : needsCode ? 'Confirmar código' : 'Entrar'}
          </button>
        </form>
      </main>
    </div>
  );
}
