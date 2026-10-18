// Assets: everything the user generated, from the IndexedDB store. Filter, search, sort,
// hover-play videos, and a viewer with download / favorite / delete / reuse actions.

import { h, modal, download, plural, ICON } from '../ui.js';

const FILTERS = [
  { id: 'all', name: 'All' },
  { id: 'video', name: 'Video' },
  { id: 'image', name: 'Image' },
  { id: 'speak', name: 'Speak' },
  { id: 'fav', name: 'Favorites' },
];
const TYPE_NAME = { video: 'Video', image: 'Image', speak: 'Speak' };
const TYPE_ICON = { video: 'camera', image: 'image', speak: 'mic' };

function fmtBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i < 2 ? 0 : 1)} ${u[i]}`;
}

function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString();
}

const isVideoBlob = (b) => b instanceof Blob && b.type.startsWith('video/');
const isAudioBlob = (b) => b instanceof Blob && b.type.startsWith('audio/');
const isImageBlob = (b) => b instanceof Blob && b.type.startsWith('image/');

function extFor(blob, type) {
  const t = blob?.type ?? '';
  const m = t.match(/^[a-z]+\/([a-z0-9.+-]+)/i);
  if (m) return { jpeg: 'jpg', 'svg+xml': 'svg', mpeg: 'mp3', 'x-wav': 'wav', quicktime: 'mov' }[m[1]] ?? m[1];
  return type === 'image' ? 'png' : 'webm';
}

/** Short human labels for whatever meta a tool stored (only the useful, known keys). */
function metaBits(rec) {
  const m = rec.meta ?? {};
  const out = [];
  if (Number.isFinite(+m.duration) && +m.duration > 0) out.push(`${+m.duration % 1 ? (+m.duration).toFixed(1) : +m.duration}s`);
  if (m.aspect) out.push(String(m.aspect));
  else if (m.width && m.height) out.push(`${m.width}×${m.height}`);
  return out;
}

function metaRows(rec, presetName) {
  const m = rec.meta ?? {};
  const label = { presetName: 'Preset', preset: 'Preset', model: 'Model', duration: 'Duration', aspect: 'Aspect', style: 'Style', styleName: 'Style', seed: 'Seed', voice: 'Voice', width: 'Width', height: 'Height', resolution: 'Resolution', intensity: 'Intensity', batch: 'Batch' };
  const rows = [];
  const used = new Set();
  for (const [k, v] of Object.entries(m)) {
    if (v == null || v === '' || typeof v === 'object') continue;
    if ((k === 'preset' && m.presetName) || (k === 'style' && m.styleName)) continue; // prefer readable names
    const name = label[k] ?? k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());
    if (used.has(name)) continue;
    used.add(name);
    if (k === 'preset' && presetName) { rows.push([name, presetName(v)]); continue; }
    rows.push([name, k === 'duration' ? `${v}s` : String(v)]);
  }
  return rows;
}

export async function mount(root, ctx) {
  const { store } = ctx;
  const presetsMod = await import('../presets.js').catch(() => null);
  const urls = new Map(); // asset id -> object URL
  const urlFor = (rec) => {
    if (!(rec.blob instanceof Blob)) return null;
    if (!urls.has(rec.id)) urls.set(rec.id, URL.createObjectURL(rec.blob));
    return urls.get(rec.id);
  };
  const dropUrl = (id) => { const u = urls.get(id); if (u) { URL.revokeObjectURL(u); urls.delete(id); } };

  let assets = [];
  let filter = FILTERS.some((f) => f.id === ctx.params.get('filter')) ? ctx.params.get('filter') : 'all';
  let query = '';
  let sort = 'new';
  let openModal = null;
  let dead = false;

  const countEl = h('p', {});
  const storageEl = h('p', { class: 'pg-storage', hidden: true });
  const chips = h('div', { class: 'pg-chips pg-lib-filters', role: 'group', 'aria-label': 'Filter assets' });
  const search = h('input', { type: 'search', class: 'input pg-search-input', id: 'pg-lib-search', placeholder: 'Search prompts', autocomplete: 'off' });
  const sortSel = h('select', { class: 'select', id: 'pg-lib-sort' },
    h('option', { value: 'new' }, 'Newest first'), h('option', { value: 'old' }, 'Oldest first'));
  const grid = h('div', { class: 'pg-lib-grid', role: 'list' });
  const toolbar = h('div', { class: 'pg-lib-toolbar' },
    chips,
    h('div', { class: 'pg-lib-tools' },
      h('label', { class: 'pg-search' }, h('span', { class: 'pg-sr' }, 'Search prompts'), h('span', { class: 'pg-search-icon', html: ICON.search }), search),
      h('label', { class: 'pg-sort' }, h('span', { class: 'pg-sr' }, 'Sort'), sortSel)));

  root.append(h('div', { class: 'page pg-library' },
    h('div', { class: 'page-head' },
      h('div', {}, h('span', { class: 'eyebrow' }, 'Assets'), h('h1', {}, 'Your library'), countEl),
      storageEl),
    toolbar,
    grid));

  search.addEventListener('input', () => { query = search.value.trim().toLowerCase(); renderGrid(); });
  sortSel.addEventListener('change', () => { sort = sortSel.value; renderGrid(); });

  async function refresh() {
    try { assets = await store.listAssets(); } catch (e) { console.error(e); assets = []; }
    if (dead) return;
    renderChips();
    renderGrid();
    renderStorage();
  }

  function counts() {
    const c = { all: assets.length, video: 0, image: 0, speak: 0, fav: 0 };
    for (const a of assets) { c[a.type] = (c[a.type] ?? 0) + 1; if (a.favorite) c.fav++; }
    return c;
  }

  function renderChips() {
    const c = counts();
    chips.replaceChildren(...FILTERS.map((f) => h('button', {
      type: 'button', class: 'chip', 'aria-pressed': String(f.id === filter),
      onclick: () => { filter = f.id; renderChips(); renderGrid(); },
    }, f.name, h('span', { class: 'pg-chip-count' }, String(c[f.id] ?? 0)))));
    countEl.textContent = assets.length
      ? `${plural(assets.length, 'asset')} made on this device. Nothing leaves your browser.`
      : 'Everything you generate lands here, stored only in this browser.';
    toolbar.hidden = !assets.length;
  }

  async function renderStorage() {
    const own = assets.reduce((s, a) => s + (a.blob?.size ?? 0) + (a.thumb?.length ?? 0), 0);
    let text = assets.length ? `${fmtBytes(own)} of media` : '';
    try {
      const est = await navigator.storage?.estimate?.();
      if (est?.quota) text = `${text ? `${text} · ` : ''}${fmtBytes(est.usage ?? 0)} used of ${fmtBytes(est.quota)} available`;
    } catch {}
    if (dead) return;
    storageEl.hidden = !text;
    storageEl.replaceChildren(h('span', { class: 'pg-storage-dot' }), text);
  }

  function visible() {
    let list = assets.filter((a) => (filter === 'all' ? true : filter === 'fav' ? a.favorite : a.type === filter));
    if (query) list = list.filter((a) => a.prompt.toLowerCase().includes(query) || String(a.meta?.presetName ?? a.meta?.preset ?? '').toLowerCase().includes(query));
    list.sort((a, b) => (sort === 'old' ? a.createdAt - b.createdAt : b.createdAt - a.createdAt));
    return list;
  }

  function renderGrid() {
    if (!assets.length) { grid.replaceChildren(emptyState()); grid.classList.add('is-empty'); return; }
    grid.classList.remove('is-empty');
    const list = visible();
    if (!list.length) {
      grid.replaceChildren(h('div', { class: 'empty pg-lib-empty' },
        h('h2', {}, 'No matches'),
        h('p', {}, query ? `Nothing in ${FILTERS.find((f) => f.id === filter).name.toLowerCase()} matches “${search.value.trim()}”.` : 'Nothing here yet.'),
        h('button', { type: 'button', class: 'btn', onclick: () => { filter = 'all'; query = ''; search.value = ''; renderChips(); renderGrid(); } }, 'Clear filters')));
      grid.classList.add('is-empty');
      return;
    }
    grid.replaceChildren(...list.map(tile));
  }

  function emptyState() {
    return h('div', { class: 'pg-lib-empty-hero' },
      h('div', { class: 'pg-lib-empty-art', 'aria-hidden': 'true' }, h('span', { html: ICON.camera }), h('span', { html: ICON.image }), h('span', { html: ICON.mic })),
      h('h2', {}, 'No assets yet'),
      h('p', {}, 'Videos, images and talking avatars you generate are saved here automatically.'),
      h('div', { class: 'pg-lib-empty-ctas' },
        h('a', { class: 'btn btn-primary', href: '#/video' }, h('span', { html: ICON.camera }), 'Create a video'),
        h('a', { class: 'btn', href: '#/image' }, h('span', { html: ICON.image }), 'Generate an image'),
        h('a', { class: 'btn', href: '#/speak' }, h('span', { html: ICON.mic }), 'Make it speak')));
  }

  function thumbNode(rec) {
    if (rec.thumb) return h('img', { src: rec.thumb, alt: '', loading: 'lazy', decoding: 'async' });
    if (isImageBlob(rec.blob)) return h('img', { src: urlFor(rec), alt: '', loading: 'lazy', decoding: 'async' });
    return h('span', { class: 'pg-thumb-fallback', html: ICON[TYPE_ICON[rec.type]] ?? ICON.sparkle });
  }

  function tile(rec) {
    const media = h('span', { class: 'pg-asset-media' }, thumbNode(rec));
    const bits = metaBits(rec);
    const fav = h('span', { class: 'pg-asset-fav', html: ICON.heart, hidden: !rec.favorite, title: 'Favorite' });
    const el = h('button', { type: 'button', class: 'pg-asset', 'aria-label': `Open ${TYPE_NAME[rec.type] ?? 'asset'}: ${rec.prompt || 'untitled'}`, onclick: () => openViewer(rec) },
      media,
      h('span', { class: `badge pg-type pg-type-${rec.type}` }, h('span', { html: ICON[TYPE_ICON[rec.type]] ?? ICON.sparkle }), TYPE_NAME[rec.type] ?? rec.type),
      fav,
      isVideoBlob(rec.blob) ? h('span', { class: 'pg-asset-play', html: ICON.play }) : null,
      h('span', { class: 'pg-asset-info' },
        h('span', { class: 'pg-asset-prompt' }, rec.prompt || 'Untitled'),
        h('span', { class: 'pg-asset-meta' }, [...bits, ago(rec.createdAt)].join(' · '))));
    el._fav = fav;
    if (isVideoBlob(rec.blob)) {
      let vid = null;
      const start = () => {
        if (vid) return;
        vid = h('video', { src: urlFor(rec), muted: true, loop: true, playsinline: true, preload: 'auto', 'aria-hidden': 'true' });
        vid.muted = true;
        vid.addEventListener('playing', () => vid?.classList.add('is-on'));
        media.append(vid);
        vid.play().catch(() => {});
      };
      const end = () => { if (!vid) return; vid.pause(); vid.removeAttribute('src'); vid.load(); vid.remove(); vid = null; };
      el.addEventListener('pointerenter', start);
      el.addEventListener('pointerleave', end);
      el.addEventListener('focus', start);
      el.addEventListener('blur', end);
    }
    return h('div', { role: 'listitem', class: 'pg-asset-cell', dataset: { id: rec.id } }, el);
  }

  function openViewer(rec) {
    let player;
    if (isVideoBlob(rec.blob)) {
      player = h('video', { src: urlFor(rec), controls: true, loop: true, playsinline: true, autoplay: rec.type !== 'speak', poster: rec.thumb || null });
      if (rec.type !== 'speak') player.muted = true;
    } else if (isAudioBlob(rec.blob)) {
      player = h('div', { class: 'pg-viewer-audio' }, rec.thumb ? h('img', { src: rec.thumb, alt: '' }) : null, h('audio', { src: urlFor(rec), controls: true }));
    } else if (isImageBlob(rec.blob) || rec.thumb) {
      player = h('img', { src: isImageBlob(rec.blob) ? urlFor(rec) : rec.thumb, alt: rec.prompt || 'Generated image' });
    } else {
      player = h('div', { class: 'pg-thumb-fallback', html: ICON.sparkle });
    }

    const favBtn = h('button', { type: 'button', class: 'btn pg-fav-btn', 'aria-pressed': String(!!rec.favorite) }, h('span', { html: ICON.heart }), h('span', {}, rec.favorite ? 'Favorited' : 'Favorite'));
    favBtn.addEventListener('click', async () => {
      const on = await store.toggleFavorite(rec.id);
      rec.favorite = on;
      favBtn.setAttribute('aria-pressed', String(on));
      favBtn.lastChild.textContent = on ? 'Favorited' : 'Favorite';
      renderChips();
      if (filter === 'fav') renderGrid();
      else { const t = grid.querySelector(`[data-id="${CSS.escape(rec.id)}"] .pg-asset`); if (t) t._fav.hidden = !on; }
    });

    const delBtn = h('button', { type: 'button', class: 'btn pg-del-btn' }, h('span', { html: ICON.trash }), h('span', {}, 'Delete'));
    let armed = 0;
    delBtn.addEventListener('click', async () => {
      if (!armed) {
        delBtn.classList.add('is-armed');
        delBtn.lastChild.textContent = 'Click again to delete';
        armed = setTimeout(() => { armed = 0; delBtn.classList.remove('is-armed'); delBtn.lastChild.textContent = 'Delete'; }, 4000);
        return;
      }
      clearTimeout(armed);
      await store.deleteAsset(rec.id);
      openModal?.close();
      dropUrl(rec.id);
      assets = assets.filter((a) => a.id !== rec.id);
      renderChips();
      renderGrid();
      renderStorage();
      ctx.toast('Asset deleted', 'info');
    });

    const dlBtn = h('button', { type: 'button', class: 'btn' }, h('span', { html: ICON.download }), 'Download');
    dlBtn.addEventListener('click', async () => {
      let blob = rec.blob instanceof Blob ? rec.blob : null;
      if (!blob && rec.thumb) { try { blob = await (await fetch(rec.thumb)).blob(); } catch {} }
      if (!blob) { ctx.toast('Nothing to download for this asset', 'bad'); return; }
      download(blob, `higgsfield-${rec.type}-${rec.id}.${extFor(blob, rec.type)}`);
    });

    const go = (route, params) => { openModal?.close(); ctx.navigate(route, params); };
    const tool = TYPE_NAME[rec.type] ? rec.type : 'image';
    const actions = h('div', { class: 'pg-viewer-actions' },
      rec.type === 'image' ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => go('video', { asset: rec.id }) }, h('span', { html: ICON.camera }), 'Animate') : null,
      rec.prompt ? h('button', { type: 'button', class: `btn${rec.type === 'image' ? '' : ' btn-primary'}`, onclick: () => go(tool, { prompt: rec.prompt }) }, h('span', { html: ICON.sparkle }), 'Reuse prompt') : null,
      dlBtn, favBtn, delBtn);

    const rows = metaRows(rec, (id) => presetsMod?.presetById?.(id)?.name ?? id);
    const created = new Date(rec.createdAt);
    const body = h('div', { class: 'pg-viewer' },
      h('div', { class: 'pg-viewer-media' }, player),
      h('div', { class: 'pg-viewer-side' },
        h('span', { class: `badge pg-type pg-type-${rec.type}` }, h('span', { html: ICON[TYPE_ICON[rec.type]] ?? ICON.sparkle }), TYPE_NAME[rec.type] ?? rec.type),
        h('h2', { class: 'pg-viewer-title' }, rec.type === 'speak' ? 'Script' : 'Prompt'),
        h('p', { class: 'pg-viewer-prompt' }, rec.prompt || 'No prompt'),
        actions,
        h('dl', { class: 'pg-viewer-meta' },
          h('div', {}, h('dt', {}, 'Created'), h('dd', {}, h('time', { datetime: created.toISOString() }, created.toLocaleString()))),
          rec.blob?.size ? h('div', {}, h('dt', {}, 'Size'), h('dd', {}, fmtBytes(rec.blob.size))) : null,
          rows.map(([k, v]) => h('div', {}, h('dt', {}, k), h('dd', {}, v))))));
    openModal = modal(body, {
      label: `${TYPE_NAME[rec.type] ?? 'Asset'} viewer`, wide: true,
      onClose: () => {
        clearTimeout(armed);
        const v = body.querySelector('video, audio');
        if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
        openModal = null;
      },
    });
  }

  await refresh();

  return () => {
    dead = true;
    openModal?.close();
    for (const v of grid.querySelectorAll('video')) { v.pause(); v.removeAttribute('src'); }
    for (const u of urls.values()) URL.revokeObjectURL(u);
    urls.clear();
  };
}
