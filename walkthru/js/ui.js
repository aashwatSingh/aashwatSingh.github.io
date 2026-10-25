// Small DOM helpers shared by every view: safe HTML templating, formatting, toasts and photos.

import { getPhoto } from './store.js';

// ---------------------------------------------------------------- safe HTML
//
// html`<p>${name}</p>` escapes every interpolated value. Arrays are joined, null/false render as
// nothing, and raw(...) or a nested html`` result passes through unescaped. Views build all
// markup with it, so text from residents, record files or the URL can't inject markup.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));

function part(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new Raw(out);
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

// ---------------------------------------------------------------- formatting

const DATE = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const DATE_TIME = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
const TIME_S = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' });

export const fmtDate = (iso) => (iso ? DATE.format(new Date(iso.length === 10 ? `${iso}T12:00:00` : iso)) : '—');
export const fmtDateTime = (iso) => (iso ? DATE_TIME.format(new Date(iso)) : '—');
export const fmtTime = (iso) => (iso ? TIME_S.format(new Date(iso)) : '—');
export const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "2 h 05 m" until a moment, or "closed". */
export function countdown(toIso, now = Date.now()) {
  const ms = new Date(toIso).getTime() - now;
  if (ms <= 0) return 'closed';
  const h = Math.floor(ms / 3600e3);
  const m = Math.floor((ms % 3600e3) / 60e3);
  return h ? `${h} h ${String(m).padStart(2, '0')} m` : `${m} m`;
}

/** Local YYYY-MM-DD for a moment. */
export function localDay(t = Date.now()) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export const KIND_LABEL = { 'move-in': 'Move-in', 'move-out': 'Move-out' };
export const CONDITION_LABEL = { ok: 'Looks fine', wear: 'Normal wear', damage: 'Damage' };
export const STATUS_LABEL = { collecting: 'Collecting', ready: 'Ready to review', locked: 'Closed, empty', finalized: 'Finalized' };

// ---------------------------------------------------------------- toasts

let toastTimer = 0;
export function toast(message, kind = 'info') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ---------------------------------------------------------------- photos

const urls = new Map();

/** An object URL for a stored photo, cached for the visit. Null if the photo isn't here. */
export async function photoURL(hash) {
  if (!hash) return null;
  if (urls.has(hash)) return urls.get(hash);
  const rec = await getPhoto(hash);
  if (!rec) return null;
  const url = URL.createObjectURL(rec.blob);
  urls.set(hash, url);
  return url;
}

/** Forget a cached URL (after a photo is replaced, e.g. by the tamper demo). */
export function dropPhotoURL(hash) {
  const url = urls.get(hash);
  if (url) URL.revokeObjectURL(url);
  urls.delete(hash);
}

/**
 * Fill every <img data-photo="hash"> under `root` with its stored photo. Missing photos get a
 * "Photo not in this browser" placeholder.
 */
export async function hydratePhotos(root) {
  await Promise.all($$('img[data-photo]', root).map(async (img) => {
    const url = await photoURL(img.dataset.photo);
    if (url) img.src = url;
    else img.replaceWith(Object.assign(document.createElement('div'), { className: 'photo-missing', textContent: 'Photo not in this browser' }));
  }));
}

/** Save a Blob as a download. */
export function download(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** A file-safe slug: "Unit 204 move-out" → "unit-204-move-out". */
export const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

/** Ask before a destructive action, using a native dialog element. Resolves true or false. */
export function confirmBox(message, okLabel = 'Continue') {
  return new Promise((resolve) => {
    const dlg = document.createElement('dialog');
    dlg.className = 'confirm';
    dlg.innerHTML = String(html`<form method="dialog"><p>${message}</p><div class="row end">
      <button class="btn ghost" value="no">Cancel</button><button class="btn danger" value="yes">${okLabel}</button></div></form>`);
    document.body.append(dlg);
    dlg.addEventListener('close', () => { resolve(dlg.returnValue === 'yes'); dlg.remove(); });
    dlg.showModal();
  });
}
