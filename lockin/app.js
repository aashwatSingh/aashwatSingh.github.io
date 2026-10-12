import {
  DEFAULT_COMMITMENTS, heatmap, todayKey, addDays, daysBetween, weekStart, valueOf, markOf, dayStatus, streak,
  keptRate, takeaways, weekStats, weeklyVerdict, truthContext, pickTruth, pickIndex, socialSuggestion, mergeDays,
} from './logic.js';
import { TRUTHS, SOCIAL_LADDER, WEAK_SPOTS, AMBITIONS, WHY_DRAFT } from './truths.js';

const STORE_KEY = 'lockin:v1';
const TIMER_KEY = 'lockin:timer';
const THEME_KEY = 'lockin:theme';
const HAMZA_KEY = 'hamza-tracker:v1';
const REVIEW_HOUR = 18;
const KINDS = ['check', 'count', 'focus'];
const MARKS = ['full', 'min', 'miss'];
const TAGS = new Set([...WEAK_SPOTS, ...AMBITIONS].map((t) => t.tag));
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[\w-]{1,40}$/;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

const ICON = {
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>',
};

const DATE_LONG = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
const DATE_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
const WEEKDAY = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const TIME = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const asDate = (key) => { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d); };

// ---------------------------------------------------------------- storage

let storageOk = true;
let store = { version: 1, profile: null, days: {} };

const str = (v, max = 600) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v, lo, hi, dflt) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
};

function cleanCommitment(c, i) {
  if (!c || typeof c !== 'object' || !KINDS.includes(c.kind)) return null;
  const id = ID_RE.test(c.id) ? c.id : `c${i}${Date.now().toString(36)}`;
  const label = str(c.label, 60).trim();
  if (c.kind === 'check') {
    const full = str(c.full, 120).trim();
    const min = str(c.min, 120).trim();
    if (!label && !full && !min) return null;
    return { id, label: label || full || 'Commitment', kind: 'check', full, min };
  }
  const focus = c.kind === 'focus';
  const full = num(c.full, 1, focus ? 600 : 100, focus ? 50 : 3);
  const out = {
    id, label: label || (focus ? 'Deep work' : 'Reps'), kind: c.kind, full,
    min: num(c.min, 1, full, 1), unit: focus ? 'min' : str(c.unit, 40).trim() || 'reps',
  };
  if (typeof c.link === 'string' && /^https:\/\/[^\s"'<>]+$/.test(c.link)) out.link = c.link.slice(0, 300);
  return out;
}

function nextMay() {
  const now = new Date();
  return `${now.getMonth() >= 4 ? now.getFullYear() + 1 : now.getFullYear()}-05-26`;
}

function defaultProfile() {
  return {
    why: '', letter: '', tags: [], commitments: structuredClone(DEFAULT_COMMITMENTS),
    deadlineLabel: 'Summer internship starts', deadline: nextMay(), startDate: todayKey(), socialTarget: 3,
  };
}

function cleanProfile(p) {
  if (!p || typeof p !== 'object') return null;
  const seen = new Set();
  const commitments = (Array.isArray(p.commitments) ? p.commitments : [])
    .map(cleanCommitment).filter((c) => c && !seen.has(c.id) && seen.add(c.id)).slice(0, 6);
  return {
    why: str(p.why), letter: str(p.letter),
    tags: [...new Set((Array.isArray(p.tags) ? p.tags : []).filter((t) => TAGS.has(t)))],
    commitments: commitments.length ? commitments : structuredClone(DEFAULT_COMMITMENTS),
    deadlineLabel: str(p.deadlineLabel, 60), deadline: DAY_RE.test(p.deadline) ? p.deadline : '',
    startDate: DAY_RE.test(p.startDate) ? p.startDate : todayKey(),
    socialTarget: num(p.socialTarget, 0, 21, 3),
  };
}

function cleanDay(d) {
  if (!d || typeof d !== 'object') return null;
  const marks = {};
  for (const [k, v] of Object.entries(d.marks || {})) if (ID_RE.test(k) && MARKS.includes(v)) marks[k] = v;
  const counts = {};
  for (const [k, v] of Object.entries(d.counts || {})) if (ID_RE.test(k)) counts[k] = num(v, 0, 999, 0);
  const social = (Array.isArray(d.social) ? d.social : [])
    .filter((s) => s && typeof s.note === 'string' && s.note.trim())
    .slice(0, 50).map((s) => ({ note: str(s.note, 200), at: str(s.at, 40) }));
  return {
    oneThing: str(d.oneThing, 200), firstStep: str(d.firstStep, 200), marks, counts,
    focusMin: num(d.focusMin, 0, 1440, 0), urges: num(d.urges, 0, 999, 0), social,
    win: str(d.win, 240), lesson: str(d.lesson, 240), reviewed: str(d.reviewed, 40),
    updated: str(d.updated, 40) || new Date(0).toISOString(),
  };
}

function cleanDays(days) {
  const out = {};
  for (const [k, d] of Object.entries(days && typeof days === 'object' ? days : {})) {
    const clean = DAY_RE.test(k) && cleanDay(d);
    if (clean) out[k] = clean;
  }
  return out;
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data === 'object') store = { version: 1, profile: cleanProfile(data.profile), days: cleanDays(data.days) };
    }
    localStorage.setItem(`${STORE_KEY}:probe`, '1');
    localStorage.removeItem(`${STORE_KEY}:probe`);
  } catch {
    storageOk = false;
  }
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch {
    storageOk = false;
  }
  $('#storage-warning').hidden = storageOk;
}

function readHamza() {
  try {
    const data = JSON.parse(localStorage.getItem(HAMZA_KEY) || 'null');
    return data && typeof data.videos === 'object' ? data : null;
  } catch {
    return null;
  }
}

let today = todayKey();
const getDay = (k = today) => store.days[k] || {};

function updateDay(k, fn) {
  const next = fn(structuredClone(store.days[k] || {})) || {};
  next.updated = new Date().toISOString();
  store.days[k] = next;
  saveStore();
}

const P = () => store.profile;
const opts = () => ({ today, startDate: P().startDate, commitments: P().commitments });
const countCommitment = () => P().commitments.find((c) => c.kind === 'count');
const isKept = (k = today) => dayStatus(store.days[k], P().commitments).kept;

// Toast when an action turns the day from open to kept.
function afterChange(wasKept) {
  renderAll();
  if (!wasKept && isKept()) {
    const n = daysBetween(P().startDate, today) + 1;
    toast(`Locked in. Day ${n} kept.`);
  }
}

// ---------------------------------------------------------------- UI helpers

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  // A modal dialog sits in the top layer, so the toast has to live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2800);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const THEMES = ['auto', 'light', 'dark'];
function applyTheme(theme) {
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const btn = $('#theme-toggle');
  btn.innerHTML = ICON[theme];
  btn.setAttribute('aria-label', `Theme: ${theme}`);
  btn.title = `Theme: ${theme}`;
}

const setValue = (el, v) => { if (document.activeElement !== el) el.value = v || ''; };

// ---------------------------------------------------------------- today

function renderHero(s) {
  const n = daysBetween(P().startDate, today) + 1;
  $('#hero-date').textContent = DATE_LONG.format(asDate(today));
  $('#hero-day').textContent = `Day ${n}`;
  const pills = [];
  if (s.current) pills.push(`<span class="pill on">${s.current}-day streak</span>`);
  if (s.atRisk) pills.push('<span class="pill">Yesterday slipped. Don’t miss twice.</span>');
  if (P().deadline && P().deadline > today) {
    const left = daysBetween(today, P().deadline);
    const when = left <= 60 ? plural(left, 'day') : plural(Math.floor(left / 7), 'week');
    pills.push(`<span class="pill">${when} until ${esc(P().deadlineLabel || 'your deadline')}</span>`);
  }
  $('#hero-meta').innerHTML = pills.join('');
}

function renderTruth(s) {
  // Milestones count kept days before today, so the message holds steady all day.
  const before = s.current - (isKept() ? 1 : 0);
  const context = truthContext({ missedYesterday: s.missedYesterday, current: before, dateKey: today });
  const t = pickTruth(TRUTHS, { dateKey: today, context, tags: P().tags });
  const label = { miss: 'Yesterday', streak: `${before} days straight`, monday: 'New week' }[context] || 'Today’s truth';
  $('#truth-label').textContent = label;
  $('#truth-text').textContent = t?.text || '';
}

function renderOneThing() {
  const d = getDay();
  setValue($('#one-thing'), d.oneThing);
  setValue($('#first-step'), d.firstStep);
}

function markSeg(c, mark) {
  return `<div class="seg" role="group" aria-label="Mark ${esc(c.label)}" data-cid="${esc(c.id)}">
    ${MARKS.map((m) => `<button type="button" data-mark="${m}" aria-pressed="${mark === m}">${{ full: 'Full', min: 'Min', miss: 'Missed' }[m]}</button>`).join('')}
  </div>`;
}

function linkHost(link) {
  try { return link ? new URL(link).hostname.replace(/^(www|app)\./, '') : ''; } catch { return ''; }
}

function commitmentRow(c, day) {
  const mark = markOf(c, day);
  const v = valueOf(c, day);
  let value = '';
  let sub = '';
  let extra = '';
  if (c.kind === 'check') {
    sub = `<b>Full</b> ${esc(c.full || c.label)}${c.min ? ` · <b>Min</b> ${esc(c.min)}` : ''}`;
  } else if (c.kind === 'focus') {
    value = `${v} / ${c.full} min`;
    sub = `<b>Full</b> ${c.full} min · <b>Min</b> ${c.min} min, logged by the focus timer`;
    extra = `<div class="bar"><span style="width:${Math.min(100, (v / c.full) * 100)}%"></span></div>`;
  } else {
    value = `${v} / ${c.full}`;
    sub = `<b>Full</b> ${c.full} · <b>Min</b> ${c.min} ${esc(c.unit)}`;
  }
  const controls = [];
  if (c.kind === 'count') {
    controls.push(`<div class="stepper" data-count="${esc(c.id)}">
      <button type="button" data-step="-1" aria-label="One less">−</button>
      <output aria-label="${esc(c.label)} today">${v}</output>
      <button type="button" data-step="1" aria-label="One more">+</button>
    </div>`);
  }
  if (c.kind === 'focus') controls.push(`<button type="button" class="btn" data-focus="${c.full}">Start focus</button>`);
  controls.push(markSeg(c, mark));
  const host = linkHost(c.link);
  if (host) controls.push(`<a class="cm-link" href="${esc(c.link)}" target="_blank" rel="noopener">Open ${esc(host)} ↗</a>`);
  return `<div class="cm ${mark === 'full' ? 'is-full' : mark === 'min' ? 'is-min' : ''}">
    <div class="cm-head"><span class="cm-label"><i aria-hidden="true"></i>${esc(c.label)}</span><span class="cm-value">${value}</span></div>
    <div class="cm-sub">${sub}</div>
    ${extra}
    <div class="cm-controls">${controls.join('')}</div>
  </div>`;
}

function renderStandard() {
  const day = getDay();
  const st = dayStatus(day, P().commitments);
  $('#commitments').innerHTML = P().commitments.map((c) => commitmentRow(c, day)).join('');
  const pill = $('#standard-count');
  pill.textContent = st.kept ? 'Kept' : `${st.met} of ${st.total}`;
  pill.className = `pill${st.kept ? ' on' : ''}`;
  $('#standard').classList.toggle('is-kept', st.kept);
  $('#locked').hidden = !st.kept;
  if (st.kept) {
    const n = daysBetween(P().startDate, today) + 1;
    $('#locked-title').textContent = st.full === st.total ? 'Locked in. Full marks.' : 'Locked in.';
    $('#locked-sub').textContent = `Day ${n} kept. Now you’ve earned the lesson.`;
  }
}

function renderOwnWords() {
  const hamza = readHamza();
  const list = takeaways(hamza);
  const watched = Object.values(hamza?.videos || {}).filter((p) => p?.watched).length;
  const box = $('#own-words');
  box.classList.remove('is-warning');
  if (list.length) {
    $('#own-h').textContent = 'In your own words';
    $('#own-text').textContent = list[pickIndex(list.length, today)].text;
    $('#own-sub').textContent = 'You wrote this after a lesson. Where does it show up in today?';
    box.hidden = false;
  } else if (watched >= 3) {
    $('#own-h').textContent = 'Watching vs doing';
    $('#own-text').textContent = `You’ve watched ${watched} lessons and written down zero takeaways.`;
    $('#own-sub').textContent = 'If it wasn’t worth writing down, was it worth the hour? Next time, write one line before you close the video.';
    box.classList.add('is-warning');
    box.hidden = false;
  } else {
    box.hidden = true;
  }
}

function socialReps() {
  const all = [];
  for (const [k, d] of Object.entries(store.days)) for (const s of d.social || []) all.push({ day: k, ...s });
  return all.sort((a, b) => (b.at || b.day).localeCompare(a.at || a.day));
}

function renderSocial() {
  const target = P().socialTarget;
  const reps = socialReps();
  const box = $('#social');
  box.hidden = !target && !reps.length;
  if (box.hidden) return;
  const from = weekStart(today);
  const week = reps.filter((r) => r.day >= from && r.day <= today);
  const pill = $('#social-count');
  pill.textContent = `${week.length} / ${target}`;
  pill.className = `pill${target && week.length >= target ? ' on' : ''}`;
  const sug = socialSuggestion(SOCIAL_LADDER, reps.length, from);
  $('#social-level').textContent = `Level ${sug.level} · ${sug.name}`;
  $('#social-text').textContent = sug.text;
  $('#social-list').innerHTML = week.map((r) =>
    `<li>${esc(r.note)}<small>${WEEKDAY.format(asDate(r.day))}</small></li>`).join('');
}

let reviewForced = false;
function renderReview() {
  const day = getDay();
  const hour = new Date().getHours();
  const open = reviewForced || hour >= REVIEW_HOUR || hour < 4;
  const state = $('#review-state');
  $('#review-done').hidden = !day.reviewed;
  $('#review-form').hidden = !!day.reviewed || !open;
  $('#review-closed').hidden = !!day.reviewed || open;
  state.textContent = day.reviewed ? 'Closed' : open ? 'Open' : '';
  state.className = `pill${day.reviewed ? ' good' : open ? ' on' : ''}`;
  state.hidden = !state.textContent;

  if (day.reviewed) {
    const tmr = getDay(addDays(today, 1));
    const kept = isKept();
    $('#review-done').innerHTML = `
      <p><strong>${kept ? 'Day kept and closed.' : 'Day closed. Logged honestly.'}</strong> <span class="muted small">${esc(TIME.format(new Date(day.reviewed)))}</span></p>
      ${day.win ? `<p>Win: ${esc(day.win)}</p>` : ''}
      ${tmr.oneThing ? `<p class="muted">Tomorrow: ${esc(tmr.oneThing)}</p>` : ''}
      <button type="button" class="btn ghost" id="review-edit">Edit review</button>`;
    return;
  }
  if (!open) return;
  const pending = P().commitments.filter((c) => markOf(c, day) === null);
  $('#review-open-items').innerHTML = pending.length
    ? `<p class="muted small">Still open. Be honest:</p>${pending.map((c) =>
      `<div class="review-open-item"><span>${esc(c.label)}</span>${markSeg(c, null)}</div>`).join('')}`
    : '';
  setValue($('#review-win'), day.win);
  setValue($('#review-lesson'), day.lesson);
  const tmr = getDay(addDays(today, 1));
  setValue($('#review-next'), tmr.oneThing);
  setValue($('#review-next-step'), tmr.firstStep);
  $('#review-next').placeholder = day.oneThing ? `Today’s was: ${day.oneThing}` : 'The task that makes tomorrow a win';
}

// ---------------------------------------------------------------- progress

function renderProgress() {
  const o = opts();
  const s = streak(store.days, o);
  const rate = keptRate(store.days, o);
  const hamza = readHamza();
  const w = weekStats(store.days, o, hamza);
  const cc = countCommitment();
  const countTarget = cc ? cc.full * 5 : 0;
  const socialTarget = P().socialTarget;
  const total = P().commitments.length;

  // Heatmap: grows from 6 weeks up to 26 as your history gets longer.
  const span = daysBetween(o.startDate, today) + asDate(o.startDate).getDay() + (6 - asDate(today).getDay()) + 1;
  const weeks = Math.min(26, Math.max(6, Math.ceil(span / 7)));
  const cols = heatmap(new Map(), today, weeks).map((col) => `<div class="hm-col">${col.map((cell) => {
    if (!cell) return '<span class="hm-cell none"></span>';
    if (cell.key < o.startDate) return '<span class="hm-cell pre"></span>';
    const st = dayStatus(store.days[cell.key], P().commitments);
    const state = s.states.get(cell.key);
    let cls = '';
    if (state === 'kept') cls = st.full === total ? 'full' : 'kept';
    else if (state === 'slip') cls = 'slip';
    else if (st.met) cls = 'part';
    if (state === 'today') cls += ' today';
    const label = `${DATE_SHORT.format(asDate(cell.key))}: ${st.met} of ${total}${state === 'slip' ? ', forgiven' : ''}`;
    return `<span class="hm-cell ${cls}" title="${label}"></span>`;
  }).join('')}</div>`).join('');

  const row = (label, n, of, text) => `<div class="week-row"><span>${label}</span>
    <div class="bar"><span style="width:${of ? Math.min(100, (n / of) * 100) : 0}%"></span></div>
    <span class="n">${text}</span></div>`;

  const entries = [];
  for (const k of Object.keys(store.days).sort().reverse()) {
    const d = store.days[k];
    if (d.win) entries.push({ k, kind: 'Win', text: d.win });
    for (const r of d.social || []) entries.push({ k, kind: 'Rep', text: r.note });
    if (d.urges) entries.push({ k, kind: 'Urge', text: `Beat the urge ${d.urges === 1 ? 'once' : `${d.urges} times`}.` });
  }
  const shown = entries.slice(0, 80);

  $('#progress').innerHTML = `
    <section class="panel">
      <div class="streak-head"><strong>${s.current}</strong><span>day streak${s.atRisk ? ' · yesterday slipped, so don’t miss twice' : ''}</span></div>
      <dl class="big-stats">
        <div><dt>Longest</dt><dd>${s.longest}</dd></div>
        <div><dt>Days kept</dt><dd>${s.keptDays}</dd></div>
        <div><dt>Comebacks</dt><dd>${s.comebacks}</dd></div>
        <div><dt>Kept, last 30</dt><dd>${rate === null ? '–' : `${Math.round(rate * 100)}%`}</dd></div>
      </dl>
    </section>

    <section class="panel">
      <h3>Every day since you started</h3>
      <div class="heatmap" style="grid-template-columns: repeat(${weeks}, minmax(8px, 26px))">${cols}</div>
      <p class="hm-legend">
        <span><i class="hm-cell full"></i>Full marks</span>
        <span><i class="hm-cell kept"></i>Kept</span>
        <span><i class="hm-cell slip"></i>Slip, forgiven</span>
        <span><i class="hm-cell part"></i>Partial</span>
        <span><i class="hm-cell"></i>Missed</span>
      </p>
      <p class="muted small">Never miss twice: one slip between kept days doesn’t break the streak. Two in a row does.</p>
    </section>

    <section class="panel">
      <h3>This week <small class="muted">since ${esc(DATE_SHORT.format(asDate(w.from)))}</small></h3>
      ${row('Days kept', w.keptDays, w.daysElapsed, `${w.keptDays} / ${w.daysElapsed}`)}
      ${cc ? row(esc(cc.label), w.counts[cc.id] || 0, countTarget, `${w.counts[cc.id] || 0} / ${countTarget}`) : ''}
      ${row('Focus', w.focusMin, 60 * 6, `${(w.focusMin / 60).toFixed(1)} h`)}
      ${socialTarget ? row('Social reps', w.social, socialTarget, `${w.social} / ${socialTarget}`) : ''}
      ${row('Urges beaten', w.urges, Math.max(w.urges, 1), String(w.urges))}
      ${hamza ? `<div class="watch-vs">
        <div><strong>${w.lessons}</strong><span>Hamza lessons watched</span></div>
        <div><strong>${w.keptDays}</strong><span>Days you kept your word</span></div>
      </div>` : ''}
      <p class="verdict">${esc(weeklyVerdict(w, { countTarget, socialTarget }))}</p>
    </section>

    <section class="panel">
      <h3>Proof file</h3>
      <p class="muted small">Read this when you doubt yourself. Every line is something you actually did.</p>
      ${shown.length ? `<ul class="proof">${shown.map((e) => `<li><time>${esc(DATE_SHORT.format(asDate(e.k)))}</time>
        <span><span class="kind">${e.kind}</span>${esc(e.text)}</span></li>`).join('')}</ul>
        ${entries.length > shown.length ? `<p class="muted small">…and ${entries.length - shown.length} more.</p>` : ''}`
        : '<p class="empty-note">Empty for now. Tonight’s win will be the first line.</p>'}
    </section>

    <section class="panel">
      <h3>Your why</h3>
      <p class="why-text">${P().why ? esc(P().why) : '<span class="muted">You haven’t written it yet.</span>'}</p>
      <button type="button" class="btn ghost" data-open-setup>Edit your setup</button>
    </section>`;
}

// ---------------------------------------------------------------- render

let tab = location.hash === '#progress' ? 'progress' : 'today';

function renderAll() {
  if (!P()) return;
  today = todayKey();
  const s = streak(store.days, opts());
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-pressed', String(b.dataset.tab === tab));
  $('#view-today').hidden = tab !== 'today';
  $('#view-progress').hidden = tab !== 'progress';
  renderHero(s);
  renderTruth(s);
  if (tab === 'today') {
    renderOneThing();
    renderStandard();
    renderOwnWords();
    renderSocial();
    renderReview();
  } else {
    renderProgress();
  }
}

// ---------------------------------------------------------------- focus timer

let timer = null; // { start, dur, label, day }
let preset = 25;
let tick = null;
let wakeLock = null;
let audio = null;

function loadTimer() {
  try {
    const t = JSON.parse(localStorage.getItem(TIMER_KEY) || 'null');
    if (t && Number.isFinite(t.start) && Number.isFinite(t.dur) && DAY_RE.test(t.day)) return t;
  } catch {}
  return null;
}
function saveTimer() {
  try {
    if (timer) localStorage.setItem(TIMER_KEY, JSON.stringify(timer));
    else localStorage.removeItem(TIMER_KEY);
  } catch {}
}

function primeAudio() {
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    audio.resume?.();
  } catch {}
}
function chime() {
  navigator.vibrate?.([200, 100, 200]);
  if (!audio) return;
  const t = audio.currentTime;
  [[0, 660], [0.28, 880]].forEach(([dt, f]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + dt);
    g.gain.exponentialRampToValueAtTime(0.25, t + dt + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dt + 0.7);
    o.connect(g).connect(audio.destination);
    o.start(t + dt);
    o.stop(t + dt + 0.75);
  });
}

async function holdScreen() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
}
function releaseScreen() {
  wakeLock?.release?.().catch(() => {});
  wakeLock = null;
}

const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function timerLabel() {
  const d = getDay();
  return d.firstStep || d.oneThing || '';
}

function openTimer(minutes, autostart = false) {
  if (!timer) {
    preset = minutes || preset;
    $('#timer-label').textContent = timerLabel() ? `Working on: ${timerLabel()}` : 'Working on your One Thing.';
  }
  updateTimerUI();
  if (!$('#timer').open) $('#timer').showModal();
  if (autostart && !timer) startTimer();
}

function startTimer() {
  primeAudio();
  timer = { start: Date.now(), dur: preset, label: timerLabel(), day: today };
  saveTimer();
  holdScreen();
  runTick();
}

function stopTimer(completed) {
  if (!timer) return;
  const minutes = completed ? timer.dur : Math.floor((Date.now() - timer.start) / 60000);
  const day = timer.day;
  timer = null;
  saveTimer();
  releaseScreen();
  clearInterval(tick);
  document.title = 'Lock In';
  const wasKept = P() ? isKept() : true;
  if (minutes > 0 && P()) updateDay(day, (d) => ({ ...d, focusMin: (d.focusMin || 0) + minutes }));
  updateTimerUI();
  if (completed) toast(`${minutes} focused minutes logged. That’s a rep.`);
  else if (minutes > 0) toast(`${plural(minutes, 'minute')} logged. Partial counts.`);
  else toast('Stopped. Under a minute, so nothing logged.');
  afterChange(wasKept);
}

function runTick() {
  clearInterval(tick);
  tick = setInterval(updateTimerUI, 250);
  updateTimerUI();
}

function updateTimerUI() {
  const pill = $('#timer-pill');
  for (const b of document.querySelectorAll('#timer-presets button')) {
    b.setAttribute('aria-pressed', String(Number(b.dataset.min) === (timer ? timer.dur : preset)));
    b.disabled = !!timer;
  }
  $('#timer-start').hidden = !!timer;
  $('#timer-stop').hidden = !timer;
  if (!timer) {
    pill.hidden = true;
    $('#timer-clock').textContent = fmt(preset * 60000);
    $('#timer-bar').style.width = '0%';
    return;
  }
  const total = timer.dur * 60000;
  const left = timer.start + total - Date.now();
  if (left <= 0) {
    chime();
    stopTimer(true);
    return;
  }
  const text = fmt(left);
  $('#timer-clock').textContent = text;
  $('#timer-bar').style.width = `${Math.min(100, ((total - left) / total) * 100)}%`;
  pill.hidden = $('#timer').open;
  pill.textContent = `Focus · ${text}`;
  document.title = `${text} · Lock In`;
}

// ---------------------------------------------------------------- about to slip?

let breathTimers = [];
function clearBreath() {
  breathTimers.forEach(clearTimeout);
  breathTimers.forEach(clearInterval);
  breathTimers = [];
}

function openUrge() {
  clearBreath();
  $('#urge-breathe').hidden = false;
  $('#urge-remember').hidden = true;
  const t = pickTruth(TRUTHS, { dateKey: today, context: 'urge', salt: String(Date.now()) });
  $('#urge-truth').textContent = t?.text || '';
  const started = Date.now();
  const step = () => {
    const elapsed = (Date.now() - started) / 1000;
    const left = Math.max(0, Math.ceil(20 - elapsed));
    $('#breath-left').textContent = left;
    $('#breath-text').textContent = elapsed % 10 < 4 ? 'Breathe in…' : 'Breathe out…';
    if (left === 0) showRemember();
  };
  breathTimers.push(setInterval(step, 250));
  step();
  $('#urge').showModal();
}

function showRemember() {
  clearBreath();
  $('#urge-breathe').hidden = true;
  $('#urge-remember').hidden = false;
  const p = P();
  $('#urge-why').textContent = p?.why || 'You haven’t written your why yet. When this passes, do it in setup. It’s what this screen is for.';
  $('#urge-letter').textContent = p?.letter || '';
  $('#urge-letter-box').hidden = !p?.letter;
  const label = timerLabel();
  $('#swap-focus').textContent = label ? `10 minutes on: ${label}` : '10 minutes on your One Thing';
  $('#urge-remember button').focus();
}

function swap(kind) {
  primeAudio();
  updateDay(today, (d) => ({ ...d, urges: (d.urges || 0) + 1 }));
  $('#urge').close();
  if (kind === 'focus') openTimer(10, true);
  else if (kind === 'apply') toast(countCommitment() ? `Go. Hit + on ${countCommitment().label} when it’s sent.` : 'Go. Send it now.');
  else toast('Go. Phone stays here. Five minutes.');
  renderAll();
}

// ---------------------------------------------------------------- setup

let setupStep = 0;
let draft = null;
const STEPS = 4;

function commitmentEditor(c, i) {
  const kindSel = `<select data-k="kind" aria-label="Type">
    <option value="check"${c.kind === 'check' ? ' selected' : ''}>Yes / no</option>
    <option value="count"${c.kind === 'count' ? ' selected' : ''}>Count</option>
    <option value="focus"${c.kind === 'focus' ? ' selected' : ''}>Focus minutes</option>
  </select>`;
  let levels;
  if (c.kind === 'check') {
    levels = `<label class="field"><span>Full</span><input data-k="full" maxlength="120" value="${esc(c.full)}" placeholder="What full looks like"></label>
      <label class="field"><span>Minimum</span><input data-k="min" maxlength="120" value="${esc(c.min)}" placeholder="Your worst-day version"></label>`;
  } else {
    levels = `<label class="field"><span>Full${c.kind === 'focus' ? ' (minutes)' : ''}</span><input data-k="full" type="number" min="1" max="600" value="${c.full}"></label>
      <label class="field"><span>Minimum</span><input data-k="min" type="number" min="1" max="600" value="${c.min}"></label>
      ${c.kind === 'count' ? `<label class="field"><span>Counting</span><input data-k="unit" maxlength="40" value="${esc(c.unit)}" placeholder="apps, pages, sets…"></label>` : ''}`;
  }
  return `<div class="cm-edit" data-i="${i}" data-id="${esc(c.id)}" data-link="${esc(c.link || '')}">
    <div class="cm-edit-head">
      <label class="field"><span>Commitment</span><input data-k="label" maxlength="60" value="${esc(c.label)}" placeholder="e.g. Gym"></label>
      <label class="field"><span>Type</span>${kindSel}</label>
      <button type="button" class="icon-btn" data-remove aria-label="Remove ${esc(c.label || 'commitment')}">${ICON.close}</button>
    </div>
    <div class="two">${levels}</div>
  </div>`;
}

function readCommitments() {
  return [...document.querySelectorAll('#setup-commitments .cm-edit')].map((el) => {
    const v = (k) => el.querySelector(`[data-k="${k}"]`)?.value ?? '';
    const c = { id: el.dataset.id, label: v('label'), kind: v('kind'), full: v('full'), min: v('min'), unit: v('unit') };
    if (el.dataset.link) c.link = el.dataset.link;
    return c;
  });
}

function renderCommitmentEditors() {
  $('#setup-commitments').innerHTML = draft.commitments.map(commitmentEditor).join('');
  $('#add-commitment').hidden = draft.commitments.length >= 6;
}

function checkList(items, chosen) {
  return items.map((t) => `<label class="check"><input type="checkbox" value="${t.tag}"${chosen.includes(t.tag) ? ' checked' : ''}> ${esc(t.label)}</label>`).join('');
}

function openSetup() {
  draft = structuredClone(P() || defaultProfile());
  setupStep = 0;
  $('#setup-why').value = draft.why;
  $('#setup-letter').value = draft.letter;
  $('#setup-deadline-label').value = draft.deadlineLabel;
  $('#setup-deadline').value = draft.deadline;
  $('#setup-social').value = draft.socialTarget;
  $('#setup-weak').innerHTML = checkList(WEAK_SPOTS, draft.tags);
  $('#setup-ambitions').innerHTML = checkList(AMBITIONS, draft.tags);
  renderCommitmentEditors();
  showSetupStep();
  if (!$('#setup').open) $('#setup').showModal();
}

function showSetupStep() {
  for (const el of document.querySelectorAll('.setup-step')) el.hidden = Number(el.dataset.step) !== setupStep;
  $('#setup-steps').innerHTML = Array.from({ length: STEPS }, (_, i) => `<i class="${i <= setupStep ? 'on' : ''}"></i>`).join('');
  $('#setup-back').style.visibility = setupStep ? 'visible' : 'hidden';
  $('#setup-next').textContent = setupStep === STEPS - 1 ? (P() ? 'Save' : 'Start Day 1') : 'Next';
  document.querySelector(`.setup-step[data-step="${setupStep}"] textarea, .setup-step[data-step="${setupStep}"] input`)?.focus({ preventScroll: true });
}

function finishSetup() {
  draft.commitments = readCommitments();
  const first = !P();
  const profile = cleanProfile({
    ...draft,
    why: $('#setup-why').value.trim(),
    letter: $('#setup-letter').value.trim(),
    tags: [...document.querySelectorAll('#setup-weak input:checked, #setup-ambitions input:checked')].map((i) => i.value),
    deadlineLabel: $('#setup-deadline-label').value.trim(),
    deadline: $('#setup-deadline').value,
    socialTarget: $('#setup-social').value,
  });
  store.profile = profile;
  saveStore();
  $('#setup').close();
  renderAll();
  toast(first ? 'Day 1. Set your One Thing and go.' : 'Setup saved.');
  if (first) $('#one-thing').focus();
}

// ---------------------------------------------------------------- events

let saveTimerId;
function bindEvents() {
  // Tabs
  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      tab = b.dataset.tab;
      history.replaceState(null, '', tab === 'progress' ? '#progress' : location.pathname + location.search);
      renderAll();
      window.scrollTo({ top: 0 });
    });
  }

  // One Thing
  const saveOne = () => {
    clearTimeout(saveTimerId);
    saveTimerId = setTimeout(() => {
      updateDay(today, (d) => ({ ...d, oneThing: $('#one-thing').value.trim(), firstStep: $('#first-step').value.trim() }));
      $('#one-saved').textContent = 'Saved';
      setTimeout(() => { $('#one-saved').textContent = ''; }, 1500);
    }, 400);
  };
  $('#one-thing').addEventListener('input', saveOne);
  $('#first-step').addEventListener('input', saveOne);
  $('#start-now').addEventListener('click', () => openTimer(10, true));

  // Marks, counters and focus buttons (the standard and the review share these)
  document.addEventListener('click', (e) => {
    const markBtn = e.target.closest('.seg[data-cid] button[data-mark]');
    if (markBtn) {
      const id = markBtn.parentElement.dataset.cid;
      const m = markBtn.dataset.mark;
      const wasKept = isKept();
      updateDay(today, (d) => {
        const marks = { ...d.marks };
        if (marks[id] === m) delete marks[id];
        else marks[id] = m;
        return { ...d, marks };
      });
      afterChange(wasKept);
      return;
    }
    const stepBtn = e.target.closest('.stepper button[data-step]');
    if (stepBtn) {
      const id = stepBtn.parentElement.dataset.count;
      const wasKept = isKept();
      updateDay(today, (d) => {
        const counts = { ...d.counts };
        counts[id] = Math.max(0, Math.min(999, (counts[id] || 0) + Number(stepBtn.dataset.step)));
        return { ...d, counts };
      });
      afterChange(wasKept);
      return;
    }
    const focusBtn = e.target.closest('[data-focus]');
    if (focusBtn) {
      openTimer(Number(focusBtn.dataset.focus) >= 50 ? 50 : 25);
      return;
    }
    if (e.target.closest('[data-open-setup]')) openSetup();
    if (e.target.closest('#review-edit')) {
      updateDay(today, (d) => ({ ...d, reviewed: '' }));
      reviewForced = true;
      renderAll();
    }
  });

  // Social reps
  $('#social-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const note = $('#social-note').value.trim();
    if (!note) { $('#social-note').focus(); return; }
    updateDay(today, (d) => ({ ...d, social: [...(d.social || []), { note: note.slice(0, 200), at: new Date().toISOString() }] }));
    $('#social-note').value = '';
    renderAll();
    toast('Rep logged. That’s evidence.');
  });

  // Night review
  $('#review-open').addEventListener('click', () => {
    reviewForced = true;
    renderAll();
    $('#review-win').focus();
  });
  $('#review-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const tomorrow = addDays(today, 1);
    updateDay(today, (d) => {
      const marks = { ...d.marks };
      for (const c of P().commitments) if (markOf(c, d) === null) marks[c.id] = 'miss';
      return { ...d, marks, win: $('#review-win').value.trim(), lesson: $('#review-lesson').value.trim(), reviewed: new Date().toISOString() };
    });
    const next = $('#review-next').value.trim();
    const step = $('#review-next-step').value.trim();
    if (next || step) updateDay(tomorrow, (d) => ({ ...d, oneThing: next, firstStep: step }));
    reviewForced = false;
    renderAll();
    toast(isKept() ? 'Day kept and closed. Sleep. Tomorrow you go again.' : 'Logged honestly. Tomorrow, hit the minimums. Never miss twice.');
  });

  // Timer
  for (const b of document.querySelectorAll('#timer-presets button')) {
    b.addEventListener('click', () => { if (!timer) { preset = Number(b.dataset.min); updateTimerUI(); } });
  }
  $('#timer-start').addEventListener('click', startTimer);
  $('#timer-stop').addEventListener('click', () => stopTimer(false));
  $('#timer').addEventListener('close', updateTimerUI);
  $('#timer-pill').addEventListener('click', () => openTimer());

  // About to slip?
  $('#slip-btn').addEventListener('click', openUrge);
  $('#urge-skip').addEventListener('click', showRemember);
  $('#urge-close').addEventListener('click', () => $('#urge').close());
  $('#urge').addEventListener('close', clearBreath);
  for (const b of document.querySelectorAll('.swap')) b.addEventListener('click', () => swap(b.dataset.swap));

  // Setup
  $('#setup-btn').addEventListener('click', () => { $('.menu').open = false; openSetup(); });
  $('#setup').addEventListener('cancel', (e) => { if (!P()) e.preventDefault(); });
  // If the browser closes first-run setup anyway, start with the defaults; they're editable later.
  $('#setup').addEventListener('close', () => {
    if (P()) return;
    store.profile = cleanProfile(defaultProfile());
    saveStore();
    renderAll();
  });
  $('#use-draft').addEventListener('click', () => {
    const ta = $('#setup-why');
    if (ta.value.trim() && !confirm('Replace what you wrote with the draft?')) return;
    ta.value = WHY_DRAFT;
    ta.focus();
  });
  $('#setup-next').addEventListener('click', () => {
    if (setupStep === 2) draft.commitments = readCommitments();
    if (setupStep < STEPS - 1) { setupStep++; showSetupStep(); } else finishSetup();
  });
  $('#setup-back').addEventListener('click', () => {
    if (setupStep === 2) draft.commitments = readCommitments();
    if (setupStep > 0) { setupStep--; showSetupStep(); }
  });
  $('#setup-form').addEventListener('submit', (e) => e.preventDefault());
  $('#setup-commitments').addEventListener('change', (e) => {
    if (e.target.dataset.k !== 'kind') return;
    draft.commitments = readCommitments();
    const i = Number(e.target.closest('.cm-edit').dataset.i);
    const c = draft.commitments[i];
    const id = c.id;
    draft.commitments[i] = c.kind === 'check'
      ? { id, label: c.label, kind: 'check', full: '', min: '' }
      : c.kind === 'focus'
        ? { id, label: c.label, kind: 'focus', full: 50, min: 10, unit: 'min' }
        : { id, label: c.label, kind: 'count', full: 3, min: 1, unit: '' };
    renderCommitmentEditors();
  });
  $('#setup-commitments').addEventListener('click', (e) => {
    if (!e.target.closest('[data-remove]')) return;
    draft.commitments = readCommitments();
    if (draft.commitments.length <= 1) { toast('Keep at least one.'); return; }
    draft.commitments.splice(Number(e.target.closest('.cm-edit').dataset.i), 1);
    renderCommitmentEditors();
  });
  $('#add-commitment').addEventListener('click', () => {
    draft.commitments = readCommitments();
    draft.commitments.push({ id: `c${Date.now().toString(36)}`, label: '', kind: 'check', full: '', min: '' });
    renderCommitmentEditors();
    document.querySelector('#setup-commitments .cm-edit:last-child input')?.focus();
  });

  // Menu
  const menu = $('.menu');
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  $('#export-btn').addEventListener('click', () => {
    const data = { app: 'lock-in', version: 1, exported: new Date().toISOString(), profile: store.profile, days: store.days };
    download(`lock-in-${today}.json`, JSON.stringify(data, null, 2), 'application/json');
    menu.open = false;
  });
  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    menu.open = false;
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || data.app !== 'lock-in' || typeof data.days !== 'object') throw new Error('not a Lock In export');
      const incoming = cleanProfile(data.profile);
      if (incoming && (!P() || (JSON.stringify(incoming) !== JSON.stringify(P())
        && confirm('Also replace your setup (why, standard, letter) with the one in this file?')))) {
        store.profile = incoming;
      }
      const { days, count } = mergeDays(store.days, cleanDays(data.days));
      store.days = days;
      saveStore();
      if ($('#setup').open && P()) $('#setup').close();
      renderAll();
      toast(`Imported ${plural(count, 'day')}.`);
    } catch {
      toast('That file isn’t a Lock In export.');
    }
  });
  $('#reset-btn').addEventListener('click', () => {
    menu.open = false;
    if (!confirm('Erase your setup and every day in this browser? Export first if you want a backup.')) return;
    store = { version: 1, profile: null, days: {} };
    saveStore();
    timer = null;
    saveTimer();
    openSetup();
  });

  // Theme
  $('#theme-toggle').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme || 'auto';
    const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
    applyTheme(next);
    try { if (next === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch {}
  });

  // A new day starts at 4 am; catch it if the page stays open, and keep the timer's wake lock.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (timer) holdScreen();
    if (todayKey() !== today) { reviewForced = false; renderAll(); }
  });
  setInterval(() => { if (todayKey() !== today) { reviewForced = false; renderAll(); } }, 60000);
}

// ---------------------------------------------------------------- boot

function init() {
  loadStore();
  $('#storage-warning').hidden = storageOk;
  applyTheme(document.documentElement.dataset.theme || 'auto');
  bindEvents();
  timer = loadTimer();
  if (P()) renderAll();
  else openSetup();
  if (timer) runTick();
  if (location.hash === '#slip' && P()) openUrge();
}

init();
