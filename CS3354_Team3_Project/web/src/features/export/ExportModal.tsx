/**
 * @author Saaqib Shaik
 * @description The export dialog. Calendar tab: choose which deadlines to include and a destination; for
 *   Google / Outlook the user must explicitly allow access first - declining cancels without sharing
 *   anything. Spreadsheet tab: choose sheets; financial sheets are only offered to owners and managers
 *   (the server enforces the same rule). Shows "Nothing to export" and success counts from the server.
 * @traces SE-FR-19, SE-FR-20, UC-14, UC-15
 */
import { useState } from 'react';
import type { CalendarExportResult, Role, SheetsExportResult, SpreadsheetSection } from '../../shared/types';
import { isManager } from '../../shared/permissions';
import { formatDateTime } from '../../shared/format';
import { Alert, Icon, Modal, Segmented } from '../../shared/ui';
import { toApiError } from '../../shared/useSave';
import { exportController, type CalendarIncludes } from './exportController';

type Tab = 'calendar' | 'spreadsheet';
type CalTarget = 'ical' | 'google' | 'outlook';

const SECTIONS: { value: SpreadsheetSection; label: string; financial?: boolean }[] = [
  { value: 'tasks', label: 'Tasks' },
  { value: 'soft_deadlines', label: 'Soft deadlines' },
  { value: 'time_entries', label: 'Time entries' },
  { value: 'financials', label: 'Bid & budget', financial: true },
  { value: 'stage_costs', label: 'Stage costs', financial: true },
  { value: 'expenses', label: 'Expenses', financial: true },
];

export function ExportModal({ open, onClose, projectId, projectName, role }: { open: boolean; onClose: () => void; projectId: string; projectName: string; role: Role }) {
  const manager = isManager(role);
  const [tab, setTab] = useState<Tab>('calendar');
  const [target, setTarget] = useState<CalTarget>('ical');
  const [includes, setIncludes] = useState<CalendarIncludes>({ include_project_deadline: true, include_task_due_dates: true, include_soft_deadlines: true });
  const [sections, setSections] = useState<SpreadsheetSection[]>(manager ? SECTIONS.map((s) => s.value) : ['tasks', 'soft_deadlines', 'time_entries']);
  const [consentOpen, setConsentOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'danger' | 'warn'; text: string } | null>(null);
  const [links, setLinks] = useState<CalendarExportResult['provider_links']>([]);
  const [sheets, setSheets] = useState<SheetsExportResult | null>(null);

  const reset = () => {
    setMessage(null);
    setLinks([]);
    setSheets(null);
  };

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    reset();
    try {
      await fn();
    } catch (err) {
      const e = toApiError(err);
      setMessage({ tone: e.detail === 'Nothing to export' ? 'warn' : 'danger', text: e.detail });
    } finally {
      setBusy(false);
    }
  };

  const exportCalendar = () => {
    if (target === 'ical') {
      void run(async () => {
        const { count, filename } = await exportController.downloadIcs(projectId, includes);
        setMessage({ tone: 'ok', text: `${count} deadline${count === 1 ? '' : 's'} saved to ${filename}` });
      });
    } else {
      setConsentOpen(true);
    }
  };

  const answerConsent = (allow: boolean) => {
    setConsentOpen(false);
    void run(async () => {
      const result = await exportController.toProvider(projectId, target as 'google' | 'outlook', allow, includes);
      setMessage({ tone: 'ok', text: result.message });
      setLinks(result.provider_links);
    });
  };

  const exportSheet = (kind: 'excel' | 'sheets') =>
    run(async () => {
      if (kind === 'excel') {
        const { count, filename } = await exportController.downloadXlsx(projectId, sections);
        setMessage({ tone: 'ok', text: `${count} records saved to ${filename}` });
      } else {
        const result = await exportController.toSheets(projectId, sections);
        setSheets(result);
        setMessage({ tone: 'ok', text: result.message });
      }
    });

  const toggleSection = (s: SpreadsheetSection) => setSections((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]));
  const providerName = target === 'google' ? 'Google Calendar' : 'Outlook Calendar';

  return (
    <Modal open={open} onClose={onClose} title={`Export · ${projectName}`} wide>
      <div className="space-y-5">
        <Segmented ariaLabel="Export type" value={tab} onChange={(t) => { setTab(t); reset(); }} options={[{ value: 'calendar', label: 'Calendar' }, { value: 'spreadsheet', label: 'Spreadsheet' }]} />
        {message ? <Alert tone={message.tone} onClose={() => setMessage(null)}>{message.text}</Alert> : null}

        {tab === 'calendar' ? (
          <div className="space-y-4">
            <fieldset className="space-y-2">
              <legend className="label">Include</legend>
              {([
                ['include_project_deadline', 'Project deadline'],
                ['include_task_due_dates', 'Task due dates'],
                ['include_soft_deadlines', 'Soft deadlines'],
              ] as [keyof CalendarIncludes, string][]).map(([key, label]) => (
                <label key={key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={includes[key]} onChange={(e) => setIncludes({ ...includes, [key]: e.target.checked })} /> {label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend className="label">Destination</legend>
              <div className="grid gap-2 sm:grid-cols-3">
                {([
                  ['ical', 'iCalendar (.ics)', 'Apple, Thunderbird, any app'],
                  ['google', 'Google Calendar', 'Requires your permission'],
                  ['outlook', 'Outlook', 'Requires your permission'],
                ] as [CalTarget, string, string][]).map(([value, label, hint]) => (
                  <button key={value} type="button" onClick={() => setTarget(value)} aria-pressed={target === value}
                    className={`rounded-lg border p-3 text-left ${target === value ? 'border-brand bg-brand/5' : 'border-line hover:bg-surface-2'}`}>
                    <span className="block text-sm font-semibold">{label}</span>
                    <span className="block text-xs text-muted">{hint}</span>
                  </button>
                ))}
              </div>
            </fieldset>
            {consentOpen ? (
              <div className="rounded-xl border border-brand/40 bg-brand/5 p-4" role="alertdialog" aria-label="Calendar permission">
                <p className="flex items-center gap-2 font-semibold"><Icon name="shield" /> Allow ProjectForge to add events to {providerName}?</p>
                <p className="mt-1 text-sm text-muted">Only the deadlines selected above are shared. Declining cancels the export and nothing leaves ProjectForge.</p>
                <div className="mt-3 flex gap-2">
                  <button type="button" className="btn-primary" onClick={() => answerConsent(true)}>Allow</button>
                  <button type="button" className="btn-secondary" onClick={() => answerConsent(false)}>Decline</button>
                </div>
              </div>
            ) : (
              <button type="button" className="btn-primary" onClick={exportCalendar} disabled={busy}>
                <Icon name="download" /> {busy ? 'Exporting…' : 'Export deadlines'}
              </button>
            )}
            {links.length > 0 ? (
              <ul className="divide-y divide-line rounded-lg border border-line">
                {links.map((l) => (
                  <li key={l.url} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{l.title}</span>
                      <span className="text-xs text-muted">{formatDateTime(l.starts_at)}</span>
                    </span>
                    <a href={l.url} target="_blank" rel="noopener noreferrer" className="btn-secondary shrink-0 py-1 text-xs">
                      Add <Icon name="external" className="h-3 w-3" />
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : (
          <div className="space-y-4">
            <fieldset className="grid gap-2 sm:grid-cols-2">
              <legend className="label">Sheets</legend>
              {SECTIONS.map((s) => {
                const locked = s.financial && !manager;
                return (
                  <label key={s.value} className={`flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm ${locked ? 'opacity-60' : ''}`}>
                    <input type="checkbox" disabled={locked} checked={!locked && sections.includes(s.value)} onChange={() => toggleSection(s.value)} />
                    {s.label}
                    {locked ? <span className="ml-auto flex items-center gap-1 text-xs text-muted"><Icon name="lock" className="h-3 w-3" /> Managers only</span> : null}
                  </label>
                );
              })}
            </fieldset>
            <p className="text-xs text-muted">Text that starts with = + - @ is saved as plain text so it can never run as a spreadsheet formula.</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn-primary" onClick={() => exportSheet('excel')} disabled={busy || sections.length === 0}>
                <Icon name="download" /> Download .xlsx
              </button>
              <button type="button" className="btn-secondary" onClick={() => exportSheet('sheets')} disabled={busy || sections.length === 0}>
                Prepare for Google Sheets
              </button>
            </div>
            {sheets ? (
              <div className="space-y-2">
                {sheets.sheets.map((s) => (
                  <details key={s.title} className="rounded-lg border border-line">
                    <summary className="cursor-pointer px-3 py-2 text-sm font-semibold">{s.title} · {s.values.length - 1} rows</summary>
                    <pre className="max-h-48 overflow-auto bg-surface-2 p-3 text-xs">{s.values.slice(0, 20).map((r) => r.join('\t')).join('\n')}</pre>
                  </details>
                ))}
              </div>
            ) : null}
          </div>
        )}
      </div>
    </Modal>
  );
}
