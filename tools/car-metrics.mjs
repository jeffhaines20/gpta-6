// The car legibility METRICS, split out of tools/car-probe.mjs so they can be
// imported without launching a browser.
//
// WHY THIS FILE EXISTS. car-probe.mjs runs its capture at module top level with
// no entry guard, so `import { wheelMetrics } from './car-probe.mjs'` starts an
// http server and a headless Chromium. The second blind reviewer of the round-1
// car pass hit exactly that and worked around it by copying 150 lines of this
// code into its own scratch directory VERBATIM, then writing a further self-test
// whose only job was to prove the copy still reproduced car-probe's numbers
// (6.578 elliptical against 0.864 circular). That is a fork of a measuring
// instrument created by an import side effect, and the next reviewer would have
// had to make another one. The metrics live here now; car-probe.mjs imports
// them and keeps the capture.
//
//   node tools/car-metrics.mjs --selftest
import { pathToFileURL } from 'node:url';
import { readPNG } from './png.mjs';
import { writePNG } from './crop.mjs';

export { readPNG };

// ------------------------------------------------------------------ sampling
//
// readPNG returns `channels`, and for these screenshots it is 3, not 4. A
// hardcoded 4-byte stride misaligns every sample and runs off the end of the
// buffer in the bottom quarter, where the reads come back undefined -> NaN.
// NaN then fails every `>` comparison silently, so the corrupted rows report NO
// DIFFERENCE, which is the most dangerous shape a measurement bug can take.
// Everything below goes through this one accessor, and it throws rather than
// return a non-finite sample.
export function sampler(png) {
  const { width: w, height: h, channels: ch, data } = png;
  if (!(ch === 3 || ch === 4)) throw new Error(`unexpected channels ${ch}`);
  return {
    w, h, ch,
    luma(x, y) {
      const xi = x | 0, yi = y | 0;
      if (xi < 0 || yi < 0 || xi >= w || yi >= h) return null;
      const p = (yi * w + xi) * ch;
      const v = 0.2126 * data[p] + 0.7152 * data[p + 1] + 0.0722 * data[p + 2];
      if (!Number.isFinite(v)) {
        throw new Error(`non-finite sample at ${xi},${yi} (channels=${ch}) - stride bug`);
      }
      return v;
    },
  };
}

export const median = (a) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const pct = (a, q) => {
  if (!a.length) return NaN;
  const s = Float64Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};
export const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
export const stdev = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};

/**
 * Luma inside the projected wheel, split into rim core and tyre annulus.
 *
 * THE WHEEL IS AN ELLIPSE, NOT A CIRCLE, and sampling it as a circle is a bug
 * that flatters nothing and ruins everything. A kerbside car seen from the
 * carriageway is nearly end-on, so its wheel projects about 17 px wide by 38 px
 * tall. A circular annulus at 0.80-1.00 of the tall radius spends most of its
 * area on the bright body and the brighter road either side of the tyre, so the
 * "tyre" reads far lighter than rubber and the rim/tyre ratio is squeezed toward
 * 1. That is why the first pass measured a 10:1 albedo step - alloy 0.55 against
 * rubber 0.055 - as a ratio of 1.20, and then read a real change as a
 * regression.
 *
 * So the caller passes the two projected semi-axis VECTORS of the wheel disc:
 * `up` is the screen offset of a point one wheel radius above the axle, `fore`
 * the offset of one radius along the car's axis. The wheel lies in the plane
 * those two span, and a pixel's normalised radius comes from solving
 * p - c = a*up + b*fore and taking hypot(a, b).
 */
export function wheelMetrics(png, cx, cy, up, fore) {
  const s = sampler(png);
  // Inverse of the 2x2 [up fore] basis, so screen offsets become disc coords.
  const det = up[0] * fore[1] - up[1] * fore[0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) {
    return { px: 0, samples: 0, rimTyre: null, rimCoV: null, degenerate: true };
  }
  const i00 = fore[1] / det, i01 = -fore[0] / det;
  const i10 = -up[1] / det, i11 = up[0] / det;
  const core = [], tyre = [], inner = [];
  const rx = Math.abs(up[0]) + Math.abs(fore[0]);
  const ry = Math.abs(up[1]) + Math.abs(fore[1]);
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = x - cx, dy = y - cy;
      const a = i00 * dx + i01 * dy, b = i10 * dx + i11 * dy;
      const d = Math.hypot(a, b);
      if (d > 1) continue;
      const L = s.luma(x, y);
      if (L === null) continue;
      if (d < 0.55) core.push(L);
      if (d < 0.75) inner.push(L);
      if (d >= 0.80) tyre.push(L);
    }
  }
  const tyreMed = median(tyre);
  return {
    px: +(2 * Math.hypot(up[0], up[1])).toFixed(1),
    widthPx: +(2 * Math.hypot(fore[0], fore[1])).toFixed(1),
    samples: core.length + tyre.length,
    rimTyre: tyreMed > 0.5 ? +(median(core) / tyreMed).toFixed(3) : null,
    rimCoV: +(stdev(inner) / Math.max(1e-6, mean(inner))).toFixed(3),
    rimLuma: +median(core).toFixed(1),
    tyreLuma: +tyreMed.toFixed(1),
  };
}

/** Specular response and vertical gradient over a projected quad on the flank. */
export function flankMetrics(png, quad) {
  const s = sampler(png);
  // quad: [tl, tr, br, bl] in screen px. Sample on a regular (u,v) grid inside it.
  const N = 48;
  const all = [], top = [], bot = [];
  for (let iv = 0; iv <= N; iv++) {
    const v = iv / N;
    for (let iu = 0; iu <= N; iu++) {
      const u = iu / N;
      const x = (1 - u) * ((1 - v) * quad[0][0] + v * quad[3][0])
              + u * ((1 - v) * quad[1][0] + v * quad[2][0]);
      const y = (1 - u) * ((1 - v) * quad[0][1] + v * quad[3][1])
              + u * ((1 - v) * quad[1][1] + v * quad[2][1]);
      const L = s.luma(x, y);
      if (L === null) continue;
      all.push(L);
      if (v < 1 / 3) top.push(L);
      else if (v > 2 / 3) bot.push(L);
    }
  }
  const med = median(all);
  const botMed = median(bot);
  return {
    samples: all.length,
    spec: med > 0.5 ? +(pct(all, 0.98) / med).toFixed(3) : null,
    vGrad: botMed > 0.5 ? +(median(top) / botMed).toFixed(3) : null,
    topLuma: +median(top).toFixed(1),
    botLuma: +botMed.toFixed(1),
  };
}

/** Detail density over the car's projected box: mean |Laplacian| / mean luma. */
export function edgeMetrics(png, box) {
  const s = sampler(png);
  const x0 = Math.max(1, Math.floor(box[0])), y0 = Math.max(1, Math.floor(box[1]));
  const x1 = Math.min(s.w - 2, Math.ceil(box[2])), y1 = Math.min(s.h - 2, Math.ceil(box[3]));
  let lap = 0, lum = 0, n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const c = s.luma(x, y);
      const v = Math.abs(4 * c - s.luma(x - 1, y) - s.luma(x + 1, y)
                             - s.luma(x, y - 1) - s.luma(x, y + 1));
      lap += v; lum += c; n++;
    }
  }
  if (!n) return { edges: null, px: 0 };
  return {
    px: n,
    boxW: x1 - x0 + 1,
    boxH: y1 - y0 + 1,
    edges: +(lap / Math.max(1e-6, lum)).toFixed(4),
  };
}

/**
 * sRGB byte -> linear. CLAUDE.md: a ratio of percentiles is exactly invariant
 * under an exposure change ONLY in linear light; the same ratio on the encoded
 * bytes drifts about 20% across a stop, because the OETF is not a scale. Every
 * ratio below is reported twice - once on the encoded luma, which is what the
 * two reviewers quoted and what their photograph baselines are in, and once in
 * linear light, which is the one that survives a build-to-build exposure move.
 */
export const LIN = (() => {
  const t = new Float64Array(256);
  for (let i = 0; i < 256; i++) {
    const c = i / 255;
    t[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }
  return t;
})();

function lumaSamples(png, cx, cy, up, fore) {
  const s = sampler(png);
  const { data, width: w, channels: ch } = png;
  const det = up[0] * fore[1] - up[1] * fore[0];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-6) return null;
  const i00 = fore[1] / det, i01 = -fore[0] / det;
  const i10 = -up[1] / det, i11 = up[0] / det;
  const rx = Math.abs(up[0]) + Math.abs(fore[0]);
  const ry = Math.abs(up[1]) + Math.abs(fore[1]);
  const core = [], tyre = [], coreLin = [], tyreLin = [];
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const dx = x - cx, dy = y - cy;
      const d = Math.hypot(i00 * dx + i01 * dy, i10 * dx + i11 * dy);
      if (d > 1) continue;
      const L = s.luma(x, y);            // throws on a stride bug rather than NaN
      if (L === null) continue;
      const p = ((y | 0) * w + (x | 0)) * ch;
      const lin = 0.2126 * LIN[data[p]] + 0.7152 * LIN[data[p + 1]] + 0.0722 * LIN[data[p + 2]];
      if (d < 0.55) { core.push(L); coreLin.push(lin); }
      if (d >= 0.80) { tyre.push(L); tyreLin.push(lin); }
    }
  }
  return { core, tyre, coreLin, tyreLin };
}

/**
 * How much of the rim is bright, and how bright is its brightest part.
 *
 * TAKEN FROM the second blind reviewer of the round-1 car pass, which is the
 * only wheel metric in this project with REAL-PHOTOGRAPH baselines attached:
 *
 *   hubPeak = p95(core) / median(tyre)      Mustang 1.67, parked SUV 1.60
 *   hubFrac = % of core brighter than 1.5x median(tyre)   28.6% and 7.9%
 *
 * Why both are needed, and why rimTyre alone sent round 1 the wrong way. A real
 * alloy at 30 px is a bright face covering MOST of the core; the round-1 traffic
 * wheel is a dark face with one specular dot in it - "a hole plus a speck" -
 * and that reads as a HIGH peak over a tiny fraction. rimTyre averages the two
 * back into an unremarkable number. The photographs put rimTyre at 0.958 and
 * 1.015, i.e. a real wheel's core median is about the SAME as its tyre: a wheel
 * is mostly dark, with a bright MINORITY. Chasing rimTyre upward would build a
 * bright disc, which is the defect two rounds of critique already named.
 */
export function hubMetrics(png, cx, cy, up, fore) {
  const S = lumaSamples(png, cx, cy, up, fore);
  if (!S) return { hubPeak: null, hubFrac: null, coreN: 0, degenerate: true };
  const t = median(S.tyre), tLin = median(S.tyreLin);
  const thr = 1.5 * t;
  const frac = S.core.filter((v) => v > thr).length / Math.max(1, S.core.length);
  const fracLin = S.coreLin.filter((v) => v > 1.5 * tLin).length / Math.max(1, S.coreLin.length);
  return {
    hubPeak: +(pct(S.core, 0.95) / Math.max(1e-6, t)).toFixed(2),
    hubFrac: +(100 * frac).toFixed(1),
    hubPeakLin: +(pct(S.coreLin, 0.95) / Math.max(1e-9, tLin)).toFixed(2),
    hubFracLin: +(100 * fracLin).toFixed(1),
    rimTyreLin: +(median(S.coreLin) / Math.max(1e-9, tLin)).toFixed(3),
    coreN: S.core.length, tyreMed: +t.toFixed(1),
  };
}

/**
 * The GRILLE APERTURE, sampled over the quad the grille's own geometry projects
 * to. Both blind reviewers of round 1 named this rectangle independently - one
 * as "a flat-black front valance slab", the other, correctly, as the grille -
 * and the numbers they gave are all of the same shape: mean luma 9.9-10.1 with a
 * standard deviation of 0.42-0.46 over 3,600-6,900 px. So:
 *
 *   flatSd    stdev of luma over the aperture, raw. The reviewers' number.
 *   flatRel   the same spread as a fraction of the CAR'S OWN PAINT median.
 *             Exposure-invariant (both terms come from one frame) and, unlike
 *             sd/mean on the aperture itself, its denominator is not near-black -
 *             CLAUDE.md is explicit that a dusk/night ratio between two near-black
 *             quantities is how round 1's wheel defect got past review.
 *   vsPaint   aperture median / paint median. "How much darker than its own car."
 *   vsShadow  aperture median / the shadow under the car. Reviewer 2's test, and
 *             the one with a floor in it: a grille that is DARKER than the shadow
 *             its own car casts is not a grille, it is a hole. Must be > 1.
 *
 * All three ratios are also reported in linear light, where a ratio of
 * percentiles is exactly invariant under an exposure change.
 */
export function noseMetrics(png, quad, paintQuad, shadowQuad) {
  const s = sampler(png);
  const { data, width: w, channels: ch } = png;
  const grid = (q, N) => {
    const L = [], lin = [];
    for (let iv = 0; iv <= N; iv++) {
      for (let iu = 0; iu <= N; iu++) {
        const u = iu / N, v = iv / N;
        const x = (1 - u) * ((1 - v) * q[0][0] + v * q[3][0]) + u * ((1 - v) * q[1][0] + v * q[2][0]);
        const y = (1 - u) * ((1 - v) * q[0][1] + v * q[3][1]) + u * ((1 - v) * q[1][1] + v * q[2][1]);
        // ROUND, do not let sampler() truncate. The bilinear form underflows on
        // its own edges: for a quad whose top edge is y = 806 at both corners,
        // u = 0.05 evaluates 0.95*806 + 0.05*806 = 805.9999999999999, and a
        // truncating read then samples the row ABOVE the rectangle. On the
        // synthetic frame in tools/car-frames.mjs that put 3 samples of bodywork
        // at luma 120 into a grille painted dead flat at 10 and reported its
        // spread as sd 4.64 instead of 0 - a fifth of the entire signal this
        // round is judged on, invented by floating point at a rectangle edge.
        // flankMetrics above has the same latent bug and is deliberately NOT
        // changed: its numbers have to stay comparable with the two blind
        // reviews', and its quads sit well inside large panels where the edge
        // row is the same material anyway.
        const c = s.luma(Math.round(x), Math.round(y));
        if (c === null) continue;
        L.push(c);
        const p = (Math.round(y) * w + Math.round(x)) * ch;
        lin.push(0.2126 * LIN[data[p]] + 0.7152 * LIN[data[p + 1]] + 0.0722 * LIN[data[p + 2]]);
      }
    }
    return { L, lin };
  };
  const a = grid(quad, 40), p = grid(paintQuad, 24), sh = grid(shadowQuad, 16);
  const m = mean(a.L), sd = stdev(a.L);
  const paintMed = median(p.L), shMed = median(sh.L);
  const paintLin = median(p.lin), shLin = median(sh.lin);
  return {
    samples: a.L.length,
    meanL: +m.toFixed(2), medL: +median(a.L).toFixed(2),
    flatSd: +sd.toFixed(2),
    flatP95P5: +(pct(a.L, 0.95) - pct(a.L, 0.05)).toFixed(1),
    flatRel: +(sd / Math.max(1e-6, paintMed)).toFixed(4),
    vsPaint: +(median(a.L) / Math.max(1e-6, paintMed)).toFixed(3),
    vsShadow: +(median(a.L) / Math.max(1e-6, shMed)).toFixed(3),
    flatRelLin: +(stdev(a.lin) / Math.max(1e-9, paintLin)).toFixed(4),
    vsPaintLin: +(median(a.lin) / Math.max(1e-9, paintLin)).toFixed(3),
    vsShadowLin: +(median(a.lin) / Math.max(1e-9, shLin)).toFixed(3),
    paintMed: +paintMed.toFixed(1), shadowMed: +shMed.toFixed(1),
  };
}

/**
 * Draw the sampled regions onto a copy of the frame. This is not decoration:
 * the first framing this tool used put its "flank" quad on a surface the camera
 * could barely see, and the metric obligingly returned a number for it. A rect
 * that is not looked at is a rect that is measuring the background.
 */
export function overlay(png, setup, file) {
  const { width: w, height: h, channels: ch, data } = png;
  const rgb = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    rgb[i * 3] = data[i * ch]; rgb[i * 3 + 1] = data[i * ch + 1]; rgb[i * 3 + 2] = data[i * ch + 2];
  }
  const put = (x, y, c) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= w || yi >= h) return;
    const p = (yi * w + xi) * 3;
    rgb[p] = c[0]; rgb[p + 1] = c[1]; rgb[p + 2] = c[2];
  };
  const ellipse = (cx, cy, up, fore, k, c) => {
    for (let a = 0; a < 720; a++) {
      const t = a / 114.6;
      put(cx + k * (up[0] * Math.cos(t) + fore[0] * Math.sin(t)),
        cy + k * (up[1] * Math.cos(t) + fore[1] * Math.sin(t)), c);
    }
  };
  const line = (a, b, c) => {
    const n = Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1])) + 1;
    for (let i = 0; i <= n; i++) put(a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n, c);
  };
  for (const wd of [setup.wheelFront, setup.wheelRear]) {
    ellipse(wd.cx, wd.cy, wd.up, wd.fore, 1, [0, 255, 0]);      // the disc sampled
    ellipse(wd.cx, wd.cy, wd.up, wd.fore, 0.55, [255, 255, 0]); // rim core
    ellipse(wd.cx, wd.cy, wd.up, wd.fore, 0.80, [255, 128, 0]); // tyre annulus
  }
  for (let i = 0; i < 4; i++) line(setup.flank[i], setup.flank[(i + 1) % 4], [255, 0, 255]);
  if (setup.deck) for (let i = 0; i < 4; i++) line(setup.deck[i], setup.deck[(i + 1) % 4], [255, 255, 255]);
  const [x0, y0, x1, y1] = setup.box;
  line([x0, y0], [x1, y0], [0, 200, 255]); line([x1, y0], [x1, y1], [0, 200, 255]);
  line([x1, y1], [x0, y1], [0, 200, 255]); line([x0, y1], [x0, y0], [0, 200, 255]);
  writePNG(file, w, h, rgb);
}

// ------------------------------------------------------------------ selftest
//
// Each case is a KNOWN-BAD or KNOWN-GOOD synthetic frame, because a metric that
// has never been shown a wrong answer is not an instrument. Two probes in this
// project shipped bugs their own self-tests caught.
function synth(w, h, ch, paint) {
  const data = new Uint8Array(w * h * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = paint(x, y);
      const p = (y * w + x) * ch;
      data[p] = c[0]; data[p + 1] = c[1]; data[p + 2] = c[2];
      if (ch === 4) data[p + 3] = 255;
    }
  }
  return { width: w, height: h, channels: ch, data };
}

export function selftest() {
  const fail = [];
  const ok = (name, cond, got) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${got !== undefined ? `  (${got})` : ''}`);
    if (!cond) fail.push(name);
  };

  // 1. The defect this tool was built to name: a featureless dark disc. The rim
  //    must NOT be reported as legible.
  const UP = [0, 24], FORE = [24, 0];                       // a round-on wheel
  const flat = synth(64, 64, 3, (x, y) =>
    (Math.hypot(x - 32, y - 32) < 24 ? [18, 19, 22] : [140, 140, 140]));
  const mFlat = wheelMetrics(flat, 32, 32, UP, FORE);
  ok('flat disc: rimTyre ~ 1', Math.abs(mFlat.rimTyre - 1) < 0.05, mFlat.rimTyre);
  ok('flat disc: rimCoV ~ 0', mFlat.rimCoV < 0.02, mFlat.rimCoV);

  // 2. A rim that IS legible: bright core, dark tyre. Both metrics must rise.
  const alloyPaint = (sx) => (x, y) => {
    const d = Math.hypot((x - 32) / sx, y - 32);
    if (d > 24) return [140, 140, 140];                    // bright background
    if (d > 18) return [18, 19, 22];                       // tyre
    const a = Math.atan2(y - 32, (x - 32) / sx);
    const lobe = 0.5 + 0.5 * Math.cos(5 * a);              // five spokes
    const v = Math.round(40 + 170 * lobe);
    return [v, v, v];
  };
  const mAlloy = wheelMetrics(synth(64, 64, 3, alloyPaint(1)), 32, 32, UP, FORE);
  ok('alloy disc: rimTyre > 2', mAlloy.rimTyre > 2, mAlloy.rimTyre);
  ok('alloy disc: rimCoV > 0.3', mAlloy.rimCoV > 0.3, mAlloy.rimCoV);

  // 2b. THE ELLIPSE TRAP. The same wheel foreshortened to 0.42 of its width -
  //     which is roughly what a kerbside car gives from the carriageway. Sampled
  //     with the correct semi-axes it must read the SAME as the round-on one.
  //     Sampled as a circle it must not: the annulus fills with bright
  //     background and the ratio collapses toward 1, which is exactly how a real
  //     10:1 albedo step came back as 1.20 and made a fix look like a
  //     regression.
  const squashed = synth(64, 64, 3, alloyPaint(0.42));
  const mEll = wheelMetrics(squashed, 32, 32, UP, [24 * 0.42, 0]);
  const mAsCircle = wheelMetrics(squashed, 32, 32, UP, FORE);
  ok('foreshortened, elliptical sampling: same answer',
    Math.abs(mEll.rimTyre - mAlloy.rimTyre) / mAlloy.rimTyre < 0.15,
    `${mEll.rimTyre} vs ${mAlloy.rimTyre}`);
  ok('foreshortened, CIRCULAR sampling: collapses toward 1',
    mAsCircle.rimTyre < 0.5 * mEll.rimTyre, `${mAsCircle.rimTyre} vs ${mEll.rimTyre}`);

  // 3. THE STRIDE TRAP. readPNG returns channels 3 for these screenshots. A
  //    4-byte stride misreads every pixel and runs off the buffer in the bottom
  //    quarter, where the samples come back NaN - and NaN loses every comparison
  //    silently, so the corrupted rows report "no difference". A known value is
  //    planted in the BOTTOM quarter of a 3-channel image; a tool with the bug
  //    cannot read it back.
  const planted = synth(40, 40, 3, (x, y) => (y >= 30 ? [200, 200, 200] : [10, 10, 10]));
  const sp = sampler(planted);
  ok('3ch: bottom quarter reads planted 200', Math.abs(sp.luma(20, 35) - 200) < 1,
    sp.luma(20, 35).toFixed(1));
  ok('3ch: top reads planted 10', Math.abs(sp.luma(20, 5) - 10) < 1, sp.luma(20, 5).toFixed(1));
  // The same image at 4 channels must give the SAME answer through the accessor.
  const planted4 = synth(40, 40, 4, (x, y) => (y >= 30 ? [200, 200, 200] : [10, 10, 10]));
  ok('4ch: same answer as 3ch', Math.abs(sampler(planted4).luma(20, 35) - 200) < 1);
  // And the naive 4-stride read of that same 3-channel buffer: index
  // (35*40+20)*4 = 5680 against a 4800-byte buffer, so it runs off the end and
  // comes back `undefined`. The second assertion is the point of the whole
  // case - `Math.abs(undefined - 200) > 1` is FALSE, so a tool written that way
  // reports the corrupted rows as MATCHING. That is the reassuring wrong answer.
  const bad = planted.data[(35 * 40 + 20) * 4];
  ok('a 4-stride read of a 3ch buffer runs off the end', bad === undefined, String(bad));
  ok('...and the naive NaN guard does not fire', (Math.abs(bad - 200) > 1) === false);

  // 4. vGrad must SEE a top-to-bottom fade, must report ~1 on a flat panel, and
  //    must be MONOTONIC in the steepness of the fade - that last property is
  //    the one a before/after comparison actually rests on.
  const fadeOf = (drop) => synth(64, 64, 3, (x, y) => {
    const v = Math.round(240 - drop * (y / 63)); return [v, v, v];
  });
  const q = [[8, 8], [56, 8], [56, 56], [8, 56]];
  const gentle = flankMetrics(fadeOf(120), q).vGrad;
  const steep = flankMetrics(fadeOf(220), q).vGrad;
  ok('fade: vGrad > 1.4', gentle > 1.4, gentle);
  ok('steeper fade reads higher', steep > gentle + 0.5, `${gentle} -> ${steep}`);
  const flatPanel = synth(64, 64, 3, () => [120, 120, 120]);
  const mFlatP = flankMetrics(flatPanel, q);
  ok('flat panel: vGrad ~ 1', Math.abs(mFlatP.vGrad - 1) < 0.02, mFlatP.vGrad);
  ok('flat panel: spec ~ 1', Math.abs(mFlatP.spec - 1) < 0.02, mFlatP.spec);

  // 5. A glint must raise spec - and a glint too SMALL to reach the top 2% of
  //    the samples must not, which is this metric's resolution limit stated as a
  //    test so that nobody later quotes spec for a highlight it cannot see.
  const glintOf = (r) => synth(64, 64, 3, (x, y) =>
    (Math.hypot(x - 32, y - 20) < r ? [250, 250, 250] : [110, 110, 110]));
  const bigGlint = flankMetrics(glintOf(9), q).spec;      // 9.4% of the quad
  const tinyGlint = flankMetrics(glintOf(4), q).spec;     // 1.87% of the quad
  ok('broad glint: spec > 1.5', bigGlint > 1.5, bigGlint);
  ok('sub-2% glint is BELOW this metric resolution', tinyGlint === 1, tinyGlint);

  // 6. edges must rise on a striped panel and sit near zero on a flat one.
  const stripes = synth(64, 64, 3, (x) => { const v = x % 6 < 3 ? 60 : 180; return [v, v, v]; });
  const eFlat = edgeMetrics(flatPanel, [8, 8, 56, 56]).edges;
  const eStripe = edgeMetrics(stripes, [8, 8, 56, 56]).edges;
  ok('flat panel: edges ~ 0', eFlat < 0.01, eFlat);
  ok('striped panel: edges > 10x flat', eStripe > 10 * Math.max(eFlat, 1e-4), eStripe);

  // 7. hubPeak / hubFrac must separate the two failure modes that rimTyre
  //    averages together, because that averaging is what let round 1 ship a
  //    wheel the next review called "a hole plus a speck".
  //      A) a BRIGHT FACE covering most of the core  -> high frac, modest peak
  //      B) a DARK face with one hot dot in it       -> tiny frac, huge peak
  //    A metric that cannot tell A from B cannot adjudicate this round.
  const tyreRing = (x, y) => (Math.hypot(x - 32, y - 32) >= 18 ? [20, 20, 20] : null);
  const brightFace = synth(64, 64, 3, (x, y) => {
    if (Math.hypot(x - 32, y - 32) > 24) return [140, 140, 140];
    return tyreRing(x, y) ?? [70, 70, 70];              // 3.5x the tyre, everywhere
  });
  const dotOf = (r) => synth(64, 64, 3, (x, y) => {
    if (Math.hypot(x - 32, y - 32) > 24) return [140, 140, 140];
    if (Math.hypot(x - 32, y - 32) < r) return [250, 250, 250];   // one hot dot
    return tyreRing(x, y) ?? [18, 18, 18];             // otherwise darker than the tyre
  });
  const specDot = dotOf(4);                            // 9.2% of the core
  const hB = hubMetrics(brightFace, 32, 32, UP, FORE);
  const hD = hubMetrics(specDot, 32, 32, UP, FORE);
  ok('bright face: hubFrac is most of the core', hB.hubFrac > 90, `${hB.hubFrac}%`);
  ok('dark face + hot dot: hubFrac is a small minority', hD.hubFrac < 15, `${hD.hubFrac}%`);
  ok('dark face + hot dot: hubPeak is high anyway', hD.hubPeak > 5, hD.hubPeak);
  // RESOLUTION LIMIT, stated as a test so nobody later quotes hubPeak for a
  // highlight it cannot see. hubPeak is a p95, so a specular dot covering under
  // 5% of the core does not reach it at all - the same shape of limit `spec`
  // carries above. The round-1 wheel's reported 27.9 peak was therefore a
  // highlight over 5% of the core, not a single pixel.
  const hTiny = hubMetrics(dotOf(2), 32, 32, UP, FORE);   // 2.3% of the core
  ok('a sub-5% hot dot is BELOW hubPeak resolution', hTiny.hubPeak < 1.2,
    `${hTiny.hubPeak} at 2.3% coverage vs ${hD.hubPeak} at 9.2%`);
  ok('the two are NOT separated by rimTyre alone',
    Math.abs(wheelMetrics(brightFace, 32, 32, UP, FORE).rimTyre
           - wheelMetrics(specDot, 32, 32, UP, FORE).rimTyre) > 1,
    'stated so the pair is used together, never rimTyre by itself');

  // 7b. The linear-light twin must be EXACTLY invariant under an exposure change
  //     and the encoded one must NOT be - CLAUDE.md records a 20% drift on the
  //     sRGB bytes across a stop. Half the linear signal, re-encode, remeasure.
  const enc = (lin) => Math.round(255 * (lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055));
  const dec = (b) => LIN[b];
  const expose = (src, k) => synth(64, 64, 3, (x, y) => {
    const v = enc(dec(src.data[(y * 64 + x) * 3]) * k);
    return [v, v, v];
  });
  // A wheel with plenty of signal in it: tyre 60, face 180. Halving the LINEAR
  // light must leave the linear ratio alone and must move the encoded one.
  const litWheel = synth(64, 64, 3, (x, y) => {
    if (Math.hypot(x - 32, y - 32) > 24) return [140, 140, 140];
    return Math.hypot(x - 32, y - 32) >= 18 ? [60, 60, 60] : [180, 180, 180];
  });
  const hL = hubMetrics(litWheel, 32, 32, UP, FORE);
  const hLs = hubMetrics(expose(litWheel, 0.5), 32, 32, UP, FORE);
  ok('hubPeakLin survives a half-stop exposure change',
    Math.abs(hLs.hubPeakLin - hL.hubPeakLin) / hL.hubPeakLin < 0.02,
    `${hL.hubPeakLin} -> ${hLs.hubPeakLin}`);
  ok('...and the ENCODED hubPeak does not, which is why both are reported',
    Math.abs(hLs.hubPeak - hL.hubPeak) / hL.hubPeak > 0.05,
    `${hL.hubPeak} -> ${hLs.hubPeak}`);
  // THE LIMIT OF THAT INVARIANCE, and it matters because two of the four hours
  // in this round are dusk and night. Linear invariance is exact in continuous
  // light; the frames are 8-bit. Run the SAME check on a near-black wheel (tyre
  // 20, face 70) and the linear ratio drifts several percent purely from
  // quantisation at the dark end. So a night reading is not a precision
  // instrument however it is normalised - which is the concrete form of
  // CLAUDE.md's rule against calibrating at night on near-black quantities.
  const hDk = hubMetrics(brightFace, 32, 32, UP, FORE);
  const hDks = hubMetrics(expose(brightFace, 0.5), 32, 32, UP, FORE);
  const drift = Math.abs(hDks.hubPeakLin - hDk.hubPeakLin) / hDk.hubPeakLin;
  ok('near-black: 8-bit quantisation breaks the invariance (stated, not hidden)',
    drift > 0.02, `${hDk.hubPeakLin} -> ${hDks.hubPeakLin} = ${(100 * drift).toFixed(1)}% drift`);

  // 8. noseMetrics must call the round-1 grille what it is: DEAD FLAT. The
  //    reviewers measured sd 0.42-0.46 on it against sd 13.3 on the bonnet, so
  //    the test is that a flat patch and a modulated one are far apart, and that
  //    vsShadow catches an aperture darker than the shadow under its own car.
  const q40 = [[8, 8], [56, 8], [56, 40], [8, 40]];
  const paintQ = [[8, 44], [56, 44], [56, 60], [8, 60]];
  const shadowQ = [[0, 61], [63, 61], [63, 63], [0, 63]];
  const noseFrame = (grille) => synth(64, 64, 3, (x, y) => {
    if (y >= 61) return [16, 16, 16];                  // shadow under the car
    if (y >= 44) return [107, 107, 107];               // body paint
    const v = grille(x, y); return [v, v, v];
  });
  const flatG = noseMetrics(noseFrame(() => 10), q40, paintQ, shadowQ);
  const slatG = noseMetrics(noseFrame((x, y) => (y % 8 < 4 ? 26 : 62)), q40, paintQ, shadowQ);
  ok('a dead-flat aperture reads sd ~0', flatG.flatSd < 0.01, flatG.flatSd);
  ok('a slatted aperture reads a large sd', slatG.flatSd > 15, slatG.flatSd);
  ok('flat aperture is DARKER than the shadow under the car (vsShadow < 1)',
    flatG.vsShadow < 1, flatG.vsShadow);
  ok('slatted aperture clears the shadow floor (vsShadow > 1)',
    slatG.vsShadow > 1, slatG.vsShadow);
  ok('vsPaint sees the round-1 ratio (10/107)', Math.abs(flatG.vsPaint - 10 / 107) < 0.01,
    flatG.vsPaint);
  // KNOWN-BAD: sd/mean ON THE APERTURE ITSELF cannot tell a near-black flat panel
  // from a near-black modulated one once the frame is dark, which is exactly the
  // trap CLAUDE.md names. flatRel normalises by the paint instead; prove it still
  // separates them when everything is scaled down 20x.
  const darkFlat = noseMetrics(noseFrame(() => 1), q40, paintQ, shadowQ);
  const darkSlat = noseMetrics(noseFrame((x, y) => (y % 8 < 4 ? 1 : 4)), q40, paintQ, shadowQ);
  ok('flatRel still separates flat from slatted in a near-black aperture',
    darkSlat.flatRel > 5 * Math.max(darkFlat.flatRel, 1e-4),
    `${darkFlat.flatRel} vs ${darkSlat.flatRel}`);

  console.log(fail.length ? `\nSELFTEST FAILED: ${fail.join(', ')}` : '\nSELFTEST OK');
  return fail.length === 0;
}

// Guarded on being the ENTRY module, not merely on the flag being present.
// Without that, `node tools/car-frames.mjs --selftest` runs THIS file's
// self-test and exits before its own ever starts - which is exactly what
// happened, and it printed a full page of PASS lines for the wrong tool.
const DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT && process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);
