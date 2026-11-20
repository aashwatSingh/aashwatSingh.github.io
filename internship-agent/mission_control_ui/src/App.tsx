import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, blitz as blitzApi, gateChoice, resolveBlocker } from "./api";
import { ActivityFeed, Controls, CurrentJob, GoalTracker, LiveLog, UnblockQueue } from "./components";
import { ring, useLogStream, usePolledState } from "./hooks";
import type { BlitzAction, UnblockAction, UnblockItem } from "./types";

export default function App() {
  const { state, offline, refresh } = usePolledState(1500);
  const { lines, connected } = useLogStream();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const lastAlert = useRef("");

  // Ring once for each new thing that needs the candidate.
  useEffect(() => {
    if (!state) return;
    const open = state.unblock.filter((i) => i.status === "open").map((i) => i.id).join(",");
    const alert = [
      state.timed_out ? `timeout:${state.job?.id ?? ""}` : "",
      state.waiting ? `answer:${state.job?.id ?? ""}:${state.waiting.field}` : "",
      open,
    ].join("|");
    if (lastAlert.current && alert !== lastAlert.current && alert.replace(/\|/g, "")) ring();
    lastAlert.current = alert || "|";
  }, [state]);

  const run = useCallback(
    async (work: () => Promise<unknown>, done: string) => {
      setBusy(true);
      try {
        await work();
        setNotice({ text: done, tone: "ok" });
      } catch (e) {
        setNotice({ text: e instanceof ApiError ? e.message : "Mission Control is not reachable", tone: "bad" });
      } finally {
        setBusy(false);
        void refresh();
      }
    },
    [refresh],
  );

  const onAction = (action: BlitzAction, limit?: number) =>
    run(() => blitzApi(action, limit), action === "start" ? `Started a batch of ${limit ?? "all"}` : `${action} sent`);

  const onResolve = (item: UnblockItem, action: UnblockAction, answers?: Record<string, string>) => {
    if (action === "confirm" && !window.confirm(`Mark ${item.job.company} as submitted without a confirmation e-mail?`)) return;
    const done: Record<UnblockAction, string> = {
      retry: "Queued for retry",
      resume: "Answers saved; queued for retry",
      confirm: "Marked as submitted in the tracker",
      dismiss: "Dismissed",
    };
    void run(() => resolveBlocker(item.id, action, answers), `${item.job.company}: ${done[action]}`);
  };

  useEffect(() => {
    if (!notice) return;
    const t = window.setTimeout(() => setNotice(null), 5000);
    return () => window.clearTimeout(t);
  }, [notice]);

  if (!state) {
    return (
      <main>
        <h1>Mission Control</h1>
        <p className="dim">{offline ? "Cannot reach app_server.py. Is it running?" : "Loading..."}</p>
      </main>
    );
  }

  return (
    <main>
      <header>
        <h1>Mission Control</h1>
        <span className={`small ${offline ? "bad-text" : "dim"}`}>
          {offline ? "Server not reachable: showing the last view" : `Updated ${state.updated || "just now"}`}
        </span>
      </header>
      {notice && (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}
      <GoalTracker metrics={state.metrics} tracker={state.tracker} />
      <div className="grid">
        <div className="col">
          <Controls blitz={state.blitz} busy={busy} onAction={(a, l) => void onAction(a, l)} />
          <CurrentJob state={state} busy={busy} onChoice={(c) => void run(() => gateChoice(c), "Choice sent")} />
          <ActivityFeed items={state.activity} />
        </div>
        <div className="col">
          <UnblockQueue items={state.unblock} busy={busy} onResolve={onResolve} />
          <LiveLog lines={lines} connected={connected} />
        </div>
      </div>
    </main>
  );
}
