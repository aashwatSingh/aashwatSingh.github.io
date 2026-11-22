import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, blitz as blitzApi, gateChoice, resolveBlocker, runForceStop, runStart, runStop, shutdownServer } from "./api";
import { ActionBar, ActivityFeed, CurrentJob, GoalTracker, LiveLog, UnblockQueue } from "./components";
import { ring, useLogStream, usePolledState } from "./hooks";
import type { BlitzAction, RunOptions, UnblockAction, UnblockItem } from "./types";

export default function App() {
  const { state, offline, refresh } = usePolledState(1500);
  const { lines, connected } = useLogStream();
  const [busy, setBusy] = useState(false);
  const [down, setDown] = useState(false);
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

  const onStart = (options: RunOptions) =>
    run(() => runStart(options), `Started ${options.limit ? `a batch of ${options.limit}` : "the whole queue"}${options.dry_run ? " (dry run)" : ""}`);

  const onAction = (action: BlitzAction) => {
    if (action === "stop") return run(runStop, "Stopping after the current application");
    if (action === "force-stop") return run(runForceStop, "Runner force-stopped");
    return run(() => blitzApi(action), `${action} sent`);
  };

  const onShutdown = () => {
    const warning = state?.blitz.running
      ? "A run is going. Shut Down finishes the current application, then stops the runner and the server. Continue?"
      : "Shut down the Mission Control server?";
    if (!window.confirm(warning)) return;
    void run(async () => {
      await shutdownServer();
      setDown(true);
    }, "Shutting down...");
  };

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

  if (down) {
    return (
      <main>
        <h1>Mission Control</h1>
        <p className="dim">Shut down. You can close this tab. Open the SWE Internship Agent shortcut to start it again.</p>
      </main>
    );
  }

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
        <span className="small dim">
          <span className={`phone-badge ${state.phone.connected ? "on" : state.phone.enabled ? "warn" : "off"}`}>
            Phone Assist: {state.phone.label}
          </span>{" "}
          <span className={offline ? "bad-text" : ""}>
            {offline ? "Server not reachable: showing the last view" : `Updated ${state.updated || "just now"}`}
          </span>{" "}
          <button type="button" className="quiet" disabled={busy} onClick={onShutdown}>
            Shut Down Server
          </button>
        </span>
      </header>
      {notice && (
        <div className={`toast ${notice.tone}`} role="status">
          {notice.text}
        </div>
      )}
      <ActionBar blitz={state.blitz} busy={busy} onStart={(o) => void onStart(o)} onAction={(a) => void onAction(a)} />
      <GoalTracker metrics={state.metrics} tracker={state.tracker} />
      <div className="grid">
        <div className="col">
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
