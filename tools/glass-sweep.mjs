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
export function detectLinear(L, w, h, up = 2) {
  const W2 = w * up, H2 = h * up;
  const data = new Uint8Array(W2 * H2 * 3);
  for (let y = 0; y < H2; y++) {
    for (let x = 0; x < W2; x++) {
      const i = ((y / up) | 0) * w + ((x / up) | 0), o = (y * W2 + x) * 3;
      data[o] = encodeByte(L.r[i]); data[o + 1] = encodeByte(L.g[i]); data[o + 2] = encodeByte(L.b[i]);
    }
  }
  const d = detect({ width: W2, height: H2, channels: 3, data }, { transfer: 'aces' });
  return d.ok ? { ok: true, glassBR: d.glassBR, wallBR: d.wallBR, shift: d.shift, paneWall: d.paneWall }
    : { ok: false, why: d.why.join('; ') };
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
    for (const s of grid.s) for (const K of grid.K) row.grid[`${s}|${K}`] = frameStats(S(s, K), cls, cap.w, cap.h);
    // The photograph's own detector, like for like, on the measured off arm and on each picked point.
    row.detect = { off: detectLinear(arms.off, cap.w, cap.h) };
    for (const [ps, pk] of PICKS) {
      const L = S(ps, pk);
      row.pick = row.pick ?? {};
      row.pick[`${ps}|${pk}`] = frameStats(L, cls, cap.w, cap.h);
      row.detect[`${ps}|${pk}`] = detectLinear(L, cap.w, cap.h);
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
  const out = path.join(dir, `${TAG}-surface.json`);
  fs.writeFileSync(out, JSON.stringify({ grid, rows: rows.map((r) => ({ ...r })) }, null, 1));
  console.log(`\n${out}`);
}
