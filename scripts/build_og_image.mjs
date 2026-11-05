// Builds og-image.png: the 1200×630 card LinkedIn, Slack and others show when the site is shared.
// Edit the text below to match index.html's header, then run:
//
//   node scripts/build_og_image.mjs
//
// Needs Playwright (the same one the browser smoke tests use). Set PLAYWRIGHT_MODULE to use one
// installed elsewhere.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = await import('playwright').catch(() => require(process.env.PLAYWRIGHT_MODULE || 'playwright'));

const card = {
  name: 'Aashwat Singh',
  role: 'Software engineering · applied AI/ML',
  line: 'Computer Science, UT Dallas · Seeking Summer 2027 internships',
  url: 'aashwatsingh.github.io',
};

const esc = (s) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; background: #f7f5f2; color: #1d1b18;
    font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  .card { position: relative; height: 100%; padding: 92px 96px; display: flex; flex-direction: column; }
  .bar { position: absolute; left: 0; top: 0; bottom: 0; width: 18px; background: #c2410c; }
  h1 { font-size: 96px; font-weight: 800; letter-spacing: -0.035em; line-height: 1; }
  .role { margin-top: 26px; font-size: 42px; font-weight: 650; color: #c2410c; letter-spacing: -0.01em; }
  .line { margin-top: 18px; font-size: 32px; color: #6b655c; }
  .foot { margin-top: auto; display: flex; justify-content: space-between; align-items: center; }
  .url { font-size: 30px; font-weight: 600; color: #1d1b18; }
  .mark { width: 92px; height: 92px; border-radius: 20px; background: #c2410c; color: #fff; display: grid;
    place-items: center; font-size: 40px; font-weight: 800; letter-spacing: -0.03em; }
</style></head><body><div class="card">
  <div class="bar"></div>
  <h1>${esc(card.name)}</h1>
  <p class="role">${esc(card.role)}</p>
  <p class="line">${esc(card.line)}</p>
  <div class="foot"><span class="url">${esc(card.url)}</span><span class="mark">AS</span></div>
</div></body></html>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(html);
  const out = new URL('../og-image.png', import.meta.url);
  await page.screenshot({ path: out.pathname, type: 'png' });
  console.log(`wrote ${out.pathname}`);
} finally {
  await browser.close();
}
