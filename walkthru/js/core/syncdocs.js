// What syncs and how two copies of a document are reconciled. Pure functions over the state object,
// so the rules are unit tested; js/sync.js does the network side.
//
// Documents are properties, units, inspections and sealed submissions. Drafts stay on the device
// until sealed, and the demo property never syncs (every device builds its own).
//
// Each sync channel remembers the hash of every document as it last agreed with the server
// (`meta.synced`). A document whose hash differs has changed here and is pushed. A pulled document
// replaces the local copy if the local copy hasn't changed since; otherwise the two are merged.

import { canonical, sha256Hex } from './integrity.js';
import { upsertResident } from './model.js';

export const KINDS = ['property', 'unit', 'inspection', 'submission'];
const COLLECTION = { property: 'properties', unit: 'units', inspection: 'inspections', submission: 'submissions' };

export const docKey = (kind, id) => `${kind}:${id}`;
export const docHash = (body) => sha256Hex(canonical(body));
export const emptyMeta = () => ({ cursor: 0, synced: {}, rejected: {} });

function isDemoProperty(state, propertyId) {
  return Boolean(state.properties[propertyId]?.demo);
}

/**
 * The documents a channel is responsible for, as [{ kind, id, body }].
 * channel.unitId set: only that unit's inspections and sealed submissions (a door code's rights).
 */
export function channelDocs(state, channel) {
  const out = [];
  const unitOk = (unitId) => {
    const u = state.units[unitId];
    return u && !isDemoProperty(state, u.propertyId) && (!channel.unitId || unitId === channel.unitId);
  };
  if (!channel.unitId) {
    for (const p of Object.values(state.properties)) if (!p.demo) out.push({ kind: 'property', id: p.id, body: p });
    for (const u of Object.values(state.units)) if (unitOk(u.id)) out.push({ kind: 'unit', id: u.id, body: u });
  }
  for (const i of Object.values(state.inspections)) if (unitOk(i.unitId)) out.push({ kind: 'inspection', id: i.id, body: i });
  for (const s of Object.values(state.submissions)) if (s.seal && unitOk(s.unitId)) out.push({ kind: 'submission', id: s.id, body: s });
  return out;
}

/** Documents changed here since the channel last synced. */
export async function pendingDocs(state, channel, meta) {
  const out = [];
  for (const d of channelDocs(state, channel)) {
    const h = await docHash(d.body);
    if (meta.synced[docKey(d.kind, d.id)] !== h) out.push({ ...d, hash: h });
  }
  return out;
}

// ---------------------------------------------------------------- merging

function mergeResidents(local = [], remote = []) {
  const byId = new Map(remote.map((r) => [r.id, r]));
  for (const r of local) {
    if (!byId.has(r.id)) byId.set(r.id, r);
    // A door code sees deposits as 0; never let that wipe a deposit set here.
    else if (!byId.get(r.id).depositCents && r.depositCents) byId.set(r.id, { ...byId.get(r.id), depositCents: r.depositCents });
  }
  return [...byId.values()];
}

function mergeDecisions(local = {}, remote = {}) {
  const out = { ...local };
  for (const [key, d] of Object.entries(remote)) {
    const mine = out[key];
    if (!mine || String(d.decidedAt || '') >= String(mine.decidedAt || '')) out[key] = d;
  }
  return out;
}

/**
 * Reconcile a document changed both here and on the server. Collections are unioned (residents,
 * staff decisions, forwarding addresses); single fields take the server's value, which is the
 * newer write. Sealed submissions never merge: a different seal is a conflict and the local copy
 * stays. Returns { body, conflict }.
 */
export function mergeDoc(kind, local, remote) {
  if (kind === 'submission') {
    return local.seal && local.seal !== remote.seal ? { body: local, conflict: true } : { body: remote, conflict: false };
  }
  if (kind === 'unit') return { body: { ...remote, residents: mergeResidents(local.residents, remote.residents) }, conflict: false };
  if (kind === 'inspection') {
    const lr = local.review || {};
    const rr = remote.review || {};
    return {
      body: {
        ...remote,
        surrenderDate: remote.surrenderDate ?? local.surrenderDate ?? null,
        forwarding: { ...(local.forwarding || {}), ...(remote.forwarding || {}) },
        review: { decisions: mergeDecisions(lr.decisions, rr.decisions), finalizedAt: rr.finalizedAt ?? lr.finalizedAt ?? null },
      },
      conflict: false,
    };
  }
  return { body: remote, conflict: false };
}

/**
 * Make `target` equal to `source` without replacing the object, so screens that hold a reference to
 * it (an open review, a unit page) keep writing to the live record.
 */
function replaceInPlace(target, source) {
  const copy = structuredClone(source);
  for (const k of Object.keys(target)) if (!(k in copy)) delete target[k];
  Object.assign(target, copy);
}

/**
 * Apply one pulled document. Returns 'added' | 'replaced' | 'merged' | 'kept' | 'conflict'.
 * Sealed submissions must be verified by the caller first.
 */
export async function applyDoc(state, meta, { kind, id, body }) {
  const coll = state[COLLECTION[kind]];
  const key = docKey(kind, id);
  const remoteHash = await docHash(body);
  const local = coll[id];
  let result;
  if (!local) {
    coll[id] = structuredClone(body);
    result = 'added';
  } else {
    const localHash = await docHash(local);
    if (localHash === remoteHash) result = 'kept';
    else if (localHash === meta.synced[key]) {
      replaceInPlace(local, body);
      result = 'replaced';
    } else {
      const m = mergeDoc(kind, local, body);
      if (m.body !== local) replaceInPlace(local, m.body);
      result = m.conflict ? 'conflict' : 'merged';
    }
  }
  meta.synced[key] = remoteHash;
  // A submission brings its resident with it, so the office learns who walked the unit.
  if (kind === 'submission' && result !== 'conflict') {
    const unit = state.units[body.unitId];
    if (unit) upsertResident(unit, { id: body.residentId, name: String(body.residentName).trim(), bedroom: body.bedroom });
  }
  return result;
}
