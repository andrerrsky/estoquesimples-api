import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';

import { errorMessage } from '../api/client';
import { fmtDateTime, fmtInteger, fmtRelative } from '../lib/format';
import type { Tone } from '../lib/labels';
import { Icon, type IconName } from './Icon';

// ---------------------------------------------------------------------------
// Avisos (toasts) — com ação opcional, para o "Desfazer" que o app oferece
// ---------------------------------------------------------------------------

interface ToastOptions {
  tone?: 'default' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
  /** Milissegundos na tela. Avisos com ação ficam 15 s, como no app. */
  duration?: number;
}

interface Toast extends ToastOptions {
  id: number;
  message: string;
}

const ToastContext = createContext<{ push: (message: string, options?: ToastOptions) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((current) => current.filter((toast) => toast.id !== id)), []);

  const push = useCallback(
    (message: string, options: ToastOptions = {}) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((current) => [...current.slice(-2), { id, message, ...options }]);
      window.setTimeout(() => dismiss(id), options.duration ?? (options.action ? 15_000 : options.tone === 'error' ? 7_000 : 4_500));
    },
    [dismiss],
  );

  const value = useMemo(() => ({ push }), [push]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      {createPortal(
        <div className="toasts" role="status" aria-live="polite">
          {toasts.map((toast) => (
            <div key={toast.id} className={`toast ${toast.tone && toast.tone !== 'default' ? `toast--${toast.tone}` : ''}`}>
              <span className="toast__message">{toast.message}</span>
              {toast.action && (
                <button
                  type="button"
                  className="toast__action"
                  onClick={() => {
                    toast.action?.onClick();
                    dismiss(toast.id);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
              <button type="button" className="toast__close" aria-label="Fechar aviso" onClick={() => dismiss(toast.id)}>
                <Icon name="x" size={16} />
              </button>
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast fora do ToastProvider');
  return {
    push: context.push,
    success: (message: string, options?: ToastOptions) => context.push(message, { ...options, tone: 'success' }),
    error: (error: unknown) => context.push(errorMessage(error), { tone: 'error' }),
  };
}

// ---------------------------------------------------------------------------
// Estrutura de página
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  actions,
  crumbs,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  crumbs?: Array<{ label: string; to?: string }>;
}) {
  return (
    <header>
      {crumbs && (
        <nav className="crumbs" aria-label="Você está em">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 6 }}>
              {index > 0 && <Icon name="chevronRight" size={14} />}
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page-header">
        <div style={{ minWidth: 0 }}>
          <h1 className="page-header__title">{title}</h1>
          {subtitle && <p className="page-header__sub">{subtitle}</p>}
        </div>
        {actions && <div className="page-header__actions no-print">{actions}</div>}
      </div>
    </header>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  flush,
  className,
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`card ${flush ? 'card--flush' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <div className="card__header">
          <div style={{ minWidth: 0 }}>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <div className="card__sub">{subtitle}</div>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function Tile({ label, value, foot, alert, to }: { label: string; value: ReactNode; foot?: ReactNode; alert?: boolean; to?: string }) {
  const content = (
    <>
      <div className="tile__label">{label}</div>
      <div className="tile__value">{value}</div>
      {foot && <div className="tile__foot">{foot}</div>}
    </>
  );
  const className = `tile ${alert ? 'tile--alert' : ''} ${to ? 'tile--link' : ''}`;
  return to ? (
    <Link to={to} className={className}>
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}

export function Badge({ tone = 'neutral', children }: { tone?: Tone | 'solid'; children: ReactNode }) {
  return <span className={`badge ${tone === 'neutral' ? '' : `badge--${tone}`}`}>{children}</span>;
}

export function Notice({
  tone = 'info',
  title,
  children,
  action,
}: {
  tone?: 'info' | 'warning' | 'error' | 'success';
  title?: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return (
    <div className={`notice notice--${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
      <Icon name={icon} />
      <div style={{ minWidth: 0 }}>
        {title && <div className="notice__title">{title}</div>}
        {children && <div>{children}</div>}
      </div>
      {action && <div className="notice__actions">{action}</div>}
    </div>
  );
}

export function Empty({ icon = 'box', title, children, actions }: { icon?: IconName; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={24} />
      </div>
      <div className="empty__title">{title}</div>
      {children && <div className="empty__text">{children}</div>}
      {actions && <div className="empty__actions">{actions}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3, height = 16 }: { lines?: number; height?: number }) {
  return (
    <div className="stack stack--tight" aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton" style={{ height, width: `${92 - ((index * 17) % 40)}%` }} />
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="row muted" role="status">
      <span className="spinner" />
      {label && <span>{label}</span>}
    </span>
  );
}

/** Estado de carregamento/erro padrão de uma consulta. */
export function QueryState({ loading, error, onRetry }: { loading: boolean; error: unknown; onRetry?: () => void }) {
  if (loading) {
    return (
      <div style={{ padding: 18 }}>
        <Skeleton lines={5} />
      </div>
    );
  }
  if (error) {
    return (
      <Empty icon="alert" title="Não foi possível carregar" actions={onRetry && <button type="button" className="btn btn--secondary btn--sm" onClick={onRetry}>Tentar de novo</button>}>
        {errorMessage(error)}
      </Empty>
    );
  }
  return null;
}

export function KeyValue({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Time({ value, relative = true }: { value: string | null | undefined; relative?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return <time dateTime={value} title={fmtDateTime(value)}>{relative ? fmtRelative(value) : fmtDateTime(value)}</time>;
}

export function Meter({ value, max }: { value: number; max: number }) {
  const ratio = max <= 0 ? 1 : Math.min(1, value / max);
  const tone = ratio >= 1 ? 'meter__fill--error' : ratio >= 0.8 ? 'meter__fill--warning' : '';
  return (
    <div className="meter" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={max}>
      <div className={`meter__fill ${tone}`} style={{ width: `${Math.round(ratio * 100)}%` }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------

export function Field({
  label,
  optional,
  hint,
  error,
  full,
  children,
}: {
  label: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | undefined;
  full?: boolean;
  children: ReactNode;
}) {
  return (
    <label className={`field ${full ? 'field--full' : ''}`}>
      <span className="field__label">
        {label} {optional && <span className="field__optional">(opcional)</span>}
      </span>
      {children}
      {error ? <span className="field__error">{error}</span> : hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  );
}

export function SearchInput({
  value,
  onChange,
  placeholder,
  autoFocus,
  action,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  autoFocus?: boolean;
  action?: ReactNode;
}) {
  return (
    <div className="input-group toolbar__search">
      <Icon name="search" className="input-group__icon" />
      <input
        className="input"
        type="search"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        autoFocus={autoFocus}
        style={action ? { paddingRight: 44 } : undefined}
      />
      {action && <span className="input-group__action">{action}</span>}
    </div>
  );
}

export function Chips<T extends string>({
  value,
  onChange,
  items,
  label,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ key: T; label: string; count?: number | undefined }>;
  label: string;
}) {
  return (
    <div className="chips" role="radiogroup" aria-label={label}>
      {items.map((item) => (
        <button key={item.key} type="button" role="radio" aria-checked={item.key === value} className={`chip ${item.key === value ? 'active' : ''}`} onClick={() => onChange(item.key)}>
          {item.label}
          {item.count !== undefined && <span className="chip__count">{fmtInteger(item.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (value: T) => void; items: Array<{ key: T; label: string }> }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button key={item.key} type="button" role="tab" aria-selected={item.key === value} className={`tab ${item.key === value ? 'active' : ''}`} onClick={() => onChange(item.key)}>
          {item.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span>
        {fmtInteger(from)}–{fmtInteger(to)} de {fmtInteger(total)}
      </span>
      <div className="row" style={{ gap: 6 }}>
        <button type="button" className="btn btn--ghost btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          <Icon name="chevronLeft" size={16} /> Anterior
        </button>
        <button type="button" className="btn btn--ghost btn--sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
          Próxima <Icon name="chevronRight" size={16} />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sobreposições
// ---------------------------------------------------------------------------

function useOverlay(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);
}

export function Modal({
  open,
  onClose,
  title,
  description,
  wide,
  children,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  wide?: boolean;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  const titleId = useId();
  useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="modal__header">
          <div>
            <h2 className="modal__title" id={titleId}>{title}</h2>
            {description && <div className="modal__description">{description}</div>}
          </div>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {actions && <div className="modal__actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

/** Painel lateral (desktop) ou tela cheia (celular): detalhe e formulários longos. */
export function Drawer({
  open,
  onClose,
  title,
  subtitle,
  children,
  footer,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}) {
  const titleId = useId();
  useOverlay(open, onClose);
  if (!open) return null;
  return createPortal(
    <div className="overlay overlay--drawer" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="drawer__header">
          <div style={{ minWidth: 0 }}>
            <h2 className="drawer__title" id={titleId}>{title}</h2>
            {subtitle && <div className="drawer__sub">{subtitle}</div>}
          </div>
          <button type="button" className="icon-btn" aria-label="Fechar" onClick={onClose}>
            <Icon name="x" />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
        {footer && <div className="drawer__footer">{footer}</div>}
      </aside>
    </div>,
    document.body,
  );
}

/**
 * Confirmação de uma ação. `onConfirm` pode ser assíncrono: o botão fica
 * ocupado e, se der erro, a mensagem aparece no próprio diálogo.
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Confirmar',
  danger,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
  children?: ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setBusy(false);
      setError(null);
    }
  }, [open]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      onClose();
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open={open} onClose={onClose} title={title} description={description}>
      <form onSubmit={submit} className="stack">
        {children}
        {error && <Notice tone="error">{error}</Notice>}
        <div className="row row--end" style={{ flexWrap: 'wrap' }}>
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className={`btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`} disabled={busy} autoFocus>
            {busy ? 'Aguarde…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export interface MenuItem {
  label: string;
  icon?: IconName;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** Menu suspenso ancorado ao botão, renderizado em portal para não ser cortado. */
export function Menu({
  trigger,
  items,
  label,
  header,
}: {
  trigger: (props: { onClick: () => void; 'aria-expanded': boolean; 'aria-haspopup': 'menu'; ref: React.RefObject<HTMLButtonElement | null> }) => ReactNode;
  items: Array<MenuItem | 'sep'>;
  label: string;
  header?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const menu = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!open || !anchor.current || !menu.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const size = menu.current.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - size.width, window.innerWidth - size.width - 8));
    const below = rect.bottom + 6;
    const top = below + size.height > window.innerHeight - 8 ? Math.max(8, rect.top - size.height - 6) : below;
    setPosition({ top, left });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (menu.current?.contains(event.target as Node) || anchor.current?.contains(event.target as Node)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => event.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    window.addEventListener('scroll', close, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
      window.removeEventListener('scroll', close, true);
    };
  }, [open]);

  return (
    <>
      {trigger({ onClick: () => setOpen((value) => !value), 'aria-expanded': open, 'aria-haspopup': 'menu', ref: anchor })}
      {open &&
        createPortal(
          <div ref={menu} className="menu" role="menu" aria-label={label} style={position ? { top: position.top, left: position.left } : { visibility: 'hidden', top: 0, left: 0 }}>
            {header}
            {items.map((item, index) =>
              item === 'sep' ? (
                <div key={`sep-${index}`} className="menu__sep" />
              ) : (
                <button
                  key={item.label}
                  type="button"
                  role="menuitem"
                  className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
                  disabled={item.disabled}
                  onClick={() => {
                    setOpen(false);
                    item.onClick();
                  }}
                >
                  {item.icon && <Icon name={item.icon} size={16} />}
                  {item.label}
                </button>
              ),
            )}
          </div>,
          document.body,
        )}
    </>
  );
}
