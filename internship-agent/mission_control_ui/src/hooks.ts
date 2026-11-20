import { useCallback, useEffect, useRef, useState } from "react";
import { fetchState } from "./api";
import type { State } from "./types";

/** /api/state every `intervalMs`, plus refresh() for right after a button press. */
export function usePolledState(intervalMs: number) {
  const [state, setState] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const alive = useRef(true);

  const refresh = useCallback(async () => {
    try {
      const next = await fetchState();
      if (alive.current) {
        setState(next);
        setOffline(false);
      }
    } catch {
      if (alive.current) setOffline(true); // server restarting: keep the last view
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), intervalMs);
    return () => {
      alive.current = false;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [intervalMs, refresh]);

  return { state, offline, refresh };
}

const MAX_LINES = 600;

/** The runner's log, live over server-sent events. EventSource reconnects by itself. */
export function useLogStream() {
  const [lines, setLines] = useState<string[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const source = new EventSource("/api/logs/stream");
    let pending: string[] = [];
    let flushTimer = 0;
    const flush = () => {
      flushTimer = 0;
      const batch = pending;
      pending = [];
      setLines((old) => [...old, ...batch].slice(-MAX_LINES));
    };
    source.onopen = () => {
      setConnected(true);
      setLines([]); // the server resends the recent lines on every (re)connect
    };
    source.onerror = () => setConnected(false);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        pending.push(JSON.parse(event.data) as string);
      } catch {
        return;
      }
      if (!flushTimer) flushTimer = window.setTimeout(flush, 120);
    };
    return () => {
      source.close();
      if (flushTimer) window.clearTimeout(flushTimer);
    };
  }, []);

  return { lines, connected };
}

let audio: AudioContext | null = null;

/** A short two-tone chime: a question, a blocker or a timeout needs the candidate. */
export function ring() {
  try {
    audio ??= new AudioContext();
    const ctx = audio;
    [0, 0.18].forEach((offset, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i === 0 ? 880 : 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.18, ctx.currentTime + offset + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + offset + 0.16);
      osc.connect(gain).connect(ctx.destination);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.18);
    });
  } catch {
    /* audio blocked until the first click: the page still shows it */
  }
}
