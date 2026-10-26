// The data model and the rules that tie it together. No DOM and no storage: functions take the
// state object and change it in place, or derive answers from it, so they are unit tested.
//
// state = { version, properties: {id: Property}, units: {id: Unit},
//           inspections: {id: Inspection}, submissions: {id: Submission} }
// The shapes are documented in docs/ARCHITECTURE.md.

import { TEMPLATES, checklist, checklistFor, bedroomsOf } from './templates.js';
import { DEFAULT_RATES } from './rates.js';

export const STATE_VERSION = 1;
export const LOCK_HOURS = 48;

export const emptyState = () => ({ version: STATE_VERSION, properties: {}, units: {}, inspections: {}, submissions: {} });

/** A random id like "u_k3j9x2a7q1". */
export function newId(prefix) {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return `${prefix}_${Array.from(bytes, (b) => (b % 36).toString(36)).join('')}`;
}

const byOpened = (a, b) => String(a.openedAt).localeCompare(String(b.openedAt));

// ---------------------------------------------------------------- properties and units

export function addProperty(state, { id = newId('p'), name, city = '', state: st = 'TX', rates = DEFAULT_RATES, demo = false }) {
  const p = { id, name, city, state: st, rates: rates.map((r) => ({ ...r })), demo };
  state.properties[id] = p;
  return p;
}

export function addUnit(state, { id = newId('u'), propertyId, label, template }) {
  if (!TEMPLATES[template]) throw new Error(`Unknown template ${template}`);
  const u = { id, propertyId, label, template, residents: [] };
  state.units[id] = u;
  return u;
}

export const unitsOf = (state, propertyId) =>
  Object.values(state.units).filter((u) => u.propertyId === propertyId)
    .sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));

/**
 * Find or add a resident on a unit. Matches by id, else by name (ignoring case and spaces) and
 * bedroom. Returns the resident.
 */
export function upsertResident(unit, { id, name, bedroom = null, depositCents = 0 }) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
  let r = (id && unit.residents.find((x) => x.id === id))
    || unit.residents.find((x) => norm(x.name) === norm(name) && (x.bedroom || null) === (bedroom || null));
  if (!r) {
    r = { id: id || newId('r'), name: String(name).trim(), bedroom: bedroom || null, depositCents };
    unit.residents.push(r);
  }
  return r;
}

/** Bedrooms on a unit that no resident has claimed yet. */
export function openBedrooms(unit) {
  const taken = new Set(unit.residents.map((r) => r.bedroom).filter(Boolean));
  return bedroomsOf(unit.template).filter((b) => !taken.has(b));
}

// ---------------------------------------------------------------- inspections

/** Open a move-in or move-out walkthrough. The record locks LOCK_HOURS after it opens. */
export function openInspection(state, { id = newId('i'), unitId, kind, now }) {
  const opened = new Date(now);
  const insp = {
    id, unitId, kind,
    openedAt: opened.toISOString(),
    lockAt: new Date(opened.getTime() + LOCK_HOURS * 3600e3).toISOString(),
    surrenderDate: null,
    forwarding: {},
    review: { decisions: {}, finalizedAt: null },
  };
  state.inspections[id] = insp;
  return insp;
}

export const inspectionsOf = (state, unitId) =>
  Object.values(state.inspections).filter((i) => i.unitId === unitId).sort(byOpened);

export const isLocked = (insp, now) => new Date(now).getTime() >= new Date(insp.lockAt).getTime();

export const submissionsOf = (state, inspectionId) =>
  Object.values(state.submissions).filter((s) => s.inspectionId === inspectionId)
    .sort((a, b) => String(a.startedAt).localeCompare(String(b.startedAt)));

export const sealedOf = (state, inspectionId) => submissionsOf(state, inspectionId).filter((s) => s.seal);

/** The inspection a resident would join right now: the latest one of that kind still open. */
export function openInspectionFor(state, unitId, kind, now) {
  const list = inspectionsOf(state, unitId).filter((i) => i.kind === kind && !i.review.finalizedAt && !isLocked(i, now));
  return list[list.length - 1] || null;
}

/**
 * The inspection this one is compared against: the most recent earlier inspection of the same
 * unit with at least one sealed submission. That is how the last move-out becomes the next
 * move-in's baseline, with no pointer to keep in sync.
 */
export function baselineOf(state, insp) {
  const earlier = inspectionsOf(state, insp.unitId).filter((i) => i.id !== insp.id && byOpened(i, insp) < 0);
  for (let k = earlier.length - 1; k >= 0; k--) if (sealedOf(state, earlier[k].id).length) return earlier[k];
  return null;
}

/**
 * 'collecting' (window open, nothing sealed yet), 'ready' (sealed evidence waiting for review),
 * 'locked' (window closed with nothing sealed) or 'finalized'.
 */
export function inspectionStatus(state, insp, now) {
  if (insp.review.finalizedAt) return 'finalized';
  const sealed = sealedOf(state, insp.id).length;
  if (sealed) return 'ready';
  return isLocked(insp, now) ? 'locked' : 'collecting';
}

// ---------------------------------------------------------------- submissions and evidence

export function startSubmission(state, { id = newId('s'), inspection, resident, now }) {
  const s = {
    id, inspectionId: inspection.id, unitId: inspection.unitId, kind: inspection.kind,
    residentId: resident.id, residentName: resident.name, bedroom: resident.bedroom || null,
    startedAt: new Date(now).toISOString(), submittedAt: null, entries: [], head: null, seal: null,
  };
  state.submissions[id] = s;
  return s;
}

/** Add or replace the entry for one item in an unsealed submission. */
export function putEntry(sub, entry) {
  if (sub.seal) throw new Error('This submission is sealed and can no longer change.');
  const i = sub.entries.findIndex((e) => e.key === entry.key);
  if (i >= 0) sub.entries[i] = entry;
  else sub.entries.push(entry);
}

/** The items a submission should cover, and which of them it has. */
export function coverage(unit, sub) {
  const items = checklistFor(unit.template, sub.bedroom);
  const done = new Set(sub.entries.map((e) => e.key));
  return { items, done: items.filter((c) => done.has(c.key)).length, total: items.length, missing: items.filter((c) => !done.has(c.key)) };
}

/**
 * All sealed evidence for an inspection, grouped by item key, oldest capture first:
 * { [key]: [{ entry, submission }] }. Roommates may each have shot shared rooms.
 */
export function evidenceOf(state, inspectionId) {
  const out = {};
  for (const s of sealedOf(state, inspectionId)) {
    for (const e of s.entries) (out[e.key] ||= []).push({ entry: e, submission: s });
  }
  for (const list of Object.values(out)) list.sort((a, b) => a.entry.photo.capturedAt.localeCompare(b.entry.photo.capturedAt));
  return out;
}

/** Every item of the unit's checklist paired with the evidence before (baseline) and after. */
export function comparisonRows(state, insp) {
  const unit = state.units[insp.unitId];
  const base = baselineOf(state, insp);
  const after = evidenceOf(state, insp.id);
  const before = base ? evidenceOf(state, base.id) : {};
  return checklist(unit.template).map((c) => ({
    ...c,
    before: before[c.key]?.[0] || null,
    after: after[c.key]?.[0] || null,
    extra: (after[c.key] || []).slice(1),
  }));
}

/** Approved charges from the review, in checklist order. */
export function approvedCharges(state, insp) {
  const unit = state.units[insp.unitId];
  return checklist(unit.template)
    .map((c) => ({ key: c.key, area: c.area, item: c.item, d: insp.review.decisions[c.key] }))
    .filter((x) => x.d?.action === 'charge')
    .map((x) => ({ key: x.key, label: `${x.area.label}: ${x.d.label}`, cents: x.d.cents, responsible: x.d.responsible || [] }));
}
