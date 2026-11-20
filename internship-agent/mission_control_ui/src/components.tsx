import { useEffect, useRef, useState, type FormEvent } from "react";
import { reasonLabel } from "./labels";
import type { Activity, Blitz, BlitzAction, Metrics, State, Tracker, UnblockAction, UnblockItem } from "./types";

function fmtTime(stamp: string) {
  const t = stamp.replace("T", " ");
  return t.length >= 16 ? t.slice(5, 16) : t;
}

/* ---- goal tracker --------------------------------------------------------------------- */

export function GoalTracker({ metrics, tracker }: { metrics: Metrics; tracker: Tracker }) {
  const pct = Math.round(metrics.progress * 1000) / 10;
  const tiles: { label: string; value: number; tone?: string; hint: string }[] = [
    { label: "Applied", value: metrics.applied, tone: "accent", hint: "rows in internship_tracker.xlsx (Unverified rows excluded)" },
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
      {(tracker.error || tracker.pendingWrites > 0 || metrics.unverified > 0) && (
        <p className="note">
          {[
            tracker.error,
            tracker.pendingWrites > 0 && `${tracker.pendingWrites} waiting to be written (close the workbook in Excel)`,
            metrics.unverified > 0 && `${metrics.unverified} marked "Unverified / Needs Check" in the tracker`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      )}
    </section>
  );
}

/* ---- batch controls ------------------------------------------------------------------- */

const BATCH_KEY = "mc.batchSize";

export function Controls({ blitz, busy, onAction }: {
  blitz: Blitz;
  busy: boolean;
  onAction: (action: BlitzAction, limit?: number) => void;
}) {
  const [size, setSize] = useState(() => window.localStorage.getItem(BATCH_KEY) ?? "25");
  const valid = /^\d+$/.test(size) && Number(size) >= 1 && Number(size) <= 500;
  const save = (v: string) => {
    setSize(v);
    window.localStorage.setItem(BATCH_KEY, v);
  };
  const status = !blitz.running
    ? blitz.exit_code !== null
      ? `Last run ended (exit code ${blitz.exit_code}).`
      : "No run is going."
    : blitz.stopping
      ? "Stopping after the current application..."
      : blitz.paused
        ? "Paused: no new application starts until you resume."
        : `Running${blitz.limit ? ` a batch of ${blitz.limit}` : ""}${blitz.external ? " (started from a terminal)" : ""} since ${blitz.started}.`;
  const start = (e: FormEvent) => {
    e.preventDefault();
    if (valid) onAction("start", Number(size));
  };
  return (
    <section className="card" aria-label="Batch controls">
      <h3>Batch</h3>
      <form className="controls" onSubmit={start}>
        <label className="size">
          Applications
          <input
            type="number"
            min={1}
            max={500}
            value={size}
            onChange={(e) => save(e.target.value)}
            disabled={blitz.running}
            aria-invalid={!valid}
          />
        </label>
        <button type="submit" className="primary" disabled={busy || blitz.running || !valid}>
          Start
        </button>
        {blitz.paused ? (
          <button type="button" disabled={busy || !blitz.running} onClick={() => onAction("resume")}>
            Resume
          </button>
        ) : (
          <button type="button" disabled={busy || !blitz.running || blitz.stopping} onClick={() => onAction("pause")}>
            Pause
          </button>
        )}
        <button type="button" disabled={busy || !blitz.running || blitz.stopping} onClick={() => onAction("stop")}>
          Stop
        </button>
        <button
          type="button"
          className="danger"
          disabled={busy || !blitz.running}
          onClick={() => {
            if (window.confirm("Force-stop ends the runner immediately, even mid-application. Continue?")) onAction("force-stop");
          }}
        >
          Force stop
        </button>
      </form>
      <p className="dim small">{status}</p>
      <p className="dim small mono">{blitz.command}</p>
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
