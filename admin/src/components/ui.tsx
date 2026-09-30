import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';

import { ApiError } from '../api/client';
import { fmtNumber, fmtRelative, fmtDateTime } from '../lib/format';
import type { Tone } from '../lib/labels';
import { Icon, type IconName } from './Icon';

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

interface Toast {
  id: number;
  message: string;
  tone: 'default' | 'success' | 'error';
}

const ToastContext = createContext<{ push: (message: string, tone?: Toast['tone']) => void } | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const push = useCallback((message: string, tone: Toast['tone'] = 'default') => {
    const id = (counter.current += 1);
    setToasts((current) => [...current, { id, message, tone }]);
    window.setTimeout(() => setToasts((current) => current.filter((toast) => toast.id !== id)), 4500);
  }, []);

  const value = useMemo(() => ({ push }), [push]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast ${toast.tone === 'default' ? '' : `toast--${toast.tone}`}`}>
            <Icon name={toast.tone === 'error' ? 'alert' : toast.tone === 'success' ? 'check' : 'info'} size={16} />
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast fora do ToastProvider');
  return context;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.details.length > 0) return error.details.map((detail) => detail.message).join(' ');
    return error.message;
  }
  if (error instanceof Error) return error.message;
  return 'Algo deu errado.';
}

// ---------------------------------------------------------------------------
// Page scaffolding
// ---------------------------------------------------------------------------

export function PageHeader({
  title,
  subtitle,
  crumbs,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  crumbs?: Array<{ label: string; to?: string }>;
  actions?: ReactNode;
}) {
  return (
    <div>
      {crumbs && crumbs.length > 0 && (
        <nav className="crumbs" aria-label="Navegação">
          {crumbs.map((crumb, index) => (
            <span key={`${crumb.label}-${index}`} className="row" style={{ gap: 6 }}>
              {index > 0 && <Icon name="chevronRight" size={14} />}
              {crumb.to ? <Link to={crumb.to}>{crumb.label}</Link> : <span>{crumb.label}</span>}
            </span>
          ))}
        </nav>
      )}
      <div className="page-header">
        <div>
          <h1 className="page-header__title">{title}</h1>
          {subtitle && <div className="page-header__sub">{subtitle}</div>}
        </div>
        {actions && <div className="page-header__actions">{actions}</div>}
      </div>
    </div>
  );
}

export function Card({
  title,
  subtitle,
  actions,
  flush,
  children,
  className,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  flush?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`card ${flush ? 'card--flush' : ''} ${className ?? ''}`}>
      {(title || actions) && (
        <header className="card__header">
          <div>
            {title && <h2 className="card__title">{title}</h2>}
            {subtitle && <div className="card__sub">{subtitle}</div>}
          </div>
          {actions && <div className="card__actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Badge({ tone = 'neutral', children, plain }: { tone?: Tone; children: ReactNode; plain?: boolean }) {
  const cls = tone === 'neutral' ? '' : `badge--${tone}`;
  return <span className={`badge ${cls} ${plain ? 'badge--plain' : ''}`}>{children}</span>;
}

export function StatTile({
  label,
  value,
  foot,
  delta,
  tone,
  spark,
  hint,
}: {
  label: string;
  value: ReactNode;
  foot?: ReactNode;
  delta?: number | null;
  tone?: 'accent' | 'alert';
  spark?: ReactNode;
  hint?: string;
}) {
  return (
    <div className={`tile ${tone ? `tile--${tone}` : ''}`} title={hint}>
      <div className="tile__label">
        <span>{label}</span>
        {delta !== undefined && <Delta value={delta} />}
      </div>
      <div className="tile__value">{value}</div>
      {spark && <div className="tile__spark">{spark}</div>}
      {foot && <div className="tile__foot">{foot}</div>}
    </div>
  );
}

export function Delta({ value }: { value: number | null }) {
  if (value === null) return <span className="delta delta--flat">novo</span>;
  const rounded = Math.round(value * 100);
  if (rounded === 0) return <span className="delta delta--flat">0%</span>;
  const up = rounded > 0;
  return (
    <span className={`delta ${up ? 'delta--up' : 'delta--down'}`}>
      <Icon name={up ? 'arrowUp' : 'arrowDown'} size={12} />
      {Math.abs(rounded)}%
    </span>
  );
}

export function Notice({ tone, title, children }: { tone: 'warning' | 'error' | 'info' | 'success'; title?: string; children: ReactNode }) {
  const icon: IconName = tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return (
    <div className={`notice notice--${tone}`}>
      <Icon name={icon} />
      <div>
        {title && <div className="notice__title">{title}</div>}
        <div>{children}</div>
      </div>
    </div>
  );
}

export function Empty({ icon = 'package', title, children }: { icon?: IconName; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} />
      </div>
      <div className="strong">{title}</div>
      {children && <div className="small">{children}</div>}
    </div>
  );
}

export function Skeleton({ lines = 3, height = 14 }: { lines?: number; height?: number }) {
  return (
    <div className="stack stack--tight" aria-busy="true">
      {Array.from({ length: lines }, (_, index) => (
        <div key={index} className="skeleton" style={{ height, width: `${100 - (index % 3) * 12}%` }} />
      ))}
    </div>
  );
}

export function KeyValue({ items }: { items: Array<{ label: string; value: ReactNode }> }) {
  return (
    <dl className="kv">
      {items.map((item) => (
        <div key={item.label} style={{ display: 'contents' }}>
          <dt>{item.label}</dt>
          <dd>{item.value ?? '—'}</dd>
        </div>
      ))}
    </dl>
  );
}

export function Time({ value, relative = true }: { value: string | null | undefined; relative?: boolean }) {
  if (!value) return <span className="muted">—</span>;
  return (
    <time dateTime={value} title={fmtDateTime(value)}>
      {relative ? fmtRelative(value) : fmtDateTime(value)}
    </time>
  );
}

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ key: T; label: string; count?: number }>;
}) {
  return (
    <div className="tabs" role="tablist">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="tab"
          aria-selected={item.key === value}
          className={`tab ${item.key === value ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
          {item.count !== undefined && <span className="tab__count">{fmtNumber(item.count)}</span>}
        </button>
      ))}
    </div>
  );
}

export function Chips<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (value: T) => void;
  items: Array<{ key: T; label: string }>;
}) {
  return (
    <div className="chips" role="radiogroup">
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          role="radio"
          aria-checked={item.key === value}
          className={`chip ${item.key === value ? 'active' : ''}`}
          onClick={() => onChange(item.key)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Modal e confirmação
// ---------------------------------------------------------------------------

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  wide?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal--wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div>
          <h2 className="modal__title">{title}</h2>
          {description && <div className="modal__desc">{description}</div>}
        </div>
        {children}
      </div>
    </div>
  );
}

/**
 * Confirmação de ação sensível.
 *
 * Toda ação que altera dado de cliente pede um motivo (vai para a auditoria)
 * e, quando `confirmWord` é informado, exige digitar a palavra — o padrão para
 * o que não se desfaz com um clique (excluir empresa, transferir propriedade).
 */
export function ConfirmDialog({
  open,
  onClose,
  title,
  description,
  confirmLabel = 'Confirmar',
  danger,
  requireReason = true,
  confirmWord,
  onConfirm,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
  requireReason?: boolean;
  confirmWord?: string;
  onConfirm: (reason: string) => Promise<void>;
  children?: ReactNode;
}) {
  const [reason, setReason] = useState('');
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setReason('');
      setTyped('');
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const ready = (!requireReason || reason.trim().length >= 3) && (!confirmWord || typed === confirmWord);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(reason.trim());
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
        {requireReason && (
          <label className="field">
            <span className="field__label">Motivo</span>
            <textarea
              className="textarea"
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="Ex.: cliente relatou pelo WhatsApp em 30/09 que perdeu o aparelho"
              maxLength={500}
              autoFocus
            />
            <span className="field__hint">Fica registrado na auditoria junto com a ação.</span>
          </label>
        )}
        {confirmWord && (
          <label className="field">
            <span className="field__label">
              Digite <code>{confirmWord}</code> para confirmar
            </span>
            <input className="input" value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" />
          </label>
        )}
        {error && <div className="field__error">{error}</div>}
        <div className="modal__actions">
          <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>
            Cancelar
          </button>
          <button type="submit" className={`btn ${danger ? 'btn--danger-solid' : 'btn--primary'}`} disabled={!ready || busy}>
            {busy ? 'Aguarde…' : confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Menu de ações
// ---------------------------------------------------------------------------

export function ActionMenu({ label = 'Ações', items }: { label?: string; items: Array<{ label: string; icon?: IconName; danger?: boolean; onClick: () => void; disabled?: boolean } | 'sep'> }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  return (
    <div className="menu" ref={ref}>
      <button type="button" className="btn btn--secondary" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open}>
        {label}
        <Icon name="chevronDown" size={16} />
      </button>
      {open && (
        <div className="menu__list" role="menu">
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
                {item.icon && <Icon name={item.icon} />}
                {item.label}
              </button>
            ),
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tabela e paginação
// ---------------------------------------------------------------------------

export interface Column<T> {
  key: string;
  header: ReactNode;
  render: (row: T) => ReactNode;
  numeric?: boolean;
  sortKey?: string;
  width?: string | number;
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  onRowClick,
  loading,
  empty,
  sort,
  onSort,
  compact,
}: {
  rows: T[];
  columns: Array<Column<T>>;
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  loading?: boolean;
  empty?: ReactNode;
  sort?: { key: string; order: 'asc' | 'desc' };
  onSort?: (key: string) => void;
  compact?: boolean;
}) {
  return (
    <div className="table-wrap">
      <table className={`table ${compact ? 'table--compact' : ''}`}>
        <thead>
          <tr>
            {columns.map((column) => {
              const sortable = Boolean(column.sortKey && onSort);
              const active = sort && column.sortKey === sort.key;
              return (
                <th
                  key={column.key}
                  className={`${column.numeric ? 'num' : ''} ${sortable ? 'sortable' : ''}`}
                  style={column.width ? { width: column.width } : undefined}
                  onClick={sortable ? () => onSort?.(column.sortKey as string) : undefined}
                  aria-sort={active ? (sort.order === 'asc' ? 'ascending' : 'descending') : undefined}
                >
                  {column.header}
                  {active && <Icon name={sort.order === 'asc' ? 'arrowUp' : 'arrowDown'} size={12} style={{ marginLeft: 4, verticalAlign: -1 }} />}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading && rows.length === 0 ? (
            Array.from({ length: 5 }, (_, index) => (
              <tr key={`sk-${index}`}>
                {columns.map((column) => (
                  <td key={column.key}>
                    <div className="skeleton" style={{ width: `${55 + ((index * 17) % 40)}%` }} />
                  </td>
                ))}
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length}>{empty ?? <Empty title="Nada por aqui" />}</td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={rowKey(row)} className={onRowClick ? 'clickable' : ''} onClick={onRowClick ? () => onRowClick(row) : undefined}>
                {columns.map((column) => (
                  <td key={column.key} className={column.numeric ? 'num' : ''}>
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export function Pagination({
  page,
  pageSize,
  total,
  onPage,
  onPageSize,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const from = total === 0 ? 0 : (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div className="pagination">
      <span>
        {total === 0 ? 'Nenhum registro' : `${fmtNumber(from)}–${fmtNumber(to)} de ${fmtNumber(total)}`}
      </span>
      <div className="pagination__controls">
        {onPageSize && (
          <select className="select select--sm" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))} aria-label="Itens por página">
            {[25, 50, 100].map((size) => (
              <option key={size} value={size}>
                {size} por página
              </option>
            ))}
          </select>
        )}
        <button type="button" className="btn btn--ghost btn--sm btn--icon" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label="Página anterior">
          <Icon name="chevronLeft" />
        </button>
        <span>
          {page} / {pages}
        </span>
        <button type="button" className="btn btn--ghost btn--sm btn--icon" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label="Próxima página">
          <Icon name="chevronRight" />
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dados brutos
// ---------------------------------------------------------------------------

export function Props({ value }: { value: Record<string, unknown> }) {
  const entries = Object.entries(value ?? {});
  if (entries.length === 0) return null;
  return (
    <div className="props">
      {entries.map(([key, item]) => (
        <span key={key} className="props__item">
          <span className="props__key">{key}:</span>
          <span>{typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item)}</span>
        </span>
      ))}
    </div>
  );
}

export function Json({ value }: { value: unknown }) {
  return <pre className="json">{JSON.stringify(value, null, 2)}</pre>;
}

export function Details({ summary, children }: { summary: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" className="btn btn--link small" onClick={() => setOpen((value) => !value)}>
        {summary} <Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} />
      </button>
      {open && <div style={{ marginTop: 6 }}>{children}</div>}
    </div>
  );
}

export function CopyId({ id }: { id: string }) {
  const toast = useToast();
  return (
    <button
      type="button"
      className="btn btn--link mono small"
      title="Copiar identificador"
      onClick={() => {
        void navigator.clipboard?.writeText(id).then(() => toast.push('Identificador copiado.'));
      }}
    >
      {id}
    </button>
  );
}
