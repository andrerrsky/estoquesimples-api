import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';

import { api } from '../api/client';
import { useAuth } from '../auth/AuthProvider';
import { ADMIN_ROLE } from '../lib/labels';
import { initials } from '../lib/format';
import { Icon, type IconName } from './Icon';

interface NavItem {
  to: string;
  label: string;
  icon: IconName;
  minRole?: 'owner' | 'support' | 'viewer';
  badge?: (counts: { alerts: number; support: number }) => number | undefined;
}

const NAV: Array<{ section: string; items: NavItem[] }> = [
  {
    section: 'Acompanhar',
    items: [
      { to: '/', label: 'Visão geral', icon: 'home' },
      { to: '/analytics', label: 'Uso do produto', icon: 'chart' },
      { to: '/eventos', label: 'Eventos', icon: 'activity' },
    ],
  },
  {
    section: 'Suporte',
    items: [
      { to: '/suporte', label: 'Atendimento', icon: 'message', badge: (counts) => counts.support || undefined },
      { to: '/usuarios', label: 'Usuários', icon: 'users' },
      { to: '/empresas', label: 'Empresas', icon: 'building' },
      { to: '/assinaturas', label: 'Assinaturas', icon: 'card' },
      { to: '/avaliacoes', label: 'Avaliações', icon: 'mail' },
      { to: '/notificacoes', label: 'Notificações', icon: 'zap' },
      { to: '/auditoria', label: 'Auditoria', icon: 'list' },
    ],
  },
  {
    section: 'Plataforma',
    items: [
      { to: '/operacao', label: 'Operação', icon: 'activity', badge: (counts) => counts.alerts || undefined },
      { to: '/planos', label: 'Planos', icon: 'tag' },
      { to: '/administradores', label: 'Administradores', icon: 'shield', minRole: 'owner' },
    ],
  },
];

export function Shell({ children }: { children: ReactNode }) {
  const { admin, logout, can } = useAuth();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const [search, setSearch] = useState('');

  useEffect(() => setOpen(false), [location.pathname]);

  // Contagem de alertas para o selo do menu; barata e reaproveitada pela
  // tela de operação.
  const status = useQuery({
    queryKey: ['ops', 'status'],
    queryFn: () => api.get<{ alerts: unknown[] }>('/ops/status'),
    refetchInterval: 120_000,
  });
  const alerts = status.data?.alerts.length ?? 0;
  const supportStats = useQuery({
    queryKey: ['support', 'stats'],
    queryFn: () => api.get<{ open: number }>('/support/stats'),
    refetchInterval: 60_000,
  });
  const counts = { alerts, support: supportStats.data?.open ?? 0 };

  const submitSearch = (event: FormEvent) => {
    event.preventDefault();
    const term = search.trim();
    if (!term) return;
    navigate(`/usuarios?q=${encodeURIComponent(term)}`);
  };

  if (!admin) return null;

  return (
    <div className="shell">
      {open && <div className="sidebar-scrim" onClick={() => setOpen(false)} />}
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="sidebar__brand">
          <div className="sidebar__brand-mark">
            <svg width="22" height="22" viewBox="0 0 64 64" aria-hidden="true">
              <g transform="translate(32 34)">
                <polygon points="0,-16 16,-8 0,0 -16,-8" fill="#fff" />
                <polygon points="0,0 16,-8 16,10 0,18" fill="#fff" fillOpacity="0.82" />
                <polygon points="0,0 -16,-8 -16,10 0,18" fill="#fff" fillOpacity="0.64" />
              </g>
            </svg>
          </div>
          <div>
            <div className="sidebar__brand-title">Estoque Simples</div>
            <div className="sidebar__brand-sub">Painel administrativo</div>
          </div>
        </div>

        {NAV.map((group) => {
          const items = group.items.filter((item) => !item.minRole || can(item.minRole));
          if (items.length === 0) return null;
          return (
            <div key={group.section}>
              <div className="sidebar__section">{group.section}</div>
              <nav className="sidebar__nav">
                {items.map((item) => {
                  const badge = item.badge?.(counts);
                  return (
                    <NavLink key={item.to} to={item.to} end={item.to === '/'} className={({ isActive }) => `navlink ${isActive ? 'active' : ''}`}>
                      <Icon name={item.icon} />
                      {item.label}
                      {badge !== undefined && <span className="navlink__badge">{badge}</span>}
                    </NavLink>
                  );
                })}
              </nav>
            </div>
          );
        })}

        <div className="sidebar__footer">
          <div className="sidebar__user">
            <div className="sidebar__avatar">{initials(admin.name)}</div>
            <div style={{ minWidth: 0 }}>
              <div className="sidebar__user-name">{admin.name}</div>
              <div className="sidebar__user-role">{ADMIN_ROLE[admin.role]?.label ?? admin.role}</div>
            </div>
            <button type="button" className="btn btn--ghost btn--icon" style={{ marginLeft: 'auto', color: '#fff', borderColor: 'rgba(255,255,255,.3)' }} onClick={() => void logout()} title="Sair">
              <Icon name="logout" size={16} />
            </button>
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <button type="button" className="btn btn--ghost btn--icon topbar__menu" onClick={() => setOpen(true)} aria-label="Abrir menu">
            <Icon name="menu" />
          </button>
          <form className="topbar__search" onSubmit={submitSearch} role="search">
            <Icon name="search" />
            <input
              type="search"
              placeholder="Buscar conta por e-mail, nome ou ID…"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              aria-label="Buscar conta"
            />
          </form>
          <div className="topbar__spacer" />
          {alerts > 0 && (
            <NavLink to="/operacao" className="badge badge--warning">
              {alerts} alerta{alerts > 1 ? 's' : ''}
            </NavLink>
          )}
        </header>
        {children}
      </div>
    </div>
  );
}
