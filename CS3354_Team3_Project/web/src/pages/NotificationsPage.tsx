/**
 * @author Aashwat Singh - matches notifications.html
 * @description Every notification for the signed-in user - @mentions, assignments, role changes, member
 *   changes and automatic deadline / soft-deadline reminders - newest first, with All / Unread tabs,
 *   mark-as-read on open, and "Mark all as read". New notifications appear live.
 * @traces SE-FR-29, SE-NFR-12, UC-22
 */
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { notificationController } from '../features/collaboration/commentController';
import { useRealtime } from '../services/realtimeClient';
import type { Notification } from '../shared/types';
import { formatDateTime, relativeTime } from '../shared/format';
import { Alert, EmptyState, Icon, PageHeader, Segmented, Spinner, type Tone } from '../shared/ui';
import { toApiError } from '../shared/useSave';

const KIND: Record<string, { icon: string; tone: Tone; label: string }> = {
  mention: { icon: 'comment', tone: 'brand', label: 'Mention' },
  assignment: { icon: 'check', tone: 'info', label: 'Assignment' },
  role_change: { icon: 'shield', tone: 'accent', label: 'Role change' },
  member_added: { icon: 'users', tone: 'ok', label: 'Added to project' },
  member_removed: { icon: 'logout', tone: 'danger', label: 'Removed' },
  deadline_reminder: { icon: 'clock', tone: 'warn', label: 'Due soon' },
  soft_deadline_reminder: { icon: 'target', tone: 'warn', label: 'Soft deadline' },
  task_reassigned: { icon: 'refresh', tone: 'info', label: 'Reassigned' },
  system: { icon: 'info', tone: 'neutral', label: 'ProjectForge' },
};

const TONE_BG: Record<Tone, string> = {
  neutral: 'bg-surface-2 text-muted', brand: 'bg-brand/10 text-brand', ok: 'bg-ok/10 text-ok', warn: 'bg-warn/10 text-warn',
  danger: 'bg-danger/10 text-danger', info: 'bg-info/10 text-info', accent: 'bg-accent/10 text-accent',
};

export function NotificationsPage() {
  const navigate = useNavigate();
  const [tab, setTab] = useState<'all' | 'unread'>('all');
  const [items, setItems] = useState<Notification[] | null>(null);
  const [unread, setUnread] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await notificationController.list(tab === 'unread');
      setItems(result.items);
      setUnread(result.unread_count);
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, [tab]);

  useEffect(() => void load(), [load]);
  useRealtime('notification', (n: Notification) => {
    setItems((list) => [n, ...(list ?? [])]);
    setUnread((u) => u + 1);
  });

  const open = async (n: Notification) => {
    if (!n.is_read) {
      try {
        await notificationController.markRead(n.id);
        setItems((list) => (list ?? []).map((x) => (x.id === n.id ? { ...x, is_read: true } : x)));
        setUnread((u) => Math.max(0, u - 1));
      } catch (err) {
        setError(toApiError(err).detail);
      }
    }
    if (n.link) navigate(n.link);
  };

  const markAll = async () => {
    try {
      const result = await notificationController.markAllRead();
      setItems(tab === 'unread' ? [] : result.items);
      setUnread(0);
    } catch (err) {
      setError(toApiError(err).detail);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader
        title="Notifications"
        subtitle={`${unread} unread`}
        actions={
          <>
            <Segmented ariaLabel="Notification filter" value={tab} onChange={setTab} options={[{ value: 'all', label: 'All' }, { value: 'unread', label: 'Unread' }]} />
            <button type="button" className="btn-secondary" onClick={() => void markAll()} disabled={unread === 0}><Icon name="check" /> Mark all as read</button>
          </>
        }
      />
      {error ? <div className="mb-4"><Alert onClose={() => setError(null)}>{error}</Alert></div> : null}
      <div className="card divide-y divide-line">
        {items === null ? <Spinner /> : items.length === 0 ? (
          <EmptyState icon="bell" title={tab === 'unread' ? 'No unread notifications' : 'No notifications yet'}>Mentions, assignments and deadline reminders show up here.</EmptyState>
        ) : items.map((n) => {
          const meta = KIND[n.kind] ?? KIND.system;
          return (
            <button key={n.id} type="button" onClick={() => void open(n)} className={`flex w-full items-start gap-4 px-5 py-4 text-left transition hover:bg-surface-2 ${n.is_read ? '' : 'bg-brand/[0.03]'}`}>
              <span className={`rounded-full p-2.5 ${TONE_BG[meta.tone]}`}><Icon name={meta.icon} /></span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">{meta.label}</span>
                <span className={`mt-0.5 block text-sm ${n.is_read ? 'text-muted' : 'font-semibold text-ink'}`}>{n.message}</span>
                <span className="mt-1 block text-xs text-muted" title={formatDateTime(n.created_at)}>{relativeTime(n.created_at)}</span>
              </span>
              {!n.is_read ? <span className="mt-2 h-2.5 w-2.5 shrink-0 rounded-full bg-brand" aria-label="Unread" /> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
