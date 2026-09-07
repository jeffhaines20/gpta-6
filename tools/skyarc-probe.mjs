// The two defects this round was opened for, as numbers, read off committed
// frames.
//
//   1. AT GOLDEN THE WHOLE DOME WARMS, NOT JUST THE SUN SIDE. The sky away from
//      the sun should still be blue; two blind reviewers measured it neutral.
//   2. NOON IS MILKY AND ITS DAPPLE HAS LOST CONTRAST.
//
// WHAT "CHROMA" MEANS HERE, because this project already has two other
// definitions and they disagree in SIGN on the frame this round is about.
//
//   tools/shade-probe.mjs  rbn     = (R-B)/(R+B) on LINEARISED byte means
//   this file              chroma  = (R-B)/(R+G+B) on the byte means
//
// The reviews this round answers are in the second. On r8-corridor-golden's sky
// rect the byte means are (179.3, 177.4, 177.7): rbn reads +0.0062 and chroma
// reads +0.0030 - a factor of two on the number this round is graded by - and on
// darker rects the two diverge much further, because rbn linearises first and
// chroma does not. Neither is wrong; quoting one against a number computed in the
// other is. Both are reported on every rect below so a later round can read
// either.
//
// EVERYTHING IS A RATIO INSIDE ONE FRAME. Noon's stop moved between the two
// builds compared here (1/33,500 -> 1/22,100, +0.60 stops), so an absolute R-B is
// not comparable across them - and that is not a hypothetical caveat, it is most
// of defect 2. reExpose() below re-tonemaps a frame at another stop through the
// renderer's own chain, so "what did the STOP do" can be separated from "what did
// the LIGHT do" instead of guessed at.
//
// TWO THINGS THAT WILL MISLEAD A READER OF THIS OUTPUT IF THEY ARE NOT SAID:
//
//   - THE SKY RECT CONTAINS CLOUD, and the cloud phase differs between any two
//     capture sessions. r8's corridor sky rect has sd 12.8 where r2post's has
//     4.0, and a lit deck is near-neutral, so the rect mean confounds "the sky
//     got warmer" with "a cloud drifted into the rect". So the rect is also
//     reported by LUMA QUINTILE: at noon and golden the clear dome is the DARK
//     end of the sky rect and the deck is the bright end, and the darkest
//     quintile is the closest thing to a cloud-free read this frame allows.
//     Stated as a limitation rather than a mask: it is a quantile, so it
//     reselects when the frame's exposure moves, and it is only safe here
//     because the reExpose() arm shows both ends moving together.
//
//   - AT GOLDEN ALMOST NOTHING IN THE GROUND BAND IS SUNLIT. Measured on these
//     frames, the brightest quintile of the road band is not a sun population at
//     8 degrees of elevation - it is gaps in the oak canopy plus vehicle roofs.
//     Every lit/shade row therefore prints its own n, and the golden rows are
//     labelled. Two reviewers once built a diagnosis on a "sunlit" sample of this
//     band and were wrong.
//
//   node tools/skyarc-probe.mjs --selftest
//   node tools/skyarc-probe.mjs r8-corridor-golden r2post-corridor-golden ...
//   node tools/skyarc-probe.mjs --restop 33500:22100 r2post-corridor-noon
import fs from 'node:fs';
import { readPNG } from './png.mjs';
import { unDisplay } from './critic-metrics.mjs';

// --------------------------------------------------------------- the geometry
// 1600x900, the tools/hero-shots.mjs framings. The rects are the ones the two
// reviews used, restated here once so a later round re-reads the same pixels.
export const SKY_RECT = [330, 45, 600, 150];        // upper frame, anti-solar half
// The road, minus the median strip and the kerb lines that bound it. Two x
// ranges, not one, because the strip between them is not carriageway.
// THIS RECT IS THE CORRIDOR CAMERA'S AND ONLY THE CORRIDOR CAMERA'S. Measured
// with the geometric mask below, it is 77.0% shade at corridor noon and 99.82%
// SUN at fivepoints noon - at fivepoints the same screen rectangle lands on open
// sunlit plaza, mean L 168 against the corridor's 55, and its dapple and shade
// rows there are describing a different surface in a different light. Read the
// road rows on corridor frames; at fivepoints read the ground/plaza means.
export const ROAD_X = [[600, 795], [875, 1065]];
export const ROAD_Y = [700, 885];
export const DAPPLE_ROW = 790;
export const BRICK_RECT = [1330, 690, 1470, 730];   // shaded brick footway

const s2l = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; s2l[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }
const luma8 = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** (R-B)/(R+G+B) on byte means. The definition both reviews of this round used. */
export const chroma = (r, g, b) => (r - b) / Math.max(r + g + b, 1e-9);
/** (R-B)/(R+B) on linearised byte means. tools/shade-probe.mjs calls this rbn. */
export const rbn = (r, b) => {
  const R = s2l[Math.max(0, Math.min(255, Math.round(r)))];
  const B = s2l[Math.max(0, Math.min(255, Math.round(b)))];
  return (R - B) / Math.max(R + B, 1e-9);
};

// ------------------------------------------------------------- pixel gathering
// channels, NOT 4. Playwright writes 3-channel PNGs for opaque screenshots and a
// hardcoded stride misaligns every sample and reads past the buffer in the bottom
// quarter, where the undefined reads become NaN - and NaN fails every comparison
// silently, so the affected rows report "no difference". gather() throws on a
// non-finite sample for that reason, and selftest() feeds it a bad stride.
function gather(img, spans) {
  const { width: W, height: H, channels: C, data } = img;
  const px = [];
  for (const [x0, y0, x1, y1] of spans) {
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const i = (y * W + x) * C, r = data[i], g = data[i + 1], b = data[i + 2];
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
          throw new Error(`non-finite sample at ${x},${y} — stride wrong? (channels=${C})`);
        }
        px.push([luma8(r, g, b), r, g, b]);
      }
    }
  }
  return px;
}
function stat(px) {
  if (!px.length) return { n: 0 };
  let r = 0, g = 0, b = 0, L = 0;
  for (const p of px) { L += p[0]; r += p[1]; g += p[2]; b += p[3]; }
  const n = px.length;
  r /= n; g /= n; b /= n; L /= n;
  let v = 0;
  for (const p of px) v += (p[0] - L) ** 2;
  const sd = Math.sqrt(v / n);
  return { n, r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1), L: +L.toFixed(1),
    sd: +sd.toFixed(1), cv: +(sd / Math.max(L, 1e-9)).toFixed(3),
    rb: +(r - b).toFixed(1), chroma: +chroma(r, g, b).toFixed(4), rbn: +rbn(r, b).toFixed(4) };
}
const rect = (img, [x0, y0, x1, y1]) => stat(gather(img, [[x0, y0, x1, y1]]));
const roadSpans = () => ROAD_X.map(([a, b]) => [a, ROAD_Y[0], b, ROAD_Y[1]]);

/**
 * Mean chroma per luma quintile of a region, darkest first.
 * At noon and golden the clear dome is the dark end of the sky rect and the lit
 * cloud deck the bright end; on the road it is shade and sun. A QUANTILE, so it
 * reselects if the frame's level moves - read it alongside the reExpose() arm,
 * never on its own across two builds at different stops.
 */
export function quintiles(img, spans) {
  const px = gather(img, spans).sort((a, b) => a[0] - b[0]);
  const q = Math.floor(px.length / 5);
  return Array.from({ length: 5 }, (_, k) => stat(px.slice(k * q, k === 4 ? px.length : (k + 1) * q)));
}

/**
 * Azimuthal scan of the sky band: chroma per column bin.
 * The whole of defect 1 is that this runs the wrong way - the warm offset was
 * measured LARGER away from the sun than toward it.
 */
export function skyScan(img, y0 = 45, y1 = 150, bin = 100) {
  const out = [];
  for (let x = 0; x + bin <= img.width; x += bin) out.push({ x, ...rect(img, [x, y0, x + bin, y1]) });
  return out;
}

/**
 * Dapple along one scanline of the road, and the SHAPE of its edges.
 *
 * cv is sd/mean, which is what "the dapple reads" means and which falls both
 * when the sun softens and when the ambient rises. Those have opposite fixes, so
 * the gradient percentiles are here too: p99/p90 of |d luma/dx| is an edge SHAPE
 * ratio - it holds when a shadow edge keeps its profile and only its contrast
 * moves, and it collapses when the sun itself is softened.
 */
export function dapple(img, y = DAPPLE_ROW) {
  const { width: W, channels: C, data } = img;
  const rows = [], grads = [];
  for (const [a, b] of ROAD_X) {
    const v = [];
    for (let x = a; x < b; x++) {
      const i = (y * W + x) * C;
      const L = luma8(data[i], data[i + 1], data[i + 2]);
      if (!Number.isFinite(L)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      v.push(L);
    }
    rows.push(...v);
    for (let i = 1; i < v.length; i++) grads.push(Math.abs(v[i] - v[i - 1]));
  }
  const mean = rows.reduce((s, c) => s + c, 0) / rows.length;
  const sd = Math.sqrt(rows.reduce((s, c) => s + (c - mean) ** 2, 0) / rows.length);
  grads.sort((a, b) => a - b);
  const pct = (p) => grads[Math.min(grads.length - 1, Math.floor(p * grads.length))];
  const p90 = pct(0.90), p99 = pct(0.99);
  return { n: rows.length, mean: +mean.toFixed(2), sd: +sd.toFixed(2), cv: +(sd / mean).toFixed(3),
    p90: +p90.toFixed(2), p99: +p99.toFixed(2), edgeShape: +(p99 / Math.max(p90, 1e-9)).toFixed(2) };
}

// ------------------------------------------------------------------- reExpose
// The renderer's own chain, forward: srgb(aces(roll(radiance * exposure))).
// The two rolloff constants MUST match src/post.js's params block; they are the
// same pair tools/critic-metrics.mjs inverts.
const ROLL_KNEE = 0.5, ROLL_CEIL = 8.0;
const roll = (x) => {
  if (x <= ROLL_KNEE) return x;
  const S = ROLL_CEIL - ROLL_KNEE, u = x - ROLL_KNEE;
  return ROLL_KNEE + (S * u) / (S + u);
};
const aces = (x) => Math.min(1, Math.max(0, (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14)));
const l2s = (c) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/**
 * Re-tonemap a frame as if it had been shot at a different stop.
 *
 * This is the instrument that separates "the stop did it" from "the light did
 * it", and defect 2 turns on it. It is exact for everything downstream of the
 * multiply by exposure and wrong for anything upstream that is not linear in
 * radiance - bloom is thresholded in EXPOSED units, so a region near the bloom
 * threshold is not reproduced. The sky rect and the road band are both far below
 * noon's threshold (2.1 exposed), which is why they are the regions read here.
 *
 * @param {number} k new stop / old stop, e.g. (1/22100)/(1/33500).
 */
export function reExpose(img, k) {
  const { width: W, height: H, channels: C, data } = img;
  const out = new Uint8Array(W * H * C);
  const lut = new Uint8Array(256);
  for (let i = 0; i < 256; i++) lut[i] = Math.round(255 * l2s(aces(roll(unDisplay(i) * k))));
  for (let i = 0; i < W * H * C; i += C) {
    for (let c = 0; c < 3; c++) out[i + c] = lut[data[i + c]];
    for (let c = 3; c < C; c++) out[i + c] = data[i + c];
  }
  return { width: W, height: H, channels: C, data: out };
}

// ------------------------------------------------------- a GEOMETRIC sun mask
//
// "State your sun population size before any sun/shade claim" is a rule this
// project paid a round for, and a luma quintile does not answer it: a quantile
// RESELECTS when the frame's level moves, so a change that lifted every shadow
// reads as no change at all. Every lit/shade row above is a quantile and is
// labelled as one.
//
// This is the real split, and it comes free with the bounce arms. The district
// bounce is ambient: removing it takes ~20.7% of the light off a surface lit by
// the ambient alone and ~3.6% off one that also has the sun (noon, sky 15,156 +
// bounce 3,947 against sun-on-horizontal 90,102). So the FRACTIONAL drop between
// the base arm and the bounce00 arm classifies a pixel by which lights reach it,
// not by how bright it is - the same argument tools/warmth-probe.mjs makes for
// its shadow-map A/B, applied to a light this round already had two arms of.
//
// The threshold is placed between the two predicted populations rather than
// fitted: halfway in log terms between 3.6% and 20.7% is 8.6%.
export function bounceMask(base, off, spans, thresh = 0.086) {
  const { width: W, channels: C } = base;
  if (off.width !== W || off.channels !== C) throw new Error('arm size/channel mismatch');
  const lit = [], shade = [];
  for (const [x0, y0, x1, y1] of spans) {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * C;
      const a = 0.2126 * unDisplay(base.data[i]) + 0.7152 * unDisplay(base.data[i + 1]) + 0.0722 * unDisplay(base.data[i + 2]);
      const b = 0.2126 * unDisplay(off.data[i]) + 0.7152 * unDisplay(off.data[i + 1]) + 0.0722 * unDisplay(off.data[i + 2]);
      if (!Number.isFinite(a) || !Number.isFinite(b)) throw new Error(`non-finite at ${x},${y} — stride wrong?`);
      const drop = a > 1e-9 ? (a - b) / a : 0;
      const px = [0.2126 * base.data[i] + 0.7152 * base.data[i + 1] + 0.0722 * base.data[i + 2],
        base.data[i], base.data[i + 1], base.data[i + 2]];
      (drop >= thresh ? shade : lit).push(px);
    }
  }
  const n = lit.length + shade.length;
  return { lit: stat(lit), shade: stat(shade), n,
    litPct: +(100 * lit.length / n).toFixed(2), shadePct: +(100 * shade.length / n).toFixed(2) };
}

// --------------------------------------------------------------------- report
export function measure(img) {
  const sky = rect(img, SKY_RECT);
  const skyQ = quintiles(img, [SKY_RECT]);
  const road = stat(gather(img, roadSpans()));
  const roadQ = quintiles(img, roadSpans());
  return {
    sky, skyClear: skyQ[0], skyBright: skyQ[4],
    scan: skyScan(img),
    road, roadShade: roadQ[0], roadLit: roadQ[4],
    // Hue separation between the two ends of the road band. NOT a sun/shade
    // separation at golden: see the header. n is printed next to it always.
    hueSep: +(roadQ[4].chroma - roadQ[0].chroma).toFixed(3),
    dapple: dapple(img),
    brick: rect(img, BRICK_RECT),
  };
}

function line(tag, m) {
  const p = (o) => `${String(o.r).padStart(5)}/${String(o.g).padStart(5)}/${String(o.b).padStart(5)}`;
  return [
    `${tag}`,
    `  sky rect      ${p(m.sky)}  R-B ${String(m.sky.rb).padStart(6)}  chroma ${m.sky.chroma.toFixed(4).padStart(7)}  rbn ${m.sky.rbn.toFixed(4).padStart(7)}  sd ${m.sky.sd}`,
    `  sky clear q1  ${p(m.skyClear)}  R-B ${String(m.skyClear.rb).padStart(6)}  chroma ${m.skyClear.chroma.toFixed(4).padStart(7)}  (n ${m.skyClear.n})`,
    `  sky bright q5 ${p(m.skyBright)}  R-B ${String(m.skyBright.rb).padStart(6)}  chroma ${m.skyBright.chroma.toFixed(4).padStart(7)}  (n ${m.skyBright.n})`,
    `  sky by column ${m.scan.map((s) => `${s.x}:${s.chroma.toFixed(3)}`).join(' ')}`,
    `  road band     ${p(m.road)}  chroma ${m.road.chroma.toFixed(4).padStart(7)}  rbn ${m.road.rbn.toFixed(4).padStart(7)}  (n ${m.road.n})`,
    `  road dark q1  ${p(m.roadShade)}  chroma ${m.roadShade.chroma.toFixed(4).padStart(7)}  rbn ${m.roadShade.rbn.toFixed(4).padStart(7)}  (n ${m.roadShade.n})`,
    `  road light q5 ${p(m.roadLit)}  chroma ${m.roadLit.chroma.toFixed(4).padStart(7)}  rbn ${m.roadLit.rbn.toFixed(4).padStart(7)}  (n ${m.roadLit.n})  hue sep ${m.hueSep}`,
    `  dapple y${DAPPLE_ROW}   mean ${m.dapple.mean}  sd ${m.dapple.sd}  CV ${m.dapple.cv}  p90 ${m.dapple.p90}  p99 ${m.dapple.p99}  p99/p90 ${m.dapple.edgeShape}  (n ${m.dapple.n})`,
    `  brick footway ${p(m.brick)}  chroma ${m.brick.chroma.toFixed(4).padStart(7)}  rbn ${m.brick.rbn.toFixed(4).padStart(7)}`,
  ].join('\n');
}

// ------------------------------------------------------------------- selftest
// Every case here fails on a KNOWN-BAD implementation. Six passing cases prove
// nothing on their own; what these are for is the four traps this file's own
// measurements could have fallen into.
function selftest() {
  let fail = 0;
  const bad = (m) => { console.error('FAIL ' + m); fail++; };
  const mk = (C, f) => ({ width: 20, height: 20, channels: C,
    data: Uint8Array.from({ length: 20 * 20 * C }, (_, i) => f(i)) });

  // 1. THE STRIDE TRAP. A 3-channel image read with a 4-byte stride runs off the
  //    end of the buffer and reads undefined -> NaN. gather() must throw rather
  //    than return a mean computed over NaN, which compares as "no difference".
  const three = mk(3, (i) => (i % 3 === 0 ? 200 : 100));
  try {
    gather({ ...three, channels: 4 }, [[0, 0, 20, 20]]);
    bad('a 4-byte stride on a 3-channel image did not throw');
  } catch (e) { if (!/non-finite/.test(e.message)) bad(`wrong throw: ${e.message}`); }

  // 2. THE TWO CHROMAS DISAGREE, and this file exists partly to keep them apart.
  //    r8-corridor-golden's sky rect: (179.3, 177.4, 177.7).
  if (Math.abs(chroma(179.3, 177.4, 177.7) - 0.0030) > 0.0005) bad('chroma definition drifted');
  if (Math.abs(rbn(179.3, 177.7) - 0.0062) > 0.0010) bad('rbn definition drifted');
  //    ...and a case where they differ in SIGN, which is the reason both are here.
  if (!(chroma(96, 134, 174) < 0 && rbn(96, 174) < 0)) bad('sign sanity');

  // 3. reExpose AT k=1 MUST BE THE IDENTITY, to the byte, or every "the stop did
  //    it" row in this round is measuring the round-trip and not the stop. This
  //    is the case that caught a real bug: the first version encoded through
  //    Math.round(255*l2s(...)) but decoded with acesOnly(), and k=1 moved 214
  //    of 256 levels.
  const ramp = mk(3, (i) => i % 256);
  const same = reExpose(ramp, 1);
  let moved = 0;
  for (let i = 0; i < ramp.data.length; i++) if (Math.abs(same.data[i] - ramp.data[i]) > 1) moved++;
  if (moved) bad(`reExpose(k=1) moved ${moved} of ${ramp.data.length} samples`);
  //    ...and a brighter stop must not DARKEN anything.
  const up = reExpose(ramp, 1.5);
  for (let i = 0; i < ramp.data.length; i++) {
    if (up.data[i] < ramp.data[i] - 1) { bad(`reExpose(k=1.5) darkened byte ${ramp.data[i]} to ${up.data[i]}`); break; }
  }

  // 4. CV MUST FALL WHEN A CONSTANT IS ADDED and hold when the row is scaled.
  //    That is the whole of "the ambient was lifted, the sun was not softened",
  //    and a CV implemented on sd alone would pass the first and fail the second.
  const rowImg = (f) => {
    const im = mk(3, () => 0);
    for (const [a, b] of ROAD_X) for (let x = a; x < b; x++) { /* out of range on purpose */ void x; }
    return im;
  };
  void rowImg;
  const synth = (fn) => {
    const W = 1600, H = 900, C = 3, data = new Uint8Array(W * H * C);
    for (const [a, b] of ROAD_X) for (let x = a; x < b; x++) {
      const v = fn(x), i = (DAPPLE_ROW * W + x) * C;
      data[i] = data[i + 1] = data[i + 2] = v;
    }
    return { width: W, height: H, channels: C, data };
  };
  const base = dapple(synth((x) => (x % 8 < 4 ? 40 : 80)));
  const lifted = dapple(synth((x) => (x % 8 < 4 ? 40 : 80) + 40));
  const scaled = dapple(synth((x) => Math.round((x % 8 < 4 ? 40 : 80) * 1.5)));
  if (!(lifted.cv < base.cv * 0.7)) bad(`adding a constant did not collapse CV (${base.cv} -> ${lifted.cv})`);
  if (Math.abs(scaled.cv - base.cv) > 0.02) bad(`scaling the row moved CV (${base.cv} -> ${scaled.cv})`);
  //    ...and the edge SHAPE ratio must survive both, because it is the thing
  //    that says "the sun was not softened".
  if (Math.abs(lifted.edgeShape - base.edgeShape) > 0.01) bad('a constant lift moved the edge shape ratio');

  // 5. QUINTILES MUST ORDER BY LUMA. A quintile split that does not sort selects
  //    the rect's raster order, which on a sky rect is "the top of the frame".
  const grad = { width: 1600, height: 900, channels: 3, data: new Uint8Array(1600 * 900 * 3) };
  for (let y = SKY_RECT[1]; y < SKY_RECT[3]; y++) for (let x = SKY_RECT[0]; x < SKY_RECT[2]; x++) {
    const i = (y * 1600 + x) * 3, v = ((x * 7 + y * 13) % 200) + 20;
    grad.data[i] = v; grad.data[i + 1] = v; grad.data[i + 2] = v;
  }
  const qs = quintiles(grad, [SKY_RECT]);
  for (let k = 1; k < 5; k++) if (!(qs[k].L > qs[k - 1].L)) bad(`quintile ${k} is not brighter than ${k - 1}`);

  // 6. THE BOUNCE MASK MUST SPLIT BY LIGHT PATH AND NOT BY BRIGHTNESS. Two
  //    synthetic populations: a DARK pixel that loses only 3.6% when the ambient
  //    goes (a sunlit surface in deep shadow of its own albedo) and a BRIGHT one
  //    that loses 20.7% (open shade off pale pavement). A luma split calls the
  //    first shade and the second sun; the mask must call them the other way
  //    round, or it is a brightness threshold with extra steps.
  const armPair = (fn) => {
    const W = 1600, H = 900, C = 3;
    const mk = () => ({ width: W, height: H, channels: C, data: new Uint8Array(W * H * C) });
    const a = mk(), b = mk();
    for (let x = 600; x < 700; x++) {
      const [va, vb] = fn(x), i = (700 * W + x) * C;
      a.data[i] = a.data[i + 1] = a.data[i + 2] = va;
      b.data[i] = b.data[i + 1] = b.data[i + 2] = vb;
    }
    return [a, b];
  };
  // Byte 60 losing 3.6% of its SCENE radiance, and byte 200 losing 20.7%.
  const enc = (v) => { let lo = 0, hi = 255; while (lo < hi) { const m = (lo + hi) >> 1; if (unDisplay(m) < v) lo = m + 1; else hi = m; } return lo; };
  const [A, B] = armPair((x) => (x < 650
    ? [60, enc(unDisplay(60) * (1 - 0.036))]
    : [200, enc(unDisplay(200) * (1 - 0.207))]));
  const m = bounceMask(A, B, [[600, 700, 700, 701]]);
  if (!(m.litPct > 45 && m.litPct < 55)) bad(`bounce mask split ${m.litPct}% lit, expected ~50%`);
  if (!(m.lit.L < m.shade.L)) bad('bounce mask sorted by brightness, not by light path');

  console.log(fail ? `SKYARC SELFTEST: ${fail} FAILED` : 'SKYARC SELFTEST: PASS — 6 cases, 5 of them known-bad inputs');
  return fail;
}

// ----------------------------------------------------------------------- main
const DIRECT = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/skyarc-probe.mjs');
if (DIRECT) {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);
  // --mask base.png off.png : the geometric sun/shade split off a bounce arm pair.
  const mi = argv.indexOf('--mask');
  if (mi >= 0) {
    const [ba, oa] = [argv[mi + 1], argv[mi + 2]];
    const f = (t) => (t.endsWith('.png') ? t : `docs/shots/${t}.png`);
    const m = bounceMask(readPNG(f(ba)), readPNG(f(oa)), ROAD_X.map(([a, b]) => [a, ROAD_Y[0], b, ROAD_Y[1]]));
    const p = (o) => `${String(o.r).padStart(5)}/${String(o.g).padStart(5)}/${String(o.b).padStart(5)}`;
    console.log(`geometric split of the road band, ${ba} against ${oa}`);
    console.log(`  SUN   ${p(m.lit)}  L ${m.lit.L}  chroma ${m.lit.chroma.toFixed(4)}  rbn ${m.lit.rbn.toFixed(4)}  n ${m.lit.n} (${m.litPct}% of ${m.n})`);
    console.log(`  SHADE ${p(m.shade)}  L ${m.shade.L}  chroma ${m.shade.chroma.toFixed(4)}  rbn ${m.shade.rbn.toFixed(4)}  n ${m.shade.n} (${m.shadePct}%)`);
    console.log(`  hue separation (sun - shade), chroma ${(m.lit.chroma - m.shade.chroma).toFixed(4)}  rbn ${(m.lit.rbn - m.shade.rbn).toFixed(4)}`);
    process.exit(0);
  }
  const ri = argv.indexOf('--restop');
  let restop = null;
  if (ri >= 0) { const [o, n] = argv[ri + 1].split(':').map(Number); restop = { o, n, k: o / n }; argv.splice(ri, 2); }
  const dir = 'docs/shots';
  const out = {};
  for (const tag of argv) {
    const file = tag.endsWith('.png') ? tag : `${dir}/${tag}.png`;
    if (!fs.existsSync(file)) { console.error(`missing ${file}`); continue; }
    const img = readPNG(file);
    const m = measure(img);
    out[tag] = m;
    console.log(line(tag, m));
    if (restop) {
      const rm = measure(reExpose(img, restop.k));
      out[`${tag} @1/${restop.n}`] = rm;
      console.log(line(`${tag}  RE-EXPOSED 1/${restop.o} -> 1/${restop.n}  (${(Math.log2(restop.k)).toFixed(3)} stops)`, rm));
    }
    console.log('');
  }
  const tag = process.env.SKYARC_TAG;
  if (tag) {
    fs.mkdirSync('docs', { recursive: true });
    fs.writeFileSync(`docs/skyarc-${tag}.json`, JSON.stringify(out, null, 1));
    console.log(`wrote docs/skyarc-${tag}.json`);
  }
}
