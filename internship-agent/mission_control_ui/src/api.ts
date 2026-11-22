import type { BlitzAction, RunOptions, State, UnblockAction } from "./types";

export class ApiError extends Error {}

/** The per-session token app_server.py put in this page; every POST /api/* must send it back. */
function sessionToken(): string {
  return document.querySelector<HTMLMetaElement>('meta[name="mission-token"]')?.content ?? "";
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Mission-Token": sessionToken() },
    body: JSON.stringify(body),
  });
  const data: unknown = await r.json().catch(() => ({}));
  if (!r.ok) {
    const message = (data as { error?: string }).error ?? `request failed (${r.status})`;
    throw new ApiError(message);
  }
  return data as T;
}

export async function fetchState(): Promise<State> {
  const r = await fetch("/api/state", { cache: "no-store" });
  if (!r.ok) throw new ApiError(`state request failed (${r.status})`);
  return (await r.json()) as State;
}

export const blitz = (action: BlitzAction, limit?: number) =>
  post<{ ok: boolean }>("/api/blitz", limit ? { action, limit } : { action });

export const runStart = (options: RunOptions) => post<{ ok: boolean }>("/api/run/start", options);
export const runStop = () => post<{ ok: boolean }>("/api/run/stop", {});
export const runForceStop = () => post<{ ok: boolean }>("/api/run/force-stop", {});
export const shutdownServer = () => post<{ ok: boolean; stopping_run: boolean }>("/api/shutdown", {});

export const gateChoice = (choice: string) => post<{ ok: boolean }>("/api/gate-choice", { choice });

export const resolveBlocker = (id: string, action: UnblockAction, answers?: Record<string, string>) =>
  post<{ ok: boolean; learned: number }>(`/api/unblock/${encodeURIComponent(id)}`, answers ? { action, answers } : { action });
