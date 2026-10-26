// Boot and routing. Each screen lives in views/ and is a function (main, params, ctx) that renders
// into <main> and may return a cleanup function (the capture screen uses it to stop the camera).

import * as store from './store.js';
import { $, $$, html, toast } from './ui.js';
import * as home from './views/home.js';
import * as office from './views/office.js';
import * as review from './views/review.js';
import * as settle from './views/settle.js';
import * as resident from './views/resident.js';
import * as report from './views/report.js';
import * as verify from './views/verify.js';
import * as syncview from './views/syncview.js';
import { startAutoSync, onStatus } from './sync.js';

const ROUTES = [
  ['/', home.render, null],
  ['/about', home.about, 'about'],
  ['/demo', home.loadDemo, 'office'],
  ['/office', office.dashboard, 'office'],
  ['/office/p/:pid', office.property, 'office'],
  ['/office/u/:uid', office.unit, 'office'],
  ['/office/rates/:pid', office.rates, 'office'],
  ['/office/qr/:uid', office.doorSign, 'office'],
  ['/office/review/:iid', review.render, 'office'],
  ['/office/settle/:iid', settle.render, 'office'],
  ['/report/:iid', report.render, null],
  ['/door/:payload', resident.door, null],
  ['/start/:uid', resident.start, null],
  ['/capture/:sid', resident.capture, null],
  ['/submit/:sid', resident.submit, null],
  ['/receipt/:sid', resident.receipt, null],
  ['/verify', verify.render, 'verify'],
  ['/office/sync', syncview.render, 'office'],
  ['/connect/:payload', syncview.connect, 'office'],
];

function match(path) {
  for (const [pattern, view, nav] of ROUTES) {
    const names = [];
    const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, n) => { names.push(n); return '([^/]+)'; })}$`);
    const m = re.exec(path);
    if (m) return { view, nav, params: Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(m[i + 1])])) };
  }
  return null;
}

let auto = null;

const ctx = {
  state: null,
  now: () => Date.now(),
  /** Save, then sync shortly after if this device syncs. */
  async save() { await store.saveState(ctx.state); auto?.soon(); },
  /** Save without scheduling a sync (used by the sync itself). */
  async persist() { await store.saveState(ctx.state); },
  go(path) { location.hash = path; },
  rerender: () => route(),
};

let cleanup = null;
let routing = 0;

async function route() {
  const ticket = ++routing;
  if (typeof cleanup === 'function') { try { cleanup(); } catch (e) { console.error(e); } }
  cleanup = null;
  const [rawPath, query = ''] = location.hash.replace(/^#/, '').split('?');
  const path = rawPath || '/';
  const found = match(path);
  const main = $('#main');
  for (const a of $$('[data-nav]')) {
    if (found && a.dataset.nav === found.nav) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  if (!found) {
    main.innerHTML = String(html`<h1>Not found</h1><p>That page doesn't exist. <a href="#/">Go home</a>.</p>`);
    return;
  }
  try {
    const result = await found.view(main, { ...found.params, query: new URLSearchParams(query) }, ctx);
    if (ticket !== routing) { if (typeof result === 'function') result(); return; }
    cleanup = result;
    document.title = `${$('h1', main)?.textContent?.trim() || 'Walkthru'} · Walkthru`;
  } catch (err) {
    console.error(err);
    if (ticket === routing) {
      main.innerHTML = String(html`<h1>Something went wrong</h1><p class="muted">${err.message}</p><p><a href="#/">Go home</a></p>`);
    }
  }
}

async function boot() {
  await store.init();
  ctx.state = await store.loadState();
  if (!store.persistent) {
    $('#storage-note').textContent = 'Storage is off in this browser, so data lasts only until you close the tab.';
  }
  window.addEventListener('hashchange', () => {
    route();
    $('#main').focus({ preventScroll: true });
    window.scrollTo(0, 0);
  });
  await route();
  onStatus((st) => {
    const el = $('#sync-note');
    if (!el) return;
    el.textContent = st.state === 'syncing' ? 'Syncing…' : st.state === 'error' ? 'Sync problem: see Office → Sync' : st.state === 'idle' ? 'Synced' : '';
    el.dataset.state = st.state;
  });
  auto = startAutoSync(ctx, onRemoteChange);
}

// New records arrived from another device. Redraw the screen unless someone is typing in it.
function onRemoteChange(summary) {
  const busy = document.activeElement?.closest?.('#main input, #main textarea, #main select');
  const path = location.hash.replace(/^#/, '').split('?')[0] || '/';
  const quiet = /^\/(capture|submit|demo)/.test(path);
  if (summary.pulled && !busy && !quiet) route();
  else if (summary.pulled && !quiet) toast('New records arrived from another device. Reopen this page to see them.');
}

boot().catch((err) => {
  console.error(err);
  toast(`Walkthru could not start: ${err.message}`, 'bad');
});
