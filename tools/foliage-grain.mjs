// Is a canopy made of LEAVES or of PLATES? Four numbers, off any frame.
//
// The oak round shipped a crown built from 48 flattened pillows. Looking at
// docs/shots/oak2-look-oak-up-golden.png the failure is obvious - metre-wide
// nearly-planar sheets, uniformly dark, hard polygon corners against the sky -
// but "obvious" is what the last four rounds of this ledger kept getting wrong.
// A leg-median hid a bimodal split; a colour detector disagreed with the eye and
// the detector was believed; an A/B whose two arms were secretly identical
// produced a confident null result. So before anything changes the foliage, the
// change needs an instrument that can say it went the right way, and by how much
// against the photographs.
//
//   node tools/foliage-grain.mjs --selftest
//   node tools/foliage-grain.mjs docs/shots/oak2-look-oak-up-golden.png
//   node tools/foliage-grain.mjs --reference          # the 97 canopy stations
//   node tools/foliage-grain.mjs --engine             # the oak bench frames
//
// WHAT IT MEASURES, and why each one is separate.
//
//   boundaryD   Perimeter of the canopy silhouette at three scales, fitted to
//               P(s) ~ s^(1-D). A straight polygon edge gives D = 1.0 no matter
//               how long it is; a ragged leaf edge gives more. This is the one
//               that sees "hard polygon corners", and it is scale-derived rather
//               than a corner detector so it cannot be fooled by a subdivided
//               polygon that is still straight.
//
//   holesPerK   Enclosed sky components per 1000 canopy pixels, and their median
//               area. Real canopy is porous with MANY SMALL holes. A pillow
//               crown is a few big sheets with a few big gaps - the same total
//               sky, arranged the way a tarpaulin is arranged and not the way a
//               tree is. Total sky fraction cannot tell those apart; this can.
//
//   xings       Canopy<->sky transitions per row. Granularity along a scanline,
//               independent of the boundary measure: a crown of many small
//               plates crosses often even where its outline is smooth.
//
//   texture     RMS luminance gradient inside the mass, over the mean, measured
//               on the mask ERODED BY 2 px so the silhouette edge cannot inflate
//               it. This is dappling - sun through leaves - and it is the number
//               that says "uniformly dark".
//
// SEGMENTATION IS OTSU, not a colour rule. A colour rule is what under-read the
// backlit wall in oak-census (see the note at the top of oak-profile.mjs); it
// also cannot survive golden hour, where the sky is warm and the "sky is blue"
// test inverts. Otsu takes the crop's own luminance histogram and splits it, so
// blue sky, white overcast and orange sky all work. It is REFUSED, with a
// reason, when the crop is not bimodal - a flat crop must read n/a rather than
// produce a confident number about a boundary that does not exist.
//
// WHICH FRAMES THIS IS HONEST ON. The mask is "dark thing against bright sky",
// so anything else dark and hard-edged in the crop - a parapet, a wire, a signal
// mast, a lamp head - is counted as canopy. On the district hero frames that
// inflates D and xings by an amount nobody can subtract, and it is why
// tree-corridor-dusk scores D 1.40 while the oak bench looking straight up
// scores 1.07 on the same trees. So: the isolation frames from oak-look.mjs are
// the ones to compare against the photographs, and the district frames are for
// before/after at a FIXED camera, where the contamination is identical on both
// sides and cancels. Reading a district frame as an absolute score is the
// pooling error this ledger has already made twice.
//
// Reference is REFERENCE (binding constraint 1): this reads the reprojected
// Mapillary views to get a target band and writes nothing back into any asset.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readPNG } from './png.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// --- luminance, crop, Otsu -------------------------------------------------

// Every measurement here counts PIXELS - boundary cells, scanline crossings,
// hole areas - so a frame captured at 1600 wide scores differently from the same
// content at 1280 for no reason but the capture size. The reprojected reference
// views are 1280x960, the oak bench is 1400x900 and the district heroes are
// 1600x900, so that confound is present the moment a photograph is compared with
// a render. Every crop is therefore area-averaged down to a common width before
// anything is counted. Never UP: inventing pixels would invent boundary.
const NORM_W = 1024;

/** Rec.709 luma of a crop, area-averaged to NORM_W if the crop is wider. */
function luma(img, box) {
  const [x0, y0, x1, y1] = box;
  const sw0 = x1 - x0, sh0 = y1 - y0, c = img.channels, sw = img.width, d = img.data;
  const src = new Float32Array(sw0 * sh0);
  for (let y = 0; y < sh0; y++) {
    for (let x = 0; x < sw0; x++) {
      const i = ((y + y0) * sw + (x + x0)) * c;
      src[y * sw0 + x] = c === 1 ? d[i] : 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
    }
  }
  if (sw0 <= NORM_W) return { L: src, w: sw0, h: sh0, scale: 1 };

  const k = NORM_W / sw0;
  const w = NORM_W, h = Math.max(1, Math.round(sh0 * k));
  const L = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const sy0 = (y * sh0) / h, sy1 = ((y + 1) * sh0) / h;
    const j0 = Math.floor(sy0), j1 = Math.min(sh0, Math.ceil(sy1));
    for (let x = 0; x < w; x++) {
      const sx0 = (x * sw0) / w, sx1 = ((x + 1) * sw0) / w;
      const i0 = Math.floor(sx0), i1 = Math.min(sw0, Math.ceil(sx1));
      let acc = 0, wt = 0;
      for (let j = j0; j < j1; j++) {
        const fy = Math.min(sy1, j + 1) - Math.max(sy0, j);
        if (fy <= 0) continue;
        for (let i = i0; i < i1; i++) {
          const fx = Math.min(sx1, i + 1) - Math.max(sx0, i);
          if (fx <= 0) continue;
          acc += src[j * sw0 + i] * fx * fy; wt += fx * fy;
        }
      }
      L[y * w + x] = wt > 0 ? acc / wt : 0;
    }
  }
  return { L, w, h, scale: k };
}

/**
 * Otsu's threshold plus its separability. eta is between-class variance over
 * total variance: 1.0 is two delta functions, 0.0 is a histogram with no split
 * worth making. The refusal below keys off eta, so a crop of flat sky or flat
 * wall reports n/a instead of a threshold picked out of sensor noise.
 */
function otsu(L) {
  const hist = new Float64Array(256);
  for (let i = 0; i < L.length; i++) hist[Math.max(0, Math.min(255, Math.round(L[i])))]++;
  const n = L.length;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let wB = 0, sumB = 0, best = -1, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  const mean = sum / n;
  let varTot = 0;
  for (let t = 0; t < 256; t++) varTot += hist[t] * (t - mean) * (t - mean);
  const eta = varTot > 0 ? (best / (n * n)) / (varTot / n) : 0;
  return { thr, eta };
}

// --- the four measurements -------------------------------------------------

/** Perimeter of a boolean mask in pixel units: mask cells with a 4-neighbour
 *  of the other class. Outside the crop counts as sky, so a canopy running off
 *  the top of the frame is not credited with an edge it does not have. */
function perimeter(m, w, h) {
  let p = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!m[y * w + x]) continue;
      if (x === 0 || !m[y * w + x - 1]) { p++; continue; }
      if (x === w - 1 || !m[y * w + x + 1]) { p++; continue; }
      if (y === 0 || !m[(y - 1) * w + x]) { p++; continue; }
      if (y === h - 1 || !m[(y + 1) * w + x]) { p++; continue; }
    }
  }
  return p;
}

/** Majority-vote downsample by an integer factor. Majority rather than any/all
 *  because either of those biases the coarse mask's area, and an area bias
 *  walks straight into the perimeter ratio the dimension is fitted from. */
function shrink(m, w, h, s) {
  const nw = Math.floor(w / s), nh = Math.floor(h / s);
  const out = new Uint8Array(nw * nh);
  const half = (s * s) / 2;
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let c = 0;
      for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) c += m[(y * s + j) * w + x * s + i];
      out[y * nw + x] = c > half ? 1 : 0;
    }
  }
  return { m: out, w: nw, h: nh };
}

/**
 * Boundary dimension from perimeter at scales 1, 2, 4, 8.
 *
 * Counting boundary CELLS at cell size s is box-counting, so N(s) ~ s^-D and a
 * least-squares fit of log N against log s has slope -D. A straight edge gives
 * D = 1 (halve the cell size, double the count); a ragged one gives more.
 *
 * The first cut of this returned 1 - slope, which is the relation for boundary
 * LENGTH rather than boundary COUNT, and it put a hexagon at D = 2.01 - a
 * boundary dimension of two, for six straight sides. The synthetic hexagon in
 * --selftest is the only reason that was caught before the number was used to
 * judge a build, which is the whole argument for the self-test.
 *
 * Four scales, not three: 1 to 4 only probes roughness one to four pixels
 * across, and the structure under test - leaf clumps against sky - lives from
 * about five pixels to about eighty. Fitting over 1..8 covers the small half of
 * that and leaves the large half to `xings` and `holesPerK`.
 */
function boundaryDim(m, w, h) {
  const pts = [];
  for (const s of [1, 2, 4, 8]) {
    const g = s === 1 ? { m, w, h } : shrink(m, w, h, s);
    const p = perimeter(g.m, g.w, g.h);
    if (p < 12) return null;                 // too little boundary to fit
    pts.push([Math.log(s), Math.log(p)]);
  }
  const n = pts.length;
  const mx = pts.reduce((a, p) => a + p[0], 0) / n;
  const my = pts.reduce((a, p) => a + p[1], 0) / n;
  let num = 0, den = 0;
  for (const [x, y] of pts) { num += (x - mx) * (y - my); den += (x - mx) * (x - mx); }
  const slope = num / den;
  return -slope;
}

/** Enclosed sky: 4-connected sky components that never touch the crop border. */
function holes(m, w, h) {
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const areas = [];
  for (let start = 0; start < w * h; start++) {
    if (m[start] || seen[start]) continue;
    let sp = 0, area = 0, open = false;
    stack[sp++] = start; seen[start] = 1;
    while (sp) {
      const i = stack[--sp];
      const x = i % w, y = (i - x) / w;
      area++;
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) open = true;
      if (x > 0 && !m[i - 1] && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
      if (x < w - 1 && !m[i + 1] && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
      if (y > 0 && !m[i - w] && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
      if (y < h - 1 && !m[i + w] && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
    }
    if (!open) areas.push(area);
  }
  areas.sort((a, b) => a - b);
  return areas;
}

/** Mask<->background transitions per row, over rows that carry any mask. */
function crossings(m, w, h) {
  let rows = 0, x = 0;
  for (let y = 0; y < h; y++) {
    let any = false, c = 0;
    for (let i = 1; i < w; i++) {
      const a = m[y * w + i - 1], b = m[y * w + i];
      if (a) any = true;
      if (a !== b) c++;
    }
    if (m[y * w + w - 1]) any = true;
    if (any) { rows++; x += c; }
  }
  return rows ? x / rows : 0;
}

/** Erode by one 4-connected step, repeated. */
function erode(m, w, h, k) {
  let cur = m;
  for (let n = 0; n < k; n++) {
    const out = new Uint8Array(w * h);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        out[i] = cur[i] && cur[i - 1] && cur[i + 1] && cur[i - w] && cur[i + w] ? 1 : 0;
      }
    }
    cur = out;
  }
  return cur;
}

/** Mean gradient magnitude inside the eroded mass, normalised by mean luma. */
function texture(L, m, w, h) {
  const inner = erode(m, w, h, 2);
  let n = 0, g = 0, lum = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!inner[i]) continue;
      const dx = L[i + 1] - L[i - 1], dy = L[i + w] - L[i - w];
      g += Math.hypot(dx, dy); lum += L[i]; n++;
    }
  }
  if (n < 200) return null;
  const meanL = lum / n;
  return meanL > 1 ? (g / n) / meanL : null;
}

// --- one frame -------------------------------------------------------------

/**
 * Score a crop. Returns { ok: false, why } rather than numbers whenever the
 * crop cannot support them: not bimodal, or one class too small to have a
 * boundary worth measuring. Both refusals are exercised by --selftest.
 */
export function grain(img, box) {
  const { L, w, h, scale } = luma(img, box);
  const { thr, eta } = otsu(L);
  if (eta < 0.35) return { ok: false, why: `not bimodal (eta ${eta.toFixed(2)})` };
  // ROUND, not raw compare. The histogram Otsu chose from is binned by
  // Math.round, so `thr` names a BIN; testing the unrounded luma against it puts
  // every pixel of a two-valued image on the wrong side when the dark value
  // happens to sit just above its own bin centre. The first run of this
  // self-test did exactly that and reported the hexagon as 0% mass.
  const m = new Uint8Array(w * h);
  let mass = 0;
  for (let i = 0; i < L.length; i++) if (Math.round(L[i]) <= thr) { m[i] = 1; mass++; }
  const frac = mass / (w * h);
  if (frac < 0.08 || frac > 0.92) return { ok: false, why: `mass ${(frac * 100).toFixed(0)}% of crop` };

  const D = boundaryDim(m, w, h);
  if (D === null) return { ok: false, why: 'boundary too short to fit' };
  const hs = holes(m, w, h);
  const tex = texture(L, m, w, h);
  return {
    ok: true, w, h, scale: +scale.toFixed(3), thr, eta: +eta.toFixed(3), massFrac: +frac.toFixed(3),
    boundaryD: +D.toFixed(3),
    holesPerK: +((hs.length * 1000) / mass).toFixed(2),
    holeMedian: hs.length ? hs[hs.length >> 1] : 0,
    xings: +crossings(m, w, h).toFixed(2),
    texture: tex === null ? null : +tex.toFixed(4),
  };
}

/** Default crop: the upper band, where canopy sits against sky rather than
 *  against a shopfront. Same band oak-census called `upper`. */
function defaultBox(img) {
  return [0, 0, img.width, Math.round(img.height * 0.55)];
}

function scoreFile(file, box) {
  const img = readPNG(file);
  const b = box ?? defaultBox(img);
  return { file: path.basename(file), ...grain(img, b) };
}

// --- self-test -------------------------------------------------------------
//
// Four synthetic rasters whose ORDER is known before the tool runs. A metric
// that cannot separate a hexagon from a canopy is inert, and an inert metric
// that reports plausible numbers is worse than no metric: it launders a guess
// into a measurement. These are built in memory - no PNG encoder in the repo,
// and none is needed.

function synth(kind) {
  const W = 320, H = 320, data = new Uint8Array(W * H * 3);
  const SKY = [196, 212, 236], DARK = [38, 46, 34];
  const put = (x, y, c) => { const i = (y * W + x) * 3; data[i] = c[0]; data[i + 1] = c[1]; data[i + 2] = c[2]; };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, SKY);
  if (kind === 'flat') {
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, [60, 70, 55]);
    return { width: W, height: H, channels: 3, data };
  }
  // Deterministic value noise, so the self-test is the same test every run.
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296); };
  if (kind === 'hex') {
    const cx = W / 2, cy = H / 2, R = 118;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      let inside = true;
      for (let k = 0; k < 6; k++) {
        const a = (k * Math.PI) / 3;
        if ((x - cx) * Math.cos(a) + (y - cy) * Math.sin(a) > R * 0.866) { inside = false; break; }
      }
      if (inside) put(x, y, DARK);
    }
    return { width: W, height: H, channels: 3, data };
  }
  if (kind === 'pillows') {
    // Eight big smooth ellipses: the shape of the crown under test.
    const els = [];
    for (let k = 0; k < 8; k++) {
      els.push({ cx: 60 + rnd() * 200, cy: 60 + rnd() * 200, a: 52 + rnd() * 26, b: 26 + rnd() * 14, t: rnd() * Math.PI });
    }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      for (const e of els) {
        const dx = x - e.cx, dy = y - e.cy;
        const u = dx * Math.cos(e.t) + dy * Math.sin(e.t), v = -dx * Math.sin(e.t) + dy * Math.cos(e.t);
        if ((u * u) / (e.a * e.a) + (v * v) / (e.b * e.b) <= 1) { put(x, y, DARK); break; }
      }
    }
    return { width: W, height: H, channels: 3, data };
  }
  // 'canopy': octave noise thresholded inside a crown DISC, with the surviving
  // mass modulated in brightness so it dapples the way sun through leaves does.
  // Octaves are 6/12/24 across 320 px - features of 53, 27 and 13 px, which is
  // leaf-clump scale. The first cut used 8/16/32/64 and no disc: per-pixel
  // speckle out to the frame corners, which majority-downsampling erases
  // completely and which therefore fitted a boundary dimension ABOVE 2. A
  // boundary cannot have dimension 2, so that number was the synth being wrong
  // rather than the metric, and it is worth saying so here because a D over 2
  // on a real frame means the same thing: sub-pixel speckle, not a rough edge.
  const oct = [];
  for (const n of [6, 12, 24, 48]) {
    const g = new Float32Array((n + 1) * (n + 1));
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    oct.push({ n, g });
  }
  const noise = (x, y) => {
    let v = 0, amp = 1, tot = 0;
    for (const { n, g } of oct) {
      const fx = (x / W) * n, fy = (y / H) * n;
      const x0 = Math.floor(fx), y0 = Math.floor(fy), ax = fx - x0, ay = fy - y0;
      const sx = ax * ax * (3 - 2 * ax), sy = ay * ay * (3 - 2 * ay);
      const g00 = g[y0 * (n + 1) + x0], g10 = g[y0 * (n + 1) + x0 + 1];
      const g01 = g[(y0 + 1) * (n + 1) + x0], g11 = g[(y0 + 1) * (n + 1) + x0 + 1];
      v += amp * ((g00 * (1 - sx) + g10 * sx) * (1 - sy) + (g01 * (1 - sx) + g11 * sx) * sy);
      tot += amp; amp *= 0.74;
    }
    return v / tot;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const r = Math.hypot(x - W / 2, y - H / 2) / 132;
    if (r > 1.05) continue;                       // outside the crown: sky
    // Dense in the middle, thinning at the rim, so the silhouette is ragged
    // rather than a circle with texture painted inside it.
    if (noise(x, y) < 0.33 + 0.30 * r * r) continue;
    const k = 0.6 + 0.85 * noise(x * 2.7 + 41, y * 2.7 + 17);
    put(x, y, [DARK[0] * k, DARK[1] * k, DARK[2] * k]);
  }
  return { width: W, height: H, channels: 3, data };
}

// Everything below this line is the command line. It is guarded because grain()
// is imported by --sweep's sibling tools and by anything else that wants to
// score a raster it built itself; without the guard an `import { grain }` prints
// a usage banner and can call process.exit out from under its caller.
const IS_MAIN = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (IS_MAIN && has('selftest')) {
  const box = [0, 0, 320, 320];
  const r = {};
  for (const k of ['flat', 'hex', 'pillows', 'canopy']) r[k] = grain(synth(k), box);
  for (const k of Object.keys(r)) console.log(`  ${k.padEnd(8)} ${JSON.stringify(r[k])}`);
  const fails = [];
  const chk = (name, cond) => { if (!cond) fails.push(name); };
  chk('flat must refuse', r.flat.ok === false);
  chk('hex/pillows/canopy must all score', r.hex.ok && r.pillows.ok && r.canopy.ok);
  if (r.hex.ok && r.pillows.ok && r.canopy.ok) {
    chk('canopy edge is rougher than pillows', r.canopy.boundaryD > r.pillows.boundaryD + 0.08);
    chk('canopy edge is rougher than hexagon', r.canopy.boundaryD > r.hex.boundaryD + 0.08);
    chk('a hexagon reads as a straight edge', r.hex.boundaryD < 1.06);
    // Relative, with a floor. What is being asserted is that the measure
    // SEPARATES a porous crown from a plate crown - what counts as porous in
    // absolute terms is for --reference to read off the photographs, not for a
    // synthetic raster to declare.
    chk('canopy encloses far more sky than the plate crowns',
      r.canopy.holesPerK > 10 * Math.max(r.pillows.holesPerK, r.hex.holesPerK, 0.02));
    chk('pillows are not porous', r.pillows.holesPerK < 0.5);
    chk('hexagon is not porous', r.hex.holesPerK < 0.5);
    chk('canopy crosses more than pillows', r.canopy.xings > 2 * r.pillows.xings);
    chk('pillows cross more than a hexagon', r.pillows.xings > r.hex.xings);
    chk('canopy dapples', r.canopy.texture > 3 * r.hex.texture);
    chk('flat plates do not dapple', r.pillows.texture < 0.01);
  }
  console.log(fails.length ? `\nSELFTEST FAILED: ${fails.join('; ')}` : '\nselftest ok - all four separate as predicted');
  process.exit(fails.length ? 1 : 0);
}

// --- the sweep that killed the subdivision plan ----------------------------
//
// "Break the 48 pillows into more and smaller plates" was the obvious fix, and
// it is capped far below the reference band. This holds total painted area
// constant and varies only the plate COUNT, so what it isolates is granularity
// and nothing else. Kept as a mode rather than a scratch file because the
// conclusion is load-bearing - it is the reason the foliage got an alpha mask
// instead of a triangle budget - and a future round will want to re-run it
// rather than take it on trust.
function platesRaster(n, splay) {
  const W = 320, H = 320, data = new Uint8Array(W * H * 3);
  const SKY = [196, 212, 236], DARK = [38, 46, 34];
  for (let i = 0; i < W * H; i++) { data[i * 3] = SKY[0]; data[i * 3 + 1] = SKY[1]; data[i * 3 + 2] = SKY[2]; }
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296); };
  const A0 = 52 * 26, a = Math.sqrt((A0 * 8) / n);   // area per plate ~ 1/n
  const els = [];
  for (let k = 0; k < n; k++) {
    els.push({
      cx: 60 + rnd() * 200, cy: 60 + rnd() * 200,
      a: a * (0.8 + 0.4 * rnd()), b: a * 0.5 * (0.8 + 0.4 * rnd()), t: rnd() * Math.PI,
      k: splay ? 0.55 + 0.9 * rnd() : 1,             // per-plate shade = splayed normals
    });
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    for (const e of els) {
      const dx = x - e.cx, dy = y - e.cy;
      const u = dx * Math.cos(e.t) + dy * Math.sin(e.t), v = -dx * Math.sin(e.t) + dy * Math.cos(e.t);
      if ((u * u) / (e.a * e.a) + (v * v) / (e.b * e.b) <= 1) {
        const i = (y * W + x) * 3;
        data[i] = DARK[0] * e.k; data[i + 1] = DARK[1] * e.k; data[i + 2] = DARK[2] * e.k;
        break;
      }
    }
  }
  return { width: W, height: H, channels: 3, data };
}

if (IS_MAIN && has('sweep')) {
  console.log('  n  splay    D       holes/1k   med   xings    tex      mass');
  for (const splay of [false, true]) {
    for (const n of [8, 16, 32, 64, 128]) {
      const r = grain(platesRaster(n, splay), [0, 0, 320, 320]);
      console.log(String(n).padStart(4), String(splay).padStart(6), '  ', r.ok
        ? `${r.boundaryD.toFixed(3)}  ${String(r.holesPerK).padStart(7)}  ${String(r.holeMedian).padStart(4)}  `
          + `${String(r.xings).padStart(6)}  ${r.texture.toFixed(4)}  ${(r.massFrac * 100).toFixed(0)}%`
        : `n/a - ${r.why}`);
    }
  }
  console.log('\n  target   1.538     3.57      8   50.00  0.2467   (33 photographs)');
  console.log('\nSixteen times the plates buys xings 2.9 -> 11.5 against a target of 50, and');
  console.log('leaves holesPerK an order of magnitude short. Overlapping convex opaque blobs');
  console.log('merge into a blob. This is why the fix is an alpha mask, not more triangles.');
  process.exit(0);
}

// --- what a 2-D cutout stencil would buy ------------------------------------
//
// The --sweep above kills subdivision. This sizes its replacement, and it runs
// at the mass the REAL crown has (~50%) rather than the 14% a scatter of plates
// gives, because every measure here behaves differently at different mass and
// the first version of this simulation quietly sat in the wrong regime.
//
// The geometry under test: a dense crown of overlapping plates, each cut by a
// K x Hm binary stencil with a per-plate phase offset. That is exactly what the
// engine can do for free - propMaterial binds a PAL_W=16 palette with
// NearestFilter, so u anywhere in [i/16, (i+1)/16) resolves to palette column i,
// and an alphaMap of width 16*K addressed by the same uv resolves K distinct
// mask columns inside that range. Two dimensions of stencil, no new attribute,
// no new material, no triangles.
//
// One scale note that sets everything: the reference holeMedian is 8 PIXELS OF
// AREA - under three pixels across - so the stencil wants texels of about three
// to four screen pixels. K=32 overshoots into D > 2, which is not a rougher
// edge but sub-pixel speckle, and it will shimmer under motion.
function crownRaster({ n, K, Hm, duty, phase, cut }) {
  const W = 320, H = 320, SKY = [196, 212, 236], DARK = [38, 46, 34];
  const data = new Uint8Array(W * H * 3);
  for (let i = 0; i < W * H; i++) { data[i * 3] = SKY[0]; data[i * 3 + 1] = SKY[1]; data[i * 3 + 2] = SKY[2]; }
  let seed = 0x9e3779b9;
  const rnd = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return ((seed >>> 0) / 4294967296); };
  const st = new Uint8Array(K * Hm);
  {
    const g = new Float32Array((K + 1) * (Hm + 1));
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < Hm; y++) {
      for (let x = 0; x < K; x++) {
        const a = g[y * (K + 1) + x], b = g[((y * 2) % Hm) * (K + 1) + ((x * 2) % K)];
        st[y * K + x] = (0.6 * a + 0.4 * b) > duty ? 1 : 0;
      }
    }
  }
  const els = [];
  for (let k = 0; k < n; k++) {
    const a0 = 2 * Math.PI * rnd(), r0 = 132 * Math.sqrt(rnd()) * 0.92;
    els.push({
      cx: W / 2 + Math.cos(a0) * r0, cy: H / 2 + Math.sin(a0) * r0,
      a: 30 + 18 * rnd(), b: 15 + 10 * rnd(), t: rnd() * Math.PI,
      ps: phase ? Math.floor(rnd() * K) : 0, pt: phase ? Math.floor(rnd() * Hm) : 0,
      sh: 0.55 + 0.9 * rnd(),
    });
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      for (const e of els) {
        const dx = x - e.cx, dy = y - e.cy;
        const u = dx * Math.cos(e.t) + dy * Math.sin(e.t), v = -dx * Math.sin(e.t) + dy * Math.cos(e.t);
        if ((u * u) / (e.a * e.a) + (v * v) / (e.b * e.b) > 1) continue;
        if (cut) {
          const sI = Math.floor(((u / e.a + 1) / 2) * K) + e.ps;
          const tI = Math.floor(((v / e.b + 1) / 2) * Hm) + e.pt;
          if (!st[(((tI % Hm) + Hm) % Hm) * K + (((sI % K) + K) % K)]) continue;
        }
        const i = (y * W + x) * 3;
        data[i] = DARK[0] * e.sh; data[i + 1] = DARK[1] * e.sh; data[i + 2] = DARK[2] * e.sh;
        break;
      }
    }
  }
  return { width: W, height: H, channels: 3, data };
}

if (IS_MAIN && has('stencil')) {
  const row = (label, o) => {
    const r = grain(crownRaster(o), [0, 0, 320, 320]);
    console.log(label.padEnd(34), r.ok
      ? `D ${r.boundaryD.toFixed(3)}  holes ${String(r.holesPerK).padStart(5)}  med ${String(r.holeMedian).padStart(4)}`
        + `  xings ${String(r.xings).padStart(6)}  tex ${r.texture.toFixed(4)}  mass ${(r.massFrac * 100).toFixed(0)}%`
      : `n/a - ${r.why}`);
  };
  console.log('DENSE CROWN, UNCUT - the regime the real oak is in');
  for (const n of [40, 80, 160]) row(`${n} plates, uncut`, { n, K: 16, Hm: 8, duty: 0.45, phase: true, cut: false });
  console.log('\n2-D STENCIL, 80 plates - texel size on a ~60x25 px plate');
  for (const [K, Hm] of [[8, 4], [16, 8], [32, 16], [48, 24]]) {
    row(`K=${K} Hm=${Hm} (~${(60 / K).toFixed(1)}x${(25 / Hm).toFixed(1)} px)`, { n: 80, K, Hm, duty: 0.45, phase: true, cut: true });
  }
  console.log('\nDUTY at K=16 Hm=8, 80 plates');
  for (const duty of [0.30, 0.40, 0.50, 0.60]) row(`duty ${duty}`, { n: 80, K: 16, Hm: 8, duty, phase: true, cut: true });
  console.log('\nADDING PLATES BACK - note xings FALLS as the crown fills in');
  for (const n of [80, 120, 160, 240]) row(`${n} plates`, { n, K: 16, Hm: 8, duty: 0.45, phase: true, cut: true });
  console.log('\nTARGET'.padEnd(35) + 'D 1.538  holes  3.57  med    8  xings  50.00  tex 0.2467');
  console.log('ENGINE oak-up now'.padEnd(34) + 'D 1.084  holes  0.03  med    2  xings   4.78  tex 0.0715  mass 52%');
  console.log('\nK=16/Hm=8/duty 0.40 lands D 1.574 vs 1.538 and holes 3.60 vs 3.57 at 51% mass.');
  console.log('But xings stays ~10-13 against 50 at EVERY setting, and falls as plates are');
  console.log('added. Enclosed holes on target while crossings are five times short can only');
  console.log('mean the photographs\' crossings are not enclosed holes: they are sky channels');
  console.log('opening outward, between discrete leaf clumps hung on limbs. A canopy is not a');
  console.log('crown volume with holes punched in it. That gap is a PLACEMENT fault, and no');
  console.log('mask fixes it.');
  process.exit(0);
}

// --- batch modes -----------------------------------------------------------

const fmt = (r) => (r.ok
  ? `D ${r.boundaryD.toFixed(3)}  holes/1k ${String(r.holesPerK).padStart(6)}  med ${String(r.holeMedian).padStart(5)}`
    + `  xings ${String(r.xings).padStart(6)}  tex ${r.texture === null ? '  n/a ' : r.texture.toFixed(4)}`
    + `  mass ${(r.massFrac * 100).toFixed(0)}%`
  : `n/a - ${r.why}`);

const summarise = (rows) => {
  const ok = rows.filter((r) => r.ok);
  if (!ok.length) return null;
  const med = (f) => { const v = ok.map(f).filter((x) => x !== null).sort((a, b) => a - b); return v.length ? v[v.length >> 1] : null; };
  return {
    n: ok.length, refused: rows.length - ok.length,
    boundaryD: med((r) => r.boundaryD), holesPerK: med((r) => r.holesPerK),
    holeMedian: med((r) => r.holeMedian), xings: med((r) => r.xings), texture: med((r) => r.texture),
  };
};

const out = { generated: new Date().toISOString().slice(0, 10) };

if (IS_MAIN && has('reference')) {
  // The canopy stations the census found, not every view: scoring a frame with
  // no canopy in it would pull the target band toward "shopfront".
  const census = JSON.parse(fs.readFileSync('docs/oak-census.json', 'utf8'));
  const dir = 'reference/sarasota/mapillary/views';
  const want = census.rows.filter((r) => r.upper > 0.25).sort((a, b) => b.upper - a.upper);
  const rows = [];
  for (const r of want) {
    const f = path.join(dir, `${r.id}-${r.side}.png`);
    if (!fs.existsSync(f)) continue;
    const s = scoreFile(f);
    rows.push({ ...s, s: +r.s.toFixed(0), upper: +r.upper.toFixed(3) });
  }
  if (!rows.length) {
    console.error(`no reprojected views in ${dir} - run: node tools/reproject-pano.mjs --facades`);
    process.exit(2);
  }
  for (const r of rows.slice(0, 20)) console.log(`  ${r.file.padEnd(26)} s=${String(r.s).padStart(4)}  ${fmt(r)}`);
  out.reference = summarise(rows);
  console.log(`\n  PHOTOGRAPHS (median of ${out.reference.n}, ${out.reference.refused} refused):`, JSON.stringify(out.reference));
}

if (IS_MAIN && has('engine')) {
  const files = (arg('glob', 'oak2-look,oak-look,tree-'))
    .split(',')
    .flatMap((p) => fs.readdirSync('docs/shots').filter((f) => f.startsWith(p) && f.endsWith('.png')))
    .map((f) => path.join('docs/shots', f));
  const rows = files.map((f) => scoreFile(f));
  for (const r of rows) console.log(`  ${r.file.padEnd(38)} ${fmt(r)}`);
  out.engine = summarise(rows);
  console.log(`\n  ENGINE (median of ${out.engine?.n ?? 0}):`, JSON.stringify(out.engine));
}

const loose = IS_MAIN ? process.argv.slice(2).filter((a) => !a.startsWith('--') && a.endsWith('.png')) : [];
for (const f of loose) {
  const box = arg('crop', null)?.split(',').map(Number) ?? null;
  const r = scoreFile(f, box);
  console.log(`  ${r.file.padEnd(38)} ${fmt(r)}`);
  (out.files ??= []).push(r);
}

if (IS_MAIN && (has('reference') || has('engine'))) {
  fs.writeFileSync('docs/foliage-grain.json', JSON.stringify(out, null, 1));
  console.log('\ndocs/foliage-grain.json');
}
if (IS_MAIN && !has('reference') && !has('engine') && !loose.length) {
  console.log('usage: --selftest | --reference | --engine | <file.png> [--crop x0,y0,x1,y1]');
}
