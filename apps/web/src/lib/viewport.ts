/**
 * Zoom do iPhone e do iPad. O Safari amplia a página quando um campo com
 * letra menor que 16px recebe o foco, e não desfaz sozinho: a tela seguinte
 * abre ampliada, com cartões colados na borda ou cortados. A causa é
 * resolvida no CSS (campos com 16px em telas de toque, `app.css`); isto aqui
 * é a rede de segurança para quando a pessoa já está com zoom (pinça, ou um
 * campo que escapou da regra): ao trocar de tela, a página volta ao tamanho
 * normal. O zoom por pinça continua permitido (acessibilidade): o limite é
 * aplicado só por um instante e retirado em seguida.
 */

function isTouchSafari(): boolean {
  const ua = navigator.userAgent;
  // iPadOS se apresenta como Mac: o que denuncia é a tela de toque.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function resetZoom(): void {
  if (typeof window === 'undefined' || !isTouchSafari()) return;
  const scale = window.visualViewport?.scale ?? 1;
  if (scale <= 1.01) return;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return;
  const original = meta.getAttribute('content') ?? 'width=device-width, initial-scale=1';
  if (original.includes('maximum-scale')) return;
  meta.setAttribute('content', `${original}, maximum-scale=1`);
  window.setTimeout(() => meta.setAttribute('content', original), 350);
}
