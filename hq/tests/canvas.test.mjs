import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {
  canvasGet, pullCanvas, packPayload, unpackPayload, bookmarklet, bookmarkletSource, cleanCanvas, safeUrl,
  gradeWeights, kindOf, shortCode, canvasItems, courseSummaries,
} from '../js/canvas.js';

const NOW = Date.parse('2026-10-26T15:00:00Z');
const H = 36e5;

/** A fetch that serves canned Canvas responses, with the session-auth prefix and pagination. */
function fakeFetch(routes, calls = []) {
  return async (url, opts) => {
    calls.push({ url, opts });
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const r = routes[path] ?? routes[path.split('?')[0]];
    if (!r) return new Response('<html>not found</html>', { status: 404 });
    if (r.status) return new Response('{"errors":[]}', { status: r.status });
    return new Response(`while(1);${JSON.stringify(r.body)}`, { status: 200, headers: r.link ? { Link: r.link } : {} });
  };
}

test('canvasGet strips while(1); and follows Link pages onto the same base', async () => {
  const calls = [];
  const f = fakeFetch({
    '/api/v1/x?per_page=2': { body: [1, 2], link: '<https://canvas.example.edu/api/v1/x?page=2&per_page=2>; rel="next", <https://canvas.example.edu/api/v1/x?page=1>; rel="first"' },
    '/api/v1/x?page=2&per_page=2': { body: [3], link: '<https://canvas.example.edu/api/v1/x?page=1>; rel="first"' },
  }, calls);
  const out = await canvasGet('/api/v1/x?per_page=2', 'https://proxy.example.dev', 'tok', f);
  assert.deepEqual(out, [1, 2, 3]);
  assert.equal(calls[1].url, 'https://proxy.example.dev/api/v1/x?page=2&per_page=2');
  assert.equal(calls[0].opts.headers.Authorization, 'Bearer tok');
  assert.equal(calls[0].opts.credentials, 'omit');
});

test('canvasGet on Canvas itself uses the login cookie, not a token', async () => {
  const calls = [];
  const out = await canvasGet('/api/v1/users/self', '', null, fakeFetch({ '/api/v1/users/self': { body: { name: 'A' } } }, calls));
  assert.deepEqual(out, { name: 'A' });
  assert.equal(calls[0].opts.credentials, 'same-origin');
  assert.equal(calls[0].opts.headers.Authorization, undefined);
});

test('canvasGet reports the status, and a login page as not logged in', async () => {
  await assert.rejects(canvasGet('/api/v1/courses', '', null, fakeFetch({ '/api/v1/courses': { status: 401 } })), (e) => e.status === 401);
  const html = async () => new Response('<!doctype html><title>Log in</title>', { status: 200 });
  await assert.rejects(canvasGet('/api/v1/courses', '', null, html), /logged in/);
});

const COURSES = [
  { id: 1, name: 'Data Structures', course_code: 'CS 3345.002', apply_assignment_group_weights: true,
    term: { name: 'Fall 2026', end_at: '2026-12-20T00:00:00Z' },
    enrollments: [{ type: 'student', computed_current_score: 88.4, computed_current_grade: 'B+' }] },
  { id: 2, name: 'Old Course', course_code: 'CS 1336', term: { name: 'Spring 2026', end_at: '2026-05-10T00:00:00Z' }, enrollments: [] },
  { id: 3, name: 'Locked', access_restricted_by_date: true },
];
const PLANNER = [
  { plannable_type: 'assignment', plannable_id: 10, course_id: 1, html_url: '/courses/1/assignments/10',
    plannable: { title: 'Homework 6', due_at: '2026-10-27T04:59:00Z', points_possible: 50 },
    submissions: { submitted: false, missing: false, late: false, graded: false, excused: false }, planner_override: null },
  { plannable_type: 'quiz', plannable_id: 77, course_id: 1, html_url: '/courses/1/quizzes/77',
    plannable: { title: 'Quiz 7', due_at: '2026-10-26T21:00:00Z', points_possible: 10, assignment_id: 11 },
    submissions: { submitted: true }, planner_override: { marked_complete: false, dismissed: false } },
  { plannable_type: 'announcement', plannable_id: 5, course_id: 1, plannable: { title: 'Welcome' } },
  { plannable_type: 'calendar_event', plannable_id: 900, course_id: 1, html_url: '/calendar?event_id=900',
    plannable: { title: 'Exam 2', start_at: '2026-10-28T23:00:00Z', end_at: '2026-10-29T00:15:00Z' }, submissions: false },
];
const GROUPS = [
  { id: 100, name: 'Homework', group_weight: 20, assignments: [{ id: 10, points_possible: 50 }, { id: 12, points_possible: 50, omit_from_final_grade: true }] },
  { id: 101, name: 'Quizzes', group_weight: 10, assignments: [{ id: 11, points_possible: 10 }] },
];

test('pullCanvas keeps current courses and trims everything to what HQ uses', async () => {
  const paths = [];
  const get = async (p) => {
    paths.push(p);
    if (p === '/api/v1/users/self') return { short_name: 'Aashwat' };
    if (p.startsWith('/api/v1/courses?')) return COURSES;
    if (p.startsWith('/api/v1/planner/items')) return PLANNER;
    if (p.startsWith('/api/v1/users/self/missing_submissions')) throw new Error('Canvas answered 403 for /missing');
    if (p.startsWith('/api/v1/courses/1/assignment_groups')) return GROUPS;
    throw new Error(`unexpected ${p}`);
  };
  const out = await pullCanvas(get, NOW, 'https://canvas.example.edu');
  assert.equal(out.v, 1);
  assert.equal(out.user, 'Aashwat');
  assert.deepEqual(out.courses.map((c) => c.id), [1], 'ended and locked courses are dropped');
  assert.deepEqual(out.courses[0], { id: 1, name: 'Data Structures', code: 'CS 3345.002', term: 'Fall 2026', score: 88.4, grade: 'B+', weighted: true });
  assert.ok(!paths.some((p) => p.includes('/courses/2/')), 'no calls for dropped courses');
  assert.equal(out.planner.length, 3, 'announcements are not tasks');
  const quiz = out.planner.find((p) => p.type === 'quiz');
  assert.equal(quiz.aid, 11, 'quizzes carry their assignment id');
  assert.deepEqual(quiz.sub, { s: true, m: false, l: false, g: false, x: false });
  const ev = out.planner.find((p) => p.type === 'calendar_event');
  assert.equal(ev.due, '2026-10-28T23:00:00Z');
  assert.equal(ev.sub, null);
  assert.deepEqual(out.groups[0].a, [[10, 50]], 'assignments left out of the final grade are skipped');
  assert.deepEqual(out.missing, []);
  assert.equal(out.errors.length, 1, 'a failing optional call is reported, not fatal');
  assert.ok(cleanCanvas(JSON.parse(JSON.stringify(out))), 'the output passes cleaning');
});

test('pack and unpack round-trip, compressed and plain', async () => {
  const data = { v: 1, text: 'Résumé ✓ '.repeat(500), list: Array.from({ length: 300 }, (_, i) => i) };
  const z = await packPayload(data);
  assert.equal(z[0], 'z');
  assert.match(z, /^[\w-]+$/, 'URL-safe');
  assert.deepEqual(await unpackPayload(z), data);
  const plain = `j${Buffer.from(JSON.stringify(data)).toString('base64url')}`;
  assert.deepEqual(await unpackPayload(plain), data);
  await assert.rejects(unpackPayload('qabc'), /Unknown/);
});

test('the bookmarklet is one valid script that embeds the real pull code', () => {
  const src = bookmarkletSource('https://aashwatsingh.github.io/hq/');
  assert.doesNotThrow(() => new vm.Script(src));
  assert.ok(src.includes('async function pullCanvas(get, now, origin)'));
  assert.ok(src.includes('"https://aashwatsingh.github.io/hq/"'));
  const href = bookmarklet('https://aashwatsingh.github.io/hq/');
  assert.ok(href.startsWith('javascript:'));
  assert.equal(decodeURIComponent(href.slice('javascript:'.length)), src);
  // Some browsers drop line breaks from bookmarks; the code must still run without them.
  assert.doesNotThrow(() => new vm.Script(src.replace(/\n\s*/g, ' ')));
});

test('cleanCanvas rejects bad payloads and unsafe links', () => {
  assert.equal(cleanCanvas(null), null);
  assert.equal(cleanCanvas({ v: 2, at: '2026-10-26T00:00:00Z', origin: 'https://a.edu' }), null);
  assert.equal(cleanCanvas({ v: 1, at: '2026-10-26T00:00:00Z', origin: 'javascript:alert(1)' }), null);
  const c = cleanCanvas({
    v: 1, at: '2026-10-26T00:00:00Z', origin: 'https://canvas.example.edu', user: 'A',
    courses: [{ id: 1, name: 'X' }, { id: 'nope' }],
    planner: [
      { type: 'assignment', id: 1, title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)', due: 'garbage' },
      { type: 'assignment', id: 2, title: 'Ok', url: '/courses/1/assignments/2', due: '2026-10-27T00:00:00Z' },
      { type: 'evil', id: 3, title: 'skip' },
    ],
  });
  assert.equal(c.courses.length, 1);
  assert.equal(c.planner.length, 2);
  assert.equal(c.planner[0].url, '', 'javascript: links are dropped');
  assert.equal(c.planner[0].due, null);
  assert.equal(c.planner[1].url, 'https://canvas.example.edu/courses/1/assignments/2');
  assert.equal(safeUrl('http://evil.example/x', 'https://a.edu'), '');
  assert.equal(safeUrl('http://127.0.0.1:8124/x', 'https://a.edu'), 'http://127.0.0.1:8124/x', 'local test servers are allowed');
});

test('gradeWeights estimates the share of the final grade', () => {
  const courses = [{ id: '1', weighted: true }, { id: '2', weighted: false }];
  const groups = [
    { id: 'g1', course: '1', weight: 50, a: [['a1', 100], ['a2', 100], ['a3', 100]] },
    { id: 'g2', course: '1', weight: 20, a: [['h1', 50], ['h2', 50]] },
    { id: 'g3', course: '1', weight: 30, a: [] },
    { id: 'g4', course: '2', weight: 0, a: [['p1', 150], ['p2', 50]] },
  ];
  const w = gradeWeights(courses, groups);
  // The empty group's 30% is spread over the others: 50/70 and 20/70.
  assert.ok(Math.abs(w.get('a1') - (50 / 70) * (100 / 300) * 100) < 1e-9);
  assert.ok(Math.abs(w.get('h1') - (20 / 70) * 0.5 * 100) < 1e-9);
  assert.equal(w.get('p1'), 75);
  assert.equal(w.get('p2'), 25);
});

test('kindOf reads exams, projects and quizzes from titles', () => {
  assert.equal(kindOf('assignment', 'Exam 2'), 'exam');
  assert.equal(kindOf('assignment', 'Midterm 1 (Section 002)'), 'exam');
  assert.equal(kindOf('calendar_event', 'Exam 2 in ECSS 2.410'), 'exam');
  assert.equal(kindOf('assignment', 'Test 3'), 'exam');
  assert.equal(kindOf('assignment', 'Exam 2 Review Sheet'), 'assignment');
  assert.equal(kindOf('discussion_topic', 'Practice Midterm discussion'), 'discussion');
  assert.equal(kindOf('assignment', 'Final Project Report'), 'project');
  assert.equal(kindOf('assignment', 'Write unit test cases'), 'assignment');
  assert.equal(kindOf('quiz', 'Chapter 4'), 'quiz');
  assert.equal(kindOf('assignment', 'Pop Quiz 3'), 'quiz');
  assert.equal(kindOf('calendar_event', 'Office hours'), 'event');
  assert.equal(kindOf('planner_note', 'Exam?'), 'note');
});

test('shortCode finds the subject and number', () => {
  assert.equal(shortCode({ code: 'CS 3345.002', name: '' }), 'CS 3345');
  assert.equal(shortCode({ code: '2268-UTDAL-ECS-3390-SEC0W1', name: '' }), 'ECS 3390');
  assert.equal(shortCode({ code: 'Advising', name: 'CS Advising' }), 'Advising');
});

test('canvasItems: done states, missing merge, hidden courses, past events', () => {
  const canvas = cleanCanvas({
    v: 1, at: '2026-10-26T00:00:00Z', origin: 'https://canvas.example.edu',
    courses: [{ id: 1, name: 'DS', code: 'CS 3345', score: 75, weighted: false }, { id: 2, name: 'Hidden', code: 'CS 9999' }],
    groups: [{ id: 9, course: 1, weight: 0, a: [[10, 50], [11, 50]] }],
    planner: [
      { type: 'assignment', id: 10, aid: 10, course: 1, title: 'HW', due: '2026-10-27T00:00:00Z', sub: { s: false } },
      { type: 'quiz', id: 70, aid: 11, course: 1, title: 'Quiz', due: '2026-10-25T00:00:00Z', sub: { s: true } },
      { type: 'calendar_event', id: 5, course: 1, title: 'Lecture', due: '2026-10-25T00:00:00Z', sub: null },
      { type: 'assignment', id: 20, aid: 20, course: 2, title: 'Hidden HW', due: '2026-10-27T00:00:00Z', sub: { s: false } },
    ],
    missing: [{ id: 10, course: 1, title: 'HW' }, { id: 30, course: 1, title: 'Old HW', due: '2026-10-01T00:00:00Z' }],
  });
  const items = canvasItems(canvas, { now: NOW, hidden: ['2'], done: { 'c:a:30': '2026-10-26T00:00:00Z' } });
  const by = Object.fromEntries(items.map((i) => [i.title, i]));
  assert.equal(by['Hidden HW'], undefined);
  assert.equal(by.HW.missing, true, 'the missing list marks the planner item');
  assert.equal(by.HW.weight, 50);
  assert.equal(by.HW.sub, 'CS 3345');
  assert.equal(by.HW.courseScore, 75);
  assert.equal(by.Quiz.done, true);
  assert.equal(by.Lecture.past, true);
  assert.equal(by['Old HW'].missing, true);
  assert.equal(by['Old HW'].done, true, 'checked off in HQ');
  const sums = courseSummaries(canvas, items, ['2']);
  assert.equal(sums.find((c) => c.id === '1').open, 1);
  assert.equal(sums.find((c) => c.id === '2').hidden, true);
  assert.equal(new Date(NOW + H).getTime() > NOW, true);
});
