// Demo data so the prototype can be tried without walking a real apartment.
//
// Photos are drawn on a canvas: one simple scene per checklist item, the same layout for the
// move-in and move-out shot of an item. Every move-out shot gets realistic noise (different light,
// a slightly different camera position, sensor grain), and exactly five of them get planted
// damage. That is the Road Map's prototype gate: the comparison must flag all five planted changes
// and nothing else.

import { checklist, checklistFor } from './core/templates.js';
import { addProperty, addUnit, upsertResident, openInspection, startSubmission, putEntry } from './core/model.js';
import { sealSubmission, sha256Hex } from './core/integrity.js';
import { canvasToBlob } from './imaging.js';
import { putPhoto } from './store.js';

export const DEMO_PROPERTY_ID = 'p_demo';
const W = 640;
const H = 480;
const DAY = 86400e3;

// Planted damage per demo unit: item key → { kind, condition the resident reported, note }.
export const PLANTED = {
  u_demo204: {
    'living.walls': { kind: 'hole', condition: 'ok', note: '' },
    'bedA.carpet': { kind: 'stain', condition: 'damage', note: 'Coffee spill by the desk' },
    'bedB.blinds': { kind: 'slats', condition: 'damage', note: 'Two slats snapped' },
    'bath1.mirror': { kind: 'crack', condition: 'ok', note: '' },
    'kitchen.counters': { kind: 'burn', condition: 'damage', note: 'Hot pan mark' },
  },
  // For the resident demo: a move-out shot here will show one new mark.
  u_demo310: {
    'bedA.bwalls': { kind: 'scuff', condition: 'damage', note: 'Chair scuffed the wall' },
  },
};

// Reported, but not visible: the carpet is flattened by furniture. Normal wear and tear.
const WEAR_ONLY = { u_demo204: { 'living.floor': 'Carpet flattened where the couch sat' } };

// ---------------------------------------------------------------- deterministic randomness

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

function rng(seed) {
  let a = typeof seed === 'string' ? hashStr(seed) : seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = (rand, arr) => arr[Math.floor(rand() * arr.length)];

// ---------------------------------------------------------------- scenes

const WALLS = ['#d9d2c5', '#cfd6dc', '#e2dccf', '#c9cfc4', '#ddd3c8'];
const CARPETS = ['#8a8172', '#7d7a74', '#93897a', '#6f7480'];

function rect(ctx, x, y, w, h, fill) {
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
}

function wallAndFloor(ctx, wall, floorTop, floor) {
  rect(ctx, -60, -60, W + 120, floorTop + 60, wall);
  const g = ctx.createLinearGradient(0, 0, W, 0);
  g.addColorStop(0, 'rgba(0,0,0,0.06)');
  g.addColorStop(1, 'rgba(255,255,255,0.05)');
  rect(ctx, -60, -60, W + 120, floorTop + 60, g);
  rect(ctx, -60, floorTop - 16, W + 120, 16, '#f2efe9'); // baseboard
  rect(ctx, -60, floorTop, W + 120, H - floorTop + 60, floor);
}

function carpetTexture(ctx, top, rand, color) {
  ctx.fillStyle = color;
  for (let i = 0; i < 900; i++) {
    ctx.globalAlpha = 0.18;
    ctx.fillRect(rand() * (W + 80) - 40, top + rand() * (H - top + 40), 3, 2);
  }
  ctx.globalAlpha = 1;
}

const SCENES = {
  wall(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 380, c.carpet);
    carpetTexture(ctx, 380, rand, '#000');
    rect(ctx, 470, 220, 26, 40, '#f7f5f0'); // light switch
    rect(ctx, 479, 230, 8, 20, '#e4e0d8');
    ctx.strokeStyle = '#5b4a3a'; ctx.lineWidth = 10;
    ctx.strokeRect(120, 110, 170, 120); // picture frame
    rect(ctx, 125, 115, 160, 110, '#9fb6c9');
    rect(ctx, 125, 180, 160, 45, '#6d8a6a');
  },
  floor(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 110, c.carpet);
    carpetTexture(ctx, 110, rand, '#000');
    carpetTexture(ctx, 110, rand, '#fff');
    rect(ctx, 430, 60, 160, 70, '#6b5644'); // desk edge
  },
  corner(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 330, c.carpet);
    rect(ctx, 320, -60, 400, 390, 'rgba(0,0,0,0.08)');
    ctx.strokeStyle = 'rgba(0,0,0,0.18)'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(320, -60); ctx.lineTo(320, 330); ctx.stroke();
    carpetTexture(ctx, 330, rand, '#000');
  },
  blinds(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 420, c.carpet);
    rect(ctx, 150, 60, 340, 290, '#f4f2ee'); // frame
    rect(ctx, 166, 76, 308, 258, '#2e3f55'); // glass, dark outside
    for (let y = 80; y < 330; y += 14) {
      rect(ctx, 168, y, 304, 10, '#ebe8e1');
      rect(ctx, 168, y + 9, 304, 1, '#c9c4ba');
    }
    rect(ctx, 316, 66, 3, 270, '#b9b3a8'); // cord
  },
  door(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 430, c.carpet);
    rect(ctx, 200, 40, 240, 390, '#f1ece2');
    rect(ctx, 214, 52, 212, 378, '#e7e0d2');
    ctx.strokeStyle = '#d2c9b8'; ctx.lineWidth = 4;
    ctx.strokeRect(236, 76, 168, 140);
    ctx.strokeRect(236, 246, 168, 160);
    ctx.fillStyle = '#9a8a64';
    ctx.beginPath(); ctx.arc(406, 240, 11, 0, Math.PI * 2); ctx.fill();
  },
  ceiling(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, '#ecebe7');
    const g = ctx.createRadialGradient(320, 240, 40, 320, 240, 420);
    g.addColorStop(0, 'rgba(255,255,255,0.4)'); g.addColorStop(1, 'rgba(0,0,0,0.1)');
    rect(ctx, -60, -60, W + 120, H + 120, g);
    ctx.fillStyle = '#f8f8f6';
    ctx.beginPath(); ctx.arc(320, 240, 70, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#cfcdc6'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(320, 240, 70, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(320, 240, 30, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#4caf50';
    ctx.beginPath(); ctx.arc(350, 220, 5, 0, Math.PI * 2); ctx.fill();
  },
  stove(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, '#1f2124');
    for (const [x, y, r] of [[200, 150, 78], [440, 150, 62], [200, 340, 62], [440, 340, 78]]) {
      ctx.fillStyle = '#b8bcc2';
      ctx.beginPath(); ctx.arc(x, y, r + 14, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#3a3c40'; ctx.lineWidth = 7;
      for (let k = r; k > 12; k -= 15) { ctx.beginPath(); ctx.arc(x, y, k, 0, Math.PI * 2); ctx.stroke(); }
    }
  },
  counter(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, 200, '#e9e4da');
    ctx.strokeStyle = '#cfc8ba'; ctx.lineWidth = 2;
    for (let x = -60; x < W + 60; x += 60) { ctx.beginPath(); ctx.moveTo(x, -60); ctx.lineTo(x, 140); ctx.stroke(); }
    for (let y = 20; y < 140; y += 40) { ctx.beginPath(); ctx.moveTo(-60, y); ctx.lineTo(W + 60, y); ctx.stroke(); }
    rect(ctx, -60, 140, W + 120, H, '#8f8678');
    for (let i = 0; i < 1400; i++) {
      ctx.fillStyle = pick(rand, ['#6f675b', '#b2aa9b', '#4f4a42', '#a49a89']);
      ctx.fillRect(rand() * (W + 80) - 40, 140 + rand() * (H - 100), 3, 3);
    }
    rect(ctx, 60, 160, 120, 60, '#d8d2c4'); // cutting board
  },
  sink(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, '#ddd7cc');
    ctx.fillStyle = '#c4c9cf';
    ctx.beginPath(); ctx.ellipse(320, 270, 220, 150, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#a9afb6';
    ctx.beginPath(); ctx.ellipse(320, 285, 190, 120, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#5d6168';
    ctx.beginPath(); ctx.arc(320, 320, 16, 0, Math.PI * 2); ctx.fill();
    rect(ctx, 305, 60, 30, 80, '#bfc4ca');
    rect(ctx, 305, 60, 110, 22, '#bfc4ca');
  },
  fridge(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, '#f3f5f6');
    for (const y of [150, 280, 400]) rect(ctx, -60, y, W + 120, 8, '#cdd5da');
    for (let i = 0; i < 7; i++) {
      const shelf = pick(rand, [150, 280, 400]);
      const hgt = 40 + rand() * 60;
      rect(ctx, 40 + rand() * 520, shelf - hgt, 40 + rand() * 50, hgt, pick(rand, ['#c0392b', '#2e86c1', '#f1c40f', '#27ae60', '#ecf0f1']));
    }
  },
  tile(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, '#eef0f0');
    ctx.strokeStyle = '#c7cccc'; ctx.lineWidth = 3;
    for (let x = -60; x < W + 60; x += 64) { ctx.beginPath(); ctx.moveTo(x, -60); ctx.lineTo(x, 300); ctx.stroke(); }
    for (let y = -60; y < 300; y += 64) { ctx.beginPath(); ctx.moveTo(-60, y); ctx.lineTo(W + 60, y); ctx.stroke(); }
    rect(ctx, -60, 300, W + 120, 14, '#f7f7f5'); // caulk line
    rect(ctx, -60, 314, W + 120, H, '#fafafa'); // tub
    rect(ctx, -60, 314, W + 120, 30, 'rgba(0,0,0,0.05)');
  },
  toilet(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, 180, c.wall);
    rect(ctx, -60, 120, W + 120, H, '#d9d6cf');
    ctx.strokeStyle = '#bdb9b0'; ctx.lineWidth = 2;
    for (let x = -60; x < W + 60; x += 80) { ctx.beginPath(); ctx.moveTo(x, 120); ctx.lineTo(x, H + 60); ctx.stroke(); }
    rect(ctx, 220, 40, 200, 120, '#fbfbfa');
    ctx.fillStyle = '#fbfbfa';
    ctx.beginPath(); ctx.ellipse(320, 280, 110, 130, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#dfe8ee';
    ctx.beginPath(); ctx.ellipse(320, 290, 75, 95, 0, 0, Math.PI * 2); ctx.fill();
  },
  mirror(ctx, rand, c) {
    rect(ctx, -60, -60, W + 120, H + 120, c.wall);
    rect(ctx, 130, 50, 380, 300, '#9aa3a8');
    const g = ctx.createLinearGradient(140, 60, 500, 340);
    g.addColorStop(0, '#dfe7ec'); g.addColorStop(0.5, '#b7c4cc'); g.addColorStop(1, '#d4dde2');
    rect(ctx, 140, 60, 360, 280, g);
    rect(ctx, 80, 380, 480, 120, '#e8e3d9'); // vanity top
  },
  desk(ctx, rand, c) {
    wallAndFloor(ctx, c.wall, 400, c.carpet);
    rect(ctx, 90, 230, 460, 26, '#7a5d43');
    rect(ctx, 110, 256, 20, 160, '#5f4733');
    rect(ctx, 510, 256, 20, 160, '#5f4733');
    rect(ctx, 260, 190, 120, 40, '#2c3e50'); // laptop
    rect(ctx, 400, 280, 90, 18, '#34495e'); // chair seat
    rect(ctx, 438, 298, 14, 110, '#2c3e50');
  },
};

// ---------------------------------------------------------------- planted damage

const DAMAGE = {
  hole(ctx, rand) {
    const x = 330 + rand() * 60, y = 190 + rand() * 40;
    ctx.fillStyle = '#efe9dd';
    ctx.beginPath(); ctx.ellipse(x, y, 46, 38, 0.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3b332b';
    ctx.beginPath();
    for (let a = 0; a < Math.PI * 2; a += 0.35) {
      const r = 24 + rand() * 10;
      ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r * 0.85);
    }
    ctx.closePath(); ctx.fill();
  },
  stain(ctx, rand) {
    const x = 200 + rand() * 120, y = 290 + rand() * 60;
    const g = ctx.createRadialGradient(x, y, 5, x, y, 70);
    g.addColorStop(0, 'rgba(60,35,15,0.95)'); g.addColorStop(0.7, 'rgba(70,45,20,0.75)'); g.addColorStop(1, 'rgba(70,45,20,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, y, 80, 52, 0.2, 0, Math.PI * 2); ctx.fill();
  },
  slats(ctx) {
    // Two slats gone and one hanging at an angle.
    rect(ctx, 168, 192, 304, 10, '#2e3f55');
    rect(ctx, 168, 206, 304, 10, '#2e3f55');
    ctx.save();
    ctx.translate(320, 225); ctx.rotate(0.25);
    rect(ctx, -150, -5, 300, 10, '#ebe8e1');
    ctx.restore();
  },
  crack(ctx, rand) {
    const cx = 260 + rand() * 80, cy = 150 + rand() * 60;
    ctx.fillStyle = 'rgba(60,70,78,0.55)';
    ctx.beginPath(); ctx.arc(cx, cy, 22, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#3c464e'; ctx.lineCap = 'round';
    for (let k = 0; k < 7; k++) {
      let x = cx, y = cy;
      let a = (k / 7) * Math.PI * 2 + rand() * 0.5;
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(x, y);
      for (let s = 0; s < 6; s++) {
        a += (rand() - 0.5) * 0.6;
        x += Math.cos(a) * (18 + rand() * 14);
        y += Math.sin(a) * (18 + rand() * 14);
        ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  },
  burn(ctx, rand) {
    const x = 380 + rand() * 100, y = 300 + rand() * 60;
    ctx.strokeStyle = 'rgba(30,18,10,0.9)'; ctx.lineWidth = 16;
    ctx.beginPath(); ctx.arc(x, y, 50, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(80,50,25,0.55)';
    ctx.beginPath(); ctx.arc(x, y, 42, 0, Math.PI * 2); ctx.fill();
  },
  scuff(ctx, rand) {
    const x = 300 + rand() * 60, y = 250 + rand() * 40;
    ctx.strokeStyle = 'rgba(45,40,38,0.85)'; ctx.lineCap = 'round';
    for (let k = 0; k < 4; k++) {
      ctx.lineWidth = 9 - k;
      ctx.beginPath(); ctx.moveTo(x - 70, y + k * 9); ctx.quadraticCurveTo(x, y - 14 + k * 9, x + 80, y + 6 + k * 9); ctx.stroke();
    }
  },
};

/**
 * Draw one demo photo. `seedKey` fixes the scene layout (same for move-in and move-out);
 * `shot` varies the light and camera position (pass null for a clean baseline shot).
 * Returns { blob, width, height }.
 */
export async function demoPhoto({ seedKey, scene, damage = null, shot = null }) {
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const layout = rng(seedKey);
  const colors = { wall: pick(layout, WALLS), carpet: pick(layout, CARPETS) };
  const noise = shot ? rng(`${seedKey}|${shot}`) : null;
  const dx = noise ? Math.round((noise() - 0.5) * 16) : 0;
  const dy = noise ? Math.round((noise() - 0.5) * 12) : 0;

  ctx.save();
  ctx.translate(W / 2 + dx, H / 2 + dy);
  ctx.scale(1.06, 1.06);
  ctx.translate(-W / 2, -H / 2);
  (SCENES[scene] || SCENES.wall)(ctx, layout, colors);
  if (damage) DAMAGE[damage](ctx, rng(`${seedKey}|damage`));
  ctx.restore();

  // Different light: warmer or cooler, brighter or dimmer.
  if (noise) {
    const k = 0.86 + noise() * 0.22;
    const warm = noise() < 0.5;
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = `rgb(${Math.round(255 * Math.min(1, k + (warm ? 0.04 : 0)))},${Math.round(255 * k)},${Math.round(255 * Math.min(1, k - (warm ? 0.05 : -0.03)))})`;
    ctx.fillRect(0, 0, W, H);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Sensor grain.
  const grain = rng(`${seedKey}|grain|${shot || 'base'}`);
  const img = ctx.getImageData(0, 0, W, H);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (grain() - 0.5) * 10;
    img.data[i] += n; img.data[i + 1] += n; img.data[i + 2] += n;
  }
  ctx.putImageData(img, 0, 0);

  ctx.font = '600 13px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.fillRect(10, H - 28, 96, 20);
  ctx.fillStyle = '#0B1F3A';
  ctx.fillText('DEMO PHOTO', 18, H - 13);

  return { blob: await canvasToBlob(c), width: W, height: H };
}

/** The demo photo a resident gets from "Use demo photo" for an item of a demo unit. */
export function demoShotFor(unit, key, kind, shot) {
  const item = checklist(unit.template).find((c) => c.key === key);
  const plant = kind === 'move-out' ? PLANTED[unit.id]?.[key] : null;
  return demoPhoto({ seedKey: `${unit.id}|${key}`, scene: item?.item.scene, damage: plant?.kind || null, shot });
}

/** What a demo resident would report for an item (used by "Use demo photo"). */
export function demoReport(unit, key, kind) {
  if (kind !== 'move-out') return { condition: 'ok', note: '' };
  const plant = PLANTED[unit.id]?.[key];
  if (plant) return { condition: plant.condition, note: plant.note };
  const wear = WEAR_ONLY[unit.id]?.[key];
  return wear ? { condition: 'wear', note: wear } : { condition: 'ok', note: '' };
}

export const isDemoUnit = (unit) => Boolean(unit && PLANTED[unit.id]) || unit?.id?.startsWith('u_demo');

// ---------------------------------------------------------------- building the demo property

async function capture({ unit, sub, kind, start, keys }) {
  let t = start;
  for (const key of keys) {
    const { blob, width, height } = await demoShotFor(unit, key, kind, kind === 'move-out' ? `out-${key}` : null);
    const hash = await sha256Hex(new Uint8Array(await blob.arrayBuffer()));
    await putPhoto(hash, { type: 'image/jpeg', blob });
    const report = demoReport(unit, key, kind);
    t += 15e3 + (hashStr(key) % 25) * 1e3;
    putEntry(sub, {
      id: `e_${sub.id}_${key.replace('.', '_')}`, key, condition: report.condition, note: report.note,
      photo: { hash, type: 'image/jpeg', width, height, capturedAt: new Date(t).toISOString(), serverTime: null, source: 'demo' },
    });
  }
  return t;
}

async function walk(state, { unit, kind, resident, inspection, keys, start }) {
  const sub = startSubmission(state, { id: `s_${inspection.id}_${resident.id}`, inspection, resident, now: start });
  const end = await capture({ unit, sub, kind, start, keys });
  state.submissions[sub.id] = await sealSubmission(sub, new Date(end + 60e3).toISOString());
}

/** Remove the demo property and everything under it (photos are left; they are tiny and unused). */
export function removeDemo(state) {
  delete state.properties[DEMO_PROPERTY_ID];
  for (const u of Object.values(state.units)) if (u.propertyId === DEMO_PROPERTY_ID) delete state.units[u.id];
  for (const i of Object.values(state.inspections)) if (!state.units[i.unitId]) delete state.inspections[i.id];
  for (const s of Object.values(state.submissions)) if (!state.inspections[s.inspectionId]) delete state.submissions[s.id];
}

/**
 * Add the demo property: unit 204 with a sealed move-in and move-out ready for review, unit 310
 * with a sealed move-in waiting for its move-out, and an empty studio. `progress(done, total)`
 * reports photo progress.
 */
export async function buildDemo(state, now, progress = () => {}) {
  removeDemo(state);
  const p = addProperty(state, { id: DEMO_PROPERTY_ID, name: 'Maple Court (demo)', city: 'Richardson', state: 'TX', demo: true });

  const u204 = addUnit(state, { id: 'u_demo204', propertyId: p.id, label: '204', template: '2x2' });
  const jordan = upsertResident(u204, { id: 'r_demo_jordan', name: 'Jordan Reyes', bedroom: 'A', depositCents: 50000 });
  const priya = upsertResident(u204, { id: 'r_demo_priya', name: 'Priya Nair', bedroom: 'B', depositCents: 50000 });

  const u310 = addUnit(state, { id: 'u_demo310', propertyId: p.id, label: '310', template: '1x1' });
  const alex = upsertResident(u310, { id: 'r_demo_alex', name: 'Alex Kim', bedroom: 'A', depositCents: 40000 });

  addUnit(state, { id: 'u_demo112', propertyId: p.id, label: '112', template: 'studio' });

  const all204 = checklist(u204.template).map((c) => c.key);
  const jordanKeys = checklistFor(u204.template, 'A').map((c) => c.key);
  const priyaKeys = all204.filter((k) => k.startsWith('bedB.'));
  const keys310 = checklist(u310.template).map((c) => c.key);
  const total = all204.length * 2 + keys310.length;
  let done = 0;
  const tick = () => progress(++done, total);

  const moveOutAt = now - 5 * DAY;
  const moveInAt = moveOutAt - 430 * DAY;

  const in204 = openInspection(state, { id: 'i_demo204_in', unitId: u204.id, kind: 'move-in', now: moveInAt });
  for (const [resident, keys] of [[jordan, jordanKeys], [priya, priyaKeys]]) {
    const start = moveInAt + 10 * 60e3 + (resident === priya ? 40 * 60e3 : 0);
    await walk(state, { unit: u204, kind: 'move-in', resident, inspection: in204, keys, start });
    keys.forEach(tick);
  }
  const out204 = openInspection(state, { id: 'i_demo204_out', unitId: u204.id, kind: 'move-out', now: moveOutAt });
  for (const [resident, keys] of [[jordan, jordanKeys], [priya, priyaKeys]]) {
    const start = moveOutAt + 10 * 60e3 + (resident === priya ? 25 * 60e3 : 0);
    await walk(state, { unit: u204, kind: 'move-out', resident, inspection: out204, keys, start });
    keys.forEach(tick);
  }
  out204.surrenderDate = new Date(moveOutAt).toISOString().slice(0, 10);
  out204.forwarding = { [jordan.id]: true };

  const in310 = openInspection(state, { id: 'i_demo310_in', unitId: u310.id, kind: 'move-in', now: now - 60 * DAY });
  await walk(state, { unit: u310, kind: 'move-in', resident: alex, inspection: in310, keys: keys310, start: now - 60 * DAY + 5 * 60e3 });
  keys310.forEach(tick);

  return p;
}
