// Runs on Comet HQ's page only. It passes HQ's "sync now" requests to the background worker,
// which can read Canvas with your login, and hands the result back to the page.
const VERSION = chrome.runtime.getManifest().version;
const post = (msg) => window.postMessage(msg, location.origin);

window.addEventListener('message', (e) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const m = e.data;
  if (m?.type === 'comet-hq-ping') post({ type: 'comet-hq-ext', v: VERSION });
  if (m?.type !== 'comet-hq-sync' || typeof m.id !== 'string') return;
  chrome.runtime.sendMessage({ type: 'sync', origin: m.origin }, (res) => {
    const out = chrome.runtime.lastError ? { ok: false, error: chrome.runtime.lastError.message } : res;
    post({ type: 'comet-hq-sync-result', id: m.id, ...out });
  });
});

post({ type: 'comet-hq-ext', v: VERSION });
