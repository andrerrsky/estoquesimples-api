import { lazy, Suspense, type ComponentType } from 'react';
import { createBrowserRouter, Navigate } from 'react-router-dom';

import { AppShell, CloudGate, FullScreenLoading, PageLoading } from './components/AppShell';
import { ForgotPasswordPage, InvitePage, LoginPage, RegisterPage, ResetPasswordPage, VerifyEmailPage } from './pages/AuthPages';
import { LandingPage } from './pages/LandingPage';

/**
 * Rotas. As telas internas são carregadas sob demanda: quem só visita a
 * página inicial ou a de entrada não baixa o código do estoque.
 */
const page = <T extends Record<string, ComponentType>>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => loader().then((module) => ({ default: module[name] as ComponentType })));

const StockPage = page(() => import('./pages/StockPage'), 'StockPage');
const HistoryPage = page(() => import('./pages/HistoryPage'), 'HistoryPage');
const ReportsPage = page(() => import('./pages/ReportsPage'), 'ReportsPage');
const AnalysisPage = page(() => import('./pages/AnalysisPage'), 'AnalysisPage');
const ImportExportPage = page(() => import('./pages/ImportExportPage'), 'ImportExportPage');
const ConflictsPage = page(() => import('./pages/ConflictsPage'), 'ConflictsPage');
const TeamPage = page(() => import('./pages/TeamPage'), 'TeamPage');
const PlanPage = page(() => import('./pages/PlanPage'), 'PlanPage');
const NotificationsPage = page(() => import('./pages/NotificationsPage'), 'NotificationsPage');
const SupportPage = page(() => import('./pages/SupportPage'), 'SupportPage');
const SupportNewPage = page(() => import('./pages/SupportPage'), 'SupportNewPage');
const SupportTicketPage = page(() => import('./pages/SupportPage'), 'SupportTicketPage');
const AccountPage = page(() => import('./pages/AccountPage'), 'AccountPage');
const CompaniesPage = page(() => import('./pages/CompaniesPage'), 'CompaniesPage');
const LegalPage = page(() => import('./pages/LegalPage'), 'LegalPage');

const lazyPage = (Component: ComponentType, gated = false) => (
  <Suspense fallback={<PageLoading />}>
    {gated ? (
      <CloudGate>
        <Component />
      </CloudGate>
    ) : (
      <Component />
    )}
  </Suspense>
);

function NotFound() {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24, textAlign: 'center' }}>
      <div className="stack">
        <h1 style={{ fontSize: 22 }}>Página não encontrada</h1>
        <p className="muted">O endereço pode ter mudado ou nunca ter existido.</p>
        <a className="btn btn--primary" href="/">Ir para o início</a>
      </div>
    </div>
  );
}

export const router = createBrowserRouter([
  { path: '/', element: <LandingPage /> },
  { path: '/entrar', element: <LoginPage /> },
  { path: '/criar-conta', element: <RegisterPage /> },
  { path: '/esqueci-a-senha', element: <ForgotPasswordPage /> },
  { path: '/redefinir-senha', element: <ResetPasswordPage /> },
  { path: '/confirmar-email', element: <VerifyEmailPage /> },
  { path: '/convite/:token', element: <InvitePage /> },
  { path: '/termos', element: <Suspense fallback={<FullScreenLoading />}><LegalPage /></Suspense> },
  { path: '/privacidade', element: <Suspense fallback={<FullScreenLoading />}><LegalPage /></Suspense> },
  {
    path: '/app',
    element: <AppShell />,
    children: [
      { index: true, element: <Navigate to="/app/estoque" replace /> },
      { path: 'estoque', element: lazyPage(StockPage, true) },
      { path: 'historico', element: lazyPage(HistoryPage, true) },
      { path: 'relatorios', element: lazyPage(ReportsPage, true) },
      { path: 'analise', element: lazyPage(AnalysisPage, true) },
      { path: 'importar', element: lazyPage(ImportExportPage, true) },
      { path: 'conflitos', element: lazyPage(ConflictsPage, true) },
      { path: 'equipe', element: lazyPage(TeamPage) },
      { path: 'plano', element: lazyPage(PlanPage) },
      { path: 'notificacoes', element: lazyPage(NotificationsPage) },
      { path: 'suporte', element: lazyPage(SupportPage) },
      { path: 'suporte/novo', element: lazyPage(SupportNewPage) },
      { path: 'suporte/:ticketId', element: lazyPage(SupportTicketPage) },
      { path: 'conta', element: lazyPage(AccountPage) },
      { path: 'empresas', element: lazyPage(CompaniesPage) },
      { path: '*', element: <NotFound /> },
    ],
  },
  { path: '*', element: <NotFound /> },
]);
