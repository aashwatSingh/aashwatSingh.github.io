// Persistence in IndexedDB: one state document (properties, units, inspections, submissions) and
// photo blobs keyed by their SHA-256 hash. Content addressing means a photo's key is its
// fingerprint, so a swapped or edited photo no longer matches the key it is stored under.
//
// If IndexedDB is unavailable (some private windows), everything works in memory for the visit
// and `persistent` is false so the UI can say so.

import { emptyState, STATE_VERSION } from './core/model.js';
import { sha256Hex } from './core/integrity.js';

const DB_NAME = 'walkthru';
const DB_VERSION = 1;
const STATE_KEY = 'main';

let db = null;
export let persistent = false;
const memory = { state: null, photos: new Map() };

function open() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('state')) d.createObjectStore('state');
      if (!d.objectStoreNames.contains('photos')) d.createObjectStore('photos');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Walkthru is open in another tab with an older version.'));
  });
}

function tx(storeName, mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    let result;
    const req = fn(store);
    req.onsuccess = () => { result = req.result; };
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Storage transaction aborted'));
  });
}

export async function init() {
  try {
    if (typeof indexedDB === 'undefined') throw new Error('no IndexedDB');
    db = await open();
    persistent = true;
  } catch (err) {
    console.warn('Walkthru: falling back to memory storage', err);
    db = null;
    persistent = false;
  }
}

function migrate(raw) {
  if (!raw || typeof raw !== 'object' || raw.version !== STATE_VERSION) return emptyState();
  const s = emptyState();
  for (const k of ['properties', 'units', 'inspections', 'submissions']) {
    if (raw[k] && typeof raw[k] === 'object') s[k] = raw[k];
  }
  if (raw.sync && typeof raw.sync === 'object') s.sync = raw.sync;
  return s;
}

export async function loadState() {
  if (!db) return migrate(memory.state);
  return migrate(await tx('state', 'readonly', (s) => s.get(STATE_KEY)));
}

export async function saveState(state) {
  if (!db) { memory.state = structuredClone(state); return; }
  await tx('state', 'readwrite', (s) => s.put(state, STATE_KEY));
}

/** Store a photo under its hash. `record` is { type, blob }. */
export async function putPhoto(hash, record) {
  if (!db) { memory.photos.set(hash, record); return; }
  await tx('photos', 'readwrite', (s) => s.put(record, hash));
}

async function getLocal(hash) {
  if (!db) return memory.photos.get(hash) || null;
  return (await tx('photos', 'readonly', (s) => s.get(hash))) || null;
}

// Where to look when a photo isn't stored here (sync.js sets it). It must resolve to
// { type, bytes } or null; the bytes are checked against the hash before they are kept.
let remoteSource = null;
const inflight = new Map();
export function setRemotePhotoSource(fn) { remoteSource = fn; }

async function fetchRemote(hash) {
  const got = await remoteSource(hash);
  if (!got) return null;
  if ((await sha256Hex(got.bytes)) !== hash) {
    console.warn('Walkthru: a downloaded photo did not match its fingerprint and was discarded', hash);
    return null;
  }
  const record = { type: got.type, blob: new Blob([got.bytes], { type: got.type }) };
  await putPhoto(hash, record);
  return record;
}

/** The stored { type, blob } for a hash, fetched from sync if it isn't here; null if unavailable. */
export async function getPhoto(hash) {
  const local = await getLocal(hash);
  if (local || !remoteSource) return local;
  if (!inflight.has(hash)) {
    inflight.set(hash, fetchRemote(hash).catch((err) => { console.warn('Walkthru: photo download failed', err); return null; })
      .finally(() => inflight.delete(hash)));
  }
  return inflight.get(hash);
}

export async function getPhotoBytes(hash) {
  const rec = await getPhoto(hash);
  return rec ? new Uint8Array(await rec.blob.arrayBuffer()) : null;
}

export async function hasPhoto(hash) {
  if (!db) return memory.photos.has(hash);
  return (await tx('photos', 'readonly', (s) => s.count(hash))) > 0;
}

/** Remove everything Walkthru stored in this browser. */
export async function clearAll() {
  memory.state = null;
  memory.photos.clear();
  if (!db) return;
  await tx('state', 'readwrite', (s) => s.clear());
  await tx('photos', 'readwrite', (s) => s.clear());
}
