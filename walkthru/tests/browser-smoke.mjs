// Browser smoke test for the Walkthru prototype. Not part of `node --test`: it needs Playwright and
// a local server.
//
//   python3 -m http.server 8123            (from the repository root, in another terminal)
//   npm install --no-save playwright && npx playwright install chromium   (once)
//   node walkthru/tests/browser-smoke.mjs
//
// Set BASE to test another address, or PLAYWRIGHT_MODULE to a Playwright install elsewhere.
// It checks the roadmap gate (all five planted changes flagged, nothing else), then walks the
// resident and office flows on a phone and a desktop with a simulated camera.

import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const BASE = process.env.BASE || 'http://127.0.0.1:8123/walkthru/';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthru-'));

const browser = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errors = [];
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`${tag}: ${m.text()}`); });
};
const ok = (msg) => console.log(`ok - ${msg}`);
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); ok(msg); };

try {
  // ---- the gate: compare every demo move-out photo with its move-in photo
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  const d = await desk.newPage();
  watch(d, 'desktop');
  await d.goto(`${BASE}#/demo?then=review`);
  await d.waitForSelector('.review-item', { timeout: 60000 });
  const gate = await d.evaluate(async () => {
    const store = await import('./js/store.js');
    const model = await import('./js/core/model.js');
    const img = await import('./js/imaging.js');
    const demo = await import('./js/demo.js');
    const st = await store.loadState();
    const rows = model.comparisonRows(st, st.inspections.i_demo204_out);
    const out = [];
    for (const r of rows) {
      const diff = await img.diffPhotos(r.before.entry.photo.hash, r.after.entry.photo.hash);
      out.push({ key: r.key, changed: diff.changed, planted: Boolean(demo.PLANTED.u_demo204[r.key]) });
    }
    return out;
  });
  const planted = gate.filter((r) => r.planted);
  check(planted.length === 5 && planted.every((r) => r.changed), 'gate: all five planted changes flagged');
  const falseFlags = gate.filter((r) => !r.planted && r.changed).map((r) => r.key);
  check(falseFlags.length === 0, `gate: no unchanged item flagged (${gate.length} pairs)${falseFlags.length ? ` got ${falseFlags}` : ''}`);

  // ---- resident on a phone: move-out of unit 310 with the camera and ghost overlay
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, permissions: ['camera'], acceptDownloads: true });
  const p = await phone.newPage();
  watch(p, 'phone');
  await p.goto(`${BASE}#/demo?then=resident`);
  await p.waitForSelector('#start', { timeout: 60000 });
  check(await p.$eval('input[name=kind]:checked', (e) => e.value) === 'move-out', 'start page suggests move-out');
  await p.check('input[name=consent]');
  await p.click('#start .btn.primary');
  await p.waitForSelector('#shutter:not([disabled])', { timeout: 15000 });
  check(Boolean(await p.$('.stage .ghost')), 'ghost of the move-in photo over the live camera');
  await p.click('#shutter');
  await p.waitForSelector('.hash-badge');
  ok('shutter photo fingerprinted');
  const total = await p.$$eval('.area-list li', (l) => l.length);
  for (let i = 1; i < total; i++) {
    await p.click('#next');
    await p.click('#demo-shot');
    await p.waitForSelector('.hash-badge');
  }
  await p.click('#next');
  await p.click('#seal');
  await p.click('#verify');
  await p.waitForSelector('#verify-out .callout');
  check((await p.textContent('#verify-out')).includes('Verified'), `sealed ${total} items and verified on the phone`);
  const [dl] = await Promise.all([p.waitForEvent('download'), p.click('#send')]);
  const recPath = path.join(tmp, 'record.json');
  await dl.saveAs(recPath);

  // ---- office in a fresh browser: verify and import the record; an edited copy is refused
  const o = await (await browser.newContext()).newPage();
  watch(o, 'office');
  await o.goto(`${BASE}#/verify`);
  await o.setInputFiles('#rec-file', recPath);
  await o.waitForSelector('#rec-out .callout');
  check((await o.textContent('#rec-out')).includes('Verified'), 'record file verifies in another browser');
  await o.click('#do-import');
  await o.waitForSelector('.timeline');
  ok('record imported');
  const edited = JSON.parse(fs.readFileSync(recPath, 'utf8'));
  edited.submission.entries[0].note += ' (edited)';
  fs.writeFileSync(path.join(tmp, 'edited.json'), JSON.stringify(edited));
  await o.goto(`${BASE}#/verify`);
  await o.setInputFiles('#rec-file', path.join(tmp, 'edited.json'));
  await o.waitForSelector('#rec-out .callout');
  check((await o.textContent('#rec-out')).includes('Does not verify'), 'edited record file refused');

  // ---- desktop: review, settle, tamper demo
  await d.goto(`${BASE}#/office/review/i_demo204_out`);
  await d.waitForSelector('#accept-all');
  await d.click('#accept-all');
  await d.waitForSelector('.decision.charged');
  await d.click('a.btn.primary[href*="settle"]');
  await d.waitForSelector('#finalize');
  const foot = (await d.$eval('tfoot', (t) => t.innerText)).replace(/\s+/g, ' ');
  check(/\$1,000\.00 \$360\.00 \$640\.00/.test(foot), `settlement adds up (${foot.trim()})`);
  await d.click('#finalize');
  await d.waitForSelector('#reopen');
  await d.goto(`${BASE}#/verify`);
  await d.click('#tamper');
  await d.waitForFunction(() => document.querySelector('#all-out table'), null, { timeout: 15000 });
  check((await d.textContent('#all-out')).includes('photo was altered'), 'one changed pixel is caught');
  await d.click('#untamper');
  await d.waitForFunction(() => document.querySelector('#all-out')?.textContent.includes('Every record verified'), null, { timeout: 15000 });
  ok('restored photo verifies again');

  check(errors.length === 0, `no console errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
