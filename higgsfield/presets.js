// Camera presets and the pure camera math behind them. DOM-free so it runs under node --test.
// cameraAt(id, t) describes a virtual camera looking at a flat picture; render.js turns it into pixels.

export const CATEGORIES = [
  { id: 'zoom', name: 'Zoom & Dolly' },
  { id: 'orbit', name: 'Orbit & Arc' },
  { id: 'crane', name: 'Crane & Lift' },
  { id: 'pan-tilt', name: 'Pan & Tilt' },
  { id: 'handheld', name: 'Handheld' },
  { id: 'drone', name: 'Drone & FPV' },
  { id: 'lens', name: 'Lens & Focus' },
  { id: 'fx', name: 'Effects' },
];

// ---------------------------------------------------------------- math helpers

const TAU = Math.PI * 2;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const seg = (t, a, b) => clamp((t - a) / (b - a), 0, 1);
const bump = (t, c, w) => Math.exp(-(((t - c) / w) ** 2));
const wave = (t, f, ph = 0) => Math.sin(TAU * (f * t + ph));
const sine = (t) => -(Math.cos(Math.PI * t) - 1) / 2;
const smooth = (t) => t * t * (3 - 2 * t);
const inCubic = (t) => t * t * t;
const outCubic = (t) => 1 - (1 - t) ** 3;
const inOutCubic = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const inOutQuint = (t) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2);
const outExpo = (t) => (t >= 1 ? 1 : 1 - 2 ** (-10 * t));
const zoomExp = (from, to, e) => Math.exp(lerp(Math.log(from), Math.log(to), e));
// Deterministic 0..1 hash for an integer.
const hash1 = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
// Slow in the middle, fast at the ends (bullet-time ramp).
const ramp = (t) => { const u = 2 * t - 1; return 0.5 + 0.5 * Math.sign(u) * Math.abs(u) ** 2.2; };

/** Piecewise keyframes [[t, value], ...] with an easing between keys. */
function keys(t, ks, ease = sine) {
  if (t <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    const [t1, v1] = ks[i];
    if (t <= t1) { const [t0, v0] = ks[i - 1]; return lerp(v0, v1, ease((t - t0) / (t1 - t0 || 1))); }
  }
  return ks[ks.length - 1][1];
}

/** A few short bursts placed pseudo-randomly along the timeline (glitch / vhs). */
function bursts(t, n, salt, base = 0) {
  let g = base;
  for (let k = 0; k < n; k++) {
    const c = (k + 0.5) / n + (hash1(k + salt) - 0.5) * (0.6 / n);
    const w = 0.012 + 0.025 * hash1(k + salt + 11);
    g = Math.max(g, (0.55 + 0.45 * hash1(k + salt + 23)) * bump(t, c, w));
  }
  return g;
}

/** Decaying jolt starting at t0: returns 0 before, 1 at the hit, fading with `k`. */
const jolt = (t, t0, k = 8) => (t < t0 ? 0 : Math.exp(-(t - t0) * k));

// ---------------------------------------------------------------- presets
// [id, name, category, description, tags, flags, motion(t) -> partial camera]

const P = [];
const def = (id, name, category, description, tags, flags, fn) => P.push({ id, name, category, description, tags, ...flags, fn });

// Zoom & Dolly
def('dolly-in', 'Dolly In', 'zoom', 'Smooth push toward the subject on a track.', ['push', 'forward', 'classic'], { popular: true },
  (t) => { const e = sine(t); return { zoom: lerp(1.02, 1.42, e), y: lerp(0, -0.012, e) }; });
def('dolly-out', 'Dolly Out', 'zoom', 'Pull away from the subject to reveal the scene.', ['pull', 'reveal', 'classic'], { popular: true },
  (t) => { const e = sine(t); return { zoom: lerp(1.42, 1.02, e), y: lerp(-0.012, 0, e) }; });
def('super-dolly', 'Super Dolly In', 'zoom', 'Long, accelerating push with zoom streaks.', ['push', 'fast', 'dramatic'], { popular: true },
  (t) => { const e = inOutCubic(t); return { zoom: zoomExp(1, 2.2, e), blur: 3 * bump(t, 0.55, 0.18), fx: 'radial', fxAmount: 0.8 * bump(t, 0.55, 0.2) }; });
def('super-dolly-out', 'Super Dolly Out', 'zoom', 'Fast, sweeping pull-back from close-up to wide.', ['pull', 'fast', 'reveal'], {},
  (t) => { const e = inOutCubic(t); return { zoom: zoomExp(2.2, 1, e), blur: 3 * bump(t, 0.45, 0.18), fx: 'radial', fxAmount: 0.8 * bump(t, 0.45, 0.2) }; });
def('crash-zoom', 'Crash Zoom In', 'zoom', 'A sudden snap zoom into the subject, then a settle.', ['snap', 'punch', 'fast'], { popular: true },
  (t) => {
    const e = outExpo(seg(t, 0.32, 0.5));
    return { zoom: lerp(1.0 + 0.04 * seg(t, 0, 0.32), 2.3, e) + 0.08 * bump(t, 0.52, 0.04), blur: 10 * bump(t, 0.38, 0.045),
      shake: 0.55 * bump(t, 0.55, 0.1), fx: 'radial', fxAmount: bump(t, 0.38, 0.06) };
  });
def('crash-zoom-out', 'Crash Zoom Out', 'zoom', 'Snap back from a tight close-up to the full frame.', ['snap', 'pull', 'fast'], {},
  (t) => {
    const e = outExpo(seg(t, 0.45, 0.62));
    return { zoom: lerp(2.3 - 0.06 * seg(t, 0, 0.45), 1.02, e), blur: 10 * bump(t, 0.5, 0.045),
      shake: 0.5 * bump(t, 0.66, 0.1), fx: 'radial', fxAmount: bump(t, 0.5, 0.06) };
  });
def('dolly-zoom', 'Dolly Zoom In', 'zoom', 'The vertigo effect: subject holds while the world warps behind.', ['vertigo', 'hitchcock', 'warp'], { popular: true },
  (t) => ({ zoom: lerp(1.75, 1.0, sine(t)), fx: 'vertigo', fxAmount: 1 }));
def('dolly-zoom-out', 'Dolly Zoom Out', 'zoom', 'Reverse vertigo: the background rushes in around a still subject.', ['vertigo', 'warp'], {},
  (t) => ({ zoom: lerp(1.0, 1.75, sine(t)), fx: 'vertigo', fxAmount: 1 }));
def('ken-burns', 'Ken Burns', 'zoom', 'Documentary-style slow zoom with a gentle diagonal drift.', ['slow', 'documentary', 'photo'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.1, 1.32, e), x: lerp(-0.035, 0.035, e), y: lerp(0.02, -0.02, e) }; });
def('slow-push', 'Slow Push', 'zoom', 'Barely-there creep forward. Tension without distraction.', ['slow', 'subtle', 'tension'], {},
  (t) => ({ zoom: lerp(1.02, 1.16, t), shake: 0.05 }));
def('double-punch', 'Double Punch-In', 'zoom', 'Two hard punch-ins that land on beat.', ['punch', 'beat', 'music'], { new: true },
  (t) => ({ zoom: 1.02 + 0.28 * outCubic(seg(t, 0.2, 0.3)) + 0.4 * outCubic(seg(t, 0.6, 0.7)),
    blur: 5 * (bump(t, 0.23, 0.03) + bump(t, 0.63, 0.03)), shake: 0.4 * (bump(t, 0.3, 0.06) + bump(t, 0.7, 0.06)) }));
def('eyes-in', 'Eyes In', 'zoom', 'Dive straight into the eyes of your subject.', ['face', 'portrait', 'macro'], { new: true },
  (t) => { const e = inOutCubic(seg(t, 0.05, 0.95)); return { zoom: zoomExp(1, 4.2, e), y: lerp(0, -0.1, sine(seg(t, 0, 0.6))), blur: 2.5 * bump(t, 0.6, 0.15), fx: 'radial', fxAmount: 0.7 * bump(t, 0.6, 0.18) }; });
def('earth-zoom-out', 'Earth Zoom Out', 'zoom', 'From a tight close-up out to the whole world, with a spin.', ['pull', 'epic', 'space'], { popular: true },
  (t) => { const e = sine(t); return { zoom: zoomExp(5, 1, e), rotate: lerp(0.22, 0, outCubic(t)), blur: 3 * bump(t, 0.4, 0.2), fx: 'radial', fxAmount: 0.85 * bump(t, 0.4, 0.22) }; });

// Orbit & Arc
def('arc-left', 'Arc Left', 'orbit', 'Curved move around the subject to the left.', ['arc', 'parallax', 'move'], { popular: true },
  (t) => { const e = sine(t); return { zoom: 1.24, x: lerp(0.07, -0.07, e), tiltY: lerp(-0.22, 0.22, e), rotate: lerp(0.015, -0.015, e) }; });
def('arc-right', 'Arc Right', 'orbit', 'Curved move around the subject to the right.', ['arc', 'parallax', 'move'], {},
  (t) => { const e = sine(t); return { zoom: 1.24, x: lerp(-0.07, 0.07, e), tiltY: lerp(0.22, -0.22, e), rotate: lerp(-0.015, 0.015, e) }; });
def('orbit-360', '360 Orbit', 'orbit', 'A full circle around the subject. Loops seamlessly.', ['orbit', 'loop', 'circle'], { popular: true },
  (t) => { const a = TAU * t; return { zoom: 1.3 + 0.05 * Math.cos(a), x: 0.09 * Math.sin(a), y: 0.012 * Math.cos(2 * a), tiltY: 0.3 * Math.sin(a), rotate: 0.02 * Math.sin(a), blur: 0.8 * Math.abs(Math.cos(a)) }; });
def('orbit-left', 'Orbit Left', 'orbit', 'Wide, steady orbit sweeping left.', ['orbit', 'sweep'], {},
  (t) => { const e = lerp(t, sine(t), 0.6); return { zoom: 1.36, x: lerp(0.11, -0.11, e), tiltY: lerp(-0.34, 0.34, e), rotate: lerp(0.03, -0.03, e) }; });
def('orbit-right', 'Orbit Right', 'orbit', 'Wide, steady orbit sweeping right.', ['orbit', 'sweep'], {},
  (t) => { const e = lerp(t, sine(t), 0.6); return { zoom: 1.36, x: lerp(-0.11, 0.11, e), tiltY: lerp(0.34, -0.34, e), rotate: lerp(-0.03, 0.03, e) }; });
def('lazy-susan', 'Lazy Susan', 'orbit', 'The subject turns like it is on a turntable.', ['turntable', 'product', 'spin'], {},
  (t) => ({ zoom: 1.22, x: -0.035 * wave(t, 1), tiltY: 0.42 * wave(t, 1) }));
def('bullet-time', 'Bullet Time', 'orbit', 'Frozen-moment sweep that slows to a crawl mid-move.', ['matrix', 'freeze', 'slow-mo'], { popular: true },
  (t) => { const e = ramp(t); return { zoom: 1.32, x: lerp(0.1, -0.1, e), tiltY: lerp(-0.36, 0.36, e), rotate: lerp(0.02, -0.02, e), blur: 4 * (1 - bump(t, 0.5, 0.28)) }; });
def('robo-arm', 'Robo Arm', 'orbit', 'Motion-control rig: precise, fast moves with hard stops.', ['motion control', 'robotic', 'commercial'], { new: true },
  (t) => {
    const T = [[0], [0.28], [0.46], [0.72], [1]];
    const k = (vals) => keys(t, T.map((x, i) => [x[0], vals[i]]), inOutQuint);
    return { zoom: k([1.15, 1.5, 1.5, 1.28, 1.62]), x: k([-0.06, 0.04, 0.04, -0.03, 0.02]), y: k([0.03, -0.02, -0.02, 0.02, -0.01]),
      rotate: k([0, -0.08, -0.08, 0.06, 0]), tiltY: k([0.2, -0.15, -0.15, 0.2, 0]), blur: 3 * (bump(t, 0.14, 0.05) + bump(t, 0.59, 0.05) + bump(t, 0.86, 0.05)) };
  });
def('spiral-in', 'Spiral In', 'orbit', 'Twisting push toward the subject.', ['spin', 'push', 'twist'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.08, 1.75, e), rotate: lerp(0, 0.4, e) }; });
def('spiral-out', 'Spiral Out', 'orbit', 'Twisting pull away from the subject.', ['spin', 'pull', 'twist'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.75, 1.08, e), rotate: lerp(-0.4, 0, e) }; });
def('head-tracking', 'Head Tracking', 'orbit', 'Camera locks onto the face as the world moves around it.', ['follow', 'face', 'tracking'], { new: true },
  (t) => ({ zoom: 1.24, x: 0.035 * wave(t, 0.8), y: 0.01 * wave(t, 1.6, 0.2), tiltY: 0.12 * wave(t, 0.8), shake: 0.15, fx: 'snorricam', fxAmount: 0.85 }));
def('arc-push', 'Arc Push-In', 'orbit', 'Arcs to the right while closing in on the subject.', ['arc', 'push', 'hero'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.12, 1.55, e), x: lerp(-0.06, 0.05, e), tiltY: lerp(0.24, -0.16, e) }; });

// Crane & Lift
def('crane-up', 'Crane Up', 'crane', 'Rise up and over while tilting down to keep the subject.', ['rise', 'reveal', 'jib'], { popular: true },
  (t) => { const e = sine(t); return { zoom: 1.26, y: lerp(0.08, -0.08, e), tiltX: lerp(-0.18, 0.18, e) }; });
def('crane-down', 'Crane Down', 'crane', 'Descend from above down to eye level.', ['descend', 'jib'], {},
  (t) => { const e = sine(t); return { zoom: 1.26, y: lerp(-0.08, 0.08, e), tiltX: lerp(0.18, -0.18, e) }; });
def('crane-overhead', 'Overhead Crane', 'crane', 'Climb high above for a top-down, god\'s-eye view.', ['top-down', 'rise', 'aerial'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.2, 1.48, e), y: lerp(0.09, -0.09, e), tiltX: lerp(0, 0.38, e), rotate: lerp(0, 0.07, e) }; });
def('pedestal-up', 'Pedestal Up', 'crane', 'Straight vertical lift with no tilt.', ['vertical', 'lift'], {},
  (t) => ({ zoom: 1.2, y: lerp(0.07, -0.07, sine(t)) }));
def('pedestal-down', 'Pedestal Down', 'crane', 'Straight vertical drop with no tilt.', ['vertical', 'drop'], {},
  (t) => ({ zoom: 1.2, y: lerp(-0.07, 0.07, sine(t)) }));
def('jib-reveal', 'Jib Reveal', 'crane', 'Starts tight and low, then lifts out to reveal everything.', ['reveal', 'rise', 'pull'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.62, 1.1, e), y: lerp(0.07, -0.03, e), tiltX: lerp(-0.2, 0.02, e) }; });
def('levitation', 'Levitation', 'crane', 'Dreamy weightless float with a soft bob and glow.', ['float', 'dreamy', 'surreal'], { new: true },
  (t) => ({ zoom: 1.2 + 0.05 * t, y: lerp(0.04, -0.06, sine(t)) + 0.012 * wave(t, 1.5), rotate: 0.02 * wave(t, 1), fx: 'lightleak', fxAmount: 0.45 }));
def('low-angle-rise', 'Low-Angle Rise', 'crane', 'From a heroic low angle up to eye level.', ['hero', 'rise', 'low angle'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.42, 1.16, e), y: lerp(0.05, -0.02, e), tiltX: lerp(-0.3, 0, e) }; });

// Pan & Tilt
def('pan-left', 'Pan Left', 'pan-tilt', 'Smooth horizontal pan to the left.', ['pan', 'horizontal'], {},
  (t) => { const e = sine(t); return { zoom: 1.22, x: lerp(0.08, -0.08, e), tiltY: lerp(0.05, -0.05, e) }; });
def('pan-right', 'Pan Right', 'pan-tilt', 'Smooth horizontal pan to the right.', ['pan', 'horizontal'], {},
  (t) => { const e = sine(t); return { zoom: 1.22, x: lerp(-0.08, 0.08, e), tiltY: lerp(-0.05, 0.05, e) }; });
def('tilt-up', 'Tilt Up', 'pan-tilt', 'Tilt the camera upward from the ground to the sky.', ['tilt', 'vertical'], {},
  (t) => { const e = sine(t); return { zoom: 1.22, y: lerp(0.08, -0.08, e), tiltX: lerp(0.06, -0.06, e) }; });
def('tilt-down', 'Tilt Down', 'pan-tilt', 'Tilt the camera downward.', ['tilt', 'vertical'], {},
  (t) => { const e = sine(t); return { zoom: 1.22, y: lerp(-0.08, 0.08, e), tiltX: lerp(-0.06, 0.06, e) }; });
def('whip-pan', 'Whip Pan', 'pan-tilt', 'Blurred, lightning-fast pan to the right.', ['fast', 'transition', 'blur'], { popular: true },
  (t) => { const e = inOutQuint(seg(t, 0.38, 0.6)); return { zoom: 1.32, x: lerp(-0.1, 0.1, e) + 0.01 * (t - 0.5), rotate: 0.03 * bump(t, 0.49, 0.06), blur: 16 * bump(t, 0.49, 0.06), shake: 0.3 * bump(t, 0.62, 0.06) }; });
def('whip-pan-left', 'Whip Pan Left', 'pan-tilt', 'Blurred, lightning-fast pan to the left.', ['fast', 'transition', 'blur'], {},
  (t) => { const e = inOutQuint(seg(t, 0.38, 0.6)); return { zoom: 1.32, x: lerp(0.1, -0.1, e) - 0.01 * (t - 0.5), rotate: -0.03 * bump(t, 0.49, 0.06), blur: 16 * bump(t, 0.49, 0.06), shake: 0.3 * bump(t, 0.62, 0.06) }; });
def('whip-tilt', 'Whip Tilt', 'pan-tilt', 'A snap vertical whip with heavy blur.', ['fast', 'vertical', 'blur'], {},
  (t) => { const e = inOutQuint(seg(t, 0.38, 0.6)); return { zoom: 1.32, y: lerp(0.09, -0.09, e), blur: 16 * bump(t, 0.49, 0.06), shake: 0.3 * bump(t, 0.62, 0.06) }; });
def('dutch-angle', 'Dutch Angle', 'pan-tilt', 'Rolls into a tense, off-kilter tilted frame.', ['roll', 'tension', 'thriller'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.12, 1.38, e), rotate: lerp(0, 0.2, e), x: lerp(0, 0.02, e) }; });
def('dutch-roll', 'Dutch Roll', 'pan-tilt', 'Rocks side to side like a ship at sea.', ['roll', 'sway', 'uneasy'], {},
  (t) => ({ zoom: 1.44, rotate: 0.2 * wave(t, 1), x: 0.015 * wave(t, 1, 0.25) }));
def('static', 'Static', 'pan-tilt', 'Locked-off tripod. Only the faintest lens breathing.', ['tripod', 'still', 'calm'], {},
  (t) => ({ zoom: 1.03 + 0.006 * sine(t), shake: 0.03 }));
def('diagonal-pan', 'Diagonal Drift', 'pan-tilt', 'Slow drift across the frame on a diagonal.', ['drift', 'slow'], {},
  (t) => { const e = sine(t); return { zoom: 1.26, x: lerp(-0.06, 0.06, e), y: lerp(0.04, -0.04, e) }; });

// Handheld
def('handheld', 'Handheld', 'handheld', 'Organic shoulder-rig sway with natural micro-shake.', ['shaky', 'documentary', 'natural'], { popular: true },
  (t) => ({ zoom: 1.16, x: 0.01 * wave(t, 0.5), shake: 0.45 }));
def('snorricam', 'Snorricam', 'handheld', 'Body-mounted rig: the subject stays locked, the world swings.', ['body mount', 'disorienting', 'music video'], { popular: true },
  (t) => ({ zoom: 1.32, rotate: 0.07 * wave(t, 0.9), x: 0.025 * wave(t, 0.7, 0.3), y: 0.012 * wave(t, 1.4), shake: 0.5, fx: 'snorricam', fxAmount: 1 }));
def('car-grip', 'Car Grip', 'handheld', 'Mounted to a moving car: lateral glide plus road vibration.', ['vehicle', 'tracking', 'speed'], {},
  (t) => ({ zoom: 1.22, x: lerp(-0.05, 0.05, t), y: 0.004 * wave(t, 41), tiltY: lerp(0.08, -0.08, t), shake: 0.22, blur: 0.8 }));
def('walking', 'Walk & Talk', 'handheld', 'Steady walking push with a footstep bob.', ['walk', 'follow', 'vlog'], {},
  (t) => ({ zoom: lerp(1.12, 1.3, t), y: 0.01 * Math.abs(wave(t, 3)), x: 0.008 * wave(t, 1.5), rotate: 0.008 * wave(t, 1.5), shake: 0.2 }));
def('documentary', 'Documentary', 'handheld', 'Operator reframes mid-shot like a real camera crew.', ['doc', 'reframe', 'real'], {},
  (t) => ({ zoom: keys(t, [[0.2, 1.12], [0.55, 1.28]]), x: keys(t, [[0.2, 0.02], [0.55, -0.015]]), shake: 0.35 }));
def('earthquake', 'Earthquake', 'handheld', 'Violent rumble that builds and fades.', ['shake', 'chaos', 'action'], {},
  (t) => { const env = bump(t, 0.5, 0.28); return { zoom: 1.3, x: 0.018 * env * wave(t, 23), y: 0.024 * env * wave(t, 31, 0.3), rotate: 0.02 * env * wave(t, 17), shake: 0.4 + 0.6 * env, blur: 2 * env }; });
def('impact-shake', 'Impact', 'handheld', 'A calm frame hit by a single heavy jolt.', ['hit', 'jolt', 'action'], {},
  (t) => { const k = jolt(t, 0.4, 7); return { zoom: 1.18 + 0.12 * k, x: 0.035 * k * wave(t, 18), y: 0.03 * k * wave(t, 23, 0.2), rotate: 0.025 * k * wave(t, 13), blur: 6 * k, fx: 'flash', fxAmount: 0.85 * jolt(t, 0.4, 22) }; });

// Drone & FPV
def('fpv-drone', 'FPV Drone', 'drone', 'Racing-drone dive with banking turns and speed.', ['fpv', 'fast', 'aerial'], { popular: true },
  (t) => ({ zoom: zoomExp(1.05, 2.2, smooth(t)), rotate: 0.17 * wave(t, 0.8), x: 0.045 * wave(t, 0.8, 0.3), y: lerp(0.03, -0.02, t) + 0.015 * wave(t, 1.6), tiltX: 0.1 * wave(t, 0.8, 0.1), shake: 0.25, fx: 'radial', fxAmount: 0.55 * smooth(t) }));
def('drone-flyover', 'Drone Flyover', 'drone', 'Glides forward over the scene, looking down.', ['aerial', 'forward', 'landscape'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.26, 1.46, e), y: lerp(-0.08, 0.08, e), tiltX: lerp(0.24, 0.1, e), shake: 0.08 }; });
def('drone-reveal', 'Drone Reveal', 'drone', 'Rises and pulls back to unveil the landscape.', ['aerial', 'reveal', 'epic'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.8, 1.05, e), y: lerp(0.06, -0.03, e), tiltX: lerp(-0.1, 0.12, e), shake: 0.06 }; });
def('drone-orbit', 'Drone Orbit', 'drone', 'High, slow orbit around the subject.', ['aerial', 'orbit'], {},
  (t) => { const e = sine(t); return { zoom: 1.34, x: lerp(0.07, -0.07, e), rotate: lerp(-0.06, 0.06, e), tiltX: 0.14, tiltY: lerp(-0.2, 0.2, e), shake: 0.05 }; });
def('flying', 'Flying', 'drone', 'Soaring forward flight with gentle banking.', ['fly', 'soar', 'aerial'], {},
  (t) => ({ zoom: lerp(1.15, 1.62, t), y: 0.02 * wave(t, 1.2), rotate: 0.07 * wave(t, 0.6), x: 0.03 * wave(t, 0.6, 0.1), shake: 0.1 }));
def('hyperlapse', 'Hyperlapse', 'drone', 'Stepped forward motion with racing light.', ['time', 'city', 'travel'], { new: true },
  (t) => { const s = t * 6; const st = Math.floor(s) + smooth(Math.min(1, (s % 1) * 2)); return { zoom: 1.05 + 0.1 * Math.min(6, st), shake: 0.12, fx: 'timelapse', fxAmount: t }; });
def('top-down-rise', 'Top-Down Ascend', 'drone', 'Straight-down drone shot that climbs and rotates.', ['top-down', 'aerial', 'rise'], {},
  (t) => { const e = sine(t); return { zoom: lerp(2.1, 1.35, e), rotate: lerp(-0.18, 0.18, e) }; });
def('fly-through', 'Fly-Through', 'drone', 'Punches forward through the scene at full throttle.', ['fast', 'forward', 'tunnel'], {},
  (t) => ({ zoom: zoomExp(1.02, 3.2, inCubic(t)), blur: 3 * inCubic(t), shake: 0.15, fx: 'radial', fxAmount: inCubic(t) }));

// Lens & Focus
def('rack-focus', 'Rack Focus', 'lens', 'Focus pulls from the background onto the subject.', ['focus', 'depth', 'cinematic'], { popular: true },
  (t) => ({ zoom: 1.12 + 0.03 * smooth(seg(t, 0.3, 0.65)), fx: 'rackfocus', fxAmount: smooth(seg(t, 0.3, 0.65)) }));
def('focus-change', 'Focus Change', 'lens', 'Defocuses fully, then snaps back sharp.', ['focus', 'transition'], {},
  (t) => ({ zoom: 1.1 + 0.02 * bump(t, 0.5, 0.2), blur: 9 * bump(t, 0.5, 0.17) }));
def('blur-reveal', 'Blur Reveal', 'lens', 'Opens out of a soft blur into crisp focus.', ['reveal', 'intro', 'focus'], {},
  (t) => { const e = sine(seg(t, 0, 0.8)); return { zoom: lerp(1.26, 1.08, e), blur: lerp(14, 0, e) }; });
def('lens-breathing', 'Lens Breathing', 'lens', 'Subtle focus breathing for an analog lens feel.', ['analog', 'subtle', 'vintage'], {},
  (t) => ({ zoom: 1.1 + 0.03 * (0.5 + 0.5 * wave(t, 1)), blur: 1.4 * (0.5 + 0.5 * wave(t, 1, 0.25)) }));
def('defocus-out', 'Dream Defocus', 'lens', 'Drifts out of focus into a warm, glowing haze.', ['dream', 'outro', 'soft'], {},
  (t) => { const e = sine(t); return { zoom: lerp(1.05, 1.22, e), blur: lerp(0, 10, e), fx: 'lightleak', fxAmount: 0.6 * e }; });
def('tunnel-vision', 'Tunnel Vision', 'lens', 'Radial zoom-blur that pulls everything to the center.', ['radial', 'zoom blur', 'intense'], {},
  (t) => ({ zoom: lerp(1.1, 1.38, sine(t)), fx: 'radial', fxAmount: 0.7 + 0.25 * sine(t) }));

// Effects
def('glitch', 'Glitch', 'fx', 'Digital breakup: RGB split, slice tears and scan noise.', ['digital', 'rgb', 'cyber'], { popular: true },
  (t) => { const g = bursts(t, 6, 3, 0.12); return { zoom: 1.15 + 0.08 * sine(t), shake: 0.12 + 0.35 * g, fx: 'glitch', fxAmount: g }; });
def('disintegration', 'Disintegration', 'fx', 'The image dissolves into drifting particles.', ['dust', 'thanos', 'particles'], { popular: true },
  (t) => ({ zoom: 1.1 + 0.08 * t, fx: 'disintegrate', fxAmount: smooth(seg(t, 0.15, 0.92)) }));
def('explosion', 'Explosion', 'fx', 'Shatters outward in a fiery blast.', ['blast', 'shatter', 'action'], { new: true },
  (t) => { const k = jolt(t, 0.38, 4); return { zoom: 1.12 + 0.06 * seg(t, 0, 0.38), shake: 0.9 * k, fx: 'explode', fxAmount: seg(t, 0.38, 1) }; });
def('flash-cut', 'Flash Cut', 'fx', 'Paparazzi flashes with jump-cut punch-ins.', ['flash', 'jump cut', 'fashion'], {},
  (t) => ({ zoom: keys(t, [[0.32, 1.06], [0.34, 1.3], [0.65, 1.3], [0.67, 1.55]], smooth), fx: 'flash', fxAmount: Math.max(jolt(t, 0.33, 14), jolt(t, 0.66, 14)) }));
def('strobe', 'Strobe', 'fx', 'Club strobe hits pulsing in rhythm.', ['flash', 'club', 'rhythm'], {},
  (t) => ({ zoom: 1.1 + 0.03 * wave(t, 4), fx: 'flash', fxAmount: 0.6 * Math.exp(-((t * 8) % 1) * 9) }));
def('timelapse', 'Timelapse', 'fx', 'Light races from day through dusk to night.', ['time', 'sky', 'day to night'], { popular: true },
  (t) => ({ zoom: lerp(1.06, 1.16, t), fx: 'timelapse', fxAmount: t }));
def('light-leak', 'Light Leak', 'fx', 'Warm analog light leaks bleed across the frame.', ['analog', 'film', 'warm'], {},
  (t) => ({ zoom: 1.08 + 0.1 * sine(t), fx: 'lightleak', fxAmount: 0.45 + 0.55 * bump(t, 0.5, 0.3) }));
def('heartbeat', 'Heartbeat', 'fx', 'Double-pulse zoom that throbs like a heartbeat.', ['pulse', 'beat', 'tension'], {},
  (t) => { const b = (c) => bump(t, c, 0.025); const p = b(0.15) + 0.7 * b(0.24) + b(0.55) + 0.7 * b(0.64); return { zoom: 1.08 + 0.09 * p, blur: 2.5 * p, fx: 'radial', fxAmount: 0.4 * p }; });
def('shockwave', 'Shockwave', 'fx', 'A blast punch-in with a white flash and ripple shake.', ['impact', 'punch', 'flash'], {},
  (t) => { const k = jolt(t, 0.45, 6); return { zoom: 1.08 + 0.32 * k * smooth(seg(t, 0.45, 0.48)) + 0.06 * seg(t, 0.45, 1), shake: 0.7 * k, blur: 6 * jolt(t, 0.45, 14), fx: 'flash', fxAmount: jolt(t, 0.45, 16) }; });
def('warp-speed', 'Hyperspeed', 'fx', 'Jump to lightspeed with streaking radial blur.', ['space', 'speed', 'warp'], { new: true },
  (t) => ({ zoom: zoomExp(1.02, 2.6, t * t), blur: 2 * t * t, fx: 'radial', fxAmount: 0.3 + 0.7 * t }));
def('vhs', 'VHS Rewind', 'fx', 'Tape tracking errors, jitter and color bleed.', ['retro', 'tape', '90s'], {},
  (t) => { const g = bursts(t, 4, 41, 0.22); return { zoom: 1.12, x: 0.006 * Math.round(wave(t, 3) * 2), shake: 0.1, fx: 'glitch', fxAmount: g }; });

export const PRESETS = P.map(({ fn, ...meta }) => meta);
const MOTION = new Map(P.map((p) => [p.id, p.fn]));
const BY_ID = new Map(PRESETS.map((p) => [p.id, p]));

// Friendly aliases so links like #/video?preset=360-orbit keep working.
const ALIASES = {
  '360-orbit': 'orbit-360', orbit: 'orbit-360', 'crash-zoom-in': 'crash-zoom', 'super-dolly-in': 'super-dolly',
  vertigo: 'dolly-zoom', 'dolly-zoom-in': 'dolly-zoom', 'whip-pan-right': 'whip-pan', disintegrate: 'disintegration',
  explode: 'explosion', flash: 'flash-cut', fpv: 'fpv-drone', dutch: 'dutch-angle', 'focus-pull': 'rack-focus',
  'zoom-in': 'dolly-in', 'zoom-out': 'dolly-out', tripod: 'static', 'time-lapse': 'timelapse', hyperspeed: 'warp-speed',
  impact: 'impact-shake', 'jib-up': 'crane-up', 'jib-down': 'crane-down', 'earth-zoom': 'earth-zoom-out',
};

/** Look up a preset by id (or a common alias). */
export function presetById(id) {
  if (id == null) return undefined;
  const key = String(id).toLowerCase();
  return BY_ID.get(key) ?? BY_ID.get(ALIASES[key]);
}

export const NEUTRAL = Object.freeze({ zoom: 1, x: 0, y: 0, rotate: 0, tiltX: 0, tiltY: 0, blur: 0, shake: 0, fx: null, fxAmount: 0 });
const num = (v, d) => (Number.isFinite(v) ? v : d);

/**
 * The virtual camera of `presetId` at normalized time t (0..1, eased inside).
 * intensity scales every motion away from neutral (0 = static, 1 = as designed, up to ~2).
 * Unknown ids return a static camera.
 */
export function cameraAt(presetId, t, { intensity = 1 } = {}) {
  const tt = clamp(num(t, 0), 0, 1);
  const k = clamp(num(intensity, 1), 0, 2);
  const fn = MOTION.get(presetById(presetId)?.id);
  const raw = fn ? fn(tt) : {};
  const c = { ...NEUTRAL, ...raw };
  return {
    zoom: clamp(Math.exp(Math.log(Math.max(1, num(c.zoom, 1))) * k), 1, 12),
    x: clamp(num(c.x, 0) * k, -0.45, 0.45),
    y: clamp(num(c.y, 0) * k, -0.45, 0.45),
    rotate: clamp(num(c.rotate, 0) * k, -Math.PI, Math.PI),
    tiltX: clamp(num(c.tiltX, 0) * k, -0.6, 0.6),
    tiltY: clamp(num(c.tiltY, 0) * k, -0.6, 0.6),
    blur: clamp(num(c.blur, 0) * k, 0, 40),
    shake: clamp(num(c.shake, 0) * k, 0, 1),
    fx: typeof c.fx === 'string' ? c.fx : null,
    fxAmount: clamp(num(c.fxAmount, 0), 0, 1),
  };
}
