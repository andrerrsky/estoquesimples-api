import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router-dom';

import { useAuth } from './auth/AuthProvider';
import { Shell } from './components/Shell';
import { AdminsPage } from './pages/AdminsPage';
import { AnalyticsPage } from './pages/AnalyticsPage';
import { AuditPage } from './pages/AuditPage';
import { ErrorsPage } from './pages/ErrorsPage';
import { EventsPage } from './pages/EventsPage';
import { BlogEditorPage } from './pages/BlogEditorPage';
import { BlogPage } from './pages/BlogPage';
import { CouponDetailPage, CouponsPage } from './pages/CouponsPage';
import { HelpPage } from './pages/HelpPage';
import { LifecyclePage } from './pages/LifecyclePage';
import { SecurityPage } from './pages/SecurityPage';
import { LoginPage } from './pages/LoginPage';
import { OpsPage } from './pages/OpsPage';
import { JobRunPage } from './pages/JobRunPage';
import { OverviewPage } from './pages/OverviewPage';
import { PlansPage } from './pages/PlansPage';
import { CampaignDetailPage, NotificationsPage } from './pages/NotificationsPage';
import { ReviewsPage } from './pages/ReviewsPage';
import { AiPage } from './pages/AiPage';
import { SubscriptionDetailPage } from './pages/SubscriptionDetailPage';
import { SupportPage, TicketDetailPage } from './pages/SupportPage';
import { SubscriptionsPage } from './pages/SubscriptionsPage';
import { UserDetailPage } from './pages/UserDetailPage';
import { UsersPage } from './pages/UsersPage';
import { WorkspaceDetailPage } from './pages/WorkspaceDetailPage';
import { WorkspacesPage } from './pages/WorkspacesPage';
import { CookieConsent } from './components/CookieConsent';

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
  // Segundo fator obrigatório e ainda não cadastrado: só a tela de segurança.
  if (admin.mfaRequired && !admin.mfaEnabled) return <SecurityPage forced />;
  return (
    <>
      <Shell>
        <Outlet />
      </Shell>
      <CookieConsent />
    </>
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
        { path: '/cupons', element: <CouponsPage /> },
        { path: '/cupons/:couponId', element: <CouponDetailPage /> },
        { path: '/planos', element: <PlansPage /> },
        { path: '/suporte', element: <SupportPage /> },
        { path: '/suporte/:ticketId', element: <TicketDetailPage /> },
        { path: '/avaliacoes', element: <ReviewsPage /> },
        { path: '/ia', element: <AiPage /> },
        { path: '/notificacoes', element: <NotificationsPage /> },
        { path: '/emails', element: <LifecyclePage /> },
        { path: '/notificacoes/:campaignId', element: <CampaignDetailPage /> },
        { path: '/analytics', element: <AnalyticsPage /> },
        { path: '/eventos', element: <EventsPage /> },
        { path: '/erros', element: <ErrorsPage /> },
        { path: '/auditoria', element: <AuditPage /> },
        { path: '/operacao', element: <OpsPage /> },
        { path: '/operacao/tarefas/:jobId', element: <JobRunPage /> },
        { path: '/administradores', element: <AdminsPage /> },
        { path: '/blog', element: <BlogPage /> },
        { path: '/blog/novo', element: <BlogEditorPage /> },
        { path: '/blog/:postId', element: <BlogEditorPage /> },
        { path: '/ajuda', element: <HelpPage /> },
        { path: '/seguranca', element: <SecurityPage /> },
        { path: '*', element: <NotFound /> },
      ],
    },
  ],
  { basename: '/admin' },
);
