import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAuthOptional } from '../auth/context';
import { openCookiePreferences } from '../lib/ga';
import { Logo } from './Icon';

/**
 * Cabeçalho e rodapé das páginas públicas que não são a página inicial
 * (blog, ajuda). A barra troca "Entrar" por "Abrir meu estoque" quando há
 * sessão, igual à página inicial.
 */
export function PublicShell({ children, className }: { children: ReactNode; className?: string }) {
  const auth = useAuthOptional();
  const authed = auth?.status === 'authed';
  const year = new Date().getFullYear();
  return (
    <div className={className} style={{ background: 'var(--surface-content)', minHeight: '100dvh', display: 'flex', flexDirection: 'column' }}>
      <header className="landing__nav">
        <Link to="/" className="row strong" style={{ gap: 10, color: 'var(--text)' }}>
          <Logo size={28} /> Estoque Simples
        </Link>
        <nav className="public-nav" aria-label="Site">
          <Link to="/blog">Blog</Link>
          <Link to="/plataformas">Onde usar</Link>
          <Link to="/ajuda">Ajuda</Link>
        </nav>
        <span className="spacer" />
        <Link to={authed ? '/app' : '/entrar'} className="btn btn--secondary btn--sm">
          {authed ? 'Abrir meu estoque' : 'Entrar'}
        </Link>
      </header>
      <div style={{ flex: 1 }}>{children}</div>
      <footer className="blog-footer">
        <div className="blog-footer__inner">
          <span>
            <Logo size={20} /> Estoque Simples © {year}
          </span>
          <nav aria-label="Rodapé">
            <Link to="/">Início</Link>
            <Link to="/plataformas">Onde usar</Link>
            <Link to="/ajuda">Central de ajuda</Link>
            <Link to="/termos">Termos de Uso</Link>
            <Link to="/privacidade">Política de Privacidade</Link>
            <button type="button" className="link-button" onClick={openCookiePreferences}>Preferências de cookies</button>
            <a href="/blog/feed.xml">RSS</a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
