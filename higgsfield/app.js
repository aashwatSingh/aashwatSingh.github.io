// Shell: hash router, credit pill, view mounting. Each view module in views/ exports
// mount(root, ctx) and may return an unmount() function.

import * as store from './store.js';
import { $, $$, toast } from './ui.js';

const ROUTES = {
  explore: () => import('./views/explore.js'),
  video: () => import('./views/video.js'),
  image: () => import('./views/image.js'),
  speak: () => import('./views/speak.js'),
  library: () => import('./views/library.js'),
  pricing: () => import('./views/pricing.js'),
};
const TITLES = { explore: 'Explore', video: 'Create video', image: 'Create image', speak: 'Speak', library: 'Assets', pricing: 'Pricing' };

let unmount = null;
let token = 0;

/** Parse "#/video?preset=dolly-in" into { route: 'video', params }. */
function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const route = ROUTES[path] ? path : 'explore';
  return { route, params: new URLSearchParams(query) };
}

export function navigate(route, params = {}) {
  const q = new URLSearchParams(params).toString();
  location.hash = `#/${route}${q ? `?${q}` : ''}`;
}

async function render() {
  const { route, params } = parseHash();
  const mine = ++token;
  try { unmount?.(); } catch (e) { console.error(e); }
  unmount = null;

  for (const a of $$('.nav a')) {
    if (a.dataset.route === route) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  document.title = `${TITLES[route]} · Higgsfield Clone`;

  const root = $('#view');
  root.replaceChildren();
  root.dataset.route = route;
  try {
    const mod = await ROUTES[route]();
    if (mine !== token) return;
    const ctx = { store, toast, navigate, params, route };
    unmount = (await mod.mount(root, ctx)) ?? null;
  } catch (e) {
    console.error(e);
    root.innerHTML = '<div class="page"><div class="empty"><h2>Something went wrong</h2><p>This page failed to load. Try reloading.</p></div></div>';
  }
  window.scrollTo(0, 0);
}

function paintCredits({ credits, plan }) {
  $('#credit-count').textContent = credits.toLocaleString();
  $('#plan-badge').textContent = store.PLANS.find((p) => p.id === plan)?.name ?? 'Free';
}

store.onChange(paintCredits);
paintCredits({ credits: store.getCredits(), plan: store.getPlan().id });
window.addEventListener('hashchange', render);
render();
