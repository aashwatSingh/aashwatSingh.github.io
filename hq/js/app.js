import {
  canvasGet, pullCanvas, unpackPayload, cleanCanvas, bookmarklet, canvasItems, courseSummaries,
} from './canvas.js';
import { rank, scoreItem, taskItems, weekAhead, bucketOf, BUCKETS, CATEGORIES, isOpen, isActionable } from './priority.js';
import { STAGES, OUTCOMES, setStage, pipelineStats, pipelineItems, defaultNext, stageSince, quietApps } from './pipeline.js';
import { PATTERNS, DIFFICULTY } from './problems.js';
import { allProblems, practice, undo, todaysSet, patternProgress, readiness, dsaItem, CONFIDENCE } from './dsa.js';
import { STORE_KEY, TOKEN_KEY, THEME_KEY, cleanStore, emptyStore, defaultSettings, newId, cleanTask, cleanApp } from './store.js';
import { sampleStore } from './sample.js';
import { connectExtension, extensionZip, EXT_VERSION, olderThan } from './bridge.js';
import { HOUR, keyOf, addDays, daysBetween, practiceDay, dateOf } from './dates.js';
import { streaks, heatmap } from '../../hamza/insights.js';
import { todayKey as lockinToday, dayStatus } from '../../lockin/logic.js';

const LOCKIN_KEY = 'lockin:v1';
const TAB_KEY = 'hq:tab';
const TABS = ['today', 'school', 'intern', 'dsa'];
const AUTO_SYNC_MS = 30 * 60e3;
// With the extension, opening HQ always syncs unless it synced in the last two minutes.
const EXT_SYNC_MS = 2 * 60e3;

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ICON = {
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
  link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
};

const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });

// ---------------------------------------------------------------- storage

let store = emptyStore();
let storageOk = true;
let tab = 'today';
const ui = { taskFilter: 'all', course: 'all', showDone: false, showAll: false, open: new Set(), syncing: false, syncError: '', loggedOut: false };
let ext = { present: false, version: '', sync: async () => ({ ok: false }) };
let lastItems = new Map();

function load() {
  let raw = null;
  try {
    raw = localStorage.getItem(STORE_KEY);
    localStorage.setItem(`${STORE_KEY}:probe`, '1');
    localStorage.removeItem(`${STORE_KEY}:probe`);
  } catch {
    storageOk = false;
  }
  let data = null;
  try { data = raw ? JSON.parse(raw) : null; } catch { /* a damaged save starts fresh */ }
  store = cleanStore(data);
}

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    storageOk = false;
  }
  $('#storage-warning').hidden = storageOk;
}

function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}

function setToken(t) {
  try { if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY); } catch { storageOk = false; }
}

// ---------------------------------------------------------------- formatting

const endOfDay = (ms) => { const d = new Date(ms); return d.getHours() === 23 && d.getMinutes() === 59; };

/** "today 7:00 PM", "tomorrow", "Wed 9:00 AM", "Nov 4". Canvas's 11:59 PM reads as just the day. */
function when(ms, now) {
  const day = keyOf(ms);
  const today = keyOf(now);
  const t = endOfDay(ms) ? '' : ` ${TIME.format(ms)}`;
  if (day === today) return `today${t}`;
  if (day === addDays(today, 1)) return `tomorrow${t}`;
  if (day === addDays(today, -1)) return `yesterday${t}`;
  const diff = daysBetween(today, day);
  if (diff > 0 && diff < 7) return `${WEEKDAY.format(ms)}${t}`;
  return SHORT.format(ms);
}

function span(ms) {
  const h = Math.abs(ms) / HOUR;
  if (h < 1) return `${Math.max(1, Math.round(Math.abs(ms) / 60e3))} min`;
  if (h < 36) return `${Math.round(h)} h`;
  return plural(Math.round(h / 24), 'day');
}

const dayLabel = (key) => when(dateOf(key).getTime() + 23 * HOUR + 59 * 60e3, Date.now());

const KIND_LABEL = { exam: 'Exam', interview: 'Interview', oa: 'Online assessment', project: 'Project', offer: 'Offer',
  quiz: 'Quiz', discussion: 'Discussion', event: 'Event', note: 'Planner note', page: 'Page', review: 'Peer review', assignment: 'Assignment' };

function reasonHtml(r, now) {
  switch (r.t) {
    case 'missing': return `<span class="hot">Missing${r.ms ? ` · ${span(r.ms)} late` : ''}</span>`;
    case 'overdue': return `<span class="hot">Overdue ${span(r.ms)}</span>`;
    case 'due': return `<span class="${r.at - now < 24 * HOUR ? 'warm' : ''}">Due ${esc(when(r.at, now))}</span>`;
    case 'weight': return r.v < 1 ? '&lt;1% of grade' : `~${r.v < 10 ? +r.v.toFixed(1) : Math.round(r.v)}% of grade`;
    case 'kind': return KIND_LABEL[r.v] || '';
    case 'grade': return `class at ${Math.round(r.v)}%`;
    case 'pri': return 'P1';
    case 'note': return esc(r.v);
    default: return '';
  }
}

const scoreClass = (s) => (s >= 70 ? 's3' : s >= 45 ? 's2' : '');

// ---------------------------------------------------------------- motion

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const motionOK = () => !reduceMotion.matches;

/** A stable view-transition name for a row, so it glides to its new place when a list changes. */
function vt(list, key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return `style="view-transition-name:${list}-${(h >>> 0).toString(36)};view-transition-class:row"`;
}

/**
 * Save and redraw after a change. Where the browser supports view transitions, rows glide to
 * their new places, finished ones slip away and new ones settle in, instead of the list jumping.
 */
function update() {
  save();
  const run = () => render();
  if (motionOK() && document.startViewTransition && !document.querySelector('dialog[open]')) {
    try {
      const t = document.startViewTransition(run);
      // A quick second change skips the first animation; its redraw still happens, so that's fine.
      for (const p of [t.ready, t.finished, t.updateCallbackDone]) p.catch(() => {});
      return;
    } catch { /* fall back to a plain redraw */ }
  }
  run();
}

/** Numbers marked data-count roll from their last value (or 0 on entrance) to the new one. */
const counted = new Map();
function countUp(root, fromZero) {
  for (const el of root.querySelectorAll('[data-count]')) {
    const key = el.dataset.count;
    const to = Number(el.textContent);
    const from = fromZero ? 0 : counted.get(key) ?? to;
    counted.set(key, to);
    if (!motionOK() || from === to || !Number.isFinite(to)) continue;
    const t0 = performance.now();
    el.textContent = String(from);
    const step = (t) => {
      const p = Math.min(1, (t - t0) / 900);
      el.textContent = String(Math.round(from + (to - from) * (1 - (1 - p) ** 4)));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }
}

// ---------------------------------------------------------------- derived state

function context() {
  const now = Date.now();
  const today = keyOf(now);
  const pday = practiceDay(now);
  const s = store.settings;
  const problems = allProblems(store.dsa.custom);
  const canvas = canvasItems(store.canvas, { done: store.done, hidden: s.hidden, now });
  const tasks = taskItems(store.tasks);
  const intern = pipelineItems(store.apps, today);
  const set = todaysSet(store.dsa, s, pday, problems);
  const dsa = dsaItem(set, s, today);
  const all = [...canvas, ...tasks, ...intern, ...(dsa ? [dsa] : [])];
  const ranked = rank(all, now);
  lastItems = new Map(all.map((i) => [i.key, i]));
  return { now, today, pday, s, problems, canvas, tasks, intern, set, all, ranked };
}

// ---------------------------------------------------------------- shared rows

function itemRow(it, now, { score = true, list = 'p' } = {}) {
  let lead;
  if (it.src === 'intern') lead = `<button type="button" class="go" data-act="open-app" data-id="${esc(it.appId || '')}" aria-label="Update ${esc(it.sub)}">${ICON.arrow}</button>`;
  else if (it.src === 'dsa') lead = `<button type="button" class="go" data-act="go-dsa" aria-label="Open DSA practice">${ICON.arrow}</button>`;
  else if (it.kind === 'event') lead = '<span class="go" aria-hidden="true">•</span>';
  else {
    const locked = it.done && !it.localDone && it.src === 'canvas';
    lead = `<button type="button" class="check" data-act="done" aria-pressed="${it.done}" ${locked ? 'disabled title="Done in Canvas"' : ''}
      aria-label="${it.done ? 'Mark not done' : 'Mark done'}: ${esc(it.title)}"></button>`;
  }
  let title;
  if (it.src === 'task') title = `<button type="button" class="pr-title" data-act="edit-task">${esc(it.title)}</button>`;
  else if (it.src === 'intern' && it.appId) title = `<button type="button" class="pr-title" data-act="open-app" data-id="${esc(it.appId)}">${esc(it.title)}</button>`;
  else if (it.src === 'dsa') title = `<button type="button" class="pr-title" data-act="go-dsa">${esc(it.title)}</button>`;
  else if (it.url) title = `<a class="pr-title" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a>`;
  else title = `<span class="pr-title">${esc(it.title)}</span>`;
  const reasons = it.reasons || scoreItem(it, now).reasons;
  const status = [];
  if (it.src === 'canvas') {
    if (it.excused) status.push('<span class="pill">Excused</span>');
    else if (it.graded) status.push('<span class="pill good">Graded</span>');
    else if (it.submitted) status.push('<span class="pill good">Submitted</span>');
    else if (it.canvasDone) status.push('<span class="pill good">Done in Canvas</span>');
    if (it.late && it.submitted) status.push('<span class="pill bad">Late</span>');
  }
  const meta = [
    it.sub ? `<span class="src">${esc(it.sub)}</span>` : '',
    ...(it.done ? [] : reasons.map((r) => reasonHtml(r, now))),
    ...(it.done && it.due != null ? [`<span>Due ${esc(when(it.due, now))}</span>`] : []),
    ...status,
  ].filter(Boolean).map((x) => (x.startsWith('<span') ? x : `<span>${x}</span>`)).join('');
  const sc = score && typeof it.score === 'number' && !it.done
    ? `<span class="score ${scoreClass(it.score)}" title="Priority ${it.score} of 100">${it.score}</span>` : '<span></span>';
  return `<li class="pr${it.done ? ' is-done' : ''}" data-key="${esc(it.key)}" ${vt(list, it.key)}>${lead}<div>${title}<div class="pr-meta">${meta}</div></div>${sc}</li>`;
}

// ---------------------------------------------------------------- Today

function renderToday(c) {
  const name = store.settings.name || store.canvas?.user || '';
  const hour = new Date(c.now).getHours();
  const greet = hour < 5 ? 'Up late' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const open = c.all.filter(isActionable);
  const due48 = open.filter((i) => i.due != null && i.due >= c.now && i.due - c.now <= 48 * HOUR).length;
  const overdue = open.filter((i) => i.due != null && i.due < c.now).length;
  const top = c.ranked[0];
  const nothing = !store.canvas && !store.tasks.length && !store.apps.length && !Object.keys(store.dsa.problems).length;

  const summary = nothing
    ? 'Connect Canvas or add a task, and HQ will rank everything for you.'
    : `<b>${due48}</b> due in the next 48 hours · <b class="${overdue ? 'hot' : ''}">${overdue}</b> overdue${top ? ` · start with <b>${esc(top.title)}</b>` : ''}`;

  const shown = ui.showAll ? c.ranked : c.ranked.slice(0, 8);
  const priorities = nothing ? `
    <div class="empty-big">
      <h3>Welcome to Comet HQ</h3>
      <p>One list for school, the internship hunt and DSA prep, ranked by what matters most right now.</p>
      <div class="row" style="justify-content:center">
        <button type="button" class="btn primary" data-open="connect">Connect Canvas</button>
        <button type="button" class="btn" data-act="load-sample">Try it with sample data</button>
      </div>
    </div>` : c.ranked.length ? `
    <ol class="plist">${shown.map((it) => itemRow(it, c.now)).join('')}</ol>
    ${c.ranked.length > 8 ? `<button type="button" class="btn ghost small more" data-act="show-all">${ui.showAll ? 'Show top 8' : `Show all ${c.ranked.length}`}</button>` : ''}`
    : '<p class="empty">Nothing open. Enjoy it, or pull tomorrow’s work forward.</p>';

  $('#view-today').innerHTML = `
    <div class="hero">
      <p class="hero-date">${esc(LONG.format(c.now))}</p>
      <h2>${greet}${name ? `, ${esc(name)}` : ''}</h2>
      <p class="summary">${summary}</p>
    </div>
    <div class="grid">
      <div class="stack">
        <section class="panel" aria-labelledby="pri-h">
          <div class="panel-head"><h3 id="pri-h">Top priorities</h3><span class="muted">Ranked by deadline, grade weight and stakes</span></div>
          ${priorities}
        </section>
        ${tasksPanel(c)}
      </div>
      <aside class="stack">
        ${todayTiles(c, due48, overdue)}
        ${weekPanel(c)}
        ${countdownPanel(c)}
        ${lockinPanel(c)}
        ${canvasStatusPanel(c)}
      </aside>
    </div>`;
}

function tasksPanel(c) {
  const counts = Object.fromEntries(CATEGORIES.map((cat) => [cat.id, store.tasks.filter((t) => !t.done && t.cat === cat.id).length]));
  const scored = c.ranked.filter((i) => i.src === 'task' && (ui.taskFilter === 'all' || i.cat === ui.taskFilter));
  const doneToday = store.tasks.filter((t) => t.done && keyOf(t.done) === c.today && (ui.taskFilter === 'all' || t.cat === ui.taskFilter));
  const doneRows = doneToday.map((t) => itemRow({ key: `t:${t.id}`, src: 'task', kind: 'task', title: t.title, sub: 'Done today', done: true, due: null, taskId: t.id }, c.now, { list: 't' })).join('');
  const chips = [['all', 'All', store.tasks.filter((t) => !t.done).length], ...CATEGORIES.map((x) => [x.id, x.label, counts[x.id]])]
    .map(([id, label, n]) => `<button type="button" class="chip" data-act="task-filter" data-id="${id}" aria-pressed="${ui.taskFilter === id}">${label} ${n ? `· ${n}` : ''}</button>`).join('');
  return `
    <section class="panel" aria-labelledby="tasks-h">
      <div class="panel-head"><h3 id="tasks-h">My tasks</h3><span class="muted">Anything Canvas doesn’t know about</span></div>
      <form class="add-task" id="add-task" autocomplete="off">
        <label class="visually-hidden" for="new-task">New task</label>
        <input type="text" id="new-task" name="title" maxlength="200" placeholder="Add a task, e.g. Ask Prof. Lee for a reference">
        <select name="cat" aria-label="Category">${CATEGORIES.map((x) => `<option value="${x.id}" ${ui.taskFilter === x.id ? 'selected' : ''}>${x.label}</option>`).join('')}</select>
        <select name="pri" aria-label="Priority"><option value="1">P1</option><option value="2" selected>P2</option><option value="3">P3</option></select>
        <input type="date" name="due" aria-label="Due date">
        <button type="submit" class="btn primary">Add</button>
      </form>
      <div class="filters" role="group" aria-label="Filter tasks">${chips}</div>
      ${scored.length || doneRows ? `<ol class="plist">${scored.map((it) => itemRow(it, c.now, { list: 't' })).join('')}${doneRows}</ol>` : '<p class="empty">No open tasks here.</p>'}
    </section>`;
}

function todayTiles(c, due48, overdue) {
  const log = new Map(Object.entries(store.dsa.log));
  const streak = streaks(log, c.pday).current;
  const stats = pipelineStats(store.apps, c.today);
  return `
    <dl class="tiles">
      <div class="tile"><dt>Due in 48 hours</dt><dd><span data-count="due48">${due48}</span></dd></div>
      <div class="tile ${overdue ? 'alert' : ''}"><dt>Overdue</dt><dd><span data-count="overdue">${overdue}</span></dd></div>
      <div class="tile"><dt>DSA streak</dt><dd><span data-count="streak">${streak}</span> <small>${streak === 1 ? 'day' : 'days'}</small></dd></div>
      <div class="tile"><dt>Active applications</dt><dd><span data-count="active">${stats.active}</span></dd></div>
    </dl>`;
}

function weekPanel(c) {
  const days = weekAhead(c.all, c.now);
  const max = Math.max(1, ...days.map((d) => d.load));
  const rows = days.map((d, i) => {
    const pct = Math.round((d.load / max) * 100);
    const names = [...d.items].sort((a, b) => (b.weight || 0) - (a.weight || 0)).slice(0, 2).map((x) => x.title);
    return `<div class="wk ${i === 0 ? 'today' : ''}" title="${esc(d.items.map((x) => x.title).join('\n'))}">
      <span class="d">${i === 0 ? 'Today' : esc(WEEKDAY.format(dateOf(d.key)))}</span>
      <div class="bar" role="img" aria-label="${plural(d.count, 'item')}"><span style="width:${d.count ? Math.max(6, pct) : 0}%;--heat:${35 + Math.round(pct * 0.65)}%"></span></div>
      <span class="n">${d.count || ''}</span>
      ${names.length ? `<span class="wk-names">${esc(names.join(' · '))}</span>` : ''}
    </div>`;
  }).join('');
  return `<section class="panel" aria-labelledby="week-h">
    <div class="panel-head"><h3 id="week-h">The week ahead</h3><span class="muted">Bar = how heavy the day is</span></div>
    <div class="week">${rows}</div></section>`;
}

function countdownPanel(c) {
  const d = c.s.interviewDate;
  if (!d || d < c.today) return '';
  const n = daysBetween(c.today, d);
  return `<section class="panel countdown">
    <div class="panel-head"><h3>${esc(c.s.interviewLabel || 'Interview')}</h3><button type="button" class="btn ghost small" data-act="go-dsa">Prep →</button></div>
    <strong>${n === 0 ? 'Today' : plural(n, 'day')}</strong> <span class="muted">${n ? 'to go' : ''} · ${esc(SHORT.format(dateOf(d)))}</span>
  </section>`;
}

function lockinPanel(c) {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(LOCKIN_KEY) || 'null'); } catch { return ''; }
  if (!data?.profile || !Array.isArray(data.profile.commitments)) return '';
  const day = data.days?.[lockinToday(c.now)];
  const st = dayStatus(day, data.profile.commitments);
  const top = c.ranked[0];
  return `<section class="panel lockin-card">
    <div class="panel-head"><h3>Lock In</h3>${st.kept ? '<span class="pill good">Day kept</span>' : `<span class="pill">${st.met}/${st.total} commitments</span>`}</div>
    ${day?.oneThing ? `<p class="small muted" style="margin:0">Today’s One Thing</p><p class="one">${esc(day.oneThing)}</p>`
      : `<p class="small muted">No One Thing set yet.${top ? ` HQ’s top pick: <strong>${esc(top.title)}</strong>.` : ''}</p>`}
    <a class="btn small" href="../lockin/">Open Lock In →</a>
  </section>`;
}

/** Where HQ syncs from: the address you saved, else the one the last sync came from. */
function canvasOrigin() {
  return store.settings.canvasUrl || (store.canvas && !store.sample ? store.canvas.origin : '');
}

const autoSync = () => ext.present || Boolean(getToken());

function syncPill(c) {
  if (ui.syncing) return '<span class="pill accent syncing"><i aria-hidden="true"></i>Syncing…</span>';
  if (ui.syncError) return `<span class="pill bad">${ui.loggedOut ? 'Logged out of Canvas' : 'Sync paused'}</span>`;
  if (!store.canvas) return '<span class="pill">Not connected</span>';
  if (store.sample) return '<span class="pill">Sample data</span>';
  const ago = c.now - Date.parse(store.canvas.at);
  if (ago < 5 * 60e3) return '<span class="pill good">Up to date</span>';
  return `<span class="pill ${ago > 24 * HOUR ? 'bad' : ''}">Synced ${span(ago)} ago</span>`;
}

function syncNote() {
  if (ui.syncError) {
    const origin = canvasOrigin();
    return `<p class="small sync-error">${esc(ui.syncError)}</p>${ui.loggedOut && origin ? `<a class="btn small" href="${esc(origin)}" target="_blank" rel="noopener">Open Canvas</a> ` : ''}`;
  }
  if (ext.present) return canvasOrigin() ? '<p class="small muted">Syncs by itself every time you open HQ.</p>'
    : '<p class="small muted">The extension is installed. Add your Canvas address to finish.</p>';
  if (getToken()) return '<p class="small muted">Syncs by itself through your proxy.</p>';
  return '';
}

function canvasStatusPanel(c) {
  if (!store.canvas || store.sample) {
    return `<section class="panel"><div class="panel-head"><h3>Canvas</h3>${syncPill(c)}</div>
      ${syncNote() || '<p class="small muted">Sync your assignments, quizzes, exams and grades from UT Dallas’s Canvas.</p>'}
      ${autoSync() && canvasOrigin() ? '<button type="button" class="btn primary small" data-act="sync">Sync now</button>'
        : '<button type="button" class="btn primary small" data-open="connect">Connect Canvas</button>'}</section>`;
  }
  return `<section class="panel"><div class="panel-head"><h3>Canvas</h3>${syncPill(c)}</div>
    <p class="small muted">${plural(store.canvas.courses.length, 'course')} · ${plural(c.canvas.filter(isOpen).length, 'open item')}</p>
    ${syncNote()}
    ${autoSync() ? '<button type="button" class="btn small" data-act="sync">Sync now</button>'
      : '<button type="button" class="btn small" data-open="connect">Turn on auto-sync</button>'}</section>`;
}

// ---------------------------------------------------------------- School

function renderSchool(c) {
  const view = $('#view-school');
  if (!store.canvas) {
    view.innerHTML = `<section class="panel empty-big">
      <h3>Connect Canvas to see your classes</h3>
      <p>HQ reads your planner, current grades and assignment-group weights, so it can tell a 2% homework from a 20% exam.</p>
      <div class="row" style="justify-content:center">
        <button type="button" class="btn primary" data-open="connect">Connect Canvas</button>
        <button type="button" class="btn" data-act="load-sample">Try sample data</button>
      </div></section>`;
    return;
  }
  const summaries = courseSummaries(store.canvas, c.canvas, c.s.hidden);
  const courses = summaries.map((s) => `
    <article class="course ${s.hidden ? 'hidden-course' : ''}" ${vt('c', s.id)}>
      <div class="course-top">
        <span class="course-code">${esc(s.code)}</span>
        ${s.score != null ? `<span class="course-grade ${s.score < 80 ? 'low' : ''}">${+s.score.toFixed(1)}%${s.grade ? `<small>${esc(s.grade)}</small>` : ''}</span>` : '<span class="muted small">No grade yet</span>'}
      </div>
      <div class="course-name" title="${esc(s.name)}">${esc(s.name)}</div>
      <div class="course-next">${s.hidden ? '<span class="muted">Hidden from HQ</span>' : s.next ? `Next: <strong>${esc(s.next.title)}</strong> <span class="muted">· ${esc(when(s.next.due, c.now))}</span>` : '<span class="muted">Nothing due</span>'}</div>
      <div class="course-foot">
        <span class="small muted">${s.hidden ? '' : `${plural(s.open, 'open item')}${s.missing ? ` · <span class="status-bad">${s.missing} missing</span>` : ''}`}</span>
        <button type="button" class="btn ghost small" data-act="toggle-course" data-id="${esc(s.id)}">${s.hidden ? 'Show' : 'Hide'}</button>
      </div>
    </article>`).join('');

  const visible = c.canvas.filter((i) => ui.course === 'all' || i.courseId === ui.course);
  const open = visible.filter(isOpen).map((i) => ({ ...i, ...scoreItem(i, c.now) }));
  const groups = BUCKETS.map((b) => ({ ...b, items: open.filter((i) => bucketOf(i.due, c.now) === b.id).sort((a, x) => (a.due ?? Infinity) - (x.due ?? Infinity)) }))
    .filter((g) => g.items.length);
  const done = ui.showDone ? visible.filter((i) => !isOpen(i)).sort((a, b) => (b.due ?? 0) - (a.due ?? 0)).slice(0, 30) : [];
  const chips = [['all', 'All courses'], ...summaries.filter((s) => !s.hidden).map((s) => [s.id, s.code])]
    .map(([id, label]) => `<button type="button" class="chip" data-act="course-filter" data-id="${esc(id)}" aria-pressed="${ui.course === id}">${esc(label)}</button>`).join('');

  view.innerHTML = `
    <section class="panel" style="margin-bottom:16px">
      <div class="sync-line">
        <p><strong>Canvas</strong> ${syncPill(c)} <span class="muted">${store.canvas.user ? `${esc(store.canvas.user)} · ` : ''}${esc(store.canvas.origin.replace(/^https?:\/\//, ''))}</span></p>
        <div class="row">
          <button type="button" class="btn small" data-act="sync">${autoSync() ? 'Sync now' : 'Turn on auto-sync'}</button>
          <button type="button" class="btn ghost small" data-open="connect">Connection</button>
        </div>
      </div>
      ${ui.syncError ? syncNote() : ''}
      ${store.canvas.errors.length ? `<p class="small muted" style="margin:8px 0 0">Some parts didn’t load: ${esc(store.canvas.errors.join('; '))}</p>` : ''}
    </section>
    <div class="courses">${courses}</div>
    <section class="panel" aria-labelledby="cw-h">
      <div class="panel-head"><h3 id="cw-h">Coursework</h3>
        <label class="small muted row" style="gap:6px"><input type="checkbox" id="show-done" ${ui.showDone ? 'checked' : ''}> Show done and past</label></div>
      <div class="filters" role="group" aria-label="Filter by course">${chips}</div>
      ${groups.length ? groups.map((g) => `<h4 class="group-h ${g.id === 'overdue' ? 'hot' : ''}">${g.label} · ${g.items.length}</h4>
        <ol class="plist">${g.items.map((it) => itemRow(it, c.now, { score: it.kind !== 'event', list: 's' })).join('')}</ol>`).join('') : '<p class="empty">Nothing open in Canvas. Nice.</p>'}
      ${done.length ? `<h4 class="group-h">Done and past</h4><ol class="plist">${done.map((it) => itemRow(it, c.now, { score: false, list: 's' })).join('')}</ol>` : ''}
    </section>`;
}

// ---------------------------------------------------------------- Internships

function renderIntern(c) {
  const stats = pipelineStats(store.apps, c.today);
  const quiet = new Set(quietApps(store.apps, c.today).map((a) => a.id));
  const sortApps = (list) => [...list].sort((a, b) => (a.nextDue || '9999').localeCompare(b.nextDue || '9999') || b.updated.localeCompare(a.updated));
  const cols = STAGES.filter((s) => s.id !== 'closed').map((s) => {
    const list = sortApps(store.apps.filter((a) => a.stage === s.id));
    return `<section class="col" aria-label="${esc(s.label)}">
      <div class="col-h"><span>${esc(s.label)}</span><span class="pill">${list.length}</span></div>
      <div class="col-list">${list.map((a) => appCard(a, c, quiet.has(a.id))).join('') || '<p class="empty small" style="padding:4px 2px">None</p>'}</div>
    </section>`;
  }).join('');
  const closed = sortApps(store.apps.filter((a) => a.stage === 'closed'));
  const rate = stats.responseRate == null ? '—' : `<span data-count="rate">${Math.round(stats.responseRate * 100)}</span>%`;
  $('#view-intern').innerHTML = `
    <dl class="tiles five" style="margin-bottom:16px">
      <div class="tile"><dt>Applied</dt><dd><span data-count="applied">${stats.applied}</span></dd></div>
      <div class="tile"><dt>This week</dt><dd><span data-count="week">${stats.thisWeek}</span></dd></div>
      <div class="tile"><dt>Response rate</dt><dd>${rate} <small>${stats.applied ? `${stats.responded}/${stats.applied}` : ''}</small></dd></div>
      <div class="tile"><dt>Interviews</dt><dd><span data-count="interviews">${stats.interviews}</span></dd></div>
      <div class="tile"><dt>Offers</dt><dd><span data-count="offers">${stats.offers}</span></dd></div>
    </dl>
    <div class="row toolbar">
      <div class="row">
        <button type="button" class="btn primary" data-act="new-app">+ Add application</button>
        <a class="btn" href="https://app.appwing.us" target="_blank" rel="noopener">AppWing ${ICON.link}</a>
      </div>
      <span class="small muted">${quiet.size ? `${plural(quiet.size, 'application')} quiet for 2+ weeks. A short follow-up note helps.` : 'Next steps with dates show up in Today’s priorities.'}</span>
    </div>
    ${store.apps.length ? `<div class="board">${cols}</div>` : `<section class="panel empty-big"><h3>Track your internship hunt</h3>
      <p>Add each application with its next step (OA due, interview date). HQ puts deadlines into your priorities and nudges you to follow up on quiet ones.</p>
      <button type="button" class="btn primary" data-act="new-app">+ Add your first application</button></section>`}
    ${closed.length ? `<details class="panel" style="margin-top:16px"><summary><strong>Closed</strong> <span class="muted">· ${closed.length}</span></summary>
      <ul class="closed-list" style="margin-top:10px">${closed.map((a) => `<li><button type="button" class="pr-title" data-act="open-app" data-id="${esc(a.id)}" style="border:0;background:none;padding:0">${esc(a.company)}</button>
        <span class="muted small">${esc(a.role)}</span>${a.outcome ? `<span class="pill">${esc(OUTCOMES.find((o) => o.id === a.outcome)?.label || '')}</span>` : ''}</li>`).join('')}</ul></details>` : ''}`;
}

function appCard(a, c, quiet) {
  const since = keyOf(stageSince(a)) || c.today;
  const days = daysBetween(since, c.today);
  const nextIdx = STAGES.findIndex((s) => s.id === a.stage) + 1;
  const next = nextIdx < 5 ? STAGES[nextIdx] : null;
  const due = a.nextDue ? dateOf(a.nextDue).getTime() + (a.nextTime ? (Number(a.nextTime.slice(0, 2)) * 60 + Number(a.nextTime.slice(3))) * 60e3 : 23 * HOUR + 59 * 60e3) : null;
  const overdue = due != null && due < c.now;
  return `<article class="card" data-app="${esc(a.id)}" ${vt('a', a.id)}>
    <div class="card-top">
      <button type="button" class="card-company" data-act="open-app" data-id="${esc(a.id)}">${esc(a.company)}</button>
      ${a.url ? `<a class="go" href="${esc(a.url)}" target="_blank" rel="noopener" aria-label="Open the ${esc(a.company)} posting">${ICON.link}</a>` : ''}
    </div>
    ${a.role ? `<div class="card-role">${esc(a.role)}</div>` : ''}
    <div class="card-next">${esc(a.next || defaultNext(a))}${due != null ? ` · <span class="${overdue ? 'status-bad' : 'status-due'}">${esc(when(due, c.now))}</span>` : ''}</div>
    <div class="card-foot">
      <span class="${quiet ? 'status-bad' : ''}">${quiet ? `No reply in ${days} days` : days ? `${plural(days, 'day')} in stage` : 'Today'}</span>
      ${next ? `<button type="button" class="adv" data-act="advance" data-id="${esc(a.id)}" title="Move to ${esc(next.label)}">→ ${esc(next.label === 'Online assessment' ? 'OA' : next.label)}</button>` : ''}
    </div>
  </article>`;
}

// ---------------------------------------------------------------- DSA

const PATTERN_NAME = Object.fromEntries(PATTERNS.map((p) => [p.id, p.name]));

function probRow(p, c, tag = '', list = 'q') {
  const s = store.dsa.problems[p.slug];
  const today = s?.last === c.pday;
  const conf = today ? s.conf : null;
  let status = 'Not started';
  if (s?.st === 'solved') status = `${CONFIDENCE.find((x) => x.v === s.conf)?.label} · review ${s.due <= c.pday ? (today ? dayLabel(s.due) : 'due') : dayLabel(s.due)}`;
  else if (s) status = `Tried · retry ${dayLabel(s.due)}`;
  const buttons = [
    ...(!s || s.st === 'attempted' || (today && conf === 0) ? [{ v: 0, label: 'Tried', hint: 'Didn’t get it yet; retry tomorrow' }] : []),
    ...CONFIDENCE,
  ].map((b) => `<button type="button" data-act="practice" data-slug="${esc(p.slug)}" data-v="${b.v}" title="${esc(b.hint)}" aria-pressed="${conf === b.v}">${esc(b.label)}</button>`).join('');
  return `<li class="prob" ${vt(list, p.slug)}>
    <div>
      <a class="prob-title" href="${esc(p.url || `https://leetcode.com/problems/${p.slug}/`)}" target="_blank" rel="noopener">${esc(p.title)}</a>
      <div class="prob-meta">
        ${tag ? `<span class="pill accent">${esc(tag)}</span>` : ''}
        <span class="diff ${p.diff}">${DIFFICULTY[p.diff]}</span>
        <span>${esc(PATTERN_NAME[p.pattern] || '')}</span>
        <span>${esc(status)}</span>
        ${p.premium ? '<span class="pill">Premium</span>' : ''}
        ${p.custom ? '<span class="pill">Yours</span>' : ''}
      </div>
    </div>
    <div class="conf" role="group" aria-label="How did ${esc(p.title)} go?">${buttons}${today ? `<button type="button" data-act="undo-practice" data-slug="${esc(p.slug)}" title="Undo today’s mark">Undo</button>` : ''}</div>
  </li>`;
}

function renderDsa(c) {
  const states = store.dsa.problems;
  const solved = c.problems.filter((p) => states[p.slug]?.st === 'solved').length;
  const log = new Map(Object.entries(store.dsa.log));
  const st = streaks(log, c.pday);
  const ready = readiness(c.problems, states, c.pday);
  const progress = patternProgress(c.problems, states);
  const set = c.set;
  const total = set.doneToday.length + set.left;
  const grid = heatmap(log, c.pday, 26);
  const hm = grid.map((col, ci) => `<div class="hm-col" style="--c:${ci}">${col.map((cell) => (cell
    ? `<span class="hm-cell ${cell.level ? `l${cell.level}` : ''} ${cell.key === c.pday ? 'today' : ''}" title="${esc(`${plural(cell.count, 'problem')} · ${SHORT.format(dateOf(cell.key))}`)}"></span>`
    : '<span class="hm-cell none"></span>')).join('')}</div>`).join('');

  const todayRows = [
    ...set.reviews.map((p) => probRow(p, c, 'Review', 'qs')),
    ...set.fresh.map((p) => probRow(p, c, 'New', 'qs')),
    ...set.doneToday.map((p) => probRow(p, c, 'Done', 'qs')),
  ].join('');

  const patterns = progress.map((pr) => {
    const list = c.problems.filter((p) => p.pattern === pr.id);
    const solidPct = (pr.solid / pr.total) * 100;
    const restPct = ((pr.solved - pr.solid) / pr.total) * 100;
    return `<details class="pat" data-pattern="${pr.id}" ${ui.open.has(pr.id) ? 'open' : ''}>
      <summary><span>${esc(pr.name)}</span>
        <span class="bar" role="img" aria-label="${pr.solid} solid, ${pr.solved - pr.solid} shaky or needed help, of ${pr.total}"><span class="solid" style="width:${solidPct}%"></span><span class="rest" style="width:${restPct}%"></span></span>
        <span class="n">${pr.solved}/${pr.total}</span></summary>
      ${ui.open.has(pr.id) ? `<ol class="plist pat-body">${list.map((p) => probRow(p, c, '', 'qp')).join('')}</ol>` : ''}
    </details>`;
  }).join('');

  $('#view-dsa').innerHTML = `
    <dl class="tiles four" style="margin-bottom:16px">
      <div class="tile"><dt>Solved</dt><dd><span data-count="solved">${solved}</span> <small>/ ${c.problems.length}</small></dd><div class="bar"><span style="width:${(solved / c.problems.length) * 100}%"></span></div></div>
      <div class="tile"><dt>Streak</dt><dd><span data-count="dsa-streak">${st.current}</span> <small>${st.current === 1 ? 'day' : 'days'} · best ${st.longest}</small></dd></div>
      <div class="tile ${set.dueCount > 5 ? 'alert' : ''}"><dt>Reviews due</dt><dd><span data-count="due-reviews">${set.dueCount}</span></dd></div>
      <div class="tile"><dt>Interview readiness</dt><dd><span data-count="ready">${ready}</span>%</dd><div class="bar"><span style="width:${ready}%"></span></div></div>
    </dl>
    <div class="grid">
      <div class="stack">
        <section class="panel" aria-labelledby="set-h">
          <div class="panel-head"><h3 id="set-h">Today’s set</h3><span class="muted">${set.doneToday.length} of ${total} done</span></div>
          <p class="muted">Open the problem, solve it, then say how it went. HQ schedules the next review: Solid comes back later, Shaky sooner, Needed help tomorrow.</p>
          ${todayRows ? `<ol class="plist">${todayRows}</ol>` : '<p class="empty">Set your daily goal on the right to get problems here.</p>'}
        </section>
        <section class="panel" aria-labelledby="pat-h">
          <div class="panel-head"><h3 id="pat-h">Patterns</h3><button type="button" class="btn small" data-act="new-prob">+ Add a problem</button></div>
          <p class="muted">The core 150 in learning order. Open a pattern to see and mark its problems.</p>
          <div class="patterns">${patterns}</div>
          <div class="legend"><span><i style="background:var(--accent)"></i>Solid</span><span><i style="background:color-mix(in srgb, var(--accent) 40%, var(--surface-2))"></i>Shaky or needed help</span><span><i style="background:var(--surface-2)"></i>Not solved</span></div>
        </section>
      </div>
      <aside class="stack">
        <section class="panel" aria-labelledby="goal-h">
          <div class="panel-head"><h3 id="goal-h">Interview and daily goal</h3></div>
          <form id="dsa-settings" class="inline-settings">
            <label class="field"><span>Next interview</span><input type="text" name="interviewLabel" maxlength="80" value="${esc(c.s.interviewLabel)}" placeholder="e.g. Capital One Power Day"></label>
            <label class="field"><span>Date</span><input type="date" name="interviewDate" value="${esc(c.s.interviewDate)}"></label>
            <label class="field"><span>New / day</span><input type="number" name="dailyNew" min="0" max="10" value="${c.s.dailyNew}"></label>
            <label class="field"><span>Reviews / day</span><input type="number" name="dailyReview" min="0" max="20" value="${c.s.dailyReview}"></label>
          </form>
          <p class="small muted" style="margin:10px 0 0">Within two weeks of an interview, practice moves up in Today’s priorities.</p>
        </section>
        <section class="panel" aria-labelledby="hm-h">
          <div class="panel-head"><h3 id="hm-h">Practice, last 26 weeks</h3></div>
          <div class="heatmap" role="img" aria-label="${plural([...log.values()].reduce((a, b) => a + b, 0), 'problem')} practiced; current streak ${st.current}">${hm}</div>
          <div class="legend"><span>Less</span><span><i class="hm-cell"></i><i class="hm-cell l1"></i><i class="hm-cell l2"></i><i class="hm-cell l3"></i><i class="hm-cell l4"></i></span><span>More</span></div>
        </section>
        <section class="panel">
          <h3>How readiness works</h3>
          <p class="small muted" style="margin:6px 0 0">Each of the ${PATTERNS.length} patterns counts equally and fills up when about 60% of it is solved solidly. Breadth beats grinding one topic, and reviews left more than a week overdue count a little less.</p>
        </section>
      </aside>
    </div>`;
}

// ---------------------------------------------------------------- render

let enterTimer;
const STAGGER = '.hero, .tiles, .panel, .courses > .course, .board > .col, .toolbar';

/** Redraw the open tab. `enter` plays the arrival: blocks rise in one after another. */
function render({ enter = false } = {}) {
  const c = context();
  const view = $(`#view-${tab}`);
  // Keep a half-typed entry and the caret where they were across a redraw.
  const active = document.activeElement;
  const keep = active?.id && view.contains(active) && 'value' in active
    ? { id: active.id, value: active.value, start: active.selectionStart, end: active.selectionEnd } : null;
  $('#sample-banner').hidden = !store.sample;
  $('#storage-warning').hidden = storageOk;
  const hot = c.canvas.filter((i) => isActionable(i) && i.due != null && i.due - c.now < 24 * HOUR).length;
  $('#count-school').hidden = !hot;
  $('#count-school').textContent = hot;
  $('#count-dsa').hidden = !c.set.left;
  $('#count-dsa').textContent = c.set.left;
  for (const b of $$('.tab')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  for (const t of TABS) $(`#view-${t}`).hidden = t !== tab;
  view.classList.remove('enter');
  ({ today: renderToday, school: renderSchool, intern: renderIntern, dsa: renderDsa })[tab](c);
  if (keep) {
    const el = document.getElementById(keep.id);
    if (el) {
      el.value = keep.value;
      el.focus({ preventScroll: true });
      try { el.setSelectionRange(keep.start, keep.end); } catch { /* not a text field */ }
    }
  }
  placeGlider();
  if (enter && motionOK()) {
    $$(STAGGER, view).forEach((el, i) => el.style.setProperty('--i', Math.min(i, 8)));
    void view.offsetWidth;
    view.classList.add('enter');
    clearTimeout(enterTimer);
    enterTimer = setTimeout(() => view.classList.remove('enter'), 1600);
  }
  countUp(view, enter);
}

/** Slide the tab highlight under the selected tab. */
function placeGlider() {
  const g = $('.tab-glider');
  const t = $(`.tab[data-tab="${tab}"]`);
  if (!g || !t) return;
  g.style.width = `${t.offsetWidth}px`;
  g.style.transform = `translateX(${t.offsetLeft}px)`;
}

function setTab(t) {
  if (!TABS.includes(t)) return;
  tab = t;
  try { localStorage.setItem(TAB_KEY, t); } catch { /* fine */ }
  render({ enter: true });
  window.scrollTo({ top: 0, behavior: motionOK() ? 'smooth' : 'auto' });
}

let toastTimer;
function toast(text, action, fn) {
  const el = $('#toast');
  $('#toast-text').textContent = text;
  const btn = $('#toast-action');
  btn.hidden = !action;
  btn.textContent = action || '';
  btn.onclick = action ? () => { el.classList.remove('show'); fn(); } : null;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), action ? 6000 : 3500);
}

// ---------------------------------------------------------------- Canvas sync

const hqUrl = () => location.origin + location.pathname;

function applyCanvas(clean, { quiet = false } = {}) {
  const wasSample = store.sample;
  if (wasSample) {
    const keep = store.settings;
    store = emptyStore();
    store.settings = { ...defaultSettings(), name: keep.name, canvasUrl: keep.canvasUrl, proxyUrl: keep.proxyUrl };
  }
  store.canvas = clean;
  if (!store.settings.canvasUrl && clean.origin.startsWith('https://')) store.settings.canvasUrl = clean.origin;
  const keys = new Set(canvasItems(clean).map((i) => i.key));
  for (const k of Object.keys(store.done)) if (!keys.has(k)) delete store.done[k];
  ui.syncError = '';
  ui.loggedOut = false;
  update();
  if (quiet && !wasSample) return;
  const open = canvasItems(clean, { hidden: store.settings.hidden }).filter(isOpen).length;
  toast(`Synced ${plural(clean.courses.length, 'course')} and ${plural(open, 'open item')} from Canvas${wasSample ? '. Sample data cleared' : ''}`);
}

async function ingestHash() {
  const m = /^#canvas=([\w-]+)$/.exec(location.hash);
  if (!m) return;
  // Take the data out of the address bar and this history entry right away.
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const clean = cleanCanvas(await unpackPayload(m[1]));
    if (!clean) throw new Error('it isn’t Canvas data HQ recognizes');
    applyCanvas(clean);
  } catch (e) {
    toast(`Couldn’t read that sync: ${e.message}`);
  }
}

async function syncWithExtension({ quiet = false } = {}) {
  const origin = canvasOrigin();
  if (!origin) { if (!quiet) openConnect(); return; }
  if (ui.syncing) return;
  ui.syncing = true;
  ui.syncError = '';
  $('#sync-btn').classList.add('spin');
  render();
  try {
    const res = await ext.sync(origin);
    if (!res.ok) throw Object.assign(new Error(res.error || 'The extension couldn’t sync.'), { status: res.status });
    const clean = cleanCanvas(res.data);
    if (!clean) throw new Error('Canvas sent something HQ couldn’t read.');
    ui.syncing = false;
    applyCanvas(clean, { quiet });
  } catch (e) {
    ui.loggedOut = e.status === 401;
    ui.syncError = ui.loggedOut ? 'You’re logged out of Canvas. Log in there, then come back: HQ syncs on its own.' : e.message;
    if (!quiet) toast(ui.syncError);
  } finally {
    ui.syncing = false;
    $('#sync-btn').classList.remove('spin');
    if ($('#connect').open) fillConnect();
    render();
  }
}

/** Sync the best way available: the extension, then a token, else explain how to connect. */
function syncNow(opts) {
  if (ext.present && canvasOrigin()) return syncWithExtension(opts);
  if (getToken() && store.settings.canvasUrl) return syncWithToken(opts);
  openConnect();
  return null;
}

async function syncWithToken({ quiet = false } = {}) {
  const token = getToken();
  const s = store.settings;
  if (!token || !s.canvasUrl) { if (!quiet) openConnect(); return; }
  if (ui.syncing) return;
  ui.syncing = true;
  $('#sync-btn').classList.add('spin');
  try {
    const base = s.proxyUrl || s.canvasUrl;
    const data = await pullCanvas((p) => canvasGet(p, base, token, (u, o) => fetch(u, o)), Date.now(), s.canvasUrl);
    const clean = cleanCanvas(JSON.parse(JSON.stringify(data)));
    if (!clean) throw new Error('Canvas sent something HQ couldn’t read.');
    applyCanvas(clean);
  } catch (e) {
    ui.syncError = e instanceof TypeError
      ? (s.proxyUrl ? 'Couldn’t reach the proxy. Check its address, and that ALLOWED_ORIGIN includes this site.'
        : 'Canvas blocked the request from this site. Add a proxy address, or use the Sync button bookmark.')
      : e.status === 401 ? 'Canvas rejected the token. It may have expired; make a new one.' : e.message;
    if (!quiet) toast(ui.syncError);
    if ($('#connect').open) fillConnect();
  } finally {
    ui.syncing = false;
    $('#sync-btn').classList.remove('spin');
  }
}

function fillConnect() {
  const s = store.settings;
  $('#bookmarklet').href = bookmarklet(hqUrl());
  $('#proxy-url').value = s.proxyUrl;
  $('#canvas-token').value = '';
  $('#canvas-token').placeholder = getToken() ? 'A token is saved. Paste a new one to replace it.' : 'Paste a token';
  $('#forget-token').hidden = !getToken();
  $('#canvas-url').value = canvasOrigin();
  $('#ext-ready').hidden = !ext.present;
  $('#ext-setup').hidden = ext.present;
  $('#ext-update').hidden = !ext.present || !olderThan(ext.version, EXT_VERSION);
  const st = $('#connect-status');
  st.hidden = false;
  if (ui.syncError) st.innerHTML = `<span class="status-bad">Last sync didn’t work:</span> ${esc(ui.syncError)}`;
  else if (store.canvas && !store.sample) st.innerHTML = `<span class="status-ok">Connected.</span> Last sync ${span(Date.now() - Date.parse(store.canvas.at))} ago from ${esc(store.canvas.origin.replace(/^https?:\/\//, ''))}.`;
  else st.hidden = true;
}

async function downloadExtension() {
  try {
    const bytes = await extensionZip(new URL('./', location.href).href);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/zip' }));
    a.download = 'comet-hq-sync.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    toast('Downloaded. Unzip it, then load the folder in chrome://extensions.');
  } catch (e) {
    toast(`Couldn’t build the download: ${e.message}`);
  }
}

function openConnect() {
  fillConnect();
  $('#connect').showModal();
}

// ---------------------------------------------------------------- dialogs

function openTask(id) {
  const t = store.tasks.find((x) => x.id === id);
  if (!t) return;
  const f = $('#task-form');
  f.dataset.id = id;
  f.elements.title.value = t.title;
  f.cat.innerHTML = CATEGORIES.map((x) => `<option value="${x.id}">${x.label}</option>`).join('');
  f.cat.value = t.cat;
  f.pri.value = String(t.pri);
  f.due.value = t.due;
  f.time.value = t.time;
  f.notes.value = t.notes;
  $('#task-dlg').showModal();
}

function openApp(id) {
  const a = id ? store.apps.find((x) => x.id === id) : null;
  if (id && !a) return;
  const f = $('#app-form');
  f.dataset.id = a ? a.id : '';
  $('#app-title-h').textContent = a ? a.company : 'Add application';
  f.stage.innerHTML = STAGES.map((s) => `<option value="${s.id}">${esc(s.label)}</option>`).join('');
  f.outcome.innerHTML = `<option value="">—</option>${OUTCOMES.map((o) => `<option value="${o.id}">${esc(o.label)}</option>`).join('')}`;
  for (const k of ['company', 'role', 'url', 'applied', 'next', 'nextDue', 'nextTime', 'notes']) f.elements[k].value = a ? a[k] : '';
  f.stage.value = a ? a.stage : 'applied';
  f.outcome.value = a ? a.outcome : '';
  if (!a) f.applied.value = keyOf(Date.now());
  $('#outcome-field').hidden = f.stage.value !== 'closed';
  $('#app-delete').hidden = !a;
  $('#app-dlg').showModal();
  if (!a) f.company.focus();
}

function openProblem() {
  const f = $('#prob-form');
  f.reset();
  f.pattern.innerHTML = PATTERNS.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
  $('#prob-dlg').showModal();
}

// ---------------------------------------------------------------- actions

const settling = new Set();

/** Check something off: the circle fills and the title strikes through, then the row slips away. */
function toggleDone(key, btn) {
  if (!key || settling.has(key)) return;
  const row = btn?.closest('.pr');
  if (!row || btn.getAttribute('aria-pressed') === 'true' || !motionOK()) { applyDone(key); return; }
  settling.add(key);
  btn.setAttribute('aria-pressed', 'true');
  row.classList.add('checking');
  setTimeout(() => { settling.delete(key); applyDone(key); }, 460);
}

function applyDone(key) {
  if (key?.startsWith('t:')) {
    const t = store.tasks.find((x) => x.id === key.slice(2));
    if (!t) return;
    const was = t.done;
    t.done = was ? '' : new Date().toISOString();
    update();
    if (!was) toast(`Done: ${t.title}`, 'Undo', () => { t.done = ''; update(); });
    return;
  }
  const it = lastItems.get(key);
  if (it?.src === 'canvas') {
    if (store.done[key]) {
      delete store.done[key];
      update();
    } else if (!it.done) {
      store.done[key] = new Date().toISOString();
      update();
      toast(`Checked off in HQ: ${it.title}`, 'Undo', () => { delete store.done[key]; update(); });
    }
  }
}

function advanceApp(id) {
  const a = store.apps.find((x) => x.id === id);
  if (!a) return;
  const i = STAGES.findIndex((s) => s.id === a.stage);
  const next = STAGES[i + 1];
  if (!next || next.id === 'closed') return;
  const moved = { ...setStage(a, next.id), next: '', nextDue: '', nextTime: '' };
  store.apps = store.apps.map((x) => (x.id === id ? moved : x));
  update();
  toast(`${a.company} → ${next.label}. Add the next date?`, 'Edit', () => openApp(id));
}

function loadSample() {
  const hasData = !store.sample && (store.canvas || store.tasks.length || store.apps.length || Object.keys(store.dsa.problems).length);
  if (hasData && !confirm('Replace everything in HQ with sample data? Export first if you want to keep it.')) return;
  const keep = store.settings;
  store = cleanStore(sampleStore(Date.now()));
  store.settings.name = keep.name;
  store.settings.canvasUrl = keep.canvasUrl;
  store.settings.proxyUrl = keep.proxyUrl;
  update();
  toast('Sample data loaded. Clear it any time from the banner.');
}

function clearSample() {
  const keep = store.settings;
  store = emptyStore();
  store.settings = { ...defaultSettings(), name: keep.name, canvasUrl: keep.canvasUrl, proxyUrl: keep.proxyUrl };
  update();
}

function exportData() {
  const blob = new Blob([JSON.stringify({ app: 'comet-hq', exported: new Date().toISOString(), ...store }, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `comet-hq-${keyOf(Date.now())}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function importData(file) {
  try {
    const data = JSON.parse(await file.text());
    if (!data || typeof data !== 'object' || (data.app && data.app !== 'comet-hq')) throw new Error('not a Comet HQ backup');
    if (!confirm('Replace everything in HQ on this device with this backup?')) return;
    store = cleanStore(data);
    update();
    toast('Backup imported.');
  } catch (e) {
    toast(`Couldn’t import: ${e.message}`);
  }
}

const THEMES = ['auto', 'light', 'dark'];
function applyTheme(t) {
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  const btn = $('#theme-toggle');
  btn.innerHTML = ICON[t];
  btn.setAttribute('aria-label', `Theme: ${t}`);
  btn.title = `Theme: ${t}`;
}

function bindEvents() {
  for (const b of $$('.tab')) b.addEventListener('click', () => setTab(b.dataset.tab));

  document.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) {
      opener.closest('details')?.removeAttribute('open');
      if (opener.dataset.open === 'connect') openConnect();
      return;
    }
    if (e.target.closest('[data-close]')) { e.target.closest('dialog')?.close(); return; }
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const key = el.closest('[data-key]')?.dataset.key;
    const id = el.dataset.id;
    switch (el.dataset.act) {
      case 'done': toggleDone(key, el); break;
      case 'edit-task': openTask(lastItems.get(key)?.taskId || key?.slice(2)); break;
      case 'open-app': if (id) openApp(id); else setTab('intern'); break;
      case 'new-app': openApp(null); break;
      case 'advance': advanceApp(id); break;
      case 'go-dsa': setTab('dsa'); break;
      case 'show-all': ui.showAll = !ui.showAll; render(); break;
      case 'task-filter': ui.taskFilter = id; render(); break;
      case 'course-filter': ui.course = id; render(); break;
      case 'toggle-course': {
        const h = new Set(store.settings.hidden);
        if (h.has(id)) h.delete(id); else h.add(id);
        store.settings.hidden = [...h];
        if (ui.course === id) ui.course = 'all';
        update();
        break;
      }
      case 'sync': syncNow(); break;
      case 'download-ext': downloadExtension(); break;
      case 'load-sample': loadSample(); break;
      case 'practice': {
        const v = Number(el.dataset.v);
        const pday = practiceDay();
        store.dsa = practice(store.dsa, el.dataset.slug, v, pday);
        update();
        const s = store.dsa.problems[el.dataset.slug];
        toast(v ? `Next review ${dayLabel(s.due)}` : 'Logged the attempt. It’ll be back tomorrow.');
        break;
      }
      case 'undo-practice': store.dsa = undo(store.dsa, el.dataset.slug, practiceDay()); update(); break;
      case 'new-prob': openProblem(); break;
      default: break;
    }
  });

  document.addEventListener('submit', (e) => {
    if (e.target.id !== 'add-task') return;
    e.preventDefault();
    const f = e.target;
    const t = cleanTask({ id: newId(), title: f.elements.title.value, cat: f.cat.value, pri: Number(f.pri.value), due: f.due.value, created: new Date().toISOString() });
    if (!t) { f.elements.title.focus(); return; }
    f.elements.title.value = '';
    store.tasks.push(t);
    update();
    $('#new-task')?.focus();
  });

  document.addEventListener('change', (e) => {
    if (e.target.id === 'show-done') { ui.showDone = e.target.checked; render(); return; }
    const form = e.target.closest('#dsa-settings');
    if (form) {
      const s = store.settings;
      const n = (v, hi) => Math.min(hi, Math.max(0, Math.round(Number(v) || 0)));
      store.settings = { ...s, interviewLabel: form.interviewLabel.value.trim().slice(0, 80), interviewDate: form.interviewDate.value,
        dailyNew: n(form.dailyNew.value, 10), dailyReview: n(form.dailyReview.value, 20) };
      update();
    }
  });

  document.addEventListener('toggle', (e) => {
    const d = e.target;
    if (!(d instanceof HTMLDetailsElement) || !d.dataset.pattern) return;
    const was = ui.open.has(d.dataset.pattern);
    if (d.open === was) return;
    if (d.open) ui.open.add(d.dataset.pattern); else ui.open.delete(d.dataset.pattern);
    render();
  }, true);

  // Task dialog
  $('#task-form').addEventListener('submit', (e) => {
    const f = e.target;
    const t = store.tasks.find((x) => x.id === f.dataset.id);
    if (!t) return;
    const clean = cleanTask({ ...t, title: f.elements.title.value, cat: f.cat.value, pri: Number(f.pri.value), due: f.due.value, time: f.time.value, notes: f.notes.value });
    if (!clean) { e.preventDefault(); return; }
    Object.assign(t, clean);
    update();
  });
  $('#task-delete').addEventListener('click', () => {
    const f = $('#task-form');
    const i = store.tasks.findIndex((x) => x.id === f.dataset.id);
    if (i < 0) return;
    const [gone] = store.tasks.splice(i, 1);
    $('#task-dlg').close();
    update();
    toast(`Deleted: ${gone.title}`, 'Undo', () => { store.tasks.splice(i, 0, gone); update(); });
  });

  // Application dialog
  $('#app-form').stage.addEventListener('change', (e) => { $('#outcome-field').hidden = e.target.value !== 'closed'; });
  $('#app-form').addEventListener('submit', (e) => {
    const f = e.target;
    const old = store.apps.find((x) => x.id === f.dataset.id);
    const fields = { company: f.company.value, role: f.elements.role.value, url: f.url.value.trim(), applied: f.applied.value, next: f.next.value,
      nextDue: f.nextDue.value, nextTime: f.nextTime.value, notes: f.notes.value, outcome: f.outcome.value };
    if (f.url.value.trim() && !/^https:\/\//.test(f.url.value.trim())) { e.preventDefault(); toast('Links need to start with https://'); return; }
    let a = old ? { ...old, ...fields } : { id: newId(), stage: 'wishlist', history: [], created: new Date().toISOString(), ...fields };
    a = setStage(a, f.stage.value);
    if (f.applied.value) a.applied = f.applied.value;
    a.outcome = a.stage === 'closed' ? f.outcome.value : '';
    a.updated = new Date().toISOString();
    const clean = cleanApp(a);
    if (!clean) { e.preventDefault(); return; }
    store.apps = old ? store.apps.map((x) => (x.id === clean.id ? clean : x)) : [...store.apps, clean];
    update();
  });
  $('#app-delete').addEventListener('click', () => {
    const id = $('#app-form').dataset.id;
    const i = store.apps.findIndex((x) => x.id === id);
    if (i < 0) return;
    const [gone] = store.apps.splice(i, 1);
    $('#app-dlg').close();
    update();
    toast(`Deleted ${gone.company}`, 'Undo', () => { store.apps.splice(i, 0, gone); update(); });
  });

  // Custom problem dialog
  $('#prob-form').url.addEventListener('change', (e) => {
    const m = /leetcode\.com\/problems\/([a-z0-9-]+)/.exec(e.target.value);
    const f = $('#prob-form');
    if (m && !f.elements.title.value) f.elements.title.value = m[1].split('-').map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
  });
  $('#prob-form').addEventListener('submit', (e) => {
    const f = e.target;
    const url = f.url.value.trim();
    const title = f.elements.title.value.trim();
    const m = /leetcode\.com\/problems\/([a-z0-9-]+)/.exec(url);
    const slug = (m ? m[1] : `my-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`).slice(0, 100);
    if (!title || !slug || (url && !/^https:\/\//.test(url))) { e.preventDefault(); toast('Add a title, and a link starting with https://'); return; }
    if (allProblems(store.dsa.custom).some((p) => p.slug === slug)) { e.preventDefault(); toast('That problem is already in your list.'); return; }
    store.dsa.custom.push({ slug, title, diff: f.diff.value, pattern: f.pattern.value, url });
    ui.open.add(f.pattern.value);
    update();
    toast(`Added ${title} to ${PATTERN_NAME[f.pattern.value]}.`);
  });

  // Connect dialog
  $('#bookmarklet').addEventListener('click', (e) => {
    e.preventDefault();
    toast('Drag this button to your bookmarks bar, then click it while you’re on Canvas.');
  });
  $('#copy-bookmarklet').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bookmarklet(hqUrl()));
      toast('Copied. Paste it as a bookmark’s address.');
    } catch {
      toast('Couldn’t copy here. Long-press the Sync button and copy its link instead.');
    }
  });
  $('#address-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#canvas-url').value.trim().replace(/\/+$/, '');
    if (!/^https:\/\/[^\s/]+$/.test(url) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(url)) {
      toast('Paste the address from Canvas’s address bar, like https://elearning.utdallas.edu');
      return;
    }
    store.settings.canvasUrl = url;
    ui.syncError = '';
    save();
    if (ext.present) { $('#connect').close(); syncWithExtension(); } else { toast('Saved.'); fillConnect(); render(); }
  });
  $('#copy-ext-url').addEventListener('click', async () => {
    try { await navigator.clipboard.writeText('chrome://extensions'); toast('Copied. Paste it into a new tab’s address bar.'); } catch { toast('Type chrome://extensions into a new tab.'); }
  });
  window.addEventListener('resize', placeGlider);
  $('#token-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const url = $('#canvas-url').value.trim().replace(/\/+$/, '');
    const proxy = $('#proxy-url').value.trim().replace(/\/+$/, '');
    const local = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
    if (!/^https:\/\/[^\s/]+$/.test(url) && !local.test(url)) { toast('Enter your Canvas address, like https://elearning.utdallas.edu'); return; }
    if (proxy && !/^https:\/\/[^\s"'<>]+$/.test(proxy) && !local.test(proxy)) { toast('The proxy address needs to start with https://'); return; }
    store.settings.canvasUrl = url;
    store.settings.proxyUrl = proxy;
    const t = $('#canvas-token').value.trim();
    if (t) setToken(t);
    save();
    if (!getToken()) { toast('Paste an access token first.'); return; }
    $('#connect').close();
    syncWithToken();
  });
  $('#forget-token').addEventListener('click', () => { setToken(''); ui.syncError = ''; fillConnect(); render(); toast('Token removed from this browser.'); });

  // Top bar
  $('#sync-btn').addEventListener('click', () => syncNow());
  $('#theme-toggle').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme || 'auto';
    const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
    applyTheme(next);
    try { if (next === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch { /* fine */ }
  });
  const closeMenu = () => $('.menu').removeAttribute('open');
  $('#name-btn').addEventListener('click', () => {
    closeMenu();
    const n = prompt('Your name for the greeting', store.settings.name || store.canvas?.user || '');
    if (n === null) return;
    store.settings.name = n.trim().slice(0, 60);
    update();
  });
  $('#sample-btn').addEventListener('click', () => { closeMenu(); loadSample(); });
  $('#clear-sample').addEventListener('click', clearSample);
  $('#export-btn').addEventListener('click', () => { closeMenu(); exportData(); });
  $('#import-btn').addEventListener('click', () => { closeMenu(); $('#import-input').click(); });
  $('#import-input').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importData(f); });
  $('#reset-btn').addEventListener('click', () => {
    closeMenu();
    if (!confirm('Erase all of HQ’s data and the Canvas token from this browser? This can’t be undone.')) return;
    try { localStorage.removeItem(STORE_KEY); localStorage.removeItem(TOKEN_KEY); } catch { /* fine */ }
    store = emptyStore();
    ui.syncError = '';
    render();
  });
  document.addEventListener('click', (e) => { if (!e.target.closest('.menu')) closeMenu(); });

  // Another tab changed the data, or the bookmarklet reopened this tab with fresh Canvas data.
  window.addEventListener('storage', (e) => {
    if (e.key === STORE_KEY) { load(); render(); } else if (e.key === LOCKIN_KEY && tab === 'today') render();
  });
  window.addEventListener('hashchange', ingestHash);

  // Keep relative times fresh, but never re-render under someone's typing or an open dialog.
  const quietRender = () => {
    if (document.visibilityState !== 'visible' || $$('dialog[open]').length) return;
    if (document.activeElement?.matches?.('main input, main select, main textarea')) return;
    render();
  };
  setInterval(quietRender, 60e3);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    quietRender();
    maybeAutoSync();
  });
}

/** Every time HQ opens (or you come back to it), refresh from Canvas if a helper is set up. */
function maybeAutoSync() {
  if (ui.syncing || !canvasOrigin()) return;
  const age = store.canvas && !store.sample ? Date.now() - Date.parse(store.canvas.at) : Infinity;
  if (ext.present) {
    if (age > EXT_SYNC_MS || ui.syncError) syncWithExtension({ quiet: true });
  } else if (getToken() && store.settings.canvasUrl && age > AUTO_SYNC_MS) {
    syncWithToken({ quiet: true });
  }
}

function init() {
  load();
  try { const t = localStorage.getItem(TAB_KEY); if (TABS.includes(t)) tab = t; } catch { /* fine */ }
  applyTheme(document.documentElement.dataset.theme || 'auto');
  bindEvents();
  render({ enter: true });
  requestAnimationFrame(() => requestAnimationFrame(() => $('.tabs').classList.add('ready')));
  ext = connectExtension(() => {
    if ($('#connect').open) fillConnect();
    render();
    maybeAutoSync();
  });
  if (location.hash.startsWith('#canvas=')) { tab = 'today'; ingestHash(); } else maybeAutoSync();
}

init();
