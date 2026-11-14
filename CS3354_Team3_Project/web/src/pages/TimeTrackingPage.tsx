/**
 * @author Jon Sorey - matches time-tracking.html
 * @description Time tracking hub: pick one of your tasks and run the timer, log hours by hand, see this
 *   week's hours per day, and browse entries. Members only ever see their own entries; owners and managers
 *   can switch to "Whole project" for the current project.
 * @traces SE-FR-04, SE-NFR-02, UC-03, UC-04
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useProjectScope } from '../features/projects/ProjectScope';
import { taskController } from '../features/tasks/taskController';
import { TaskTimerWidget } from '../features/time-tracking/TaskTimerWidget';
import { hoursByDay, isValidHours } from '../features/time-tracking/model';
import { timeController } from '../features/time-tracking/timeController';
import { useRealtime } from '../services/realtimeClient';
import { isManager } from '../shared/permissions';
import type { Task, TimeEntry } from '../shared/types';
import { formatDateTime, formatDuration, formatHours, todayIso } from '../shared/format';
import { Alert, Badge, Card, EmptyState, Field, Icon, PageHeader, RetryBanner, Segmented, Spinner } from '../shared/ui';
import { toApiError, useSave } from '../shared/useSave';

const DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function weekDays(): string[] {
  const now = new Date();
  const monday = new Date(now);
  monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
}

export function TimeTrackingPage() {
  const { currentProject } = useProjectScope();
  const [myTasks, setMyTasks] = useState<Task[] | null>(null);
  const [taskId, setTaskId] = useState('');
  const [entries, setEntries] = useState<TimeEntry[] | null>(null);
  const [myEntries, setMyEntries] = useState<TimeEntry[]>([]);
  const [scope, setScope] = useState<'mine' | 'project'>('mine');
  const [hours, setHours] = useState('');
  const [date, setDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const days = useMemo(weekDays, []);
  const canSeeProject = isManager(currentProject?.my_role);

  const loadEntries = useCallback(async () => {
    try {
      const own = await timeController.list({});
      setMyEntries(own);
      setEntries(scope === 'project' && currentProject ? await timeController.list({ project_id: currentProject.id }) : own);
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, [scope, currentProject]);

  useEffect(() => {
    taskController.mine(false).then((t) => {
      setMyTasks(t);
      setTaskId((cur) => cur || t[0]?.id || '');
    }).catch((err) => setError(toApiError(err).detail));
  }, []);
  useEffect(() => void loadEntries(), [loadEntries]);
  useEffect(() => { if (!canSeeProject) setScope('mine'); }, [canSeeProject]);
  useRealtime('timer', () => void loadEntries());

  const selected = myTasks?.find((t) => t.id === taskId);
  const log = useSave(
    () => timeController.setHours(selected!.project_id, selected!.id, { actual_hours: Number(hours), work_date: date, note }),
    () => { setHours(''); setNote(''); void loadEntries(); },
  );

  const perDay = hoursByDay(myEntries, days);
  const max = Math.max(1, ...perDay);
  const total = perDay.reduce((a, b) => a + b, 0);

  const remove = async (id: string) => {
    try {
      await timeController.remove(id);
      void loadEntries();
    } catch (err) {
      setError(toApiError(err).detail);
    }
  };

  return (
    <div>
      <PageHeader title="Time Tracking" subtitle="Track time on the tasks assigned to you." />
      {error ? <div className="mb-4"><Alert onClose={() => setError(null)}>{error}</Alert></div> : null}
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Timer" className="lg:col-span-2">
          {myTasks === null ? <Spinner /> : myTasks.length === 0 ? (
            <EmptyState icon="clock" title="No open tasks assigned to you">When a manager assigns you a task, you can track time on it here.</EmptyState>
          ) : (
            <div className="space-y-4">
              <Field label="Task" htmlFor="tt-task">
                <select id="tt-task" className="input" value={taskId} onChange={(e) => setTaskId(e.target.value)}>
                  {myTasks.map((t) => <option key={t.id} value={t.id}>{t.title}</option>)}
                </select>
              </Field>
              {selected ? (
                <>
                  <TaskTimerWidget taskId={selected.id} taskTitle={selected.title} canTrack onStopped={() => void loadEntries()} />
                  <p className="text-xs text-muted">
                    Estimated {formatHours(selected.estimated_hours)} · Assigned {formatHours(selected.assigned_hours)} · Actual {formatHours(selected.actual_hours)} ·{' '}
                    <Link to={`/tasks/${selected.id}`} className="font-semibold text-brand">Open task</Link>
                  </p>
                  <div className="space-y-2 border-t border-line pt-4">
                    <p className="label">Log hours manually</p>
                    <RetryBanner error={log.networkError} onRetry={log.retry} onCancel={log.cancel} busy={log.saving} />
                    {log.error ? <Alert>{log.error.detail}</Alert> : null}
                    <div className="grid gap-2 sm:grid-cols-[7rem_10rem_1fr_auto]">
                      <input className="input" type="number" min={0.25} max={24} step="0.25" placeholder="Hours" value={hours} onChange={(e) => setHours(e.target.value)} aria-label="Hours" />
                      <input className="input" type="date" value={date} max={todayIso()} onChange={(e) => setDate(e.target.value)} aria-label="Date" />
                      <input className="input" placeholder="Note" value={note} onChange={(e) => setNote(e.target.value)} aria-label="Note" maxLength={300} />
                      <button type="button" className="btn-primary" disabled={!isValidHours(hours) || log.saving} onClick={() => void log.run()}><Icon name="plus" /> Log</button>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          )}
        </Card>
        <Card title="This week" actions={<span className="text-sm font-bold">{total.toFixed(2)} h</span>}>
          <div className="flex h-40 items-end gap-2" aria-label="Hours logged per day this week">
            {perDay.map((h, i) => (
              <div key={days[i]} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-muted">{h ? h.toFixed(1) : ''}</span>
                <div className="w-full rounded-t bg-brand" style={{ height: `${Math.max(3, (h / max) * 120)}px`, opacity: h ? 1 : 0.25 }} title={`${DAY_LABELS[i]}: ${h.toFixed(2)} h`} />
                <span className="text-[10px] font-semibold text-muted">{DAY_LABELS[i]}</span>
              </div>
            ))}
          </div>
        </Card>
      </div>
      <Card
        title="Time entries"
        className="mt-6"
        bodyClass="p-0"
        actions={canSeeProject ? <Segmented ariaLabel="Entries scope" value={scope} onChange={setScope} options={[{ value: 'mine', label: 'Mine' }, { value: 'project', label: `Whole project` }]} /> : <Badge tone="neutral" icon="lock">Only your entries</Badge>}
      >
        {entries === null ? <Spinner /> : entries.length === 0 ? <EmptyState icon="clock" title="No time logged yet" /> : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-surface-2"><tr><th className="table-head">Task</th><th className="table-head">Project</th>{scope === 'project' ? <th className="table-head">Person</th> : null}<th className="table-head">Started</th><th className="table-head">Source</th><th className="table-head text-right">Hours</th><th className="table-head w-12" /></tr></thead>
              <tbody className="divide-y divide-line">
                {entries.map((e) => (
                  <tr key={e.id}>
                    <td className="table-cell"><Link to={`/tasks/${e.task_id}`} className="font-medium hover:text-brand">{e.task_title}</Link>{e.note ? <p className="text-xs text-muted">{e.note}</p> : null}</td>
                    <td className="table-cell text-muted">{e.project_name}</td>
                    {scope === 'project' ? <td className="table-cell">@{e.username}</td> : null}
                    <td className="table-cell whitespace-nowrap">{formatDateTime(e.started_at)}</td>
                    <td className="table-cell">{e.is_running ? <Badge tone="ok" icon={e.is_paused ? 'pause' : 'play'}>{e.is_paused ? 'Paused' : 'Running'} {formatDuration(e.elapsed_seconds)}</Badge> : <Badge tone="neutral" icon={e.source === 'timer' ? 'clock' : 'edit'}>{e.source === 'timer' ? 'Timer' : 'Manual'}</Badge>}</td>
                    <td className="table-cell text-right tabular-nums font-medium">{formatHours(e.duration_hours)}</td>
                    <td className="table-cell">{!e.is_running ? <button type="button" className="btn-ghost p-1.5 hover:text-danger" onClick={() => void remove(e.id)} aria-label="Delete entry"><Icon name="trash" /></button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
