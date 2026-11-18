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
import { TRANSFER, horizonRow } from './pane-tint.mjs';
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
  };
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
    rows.push(row);
    process.stderr.write('.');
  }
  process.stderr.write('\n');
  if (skipped.length) console.log(`SKIPPED ${skipped.length} incomplete station(s): ${skipped.join('; ')}`);
  const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : ' n/a ');
  for (const tod of ['noon', 'golden']) {
    const R = rows.filter((r) => r.tod === tod);
    console.log(`\n${tod.toUpperCase()}  n=${R.length} views  (medians of per-view numbers; scene-linear, above the horizon)`);
    console.log('  measured arm      glass B/R   wall B/R   shift   pane:wall   modulation   flat%   pane cv');
    for (const a of ['off', 'mir30', 'rough2', 'r1k0', 'r1k5', 'r3k0', 'r3k5', 'mid']) {
      const m = (k) => median(R.map((r) => r.measured[a][k]));
      console.log(`  ${a.padEnd(16)}  ${f3(m('glassBR')).padStart(8)}   ${f3(m('wallBR')).padStart(8)}   ${f3(m('shift'))}   ${f3(m('paneWall')).padStart(8)}   `
        + `${f3(m('modulation')).padStart(9)}   ${(100 * m('flatFrac')).toFixed(0).padStart(4)}   ${f3(m('paneCV'))}`);
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
  const out = path.join(dir, `${TAG}-surface.json`);
  fs.writeFileSync(out, JSON.stringify({ grid, rows: rows.map((r) => ({ ...r })) }, null, 1));
  console.log(`\n${out}`);
}
