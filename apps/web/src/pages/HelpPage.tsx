import { useEffect } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { useAuth } from '../auth/AuthProvider';
import { HelpCenter } from '../components/HelpCenter';
import { Logo } from '../components/Icon';
import { PageHeader } from '../components/ui';

/** De qual resposta a pessoa veio ao abrir a solicitação: vai no diagnóstico. */
const fromArticle = (pathname: string) => (articleId: string | null) => ({ from: articleId ? `${pathname}?artigo=${articleId}` : pathname });

/** Central de ajuda dentro da aplicação (com a navegação ao lado). */
export function HelpPage() {
  const { pathname } = useLocation();
  return (
    <div className="page page--narrow">
      <PageHeader
        title="Central de ajuda"
        subtitle="Como o Estoque Simples funciona, em poucas palavras. Busque a sua dúvida ou escolha um assunto."
        actions={<Link to="/app/suporte" className="btn btn--secondary">Minhas solicitações</Link>}
      />
      <HelpCenter supportTo="/app/suporte/novo" supportLabel="Falar com o suporte" supportState={fromArticle(pathname)} />
    </div>
  );
}

/**
 * A mesma central, pública (estoquesimples.com.br/ajuda): serve a quem ainda
 * não tem conta ou não consegue entrar — justamente quem não alcançaria a
 * ajuda de dentro da aplicação.
 */
export function PublicHelpPage() {
  const { status } = useAuth();
  const authed = status === 'authed';

  useEffect(() => {
    document.title = 'Central de ajuda · Estoque Simples';
    return () => {
      document.title = 'Estoque Simples';
    };
  }, []);

  return (
    <div style={{ background: 'var(--surface)', minHeight: '100dvh' }}>
      <header className="landing__nav">
        <Link to="/" className="row strong" style={{ gap: 10, color: 'var(--text)' }}>
          <Logo size={28} /> Estoque Simples
        </Link>
        <span className="spacer" />
        <Link to={authed ? '/app' : '/entrar'} className="btn btn--secondary btn--sm">
          {authed ? 'Abrir meu estoque' : 'Entrar'}
        </Link>
      </header>
      <main className="page page--narrow" style={{ margin: '0 auto' }}>
        <PageHeader title="Central de ajuda" subtitle="Como o Estoque Simples funciona, em poucas palavras. Busque a sua dúvida ou escolha um assunto." />
        <HelpCenter
          supportTo={authed ? '/app/suporte/novo' : '/entrar'}
          supportLabel={authed ? 'Falar com o suporte' : 'Entrar para falar com o suporte'}
          supportState={authed ? fromArticle('/ajuda') : () => ({ from: '/app/suporte/novo' })}
        />
      </main>
    </div>
  );
}
