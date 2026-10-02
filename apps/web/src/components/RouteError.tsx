import { useRouteError } from 'react-router-dom';

import { isChunkLoadError } from '../lib/chunks';
import { Empty } from './ui';

/**
 * O que aparece quando uma tela quebra ao carregar ou ao desenhar. Nunca o
 * erro cru: uma explicação e o caminho de volta. O caso mais comum é a aba
 * ter ficado aberta durante uma atualização (ver `lib/chunks.ts`).
 */
export function RouteError({ fullScreen }: { fullScreen?: boolean }) {
  const error = useRouteError();
  const outdated = isChunkLoadError(error);

  const content = (
    <Empty
      icon={outdated ? 'refresh' : 'alert'}
      title={outdated ? 'O Estoque Simples foi atualizado' : 'Não foi possível abrir esta tela'}
      actions={
        <>
          <button type="button" className="btn btn--primary" onClick={() => window.location.reload()}>
            Recarregar a página
          </button>
          {!outdated && <a className="btn btn--secondary" href="/app/estoque">Ir para o estoque</a>}
        </>
      }
    >
      {outdated
        ? 'Esta aba ficou aberta enquanto uma versão nova era publicada. Recarregue para continuar; nada do que você salvou se perdeu.'
        : 'Algo deu errado ao montar esta tela. Recarregue a página; se continuar, fale com o suporte.'}
    </Empty>
  );

  return fullScreen ? <div style={{ display: 'grid', placeItems: 'center', minHeight: '100dvh', padding: 24 }}>{content}</div> : <div className="page page--narrow">{content}</div>;
}
