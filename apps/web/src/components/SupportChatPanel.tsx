import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router-dom';

import { api, ApiError, errorMessage } from '../api/client';
import type { Ticket, TicketMessage } from '../api/types';
import { useAuth } from '../auth/AuthProvider';
import { track } from '../lib/analytics';
import { installId, supportDevice } from '../lib/device';
import { useWorkspace } from '../workspace/WorkspaceProvider';
import { Icon, Logo } from './Icon';
import { chatKeys, readChatTicket, writeChatTicket } from './SupportChat';

interface TicketDetail {
  ticket: Ticket;
  messages: TicketMessage[];
}

/** Fala que só existe nesta tela: as perguntas automáticas do começo. */
interface LocalLine {
  id: number;
  author: 'support' | 'user';
  body: string;
}

/** Em que ponto das perguntas iniciais o visitante está. */
type GuestStep = 'name' | 'email' | 'question' | 'done';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const MESSAGE_MAX = 4000;

const hour = new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' });
const dayAndHour = new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

function when(iso: string): string {
  const date = new Date(iso);
  return (date.toDateString() === new Date().toDateString() ? hour : dayAndHour).format(date).replace(',', '');
}

/** O assunto da solicitação sai da primeira linha do que a pessoa escreveu. */
function subjectOf(message: string): string {
  const first = message.split('\n')[0]?.trim() ?? '';
  if (first.length === 0) return 'Conversa pelo chat';
  return first.length > 80 ? `${first.slice(0, 79)}…` : first;
}

/**
 * Chat de suporte. Para a pessoa é uma conversa; por baixo, é uma
 * solicitação de suporte como qualquer outra (`/v1/support/tickets`), que a
 * equipe responde pelo painel e que aparece também em /app/suporte.
 *
 * - Com sessão: a primeira mensagem abre a solicitação já ligada à conta.
 * - Sem sessão: três perguntas automáticas (nome, e-mail, dúvida) e a
 *   solicitação nasce ligada a este navegador, com o contato informado. O
 *   nome e o e-mail ficam só na memória desta página até o envio.
 *
 * As respostas da equipe chegam por consulta periódica enquanto o balão
 * está aberto.
 */
export default function SupportChatPanel({ onClose }: { onClose: () => void }) {
  const { status, user } = useAuth();
  const { workspaceId, entitlement } = useWorkspace();
  const location = useLocation();
  const queryClient = useQueryClient();
  const authed = status === 'authed';

  const [ticketId, setTicketIdState] = useState<string | null>(readChatTicket);
  const [lines, setLines] = useState<LocalLine[]>([]);
  const [typing, setTyping] = useState(false);
  const [step, setStep] = useState<GuestStep>('name');
  const [guest, setGuest] = useState({ name: '', email: '' });
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const counter = useRef(0);
  const timers = useRef<number[]>([]);
  const greeted = useRef(false);
  const scroller = useRef<HTMLDivElement | null>(null);
  const input = useRef<HTMLTextAreaElement | HTMLInputElement | null>(null);

  const setTicketId = useCallback((id: string | null) => {
    writeChatTicket(id);
    setTicketIdState(id);
  }, []);

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const addLine = useCallback((author: LocalLine['author'], body: string) => {
    counter.current += 1;
    const id = counter.current;
    setLines((current) => [...current, { id, author, body }]);
  }, []);

  /** Fala automática, com a pausa de "digitando" antes — sem ela o texto brota de uma vez. */
  const say = useCallback(
    (body: string, delay = 900) => {
      setTyping(true);
      const timer = window.setTimeout(() => {
        addLine('support', body);
        setTyping(false);
      }, delay);
      timers.current.push(timer);
    },
    [addLine],
  );

  // Quem tem conta e já estava numa conversa em aberto continua nela.
  const open = useQuery({
    queryKey: chatKeys.list,
    queryFn: () => api.get<{ tickets: Ticket[] }>('/v1/support/tickets', { installId: installId() }, { optionalAuth: true }),
    enabled: authed && ticketId === null,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (ticketId !== null || !open.data) return;
    const ongoing = open.data.tickets.find((ticket) => ticket.status !== 'resolved');
    if (ongoing) setTicketId(ongoing.id);
  }, [open.data, ticketId, setTicketId]);

  const detail = useQuery({
    queryKey: chatKeys.ticket(ticketId ?? ''),
    queryFn: () => api.get<TicketDetail>(`/v1/support/tickets/${ticketId}`, { installId: installId() }, { optionalAuth: true }),
    enabled: ticketId !== null,
    // A resposta da equipe aparece sozinha; em segundo plano o navegador pausa.
    refetchInterval: 8_000,
    retry: (failures, caught) => !(caught instanceof ApiError && caught.status === 404) && failures < 2,
  });

  // A conversa guardada não é mais desta pessoa (saiu da conta, trocou de
  // conta): começa do zero em vez de mostrar erro.
  useEffect(() => {
    if (detail.error instanceof ApiError && detail.error.status === 404) setTicketId(null);
  }, [detail.error, setTicketId]);

  // Abrir a conversa marca como lida: o aviso no botão some.
  useEffect(() => {
    if (detail.data) void queryClient.invalidateQueries({ queryKey: chatKeys.unread });
  }, [detail.data, queryClient]);

  // Saudação: uma vez, quando já se sabe quem é a pessoa e se há conversa.
  // O efeito é dono do próprio temporizador: se for desfeito antes da hora
  // (inclusive na montagem dupla do modo de desenvolvimento), cancela e não
  // deixa o "digitando" preso.
  const waiting = status === 'loading' || (authed && ticketId === null && open.isLoading);
  const firstName = user?.name.trim().split(/\s+/)[0] ?? '';
  useEffect(() => {
    if (greeted.current || waiting || ticketId !== null) return;
    setTyping(true);
    const timer = window.setTimeout(
      () => {
        greeted.current = true;
        addLine(
          'support',
          authed
            ? `Olá${firstName ? `, ${firstName}` : ''}! Escreva a sua dúvida que a nossa equipe responde por aqui.`
            : 'Olá! Aqui é a equipe do Estoque Simples. Como posso te chamar?',
        );
        setTyping(false);
      },
      authed ? 600 : 900,
    );
    return () => {
      window.clearTimeout(timer);
      setTyping(false);
    };
  }, [waiting, ticketId, authed, firstName, addLine]);

  const messages = detail.data?.messages ?? [];
  const ticket = detail.data?.ticket ?? null;
  const answered = messages.some((message) => message.author === 'support');

  // Sempre na última mensagem, como em qualquer chat.
  const total = lines.length + messages.length + (typing ? 1 : 0) + (sending ? 1 : 0);
  useLayoutEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [total]);

  useEffect(() => {
    input.current?.focus();
  }, [step, ticketId, waiting]);

  const diagnostics = () => ({
    channel: 'chat',
    path: location.pathname.slice(0, 300),
    ...(authed && workspaceId ? { workspaceId } : {}),
    ...(authed && entitlement ? { planKey: entitlement.planKey } : {}),
  });

  const create = useMutation({
    mutationFn: (input_: { message: string; name?: string; email?: string }) =>
      api.post<Ticket>(
        '/v1/support/tickets',
        {
          installId: installId(),
          subject: subjectOf(input_.message),
          message: input_.message,
          category: 'question',
          ...(input_.name ? { contactName: input_.name } : {}),
          ...(input_.email ? { contactEmail: input_.email } : {}),
          device: supportDevice(),
          diagnostics: diagnostics(),
        },
        { optionalAuth: true },
      ),
  });

  const reply = useMutation({
    mutationFn: (message: string) =>
      api.post<{ ticket: Ticket; message: TicketMessage | null }>(`/v1/support/tickets/${ticketId}/messages`, { installId: installId(), message }, { optionalAuth: true }),
  });

  const fail = (caught: unknown, text: string) => {
    // O texto volta para o campo: nada do que a pessoa escreveu se perde.
    setDraft(text);
    setError(
      caught instanceof ApiError && caught.status === 429
        ? 'Muitas mensagens em pouco tempo. Aguarde um instante e envie de novo.'
        : caught instanceof ApiError && caught.status === 409
          ? 'Você já tem várias solicitações em aberto. Continue por uma delas em Suporte.'
          : errorMessage(caught),
    );
  };

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    const text = draft.trim();
    if (text === '' || typing || sending !== null) return;
    setError(null);

    // Conversa em andamento: é só mais uma mensagem.
    if (ticketId !== null) {
      setDraft('');
      setSending(text);
      try {
        const result = await reply.mutateAsync(text);
        const sent = result.message;
        queryClient.setQueryData<TicketDetail>(chatKeys.ticket(ticketId), (current) =>
          current && sent ? { ticket: result.ticket, messages: [...current.messages, sent] } : current,
        );
      } catch (caught) {
        fail(caught, text);
      } finally {
        setSending(null);
      }
      return;
    }

    // Perguntas iniciais de quem não tem sessão.
    if (!authed && step === 'name') {
      if (text.length < 2 || text.length > 80) return setError('Escreva como prefere ser chamado.');
      setDraft('');
      addLine('user', text);
      setGuest((current) => ({ ...current, name: text }));
      setStep('email');
      say(`Prazer, ${text.split(/\s+/)[0]}! Qual é o seu e-mail? É por ele que a resposta chega se você sair desta página.`);
      return;
    }
    if (!authed && step === 'email') {
      if (!EMAIL.test(text) || text.length > 254) return setError('Esse e-mail parece incompleto. Confira e envie de novo.');
      setDraft('');
      addLine('user', text);
      setGuest((current) => ({ ...current, email: text.toLowerCase() }));
      setStep('question');
      say('Certo. Qual é a sua dúvida? Pode escrever com as suas palavras.');
      return;
    }

    // Primeira mensagem de verdade: abre a solicitação.
    setDraft('');
    setSending(text);
    try {
      const created = await create.mutateAsync(authed ? { message: text } : { message: text, name: guest.name, email: guest.email });
      track('support.ticket_submitted', { category: 'question', channel: 'chat' });
      // A conversa já nasce com a mensagem enviada: nada de piscar vazio.
      queryClient.setQueryData<TicketDetail>(chatKeys.ticket(created.id), {
        ticket: created,
        messages: [{ id: `local-${created.id}`, author: 'user', authorName: null, body: text, createdAt: new Date().toISOString() }],
      });
      setStep('done');
      setTicketId(created.id);
      void queryClient.invalidateQueries({ queryKey: chatKeys.list });
      void queryClient.invalidateQueries({ queryKey: ['support'] });
    } catch (caught) {
      fail(caught, text);
    } finally {
      setSending(null);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  };

  const startOver = () => {
    setTicketId(null);
    setLines([]);
    setStep('name');
    setError(null);
    greeted.current = false;
  };

  const asking = ticketId === null && !authed && (step === 'name' || step === 'email');
  const placeholder = asking ? (step === 'name' ? 'Seu nome' : 'Seu e-mail') : ticketId === null ? 'Escreva a sua dúvida…' : 'Escreva uma mensagem…';
  const busy = typing || sending !== null;

  return (
    <section className="chat" role="dialog" aria-label="Chat de suporte" onKeyDown={(event) => event.key === 'Escape' && onClose()}>
      <header className="chat__header">
        <span className="chat__avatar"><Logo size={26} /></span>
        <div className="chat__who">
          <strong>Suporte Estoque Simples</strong>
          <span>{ticket ? `Solicitação #${ticket.number}` : 'Respondemos por aqui e por e-mail'}</span>
        </div>
        <button type="button" className="chat__close" aria-label="Fechar o chat" onClick={onClose}>
          <Icon name="x" size={18} />
        </button>
      </header>

      <div className="chat__body" ref={scroller} role="log" aria-live="polite" aria-relevant="additions">
        {waiting || (ticketId !== null && detail.isLoading) ? (
          <p className="chat__note">Carregando a conversa…</p>
        ) : (
          <>
            {ticketId === null && !authed && (
              <p className="chat__note">As primeiras perguntas são automáticas, para agilizar. Quem responde a sua dúvida é uma pessoa da equipe.</p>
            )}

            {lines.map((line) => (
              <div key={`l${line.id}`} className={`chat__msg chat__msg--${line.author}`}>
                {line.author === 'support' && <span className="chat__author">Equipe Estoque Simples</span>}
                {line.body}
              </div>
            ))}

            {messages.map((message) =>
              message.author === 'system' ? (
                <p key={message.id} className="chat__note">{message.body}</p>
              ) : (
                <div key={message.id} className={`chat__msg chat__msg--${message.author}`}>
                  {message.author === 'support' && <span className="chat__author">{message.authorName ?? 'Equipe Estoque Simples'}</span>}
                  {message.body}
                  <time className="chat__time" dateTime={message.createdAt}>{when(message.createdAt)}</time>
                </div>
              ),
            )}

            {sending !== null && (
              <div className="chat__msg chat__msg--user chat__msg--sending">
                {sending}
                <span className="chat__time">Enviando…</span>
              </div>
            )}

            {typing && (
              <div className="chat__msg chat__msg--support chat__typing" aria-label="Digitando">
                <span /><span /><span />
              </div>
            )}

            {ticket && !answered && sending === null && (
              <p className="chat__note">
                Mensagem recebida. Assim que alguém da equipe responder, a resposta aparece aqui
                {authed ? ' e nas suas notificações.' : ' e chega no seu e-mail.'}
              </p>
            )}

            {ticket?.status === 'resolved' && (
              <p className="chat__note">
                Conversa encerrada. Escrever de novo reabre esta conversa.{' '}
                <button type="button" className="btn btn--link" onClick={startOver}>Começar outra</button>
              </p>
            )}

            {detail.error && !(detail.error instanceof ApiError && detail.error.status === 404) && (
              <p className="chat__note chat__note--error">Sem conexão com o servidor. Tentando de novo…</p>
            )}
          </>
        )}
      </div>

      <form className="chat__composer" onSubmit={(event) => void submit(event)} noValidate>
        {error && <p className="chat__error" role="alert">{error}</p>}
        <div className="chat__row">
          {asking ? (
            <input
              ref={(element) => { input.current = element; }}
              className="chat__input"
              type={step === 'email' ? 'email' : 'text'}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={placeholder}
              aria-label={placeholder}
              autoComplete={step === 'email' ? 'email' : 'given-name'}
              maxLength={step === 'email' ? 254 : 80}
              disabled={waiting}
            />
          ) : (
            <textarea
              ref={(element) => { input.current = element; }}
              className="chat__input chat__input--area"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              aria-label={placeholder}
              rows={2}
              maxLength={MESSAGE_MAX}
              disabled={waiting}
            />
          )}
          <button type="submit" className="chat__send" aria-label="Enviar" disabled={busy || waiting || draft.trim() === ''}>
            <Icon name="send" size={18} />
          </button>
        </div>
        <div className="chat__foot">
          <Link to={authed ? '/app/ajuda' : '/ajuda'} onClick={onClose}>Perguntas frequentes</Link>
          {authed && ticket ? (
            <Link to={`/app/suporte/${ticket.id}`} onClick={onClose}>Abrir em Suporte</Link>
          ) : !authed && ticketId === null ? (
            <Link to="/entrar" onClick={onClose}>Já tenho conta</Link>
          ) : null}
        </div>
      </form>
    </section>
  );
}
