// Moving data without a server: the door QR code carries the unit's details in the URL, and a
// finished submission travels to the office as a single "record file" (JSON with the photos
// inside). Both come from outside this browser, so everything read here is validated strictly.

import { TEMPLATES } from './templates.js';
import { isHash } from './integrity.js';

const ID_RE = /^[\w-]{1,40}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
const KINDS = ['move-in', 'move-out'];
const CONDITIONS = ['ok', 'wear', 'damage'];
const SOURCES = ['camera', 'upload', 'demo'];
const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const RECORD_FORMAT = 'walkthru-record';
export const MAX_RECORD_BYTES = 80 * 1024 * 1024;

const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

// ---------------------------------------------------------------- base64

export function bytesToBase64(bytes) {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(s);
}

export function base64ToBytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const toUrl = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromUrl = (s) => s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);

// ---------------------------------------------------------------- door QR payload

/**
 * Encode a unit's door details for the QR code URL. With `inspection`, the link also names one
 * open walkthrough, so roommates scanning on different phones all join the same one.
 */
export function encodeDoor({ property, unit, inspection = null }) {
  const data = { v: 1, pid: property.id, pn: property.name, pc: property.city || '', st: property.state || 'TX', uid: unit.id, ul: unit.label, t: unit.template };
  if (inspection) Object.assign(data, { iid: inspection.id, ik: inspection.kind, io: inspection.openedAt, il: inspection.lockAt });
  return toUrl(bytesToBase64(new TextEncoder().encode(JSON.stringify(data))));
}

/**
 * Decode a door payload. Returns { property, unit, inspection } (inspection may be null), or
 * null if it is not a valid payload.
 */
export function decodeDoor(s) {
  if (typeof s !== 'string' || s.length > 2000 || !/^[\w-]+$/.test(s)) return null;
  let d;
  try {
    d = JSON.parse(new TextDecoder().decode(base64ToBytes(fromUrl(s))));
  } catch {
    return null;
  }
  if (!d || d.v !== 1 || !ID_RE.test(d.pid) || !ID_RE.test(d.uid) || !TEMPLATES[d.t]) return null;
  const pn = text(d.pn, 80);
  const ul = text(d.ul, 20);
  if (!pn || !ul) return null;
  const inspection = ID_RE.test(d.iid) && KINDS.includes(d.ik) && ISO_RE.test(d.io) && ISO_RE.test(d.il)
    ? { id: d.iid, unitId: d.uid, kind: d.ik, openedAt: d.io, lockAt: d.il }
    : null;
  return {
    property: { id: d.pid, name: pn, city: text(d.pc, 60), state: /^[A-Z]{2}$/.test(d.st) ? d.st : 'TX' },
    unit: { id: d.uid, propertyId: d.pid, label: ul, template: d.t },
    inspection,
  };
}

// ---------------------------------------------------------------- record file

/**
 * Build the record file for one sealed submission. `photos` maps hash → { type, bytes }.
 * Returns a plain object ready for JSON.stringify.
 */
export function buildRecord({ property, unit, inspection, submission, photos, exportedAt }) {
  const pics = {};
  for (const e of submission.entries) {
    const p = photos[e.photo.hash];
    if (p) pics[e.photo.hash] = `data:${p.type};base64,${bytesToBase64(p.bytes)}`;
  }
  return {
    format: RECORD_FORMAT,
    version: 1,
    exportedAt,
    property: { id: property.id, name: property.name, city: property.city || '', state: property.state || 'TX' },
    unit: { id: unit.id, label: unit.label, template: unit.template },
    inspection: { id: inspection.id, kind: inspection.kind, openedAt: inspection.openedAt, lockAt: inspection.lockAt },
    submission,
    photos: pics,
  };
}

function cleanEntry(e) {
  if (!e || !ID_RE.test(e.id) || typeof e.key !== 'string' || !/^[\w-]{1,40}\.[\w-]{1,40}$/.test(e.key)) return null;
  if (!CONDITIONS.includes(e.condition) || !isHash(e.prev) || !isHash(e.hash)) return null;
  const p = e.photo;
  if (!p || !isHash(p.hash) || !PHOTO_TYPES.includes(p.type) || !SOURCES.includes(p.source) || !ISO_RE.test(p.capturedAt)) return null;
  if (p.serverTime != null && !ISO_RE.test(p.serverTime)) return null;
  const width = Math.round(Number(p.width));
  const height = Math.round(Number(p.height));
  if (!(width > 0 && width <= 10000 && height > 0 && height <= 10000)) return null;
  // Keep the exact strings: they are covered by the entry hash, so trimming them would break it.
  if (typeof e.note !== 'string' || e.note.length > 500) return null;
  return {
    id: e.id, key: e.key, condition: e.condition, note: e.note, prev: e.prev, hash: e.hash,
    photo: { hash: p.hash, type: p.type, width, height, capturedAt: p.capturedAt, serverTime: p.serverTime ?? null, source: p.source },
  };
}

/**
 * Validate a parsed record file. Returns { ok: true, record } with photo bytes decoded, or
 * { ok: false, error }. It checks shape only; call verifySubmission() to check the seal.
 */
export function readRecord(raw) {
  const fail = (error) => ({ ok: false, error });
  if (!raw || raw.format !== RECORD_FORMAT || raw.version !== 1) return fail('This is not a Walkthru record file.');
  const pr = raw.property;
  const un = raw.unit;
  const ins = raw.inspection;
  const s = raw.submission;
  if (!pr || !ID_RE.test(pr.id) || !text(pr.name, 80)) return fail('The property details are missing.');
  if (!un || !ID_RE.test(un.id) || !text(un.label, 20) || !TEMPLATES[un.template]) return fail('The unit details are missing.');
  if (!ins || !ID_RE.test(ins.id) || !KINDS.includes(ins.kind) || !ISO_RE.test(ins.openedAt) || !ISO_RE.test(ins.lockAt)) return fail('The inspection details are missing.');
  if (!s || !ID_RE.test(s.id) || s.inspectionId !== ins.id || s.unitId !== un.id || s.kind !== ins.kind) return fail('The submission does not belong to this inspection.');
  if (!ID_RE.test(s.residentId) || typeof s.residentName !== 'string' || !s.residentName.trim() || s.residentName.length > 60) return fail('The resident is missing.');
  if (s.bedroom != null && !/^[A-D]$/.test(s.bedroom)) return fail('The bedroom is not valid.');
  if (!ISO_RE.test(s.startedAt) || !ISO_RE.test(s.submittedAt) || !isHash(s.head) || !isHash(s.seal)) return fail('The submission is not sealed.');
  if (!Array.isArray(s.entries) || s.entries.length > 400) return fail('The submission has no entries.');
  const entries = s.entries.map(cleanEntry);
  if (entries.some((e) => !e)) return fail('One of the entries is malformed.');

  const photos = {};
  const pics = raw.photos && typeof raw.photos === 'object' ? raw.photos : {};
  for (const e of entries) {
    const url = pics[e.photo.hash];
    if (typeof url !== 'string') continue; // reported as missing by verification
    const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+=*)$/.exec(url);
    if (!m) return fail('A photo in the file is not a supported image.');
    try {
      photos[e.photo.hash] = { type: m[1], bytes: base64ToBytes(m[2]) };
    } catch {
      return fail('A photo in the file could not be read.');
    }
  }
  return {
    ok: true,
    record: {
      property: { id: pr.id, name: text(pr.name, 80), city: text(pr.city, 60), state: /^[A-Z]{2}$/.test(pr.state) ? pr.state : 'TX' },
      unit: { id: un.id, label: text(un.label, 20), template: un.template },
      inspection: { id: ins.id, kind: ins.kind, openedAt: ins.openedAt, lockAt: ins.lockAt },
      submission: {
        id: s.id, inspectionId: s.inspectionId, unitId: s.unitId, kind: s.kind, residentId: s.residentId,
        residentName: s.residentName, bedroom: s.bedroom ?? null, startedAt: s.startedAt, submittedAt: s.submittedAt,
        head: s.head, seal: s.seal, entries,
      },
      photos,
    },
  };
}
