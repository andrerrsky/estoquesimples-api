import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { lazy, StrictMode, Suspense, useEffect, useState, type ReactNode } from 'react';
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

/** Quanto do chat já foi pedido: nada, baixando em segundo plano, ou aberto. */
type Wanted = 'no' | 'warm' | 'open';

/** Disparado quando o balão está na página: o rodapé mostra "Fale com o suporte". */
export const CHAT_READY_EVENT = 'estoque:chat-pronto';
/** O rodapé pede para abrir o chat (sem procurar o balão no DOM). */
export const CHAT_OPEN_EVENT = 'estoque:abrir-chat';

/** O balão, estático: um botão e um ícone, sem nada por trás. */
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

/** Um cliente só, criado na primeira vez que algum provedor precisa dele. */
let cliente: QueryClient | null = null;
function Providers({ children }: { children: ReactNode }) {
  cliente ??= new QueryClient({ defaultOptions: { queries: { staleTime: 15_000, retry: false }, mutations: { retry: false } } });
  return (
    <QueryClientProvider client={cliente}>
      <AuthProvider>{children}</AuthProvider>
    </QueryClientProvider>
  );
}

/**
 * Este navegador já entrou na conta alguma vez? Só então existe sessão para
 * retomar — é a mesma marca que `api/client.ts` usa para não pedir
 * `/v1/auth/web/refresh` a quem nunca entrou.
 */
function sessaoPossivel(): boolean {
  try {
    return localStorage.getItem('es_web_sessao') === '1';
  } catch {
    return false;
  }
}

/**
 * O que a página inicial ganha depois de carregada.
 *
 * O ponto desta estrutura é **o que não é montado**: os provedores (cache de
 * consultas e sessão) só entram na árvore quando há o que fazer com eles —
 * uma sessão para retomar, ou o chat de verdade a caminho. Antes, montá-los
 * era a primeira coisa que `mountExtras` fazia, e na visita mais comum (quem
 * chega pela primeira vez, num computador) isso servia só para desenhar um
 * botão estático. O balão não precisa de nada disso; o chat, sim, e ele já
 * chega sob demanda.
 *
 * O balão fica **fora** da parte que muda, e por isso nunca remonta. Essa
 * posição não é detalhe: com ele dentro, o primeiro passar do mouse (que
 * começa a baixar o chat) faria os provedores entrarem, o botão se
 * desmontaria no meio do gesto e o clique que vinha em seguida se perdia.
 */
function Extras({ onSession, desktop, comSessao }: { onSession: (authed: boolean) => void; desktop: boolean; comSessao: boolean }) {
  const [wanted, setWanted] = useState<Wanted>('no');
  // Cada pedido do rodapé remonta o chat já aberto (ele pode ter sido fechado).
  const [opening, setOpening] = useState(0);

  const abrir = () => {
    setWanted('open');
    setOpening((count) => count + 1);
  };

  useEffect(() => {
    if (!desktop) return undefined;
    const open = () => abrir();
    document.addEventListener(CHAT_OPEN_EVENT, open);
    document.dispatchEvent(new CustomEvent(CHAT_READY_EVENT));
    return () => document.removeEventListener(CHAT_OPEN_EVENT, open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [desktop]);

  const precisaProvedores = comSessao || wanted !== 'no';

  return (
    <>
      {desktop && wanted !== 'open' && <Stub onWarm={() => setWanted((current) => (current === 'no' ? 'warm' : current))} onOpen={abrir} />}
      {precisaProvedores && (
        <Providers>
          {comSessao && <SessionProbe onSession={onSession} />}
          {wanted === 'warm' && (
            <Suspense fallback={null}>
              {/* Baixa o chat em segundo plano, fora da tela; o balão visível continua sendo o de cima. */}
              <span hidden>
                <LandingChat initialOpen={false} />
              </span>
            </Suspense>
          )}
          {wanted === 'open' && (
            <Suspense fallback={<Stub busy />}>
              <LandingChat key={opening} initialOpen />
            </Suspense>
          )}
        </Providers>
      )}
    </>
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
  createRoot(host).render(
    <StrictMode>
      <Extras onSession={onSession} desktop={window.matchMedia(DESKTOP).matches} comSessao={sessaoPossivel()} />
    </StrictMode>,
  );
}
