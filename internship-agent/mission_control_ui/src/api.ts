import type { BlitzAction, State, UnblockAction } from "./types";

export class ApiError extends Error {}

async function post<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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

export const gateChoice = (choice: string) => post<{ ok: boolean }>("/api/gate-choice", { choice });

export const resolveBlocker = (id: string, action: UnblockAction, answers?: Record<string, string>) =>
  post<{ ok: boolean; learned: number }>(`/api/unblock/${encodeURIComponent(id)}`, answers ? { action, answers } : { action });
