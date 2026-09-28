import { TEMPLATES, FOLLOW_UP, fill } from './templates.js';

const STORE_KEY = 'free-pitch:v1';
const THEME_KEY = 'free-pitch:theme';
const FOLLOW_UP_DAYS = 10;

const KINDS = [
  { id: 'official', label: 'Streaming editors', hue: 280 },
  { id: 'playlist', label: 'Playlists', hue: 150 },
  { id: 'blog', label: 'Blogs', hue: 30 },
  { id: 'radio', label: 'Radio', hue: 220 },
  { id: 'youtube', label: 'YouTube', hue: 0 },
  { id: 'community', label: 'Communities', hue: 90 },
  { id: 'showcase', label: 'Showcases', hue: 330 },
];
const KIND = Object.fromEntries(KINDS.map((k) => [k.id, k]));
const KIND_SINGULAR = { official: 'Streaming editors', playlist: 'Playlist', blog: 'Blog', radio: 'Radio', youtube: 'YouTube', community: 'Community', showcase: 'Showcase' };

const STATUSES = [
  { id: 'draft', label: 'Not sent yet' },
  { id: 'sent', label: 'Sent' },
  { id: 'followed', label: 'Followed up' },
  { id: 'replied', label: 'Replied' },
  { id: 'placed', label: 'Added / featured' },
  { id: 'declined', label: 'Declined' },
  { id: 'silent', label: 'No response' },
];
const STATUS = Object.fromEntries(STATUSES.map((s) => [s.id, s]));
const PITCHED = new Set(['sent', 'followed', 'replied', 'placed', 'declined', 'silent']);
const STATUS_FILTERS = ['all', 'todo', 'pitched', 'hidden'];
const SORT_IDS = ['deadline', 'name', 'kind'];
const TABS = ['curators', 'pitches', 'kit'];
const PROFILE_FIELDS = ['artist', 'email', 'city', 'country', 'genre', 'similar', 'bio', 'spotify', 'instagram', 'tiktok', 'youtube', 'soundcloud', 'website'];
const RELEASE_FIELDS = ['title', 'type', 'date', 'features', 'private_link', 'public_link', 'mood', 'bpm', 'hook', 'story'];
const CURATOR_FIELDS = ['name', 'greet', 'kind', 'method', 'contact', 'url', 'region', 'guidelines'];

const $ = (sel) => document.querySelector(sel);

const ICON = {
  auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/></svg>',
  light: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5.5" width="17" height="13" rx="2"/><path d="M4 7l8 6 8-6"/></svg>',
  form: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4.5" y="3.5" width="15" height="17" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
  check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path stroke-linejoin="round" d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.2v.3"/></svg>',
};

// ---------------------------------------------------------------- storage

let storageOk = true;
let store = emptyStore();

function emptyStore() {
  return { version: 1, profile: { updated: '' }, releases: [], custom: [], pitches: {}, hidden: {}, release: '' };
}

function loadStore() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) store = { ...emptyStore(), ...clean(JSON.parse(raw)) };
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

const now = () => new Date().toISOString();
const newId = (prefix) => `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
const str = (v, max = 4000) => (typeof v === 'string' ? v.slice(0, max) : '');
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const safeUrl = (u) => (/^https?:\/\//i.test(u) ? u : '');

// Everything read from storage or an import passes through here, so the
// rest of the app can trust field types.
function clean(data) {
  const out = emptyStore();
  if (!isObj(data)) return out;
  if (isObj(data.profile)) {
    for (const f of PROFILE_FIELDS) out.profile[f] = str(data.profile[f]);
    out.profile.updated = str(data.profile.updated);
  }
  if (Array.isArray(data.releases)) {
    out.releases = data.releases.filter((r) => isObj(r) && str(r.id) && str(r.title)).map((r) => {
      const rel = { id: str(r.id, 64), updated: str(r.updated) };
      for (const f of RELEASE_FIELDS) rel[f] = str(r[f]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(rel.date)) rel.date = '';
      return rel;
    });
  }
  if (Array.isArray(data.custom)) {
    out.custom = data.custom
      .filter((c) => isObj(c) && str(c.id).startsWith('c-') && str(c.name))
      .map(cleanCustom)
      .filter((c) => (c.method === 'email' ? EMAIL_RE.test(c.contact) : safeUrl(c.contact)));
  }
  if (isObj(data.pitches)) {
    for (const [key, p] of Object.entries(data.pitches)) {
      if (!isObj(p) || !key.includes(':')) continue;
      out.pitches[key.slice(0, 160)] = {
        status: STATUS[p.status] ? p.status : 'draft',
        subject: str(p.subject),
        body: str(p.body, 20000),
        edited: p.edited === true,
        sent: str(p.sent),
        followed: str(p.followed),
        notes: str(p.notes),
        updated: str(p.updated),
      };
    }
  }
  if (isObj(data.hidden)) {
    for (const [id, h] of Object.entries(data.hidden)) {
      if (isObj(h) && ['hidden', 'charges', 'shown'].includes(h.state)) out.hidden[id.slice(0, 64)] = { state: h.state, updated: str(h.updated) };
    }
  }
  out.release = str(data.release, 64);
  return out;
}

function cleanCustom(c) {
  const out = { id: str(c.id, 64), custom: true, updated: str(c.updated) };
  for (const f of CURATOR_FIELDS) out[f] = str(c[f]);
  if (!KIND[out.kind]) out.kind = 'playlist';
  if (!['email', 'form'].includes(out.method)) out.method = 'email';
  const lead = Number.parseInt(c.lead_days, 10);
  out.lead_days = Number.isFinite(lead) && lead >= 0 ? Math.min(lead, 365) : null;
  out.released_ok = c.released_ok !== false;
  out.genres = [];
  return out;
}

// ---------------------------------------------------------------- data

let directory = [];
let checkedAt = '';

async function loadDirectory() {
  const res = await fetch('data/curators.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  checkedAt = data.updated || '';
  directory = (data.curators || []).filter((c) => c && c.id && c.name && KIND[c.kind]);
}

const allCurators = () => [...directory, ...store.custom];
const curatorById = (id) => allCurators().find((c) => c.id === id);
const currentRelease = () => store.releases.find((r) => r.id === store.release) || null;
const pitchKey = (releaseId, curatorId) => `${releaseId}:${curatorId}`;
const NO_PITCH = Object.freeze({ status: 'draft' });
const pitchFor = (curatorId, release = currentRelease()) => (release && store.pitches[pitchKey(release.id, curatorId)]) || NO_PITCH;
const hiddenState = (id) => store.hidden[id]?.state === 'shown' ? '' : store.hidden[id]?.state || '';

function updatePitch(releaseId, curatorId, patch) {
  const key = pitchKey(releaseId, curatorId);
  const next = { status: 'draft', ...store.pitches[key], ...patch, updated: now() };
  if (PITCHED.has(next.status) && !next.sent) next.sent = now();
  if (next.status === 'followed' && !next.followed) next.followed = now();
  const blank = next.status === 'draft' && !next.edited && !next.notes?.trim();
  if (blank) delete store.pitches[key];
  else store.pitches[key] = next;
  saveStore();
}

// ---------------------------------------------------------------- dates

const DAY = 864e5;
const pad = (n) => String(n).padStart(2, '0');
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const isoDay = (iso) => { const [y, m, d] = iso.split('-').map(Number); return Date.UTC(y, m - 1, d); };
const addDays = (iso, n) => new Date(isoDay(iso) + n * DAY).toISOString().slice(0, 10);
const daysUntil = (iso) => Math.round((isoDay(iso) - isoDay(todayISO())) / DAY);
const localDay = (stamp) => { const d = new Date(stamp); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dateFmt = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric' });
const dateFmtYear = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
const fmtDay = (iso) => (iso.slice(0, 4) === todayISO().slice(0, 4) ? dateFmt : dateFmtYear).format(new Date(isoDay(iso)));

function relDays(n) {
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  if (n === -1) return 'yesterday';
  return n > 0 ? `in ${n} days` : `${-n} days ago`;
}

// When can this release still go to this curator?
// open: pitch any time; due: pitch by `by`; late: past the ideal date but still accepted; closed: no longer accepted.
function windowFor(c, release) {
  if (!release?.date) return { state: 'open' };
  const toRelease = daysUntil(release.date);
  if (toRelease <= 0 && !c.released_ok) return { state: 'closed', why: 'Only takes unreleased music' };
  if (c.after_days != null && toRelease < -c.after_days) {
    return { state: 'closed', why: `Accepted until ${c.after_days} days after release` };
  }
  if (c.lead_days != null) {
    const by = addDays(release.date, -c.lead_days);
    const left = daysUntil(by);
    if (left >= 0) return { state: 'due', by, left };
    if (toRelease > 0 || c.released_ok) return { state: 'late', by, left };
  }
  return { state: 'open' };
}

// ---------------------------------------------------------------- formatting

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat();
const plural = (n, word) => `${nf.format(n)} ${word}${n === 1 ? '' : 's'}`;
const kindBadge = (kind) => `<span class="badge" style="--h:${KIND[kind]?.hue ?? 0}">${esc(KIND_SINGULAR[kind] || kind)}</span>`;

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  // A modal dialog sits in the top layer, so the toast has to live inside it to be seen.
  const host = document.querySelector('dialog[open]') || document.body;
  if (el.parentElement !== host) host.append(el);
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------- state

const state = { tab: 'curators', kind: '', q: '', status: 'all', region: '', sort: 'deadline' };

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  state.tab = TABS.includes(p.get('tab')) ? p.get('tab') : 'curators';
  state.kind = KIND[p.get('kind')] || p.get('kind') === 'mine' ? p.get('kind') : '';
  state.q = p.get('q') || '';
  state.status = STATUS_FILTERS.includes(p.get('status')) ? p.get('status') : 'all';
  state.region = p.get('region') || '';
  state.sort = SORT_IDS.includes(p.get('sort')) ? p.get('sort') : 'deadline';
}

function writeHash() {
  const p = new URLSearchParams();
  if (state.tab !== 'curators') p.set('tab', state.tab);
  if (state.kind) p.set('kind', state.kind);
  if (state.q) p.set('q', state.q);
  if (state.status !== 'all') p.set('status', state.status);
  if (state.region) p.set('region', state.region);
  if (state.sort !== 'deadline') p.set('sort', state.sort);
  const hash = p.toString();
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search);
}

// ---------------------------------------------------------------- release bar

function renderReleaseBar() {
  const sel = $('#release-select');
  const sorted = [...store.releases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!sorted.length) {
    sel.innerHTML = '<option value="">No releases yet</option>';
    sel.disabled = true;
    $('#release-when').innerHTML = 'Add a release to get pitch-by dates and ready-made pitches.';
    return;
  }
  if (!currentRelease()) store.release = sorted[0].id;
  sel.disabled = false;
  sel.innerHTML = sorted.map((r) => `<option value="${esc(r.id)}"${r.id === store.release ? ' selected' : ''}>${esc(r.title)}${r.type && r.type !== 'single' ? ` (${esc(r.type)})` : ''}</option>`).join('');
  const r = currentRelease();
  if (!r.date) { $('#release-when').textContent = 'No release date set.'; return; }
  const n = daysUntil(r.date);
  $('#release-when').innerHTML = n > 0
    ? `Out <strong>${esc(fmtDay(r.date))}</strong> · ${esc(relDays(n))}`
    : n === 0 ? '<strong>Out today</strong>' : `Out since <strong>${esc(fmtDay(r.date))}</strong>`;
}

// ---------------------------------------------------------------- curators view

function regionsOf(c) {
  return (c.region || 'Global').split(/[,/]/).map((s) => s.trim()).filter(Boolean);
}

function regionMismatch(c) {
  const country = store.profile.country;
  if (!country || country === 'other') return false;
  const regions = regionsOf(c);
  return !regions.some((r) => /global/i.test(r) || r.toUpperCase() === country);
}

function renderRegionOptions() {
  const set = new Set();
  for (const c of allCurators()) for (const r of regionsOf(c)) set.add(r);
  const opts = [...set].sort((a, b) => (a === 'Global' ? -1 : b === 'Global' ? 1 : a.localeCompare(b)));
  if (state.region && !set.has(state.region)) state.region = '';
  $('#region').innerHTML = ['<option value="">All regions</option>', ...opts.map((r) => `<option value="${esc(r)}"${r === state.region ? ' selected' : ''}>${esc(r)}</option>`)].join('');
}

function visibleForStatus(c) {
  const hidden = hiddenState(c.id);
  if (state.status === 'hidden') return !!hidden;
  if (hidden) return false;
  if (state.status === 'todo') return !PITCHED.has(pitchFor(c.id).status);
  if (state.status === 'pitched') return PITCHED.has(pitchFor(c.id).status);
  return true;
}

function matches(c, terms) {
  if (state.kind === 'mine' ? !c.custom : state.kind && c.kind !== state.kind) return false;
  if (state.region && !regionsOf(c).includes(state.region)) return false;
  if (!visibleForStatus(c)) return false;
  if (terms.length) {
    const hay = [c.name, c.guidelines, c.region, KIND_SINGULAR[c.kind], ...(c.genres || [])].join('\n').toLowerCase();
    return terms.every((t) => hay.includes(t));
  }
  return true;
}

const WINDOW_RANK = { due: 0, open: 1, late: 2, closed: 3 };
function sortCurators(list) {
  const release = currentRelease();
  const byName = (a, b) => a.name.localeCompare(b.name);
  if (state.sort === 'name') return list.sort(byName);
  if (state.sort === 'kind') return list.sort((a, b) => KINDS.findIndex((k) => k.id === a.kind) - KINDS.findIndex((k) => k.id === b.kind) || byName(a, b));
  return list.sort((a, b) => {
    const wa = windowFor(a, release), wb = windowFor(b, release);
    const pa = PITCHED.has(pitchFor(a.id).status), pb = PITCHED.has(pitchFor(b.id).status);
    return pa - pb || WINDOW_RANK[wa.state] - WINDOW_RANK[wb.state] || (wa.by || '').localeCompare(wb.by || '') || KINDS.findIndex((k) => k.id === a.kind) - KINDS.findIndex((k) => k.id === b.kind) || byName(a, b);
  });
}

function renderKinds() {
  const counts = new Map();
  let mine = 0, total = 0;
  for (const c of allCurators()) {
    if (hiddenState(c.id)) continue;
    counts.set(c.kind, (counts.get(c.kind) || 0) + 1);
    total++;
    if (c.custom) mine++;
  }
  const chip = (id, label, n, hue) => `<button type="button" class="kind-chip" data-kind="${esc(id)}" aria-pressed="${state.kind === id}" style="--h:${hue}"><i></i>${esc(label)}<span>${nf.format(n)}</span></button>`;
  $('#kind-chips').innerHTML = [
    chip('', 'All', total, 280),
    ...KINDS.filter((k) => counts.get(k.id) || state.kind === k.id).map((k) => chip(k.id, k.label, counts.get(k.id) || 0, k.hue)),
    mine || state.kind === 'mine' ? chip('mine', 'Added by you', mine, 45) : '',
  ].join('');
}

function windowHTML(w) {
  if (w.state === 'due') return `<p class="when when-due"><span>Pitch by <strong>${esc(fmtDay(w.by))}</strong> · ${esc(relDays(w.left))}</span></p>`;
  if (w.state === 'late') return `<p class="when when-late">${ICON.warn}<span>Ideal pitch-by date passed (${esc(fmtDay(w.by))}). Still accepted.</span></p>`;
  if (w.state === 'closed') return `<p class="when when-closed">${ICON.warn}<span>Closed for this release: ${esc(w.why.toLowerCase())}</span></p>`;
  return '<p class="when">Pitch any time</p>';
}

function statusPill(p) {
  if (!PITCHED.has(p.status)) return p.edited ? '<span class="pill pill-draft">Draft</span>' : '';
  const date = p.status === 'followed' ? p.followed : p.sent;
  return `<span class="pill pill-${p.status}">${esc(STATUS[p.status].label)}${date ? ` · ${esc(fmtDay(localDay(date)))}` : ''}</span>`;
}

function cardHTML(c) {
  const release = currentRelease();
  const p = pitchFor(c.id);
  const hidden = hiddenState(c.id);
  const verified = c.custom
    ? '<span class="verified mine">Added by you</span>'
    : `<a class="verified" href="${esc(safeUrl(c.free_proof))}" target="_blank" rel="noopener" title="${esc(c.free_note || '')}">${ICON.check}Free · checked ${esc(fmtDay(c.checked))}${c.checked_via === 'search' ? ' via search' : ''}</a>`;
  const genres = (c.genres || []).filter((g) => g !== 'all-genres');
  return `<article class="ccard${PITCHED.has(p.status) ? ' is-pitched' : ''}${hidden ? ' is-hidden' : ''}" data-id="${esc(c.id)}">
    <div class="ccard-top">
      ${kindBadge(c.kind)}
      <span class="ccard-region">${esc(c.region || 'Global')}</span>
      <span class="ccard-method" title="${c.method === 'email' ? 'Pitch by email' : 'Pitch through their site'}">${c.method === 'email' ? ICON.mail : ICON.form}${c.method === 'email' ? 'Email' : 'Web form'}</span>
    </div>
    <h3 class="ccard-name">${esc(c.name)}</h3>
    ${genres.length ? `<p class="ccard-genres">${genres.map((g) => `<span>${esc(g.replace(/-/g, ' '))}</span>`).join('')}</p>` : ''}
    <p class="ccard-guide">${esc(c.guidelines || '')}</p>
    ${release ? windowHTML(windowFor(c, release)) : ''}
    ${regionMismatch(c) ? `<p class="when when-late">${ICON.warn}<span>${esc(c.region)} only</span></p>` : ''}
    ${hidden === 'charges' ? `<p class="when when-closed">${ICON.warn}<span>You reported this outlet now charges</span></p>` : ''}
    <div class="ccard-foot">
      ${verified}
      ${statusPill(p)}
    </div>
    <div class="ccard-actions">
      <button type="button" class="btn primary" data-action="pitch">${PITCHED.has(p.status) ? 'Open pitch' : 'Pitch'}</button>
      ${hidden
        ? '<button type="button" class="btn" data-action="unhide">Show again</button>'
        : `<details class="more">
            <summary class="icon-btn" aria-label="More actions for ${esc(c.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg></summary>
            <div class="menu-panel">
              ${c.url ? `<a href="${esc(safeUrl(c.url))}" target="_blank" rel="noopener">Visit site ↗</a>` : ''}
              ${c.custom ? '<button type="button" data-action="edit">Edit</button>' : ''}
              <button type="button" data-action="hide">Hide</button>
              ${c.custom ? '' : '<button type="button" data-action="charges" class="danger">Now charges a fee</button>'}
            </div>
          </details>`}
    </div>
  </article>`;
}

function renderCurators() {
  const terms = state.q.toLowerCase().split(/\s+/).filter(Boolean);
  const list = sortCurators(allCurators().filter((c) => matches(c, terms)));
  $('#grid').innerHTML = list.map(cardHTML).join('');
  const shown = allCurators().filter((c) => !hiddenState(c.id)).length;
  $('#result-count').textContent = state.status === 'hidden'
    ? `${plural(list.length, 'hidden outlet')}`
    : list.length === shown ? `${plural(list.length, 'free outlet')}` : `Showing ${nf.format(list.length)} of ${plural(shown, 'free outlet')}`;
  const empty = $('#empty');
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = state.status === 'hidden'
      ? '<h2>Nothing hidden</h2><p>Outlets you hide or report as charging show up here.</p>'
      : `<h2>No outlets match</h2><p>Try a different search, kind or region.</p><button type="button" class="btn" id="clear-filters">Clear filters</button>`;
  }
}

// ---------------------------------------------------------------- pitch builder

function profileVars(c, release) {
  const pr = store.profile;
  const released = release?.date ? daysUntil(release.date) <= 0 : false;
  const article = /^[aeiou]/i.test(pr.genre || '') ? 'an' : 'a';
  const intro = [pr.genre && `${article} ${pr.genre} artist`, pr.city && `from ${pr.city}`].filter(Boolean).join(' ') || 'an independent artist';
  const handle = (v, base) => (!v ? '' : /^https?:\/\//.test(v) ? v : `${base}${v.replace(/^@/, '')}`);
  const socials = [
    pr.spotify && `Spotify: ${pr.spotify}`,
    pr.instagram && `Instagram: ${handle(pr.instagram, 'https://instagram.com/')}`,
    pr.tiktok && `TikTok: ${handle(pr.tiktok, 'https://www.tiktok.com/@')}`,
    pr.youtube && `YouTube: ${pr.youtube}`,
    pr.soundcloud && pr.soundcloud,
    pr.website && pr.website,
  ].filter(Boolean).join('\n');
  // Playlist submission sites route to many different curators, so no team name there.
  const greet = c.custom ? (c.greet || c.name)
    : c.kind === 'playlist' && c.method === 'form' ? 'there'
    : `${c.name.replace(/\s*\(.*?\)\s*/g, ' ').trim()} team`;
  return {
    greet,
    artist: pr.artist || 'Your Artist Name',
    intro,
    genre: pr.genre || 'hip-hop',
    city: pr.city,
    similar: pr.similar,
    similar_sentence: pr.similar ? `For fans of ${pr.similar}.` : '',
    bio: pr.bio,
    contact: pr.email,
    socials,
    track: release?.title || 'Your Track',
    type: release?.type || 'single',
    featuring: release?.features ? ` ${/^(feat|ft|with)\b/i.test(release.features) ? '' : 'feat. '}${release.features}` : '',
    released: !release?.date ? '' : released ? `came out ${fmtDay(release.date)}` : `drops ${fmtDay(release.date)}`,
    hook: release?.hook,
    story: release?.story,
    link: linkFor(release),
  };
}

function linkFor(release) {
  if (!release) return '';
  const released = release.date ? daysUntil(release.date) <= 0 : false;
  return released ? release.public_link || release.private_link : release.private_link || release.public_link;
}

function draftFor(c, release, followUp = false) {
  const vars = profileVars(c, release);
  const p = pitchFor(c.id, release);
  if (followUp) {
    vars.sent = p.sent ? `on ${fmtDay(localDay(p.sent))}` : 'recently';
    return { subject: fill(FOLLOW_UP.subject, vars), body: fill(FOLLOW_UP.body, vars) };
  }
  const t = TEMPLATES[c.kind] || TEMPLATES.playlist;
  return { subject: t.subject ? fill(t.subject, vars) : '', body: fill(t.body, vars) };
}

function mailtoHref(to, subject, body) {
  return `mailto:${to}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function gmailHref(to, subject, body) {
  const q = new URLSearchParams({ view: 'cm', fs: '1', to, su: subject, body });
  return `https://mail.google.com/mail/?${q}`;
}

// ---------------------------------------------------------------- pitch dialog

const pitchDialog = $('#pitch');
let open = null; // { curator, release, followUp }
let pitchSaveTimer = null;

function warningsFor(c, release) {
  const out = [];
  if (!store.profile.artist) out.push('Add your artist name in <button type="button" class="link-btn" data-go="kit">Kit</button> so pitches are signed properly.');
  if (!release) out.push('Add a release in <button type="button" class="link-btn" data-go="kit">Kit</button> first. The pitch below uses placeholders.');
  const w = windowFor(c, release);
  if (w.state === 'closed') out.push(`Closed for this release: ${esc(w.why.toLowerCase())}.`);
  if (w.state === 'late') out.push(`The ideal pitch-by date was ${esc(fmtDay(w.by))}. It's still accepted, so send it soon.`);
  if (release && !linkFor(release)) out.push('This release has no streaming link yet. Add one in Kit.');
  if (regionMismatch(c)) out.push(`This outlet is for ${esc(c.region)} artists.`);
  if (hiddenState(c.id) === 'charges') out.push('You reported that this outlet now charges. Skip it if that is true.');
  return out;
}

function openPitch(curatorId, { followUp = false } = {}) {
  const c = curatorById(curatorId);
  if (!c) return;
  flushPitchSave();
  const release = currentRelease();
  open = { curator: c, release, followUp };
  const p = pitchFor(c.id, release);

  $('#pitch-kicker').innerHTML = `${kindBadge(c.kind)}<span>${esc(c.region || 'Global')}</span>`;
  $('#pitch-title').textContent = followUp ? `Follow up with ${c.name}` : c.name;
  $('#pitch-meta').innerHTML = [
    c.method === 'email' ? `${ICON.mail}<span>${esc(c.contact)}</span>` : `${ICON.form}<a href="${esc(safeUrl(c.contact))}" target="_blank" rel="noopener">Their submission page ↗</a>`,
    c.custom ? '<span>Added by you</span>' : `<a href="${esc(safeUrl(c.free_proof))}" target="_blank" rel="noopener">${ICON.check}Free: ${esc(c.free_note || 'checked')}</a>`,
  ].map((s) => `<span class="meta-item">${s}</span>`).join('');
  $('#pitch-guide').innerHTML = c.guidelines ? `<p>${esc(c.guidelines)}</p>` : '';
  $('#pitch-guide').hidden = !c.guidelines;
  $('#pitch-warnings').innerHTML = warningsFor(c, release).map((w) => `<p class="warn">${ICON.warn}<span>${w}</span></p>`).join('');

  const draft = draftFor(c, release, followUp);
  const useSaved = !followUp && p.edited;
  $('#pitch-subject').value = useSaved ? p.subject : draft.subject;
  $('#pitch-body').value = useSaved ? p.body : draft.body;
  $('#pitch-reset').hidden = !useSaved;
  const formStyle = c.method === 'form' && !followUp;
  $('#subject-field').hidden = formStyle;
  $('#compose-label').textContent = followUp ? 'Follow-up' : formStyle ? 'Your pitch, ready to paste' : 'Your pitch';
  $('#body-label').textContent = formStyle ? (c.fields?.[0]?.label || 'Pitch text') : 'Message';
  $('#pitch-status').innerHTML = STATUSES.map((s) => `<option value="${s.id}"${s.id === p.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('');
  $('#pitch-status').disabled = !release;
  $('#pitch-notes').value = p.notes || '';
  $('#pitch-notes').disabled = !release;
  $('#pitch-saved').textContent = '';
  renderPitchDates();
  renderSendButtons();
  renderCounter();
  if (!pitchDialog.open) pitchDialog.showModal();
  pitchDialog.scrollTop = 0;
}

function renderPitchDates() {
  const p = open.release ? pitchFor(open.curator.id, open.release) : NO_PITCH;
  const bits = [];
  if (p.sent) bits.push(`Sent ${fmtDay(localDay(p.sent))}`);
  if (p.followed) bits.push(`followed up ${fmtDay(localDay(p.followed))}`);
  if (p.status === 'sent' && p.sent) {
    const due = addDays(localDay(p.sent), FOLLOW_UP_DAYS);
    bits.push(daysUntil(due) <= 0 ? 'follow-up due' : `follow up ${relDays(daysUntil(due))} if no reply`);
  }
  $('#pitch-dates').textContent = bits.join(' · ');
}

function renderSendButtons() {
  const c = open.curator;
  const subject = $('#pitch-subject').value;
  const body = $('#pitch-body').value;
  const sent = PITCHED.has(pitchFor(c.id, open.release).status) && !open.followUp;
  const markLabel = open.followUp ? 'Mark followed up' : 'Mark as sent';
  const markBtn = open.release && !sent ? `<button type="button" class="btn good" data-send="mark">${ICON.check}${markLabel}</button>` : '';
  if (c.method === 'email') {
    $('#pitch-send').innerHTML = `
      <a class="btn primary" data-send="open" href="${esc(mailtoHref(c.contact, subject, body))}">${ICON.mail}Open in email app</a>
      <a class="btn" data-send="open" href="${esc(gmailHref(c.contact, subject, body))}" target="_blank" rel="noopener">Open in Gmail ↗</a>
      <button type="button" class="btn" data-send="copy">Copy</button>
      ${markBtn}`;
  } else {
    $('#pitch-send').innerHTML = `
      <button type="button" class="btn primary" data-send="copy">Copy pitch</button>
      <a class="btn" data-send="open" href="${esc(safeUrl(c.contact))}" target="_blank" rel="noopener">Open submission page ↗</a>
      ${markBtn}`;
  }
}

function renderCounter() {
  const max = open?.curator.method === 'form' && !open.followUp ? open.curator.fields?.[0]?.max : null;
  const len = $('#pitch-body').value.length;
  const el = $('#pitch-counter');
  el.textContent = max ? `${nf.format(len)} / ${nf.format(max)} characters${len > max ? ': trim it before pasting' : ''}` : '';
  el.classList.toggle('over', !!max && len > max);
}

function flushPitchSave() {
  if (!pitchSaveTimer || !open) return;
  clearTimeout(pitchSaveTimer);
  pitchSaveTimer = null;
  if (!open.release) return;
  const patch = { notes: $('#pitch-notes').value };
  if (!open.followUp) {
    const draft = draftFor(open.curator, open.release);
    const subject = $('#pitch-subject').value, body = $('#pitch-body').value;
    const edited = subject !== draft.subject || body !== draft.body;
    Object.assign(patch, edited ? { subject, body, edited } : { subject: '', body: '', edited: false });
    $('#pitch-reset').hidden = !edited;
  }
  updatePitch(open.release.id, open.curator.id, patch);
  $('#pitch-saved').textContent = storageOk ? 'Saved' : 'Not saved: storage blocked';
  afterPitchChange();
}

function schedulePitchSave() {
  $('#pitch-saved').textContent = open?.release ? 'Saving…' : '';
  clearTimeout(pitchSaveTimer);
  pitchSaveTimer = setTimeout(flushPitchSave, 500);
}

function setStatus(status) {
  if (!open?.release) return;
  flushPitchSave();
  updatePitch(open.release.id, open.curator.id, { status });
  $('#pitch-status').value = status;
  renderPitchDates();
  renderSendButtons();
  afterPitchChange();
}

function afterPitchChange() {
  renderDueBadge();
  if (state.tab === 'curators') { renderKinds(); renderCurators(); }
  if (state.tab === 'pitches') renderPitches();
}

// ---------------------------------------------------------------- pitches view

function pitchRows(release) {
  const rows = [];
  for (const c of allCurators()) {
    const p = store.pitches[pitchKey(release.id, c.id)];
    if (p) rows.push({ c, p });
  }
  return rows;
}

function followUpDue(p) {
  return p.status === 'sent' && p.sent && daysUntil(addDays(localDay(p.sent), FOLLOW_UP_DAYS)) <= 0;
}

function renderDueBadge() {
  let due = 0;
  for (const p of Object.values(store.pitches)) if (followUpDue(p)) due++;
  const b = $('#due-badge');
  b.hidden = !due;
  b.textContent = due;
  b.title = `${plural(due, 'follow-up')} due`;
}

function renderPitches() {
  const release = currentRelease();
  const stats = $('#pitch-stats'), dueEl = $('#due'), listEl = $('#pitch-list');
  if (!release) {
    stats.innerHTML = '';
    dueEl.innerHTML = '';
    listEl.innerHTML = `<div class="empty"><h2>No release yet</h2><p>Add the song you're pitching in <strong>Kit</strong>, then pitch curators from the <strong>Curators</strong> tab. Every pitch you send is tracked here.</p><button type="button" class="btn primary" data-go="kit">Go to Kit</button></div>`;
    return;
  }
  const rows = pitchRows(release);
  const pitched = rows.filter((r) => PITCHED.has(r.p.status));
  const replies = pitched.filter((r) => ['replied', 'placed', 'declined'].includes(r.p.status)).length;
  const placed = pitched.filter((r) => r.p.status === 'placed').length;
  const rate = pitched.length ? Math.round((replies / pitched.length) * 100) : 0;
  stats.innerHTML = [
    ['Pitched', nf.format(pitched.length)],
    ['Replies', nf.format(replies)],
    ['Reply rate', `${rate}%`],
    ['Added / featured', nf.format(placed)],
  ].map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('');

  const due = rows.filter((r) => followUpDue(r.p));
  dueEl.innerHTML = due.length ? `<section class="due">
    <h2>${plural(due.length, 'follow-up')} due</h2>
    <p class="muted">No reply after ${FOLLOW_UP_DAYS} days. One polite nudge is fine; after that, move on.</p>
    <ul>${due.map(({ c, p }) => `<li><span><strong>${esc(c.name)}</strong> · sent ${esc(fmtDay(localDay(p.sent)))}</span>
      <span class="due-actions"><button type="button" class="btn" data-follow="${esc(c.id)}">Write follow-up</button>
      <button type="button" class="btn" data-silent="${esc(c.id)}">No response</button></span></li>`).join('')}</ul>
  </section>` : '';

  if (!rows.length) {
    listEl.innerHTML = `<div class="empty"><h2>Nothing pitched for “${esc(release.title)}” yet</h2><p>Open the <strong>Curators</strong> tab and start with the ones whose pitch-by date is closest.</p><button type="button" class="btn primary" data-go="curators">Find curators</button></div>`;
    return;
  }
  const order = STATUSES.map((s) => s.id);
  rows.sort((a, b) => order.indexOf(b.p.status) - order.indexOf(a.p.status) || (b.p.updated || '').localeCompare(a.p.updated || ''));
  listEl.innerHTML = `<div class="plist">${rows.map(({ c, p }) => `<div class="prow" data-id="${esc(c.id)}">
      <div class="prow-main">
        <button type="button" class="prow-name" data-open="${esc(c.id)}">${esc(c.name)}</button>
        <span class="prow-meta">${kindBadge(c.kind)}${p.sent ? `<span>Sent ${esc(fmtDay(localDay(p.sent)))}</span>` : ''}${p.notes ? `<span class="prow-note">${esc(p.notes.split('\n')[0])}</span>` : ''}</span>
      </div>
      <label class="select"><span class="visually-hidden">Status for ${esc(c.name)}</span>
        <select data-status-for="${esc(c.id)}">${STATUSES.map((s) => `<option value="${s.id}"${s.id === p.status ? ' selected' : ''}>${esc(s.label)}</option>`).join('')}</select>
      </label>
    </div>`).join('')}</div>`;
}

// ---------------------------------------------------------------- kit view

function renderProfile() {
  const form = $('#profile-form');
  for (const f of PROFILE_FIELDS) if (form.elements[f]) form.elements[f].value = store.profile[f] || '';
}

function renderReleaseList() {
  const el = $('#release-list');
  const sorted = [...store.releases].sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  if (!sorted.length) {
    el.innerHTML = '<p class="muted">No releases yet. Add the song you want to pitch.</p>';
    return;
  }
  el.innerHTML = sorted.map((r) => {
    const pitched = Object.entries(store.pitches).filter(([k, p]) => k.startsWith(`${r.id}:`) && PITCHED.has(p.status)).length;
    return `<div class="rrow">
      <div>
        <strong>${esc(r.title)}</strong>${r.features ? ` <span class="muted">${esc(r.features)}</span>` : ''}
        <p class="muted">${esc(r.type || 'single')}${r.date ? ` · ${esc(fmtDay(r.date))}` : ''} · ${plural(pitched, 'pitch')} sent${linkFor(r) ? '' : ' · <span class="warn-text">no streaming link</span>'}</p>
      </div>
      <div class="rrow-actions">
        <button type="button" class="btn" data-edit-release="${esc(r.id)}">Edit</button>
        <button type="button" class="btn primary" data-pitch-release="${esc(r.id)}">Pitch it</button>
      </div>
    </div>`;
  }).join('');
}

// ---------------------------------------------------------------- dialogs: release & curator

const releaseDialog = $('#release-dialog');
let editingRelease = null;

function openReleaseForm(id = null) {
  editingRelease = id ? store.releases.find((r) => r.id === id) : null;
  const form = $('#release-form');
  form.reset();
  $('#release-dialog-title').textContent = editingRelease ? `Edit “${editingRelease.title}”` : 'New release';
  $('#release-delete').hidden = !editingRelease;
  if (editingRelease) for (const f of RELEASE_FIELDS) form.elements[f].value = editingRelease[f] || '';
  releaseDialog.showModal();
  form.elements.title.focus();
}

function saveReleaseForm() {
  const form = $('#release-form');
  const data = {};
  for (const f of RELEASE_FIELDS) data[f] = form.elements[f].value.trim();
  if (editingRelease) Object.assign(editingRelease, data, { updated: now() });
  else {
    const r = { id: newId('r'), ...data, updated: now() };
    store.releases.push(r);
    store.release = r.id;
  }
  saveStore();
  releaseDialog.close();
  toast(editingRelease ? 'Release updated.' : 'Release added. Pitch-by dates are ready.');
  renderAll();
}

const curatorDialog = $('#curator-dialog');
let editingCurator = null;

function openCuratorForm(id = null) {
  editingCurator = id ? store.custom.find((c) => c.id === id) : null;
  const form = $('#curator-form');
  form.reset();
  $('#curator-dialog-title').textContent = editingCurator ? `Edit ${editingCurator.name}` : 'Add a curator';
  $('#curator-delete').hidden = !editingCurator;
  if (editingCurator) {
    for (const f of CURATOR_FIELDS) form.elements[f].value = editingCurator[f] || '';
    form.elements.lead_days.value = editingCurator.lead_days ?? '';
    form.elements.released_ok.checked = editingCurator.released_ok;
  }
  curatorDialog.showModal();
  form.elements.name.focus();
}

function saveCuratorForm() {
  const form = $('#curator-form');
  const raw = { id: editingCurator?.id || newId('c'), updated: now(), released_ok: form.elements.released_ok.checked, lead_days: form.elements.lead_days.value };
  for (const f of CURATOR_FIELDS) raw[f] = form.elements[f].value.trim();
  if (raw.method === 'email' && !EMAIL_RE.test(raw.contact)) { toast('That email address looks off.'); return; }
  if (raw.method === 'form' && !safeUrl(raw.contact)) { toast('Submission links need to start with https://'); return; }
  if (raw.url && !safeUrl(raw.url)) raw.url = '';
  const c = cleanCustom(raw);
  if (editingCurator) store.custom[store.custom.indexOf(editingCurator)] = c;
  else store.custom.push(c);
  saveStore();
  curatorDialog.close();
  toast(editingCurator ? 'Curator updated.' : 'Curator added.');
  renderAll();
}

// ---------------------------------------------------------------- tabs, theme, controls

function syncControls() {
  $('#search').value = state.q;
  for (const b of document.querySelectorAll('#status-seg button')) b.setAttribute('aria-pressed', String(b.dataset.status === state.status));
  $('#sort').value = state.sort;
  for (const b of document.querySelectorAll('.tab')) b.setAttribute('aria-pressed', String(b.dataset.tab === state.tab));
  for (const t of TABS) $(`#view-${t}`).hidden = state.tab !== t;
}

function renderAll() {
  syncControls();
  renderReleaseBar();
  renderDueBadge();
  if (state.tab === 'curators') { renderRegionOptions(); renderKinds(); renderCurators(); }
  if (state.tab === 'pitches') renderPitches();
  if (state.tab === 'kit') { renderProfile(); renderReleaseList(); }
}

function goTab(tab) {
  state.tab = tab;
  writeHash();
  renderAll();
  window.scrollTo({ top: 0 });
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

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    (document.querySelector('dialog[open]') || document.body).append(ta);
    ta.select();
    const ok = document.execCommand?.('copy');
    ta.remove();
    return !!ok;
  }
}

function mergeImport(data) {
  const incoming = clean(data);
  let n = 0;
  const newer = (a, b) => (a?.updated || '') > (b?.updated || '');
  if (newer(incoming.profile, store.profile)) { store.profile = incoming.profile; n++; }
  for (const r of incoming.releases) {
    const i = store.releases.findIndex((x) => x.id === r.id);
    if (i < 0) { store.releases.push(r); n++; } else if (newer(r, store.releases[i])) { store.releases[i] = r; n++; }
  }
  for (const c of incoming.custom) {
    const i = store.custom.findIndex((x) => x.id === c.id);
    if (i < 0) { store.custom.push(c); n++; } else if (newer(c, store.custom[i])) { store.custom[i] = c; n++; }
  }
  for (const [k, p] of Object.entries(incoming.pitches)) {
    if (newer(p, store.pitches[k]) || !store.pitches[k]) { store.pitches[k] = p; n++; }
  }
  for (const [id, h] of Object.entries(incoming.hidden)) {
    if (newer(h, store.hidden[id]) || !store.hidden[id]) { store.hidden[id] = h; n++; }
  }
  if (!currentRelease() && incoming.release) store.release = incoming.release;
  return n;
}

function bindEvents() {
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { state.q = e.target.value.trim(); writeHash(); renderCurators(); }, 120);
  });
  $('#status-seg').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-status]');
    if (!b) return;
    state.status = b.dataset.status;
    writeHash(); syncControls(); renderCurators();
  });
  $('#kind-chips').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-kind]');
    if (!b) return;
    state.kind = state.kind === b.dataset.kind ? '' : b.dataset.kind;
    writeHash(); renderKinds(); renderCurators();
  });
  $('#region').addEventListener('change', (e) => { state.region = e.target.value; writeHash(); renderCurators(); });
  $('#sort').addEventListener('change', (e) => { state.sort = e.target.value; writeHash(); renderCurators(); });
  $('#add-curator').addEventListener('click', () => openCuratorForm());
  $('#empty').addEventListener('click', (e) => {
    if (e.target.id !== 'clear-filters') return;
    Object.assign(state, { q: '', status: 'all', kind: '', region: '' });
    writeHash(); renderAll();
  });

  $('#grid').addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (!b) return;
    const id = b.closest('.ccard').dataset.id;
    const act = b.dataset.action;
    b.closest('details')?.removeAttribute('open');
    if (act === 'pitch') openPitch(id);
    else if (act === 'edit') openCuratorForm(id);
    else if (act === 'hide' || act === 'charges') {
      store.hidden[id] = { state: act === 'hide' ? 'hidden' : 'charges', updated: now() };
      saveStore();
      renderKinds(); renderCurators();
      toast(act === 'hide' ? 'Hidden. Find it under Hidden.' : 'Thanks. It is hidden and flagged as charging.');
    } else if (act === 'unhide') {
      store.hidden[id] = { state: 'shown', updated: now() };
      saveStore();
      renderKinds(); renderCurators();
    }
  });
  // Close any open card menu when clicking elsewhere.
  document.addEventListener('click', (e) => {
    for (const d of document.querySelectorAll('details[open]')) if (!d.contains(e.target)) d.open = false;
  });

  $('#release-select').addEventListener('change', (e) => { store.release = e.target.value; saveStore(); renderAll(); });
  $('#release-add').addEventListener('click', () => openReleaseForm());
  $('#release-add-2').addEventListener('click', () => openReleaseForm());

  for (const b of document.querySelectorAll('.tab')) b.addEventListener('click', () => goTab(b.dataset.tab));
  document.addEventListener('click', (e) => {
    const go = e.target.closest('[data-go]');
    if (!go) return;
    if (pitchDialog.open) pitchDialog.close();
    goTab(go.dataset.go);
  });

  // Pitches view
  $('#view-pitches').addEventListener('click', (e) => {
    const t = e.target.closest('[data-open], [data-follow], [data-silent]');
    if (!t) return;
    if (t.dataset.open) openPitch(t.dataset.open);
    else if (t.dataset.follow) openPitch(t.dataset.follow, { followUp: true });
    else if (t.dataset.silent) {
      updatePitch(store.release, t.dataset.silent, { status: 'silent' });
      afterPitchChange();
    }
  });
  $('#view-pitches').addEventListener('change', (e) => {
    const id = e.target.dataset.statusFor;
    if (!id) return;
    updatePitch(store.release, id, { status: e.target.value });
    afterPitchChange();
  });

  // Kit
  let profileTimer;
  $('#profile-form').addEventListener('input', () => {
    $('#profile-saved').textContent = 'Saving…';
    clearTimeout(profileTimer);
    profileTimer = setTimeout(() => {
      const form = $('#profile-form');
      for (const f of PROFILE_FIELDS) store.profile[f] = form.elements[f].value.trim();
      store.profile.updated = now();
      saveStore();
      $('#profile-saved').textContent = storageOk ? 'Saved' : 'Not saved: storage blocked';
    }, 400);
  });
  $('#profile-form').addEventListener('submit', (e) => e.preventDefault());
  $('#release-list').addEventListener('click', (e) => {
    const edit = e.target.closest('[data-edit-release]');
    const pitch = e.target.closest('[data-pitch-release]');
    if (edit) openReleaseForm(edit.dataset.editRelease);
    if (pitch) { store.release = pitch.dataset.pitchRelease; saveStore(); goTab('curators'); }
  });

  // Release dialog
  $('#release-form').addEventListener('submit', (e) => { e.preventDefault(); saveReleaseForm(); });
  $('#release-cancel').addEventListener('click', () => releaseDialog.close());
  $('#release-delete').addEventListener('click', () => {
    if (!editingRelease || !confirm(`Delete “${editingRelease.title}” and every pitch you tracked for it?`)) return;
    const id = editingRelease.id;
    store.releases = store.releases.filter((r) => r.id !== id);
    for (const k of Object.keys(store.pitches)) if (k.startsWith(`${id}:`)) delete store.pitches[k];
    if (store.release === id) store.release = '';
    saveStore();
    releaseDialog.close();
    renderAll();
  });

  // Curator dialog
  $('#curator-form').addEventListener('submit', (e) => { e.preventDefault(); saveCuratorForm(); });
  $('#curator-cancel').addEventListener('click', () => curatorDialog.close());
  $('#curator-delete').addEventListener('click', () => {
    if (!editingCurator || !confirm(`Remove ${editingCurator.name}? Pitches you tracked to it are removed too.`)) return;
    const id = editingCurator.id;
    store.custom = store.custom.filter((c) => c.id !== id);
    for (const k of Object.keys(store.pitches)) if (k.endsWith(`:${id}`)) delete store.pitches[k];
    delete store.hidden[id];
    saveStore();
    curatorDialog.close();
    renderAll();
  });

  // Pitch dialog
  $('#pitch-subject').addEventListener('input', () => { renderSendButtons(); if (!open.followUp) schedulePitchSave(); });
  $('#pitch-body').addEventListener('input', () => { renderSendButtons(); renderCounter(); if (!open.followUp) schedulePitchSave(); });
  $('#pitch-notes').addEventListener('input', schedulePitchSave);
  $('#pitch-status').addEventListener('change', (e) => setStatus(e.target.value));
  $('#pitch-reset').addEventListener('click', () => {
    const d = draftFor(open.curator, open.release);
    $('#pitch-subject').value = d.subject;
    $('#pitch-body').value = d.body;
    renderSendButtons(); renderCounter(); schedulePitchSave();
  });
  $('#pitch-send').addEventListener('click', async (e) => {
    const b = e.target.closest('[data-send]');
    if (!b) return;
    if (b.dataset.send === 'copy') {
      const subject = $('#pitch-subject').value;
      const text = open.curator.method === 'email' && subject ? `${subject}\n\n${$('#pitch-body').value}` : $('#pitch-body').value;
      toast((await copyText(text)) ? 'Copied. Paste it into their form or email.' : "Couldn't copy. Select the text and copy it yourself.");
      b.closest('.send').querySelector('[data-send="mark"]')?.classList.add('nudge');
    } else if (b.dataset.send === 'open') {
      b.closest('.send').querySelector('[data-send="mark"]')?.classList.add('nudge');
    } else if (b.dataset.send === 'mark') {
      setStatus(open.followUp ? 'followed' : 'sent');
      toast(open.followUp ? 'Marked as followed up.' : `Marked as sent. We'll remind you to follow up in ${FOLLOW_UP_DAYS} days.`);
    }
  });
  pitchDialog.addEventListener('click', (e) => { if (e.target === pitchDialog) pitchDialog.close(); });
  pitchDialog.addEventListener('close', () => { flushPitchSave(); open = null; });
  for (const d of [releaseDialog, curatorDialog]) d.addEventListener('click', (e) => { if (e.target === d) d.close(); });

  // Menu
  const menu = $('.menu');
  $('#export-btn').addEventListener('click', () => {
    const data = { app: 'free-pitch', exported: now(), ...store };
    download(`free-pitch-${todayISO()}.json`, JSON.stringify(data, null, 2), 'application/json');
    menu.open = false;
  });
  $('#import-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    menu.open = false;
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!isObj(data) || data.app !== 'free-pitch') throw new Error('not an export');
      const n = mergeImport(data);
      saveStore();
      renderAll();
      toast(`Imported ${plural(n, 'change')}.`);
    } catch {
      toast("That file isn't a Free Pitch export.");
    }
  });
  $('#reset-btn').addEventListener('click', () => {
    menu.open = false;
    if (!confirm('Erase your profile, releases, added curators and every tracked pitch in this browser? Export first if you want a backup.')) return;
    store = emptyStore();
    saveStore();
    renderAll();
    toast('Everything erased.');
  });

  // Theme
  $('#theme-toggle').addEventListener('click', () => {
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
    applyTheme(next);
    try { if (next === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, next); } catch {}
  });

  // "/" focuses search
  document.addEventListener('keydown', (e) => {
    if (e.key !== '/' || e.metaKey || e.ctrlKey || document.querySelector('dialog[open]')) return;
    if (e.target.closest('input, textarea, select, [contenteditable]')) return;
    e.preventDefault();
    if (state.tab !== 'curators') goTab('curators');
    $('#search').focus();
  });

  window.addEventListener('hashchange', () => { readHash(); renderAll(); });
  // Another tab may have changed the data.
  window.addEventListener('storage', (e) => {
    if (e.key !== STORE_KEY || document.querySelector('dialog[open]')) return;
    loadStore();
    renderAll();
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
    await loadDirectory();
  } catch (err) {
    console.error(err);
    toast("Couldn't load the curator directory.");
  }
  $('#checked-at').textContent = checkedAt ? fmtDay(checkedAt) : '—';
  renderAll();
}

init();
