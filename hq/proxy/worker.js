// Comet HQ Canvas proxy: a Cloudflare Worker that lets HQ call the Canvas API with your token.
//
// Canvas sends no CORS headers, so a page on github.io can't read its API responses directly.
// This Worker forwards GET /api/v1/* to your Canvas and adds CORS headers for HQ's address only.
// It stores nothing and logs nothing: your token passes through in the Authorization header.
//
// Variables (Worker → Settings → Variables and secrets):
//   CANVAS_URL      your Canvas address, e.g. https://elearning.utdallas.edu
//   ALLOWED_ORIGIN  where HQ lives, e.g. https://aashwatsingh.github.io (comma-separated for more)

export default {
  async fetch(request, env) {
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map((s) => s.trim()).filter(Boolean);
    const origin = request.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : allowed[0] || 'null',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Accept',
      'Access-Control-Expose-Headers': 'Link',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };
    const reply = (status, text) => new Response(text, { status, headers: { ...cors, 'Content-Type': 'text/plain' } });

    if (!allowed.includes(origin)) return reply(403, 'This proxy only answers Comet HQ. Check ALLOWED_ORIGIN.');
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(request.url);
    if (request.method !== 'GET' || !url.pathname.startsWith('/api/v1/')) return reply(404, 'Only GET /api/v1/* is forwarded.');
    const auth = request.headers.get('Authorization') || '';
    if (!/^Bearer [\w~.+/=-]+$/.test(auth)) return reply(401, 'Missing Canvas token.');
    const canvas = String(env.CANVAS_URL || '').replace(/\/+$/, '');
    if (!/^https?:\/\/[^/]+$/.test(canvas)) return reply(500, 'Set CANVAS_URL on the Worker, like https://elearning.utdallas.edu');

    const upstream = await fetch(canvas + url.pathname + url.search, {
      headers: { Authorization: auth, Accept: 'application/json' },
      redirect: 'manual',
    });
    const headers = new Headers(cors);
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
    headers.set('Cache-Control', 'no-store');
    const link = upstream.headers.get('Link');
    if (link) headers.set('Link', link);
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};
