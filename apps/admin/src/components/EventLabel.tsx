import { useQuery } from '@tanstack/react-query';
import { useId, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';

import { api } from '../api/client';
import { eventDomain } from '../lib/labels';

interface CatalogEvent {
  name: string;
  source: 'app' | 'server' | 'both';
  description: string;
  properties?: Record<string, string>;
}

const SOURCE_LABEL: Record<CatalogEvent['source'], string> = {
  app: 'o app Android ou a web, no aparelho da pessoa',
  server: 'a API, no servidor (não depende do aparelho)',
  both: 'o app/web e também a API',
};

/** Catálogo de eventos (o mesmo da API), buscado uma vez por sessão do painel. */
export function useEventCatalog() {
  return useQuery({
    queryKey: ['analytics', 'catalog'],
    queryFn: () => api.get<{ events: CatalogEvent[] }>('/analytics/catalog'),
    staleTime: Infinity,
    select: (data) => new Map(data.events.map((item) => [item.name, item])),
  });
}

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'sim' : 'não';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/**
 * Nome técnico do evento (`screen.viewed`) com um balão que explica o que ele
 * significa, quem o registra e o que cada propriedade quer dizer, com os
 * valores deste registro. Abre ao passar o mouse ou ao focar pelo teclado;
 * fecha com Esc. Fica num portal porque as tabelas cortam o que transborda.
 */
export function EventLabel({ name, properties }: { name: string; properties?: Record<string, unknown> }) {
  const catalog = useEventCatalog();
  const info = catalog.data?.get(name);
  const id = useId();
  const trigger = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<CSSProperties | null>(null);

  const show = () => {
    const rect = trigger.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 340;
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8));
    const below = window.innerHeight - rect.bottom > 220;
    setPosition(below ? { left, top: rect.bottom + 6, width } : { left, bottom: window.innerHeight - rect.top + 6, width });
  };
  const hide = () => setPosition(null);

  const documented = info?.properties ?? {};
  const keys = Array.from(new Set([...Object.keys(documented), ...Object.keys(properties ?? {})]));

  return (
    <>
      <code
        ref={trigger}
        className="event-label"
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
        {name}
      </code>
      {position &&
        createPortal(
          <div role="tooltip" id={id} className="event-tip" style={position}>
            <div className="event-tip__title">{info?.description ?? 'Evento fora do catálogo.'}</div>
            {!info && <p className="event-tip__text">Ainda não documentado em analytics.events.ts. Foi aceito porque o nome segue o formato domínio.ação.</p>}
            <dl className="event-tip__grid">
              <dt>Área</dt>
              <dd>{eventDomain(name)}</dd>
              {info && (
                <>
                  <dt>Quem registra</dt>
                  <dd>{SOURCE_LABEL[info.source]}</dd>
                </>
              )}
            </dl>
            {keys.length > 0 && (
              <>
                <div className="event-tip__subtitle">Propriedades</div>
                <dl className="event-tip__grid">
                  {keys.map((key) => (
                    <div key={key} className="event-tip__row">
                      <dt>
                        <code>{key}</code>
                      </dt>
                      <dd>
                        {documented[key] && <span className="event-tip__muted">{documented[key]}</span>}
                        {properties && key in properties && (
                          <span>
                            {documented[key] ? ' · ' : ''}aqui: <strong>{formatValue(properties[key])}</strong>
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </>
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
