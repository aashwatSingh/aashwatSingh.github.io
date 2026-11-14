/**
 * @author Saaqib Shaik (calendar & export), Preethi Seereddy (soft deadlines on the calendar) - matches
 *   calendar.html and calendar-week.html
 * @description Month and Week views of every deadline across the user's projects: project deadlines, task
 *   due dates and soft deadlines, colored by project card color and marked with a kind icon. Filter by
 *   project, jump to today, open any item, and export the selected project's deadlines.
 * @traces SE-FR-07, SE-FR-19, UC-07, UC-14
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ExportModal } from '../features/export/ExportModal';
import { projectController } from '../features/projects/projectController';
import { useProjectScope } from '../features/projects/ProjectScope';
import { useRealtime } from '../services/realtimeClient';
import type { CalendarEvent } from '../shared/types';
import { formatTime } from '../shared/format';
import { Alert, Icon, PageHeader, Segmented, Spinner } from '../shared/ui';
import { toApiError } from '../shared/useSave';

type View = 'month' | 'week';
const KIND_ICON: Record<CalendarEvent['kind'], string> = { project_deadline: 'flag', task_due: 'check', soft_deadline: 'target' };
const KIND_LABEL: Record<CalendarEvent['kind'], string> = { project_deadline: 'Project deadline', task_due: 'Task due', soft_deadline: 'Soft deadline' };
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function startOfWeek(d: Date): Date {
  const s = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  s.setDate(s.getDate() - ((s.getDay() + 6) % 7));
  return s;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function EventChip({ event, compact }: { event: CalendarEvent; compact?: boolean }) {
  const to = event.task_id ? `/tasks/${event.task_id}` : `/projects/${event.project_id}`;
  return (
    <Link to={to} title={`${KIND_LABEL[event.kind]} · ${event.title} · ${event.project_name}`}
      className={`flex items-center gap-1 truncate rounded px-1.5 py-0.5 text-[11px] font-medium text-white ${event.is_completed ? 'opacity-50 line-through' : ''}`}
      style={{ background: event.color }}>
      <Icon name={KIND_ICON[event.kind]} className="h-3 w-3 shrink-0" />
      {!compact ? <span className="shrink-0 opacity-80">{formatTime(event.starts_at)}</span> : null}
      <span className="truncate">{event.title}</span>
    </Link>
  );
}

export function CalendarPage() {
  const { projects, currentProject } = useProjectScope();
  const [view, setView] = useState<View>('month');
  const [cursor, setCursor] = useState(() => new Date());
  const [projectFilter, setProjectFilter] = useState('');
  const [events, setEvents] = useState<CalendarEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const range = useMemo(() => {
    if (view === 'week') {
      const start = startOfWeek(cursor);
      return { start, end: addDays(start, 7), days: Array.from({ length: 7 }, (_, i) => addDays(start, i)) };
    }
    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const start = startOfWeek(first);
    return { start, end: addDays(start, 42), days: Array.from({ length: 42 }, (_, i) => addDays(start, i)) };
  }, [view, cursor]);

  const load = useCallback(async () => {
    try {
      setEvents(await projectController.calendarEvents(range.start, range.end, projectFilter || undefined));
      setError(null);
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, [range, projectFilter]);

  useEffect(() => void load(), [load]);
  useRealtime('task_changed', () => void load());
  useRealtime('soft_deadline_changed', () => void load());

  const byDay = (day: Date) => (events ?? []).filter((e) => sameDay(new Date(e.starts_at), day));
  const shift = (dir: number) => setCursor((c) => (view === 'week' ? addDays(c, dir * 7) : new Date(c.getFullYear(), c.getMonth() + dir, 1)));
  const title = view === 'month'
    ? cursor.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    : `${range.start.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} – ${addDays(range.start, 6).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })}`;
  const exportProject = projects.find((p) => p.id === (projectFilter || currentProject?.id));
  const today = new Date();

  return (
    <div>
      <PageHeader
        title="Calendar"
        subtitle="Project deadlines, task due dates and soft deadlines in one place."
        actions={
          <>
            <Segmented ariaLabel="Calendar view" value={view} onChange={setView} options={[{ value: 'month', label: 'Month' }, { value: 'week', label: 'Week' }]} />
            {exportProject ? <button type="button" className="btn-secondary" onClick={() => setExporting(true)}><Icon name="download" /> Export</button> : null}
          </>
        }
      />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <button type="button" className="btn-secondary px-2" onClick={() => shift(-1)} aria-label="Previous"><Icon name="chevron-left" /></button>
        <button type="button" className="btn-secondary" onClick={() => setCursor(new Date())}>Today</button>
        <button type="button" className="btn-secondary px-2" onClick={() => shift(1)} aria-label="Next"><Icon name="chevron-right" /></button>
        <h2 className="ml-2 text-lg font-semibold">{title}</h2>
        <span className="flex-1" />
        <select className="input w-auto" value={projectFilter} onChange={(e) => setProjectFilter(e.target.value)} aria-label="Filter by project">
          <option value="">All projects</option>
          {projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </div>
      <div className="mb-3 flex flex-wrap gap-4 text-xs text-muted">
        {(Object.keys(KIND_LABEL) as CalendarEvent['kind'][]).map((k) => <span key={k} className="flex items-center gap-1"><Icon name={KIND_ICON[k]} className="h-3.5 w-3.5" /> {KIND_LABEL[k]}</span>)}
      </div>
      {error ? <Alert>{error}</Alert> : events === null ? <Spinner /> : view === 'month' ? (
        <div className="card overflow-hidden">
          <div className="grid grid-cols-7 border-b border-line bg-surface-2">{WEEKDAYS.map((d) => <div key={d} className="px-2 py-2 text-center text-xs font-semibold text-muted">{d}</div>)}</div>
          <div className="grid grid-cols-7">
            {range.days.map((day) => {
              const items = byDay(day);
              const inMonth = day.getMonth() === cursor.getMonth();
              return (
                <div key={day.toISOString()} className={`min-h-[108px] border-b border-r border-line p-1.5 ${inMonth ? '' : 'bg-surface-2/50'}`}>
                  <p className={`mb-1 text-right text-xs font-semibold ${sameDay(day, today) ? 'ml-auto flex h-6 w-6 items-center justify-center rounded-full bg-brand text-brand-ink' : inMonth ? '' : 'text-muted'}`}>{day.getDate()}</p>
                  <div className="space-y-0.5">
                    {items.slice(0, 3).map((e) => <EventChip key={e.id} event={e} compact />)}
                    {items.length > 3 ? <button type="button" className="text-[11px] font-semibold text-brand" onClick={() => { setCursor(day); setView('week'); }}>+{items.length - 3} more</button> : null}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-7">
          {range.days.map((day) => {
            const items = byDay(day);
            return (
              <section key={day.toISOString()} className={`card min-h-[280px] p-3 ${sameDay(day, today) ? 'ring-2 ring-brand' : ''}`} aria-label={day.toDateString()}>
                <p className="text-xs font-semibold uppercase text-muted">{WEEKDAYS[(day.getDay() + 6) % 7]}</p>
                <p className="mb-3 text-2xl font-bold">{day.getDate()}</p>
                <div className="space-y-1.5">
                  {items.length === 0 ? <p className="text-xs text-muted">Nothing due</p> : items.map((e) => <EventChip key={e.id} event={e} />)}
                </div>
              </section>
            );
          })}
        </div>
      )}
      {exportProject ? <ExportModal open={exporting} onClose={() => setExporting(false)} projectId={exportProject.id} projectName={exportProject.name} role={exportProject.my_role} /> : null}
    </div>
  );
}
