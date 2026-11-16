import { renderToString } from 'react-dom/server';

import { LandingPage, PLAY_RATING, VIDEO } from './pages/LandingPage';
import { VideoPage, type TranscriptBlock } from './pages/VideoPage';

export { PLAY_RATING, VIDEO };

/**
 * Renderiza a página inicial em HTML no build (ver scripts/prerender.mjs).
 * Só a página, sem provedores: é o mesmo que `landing-main.tsx` renderiza
 * ao hidratar, por isso os dois precisam continuar iguais.
 */
export function render(): string {
  return renderToString(<LandingPage />);
}

/**
 * Renderiza a página de exibição do vídeo (`/video`). Esta não hidrata:
 * o HTML sai pronto do build e nenhum JavaScript a acompanha, então ela
 * não precisa casar com nenhuma entrada do cliente.
 */
export function renderVideo(transcript: TranscriptBlock[]): string {
  return renderToString(<VideoPage transcript={transcript} />);
}
