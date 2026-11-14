/**
 * @author Jon Sorey
 * @description Charts for charts.html, drawn as plain SVG: grouped bars of estimated / assigned / actual
 *   hours per person, a weekly actual-hours trend, and an efficiency table. Series are told apart by
 *   pattern and labels as well as color, and every chart has a text alternative for screen readers.
 * @traces SE-FR-05, SE-NFR-02, UC-02, SE-FR-15
 */
import type { PerformanceReport } from '../../shared/types';
import { formatDate } from '../../shared/format';
import { Badge } from '../../shared/ui';
import { formatEfficiency } from './reportController';

const SERIES = [
  { key: 'estimated_hours' as const, label: 'Estimated', color: 'rgb(var(--c-brand))', pattern: '' },
  { key: 'assigned_hours' as const, label: 'Assigned', color: 'rgb(var(--c-accent))', pattern: 'url(#hatch)' },
  { key: 'actual_hours' as const, label: 'Actual', color: 'rgb(var(--c-ok))', pattern: 'url(#dots)' },
];

function niceMax(value: number): number {
  if (value <= 0) return 5;
  const pow = 10 ** Math.floor(Math.log10(value));
  return Math.ceil(value / pow) * pow;
}

function Patterns() {
  return (
    <defs>
      <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="6" height="6" fill="rgb(var(--c-accent))" />
        <line x1="0" y1="0" x2="0" y2="6" stroke="rgb(var(--c-surface))" strokeWidth="2" opacity="0.6" />
      </pattern>
      <pattern id="dots" width="6" height="6" patternUnits="userSpaceOnUse">
        <rect width="6" height="6" fill="rgb(var(--c-ok))" />
        <circle cx="3" cy="3" r="1.2" fill="rgb(var(--c-surface))" opacity="0.7" />
      </pattern>
    </defs>
  );
}

export function MemberHoursChart({ report }: { report: PerformanceReport }) {
  const rows = report.members;
  const max = niceMax(Math.max(0, ...rows.flatMap((r) => [r.estimated_hours, r.assigned_hours, r.actual_hours])));
  const height = 240;
  const groupWidth = 96;
  const width = Math.max(360, rows.length * groupWidth + 56);
  const plotH = height - 48;
  const barW = 20;
  const summary = rows.map((r) => `${r.display_name}: estimated ${r.estimated_hours}, assigned ${r.assigned_hours}, actual ${r.actual_hours} hours`).join('; ');
  return (
    <figure>
      <div className="mb-2 flex flex-wrap gap-3 text-xs">
        {SERIES.map((s) => (
          <span key={s.key} className="flex items-center gap-1.5">
            <svg width="14" height="14" aria-hidden><Patterns /><rect width="14" height="14" rx="3" fill={s.pattern || s.color} /></svg>
            {s.label}
          </span>
        ))}
      </div>
      <div className="overflow-x-auto">
        <svg width={width} height={height} role="img" aria-label={`Hours per person. ${summary}`}>
          <Patterns />
          {[0, 0.25, 0.5, 0.75, 1].map((f) => {
            const y = 8 + plotH - f * plotH;
            return (
              <g key={f}>
                <line x1={40} x2={width} y1={y} y2={y} stroke="rgb(var(--c-line))" strokeDasharray="3 3" />
                <text x={34} y={y + 4} fontSize="10" textAnchor="end" fill="rgb(var(--c-muted))">{(max * f).toFixed(0)}</text>
              </g>
            );
          })}
          {rows.map((r, gi) => {
            const gx = 52 + gi * groupWidth;
            return (
              <g key={r.user_id}>
                {SERIES.map((s, si) => {
                  const value = r[s.key];
                  const h = (value / max) * plotH;
                  return (
                    <g key={s.key}>
                      <rect x={gx + si * (barW + 4)} y={8 + plotH - h} width={barW} height={Math.max(0, h)} rx={3} fill={s.pattern || s.color}>
                        <title>{`${r.display_name} · ${s.label}: ${value.toFixed(2)} h`}</title>
                      </rect>
                      {value > 0 ? <text x={gx + si * (barW + 4) + barW / 2} y={8 + plotH - h - 4} fontSize="9" textAnchor="middle" fill="rgb(var(--c-muted))">{value.toFixed(1)}</text> : null}
                    </g>
                  );
                })}
                <text x={gx + (3 * barW + 8) / 2} y={height - 18} fontSize="11" textAnchor="middle" fill="rgb(var(--c-ink))">{r.username}</text>
                <text x={gx + (3 * barW + 8) / 2} y={height - 4} fontSize="10" textAnchor="middle" fill="rgb(var(--c-muted))">{formatEfficiency(r.efficiency_pct)}</text>
              </g>
            );
          })}
        </svg>
      </div>
      <figcaption className="sr-only">{summary}</figcaption>
    </figure>
  );
}

export function WeeklyTrendChart({ report }: { report: PerformanceReport }) {
  const points = report.weekly;
  const max = niceMax(Math.max(0, ...points.map((p) => p.actual_hours)));
  const width = Math.max(360, points.length * 72);
  const height = 180;
  const plotH = height - 40;
  const step = points.length > 1 ? (width - 60) / (points.length - 1) : 0;
  const coords = points.map((p, i) => ({ x: 40 + i * step, y: 8 + plotH - (p.actual_hours / max) * plotH, p }));
  const path = coords.map((c, i) => `${i === 0 ? 'M' : 'L'}${c.x},${c.y}`).join(' ');
  const label = points.map((p) => `Week of ${formatDate(p.week_start + 'T12:00:00')}: ${p.actual_hours} hours`).join('; ');
  return (
    <div className="overflow-x-auto">
      <svg width={width} height={height} role="img" aria-label={`Actual hours per week. ${label}`}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={36} x2={width} y1={8 + plotH - f * plotH} y2={8 + plotH - f * plotH} stroke="rgb(var(--c-line))" strokeDasharray="3 3" />
        ))}
        <path d={path} fill="none" stroke="rgb(var(--c-brand))" strokeWidth={2.5} />
        {coords.map((c) => (
          <g key={c.p.week_start}>
            <rect x={c.x - 4} y={c.y - 4} width={8} height={8} fill="rgb(var(--c-surface))" stroke="rgb(var(--c-brand))" strokeWidth={2}>
              <title>{`${c.p.actual_hours.toFixed(2)} h`}</title>
            </rect>
            <text x={c.x} y={height - 8} fontSize="10" textAnchor="middle" fill="rgb(var(--c-muted))">{formatDate(c.p.week_start + 'T12:00:00', { year: undefined })}</text>
            <text x={c.x} y={c.y - 9} fontSize="9" textAnchor="middle" fill="rgb(var(--c-muted))">{c.p.actual_hours.toFixed(1)}</text>
          </g>
        ))}
      </svg>
    </div>
  );
}

export function TaskEfficiencyTable({ report }: { report: PerformanceReport }) {
  if (report.tasks.length === 0) return <p className="py-6 text-center text-sm text-muted">No tasks with estimates or logged hours in this range.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead className="bg-surface-2">
          <tr>
            <th className="table-head">Task</th>
            <th className="table-head">Assignee</th>
            <th className="table-head text-right">Estimated</th>
            <th className="table-head text-right">Actual</th>
            <th className="table-head text-right">Efficiency</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.tasks.map((t) => {
            const eff = t.efficiency_pct;
            const tone = eff === 'N/A' ? 'neutral' : eff >= 100 ? 'ok' : eff >= 75 ? 'warn' : 'danger';
            return (
              <tr key={t.task_id}>
                <td className="table-cell font-medium">{t.title}</td>
                <td className="table-cell text-muted">{t.assignee_username ? `@${t.assignee_username}` : '—'}</td>
                <td className="table-cell text-right tabular-nums">{t.estimated_hours == null ? '—' : t.estimated_hours.toFixed(2)}</td>
                <td className="table-cell text-right tabular-nums">{t.actual_hours.toFixed(2)}</td>
                <td className="table-cell text-right"><Badge tone={tone} icon={eff === 'N/A' ? 'info' : eff >= 100 ? 'check' : 'alert'}>{formatEfficiency(eff)}</Badge></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
