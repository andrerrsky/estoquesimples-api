import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { AuthProvider, useAuth } from './auth/AuthProvider';
import { Icon } from './components/Icon';

import './styles/support-chat.css';

/** Avisa a página quando a sessão foi retomada (ou confirmada como visitante). */
function SessionProbe({ onSession }: { onSession: (authed: boolean) => void }) {
  const { status } = useAuth();
  useEffect(() => {
    if (status !== 'loading') onSession(status === 'authed');
  }, [status, onSession]);
  return null;
}

// O chat só existe em telas largas (`SupportChat` se esconde abaixo de
// 900px): no celular nem o código dele é baixado.
const DESKTOP = '(min-width: 900px)';
const LandingChat = lazy(() => import('./landing-chat'));

/** Disparado quando o balão está na página: o rodapé mostra "Fale com o suporte". */
export const CHAT_READY_EVENT = 'estoque:chat-pronto';
/** O rodapé pede para abrir o chat (sem procurar o balão no DOM). */
export const CHAT_OPEN_EVENT = 'estoque:abrir-chat';

/**
 * Só o balão, estático, até alguém chegar perto dele: o chat inteiro (com
 * sessão, empresa, consultas e roteador) é baixado no primeiro passar do
 * mouse, foco ou clique, e abre já na conversa. A maioria das visitas não
 * paga por ele.
 */
function ChatLauncher() {
  const [wanted, setWanted] = useState<'no' | 'warm' | 'open'>('no');
  // Cada pedido do rodapé remonta o chat já aberto (ele pode ter sido fechado).
  const [opening, setOpening] = useState(0);

  useEffect(() => {
    const open = () => {
      setWanted('open');
      setOpening((count) => count + 1);
    };
    document.addEventListener(CHAT_OPEN_EVENT, open);
    document.dispatchEvent(new CustomEvent(CHAT_READY_EVENT));
    return () => document.removeEventListener(CHAT_OPEN_EVENT, open);
  }, []);

  if (wanted === 'open') {
    return (
      <Suspense fallback={<Stub busy />}>
        <LandingChat key={opening} initialOpen />
      </Suspense>
    );
  }
  return (
    <>
      <Stub onWarm={() => setWanted((current) => (current === 'no' ? 'warm' : current))} onOpen={() => setWanted('open')} />
      {wanted === 'warm' && (
        <Suspense fallback={null}>
          {/* Carrega o chat em segundo plano, fora da tela; o balão visível continua sendo o de cima. */}
          <span hidden>
            <LandingChat initialOpen={false} />
          </span>
        </Suspense>
      )}
    </>
  );
}

function Stub({ busy = false, onWarm, onOpen }: { busy?: boolean; onWarm?: () => void; onOpen?: () => void }) {
  return (
    <div className="chat-dock no-print">
      <button
        type="button"
        className="chat-launcher"
        aria-label="Abrir o chat de suporte"
        aria-expanded={false}
        aria-busy={busy || undefined}
        onMouseEnter={onWarm}
        onFocus={onWarm}
        onClick={onOpen}
      >
        <Icon name="help" size={24} />
      </button>
    </div>
  );
}

/**
 * A parte da aplicação que a página inicial usa depois de carregada: a
 * retomada da sessão (que troca "Criar conta" por "Abrir meu estoque") e,
 * em telas largas, o balão do chat de suporte. Monta numa raiz própria, ao
 * lado da página, para não mexer no HTML hidratado.
 */
export function mountExtras(onSession: (authed: boolean) => void): void {
  const host = document.createElement('div');
  host.id = 'extras';
  document.body.appendChild(host);
  const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: false }, mutations: { retry: false } } });
  const desktop = window.matchMedia(DESKTOP).matches;
  createRoot(host).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <AuthProvider>
          <SessionProbe onSession={onSession} />
          {desktop && <ChatLauncher />}
        </AuthProvider>
      </QueryClientProvider>
    </StrictMode>,
  );
}
