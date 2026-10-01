import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthProvider';
import { Shell } from './components/Shell';
import { AdminsPage } from './pages/AdminsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditPage } from './pages/AuditPage';
import { EventsPage } from './pages/EventsPage';
import { LoginPage } from './pages/LoginPage';
import { OpsPage } from './pages/OpsPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlansPage } from './pages/PlansPage';
import { CampaignDetailPage, NotificationsPage } from './pages/NotificationsPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { SubscriptionDetailPage } from './pages/SubscriptionDetailPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { WorkspaceDetailPage } from './pages/WorkspaceDetailPage';
import { WorkspacesPage } from './pages/WorkspacesPage';

function RequireAuth() {
  const { admin, loading } = useAuth();
  const location = useLocation();
  if (loading) {
    return (
      <div style={{ display: 'grid', placeItems: 'center', height: '100vh' }} className="muted">
        Carregando…
      </div>
    );
  }
  if (!admin) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return (
    <Shell>
      <Outlet />
    </Shell>
  );
}

function NotFound() {
  return (
    <div className="page">
      <div className="empty">
        <div className="strong">Página não encontrada</div>
      </div>
    </div>
  );
}

export const router = createBrowserRouter(
  [
    { path: '/login', element: <LoginPage /> },
    {
      element: <RequireAuth />,
      children: [
        { path: '/', element: <OverviewPage /> },
        { path: '/usuarios', element: <UsersPage /> },
        { path: '/usuarios/:userId', element: <UserDetailPage /> },
        { path: '/empresas', element: <WorkspacesPage /> },
        { path: '/empresas/:workspaceId', element: <WorkspaceDetailPage /> },
        { path: '/assinaturas', element: <SubscriptionsPage /> },
        { path: '/assinaturas/:subscriptionId', element: <SubscriptionDetailPage /> },
        { path: '/planos', element: <PlansPage /> },
        { path: '/avaliacoes', element: <ReviewsPage /> },
        { path: '/notificacoes', element: <NotificationsPage /> },
        { path: '/notificacoes/:campaignId', element: <CampaignDetailPage /> },
        { path: '/analytics', element: <AnalyticsPage /> },
        { path: '/eventos', element: <EventsPage /> },
        { path: '/auditoria', element: <AuditPage /> },
        { path: '/operacao', element: <OpsPage /> },
        { path: '/administradores', element: <AdminsPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: '/admin' },
);
