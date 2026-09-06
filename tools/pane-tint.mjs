// What COLOUR is the glass, in the photograph and in the frame, measured on the
// same kind of region by the same code?
//
// The open finding this exists for: "engine B/R 1.49-2.07 against a reference of
// 0.67-0.83, pane:wall 0.49 against 0.12". Those are two numbers about two
// different populations of pixels, and nothing in the repo could re-derive
// either. pane-stats.mjs and glaz-probe.mjs measure a RENDER's panes exactly -
// they read the packed roughness/metalness texel the shader itself sampled - and
// a photograph has no such texel. So the reference half needs a detector, and a
// detector is the thing this ledger has been burned by twice.
//
// The three rules it is built to:
//
//   1. LIKE FOR LIKE. Only pixels ABOVE THE HORIZON ROW are measured. For a
//      vertical facade that is exactly "higher than the camera's eye" - a
//      projective fact, not a judgement - so the same physical band of building
//      is compared in both domains, and road, pavement, parked cars and
//      shopfront interiors are out of the sample in both. The horizon row comes
//      from the shared camera model (roofline.mjs CAM), and it is CHECKED
//      against the engine's own world-height pass by --validate.
//
//   2. THE SAME TRANSFER. A screenshot from this renderer is
//      srgb(aces(scene * exposure)) (src/post.js; derived at length in
//      critic-metrics.mjs). A photograph is srgb(scene) with a camera's own
//      curve in it. Ratios of 8-bit values across those two are not comparable,
//      so each is linearised with ITS OWN inverse before any ratio is taken.
//      The engine's inverse gained an sRGB decode in front of the tonemap
//      inverse when post.js gained its encode; before that it was the tonemap
//      inverse alone, and an ARCHIVED engine frame still needs that older one.
//
//   3. AN INSTRUMENT THAT CAN BE WRONG OUT LOUD. --selftest builds synthetic
//      facades whose answers are known and OPPOSITE to each other: a warm-paned
//      wall must read warm and a cool-paned wall must read cool, from the same
//      code, or the detector is inert. It also has to REFUSE a wall with no
//      windows in it rather than return a plausible number, and it has to keep a
//      blue curtain wall that reaches the top of frame OUT of the sky mask -
//      which is the specific failure roofline.mjs documents in its header ("a
//      glass curtain wall reads 88,104,130", i.e. it passes a colour-only sky
//      test). Every one of those cases is a case this detector could fail while
//      still printing numbers that look fine.
//
// And the honest limit, stated up front: this detector selects DARK OPENINGS IN
// A FACADE. Some of them are not glass - a recessed loggia, a dark awning, a
// sign panel. That error is not argued about, it is MEASURED: --validate runs
// this same detector over engine frames that also carry glaz-probe's ground
// truth mask and prints the bias between them. The reference numbers are then
// read with that bias attached.
//
// Usage:
//   node tools/pane-tint.mjs --selftest
//   node tools/pane-tint.mjs --reference                # all reprojected views
//   node tools/pane-tint.mjs --reference --limit 40 --overlays
//   node tools/pane-tint.mjs --engine docs/shots/pano-match --time golden
//   node tools/pane-tint.mjs --validate <glaz-capture-base> ...
//   node tools/pane-tint.mjs --truth <glaz-capture-base> ...   # ground truth only
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';
import { writePNG } from './crop.mjs';

const REF = 'reference/sarasota/mapillary/views';
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ------------------------------------------------------------------ transfer
//
// sRGB EOTF, for a photograph.
const s2l = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const v = i / 255;
  s2l[i] = v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}
// The renderer's inverse: sRGB decode, THEN the Narkowicz ACES inverse, because
// post.js's composite applies them in the opposite order. Same derivation as
// critic-metrics.mjs and glaz-probe.mjs; kept identical on purpose so a number
// measured here is comparable with one measured there.
//
// `acesOnly` is the inverse for a frame captured BEFORE post.js gained its
// encode. It is not dead code: this repo's docs/shots tree spans both, and
// reading an archived engine frame with the current inverse understates its
// darks by the same 2.4x the encode was worth.
function acesInverse(y) {
  const A = 2.43 * y - 2.51, B = 0.59 * y - 0.03, C = 0.14 * y;
  if (Math.abs(A) < 1e-9) return B !== 0 ? -C / B : 0;
  const disc = B * B - 4 * A * C;
  if (disc < 0) return 0;
  const roots = [(-B + Math.sqrt(disc)) / (2 * A), (-B - Math.sqrt(disc)) / (2 * A)].filter((v) => v >= 0);
  return roots.length ? Math.min(...roots) : 0;
}
// And the composite gained a highlight rolloff in front of the fit, so the byte
// is srgb(aces(roll(radiance * exposure))) and the inverse gains roll^-1 at the
// end. Same two constants as src/post.js's params block and critic-metrics.mjs;
// they must not drift, and the self-test at the bottom of this file asserts that
// reading a rolloff-encoded frame with the FLAT inverse gives a different answer,
// so a drift shows up as a failure rather than as a quiet bias.
//
//   roll^-1(y) = y                            y <= K
//   roll^-1(y) = K + S(y-K)/(S - (y-K))       y >  K,   S = C - K
//
// `acesFlat` is the inverse for a frame captured after post.js gained its encode
// and before it gained the rolloff; `acesOnly` for one from before the encode.
// Neither is dead code: this repo's docs/shots tree spans all three.
const ROLL_KNEE = 0.5, ROLL_CEIL = 8.0;
function rollInverse(y) {
  if (!(ROLL_CEIL > ROLL_KNEE) || y <= ROLL_KNEE) return y;
  const S = ROLL_CEIL - ROLL_KNEE, u = y - ROLL_KNEE;
  return u >= S ? Infinity : ROLL_KNEE + (S * u) / (S - u);
}
const a2l = new Float64Array(256), acesOnly = new Float64Array(256), acesFlat = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  acesFlat[i] = acesInverse(s2l[i]);
  a2l[i] = rollInverse(acesFlat[i]);
  acesOnly[i] = acesInverse(i / 255);
}
export const TRANSFER = { srgb: s2l, aces: a2l, acesFlat, acesOnly };
export const ROLLOFF = { knee: ROLL_KNEE, ceil: ROLL_CEIL };
const Y = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

// ------------------------------------------------------------------- camera
// roofline.mjs' CAM, restated rather than imported so this file can be read on
// its own; --selftest asserts the two agree.
const PITCH = 12, HFOV = 75, ASPECT = 4 / 3;
const VFOV = (2 * Math.atan(Math.tan((HFOV * Math.PI) / 360) / ASPECT) * 180) / Math.PI;
/**
 * The row the horizon falls on. A ray leaving row `j` has elevation
 * PITCH + atan((1 - 2(j+0.5)/h) * tan(VFOV/2)); solve that for zero. Above this
 * row every ray points UP, so anything it lands on that is part of a vertical
 * facade stands higher than the camera's eye (2.5 m).
 */
export const horizonRow = (h) => (h / 2) * (1 + Math.tan((PITCH * Math.PI) / 180) / Math.tan((VFOV * Math.PI) / 360)) - 0.5;

// ------------------------------------------------------------------ detector
//
// Tunables in one place so they can be moved and re-tested rather than hunted
// for in the body.
export const D = {
  // Sky. Colour ALONE cannot do this: roofline.mjs' header records that a glass
  // curtain wall reads 88,104,130 and passes a bright-and-blue test. So sky here
  // is a TOP RUN PER COLUMN, not a flood fill and not a colour class: walk down
  // from row 0 while the pixel is bright, blue-leaning and smooth, and stop at
  // the first parapet edge. A wall below a roofline is then unreachable however
  // sky-coloured it is, and a facade that reaches row 0 has no sky in that
  // column at all. Measured on the two domains this has to serve: reference sky
  // runs linear b/r 1.7-3.0 and engine sky 1.37-2.5, against 0.87-0.94 for
  // sunlit stucco, 0.92 for cream precast and 1.19 for the engine's grey wall.
  skyBR: 1.30,              // linear blue/red to START a column's sky run
  skyBRgrow: 1.15,          // ... and to continue it
  skyLuma: 0.55,            // x the 98th percentile luma of the frame
  skyLumaGrow: 0.40,
  // Blown-out sky passes on brightness alone - but ONLY if it is actually blown
  // out. Without the absolute bar this clause eats any frame filled edge to edge
  // with one bright surface, because there p98 IS that surface.
  skyWhite: 0.92,           // x p98 ...
  skyWhite8: 232,           // ... and this many 8-bit levels, absolutely ...
  // ... and not WARM. Sunlit white precast measures 251,249,244 - bright enough
  // for both bars above - and eating it removes the brightest half of a wall,
  // which is the denominator of every ratio here. Blown-out sky clips toward
  // neutral or blue; a warm white surface does not.
  skyWhiteBR: 0.98,
  skyGrad: 14,              // 8-bit luma gradient the run may not cross
  skyMiss: 3,               // consecutive failures that end a column's run
  skyGrow: true,            // then spread sideways from those runs, edge-limited
  skyMinFrac: 0.004,        // a sky component smaller than this is not sky
  // Vegetation: a green excess in linear RGB. Sarasota's oaks are olive rather
  // than emerald, so this is a low bar on purpose. The mask is then CLOSED,
  // because the inside of a canopy is not green - it is dark shadow between lit
  // leaves, and a dark hole surrounded by leaf is exactly what the pane rule
  // below is built to find. Without the close, an oak reads as a wall of glass.
  // The index is g MINUS THE LARGER OF r AND b, relative to the pixel's own
  // brightness. `2g - r - b` was tried first and is wrong in the one direction
  // that matters here: warm glass reflecting a stucco street reads r ~ g >> b
  // and passes it, so every WARM pane in the reference was being thrown away as
  // a leaf - a bias straight into the answer this tool exists to find.
  greenExcess: 0.14,
  vegClose: 6,              // px; dilate then erode, to swallow shadow in canopy
  // Colour cannot find a BACKLIT canopy: an oak against a deep blue winter sky
  // measures greenIdx -0.42, because what comes through the leaves is sky. What
  // separates it from every wall and every pane is fine-scale texture. Measured
  // over both domains: lit canopy runs 0.39-0.67 of its pixels above the
  // gradient bar, a photographed wall 0.16-0.17, a window 0.02-0.19, and the
  // densest engine window grid 0.44. The per-pixel bar is set clear of that grid
  // so a mullioned elevation is not mistaken for a tree.
  texGrad: 18,              // 8-bit luma gradient that counts as "busy"
  texRad: 7,                // px, the window busyness is measured over
  texVeg: 0.55,             // above this fraction of busy pixels: canopy
  maxClutterFrac: 0.30,     // of the region above the horizon: else refuse
  maxVegFrac: 0.34,         // of the region above the horizon: else it is a tree
  maxSkyFrac: 0.80,         // of the region above the horizon: else it is sky
  // Local window the pane/wall split is made in, as a fraction of frame width.
  // A pane is dark AGAINST ITS OWN WALL; a global threshold would call a sunlit
  // wall "wall" and a shaded wall of the same building "glass".
  winFrac: 0.055,
  paneK: 0.55,              // pane if luma < localMean - paneK * localStd ...
  paneRel: 0.86,            // ... and below this fraction of the local mean
  wallK: 0.10,              // wall if luma > localMean + wallK * localStd
  // A window above the horizon in these views is tens of pixels across. The
  // scattered gaps between leaves are not, and they pass the shape rule because
  // a leaf gap is round. This is what separates them.
  paneOpen: 2,              // px; erode-then-dilate, to cut speckle bridges
  minComponent: 200,        // px; smaller dark blobs are noise, not openings
  // Dark things that touch merge into one component - a ribbon window running
  // into the shadowed soffit beside it, say - so this cannot be tight or a whole
  // band of real glazing is thrown away for the company it keeps. The shape rule
  // below is what actually rejects a merged blob: it is ragged, so its fill is low.
  maxComponentFrac: 0.35,   // of the facade region: bigger is a shadow, not a pane
  // An opening is a RECTANGLE. A balcony balustrade, the shadow line under a
  // cornice and the dark edge of an awning are all "darker than the wall beside
  // them" and all read as glass without this - they are long, thin and ragged,
  // and a window is none of those.
  // Aspect alone cannot do it: a RIBBON WINDOW is a legitimate glazing form and
  // is as long and thin as the shadow under a cornice. What separates them is
  // that a ribbon is SOLID and a balustrade is bars - so the rule is fill ratio
  // and a minimum height, with aspect only catching the extreme lines.
  minFill: 0.50,            // component area / its bounding box
  minSide: 8,               // px, the shorter side of the bounding box
  maxAspect: 40,
  minFacadeFrac: 0.06,      // of the frame, above the horizon: else refuse
  minPaneFrac: 0.02,        // of the facade region: else there are no openings
  maxPaneFrac: 0.62,        // of the facade region: else it is not a facade
  minPanePx: 3000,
};

/** Integral image of `src` over `mask`, returning box mean and std. */
function boxStats(src, mask, w, h, rad) {
  const S = new Float64Array((w + 1) * (h + 1));
  const S2 = new Float64Array((w + 1) * (h + 1));
  const N = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, j = (y + 1) * (w + 1) + (x + 1);
      const m = mask[i] ? 1 : 0, v = m ? src[i] : 0;
      S[j] = v + S[j - 1] + S[j - (w + 1)] - S[j - (w + 2)];
      S2[j] = v * v + S2[j - 1] + S2[j - (w + 1)] - S2[j - (w + 2)];
      N[j] = m + N[j - 1] + N[j - (w + 1)] - N[j - (w + 2)];
    }
  }
  const at = (T, x0, y0, x1, y1) => T[y1 * (w + 1) + x1] - T[y0 * (w + 1) + x1] - T[y1 * (w + 1) + x0] + T[y0 * (w + 1) + x0];
  const mean = new Float32Array(w * h), std = new Float32Array(w * h), cnt = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
      const n = at(N, x0, y0, x1, y1);
      const i = y * w + x;
      cnt[i] = n;
      if (n < 8) { mean[i] = 0; std[i] = 0; continue; }
      const m = at(S, x0, y0, x1, y1) / n;
      mean[i] = m;
      std[i] = Math.sqrt(Math.max(0, at(S2, x0, y0, x1, y1) / n - m * m));
    }
  }
  return { mean, std, cnt };
}

/** Morphological close (dilate then erode) or open (erode then dilate). Box-summed. */
function morph(mask, w, h, rad, how) {
  const box = (src) => {
    const S = new Int32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const j = (y + 1) * (w + 1) + (x + 1);
        S[j] = (src[y * w + x] ? 1 : 0) + S[j - 1] + S[j - (w + 1)] - S[j - (w + 2)];
      }
    }
    return (x0, y0, x1, y1) => S[y1 * (w + 1) + x1] - S[y0 * (w + 1) + x1] - S[y1 * (w + 1) + x0] + S[y0 * (w + 1) + x0];
  };
  const pass = (src, want) => {
    const at = box(src);
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1);
        const n = at(x0, y0, x1, y1), area = (x1 - x0) * (y1 - y0);
        out[y * w + x] = want === 'dilate' ? (n > 0 ? 1 : 0) : (n === area ? 1 : 0);
      }
    }
    return out;
  };
  return how === 'close'
    ? pass(pass(mask, 'dilate'), 'erode')
    : pass(pass(mask, 'erode'), 'dilate');
}

/** 4-connected components of a boolean mask, as index lists. */
function components(mask, w, h) {
  const seen = new Uint8Array(w * h);
  const out = [];
  const stack = new Int32Array(w * h);
  for (let s = 0; s < w * h; s++) {
    if (!mask[s] || seen[s]) continue;
    let sp = 0; stack[sp++] = s; seen[s] = 1;
    const px = [];
    while (sp) {
      const p = stack[--sp];
      px.push(p);
      const x = p % w;
      if (x > 0 && mask[p - 1] && !seen[p - 1]) { seen[p - 1] = 1; stack[sp++] = p - 1; }
      if (x < w - 1 && mask[p + 1] && !seen[p + 1]) { seen[p + 1] = 1; stack[sp++] = p + 1; }
      if (p >= w && mask[p - w] && !seen[p - w]) { seen[p - w] = 1; stack[sp++] = p - w; }
      if (p < w * (h - 1) && mask[p + w] && !seen[p + w]) { seen[p + w] = 1; stack[sp++] = p + w; }
    }
    out.push(px);
  }
  return out;
}

/**
 * Classify one image.
 * @returns {{ok:boolean, why:string[], cls:Uint8Array, ...stats}}
 *   cls: 0 unused, 1 pane, 2 wall, 3 sky, 4 vegetation, 5 below horizon
 */
export function detect(img, { transfer = 'srgb', hRow = null } = {}) {
  const { width: w, height: h, channels: ch, data } = img;
  const lut = TRANSFER[transfer];
  if (!lut) throw new Error(`unknown transfer ${transfer}`);
  const n = w * h;
  const lr = new Float32Array(n), lg = new Float32Array(n), lb = new Float32Array(n);
  const l8 = new Float32Array(n), lin = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    lr[i] = lut[r]; lg[i] = lut[g]; lb[i] = lut[b];
    l8[i] = Y(r, g, b);
    lin[i] = Y(lr[i], lg[i], lb[i]);
  }
  const hr = Math.round(hRow ?? horizonRow(h));

  // 98th percentile of 8-bit luma, the frame's own "bright".
  const hist = new Int32Array(256);
  for (let i = 0; i < n; i++) hist[Math.min(255, Math.round(l8[i]))]++;
  let acc = 0, p98 = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.98) { p98 = v; break; } }

  // --- sky: bright, blue-leaning, SMOOTH and CONNECTED TO THE TOP EDGE.
  const grad = new Float32Array(n);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      grad[i] = Math.abs(l8[i + 1] - l8[i - 1]) + Math.abs(l8[i + w] - l8[i - w]);
    }
  }
  const bOverR = (i) => lb[i] / Math.max(1e-6, lr[i]);
  const skyOK = (i, start) => grad[i] < D.skyGrad && (
    (l8[i] > p98 * (start ? D.skyLuma : D.skyLumaGrow) && bOverR(i) > (start ? D.skyBR : D.skyBRgrow))
    || (l8[i] > p98 * D.skyWhite && l8[i] > D.skyWhite8 && lb[i] >= lr[i] * D.skyWhiteBR));
  const sky = new Uint8Array(n);
  for (let x = 0; x < w; x++) {
    if (!skyOK(x, true)) continue;                    // this column starts on built work
    let miss = 0;
    for (let y = 0; y < h; y++) {
      const i = y * w + x;
      if (skyOK(i, false)) { sky[i] = 1; miss = 0; continue; }
      if (++miss >= D.skyMiss) break;                 // a parapet, not a wire
    }
  }
  // The column runs alone cannot reach sky that is BEHIND something: a bare oak
  // over a deep blue winter sky stops every run in its first few rows, and the
  // sky between the branches then reads as a very blue, fairly bright wall. So
  // the runs are grown 4-connected - but only across pixels that are themselves
  // sky-coloured AND smooth, so the growth stops dead at a parapet edge and
  // cannot walk down onto the curtain wall below it.
  if (D.skyGrow) {
    const stack = new Int32Array(n);
    let sp = 0;
    for (let i = 0; i < n; i++) if (sky[i]) stack[sp++] = i;
    while (sp) {
      const q = stack[--sp];
      const x = q % w;
      const push = (t) => { if (!sky[t] && skyOK(t, false)) { sky[t] = 1; stack[sp++] = t; } };
      if (x > 0) push(q - 1);
      if (x < w - 1) push(q + 1);
      if (q >= w) push(q - w);
      if (q < n - w) push(q + w);
    }
  }
  // A sky region that is small is not sky - it is a bright pane, a lit sign or
  // a gap through a tree. With the per-column run above, this is the clause that
  // keeps a blue curtain wall running to the top of frame out of the mask.
  for (const px of components(sky, w, h)) {
    if (px.length >= n * D.skyMinFrac) continue;
    for (const p of px) sky[p] = 0;
  }

  // --- vegetation, and the facade region.
  const busy = new Float32Array(n);
  for (let i = 0; i < n; i++) busy[i] = grad[i] > D.texGrad ? 1 : 0;
  const all1 = new Uint8Array(n).fill(1);
  const tex = boxStats(busy, all1, w, h, D.texRad).mean;
  const vegRaw = new Uint8Array(n);
  let clutter = 0;
  for (let i = 0; i < n; i++) {
    if (sky[i]) continue;
    const m = (lr[i] + lg[i] + lb[i]) / 3;
    const green = m > 1e-6 && (lg[i] - Math.max(lr[i], lb[i])) / m > D.greenExcess;
    const busyHere = tex[i] > D.texVeg;
    if (busyHere) clutter++;
    if (green || busyHere) vegRaw[i] = 1;
  }
  const veg = morph(vegRaw, w, h, D.vegClose, 'close');
  const cls = new Uint8Array(n);
  let facade = 0, above = 0, vegPx = 0, skyPx = 0;
  const inFacade = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const y = (i / w) | 0;
    if (y > hr) { cls[i] = 5; continue; }
    above++;
    if (sky[i]) { cls[i] = 3; skyPx++; continue; }
    if (veg[i]) { cls[i] = 4; vegPx++; continue; }
    inFacade[i] = 1; facade++;
  }
  const why = [];
  if (above > 0 && vegPx > above * D.maxVegFrac) why.push(`${((100 * vegPx) / above).toFixed(0)}% of the view above the horizon is canopy, not facade`);
  if (above > 0 && clutter > above * D.maxClutterFrac) why.push(`${((100 * clutter) / above).toFixed(0)}% of the view above the horizon is canopy-grade clutter`);
  if (above > 0 && skyPx > above * D.maxSkyFrac) why.push(`${((100 * skyPx) / above).toFixed(0)}% of the view above the horizon is sky`);
  if (facade < n * D.minFacadeFrac) why.push(`only ${((100 * facade) / n).toFixed(1)}% of the frame is facade above the horizon`);

  // --- pane vs wall, LOCALLY. A pane is dark against the wall it is set in;
  //     comparing it to the frame's global mean would classify a shaded
  //     elevation as glass and a sunlit one as wall.
  const rad = Math.max(8, Math.round(w * D.winFrac));
  const { mean, std, cnt } = boxStats(lin, inFacade, w, h, rad);
  const paneRaw = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (!inFacade[i] || cnt[i] < 64) continue;
    if (lin[i] < mean[i] - D.paneK * std[i] && lin[i] < mean[i] * D.paneRel) paneRaw[i] = 1;
  }
  // Openings are objects, not speckle: drop tiny components, and drop any
  // component so large it is an unlit elevation rather than a window.
  //
  // The OPEN first, and it is not cosmetic. Palm-frond shadow speckled across a
  // ribbon window bridges the ribbon to everything else dark in the frame, and
  // the merged component is ragged, fails the fill rule and takes the real
  // glazing with it: on one Pineapple Ave view, 62k px were being discarded by
  // shape against 9k kept. Eroding then dilating by 2 px cuts bridges thinner
  // than about 5 px and leaves an opening's interior alone.
  const paneOpen = morph(paneRaw, w, h, D.paneOpen, 'open');
  const pane = new Uint8Array(n);
  let panePx = 0;
  let dropShape = 0;
  for (const px of components(paneOpen, w, h)) {
    if (px.length < D.minComponent || px.length > facade * D.maxComponentFrac) continue;
    let x0 = w, x1 = -1, y0 = h, y1 = -1;
    for (const p of px) {
      const x = p % w, y = (p / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
    const bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (Math.min(bw, bh) < D.minSide
      || Math.max(bw, bh) / Math.min(bw, bh) > D.maxAspect
      || px.length / (bw * bh) < D.minFill) { dropShape += px.length; continue; }
    for (const p of px) pane[p] = 1;
    panePx += px.length;
  }
  // The wall class is the normaliser for every ratio this tool reports, so it
  // must not absorb sky. A column whose top row is a leaf never starts a sky run,
  // and the sky visible through the gaps below it then reads as a very bright,
  // very blue "wall". Those pixels are dropped rather than reclassified: they are
  // bright and blue, which is a description of sky and not of a pane.
  let wallPx = 0, wallSkyDrop = 0;
  for (let i = 0; i < n; i++) {
    if (!inFacade[i] || pane[i]) continue;
    if (cnt[i] < 64 || lin[i] <= mean[i] + D.wallK * std[i]) continue;
    if (lb[i] > lr[i] * D.skyBR && l8[i] > p98 * D.skyLuma) { wallSkyDrop++; continue; }
    cls[i] = 2; wallPx++;
  }
  for (let i = 0; i < n; i++) if (pane[i]) cls[i] = 1;

  if (facade > 0) {
    const pf = panePx / facade;
    if (panePx < D.minPanePx) why.push(`only ${panePx} pane px above the horizon`);
    else if (pf < D.minPaneFrac) why.push(`openings are ${(100 * pf).toFixed(1)}% of the facade region - no windows found`);
    else if (pf > D.maxPaneFrac) why.push(`openings are ${(100 * pf).toFixed(1)}% of the facade region - this is not a facade`);
  }
  if (wallPx < 1000) why.push(`only ${wallPx} wall px above the horizon`);

  const meanOf = (want) => {
    let r = 0, g = 0, b = 0, y = 0, k = 0;
    for (let i = 0; i < n; i++) {
      if (cls[i] !== want) continue;
      r += lr[i]; g += lg[i]; b += lb[i]; y += lin[i]; k++;
    }
    return k ? { n: k, r: r / k, g: g / k, b: b / k, y: y / k } : { n: 0, r: 0, g: 0, b: 0, y: 0 };
  };
  const gl = meanOf(1), wl = meanOf(2);
  const br = (m) => (m.r > 1e-7 ? m.b / m.r : NaN);
  return {
    ok: why.length === 0, why, cls, w, h, hr,
    facadePx: facade, skyPx, vegPx, clutterPx: clutter, abovePx: above, wallSkyDrop, dropShape,
    glass: gl, wall: wl,
    glassBR: br(gl), wallBR: br(wl),
    shift: br(gl) / br(wl),
    paneWall: wl.y > 1e-9 ? gl.y / wl.y : NaN,
  };
}

// ------------------------------------------------- what is the pane reflecting
//
// The two candidate causes of a cobalt pane are not the same fix, and they are
// separable without touching a shader. applyGlazingEnv computes, per pixel,
//
//   radiance = mix( skyRadiance, cityRadiance, geAbove * (1 - geSky) )
//
// and every term in that is reconstructable from what glaz-probe already writes
// out: the world height and the surface normal come from the wy pass, the camera
// from the capture's own metadata, and H, D and the softness constants from
// GLAZING.canyon. So the CITY SHARE of each pane pixel can be measured rather
// than assumed - and "the panes are blue because they are reflecting sky" is a
// claim about that number, testable before anything is edited.
//
// Two approximations, both stated: the shader jitters the normal by +-0.29 deg
// per curtain-wall unit, which is ignored here because it exists to scatter the
// crossover rather than to move it; and the skyline's ragged term is a per-plot
// hash, which is integrated over its uniform range instead of reproduced.
export function canyonConstants(file = 'src/materials.js') {
  const src = fs.readFileSync(file, 'utf8');
  const block = src.slice(src.indexOf('canyon: {'));
  const num = (k) => {
    const m = block.match(new RegExp(`${k}:\\s*(-?[0-9.]+)`));
    if (!m) throw new Error(`GLAZING.canyon.${k} not found in ${file}`);
    return Number(m[1]);
  };
  const arr = (k) => {
    const m = block.match(new RegExp(`${k}:\\s*\\[([^\\]]+)\\]`));
    if (!m) throw new Error(`GLAZING.canyon.${k} not found in ${file}`);
    return m[1].split(',').map((v) => Number(v.trim()));
  };
  return {
    // The canyon's opposite height is a measured PAIR interpolated on the pane's
    // own height (src/materials.js GLAZING.canyon has the scan). Reproduced here
    // rather than approximated, because this file's whole purpose is to evaluate
    // the shader's formula offline and a tool that quietly uses a different
    // skyline is worse than no tool.
    oppositeLowH: num('oppositeLowH'), oppositeTallH: num('oppositeTallH'),
    oppositeLowY: num('oppositeLowY'), oppositeTallY: num('oppositeTallY'),
    oppositeDistance: num('oppositeDistance'),
    skylineSoft: num('skylineSoft'), skylineRagged: num('skylineRagged'),
    urbanAlbedo: arr('urbanAlbedo'),
  };
}

/**
 * Per-pixel city share of the reflected radiance, AND the sun's share of that
 * city term - the shader's own formulae, evaluated offline.
 *
 * The second one exists because a term that never fires is indistinguishable
 * from a term that fires and does nothing, and this ledger has shipped that
 * mistake twice. applyGlazingEnv's sun contribution is
 * `max(0, dot(sunW, -geN)) * geLit`; if that is zero over every pane in a frame
 * then the frame says NOTHING about whether the sun term works, however its
 * numbers moved. Reported per capture so a null result can be read correctly.
 */
export function cityShare(cap, cls, height, azim, normY, C = canyonConstants()) {
  const { w, h, meta } = cap;
  const Cm = meta.cam.cam, T = meta.cam.target;
  const nrm = (v) => { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; };
  const F = nrm([T[0] - Cm[0], T[1] - Cm[1], T[2] - Cm[2]]);
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const R0 = nrm(cross(F, [0, 1, 0]));
  const U = cross(R0, F);
  const tanHalf = Math.tan((meta.cam.fov * Math.PI) / 180 / 2);
  const aspect = w / h;
  const smooth = (e0, e1, x) => { const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
  const out = new Float32Array(w * h).fill(NaN);
  const sun = new Float32Array(w * h).fill(NaN);
  // The sun as the frame itself recorded it. NOT normalize(position): daynight.js'
  // follow() moves the light AND its target with the viewer, so the direction is
  // position MINUS the point it is aimed at, and at a station 360 m from the world
  // origin those two differ by 70 degrees. Taking the shortcut said the sun term
  // was firing on a wall where the shader correctly leaves it alone, and would
  // have had this fix recorded as broken when it is not.
  const sp = cap.meta.sun?.pos;
  const S = sp ? (() => {
    const d = [sp[0] - Cm[0], sp[1] - Cm[1], sp[2] - Cm[2]];
    const l = Math.hypot(...d);
    return [d[0] / l, d[1] / l, d[2] / l];
  })() : null;
  const tanSun = S ? S[1] / Math.max(Math.hypot(S[0], S[2]), 1e-4) : 0;
  const RAG = 9;
  for (let y = 0; y < h; y++) {
    const ndcY = 1 - ((y + 0.5) / h) * 2;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (cls[i] !== 1) continue;
      const ndcX = ((x + 0.5) / w) * 2 - 1;
      const d = nrm([
        F[0] + R0[0] * ndcX * tanHalf * aspect + U[0] * ndcY * tanHalf,
        F[1] + R0[1] * ndcX * tanHalf * aspect + U[1] * ndcY * tanHalf,
        F[2] + R0[2] * ndcX * tanHalf * aspect + U[2] * ndcY * tanHalf,
      ]);
      const ny = normY[i], hxz = Math.sqrt(Math.max(0, 1 - ny * ny));
      const N = [Math.cos(azim[i]) * hxz, ny, Math.sin(azim[i]) * hxz];
      const dn = d[0] * N[0] + d[1] * N[1] + d[2] * N[2];
      const rx = d[0] - 2 * dn * N[0], ry = d[1] - 2 * dn * N[1], rz = d[2] - 2 * dn * N[2];
      const tanR = ry / Math.max(Math.hypot(rx, rz), 1e-4);
      const above = smooth(-0.02, 0.08, tanR);
      const oppH = C.oppositeLowH + (C.oppositeTallH - C.oppositeLowH)
        * smooth(C.oppositeLowY, C.oppositeTallY, height[i]);
      let acc = 0;
      for (let k = 0; k < RAG; k++) {
        const rag = ((k + 0.5) / RAG - 0.5) * C.skylineRagged;
        const tanSky = (oppH - height[i]) / C.oppositeDistance + rag;
        acc += 1 - smooth(-C.skylineSoft, C.skylineSoft, tanR - tanSky);
      }
      out[i] = above * (acc / RAG);
      if (S) {
        const facing = Math.max(0, S[0] * -N[0] + S[1] * -N[1] + S[2] * -N[2]);
        const hitY = height[i] + C.oppositeDistance * tanR;
        const lit = smooth(-1.5, 1.5, hitY - (oppH - C.oppositeDistance * tanSun));
        sun[i] = facing * lit;
      }
    }
  }
  out.sun = sun;
  return out;
}

// -------------------------------------------------------------- ground truth
//
// The same statistics from glaz-probe's masks - the packed roughness/metalness
// texel the shader itself sampled - restricted to the SAME above-horizon rows,
// so a ground-truth number and a detector number are about the same band.
export async function truth(base) {
  const gp = await import('./glaz-probe.mjs');
  const cap = gp.loadCapture(base);
  const { cls: gcls, height, azim, normY } = gp.classify(cap);
  const share = cityShare(cap, gcls, height, azim, normY);
  const { w, h, png } = cap;
  const ch = png.channels;
  const hr = Math.round(horizonRow(h));
  const acc = () => ({ n: 0, r: 0, g: 0, b: 0, y: 0 });
  const out = { glass: acc(), wall: acc(), glassAll: acc(), wallAll: acc(), minH: Infinity, maxH: -Infinity };
  let shareSum = 0, shareN = 0, shareLo = 0, sunSum = 0, sunHit = 0;
  for (let i = 0; i < w * h; i++) {
    if (!gcls[i]) continue;
    const r = a2l[png.data[i * ch]], g = a2l[png.data[i * ch + 1]], b = a2l[png.data[i * ch + 2]];
    const y = (i / w) | 0;
    const A = gcls[i] === 1 ? out.glassAll : out.wallAll;
    A.n++; A.r += r; A.g += g; A.b += b; A.y += Y(r, g, b);
    if (y > hr) continue;
    const T = gcls[i] === 1 ? out.glass : out.wall;
    T.n++; T.r += r; T.g += g; T.b += b; T.y += Y(r, g, b);
    if (height[i] < out.minH) out.minH = height[i];
    if (height[i] > out.maxH) out.maxH = height[i];
    if (gcls[i] === 1 && Number.isFinite(share[i])) {
      shareSum += share[i]; shareN++;
      if (share[i] < 0.5) shareLo++;
      const sv = share.sun ? share.sun[i] : NaN;
      if (Number.isFinite(sv)) { sunSum += sv; if (sv > 0.02) sunHit++; }
    }
  }
  for (const k of ['glass', 'wall', 'glassAll', 'wallAll']) {
    const A = out[k];
    if (A.n) { A.r /= A.n; A.g /= A.n; A.b /= A.n; A.y /= A.n; }
  }
  const br = (m) => (m.r > 1e-9 ? m.b / m.r : NaN);
  out.glassBR = br(out.glass); out.wallBR = br(out.wall);
  out.shift = out.glassBR / out.wallBR;
  out.paneWall = out.wall.y > 1e-12 ? out.glass.y / out.wall.y : NaN;
  out.cityShare = shareN ? shareSum / shareN : NaN;
  out.skyDominatedFrac = shareN ? shareLo / shareN : NaN;
  out.sunOnOpposite = shareN ? sunSum / shareN : NaN;
  out.sunHitFrac = shareN ? sunHit / shareN : NaN;
  out.hr = hr; out.w = w; out.h = h; out.cap = cap; out.gcls = gcls; out.height = height;
  return out;
}

// ------------------------------------------------------------------ overlay
const OV = { 1: [255, 60, 40], 2: [40, 200, 90], 3: [60, 120, 255], 4: [230, 200, 40], 5: [0, 0, 0] };
export function overlay(img, cls, out) {
  const { width: w, height: h, channels: ch, data } = img;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const k = cls[i], c = OV[k];
    let r = data[i * ch], g = data[i * ch + 1], b = data[i * ch + 2];
    if (k === 5 || k === 0) { r = (r * 0.3) | 0; g = (g * 0.3) | 0; b = (b * 0.3) | 0; }
    else {
      r = Math.min(255, (r * 0.5 + c[0] * 0.35) | 0);
      g = Math.min(255, (g * 0.5 + c[1] * 0.35) | 0);
      b = Math.min(255, (b * 0.5 + c[2] * 0.35) | 0);
    }
    rgb[i * 3] = r; rgb[i * 3 + 1] = g; rgb[i * 3 + 2] = b;
  }
  writePNG(out, w, h, rgb);
  return out;
}

// ----------------------------------------------------------------- aggregate
const median = (a) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? (s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
const quant = (a, q) => {
  const s = a.filter(Number.isFinite).sort((x, y) => x - y);
  return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : NaN;
};
export function summarise(rows, label) {
  const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : 'n/a');
  const br = rows.map((r) => r.glassBR), wb = rows.map((r) => r.wallBR);
  const sh = rows.map((r) => r.shift), pw = rows.map((r) => r.paneWall);
  return {
    label, frames: rows.length,
    glassBR: { p25: quant(br, 0.25), med: median(br), p75: quant(br, 0.75) },
    wallBR: { p25: quant(wb, 0.25), med: median(wb), p75: quant(wb, 0.75) },
    shift: { p25: quant(sh, 0.25), med: median(sh), p75: quant(sh, 0.75) },
    paneWall: { p25: quant(pw, 0.25), med: median(pw), p75: quant(pw, 0.75) },
    text: `${label.padEnd(30)} n=${String(rows.length).padStart(3)}  `
      + `glass B/R ${f(quant(br, 0.25))}-${f(quant(br, 0.75))} med ${f(median(br))}  `
      + `wall B/R med ${f(median(wb))}  `
      + `shift ${f(quant(sh, 0.25))}-${f(quant(sh, 0.75))} med ${f(median(sh))}  `
      + `pane:wall ${f(quant(pw, 0.25))}-${f(quant(pw, 0.75))} med ${f(median(pw))}`,
  };
}

// ------------------------------------------------------------------ selftest
//
// Every case here is one this detector could fail while still printing numbers
// that look reasonable. Two of them must come out OPPOSITE to each other from
// the same code, which is what an inert detector cannot do.
function synth(w, h, fn) {
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * w + x) * 3;
      data[i] = Math.max(0, Math.min(255, Math.round(r)));
      data[i + 1] = Math.max(0, Math.min(255, Math.round(g)));
      data[i + 2] = Math.max(0, Math.min(255, Math.round(b)));
    }
  }
  return { width: w, height: h, channels: 3, data };
}
const enc = (v) => 255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
/** A facade: `wallLin` grey with a grid of panes at `paneLin` scaled by a tint. */
function facade(w, h, wallLin, paneLin, opts = {}) {
  const { pw = 26, ph = 30, gap = 22, top = 0, bottom = h, skyRows = 0, roadRows = 0,
    skyLin = [0.55, 0.72, 1.0], roadLin = [0.20, 0.17, 0.14] } = opts;
  return synth(w, h, (x, y) => {
    if (y < skyRows) return skyLin.map((v) => enc(v * (1 + 0.05 * Math.sin(x / 40))));
    if (y >= h - roadRows) return roadLin.map(enc);
    if (y < top || y >= bottom) return wallLin.map(enc);
    const cx = (x % (pw + gap)) < pw, cy = ((y - top) % (ph + gap + 8)) < ph;
    return (cx && cy ? paneLin : wallLin).map(enc);
  });
}
function selftest() {
  let pass = 0, fail = 0;
  const ok = (m) => { pass++; console.log(`  PASS  ${m}`); };
  const no = (m) => { fail++; console.log(`  FAIL  ${m}`); };
  const f = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : 'n/a');

  // 0. the camera scale this whole comparison is denominated in.
  const hr = horizonRow(960);
  if (Math.abs(hr - 657.2) < 1.5) ok(`horizon row on a 960-line frame is ${hr.toFixed(1)} (roofline.mjs' camera)`);
  else no(`horizon row ${hr.toFixed(1)} is not where the shared camera model puts it`);

  // 1/2. THE OPPOSITE-READING PAIR. Same wall, same geometry, same code; the
  //      panes differ only in tint, and the readings must follow them.
  const wall = [0.30, 0.31, 0.33];                       // B/R 1.100
  const warmPane = [0.060, 0.050, 0.042];                // B/R 0.700
  const coolPane = [0.042, 0.055, 0.080];                // B/R 1.905
  const W = 1280, H = 960, TOP = 40, BOT = 620;
  const rw = detect(facade(W, H, wall, warmPane, { top: TOP, bottom: BOT }), { transfer: 'srgb' });
  const rc = detect(facade(W, H, wall, coolPane, { top: TOP, bottom: BOT }), { transfer: 'srgb' });
  if (!rw.ok) no(`warm-paned facade refused: ${rw.why.join('; ')}`);
  else if (Math.abs(rw.glassBR - 0.700) < 0.06) ok(`warm panes read B/R ${f(rw.glassBR)} against a built 0.700`);
  else no(`warm panes read B/R ${f(rw.glassBR)}, built 0.700`);
  if (!rc.ok) no(`cool-paned facade refused: ${rc.why.join('; ')}`);
  else if (Math.abs(rc.glassBR - 1.905) < 0.16) ok(`cool panes read B/R ${f(rc.glassBR)} against a built 1.905`);
  else no(`cool panes read B/R ${f(rc.glassBR)}, built 1.905`);
  if (rw.ok && rc.ok && rc.glassBR / rw.glassBR > 2.2) {
    ok(`the two arms are ${f(rc.glassBR / rw.glassBR, 2)}x apart - this detector is not inert`);
  } else no('the warm and cool arms did not separate: the detector may be measuring something else');
  // The wall must NOT move between the arms - if it does, the split is leaking.
  if (rw.ok && rc.ok && Math.abs(rw.wallBR - rc.wallBR) < 0.02) ok(`wall B/R is ${f(rw.wallBR)} in both arms (built 1.100)`);
  else no(`wall B/R moved ${f(rw.wallBR)} -> ${f(rc.wallBR)} when only the panes changed`);
  // pane:wall luminance, which is the other half of the finding.
  const builtPW = Y(...warmPane) / Y(...wall);
  if (rw.ok && Math.abs(rw.paneWall / builtPW - 1) < 0.22) ok(`pane:wall reads ${f(rw.paneWall)} against a built ${f(builtPW)}`);
  else no(`pane:wall reads ${f(rw.paneWall)}, built ${f(builtPW)}`);

  // 3. THE FLAT FIELD. A wall with no windows must be refused, not scored. This
  //    is the case that matters: a detector that returns a number here looks
  //    exactly like a working one.
  const flat = detect(synth(W, H, (x, y) => wall.map((v) => enc(v * (1 + 0.02 * Math.sin(x / 30 + y / 50))))), { transfer: 'srgb' });
  if (!flat.ok) ok(`a windowless wall is refused (${flat.why[0]})`);
  else no(`a windowless wall was scored: glass B/R ${f(flat.glassBR)} over ${flat.glass.n} px that are not there`);

  // 4. THE SKY TRAP. roofline.mjs' documented failure: a blue curtain wall passes
  //    a colour-only sky test. Here the cool-paned facade runs to row 0 with no
  //    sky at all, and its panes must survive.
  const noSky = detect(facade(W, H, wall, coolPane, { top: 0, bottom: BOT }), { transfer: 'srgb' });
  if (noSky.ok && Math.abs(noSky.glassBR - 1.905) < 0.2 && noSky.skyPx < W * H * 0.02) {
    ok(`a blue curtain wall running to the top of frame keeps its panes (B/R ${f(noSky.glassBR)}, sky ${noSky.skyPx} px)`);
  } else no(`blue curtain wall to top of frame: ok=${noSky.ok} B/R ${f(noSky.glassBR)} sky ${noSky.skyPx} px`);

  // 4b. THE LEAK THE GROWTH STEP COULD OPEN. Sky directly above a blue curtain
  //     wall, parted only by a parapet: the sky must be found and the panes under
  //     it must survive. If the growth walks over the parapet the glass is eaten
  //     and the frame reads warm for no reason at all.
  const parapet = synth(W, H, (x, y) => {
    if (y < 190) return [0.55, 0.72, 1.0].map((v) => enc(v * (1 + 0.05 * Math.sin(x / 40))));
    if (y < 205) return [0.42, 0.40, 0.38].map(enc);          // the parapet itself
    const cx = (x % 48) < 26, cy = ((y - 205) % 68) < 30;
    return (cx && cy ? coolPane : wall).map(enc);
  });
  const rp = detect(parapet, { transfer: 'srgb' });
  if (rp.ok && rp.skyPx > W * 170 && Math.abs(rp.glassBR - 1.905) < 0.2) {
    ok(`sky over a parapet is found (${rp.skyPx} px) and the blue panes below it survive at B/R ${f(rp.glassBR)}`);
  } else no(`parapet case: ok=${rp.ok} sky ${rp.skyPx} px glass B/R ${f(rp.glassBR)} - ${rp.why.join('; ')}`);

  // 5. SKY IS STILL REMOVED when it really is sky, and does not join the wall.
  const withSky = detect(facade(W, H, wall, coolPane, { top: 300, bottom: BOT, skyRows: 280 }), { transfer: 'srgb' });
  if (withSky.ok && withSky.skyPx > W * 240 && Math.abs(withSky.wallBR - 1.100) < 0.05) {
    ok(`real sky is removed (${withSky.skyPx} px) and the wall stays at B/R ${f(withSky.wallBR)}`);
  } else no(`sky handling: sky ${withSky.skyPx} px, wall B/R ${f(withSky.wallBR)}`);

  // 6. THE HORIZON CUT. A warm road below the horizon must not reach a cool
  //    reading above it. Without the cut the road's 0.7 would drag the glass.
  const withRoad = detect(facade(W, H, wall, coolPane, { top: 60, bottom: 620, roadRows: 300 }), { transfer: 'srgb' });
  if (withRoad.ok && Math.abs(withRoad.glassBR - 1.905) < 0.2) ok(`a warm road below the horizon does not reach the glass (B/R ${f(withRoad.glassBR)})`);
  else no(`road contaminated the glass: B/R ${f(withRoad.glassBR)}`);

  // 6b. THE VEGETATION TRAP, in the direction that would fake the answer. Warm
  //     glass reflecting a stucco street is yellow, and a green index built as
  //     2g - r - b calls yellow a leaf. If that happens the warm panes vanish
  //     from the sample and the reference reads bluer than it is - a bias
  //     pointing straight at the finding this tool was written for.
  const yellowPane = [0.075, 0.070, 0.028];              // B/R 0.373, r ~ g >> b
  const ry = detect(facade(W, H, wall, yellowPane, { top: TOP, bottom: BOT }), { transfer: 'srgb' });
  if (ry.ok && Math.abs(ry.glassBR - 0.373) < 0.05) ok(`yellow-warm panes survive the vegetation test and read B/R ${f(ry.glassBR)} (built 0.373)`);
  else no(`yellow-warm panes: ok=${ry.ok} B/R ${f(ry.glassBR)} - ${ry.why.join('; ')}`);
  // ...and real foliage still IS removed, or the test above is vacuous.
  const leaf = [0.055, 0.090, 0.035];
  const rl = detect(facade(W, H, wall, leaf, { top: TOP, bottom: BOT }), { transfer: 'srgb' });
  if (!rl.ok) ok(`a wall of foliage-coloured openings is refused instead (${rl.why[0]})`);
  else no(`foliage-coloured openings were measured as glass: B/R ${f(rl.glassBR)} over ${rl.glass.n} px`);

  // 6c. STRUCTURE THAT IS NOT A WINDOW. Balustrades, cornice shadows and awning
  //     edges are all darker than the wall beside them. They are long, thin and
  //     ragged; a window is a rectangle. A detector without the shape rule scores
  //     them and calls the answer glass.
  const bars = synth(W, H, (x, y) => {
    const band = y > 120 && y < 150 && (x % 9) < 5;       // balustrade
    const line = y > 300 && y < 306;                      // cornice shadow
    return (band || line ? [0.05, 0.05, 0.09] : wall).map(enc);
  });
  const rb = detect(bars, { transfer: 'srgb' });
  if (!rb.ok) ok(`a facade of railings and shadow lines is refused, not scored (${rb.why[0]})`);
  else no(`railings and shadow lines were measured as glass: B/R ${f(rb.glassBR)} over ${rb.glass.n} px`);

  // 7. THE TRANSFER. The same scene encoded for this renderer must linearise to
  //    the same ratios - if the wrong inverse is applied the answer moves.
  //
  //    The synthetic frame is built with the renderer's WHOLE output chain,
  //    aces() then the sRGB encode, because that is what post.js now writes. The
  //    third arm is the point of this test after that change: reading such a
  //    frame with the OLD engine inverse (the tonemap inverse alone, still
  //    exported as TRANSFER.acesOnly for archived shots) has to give a different
  //    answer, or the encode is not actually in the chain and this whole round
  //    was a no-op.
  const acesOnlyEnc = (v) => { const x = v; const y2 = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14); return 255 * Math.max(0, Math.min(1, y2)); };
  const srgbEnc = (v) => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
  const engineEnc = (v) => srgbEnc(acesOnlyEnc(v) / 255);
  const acesImg = synth(W, H, (x, y) => {
    const inPane = y >= TOP && y < BOT && (x % 48) < 26 && ((y - TOP) % 60) < 30;
    return (inPane ? warmPane : wall).map(engineEnc);
  });
  const ra = detect(acesImg, { transfer: 'aces' });
  if (ra.ok && Math.abs(ra.glassBR - 0.700) < 0.06) ok(`a frame encoded the way post.js encodes linearises to B/R ${f(ra.glassBR)} with the renderer's own inverse`);
  else no(`engine-transfer arm: ok=${ra.ok} B/R ${f(ra.glassBR)} (${ra.why.join('; ')})`);
  const rWrong = detect(acesImg, { transfer: 'srgb' });
  if (rWrong.ok && Math.abs(rWrong.glassBR - 0.700) > 0.06) ok(`and reading it with the sRGB inverse gives ${f(rWrong.glassBR)} instead - the transfer choice is load-bearing`);
  else no(`the two transfers agree (${f(ra.glassBR)} vs ${f(rWrong.glassBR)}); one of them is not being applied`);
  const rOld = detect(acesImg, { transfer: 'acesOnly' });
  if (rOld.ok && Math.abs(rOld.glassBR - 0.700) > 0.06) ok(`and with the PRE-encode engine inverse ${f(rOld.glassBR)} - the sRGB encode is in the chain`);
  else no(`the pre-encode inverse agrees (${f(rOld.glassBR)}); post.js's sRGB encode is not being applied`);

  // 7b. THE HIGHLIGHT ROLLOFF, isolated. The panes above sit at 0.04-0.08 in
  //     ACES input and the wall at 0.30, all under the rolloff's 0.5 knee, so
  //     arms 7 and 7a would pass identically whether the rolloff were in this
  //     file's inverse or not. This arm puts a value ABOVE the knee through the
  //     whole current chain and asks the two inverses to disagree - which is the
  //     only way a drift between these constants and src/post.js's shows up as a
  //     failure rather than as a quiet bias on every bright pane in the set.
  const roll = (x) => { const S = ROLLOFF.ceil - ROLLOFF.knee, t = Math.max(0, x - ROLLOFF.knee);
    return Math.min(x, ROLLOFF.knee) + (S * t) / (S + t); };
  const chainByte = (x) => Math.round(srgbEnc(acesOnlyEnc(roll(x)) / 255));
  let rollOk = true, rollWhy = [];
  for (const x of [0.20, 0.45, 1.0, 2.5, 4.0]) {
    const b = Math.min(255, chainByte(x));
    const back = TRANSFER.aces[b], flat = TRANSFER.acesFlat[b];
    const err = Math.abs(Math.log2(back / x));
    if (!(err < 0.35)) { rollOk = false; rollWhy.push(`x=${x} -> byte ${b} -> ${f(back)} (${f(err, 2)} stops out)`); }
    // The curve is C1-continuous at the knee, so just above it the two inverses
    // differ only in the second order - 0.05 stops at x = 1. They have to part
    // company where it actually bites, and stay identical below the knee.
    const gap = Math.abs(Math.log2(back / flat));
    if (x >= 2.0 && !(gap > 0.25)) { rollOk = false; rollWhy.push(`x=${x}: rolloff inverse agrees with the flat one (${f(back)} vs ${f(flat)}, ${f(gap, 2)} stops)`); }
    if (x < ROLLOFF.knee && gap > 0.02) { rollOk = false; rollWhy.push(`x=${x}: below the knee the two inverses must agree (${f(back)} vs ${f(flat)})`); }
  }
  if (rollOk) ok(`the highlight rolloff round-trips: 0.20/0.45/1.0/2.5/4.0 in ACES input come back within 0.35 stops, the pre-rolloff inverse is over a quarter-stop out by x=2 and identical below the ${ROLLOFF.knee} knee`);
  else no(`highlight rolloff round-trip: ${rollWhy.join('; ')}`);

  console.log(`\nselftest: ${pass} passed, ${fail} failed`);
  return fail === 0;
}

// ---------------------------------------------------------------------- CLI
const f3 = (v, n = 3) => (Number.isFinite(v) ? v.toFixed(n) : 'n/a');

function runSet(files, transfer, label, { overlays = null, limit = 0 } = {}) {
  const rows = [], refused = [];
  const list = limit ? files.slice(0, limit) : files;
  for (const file of list) {
    let img;
    try { img = readPNG(file); } catch (e) { refused.push([file, e.message]); continue; }
    const r = detect(img, { transfer });
    const name = path.basename(file, '.png');
    if (overlays) overlay(img, r.cls, path.join(overlays, `${name}.mask.png`));
    if (!r.ok) { refused.push([name, r.why.join('; ')]); continue; }
    rows.push({ name, glassBR: r.glassBR, wallBR: r.wallBR, shift: r.shift, paneWall: r.paneWall,
      panePx: r.glass.n, wallPx: r.wall.n, facadePx: r.facadePx,
      glass: [r.glass.r, r.glass.g, r.glass.b], wall: [r.wall.r, r.wall.g, r.wall.b] });
  }
  const s = summarise(rows, label);
  return { summary: s, rows, refused };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (has('selftest')) {
    process.exit(selftest() ? 0 : 1);
  } else if (has('reference')) {
    const overlays = has('overlays') ? (arg('out', 'docs/shots/pane-tint/ref')) : null;
    if (overlays) fs.mkdirSync(overlays, { recursive: true });
    const files = fs.readdirSync(REF).filter((f) => f.endsWith('.png')).sort().map((f) => path.join(REF, f));
    const { summary, rows, refused } = runSet(files, 'srgb', 'REFERENCE (photograph)', { overlays, limit: Number(arg('limit', 0)) });
    console.log(summary.text);
    console.log(`  refused ${refused.length} of ${refused.length + rows.length}`);
    const tag = arg('tag', 'ref');
    fs.mkdirSync('docs/measurements', { recursive: true });
    fs.writeFileSync(`docs/measurements/pane-tint-${tag}.json`, JSON.stringify({ summary, rows, refused }, null, 1));
    console.log(`  docs/measurements/pane-tint-${tag}.json`);
  } else if (has('engine')) {
    const dir = arg('engine', 'docs/shots/pano-match');
    const time = arg('time', null);
    const overlays = has('overlays') ? (arg('out', 'docs/shots/pane-tint/eng')) : null;
    if (overlays) fs.mkdirSync(overlays, { recursive: true });
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.png') && (!time || f.includes(`-${time}.`)))
      .sort().map((f) => path.join(dir, f));
    // 'aces' is the CURRENT renderer's inverse (sRGB decode then the tonemap
    // inverse). --transfer acesOnly reads a frame captured before src/post.js
    // gained its sRGB encode on 2026-09-05; getting that wrong understates the
    // darks by about 2.4x, which is larger than any glass tint this measures.
    const engTransfer = arg('transfer', 'aces');
    const { summary, rows, refused } = runSet(files, engTransfer, `ENGINE ${time ?? ''}`.trim(), { overlays, limit: Number(arg('limit', 0)) });
    console.log(summary.text);
    console.log(`  refused ${refused.length} of ${refused.length + rows.length}`);
    for (const [n, w] of refused) console.log(`    - ${n}: ${w}`);
    const tag = arg('tag', `eng-${time ?? 'all'}`);
    fs.mkdirSync('docs/measurements', { recursive: true });
    fs.writeFileSync(`docs/measurements/pane-tint-${tag}.json`, JSON.stringify({ summary, rows, refused }, null, 1));
    console.log(`  docs/measurements/pane-tint-${tag}.json`);
  } else if (has('truth') || has('validate')) {
    // Positional args are capture bases. A value that belongs to a preceding
    // value-taking flag is not one, or `--tag smoke` is read as a capture called
    // "smoke" and the tool dies on a file nobody asked for.
    const VALUE_FLAGS = new Set(['tag', 'out', 'limit', 'time', 'engine']);
    const argv = process.argv.slice(2);
    const bases = argv.filter((a, i) => !a.startsWith('--')
      && !(i > 0 && argv[i - 1].startsWith('--') && VALUE_FLAGS.has(argv[i - 1].slice(2))));
    const both = has('validate');
    const T = [], L = [];
    for (const base of bases) {
      const t = await truth(base);
      const name = path.basename(base);
      console.log(`${name}`);
      console.log(`  TRUTH   glass ${String(t.glass.n).padStart(7)} px  B/R ${f3(t.glassBR)}   `
        + `wall ${String(t.wall.n).padStart(7)} px  B/R ${f3(t.wallBR)}   `
        + `shift ${f3(t.shift)}   pane:wall ${f3(t.paneWall)}   world y ${f3(t.minH, 1)}-${f3(t.maxH, 1)} m`);
      const env = (t.cap.meta.envProfile ?? []).filter((e) => e.el >= 0 && e.el <= 30 && e.br !== undefined);
      const irr = (t.cap.meta.irrProfile ?? []).filter((e) => e.el >= 0 && e.el <= 30 && e.br !== undefined);
      const mn = (a) => (a.length ? a.reduce((x, e) => x + e.br, 0) / a.length : NaN);
      console.log(`  CANYON  city share of the reflection ${f3(t.cityShare)}   `
        + `${(100 * t.skyDominatedFrac).toFixed(0)}% of pane px are sky-dominated   `
        + `env B/R 0-30 deg ${f3(mn(env))}   sky irradiance B/R ${f3(mn(irr))}`);
      console.log(`  SUN     on the wall opposite: mean cos*lit ${f3(t.sunOnOpposite)}   `
        + `${(100 * t.sunHitFrac).toFixed(0)}% of pane px see a sunlit wall opposite`
        + (t.sunHitFrac < 0.02 ? '   <-- the sun term cannot move this frame either way' : ''));
      T.push({ name, glassBR: t.glassBR, wallBR: t.wallBR, shift: t.shift, paneWall: t.paneWall,
        cityShare: t.cityShare, skyDominatedFrac: t.skyDominatedFrac,
        envBR: t.cap.meta.envProfile, irrBR: t.cap.meta.irrProfile,
        panePx: t.glass.n, wallPx: t.wall.n, glass: [t.glass.r, t.glass.g, t.glass.b], wall: [t.wall.r, t.wall.g, t.wall.b] });
      if (!both) continue;
      const img = readPNG(`${base}.png`);
      const d = detect(img, { transfer: 'aces' });
      if (!d.ok) { console.log(`  DETECT  refused: ${d.why.join('; ')}`); continue; }
      console.log(`  DETECT  glass ${String(d.glass.n).padStart(7)} px  B/R ${f3(d.glassBR)}   `
        + `wall ${String(d.wall.n).padStart(7)} px  B/R ${f3(d.wallBR)}   `
        + `shift ${f3(d.shift)}   pane:wall ${f3(d.paneWall)}`);
      console.log(`  BIAS    glass B/R x${f3(d.glassBR / t.glassBR)}   shift x${f3(d.shift / t.shift)}   pane:wall x${f3(d.paneWall / t.paneWall)}`);
      L.push({ name, glassBR: d.glassBR, wallBR: d.wallBR, shift: d.shift, paneWall: d.paneWall, panePx: d.glass.n, wallPx: d.wall.n });
      if (has('overlays')) {
        const out = arg('out', 'docs/shots/pane-tint/val');
        fs.mkdirSync(out, { recursive: true });
        overlay(img, d.cls, path.join(out, `${path.basename(base)}.detect.png`));
      }
    }
    const st = summarise(T, 'GROUND TRUTH');
    console.log(`\n${st.text}`);
    let out = { truth: st, truthRows: T };
    if (both && L.length) {
      const sl = summarise(L, 'DETECTOR on the same frames');
      console.log(sl.text);
      console.log(`\nDETECTOR BIAS (median):  glass B/R x${f3(sl.glassBR.med / st.glassBR.med)}   `
        + `shift x${f3(sl.shift.med / st.shift.med)}   pane:wall x${f3(sl.paneWall.med / st.paneWall.med)}`);
      out = { ...out, detector: sl, detectorRows: L,
        bias: { glassBR: sl.glassBR.med / st.glassBR.med, shift: sl.shift.med / st.shift.med, paneWall: sl.paneWall.med / st.paneWall.med } };
    }
    fs.mkdirSync('docs/measurements', { recursive: true });
    const tag = arg('tag', 'truth');
    fs.writeFileSync(`docs/measurements/pane-tint-${tag}.json`, JSON.stringify(out, null, 1));
    console.log(`docs/measurements/pane-tint-${tag}.json`);
  } else {
    console.log('usage: --selftest | --reference | --engine <dir> [--time t] | --validate <base>... | --truth <base>...');
  }
}
