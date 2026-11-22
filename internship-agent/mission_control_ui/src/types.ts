// The shapes app_server.py returns. Keep in step with build_state() / unblock.py.

export interface Job {
  id: string;
  company: string;
  title: string;
  ats: string;
  url: string;
}

export interface Step {
  key: string;
  label: string;
  status: "done" | "active" | "todo" | "skipped";
}

export interface Metrics {
  applied: number;
  verified: number;
  unverified: number;
  inProgress: number;
  blocked: number;
  failed: number;
  remaining: number;
  target: number;
  progress: number;
}

export interface Tracker {
  total: number;
  target: number;
  remaining: number;
  byStatus: { status: string; count: number }[];
  pendingWrites: number;
  unconfirmed: number;
  error: string;
}

export interface Blitz {
  running: boolean;
  pid: number | null;
  started: string;
  paused: boolean;
  stopping: boolean;
  external: boolean;
  exit_code: number | null;
  command: string;
  limit: number | null;
}

export type UnblockKind = "question" | "captcha" | "login" | "code" | "receipt" | "workday" | "other";

export interface UnblockItem {
  id: string;
  job: Job;
  kind: UnblockKind;
  reason: string;
  detail: string;
  questions: string[];
  screenshot: string;
  status: "open" | "requeued" | "taken" | "confirmed" | "dismissed";
  created: string;
  updated: string;
}

export interface Activity {
  when: string;
  company: string;
  title: string;
  ats: string;
  url: string;
  status: string;
  reason: string;
  detail: string;
}

export interface Waiting {
  field: string;
  remaining: number;
  of: number;
}

export interface State {
  job: Job | null;
  step: string;
  message: string;
  updated: string;
  timed_out: boolean;
  unconfirmed: boolean;
  waiting: Waiting | null;
  captchas: number;
  phone: { enabled: boolean; connected: boolean; label: string; token: string; channel: string; user: string };
  steps: Step[];
  choices: { key: string; label: string }[];
  tracker: Tracker;
  metrics: Metrics;
  unblock: UnblockItem[];
  activity: Activity[];
  blitz: Blitz;
  log: string[];
  attention: string;
}

export type BlitzAction = "start" | "pause" | "resume" | "stop" | "force-stop";
export type UnblockAction = "retry" | "resume" | "confirm" | "dismiss";
