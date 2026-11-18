// IS A LEAF EDGE A STEP OR A RAMP? #145's statistic, as an instrument.
//
// Every blind review this month listed "hard-edged foliage" in BOTH arms and quoted it three ways:
// "86% of leaf/sky boundary pixels have no partial coverage", "only 3.8% of 5,983 leaf/sky edge
// pixels are an in-between value", "92-94% of sky-to-leaf steps have no intermediate pixel". Each
// reviewer had their own definition and none of them is in the repo. This is one definition, with
// a selftest that fails on the known-bad, applied to both arms of a pair the same way.
//
//   node tools/leaf-edge.mjs <frame.png> --box x0,y0,x1,y1 [--box ...] [--xywh x,y,w,h ...]
//   node tools/leaf-edge.mjs <frame.png> --tone name=x,y,w,h [--tone ...]     linear tone of boxes
//   node tools/leaf-edge.mjs --selftest
//   node tools/leaf-edge.mjs ... --json
//
// TWO BOX CONVENTIONS ARE IN PLAY, and the reviewers' quotes use both: [640,240,760,320] is
// x0,y0,x1,y1 and [470,130,330,110] is x,y,w,h (330 < 470 cannot be an x1). `--box` is the first
// and `--xywh` the second, every box is printed back in both with its pixel count, so a box fed in
// the wrong convention shows up as a pixel count nobody meant (CLAUDE.md: "two tools here use two
// different box conventions").
//
// THE MEASUREMENT
//
// 1. Display-linear luma. sRGB-decode each channel and take Rec.709 luma. Display-linear and not
//    encoded, because a ratio in linear light survives an exposure change and one on encoded values
//    does not (CLAUDE.md, "Prefer exposure-invariant metrics").
// 2. Two populations per box, split by Otsu on LOG luma. In log space an exposure change is a
//    shift, so the split moves with it and every pixel stays on its side. S is the bright class's
//    median and F the dark class's. A box with no two populations is REFUSED, never scored: a flat
//    sky has no edges, and a metric that scored it 0 hard steps would look exactly like working AA.
// 3. A STEP is every place a row or a column crosses the split. From the two pixels either side of
//    the crossing the run is walked OUTWARD while the signal keeps moving the same way (by more than
//    one 8-bit code), at most MAXW pixels each side: the two ends are the step's local sky and local
//    leaf. Local ends, not S and F, so a sky gradient across the box or a sunlit leaf beside a shaded
//    one cannot manufacture an intermediate pixel.
// 4. It is a LEAF/SKY step only if its bright end is at least SKY_FRAC of S and the ends differ by
//    at least MIN_RATIO in linear light. That throws out the pale limb against the leaves, which is
//    a step this instrument is not asking about, and keeps it exposure-invariant (both are ratios).
// 5. A pixel strictly inside the run is INTERMEDIATE if it sits inside the step's contrast with a
//    BAND deadband at each end, so 8-bit rounding and the composite's dither cannot make one.
//
// Two numbers come out, the two shapes the reviewers quoted:
//
//   hardFrac   steps with no intermediate pixel at all, of all leaf/sky steps   ("92-94% of steps")
//   midShare   intermediate pixels, of every pixel any step's run touches       ("3.8% of edge pixels")
//
// and `steps` is ALWAYS printed beside them: an arm whose step count collapsed is a broken
// measurement, not a softer one.
//
// WHAT AN ANTI-ALIASED EDGE READS HERE IS A MEASUREMENT TOO, NOT A PROMISE. The scene is resolved in
// linear HDR and then tone mapped, and a sky at noon is in the shoulder of the curve: a pixel 25%
// leaf and 75% sky in HDR reads about 0.9 of the sky after the curve and lands inside the deadband.
// So a well-resolved 4-sample edge does not read hardFrac 0 here; the selftest says what it reads
// (and the frame's own pole and building edges, which MSAA resolves geometrically, are the control
// worth putting beside a canopy box).
import { readPNG } from './png.mjs';

export const PARAMS = {
  band: 0.15,       // deadband at each end of a step, as a fraction of its contrast
  maxW: 3,          // pixels walked outward from a crossing, each side
  minRatio: 3,      // a leaf/sky step's ends differ at least this much in linear light
  skyFrac: 0.5,     // and its bright end is at least this fraction of the box's sky level
  minClass: 0.04,   // each population at least this share of the box, or the box is refused
  minContrast: 3,   // and the two populations' medians at least this far apart
};

const DECODE = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  DECODE[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
const encode = (v) => {
  const c = Math.max(0, Math.min(1, v));
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
};

/** Display-linear Rec.709 luma per pixel, and the encoded luma (0..255) the walk compares. */
export function lumaPlanes(img) {
  const { width: w, height: h, channels: ch, data } = img;
  if (!(ch === 3 || ch === 4)) throw new Error(`leaf-edge: ${ch}-channel image, wanted RGB or RGBA`);
  const Y = new Float64Array(w * h), C = new Float64Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    Y[i] = 0.2126 * DECODE[data[p]] + 0.7152 * DECODE[data[p + 1]] + 0.0722 * DECODE[data[p + 2]];
    C[i] = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return { Y, C, w, h };
}

function checkBox(box, w, h) {
  const [x0, y0, x1, y1] = box;
  if (![x0, y0, x1, y1].every(Number.isInteger) || x0 < 0 || y0 < 0 || x1 > w || y1 > h || x1 - x0 < 4 || y1 - y0 < 4) {
    throw new Error(`leaf-edge: box ${box} (x0,y0,x1,y1) is not inside a ${w} x ${h} frame`);
  }
}
const median = (arr) => {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  return s[s.length >> 1];
};

/** Otsu's split of the box on log2 luma: the threshold in LINEAR luma, and the two classes. */
export function levels(planes, box, p = PARAMS) {
  const { Y, w } = planes;
  const [x0, y0, x1, y1] = box;
  const logs = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) logs.push(Math.log2(Y[y * w + x] + 1e-5));
  let lo = Infinity, hi = -Infinity;
  for (const v of logs) { if (v < lo) lo = v; if (v > hi) hi = v; }
  const n = logs.length;
  if (!(hi - lo > 1e-9)) return { ok: false, why: 'one luma level in the whole box', n };
  const BINS = 256, hist = new Float64Array(BINS);
  const bin = (v) => Math.min(BINS - 1, Math.floor(((v - lo) / (hi - lo)) * BINS));
  for (const v of logs) hist[bin(v)]++;
  let sumAll = 0;
  for (let i = 0; i < BINS; i++) sumAll += i * hist[i];
  let wB = 0, sumB = 0, best = -1, cut = 0;
  for (let i = 0; i < BINS - 1; i++) {
    wB += hist[i]; sumB += i * hist[i];
    const wF = n - wB;
    if (!wB || !wF) continue;
    const mB = sumB / wB, mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; cut = i; }
  }
  const tauLog = lo + ((cut + 1) / BINS) * (hi - lo);
  const tau = 2 ** tauLog - 1e-5;
  const dark = [], bright = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const v = Y[y * w + x];
    (v >= tau ? bright : dark).push(v);
  }
  const S = median(bright), F = median(dark);
  const out = { n, tau, S, F, nBright: bright.length, nDark: dark.length };
  if (bright.length < p.minClass * n || dark.length < p.minClass * n) {
    return { ...out, ok: false, why: `one population is under ${p.minClass * 100}% of the box (${dark.length} dark, ${bright.length} bright)` };
  }
  if (!(S / Math.max(F, 1e-6) >= p.minContrast)) {
    return { ...out, ok: false, why: `the two populations are only x${(S / Math.max(F, 1e-6)).toFixed(2)} apart` };
  }
  return { ...out, ok: true };
}

/**
 * The statistic. `box` is x0,y0,x1,y1, end-exclusive.
 * @returns {{ok:boolean, why?:string, steps:number, hard:number, hardFrac:number, midShare:number,
 *   meanMid:number, runPixels:number, midPixels:number, S:number, F:number, tau:number, n:number,
 *   hist:number[], clipped:number}}
 */
export function edgeStats(img, box, p = PARAMS) {
  const planes = img.Y ? img : lumaPlanes(img);
  const { Y, C, w, h } = planes;
  checkBox(box, w, h);
  const lv = levels(planes, box, p);
  const [x0, y0, x1, y1] = box;
  let clipped = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) if (C[y * w + x] >= 254.5) clipped++;
  const base = { n: lv.n, S: lv.S, F: lv.F, tau: lv.tau, clipped: clipped / lv.n };
  if (!lv.ok) {
    return { ...base, ok: false, why: lv.why, steps: 0, hard: 0, hardFrac: NaN, midShare: NaN, meanMid: NaN,
      runPixels: 0, midPixels: 0, hist: [0, 0, 0, 0] };
  }
  const runSet = new Set(), midSet = new Set();
  const hist = [0, 0, 0, 0];             // intermediate pixels in a step: 0, 1, 2, 3+
  let steps = 0, hard = 0, midSum = 0;
  // One line of the box: `at(k)` is the pixel index of sample k, n samples.
  const line = (n, at) => {
    for (let k = 0; k + 1 < n; k++) {
      const a = Y[at(k)], b = Y[at(k + 1)];
      const ca = a >= lv.tau, cb = b >= lv.tau;
      if (ca === cb) continue;
      // The bright side walks toward brighter, the dark side toward darker, outward from the crossing.
      const brightK = ca ? k : k + 1, darkK = ca ? k + 1 : k;
      const dirB = brightK < darkK ? -1 : 1, dirD = -dirB;
      let bk = brightK, dk = darkK;
      for (let s = 0; s < p.maxW; s++) {
        const nk = bk + dirB;
        if (nk < 0 || nk >= n || C[at(nk)] <= C[at(bk)] + 1) break;
        bk = nk;
      }
      for (let s = 0; s < p.maxW; s++) {
        const nk = dk + dirD;
        if (nk < 0 || nk >= n || C[at(nk)] >= C[at(dk)] - 1) break;
        dk = nk;
      }
      const hi = Y[at(bk)], lo = Y[at(dk)];
      if (!(hi >= p.skyFrac * lv.S) || !(hi >= p.minRatio * Math.max(lo, 1e-6))) continue;
      const bandLo = lo + p.band * (hi - lo), bandHi = hi - p.band * (hi - lo);
      const kLo = Math.min(bk, dk), kHi = Math.max(bk, dk);
      let mids = 0;
      for (let q = kLo; q <= kHi; q++) {
        const idx = at(q);
        runSet.add(idx);
        if (q > kLo && q < kHi) {
          const v = Y[idx];
          if (v > bandLo && v < bandHi) { mids++; midSet.add(idx); }
        }
      }
      steps++;
      if (mids === 0) hard++;
      midSum += mids;
      hist[Math.min(3, mids)]++;
    }
  };
  for (let y = y0; y < y1; y++) line(x1 - x0, (k) => y * w + x0 + k);
  for (let x = x0; x < x1; x++) line(y1 - y0, (k) => (y0 + k) * w + x);
  return {
    ...base, ok: steps > 0, why: steps > 0 ? undefined : 'no leaf/sky step in the box',
    steps, hard, hardFrac: steps ? hard / steps : NaN, meanMid: steps ? midSum / steps : NaN,
    runPixels: runSet.size, midPixels: midSet.size, midShare: runSet.size ? midSet.size / runSet.size : NaN, hist,
  };
}

/** Mean display-linear RGB and luma of a box, x0,y0,x1,y1. */
export function toneStats(img, box) {
  const { width: w, height: h, channels: ch, data } = img;
  checkBox(box, w, h);
  const [x0, y0, x1, y1] = box;
  let r = 0, g = 0, b = 0, n = 0;
  const lum = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const q = (y * w + x) * ch;
    const R = DECODE[data[q]], G = DECODE[data[q + 1]], B = DECODE[data[q + 2]];
    r += R; g += G; b += B; n++;
    lum.push(0.2126 * R + 0.7152 * G + 0.0722 * B);
  }
  r /= n; g /= n; b /= n;
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const s = Float64Array.from(lum).sort();
  const q = (f) => s[Math.min(n - 1, Math.floor(f * n))];
  const m = Math.max(r, g, b, 1e-9);
  return { n, rgb: [r, g, b], luma: L, chroma: [r / m, g / m, b / m], warmth: (r - b) / Math.max(L, 1e-9),
    p10: q(0.1), p50: q(0.5), p90: q(0.9) };
}

const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : '  n/a');
export function formatEdge(label, box, s) {
  const [x0, y0, x1, y1] = box;
  const head = `${label.padEnd(26)} [${x0},${y0},${x1},${y1}] = xywh [${x0},${y0},${x1 - x0},${y1 - y0}] n ${s.n}`;
  if (!s.ok) return `${head}\n${''.padEnd(26)} REFUSED: ${s.why}`;
  return `${head}\n${''.padEnd(26)} steps ${String(s.steps).padStart(5)}  hardFrac ${f3(s.hardFrac)}  ` +
    `midShare ${f3(s.midShare)} (${s.midPixels}/${s.runPixels})  meanMid ${f3(s.meanMid)}  ` +
    `mids 0/1/2/3+ ${s.hist.join('/')}  sky ${s.S.toFixed(4)} leaf ${s.F.toFixed(4)} (x${(s.S / s.F).toFixed(1)})  ` +
    `clipped ${(100 * s.clipped).toFixed(1)}%`;
}

// ---------------------------------------------------------------- selftest
//
// Synthetic canopies through the SAME chain the game puts a leaf through: coverage mixed in LINEAR
// HDR, an exposure, ACES, the sRGB encode, 8 bits. Four coverage rules over one leaf field:
//
//   hard     the coverage at the pixel centre only, 0 or 1: an alpha TEST, whatever the sample count
//   msaa4    the fraction of four rotated-grid samples inside: what 4x coverage resolves to
//   box16    a 4 x 4 box filter: an analytic ideal
//   flat     sky alone: no edges, so REFUSED, not "smooth"
//
// and the known-bad is the first: if `hard` does not read as hard, nothing this tool says about a
// frame means anything.
const _subCache = new Map();
/** The leaf field at 4 x 4 subsamples a pixel, sample (i, j) at ((i + 0.5) / 4, (j + 0.5) / 4). */
function leafField(w, h, seed) {
  const key = `${w}x${h}:${seed}`;
  if (_subCache.has(key)) return _subCache.get(key);
  let s = seed >>> 0;
  const rnd = () => { s = (Math.imul(s ^ (s >>> 15), 2246822507) + 0x9e3779b9) >>> 0; return s / 4294967296; };
  // Discs of 2-9 px, clustered so the mass has holes and islands the way a crown does.
  const W = w * 4, H = h * 4, sub = new Uint8Array(W * H);
  for (let c = 0; c < 26; c++) {
    const cx = rnd() * w, cy = rnd() * h * 0.8;
    for (let k = 0; k < 18; k++) {
      const dx = cx + (rnd() - 0.5) * 60, dy = cy + (rnd() - 0.5) * 40, r = 2 + rnd() * 7;
      for (let Y = Math.max(0, Math.floor((dy - r) * 4)); Y < Math.min(H, Math.ceil((dy + r) * 4)); Y++) {
        for (let X = Math.max(0, Math.floor((dx - r) * 4)); X < Math.min(W, Math.ceil((dx + r) * 4)); X++) {
          if (((X + 0.5) / 4 - dx) ** 2 + ((Y + 0.5) / 4 - dy) ** 2 < r * r) sub[Y * W + X] = 1;
        }
      }
    }
  }
  _subCache.set(key, sub);
  return sub;
}

function synth(kind, { exposure = 1, w = 320, h = 200, seed = 7 } = {}) {
  const sub = leafField(w, h, seed), W = w * 4;
  const at = (x, y, i, j) => (kind === 'flat' ? 0 : sub[(y * 4 + j) * W + x * 4 + i]);
  // The rotated grid a 4x target samples at, on the 4 x 4 lattice: (0.375, 0.125) (0.875, 0.375)
  // (0.125, 0.625) (0.625, 0.875).
  const MS4 = [[1, 0], [3, 1], [0, 2], [2, 3]];
  const data = new Uint8Array(w * h * 3);
  const tex = (x, y) => { const t = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return t - Math.floor(t); };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let cov;
    if (kind === 'hard' || kind === 'flat') cov = at(x, y, 2, 2);          // one sample, near the centre
    else if (kind === 'msaa4') cov = MS4.reduce((a, [i, j]) => a + at(x, y, i, j), 0) / 4;
    else { cov = 0; for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) cov += at(x, y, i, j); cov /= 16; }
    // Levels in EXPOSED HDR units, set where a noon frame puts them: the sky in ACES's shoulder at
    // about 0.86 display-linear, the leaves at about 0.04 with a texture of +-40%.
    const sky = 1.4 * (0.9 + 0.2 * (y / h));                 // a sky gradient across the box
    const leaf = 0.045 * (0.6 + 0.8 * tex(x, y));            // a leaf with texture
    const hdr = (cov * leaf + (1 - cov) * sky) * exposure;
    const aces = Math.max(0, Math.min(1, (hdr * (2.51 * hdr + 0.03)) / (hdr * (2.43 * hdr + 0.59) + 0.14)));
    const v = Math.round(encode(aces) * 255);
    const q = (y * w + x) * 3;
    data[q] = data[q + 1] = data[q + 2] = v;
  }
  return { width: w, height: h, channels: 3, data };
}

function selftest() {
  const box = [0, 0, 320, 200];
  let bad = 0;
  const check = (ok, msg) => { console.log(`  ${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) bad++; };
  const run = (kind, o) => { const s = edgeStats(synth(kind, o), box); console.log(formatEdge(`${kind}${o ? ` x${o.exposure}` : ''}`, box, s)); return s; };
  console.log('instrument self-test: synthetic canopies through linear HDR, ACES and the sRGB encode\n');
  const hard = run('hard'), ms4 = run('msaa4'), b16 = run('box16'), flat = run('flat');
  const ms4lo = run('msaa4', { exposure: 0.5 }), ms4hi = run('msaa4', { exposure: 2 });
  const hardLo = run('hard', { exposure: 0.5 }), hardHi = run('hard', { exposure: 2 });
  console.log('');
  check(hard.ok && hard.steps > 500, `the known-bad has steps to read: ${hard.steps}`);
  check(hard.hardFrac >= 0.97 && hard.midShare <= 0.02,
    `KNOWN-BAD: an alpha-tested edge reads hard (hardFrac ${f3(hard.hardFrac)} >= 0.97, midShare ${f3(hard.midShare)} <= 0.02)`);
  check(hardLo.hardFrac >= 0.97 && hardHi.hardFrac >= 0.97,
    `and reads hard a stop either way (hardFrac ${f3(hardLo.hardFrac)} / ${f3(hardHi.hardFrac)}): no exposure makes a step a ramp`);
  check(ms4.ok && ms4.hardFrac <= 0.45 && ms4.midShare >= 0.15,
    `a 4-sample resolve reads as a ramp (hardFrac ${f3(ms4.hardFrac)} <= 0.45, midShare ${f3(ms4.midShare)} >= 0.15)`);
  check(b16.ok && b16.hardFrac <= ms4.hardFrac + 0.02 && b16.midShare >= ms4.midShare - 0.02,
    `a 16-sample box filter reads at least as soft as 4 samples (hardFrac ${f3(b16.hardFrac)}, midShare ${f3(b16.midShare)})`);
  check(!flat.ok && Number.isNaN(flat.hardFrac), `a box with no leaves is REFUSED, not scored (${flat.why})`);
  // NOT exposure-invariant, and this check says how far: the tone curve's shoulder pulls a mostly-sky
  // pixel into the sky's deadband as the sky brightens, so the same resolve reads 0.377 / 0.424 /
  // 0.745 from a stop down to a stop up. What survives is the SEPARATION, at every exposure; two arms
  // are comparable only at one exposure, which is why every reading prints its sky level.
  check([[ms4lo, hardLo], [ms4, hard], [ms4hi, hardHi]].every(([a, b]) => a.hardFrac <= b.hardFrac - 0.2),
    `at every exposure the 4-sample resolve separates from the alpha test (hardFrac ${f3(ms4lo.hardFrac)} / ` +
    `${f3(ms4.hardFrac)} / ${f3(ms4hi.hardFrac)} against ${f3(hardLo.hardFrac)} / ${f3(hard.hardFrac)} / ${f3(hardHi.hardFrac)})`);
  check([ms4lo, ms4hi].every((s) => Math.abs(s.steps - ms4.steps) <= 0.1 * ms4.steps),
    `and finds the same steps within 10% (${ms4lo.steps} / ${ms4.steps} / ${ms4hi.steps}): the split moves with the exposure`);
  // The box conventions: a box fed as x,y,w,h through the x0,y0,x1,y1 door must not silently pass.
  let threw = false;
  try { edgeStats(synth('hard'), [470, 130, 330, 110]); } catch { threw = true; }
  check(threw, 'a box whose x1 is left of its x0 throws instead of measuring an empty or wrapped region');
  console.log(bad ? `\nLEAF EDGE SELFTEST: FAIL — ${bad} of 9 checks` : '\nLEAF EDGE SELFTEST: PASS — 9 checks, 0 failed');
  return bad;
}

const IS_MAIN = process.argv[1] && process.argv[1].endsWith('leaf-edge.mjs');
if (IS_MAIN) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) process.exit(selftest() ? 1 : 0);
  const json = args.includes('--json');
  const boxes = [], tones = [];
  const files = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--box' || a === '--xywh') {
      const v = args[++i].split(',').map(Number);
      boxes.push(a === '--box' ? v : [v[0], v[1], v[0] + v[2], v[1] + v[3]]);
    } else if (a === '--tone') {
      const [name, spec] = args[++i].split('=');
      const v = spec.split(',').map(Number);
      tones.push({ name, box: [v[0], v[1], v[0] + v[2], v[1] + v[3]] });
    } else if (!a.startsWith('--')) files.push(a);
  }
  const out = {};
  for (const f of files) {
    const img = readPNG(f);
    const planes = lumaPlanes(img);
    out[f] = { edges: [], tones: [] };
    if (!json) console.log(f.replace(/^.*\//, ''));
    for (const b of boxes) {
      const s = edgeStats(planes, b);
      out[f].edges.push({ box: b, ...s });
      if (!json) console.log(formatEdge('  edge', b, s));
    }
    const ref = tones.length ? toneStats(img, tones[0].box) : null;
    for (const t of tones) {
      const s = toneStats(img, t.box);
      out[f].tones.push({ name: t.name, box: t.box, ...s });
      if (!json) {
        console.log(`  ${t.name.padEnd(12)} xywh [${t.box[0]},${t.box[1]},${t.box[2] - t.box[0]},${t.box[3] - t.box[1]}] n ${String(s.n).padStart(5)}  ` +
          `luma ${s.luma.toFixed(4)} (p10 ${s.p10.toFixed(4)} p50 ${s.p50.toFixed(4)} p90 ${s.p90.toFixed(4)})  ` +
          `R:G:B ${s.chroma.map((c) => c.toFixed(2)).join(':')}  (R-B)/L ${s.warmth.toFixed(3)}  ` +
          `x${(s.luma / ref.luma).toFixed(3)} of ${tones[0].name}`);
      }
    }
  }
  if (json) console.log(JSON.stringify(out, null, 1));
}
