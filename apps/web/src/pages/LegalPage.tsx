import privacidade from '@estoquesimples/legal/privacidade.html?raw';
import termos from '@estoquesimples/legal/termos.html?raw';
import { useEffect, useMemo } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { Logo } from '../components/Icon';

/**
 * Termos de Uso e Política de Privacidade.
 *
 * O texto é o mesmo arquivo que vai dentro do app Android
 * (`packages/legal`), embutido no build: não há uma segunda redação para
 * manter. Do documento completo só interessa o conteúdo do `<article>`; o
 * estilo vem da folha da aplicação (`.legal`).
 */
function articleOf(html: string): string {
  const match = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  return match?.[1] ?? '';
}

const DOCUMENTS = {
  '/termos': { title: 'Termos de Uso', html: articleOf(termos) },
  '/privacidade': { title: 'Política de Privacidade', html: articleOf(privacidade) },
} as const;

export function LegalPage() {
  const { pathname } = useLocation();
  const { status } = useAuth();
  const document_ = pathname.startsWith('/privacidade') ? DOCUMENTS['/privacidade'] : DOCUMENTS['/termos'];
  // Conteúdo do próprio repositório, fixado no build; nada vem do usuário.
  const content = useMemo(() => ({ __html: document_.html }), [document_]);

  useEffect(() => {
    document.title = `${document_.title} · Estoque Simples`;
    window.scrollTo({ top: 0 });
    return () => {
      document.title = 'Estoque Simples';
    };
  }, [document_]);

  return (
    <div style={{ background: 'var(--surface-content)', minHeight: '100dvh' }}>
      <header className="landing__nav" style={{ borderBottom: '1px solid var(--border)' }}>
        <Link to="/" className="row strong" style={{ gap: 10, color: 'var(--text)' }}>
          <Logo size={28} /> Estoque Simples
        </Link>
        <span className="spacer" />
        <Link to={pathname.startsWith('/privacidade') ? '/termos' : '/privacidade'} className="btn btn--ghost btn--sm">
          {pathname.startsWith('/privacidade') ? 'Termos de Uso' : 'Política de Privacidade'}
        </Link>
        <Link to={status === 'authed' ? '/app' : '/entrar'} className="btn btn--secondary btn--sm">
          {status === 'authed' ? 'Abrir meu estoque' : 'Entrar'}
        </Link>
      </header>
      <article className="legal" dangerouslySetInnerHTML={content} />
    </div>
  );
}
