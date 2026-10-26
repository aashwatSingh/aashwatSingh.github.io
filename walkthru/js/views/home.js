// Home, the "How it works" page and the demo loader.

import { html, $, toast } from '../ui.js';
import { buildDemo, DEMO_PROPERTY_ID } from '../demo.js';
import { callout } from './common.js';
import { clearDiffCache } from '../imaging.js';

export function render(main, params, ctx) {
  const hasDemo = Boolean(ctx.state.properties[DEMO_PROPERTY_ID]);
  const props = Object.values(ctx.state.properties);
  main.innerHTML = String(html`
    <section class="hero">
      <div>
        <div class="eyebrow">Move-in and move-out inspections for student housing</div>
        <h1>Finished in minutes, not weeks.</h1>
        <p class="lede">Residents film each room from a QR code on the door, in the phone's browser. Every photo is fingerprinted the moment it is taken. Staff review only what changed, and charges build themselves from the rate sheet, split among roommates.</p>
        <ol class="steps" aria-label="How Walkthru works">
          <li><b>Scan</b>The QR code on the door opens the walkthrough. No app, no login.</li>
          <li><b>Film</b>Room by room, with a ghost of the last photo to line up the shot.</li>
          <li><b>Lock</b>Each photo is hashed and timestamped. The record is sealed on submit.</li>
          <li><b>Review</b>Staff see only what changed and confirm every charge.</li>
        </ol>
      </div>
      <div class="roles">
        <a class="role" href="${hasDemo ? '#/start/u_demo310' : '#/demo?then=resident'}">
          <div class="bar" style="background: var(--green)"></div>
          <b>Try it as a resident</b>
          <span class="muted">Do Alex's move-out from unit 310 of the demo property, with the ghost overlay. Works best on a phone.</span>
        </a>
        <a class="role" href="${hasDemo ? `#/office/review/i_demo204_out` : '#/demo?then=review'}">
          <div class="bar" style="background: var(--yellow)"></div>
          <b>Try it as staff</b>
          <span class="muted">Review unit 204's move-out in clipboard mode: five planted changes among 31 photos, then settle the deposits.</span>
        </a>
        <a class="role" href="#/office">
          <div class="bar" style="background: var(--blue)"></div>
          <b>Set up a property</b>
          <span class="muted">${props.length ? `${props.length} ${props.length === 1 ? 'property' : 'properties'} in this browser.` : 'Add your own property, units and rate sheet, then print the door QR codes.'}</span>
        </a>
        ${callout('caution', 'Prototype', html`<p>Everything is stored in this browser only. The auto-draft is a pixel comparison, not a vision model. Texas rules are summaries, not legal advice.</p>`)}
      </div>
    </section>
  `);
}

export function about(main) {
  main.innerHTML = String(html`
    <div class="eyebrow">Owner's manual, short version</div>
    <h1>How it works</h1>
    <p class="lede">Walkthru gives a student housing operator and its residents one shared, verifiable record of each unit's condition, so deposit decisions rest on evidence instead of memory.</p>

    <h2>Five steps from door to deposit</h2>
    <ol class="steps">
      <li><b>Scan</b>A QR code on each door opens the capture page for that unit.</li>
      <li><b>Film</b>The resident shoots each checklist item: the high-dispute spots like baseboards, carpet corners, drip pans, caulk and blinds.</li>
      <li><b>Draft</b>Each move-out photo is compared with the baseline photo of the same spot, and changes are drafted as charges.</li>
      <li><b>Lock</b>Photos are SHA-256 hashed at capture, chained, and the submission is sealed.</li>
      <li><b>Charge</b>Staff approve, edit or waive each line. Charges split among roommates and the statement cites the Texas deadline.</li>
    </ol>

    <h2>Trust system</h2>
    <div class="grid">
      <div class="card"><h3>Hash</h3><p>A SHA-256 fingerprint of every photo, taken the moment it is captured. Change one pixel and it no longer matches.</p></div>
      <div class="card"><h3>Chain and seal</h3><p>Each entry's hash includes the one before it, and the seal covers the whole chain, so entries can't be added, dropped or edited later.</p></div>
      <div class="card"><h3>Clock check</h3><p>The capture time comes from the phone, and the web server's clock is recorded beside it, so a phone set to the wrong date shows up.</p></div>
      <div class="card"><h3>Human sign-off</h3><p>The draft only suggests. A person confirms every charge, and wear and tear is never charged.</p></div>
    </div>
    ${callout('warning', 'Limits', html`<p>No system makes fraud impossible. A hash proves a photo wasn't edited after capture; it can't prove the photo was honest to begin with. This prototype flags photos picked from the library instead of taken live, but it does not yet detect photos of screens.</p>`)}

    <h2>What is real in this prototype</h2>
    <div class="table-box"><table>
      <thead><tr><th>Part</th><th>In the prototype</th><th>In production</th></tr></thead>
      <tbody>
        <tr><td>Capture</td><td>Live camera in the browser, ghost overlay, file fallback</td><td>Same, plus live prompts and recapture detection</td></tr>
        <tr><td>Fingerprints</td><td>Real SHA-256, hash chain and seal (Web Crypto)</td><td>Same, with server-signed timestamps</td></tr>
        <tr><td>Storage</td><td>This browser (IndexedDB), with optional sync through your own Supabase project; sealed files work offline</td><td>Same, with accounts and per-lease access</td></tr>
        <tr><td>Auto-draft</td><td>Pixel comparison with lighting and alignment correction</td><td>Feature matching plus a vision model</td></tr>
        <tr><td>Charges</td><td>Rate sheet, roommate split, Texas Ch. 92 deadline</td><td>Same, more states, export to property software</td></tr>
      </tbody>
    </table></div>
    <p class="small muted">Built from the Walkthru roadmap and owner's manual. Source and docs: <span class="mono">walkthru/README.md</span> in the repository.</p>
  `);
}

export async function loadDemo(main, params, ctx) {
  const then = params.query.get('then');
  main.innerHTML = String(html`
    <h1>Loading the demo property</h1>
    <p class="lede">Drawing the demo photos, fingerprinting each one and sealing the records. This takes a few seconds.</p>
    <div class="progressbar" role="progressbar" aria-label="Demo progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div>
    <p class="muted small" id="demo-count">Starting…</p>
  `);
  const bar = $('.progressbar', main);
  await buildDemo(ctx.state, ctx.now(), (done, total) => {
    const pct = Math.round((done / total) * 100);
    bar.setAttribute('aria-valuenow', pct);
    $('i', bar).style.width = `${pct}%`;
    $('#demo-count').textContent = `${done} of ${total} photos`;
  });
  clearDiffCache();
  await ctx.save();
  toast('Demo property loaded.');
  ctx.go(then === 'resident' ? '#/start/u_demo310' : then === 'review' ? '#/office/review/i_demo204_out' : `#/office/p/${DEMO_PROPERTY_ID}`);
}
