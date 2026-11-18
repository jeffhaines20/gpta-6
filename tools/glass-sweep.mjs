// #36's lever surface, read off an arms capture rather than shot point by point.
//
//   node tools/glass-sweep.mjs <dir> [--tag sw]   the surface over (F0 scale, room level), per hour
//   node tools/glass-sweep.mjs --selftest         the synthesis on arrays whose answers are known
//
// WHY THIS IS ALLOWED. Every term the two levers move enters the frame LINEARLY in scene-linear
// radiance - the exposure is a fixed per-hour constant (src/daynight.js), there is no adaptation, and
// tools/pane-tint.mjs' TRANSFER.aces inverts the composite's encode. In the glass texels, with the
// room on (uGlassRoom 1), a pane is
//
//     L(s, K) = A(s) + K * Room(s)
//
// where s scales F0 and K is the room's light: A is the specular (and the F90 rise, which s does not
// touch) and Room is linear in K by construction (the shader multiplies by uGlassRoomK and nothing
// else). A is linear in s for the F0 term; Room(s) moves with s only through the transmission's
// (1 - F), which is near-linear over the range. So four arms - (s, K) at (1, 0), (1, K1), (s1, 0),
// (s1, K1) - give the whole plane by bilinear interpolation, and a fifth, held out, says whether that
// is true: the `mid` arm is SHOT, and the surface has to PREDICT it.
//
// What it does NOT model is anything nonlinear after the scene: bloom's threshold and the
// antialiasing filter. Both are small on glass that is not clipped, and the held-out arm's residual
// is the measured size of everything this file assumes away.
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';
import { TRANSFER, ROLLOFF, horizonRow, detect } from './pane-tint.mjs';
import { loadCapture, classify, paneStructure } from './glaz-probe.mjs';

const a2l = TRANSFER.aces;
const Yl = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Linear RGB of one capture's frame, as three Float64Arrays. */
export function linearFrame(png) {
  const n = png.width * png.height, ch = png.channels;
  const r = new Float64Array(n), g = new Float64Array(n), b = new Float64Array(n);
  for (let i = 0; i < n; i++) { r[i] = a2l[png.data[i * ch]]; g[i] = a2l[png.data[i * ch + 1]]; b[i] = a2l[png.data[i * ch + 2]]; }
  return { r, g, b, n };
}

/**
 * The bilinear surface. `arms` holds linear frames keyed by the corner they were shot at; returns a
 * function (s, K) -> linear frame on the glass texels (other texels are the r1k0 corner, which no
 * room lever moves - wall texels are bit-identical in every arm, which the gate asserts).
 */
export function surface(arms, { s1, K1 }) {
  const c00 = arms.r1k0, c01 = arms.r1k5, c10 = arms.r3k0, c11 = arms.r3k5;
  for (const [k, v] of Object.entries({ r1k0: c00, r1k5: c01, r3k0: c10, r3k5: c11 })) {
    if (!v) throw new Error(`glass-sweep: corner ${k} missing`);
  }
  return (s, K) => {
    const u = (1 - s) / (1 - s1);          // 0 at s = 1, 1 at s = s1
    const v = K / K1;
    const out = { r: new Float64Array(c00.n), g: new Float64Array(c00.n), b: new Float64Array(c00.n), n: c00.n };
    for (const ch of ['r', 'g', 'b']) {
      const a = c00[ch], b2 = c01[ch], c = c10[ch], d = c11[ch], o = out[ch];
      for (let i = 0; i < c00.n; i++) {
        const base = a[i] + u * (c[i] - a[i]);                      // A(s)
        const room = (b2[i] - a[i]) + u * ((d[i] - c[i]) - (b2[i] - a[i]));   // Room(s) at K1
        o[i] = base + v * room;
      }
    }
    return out;
  };
}

/** The ratios pane-tint --truth reports, on a linear frame and a class map, above the horizon. */
export function frameStats(L, cls, w, h) {
  const hr = Math.round(horizonRow(h));
  const acc = { 1: [0, 0, 0, 0, 0], 2: [0, 0, 0, 0, 0] };
  const lum = new Float64Array(w * h).fill(NaN);
  for (let i = 0; i < w * h; i++) {
    const k = cls[i];
    if (k !== 1 && k !== 2) continue;
    const y = (i / w) | 0;
    const Y = Yl(L.r[i], L.g[i], L.b[i]);
    if (k === 1) lum[i] = Y;
    if (y > hr) continue;
    const A = acc[k]; A[0] += L.r[i]; A[1] += L.g[i]; A[2] += L.b[i]; A[3] += Y; A[4]++;
  }
  const G = acc[1], W2 = acc[2];
  const glassBR = G[0] > 0 ? G[2] / G[0] : NaN, wallBR = W2[0] > 0 ? W2[2] / W2[0] : NaN;
  const st = paneStructure(cls, lum, w, h, { want: 1, rowMax: hr });
  return {
    glassBR, wallBR, shift: glassBR / wallBR,
    paneWall: G[4] && W2[4] ? (G[3] / G[4]) / (W2[3] / W2[4]) : NaN,
    modulation: st.modMedian, flatFrac: st.flatFrac, paneCV: st.cv, glassPx: G[4],
    // The sums, so a caller can POOL over views by pixel rather than take a median of per-view
    // ratios - a view with five panes weighs as much as one with fifty in a median.
    sums: { gR: G[0], gB: G[2], gY: G[3], gN: G[4], wR: W2[0], wB: W2[2], wY: W2[3], wN: W2[4] },
  };
}
/**
 * WHERE A PANE'S COLOUR COMES FROM, read off the shot arms rather than modelled. With the room on at
 * K 0 the coating's diffuse is replaced by nothing, so r1k0 IS the specular; r1k0 - r3k0 is (1 - s1) of
 * the F0 reflection (the specular is linear in s through F0 * DFG.x); the rest of r1k0 is the F90 rise
 * no F0 scale reaches; off - r1k0 is the diffuse the room replaces; (r1k5 - r1k0) / K1 is the room per
 * unit K at F0 x1. Channel SUMS over the glass texels above the horizon - and the wall's, for a shift -
 * so views pool by adding them. `negF0` counts glass channels whose F0 part came out below -1e-4: a
 * clean capture reads ~0, two corners captured under each other's names read the whole population.
 */
export function decomposeSums(arms, cls, w, h, { s1 = 0.3, K1 = 0.5 } = {}) {
  const hr = Math.round(horizonRow(h));
  const keys = ['off', 'spec', 'f0', 'f90', 'diff', 'roomK', 'r1k0', 'r1k5', 'r3k0', 'r3k5', 'wall'];
  const T = Object.fromEntries(keys.map((k) => [k, { r: 0, g: 0, b: 0 }]));
  T.n = 0; T.negF0 = 0;
  for (let i = 0; i < w * h; i++) {
    if (((i / w) | 0) > hr) continue;
    if (cls[i] === 2) { for (const ch of ['r', 'g', 'b']) T.wall[ch] += arms.off[ch][i]; continue; }
    if (cls[i] !== 1) continue;
    T.n++;
    for (const ch of ['r', 'g', 'b']) {
      const off = arms.off[ch][i], a1 = arms.r1k0[ch][i], a3 = arms.r3k0[ch][i];
      const f0 = (a1 - a3) / (1 - s1);
      if (f0 < -1e-4) T.negF0++;
      T.off[ch] += off; T.spec[ch] += a1; T.f0[ch] += f0; T.f90[ch] += a1 - f0; T.diff[ch] += off - a1;
      T.roomK[ch] += (arms.r1k5[ch][i] - a1) / K1;
      T.r1k0[ch] += a1; T.r3k0[ch] += a3; T.r1k5[ch] += arms.r1k5[ch][i]; T.r3k5[ch] += arms.r3k5[ch][i];
    }
  }
  return T;
}
/** Add decomposeSums results, view by view, into one pool. */
export function poolSums(list) {
  const out = {};
  for (const T of list) {
    for (const [k, v] of Object.entries(T)) {
      if (typeof v === 'number') out[k] = (out[k] ?? 0) + v;
      else { out[k] ??= { r: 0, g: 0, b: 0 }; for (const ch of ['r', 'g', 'b']) out[k][ch] += v[ch]; }
    }
  }
  return out;
}
/**
 * THE ROOM A POOLED PANE WOULD NEED. At F0 scale s the pane is A(s) + K R(s) channel by channel, so its
 * B/R runs monotonically from A's own (K 0) to R's own (K -> infinity) and the K that lands a target is
 * closed form. Returns null when no K can: a target outside that interval is not "a big K", and a room
 * whose own light is bluer than the target can never warm a pane down to it.
 */
export function roomNeeded(T, s, target, { s1 = 0.3, K1 = 0.5 } = {}) {
  const u = (1 - s) / (1 - s1);
  const A = (ch) => T.r1k0[ch] + u * (T.r3k0[ch] - T.r1k0[ch]);
  const R = (ch) => ((T.r1k5[ch] - T.r1k0[ch]) + u * ((T.r3k5[ch] - T.r3k0[ch]) - (T.r1k5[ch] - T.r1k0[ch]))) / K1;
  const br0 = A('b') / A('r'), brInf = R('b') / R('r');
  const lum = (f) => 0.2126 * f('r') + 0.7152 * f('g') + 0.0722 * f('b');
  const K = (target - br0) * (target - brInf) < 0 ? (target * A('r') - A('b')) / (R('b') - target * R('r')) : null;
  return { K, br0, brInf, roomOverReflection: K === null ? null : (K * lum(R)) / lum(A),
    shareAt: (k) => (k * lum(R)) / (lum(A) + k * lum(R)), brAt: (k) => (A('b') + k * R('b')) / (A('r') + k * R('r')) };
}

/** Pixel-pooled glass B/R, shift and pane:wall over a list of frameStats results. */
export function pooled(list) {
  const t = { gR: 0, gB: 0, gY: 0, gN: 0, wR: 0, wB: 0, wY: 0, wN: 0 };
  for (const x of list) for (const k of Object.keys(t)) t[k] += x.sums[k];
  const glassBR = t.gB / t.gR, wallBR = t.wB / t.wR;
  return { glassBR, wallBR, shift: glassBR / wallBR, paneWall: (t.gY / t.gN) / (t.wY / t.wN) };
}

/**
 * THE PHOTOGRAPH'S INSTRUMENT ON A SYNTHESISED FRAME. pane-tint's reference numbers (0.804, 0.915,
 * 0.247) are its DETECTOR's, on 8-bit photographs at 1280x960, so a like-for-like reading of an arm
 * needs the same detector on the same kind of input. A surface point exists only in linear light, so
 * it is encoded through the renderer's own forward chain - the rolloff, the ACES fit, the sRGB encode,
 * exactly what TRANSFER.aces inverts - and upscaled 2x by pixel duplication, because the detector's
 * component and pane-count floors are in absolute pixels at 1280x960. That last step is an
 * approximation, and it is measured rather than assumed: see the CLI's NATIVE line.
 */
export function encodeByte(x) {
  const S = ROLLOFF.ceil - ROLLOFF.knee, t = Math.max(0, x - ROLLOFF.knee);
  const y = Math.min(x, ROLLOFF.knee) + (S * t) / (S + t);
  const z = Math.max(0, Math.min(1, (y * (2.51 * y + 0.03)) / (y * (2.43 * y + 0.59) + 0.14)));
  const e = z <= 0.0031308 ? 12.92 * z : 1.055 * z ** (1 / 2.4) - 0.055;
  return Math.max(0, Math.min(255, Math.round(255 * e)));
}
export function detectLinear(L, w, h, up = 2, truth = null) {
  const W2 = w * up, H2 = h * up;
  const data = new Uint8Array(W2 * H2 * 3);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const i = ((y / up) | 0) * w + ((x / up) | 0), o = (y * W2 + x) * 3;
      data[o] = encodeByte(L.r[i]); data[o + 1] = encodeByte(L.g[i]); data[o + 2] = encodeByte(L.b[i]);
    }
  }
  const d = detect({ width: W2, height: H2, channels: 3, data }, { transfer: 'aces' });
  // Whether or not it scores the view, what it CALLED glass is checkable against the shader's mask.
  const agree = truth ? detectorAgreement(d.cls, truth, w, h, up, d.hr) : null;
  return d.ok ? { ok: true, glassBR: d.glassBR, wallBR: d.wallBR, shift: d.shift, paneWall: d.paneWall, agree }
    : { ok: false, why: d.why.join('; '), agree };
}

/**
 * IS THE PHOTOGRAPHS' DETECTOR READING GLASS ON THIS FRAME? pane-tint finds a pane as an opening dark
 * against its wall - true of the photographs, and the reason its 0.804 means "glazing" there. On an
 * engine frame the packed texel says what is glass exactly, so the detector's own "pane" class can be
 * scored: PRECISION is the share of its pane pixels that are glass by the shader's mask, RECALL the
 * share of the glass above its horizon that it called pane, and `hist` where the rest of its panes
 * fell (glaz-probe's classes: 0 not a facade, 1 glass, 2 wall, 3 sky, 4 shopfront glass). `det` is its
 * class map at `up` x the truth's resolution, and a map of any other size THROWS: reading a 2x map at
 * 1x scores a quarter of the frame against the wrong pixels and returns a plausible number.
 */
export function detectorAgreement(det, truth, w, h, up, hr) {
  if (det.length !== w * h * up * up || truth.length !== w * h) {
    throw new Error(`detectorAgreement: maps of ${det.length} and ${truth.length} for ${w}x${h} at ${up}x`);
  }
  const W2 = w * up, H2 = h * up, hist = [0, 0, 0, 0, 0];
  let pane = 0, glass = 0, glassHit = 0;
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const j = y * W2 + x, t = truth[((y / up) | 0) * w + ((x / up) | 0)];
      if (det[j] === 1) { pane++; if (t <= 4) hist[t]++; }
      if (y <= hr && t === 1) { glass++; if (det[j] === 1) glassHit++; }
    }
  }
  return { precision: pane ? hist[1] / pane : NaN, recall: glass ? glassHit / glass : NaN, panePx: pane,
    hist: hist.map((v) => (pane ? v / pane : 0)) };
}

const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};

// ------------------------------------------------------------------ selftest
function selftest() {
  const fails = [];
  const ck = (name, ok, got) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${name}   ${got}`); if (!ok) fails.push(name); };
  // A synthetic scene where the model is EXACT: per pixel, A(s) = a0 + (1 - s) * a1 and
  // Room(s) = r0 + (1 - s) * r1, so every corner and every interior point is known in closed form.
  const n = 400, w = 20, h = 20;
  const rnd = (k) => { let x = Math.sin(k * 12.9898) * 43758.5453; return x - Math.floor(x); };
  const truth = (s, K) => {
    const o = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), n };
    for (let i = 0; i < n; i++) {
      for (const [ci, ch] of [[0, 'r'], [1, 'g'], [2, 'b']]) {
        const a0 = 0.02 + 0.05 * rnd(i * 3 + ci), a1 = -0.01 * rnd(i * 7 + ci);
        const r0 = 0.03 * rnd(i * 11 + ci), r1 = 0.004 * rnd(i * 13 + ci);
        o[ch][i] = a0 + (1 - s) * a1 + K * (r0 + (1 - s) * r1);
      }
    }
    return o;
  };
  const arms = { r1k0: truth(1, 0), r1k5: truth(1, 0.5), r3k0: truth(0.3, 0), r3k5: truth(0.3, 0.5) };
  const S = surface(arms, { s1: 0.3, K1: 0.5 });
  let worst = 0;
  for (const [s, K] of [[0.5, 0.25], [0.8, 0.1], [0.3, 1.0], [1, 0.35]]) {
    const p = S(s, K), t = truth(s, K);
    for (const ch of ['r', 'g', 'b']) for (let i = 0; i < n; i++) worst = Math.max(worst, Math.abs(p[ch][i] - t[ch][i]));
  }
  ck('where the model is exact, the surface reproduces every interior point to 1e-12', worst < 1e-12, worst.toExponential(2));
  // KNOWN-BAD: two corners swapped (an arm captured under the wrong name). The held-out point must miss.
  const swapped = surface({ ...arms, r1k5: arms.r3k5, r3k5: arms.r1k5 }, { s1: 0.3, K1: 0.5 });
  let miss = 0;
  { const p = swapped(0.5, 0.25), t = truth(0.5, 0.25);
    for (let i = 0; i < n; i++) miss = Math.max(miss, Math.abs(p.r[i] - t.r[i])); }
  ck('KNOWN-BAD two corners swapped: the held-out point misses by more than 1e-4', miss > 1e-4, miss.toExponential(2));
  // KNOWN-BAD: a missing corner throws rather than interpolating from nothing.
  let threw = false;
  try { surface({ r1k0: arms.r1k0, r1k5: arms.r1k5, r3k0: arms.r3k0 }, { s1: 0.3, K1: 0.5 }); } catch { threw = true; }
  ck('KNOWN-BAD a missing corner throws', threw, String(threw));
  // frameStats on a frame whose answer is built in: glass B/R 2, wall B/R 1, pane:wall 0.25.
  const cls = new Uint8Array(w * h), L = { r: new Float64Array(n), g: new Float64Array(n), b: new Float64Array(n), n };
  for (let i = 0; i < n; i++) {
    const x = i % w; cls[i] = x < 10 ? 1 : 2;
    if (cls[i] === 1) { L.r[i] = 0.05; L.g[i] = 0.075; L.b[i] = 0.10; } else { L.r[i] = 0.3; L.g[i] = 0.3; L.b[i] = 0.3; }
  }
  const fs1 = frameStats(L, cls, w, h);
  const wantPW = Yl(0.05, 0.075, 0.10) / 0.3;
  ck('frameStats reads a built glass B/R 2.000, wall 1.000, pane:wall exact',
    Math.abs(fs1.glassBR - 2) < 1e-9 && Math.abs(fs1.wallBR - 1) < 1e-9 && Math.abs(fs1.paneWall - wantPW) < 1e-9,
    `${fs1.glassBR.toFixed(4)} / ${fs1.wallBR.toFixed(4)} / ${fs1.paneWall.toFixed(4)} want ${wantPW.toFixed(4)}`);
  // pooled() weighs by pixel. Two frames: a big one at glass B/R 2 and a five-pixel one at B/R 0.5. The
  // pool must sit at the big one's value; a mean of the two ratios (1.25) is the error it exists to avoid.
  {
    const mk = (nG, br) => {
      const n2 = nG + 40, c2 = new Uint8Array(n2), L2 = { r: new Float64Array(n2), g: new Float64Array(n2), b: new Float64Array(n2), n: n2 };
      for (let i = 0; i < n2; i++) {
        if (i < nG) { c2[i] = 1; L2.r[i] = 0.05; L2.g[i] = 0.06; L2.b[i] = 0.05 * br; } else { c2[i] = 2; L2.r[i] = L2.g[i] = L2.b[i] = 0.3; }
      }
      return frameStats(L2, c2, n2, 1);
    };
    const P = pooled([mk(4000, 2), mk(5, 0.5)]);
    ck('pooled() weighs by pixel: 4000 px at B/R 2 and 5 px at 0.5 pool to 1.998, not the 1.25 a ratio mean gives',
      Math.abs(P.glassBR - (4000 * 0.1 + 5 * 0.025) / (4005 * 0.05)) < 1e-9 && P.glassBR > 1.99, P.glassBR.toFixed(4));
  }
  // detectorAgreement, on maps whose answer is built in. Truth: a 10x10 glass block in a 20x20 wall.
  {
    const tw = 20, th = 20, up = 2, truthM = new Uint8Array(tw * th);
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) truthM[y * tw + x] = x >= 5 && x < 15 && y >= 5 && y < 15 ? 1 : 2;
    const upMap = (fn) => { const o = new Uint8Array(tw * th * up * up); for (let y = 0; y < th * up; y++) for (let x = 0; x < tw * up; x++) o[y * tw * up + x] = fn(x, y); return o; };
    const exact = detectorAgreement(upMap((x, y) => truthM[((y / up) | 0) * tw + ((x / up) | 0)] === 1 ? 1 : 2), truthM, tw, th, up, th * up);
    ck('detectorAgreement: a detector that finds exactly the glass reads precision 1, recall 1',
      exact.precision === 1 && exact.recall === 1, `${exact.precision} / ${exact.recall}`);
    // Half its panes are wall: the 100 px glass block, and the five full rows of wall under it (100 px).
    const half = detectorAgreement(upMap((x, y) => { const tx = (x / up) | 0, ty = (y / up) | 0; return (ty >= 5 && ty < 15 && tx >= 5 && tx < 15) || ty >= 15 ? 1 : 2; }), truthM, tw, th, up, th * up);
    ck('and one whose pane class is half wall reads precision 0.5, recall 1, hist wall 0.5',
      Math.abs(half.precision - 0.5) < 1e-12 && half.recall === 1 && Math.abs(half.hist[2] - 0.5) < 1e-12,
      `${half.precision} / ${half.recall} / wall ${half.hist[2]}`);
    // KNOWN-BAD: the detector's 2x map handed over as if it were 1x. Must throw, not score the wrong pixels.
    let threw2 = false;
    try { detectorAgreement(new Uint8Array(tw * th), truthM, tw, th, up, th * up); } catch { threw2 = true; }
    ck('KNOWN-BAD a class map at the wrong resolution throws rather than scoring the wrong pixels', threw2, String(threw2));
    // KNOWN-BAD: a detector that finds nothing reads NaN precision - "no reading", never a perfect score.
    const none = detectorAgreement(upMap(() => 2), truthM, tw, th, up, th * up);
    ck('KNOWN-BAD a detector with no panes reads NaN precision and recall 0, not 100%',
      Number.isNaN(none.precision) && none.recall === 0, `${none.precision} / ${none.recall}`);
  }
  // decomposeSums and roomNeeded on arms whose terms are KNOWN: per pixel F0 reflection f, F90 rise q,
  // coating diffuse d and a room per unit K of m1 at F0 x1 and m3 at x0.3, every arm built from them.
  {
    const dw = 10, dh = 8, nn = dw * dh, dcls = new Uint8Array(nn).fill(1);
    for (let i = 0; i < nn; i += 4) dcls[i] = 2;                       // a wall texel in every four
    const rnd2 = (k) => { const x = Math.sin(k * 78.233) * 43758.5453; return x - Math.floor(x); };
    const terms = (i, c) => ({ f: 0.05 + 0.05 * rnd2(i * 5 + c), q: 0.02 * rnd2(i * 7 + c), d: 0.03 * rnd2(i * 3 + c),
      m1: 0.04 * rnd2(i * 11 + c), m3: 0.045 * rnd2(i * 13 + c) });
    const mk = (fn) => { const o = { r: new Float64Array(nn), g: new Float64Array(nn), b: new Float64Array(nn), n: nn };
      for (let i = 0; i < nn; i++) for (const [c, ch] of [[0, 'r'], [1, 'g'], [2, 'b']]) o[ch][i] = fn(terms(i, c)); return o; };
    const A2 = { off: mk((t) => t.f + t.q + t.d), r1k0: mk((t) => t.f + t.q), r3k0: mk((t) => 0.3 * t.f + t.q),
      r1k5: mk((t) => t.f + t.q + 0.5 * t.m1), r3k5: mk((t) => 0.3 * t.f + t.q + 0.5 * t.m3) };
    const T = decomposeSums(A2, dcls, dw, dh);
    let want = { f: 0, q: 0, d: 0, m1: 0 }, worst = 0;
    const hr = Math.round(horizonRow(dh));
    for (const ch of ['r', 'g', 'b']) {
      want = { f: 0, q: 0, d: 0, m1: 0 };
      for (let i = 0; i < nn; i++) { if (dcls[i] !== 1 || ((i / dw) | 0) > hr) continue; const t = terms(i, ['r', 'g', 'b'].indexOf(ch)); want.f += t.f; want.q += t.q; want.d += t.d; want.m1 += t.m1; }
      worst = Math.max(worst, Math.abs(T.f0[ch] - want.f), Math.abs(T.f90[ch] - want.q), Math.abs(T.diff[ch] - want.d), Math.abs(T.roomK[ch] - want.m1));
    }
    ck('decomposeSums recovers the F0, F90, diffuse and room terms an arm set was built from, to 1e-12',
      worst < 1e-12 && T.negF0 === 0 && T.n > 0, `worst ${worst.toExponential(2)}, ${T.n} glass px, negF0 ${T.negF0}`);
    // KNOWN-BAD: the two K-0 corners captured under each other's names - every F0 part goes negative.
    const Tsw = decomposeSums({ ...A2, r1k0: A2.r3k0, r3k0: A2.r1k0 }, dcls, dw, dh);
    ck('KNOWN-BAD the K-0 corners swapped: every glass channel\'s F0 part reads negative, and says so',
      Tsw.negF0 === 3 * Tsw.n, `${Tsw.negF0} of ${3 * Tsw.n}`);
    // roomNeeded: the K it returns must land the target exactly, and a target outside reach is null.
    const r0 = roomNeeded(T, 0.4, 0.0);
    const mid = (r0.br0 + r0.brInf) / 2, got = roomNeeded(T, 0.4, mid);
    ck('roomNeeded: the K it returns lands the target B/R to 1e-12', got.K !== null && Math.abs(got.brAt(got.K) - mid) < 1e-12,
      `target ${mid.toFixed(4)}, K ${got.K?.toFixed(4)}, lands ${got.K === null ? 'n/a' : got.brAt(got.K).toFixed(6)}`);
    const beyond = roomNeeded(T, 0.4, r0.brInf - 0.5 * Math.abs(r0.br0 - r0.brInf) * Math.sign(r0.br0 - r0.brInf));
    ck('KNOWN-BAD a target past the room\'s own colour is unreachable (null), never a big K', beyond.K === null, String(beyond.K));
  }
  // The forward encode must be what TRANSFER.aces inverts, or every detector reading is off by the
  // mismatch: round-trip a range of ACES inputs, inside 2% where 8 bits can resolve it.
  let rt = 0;
  for (const x of [0.01, 0.03, 0.08, 0.15, 0.3, 0.45, 0.8, 1.5]) rt = Math.max(rt, Math.abs(a2l[encodeByte(x)] / x - 1));
  ck('encodeByte is the inverse of TRANSFER.aces: 0.01-1.5 round-trips inside 4%', rt < 0.04, `worst ${(100 * rt).toFixed(2)}%`);
  // KNOWN-BAD: a plain sRGB encode (no tonemap) does not round-trip through the renderer's inverse.
  const naive = (x) => Math.round(255 * Math.min(1, x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));
  let rtBad = 0;
  for (const x of [0.03, 0.15, 0.45]) rtBad = Math.max(rtBad, Math.abs(a2l[naive(x)] / x - 1));
  ck('KNOWN-BAD an sRGB-only encode misses the renderer inverse by over 20%', rtBad > 0.2, `worst ${(100 * rtBad).toFixed(1)}%`);
  console.log(fails.length ? `GLASS-SWEEP SELFTEST: FAIL - ${fails.length}` : 'GLASS-SWEEP SELFTEST: PASS');
  return fails.length === 0;
}

// ---------------------------------------------------------------------- CLI
const IS_MAIN = import.meta.url === `file://${process.argv[1]}`;
if (IS_MAIN && process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
if (IS_MAIN && !process.argv.includes('--selftest')) {
  const argv = process.argv.slice(2);
  const dir = argv.find((a) => !a.startsWith('--'));
  const ti = argv.indexOf('--tag');
  const TAG = ti >= 0 ? argv[ti + 1] : 'sw';
  if (!dir) { console.error('usage: node tools/glass-sweep.mjs <capture dir> [--tag sw] | --selftest'); process.exit(2); }
  const S1 = 0.3, K1 = 0.5;
  // --pick s,K[;s,K...]: points read in full - truth AND the photograph's detector.
  const pi = argv.indexOf('--pick');
  const PICKS = pi >= 0 ? argv[pi + 1].split(';').map((t) => t.split(',').map(Number)) : [];
  const files = fs.readdirSync(dir).filter((f) => f.startsWith(`${TAG}-off-`) && f.endsWith('.meta.json'));
  const stations = files.map((f) => f.slice(`${TAG}-off-`.length, -'.meta.json'.length));
  const grid = { s: [1, 0.8, 0.6, 0.5, 0.4, 0.3], K: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.7] };
  const rows = [];
  const ARM_NAMES = ['off', 'mir30', 'rough2', 'r1k0', 'r1k5', 'r3k0', 'r3k5', 'mid'];
  const skipped = [];
  for (const st of stations.sort()) {
    const base = (arm) => path.join(dir, `${TAG}-${arm}-${st}`);
    // A station whose capture is still running, or was cut short, is SKIPPED AND NAMED - never read
    // with a missing arm, which would throw, or with a stale one, which would not.
    const missing = ARM_NAMES.filter((a) => !fs.existsSync(`${base(a)}.png`) || !fs.existsSync(`${base(a)}.meta.json`));
    if (missing.length) { skipped.push(`${st} (no ${missing.join(', ')})`); continue; }
    const cap = loadCapture(base('off'));
    const { cls } = classify(cap);
    const lf = (arm) => linearFrame(readPNG(`${base(arm)}.png`));
    const arms = { off: lf('off'), mir30: lf('mir30'), rough2: lf('rough2'), r1k0: lf('r1k0'), r1k5: lf('r1k5'),
      r3k0: lf('r3k0'), r3k5: lf('r3k5'), mid: lf('mid') };
    const S = surface(arms, { s1: S1, K1 });
    const row = { station: st, tod: st.endsWith('-noon') ? 'noon' : 'golden', measured: {}, grid: {} };
    for (const a of Object.keys(arms)) row.measured[a] = frameStats(arms[a], cls, cap.w, cap.h);
    row.predictedMid = frameStats(S(0.5, 0.25), cls, cap.w, cap.h);
    row.decomp = decomposeSums(arms, cls, cap.w, cap.h, { s1: S1, K1 });
    for (const s of grid.s) for (const K of grid.K) row.grid[`${s}|${K}`] = frameStats(S(s, K), cls, cap.w, cap.h);
    // The photograph's own detector, like for like, on the measured off arm and on each picked point.
    row.detect = { off: detectLinear(arms.off, cap.w, cap.h, 2, cls) };
    for (const [ps, pk] of PICKS) {
      const L = S(ps, pk);
      row.pick = row.pick ?? {};
      row.pick[`${ps}|${pk}`] = frameStats(L, cls, cap.w, cap.h);
      row.detect[`${ps}|${pk}`] = detectLinear(L, cap.w, cap.h, 2, cls);
    }
    rows.push(row);
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (skipped.length) console.log(`SKIPPED ${skipped.length} incomplete station(s): ${skipped.join('; ')}`);
  const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : ' n/a ');
  for (const tod of ['noon', 'golden']) {
    const R = rows.filter((r) => r.tod === tod);
    console.log(`\n${tod.toUpperCase()}  n=${R.length} views  (medians of per-view numbers; scene-linear, above the horizon)`);
    console.log('  measured arm      glass B/R   wall B/R   shift   pane:wall   modulation   flat%   pane cv     (pooled by pixel: B/R / shift / pane:wall)');
    for (const a of ['off', 'mir30', 'rough2', 'r1k0', 'r1k5', 'r3k0', 'r3k5', 'mid']) {
      const m = (k) => median(R.map((r) => r.measured[a][k]));
      const P = pooled(R.map((r) => r.measured[a]));
      console.log(`  ${a.padEnd(16)}  ${f3(m('glassBR')).padStart(8)}   ${f3(m('wallBR')).padStart(8)}   ${f3(m('shift'))}   ${f3(m('paneWall')).padStart(8)}   `
        + `${f3(m('modulation')).padStart(9)}   ${(100 * m('flatFrac')).toFixed(0).padStart(4)}   ${f3(m('paneCV'))}`
        + `     pooled ${f3(P.glassBR)} / ${f3(P.shift)} / ${f3(P.paneWall)}`);
    }
    const pm = (k) => median(R.map((r) => r.predictedMid[k]));
    const mm = (k) => median(R.map((r) => r.measured.mid[k]));
    const perView = R.map((r) => Math.abs(r.predictedMid.glassBR / r.measured.mid.glassBR - 1));
    console.log(`  HELD OUT: mid (s 0.5, K 0.25) predicted ${f3(pm('glassBR'))} / ${f3(pm('paneWall'))}   measured ${f3(mm('glassBR'))} / ${f3(mm('paneWall'))}`
      + `   worst per-view glass B/R error ${(100 * Math.max(...perView)).toFixed(2)}%`);
    console.log('  surface, glass B/R | pane:wall | modulation   (rows: F0 scale s; columns: room level K)');
    console.log(`  ${'s \\ K'.padEnd(6)}` + grid.K.map((K) => String(K).padStart(22)).join(''));
    for (const s of grid.s) {
      const cells = grid.K.map((K) => {
        const g = (k) => median(R.map((r) => r.grid[`${s}|${K}`][k]));
        return `${f3(g('glassBR'))}|${f3(g('paneWall'))}|${f3(g('modulation'))}`.padStart(22);
      });
      console.log(`  ${String(s).padEnd(6)}${cells.join('')}`);
    }
  }
  // The detector, like for like with pane-tint's 317 photographs (glass 0.804, shift 0.915,
  // pane:wall 0.247; every one of the 12 station photographs scored).
  for (const tod of ['noon', 'golden']) {
    const R = rows.filter((r) => r.tod === tod);
    console.log(`\nDETECTOR (the photographs' instrument), ${tod}, ${R.length} views`);
    for (const key of ['off', ...PICKS.map(([a, b]) => `${a}|${b}`)]) {
      const D = R.map((r) => r.detect[key]);
      const okd = D.filter((d) => d && d.ok);
      const m = (k) => median(okd.map((d) => d[k]));
      console.log(`  ${key.padEnd(10)} scored ${okd.length} of ${D.length}   glass B/R ${f3(m('glassBR'))}   wall B/R ${f3(m('wallBR'))}   `
        + `shift ${f3(m('shift'))}   pane:wall ${f3(m('paneWall'))}`);
      // Over EVERY view, scored or refused: what its pane class holds, by the shader's own mask.
      const A = D.map((d) => d?.agree).filter(Boolean);
      const ma = (fn) => median(A.map(fn));
      console.log(`  ${''.padEnd(10)} is it glass? its pane class is ${(100 * ma((a) => a.precision)).toFixed(0)}% glass by the packed texel `
        + `(${(100 * ma((a) => a.hist[2])).toFixed(0)}% wall, ${(100 * ma((a) => a.hist[0])).toFixed(0)}% not a facade), and it finds `
        + `${(100 * ma((a) => a.recall)).toFixed(0)}% of the glass   (medians over ${A.length} views; worst precision `
        + `${(100 * Math.min(...A.map((a) => (Number.isFinite(a.precision) ? a.precision : 1)))).toFixed(0)}%)`);
      if (key !== 'off') {
        const T = R.map((r) => r.pick[key]);
        const t = (k) => median(T.map((x) => x[k]));
        const P = pooled(T);
        console.log(`  ${''.padEnd(10)} truth: glass B/R ${f3(t('glassBR'))}  shift ${f3(t('shift'))}  pane:wall ${f3(t('paneWall'))}  `
          + `modulation ${f3(t('modulation'))}  flat ${(100 * t('flatFrac')).toFixed(0)}%  cv ${f3(t('paneCV'))}`
          + `   pooled ${f3(P.glassBR)} / ${f3(P.shift)} / ${f3(P.paneWall)}`);
      }
    }
  }
  // Where the colour comes from, pooled by pixel, and the room that would be needed to warm it.
  for (const tod of ['noon', 'golden']) {
    const P = poolSums(rows.filter((r) => r.tod === tod).map((r) => r.decomp));
    if (!P.off) continue;
    const Yc = (t) => Yl(t.r, t.g, t.b), yo = Yc(P.off);
    console.log(`\nWHERE THE COLOUR COMES FROM, ${tod}: ${P.n} glass px pooled (share of the off arm's light, and each term's own B/R)`);
    for (const [k, label] of [['spec', 'specular'], ['f0', '  of which F0'], ['f90', '  of which F90'], ['diff', 'coating diffuse'], ['roomK', 'room, per unit K']]) {
      console.log(`  ${label.padEnd(18)} share ${(Yc(P[k]) / yo).toFixed(3)}   B/R ${(P[k].b / P[k].r).toFixed(3)}`);
    }
    console.log(`  channels whose F0 part came out negative: ${P.negF0} of ${3 * P.n}`);
    const wallBR = P.wall.b / P.wall.r;
    const rn = roomNeeded(P, 0.4, 1.2, { s1: S1, K1 });
    console.log(`  at F0 x0.4: pane B/R ${rn.br0.toFixed(3)} with no room, the room's own ${rn.brInf.toFixed(3)}, wall ${wallBR.toFixed(3)}; `
      + `at K 0.3 the room is ${(100 * rn.shareAt(0.3)).toFixed(1)}% of the pane's light and the pane reads ${rn.brAt(0.3).toFixed(3)}`);
    for (const [label, target] of [['B/R 1.2', 1.2], ['B/R 1.0', 1.0], [`the photographs' shift (0.973 x ${wallBR.toFixed(3)})`, 0.973 * wallBR], ["the photographs' B/R 0.807", 0.807]]) {
      const q = roomNeeded(P, 0.4, target, { s1: S1, K1 });
      console.log(`    K for ${label.padEnd(40)} ${q.K === null ? 'unreachable at any K' : `${q.K.toFixed(2)}  (the room ${q.roomOverReflection.toFixed(1)}x the reflection's light)`}`);
    }
  }
  const out = path.join(dir, `${TAG}-surface.json`);
  fs.writeFileSync(out, JSON.stringify({ grid, rows: rows.map((r) => ({ ...r })) }, null, 1));
  console.log(`\n${out}`);
}
