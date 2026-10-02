import { useQuery } from '@tanstack/react-query';
import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';

import { api } from '../api/client';
import type { Ticket } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { importPage } from '../lib/chunks';
import { installId } from '../lib/device';
import { Icon } from './Icon';

import '../styles/support-chat.css';

/** Chaves de consulta do chat (o balão e o botão compartilham o cache). */
export const chatKeys = {
  list: ['support-chat', 'tickets'] as const,
  unread: ['support-chat', 'unread'] as const,
  ticket: (id: string) => ['support-chat', 'ticket', id] as const,
};

/**
 * Conversa em andamento neste navegador. Guarda só o identificador da
 * solicitação — o conteúdo vem sempre do servidor.
 */
const TICKET_KEY = 'es_web_chat_ticket';
let memoryTicket: string | null = null;

export function readChatTicket(): string | null {
  try {
    return localStorage.getItem(TICKET_KEY) ?? memoryTicket;
  } catch {
    return memoryTicket;
  }
}

export function writeChatTicket(id: string | null): void {
  memoryTicket = id;
  try {
    if (id) localStorage.setItem(TICKET_KEY, id);
    else localStorage.removeItem(TICKET_KEY);
  } catch {
    // armazenamento bloqueado: a conversa vale enquanto a página estiver aberta
  }
}

// O balão só é baixado quando alguém abre o chat.
const Panel = lazy(() => importPage(() => import('./SupportChatPanel')));

/** Telas largas o bastante para o balão não cobrir o conteúdo. */
const DESKTOP = '(min-width: 900px)';

function useDesktop(): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(DESKTOP).matches);
  useEffect(() => {
    const query = window.matchMedia(DESKTOP);
    const onChange = () => setMatches(query.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return matches;
}

/**
 * Botão flutuante de suporte, no canto inferior direito, e o balão de
 * conversa que ele abre. Só em telas de computador: no celular o balão
 * tomaria a tela inteira, e a área de suporte já está a um toque no menu.
 */
export function SupportChat() {
  const { status } = useAuth();
  const location = useLocation();
  const desktop = useDesktop();
  const [open, setOpen] = useState(false);
  const launcher = useRef<HTMLButtonElement | null>(null);

  // Na própria área de suporte o chat seria a mesma conversa duas vezes.
  const hidden = !desktop || location.pathname.startsWith('/app/suporte');
  const authed = status === 'authed';

  // Resposta nova com o balão fechado: um ponto no botão. Visitante só
  // consulta se já tem uma conversa neste navegador.
  const unread = useQuery({
    queryKey: chatKeys.unread,
    queryFn: () =>
      api
        .get<{ tickets: Ticket[] }>('/v1/support/tickets', { installId: installId() }, { optionalAuth: true })
        .then((response) => response.tickets.filter((ticket) => ticket.unread).length),
    enabled: !hidden && !open && status !== 'loading' && (authed || readChatTicket() !== null),
    refetchInterval: 60_000,
    retry: false,
  });

  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  if (hidden) return null;

  const close = () => {
    setOpen(false);
    launcher.current?.focus();
  };
  const count = open ? 0 : (unread.data ?? 0);

  return (
    <div className="chat-dock no-print">
      {open && (
        <Suspense fallback={<section className="chat chat--loading" aria-busy="true" />}>
          <Panel onClose={close} />
        </Suspense>
      )}
      <button
        ref={launcher}
        type="button"
        className={`chat-launcher ${open ? 'chat-launcher--open' : ''}`}
        aria-expanded={open}
        aria-label={open ? 'Fechar o chat de suporte' : count > 0 ? 'Abrir o chat de suporte: há resposta nova' : 'Abrir o chat de suporte'}
        onClick={() => setOpen((current) => !current)}
      >
        <Icon name={open ? 'chevronDown' : 'help'} size={24} />
        {count > 0 && <span className="chat-launcher__dot" aria-hidden="true" />}
      </button>
    </div>
  );
}
