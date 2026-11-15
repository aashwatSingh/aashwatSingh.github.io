/**
 * @author Aashwat Singh (ForgeAI); soft-deadline rules: Preethi Seereddy
 * @description The "Suggest with Nemotron" helper inside a task's Soft deadlines section. It asks ForgeAI
 *   for three checkpoints (low, medium and high priority), shows each with its date and priority, and adds
 *   one with a single click through the normal soft-deadline save, which checks again that the date is
 *   before the final due date. Nothing is saved until the person presses Add. The badge says whether the
 *   suggestions came from Nemotron or from the local engine, and a failed request offers Retry or Cancel.
 * @traces SE-FR-06, SE-FR-09, SE-NFR-03, SE-NFR-04, SE-NFR-11, UC-05
 */
import { useState } from 'react';
import type { ApiError } from '../../services/apiClient';
import { formatDateTime } from '../../shared/format';
import type { SoftDeadline, SoftDeadlinePriority } from '../../shared/types';
import { Badge, Icon, RetryBanner, type Tone } from '../../shared/ui';
import { toApiError } from '../../shared/useSave';
import { softDeadlineController } from '../soft-deadlines/softDeadlineController';
import { aiController } from './aiController';
import { EnginePills } from './EnginePills';
import { offerableSuggestions, suggestionKey, type AiSuggestReply, type AiSuggestion } from './model';

const PRIORITY_TONE: Record<SoftDeadlinePriority, Tone> = { high: 'danger', medium: 'warn', low: 'info' };

interface Props {
  projectId: string;
  taskId: string;
  taskDueDate: string | null;
  /** Called with the saved soft deadline so the list above can show it at once. */
  onAdded: (saved: SoftDeadline) => void;
}

export function SoftDeadlineSuggestions({ projectId, taskId, taskDueDate, onAdded }: Props) {
  const [result, setResult] = useState<AiSuggestReply | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [failure, setFailure] = useState<ApiError | null>(null);

  const suggest = async () => {
    setBusy(true);
    setMessage(null);
    setFailure(null);
    try {
      setResult(await aiController.suggestSoftDeadlines(projectId, taskId));
      setAdded(new Set());
    } catch (err) {
      const error = toApiError(err);
      if (error.isConnectivity || error.status >= 500) setFailure(error);
      else setMessage(error.status === 429 ? 'ForgeAI is busy. Wait a minute and try again.' : error.detail);
    } finally {
      setBusy(false);
    }
  };

  const add = async (suggestion: AiSuggestion) => {
    const key = suggestionKey(suggestion);
    setSaving(key);
    setMessage(null);
    try {
      // The normal soft-deadline save: the server re-checks "earlier than the final due date" (UC-05).
      onAdded(await softDeadlineController.create(taskId, suggestion.title, suggestion.due_at, suggestion.priority));
      setAdded((current) => new Set(current).add(key));
    } catch (err) {
      setMessage(toApiError(err).detail);
    } finally {
      setSaving(null);
    }
  };

  const offered = result ? offerableSuggestions(result.suggestions, taskDueDate, added) : [];

  return (
    <div className="space-y-3 rounded-btn border border-accent/40 bg-accent-deep/30 p-3" data-testid="soft-deadline-suggestions">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-ink"><Icon name="sparkle" className="h-4 w-4 text-accent" /> Plan checkpoints with ForgeAI</p>
          <p className="text-xs text-muted">Three suggested soft deadlines before the final due date. Nothing is saved until you press Add.</p>
        </div>
        <button type="button" className="btn-secondary btn-sm shrink-0" onClick={() => void suggest()} disabled={busy}>
          <Icon name="sparkle" /> {busy ? 'Thinking…' : result ? 'Suggest again' : 'Suggest with Nemotron'}
        </button>
      </div>
      <RetryBanner
        error={failure}
        busy={busy}
        title="ForgeAI did not answer."
        hint="Nothing was changed - retry now or cancel."
        onRetry={() => void suggest()}
        onCancel={() => setFailure(null)}
      />
      {message ? <p className="flex items-start gap-1.5 text-xs font-medium text-danger" role="alert"><Icon name="alert" className="mt-0.5 h-3 w-3" /> {message}</p> : null}
      {result ? (
        <>
          <EnginePills status={result} />
          {offered.length === 0 ? (
            <p className="text-xs text-muted">All suggestions were added. Press "Suggest again" for a new set.</p>
          ) : (
            <ul className="space-y-2" aria-label="Suggested soft deadlines">
              {offered.map((s) => {
                const key = suggestionKey(s);
                return (
                  <li key={key} className="flex flex-wrap items-center gap-3 rounded-btn border border-line bg-surface px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-semibold text-ink">{s.title}</p>
                      <p className="text-xs text-muted">{formatDateTime(s.due_at)}</p>
                    </div>
                    <Badge tone={PRIORITY_TONE[s.priority]} icon="flag">{s.priority.charAt(0).toUpperCase() + s.priority.slice(1)}</Badge>
                    <button type="button" className="btn-primary btn-sm" disabled={saving !== null} onClick={() => void add(s)} aria-label={`Add ${s.title}`}>
                      <Icon name="plus" /> {saving === key ? 'Adding…' : 'Add'}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
