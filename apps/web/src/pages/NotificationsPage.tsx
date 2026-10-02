import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearchParams } from 'react-router-dom';

import { api, ApiError } from '../api/client';
import type { AppNotification, NotificationList } from '../api/types';
import { Icon, type IconName } from '../components/Icon';
import { Card, Chips, Empty, PageHeader, QueryState, Time, useToast } from '../components/ui';
import { track } from '../lib/analytics';
import { plural } from '../lib/format';
import { useWorkspace } from '../workspace/WorkspaceProvider';

import '../styles/pages-inbox.css';

const PAGE_SIZE = 30;

type Filter = 'todas' | 'nao-lidas';

interface TypeMeta {
  icon: IconName;
  label: string;
}

/**
 * Aparência de cada tipo de notificação. O catálogo da API é aberto
 * (`NotificationType` em notifications.service.ts): um tipo novo chega aqui
 * sem deploy da web, então quem não está no mapa cai na família (o prefixo
 * antes do ponto) e, por último, no aviso genérico.
 */
const TYPE_META: Record<string, TypeMeta> = {
  'support.reply': { icon: 'help', label: 'Suporte' },
  'support.resolved': { icon: 'check', label: 'Suporte' },
  'billing.payment_confirmed': { icon: 'card', label: 'Plano' },
  'billing.payment_overdue': { icon: 'alert', label: 'Plano' },
  'billing.subscription_suspended': { icon: 'alert', label: 'Plano' },
  'billing.subscription_ended': { icon: 'card', label: 'Plano' },
  'billing.subscription_refunded': { icon: 'undo', label: 'Plano' },
  'team.invite_accepted': { icon: 'users', label: 'Equipe' },
  'team.member_joined': { icon: 'users', label: 'Equipe' },
  campaign: { icon: 'sparkle', label: 'Novidade' },
};

const FAMILY_META: Record<string, TypeMeta> = {
  support: { icon: 'help', label: 'Suporte' },
  billing: { icon: 'card', label: 'Plano' },
  team: { icon: 'users', label: 'Equipe' },
};

const DEFAULT_META: TypeMeta = { icon: 'bell', label: 'Aviso' };

const family = (type: string) => type.split('.')[0] ?? type;

function metaOf(type: string): TypeMeta {
  return TYPE_META[type] ?? FAMILY_META[family(type)] ?? DEFAULT_META;
}

/**
 * Telas que uma notificação pode pedir em `data.screen`. São os mesmos nomes
 * que o app Android entende (`PUSH_SCREENS` em push.schemas.ts), traduzidos
 * para as rotas da web.
 */
const SCREEN_ROUTE: Record<string, string> = {
  main: '/app/estoque',
  history: '/app/historico',
  reports: '/app/relatorios',
  analysis: '/app/analise',
  account: '/app/conta',
  subscription: '/app/plano',
  team: '/app/equipe',
  import: '/app/importar',
};

type Destination =
  /** Rota interna; `workspaceId` é a empresa de que o aviso fala, quando importa. */
  | { to: string; workspaceId?: string | null }
  /** Endereço de fora (campanha com link): abre em outra aba. */
  | { href: string }
  | null;

const text = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** Para onde o clique leva. Tipo sem destino conhecido só é marcado como lido. */
function destinationOf(notification: AppNotification): Destination {
  const { type, data } = notification;
  const workspaceId = text(data['workspaceId']) ?? notification.workspaceId;

  // A conversa do suporte é da conta, não da empresa: não troca de empresa.
  if (type.startsWith('support.')) {
    const ticketId = text(data['ticketId']);
    return { to: ticketId ? `/app/suporte/${ticketId}` : '/app/suporte' };
  }
  if (type.startsWith('billing.')) return { to: '/app/plano', workspaceId };
  if (type.startsWith('team.')) return { to: '/app/equipe', workspaceId };

  const route = SCREEN_ROUTE[text(data['screen']) ?? ''];
  if (route) return { to: route, workspaceId };

  const url = text(data['url']);
  if (url) {
    try {
      const parsed = new URL(url, window.location.origin);
      if (parsed.origin === window.location.origin) return { to: `${parsed.pathname}${parsed.search}${parsed.hash}` };
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return { href: parsed.href };
    } catch {
      // endereço malformado: fica sem destino
    }
  }
  return null;
}

/**
 * Caixa de notificações, a mesma que o app Android lê. A lista vem pronta da
 * API (mais recentes primeiro, paginada por cursor); aqui só se marca como
 * lida e se leva a pessoa ao lugar de que o aviso fala.
 */
export function NotificationsPage() {
  const { workspaces, workspaceId, select } = useWorkspace();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const queryClient = useQueryClient();

  // O filtro vive na URL, como os do estoque: dá para voltar sem perdê-lo.
  const filter: Filter = params.get('filtro') === 'nao-lidas' ? 'nao-lidas' : 'todas';
  const setFilter = (next: Filter) => setParams(next === 'nao-lidas' ? { filtro: 'nao-lidas' } : {}, { replace: true });

  const list = useInfiniteQuery({
    queryKey: ['notifications', 'list', filter],
    queryFn: ({ pageParam }) =>
      api.get<NotificationList>('/v1/notifications', {
        unread: filter === 'nao-lidas' ? 'true' : undefined,
        limit: PAGE_SIZE,
        before: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    // Cursor: a data da última notificação recebida (`before`, exclusivo).
    getNextPageParam: (last) => (last.hasMore ? last.items[last.items.length - 1]?.createdAt : undefined),
    refetchInterval: 60_000,
  });

  // Qualquer leitura muda a lista e o número no sino (`['notifications','unread']`
  // no AppShell): invalida tudo o que começa com 'notifications'.
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const read = useMutation({
    mutationFn: (id: string) => api.post(`/v1/notifications/${id}/read`),
    onSuccess: invalidate,
    onError: (error) => {
      // 404: a notificação já não existe; a lista se corrige ao recarregar.
      if (!(error instanceof ApiError && error.status === 404)) toast.error(error);
      invalidate();
    },
  });

  const readAll = useMutation({
    mutationFn: () => api.post<{ updated: number }>('/v1/notifications/read-all'),
    onSuccess: (result) => {
      invalidate();
      toast.push(result.updated > 0 ? `${plural(result.updated, 'notificação marcada como lida', 'notificações marcadas como lidas')}.` : 'Não havia nada para marcar.');
    },
    onError: (error) => toast.error(error),
  });

  const open = (notification: AppNotification) => {
    if (!notification.read) read.mutate(notification.id);
    track('notification.opened', { kind: family(notification.type) });

    const destination = destinationOf(notification);
    if (!destination) return;
    if ('href' in destination) {
      window.open(destination.href, '_blank', 'noopener,noreferrer');
      return;
    }
    // Aviso de outra empresa: troca para ela antes de abrir a tela, senão a
    // pessoa veria o plano ou a equipe da empresa errada.
    if (destination.workspaceId && destination.workspaceId !== workspaceId) {
      if (!workspaces.some((item) => item.id === destination.workspaceId)) {
        toast.push('Este aviso é de uma empresa da qual você não participa mais.');
        return;
      }
      select(destination.workspaceId);
    }
    navigate(destination.to);
  };

  // Uma notificação nova empurra as páginas já carregadas: a mesma linha pode
  // vir em duas páginas até a lista recarregar. Fica a primeira ocorrência.
  const byId = new Map<string, AppNotification>();
  for (const page of list.data?.pages ?? []) {
    for (const item of page.items) if (!byId.has(item.id)) byId.set(item.id, item);
  }
  const items = [...byId.values()];
  const unread = list.data?.pages[0]?.unread;
  const workspaceName = (id: string | null) => (id && workspaces.length > 1 ? workspaces.find((item) => item.id === id)?.name : undefined);

  return (
    <div className="page page--narrow">
      <PageHeader
        title="Notificações"
        subtitle={unread !== undefined && unread > 0 ? plural(unread, 'não lida', 'não lidas') : 'Avisos do suporte, do plano e da sua equipe.'}
        actions={
          <button type="button" className="btn btn--secondary" disabled={!unread || readAll.isPending} onClick={() => readAll.mutate()}>
            <Icon name="check" size={17} /> {readAll.isPending ? 'Marcando…' : 'Marcar todas como lidas'}
          </button>
        }
      />

      <Chips
        label="Filtro de notificações"
        value={filter}
        onChange={setFilter}
        items={[
          { key: 'todas', label: 'Todas' },
          { key: 'nao-lidas', label: 'Não lidas', count: unread },
        ]}
      />

      <Card flush>
        {list.isLoading || (list.error && !list.data) ? (
          <QueryState loading={list.isLoading} error={list.error} onRetry={() => void list.refetch()} />
        ) : items.length === 0 ? (
          filter === 'nao-lidas' ? (
            <Empty icon="check" title="Tudo lido" actions={<button type="button" className="btn btn--secondary btn--sm" onClick={() => setFilter('todas')}>Ver todas</button>}>
              Não há notificações esperando por você.
            </Empty>
          ) : (
            <Empty icon="bell" title="Nenhuma notificação por enquanto">
              Quando o suporte responder, um pagamento for confirmado ou alguém aceitar um convite seu, o aviso aparece aqui.
            </Empty>
          )
        ) : (
          <>
            <ul className="inbox">
              {items.map((notification) => {
                const meta = metaOf(notification.type);
                const company = workspaceName(notification.workspaceId);
                return (
                  <li key={notification.id}>
                    <button type="button" className={`inbox__item ${notification.read ? '' : 'inbox__item--unread'}`} onClick={() => open(notification)}>
                      <span className="inbox__icon">
                        <Icon name={meta.icon} />
                      </span>
                      <span className="inbox__main">
                        <span className="inbox__title">
                          {!notification.read && <span className="sr-only">Não lida: </span>}
                          {notification.title}
                        </span>
                        {notification.body !== '' && <span className="inbox__body">{notification.body}</span>}
                        <span className="inbox__meta">
                          <span>{meta.label}</span>
                          {company && <span>{company}</span>}
                          <Time value={notification.createdAt} />
                        </span>
                      </span>
                      <span className="inbox__side">
                        {!notification.read && <span className="unread-dot" aria-hidden="true" />}
                        {destinationOf(notification) && <Icon name="chevronRight" size={16} className="inbox__chevron" />}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            {list.hasNextPage && (
              <div className="inbox__more">
                <button type="button" className="btn btn--ghost btn--sm" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
                  {list.isFetchingNextPage ? 'Carregando…' : 'Carregar mais'}
                </button>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}
