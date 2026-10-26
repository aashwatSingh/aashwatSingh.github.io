import test from 'node:test';
import assert from 'node:assert/strict';
import { setStage, pipelineStats, pipelineItems, quietApps, defaultNext, stageSince } from '../js/pipeline.js';
import { cleanStore, emptyStore } from '../js/store.js';
import { sampleStore } from '../js/sample.js';

const TODAY = '2026-10-26';
const NOW = new Date(2026, 9, 26, 9).getTime();
const app = (o) => ({ id: 'x', company: 'Acme', role: 'SWE Intern', url: '', stage: 'wishlist', outcome: '', applied: '',
  next: '', nextDue: '', nextTime: '', notes: '', history: [], created: '2026-09-01T00:00:00Z', updated: '', ...o });

test('setStage records history and fills in the applied date', () => {
  const a = setStage(app(), 'applied', NOW);
  assert.equal(a.applied, TODAY);
  assert.equal(a.history.at(-1).stage, 'applied');
  assert.equal(stageSince(a), a.history.at(-1).at);
  const b = setStage(a, 'oa', NOW + 1000);
  assert.equal(b.applied, TODAY, 'applied date is kept');
  assert.equal(setStage(b, 'oa', NOW), b, 'same stage is a no-op');
  assert.equal(setStage(app(), 'closed', NOW).applied, '', 'dropping a wishlist entry is not applying');
});

test('stats: response rate counts OAs, interviews, offers and rejections', () => {
  const apps = [
    app({ id: '1', stage: 'applied', applied: '2026-10-24' }),
    app({ id: '2', stage: 'interview', applied: '2026-10-01', history: [{ stage: 'oa', at: '2026-10-05T00:00:00Z' }, { stage: 'interview', at: '2026-10-10T00:00:00Z' }] }),
    app({ id: '3', stage: 'closed', outcome: 'rejected', applied: '2026-09-20' }),
    app({ id: '4', stage: 'closed', outcome: 'ghosted', applied: '2026-09-10' }),
    app({ id: '5', stage: 'wishlist' }),
  ];
  const s = pipelineStats(apps, TODAY);
  assert.equal(s.applied, 4);
  assert.equal(s.thisWeek, 1);
  assert.equal(s.responded, 2);
  assert.equal(s.responseRate, 0.5);
  assert.equal(s.interviews, 1);
  assert.equal(s.active, 2);
  assert.equal(s.byStage.closed, 2);
  assert.equal(pipelineStats([], TODAY).responseRate, null);
});

test('next steps become items; quiet applications are grouped into one', () => {
  const apps = [
    app({ id: '1', stage: 'oa' }),
    app({ id: '2', stage: 'wishlist', company: 'Big Co', next: 'Apply before it closes', nextDue: '2026-10-30' }),
    app({ id: '3', stage: 'wishlist' }),
    app({ id: '4', stage: 'applied', company: 'Quiet A', applied: '2026-10-01', history: [{ stage: 'applied', at: '2026-10-01T12:00:00Z' }] }),
    app({ id: '5', stage: 'applied', company: 'Quiet B', applied: '2026-10-05', history: [{ stage: 'applied', at: '2026-10-05T12:00:00Z' }] }),
    app({ id: '6', stage: 'applied', company: 'Recent', applied: '2026-10-20', history: [{ stage: 'applied', at: '2026-10-20T12:00:00Z' }] }),
    app({ id: '7', stage: 'closed', nextDue: '2026-10-27' }),
  ];
  const items = pipelineItems(apps, TODAY);
  assert.deepEqual(items.map((i) => i.key), ['i:1', 'i:2', 'i:followups']);
  assert.equal(items[0].kind, 'oa');
  assert.equal(items[0].title, defaultNext(apps[0]));
  assert.equal(items[1].title, 'Apply before it closes');
  assert.equal(items[1].due, new Date(2026, 9, 30, 23, 59, 59, 999).getTime());
  assert.equal(items[2].title, 'Follow up on 2 quiet applications');
  assert.equal(quietApps(apps, TODAY).length, 2);
});

test('cleanStore turns anything into a valid store', () => {
  assert.deepEqual(cleanStore(null), emptyStore());
  assert.deepEqual(cleanStore('nope'), emptyStore());
  const s = cleanStore({
    settings: { canvasUrl: 'https://elearning.utdallas.edu/', proxyUrl: 'javascript:alert(1)', dailyNew: 99, hidden: ['12', 'x'] },
    tasks: [{ id: 'a', title: '  Do it  ', pri: 7, due: 'tomorrow' }, { title: '' }, { id: 'a', title: 'dupe' }],
    apps: [{ company: 'Acme', stage: 'nope', url: 'http://insecure.example' }],
    dsa: { problems: { 'two-sum': { st: 'solved', conf: 3, step: 1, due: '2026-10-29' }, 'BAD SLUG': { st: 'solved', due: '2026-10-29' } }, log: { '2026-10-26': 2, junk: 4 } },
    done: { 'c:a:1': '2026-10-26T00:00:00Z', '<x>': 'y' },
  });
  assert.equal(s.settings.canvasUrl, 'https://elearning.utdallas.edu');
  assert.equal(s.settings.proxyUrl, '');
  assert.equal(s.settings.dailyNew, 10);
  assert.deepEqual(s.settings.hidden, ['12']);
  assert.equal(s.tasks.length, 1);
  assert.deepEqual([s.tasks[0].title, s.tasks[0].pri, s.tasks[0].due], ['Do it', 2, '']);
  assert.equal(s.apps[0].stage, 'wishlist');
  assert.equal(s.apps[0].url, '');
  assert.deepEqual(Object.keys(s.dsa.problems), ['two-sum']);
  assert.deepEqual(s.dsa.log, { '2026-10-26': 2 });
  assert.deepEqual(Object.keys(s.done), ['c:a:1']);
});

test('sample data survives cleaning intact', () => {
  const raw = sampleStore(NOW);
  const s = cleanStore(JSON.parse(JSON.stringify(raw)));
  assert.equal(s.sample, true);
  assert.equal(s.canvas.planner.length, raw.canvas.planner.length);
  assert.equal(s.canvas.courses.length, 4);
  assert.equal(s.tasks.length, raw.tasks.length);
  assert.equal(s.apps.length, raw.apps.length);
  assert.equal(Object.keys(s.dsa.problems).length, Object.keys(raw.dsa.problems).length);
  assert.ok(Object.keys(s.dsa.problems).length > 10);
});
