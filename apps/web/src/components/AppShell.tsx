import { useQuery } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { trackScreen } from '../lib/analytics';
import { initials } from '../lib/format';
import { ROLE_LABEL } from '../lib/labels';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { Icon, Logo, type IconName } from './Icon';
import { Empty, Menu, Meter, Modal, Notice, Skeleton, Spinner } from './ui';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
}

const STOCK_NAV: NavItem[] = [
  { to: '/app/estoque', label: 'Estoque', icon: 'box' },
  { to: '/app/historico', label: 'Histórico', icon: 'history' },
  { to: '/app/relatorios', label: 'Relatórios', icon: 'chart' },
  { to: '/app/analise', label: 'Análise', icon: 'trend' },
  { to: '/app/importar', label: 'Importar e exportar', icon: 'transfer' },
];

const COMPANY_NAV: NavItem[] = [
  { to: '/app/equipe', label: 'Equipe', icon: 'users' },
  { to: '/app/plano', label: 'Plano', icon: 'card' },
];

const HELP_NAV: NavItem[] = [
  { to: '/app/ajuda', label: 'Central de ajuda', icon: 'book' },
  { to: '/app/plataformas', label: 'Plataformas', icon: 'phone' },
  { to: '/app/suporte', label: 'Falar com o suporte', icon: 'help' },
];

function useUnreadNotifications(): number {
  const query = useQuery({
    queryKey: ['notifications', 'unread'],
    queryFn: () => api.get<{ unread: number }>('/v1/notifications/unread-count'),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  return query.data?.unread ?? 0;
}

/** Estrutura das telas internas: barra lateral no desktop, barra inferior no celular. */
export function AppShell() {
  const { status, user, logout } = useAuth();
  const { workspaces, workspace, workspaceId, entitlement, loading, error, select, isPaid, refresh } = useWorkspace();
  const location = useLocation();
  const navigate = useNavigate();
  const unread = useUnreadNotifications();
  const [moreOpen, setMoreOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    trackScreen(location.pathname.split('/').slice(1, 3).join('/'));
    setMoreOpen(false);
    window.scrollTo({ top: 0 });
  }, [location.pathname]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 4);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  if (status === 'loading') return <FullScreenLoading />;
  if (status === 'guest') return <Navigate to="/entrar" replace state={{ from: `${location.pathname}${location.search}` }} />;

  // Sem empresa, só fazem sentido as telas que não dependem de uma.
  const worksWithoutCompany = ['/app/empresas', '/app/conta', '/app/ajuda', '/app/plataformas', '/app/suporte', '/app/notificacoes'].some((path) => location.pathname.startsWith(path));
  if (loading && !workspace) return <FullScreenLoading />;
  if (error && !workspace) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24 }}>
        <Empty icon="alert" title="Não foi possível carregar sua conta" actions={<button type="button" className="btn btn--secondary" onClick={() => void refresh()}>Tentar de novo</button>}>
          Confira a conexão com a internet.
        </Empty>
      </div>
    );
  }
  // Sem empresa ainda: o primeiro passo é criar (ou escolher) uma.
  if (!workspaceId && !worksWithoutCompany) return <Navigate to="/app/empresas" replace />;

  const limit = entitlement?.limits.products ?? null;
  const used = entitlement?.usage.products ?? 0;
  const userMenu = [
    { label: 'Minha conta', icon: 'user' as const, onClick: () => navigate('/app/conta') },
    { label: 'Empresas', icon: 'building' as const, onClick: () => navigate('/app/empresas') },
    'sep' as const,
    { label: 'Sair', icon: 'logout' as const, onClick: () => void logout().then(() => navigate('/entrar')) },
  ];

  const renderNav = (items: NavItem[]) =>
    items.map((item) => (
      <NavLink key={item.to} to={item.to} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
        <Icon name={item.icon} />
        {item.label}
        {item.to === '/app/analise' && !isPaid && <span className="navlink__tag">Equipe</span>}
      </NavLink>
    ));

  return (
    <div className="shell">
      <aside className="sidebar no-print">
        <Link to="/app/estoque" className="sidebar__brand">
          <Logo size={30} /> Estoque Simples
        </Link>

        {workspace && (
          <Menu
            label="Trocar de empresa"
            header={<div className="menu__label">Empresas</div>}
            items={[
              ...workspaces.filter((item) => item.status !== 'suspended').map((item) => ({
                label: item.name,
                icon: item.id === workspaceId ? ('check' as const) : ('building' as const),
                onClick: () => {
                  select(item.id);
                  navigate('/app/estoque');
                },
              })),
              'sep' as const,
              { label: 'Gerenciar empresas', icon: 'settings' as const, onClick: () => navigate('/app/empresas') },
            ]}
            trigger={(props) => (
              <button type="button" className="workspace-switch" {...props}>
                <Icon name="building" className="muted" />
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span className="workspace-switch__name truncate" style={{ display: 'block' }}>{workspace.name}</span>
                  <span className="workspace-switch__role">{ROLE_LABEL[workspace.role] ?? workspace.role}</span>
                </span>
                <Icon name="chevronDown" size={16} className="muted" />
              </button>
            )}
          />
        )}

        <nav className="nav" aria-label="Estoque">{renderNav(STOCK_NAV)}</nav>
        <div className="sidebar__section">Empresa</div>
        <nav className="nav" aria-label="Empresa">{renderNav(COMPANY_NAV)}</nav>
        <div className="sidebar__section">Ajuda</div>
        <nav className="nav" aria-label="Ajuda">{renderNav(HELP_NAV)}</nav>

        <div className="sidebar__footer">
          {entitlement && (
            <Link to="/app/plano" className="plan-meter">
              <div className="plan-meter__title">
                <span>{isPaid ? 'Plano Equipe' : 'Plano gratuito'}</span>
                {!isPaid && <span className="badge badge--brand">Ver planos</span>}
              </div>
              {limit !== null ? (
                <>
                  <Meter value={used} max={limit} />
                  <div className="plan-meter__hint">
                    {used} de {limit} produtos na nuvem
                  </div>
                </>
              ) : (
                <div className="plan-meter__hint">Produtos sem limite e equipe liberada</div>
              )}
            </Link>
          )}
        </div>
      </aside>

      <div className="main">
        <header className={`topbar no-print ${scrolled ? 'topbar--scrolled' : ''}`}>
          <Link to="/app/estoque" className="topbar__brand">
            <Logo size={28} />
            <span className="truncate">{workspace?.name ?? 'Estoque Simples'}</span>
          </Link>
          <span className="spacer" />
          <Link to="/app/notificacoes" className="icon-btn" aria-label={unread > 0 ? `Notificações: ${unread} não lidas` : 'Notificações'}>
            <Icon name="bell" size={20} />
            {unread > 0 && <span className="icon-btn__dot">{unread > 9 ? '9+' : unread}</span>}
          </Link>
          <Menu
            label="Conta"
            header={
              <div className="menu__label">
                <div className="strong" style={{ color: 'var(--text)' }}>{user?.name}</div>
                {user?.email}
              </div>
            }
            items={userMenu}
            trigger={(props) => (
              <button type="button" className="avatar avatar--btn" aria-label="Abrir menu da conta" {...props}>
                {initials(user?.name ?? '?')}
              </button>
            )}
          />
        </header>

        {user && !user.emailVerified && !location.pathname.startsWith('/app/conta') && (
          <div className="page" style={{ paddingBottom: 0, gap: 0 }}>
            <Notice tone="warning" action={<Link to="/app/conta" className="btn btn--secondary btn--sm">Confirmar</Link>}>
              Confirme seu e-mail para poder convidar pessoas e recuperar a senha.
            </Notice>
          </div>
        )}

        <Outlet />
      </div>

      <nav className="bottomnav no-print" aria-label="Navegação principal">
        {STOCK_NAV.slice(0, 3).map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => `bottomnav__item ${isActive ? 'active' : ''}`}>
            <Icon name={item.icon} size={21} />
            {item.label}
          </NavLink>
        ))}
        <button type="button" className={`bottomnav__item ${moreOpen ? 'active' : ''}`} onClick={() => setMoreOpen(true)}>
          <Icon name="menu" size={21} />
          Mais
        </button>
      </nav>

      <Modal open={moreOpen} onClose={() => setMoreOpen(false)} title={workspace?.name ?? 'Mais'} description={workspace ? ROLE_LABEL[workspace.role] : undefined}>
        <nav className="nav">
          {renderNav([...STOCK_NAV.slice(3), ...COMPANY_NAV, ...HELP_NAV, { to: '/app/conta', label: 'Minha conta', icon: 'user' }, { to: '/app/empresas', label: 'Empresas', icon: 'building' }])}
          <button type="button" className="navlink" style={{ border: 'none', background: 'none', textAlign: 'left' }} onClick={() => void logout().then(() => navigate('/entrar'))}>
            <Icon name="logout" /> Sair
          </button>
        </nav>
      </Modal>
    </div>
  );
}

export function FullScreenLoading() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh' }}>
      <Spinner label="Carregando…" />
    </div>
  );
}

/** Enquanto um pedaço da aplicação é baixado (páginas são carregadas sob demanda). */
export function PageLoading() {
  return (
    <div className="page">
      <Skeleton lines={6} height={18} />
    </div>
  );
}

/**
 * Páginas de estoque dependem do plano: no gratuito, só o proprietário usa a
 * nuvem. A API recusa de qualquer forma; aqui a pessoa recebe a explicação em
 * vez de uma tela de erro.
 */
export function CloudGate({ children }: { children: ReactNode }) {
  const { cloudAllowed, workspace, entitlement } = useWorkspace();
  if (!workspace || !entitlement || cloudAllowed) return <>{children}</>;
  return (
    <div className="page page--narrow">
      <Empty icon="lock" title="Esta empresa está no plano gratuito">
        No plano gratuito o estoque na nuvem é só do proprietário. Peça a quem criou <strong>{workspace.name}</strong> para assinar o
        plano Equipe: aí todas as pessoas convidadas voltam a ver e movimentar o estoque. Nada foi apagado.
      </Empty>
    </div>
  );
}
