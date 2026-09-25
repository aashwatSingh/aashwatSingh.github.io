import { ALL_TOPICS, guessTopic, topicHue } from './topics.js';

const STORE_KEY = 'hamza-tracker:v1';
const THEME_KEY = 'hamza-tracker:theme';
const PAGE_SIZE = 60;
const TYPES = ['video', 'live', 'short'];
const DEFAULT_TYPES = ['video', 'live'];
const STATUSES = ['all', 'unwatched', 'watched', 'starred'];
const TYPE_LABEL = { video: '', live: 'Live', short: 'Short' };

const $ = (sel) => document.querySelector(sel);

const ICON = {
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  circleCheck: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/></svg>',
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/></svg>',
  note: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M6 3.5h9l3.5 3.5v13.5H6z"/><path d="M9 11h6M9 15h6"/></svg>',
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
};

// ---------------------------------------------------------------- storage

let storageOk = true;
let store = { version: 1, videos: {} };
const NO_PROGRESS = Object.freeze({});

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      if (data && typeof data.videos === 'object') store = { version: 1, videos: data.videos };
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

const progress = (id) => store.videos[id] || NO_PROGRESS;

function isEmptyProgress(p) {
  return !p.watched && !p.star && !p.rating && !p.topic && !p.takeaways?.trim() && !p.notes?.trim();
}

function updateProgress(id, patch) {
  const next = { ...store.videos[id], ...patch, updated: new Date().toISOString() };
  if (isEmptyProgress(next)) delete store.videos[id];
  else store.videos[id] = next;
  saveStore();
}

function cleanEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const str = (v) => (typeof v === 'string' ? v : '');
  const rating = Number.isInteger(entry.rating) ? Math.min(5, Math.max(0, entry.rating)) : 0;
  const topic = TOPIC_NAMES.has(entry.topic) ? entry.topic : null;
  const clean = {
    watched: str(entry.watched) || null,
    star: entry.star === true,
    rating,
    topic,
    takeaways: str(entry.takeaways),
    notes: str(entry.notes),
    updated: str(entry.updated) || new Date(0).toISOString(),
  };
  return isEmptyProgress(clean) ? null : clean;
}

// ---------------------------------------------------------------- data

let channel = {};
let syncedAt = null;
let allVideos = [];
let videos = [];
const byId = new Map();

const TOPIC_NAMES = new Set(ALL_TOPICS.map((t) => t.name));
const topicOf = (v) => {
  const override = progress(v.id).topic;
  return TOPIC_NAMES.has(override) ? override : guessTopic(v.title);
};

async function loadVideos() {
  const res = await fetch('data/videos.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  channel = data.channel || {};
  syncedAt = data.updated || null;
  allVideos = (data.videos || []).filter((v) => v && v.id);
  for (const v of allVideos) {
    v.title ||= '(untitled)';
    v.type = TYPES.includes(v.type) ? v.type : 'video';
    byId.set(v.id, v);
  }
  videos = allVideos.filter((v) => !v.removed);
}

// ---------------------------------------------------------------- state

const state = {
  q: '',
  status: 'all',
  topic: '',
  types: new Set(DEFAULT_TYPES),
  sort: 'newest',
  tab: 'lessons',
  v: '',
};

const cmpDate = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) || (a.seq || 0) - (b.seq || 0);
const SORTS = {
  newest: (a, b) => cmpDate(b, a),
  oldest: cmpDate,
  longest: (a, b) => (b.duration || 0) - (a.duration || 0) || cmpDate(b, a),
  shortest: (a, b) => (a.duration ?? 1e9) - (b.duration ?? 1e9) || cmpDate(b, a),
  views: (a, b) => (b.views || 0) - (a.views || 0) || cmpDate(b, a),
};

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.q = p.get('q') || '';
  state.status = STATUSES.includes(p.get('status')) ? p.get('status') : 'all';
  state.topic = TOPIC_NAMES.has(p.get('topic')) ? p.get('topic') : '';
  const types = (p.get('types') || '').split(',').filter((t) => TYPES.includes(t));
  state.types = new Set(types.length ? types : DEFAULT_TYPES);
  state.sort = SORTS[p.get('sort')] ? p.get('sort') : 'newest';
  state.tab = p.get('tab') === 'journal' ? 'journal' : 'lessons';
  state.v = p.get('v') || '';
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.q) p.set('q', state.q);
  if (state.status !== 'all') p.set('status', state.status);
  if (state.topic) p.set('topic', state.topic);
  const types = TYPES.filter((t) => state.types.has(t));
  if (types.join() !== DEFAULT_TYPES.join()) p.set('types', types.join(','));
  if (state.sort !== 'newest') p.set('sort', state.sort);
  if (state.tab !== 'lessons') p.set('tab', state.tab);
  if (state.v) p.set('v', state.v);
  const hash = p.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const nf = new Intl.NumberFormat();
const compact = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

function fmtDuration(sec) {
  const s = Math.round(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function fmtHours(sec) {
  const h = sec / 3600;
  return h < 10 ? h.toFixed(1).replace(/\.0$/, '') : nf.format(Math.round(h));
}

const DAY = 864e5;
const utcDate = (iso) => new Date(`${iso}T00:00:00Z`);
const dateFmt = (opts) => new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', ...opts });
const FULL_DATE = dateFmt({ year: 'numeric', month: 'short', day: 'numeric' });
const MONTH_YEAR = dateFmt({ year: 'numeric', month: 'short' });
const YEAR = dateFmt({ year: 'numeric' });

// Channel listings only give relative dates ("2 years ago"), so show dates
// with the precision YouTube gave us when the video was first seen.
function fmtDate(v) {
  if (!v.date) return '';
  const d = utcDate(v.date);
  if (!v.date_approx) return FULL_DATE.format(d);
  const age = (utcDate(v.first_seen || v.date) - d) / DAY;
  if (age <= 2) return FULL_DATE.format(d);
  if (age < 30) return `~${FULL_DATE.format(d)}`;
  if (age < 365) return `~${MONTH_YEAR.format(d)}`;
  return `~${YEAR.format(d)}`;
}

const fmtWatched = (iso) => new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });

const splitLines = (text) => (text || '')
  .split('\n')
  .map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
  .filter(Boolean);

function highlight(text, terms) {
  if (!terms.length) return esc(text);
  const re = new RegExp(`(${terms.map(escapeRe).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part))).join('');
}

const searchTerms = (q) => q.toLowerCase().split(/\s+/).filter(Boolean);
const watchUrl = (v) => (v.type === 'short' ? `https://www.youtube.com/shorts/${v.id}` : `https://www.youtube.com/watch?v=${v.id}`);

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  // A modal dialog sits in the top layer, so the toast has to live inside it to be seen.
  const host = dialog.open ? dialog : document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// ---------------------------------------------------------------- stats & topics

const inScope = (v) => state.types.has(v.type);

function renderStats() {
  const scoped = videos.filter(inScope);
  const weekAgo = Date.now() - 7 * DAY;
  let watched = 0, starred = 0, week = 0, secWatched = 0, secTotal = 0;
  for (const v of scoped) {
    const p = progress(v.id);
    secTotal += v.duration || 0;
    if (p.watched) {
      watched++;
      secWatched += v.duration || 0;
      if (Date.parse(p.watched) >= weekAgo) week++;
    }
    if (p.star) starred++;
  }
  let takeaways = 0;
  for (const p of Object.values(store.videos)) takeaways += splitLines(p.takeaways).length;

  const pct = scoped.length ? (watched / scoped.length) * 100 : 0;
  $('#stat-watched').textContent = nf.format(watched);
  $('#stat-total').textContent = nf.format(scoped.length);
  $('#stat-pct').textContent = `${pct > 0 && pct < 1 ? pct.toFixed(1) : Math.round(pct)}%`;
  $('#stat-bar').setAttribute('aria-valuenow', String(Math.round(pct)));
  $('#stat-bar span').style.width = `${pct}%`;
  $('#stat-hours').innerHTML = `${fmtHours(secWatched)}<small> / ${fmtHours(secTotal)} h</small>`;
  $('#stat-takeaways').textContent = nf.format(takeaways);
  $('#stat-starred').textContent = nf.format(starred);
  $('#stat-week').textContent = nf.format(week);
}

function renderTopics() {
  const counts = new Map(ALL_TOPICS.map((t) => [t.name, { total: 0, watched: 0 }]));
  let total = 0, watched = 0;
  for (const v of videos) {
    if (!inScope(v)) continue;
    const c = counts.get(topicOf(v));
    const w = progress(v.id).watched ? 1 : 0;
    c.total++; c.watched += w; total++; watched += w;
  }
  const chip = (name, label, hue, c) => {
    const pct = c.total ? (c.watched / c.total) * 100 : 0;
    return `<button type="button" class="chip${name ? '' : ' chip-all'}" data-topic="${esc(name)}" aria-pressed="${state.topic === name}" style="--h:${hue}">
      <span class="chip-name"><i></i>${esc(label)}</span>
      <span class="chip-count">${nf.format(c.watched)} / ${nf.format(c.total)}</span>
      <span class="bar"><span style="width:${pct}%"></span></span>
    </button>`;
  };
  $('#topic-chips').innerHTML = [
    chip('', 'All topics', 30, { total, watched }),
    ...ALL_TOPICS
      .filter((t) => counts.get(t.name).total || state.topic === t.name)
      .map((t) => chip(t.name, t.name, t.hue, counts.get(t.name))),
  ].join('');
}

// ---------------------------------------------------------------- lesson grid

let list = [];
let rendered = 0;

function matches(v, terms) {
  if (!inScope(v)) return false;
  const p = progress(v.id);
  if (state.status === 'watched' && !p.watched) return false;
  if (state.status === 'unwatched' && p.watched) return false;
  if (state.status === 'starred' && !p.star) return false;
  if (state.topic && topicOf(v) !== state.topic) return false;
  if (terms.length) {
    const hay = `${v.title}\n${p.takeaways || ''}\n${p.notes || ''}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }
  return true;
}

function cardHTML(v) {
  const p = progress(v.id);
  const topic = topicOf(v);
  const cls = ['card', p.watched && 'is-watched', v.type === 'short' && 'is-short'].filter(Boolean).join(' ');
  const typeLabel = TYPE_LABEL[v.type] ? `<span>· ${TYPE_LABEL[v.type]}</span>` : '';
  return `<article class="${cls}" data-id="${esc(v.id)}">
    <button type="button" class="card-open" data-action="open" aria-label="Open lesson: ${esc(v.title)}">
      <span class="thumb">
        <img loading="lazy" decoding="async" src="https://i.ytimg.com/vi/${esc(v.id)}/mqdefault.jpg" alt="" width="320" height="180">
        ${v.duration ? `<span class="dur">${fmtDuration(v.duration)}</span>` : ''}
        <span class="watched-flag">${ICON.check}Watched</span>
      </span>
      <span class="card-body">
        <span class="card-title">${esc(v.title)}</span>
        <span class="card-meta"><span class="badge" style="--h:${topicHue(topic)}">${esc(topic)}</span><span title="${v.date_approx ? 'Approximate upload date' : ''}">${fmtDate(v)}</span>${typeLabel}</span>
      </span>
    </button>
    <div class="card-actions">
      <button type="button" class="act act-watch" data-action="watch" aria-pressed="${!!p.watched}">${ICON.circleCheck}<span>${p.watched ? 'Watched' : 'Mark watched'}</span></button>
      ${p.takeaways?.trim() || p.notes?.trim() ? `<span class="has-notes" title="Has takeaways or notes">${ICON.note}</span>` : ''}
      ${p.rating ? `<span class="stars-mini" title="Your rating: ${p.rating}/5">${'★'.repeat(p.rating)}</span>` : ''}
      <button type="button" class="act act-star" data-action="star" aria-pressed="${!!p.star}" aria-label="Star">${ICON.star}</button>
    </div>
  </article>`;
}

function renderEmpty() {
  const empty = $('#empty');
  if (!allVideos.length) {
    empty.innerHTML = `<h2>No videos synced yet</h2>
      <p>The video list comes from a GitHub Action that runs every night. To fill it now, open the repository's
      <strong>Actions</strong> tab, pick <strong>Sync videos</strong>, and click <strong>Run workflow</strong>.</p>`;
  } else if (!list.length) {
    empty.innerHTML = `<h2>No lessons match</h2><p>Try a different search or topic.</p>
      <button type="button" class="btn" id="clear-filters">Clear filters</button>`;
  }
  empty.hidden = list.length > 0;
}

function renderLessons() {
  const terms = searchTerms(state.q);
  list = videos.filter((v) => matches(v, terms)).sort(SORTS[state.sort]);
  rendered = 0;
  $('#grid').innerHTML = '';
  renderMore();
  const scoped = videos.filter(inScope).length;
  $('#result-count').textContent = list.length === scoped
    ? `${nf.format(list.length)} lessons`
    : `Showing ${nf.format(list.length)} of ${nf.format(scoped)} lessons`;
  renderEmpty();
}

function renderMore() {
  const chunk = list.slice(rendered, rendered + PAGE_SIZE);
  if (!chunk.length) return;
  $('#grid').insertAdjacentHTML('beforeend', chunk.map(cardHTML).join(''));
  rendered += chunk.length;
}

function refreshCard(id) {
  const el = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const v = byId.get(id);
  if (!el || !v) return;
  const focusedAction = el.contains(document.activeElement) ? document.activeElement.dataset.action : null;
  el.outerHTML = cardHTML(v);
  if (focusedAction) {
    document.querySelector(`.card[data-id="${CSS.escape(id)}"] [data-action="${focusedAction}"]`)?.focus();
  }
}

function afterChange(id) {
  refreshCard(id);
  renderStats();
  renderTopics();
  if (current?.id === id) renderLessonControls();
  if (state.tab === 'journal') renderJournal();
}

function toggleWatched(id) {
  updateProgress(id, { watched: progress(id).watched ? null : new Date().toISOString() });
  afterChange(id);
}

function toggleStar(id) {
  updateProgress(id, { star: !progress(id).star });
  afterChange(id);
}

function nextUnwatched(afterId) {
  const start = afterId ? list.findIndex((v) => v.id === afterId) + 1 : 0;
  for (let i = 0; i < list.length; i++) {
    const v = list[(start + i) % list.length];
    if (v.id !== afterId && !progress(v.id).watched) return v;
  }
  return null;
}

function goNext(afterId) {
  const v = nextUnwatched(afterId);
  if (v) openLesson(v.id);
  else toast("You've watched everything in this view.");
}

// ---------------------------------------------------------------- lesson dialog

const dialog = $('#lesson');
let current = null;
let saveTimer = null;

function renderLessonControls() {
  const v = current;
  const p = progress(v.id);
  const watchedBtn = $('#lesson-watched');
  watchedBtn.setAttribute('aria-pressed', String(!!p.watched));
  watchedBtn.innerHTML = `${ICON.circleCheck}<span>${p.watched ? `Watched ${esc(fmtWatched(p.watched))}` : 'Mark as watched'}</span>`;
  const starBtn = $('#lesson-star');
  starBtn.setAttribute('aria-pressed', String(!!p.star));
  starBtn.innerHTML = `${ICON.star}<span>${p.star ? 'Starred' : 'Star'}</span>`;
  $('#lesson-rating').innerHTML = [1, 2, 3, 4, 5].map((n) =>
    `<button type="button" role="radio" data-rating="${n}" aria-checked="${p.rating === n}" aria-label="${n} star${n > 1 ? 's' : ''}" class="${n <= (p.rating || 0) ? 'on' : ''}">★</button>`).join('');
  const guess = guessTopic(v.title);
  $('#lesson-topic').innerHTML = [`<option value="">Topic: ${esc(guess)} (auto)</option>`,
    ...ALL_TOPICS.map((t) => `<option value="${esc(t.name)}"${p.topic === t.name ? ' selected' : ''}>${esc(t.name)}</option>`)].join('');
  const topic = topicOf(v);
  const bits = [
    `<span class="badge" style="--h:${topicHue(topic)}">${esc(topic)}</span>`,
    fmtDate(v) && `<span>${fmtDate(v)}</span>`,
    v.duration && `<span>${fmtDuration(v.duration)}</span>`,
    v.views && `<span>${compact.format(v.views)} views</span>`,
    TYPE_LABEL[v.type] && `<span>${TYPE_LABEL[v.type]}</span>`,
    v.removed && '<span>No longer on the channel</span>',
  ].filter(Boolean);
  $('#lesson-meta').innerHTML = bits.join('<span aria-hidden="true">·</span>');
  $('#lesson-next').innerHTML = p.watched ? 'Next lesson <span aria-hidden="true">→</span>' : 'Mark watched &amp; next <span aria-hidden="true">→</span>';
}

function openLesson(id) {
  const v = byId.get(id);
  if (!v) return;
  flushSave();
  current = v;
  const player = $('#player');
  const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(v.id)}?rel=0`;
  if (player.getAttribute('src') !== src) player.setAttribute('src', src);
  $('#lesson-title').textContent = v.title;
  $('#lesson-yt').href = watchUrl(v);
  const p = progress(v.id);
  $('#lesson-takeaways').value = p.takeaways || '';
  $('#lesson-notes').value = p.notes || '';
  $('#lesson-saved').textContent = '';
  renderLessonControls();
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  state.v = v.id;
  writeHash();
}

function flushSave() {
  if (!saveTimer || !current) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  updateProgress(current.id, { takeaways: $('#lesson-takeaways').value, notes: $('#lesson-notes').value });
  $('#lesson-saved').textContent = storageOk ? 'Saved' : 'Not saved: storage blocked';
  afterChange(current.id);
}

function scheduleSave() {
  $('#lesson-saved').textContent = 'Saving…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, 500);
}

// ---------------------------------------------------------------- journal

function renderJournal() {
  const terms = searchTerms($('#journal-search').value);
  const groups = new Map(ALL_TOPICS.map((t) => [t.name, []]));
  let totalItems = 0;
  for (const [id, p] of Object.entries(store.videos)) {
    let items = splitLines(p.takeaways);
    totalItems += items.length;
    if (!items.length) continue;
    const v = byId.get(id) || { id, title: 'Video no longer listed', type: 'video' };
    if (terms.length && !terms.every((t) => v.title.toLowerCase().includes(t))) {
      items = items.filter((item) => terms.every((t) => item.toLowerCase().includes(t)));
      if (!items.length) continue;
    }
    groups.get(topicOf(v)).push({ v, p, items });
  }

  const sections = [];
  for (const t of ALL_TOPICS) {
    const entries = groups.get(t.name);
    if (!entries.length) continue;
    entries.sort((a, b) => (b.p.watched || b.p.updated || '').localeCompare(a.p.watched || a.p.updated || ''));
    const count = entries.reduce((n, e) => n + e.items.length, 0);
    sections.push(`<section class="j-topic" style="--h:${t.hue}">
      <h3><span class="badge">${esc(t.name)}</span><small>${nf.format(count)} takeaway${count === 1 ? '' : 's'}</small></h3>
      ${entries.map(({ v, items }) => `<article class="j-item">
        <ul>${items.map((item) => `<li>${highlight(item, terms)}</li>`).join('')}</ul>
        <button type="button" class="j-src" data-open="${esc(v.id)}">${highlight(v.title, terms)}${v.date ? ` · ${fmtDate(v)}` : ''}</button>
      </article>`).join('')}
    </section>`);
  }

  const root = $('#journal');
  if (sections.length) root.innerHTML = sections.join('');
  else if (totalItems) root.innerHTML = '<div class="empty"><h2>No takeaways match</h2><p>Try another search.</p></div>';
  else root.innerHTML = `<div class="empty"><h2>No takeaways yet</h2>
    <p>Open a lesson and write down what you learned under <strong>Key takeaways</strong>, one per line.
    Every takeaway you write is collected here, grouped by topic.</p></div>`;
}

function journalMarkdown() {
  const lines = ['# Hamza Lessons: my takeaways', '', `_Exported ${FULL_DATE.format(new Date())}_`, ''];
  for (const t of ALL_TOPICS) {
    const entries = Object.entries(store.videos)
      .map(([id, p]) => ({ v: byId.get(id) || { id, title: 'Video no longer listed' }, p, items: splitLines(p.takeaways) }))
      .filter((e) => e.items.length && topicOf(e.v) === t.name);
    if (!entries.length) continue;
    lines.push(`## ${t.name}`, '');
    for (const { v, items } of entries) {
      lines.push(`### [${v.title.replace(/[[\]]/g, '')}](${watchUrl(v)})`, ...items.map((i) => `- ${i}`), '');
    }
  }
  return lines.join('\n');
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- tabs, theme, controls

function syncControls() {
  $('#search').value = state.q;
  for (const b of document.querySelectorAll('#status-seg button')) b.setAttribute('aria-pressed', String(b.dataset.status === state.status));
  for (const b of document.querySelectorAll('#type-toggles button')) b.setAttribute('aria-pressed', String(state.types.has(b.dataset.type)));
  $('#sort').value = state.sort;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
  $('#view-lessons').hidden = state.tab !== 'lessons';
  $('#view-journal').hidden = state.tab !== 'journal';
}

function renderAll() {
  syncControls();
  renderStats();
  renderTopics();
  renderLessons();
  if (state.tab === 'journal') renderJournal();
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

function bindEvents() {
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); writeHash(); renderLessons(); }, 120);
  });

  $('#status-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-status]');
    if (!b) return;
    state.status = b.dataset.status;
    writeHash(); syncControls(); renderLessons();
  });

  $('#type-toggles').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-type]');
    if (!b) return;
    const t = b.dataset.type;
    if (state.types.has(t) && state.types.size === 1) { toast('Keep at least one type on.'); return; }
    if (state.types.has(t)) state.types.delete(t); else state.types.add(t);
    writeHash(); syncControls(); renderStats(); renderTopics(); renderLessons();
  });

  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; writeHash(); renderLessons(); });

  $('#topic-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-topic]');
    if (!b) return;
    state.topic = state.topic === b.dataset.topic ? '' : b.dataset.topic;
    writeHash(); renderTopics(); renderLessons();
  });

  // Hide the browser's broken-image icon if a thumbnail can't load.
  $('#grid').addEventListener('error', (e) => {
    if (e.target.tagName === 'IMG') e.target.style.visibility = 'hidden';
  }, true);

  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('.card').dataset.id;
    if (b.dataset.action === 'open') openLesson(id);
    else if (b.dataset.action === 'watch') toggleWatched(id);
    else if (b.dataset.action === 'star') toggleStar(id);
  });

  $('#empty').addEventListener('click', (e) => {
    if (e.target.id !== 'clear-filters') return;
    Object.assign(state, { q: '', status: 'all', topic: '' });
    writeHash(); syncControls(); renderTopics(); renderLessons();
  });

  $('#next-btn').addEventListener('click', () => goNext(null));

  const io = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting || rendered >= list.length) return;
    renderMore();
    // Re-observe so a still-visible sentinel fires again on tall screens.
    io.unobserve(entries[0].target);
    io.observe(entries[0].target);
  }, { rootMargin: '900px 0px' });
  io.observe($('#sentinel'));

  for (const b of document.querySelectorAll('.tab')) {
    b.addEventListener('click', () => {
      state.tab = b.dataset.tab;
      writeHash(); syncControls();
      if (state.tab === 'journal') renderJournal();
    });
  }

  $('#journal-search').addEventListener('input', renderJournal);
  $('#journal').addEventListener('click', (e) => {
    const b = e.target.closest('[data-open]');
    if (b) openLesson(b.dataset.open);
  });
  $('#copy-md').addEventListener('click', async () => {
    const md = journalMarkdown();
    try {
      await navigator.clipboard.writeText(md);
      toast('Journal copied as Markdown.');
    } catch {
      download('hamza-lessons-journal.md', md, 'text/markdown');
    }
  });

  // Lesson dialog
  $('#lesson-watched').addEventListener('click', () => toggleWatched(current.id));
  $('#lesson-star').addEventListener('click', () => toggleStar(current.id));
  $('#lesson-rating').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-rating]');
    if (!b) return;
    const n = Number(b.dataset.rating);
    updateProgress(current.id, { rating: progress(current.id).rating === n ? 0 : n });
    afterChange(current.id);
  });
  $('#lesson-topic').addEventListener('change', (e) => {
    updateProgress(current.id, { topic: e.target.value || null });
    afterChange(current.id);
  });
  $('#lesson-takeaways').addEventListener('input', scheduleSave);
  $('#lesson-notes').addEventListener('input', scheduleSave);
  $('#lesson-next').addEventListener('click', () => {
    const id = current.id;
    flushSave();
    if (!progress(id).watched) {
      updateProgress(id, { watched: new Date().toISOString() });
      afterChange(id);
    }
    goNext(id);
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) dialog.close(); });
  dialog.addEventListener('close', () => {
    flushSave();
    $('#player').setAttribute('src', 'about:blank'); // stops playback
    current = null;
    state.v = '';
    writeHash();
  });

  // Menu
  const menu = $('.menu');
  document.addEventListener('click', (e) => { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  $('#export-btn').addEventListener('click', () => {
    const data = { app: 'hamza-lessons', version: 1, exported: new Date().toISOString(), videos: store.videos };
    download(`hamza-lessons-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(data, null, 2), 'application/json');
    menu.open = false;
  });
  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    menu.open = false;
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data.videos !== 'object') throw new Error('missing videos');
      let merged = 0;
      for (const [id, entry] of Object.entries(data.videos)) {
        const clean = /^[\w-]{6,20}$/.test(id) && cleanEntry(entry);
        if (!clean) continue;
        const local = store.videos[id];
        if (!local || clean.updated > (local.updated || '')) { store.videos[id] = clean; merged++; }
      }
      saveStore();
      renderAll();
      toast(`Imported ${merged} lesson${merged === 1 ? '' : 's'}.`);
    } catch {
      toast("That file isn't a Hamza Lessons export.");
    }
  });
  $('#reset-btn').addEventListener('click', () => {
    menu.open = false;
    if (!confirm('Erase all watched marks, ratings, takeaways and notes in this browser? Export first if you want a backup.')) return;
    store = { version: 1, videos: {} };
    saveStore();
    renderAll();
    toast('Progress reset.');
  });

  // Theme
  $('#theme-toggle').addEventListener('click', () => {
    const now = document.documentElement.dataset.theme || 'auto';
    const next = THEMES[(THEMES.indexOf(now) + 1) % THEMES.length];
    applyTheme(next);
    try { if (next === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch {}
  });

  // "/" focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || dialog.open) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    (state.tab === 'journal' ? $('#journal-search') : $('#search')).focus();
  });

  window.addEventListener('hashchange', () => {
    readHash();
    renderAll();
    if (state.v && current?.id !== state.v) openLesson(state.v);
    else if (!state.v && dialog.open) dialog.close();
  });
}

// ---------------------------------------------------------------- boot

async function init() {
  loadStore();
  $('#storage-warning').hidden = storageOk;
  applyTheme(document.documentElement.dataset.theme || 'auto');
  readHash();
  bindEvents();
  try {
    await loadVideos();
  } catch (err) {
    console.error(err);
    toast("Couldn't load the video list.");
  }
  if (channel.url) $('#channel-link').href = channel.url;
  if (channel.handle) $('#channel-link').textContent = channel.handle;
  $('#synced-at').textContent = syncedAt
    ? `last synced ${new Date(syncedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}`
    : 'not synced yet';
  document.body.classList.toggle('no-data', !allVideos.length);
  renderAll();
  if (state.v) openLesson(state.v);
}

init();
