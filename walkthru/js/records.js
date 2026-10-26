// Moving a sealed submission between browsers as a record file, and checking records.

import { buildRecord, readRecord, MAX_RECORD_BYTES } from './core/payload.js';
import { verifySubmission } from './core/integrity.js';
import { addProperty, addUnit, openInspection, upsertResident } from './core/model.js';
import { getPhoto, getPhotoBytes, putPhoto } from './store.js';
import { download, slug } from './ui.js';

/** Build the record file for a sealed submission. Returns { blob, filename }. */
export async function exportSubmission(state, sid) {
  const sub = state.submissions[sid];
  if (!sub?.seal) throw new Error('Only a sealed submission can be sent.');
  const insp = state.inspections[sub.inspectionId];
  const unit = state.units[sub.unitId];
  const property = state.properties[unit.propertyId];
  const photos = {};
  for (const e of sub.entries) {
    const rec = await getPhoto(e.photo.hash);
    if (rec) photos[e.photo.hash] = { type: rec.type, bytes: new Uint8Array(await rec.blob.arrayBuffer()) };
  }
  const record = buildRecord({ property, unit, inspection: insp, submission: sub, photos, exportedAt: new Date().toISOString() });
  const filename = `walkthru-${slug(`${property.name} ${unit.label} ${insp.kind} ${sub.residentName}`)}.json`;
  return { blob: new Blob([JSON.stringify(record)], { type: 'application/json' }), filename };
}

/**
 * Hand a file to the phone's share sheet (mail, messages, AirDrop) when it can take files,
 * otherwise download it. Resolves to 'shared', 'downloaded' or 'cancelled'.
 */
export async function shareOrDownload(blob, filename, title) {
  const file = new File([blob], filename, { type: blob.type });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title, text: 'Sealed Walkthru record. Open it in Walkthru: Office → unit → Import record.' });
      return 'shared';
    } catch (err) {
      if (err?.name === 'AbortError') return 'cancelled';
    }
  }
  download(blob, filename);
  return 'downloaded';
}

/** Read and check a record file without importing it. Returns { ok, record?, error?, problems? }. */
export async function checkRecordFile(file) {
  if (file.size > MAX_RECORD_BYTES) return { ok: false, error: 'That file is too large to be a Walkthru record.' };
  let raw;
  try {
    raw = JSON.parse(await file.text());
  } catch {
    return { ok: false, error: 'That file is not a Walkthru record (it is not JSON).' };
  }
  const parsed = readRecord(raw);
  if (!parsed.ok) return parsed;
  const { record } = parsed;
  const v = await verifySubmission(record.submission, async (h) => record.photos[h]?.bytes || null);
  return { ok: v.ok, record, problems: v.problems, error: v.ok ? null : 'The record does not verify.' };
}

/**
 * Import a checked record into this browser. Refuses records that don't verify, units whose
 * layout differs, and a different submission under an existing id.
 * Returns { ok, message, inspectionId? }.
 */
export async function importRecord(state, record) {
  const { property, unit, inspection, submission, photos } = record;
  const have = state.submissions[submission.id];
  if (have) {
    return have.seal === submission.seal
      ? { ok: true, message: 'This record was already imported.', inspectionId: submission.inspectionId }
      : { ok: false, message: 'A different record with the same id is already here. Nothing was imported.' };
  }
  const existingUnit = state.units[unit.id];
  if (existingUnit && existingUnit.template !== unit.template) {
    return { ok: false, message: 'This unit exists here with a different layout. Nothing was imported.' };
  }
  const existingInsp = state.inspections[inspection.id];
  if (existingInsp && (existingInsp.unitId !== unit.id || existingInsp.kind !== inspection.kind)) {
    return { ok: false, message: 'The inspection in this file does not match the one here. Nothing was imported.' };
  }

  for (const [hash, p] of Object.entries(photos)) await putPhoto(hash, { type: p.type, blob: new Blob([p.bytes], { type: p.type }) });
  if (!state.properties[property.id]) addProperty(state, { id: property.id, name: property.name, city: property.city, state: property.state });
  const u = existingUnit || addUnit(state, { id: unit.id, propertyId: property.id, label: unit.label, template: unit.template });
  if (!existingInsp) {
    const i = openInspection(state, { id: inspection.id, unitId: unit.id, kind: inspection.kind, now: Date.parse(inspection.openedAt) });
    i.lockAt = inspection.lockAt;
  }
  upsertResident(u, { id: submission.residentId, name: submission.residentName.trim(), bedroom: submission.bedroom });
  state.submissions[submission.id] = submission;
  return { ok: true, message: `Imported ${submission.residentName.trim()}'s ${inspection.kind} record for unit ${unit.label}.`, inspectionId: inspection.id };
}

/** Verify every sealed submission stored in this browser, photos included. */
export async function verifyAll(state) {
  const out = [];
  for (const sub of Object.values(state.submissions)) {
    if (!sub.seal) continue;
    out.push({ sub, result: await verifySubmission(sub, getPhotoBytes) });
  }
  return out.sort((a, b) => String(b.sub.submittedAt).localeCompare(String(a.sub.submittedAt)));
}
