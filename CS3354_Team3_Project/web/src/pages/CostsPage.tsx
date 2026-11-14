/**
 * @author Jon Sorey - matches cost.html
 * @description The money screen for the current project. Owners and managers see four separate buckets -
 *   bid, budget, stage costs (Total / Subtotal) and expenses - which are never added together; members get
 *   the server's 403 "Access denied" and no figures at all. Bid and budget can be edited with exact-cent
 *   validation and a Retry banner if the save cannot reach the server.
 * @traces SE-FR-01, SE-FR-02, SE-FR-03, SE-NFR-01, SE-NFR-02, SE-NFR-04, UC-01
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ExpenseTable } from '../features/costs/ExpenseTable';
import { StageCostTable } from '../features/costs/StageCostTable';
import { costController } from '../features/costs/costController';
import { isValidAmount, normalizeAmount, subtractAmounts } from '../features/costs/model';
import { ProjectPicker, useProjectScope } from '../features/projects/ProjectScope';
import type { CostQuery, CostSummary } from '../shared/types';
import { formatMoney } from '../shared/format';
import { AccessDenied, Alert, Card, EmptyState, Field, PageHeader, RetryBanner, Spinner, StatCard } from '../shared/ui';
import { toApiError, useSave } from '../shared/useSave';

function FinancialsForm({ summary, projectId, onSaved }: { summary: CostSummary; projectId: string; onSaved: (s: CostSummary) => void }) {
  const [bid, setBid] = useState(summary.bid_amount);
  const [budget, setBudget] = useState(summary.budget_amount);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const save = useSave(() => costController.updateFinancials(projectId, { bid_amount: normalizeAmount(bid), budget_amount: normalizeAmount(budget) }), (s) => { onSaved(s); setSaved(true); });
  const submit = () => {
    const e: Record<string, string> = {};
    if (!isValidAmount(bid)) e.bid_amount = 'Enter 0 or more, e.g. 48500.00';
    if (!isValidAmount(budget)) e.budget_amount = 'Enter 0 or more, e.g. 42000.00';
    setErrors(e);
    setSaved(false);
    if (!Object.keys(e).length) void save.run();
  };
  return (
    <div className="space-y-3">
      <RetryBanner error={save.networkError} onRetry={save.retry} onCancel={save.cancel} busy={save.saving} />
      {save.error && !Object.keys(save.fieldErrors).length ? <Alert>{save.error.detail}</Alert> : null}
      {saved ? <Alert tone="ok" onClose={() => setSaved(false)}>Bid and budget saved.</Alert> : null}
      <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
        <Field label="Bid amount" error={errors.bid_amount ?? save.fieldErrors.bid_amount} htmlFor="fin-bid">
          <input id="fin-bid" className="input text-right tabular-nums" inputMode="decimal" value={bid} onChange={(e) => setBid(e.target.value)} />
        </Field>
        <Field label="Budget amount" error={errors.budget_amount ?? save.fieldErrors.budget_amount} htmlFor="fin-budget">
          <input id="fin-budget" className="input text-right tabular-nums" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
        </Field>
        <button type="button" className="btn-primary" onClick={submit} disabled={save.saving}>{save.saving ? 'Saving…' : 'Save'}</button>
      </div>
    </div>
  );
}

export function CostsPage() {
  const { currentProject, loading } = useProjectScope();
  const projectId = currentProject?.id;
  const [summary, setSummary] = useState<CostSummary | null>(null);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState<CostQuery>({ sort_by: 'expense_date', sort_dir: 'desc' });
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();

  const load = useCallback(async (q: CostQuery, sel: Set<string> | null) => {
    if (!projectId) return;
    try {
      const result = await costController.summary(projectId, { ...q, stage_ids: sel ? [...sel] : null });
      setSummary(result);
      setDenied(false);
      setError(null);
    } catch (err) {
      const e = toApiError(err);
      if (e.status === 403) {
        setDenied(true);
        setSummary(null);
      } else setError(e.detail);
    }
  }, [projectId]);

  useEffect(() => {
    setSummary(null);
    setSelected(null);
    setDenied(false);
    void load(query, null);
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  const onQuery = (q: CostQuery) => {
    setQuery(q);
    clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => void load(q, selected), q.search !== query.search ? 250 : 0);
  };

  const effectiveSelected = selected ?? new Set(summary?.stage_costs.map((s) => s.id) ?? []);
  const toggle = (id: string) => {
    const next = new Set(effectiveSelected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    const all = summary && next.size === summary.stage_costs.length;
    setSelected(all ? null : next);
    void load(query, all ? null : next);
  };
  const toggleAll = (all: boolean) => {
    const next = all ? null : new Set<string>();
    setSelected(next);
    void load(query, next);
  };

  if (loading) return <Spinner />;
  if (!currentProject) return <EmptyState title="No project selected" icon="dollar" />;

  return (
    <div>
      <PageHeader title="Cost" subtitle={`Bids, budgets, stage costs and expenses for ${currentProject.name}`} actions={<ProjectPicker />} />
      {denied ? (
        <AccessDenied title="Financial records are restricted">
          Only project owners and managers can view or edit bids, budgets, stage costs and expenses. Your role in “{currentProject.name}” is <strong>{currentProject.my_role}</strong>.
        </AccessDenied>
      ) : error ? (
        <Alert>{error}</Alert>
      ) : !summary ? (
        <Spinner label="Loading costs…" />
      ) : (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard label="Bid" value={formatMoney(summary.bid_amount, summary.currency)} icon="flag" tone="brand" hint="What we quoted the client" />
            <StatCard label="Budget" value={formatMoney(summary.budget_amount, summary.currency)} icon="target" tone="accent" hint={`${formatMoney(subtractAmounts(summary.budget_amount, summary.stage_cost_sum), summary.currency)} vs. stage costs`} />
            <StatCard label={`Stage costs · ${summary.sum_label}`} value={formatMoney(summary.stage_cost_sum, summary.currency)} icon="layout" tone="info" hint={`${summary.included_stage_ids.length} of ${summary.stage_costs.length} stages`} />
            <StatCard label="Expenses" value={formatMoney(summary.expense_total, summary.currency)} icon="dollar" tone="warn" hint={`${summary.expense_count} shown`} />
          </div>
          <p className="text-xs text-muted">These four figures are tracked separately and are never added together.</p>
          <Card title="Bid & budget">
            <FinancialsForm key={`${summary.bid_amount}-${summary.budget_amount}`} summary={summary} projectId={currentProject.id} onSaved={setSummary} />
          </Card>
          <Card title="Stage costs" actions={<span className="text-xs text-muted">Untick stages to see a subtotal</span>}>
            <StageCostTable projectId={currentProject.id} summary={summary} selected={effectiveSelected} onToggle={toggle} onToggleAll={toggleAll} onChanged={() => void load(query, selected)} />
          </Card>
          <Card title="Expenses">
            <ExpenseTable projectId={currentProject.id} summary={summary} query={query} onQuery={onQuery} onChanged={() => void load(query, selected)} />
          </Card>
        </div>
      )}
    </div>
  );
}
