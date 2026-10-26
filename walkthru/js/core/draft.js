// The auto-draft: turns "what the photos and the resident say" into a suggested line on the
// condition report. In production a vision model would do this; in the prototype it combines the
// pixel comparison from diff.js with the resident's own condition mark. Staff confirm every line.

import { rateById } from './rates.js';

// A region covering this share of the photo, or one this far out of line, counts as major damage.
// Contrast alone is a weak sign of severity (a dark scuff on a pale wall is high contrast), so the
// strength bar is high and size does most of the work.
const MAJOR_STRENGTH = 3;
const MAJOR_AREA = 0.06;

const regionArea = (diff) => (diff?.regions || []).reduce((s, r) => s + r.w * r.h, 0);

/**
 * Draft one checklist item.
 *   item      the template item ({ label, rates })
 *   before    the baseline entry or null ({ condition })
 *   after     the new entry or null ({ condition, note })
 *   diff      compare() result for the two photos, or null when there is nothing to compare
 *   rates     the property's rate sheet
 * Returns { status, flagged, severity, confidence, why: string[], suggestion }
 * where status is 'missing' | 'no-baseline' | 'unchanged' | 'changed' and suggestion is
 * { kind: 'charge', rateId, label, cents } | { kind: 'wear' } | { kind: 'none' }.
 */
export function draftItem({ item, before, after, diff, rates }) {
  const why = [];
  if (!after) return { status: 'missing', flagged: false, severity: null, confidence: null, why: ['No new photo for this item.'], suggestion: { kind: 'none' } };

  const marked = after.condition; // 'ok' | 'wear' | 'damage'
  const wasDamaged = before?.condition === 'damage';
  const photoChanged = Boolean(diff?.changed);

  if (!before || !diff) {
    // Nothing to compare against: report what the resident said, flag damage for a look.
    if (marked === 'damage') why.push('Resident marked damage. No baseline photo to compare.');
    else why.push('No baseline photo to compare.');
    return {
      status: 'no-baseline',
      flagged: marked === 'damage',
      severity: null,
      confidence: marked === 'damage' ? 'low' : null,
      why,
      suggestion: { kind: 'none' },
    };
  }

  if (photoChanged) why.push(`Photo differs from the baseline in ${diff.regions.length} ${diff.regions.length === 1 ? 'spot' : 'spots'}.`);
  if (marked === 'damage') why.push('Resident marked damage.');
  if (marked === 'wear') why.push('Resident marked wear.');
  if (after.note) why.push(`Note: “${after.note}”`);

  if (!photoChanged && marked === 'ok') {
    return { status: 'unchanged', flagged: false, severity: null, confidence: 'high', why: ['Matches the baseline photo.'], suggestion: { kind: 'none' } };
  }
  if (!photoChanged && wasDamaged) {
    why.push('The baseline already showed damage here, so it is not new.');
    return { status: 'unchanged', flagged: false, severity: null, confidence: 'medium', why, suggestion: { kind: 'none' } };
  }

  const major = photoChanged && (diff.score >= MAJOR_STRENGTH || regionArea(diff) >= MAJOR_AREA);
  const severity = photoChanged ? (major ? 'major' : 'minor') : 'minor';

  // Wear the resident reported, with at most a faint photo change, is normal wear and tear.
  if (marked === 'wear' && !major) {
    why.push('Looks like normal wear and tear, which cannot be charged (Tex. Prop. Code §92.104(b)).');
    return { status: 'changed', flagged: true, severity, confidence: photoChanged ? 'medium' : 'low', why, suggestion: { kind: 'wear' } };
  }

  const ids = item.rates || [];
  const rateId = (major && ids[1]) || ids[0];
  const rate = rateId ? rateById(rates, rateId) : null;
  const confidence = photoChanged && marked === 'damage' ? 'high' : photoChanged ? 'medium' : 'low';
  return {
    status: 'changed',
    flagged: true,
    severity,
    confidence,
    why,
    suggestion: rate ? { kind: 'charge', rateId: rate.id, label: rate.label, cents: rate.cents } : { kind: 'none' },
  };
}
