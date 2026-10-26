// The internship hunt: stages, stats and the next steps that feed Top priorities.

import { daysBetween, keyOf, stamp } from './dates.js';

export const STAGES = [
  { id: 'wishlist', label: 'Wishlist' },
  { id: 'applied', label: 'Applied' },
  { id: 'oa', label: 'Online assessment' },
  { id: 'interview', label: 'Interviewing' },
  { id: 'offer', label: 'Offer' },
  { id: 'closed', label: 'Closed' },
];
export const STAGE_IDS = STAGES.map((s) => s.id);
export const OUTCOMES = [
  { id: 'rejected', label: 'Rejected' },
  { id: 'withdrew', label: 'Withdrew' },
  { id: 'ghosted', label: 'No response' },
];

// Days an application can sit in Applied before HQ suggests a follow-up.
export const QUIET_DAYS = 14;

const KIND = { wishlist: 'application', applied: 'followup', oa: 'oa', interview: 'interview', offer: 'offer' };

/** What to do next at each stage, when you haven't written your own next step. */
export function defaultNext(app) {
  const c = app.company || 'this company';
  return {
    wishlist: `Apply to ${c}`, applied: `Follow up with ${c}`, oa: `Finish the ${c} online assessment`,
    interview: `Prep for the ${c} interview`, offer: `Decide on the ${c} offer`, closed: '',
  }[app.stage] || '';
}

/** Move an application to a stage, recording when. Moving past Wishlist fills in the applied date. */
export function setStage(app, stage, nowMs = Date.now()) {
  if (!STAGE_IDS.includes(stage) || stage === app.stage) return app;
  const at = new Date(nowMs).toISOString();
  const next = { ...app, stage, history: [...(app.history || []), { stage, at }], updated: at };
  if (!next.applied && stage !== 'wishlist' && !(stage === 'closed' && app.stage === 'wishlist')) next.applied = keyOf(nowMs);
  if (stage !== 'closed') next.outcome = '';
  return next;
}

/** When the application entered its current stage (ISO). */
export function stageSince(app) {
  const h = (app.history || []).filter((x) => x.stage === app.stage);
  return h.length ? h[h.length - 1].at : app.created;
}

const reached = (app, stage) => app.stage === stage || (app.history || []).some((h) => h.stage === stage);

export function pipelineStats(apps, today) {
  const applied = apps.filter((a) => a.applied);
  const responded = applied.filter((a) => reached(a, 'oa') || reached(a, 'interview') || reached(a, 'offer')
    || (a.stage === 'closed' && a.outcome === 'rejected'));
  const byStage = Object.fromEntries(STAGE_IDS.map((s) => [s, apps.filter((a) => a.stage === s).length]));
  return {
    total: apps.length,
    applied: applied.length,
    thisWeek: applied.filter((a) => { const d = daysBetween(a.applied, today); return d >= 0 && d < 7; }).length,
    responded: responded.length,
    responseRate: applied.length ? responded.length / applied.length : null,
    interviews: apps.filter((a) => reached(a, 'interview')).length,
    offers: apps.filter((a) => reached(a, 'offer')).length,
    active: apps.filter((a) => a.stage !== 'closed' && a.stage !== 'wishlist').length,
    byStage,
  };
}

/** Applications sitting in Applied for QUIET_DAYS or more. */
export function quietApps(apps, today) {
  return apps.filter((a) => a.stage === 'applied' && !a.nextDue && a.applied && daysBetween(a.applied, today) >= QUIET_DAYS
    && daysBetween(keyOf(stageSince(a)) || today, today) >= QUIET_DAYS);
}

/**
 * Next steps as priority items: anything with a deadline, every OA, interview and offer, and one
 * grouped follow-up for quiet applications (so ten old applications don't flood the list).
 */
export function pipelineItems(apps, today) {
  const items = [];
  for (const a of apps) {
    if (a.stage === 'closed') continue;
    const due = a.nextDue ? stamp(a.nextDue, a.nextTime) : null;
    if (due == null && !['oa', 'interview', 'offer'].includes(a.stage)) continue;
    items.push({
      key: `i:${a.id}`, src: 'intern', kind: KIND[a.stage], title: a.next || defaultNext(a),
      sub: [a.company, a.role].filter(Boolean).join(' · '), url: a.url, due, undatedUrgency: 0.5, appId: a.id,
    });
  }
  const quiet = quietApps(apps, today);
  if (quiet.length) {
    items.push({
      key: 'i:followups', src: 'intern', kind: 'followup',
      title: quiet.length === 1 ? `Follow up with ${quiet[0].company}` : `Follow up on ${quiet.length} quiet applications`,
      sub: quiet.slice(0, 3).map((a) => a.company).join(', ') + (quiet.length > 3 ? '…' : ''),
      due: null, undatedUrgency: 0.35, note: `${QUIET_DAYS}+ days without a reply`,
    });
  }
  return items;
}
