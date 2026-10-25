// Pieces shared by several screens.

import { html, STATUS_LABEL, KIND_LABEL } from '../ui.js';
import { inspectionsOf, inspectionStatus } from '../core/model.js';

export function notFound(main, what = 'page') {
  main.innerHTML = String(html`<h1>Not found</h1><p>That ${what} isn't in this browser. Records live only where they were made or imported.</p><p><a class="btn" href="#/">Go home</a></p>`);
}

export const statusChip = (status) => html`<span class="chip ${status}">${STATUS_LABEL[status] || status}</span>`;

/** The latest inspection of a unit and its status, or null. */
export function latestOf(state, unit, now) {
  const list = inspectionsOf(state, unit.id);
  const insp = list[list.length - 1];
  return insp ? { insp, status: inspectionStatus(state, insp, now) } : null;
}

export const kindLabel = (k) => KIND_LABEL[k] || k;

export function callout(kind, title, body) {
  return html`<div class="callout ${kind}"><b>${title}</b><div>${body}</div></div>`;
}

/** Breadcrumbs: [[label, href], ...]. */
export const crumbs = (items) => html`<nav class="crumbs no-print" aria-label="Breadcrumb">${items.map(([label, href], i) => html`${i ? html`<span aria-hidden="true">›</span>` : ''}<a href="${href}">${label}</a>`)}</nav>`;
