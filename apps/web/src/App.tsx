import { lazy, Suspense, useEffect, useState, type ComponentType } from 'react';
import { createBrowserRouter, Navigate, Outlet, ScrollRestoration } from 'react-router-dom';

import { AppShell, CloudGate, FullScreenLoading, PageLoading } from './components/AppShell';
import { RouteError } from './components/RouteError';
import { SupportChat } from './components/SupportChat';
import { importPage } from './lib/chunks';
import { LandingPage } from './pages/LandingPage';

/**
 * Rotas. As telas internas são carregadas sob demanda: quem só visita a
 * página inicial ou a de entrada não baixa o código do estoque.
 */
const page = <T extends object>(loader: () => Promise<T>, name: keyof T) =>
  lazy(() => importPage(loader).then((module) => ({ default: module[name] as unknown as ComponentType })));

const StockPage = page(() => import('./pages/StockPage'), 'StockPage');
const HistoryPage = page(() => import('./pages/HistoryPage'), 'HistoryPage');
const ReportsPage = page(() => import('./pages/ReportsPage'), 'ReportsPage');
const AnalysisPage = page(() => import('./pages/AnalysisPage'), 'AnalysisPage');
const ImportExportPage = page(() => import('./pages/ImportExportPage'), 'ImportExportPage');
const ConflictsPage = page(() => import('./pages/ConflictsPage'), 'ConflictsPage');
const TeamPage = page(() => import('./pages/TeamPage'), 'TeamPage');
const BrandPage = page(() => import('./pages/BrandPage'), 'BrandPage');
const PlanPage = page(() => import('./pages/PlanPage'), 'PlanPage');
const NotificationsPage = page(() => import('./pages/NotificationsPage'), 'NotificationsPage');
const SupportPage = page(() => import('./pages/SupportPage'), 'SupportPage');
const SupportNewPage = page(() => import('./pages/SupportPage'), 'SupportNewPage');
const SupportTicketPage = page(() => import('./pages/SupportPage'), 'SupportTicketPage');
const AccountPage = page(() => import('./pages/AccountPage'), 'AccountPage');
const CompaniesPage = page(() => import('./pages/CompaniesPage'), 'CompaniesPage');
const LegalPage = page(() => import('./pages/LegalPage'), 'LegalPage');
// As telas de conta também ficam fora do pacote inicial: a página inicial
// (a mais visitada) não precisa delas para pintar.
const LoginPage = page(() => import('./pages/AuthPages'), 'LoginPage');
const BrandedLoginPage = page(() => import('./pages/AuthPages'), 'BrandedLoginPage');
const RegisterPage = page(() => import('./pages/AuthPages'), 'RegisterPage');
const ForgotPasswordPage = page(() => import('./pages/AuthPages'), 'ForgotPasswordPage');
const ResetPasswordPage = page(() => import('./pages/AuthPages'), 'ResetPasswordPage');
const VerifyEmailPage = page(() => import('./pages/AuthPages'), 'VerifyEmailPage');
const InvitePage = page(() => import('./pages/AuthPages'), 'InvitePage');
const HelpPage = page(() => import('./pages/HelpPage'), 'HelpPage');
const PlatformsPage = page(() => import('./pages/PlatformsPage'), 'PlatformsPage');
const PublicPlatformsPage = page(() => import('./pages/PlatformsPage'), 'PublicPlatformsPage');
const PublicHelpPage = page(() => import('./pages/HelpPage'), 'PublicHelpPage');

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

/**
 * Moldura de todas as rotas: a tela da vez e o chat de suporte por cima.
 *
 * O chat e a restauração de rolagem só entram depois do primeiro render: a
 * página inicial chega pré-renderizada só com a tela (`main.tsx` hidrata), e
 * qualquer nó a mais aqui faria o React descartar o HTML pronto.
 */
function Root() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <>
      <Outlet />
      {mounted && (
        <>
          {/* Tela nova começa no topo; voltar restaura onde a pessoa estava; link com
              #âncora vai até ela. A chave é o caminho: mudar só a busca ou o filtro
              na URL (lista de produtos, ajuda) não joga a página para o topo. */}
          <ScrollRestoration getKey={(location) => location.pathname} />
          <SupportChat />
        </>
      )}
    </>
  );
}

export const router = createBrowserRouter([
  {
    element: <Root />,
    // Qualquer falha fora da área interna: tela cheia, com o caminho de volta.
    errorElement: <RouteError fullScreen />,
    children: [
      { path: '/', element: <LandingPage /> },
      { path: '/entrar', element: <Suspense fallback={<FullScreenLoading />}><LoginPage /></Suspense> },
      // Entrada personalizada da empresa (identificadores reservados nunca chegam aqui: ver brand-rules.ts).
      { path: '/:slug/entrar', element: <Suspense fallback={<FullScreenLoading />}><BrandedLoginPage /></Suspense> },
      { path: '/criar-conta', element: <Suspense fallback={<FullScreenLoading />}><RegisterPage /></Suspense> },
      { path: '/esqueci-a-senha', element: <Suspense fallback={<FullScreenLoading />}><ForgotPasswordPage /></Suspense> },
      { path: '/redefinir-senha', element: <Suspense fallback={<FullScreenLoading />}><ResetPasswordPage /></Suspense> },
      { path: '/confirmar-email', element: <Suspense fallback={<FullScreenLoading />}><VerifyEmailPage /></Suspense> },
      { path: '/convite/:token', element: <Suspense fallback={<FullScreenLoading />}><InvitePage /></Suspense> },
      { path: '/termos', element: <Suspense fallback={<FullScreenLoading />}><LegalPage /></Suspense> },
      { path: '/privacidade', element: <Suspense fallback={<FullScreenLoading />}><LegalPage /></Suspense> },
      { path: '/ajuda', element: <Suspense fallback={<FullScreenLoading />}><PublicHelpPage /></Suspense> },
      { path: '/plataformas', element: <Suspense fallback={<FullScreenLoading />}><PublicPlatformsPage /></Suspense> },
      {
        path: '/app',
        element: <AppShell />,
        children: [
          {
            // Falha de uma tela interna: o menu continua, só o miolo explica.
            errorElement: <RouteError />,
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
              { path: 'marca', element: lazyPage(BrandPage) },
              { path: 'notificacoes', element: lazyPage(NotificationsPage) },
              { path: 'ajuda', element: lazyPage(HelpPage) },
              { path: 'plataformas', element: lazyPage(PlatformsPage) },
              { path: 'suporte', element: lazyPage(SupportPage) },
              { path: 'suporte/novo', element: lazyPage(SupportNewPage) },
              { path: 'suporte/:ticketId', element: lazyPage(SupportTicketPage) },
              { path: 'conta', element: lazyPage(AccountPage) },
              { path: 'empresas', element: lazyPage(CompaniesPage) },
              { path: '*', element: <NotFound /> },
            ],
          },
        ],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
