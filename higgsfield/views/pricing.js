// Pricing: demo plans, credit top-ups, what things cost, FAQ. No payment is ever taken:
// choosing a plan just calls store.setPlan / store.addCredits.

import { h, segmented, ICON } from '../ui.js';

const ANNUAL_OFF = 0.2;
const TOPUPS = [
  { credits: 100, price: 5 },
  { credits: 300, price: 12, note: 'Save 20%' },
  { credits: 1000, price: 35, note: 'Best value' },
];
const VIDEO_MODELS = [
  { name: 'Lite', rate: 2, note: '720p, single-sample motion' },
  { name: 'Standard', rate: 3, note: '1080p, light motion blur' },
  { name: 'Turbo', rate: 5, note: '1080p, heavy motion blur' },
];
const DURATIONS = [3, 5, 8];
const FAQ = [
  ['Is this the real Higgsfield?', 'No. This is an unofficial study of the Higgsfield interface. It is not affiliated with Higgsfield, and there is no AI model behind it: videos, images and voices are made by procedural code running in your browser.'],
  ['Will I be charged?', 'Never. Checkout here is a demo: no payment is taken and no card is asked for. Choosing a plan only changes the plan stored in this browser and adds that plan’s credits.'],
  ['How do credits work?', 'Each generation spends credits up front. Video costs per second of footage and depends on the model, images cost 1 credit each, and Speak costs 2 credits for every 10 seconds of script.'],
  ['What happens when I run out?', 'The Generate button will tell you, and you can pick a plan or add a top-up pack on this page. Credits never expire.'],
  ['Why do my exports have a watermark?', 'Exports on the Free plan carry a small “higgsfield clone” mark in the corner. Any paid demo plan removes it.'],
  ['Where are my files stored?', 'In this browser only (IndexedDB). Nothing is uploaded. Clearing site data, or using a private window, removes them, so download anything you want to keep.'],
];

const money = (n) => `$${Number.isInteger(n) ? n : n.toFixed(2)}`;
const check = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

export async function mount(root, ctx) {
  const { store } = ctx;
  let billing = 'monthly';

  const balance = h('strong', { class: 'pg-balance-num' });
  const planName = h('span', {});
  const buys = h('p', { class: 'pg-buys' });
  const plansGrid = h('div', { class: 'pg-plans' });

  const toggle = segmented('Billing period', [
    { value: 'monthly', label: 'Monthly' },
    { value: 'annual', label: 'Annual · save 20%' },
  ], billing, (v) => { billing = v; renderPlans(); });
  toggle.classList.add('pg-billing');

  function renderBalance() {
    const c = store.getCredits();
    balance.textContent = c.toLocaleString();
    planName.textContent = `${store.getPlan()?.name ?? 'Free'} plan`;
    const lite5 = Math.floor(c / 10);
    const images = c;
    buys.textContent = c
      ? `Enough for about ${lite5.toLocaleString()} five-second Lite videos, or ${images.toLocaleString()} images.`
      : 'You are out of credits. Pick a plan or add a pack below.';
  }

  function renderPlans() {
    const current = store.getPlan()?.id;
    plansGrid.replaceChildren(...store.PLANS.map((p) => {
      const annual = billing === 'annual' && p.price > 0;
      const monthly = annual ? Math.round(p.price * (1 - ANNUAL_OFF) * 100) / 100 : p.price;
      const isCurrent = p.id === current;
      const btn = h('button', {
        type: 'button',
        class: `btn btn-block ${p.popular && !isCurrent ? 'btn-primary' : ''}`,
        disabled: isCurrent,
        onclick: () => choose(p),
      }, isCurrent ? 'Current plan' : p.price ? `Choose ${p.name}` : 'Switch to Free');
      return h('article', { class: `pg-plan${p.popular ? ' is-popular' : ''}${isCurrent ? ' is-current' : ''}`, 'aria-label': `${p.name} plan` },
        h('div', { class: 'pg-plan-head' },
          h('h3', {}, p.name),
          p.popular ? h('span', { class: 'badge badge-accent' }, 'Most popular') : null,
          isCurrent ? h('span', { class: 'badge pg-current-badge' }, 'Current') : null),
        h('div', { class: 'pg-price' },
          h('span', { class: 'pg-price-num' }, money(monthly)),
          h('span', { class: 'pg-price-per' }, p.price ? '/ month' : 'forever'),
          annual ? h('s', { class: 'pg-price-was' }, money(p.price)) : null),
        h('p', { class: 'pg-price-note' }, annual ? `Billed ${money(Math.round(monthly * 12 * 100) / 100)} yearly` : p.price ? 'Billed monthly, cancel anytime' : 'No card, no catch'),
        h('p', { class: 'pg-plan-credits' }, h('span', { html: ICON.bolt }), `${p.credits.toLocaleString()} credits${p.price ? ' / month' : ''}`),
        h('ul', { class: 'pg-perks' }, p.perks.map((perk) => h('li', {}, h('span', { html: check }), perk))),
        btn);
    }));
  }

  function choose(p) {
    store.setPlan(p.id);
    ctx.toast(`Switched to ${p.name}. ${p.credits.toLocaleString()} credits added. Demo checkout: no payment was taken.`, 'good');
  }

  const topups = h('div', { class: 'pg-topups' }, TOPUPS.map((t) => h('article', { class: 'pg-topup' },
    h('div', { class: 'pg-topup-amt' }, h('span', { html: ICON.bolt }), h('strong', {}, t.credits.toLocaleString()), h('span', {}, 'credits')),
    h('div', { class: 'pg-topup-row' },
      h('span', { class: 'pg-topup-price' }, money(t.price)),
      t.note ? h('span', { class: 'badge' }, t.note) : null),
    h('button', {
      type: 'button', class: 'btn btn-block',
      onclick: () => { store.addCredits(t.credits); ctx.toast(`${t.credits.toLocaleString()} credits added. Demo checkout: no payment was taken.`, 'good'); },
    }, `Add ${t.credits.toLocaleString()} credits`))));

  const costTable = h('div', { class: 'pg-table-wrap' },
    h('table', { class: 'pg-table' },
      h('caption', { class: 'pg-sr' }, 'Credit cost per generation'),
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, 'Tool'), h('th', { scope: 'col' }, 'Option'), h('th', { scope: 'col' }, 'Rate'),
        ...DURATIONS.map((d) => h('th', { scope: 'col', class: 'pg-num' }, `${d}s`)))),
      h('tbody', {},
        VIDEO_MODELS.map((m, i) => h('tr', {},
          i === 0 ? h('th', { scope: 'rowgroup', rowspan: String(VIDEO_MODELS.length) }, h('span', { class: 'pg-tool' }, h('span', { html: ICON.camera }), 'Video')) : null,
          h('td', {}, h('strong', {}, m.name), h('span', { class: 'pg-cell-note' }, m.note)),
          h('td', {}, `${m.rate} / sec`),
          ...DURATIONS.map((d) => h('td', { class: 'pg-num' }, String(m.rate * d))))),
        h('tr', {},
          h('th', { scope: 'row' }, h('span', { class: 'pg-tool' }, h('span', { html: ICON.image }), 'Image')),
          h('td', {}, h('strong', {}, 'Soul'), h('span', { class: 'pg-cell-note' }, 'Batch of 1 to 4')),
          h('td', {}, '1 / image'),
          h('td', { class: 'pg-num', colspan: String(DURATIONS.length) }, '1 to 4 per batch')),
        h('tr', {},
          h('th', { scope: 'row' }, h('span', { class: 'pg-tool' }, h('span', { html: ICON.mic }), 'Speak')),
          h('td', {}, h('strong', {}, 'Avatar'), h('span', { class: 'pg-cell-note' }, 'Rounded up per 10s')),
          h('td', {}, '2 / 10 sec'),
          h('td', { class: 'pg-num', colspan: String(DURATIONS.length) }, '30s script = 6')))));

  const faq = h('div', { class: 'pg-faq' }, FAQ.map(([q, a]) => h('details', {}, h('summary', {}, q), h('p', {}, a))));

  root.append(h('div', { class: 'page pg-pricing' },
    h('div', { class: 'page-head' },
      h('div', {}, h('span', { class: 'eyebrow' }, 'Pricing'), h('h1', {}, 'Plans & credits'),
        h('p', {}, 'Every plan unlocks every camera preset. Paid plans remove the watermark and add more credits each month.')),
      h('div', { class: 'pg-balance', role: 'status', 'aria-live': 'polite' },
        h('span', { class: 'pg-balance-icon', html: ICON.bolt }),
        h('div', {}, h('div', { class: 'pg-balance-line' }, balance, h('span', {}, ' credits')), h('div', { class: 'pg-balance-plan' }, planName)))),
    h('p', { class: 'pg-demo-note' }, h('strong', {}, 'Demo checkout: no payment is taken.'), ' Choosing a plan or pack just updates this browser’s demo balance.'),
    h('div', { class: 'pg-billing-row' }, toggle),
    plansGrid,
    h('section', { class: 'section', 'aria-labelledby': 'pg-topup-title' },
      h('div', { class: 'section-head' }, h('div', {}, h('span', { class: 'eyebrow' }, 'Top up'), h('h2', { id: 'pg-topup-title' }, 'Credit packs'))),
      buys,
      topups),
    h('section', { class: 'section', 'aria-labelledby': 'pg-cost-title' },
      h('div', { class: 'section-head' }, h('div', {}, h('span', { class: 'eyebrow' }, 'Costs'), h('h2', { id: 'pg-cost-title' }, 'What a generation costs'))),
      costTable),
    h('section', { class: 'section', 'aria-labelledby': 'pg-faq-title' },
      h('div', { class: 'section-head' }, h('div', {}, h('span', { class: 'eyebrow' }, 'FAQ'), h('h2', { id: 'pg-faq-title' }, 'Questions'))),
      faq)));

  renderBalance();
  renderPlans();
  const unsub = store.onChange(() => { renderBalance(); renderPlans(); });
  return () => unsub();
}
