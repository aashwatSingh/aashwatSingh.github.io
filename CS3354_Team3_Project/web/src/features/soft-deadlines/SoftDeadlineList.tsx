/**
 * @author Preethi Seereddy
 * @description Soft deadlines on the task screen. Lists checkpoints in date order; the assignee or a manager
 *   can add, edit, tick off and delete them. Dates are validated before saving; if the server still rejects
 *   an edit, the field snaps back to the original saved value the server returns, and a timed-out save offers
 *   Retry / Cancel while keeping the typed value.
 * @traces SE-FR-06, SE-FR-07, SE-FR-08, SE-FR-09, SE-FR-10, SE-NFR-04, UC-05, UC-06, UC-07
 */
import { useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../services/apiClient';
import { useRealtime } from '../../services/realtimeClient';
import type { SoftDeadline } from '../../shared/types';
import { formatDateTime, fromLocalInput, toLocalInput } from '../../shared/format';
import { Alert, EmptyState, Icon, RetryBanner, Spinner } from '../../shared/ui';
import { toApiError, useSave } from '../../shared/useSave';
import { SoftDeadlineStateBadge } from './SoftDeadlineBadge';
import { softDeadlineController } from './softDeadlineController';
import { NEEDS_DUE_DATE, softDeadlineError } from './validation';

interface Props {
  taskId: string;
  taskDueDate: string | null;
  canManage: boolean;
}

function EditRow({ item, taskDueDate, onSaved, onCancel }: { item: SoftDeadline; taskDueDate: string | null; onSaved: (sd: SoftDeadline) => void; onCancel: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [due, setDue] = useState(toLocalInput(item.due_at));
  const [clientError, setClientError] = useState<string | null>(null);
  const save = useSave(() => softDeadlineController.update(item.id, { title, due_at: fromLocalInput(due) ?? undefined }), onSaved);

  useEffect(() => {
    // UC-06: the server rejected the date and sent back the record it kept - restore that value.
    const original = (save.error?.body as { original?: SoftDeadline } | undefined)?.original;
    if (original) {
      setDue(toLocalInput(original.due_at));
      setTitle(original.title);
    }
  }, [save.error]);

  const submit = () => {
    const err = softDeadlineError(fromLocalInput(due), taskDueDate);
    setClientError(err);
    if (err) {
      setDue(toLocalInput(item.due_at)); // keep the original value on an invalid edit
      return;
    }
    void save.run();
  };

  return (
    <div className="space-y-2 rounded-lg border border-brand/40 bg-brand/5 p-3">
      <RetryBanner error={save.networkError} onRetry={save.retry} onCancel={save.cancel} busy={save.saving} />
      {clientError || save.error ? <Alert>{clientError ?? save.error?.detail}</Alert> : null}
      <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
        <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Soft deadline title" maxLength={120} />
        <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Soft deadline date" />
      </div>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn-secondary py-1.5" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn-primary py-1.5" onClick={submit} disabled={save.saving}>{save.saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

export function SoftDeadlineList({ taskId, taskDueDate, canManage }: Props) {
  const [items, setItems] = useState<SoftDeadline[] | null>(null);
  const [title, setTitle] = useState('');
  const [due, setDue] = useState('');
  const [clientError, setClientError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);

  const load = useCallback(async () => setItems(await softDeadlineController.listForTask(taskId)), [taskId]);
  useEffect(() => void load(), [load]);
  useRealtime('soft_deadline_changed', (data: { task_id: string }) => data.task_id === taskId && void load());

  const sortAndSet = (next: SoftDeadline[]) => setItems([...next].sort((a, b) => a.due_at.localeCompare(b.due_at)));

  const create = useSave(() => softDeadlineController.create(taskId, title.trim(), fromLocalInput(due) ?? ''), (sd) => {
    sortAndSet([...(items ?? []), sd]);
    setTitle('');
    setDue('');
  });

  const add = () => {
    const err = !title.trim() ? 'Give the checkpoint a title' : softDeadlineError(fromLocalInput(due), taskDueDate);
    setClientError(err);
    if (!err) void create.run();
  };

  const toggle = async (sd: SoftDeadline) => {
    try {
      const updated = await softDeadlineController.complete(sd.id, !sd.is_completed);
      sortAndSet((items ?? []).map((x) => (x.id === sd.id ? updated : x)));
    } catch (err) {
      setRowError(toApiError(err).detail);
    }
  };

  const remove = async (sd: SoftDeadline) => {
    try {
      await softDeadlineController.remove(sd.id);
      setItems((items ?? []).filter((x) => x.id !== sd.id));
    } catch (err) {
      setRowError(err instanceof ApiError ? err.detail : 'Could not delete');
    }
  };

  if (items === null) return <Spinner label="Loading soft deadlines…" />;
  return (
    <div className="space-y-3">
      {taskDueDate ? (
        <p className="text-xs text-muted">Final due date: <span className="font-semibold text-ink">{formatDateTime(taskDueDate)}</span>. Checkpoints must come before it.</p>
      ) : (
        <Alert tone="info">{NEEDS_DUE_DATE}</Alert>
      )}
      {rowError ? <Alert onClose={() => setRowError(null)}>{rowError}</Alert> : null}
      {items.length === 0 ? (
        <EmptyState icon="target" title="No soft deadlines">Break the work into checkpoints before the final due date.</EmptyState>
      ) : (
        <ul className="space-y-2">
          {items.map((sd) =>
            editing === sd.id ? (
              <li key={sd.id}>
                <EditRow item={sd} taskDueDate={taskDueDate} onCancel={() => setEditing(null)} onSaved={(u) => { sortAndSet(items.map((x) => (x.id === u.id ? u : x))); setEditing(null); }} />
              </li>
            ) : (
              <li key={sd.id} className="flex items-center gap-3 rounded-lg border border-line px-3 py-2">
                <input type="checkbox" checked={sd.is_completed} disabled={!canManage} onChange={() => void toggle(sd)} aria-label={`Mark ${sd.title} complete`} />
                <div className="min-w-0 flex-1">
                  <p className={`truncate text-sm font-medium ${sd.is_completed ? 'text-muted line-through' : ''}`}>{sd.title}</p>
                  <p className="text-xs text-muted">{formatDateTime(sd.due_at)}</p>
                </div>
                <SoftDeadlineStateBadge state={sd.state} />
                {canManage ? (
                  <>
                    <button type="button" className="btn-ghost p-1.5" onClick={() => setEditing(sd.id)} aria-label={`Edit ${sd.title}`}><Icon name="edit" /></button>
                    <button type="button" className="btn-ghost p-1.5 hover:text-danger" onClick={() => void remove(sd)} aria-label={`Delete ${sd.title}`}><Icon name="trash" /></button>
                  </>
                ) : null}
              </li>
            ),
          )}
        </ul>
      )}
      {canManage && taskDueDate ? (
        <div className="space-y-2 rounded-lg border border-dashed border-line p-3">
          <RetryBanner error={create.networkError} onRetry={create.retry} onCancel={create.cancel} busy={create.saving} />
          {clientError || create.error ? <Alert>{clientError ?? create.error?.detail}</Alert> : null}
          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto]">
            <input className="input" placeholder="Checkpoint, e.g. First draft" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="New soft deadline title" maxLength={120} />
            <input className="input" type="datetime-local" value={due} onChange={(e) => setDue(e.target.value)} aria-label="New soft deadline date"
              max={toLocalInput(taskDueDate)} />
            <button type="button" className="btn-primary" onClick={add} disabled={create.saving}><Icon name="plus" /> Add</button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
