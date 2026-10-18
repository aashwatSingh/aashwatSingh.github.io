// Credits, plan and the asset library. Settings live in localStorage; generated
// media (Blobs) live in IndexedDB. Both fall back to memory when the browser blocks storage.

const SETTINGS_KEY = 'higgsfield-clone:v1';
const DB_NAME = 'higgsfield-clone';
const DB_STORE = 'assets';

export const PLANS = [
  { id: 'free', name: 'Free', price: 0, credits: 60, perks: ['60 credits to start', '720p exports', 'Every camera preset', 'Watermark on exports'] },
  { id: 'basic', name: 'Basic', price: 9, credits: 150, perks: ['150 credits a month', '1080p exports', 'No watermark', 'Soul image styles'] },
  { id: 'pro', name: 'Pro', price: 29, credits: 600, popular: true, perks: ['600 credits a month', '1080p exports', 'Priority queue', 'Speak avatars', 'Commercial use'] },
  { id: 'ultimate', name: 'Ultimate', price: 49, credits: 1200, perks: ['1,200 credits a month', 'Everything in Pro', 'Unlimited Soul images', 'Early access to new presets'] },
];

const DEFAULTS = { credits: 60, plan: 'free', lastPrompt: {} };
const listeners = new Set();
let settings = load();

function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
    if (raw && typeof raw === 'object') {
      return {
        credits: Number.isFinite(raw.credits) ? Math.max(0, Math.round(raw.credits)) : DEFAULTS.credits,
        plan: PLANS.some((p) => p.id === raw.plan) ? raw.plan : DEFAULTS.plan,
        lastPrompt: raw.lastPrompt && typeof raw.lastPrompt === 'object' ? raw.lastPrompt : {},
      };
    }
  } catch {}
  return structuredClone(DEFAULTS);
}

function save() {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
  for (const fn of listeners) fn(snapshot());
}

const snapshot = () => ({ credits: settings.credits, plan: settings.plan });

/** Subscribe to credit/plan changes. Returns an unsubscribe function. */
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

export const getCredits = () => settings.credits;
export const getPlan = () => PLANS.find((p) => p.id === settings.plan);

/** Take `n` credits. Returns false (and takes nothing) when the balance is too low. */
export function spendCredits(n) {
  if (n > settings.credits) return false;
  settings.credits -= n;
  save();
  return true;
}

export function addCredits(n) { settings.credits += Math.max(0, Math.round(n)); save(); }

/** Switch plan and top up with that plan's monthly credits. */
export function setPlan(id) {
  const plan = PLANS.find((p) => p.id === id);
  if (!plan) return;
  settings.plan = id;
  settings.credits += plan.credits;
  save();
}

/** Remember the last prompt per tool ('video' | 'image' | 'speak') so a reload doesn't lose it. */
export const getLastPrompt = (tool) => settings.lastPrompt[tool] ?? '';
export function setLastPrompt(tool, text) {
  settings.lastPrompt[tool] = String(text).slice(0, 2000);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

// ---------------------------------------------------------------- assets (IndexedDB)

let dbPromise = null;
const memory = new Map();

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE, { keyPath: 'id' });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
      } catch { resolve(null); }
    });
  }
  return dbPromise;
}

async function tx(mode, fn) {
  const d = await db();
  if (!d) return fn(null);
  return new Promise((resolve, reject) => {
    const t = d.transaction(DB_STORE, mode);
    const out = fn(t.objectStore(DB_STORE));
    t.oncomplete = () => resolve(out?.result ?? out);
    t.onerror = () => reject(t.error);
  });
}

const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/**
 * Save a generated asset.
 * @param {{type:'video'|'image'|'speak', prompt:string, blob:Blob, thumb:string, meta?:object}} asset
 *   thumb is a small JPEG data URL; meta holds tool settings (preset, model, aspect, duration, ...).
 * @returns {Promise<string>} the new asset id
 */
export async function saveAsset({ type, prompt, blob, thumb, meta = {} }) {
  const rec = { id: newId(), type, prompt: String(prompt ?? ''), blob, thumb, meta, favorite: false, createdAt: Date.now() };
  try {
    await tx('readwrite', (s) => (s ? s.put(rec) : memory.set(rec.id, rec)));
  } catch { memory.set(rec.id, rec); }
  return rec.id;
}

/** All assets, newest first. */
export async function listAssets() {
  let rows = [];
  try { rows = await tx('readonly', (s) => (s ? s.getAll() : null)) ?? []; } catch {}
  rows = [...rows, ...memory.values()];
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

export async function getAsset(id) {
  if (memory.has(id)) return memory.get(id);
  try { return await tx('readonly', (s) => (s ? s.get(id) : null)); } catch { return null; }
}

export async function deleteAsset(id) {
  memory.delete(id);
  try { await tx('readwrite', (s) => s?.delete(id)); } catch {}
}

export async function toggleFavorite(id) {
  const rec = await getAsset(id);
  if (!rec) return false;
  rec.favorite = !rec.favorite;
  if (memory.has(id)) memory.set(id, rec);
  else { try { await tx('readwrite', (s) => s?.put(rec)); } catch {} }
  return rec.favorite;
}
