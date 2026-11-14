/**
 * @author eLeet Coderz (Team 3) - visual language shared by every screen (from dashboard.html)
 * @description Reusable building blocks: icons, buttons-in-cards, colored badges (which always pair color
 *   with an icon or text so color-blind users are never relying on color alone), avatars, progress bars,
 *   modals, empty / loading / error states, and the "couldn't save - Retry / Cancel" banner.
 * @traces SE-FR-15, SE-NFR-04, UC-01, UC-06, UC-17
 */
import { useEffect, useRef, type ReactNode } from 'react';
import { initials } from './format';
import type { ApiError } from '../services/apiClient';

// ---------------------------------------------------------------------------
// Icons (inline SVG, 24px grid, stroke = currentColor)
// ---------------------------------------------------------------------------
const PATHS: Record<string, string> = {
  dashboard: 'M3 13h8V3H3zm10 8h8V11h-8zM3 21h8v-6H3zm10-18v6h8V3z',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  board: 'M4 4h5v16H4zM10.5 4h5v10h-5zM17 4h3v7h-3z',
  chart: 'M4 20V10m6 10V4m6 16v-7m4 7H2',
  dollar: 'M12 2v20m5-16H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  calendar: 'M8 2v4m8-4v4M3 10h18M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
  bell: 'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9m-4.27 13a2 2 0 0 1-3.46 0',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-14v4l3 3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm7.4-3a7.4 7.4 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2-1.2L14.5 3h-4l-.4 2.6a7.6 7.6 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2 1.2l.4 2.6h4l.4-2.6a7.6 7.6 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4m7 14 5-5-5-5m5 5H9',
  plus: 'M12 5v14m-7-7h14',
  x: 'M18 6 6 18M6 6l12 12',
  check: 'M20 6 9 17l-5-5',
  'chevron-left': 'm15 18-6-6 6-6',
  'chevron-right': 'm9 18 6-6-6-6',
  'chevron-down': 'm6 9 6 6 6-6',
  'chevron-up': 'm18 15-6-6-6 6',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zm10 2-4.35-4.35',
  menu: 'M3 12h18M3 6h18M3 18h18',
  grip: 'M9 5h.01M9 12h.01M9 19h.01M15 5h.01M15 12h.01M15 19h.01',
  'eye-off': 'M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19M1 1l22 22',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zm11 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  trash: 'M3 6h18m-2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2',
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4z',
  download: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4m4-5 5 5 5-5m-5 5V3',
  refresh: 'M23 4v6h-6M1 20v-6h6m14.49-5A9 9 0 0 0 5.64 5.64L1 10m22 4-4.64 4.36A9 9 0 0 1 3.51 15',
  lock: 'M5 11h14v10H5zm3 0V7a4 4 0 0 1 8 0v4',
  alert: 'M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-6v-4m0-4h.01',
  sun: 'M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10zm0-16v2m0 18v2M4.22 4.22l1.42 1.42m12.72 12.72 1.42 1.42M1 12h2m18 0h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42',
  moon: 'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z',
  flag: 'M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1zm0 7v-7',
  comment: 'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
  play: 'm6 3 14 9-14 9z',
  pause: 'M6 4h4v16H6zm8 0h4v16h-4z',
  stop: 'M5 5h14v14H5z',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  target: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zm0-4a6 6 0 1 0 0-12 6 6 0 0 0 0 12zm0-4a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6m4-3h6v6m-11 5L21 3',
  palette: 'M12 22a10 10 0 1 1 10-10c0 2.5-2 3-3.5 3H16a2 2 0 0 0-1.5 3.3A2 2 0 0 1 12 22zM7.5 11a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm3-4a1 1 0 1 0 0-2 1 1 0 0 0 0 2zm5 0a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  layout: 'M3 3h18v18H3zM3 9h18M9 21V9',
};

export function Icon({ name, className = 'h-4 w-4', title }: { name: keyof typeof PATHS | string; className?: string; title?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  );
}

export function Logo({ className = 'h-8 w-8' }: { className?: string }) {
  return <img src="/logo.svg" alt="ProjectForge logo" className={className} />;
}

// ---------------------------------------------------------------------------
// Badges & status
// ---------------------------------------------------------------------------
export type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'accent';

const TONE_CLASS: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted border-line',
  brand: 'bg-brand/10 text-brand border-brand/30',
  ok: 'bg-ok/10 text-ok border-ok/30',
  warn: 'bg-warn/10 text-warn border-warn/40',
  danger: 'bg-danger/10 text-danger border-danger/30',
  info: 'bg-info/10 text-info border-info/30',
  accent: 'bg-accent/10 text-accent border-accent/30',
};

export function Badge({ tone = 'neutral', icon, children, className = '' }: { tone?: Tone; icon?: string; children: ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${TONE_CLASS[tone]} ${className}`}>
      {icon ? <Icon name={icon} className="h-3 w-3" /> : null}
      {children}
    </span>
  );
}

const STATUS_META: Record<string, { tone: Tone; icon: string; label: string }> = {
  todo: { tone: 'neutral', icon: 'target', label: 'To do' },
  in_progress: { tone: 'info', icon: 'play', label: 'In progress' },
  review: { tone: 'accent', icon: 'eye', label: 'In review' },
  done: { tone: 'ok', icon: 'check', label: 'Done' },
  planning: { tone: 'neutral', icon: 'edit', label: 'Planning' },
  active: { tone: 'ok', icon: 'play', label: 'Active' },
  on_hold: { tone: 'warn', icon: 'pause', label: 'On hold' },
  completed: { tone: 'brand', icon: 'check', label: 'Completed' },
  archived: { tone: 'neutral', icon: 'folder', label: 'Archived' },
};

export function StatusBadge({ status }: { status: string }) {
  const meta = STATUS_META[status] ?? { tone: 'neutral' as Tone, icon: 'info', label: status };
  return (
    <Badge tone={meta.tone} icon={meta.icon}>
      {meta.label}
    </Badge>
  );
}

const PRIORITY_META: Record<string, { tone: Tone; label: string; bars: number }> = {
  low: { tone: 'neutral', label: 'Low', bars: 1 },
  medium: { tone: 'info', label: 'Medium', bars: 2 },
  high: { tone: 'warn', label: 'High', bars: 3 },
  urgent: { tone: 'danger', label: 'Urgent', bars: 4 },
};

export function PriorityBadge({ priority }: { priority: string }) {
  const meta = PRIORITY_META[priority] ?? PRIORITY_META.medium;
  return (
    <Badge tone={meta.tone}>
      <span className="flex items-end gap-px" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span key={i} className={`w-[3px] rounded-sm ${i <= meta.bars ? 'bg-current' : 'bg-current/20'}`} style={{ height: 3 + i * 2 }} />
        ))}
      </span>
      {meta.label}
    </Badge>
  );
}

export function RoleBadge({ role }: { role: string }) {
  const tone: Tone = role === 'owner' ? 'brand' : role === 'manager' ? 'accent' : 'neutral';
  const icon = role === 'owner' ? 'shield' : role === 'manager' ? 'users' : 'target';
  return (
    <Badge tone={tone} icon={icon}>
      {role.charAt(0).toUpperCase() + role.slice(1)}
    </Badge>
  );
}

export function Avatar({ name, url, size = 'h-8 w-8', className = '' }: { name: string; url?: string | null; size?: string; className?: string }) {
  if (url) {
    return <img src={url} alt="" className={`${size} rounded-full object-cover ring-2 ring-surface ${className}`} referrerPolicy="no-referrer" />;
  }
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360;
  return (
    <span
      className={`${size} inline-flex shrink-0 items-center justify-center rounded-full text-[0.7rem] font-bold text-white ring-2 ring-surface ${className}`}
      style={{ background: `hsl(${hash} 55% 48%)` }}
      aria-label={name}
      title={name}
    >
      {initials(name)}
    </span>
  );
}

export function ProgressBar({ value, color, label, size = 'h-2' }: { value: number; color?: string; label?: string; size?: string }) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="w-full">
      {label ? (
        <div className="mb-1 flex justify-between text-xs text-muted">
          <span className="truncate">{label}</span>
          <span className="font-semibold text-ink">{value.toFixed(2)}%</span>
        </div>
      ) : null}
      <div className={`${size} w-full overflow-hidden rounded-full bg-surface-2`} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
        <div className="h-full rounded-full bg-brand transition-all duration-500" style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout helpers
// ---------------------------------------------------------------------------
export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-muted">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Card({ title, actions, children, className = '', bodyClass = 'p-5' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <header className="flex items-center justify-between gap-2 border-b border-line px-5 py-3">
          <h2 className="text-sm font-semibold">{title}</h2>
          {actions}
        </header>
      ) : null}
      <div className={bodyClass}>{children}</div>
    </section>
  );
}

export function StatCard({ label, value, hint, icon, tone = 'brand' }: { label: string; value: ReactNode; hint?: ReactNode; icon: string; tone?: Tone }) {
  return (
    <div className="card flex items-start gap-4 p-4">
      <span className={`rounded-lg border p-2.5 ${TONE_CLASS[tone]}`}>
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
        <p className="mt-0.5 truncate text-xl font-bold">{value}</p>
        {hint ? <p className="mt-0.5 text-xs text-muted">{hint}</p> : null}
      </div>
    </div>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-3 py-10 text-sm text-muted" role="status">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-brand border-t-transparent" />
      {label}
    </div>
  );
}

export function EmptyState({ icon = 'folder', title, children, action }: { icon?: string; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-12 text-center">
      <span className="mb-3 rounded-full bg-surface-2 p-3 text-muted">
        <Icon name={icon} className="h-6 w-6" />
      </span>
      <p className="font-semibold">{title}</p>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function Alert({ tone = 'danger', title, children, onClose }: { tone?: Tone; title?: string; children?: ReactNode; onClose?: () => void }) {
  const icon = tone === 'ok' ? 'check' : tone === 'info' || tone === 'brand' ? 'info' : 'alert';
  return (
    <div className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${TONE_CLASS[tone]}`} role={tone === 'danger' ? 'alert' : 'status'}>
      <Icon name={icon} className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0 flex-1 text-ink">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div className={title ? 'mt-0.5 text-muted' : ''}>{children}</div> : null}
      </div>
      {onClose ? (
        <button type="button" onClick={onClose} className="text-muted hover:text-ink" aria-label="Dismiss">
          <Icon name="x" />
        </button>
      ) : null}
    </div>
  );
}

/** SE-NFR-04: shown when a save timed out / failed twice. The form keeps everything the user typed. */
export function RetryBanner({ error, onRetry, onCancel, busy }: { error: ApiError | null; onRetry: () => void; onCancel: () => void; busy?: boolean }) {
  if (!error) return null;
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-warn/40 bg-warn/10 px-4 py-3 text-sm sm:flex-row sm:items-center" role="alert">
      <Icon name="alert" className="h-5 w-5 shrink-0 text-warn" />
      <div className="flex-1">
        <p className="font-semibold">Your changes were not saved yet.</p>
        <p className="text-muted">{error.detail} We tried again automatically. Your input is kept - retry now or cancel.</p>
      </div>
      <div className="flex gap-2">
        <button type="button" className="btn-primary" onClick={onRetry} disabled={busy}>
          <Icon name="refresh" /> Retry
        </button>
        <button type="button" className="btn-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </div>
  );
}

export function AccessDenied({ title = 'Access denied', children }: { title?: string; children?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center px-6 py-14 text-center">
      <span className="mb-3 rounded-full border border-danger/30 bg-danger/10 p-3 text-danger">
        <Icon name="lock" className="h-7 w-7" />
      </span>
      <p className="text-lg font-bold">{title}</p>
      <p className="mt-1 max-w-md text-sm text-muted">{children ?? 'Your role in this project does not allow this view.'}</p>
      <p className="mt-3 font-mono text-xs text-danger">HTTP 403 · Access denied</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Forms
// ---------------------------------------------------------------------------
export function Field({ label, error, hint, children, htmlFor }: { label: string; error?: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="mt-1 flex items-center gap-1 text-xs font-medium text-danger">
          <Icon name="alert" className="h-3 w-3" /> {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 pt-[8vh] backdrop-blur-sm" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={title} className={`card w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} shadow-pop`}>
        <header className="flex items-center justify-between border-b border-line px-5 py-3">
          <h2 className="font-semibold">{title}</h2>
          <button type="button" className="btn-ghost px-2" onClick={onClose} aria-label="Close">
            <Icon name="x" />
          </button>
        </header>
        <div className="max-h-[70vh] overflow-y-auto p-5">{children}</div>
        {footer ? <footer className="flex justify-end gap-2 border-t border-line px-5 py-3">{footer}</footer> : null}
      </div>
    </div>
  );
}

export function Segmented<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  return (
    <div className="inline-flex rounded-lg border border-line bg-surface-2 p-0.5" role="tablist" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="tab"
          aria-selected={value === o.value}
          onClick={() => onChange(o.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-semibold transition ${value === o.value ? 'bg-surface text-ink shadow-card' : 'text-muted hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
