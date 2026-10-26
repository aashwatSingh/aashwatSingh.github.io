// A local stand-in for a Supabase project, for trying sync without an account and for the sync
// browser test. It answers POST /rest/v1/rpc/<function> the way Supabase's REST API does, running
// walkthru/supabase/schema.sql in PGlite (real Postgres compiled to WebAssembly) as the anon role.
// Data lives in memory and is gone when it stops.
//
//   npm install --no-save @electric-sql/pglite      (once, from the repository root)
//   node walkthru/tests/supabase-standin.mjs         (prints the URL and key to paste into Sync)
//
// PORT (default 54321) and PGLITE_MODULE can be set in the environment. Not for production.

import http from 'node:http';
import fs from 'node:fs';
import { createRequire } from 'node:module';

export const PUBLIC_KEY = 'sb_publishable_local_standin_key_0000';
const FUNCTIONS = {
  wt_create_space: ['p_key', 'p_name'],
  wt_add_unit_token: ['p_key', 'p_unit_id', 'p_token'],
  wt_push: ['p_secret', 'p_docs'],
  wt_pull: ['p_secret', 'p_since'],
  wt_missing_photos: ['p_secret', 'p_hashes'],
  wt_put_photo: ['p_secret', 'p_hash', 'p_type', 'p_b64'],
  wt_get_photo: ['p_secret', 'p_hash'],
};

async function loadPGlite() {
  const require = createRequire(import.meta.url);
  try { return (await import('@electric-sql/pglite')).PGlite; } catch { /* try the env path */ }
  return (await import(require.resolve(process.env.PGLITE_MODULE || '@electric-sql/pglite'))).PGlite;
}

/** Start the stand-in. Resolves to { url, anon, close }. */
export async function startStandin(port = Number(process.env.PORT) || 54321) {
  const PGlite = await loadPGlite();
  const pg = new PGlite();
  await pg.exec('create role anon nologin; create role authenticated nologin; grant usage on schema public to anon, authenticated;');
  await pg.exec(fs.readFileSync(new URL('../supabase/schema.sql', import.meta.url), 'utf8'));
  let queue = Promise.resolve(); // PGlite runs one query at a time

  const call = (fn, args) => {
    const names = FUNCTIONS[fn];
    const values = names.map((n) => {
      const v = args[n];
      return n === 'p_docs' ? JSON.stringify(v) : v ?? null;
    });
    const sql = `select public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')}) as r`;
    const run = async () => {
      await pg.exec('set role anon');
      try { return (await pg.query(sql, values)).rows[0].r; } finally { await pg.exec('reset role'); }
    };
    const p = queue.then(run, run);
    queue = p.catch(() => {});
    return p;
  };

  const server = http.createServer((req, res) => {
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    const send = (code, body) => {
      res.writeHead(code, { ...cors, 'Content-Type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); res.end(); return; }
    const m = /^\/rest\/v1\/rpc\/(\w+)$/.exec(req.url.split('?')[0]);
    if (req.method !== 'POST' || !m) return send(404, { message: 'Not found' });
    if (req.headers.apikey !== PUBLIC_KEY) return send(401, { message: 'Invalid API key' });
    if (!FUNCTIONS[m[1]]) return send(404, { code: 'PGRST202', message: `Could not find the function public.${m[1]} in the schema cache` });
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      try {
        send(200, await call(m[1], raw ? JSON.parse(raw) : {}));
      } catch (err) {
        send(400, { code: err.code || 'P0001', message: err.message });
      }
    });
  });
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, anon: PUBLIC_KEY, close: () => new Promise((r) => server.close(r)) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await startStandin();
  console.log(`Walkthru sync stand-in running.\n  Project URL: ${s.url}\n  Public key:  ${s.anon}\nPaste both into Office → Sync. Ctrl+C to stop; data is not kept.`);
}
