import { useState, type FormEvent } from 'react';
import { Navigate, useLocation } from 'react-router-dom';

import { ApiError } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { errorMessage } from '../components/ui';

export function LoginPage() {
  const { admin, loading, login } = useAuth();
  const location = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!loading && admin) {
    const from = (location.state as { from?: string } | null)?.from ?? '/';
    return <Navigate to={from} replace />;
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'AUTH_ACCOUNT_LOCKED') {
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
            <input className="input" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          {error && <div className="notice notice--error">{error}</div>}
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Entrando…' : 'Entrar'}
          </button>
        </form>
      </main>
    </div>
  );
}
