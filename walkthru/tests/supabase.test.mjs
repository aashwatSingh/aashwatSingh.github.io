// Tests for walkthru/supabase/schema.sql, run against real Postgres compiled to WebAssembly
// (PGlite). Skipped when PGlite isn't installed, so `node --test` works with no setup.
//
//   npm install --no-save @electric-sql/pglite      (once, from the repository root)
//
// Set PGLITE_MODULE to use an install elsewhere. Every call runs as the `anon` role, the role a
// web page gets on Supabase, so these also check that the tables are closed to it.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
async function loadPGlite() {
  try { return (await import('@electric-sql/pglite')).PGlite; } catch { /* try the env path */ }
  try { return (await import(require.resolve(process.env.PGLITE_MODULE || '@electric-sql/pglite'))).PGlite; } catch { return null; }
}
const PGlite = await loadPGlite();
const SKIP = PGlite ? false : 'PGlite not installed (npm install --no-save @electric-sql/pglite)';
const SCHEMA = fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8');

const secret = () => randomBytes(32).toString('base64url');
const sha = (b) => createHash('sha256').update(b).digest('hex');

/** A fresh database with Supabase's anon role and the schema loaded. */
async function db() {
  const pg = new PGlite();
  await pg.exec("create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;");
  await pg.exec(SCHEMA);
  await pg.exec(SCHEMA); // running it twice must be safe
  const call = async (fn, ...args) => {
    const params = args.map((_, i) => `$${i + 1}`).join(', ');
    await pg.exec('set role anon');
    try {
      const res = await pg.query(`select public.${fn}(${params}) as r`, args);
      return res.rows[0].r;
    } finally {
      await pg.exec('reset role');
    }
  };
  const asAnon = async (sql) => {
    await pg.exec('set role anon');
    try { return await pg.query(sql); } finally { await pg.exec('reset role'); }
  };
  return { pg, call, asAnon };
}

const sealHex = 'a'.repeat(64);
const docs = (unitId = 'u_1') => [
  { kind: 'property', id: 'p_1', body: { id: 'p_1', name: 'Hall', rates: [] } },
  { kind: 'unit', id: unitId, body: { id: unitId, propertyId: 'p_1', label: '1', template: 'studio', residents: [{ id: 'r_1', name: 'Sam', bedroom: null, depositCents: 50000 }] } },
  { kind: 'inspection', id: 'i_1', body: { id: 'i_1', unitId, kind: 'move-out', openedAt: 'x', lockAt: 'y', surrenderDate: '2027-05-15', forwarding: { r_1: true }, review: { decisions: { 'living.walls': { action: 'charge', cents: 3500 } }, finalizedAt: null } } },
];

test('anon cannot touch the tables or helpers directly', { skip: SKIP }, async () => {
  const { asAnon } = await db();
  for (const sql of ['select * from wt_docs', 'select * from wt_spaces', 'select * from wt_photos', 'select * from wt_unit_tokens',
    "insert into wt_spaces (space_hash) values (repeat('a', 64))", "select wt_resolve('x')", "select wt_digest('x')"]) {
    await assert.rejects(asAnon(sql), /permission denied/, sql);
  }
});

test('keys must be long and known', { skip: SKIP }, async () => {
  const { call } = await db();
  await assert.rejects(call('wt_create_space', 'short', ''), /at least 32/);
  await assert.rejects(call('wt_pull', 'short', 0), /not valid/);
  await assert.rejects(call('wt_pull', secret(), 0), /not recognised/);
});

test('push and pull with a sync key', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  assert.deepEqual(await call('wt_create_space', key, 'Hall'), { ok: true });
  assert.deepEqual(await call('wt_create_space', key, 'Hall'), { ok: true }); // idempotent
  const res = await call('wt_push', key, JSON.stringify(docs()));
  assert.equal(res.saved, 3);
  const all = await call('wt_pull', key, 0);
  assert.equal(all.docs.length, 3);
  assert.equal(all.more, false);
  assert.equal(all.docs[1].body.residents[0].depositCents, 50000); // the office sees everything
  // Unchanged docs are not re-sent; a changed one moves to the end.
  assert.equal((await call('wt_push', key, JSON.stringify(docs()))).saved, 0);
  const changed = docs();
  changed[0].body.name = 'Hall 2';
  assert.equal((await call('wt_push', key, JSON.stringify(changed))).saved, 1);
  const next = await call('wt_pull', key, all.last);
  assert.deepEqual(next.docs.map((d) => d.id), ['p_1']);
  assert.equal((await call('wt_pull', key, next.last)).docs.length, 0);
  // Another space sees nothing.
  const other = secret();
  await call('wt_create_space', other, '');
  assert.equal((await call('wt_pull', other, 0)).docs.length, 0);
});

test('malformed documents are skipped, not stored', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  await call('wt_create_space', key, '');
  const res = await call('wt_push', key, JSON.stringify([
    { kind: 'castle', id: 'x', body: { id: 'x' } },
    { kind: 'unit', id: 'bad id', body: { id: 'bad id' } },
    { kind: 'unit', id: 'u_2', body: { id: 'u_3' } },
    { kind: 'submission', id: 's_1', body: { id: 's_1', unitId: 'u_1' } },
  ]));
  assert.equal(res.saved, 0);
  assert.deepEqual(res.skipped.map((s) => s.reason), ['malformed', 'malformed', 'malformed', 'not sealed']);
  await assert.rejects(call('wt_push', key, JSON.stringify({ not: 'an array' })), /at most 500/);
});

test('a sealed submission can be added but never changed', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  await call('wt_create_space', key, '');
  const sub = { kind: 'submission', id: 's_1', body: { id: 's_1', unitId: 'u_1', seal: sealHex, entries: [] } };
  assert.equal((await call('wt_push', key, JSON.stringify([sub]))).saved, 1);
  assert.equal((await call('wt_push', key, JSON.stringify([sub]))).saved, 0);
  const forged = structuredClone(sub);
  forged.body.seal = 'b'.repeat(64);
  const res = await call('wt_push', key, JSON.stringify([forged]));
  assert.equal(res.saved, 0);
  assert.match(res.skipped[0].reason, /different sealed record/);
  const pulled = await call('wt_pull', key, 0);
  assert.equal(pulled.docs[0].body.seal, sealHex);
});

test('photos: the server checks the fingerprint', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  await call('wt_create_space', key, '');
  const bytes = randomBytes(5000);
  const hash = sha(bytes);
  assert.deepEqual(await call('wt_missing_photos', key, [hash]), [hash]);
  await assert.rejects(call('wt_put_photo', key, hash, 'image/jpeg', randomBytes(10).toString('base64')), /does not match/);
  await assert.rejects(call('wt_put_photo', key, hash, 'text/html', bytes.toString('base64')), /JPEG, PNG or WebP/);
  assert.deepEqual(await call('wt_put_photo', key, hash, 'image/jpeg', bytes.toString('base64')), { ok: true });
  assert.deepEqual(await call('wt_put_photo', key, hash, 'image/jpeg', bytes.toString('base64')), { ok: true }); // again: fine
  assert.deepEqual(await call('wt_missing_photos', key, [hash]), []);
  const got = await call('wt_get_photo', key, hash);
  assert.equal(got.type, 'image/jpeg');
  assert.equal(sha(Buffer.from(got.b64, 'base64')), hash);
  assert.equal(await call('wt_get_photo', key, 'c'.repeat(64)), null);
});

test('door codes are limited to their own unit', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  const door = secret();
  await call('wt_create_space', key, '');
  await call('wt_push', key, JSON.stringify([...docs('u_1'), ...docs('u_2').slice(1).map((d) => ({ ...d, id: d.kind === 'inspection' ? 'i_2' : d.id, body: { ...d.body, id: d.kind === 'inspection' ? 'i_2' : d.body.id } }))]));
  await assert.rejects(call('wt_add_unit_token', door, 'u_1', secret()), /not recognised/);
  assert.deepEqual(await call('wt_add_unit_token', key, 'u_1', door), { ok: true });
  await assert.rejects(call('wt_add_unit_token', door, 'u_1', secret()), /only the office/);

  // Reads: its property, unit and inspections only, with deposits and decisions removed.
  const seen = await call('wt_pull', door, 0);
  assert.deepEqual(seen.docs.map((d) => `${d.kind}:${d.id}`).sort(), ['inspection:i_1', 'property:p_1', 'unit:u_1']);
  const unit = seen.docs.find((d) => d.kind === 'unit').body;
  assert.equal(unit.residents[0].name, 'Sam');
  assert.equal(unit.residents[0].depositCents, 0);
  const insp = seen.docs.find((d) => d.kind === 'inspection').body;
  assert.deepEqual(insp.review.decisions, {});
  assert.equal(insp.surrenderDate, null);

  // Writes: a sealed submission and a new inspection for its unit; nothing else.
  const photo = randomBytes(800);
  const hash = sha(photo);
  const sub = { kind: 'submission', id: 's_9', body: { id: 's_9', unitId: 'u_1', seal: sealHex, entries: [{ photo: { hash } }] } };
  const res = await call('wt_push', door, JSON.stringify([
    sub,
    { kind: 'inspection', id: 'i_new', body: { id: 'i_new', unitId: 'u_1', kind: 'move-in' } },
    { kind: 'inspection', id: 'i_1', body: { id: 'i_1', unitId: 'u_1', kind: 'move-out', review: { decisions: {} } } }, // existing: ignored
    { kind: 'submission', id: 's_8', body: { id: 's_8', unitId: 'u_2', seal: sealHex, entries: [] } },
    docs('u_1')[1],
  ]));
  assert.equal(res.saved, 2);
  assert.deepEqual(res.skipped.map((s) => s.id), ['s_8', 'u_1']);
  const office = await call('wt_pull', key, 0);
  assert.equal(office.docs.find((d) => d.id === 'i_1').body.review.decisions['living.walls'].cents, 3500); // untouched

  // Photos: only ones its unit's submissions use.
  await call('wt_put_photo', door, hash, 'image/png', photo.toString('base64'));
  assert.equal((await call('wt_get_photo', door, hash)).type, 'image/png');
  const stray = randomBytes(500);
  await call('wt_put_photo', key, sha(stray), 'image/jpeg', stray.toString('base64'));
  await assert.rejects(call('wt_get_photo', door, sha(stray)), /not part of this unit/);
});

test('pull pages through large spaces', { skip: SKIP }, async () => {
  const { call } = await db();
  const key = secret();
  await call('wt_create_space', key, '');
  const many = Array.from({ length: 450 }, (_, i) => ({ kind: 'property', id: `p_${i}`, body: { id: `p_${i}`, name: `P${i}` } }));
  assert.equal((await call('wt_push', key, JSON.stringify(many))).saved, 450);
  const a = await call('wt_pull', key, 0);
  assert.equal(a.docs.length, 300);
  assert.equal(a.more, true);
  const b = await call('wt_pull', key, a.last);
  assert.equal(b.docs.length, 150);
  assert.equal(b.more, false);
  assert.equal(new Set([...a.docs, ...b.docs].map((d) => d.id)).size, 450);
});
