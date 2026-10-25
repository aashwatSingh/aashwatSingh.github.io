// The trust layer: SHA-256 fingerprints, a hash chain over a submission's entries, and a seal.
// Uses Web Crypto, which browsers and Node 22 both provide, so all of this is unit tested.
//
// What it proves: a photo whose bytes still hash to the recorded value has not been edited since
// capture, and a submission whose chain and seal recompute has not had entries added, removed,
// reordered or changed since it was sealed. It does not prove a photo was real to begin with.

export const GENESIS = '0'.repeat(64);
const HEX_RE = /^[0-9a-f]{64}$/;

const toHex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');

/** SHA-256 of a string (UTF-8), ArrayBuffer or typed array, as lowercase hex. */
export async function sha256Hex(data) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return toHex(await crypto.subtle.digest('SHA-256', bytes));
}

export const isHash = (s) => typeof s === 'string' && HEX_RE.test(s);

/** A short, readable form of a hash for the UI: "3f9a 0c1e". */
export const shortHash = (h) => (isHash(h) ? `${h.slice(0, 4)} ${h.slice(4, 8)}` : '—');

/**
 * JSON with object keys sorted at every level and `undefined` dropped, so the same data always
 * produces the same bytes and therefore the same hash.
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null';
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonical(v))).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/** The fields of an entry that its hash covers (everything except the chain fields). */
export function entryBody(e) {
  const p = e.photo || {};
  return {
    id: e.id,
    key: e.key,
    condition: e.condition,
    note: e.note || '',
    photo: {
      hash: p.hash, type: p.type, width: p.width, height: p.height,
      capturedAt: p.capturedAt, serverTime: p.serverTime ?? null, source: p.source,
    },
  };
}

export async function entryHash(prev, entry) {
  return sha256Hex(`${prev}\n${canonical(entryBody(entry))}`);
}

/** Link entries into a chain, in capture order. Returns new entry objects with `prev` and `hash`. */
export async function chainEntries(entries) {
  const sorted = [...entries].sort((a, b) => String(a.photo?.capturedAt).localeCompare(String(b.photo?.capturedAt)) || String(a.id).localeCompare(String(b.id)));
  const out = [];
  let prev = GENESIS;
  for (const e of sorted) {
    const hash = await entryHash(prev, e);
    out.push({ ...e, prev, hash });
    prev = hash;
  }
  return { entries: out, head: prev };
}

/** The fields a seal covers: who, what, when, and the chain head that commits to every entry. */
export function sealBody(sub) {
  return {
    id: sub.id,
    inspectionId: sub.inspectionId,
    unitId: sub.unitId,
    kind: sub.kind,
    residentId: sub.residentId,
    residentName: sub.residentName,
    bedroom: sub.bedroom ?? null,
    startedAt: sub.startedAt,
    submittedAt: sub.submittedAt,
    count: sub.entries.length,
    head: sub.head,
  };
}

export async function sealOf(sub) {
  return sha256Hex(canonical(sealBody(sub)));
}

/** Chain a submission's entries and seal it. Returns a new submission object. */
export async function sealSubmission(sub, submittedAt) {
  const { entries, head } = await chainEntries(sub.entries);
  const sealed = { ...sub, entries, head, submittedAt };
  return { ...sealed, seal: await sealOf(sealed) };
}

/**
 * Check a sealed submission. `photoBytes(hash)` may return the stored bytes for a photo (or null
 * when it is missing); pass nothing to skip the photo check. Returns { ok, problems: string[] }.
 */
export async function verifySubmission(sub, photoBytes) {
  const problems = [];
  if (!sub || !Array.isArray(sub.entries)) return { ok: false, problems: ['Not a submission.'] };
  let prev = GENESIS;
  for (const [i, e] of sub.entries.entries()) {
    const where = `Entry ${i + 1} (${e.key || 'unknown item'})`;
    if (e.prev !== prev) problems.push(`${where}: chain link is broken, so an entry was removed, added or reordered.`);
    const expect = await entryHash(e.prev ?? prev, e);
    if (e.hash !== expect) problems.push(`${where}: its details were changed after sealing.`);
    prev = e.hash;
    if (photoBytes && e.photo?.hash) {
      const bytes = await photoBytes(e.photo.hash);
      if (!bytes) problems.push(`${where}: photo is missing.`);
      else if ((await sha256Hex(bytes)) !== e.photo.hash) problems.push(`${where}: photo was altered after capture.`);
    }
  }
  if (sub.head !== prev) problems.push('Chain head does not match the last entry.');
  if (sub.seal !== (await sealOf(sub))) problems.push('Seal does not match, so the submission details were changed.');
  return { ok: problems.length === 0, problems };
}
