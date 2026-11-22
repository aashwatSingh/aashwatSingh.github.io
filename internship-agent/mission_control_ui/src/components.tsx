import { useEffect, useRef, useState, type FormEvent } from "react";
import { reasonLabel } from "./labels";
import type { Activity, Blitz, BlitzAction, Metrics, RunOptions, State, Tracker, UnblockAction, UnblockItem } from "./types";

function fmtTime(stamp: string) {
  const t = stamp.replace("T", " ");
  return t.length >= 16 ? t.slice(5, 16) : t;
}

/* ---- goal tracker --------------------------------------------------------------------- */

export function GoalTracker({ metrics, tracker }: { metrics: Metrics; tracker: Tracker }) {
  const pct = Math.round(metrics.progress * 1000) / 10;
  const tiles: { label: string; value: number; tone?: string; hint: string }[] = [
    { label: "Applied", value: metrics.applied, tone: "accent", hint: "rows in internship_tracker.xlsx, every status (the sheet's own count)" },
    { label: "E-mail verified", value: metrics.verified, tone: "ok", hint: "confirmed by a receipt e-mail" },
    { label: "In the queue", value: metrics.inProgress, hint: "pending postings in job_queue.json" },
    { label: "Needs action", value: metrics.blocked, tone: metrics.blocked ? "warn" : undefined, hint: "open items in the Unblock Queue" },
    { label: "Failed", value: metrics.failed, tone: metrics.failed ? "bad" : undefined, hint: "postings that ended in an error" },
    { label: "Remaining", value: metrics.remaining, hint: `to the goal of ${metrics.target}` },
  ];
  return (
    <section className="card goal" aria-label="Application goal">
      <div className="goal-head">
        <h2>
          {metrics.applied} <span className="dim">/ {metrics.target} applications</span>
        </h2>
        <span className="dim">{pct}%</span>
      </div>
      <div
        className="bar"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={metrics.target}
        aria-valuenow={metrics.applied}
        aria-label="Applications toward the goal"
      >
        <div className="fill" style={{ width: `${Math.min(pct, 100)}%` }} />
      </div>
      <div className="tiles">
        {tiles.map((t) => (
          <div key={t.label} className={`tile ${t.tone ?? ""}`} title={t.hint}>
            <div className="num">{t.value}</div>
            <div className="lbl">{t.label}</div>
          </div>
        ))}
      </div>
      {(tracker.error || tracker.pendingWrites > 0 || metrics.unverified > 0 || tracker.duplicates?.length > 0 ||
        tracker.formulaIssues?.length > 0) && (
        <p className="note">
          {[
            tracker.error,
            tracker.pendingWrites > 0 && `${tracker.pendingWrites} waiting to be written (close the workbook in Excel)`,
            metrics.unverified > 0 && `${metrics.unverified} marked "Unverified / Needs Check" (counted: they are rows)`,
            tracker.duplicates?.length > 0 &&
              `${tracker.duplicates.length} company + role pair(s) appear twice (kept in the count): ` +
                tracker.duplicates.slice(0, 3).map((d) => `${d.company} (rows ${d.rows.join(", ")})`).join("; "),
            tracker.formulaIssues?.length > 0 && `Summary formula: ${tracker.formulaIssues[0]}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

/* ---- Start Applying ------------------------------------------------------------------- */

const OPTIONS_KEY = "mc.run.options";
const ATS_OPTIONS: [string, string][] = [
  ["all", "All"],
  ["greenhouse", "Greenhouse"],
  ["ashby", "Ashby"],
  ["lever", "Lever"],
  ["workday", "Workday"],
];

interface RunForm {
  limit: string;
  perCompany: string;
  dryRun: boolean;
  ats: string;
}
const DEFAULT_FORM: RunForm = { limit: "20", perCompany: "3", dryRun: false, ats: "all" };

function loadForm(): RunForm {
  try {
    const saved = JSON.parse(window.localStorage.getItem(OPTIONS_KEY) ?? "{}") as Partial<RunForm>;
    return {
      limit: typeof saved.limit === "string" ? saved.limit : DEFAULT_FORM.limit,
      perCompany: typeof saved.perCompany === "string" ? saved.perCompany : DEFAULT_FORM.perCompany,
      dryRun: saved.dryRun === true,
      ats: ATS_OPTIONS.some(([key]) => key === saved.ats) ? (saved.ats as string) : DEFAULT_FORM.ats,
    };
  } catch {
    return DEFAULT_FORM;
  }
}

/** The one-click bar: Start Applying and its options, then Pause / Stop After Current Job / Force Stop while a run is going. */
export function ActionBar({ blitz, busy, onStart, onAction }: {
  blitz: Blitz;
  busy: boolean;
  onStart: (options: RunOptions) => void;
  onAction: (action: BlitzAction) => void;
}) {
  const [form, setForm] = useState<RunForm>(loadForm);
  const limit = form.limit.trim();
  const limitOk = limit === "" || (/^\d+$/.test(limit) && Number(limit) >= 1 && Number(limit) <= 500);
  const perOk = /^\d+$/.test(form.perCompany) && Number(form.perCompany) >= 1 && Number(form.perCompany) <= 50;
  const valid = limitOk && perOk;
  const change = (patch: Partial<RunForm>) => {
    const next = { ...form, ...patch };
    setForm(next);
    window.localStorage.setItem(OPTIONS_KEY, JSON.stringify(next));
  };
  const status = !blitz.running
    ? blitz.exit_code !== null
      ? `Last run ended (exit code ${blitz.exit_code}).`
      : "Ready. Nothing is running."
    : blitz.stopping
      ? "Stopping after the current application finishes..."
      : blitz.paused
        ? "Paused: no new application starts until you resume."
        : `Running${blitz.limit ? ` a batch of ${blitz.limit}` : " the whole queue"}${blitz.dry_run ? " (dry run: nothing is submitted)" : ""}` +
          `${blitz.ats ? `, ${blitz.ats} only` : ""}${blitz.external ? " (started from a terminal)" : ""} since ${blitz.started}.`;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onStart({
      limit: limit === "" ? null : Number(limit),
      dedup_level: "role",
      max_per_company: Number(form.perCompany),
      dry_run: form.dryRun,
      ats: form.ats === "all" ? null : form.ats,
    });
  };
  return (
    <section className="card action-bar" aria-label="Start applying">
      {blitz.excel_locked && !blitz.running && (
        <div className="banner bad" role="alert">
          internship_tracker.xlsx is open in Excel — close it before starting
        </div>
      )}
      <form className="controls" onSubmit={submit}>
        <button type="submit" className="primary start" disabled={busy || blitz.running || !valid}>
          {blitz.running ? (
            <>
              <span className="spinner" aria-hidden="true" /> Running...
            </>
          ) : (
            "Start Applying"
          )}
        </button>
        <label className="size">
          Limit
          <input
            type="number"
            min={1}
            max={500}
            placeholder="all"
            value={form.limit}
            onChange={(e) => change({ limit: e.target.value })}
            disabled={blitz.running}
            aria-invalid={!limitOk}
          />
        </label>
        <label className="size">
          Max/Company
          <input
            type="number"
            min={1}
            max={50}
            value={form.perCompany}
            onChange={(e) => change({ perCompany: e.target.value })}
            disabled={blitz.running}
            aria-invalid={!perOk}
          />
        </label>
        <label className="size">
          ATS
          <select value={form.ats} onChange={(e) => change({ ats: e.target.value })} disabled={blitz.running}>
            {ATS_OPTIONS.map(([key, label]) => (
              <option key={key} value={key}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="check">
          <input type="checkbox" checked={form.dryRun} onChange={(e) => change({ dryRun: e.target.checked })} disabled={blitz.running} />
          Dry Run
        </label>
        {blitz.running && (
          <>
            {blitz.paused ? (
              <button type="button" disabled={busy} onClick={() => onAction("resume")}>
                Resume
              </button>
            ) : (
              <button type="button" disabled={busy || blitz.stopping} onClick={() => onAction("pause")}>
                Pause
              </button>
            )}
            <button type="button" disabled={busy || blitz.stopping} onClick={() => onAction("stop")}>
              Stop After Current Job
            </button>
            <button
              type="button"
              className="danger"
              disabled={busy}
              onClick={() => {
                if (window.confirm("Force Stop ends the runner immediately, even in the middle of an application. Continue?")) onAction("force-stop");
              }}
            >
              Force Stop
            </button>
          </>
        )}
      </form>
      <p className="dim small" role="status">
        {status}
      </p>
    </section>
  );
}

/* ---- the posting being worked on -------------------------------------------------------- */

export function CurrentJob({ state, busy, onChoice }: { state: State; busy: boolean; onChoice: (key: string) => void }) {
  if (!state.job) {
    return (
      <section className="card" aria-label="Current application">
        <h3>Now</h3>
        <p className="dim">{state.message || "The runner is not working on a posting."}</p>
      </section>
    );
  }
  return (
    <section className="card" aria-label="Current application">
      <h3>Now</h3>
      <div className="job-title">{state.job.title || "Application"}</div>
      <div className="dim small">{[state.job.company, state.job.ats].filter(Boolean).join(" · ")}</div>
      <ol className="steps">
        {state.steps.map((s) => (
          <li key={s.key} className={s.status} aria-current={s.status === "active" ? "step" : undefined}>
            <span className="dot" aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ol>
      {state.waiting && (
        <div className="callout purple" role="status">
          <strong>Needs your answer in the browser</strong>
          <div>{state.waiting.field}</div>
          <div className="dim small">
            Fill the highlighted field and click outside it. The form continues by itself
            {state.waiting.remaining > 1 ? ` (${state.waiting.remaining} questions left).` : "."}
          </div>
        </div>
      )}
      {state.timed_out && (
        <div className="callout warn" role="alert">
          <div>{state.message}</div>
          <div className="actions">
            {state.choices.map((c) => (
              <button key={c.key} disabled={busy} className={c.key === "wait" ? "primary" : ""} onClick={() => onChoice(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      )}
      {!state.waiting && !state.timed_out && state.message && <p className="dim small">{state.message}</p>}
    </section>
  );
}

/* ---- unblock queue ---------------------------------------------------------------------- */

function BlockerCard({ item, busy, onResolve }: {
  item: UnblockItem;
  busy: boolean;
  onResolve: (item: UnblockItem, action: UnblockAction, answers?: Record<string, string>) => void;
}) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const typed = Object.values(answers).some((v) => v.trim());
  const queued = item.status === "requeued";
  const submitAnswers = (e: FormEvent) => {
    e.preventDefault();
    if (typed) onResolve(item, "resume", answers);
  };
  return (
    <li className={`blocker ${item.kind}`}>
      <div className="blocker-head">
        <div>
          <div className="job-title">
            {item.job.company} <span className="dim">— {item.job.title}</span>
          </div>
          <div className="small">
            <span className="badge">{item.job.ats || "ATS"}</span> {reasonLabel(item.reason)}
            <span className="dim"> · {fmtTime(item.updated)}</span>
          </div>
        </div>
        {item.job.url && (
          <a className="small" href={item.job.url} target="_blank" rel="noopener noreferrer">
            Open posting
          </a>
        )}
      </div>
      {item.detail && <p className="dim small detail">{item.detail}</p>}
      {queued ? (
        <div className="actions">
          <span className="small ok-text">Queued for retry: the runner picks it up next.</span>
          <button className="quiet" disabled={busy} onClick={() => onResolve(item, "dismiss")}>
            Cancel retry
          </button>
        </div>
      ) : (
        <>
          {item.kind === "question" && item.questions.length > 0 && (
            <form className="answers" onSubmit={submitAnswers}>
              {item.questions.map((q) => (
                <label key={q}>
                  <span>{q}</span>
                  <textarea
                    rows={q.length > 90 ? 3 : 1}
                    value={answers[q] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [q]: e.target.value })}
                    maxLength={2000}
                  />
                </label>
              ))}
              <div className="actions">
                <button type="submit" className="primary" disabled={busy || !typed}>
                  Save answers &amp; retry
                </button>
                <span className="dim small">Saved to custom_answers.json and reused on later forms.</span>
              </div>
            </form>
          )}
          <div className="actions">
            {item.kind === "receipt" ? (
              <>
                <button className="primary" disabled={busy} onClick={() => onResolve(item, "confirm")}>
                  Confirm submitted
                </button>
                <button disabled={busy} onClick={() => onResolve(item, "retry")}>
                  Retry
                </button>
              </>
            ) : (
              <button disabled={busy} onClick={() => onResolve(item, "retry")}>
                {item.kind === "question" ? "Retry without answers" : "Resume after manual fix"}
              </button>
            )}
            <button className="quiet" disabled={busy} onClick={() => onResolve(item, "dismiss")}>
              Dismiss
            </button>
          </div>
        </>
      )}
    </li>
  );
}

export function UnblockQueue({ items, busy, onResolve }: {
  items: UnblockItem[];
  busy: boolean;
  onResolve: (item: UnblockItem, action: UnblockAction, answers?: Record<string, string>) => void;
}) {
  const open = items.filter((i) => i.status === "open").length;
  return (
    <section className="card" aria-label="Unblock queue">
      <h3>
        Unblock queue {open > 0 && <span className="count warn-text">{open}</span>}
      </h3>
      {items.length === 0 ? (
        <p className="dim">Nothing is waiting on you.</p>
      ) : (
        <ul className="blockers">
          {items.map((item) => (
            <BlockerCard key={item.id} item={item} busy={busy} onResolve={onResolve} />
          ))}
        </ul>
      )}
    </section>
  );
}

/* ---- recent results and the live log ---------------------------------------------------- */

const STATUS_TONE: Record<string, string> = {
  submitted: "ok",
  dry_run_ok: "ok",
  manual_review: "warn",
  error: "bad",
  skipped_ineligible: "dim",
  closed: "dim",
};

export function ActivityFeed({ items }: { items: Activity[] }) {
  return (
    <section className="card" aria-label="Recent activity">
      <h3>Recent activity</h3>
      {items.length === 0 ? (
        <p className="dim">No applications logged yet.</p>
      ) : (
        <ul className="activity">
          {items.map((a) => (
            <li key={`${a.when}-${a.url}`}>
              <span className={`pill ${STATUS_TONE[a.status] ?? ""}`}>{a.status.replace(/_/g, " ")}</span>
              <span className="grow">
                <strong>{a.company}</strong> <span className="dim">{a.title}</span>
                {a.reason && <span className="dim small"> · {reasonLabel(a.reason)}</span>}
              </span>
              <span className="dim small">{fmtTime(a.when)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function LiveLog({ lines, connected }: { lines: string[]; connected: boolean }) {
  const box = useRef<HTMLPreElement>(null);
  const [follow, setFollow] = useState(true);
  useEffect(() => {
    if (follow && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [lines, follow]);
  return (
    <section className="card" aria-label="Live log">
      <h3>
        Live log <span className={`small ${connected ? "ok-text" : "dim"}`}>{connected ? "● live" : "○ reconnecting"}</span>
      </h3>
      <pre
        ref={box}
        className="log"
        tabIndex={0}
        onScroll={(e) => {
          const el = e.currentTarget;
          setFollow(el.scrollHeight - el.scrollTop - el.clientHeight < 24);
        }}
      >
        {lines.length ? lines.join("\n") : "Waiting for the runner's output..."}
      </pre>
    </section>
  );
}
