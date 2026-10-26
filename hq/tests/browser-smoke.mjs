// Browser smoke test for Comet HQ. Not part of `node --test`: it needs Playwright.
//
//   node hq/tests/browser-smoke.mjs
//
// It starts three local servers on different ports (so different origins, like the real thing):
// this repo, a mock Canvas, and the proxy Worker run under Node. Then it:
//   1. runs the real sync bookmarklet on the mock Canvas page and lands in HQ with the data;
//   2. syncs again into the already-open HQ tab (the hashchange path) and sees a submission;
//   3. tries token mode without a proxy (blocked by CORS, as on the real Canvas) and with one;
//   4. adds, completes and undoes a task, adds and advances an application, marks a DSA problem;
//   5. walks every tab on a phone in dark mode and a desktop, with no console errors or sideways scroll;
//   6. downloads the Comet HQ Sync extension from HQ, loads it, connects once, then checks that simply
//      reopening HQ later refreshes it from Canvas with no clicks, and that a logged-out Canvas is explained.
// Set SHOTS=<dir> to save screenshots, or PLAYWRIGHT_MODULE to use a Playwright installed elsewhere.

import { createRequire } from 'node:module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import worker from '../proxy/worker.js';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require(process.env.PLAYWRIGHT_MODULE || 'playwright'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SHOTS = process.env.SHOTS;
const H = 36e5;
const ok = (msg) => console.log(`ok - ${msg}`);
const check = (cond, msg) => { if (!cond) throw new Error(`FAILED: ${msg}`); ok(msg); };

// ---------------------------------------------------------------- servers

const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png' };

const site = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

let submittedHw6 = false;
const now = Date.now();
const iso = (h) => new Date(now + h * H).toISOString();
let CANVAS = '';

const canvas = http.createServer((req, res) => {
  const url = new URL(req.url, CANVAS);
  const session = /canvas_session=ok/.test(req.headers.cookie || '');
  const token = req.headers.authorization === 'Bearer test-token';
  if (!url.pathname.startsWith('/api/')) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Dashboard</title><h1>Canvas</h1>');
    return;
  }
  if (!session && !token) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"errors":[{"message":"Invalid access token."}]}'); return; }
  const send = (body, headers = {}) => {
    // Like Canvas: session-authenticated JSON gets the anti-hijacking prefix. No CORS headers, ever.
    res.writeHead(200, { 'Content-Type': 'application/json', ...headers });
    res.end((session && !token ? 'while(1);' : '') + JSON.stringify(body));
  };
  const p = url.pathname;
  if (p === '/api/v1/users/self') return send({ id: 1, name: 'Test Student', short_name: 'Tester' });
  if (p === '/api/v1/courses') {
    return send([{ id: 501, name: 'Data Structures and Algorithmic Analysis', course_code: 'CS 3345.002', apply_assignment_group_weights: true,
      term: { name: 'Fall 2026', end_at: iso(24 * 60) }, enrollments: [{ type: 'student', computed_current_score: 85.5, computed_current_grade: 'B' }] }]);
  }
  if (p === '/api/v1/courses/501/assignment_groups') {
    const a = (from, n, pts) => Array.from({ length: n }, (_, i) => ({ id: from + i, points_possible: pts, description: '<p>long</p>' }));
    return send([
      { id: 1, name: 'Homework', group_weight: 20, assignments: a(1, 10, 50) },
      { id: 2, name: 'Exams', group_weight: 60, assignments: a(21, 3, 100) },
      { id: 3, name: 'Quizzes', group_weight: 20, assignments: a(31, 10, 10) },
    ]);
  }
  if (p === '/api/v1/planner/items') {
    const sub = (s) => ({ submitted: s, missing: false, late: false, graded: false, excused: false, needs_grading: false });
    const items = [
      { plannable_type: 'assignment', plannable_id: 6, course_id: 501, html_url: '/courses/501/assignments/6',
        plannable: { id: 6, title: 'Homework 6: AVL Trees', due_at: iso(20), points_possible: 50 }, submissions: sub(submittedHw6) },
      { plannable_type: 'assignment', plannable_id: 22, course_id: 501, html_url: '/courses/501/assignments/22',
        plannable: { id: 22, title: 'Exam 2', due_at: iso(48), points_possible: 100 }, submissions: sub(false) },
      { plannable_type: 'announcement', plannable_id: 3, course_id: 501, plannable: { title: 'Room change' } },
      { plannable_type: 'quiz', plannable_id: 900, course_id: 501, html_url: '/courses/501/quizzes/900',
        plannable: { id: 900, title: 'Quiz 7', due_at: iso(5), points_possible: 10, assignment_id: 33 }, submissions: sub(false) },
      { plannable_type: 'calendar_event', plannable_id: 77, course_id: 501, html_url: '/calendar?event_id=77',
        plannable: { title: 'TA office hours', start_at: iso(26), end_at: iso(27) }, submissions: false },
    ];
    const page = url.searchParams.get('page') === '2' ? 2 : 1;
    const next = new URL(url);
    next.searchParams.set('page', '2');
    return page === 1
      ? send(items.slice(0, 2), { Link: `<${next.href}>; rel="next", <${url.href}>; rel="first"` })
      : send(items.slice(2), { Link: `<${url.href}>; rel="first"` });
  }
  if (p === '/api/v1/users/self/missing_submissions') {
    return send([{ id: 5, name: 'Homework 5: Heaps', course_id: 501, due_at: iso(-30), html_url: `${CANVAS}/courses/501/assignments/5`, points_possible: 50 }]);
  }
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end('{"errors":[]}');
});

let HQ_ORIGIN = '';
const proxy = http.createServer(async (req, res) => {
  const headers = {};
  for (const k of ['origin', 'authorization', 'accept', 'access-control-request-method', 'access-control-request-headers']) if (req.headers[k]) headers[k] = req.headers[k];
  const r = await worker.fetch(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers }), { CANVAS_URL: CANVAS, ALLOWED_ORIGIN: HQ_ORIGIN });
  res.writeHead(r.status, Object.fromEntries(r.headers));
  res.end(Buffer.from(await r.arrayBuffer()));
});

const SITE = await listen(site);
CANVAS = await listen(canvas);
const PROXY = await listen(proxy);
HQ_ORIGIN = SITE;
const HQ = `${SITE}/hq/`;

// ---------------------------------------------------------------- browser

const browser = await chromium.launch();
const errors = [];
let expectBlocked = false;
const watch = (page, tag) => {
  page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    if (expectBlocked && /CORS|Failed to fetch|ERR_FAILED/.test(m.text())) return;
    errors.push(`${tag}: ${m.text()}`);
  });
};
const shot = async (page, name) => {
  if (!SHOTS) return;
  await page.waitForTimeout(1500); // let arrivals and transitions settle
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true });
};
const titles = (page, sel = '#view-today .plist:first-of-type .pr-title') => page.$$eval(sel, (els) => els.map((e) => e.textContent.trim()));

try {
  if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const desk = await browser.newContext({ viewport: { width: 1280, height: 900 }, acceptDownloads: true });
  await desk.addCookies([{ name: 'canvas_session', value: 'ok', url: CANVAS }]);
  const hqStart = await desk.newPage();
  watch(hqStart, 'hq');
  await hqStart.goto(HQ);
  await hqStart.waitForSelector('text=Welcome to Comet HQ');
  ok('empty HQ shows the welcome');
  await hqStart.click('#view-today [data-open="connect"]');
  const href = await hqStart.getAttribute('#bookmarklet', 'href');
  check(href.startsWith('javascript:') && decodeURIComponent(href).includes(JSON.stringify(HQ)), 'the connect dialog offers a bookmarklet pointing at this HQ');
  await hqStart.close();

  // 1. The bookmarklet, run on Canvas, opens HQ with the data.
  const cv = await desk.newPage();
  watch(cv, 'canvas');
  await cv.goto(`${CANVAS}/courses/501`);
  const src = decodeURIComponent(href.slice('javascript:'.length));
  const popup = desk.waitForEvent('page');
  await cv.evaluate(src);
  const hq = await popup;
  watch(hq, 'hq');
  await hq.waitForSelector('#view-today .pr');
  const top = await titles(hq);
  check(top[0] === 'Exam 2', `Exam 2 (20% in 2 days) ranks first: ${top.join(' | ')}`);
  check(top.indexOf('Exam 2') < top.indexOf('Homework 6: AVL Trees'), 'the exam outranks the 2% homework due tomorrow');
  check(top.includes('Homework 5: Heaps'), 'missing work from the missing-submissions call is listed');
  check(top.includes('Quiz 7'), 'the second planner page was fetched');
  check(!top.includes('Room change') && !top.includes('TA office hours'), 'announcements and events stay out of priorities');
  check(!new URL(hq.url()).hash, 'the data is wiped from the address bar');
  const saved = await hq.evaluate(() => JSON.parse(localStorage.getItem('hq:v1')).canvas);
  check(saved.courses[0].score === 85.5 && saved.origin === CANVAS, 'grades and the Canvas origin are saved');
  const examMeta = await hq.textContent('#view-today .pr:first-child .pr-meta');
  check(/~20% of grade/.test(examMeta), `grade weight is estimated from assignment groups (${examMeta.trim()})`);
  const link = await hq.getAttribute('#view-today .pr:first-child a.pr-title', 'href');
  check(link === `${CANVAS}/courses/501/assignments/22`, 'items link back to Canvas');
  await shot(hq, 'desktop-today-synced');

  // 2. Sync again into the open HQ tab: Homework 6 is now submitted.
  submittedHw6 = true;
  await cv.bringToFront();
  await cv.evaluate(src);
  await hq.waitForFunction(() => ![...document.querySelectorAll('#view-today .pr-title')].some((e) => e.textContent.includes('Homework 6')));
  ok('a second sync into the open tab updates it (submitted work drops off)');

  // 3. Token mode: blocked without a proxy (no CORS on Canvas), works through the Worker.
  await hq.bringToFront();
  await hq.click('#sync-btn');
  await hq.waitForSelector('#connect[open]');
  await hq.fill('#canvas-url', CANVAS);
  await hq.click('.more-ways > summary');
  await hq.fill('#proxy-url', '');
  await hq.fill('#canvas-token', 'test-token');
  expectBlocked = true;
  await hq.click('#token-form button[type="submit"]');
  await hq.waitForFunction(() => /blocked the request/.test(document.querySelector('#toast-text').textContent));
  expectBlocked = false;
  ok('token mode without a proxy explains the CORS block');
  submittedHw6 = false;
  // With a token saved, the sync button syncs straight away, so open the dialog from the menu.
  await hq.click('.menu > summary');
  await hq.click('.menu-panel [data-open="connect"]');
  await hq.waitForSelector('#connect[open]');
  if (!(await hq.$eval('.more-ways', (d) => d.open))) await hq.click('.more-ways > summary');
  await hq.fill('#proxy-url', PROXY);
  await hq.click('#token-form button[type="submit"]');
  await hq.waitForFunction(() => /Synced 1 course/.test(document.querySelector('#toast-text').textContent));
  // The list redraws inside a view transition, a frame after the toast.
  await hq.waitForSelector('#view-today .pr-title:has-text("Homework 6: AVL Trees")');
  ok('token mode syncs through the proxy Worker (with pagination)');
  check(await hq.evaluate(() => !JSON.stringify(JSON.parse(localStorage.getItem('hq:v1'))).includes('test-token')), 'the token is not in the saved store');

  // 4. Tasks, applications, DSA.
  await hq.fill('#new-task', 'Ask Prof. Lee for a reference');
  await hq.selectOption('#add-task select[name="pri"]', '1');
  await hq.press('#new-task', 'Enter');
  await hq.waitForSelector('#view-today .pr-title:has-text("Ask Prof. Lee")');
  ok('a task can be added');
  await hq.click('#view-today .panel:has(#tasks-h) .pr:has-text("Ask Prof. Lee") .check');
  await hq.waitForSelector('#toast.show #toast-action:has-text("Undo")');
  check(await hq.$eval('#view-today .panel:has(#tasks-h) .pr:has-text("Ask Prof. Lee")', (el) => el.classList.contains('is-done')), 'checking a task marks it done');
  await hq.click('#toast-action');
  await hq.waitForSelector('#view-today .panel:has(#tasks-h) .pr:not(.is-done):has-text("Ask Prof. Lee")');
  ok('undo brings it back');

  await hq.click('#view-today .pr:has-text("Homework 5") .check');
  await hq.waitForFunction(() => ![...document.querySelectorAll('#view-today .pr-title')].some((e) => e.textContent.includes('Homework 5')));
  ok('Canvas items can be checked off in HQ (the row animates out)');

  await hq.click('.tab[data-tab="intern"]');
  await hq.click('#view-intern [data-act="new-app"] >> nth=0');
  await hq.fill('#app-form input[name="company"]', 'Acme Robotics');
  await hq.fill('#app-form input[name="role"]', 'Software Intern');
  await hq.click('#app-form button[type="submit"]');
  await hq.waitForSelector('.col[aria-label="Applied"] .card:has-text("Acme Robotics")');
  ok('an application can be added');
  await hq.click('.card:has-text("Acme Robotics") [data-act="advance"]');
  await hq.waitForSelector('.col[aria-label="Online assessment"] .card:has-text("Acme Robotics")');
  await hq.click('.tab[data-tab="today"]');
  check((await titles(hq)).includes('Finish the Acme Robotics online assessment'), 'an OA stage becomes a priority');

  await hq.click('.tab[data-tab="dsa"]');
  await hq.click('#view-dsa .prob >> nth=0 >> button:has-text("Solid")');
  await hq.waitForFunction(() => /Next review/.test(document.querySelector('#toast-text').textContent));
  check(await hq.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hq:v1')).dsa.problems).length === 1), 'marking a problem schedules its review');
  await hq.click('#view-dsa [data-act="undo-practice"] >> nth=0');
  check(await hq.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('hq:v1')).dsa.problems).length === 0), 'undo clears it');

  await hq.reload();
  await hq.waitForSelector('#view-dsa .prob');
  check(await hq.isVisible('#view-dsa'), 'the open tab survives a reload');

  const [download] = await Promise.all([hq.waitForEvent('download'), hq.evaluate(() => { document.querySelector('.menu').open = true; document.querySelector('#export-btn').click(); })]);
  const exported = fs.readFileSync(await download.path(), 'utf8');
  check(exported.includes('Acme Robotics') && !exported.includes('test-token'), 'export has the data and not the token');
  await desk.close();

  // 5. Every tab on a phone in dark mode and on a desktop, from sample data.
  for (const [name, opts] of [
    ['phone', { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, colorScheme: 'dark' }],
    ['desktop', { viewport: { width: 1280, height: 900 }, colorScheme: 'light' }],
  ]) {
    const ctx = await browser.newContext(opts);
    const page = await ctx.newPage();
    watch(page, name);
    await page.goto(HQ);
    await page.click('#view-today [data-act="load-sample"]');
    await page.waitForSelector('#view-today .pr');
    for (const t of ['today', 'school', 'intern', 'dsa']) {
      await page.click(`.tab[data-tab="${t}"]`);
      await page.waitForSelector(`#view-${t}:not([hidden]) > *`);
      const wide = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      check(wide <= 0, `${name} ${t}: no sideways scroll`);
      await shot(page, `${name}-${t}`);
    }
    await page.click('.tab[data-tab="dsa"]');
    await page.click('#view-dsa details.pat >> nth=0 >> summary');
    await page.waitForSelector('#view-dsa details.pat[open] .prob');
    ok(`${name}: a pattern opens to its problems`);
    await page.click('#clear-sample');
    await page.click('.tab[data-tab="today"]');
    await page.waitForSelector('text=Welcome to Comet HQ');
    ok(`${name}: sample data clears`);
    await ctx.close();
  }

  // 6. The extension: install once, then HQ syncs by itself whenever it opens.
  const dl = await browser.newContext({ acceptDownloads: true });
  const dlPage = await dl.newPage();
  watch(dlPage, 'download');
  await dlPage.goto(HQ);
  await dlPage.click('#view-today [data-open="connect"]');
  const [zipDl] = await Promise.all([dlPage.waitForEvent('download'), dlPage.click('#ext-setup [data-act="download-ext"]')]);
  check(zipDl.suggestedFilename() === 'comet-hq-sync.zip', 'HQ offers the extension as one download');
  const extRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-ext-'));
  execFileSync('python3', ['-I', '-m', 'zipfile', '-e', await zipDl.path(), extRoot]);
  await dl.close();
  const extDir = path.join(extRoot, 'comet-hq-sync');
  const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf8'));
  // The shipped manifest only matches the real site; let this copy also run on the local test servers.
  manifest.content_scripts[0].matches.push('http://127.0.0.1/hq/*');
  manifest.host_permissions.push('http://127.0.0.1/*');
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(manifest));

  submittedHw6 = false;
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hq-profile-'));
  const withExt = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  await withExt.addCookies([{ name: 'canvas_session', value: 'ok', url: CANVAS }]);
  const ep = withExt.pages()[0] || await withExt.newPage();
  watch(ep, 'extension');
  await ep.goto(HQ);
  await ep.waitForSelector('#view-today .panel:has-text("extension is installed")');
  ok('HQ notices the extension');
  await ep.click('#view-today [data-open="connect"]');
  check(await ep.isVisible('#ext-ready') && !(await ep.isVisible('#ext-setup')), 'the Connect dialog shows it as installed');
  await ep.fill('#canvas-url', CANVAS);
  await ep.click('#address-form button[type="submit"]');
  await ep.waitForSelector('#view-today .pr-title:has-text("Exam 2")');
  check((await titles(ep)).includes('Homework 6: AVL Trees'), 'the first sync goes through the extension with the Canvas login (no token)');
  check(await ep.isVisible('#view-today .pill:has-text("Up to date")'), 'the Canvas card says it is up to date');

  // Later: Homework 6 gets submitted on Canvas. Just reopening HQ should pick that up.
  submittedHw6 = true;
  await ep.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('hq:v1'));
    s.canvas.at = new Date(Date.now() - 3 * 36e5).toISOString();
    localStorage.setItem('hq:v1', JSON.stringify(s));
  });
  await ep.reload();
  await ep.waitForFunction(() => ![...document.querySelectorAll('#view-today .pr-title')].some((e) => e.textContent.includes('Homework 6')), null, { timeout: 15000 });
  check(await ep.isVisible('#view-today .pill:has-text("Up to date")'), 'reopening HQ re-syncs by itself, no clicks');
  await shot(ep, 'extension-auto-synced');

  // Logged out of Canvas: HQ says so and links there instead of failing quietly.
  await withExt.clearCookies();
  await ep.evaluate(() => {
    const s = JSON.parse(localStorage.getItem('hq:v1'));
    s.canvas.at = new Date(Date.now() - 3 * 36e5).toISOString();
    localStorage.setItem('hq:v1', JSON.stringify(s));
  });
  await ep.reload();
  await ep.waitForSelector('#view-today .pill:has-text("Logged out of Canvas")', { timeout: 15000 });
  check(await ep.getAttribute('#view-today a.btn:has-text("Open Canvas")', 'href') === CANVAS, 'a logged-out Canvas is explained, with a link to log in');
  await withExt.close();

  check(errors.length === 0, `no console errors${errors.length ? `:\n${errors.join('\n')}` : ''}`);
} finally {
  await browser.close();
  site.close();
  canvas.close();
  proxy.close();
}
