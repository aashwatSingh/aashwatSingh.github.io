/**
 * @author Myoram Langwang
 * @description What each dashboard widget shows: project progress bars, my open tasks, upcoming deadlines,
 *   unread notifications, hours this week (with the running timer), the role-filtered budget overview and a
 *   seven-day strip. Every widget reads from the single consolidated dashboard payload.
 * @traces SE-FR-21, SE-NFR-08, SE-NFR-02
 */
import { Link } from 'react-router-dom';
import type { CalendarEvent, Notification } from '../../shared/types';
import { formatDateTime, formatMoney, relativeTime } from '../../shared/format';
import { Badge, EmptyState, Icon, PriorityBadge, ProgressBar, RoleBadge, StatusBadge } from '../../shared/ui';

interface ProgressItem { project_id: string; name: string; role: string; color: string; total: number; done: number; progress_pct: number; deadline: string }
interface MyTask { task_id: string; title: string; status: string; priority: string; project_name: string; due_date: string | null; overdue: boolean }
interface TimeSummary { total_hours: number; per_day: number[]; running_timer: { task_id: string; task_title: string; started_at: string; is_paused: boolean } | null }
interface BudgetRow { project_id: string; name: string; currency: string; bid_amount: string; budget_amount: string; stage_cost_total: string; expense_total: string }

const KIND_ICON: Record<string, string> = { project_deadline: 'flag', task_due: 'check', soft_deadline: 'target' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function EventRow({ event }: { event: CalendarEvent }) {
  const to = event.task_id ? `/tasks/${event.task_id}` : `/projects/${event.project_id}`;
  return (
    <li>
      <Link to={to} className="flex items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
        <span className="rounded-md p-1.5 text-white" style={{ background: event.color }}>
          <Icon name={KIND_ICON[event.kind]} className="h-3.5 w-3.5" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium">{event.title}</span>
          <span className="block truncate text-xs text-muted">{event.project_name} · {formatDateTime(event.starts_at)}</span>
        </span>
        <span className="shrink-0 text-xs text-muted">{relativeTime(event.starts_at)}</span>
      </Link>
    </li>
  );
}

export function WidgetBody({ type, data }: { type: string; data: Record<string, unknown> }) {
  switch (type) {
    case 'project_progress': {
      const items = (data.project_progress as ProgressItem[] | undefined) ?? [];
      if (!items.length) return <EmptyState title="No projects yet" action={<Link className="btn-primary" to="/projects">Create a project</Link>} />;
      return (
        <ul className="space-y-4">
          {items.map((p) => (
            <li key={p.project_id}>
              <div className="mb-1 flex items-center justify-between gap-2">
                <Link to={`/projects/${p.project_id}`} className="truncate text-sm font-semibold hover:text-brand">{p.name}</Link>
                <RoleBadge role={p.role} />
              </div>
              <ProgressBar value={p.progress_pct} color={p.color} label={`${p.done}/${p.total} tasks`} />
            </li>
          ))}
        </ul>
      );
    }
    case 'my_tasks': {
      const items = (data.my_tasks as MyTask[] | undefined) ?? [];
      if (!items.length) return <EmptyState icon="check" title="Nothing assigned to you">Enjoy the calm.</EmptyState>;
      return (
        <ul className="space-y-1">
          {items.map((t) => (
            <li key={t.task_id}>
              <Link to={`/tasks/${t.task_id}`} className="block rounded-lg px-2 py-2 hover:bg-surface-2">
                <span className="flex items-center justify-between gap-2">
                  <span className="truncate text-sm font-medium">{t.title}</span>
                  <PriorityBadge priority={t.priority} />
                </span>
                <span className="mt-1 flex items-center gap-2 text-xs text-muted">
                  <StatusBadge status={t.status} />
                  <span className="truncate">{t.project_name}</span>
                  {t.due_date ? <span className={t.overdue ? 'font-semibold text-danger' : ''}>· {t.overdue ? 'Overdue ' : 'Due '}{relativeTime(t.due_date)}</span> : null}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      );
    }
    case 'upcoming_deadlines': {
      const items = (data.upcoming_deadlines as CalendarEvent[] | undefined) ?? [];
      if (!items.length) return <EmptyState icon="calendar" title="No deadlines in the next 14 days" />;
      return <ul className="space-y-0.5">{items.map((e) => <EventRow key={e.id} event={e} />)}</ul>;
    }
    case 'notifications': {
      const n = (data.notifications as { unread_count: number; items: Notification[] } | undefined) ?? { unread_count: 0, items: [] };
      return (
        <div>
          <p className="mb-2 text-xs text-muted"><span className="text-lg font-bold text-ink">{n.unread_count}</span> unread</p>
          {n.items.length === 0 ? <EmptyState icon="bell" title="You're all caught up" /> : (
            <ul className="space-y-1">
              {n.items.map((item) => (
                <li key={item.id}>
                  <Link to={item.link || '/notifications'} className="block rounded-lg px-2 py-1.5 text-sm hover:bg-surface-2">
                    <span className="line-clamp-2">{item.message}</span>
                    <span className="text-xs text-muted">{relativeTime(item.created_at)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link to="/notifications" className="mt-2 inline-block text-xs font-semibold text-brand">View all →</Link>
        </div>
      );
    }
    case 'time_summary': {
      const t = (data.time_summary as TimeSummary | undefined) ?? { total_hours: 0, per_day: [0, 0, 0, 0, 0, 0, 0], running_timer: null };
      const max = Math.max(1, ...t.per_day);
      return (
        <div className="flex h-full flex-col">
          <p className="text-2xl font-bold">{t.total_hours.toFixed(2)} <span className="text-sm font-medium text-muted">hours this week</span></p>
          <div className="mt-3 flex flex-1 items-end gap-2" aria-label="Hours per day">
            {t.per_day.map((h, i) => (
              <div key={DAYS[i]} className="flex flex-1 flex-col items-center gap-1">
                <div className="w-full rounded-t bg-brand/80" style={{ height: `${Math.max(4, (h / max) * 64)}px` }} title={`${DAYS[i]}: ${h.toFixed(2)} h`} />
                <span className="text-[10px] text-muted">{DAYS[i]}</span>
              </div>
            ))}
          </div>
          {t.running_timer ? (
            <Link to={`/tasks/${t.running_timer.task_id}`} className="mt-3 flex items-center gap-2 rounded-lg bg-ok/10 px-3 py-2 text-xs font-semibold text-ok">
              <Icon name={t.running_timer.is_paused ? 'pause' : 'play'} className="h-3.5 w-3.5" />
              {t.running_timer.is_paused ? 'Paused' : 'Running'}: {t.running_timer.task_title}
            </Link>
          ) : (
            <Link to="/time" className="mt-3 text-xs font-semibold text-brand">Open time tracking →</Link>
          )}
        </div>
      );
    }
    case 'budget_overview': {
      const b = (data.budget_overview as { restricted: boolean; projects: BudgetRow[] } | undefined) ?? { restricted: true, projects: [] };
      if (b.restricted) {
        return <EmptyState icon="lock" title="Financials are for owners and managers">You are a member on all of your projects, so no budget data is shown.</EmptyState>;
      }
      return (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr><th className="table-head">Project</th><th className="table-head text-right">Bid</th><th className="table-head text-right">Budget</th><th className="table-head text-right">Stage costs</th><th className="table-head text-right">Expenses</th></tr>
            </thead>
            <tbody className="divide-y divide-line">
              {b.projects.map((p) => (
                <tr key={p.project_id}>
                  <td className="table-cell"><Link to={`/costs?project=${p.project_id}`} className="font-medium hover:text-brand">{p.name}</Link></td>
                  <td className="table-cell text-right tabular-nums">{formatMoney(p.bid_amount, p.currency)}</td>
                  <td className="table-cell text-right tabular-nums">{formatMoney(p.budget_amount, p.currency)}</td>
                  <td className="table-cell text-right tabular-nums">{formatMoney(p.stage_cost_total, p.currency)}</td>
                  <td className="table-cell text-right tabular-nums">{formatMoney(p.expense_total, p.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case 'calendar_week': {
      const c = (data.calendar_week as { week_start: string; events: CalendarEvent[] } | undefined) ?? { week_start: '', events: [] };
      const start = c.week_start ? new Date(`${c.week_start}T00:00:00`) : new Date();
      return (
        <div className="grid h-full grid-cols-7 gap-1 text-center">
          {DAYS.map((d, i) => {
            const day = new Date(start);
            day.setDate(start.getDate() + i);
            const events = c.events.filter((e) => new Date(e.starts_at).toDateString() === day.toDateString());
            return (
              <div key={d} className="rounded-lg bg-surface-2 p-1">
                <p className="text-[10px] font-semibold text-muted">{d} {day.getDate()}</p>
                <div className="mt-1 flex flex-wrap justify-center gap-0.5">
                  {events.map((e) => <span key={e.id} className="h-2 w-2 rounded-full" style={{ background: e.color }} title={e.title} />)}
                </div>
                {events.length ? <Badge tone="neutral" className="mt-1 px-1 text-[10px]">{events.length}</Badge> : null}
              </div>
            );
          })}
        </div>
      );
    }
    default:
      return <p className="text-sm text-muted">This widget is not available.</p>;
  }
}
