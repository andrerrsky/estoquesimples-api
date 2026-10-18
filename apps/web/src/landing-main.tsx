import { StrictMode, useEffect, useState } from 'react';
import { createRoot, hydrateRoot } from 'react-dom/client';

import '@estoquesimples/design/tokens.css';
import './styles/app.css';

import { reloadForNewVersion } from './lib/chunks';
import { LandingPage, LandingSessionContext } from './pages/LandingPage';

/**
 * Entrada da página inicial (landing.html). Carrega só o que a página usa:
 * React e a própria página, sem roteador, sem cache de consultas e sem o
 * provedor de sessão. O HTML já vem pronto do build e é hidratado.
 *
 * O que a aplicação completa teria a mais (o chat de suporte e a sessão,
 * que troca "Criar conta" por "Abrir meu estoque") chega depois, quando o
 * navegador está ocioso, por `landing-extras.tsx`: não disputa a primeira
 * pintura com o conteúdo. E só quando tem para que servir: em tela larga
 * (há chat) ou quando este navegador já entrou na conta alguma vez. No
 * celular de quem nunca entrou, não baixa nada depois da hidratação.
 */
function extrasWorthLoading(): boolean {
  if (window.matchMedia('(min-width: 900px)').matches) return true;
  try {
    return localStorage.getItem('es_web_sessao') === '1';
  } catch {
    return false;
  }
}

function Landing() {
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    if (!extrasWorthLoading()) return undefined;
    let cancelled = false;
    const load = () => {
      import('./landing-extras')
        .then(({ mountExtras }) => {
          if (!cancelled) mountExtras((active) => setAuthed(active));
        })
        .catch(() => {
          // Sem os extras a página continua inteira; só não há chat.
        });
    };
    // Em ociosidade (Safari não tem requestIdleCallback: espera um pouco).
    const w = window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void };
    const idle = w.requestIdleCallback ? w.requestIdleCallback(load, { timeout: 2500 }) : window.setTimeout(load, 1200);
    return () => {
      cancelled = true;
      if (w.cancelIdleCallback) w.cancelIdleCallback(idle);
      else window.clearTimeout(idle);
    };
  }, []);

  return (
    <LandingSessionContext.Provider value={authed}>
      <LandingPage />
    </LandingSessionContext.Provider>
  );
}

window.addEventListener('vite:preloadError', (event) => {
  if (reloadForNewVersion()) event.preventDefault();
});

const container = document.getElementById('root') as HTMLElement;
const app = (
  <StrictMode>
    <Landing />
  </StrictMode>
);
if (container.firstElementChild) {
  hydrateRoot(container, app, {
    onRecoverableError: (error) => console.warn('hidratação da página inicial:', error),
  });
} else {
  createRoot(container).render(app);
}
