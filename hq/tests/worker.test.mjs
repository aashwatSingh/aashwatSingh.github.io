import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../proxy/worker.js';

const ENV = { CANVAS_URL: 'https://canvas.example.edu', ALLOWED_ORIGIN: 'https://aashwatsingh.github.io' };
const HQ = 'https://aashwatsingh.github.io';

async function withFetch(fake, fn) {
  const real = globalThis.fetch;
  globalThis.fetch = fake;
  try { return await fn(); } finally { globalThis.fetch = real; }
}

test('preflight is answered for HQ only', async () => {
  const ok = await worker.fetch(new Request('https://p.dev/api/v1/courses', { method: 'OPTIONS', headers: { Origin: HQ } }), ENV);
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('Access-Control-Allow-Origin'), HQ);
  assert.match(ok.headers.get('Access-Control-Allow-Headers'), /Authorization/);
  const evil = await worker.fetch(new Request('https://p.dev/api/v1/courses', { headers: { Origin: 'https://evil.example' } }), ENV);
  assert.equal(evil.status, 403);
});

test('forwards GET /api/v1 with the token and passes Link through', async () => {
  const seen = [];
  const res = await withFetch(async (url, opts) => {
    seen.push({ url, opts });
    return new Response('[1]', { status: 200, headers: { 'Content-Type': 'application/json', Link: '<https://canvas.example.edu/api/v1/courses?page=2>; rel="next"' } });
  }, () => worker.fetch(new Request('https://p.dev/api/v1/courses?per_page=100', { headers: { Origin: HQ, Authorization: 'Bearer abc~123' } }), ENV));
  assert.equal(res.status, 200);
  assert.equal(await res.text(), '[1]');
  assert.equal(seen[0].url, 'https://canvas.example.edu/api/v1/courses?per_page=100');
  assert.equal(seen[0].opts.headers.Authorization, 'Bearer abc~123');
  assert.match(res.headers.get('Link'), /page=2/);
  assert.equal(res.headers.get('Access-Control-Expose-Headers'), 'Link');
});

test('refuses other paths, other methods, missing tokens and a missing CANVAS_URL', async () => {
  const req = (path, init = {}) => new Request(`https://p.dev${path}`, { ...init, headers: { Origin: HQ, Authorization: 'Bearer t', ...(init.headers || {}) } });
  const never = async () => { throw new Error('should not be called'); };
  await withFetch(never, async () => {
    assert.equal((await worker.fetch(req('/login'), ENV)).status, 404);
    assert.equal((await worker.fetch(req('/api/v1/../../login'), ENV)).status, 404);
    assert.equal((await worker.fetch(req('/api/v1/courses', { method: 'POST', body: 'x' }), ENV)).status, 404);
    assert.equal((await worker.fetch(new Request('https://p.dev/api/v1/courses', { headers: { Origin: HQ } }), ENV)).status, 401);
    assert.equal((await worker.fetch(req('/api/v1/courses'), { ALLOWED_ORIGIN: HQ })).status, 500);
  });
});
