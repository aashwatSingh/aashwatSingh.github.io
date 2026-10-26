// Office sync settings: connect this device to a Supabase project, see status, link more devices.

import { html, raw, $, toast, confirmBox, fmtDateTime } from '../ui.js';
import { encodeConnect, decodeConnect } from '../core/payload.js';
import { syncOf, officeOn, createSpace, joinSpace, syncNow, status } from '../sync.js';
import { qrSvg } from '../qr.js';
import { crumbs, callout } from './common.js';

const appBase = () => `${location.origin}${location.pathname}`;

function statusLine() {
  if (status.state === 'syncing') return 'Syncing…';
  if (status.state === 'error') return `Last attempt failed: ${status.error}`;
  if (status.at) {
    const l = status.last || {};
    return `Last synced ${fmtDateTime(new Date(status.at).toISOString())}: ${l.pulled || 0} received, ${l.pushed || 0} sent${l.rejected ? `, ${l.rejected} refused (did not verify)` : ''}.`;
  }
  return 'Not synced yet on this visit.';
}

export function render(main, params, ctx) {
  const s = syncOf(ctx.state);
  const on = officeOn(ctx.state);
  const link = on ? `${appBase()}#/connect/${encodeConnect(s.office)}` : '';
  const rejected = on ? Object.entries(s.office.meta?.rejected || {}) : [];

  main.innerHTML = String(html`
    ${crumbs([['Office', '#/office']])}
    <div class="eyebrow">Shared backend</div>
    <h1>Sync</h1>
    <p class="lede">Connect phones and office computers through your own Supabase project. Residents' sealed records arrive at the office on their own, and every office device sees the same units, reviews and settlements.</p>

    ${on ? html`
      <section class="card strong">
        <div class="row between">
          <h3 style="margin: 0">Connected</h3>
          <span class="chip ${status.state === 'error' ? 'bad' : 'verified'}">${status.state === 'error' ? 'Problem' : 'On'}</span>
        </div>
        <p class="muted small" style="margin-top: 6px">${s.office.url}</p>
        <p id="sync-status" aria-live="polite">${statusLine()}</p>
        <div class="row"><button class="btn primary" id="sync-now">Sync now</button><button class="btn danger small" id="disconnect">Disconnect this device</button></div>
      </section>
      ${rejected.length ? callout('warning', 'Records refused', html`<p>These came from the server but failed verification, so they were not used:</p><ul class="small">${rejected.map(([id, problems]) => html`<li><span class="mono">${id}</span>: ${problems[0]}</li>`)}</ul>`) : ''}

      <h2>Door QR codes</h2>
      <p>Door signs and invites printed from now on carry a door code for their unit. A phone that scans one sends its sealed record straight here and gets the unit's last report for the ghost overlay. A door code can't see other units, deposits or your decisions. Reprint signs made before you connected.</p>

      <h2>Add another office device</h2>
      ${callout('warning', 'Staff only', html`<p>This link holds the sync key: anyone with it can read and change every record in this space. Share it only with staff, and never print it on a door.</p>`)}
      <div class="grid wide">
        <div class="door-sign" style="max-width: 280px; margin: 0">${raw(qrSvg(link, { label: 'QR code to connect another office device' }))}</div>
        <div><p class="hashline">${link}</p><button class="btn ghost small" id="copy-link">Copy link</button></div>
      </div>
    ` : html`
      <section class="card" style="max-width: 640px">
        <h3>Connect to Supabase</h3>
        <p class="small muted">One-time setup, about five minutes: create a free project at supabase.com, run <span class="mono">walkthru/supabase/schema.sql</span> in its SQL editor, then copy the project URL and publishable key from Project Settings → API Keys. Full steps are in the Walkthru README.</p>
        <form id="connect">
          <label class="field"><span>Project URL</span><input type="text" name="url" required placeholder="https://abcd1234.supabase.co" autocomplete="off" spellcheck="false"></label>
          <label class="field"><span>Public key</span><input type="text" name="anon" required placeholder="sb_publishable_… or the anon key" autocomplete="off" spellcheck="false">
            <small>The public (anon or publishable) key is safe in a web page. Never paste the secret or service-role key.</small></label>
          <label class="field"><span>Sync key <small>(leave empty to start a new space)</small></span><input type="text" name="key" placeholder="Only when joining a space another device created" autocomplete="off" spellcheck="false"></label>
          <button class="btn primary">Connect</button>
        </form>
        <p class="small muted" style="margin-top: 12px">Already set up on another office device? Open its "Add another office device" link here instead.</p>
      </section>
      ${callout('note', 'What syncs', html`<p>Your properties, units, rate sheets, inspections, sealed records with their photos, reviews and settlements. Drafts stay on the phone until sealed. The demo property never syncs. Deleting isn't synced in this prototype.</p>`)}
    `}
  `);

  $('#connect')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const btn = $('button', e.target);
    btn.disabled = true;
    try {
      const args = { url: f.get('url'), anon: String(f.get('anon') || '').trim(), key: String(f.get('key') || '').trim(), name: Object.values(ctx.state.properties).find((p) => !p.demo)?.name || '' };
      s.office = args.key ? await joinSpace(args) : await createSpace(args);
      await ctx.save();
      toast(args.key ? 'Joined the sync space.' : 'Sync space created.');
      await syncNow(ctx);
      ctx.rerender();
    } catch (err) {
      toast(err.message, 'bad');
      btn.disabled = false;
    }
  });
  $('#sync-now')?.addEventListener('click', async () => {
    $('#sync-status').textContent = 'Syncing…';
    await syncNow(ctx);
    ctx.rerender();
  });
  $('#disconnect')?.addEventListener('click', async () => {
    if (!(await confirmBox('Stop syncing on this device? Records stay here, and the server keeps its copy. You can reconnect with the sync key.', 'Disconnect'))) return;
    s.office = null;
    await ctx.save();
    ctx.rerender();
  });
  $('#copy-link')?.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied.'); } catch { toast('Copy failed. Select the link instead.', 'bad'); }
  });
}

/** #/connect/:payload — join this device to an office's sync space from a link. */
export function connect(main, { payload }, ctx) {
  const cfg = decodeConnect(payload);
  if (!cfg) {
    main.innerHTML = String(html`<h1>This link didn't work</h1><p>The connect link is damaged or incomplete. Copy it again from the office device's Sync page.</p>`);
    return;
  }
  const already = officeOn(ctx.state) && syncOf(ctx.state).office.key === cfg.key;
  main.innerHTML = String(html`
    <div class="eyebrow">Office device</div>
    <h1>Connect this device</h1>
    <p class="lede">This links this browser to an office's Walkthru records at <span class="mono">${cfg.url}</span>. Only do this on a staff device.</p>
    ${already ? callout('tip', 'Already connected', html`<p>This device already uses this sync space.</p>`) : html`<button class="btn primary" id="go">Connect and sync</button>`}
    <p style="margin-top: 16px"><a href="#/office/sync">Sync settings</a></p>
  `);
  $('#go')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      syncOf(ctx.state).office = await joinSpace(cfg);
      await ctx.save();
      await syncNow(ctx);
      toast('Connected. Records are syncing.');
      ctx.go('#/office');
    } catch (err) {
      toast(err.message, 'bad');
      e.target.disabled = false;
    }
  });
}
