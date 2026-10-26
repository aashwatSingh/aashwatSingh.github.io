// Browser test for sync: two phones and two office devices sharing records through the local
// Supabase stand-in. Needs Playwright, PGlite and a static server (see browser-smoke.mjs):
//
//   python3 -m http.server 8123                       (from the repository root, in another terminal)
//   node walkthru/tests/sync-browser.mjs
//
// It starts its own stand-in on a free port.

import { createRequire } from 'node:module';
import { startStandin } from './supabase-standin.mjs';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const BASE = process.env.BASE || 'http://127.0.0.1:8123/walkthru/';

const standin = await startStandin(0);
const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const ok = (msg) => console.log(`ok - ${msg}`);
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); ok(msg); };
async function device(tag, phone) {
  const ctx = await browser.newContext(phone
    ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'] }
    : { viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
  return page;
}
const stateOf = (page) => page.evaluate(async () => (await import('./js/store.js')).loadState());
async function syncNowOn(page) {
  await page.goto(`${BASE}#/office/sync`);
  await page.click('#sync-now');
  await page.waitForFunction(() => /Last synced|failed/.test(document.querySelector('#sync-status')?.textContent || ''), null, { timeout: 30000 });
  return page.textContent('#sync-status');
}
async function walk(page) {
  await page.waitForSelector('.area-list li', { state: 'attached', timeout: 15000 });
  const total = await page.$$eval('.area-list li', (l) => l.length);
  for (let i = 0; i < total; i++) {
    if (i) await page.click('#next');
    await page.waitForSelector('#shutter:not([disabled])', { timeout: 15000 });
    await page.click('#shutter');
    await page.waitForSelector('.hash-badge');
  }
  await page.click('#next');
  await page.click('#seal');
  await page.waitForSelector('#send');
  return total;
}

try {
  // ---- office A: a property, a unit with a resident and deposit, then connect sync
  const a = await device('officeA');
  await a.goto(`${BASE}#/office`);
  await a.fill('#add-prop input[name=name]', 'Elm House');
  await a.click('#add-prop button');
  await a.waitForSelector('#add-unit');
  await a.fill('#add-unit input[name=label]', '7');
  await a.selectOption('#add-unit select', '1x1');
  await a.click('#add-unit button');
  await a.waitForSelector('#add-res');
  await a.fill('#add-res input[name=name]', 'Pat Lee');
  await a.fill('#add-res input[name=deposit]', '450');
  await a.click('#add-res button');
  await a.waitForSelector('[data-deposit]');
  const unitUrl = a.url();
  await a.goto(`${BASE}#/office/sync`);
  await a.fill('#connect input[name=url]', standin.url);
  await a.fill('#connect input[name=anon]', standin.anon);
  await a.click('#connect button');
  await a.waitForSelector('#sync-now', { timeout: 30000 });
  check(/Last synced/.test(await a.textContent('#sync-status')), 'office A created a sync space and synced');

  await a.goto(unitUrl);
  await a.click('a[href*="/office/qr/"]');
  await a.waitForSelector('.door-sign');
  check((await a.textContent('main')).includes('Sync on'), 'door sign carries a door code');
  const doorLink = (await a.textContent('.hashline')).trim();

  // ---- phone 1: move-in from the door code, sent to the office automatically
  const p1 = await device('phone1', true);
  await p1.goto(doorLink);
  await p1.waitForSelector('#start', { timeout: 30000 });
  check((await p1.textContent('#start')).includes('Pat Lee'), 'phone got the unit\'s residents from the server');
  await p1.check('input[name=consent]');
  await p1.click('#start .btn.primary');
  const n = await walk(p1);
  await p1.waitForFunction(() => document.querySelector('#sync-box')?.textContent.includes('Sent to the office'), null, { timeout: 30000 });
  ok(`phone sealed ${n} photos and sent them to the office`);
  const p1State = await stateOf(p1);
  const p1Unit = Object.values(p1State.units)[0];
  check(p1Unit.residents.every((r) => !r.depositCents), 'phone never received the deposit');

  // ---- office A: the record arrives and verifies
  const st = await syncNowOn(a);
  check(/1 received|received/.test(st), `office A pulled the record (${st.trim()})`);
  await a.goto(unitUrl);
  await a.waitForSelector('.timeline');
  check(/Pat Lee.*sealed/.test(await a.textContent('.timeline')), 'office A shows Pat\'s sealed move-in');
  const aState = await stateOf(a);
  check(Object.values(aState.units)[0].residents[0].depositCents === 45000, 'office A kept the $450 deposit');

  // ---- phone 2: a fresh phone doing the move-out gets the move-in as its ghost
  const p2 = await device('phone2', true);
  await p2.goto(doorLink);
  await p2.waitForSelector('#start', { timeout: 30000 });
  check(await p2.$eval('input[name=kind]:checked', (e) => e.value) === 'move-out', 'second phone suggests move-out');
  await p2.check('input[name=consent]');
  await p2.click('#start .btn.primary');
  await p2.waitForSelector('.stage .ghost[src]', { timeout: 20000 });
  ok('second phone shows the move-in photo, fetched from the server, as a ghost');

  // ---- office B joins with the connect link; edits flow both ways
  await a.goto(`${BASE}#/office/sync`);
  const connectLink = (await a.textContent('.hashline')).trim();
  const b = await device('officeB');
  await b.goto(connectLink);
  await b.click('#go');
  await b.waitForURL(/#\/office$/, { timeout: 30000 });
  const bState = await stateOf(b);
  const bSub = Object.values(bState.submissions)[0];
  check(bSub && bSub.seal && bSub.entries.length === n, 'office B received the sealed record');
  await b.goto(`${BASE}#/report/${bSub.inspectionId}`);
  await b.waitForFunction((k) => document.querySelectorAll('.thumb img[src]').length >= k, n, { timeout: 30000 });
  ok('office B loads every photo');
  const unitId = Object.keys(bState.units)[0];
  await b.goto(`${BASE}#/office/u/${unitId}`);
  await b.fill('[data-deposit]', '500');
  await b.dispatchEvent('[data-deposit]', 'change');
  await b.waitForTimeout(300);
  await syncNowOn(b);
  await syncNowOn(a);
  check(Object.values((await stateOf(a)).units)[0].residents[0].depositCents === 50000, 'office B\'s deposit change reached office A');

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  await standin.close();
}
