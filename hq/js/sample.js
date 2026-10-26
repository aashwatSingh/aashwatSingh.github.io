// Sample data built around "now", so HQ can be tried before Canvas is connected.
// It goes through the same cleaning as real data (see store.js), so it can't drift from the format.

import { HOUR, DAY, keyOf, addDays } from './dates.js';
import { PROBLEMS } from './problems.js';
import { practice } from './dsa.js';

/** Raw store document (before cleanStore) full of believable sample data. */
export function sampleStore(now = Date.now()) {
  const today = keyOf(now);
  const at = (h) => new Date(now + h * HOUR).toISOString();
  // Evening due times read more naturally than "exactly N hours from now".
  const eve = (d, hh = 23, mm = 59) => { const x = new Date(now + d * DAY); x.setHours(hh, mm, 0, 0); return x.toISOString(); };

  const courses = [
    { id: 101, name: 'Data Structures and Algorithmic Analysis', code: 'CS 3345.002', term: 'Fall 2026', score: 88.4, grade: 'B+', weighted: true },
    { id: 102, name: 'Probability and Statistics in Computer Science', code: 'CS 3341.001', term: 'Fall 2026', score: 76.2, grade: 'C+', weighted: true },
    { id: 103, name: 'Systems Programming in UNIX', code: 'CS 3377.501', term: 'Fall 2026', score: 93.1, grade: 'A', weighted: false },
    { id: 104, name: 'Professional and Technical Communication', code: 'ECS 3390.0W1', term: 'Fall 2026', score: 91, grade: 'A-', weighted: true },
  ];
  const range = (from, n, pts) => Array.from({ length: n }, (_, i) => [from + i, pts]);
  const groups = [
    { id: 11, course: 101, name: 'Homework', weight: 20, a: range(1001, 8, 50) },
    { id: 12, course: 101, name: 'Quizzes', weight: 10, a: range(1101, 10, 10) },
    { id: 13, course: 101, name: 'Exams', weight: 50, a: range(1201, 3, 100) },
    { id: 14, course: 101, name: 'Projects', weight: 20, a: range(1301, 2, 100) },
    { id: 21, course: 102, name: 'Homework', weight: 30, a: range(2001, 10, 20) },
    { id: 22, course: 102, name: 'Exams', weight: 70, a: range(2101, 3, 100) },
    { id: 31, course: 103, name: 'Labs', weight: 0, a: range(3001, 10, 40) },
    { id: 32, course: 103, name: 'Programs', weight: 0, a: range(3101, 4, 150) },
    { id: 33, course: 103, name: 'Exams', weight: 0, a: range(3201, 2, 100) },
    { id: 41, course: 104, name: 'Assignments', weight: 60, a: range(4001, 8, 50) },
    { id: 42, course: 104, name: 'Presentation', weight: 25, a: [[4101, 100]] },
    { id: 43, course: 104, name: 'Participation', weight: 15, a: range(4201, 10, 5) },
  ];
  const sub = (o = {}) => ({ s: false, m: false, l: false, g: false, x: false, ...o });
  const item = (type, id, aid, course, title, due, pts, s, extra = {}) => ({
    type, id, aid, course, ctx: '', title, due, end: null, url: '', pts, sub: s, done: false, gone: false, ...extra,
  });
  const planner = [
    item('quiz', 501, 1107, 101, 'Quiz 7: Balanced Search Trees', at(6), 10, sub()),
    item('assignment', 1006, 1006, 101, 'Homework 6: AVL Trees', eve(1), 50, sub()),
    item('assignment', 1202, 1202, 101, 'Exam 2', eve(2, 19, 0), 100, sub()),
    item('assignment', 1302, 1302, 101, 'Project 2: Hash Map', eve(9), 100, sub()),
    item('assignment', 1005, 1005, 101, 'Homework 5: Binary Heaps', eve(-5), 50, sub({ s: true, g: true })),
    item('calendar_event', 9001, null, 101, 'TA office hours (ECSS 3.415)', at(26), null, null),
    item('assignment', 2007, 2007, 102, 'Homework 7: Conditional Probability', eve(-1), 20, sub({ m: true })),
    item('assignment', 2008, 2008, 102, 'Homework 8: Random Variables', eve(4), 20, sub()),
    item('assignment', 2102, 2102, 102, 'Midterm 2', eve(6, 13, 0), 100, sub()),
    item('assignment', 3006, 3006, 103, 'Lab 6: Pipes and Signals', eve(3), 40, sub()),
    item('assignment', 3103, 3103, 103, 'Program 3: Mini Shell', eve(12), 150, sub()),
    item('assignment', 3005, 3005, 103, 'Lab 5: Process Control', eve(-3), 40, sub({ s: true })),
    item('discussion_topic', 77, 4207, 104, 'Week 10 Discussion: Audience Analysis', at(30), 5, sub()),
    item('assignment', 4005, 4005, 104, 'Résumé and Cover Letter Draft', eve(4), 50, sub()),
    item('assignment', 4101, 4101, 104, 'Team Presentation', eve(16), 100, sub()),
    item('planner_note', 88, null, null, 'Email advisor about the spring schedule', eve(3), null, null),
  ];
  const canvas = { v: 1, at: at(-2), origin: 'https://canvas.example.edu', user: 'Temoc', errors: [], courses, groups, planner, missing: [] };

  const tasks = [
    { id: 's1', title: 'Register for spring classes', cat: 'school', pri: 1, due: addDays(today, 5), time: '', notes: '' },
    { id: 's2', title: 'Add Project 2 to my résumé', cat: 'intern', pri: 2, due: addDays(today, 2), time: '', notes: '' },
    { id: 's3', title: 'Book a mock interview at the Career Center', cat: 'intern', pri: 2, due: '', time: '', notes: '' },
    { id: 's4', title: 'Review the Big-O cheat sheet', cat: 'dsa', pri: 3, due: '', time: '', notes: '' },
    { id: 's5', title: 'Grocery run', cat: 'life', pri: 3, due: addDays(today, 1), time: '', notes: '' },
  ].map((t) => ({ ...t, done: '', created: at(-48) }));

  const hist = (...steps) => steps.map(([stage, daysAgo]) => ({ stage, at: at(-daysAgo * 24) }));
  const app = (id, company, role, stage, applied, extra = {}, history = []) => ({
    id, company, role, url: '', stage, outcome: '', applied: applied === null ? '' : addDays(today, -applied),
    next: '', nextDue: '', nextTime: '', notes: '', history, created: at(-24 * 30), updated: at(-24), ...extra,
  });
  const apps = [
    app('a1', 'Capital One', 'Technology Internship Program', 'interview', 24,
      { next: 'Power Day: 3 rounds (technical + behavioral)', nextDue: addDays(today, 4), nextTime: '10:00' },
      hist(['applied', 24], ['oa', 17], ['interview', 6])),
    app('a2', 'Texas Instruments', 'Software Engineering Intern', 'oa', 9,
      { next: 'HackerRank online assessment', nextDue: addDays(today, 2) }, hist(['applied', 9], ['oa', 2])),
    app('a3', 'American Airlines', 'Software Engineer Intern', 'applied', 20, {}, hist(['applied', 20])),
    app('a4', 'State Farm', 'Software Developer Intern', 'applied', 16, {}, hist(['applied', 16])),
    app('a5', 'Toyota Connected', 'Software Engineer Intern', 'applied', 3, {}, hist(['applied', 3])),
    app('a6', 'JPMorgan Chase', 'Software Engineer Program', 'closed', 30, { outcome: 'rejected' },
      hist(['applied', 30], ['oa', 25], ['closed', 12])),
    app('a7', 'Goldman Sachs', 'Engineering Summer Analyst', 'wishlist', null,
      { next: 'Apply before the posting closes', nextDue: addDays(today, 6) }),
    app('a8', 'Lockheed Martin', 'Software Engineering Intern', 'wishlist', null),
  ];

  // Six weeks of practice, replayed through the real spaced-repetition rules.
  let dsa = { problems: {}, log: {}, custom: [] };
  let seed = 7;
  const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const queue = PROBLEMS.filter((p) => !p.premium && p.diff !== 'H').slice(0, 30);
  let next = 0;
  for (let d = 42; d >= 1; d--) {
    const day = addDays(today, -d);
    if (rand() < 0.3) continue;
    const due = Object.entries(dsa.problems).filter(([, s]) => s.due <= day).slice(0, 2);
    for (const [slug] of due) dsa = practice(dsa, slug, rand() < 0.7 ? 3 : 2, day);
    const fresh = rand() < 0.75 ? 1 : 0;
    for (let i = 0; i < fresh && next < queue.length; i++) {
      dsa = practice(dsa, queue[next++].slug, rand() < 0.2 ? 1 : rand() < 0.5 ? 2 : 3, day);
    }
  }

  return {
    version: 1, sample: true,
    settings: { name: '', canvasUrl: '', proxyUrl: '', dailyNew: 2, dailyReview: 3, interviewDate: addDays(today, 4),
      interviewLabel: 'Capital One Power Day', hidden: [] },
    canvas, done: {}, tasks, apps, dsa,
  };
}
