// Sync with a Supabase project through the functions in supabase/schema.sql, over plain fetch
// (no SDK). Two kinds of channel:
//   office  { url, anon, key }       the sync key: everything in the space
//   door    { url, anon, token }     a unit's door code: send that unit's sealed records, get its baseline
// Settings and per-channel progress live in state.sync:
//   { office: { url, anon, key, meta }, doors: { unitId: { url, anon, token, meta } }, tokens: { unitId: token } }
//
// Nothing from the server is trusted: photos are checked against their fingerprints and every
// sealed submission is verified before it is used.

import { pendingDocs, applyDoc, emptyMeta, docKey } from './core/syncdocs.js';
import { verifySubmission, sha256Hex } from './core/integrity.js';
import { bytesToBase64, base64ToBytes, cleanSyncUrl, isPublicKey, isSecret } from './core/payload.js';
import { getPhotoBytes, hasPhoto, putPhoto, getPhoto, setRemotePhotoSource } from './store.js';

const PUSH_BATCH = 100;
const AUTO_EVERY_MS = 30_000;

// ---------------------------------------------------------------- settings

export const syncOf = (state) => (state.sync ||= { office: null, doors: {}, tokens: {} });
export const officeOn = (state) => Boolean(state.sync?.office?.key);

/** A new random secret: 32 bytes as base64url (43 characters). */
export function newSecret() {
  return bytesToBase64(crypto.getRandomValues(new Uint8Array(32))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------- the wire

export class SyncError extends Error {}

async function rpc({ url, anon }, fn, args) {
  const headers = { apikey: anon, 'Content-Type': 'application/json' };
  // Legacy anon keys are JWTs and also go in Authorization; new publishable keys don't.
  if (anon.startsWith('eyJ')) headers.Authorization = `Bearer ${anon}`;
  let res;
  try {
    res = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args), cache: 'no-store' });
  } catch {
    throw new SyncError('Could not reach the sync server. Check the connection.');
  }
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = body?.message || body?.error || text || res.statusText;
    if (res.status === 404 && /function|schema cache/i.test(msg)) throw new SyncError('The sync functions are missing. Run walkthru/supabase/schema.sql in the Supabase SQL editor.');
    if (res.status === 401 || /api ?key/i.test(msg)) throw new SyncError('Supabase refused the public key. Check the project URL and key.');
    throw new SyncError(String(msg).replace(/^Walkthru: /, ''));
  }
  return body;
}

const secretOf = (ch) => ch.key || ch.token;

// ---------------------------------------------------------------- setup

/** Check settings and create a new space. Returns the office settings to save. */
export async function createSpace({ url, anon, name }) {
  const clean = cleanSyncUrl(url);
  if (!clean) throw new SyncError('Enter the project URL, like https://abcd.supabase.co');
  if (!isPublicKey(anon)) throw new SyncError('Enter the project\'s public (anon or publishable) key.');
  const key = newSecret();
  await rpc({ url: clean, anon }, 'wt_create_space', { p_key: key, p_name: name || '' });
  return { url: clean, anon, key, meta: emptyMeta() };
}

/** Check settings for an existing space by pulling once. Returns the office settings to save. */
export async function joinSpace({ url, anon, key }) {
  const clean = cleanSyncUrl(url);
  if (!clean) throw new SyncError('Enter the project URL, like https://abcd.supabase.co');
  if (!isPublicKey(anon)) throw new SyncError('Enter the project\'s public (anon or publishable) key.');
  if (!isSecret(key)) throw new SyncError('That sync key is not valid.');
  await rpc({ url: clean, anon }, 'wt_pull', { p_secret: key, p_since: 1e15 });
  return { url: clean, anon, key, meta: emptyMeta() };
}

/** The door code for a unit, registering a new one with the server the first time. */
export async function doorCode(state, unitId) {
  const s = syncOf(state);
  if (s.tokens[unitId]) return s.tokens[unitId];
  const token = newSecret();
  await rpc(s.office, 'wt_add_unit_token', { p_key: s.office.key, p_unit_id: unitId, p_token: token });
  s.tokens[unitId] = token;
  return token;
}

/** Remember a door code read from a QR code, so this phone can send that unit's records. */
export function addDoor(state, unitId, { url, anon, token }) {
  const s = syncOf(state);
  const had = s.doors[unitId];
  if (had?.token === token && had.url === url) return had;
  s.doors[unitId] = { url, anon, token, meta: emptyMeta() };
  return s.doors[unitId];
}

// ---------------------------------------------------------------- one channel

async function ensurePhotos(ch, sub) {
  for (const e of sub.entries || []) {
    const h = e.photo?.hash;
    if (!h || (await hasPhoto(h))) continue;
    const got = await rpc(ch, 'wt_get_photo', { p_secret: secretOf(ch), p_hash: h });
    if (!got) continue; // verification reports it missing
    const bytes = base64ToBytes(got.b64);
    if ((await sha256Hex(bytes)) !== h) continue;
    await putPhoto(h, { type: got.type, blob: new Blob([bytes], { type: got.type }) });
  }
}

async function uploadPhotos(ch, subs) {
  const hashes = [...new Set(subs.flatMap((s) => s.entries.map((e) => e.photo.hash)))];
  if (!hashes.length) return 0;
  let uploaded = 0;
  for (let i = 0; i < hashes.length; i += 500) {
    const missing = (await rpc(ch, 'wt_missing_photos', { p_secret: secretOf(ch), p_hashes: hashes.slice(i, i + 500) })) || [];
    for (const h of missing) {
      const rec = await getPhoto(h);
      if (!rec) continue; // the record is still sent; whoever has the photo can add it
      const bytes = new Uint8Array(await rec.blob.arrayBuffer());
      await rpc(ch, 'wt_put_photo', { p_secret: secretOf(ch), p_hash: h, p_type: rec.type, p_b64: bytesToBase64(bytes) });
      uploaded++;
    }
  }
  return uploaded;
}

/**
 * Pull then push one channel. `unitId` limits a door channel to its unit.
 * Returns { pulled, pushed, photos, rejected, conflicts }.
 */
export async function syncChannel(state, ch, unitId = null) {
  const meta = (ch.meta ||= emptyMeta());
  const summary = { pulled: 0, pushed: 0, photos: 0, rejected: 0, conflicts: 0 };

  // Pull, a page at a time. The cursor only moves once a page is fully applied.
  for (let more = true; more;) {
    const page = await rpc(ch, 'wt_pull', { p_secret: secretOf(ch), p_since: meta.cursor || 0 });
    for (const d of page.docs) {
      if (d.kind === 'submission') {
        await ensurePhotos(ch, d.body);
        const v = await verifySubmission(d.body, getPhotoBytes);
        if (!v.ok) {
          meta.rejected[d.id] = v.problems;
          summary.rejected++;
          continue;
        }
        delete meta.rejected[d.id];
      }
      const r = await applyDoc(state, meta, d);
      if (r === 'conflict') summary.conflicts++;
      if (r !== 'kept') summary.pulled++;
    }
    meta.cursor = page.last;
    more = page.more;
  }

  // Push what changed here, photos first so a record never arrives without them.
  const pending = await pendingDocs(state, { unitId }, meta);
  if (pending.length) {
    summary.photos = await uploadPhotos(ch, pending.filter((d) => d.kind === 'submission').map((d) => d.body));
    for (let i = 0; i < pending.length; i += PUSH_BATCH) {
      const batch = pending.slice(i, i + PUSH_BATCH);
      const res = await rpc(ch, 'wt_push', { p_secret: secretOf(ch), p_docs: batch.map(({ kind, id, body }) => ({ kind, id, body })) });
      // Anything the server skipped (a door code sending a property, an inspection that already
      // exists, an identical sealed record) is the server's to keep; don't resend it every time.
      for (const d of batch) meta.synced[docKey(d.kind, d.id)] = d.hash;
      summary.pushed += res.saved || 0;
      for (const x of res.skipped || []) if (/different sealed record/.test(x.reason)) summary.conflicts++;
    }
  }
  return summary;
}

/** Has a sealed submission reached the server on any channel? */
export function isSent(state, sub) {
  const s = state.sync;
  if (!s || !sub?.seal) return false;
  const channels = [s.office, ...Object.values(s.doors || {})].filter(Boolean);
  return channels.some((ch) => ch.meta?.synced?.[docKey('submission', sub.id)]);
}

// ---------------------------------------------------------------- running it

const listeners = new Set();
export const status = { state: 'off', at: null, error: null, last: null };
export function onStatus(fn) { listeners.add(fn); fn(status); return () => listeners.delete(fn); }
function setStatus(patch) { Object.assign(status, patch); for (const fn of listeners) fn(status); }

let running = null;
let again = false;

/**
 * Sync every channel this device has. Safe to call often: overlapping calls coalesce.
 * Resolves to the combined summary, or null if there is nothing to sync.
 */
export function syncNow(ctx) {
  if (running) { again = true; return running; }
  running = (async () => {
    const s = ctx.state.sync;
    const jobs = [];
    if (s?.office?.key) jobs.push([s.office, null]);
    for (const [unitId, door] of Object.entries(s?.doors || {})) if (!s.office?.key) jobs.push([door, unitId]);
    if (!jobs.length) { setStatus({ state: 'off' }); return null; }
    setStatus({ state: 'syncing', error: null });
    const total = { pulled: 0, pushed: 0, photos: 0, rejected: 0, conflicts: 0 };
    try {
      for (const [ch, unitId] of jobs) {
        const r = await syncChannel(ctx.state, ch, unitId);
        for (const k of Object.keys(total)) total[k] += r[k] || 0;
      }
      await ctx.persist();
      setStatus({ state: 'idle', at: Date.now(), last: total });
      return total;
    } catch (err) {
      await ctx.persist().catch(() => {});
      setStatus({ state: 'error', error: err instanceof SyncError ? err.message : `Sync failed: ${err.message}` });
      if (!(err instanceof SyncError)) console.error(err);
      return null;
    }
  })().finally(() => {
    running = null;
    if (again) { again = false; syncNow(ctx); }
  });
  return running;
}

let timer = 0;
let debounce = 0;

/** Keep syncing while the app is open: now, every 30 s, when the tab comes back, and after edits. */
export function startAutoSync(ctx, onChange) {
  setRemotePhotoSource(async (hash) => {
    const s = ctx.state.sync;
    const channels = [s?.office, ...Object.values(s?.doors || {})].filter((c) => c && (c.key || c.token));
    for (const ch of channels) {
      try {
        const got = await rpc(ch, 'wt_get_photo', { p_secret: secretOf(ch), p_hash: hash });
        if (got) return { type: got.type, bytes: base64ToBytes(got.b64) };
      } catch { /* try the next channel */ }
    }
    return null;
  });
  const run = async () => {
    const r = await syncNow(ctx);
    if (r && (r.pulled || r.rejected)) onChange?.(r);
  };
  clearInterval(timer);
  timer = setInterval(() => { if (document.visibilityState === 'visible') run(); }, AUTO_EVERY_MS);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
  window.addEventListener('online', run);
  run();
  return {
    /** Call after a local change; syncs a moment later so bursts of edits go together. */
    soon() {
      clearTimeout(debounce);
      debounce = setTimeout(run, 1500);
    },
    run,
  };
}

