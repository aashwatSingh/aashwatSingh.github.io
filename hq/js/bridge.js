// HQ's side of the Comet HQ Sync extension: find it, ask it to sync, and build its download.
// The extension's content script answers on this page through window.postMessage.

import { zip } from './zip.js';

/** The extension version this HQ ships. Must match extension/manifest.json (a test checks). */
export const EXT_VERSION = '1.0.0';

/** What goes into the download: [name in the zip, path relative to /hq/]. */
export const EXT_FILES = [
  ['manifest.json', 'extension/manifest.json'],
  ['background.js', 'extension/background.js'],
  ['content.js', 'extension/content.js'],
  ['icon-48.png', 'extension/icon-48.png'],
  ['icon-128.png', 'extension/icon-128.png'],
  // The same Canvas code the bookmarklet uses, so the two never drift apart.
  ['canvas.js', 'js/canvas.js'],
];

/** The extension as a .zip (one folder, comet-hq-sync/), fetched from HQ's own files. */
export async function extensionZip(base, fetchFn = fetch) {
  const files = await Promise.all(EXT_FILES.map(async ([name, src]) => {
    const res = await fetchFn(new URL(src, base).href);
    if (!res.ok) throw new Error(`Couldn’t load ${src} (${res.status})`);
    return { name: `comet-hq-sync/${name}`, bytes: new Uint8Array(await res.arrayBuffer()) };
  }));
  return zip(files);
}

/** a < b for dotted versions. */
export function olderThan(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x !== y) return x < y;
  }
  return false;
}

/**
 * Listen for the extension. `onFound` runs once, when it first answers.
 * Returns { present, version, sync(origin) } where sync resolves to { ok, data } or { ok: false, error, status }.
 */
export function connectExtension(onFound) {
  const state = { present: false, version: '' };
  const pending = new Map();
  window.addEventListener('message', (e) => {
    if (e.source !== window || e.origin !== location.origin) return;
    const m = e.data;
    if (m?.type === 'comet-hq-ext') {
      const first = !state.present;
      state.present = true;
      state.version = String(m.v || '');
      if (first) onFound?.();
    } else if (m?.type === 'comet-hq-sync-result' && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  window.postMessage({ type: 'comet-hq-ping' }, location.origin);
  return {
    get present() { return state.present; },
    get version() { return state.version; },
    sync(origin, timeoutMs = 90e3) {
      const id = Math.random().toString(36).slice(2);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, error: 'The extension didn’t answer. Try reloading HQ.' });
        }, timeoutMs);
        pending.set(id, (m) => { clearTimeout(timer); resolve(m); });
        window.postMessage({ type: 'comet-hq-sync', id, origin }, location.origin);
      });
    },
  };
}
