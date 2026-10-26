// Canvas: pull the data (on Canvas through the bookmarklet, or from here through the proxy),
// pack it into a URL fragment, clean it on arrival, and turn it into HQ items.
//
// pullCanvas, canvasGet and packPayload must stay self-contained: no imports, no outer variables,
// semicolons everywhere and no line comments inside, because the bookmarklet embeds their source
// text (Function.prototype.toString) and runs it on the Canvas page.

/**
 * GET a Canvas API path. Lists follow `Link: rel="next"` pages. `base` is '' on Canvas itself
 * (same origin, your login cookie), or the proxy / Canvas address with a token from HQ.
 */
export async function canvasGet(path, base, token, fetchFn) {
  let url = base + path;
  let out = null;
  for (let page = 0; url && page < 25; page++) {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    const res = await fetchFn(url, { headers: headers, credentials: token ? 'omit' : 'same-origin' });
    if (!res.ok) {
      const err = new Error('Canvas answered ' + res.status + ' for ' + path.split('?')[0]);
      err.status = res.status;
      throw err;
    }
    const text = (await res.text()).replace(/^while\(1\);/, '');
    let data;
    try { data = JSON.parse(text); } catch (e) {
      throw new Error('Canvas did not send data for ' + path.split('?')[0] + '. Are you logged in?');
    }
    if (!Array.isArray(data)) return data;
    out = (out || []).concat(data);
    const next = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get('Link') || '');
    url = next ? base + next[1].replace(/^https?:\/\/[^/]+/, '') : null;
  }
  return out;
}

/**
 * Everything HQ needs from Canvas, trimmed to the fields it uses. `get(path)` returns parsed
 * JSON (see canvasGet). `origin` is the Canvas address that relative links resolve against.
 */
export async function pullCanvas(get, now, origin) {
  const day = 864e5;
  const iso = (t) => new Date(t).toISOString();
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const arr = (v) => (Array.isArray(v) ? v : []);
  const errors = [];
  const soft = (path) => get(path).catch((e) => { errors.push(String((e && e.message) || e)); return []; });

  const both = await Promise.all([
    get('/api/v1/users/self').catch(() => ({})),
    get('/api/v1/courses?enrollment_state=active&include[]=total_scores&include[]=term&per_page=100'),
  ]);
  const self = both[0] || {};
  const live = arr(both[1]).filter((c) => {
    if (!c || !c.id || c.access_restricted_by_date) return false;
    const end = (c.term && c.term.end_at) || c.end_at;
    return !end || Date.parse(end) > now - 14 * day;
  });

  const rest = await Promise.all([
    soft('/api/v1/planner/items?start_date=' + iso(now - 21 * day) + '&end_date=' + iso(now + 120 * day) + '&per_page=100'),
    soft('/api/v1/users/self/missing_submissions?per_page=100&filter[]=submittable'),
    Promise.all(live.map((c) => soft('/api/v1/courses/' + c.id + '/assignment_groups?include[]=assignments&per_page=100')
      .then((gs) => ({ id: c.id, gs: arr(gs) })))),
  ]);

  const sub = (s) => (s && typeof s === 'object'
    ? { s: !!s.submitted, m: !!s.missing, l: !!s.late, g: !!s.graded, x: !!s.excused } : null);

  return {
    v: 1,
    at: iso(now),
    origin: origin,
    user: self.short_name || self.name || '',
    errors: errors,
    courses: live.map((c) => {
      const e = arr(c.enrollments).find((x) => /student/i.test(x.type || x.role || '')) || {};
      return {
        id: c.id, name: c.name || '', code: c.course_code || '', term: (c.term && c.term.name) || '',
        score: num(e.computed_current_score), grade: e.computed_current_grade || null,
        weighted: !!c.apply_assignment_group_weights,
      };
    }),
    groups: rest[2].flatMap((x) => x.gs.map((g) => ({
      id: g.id, course: x.id, name: g.name || '', weight: num(g.group_weight) || 0,
      a: arr(g.assignments).filter((a) => !a.omit_from_final_grade).map((a) => [a.id, num(a.points_possible) || 0]),
    }))),
    planner: arr(rest[0]).filter((p) => p && p.plannable_type !== 'announcement').map((p) => {
      const pl = p.plannable || {};
      const ov = p.planner_override || {};
      return {
        type: p.plannable_type || '', id: p.plannable_id,
        aid: pl.assignment_id || (p.plannable_type === 'assignment' ? p.plannable_id : null),
        course: p.course_id || null, ctx: p.context_name || '', title: pl.title || pl.name || '',
        due: pl.due_at || pl.todo_date || pl.start_at || p.plannable_date || null, end: pl.end_at || null,
        url: p.html_url || '', pts: num(pl.points_possible), sub: sub(p.submissions),
        done: !!ov.marked_complete, gone: !!ov.dismissed,
      };
    }),
    missing: arr(rest[1]).map((a) => ({
      id: a.id, course: a.course_id || null, title: a.name || '', due: a.due_at || null,
      url: a.html_url || '', pts: num(a.points_possible),
    })),
  };
}

/** JSON → (gzip when the browser can) → base64url, with a one-letter format tag. */
export async function packPayload(obj) {
  let bytes = new TextEncoder().encode(JSON.stringify(obj));
  let tag = 'j';
  if (typeof CompressionStream === 'function') {
    const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
    bytes = new Uint8Array(await new Response(stream).arrayBuffer());
    tag = 'z';
  }
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return tag + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const MAX_PAYLOAD = 8e6;

/** The reverse of packPayload. Refuses anything that unpacks to more than 8 MB. */
export async function unpackPayload(text) {
  const tag = text[0];
  const bin = atob(text.slice(1).replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  if (tag === 'j') return JSON.parse(new TextDecoder().decode(bytes));
  if (tag !== 'z') throw new Error('Unknown sync format');
  const reader = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')).getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > MAX_PAYLOAD) {
      await reader.cancel();
      throw new Error('Sync data is too large');
    }
    chunks.push(value);
  }
  return JSON.parse(await new Blob(chunks).text());
}

/** The source of the sync bookmarklet, which opens `hqUrl` with the data in its fragment. */
export function bookmarkletSource(hqUrl) {
  return `(async () => {
  const HQ = ${JSON.stringify(hqUrl)};
  const canvasGet = ${canvasGet.toString()};
  const pullCanvas = ${pullCanvas.toString()};
  const packPayload = ${packPayload.toString()};
  const old = document.getElementById('comet-hq-sync');
  if (old) old.remove();
  const box = document.createElement('div');
  box.id = 'comet-hq-sync';
  box.setAttribute('role', 'status');
  box.style.cssText = 'position:fixed;z-index:2147483647;right:16px;bottom:16px;max-width:340px;padding:14px 16px;border-radius:12px;background:#1d1b18;color:#efebe5;font:14px/1.45 system-ui,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
  box.textContent = 'Comet HQ: reading Canvas…';
  document.body.appendChild(box);
  try {
    const data = await pullCanvas((p) => canvasGet(p, '', null, (u, o) => fetch(u, o)), Date.now(), location.origin);
    const url = HQ + '#canvas=' + await packPayload(data);
    const n = data.planner.length + data.missing.length;
    box.textContent = 'Read ' + data.courses.length + ' courses and ' + n + ' items. ';
    const a = document.createElement('a');
    a.href = url;
    a.target = 'comet-hq';
    a.textContent = 'Open Comet HQ →';
    a.style.cssText = 'color:#fb8a3c;font-weight:700';
    a.addEventListener('click', () => setTimeout(() => box.remove(), 500));
    box.appendChild(a);
    if (window.open(url, 'comet-hq')) setTimeout(() => box.remove(), 4000);
  } catch (e) {
    box.textContent = 'Comet HQ could not read Canvas: ' + ((e && e.message) || e) + ' Run this on a Canvas page while you are logged in.';
    setTimeout(() => box.remove(), 12000);
  }
})();`;
}

/** The bookmarklet itself, ready for an <a href>. */
export function bookmarklet(hqUrl) {
  return 'javascript:' + encodeURIComponent(bookmarkletSource(hqUrl));
}

// ---------------------------------------------------------------- cleaning what arrives

const ORIGIN_RE = /^https:\/\/[a-z0-9.-]+(:\d+)?$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;
const TYPES = new Set(['assignment', 'quiz', 'discussion_topic', 'calendar_event', 'planner_note', 'wiki_page',
  'assessment_request', 'sub_assignment']);

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const idOf = (v) => ((typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'string' && /^\d{1,24}$/.test(v))
  ? String(v) : null);
const when = (v) => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);
const list = (v, max) => (Array.isArray(v) ? v.slice(0, max) : []);

/** An https link (or a local test server), resolved against `origin`; '' for anything else. */
export function safeUrl(url, origin) {
  if (typeof url !== 'string' || !url) return '';
  try {
    const u = new URL(url, origin);
    if (u.protocol === 'https:' || (u.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(u.hostname))) return u.href.slice(0, 600);
  } catch { /* not a URL */ }
  return '';
}

/** A valid Canvas payload with every field checked, or null. The fragment can come from any link. */
export function cleanCanvas(raw) {
  if (!raw || typeof raw !== 'object' || raw.v !== 1) return null;
  const origin = typeof raw.origin === 'string' && ORIGIN_RE.test(raw.origin) ? raw.origin.toLowerCase() : null;
  const at = when(raw.at);
  if (!origin || !at) return null;
  const sub = (x) => (x && typeof x === 'object'
    ? { s: x.s === true, m: x.m === true, l: x.l === true, g: x.g === true, x: x.x === true } : null);
  return {
    v: 1, at, origin, user: str(raw.user, 80),
    errors: list(raw.errors, 20).map((e) => str(e, 200)).filter(Boolean),
    courses: list(raw.courses, 60).filter((c) => c && idOf(c.id)).map((c) => ({
      id: idOf(c.id), name: str(c.name, 200), code: str(c.code, 100), term: str(c.term, 100),
      score: num(c.score), grade: str(c.grade, 8) || null, weighted: c.weighted === true,
    })),
    groups: list(raw.groups, 800).filter((g) => g && idOf(g.id) && idOf(g.course)).map((g) => ({
      id: idOf(g.id), course: idOf(g.course), name: str(g.name, 120), weight: Math.max(0, num(g.weight) || 0),
      a: list(g.a, 500).filter((x) => Array.isArray(x) && idOf(x[0])).map((x) => [idOf(x[0]), Math.max(0, num(x[1]) || 0)]),
    })),
    planner: list(raw.planner, 2000).filter((p) => p && idOf(p.id) && TYPES.has(p.type)).map((p) => ({
      type: p.type, id: idOf(p.id), aid: idOf(p.aid), course: idOf(p.course), ctx: str(p.ctx, 200),
      title: str(p.title, 300).trim() || 'Untitled', due: when(p.due), end: when(p.end), url: safeUrl(p.url, origin),
      pts: num(p.pts), sub: sub(p.sub), done: p.done === true, gone: p.gone === true,
    })),
    missing: list(raw.missing, 500).filter((m) => m && idOf(m.id)).map((m) => ({
      id: idOf(m.id), course: idOf(m.course), title: str(m.title, 300).trim() || 'Untitled', due: when(m.due),
      url: safeUrl(m.url, origin), pts: num(m.pts),
    })),
  };
}

// ---------------------------------------------------------------- turning it into items

/**
 * Each assignment's estimated share of the final grade, in percent, keyed by assignment id.
 * Weighted courses: group weight × the assignment's share of its group's points, with weights
 * rescaled over groups that have points. Unweighted courses: points over all points.
 * Drop-lowest rules and extra credit are ignored, so it is an estimate.
 */
export function gradeWeights(courses, groups) {
  const out = new Map();
  const points = (g) => g.a.reduce((s, [, p]) => s + p, 0);
  for (const c of courses) {
    const gs = groups.filter((g) => g.course === c.id);
    if (c.weighted) {
      const total = gs.reduce((s, g) => s + (points(g) > 0 ? g.weight : 0), 0);
      if (total <= 0) continue;
      for (const g of gs) {
        const p = points(g);
        if (p <= 0 || g.weight <= 0) continue;
        for (const [id, pts] of g.a) out.set(id, (g.weight / total) * (pts / p) * 100);
      }
    } else {
      const total = gs.reduce((s, g) => s + points(g), 0);
      if (total <= 0) continue;
      for (const g of gs) for (const [id, pts] of g.a) out.set(id, (pts / total) * 100);
    }
  }
  return out;
}

const EXAM_RE = /\b(exams?|midterms?)\b|\btest\s*#?\d|^\s*final\s*$/i;
const NOT_EXAM_RE = /\b(practice|review|study|prep|sample|mock|corrections?|reflection|guide|wrapper|request|sign[- ]?up)\b/i;
const PROJECT_RE = /\b(project|presentation|report|paper|essay|proposal|demo|portfolio)\b/i;
const QUIZ_RE = /\bquiz(zes)?\b/i;

/** What kind of work a Canvas item is, from its type and title. */
export function kindOf(type, title = '') {
  if (type === 'planner_note') return 'note';
  if (type === 'assessment_request') return 'review';
  if (type === 'wiki_page') return 'page';
  if (EXAM_RE.test(title) && !NOT_EXAM_RE.test(title)) return 'exam';
  if (PROJECT_RE.test(title) && type !== 'calendar_event') return 'project';
  if (type === 'quiz' || QUIZ_RE.test(title)) return 'quiz';
  if (type === 'discussion_topic') return 'discussion';
  if (type === 'calendar_event') return 'event';
  return 'assignment';
}

/** "CS 3345" from a Canvas course code or name, else a trimmed code. */
export function shortCode(course) {
  if (!course) return '';
  const m = /\b([A-Z]{2,4})[\s_-]?(\d{4})\b/.exec(`${course.code} ${course.name}`);
  return m ? `${m[1]} ${m[2]}` : (course.code || course.name || '').slice(0, 16);
}

/**
 * HQ items from a cleaned payload. `done` holds keys you checked off in HQ; `hidden` holds course
 * ids you chose not to see. Non-submittable things (events, ungraded pages) count as past once over.
 */
export function canvasItems(canvas, { done = {}, hidden = [], now = Date.now() } = {}) {
  if (!canvas) return [];
  const weights = gradeWeights(canvas.courses, canvas.groups);
  const courses = new Map(canvas.courses.map((c) => [c.id, c]));
  const hide = new Set(hidden);
  const items = new Map();
  const make = (key, kind, x, status, canvasDone) => {
    const course = courses.get(x.course);
    const due = x.due ? Date.parse(x.due) : null;
    const end = x.end ? Date.parse(x.end) : null;
    const submittable = Boolean(status);
    const over = end ?? due;
    const s = status || {};
    return {
      key, src: 'canvas', kind, title: x.title, url: x.url,
      courseId: x.course, sub: course ? shortCode(course) : x.ctx || '', courseName: course?.name || x.ctx || '',
      due, pts: x.pts, weight: x.aid ? weights.get(x.aid) ?? null : null, courseScore: course?.score ?? null,
      missing: s.m === true, late: s.l === true, submitted: s.s === true, graded: s.g === true, excused: s.x === true,
      canvasDone, localDone: Boolean(done[key]),
      past: !submittable && kind !== 'note' && over != null && over < now,
      done: Boolean(s.s || s.g || s.x || canvasDone || done[key]),
    };
  };
  for (const p of canvas.planner) {
    if (p.course && hide.has(p.course)) continue;
    const key = p.aid ? `c:a:${p.aid}` : `c:${p.type}:${p.id}`;
    items.set(key, make(key, kindOf(p.type, p.title), p, p.sub, p.done || p.gone));
  }
  for (const m of canvas.missing) {
    if (m.course && hide.has(m.course)) continue;
    const key = `c:a:${m.id}`;
    const have = items.get(key);
    if (have) { if (!have.submitted) have.missing = true; continue; }
    items.set(key, make(key, kindOf('assignment', m.title), { ...m, aid: m.id }, { m: true }, false));
  }
  return [...items.values()];
}

/** One row per course: grade, open items and the next thing due. */
export function courseSummaries(canvas, items, hidden = []) {
  if (!canvas) return [];
  const hide = new Set(hidden);
  return canvas.courses.map((c) => {
    const open = items.filter((i) => i.courseId === c.id && !i.done && !i.past);
    const next = open.filter((i) => i.due != null).sort((a, b) => a.due - b.due)[0] || null;
    return { id: c.id, code: shortCode(c), name: c.name, term: c.term, score: c.score, grade: c.grade, open: open.length,
      missing: open.filter((i) => i.missing).length, next, hidden: hide.has(c.id) };
  });
}
