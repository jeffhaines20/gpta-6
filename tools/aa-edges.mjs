// How hard-stepped is a silhouette, in pixels? An anti-aliasing instrument.
//
// The complaint this answers: the scene renders into a WebGLRenderTarget, so the
// renderer's `antialias: true` (which only ever applied to the DEFAULT
// framebuffer) is inert, and the post chain contains no resolve. A critic read
// scanline y=400 of docs/shots/play-fivepoints-golden.png across a traffic mast
// and found a 162-level step completing in ONE pixel with no intermediate value.
//
// One scanline is an anecdote. This turns it into a population.
//
// THE MEASUREMENT
//
// Walk every row (and every column) of the frame as a 1-D signal of luma. A
// qualifying edge is a monotone run that
//
//   * starts on a FLAT plateau (3 samples within +/-4 levels),
//   * ends on a FLAT plateau,
//   * and spans at least MIN_CONTRAST levels between the two.
//
// The plateau requirement is what makes this a SILHOUETTE metric rather than a
// texture-detail metric: it selects boundaries between two smooth regions - sky
// against a mast, a lit wall against a dark one - and ignores the high-frequency
// interior of a brick texture, where every sample differs from its neighbour and
// "transition width" would mean nothing.
//
// For each qualifying edge, count the samples strictly BETWEEN the two plateau
// values (with a 12% deadband at each end, so 8-bit dither and the composite's
// ordered dither cannot manufacture an intermediate level). That count is the
// edge's width:
//
//   width 0  = the transition completes in one pixel. No anti-aliasing.
//   width 1  = one partially-covered pixel. What a correctly resolved
//              near-vertical edge looks like.
//   width 2+ = a softer ramp: a slanted edge, a blur, or genuine defocus.
//
// The headline numbers are
//
//   hardFrac   fraction of qualifying edges with width 0
//   meanWidth  mean intermediate-sample count
//   edges      HOW MANY were found - reported always, because a metric that
//              sampled a flat sky would report a wonderful hardFrac of 0/0 and
//              look exactly like working AA. An arm whose edge count collapsed
//              is not a smoother arm, it is a broken measurement.
//
// Usage:
//   node tools/aa-edges.mjs <a.png> [b.png ...]        measure frames
//   node tools/aa-edges.mjs --selftest                 prove it can read both ways
//   node tools/aa-edges.mjs --rect x0,y0,x1,y1 a.png   restrict to a region
//   node tools/aa-edges.mjs --json a.png               machine-readable
import { readPNG } from './png.mjs';

export const DEFAULTS = {
  minContrast: 60,   // levels between the two plateaus, of 255
  noise: 3,          // a step this small or smaller ends the monotone run
  flat: 4,           // plateau samples must agree to within this
  deadband: 0.12,    // fraction of the contrast that does not count as "between"
  maxWidth: 12,      // longer runs are gradients (sky, a soft shadow), not edges
};

/** Rec.709 luma, in 0..255. */
export function lumaPlane(img) {
  const { width: w, height: h, channels: ch, data } = img;
  const L = new Float32Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += ch) {
    L[i] = ch === 1
      ? data[p]
      : 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
  }
  return L;
}

// One pass over a 1-D signal. `get(i)` returns luma; n is its length.
// Pushes {width, contrast, at} for every qualifying edge.
function scanLine(get, n, out, opts, tag) {
  const { minContrast, noise, flat, deadband, maxWidth } = opts;
  let i = 0;
  while (i < n - 1) {
    const d = get(i + 1) - get(i);
    if (Math.abs(d) < noise + 1) { i++; continue; }
    const s = Math.sign(d);
    const a = i;
    let b = i + 1;
    // Extend while the signal keeps moving the same way by more than noise.
    while (b < n - 1 && s * (get(b + 1) - get(b)) > noise) b++;
    const va = get(a), vb = get(b);
    const contrast = Math.abs(vb - va);
    const span = b - a;
    // The run must be a step between two flat plateaus, not one leg of a ramp.
    const flatAt = (idx, dir) => {
      const j1 = idx + dir, j2 = idx + 2 * dir;
      if (j1 < 0 || j2 < 0 || j1 >= n || j2 >= n) return false;
      return Math.abs(get(j1) - get(idx)) <= flat && Math.abs(get(j2) - get(idx)) <= flat;
    };
    if (contrast >= minContrast && span <= maxWidth && flatAt(a, -1) && flatAt(b, +1)) {
      const lo = Math.min(va, vb), hi = Math.max(va, vb);
      const band = deadband * contrast;
      let width = 0;
      for (let k = a + 1; k < b; k++) {
        const v = get(k);
        if (v > lo + band && v < hi - band) width++;
      }
      out.push({ width, contrast, axis: tag });
    }
    i = b;
  }
}

/**
 * @param {{width:number,height:number,channels:number,data:Uint8Array}} img
 * @param {{rect?:number[], axes?:string}} [o]
 */
export function edgeStats(img, o = {}) {
  const opts = { ...DEFAULTS, ...o };
  const L = lumaPlane(img);
  const { width: w, height: h } = img;
  const [x0, y0, x1, y1] = o.rect ?? [0, 0, w, h];
  const axes = o.axes ?? 'xy';
  const found = [];
  if (axes.includes('x')) {
    for (let y = y0; y < y1; y++) {
      const row = y * w;
      scanLine((i) => L[row + x0 + i], x1 - x0, found, opts, 'x');
    }
  }
  if (axes.includes('y')) {
    for (let x = x0; x < x1; x++) {
      scanLine((i) => L[(y0 + i) * w + x], y1 - y0, found, opts, 'y');
    }
  }
  const n = found.length;
  const widths = found.map((e) => e.width).sort((p, q) => p - q);
  const hist = {};
  for (const wd of widths) hist[Math.min(wd, 4)] = (hist[Math.min(wd, 4)] ?? 0) + 1;
  const pct = (f) => (n ? widths[Math.min(n - 1, Math.floor(f * n))] : NaN);
  return {
    edges: n,
    hardFrac: n ? widths.filter((v) => v === 0).length / n : NaN,
    meanWidth: n ? widths.reduce((s, v) => s + v, 0) / n : NaN,
    p50: pct(0.5),
    p90: pct(0.9),
    meanContrast: n ? found.reduce((s, e) => s + e.contrast, 0) / n : NaN,
    hist,                    // widths 0,1,2,3,4+ (4 is a ">=4" bucket)
  };
}

export function statsOfFile(file, o) {
  return edgeStats(readPNG(file), o);
}

export function formatRow(label, s) {
  const f = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  n/a');
  const hb = [0, 1, 2, 3, 4].map((k) => s.hist[k] ?? 0);
  return `${label.padEnd(34)} edges ${String(s.edges).padStart(7)}  ` +
    `hard ${f(s.hardFrac)}  mean ${f(s.meanWidth, 3)}  p50 ${s.p50}  p90 ${s.p90}  ` +
    `contrast ${f(s.meanContrast, 1)}  w[0..4+] ${hb.join('/')}`;
}

// ---------------------------------------------------------------- self-test
//
// The rule this project pays for: verify the instrument can produce the OPPOSITE
// reading before trusting a null result. A "looks smooth" verdict from a metric
// that is really measuring a flat wall is indistinguishable from working AA, so
// these four synthetic frames pin all four corners:
//
//   hard   a 1-pixel step               -> hardFrac 1.00, meanWidth 0
//   aa1    one 50% coverage pixel        -> hardFrac 0.00, meanWidth 1
//   ramp3  a three-sample linear ramp    -> hardFrac 0.00, meanWidth 3
//   flat   no edge at all                -> edges 0, hardFrac n/a  (NOT "smooth")
function synth(kind, w = 256, h = 128) {
  const data = new Uint8Array(w * h * 3);
  const LO = 73, HI = 235;
  const put = (x, y, v) => { const p = (y * w + x) * 3; data[p] = data[p + 1] = data[p + 2] = v; };
  // Vertical bars so both the row scan (a real edge) and the column scan (flat)
  // are exercised. Bar edges land every 64 px.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const phase = x % 64;
      let v;
      if (kind === 'flat') v = HI;
      else if (kind === 'hard') v = phase < 32 ? HI : LO;
      else if (kind === 'aa1') {
        // One pixel of exact 50% coverage at each boundary.
        if (phase === 32 || phase === 0) v = (HI + LO) / 2;
        else v = phase < 32 ? HI : LO;
      } else if (kind === 'ramp3') {
        const t = phase >= 32 && phase <= 34 ? (phase - 31) / 4
          : phase >= 0 && phase <= 2 ? 1 - (phase + 1) / 4 : null;
        v = t === null ? (phase < 32 ? HI : LO) : HI + (LO - HI) * t;
      }
      put(x, y, Math.round(v));
    }
  }
  return { width: w, height: h, channels: 3, data };
}

if (process.argv[1] && process.argv[1].endsWith('aa-edges.mjs')) {
  const args = process.argv.slice(2);
  if (args.includes('--selftest')) {
    console.log('instrument self-test — synthetic frames, known answers\n');
    const expect = {
      hard: 'hardFrac 1.00, meanWidth 0.00',
      aa1: 'hardFrac 0.00, meanWidth 1.00',
      ramp3: 'hardFrac 0.00, meanWidth 3.00',
      flat: 'edges 0 (and hardFrac must read n/a, NOT 0 or 1)',
    };
    let bad = 0;
    for (const kind of ['hard', 'aa1', 'ramp3', 'flat']) {
      const s = edgeStats(synth(kind));
      console.log(formatRow(kind, s));
      console.log(`${''.padEnd(34)} expected: ${expect[kind]}`);
      if (kind === 'hard' && !(s.edges > 0 && s.hardFrac === 1 && s.meanWidth === 0)) bad++;
      if (kind === 'aa1' && !(s.edges > 0 && s.hardFrac === 0 && Math.abs(s.meanWidth - 1) < 1e-9)) bad++;
      if (kind === 'ramp3' && !(s.edges > 0 && s.hardFrac === 0 && Math.abs(s.meanWidth - 3) < 1e-9)) bad++;
      if (kind === 'flat' && !(s.edges === 0 && Number.isNaN(s.hardFrac))) bad++;
    }
    console.log(bad === 0 ? '\nSELFTEST PASS — the instrument separates all four cases.'
      : `\nSELFTEST FAIL — ${bad} case(s) read wrong.`);
    process.exit(bad === 0 ? 0 : 1);
  }
  const rectArg = args.indexOf('--rect');
  const rect = rectArg >= 0 ? args[rectArg + 1].split(',').map(Number) : undefined;
  const json = args.includes('--json');
  const files = args.filter((a, i) => !a.startsWith('--') && !(rectArg >= 0 && i === rectArg + 1));
  const out = {};
  for (const f of files) {
    const s = statsOfFile(f, { rect });
    out[f] = s;
    if (!json) console.log(formatRow(f.replace(/^.*\//, ''), s));
  }
  if (json) console.log(JSON.stringify(out, null, 1));
}
