import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { createPortal } from 'react-dom';

import { Icon } from './Icon';

import '../styles/photo-viewer.css';

/**
 * Foto do produto em tela cheia. Fundo escuro, a foto inteira na tela e,
 * para ver detalhes: pinça (dois dedos), toque duplo / clique duplo, roda do
 * mouse ou os botões + e −; ampliada, arrasta. Fecha pelo X, Esc, um toque
 * fora da foto ou o botão Voltar do aparelho (a abertura empilha um item no
 * histórico do navegador, para o Voltar fechar a foto em vez de sair da tela).
 *
 * O zoom é da foto, não da página: a página por trás não amplia (o que, no
 * iPhone, deixaria a tela seguinte ampliada).
 */

const MAX = 5;
const STEP = 1.6;

interface View {
  scale: number;
  x: number;
  y: number;
}

const FIT: View = { scale: 1, x: 0, y: 0 };

export function PhotoViewer({ src, alt, onClose }: { src: string | null; alt: string; onClose: () => void }) {
  const open = src !== null;
  const [view, setView] = useState<View>(FIT);
  const [loaded, setLoaded] = useState(false);
  const stage = useRef<HTMLDivElement | null>(null);
  const closeButton = useRef<HTMLButtonElement | null>(null);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<{ distance: number; scale: number; moved: boolean; lastTap: number } | null>(null);
  const lastTap = useRef(0);

  const clamp = useCallback((next: View): View => {
    const scale = Math.min(MAX, Math.max(1, next.scale));
    if (scale === 1) return FIT;
    const box = stage.current?.getBoundingClientRect();
    // Sem medir a foto: o limite de arraste é a metade do que sobra com o zoom.
    const limitX = box ? (box.width * (scale - 1)) / 2 : Infinity;
    const limitY = box ? (box.height * (scale - 1)) / 2 : Infinity;
    return { scale, x: Math.max(-limitX, Math.min(limitX, next.x)), y: Math.max(-limitY, Math.min(limitY, next.y)) };
  }, []);

  /** Zoom em torno de um ponto da tela (onde estão os dedos ou o mouse). */
  const zoomAt = useCallback(
    (factor: number, clientX?: number, clientY?: number) => {
      setView((current) => {
        const box = stage.current?.getBoundingClientRect();
        const target = Math.min(MAX, Math.max(1, current.scale * factor));
        if (!box || clientX === undefined || clientY === undefined) return clamp({ ...current, scale: target });
        const px = clientX - (box.left + box.width / 2);
        const py = clientY - (box.top + box.height / 2);
        const ratio = target / current.scale;
        return clamp({ scale: target, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio });
      });
    },
    [clamp],
  );

  // Abrir: estado limpo, foco no fechar, Esc, sem rolagem atrás, Voltar fecha.
  useEffect(() => {
    if (!open) return;
    setView(FIT);
    setLoaded(false);
    const previousFocus = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      else if (event.key === '+' || event.key === '=') zoomAt(STEP);
      else if (event.key === '-') zoomAt(1 / STEP);
    };
    document.addEventListener('keydown', onKey);
    let closedByBack = false;
    const onPop = () => {
      closedByBack = true;
      onClose();
    };
    try {
      window.history.pushState({ ...(window.history.state ?? {}), photoViewer: true }, '');
      window.addEventListener('popstate', onPop);
    } catch {
      // sem histórico (navegador restrito): só não fecha pelo Voltar
    }
    return () => {
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('popstate', onPop);
      document.body.style.overflow = previousOverflow;
      // Fechou pelo X/Esc: tira o item extra do histórico (sem disparar uma navegação de verdade).
      if (!closedByBack && window.history.state?.photoViewer) window.history.back();
      previousFocus?.focus?.();
    };
  }, [open, onClose, zoomAt]);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      gesture.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale: view.scale, moved: true, lastTap: 0 };
    } else if (points.length === 1) {
      gesture.current = { distance: 0, scale: view.scale, moved: false, lastTap: lastTap.current };
    }
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const previous = pointers.current.get(event.pointerId);
    if (!previous || !gesture.current) return;
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const points = [...pointers.current.values()];
    if (points.length === 2 && gesture.current.distance > 0) {
      const [a, b] = points as [{ x: number; y: number }, { x: number; y: number }];
      const distance = Math.hypot(a.x - b.x, a.y - b.y);
      const target = gesture.current.scale * (distance / gesture.current.distance);
      zoomAt(target / view.scale, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    const dx = event.clientX - previous.x;
    const dy = event.clientY - previous.y;
    if (Math.abs(dx) + Math.abs(dy) > 2) gesture.current.moved = true;
    if (view.scale > 1) setView((current) => clamp({ ...current, x: current.x + dx, y: current.y + dy }));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const wasTap = gesture.current && !gesture.current.moved && pointers.current.size === 1;
    pointers.current.delete(event.pointerId);
    if (pointers.current.size > 0) return;
    const onPhoto = (event.target as HTMLElement).tagName === 'IMG';
    gesture.current = null;
    if (!wasTap) return;
    const now = Date.now();
    if (now - lastTap.current < 300) {
      // Toque duplo: amplia onde tocou, ou volta ao tamanho da tela.
      lastTap.current = 0;
      if (view.scale > 1.05) setView(FIT);
      else zoomAt(2.5, event.clientX, event.clientY);
      return;
    }
    lastTap.current = now;
    // Toque simples fora da foto (sem zoom) fecha, depois de esperar um possível segundo toque.
    if (!onPhoto && view.scale <= 1.05) {
      window.setTimeout(() => {
        if (lastTap.current === now) onClose();
      }, 300);
    }
  };

  const onWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    // Trackpad (pinça vira ctrl+roda) e roda do mouse ampliam a foto, não a página.
    zoomAt(Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0025)), event.clientX, event.clientY);
  };

  if (!open) return null;

  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;

  return createPortal(
    <div className="photo-viewer" role="dialog" aria-modal="true" aria-label={alt}>
      <div className="photo-viewer__bar">
        <span className="photo-viewer__title">{alt}</span>
        <div className="photo-viewer__tools">
          <button type="button" className="photo-viewer__button" aria-label="Diminuir" disabled={view.scale <= 1} onClick={() => zoomAt(1 / STEP)}>
            <Icon name="minus" size={20} />
          </button>
          <button type="button" className="photo-viewer__button" aria-label="Ampliar" disabled={view.scale >= MAX} onClick={() => zoomAt(STEP)}>
            <Icon name="plus" size={20} />
          </button>
          <button ref={closeButton} type="button" className="photo-viewer__button" aria-label="Fechar a foto" onClick={onClose}>
            <Icon name="x" size={22} />
          </button>
        </div>
      </div>
      <div
        ref={stage}
        className={`photo-viewer__stage ${view.scale > 1 ? 'is-zoomed' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        {!loaded && <span className="photo-viewer__spinner" aria-hidden="true" />}
        <img
          src={src ?? undefined}
          alt={alt}
          draggable={false}
          onLoad={() => setLoaded(true)}
          style={{ transform: `translate3d(${view.x}px, ${view.y}px, 0) scale(${view.scale})`, opacity: loaded ? 1 : 0 }}
        />
      </div>
      <p className="photo-viewer__hint">
        {touch
          ? view.scale > 1 ? 'Arraste para ver outras partes. Toque duas vezes para voltar.' : 'Toque duas vezes ou use dois dedos para ampliar.'
          : view.scale > 1 ? 'Arraste para ver outras partes. Clique duas vezes para voltar.' : 'Clique duas vezes, use a roda do mouse ou os botões + e − para ampliar.'}
      </p>
    </div>,
    document.body,
  );
}
