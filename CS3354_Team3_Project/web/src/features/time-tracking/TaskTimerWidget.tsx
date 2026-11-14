/**
 * @author Jon Sorey
 * @description Start / pause / resume / stop timer for one task, with a live HH:MM:SS clock. Only one timer
 *   can run at a time per person; the server rejects a second start and the widget explains why.
 * @traces SE-FR-04, UC-04
 */
import { useCallback, useEffect, useState } from 'react';
import { useRealtime } from '../../services/realtimeClient';
import type { TimeEntry } from '../../shared/types';
import { formatDuration } from '../../shared/format';
import { Alert, Icon } from '../../shared/ui';
import { toApiError } from '../../shared/useSave';
import { liveElapsed } from './model';
import { timeController } from './timeController';

export function TaskTimerWidget({ taskId, taskTitle, canTrack, onStopped }: { taskId: string; taskTitle?: string; canTrack: boolean; onStopped?: (entry: TimeEntry) => void }) {
  const [active, setActive] = useState<TimeEntry | null>(null);
  const [fetchedAt, setFetchedAt] = useState(Date.now());
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setActive(await timeController.active());
      setFetchedAt(Date.now());
    } catch (err) {
      setError(toApiError(err).detail);
    }
  }, []);

  useEffect(() => void refresh(), [refresh]);
  useRealtime('timer', () => void refresh());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const act = async (fn: () => Promise<TimeEntry>, after?: (e: TimeEntry) => void) => {
    setBusy(true);
    setError(null);
    try {
      const entry = await fn();
      after?.(entry);
      await refresh();
    } catch (err) {
      setError(toApiError(err).detail);
    } finally {
      setBusy(false);
    }
  };

  const onThisTask = active?.task_id === taskId;
  const elapsed = onThisTask && active ? liveElapsed(active, fetchedAt, now) : 0;

  if (!canTrack) {
    return <p className="text-sm text-muted">Only the assignee (or a manager) can track time on this task.</p>;
  }
  return (
    <div className="space-y-3">
      {error ? <Alert onClose={() => setError(null)}>{error}</Alert> : null}
      <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface-2/60 px-4 py-3">
        <div>
          <p className="font-mono text-3xl font-bold tabular-nums" aria-live="polite" aria-label="Elapsed time">{formatDuration(elapsed)}</p>
          <p className="text-xs text-muted">
            {onThisTask ? (active?.is_paused ? 'Paused' : 'Running') : active ? `Timer running on “${active.task_title}”` : `Ready${taskTitle ? ` · ${taskTitle}` : ''}`}
          </p>
        </div>
        <div className="flex gap-2">
          {!onThisTask ? (
            <button type="button" className="btn-primary" disabled={busy || !!active} onClick={() => void act(() => timeController.start(taskId))}>
              <Icon name="play" /> Start
            </button>
          ) : (
            <>
              {active?.is_paused ? (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(timeController.resume)}>
                  <Icon name="play" /> Resume
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={busy} onClick={() => void act(timeController.pause)}>
                  <Icon name="pause" /> Pause
                </button>
              )}
              <button type="button" className="btn-danger" disabled={busy} onClick={() => void act(timeController.stop, onStopped)}>
                <Icon name="stop" /> Stop
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
