// The four falsifiable predictions the round-7 lighting critic left, computed
// from a frame rather than argued about.
//
// Every number here is read off a PNG with tools/png.mjs, and the ratios are
// LINEARISED first: a screenshot is sRGB-encoded, so a ratio of 8-bit values is
// not a ratio of light and log2 of it is not a stop.
import { readPNG } from './png.mjs';

const s2l = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  s2l[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export const lin = (v) => s2l[v];
const Y = (r, g, b) => 0.2126 * s2l[r] + 0.7152 * s2l[g] + 0.0722 * s2l[b];

// The RIGHT inverse for this renderer, and it is NEITHER the sRGB one NOR the
// bare ACES one. It is both, in that order.
//
// src/post.js's composite ends `aces(color * exposure)` -> sRGB encode ->
// dither -> gl_FragColor, so recovering the radiance behind a byte means undoing
// the sRGB transfer FIRST and the tonemap SECOND.
//
// WHAT THIS FILE SAID BEFORE, AND WHY IT WAS RIGHT AT THE TIME. The composite is
// a RawShaderMaterial and three.js substitutes no <colorspace_fragment> into it,
// so for as long as the encode was not written out by hand the byte WAS the
// Narkowicz ACES output. That was verified against the HDR scene target - the
// noon ground region read 15,976 nits at 1/78,000, which through
// aces(radiance * exposure * (ao + bloomStrength)) is 98 of 255 and through an
// sRGB encode of the same would be 169, and the frame read 97.7. The encode is
// now there (post.js, COMPOSITE_FRAG), so that same check would land on 169, and
// this inverse has the sRGB decode in front of the tonemap inverse to match.
//
// A FRAME CAPTURED BEFORE THAT CHANGE NEEDS THE OLD INVERSE. acesOnly() below is
// kept exported for exactly that: re-measuring an archived shot with the wrong
// transfer overstates every dark region by about 2.4x, which is the size of the
// defect the change removed.
//
// aces(x) = x(2.51x + 0.03) / (x(2.43x + 0.59) + 0.14), so inverting it is one
// quadratic: (2.43y - 2.51)x^2 + (0.59y - 0.03)x + 0.14y = 0.
function acesInverse(y) {
  const A = 2.43 * y - 2.51, B = 0.59 * y - 0.03, C = 0.14 * y;
  if (Math.abs(A) < 1e-9) return B !== 0 ? -C / B : 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return 0;
  const r1 = (-B + Math.sqrt(disc)) / (2 * A), r2 = (-B - Math.sqrt(disc)) / (2 * A);
  const roots = [r1, r2].filter((v) => v >= 0);
  return roots.length ? Math.min(...roots) : 0;
}
const a2l = new Float64Array(256);      // byte -> ACES input, through the encode
const acesOnlyTable = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  a2l[i] = acesInverse(s2l[i]);
  acesOnlyTable[i] = acesInverse(i / 255);
}
/** Byte from a CURRENT frame -> radiance x exposure (ACES input). */
export const unDisplay = (v) => a2l[v];
/** Byte from a frame captured BEFORE post.js gained its sRGB encode. */
export const acesOnly = (v) => acesOnlyTable[v];
const Ya = (r, g, b) => 0.2126 * a2l[r] + 0.7152 * a2l[g] + 0.0722 * a2l[b];

/** Mean LINEAR luminance over a box given as [x, y, w, h]. */
export function boxLinear(img, [x0, y0, w, h]) {
  const { width, height, channels: c, data } = img;
  let sum = 0, sumA = 0, n = 0, r = 0, g = 0, b = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * c;
      sum += Y(data[i], data[i + 1], data[i + 2]);
      sumA += Ya(data[i], data[i + 1], data[i + 2]);
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  return { linear: sum / n, scene: sumA / n, r: r / n, g: g / n, b: b / n, n };
}

/** Fraction of pixels in a box with R-B > t, i.e. visibly warm. */
export function warmFraction(img, [x0, y0, w, h], t = 10) {
  const { width, height, channels: c, data } = img;
  let warm = 0, n = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * c;
      if (data[i] - data[i + 2] > t) warm++;
      n++;
    }
  }
  return { pct: (warm / n) * 100, n };
}

/** Clipping: pixels with any channel at 255, and the 254 -> 255 histogram step. */
export function clipping(img) {
  const { width, height, channels: c, data } = img;
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  let anyClipped = 0, n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * c;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    hist[0][r]++; hist[1][g]++; hist[2][b]++;
    if (r === 255 || g === 255 || b === 255) anyClipped++;
  }
  // The 254 -> 255 step, against a floor of one pixel in the 254 bin. A true
  // division by zero here is Infinity, JSON.stringify writes that as null, and a
  // null in a metrics artifact reads as "not measured" rather than "the last bin
  // is a cliff with nothing on the step below it".
  const step = (h) => h[255] / Math.max(1, h[254]);
  return {
    clippedPct: (anyClipped / n) * 100,
    r: { at254: hist[0][254], at255: hist[0][255], step: +step(hist[0]).toFixed(2) },
    g: { at254: hist[1][254], at255: hist[1][255], step: +step(hist[1]).toFixed(2) },
    b: { at254: hist[2][254], at255: hist[2][255], step: +step(hist[2]).toFixed(2) },
  };
}

/** Whole-frame mean chroma, 8-bit max-min, and the fraction crushed to Y<=2. */
export function frameStats(img) {
  const { width, height, channels: c, data } = img;
  let chroma = 0, crushed = 0, meanY = 0;
  const n = width * height;
  for (let p = 0; p < n; p++) {
    const i = p * c;
    const r = data[i], g = data[i + 1], b = data[i + 2];
    chroma += Math.max(r, g, b) - Math.min(r, g, b);
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    meanY += y;
    if (y <= 2) crushed++;
  }
  return { chroma: chroma / n, crushedPct: (crushed / n) * 100, meanY8: meanY / n };
}

/**
 * Mean colour and chroma over a band, so a whole-frame number can be split into
 * the parts a critic is actually describing. "Golden is the least colourful
 * daylight state" is a claim about the street; a frame-wide mean mixes that with
 * the sky, which is a third of the picture and has nothing to do with how the
 * light reaches a wall.
 */
export function band(img, [x0, y0, w, h]) {
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, chroma = 0, warm = 0, n = 0, y = 0;
  for (let py = y0; py < Math.min(height, y0 + h); py++) {
    for (let px = x0; px < Math.min(width, x0 + w); px++) {
      const i = (py * width + px) * c;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      r += R; g += G; b += B;
      chroma += Math.max(R, G, B) - Math.min(R, G, B);
      if (R - B > 10) warm++;
      y += 0.2126 * R + 0.7152 * G + 0.0722 * B;
      n++;
    }
  }
  return { r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
    chroma: +(chroma / n).toFixed(2), warmPct: +((warm / n) * 100).toFixed(2),
    meanY: +(y / n).toFixed(1), rMinusB: +((r - b) / n).toFixed(1) };
}

export function report(file, opts = {}) {
  const img = readPNG(file);
  const out = { file, size: `${img.width}x${img.height}`, ...frameStats(img), ...clipping(img) };
  if (opts.pair) {
    const key = boxLinear(img, opts.pair[0]), fill = boxLinear(img, opts.pair[1]);
    out.pair = {
      key: +key.linear.toFixed(5), fill: +fill.linear.toFixed(5),
      key8: [key.r, key.g, key.b].map((v) => +v.toFixed(1)),
      fill8: [fill.r, fill.g, fill.b].map((v) => +v.toFixed(1)),
      // sRGB-decoded, which is the linearisation the round-7 critic used, kept so
      // the numbers are comparable to theirs...
      ratio: +(key.linear / Math.max(fill.linear, 1e-9)).toFixed(3),
      stops: +Math.log2(key.linear / Math.max(fill.linear, 1e-9)).toFixed(2),
      // ...and the renderer's own inverse (sRGB decode, then the ACES inverse),
      // which is the one its output actually needs. The sRGB half is now shared
      // with the photograph path, so the two differ only by the tonemap.
      sceneRatio: +(key.scene / Math.max(fill.scene, 1e-9)).toFixed(3),
      sceneStops: +Math.log2(key.scene / Math.max(fill.scene, 1e-9)).toFixed(2),
    };
  }
  if (opts.ground) out.groundWarmPct = +warmFraction(img, opts.ground).pct.toFixed(2);
  // Fixed bands at 1600x900, scaled for any other capture size: the street
  // surface, the facade band above the parked cars, and the sky.
  const sx = img.width / 1600, sy = img.height / 900;
  const B = (x, y, w, h) => [Math.round(x * sx), Math.round(y * sy), Math.round(w * sx), Math.round(h * sy)];
  out.bands = {
    ground: band(img, B(0, 620, 1600, 280)),
    facade: band(img, B(0, 300, 1600, 260)),
    sky: band(img, B(0, 0, 1600, 200)),
  };
  return out;
}

/**
 * Lamp pools at night, as a ratio rather than as two hand-placed boxes.
 * The brightest 5% of the ground band is "under a lamp" and the median is
 * "away from one". A change that flattens the pools moves the ratio; a change
 * that only moves the overall level does not.
 */
export function lampPools(img, band = [0, 620, 1600, 270]) {
  const { width, height, channels: c, data } = img;
  const vals = [];
  for (let y = band[1]; y < Math.min(height, band[1] + band[3]); y++) {
    for (let x = band[0]; x < Math.min(width, band[0] + band[2]); x++) {
      const i = (y * width + x) * c;
      vals.push(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]);
    }
  }
  vals.sort((a, b) => a - b);
  const n = vals.length;
  const top = vals.slice(Math.floor(n * 0.95));
  const inPool = top.reduce((a, b) => a + b, 0) / top.length;
  const median = vals[n >> 1];
  return { inPool: +inPool.toFixed(1), away: +median.toFixed(1),
    ratio: +(inPool / Math.max(1e-6, median)).toFixed(2) };
}

/**
 * Per-window variety: the spread of luminance among the bright pixels of the
 * facade band. A frame whose lit windows all sit at one value has a small
 * spread however bright it is.
 */
export function windowVariety(img, band = [0, 0, 1600, 520], thresh = 60) {
  const { width, height, channels: c, data } = img;
  const vals = [];
  for (let y = band[1]; y < Math.min(height, band[1] + band[3]); y++) {
    for (let x = band[0]; x < Math.min(width, band[0] + band[2]); x++) {
      const i = (y * width + x) * c;
      const v = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2];
      if (v > thresh) vals.push(v);
    }
  }
  if (vals.length < 50) return { n: vals.length, mean: 0, sd: 0 };
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  return { n: vals.length, mean: +mean.toFixed(1), sd: +sd.toFixed(1) };
}

if (process.argv[1] && process.argv[1].endsWith('critic-metrics.mjs')) {
  const PAIR = [[606, 318, 14, 10], [606, 356, 14, 10]];
  const GROUND = [100, 620, 1000, 270];
  for (const f of process.argv.slice(2)) {
    const isFive = /fivepoints/.test(f);
    const out = report(f, isFive ? { pair: PAIR, ground: GROUND } : {});
    if (/night/.test(f)) {
      const img = readPNG(f);
      out.lampPools = lampPools(img);
      out.windowVariety = windowVariety(img);
    }
    console.log(JSON.stringify(out, null, 1));
  }
}
