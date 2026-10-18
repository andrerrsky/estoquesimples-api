import { renderToString } from 'react-dom/server';

import { LandingPage, PLAY_RATING, VIDEO } from './pages/LandingPage';

export { PLAY_RATING, VIDEO };

/**
 * Renderiza a página inicial em HTML no build (ver scripts/prerender.mjs).
 * Só a página, sem provedores: é o mesmo que `landing-main.tsx` renderiza
 * ao hidratar, por isso os dois precisam continuar iguais.
 */
export function render(): string {
  return renderToString(<LandingPage />);
}
