import { useId, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

/**
 * Balão explicativo que abre ao passar o mouse ou focar pelo teclado (Esc
 * fecha). Fica num portal porque as tabelas cortam o que transborda.
 */
export function Tip({ content, children, width = 300 }: { content: ReactNode; children: ReactNode; width?: number }) {
  const id = useId();
  const trigger = useRef<HTMLSpanElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom > 180;
    setPosition(below ? { left, top: rect.bottom + 6, width } : { left, bottom: window.innerHeight - rect.top + 6, width });
  };
  const hide = () => setPosition(null);

  return (
    <>
      <span
        ref={trigger}
        className="tip-trigger"
        tabIndex={0}
        aria-describedby={position ? id : undefined}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
        onKeyDown={(event) => {
          if (event.key === 'Escape') hide();
        }}
      >
        {children}
      </span>
      {position &&
        createPortal(
          <div role="tooltip" id={id} className="event-tip" style={position}>
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
