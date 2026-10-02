import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { api, ApiError, errorMessage } from '../api/client';
import type { Ticket, TicketMessage } from '../api/types';
import { Icon } from '../components/Icon';
import { Badge, Card, ConfirmDialog, Empty, Field, Notice, PageHeader, QueryState, Time, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { installId, supportDevice } from '../lib/device';
import { TICKET_CATEGORY, TICKET_STATUS } from '../lib/labels';
import { useWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-inbox.css';

/**
 * Suporte: as mesmas solicitações do app Android (`/v1/support`, contrato em
 * docs/support.md). Toda chamada leva o `installId` deste navegador — na query
 * nos GET, no corpo nos POST. A API aceita essas rotas sem sessão (no app,
 * quem não tem conta também pede ajuda), mas estas telas só existem dentro do
 * AppShell: o Bearer vai sempre, e a solicitação é da conta, não do navegador.
 * Quem pode ver o quê é decisão da API; aqui só se mostra o que ela devolve.
 */

// Limites de `createTicketBodySchema` / `userMessageBodySchema` (support.schemas.ts).
const SUBJECT_MAX = 120;
const MESSAGE_MAX = 4000;

const REFRESH_MS = 20_000;

const supportKeys = {
  list: ['support', 'list'] as const,
  ticket: (ticketId: string) => ['support', 'ticket', ticketId] as const,
  categories: ['support', 'categories'] as const,
};

interface TicketDetail {
  ticket: Ticket;
  messages: TicketMessage[];
}

const statusOf = (status: string) => TICKET_STATUS[status] ?? { label: status, tone: 'neutral' as const };

function CharCount({ length, max }: { length: number; max: number }) {
  return (
    <span className={`char-count ${length > max * 0.9 ? 'char-count--near' : ''}`} aria-hidden="true">
      {length}/{max}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------

export function SupportPage() {
  const list = useQuery({
    queryKey: supportKeys.list,
    queryFn: () => api.get<{ tickets: Ticket[] }>('/v1/support/tickets', { installId: installId() }).then((response) => response.tickets),
    // Uma resposta da equipe aparece sem precisar recarregar a página.
    refetchInterval: 60_000,
  });

  const tickets = list.data ?? [];
  const newTicket = (
    <Link to="/app/suporte/novo" className="btn btn--primary">
      <Icon name="plus" size={17} /> Nova solicitação
    </Link>
  );

  return (
    <div className="page page--narrow">
      <PageHeader title="Falar com o suporte" subtitle="Fale com a equipe do Estoque Simples. A resposta chega por aqui." actions={newTicket} />

      <Notice tone="info" action={<Link to="/app/ajuda" className="btn btn--secondary btn--sm">Abrir a central de ajuda</Link>}>
        Muitas dúvidas já têm resposta pronta: sincronização, equipe, pagamento, reembolso.
      </Notice>

      <Card flush>
        {list.isLoading || (list.error && !list.data) ? (
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        ) : tickets.length === 0 ? (
          <Empty icon="help" title="Nenhuma solicitação ainda" actions={newTicket}>
            Ficou com dúvida, encontrou um problema ou tem uma sugestão? Escreva para a equipe: a resposta chega por aqui.
          </Empty>
        ) : (
          tickets.map((ticket) => {
            const status = statusOf(ticket.status);
            return (
              <Link key={ticket.id} to={`/app/suporte/${ticket.id}`} className={`ticket-row ${ticket.unread ? 'ticket-row--unread' : ''}`}>
                <span className="ticket-row__dot">{ticket.unread && <span className="unread-dot" aria-hidden="true" />}</span>
                <span className="ticket-row__main">
                  <span className="ticket-row__subject">
                    {ticket.unread && <span className="sr-only">Resposta nova: </span>}
                    {ticket.subject}
                  </span>
                  <span className="ticket-row__sub">
                    <span>#{ticket.number}</span>
                    <span>{ticket.categoryLabel}</span>
                  </span>
                </span>
                <span className="ticket-row__side">
                  <Badge tone={status.tone}>{status.label}</Badge>
                  <Time value={ticket.lastMessageAt} />
                </span>
              </Link>
            );
          })
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nova solicitação
// ---------------------------------------------------------------------------

export function SupportNewPage() {
  const { workspaceId, entitlement } = useWorkspace();
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  // As categorias vêm da API, com os rótulos que o painel e o app usam; a
  // lista local só cobre o intervalo até a resposta chegar (ou se ela falhar).
  const categories = useQuery({
    queryKey: supportKeys.categories,
    queryFn: () => api.get<{ categories: Array<{ key: string; label: string }> }>('/v1/support/categories', undefined, { auth: false }).then((response) => response.categories),
    staleTime: Infinity,
  });
  const options = categories.data && categories.data.length > 0 ? categories.data : TICKET_CATEGORY;

  // Outras telas podem abrir o formulário já na categoria certa:
  // /app/suporte/novo?categoria=billing
  const [category, setCategory] = useState(params.get('categoria') ?? 'question');
  const [subject, setSubject] = useState('');
  const [message, setMessage] = useState('');
  const [error, setError] = useState<unknown>(null);

  const selected = options.some((item) => item.key === category) ? category : (options[0]?.key ?? 'question');

  const create = useMutation({
    mutationFn: () => {
      // Só contexto inofensivo: de onde a pessoa veio, a empresa aberta e o
      // plano. `workspaceId` é a chave que a API usa para ligar a solicitação
      // à empresa (e ela confere se a pessoa participa). Nada do estoque vai.
      const from = (location.state as { from?: unknown } | null)?.from;
      const diagnostics: Record<string, string> = {
        path: (typeof from === 'string' ? from : location.pathname).slice(0, 300),
        ...(workspaceId ? { workspaceId } : {}),
        ...(entitlement ? { planKey: entitlement.planKey } : {}),
      };
      return api.post<Ticket>('/v1/support/tickets', {
        installId: installId(),
        subject: subject.trim(),
        message: message.trim(),
        category: selected,
        device: supportDevice(),
        diagnostics,
      });
    },
    onSuccess: (ticket) => {
      void queryClient.invalidateQueries({ queryKey: supportKeys.list });
      toast.success(`Solicitação #${ticket.number} enviada.`);
      navigate(`/app/suporte/${ticket.id}`, { replace: true });
    },
    onError: (caught) => setError(caught),
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    if (subject.trim() === '' || message.trim() === '') return setError(new Error('Preencha o assunto e a mensagem.'));
    track('support.ticket_submitted', { category: selected });
    create.mutate();
  };

  const subjectError = error instanceof ApiError ? error.fieldError('subject') : undefined;
  const messageError = error instanceof ApiError ? error.fieldError('message') : undefined;

  return (
    <div className="page page--narrow">
      <PageHeader
        crumbs={[{ label: 'Suporte', to: '/app/suporte' }, { label: 'Nova solicitação' }]}
        title="Nova solicitação"
        subtitle="Conte o que está acontecendo. Quem lê e responde é a equipe do Estoque Simples."
      />

      <Card>
        <form className="stack" onSubmit={submit}>
          {error !== null && !subjectError && !messageError && <Notice tone="error">{errorMessage(error)}</Notice>}
          <Field label="Sobre o que é?">
            <select className="select" value={selected} onChange={(event) => setCategory(event.target.value)}>
              {options.map((item) => (
                <option key={item.key} value={item.key}>
                  {item.label}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Assunto" hint="Um resumo em poucas palavras." error={subjectError}>
            <input className="input" value={subject} onChange={(event) => setSubject(event.target.value)} maxLength={SUBJECT_MAX} required autoFocus aria-invalid={subjectError ? true : undefined} />
          </Field>
          <Field label="Mensagem" hint="Diga o que você tentou fazer e o que apareceu na tela. Quanto mais detalhe, mais rápido a gente ajuda." error={messageError}>
            <textarea className="textarea" value={message} onChange={(event) => setMessage(event.target.value)} maxLength={MESSAGE_MAX} rows={7} required aria-invalid={messageError ? true : undefined} />
          </Field>
          <p className="caption">
            Junto com a mensagem vão o navegador e o sistema que você usa, a versão do aplicativo, o idioma, o fuso horário, a empresa aberta e o plano, para a equipe entender o contexto. Nenhum dado do seu estoque é enviado.
          </p>
          <div className="reply__footer">
            <CharCount length={message.length} max={MESSAGE_MAX} />
            <div className="row">
              <Link to="/app/suporte" className="btn btn--ghost">Cancelar</Link>
              <button type="submit" className="btn btn--primary" disabled={create.isPending}>
                <Icon name="send" size={16} /> {create.isPending ? 'Enviando…' : 'Enviar'}
              </button>
            </div>
          </div>
        </form>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Conversa
// ---------------------------------------------------------------------------

function Message({ message }: { message: TicketMessage }) {
  if (message.author === 'system') {
    return (
      <div className="msg msg--system">
        {message.body} · <Time value={message.createdAt} />
      </div>
    );
  }
  const mine = message.author === 'user';
  return (
    <div className={`msg ${mine ? 'msg--user' : 'msg--support'}`}>
      <div className="msg__meta">
        {mine ? 'Você' : (message.authorName ?? 'Equipe Estoque Simples')} <span className="msg__time">· <Time value={message.createdAt} /></span>
      </div>
      {message.body}
    </div>
  );
}

/** A rota é a mesma para qualquer solicitação: a chave zera rascunho e rolagem ao trocar. */
export function SupportTicketPage() {
  const { ticketId = '' } = useParams();
  return <TicketConversation key={ticketId} ticketId={ticketId} />;
}

function TicketConversation({ ticketId }: { ticketId: string }) {
  const queryClient = useQueryClient();
  const toast = useToast();
  const [draft, setDraft] = useState('');
  const [resolving, setResolving] = useState(false);
  const end = useRef<HTMLDivElement | null>(null);
  const scrolledAt = useRef(0);
  const key = supportKeys.ticket(ticketId);
  const path = `/v1/support/tickets/${encodeURIComponent(ticketId)}`;

  const detail = useQuery({
    queryKey: key,
    queryFn: () => api.get<TicketDetail>(path, { installId: installId() }),
    // Conversa aberta se atualiza sozinha; o TanStack Query pausa o intervalo
    // enquanto a aba está escondida. Depois de um erro (404), para de tentar.
    refetchInterval: (query) => (query.state.error ? false : REFRESH_MS),
  });

  const ticket = detail.data?.ticket;
  const messages = detail.data?.messages ?? [];
  const lastMessageAt = ticket?.lastMessageAt;

  // Ler a conversa (o GET acima) já a marca como vista no servidor. A cada
  // mensagem nova, a lista perde a marca de "não lida" e o sino é acertado.
  useEffect(() => {
    if (!lastMessageAt) return;
    void queryClient.invalidateQueries({ queryKey: supportKeys.list });
    // A API marca como lidos os avisos desta conversa ao abri-la; aqui só o
    // sino é atualizado.
    void queryClient.invalidateQueries({ queryKey: ['notifications'] });
  }, [ticketId, lastMessageAt, queryClient]);

  // Leva à última mensagem ao abrir e quando chega outra. No quadro seguinte,
  // porque o AppShell volta a página ao topo a cada troca de rota.
  const count = messages.length;
  useEffect(() => {
    if (count === 0 || count === scrolledAt.current) return;
    const frame = requestAnimationFrame(() => {
      const calm = scrolledAt.current === 0 || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      scrolledAt.current = count;
      end.current?.scrollIntoView({ block: 'end', behavior: calm ? 'auto' : 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [count]);

  const reply = useMutation({
    mutationFn: (text: string) => api.post<{ ticket: Ticket; message: TicketMessage | null }>(`${path}/messages`, { installId: installId(), message: text }),
    onSuccess: (result) => {
      setDraft('');
      const sent = result.message;
      queryClient.setQueryData<TicketDetail>(key, (current) =>
        current ? { ticket: result.ticket, messages: sent && !current.messages.some((item) => item.id === sent.id) ? [...current.messages, sent] : current.messages } : current,
      );
      void queryClient.invalidateQueries({ queryKey: key });
      void queryClient.invalidateQueries({ queryKey: supportKeys.list });
    },
  });

  const resolve = async () => {
    const updated = await api.post<Ticket>(`${path}/resolve`, { installId: installId() });
    queryClient.setQueryData<TicketDetail>(key, (current) => (current ? { ...current, ticket: updated } : current));
    // A API registra a resolução como uma linha da conversa: busca de novo.
    void queryClient.invalidateQueries({ queryKey: key });
    void queryClient.invalidateQueries({ queryKey: supportKeys.list });
    toast.success('Solicitação marcada como resolvida.');
  };

  const send = () => {
    const text = draft.trim();
    if (text === '' || reply.isPending) return;
    reply.mutate(text);
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    send();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      send();
    }
  };

  const crumbs = [{ label: 'Suporte', to: '/app/suporte' }, { label: ticket ? `#${ticket.number}` : 'Solicitação' }];

  // 404: não existe ou é de outra conta (a API não diz qual, de propósito).
  // 400: o endereço não tem um identificador válido. Para a pessoa, dá no mesmo.
  if (detail.error instanceof ApiError && (detail.error.status === 404 || detail.error.status === 400)) {
    return (
      <div className="page page--narrow">
        <PageHeader crumbs={crumbs} title="Solicitação não encontrada" />
        <Card>
          <Empty icon="help" title="Não encontramos esta solicitação" actions={<Link to="/app/suporte" className="btn btn--secondary">Ver minhas solicitações</Link>}>
            O endereço pode estar incompleto, ou a solicitação foi aberta em outra conta.
          </Empty>
        </Card>
      </div>
    );
  }

  if (!ticket) {
    return (
      <div className="page page--narrow">
        <PageHeader crumbs={crumbs} title="Solicitação" />
        <Card flush>
          <QueryState loading={detail.isLoading} error={detail.error} onRetry={() => void detail.refetch()} />
        </Card>
      </div>
    );
  }

  const status = statusOf(ticket.status);
  const resolved = ticket.status === 'resolved';

  return (
    <div className="page page--narrow">
      <PageHeader
        crumbs={crumbs}
        title={
          <span className="ticket-title">
            {ticket.subject} <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        }
        subtitle={
          <>
            #{ticket.number} · {ticket.categoryLabel} · aberta <Time value={ticket.createdAt} />
          </>
        }
        actions={
          !resolved && (
            <button type="button" className="btn btn--secondary" onClick={() => setResolving(true)}>
              <Icon name="check" size={17} /> Marcar como resolvida
            </button>
          )
        }
      />

      <div className="thread-panel">
        <div className="thread" role="log" aria-label="Conversa com o suporte">
          {messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
        </div>
      </div>

      <Card>
        <form className="reply" onSubmit={submit}>
          {resolved && (
            <Notice tone="info" title="Solicitação resolvida">
              Se ainda precisar de ajuda com este assunto, é só escrever abaixo: a solicitação é reaberta e a equipe volta a acompanhar.
            </Notice>
          )}
          {reply.error && <Notice tone="error">{errorMessage(reply.error)}</Notice>}
          <Field
            label={resolved ? 'Escrever de novo' : 'Sua mensagem'}
            hint={
              resolved
                ? 'Enviar reabre a solicitação.'
                : ticket.status === 'answered'
                  ? 'A equipe respondeu. Se resolveu, marque como resolvida; se não, continue a conversa por aqui.'
                  : 'Recebemos sua mensagem. Quando a equipe responder, você é avisado nas notificações.'
            }
          >
            <textarea className="textarea" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={onKeyDown} maxLength={MESSAGE_MAX} rows={4} placeholder="Escreva aqui…" />
          </Field>
          <div className="reply__footer">
            <CharCount length={draft.length} max={MESSAGE_MAX} />
            <button type="submit" className="btn btn--primary" disabled={reply.isPending || draft.trim() === ''}>
              <Icon name="send" size={16} /> {reply.isPending ? 'Enviando…' : resolved ? 'Enviar e reabrir' : 'Enviar'}
            </button>
          </div>
        </form>
      </Card>
      <div ref={end} className="thread-end" aria-hidden="true" />

      <ConfirmDialog
        open={resolving}
        onClose={() => setResolving(false)}
        title="Marcar como resolvida?"
        description="A conversa continua guardada. Se precisar, é só escrever de novo que ela reabre."
        confirmLabel="Marcar como resolvida"
        onConfirm={resolve}
      />
    </div>
  );
}
