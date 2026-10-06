import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router-dom';

import '@estoquesimples/design/tokens.css';
import './styles/app.css';

import { ApiError } from './api/client';
import { router } from './App';
import { AuthProvider } from './auth/AuthProvider';
import { bootBrand } from './lib/brand';
import { reloadForNewVersion } from './lib/chunks';
import { ToastProvider } from './components/ui';
import { WorkspaceProvider } from './workspace/WorkspaceProvider';

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

createRoot(document.getElementById('root') as HTMLElement).render(
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
  </StrictMode>,
);
