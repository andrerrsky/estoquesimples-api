import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';

import { Icon } from './Icon';

type State = 'idle' | 'syncing' | 'done' | 'error' | 'offline';

/**
 * Ícone de atualização na barra superior, ao lado do sino.
 *
 * O estoque já se atualiza sozinho (a cada 30 s e ao voltar para a aba); o
 * ícone mostra quando isso está acontecendo e deixa a pessoa forçar agora,
 * sem sair da tela. Estados: em dia (nuvem com check), atualizando (setas
 * girando — tanto no toque quanto na rodada automática), falhou (nuvem
 * cortada: a última consulta deu erro) e sem conexão.
 */
export function SyncButton({ workspaceId }: { workspaceId: string | null }) {
  const queryClient = useQueryClient();
  const [fetching, setFetching] = useState(0);
  const [failed, setFailed] = useState(false);
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  const [done, setDone] = useState(false);

  // Observa só as consultas do estoque desta empresa: quantas estão no ar e
  // se alguma terminou em erro. Assinar o cache uma vez é mais barato do que
  // um hook por consulta, e cobre telas que ainda nem foram abertas.
  useEffect(() => {
    if (!workspaceId) return;
    const cache = queryClient.getQueryCache();
    const update = () => {
      const queries = cache.findAll({ queryKey: ['inventory', workspaceId] });
      setFetching(queries.filter((query) => query.state.fetchStatus === 'fetching').length);
      setFailed(queries.some((query) => query.state.status === 'error'));
    };
    update();
    return cache.subscribe(update);
  }, [queryClient, workspaceId]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);

  // Fecho do toque: um check por um instante, para a pessoa saber que acabou.
  useEffect(() => {
    if (!done) return;
    const timer = setTimeout(() => setDone(false), 1_600);
    return () => clearTimeout(timer);
  }, [done]);

  if (!workspaceId) return null;

  const state: State = !online ? 'offline' : fetching > 0 ? 'syncing' : failed ? 'error' : done ? 'done' : 'idle';
  const label = {
    idle: 'Tudo atualizado. Clique para atualizar agora.',
    syncing: 'Atualizando…',
    done: 'Atualizado.',
    error: 'Não foi possível atualizar. Clique para tentar de novo.',
    offline: 'Sem conexão. Os dados voltam a atualizar quando a internet voltar.',
  }[state];
  const icon = state === 'syncing' ? 'refresh' : state === 'error' || state === 'offline' ? 'cloudOff' : 'cloudDone';

  const refresh = () => {
    if (state === 'syncing') return;
    setDone(false);
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: ['inventory', workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ['entitlement', workspaceId] }),
      queryClient.invalidateQueries({ queryKey: ['notifications'] }),
    ]).then(() => setDone(true));
  };

  return (
    <button type="button" className={`icon-btn sync-btn sync-btn--${state}`} onClick={refresh} aria-label={label} title={label} aria-live="polite">
      <Icon name={icon} size={20} />
    </button>
  );
}
