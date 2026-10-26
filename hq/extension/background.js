// Reads Canvas for Comet HQ with the login you already have. canvas.js is HQ's own js/canvas.js,
// copied in when HQ builds the download, so the extension and the bookmarklet run the same code.
import { canvasGet, pullCanvas } from './canvas.js';

async function sync(origin) {
  if (typeof origin !== 'string' || !/^https?:\/\/[^/\s]+$/.test(origin)) throw new Error('HQ doesn’t know your Canvas address yet.');
  // Only Canvas hosts this extension was installed for (see host_permissions in manifest.json).
  if (!(await chrome.permissions.contains({ origins: [`${origin}/*`] }))) throw new Error(`This extension can’t read ${origin}.`);
  const get = (path) => canvasGet(path, origin, null, (url, opts) => fetch(url, { ...opts, credentials: 'include' }));
  return pullCanvas(get, Date.now(), origin);
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg?.type !== 'sync' || sender.id !== chrome.runtime.id) return false;
  sync(msg.origin).then(
    (data) => reply({ ok: true, data }),
    (e) => reply({ ok: false, error: String(e?.message || e), status: e?.status || 0 }),
  );
  return true;
});
