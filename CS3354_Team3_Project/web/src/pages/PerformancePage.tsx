/**
 * @author Jon Sorey - matches charts.html
 * @description Performance and efficiency for a chosen date range. Owners and managers see the whole team;
 *   members see a "Only your hours" report built from their own records alone. Shows totals, a per-person
 *   estimated / assigned / actual chart, a weekly trend and per-task efficiency ("N/A" when no hours).
 * @traces SE-FR-05, SE-NFR-02, UC-02
 */
import { useCallback, useEffect, useState } from 'react';
import { ProjectPicker, useProjectScope } from '../features/projects/ProjectScope';
import { MemberHoursChart, TaskEfficiencyTable, WeeklyTrendChart } from '../features/reports/EfficiencyCharts';
import { formatEfficiency, reportController, validateRange } from '../features/reports/reportController';
import type { PerformanceReport } from '../shared/types';
import { todayIso } from '../shared/format';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner, StatCard } from '../shared/ui';
import { toApiError } from '../shared/useSave';

export function PerformancePage() {
  const { currentProject, loading } = useProjectScope();
  const [start, setStart] = useState(todayIso(-29));
  const [end, setEnd] = useState(todayIso());
  const [report, setReport] = useState<PerformanceReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!currentProject) return;
    const problem = validateRange(start, end);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      setReport(await reportController.performance(currentProject.id, start, end));
      setError(null);
    } catch (err) {
      setError(toApiError(err).detail);
    } finally {
      setBusy(false);
    }
  }, [currentProject, start, end]);

  useEffect(() => void load(), [currentProject?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) return <Spinner />;
  if (!currentProject) return <EmptyState title="No project selected" icon="chart" />;

  return (
    <div>
      <PageHeader
        title="Charts"
        subtitle={report ? (report.scope === 'team' ? 'Team-wide view of estimated, assigned and actual hours' : 'Only your own hours are included') : 'Performance and efficiency'}
        actions={<ProjectPicker />}
      />
      <div className="card mb-6 flex flex-wrap items-end gap-3 p-4">
        <label><span className="label">From</span><input type="date" className="input" value={start} max={end} onChange={(e) => setStart(e.target.value)} /></label>
        <label><span className="label">To</span><input type="date" className="input" value={end} min={start} onChange={(e) => setEnd(e.target.value)} /></label>
        <button type="button" className="btn-primary" onClick={() => void load()} disabled={busy}>{busy ? 'Loading…' : 'Update'}</button>
        {report ? <Badge tone={report.scope === 'team' ? 'brand' : 'warn'} icon={report.scope === 'team' ? 'users' : 'lock'} className="ml-auto">{report.scope === 'team' ? 'Team view' : 'Only your hours'}</Badge> : null}
      </div>
      {error ? <div className="mb-4"><Alert onClose={() => setError(null)}>{error}</Alert></div> : null}
      {!report ? <Spinner label="Building report…" /> : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Estimated" value={`${report.totals.estimated_hours.toFixed(2)} h`} icon="target" tone="brand" />
            <StatCard label="Assigned" value={`${report.totals.assigned_hours.toFixed(2)} h`} icon="users" tone="accent" />
            <StatCard label="Actual" value={`${report.totals.actual_hours.toFixed(2)} h`} icon="clock" tone="ok" hint={`${report.totals.tasks_done}/${report.totals.tasks_total} tasks done`} />
            <StatCard label="Efficiency" value={formatEfficiency(report.totals.efficiency_pct)} icon="chart" tone={report.totals.efficiency_pct === 'N/A' ? 'neutral' : report.totals.efficiency_pct >= 100 ? 'ok' : 'warn'} hint="Estimated ÷ actual × 100" />
          </div>
          <Card title={report.scope === 'team' ? 'Hours per person' : 'Your hours'}>
            {report.members.length ? <MemberHoursChart report={report} /> : <EmptyState title="No data in this range" icon="chart" />}
          </Card>
          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Actual hours per week"><WeeklyTrendChart report={report} /></Card>
            <Card title="Task efficiency" bodyClass="p-0"><TaskEfficiencyTable report={report} /></Card>
          </div>
        </div>
      )}
    </div>
  );
}
