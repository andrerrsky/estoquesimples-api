import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import '@estoquesimples/design/tokens.css';
import './styles/app.css';

import { ApiError } from './api/client';
import { router } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { bootBrand } from './lib/brand';
import { reloadForNewVersion } from './lib/chunks';
import { installGlobalErrorReporting } from './lib/error-reporter';
import { ToastProvider } from './components/ui';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';

// Erros de JavaScript da web e do web app vão para Admin › Erros.
installGlobalErrorReporting();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      // Erro de negócio (403, 404, 409) não melhora repetindo; só rede e 5xx.
      retry: (failures, error) => {
        if (error instanceof ApiError && error.status >= 400 && error.status < 500) return false;
        return failures < 2;
      },
    },
    mutations: { retry: false },
  },
});

// O Vite avisa quando um arquivo da versão anterior não existe mais (aba
// aberta durante um deploy): recarrega para pegar a versão nova.
window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});

// Abre já com a última marca da empresa (a API confirma ou desfaz depois).
bootBrand();

const container = document.getElementById('root') as HTMLElement;
const app = (
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <AuthProvider>
          <WorkspaceProvider>
            <RouterProvider router={router} />
          </WorkspaceProvider>
        </AuthProvider>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>
);

// A página inicial chega já renderizada (apps/web/scripts/prerender.mjs):
// hidratar aproveita o DOM que está na tela em vez de reconstruí-lo, então o
// vídeo que a pessoa já deu play e o foco do teclado continuam onde estavam.
// Qualquer diferença entre o HTML e o que o React esperava é registrada no
// console (em produção o React refaz a árvore sozinho).
// Blog vindo pronto da API (data-ssr): não é a árvore da aplicação, então não
// dá para hidratar; o React desenha por cima e a página (idêntica) assume.
if (container.querySelector('[data-ssr]')) {
  container.replaceChildren();
  createRoot(container).render(app);
} else if (container.firstElementChild) {
  hydrateRoot(container, app, {
    onRecoverableError: (error) => console.warn('hidratação da página inicial:', error),
  });
} else {
  createRoot(container).render(app);
}
