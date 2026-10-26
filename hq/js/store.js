// HQ's data: one JSON document in localStorage, checked field by field on the way in.
// The Canvas token is stored under its own key so export never includes it.

import { cleanCanvas } from './canvas.js';
import { STAGE_IDS, OUTCOMES } from './pipeline.js';
import { CATEGORIES } from './priority.js';
import { DAY_RE, TIME_RE } from './dates.js';
import { PATTERNS } from './problems.js';

export const STORE_KEY = 'hq:v1';
export const TOKEN_KEY = 'hq:canvas-token';
export const THEME_KEY = 'hq:theme';

const ID_RE = /^[\w-]{1,40}$/;
const SLUG_RE = /^[a-z0-9-]{1,100}$/;
const CATS = CATEGORIES.map((c) => c.id);
const OUTCOME_IDS = OUTCOMES.map((o) => o.id);
const PATTERN_IDS = PATTERNS.map((p) => p.id);

const str = (v, max = 300) => (typeof v === 'string' ? v.slice(0, max) : '');
const int = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};
const day = (v) => (DAY_RE.test(v || '') ? v : '');
const time = (v) => (TIME_RE.test(v || '') ? v : '');
const iso = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v.slice(0, 40) : '');
const https = (v) => (typeof v === 'string' && /^https:\/\/[^\s"'<>]+$/.test(v) ? v.slice(0, 500) : '');
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

export function defaultSettings() {
  return { name: '', canvasUrl: '', proxyUrl: '', dailyNew: 2, dailyReview: 3, interviewDate: '', interviewLabel: '', hidden: [] };
}

export function emptyStore() {
  return { version: 1, sample: false, settings: defaultSettings(), canvas: null, done: {}, tasks: [], apps: [],
    dsa: { problems: {}, log: {}, custom: [] } };
}

export function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function cleanSettings(s) {
  const d = defaultSettings();
  if (!s || typeof s !== 'object') return d;
  return {
    name: str(s.name, 60),
    canvasUrl: https(s.canvasUrl).replace(/\/+$/, ''),
    proxyUrl: https(s.proxyUrl).replace(/\/+$/, ''),
    dailyNew: int(s.dailyNew, 0, 10, d.dailyNew),
    dailyReview: int(s.dailyReview, 0, 20, d.dailyReview),
    interviewDate: day(s.interviewDate),
    interviewLabel: str(s.interviewLabel, 80),
    hidden: list(s.hidden, 60).filter((x) => typeof x === 'string' && /^\d{1,24}$/.test(x)),
  };
}

export function cleanTask(t) {
  if (!t || typeof t !== 'object') return null;
  const title = str(t.title, 200).trim();
  if (!title) return null;
  return {
    id: ID_RE.test(t.id) ? t.id : newId(), title, cat: CATS.includes(t.cat) ? t.cat : 'school',
    pri: [1, 2, 3].includes(t.pri) ? t.pri : 2, due: day(t.due), time: time(t.time), notes: str(t.notes, 1000),
    done: iso(t.done), created: iso(t.created) || new Date().toISOString(),
  };
}

export function cleanApp(a) {
  if (!a || typeof a !== 'object') return null;
  const company = str(a.company, 80).trim();
  if (!company) return null;
  const stage = STAGE_IDS.includes(a.stage) ? a.stage : 'wishlist';
  return {
    id: ID_RE.test(a.id) ? a.id : newId(), company, role: str(a.role, 120).trim(), url: https(a.url), stage,
    outcome: stage === 'closed' && OUTCOME_IDS.includes(a.outcome) ? a.outcome : '',
    applied: day(a.applied), next: str(a.next, 160).trim(), nextDue: day(a.nextDue), nextTime: time(a.nextTime),
    notes: str(a.notes, 2000),
    history: list(a.history, 50).filter((h) => h && STAGE_IDS.includes(h.stage) && iso(h.at)).map((h) => ({ stage: h.stage, at: iso(h.at) })),
    created: iso(a.created) || new Date().toISOString(), updated: iso(a.updated) || new Date().toISOString(),
  };
}

function cleanProblemState(s, depth = 0) {
  if (!s || typeof s !== 'object' || !['solved', 'attempted'].includes(s.st) || !DAY_RE.test(s.due || '')) return null;
  return {
    st: s.st, conf: int(s.conf, 0, 3, 0), step: int(s.step, 0, 5, 0), due: s.due,
    first: day(s.first) || s.due, last: day(s.last) || s.due, n: int(s.n, 0, 9999, 1),
    was: depth === 0 ? cleanProblemState(s.was, 1) : null,
  };
}

function cleanDsa(d) {
  const out = { problems: {}, log: {}, custom: [] };
  if (!d || typeof d !== 'object') return out;
  for (const [slug, s] of Object.entries(d.problems || {})) {
    const clean = SLUG_RE.test(slug) && cleanProblemState(s);
    if (clean) out.problems[slug] = clean;
  }
  for (const [k, n] of Object.entries(d.log || {})) if (DAY_RE.test(k) && int(n, 0, 999, 0) > 0) out.log[k] = int(n, 0, 999, 0);
  const seen = new Set();
  out.custom = list(d.custom, 300).filter((p) => p && SLUG_RE.test(p.slug) && !seen.has(p.slug) && seen.add(p.slug)
    && str(p.title, 120).trim() && PATTERN_IDS.includes(p.pattern)).map((p) => ({
    slug: p.slug, title: str(p.title, 120).trim(), diff: ['E', 'M', 'H'].includes(p.diff) ? p.diff : 'M',
    pattern: p.pattern, url: https(p.url),
  }));
  return out;
}

/** A complete, valid store from anything (a saved document, an import file, garbage). */
export function cleanStore(raw) {
  const s = emptyStore();
  if (!raw || typeof raw !== 'object') return s;
  s.sample = raw.sample === true;
  s.settings = cleanSettings(raw.settings);
  s.canvas = cleanCanvas(raw.canvas);
  for (const [k, v] of Object.entries(raw.done && typeof raw.done === 'object' ? raw.done : {})) {
    if (/^c:[\w:]{1,80}$/.test(k) && iso(v)) s.done[k] = iso(v);
  }
  const ids = new Set();
  const unique = (x) => x && !ids.has(x.id) && ids.add(x.id);
  s.tasks = list(raw.tasks, 2000).map(cleanTask).filter(unique);
  s.apps = list(raw.apps, 2000).map(cleanApp).filter(unique);
  s.dsa = cleanDsa(raw.dsa);
  return s;
}
