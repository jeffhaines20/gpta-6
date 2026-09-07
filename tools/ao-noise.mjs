// IS THE AO TERM NOISE, AND HOW DARK DOES IT GO? The two numbers the existing
// AO instruments cannot produce.
//
// tools/ao-sweep.mjs measures LEVELS off the AO buffer -- occlusion here minus
// occlusion there -- and tools/prop-ground.mjs measures a directional umbra in
// the composited frame. Neither can answer the complaint two blind reviewers
// raised against the r8 build, which was not about levels at all:
//
//   "the junction band is visibly dithered -- alternating light/dark single
//    pixels -- and the mottling extends across the pier face itself. It will
//    crawl in motion in a way a still frame does not show."
//
// A mean cannot see that. A mean over a dithered band and a mean over a smooth
// band of the same average brightness are the same number. What separates them
// is variance AT THE PIXEL SCALE, and that is what this file measures.
//
// ---------------------------------------------------------------------------
// WHY THE SECOND DIFFERENCE ALONG Y, AND NOT A LAPLACIAN
// ---------------------------------------------------------------------------
// Every region under test here is a VERTICAL architectural band: a facade pier,
// the jamb beside it, a wall/pavement junction seen from the street. Along a
// column inside such a band the scene's own luminance varies SLOWLY -- it is the
// same material, the same normal, the same distance, lit the same way, changing
// only with the slow vertical falloff of skylight. So anything varying from one
// row to the next AT PIXEL SCALE is not the building. It is the sampler.
//
//   n(x,y) = (2*L(x,y) - L(x,y-1) - L(x,y+1)) / sqrt(6)
//
// The sqrt(6) normalises it: for white noise of standard deviation s the
// combination 2L - La - Lb has variance (4+1+1)s^2, so n has standard deviation
// exactly s. A reported vnoise of 3.0 means "3.0 grey levels of pixel-scale
// grain", in the units of the PNG.
//
// AN ISOTROPIC HIGH-PASS WAS TRIED FIRST AND IT IS THE WRONG INSTRUMENT. A
// Laplacian fires hard on the genuine vertical edge that every one of these
// bands contains by construction -- that edge is the FEATURE, it is why the band
// was chosen -- so the isotropic version reports a large number on a perfectly
// clean render and cannot distinguish "there is an edge here" from "the edge is
// dithered". The y-only second difference is blind to any luminance profile that
// is linear in y, which includes every real vertical edge in these frames, and
// sees only what varies row to row. --selftest asserts exactly this: a synthetic
// band containing a hard vertical edge must read the SAME vnoise as one without,
// and a dithered band must read many times higher.
//
// hnoise (the same second difference along x) is reported beside it, because a
// checkerboard dither shows in both and a scanline artefact shows in only one.
// It is information, not the headline.
//
// ---------------------------------------------------------------------------
// THE TWO HEADLINE QUANTITIES
// ---------------------------------------------------------------------------
//   NOISE RATIO   vnoise over the junction band, divided by vnoise over a smooth
//                 stretch of the same pier a short distance away, IN THE SAME
//                 FRAME. A ratio inside one frame survives an exposure change,
//                 which a raw RMS does not (CLAUDE.md: prefer exposure-invariant
//                 metrics). 1.0 means the junction is no grainier than the flat
//                 wall beside it. The r8 build reads 2.87 here.
//   TROUGH        Mean luminance in the band divided by the 90th percentile of
//                 the luminance in a context window around it. Also a ratio
//                 inside one frame. It says how far below its own surroundings
//                 the AO term drags the junction: 1.0 is no darkening at all,
//                 0.16 is a black seam. The context window is the band grown by
//                 --pad pixels on each side in x, over the same rows, so the
//                 p90 is the lit stone the seam is cut into and not the sky.
//
// Both are computed on luma, both are dimensionless, and neither needs a
// matching capture of anything else.
//
//   node tools/ao-noise.mjs --selftest
//   node tools/ao-noise.mjs --shot docs/shots/r8-fivepoints-noon.png
//   node tools/ao-noise.mjs --before docs/shots/r8-fivepoints-noon.png \
//                           --after  docs/shots/aq-fivepoints-noon.png
//   node tools/ao-noise.mjs --live --port 8174     # pre-filter vs post-filter AO
import { readPNG } from './png.mjs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ---------------------------------------------------------------------------
// REGIONS
// ---------------------------------------------------------------------------
// Verbatim from the review that raised the defect, so the before/after numbers
// are comparable to the ones in the complaint. `band` is the junction the AO
// term is drawing; `face` is smooth wall of the SAME building a short way off,
// which is the control -- it carries the same exposure, the same material and
// the same distance, and differs only in whether an AO feature runs through it.
export const REGIONS = {
  'fivepoints-noon': {
    band: { x: 1181, y: 460, w: 10, h: 140 },
    face: { x: 1201, y: 460, w: 10, h: 140 },
  },
  'fivepoints-night': {
    band: { x: 1181, y: 460, w: 10, h: 140 },
    face: { x: 1201, y: 460, w: 10, h: 140 },
  },
  // THE POLE-BASE RECT IS HERE SO THE NEXT PERSON DOES NOT RE-DERIVE IT. The r8
  // review also reported "black blotches around the traffic-pole base,
  // x1080-1140 y690-740". Differencing r8 against the strength-0 control over
  // exactly that rect: mean 99.41 vs 99.46, ratio 0.9995, largest single-pixel
  // difference 3.72 grey levels. WHATEVER IS IN THAT RECT, THE AO TERM IS NOT
  // DRAWING IT. The nearest thing AO does draw in those rows is at x1167-1180,
  // outside the quoted box, and it is a 0.884 darkening -- a normal contact
  // shadow, not a blotch. Kept as a region so the claim stays falsifiable.
  'fivepoints-pole': {
    band: { x: 1080, y: 690, w: 60, h: 50 },
    face: { x: 1000, y: 690, w: 60, h: 50 },
  },
  // The corridor junction is at x1265-1275, not the x1250-1320 the review
  // quoted: a 70 px box spans the junction AND the lit pier beside it and
  // averages the two together. Found by differencing against the strength-0
  // control column by column -- 0.302 of the no-AO luminance at x1265-1275, and
  // a second junction of the same depth at x1335-1341. The face control is at
  // x1367-1377, where that same difference is 1.005: AO does nothing there.
  'corridor-noon': {
    band: { x: 1265, y: 480, w: 10, h: 120 },
    face: { x: 1367, y: 480, w: 10, h: 120 },
  },
};

const LUM = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * Luma plane from a readPNG image.
 *
 * `channels` IS 3 FOR THESE SCREENSHOTS, NOT 4. A hardcoded stride of 4 walks
 * off the end of the row and reads NaN in the bottom quarter of the frame, and
 * NaN loses every `>` comparison silently, so the bad rows report no difference
 * at all. --selftest builds the same picture as RGB and as RGBA and asserts the
 * metrics agree to 1e-9.
 */
export function lumaPlane(img) {
  const { width: w, height: h, channels: c, data } = img;
  const L = new Float64Array(w * h);
  if (c === 1) { for (let i = 0; i < w * h; i++) L[i] = data[i]; return L; }
  for (let i = 0, p = 0; i < w * h; i++, p += c) L[i] = LUM(data[p], data[p + 1], data[p + 2]);
  return L;
}

const clampRect = (r, w, h) => ({
  x: Math.max(0, r.x), y: Math.max(0, r.y),
  w: Math.min(w, r.x + r.w) - Math.max(0, r.x),
  h: Math.min(h, r.y + r.h) - Math.max(0, r.y),
});

/**
 * Pixel-scale grain along one axis, in the units of the plane.
 *
 * axis 'y' is the headline (see the header). Rows/columns at the rect's edge are
 * skipped rather than clamped: a clamped neighbour makes up a difference that
 * was never in the image.
 */
export function axisNoise(L, w, h, rect, axis = 'y') {
  const r = clampRect(rect, w, h);
  const dx = axis === 'x' ? 1 : 0, dy = axis === 'y' ? 1 : 0;
  let s2 = 0, n = 0;
  for (let y = r.y; y < r.y + r.h; y++) {
    for (let x = r.x; x < r.x + r.w; x++) {
      const xa = x - dx, xb = x + dx, ya = y - dy, yb = y + dy;
      if (xa < 0 || xb >= w || ya < 0 || yb >= h) continue;
      const v = (2 * L[y * w + x] - L[ya * w + xa] - L[yb * w + xb]) / Math.sqrt(6);
      if (!Number.isFinite(v)) throw new Error(`non-finite sample at ${x},${y}`);
      s2 += v * v; n++;
    }
  }
  if (!n) throw new Error('axisNoise: empty rect');
  return Math.sqrt(s2 / n);
}

export function rectStats(L, w, h, rect) {
  const r = clampRect(rect, w, h);
  const vals = [];
  for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) vals.push(L[y * w + x]);
  if (!vals.length) throw new Error('rectStats: empty rect');
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sorted = vals.slice().sort((a, b) => a - b);
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
  return { mean, min: sorted[0], p10: q(0.10), p50: q(0.5), p90: q(0.90), n: vals.length };
}

/**
 * How far below its own surroundings does the AO term drag the junction?
 *
 * ROW BY ROW, and that is not a detail. The first version took one mean over the
 * whole band and one p90 over the whole context window, and on a 140-row band it
 * measured the FACADE'S VERTICAL GRADIENT more than the seam: a wall that simply
 * gets brighter toward the top puts its bright rows into the p90 and its dark
 * rows into the mean, and the ratio reads 0.73 on a synthetic image with no seam
 * in it at all. --selftest catches that one directly (case A).
 *
 * So: for each row, the band's mean against the 90th percentile of the SAME ROW
 * of the context window, and the reported figure is the mean of those per-row
 * ratios. Any luminance profile that depends only on height cancels exactly.
 */
export function trough(L, w, h, band, pad) {
  const b = clampRect(band, w, h);
  const c = clampRect({ x: band.x - pad, y: band.y, w: band.w + 2 * pad, h: band.h }, w, h);
  const ratios = [];
  for (let y = b.y; y < b.y + b.h; y++) {
    let s = 0, n = 0;
    for (let x = b.x; x < b.x + b.w; x++) { s += L[y * w + x]; n++; }
    const rowCtx = [];
    for (let x = c.x; x < c.x + c.w; x++) rowCtx.push(L[y * w + x]);
    if (!n || !rowCtx.length) continue;
    rowCtx.sort((p, q) => p - q);
    const p90 = rowCtx[Math.min(rowCtx.length - 1, Math.round(0.9 * (rowCtx.length - 1)))];
    if (p90 > 0) ratios.push((s / n) / p90);
  }
  if (!ratios.length) throw new Error('trough: no usable rows');
  const bs = rectStats(L, w, h, b), cs = rectStats(L, w, h, c);
  const ratio = ratios.reduce((a, x) => a + x, 0) / ratios.length;
  if (!Number.isFinite(ratio)) throw new Error('trough: non-finite');
  return { ratio, rectRatio: cs.p90 > 0 ? bs.mean / cs.p90 : NaN,
    bandMean: bs.mean, bandMin: bs.min, ctxP90: cs.p90, ctxN: cs.n };
}

/** Every headline number for one image and one named region. */
export function measure(img, region, pad) {
  const { width: w, height: h } = img;
  const L = lumaPlane(img);
  const t = trough(L, w, h, region.band, pad);
  const bv = axisNoise(L, w, h, region.band, 'y');
  const fv = axisNoise(L, w, h, region.face, 'y');
  const bh = axisNoise(L, w, h, region.band, 'x');
  const fh = axisNoise(L, w, h, region.face, 'x');
  return {
    trough: t.ratio, rectTrough: t.rectRatio, bandMean: t.bandMean, bandMin: t.bandMin, ctxP90: t.ctxP90,
    bandV: bv, faceV: fv, noiseRatio: fv > 0 ? bv / fv : NaN,
    bandH: bh, faceH: fh, faceMean: rectStats(L, w, h, region.face).mean,
    // Grain as a FRACTION of the level it sits on. The band is much darker than
    // the face, so equal grey-level grain is far more visible there; the raw
    // ratio understates what the eye gets. Reported, not headline.
    relV: t.bandMean > 0 ? bv / t.bandMean : NaN,
  };
}

// ---------------------------------------------------------------------------
// SELFTEST
// ---------------------------------------------------------------------------
function synth(w, h, fn, channels = 3) {
  const data = new Uint8Array(w * h * channels);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = Math.max(0, Math.min(255, Math.round(fn(x, y))));
      const p = (y * w + x) * channels;
      data[p] = v; data[p + 1] = v; data[p + 2] = v;
      if (channels === 4) data[p + 3] = 255;
    }
  }
  return { width: w, height: h, channels, data };
}

function selftest() {
  const W = 200, H = 180, PAD = 30;
  const REG = { band: { x: 90, y: 30, w: 10, h: 120 }, face: { x: 120, y: 30, w: 10, h: 120 } };
  const fails = [];
  const ok = (cond, msg) => { console.log(`  ${cond ? 'ok  ' : 'FAIL'}  ${msg}`); if (!cond) fails.push(msg); };

  // A: smooth stone. Slow gradients in both axes, no pixel-scale content.
  // THE Y SLOPE IS EXACTLY ONE LEVEL PER ROW ON PURPOSE. A fractional y slope
  // rounds to 8 bits as a sawtooth and the metric correctly reports that
  // sawtooth as grain (0.22 grey levels of it), which is true but is the
  // synthetic image's noise and not the metric's. The x slope stays fractional:
  // its rounding is constant down a column, so it cancels in a y difference and
  // shows only in hnoise, which is the asymmetry being asserted.
  const base = (x, y) => 30 + y + 0.1 * x;
  const A = measure(synth(W, H, base), REG, PAD);
  ok(A.noiseRatio > 0.5 && A.noiseRatio < 2.0, `clean render: noise ratio ${A.noiseRatio.toFixed(3)} is near 1`);
  ok(A.bandV < 0.02, `clean render: band vnoise ${A.bandV.toFixed(4)} is ~0`);
  ok(A.trough > 0.93, `clean render: trough ${A.trough.toFixed(3)} shows no seam`);
  ok(A.rectTrough < 0.85, `and the whole-rect version reads ${A.rectTrough.toFixed(3)} on that same seamless image -- which is why it is not the headline`);

  // B: THE EDGE CONTROL. A hard vertical edge through the band -- 60 grey levels
  // in one column, which is a bigger step than any AO seam in these frames.
  // vnoise must NOT move: this is the property that makes the metric a noise
  // metric rather than an edge detector, and it is the reason the isotropic
  // high-pass was rejected. hnoise SHOULD move, which is why it is reported.
  const edge = (x, y) => base(x, y) - (x >= 94 && x < 97 ? 60 : 0);
  const B = measure(synth(W, H, edge), REG, PAD);
  ok(B.bandV < 0.02, `hard vertical edge: band vnoise ${B.bandV.toFixed(4)} still ~0`);
  ok(B.bandH > 10, `hard vertical edge: band hnoise ${B.bandH.toFixed(2)} does see it`);
  ok(B.trough < 0.93, `hard vertical edge: trough ${B.trough.toFixed(3)} sees the darkening`);

  // C: KNOWN BAD. The defect under repair: the same seam, dithered, alternating
  // light and dark single pixels along the edge, plus mottle over the face.
  const dith = (x, y) => edge(x, y) + (x >= 92 && x < 99 ? ((x + y) % 2 ? 14 : -14) : 0);
  const C = measure(synth(W, H, dith), REG, PAD);
  ok(C.noiseRatio > 5, `dithered seam: noise ratio ${C.noiseRatio.toFixed(2)} > 5`);
  ok(C.bandV > 10, `dithered seam: band vnoise ${C.bandV.toFixed(2)} > 10`);

  // D: mottle on the FACE as well as the band pulls the ratio back toward 1,
  // so a build that is uniformly grainy cannot hide behind the ratio. The
  // absolute vnoise is what catches that one, and it must rise.
  const both = (x, y) => dith(x, y) + ((x + y) % 2 ? 14 : -14);
  const D = measure(synth(W, H, both), REG, PAD);
  ok(D.faceV > 10, `grain everywhere: face vnoise ${D.faceV.toFixed(2)} rises`);
  ok(D.noiseRatio < C.noiseRatio, `grain everywhere: ratio ${D.noiseRatio.toFixed(2)} falls below ${C.noiseRatio.toFixed(2)} -- ratio alone is not enough`);

  // E: STRIDE. channels is 3 for these screenshots. The same picture as RGBA
  // must give the same numbers, or the reader is walking off the row.
  const E3 = measure(synth(W, H, dith, 3), REG, PAD);
  const E4 = measure(synth(W, H, dith, 4), REG, PAD);
  const same = ['trough', 'bandV', 'faceV', 'noiseRatio'].every((k) => Math.abs(E3[k] - E4[k]) < 1e-9);
  ok(same, 'RGB and RGBA of the same picture agree to 1e-9');

  // F: NON-FINITE. A NaN in the plane must throw, not be silently skipped.
  let threw = false;
  try {
    const bad = synth(W, H, base);
    const L = lumaPlane(bad); L[50 * W + 95] = NaN;
    axisNoise(L, W, H, REG.band, 'y');
  } catch { threw = true; }
  ok(threw, 'a NaN in the plane throws instead of being averaged away');

  // G: the darkness metric must actually fall when the band is darkened, and
  // must be blind to a uniform exposure change (both arms scaled together).
  const dark = (x, y) => base(x, y) * (x >= 90 && x < 100 ? 0.25 : 1);
  const G1 = measure(synth(W, H, dark), REG, PAD);
  const G2 = measure(synth(W, H, (x, y) => dark(x, y) * 0.6), REG, PAD);
  ok(G1.trough < 0.35, `darkened band: trough ${G1.trough.toFixed(3)} < 0.35`);
  ok(Math.abs(G1.trough - G2.trough) < 0.02, `trough is exposure-invariant: ${G1.trough.toFixed(3)} vs ${G2.trough.toFixed(3)} at 0.6x exposure`);

  console.log(fails.length ? `\nSELFTEST FAILED (${fails.length})` : '\nSELFTEST PASSED');
  process.exit(fails.length ? 1 : 0);
}

if (has('selftest')) selftest();

// ---------------------------------------------------------------------------
// LIVE: is the filter filtering?
// ---------------------------------------------------------------------------
// The offline metrics above see the AO term through exposure, the tone curve and
// bloom. This one reads the two AO targets directly -- aoRT, straight out of the
// 12-tap kernel, and aoBlurRT, after the depth-aware blur -- and reports how much
// grain the blur actually removed on the band in question.
//
//   effTaps = (vnoise before / vnoise after)^2
//
// which is the number of independent samples the filter is really averaging. A
// 5x5 kernel that is accepting all of its taps reads near 25. A 5x5 whose depth
// weights have collapsed reads near 1, and THAT is a filter that is present in
// the source and absent from the image.
// --arms runs SEVERAL parameter sets inside ONE page load, which is the only
// affordable way to sweep this: SwiftShader renders well under 1 fps and a
// separate capture per arm costs minutes of world-building it has already done.
// The world is frozen first (traffic and crowd to zero, cloud wind to zero) so
// nothing between two arms is anything but the parameters, and arm 0 is
// RE-MEASURED at the end -- if the repeat disagrees the sweep is void, the same
// guard tools/ao-sweep.mjs carries and for the same reason.
//
//   --arms "base,s24:aoSamples=24,spiral:aoKernel=1,fall:aoFalloff=0.08"
//
// Several settings inside one arm are separated by ';' because ',' already
// separates arms.
async function live() {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  const fs = await import('node:fs');
  const PORT = Number(arg('port', 8174));
  const TOD = arg('tod', 'noon');
  const NAME = arg('region', 'fivepoints-noon');
  const CAMNAME = arg('cam', NAME.startsWith('corridor') ? 'corridor' : 'fivepoints');
  const PEDS = Number(arg('peds', '0'));
  const TAG = arg('tag', 'aonoise');
  const KEEP = has('keep');
  const PADPX = Number(arg('pad', '30'));
  const REG = REGIONS[NAME];
  if (!REG) throw new Error(`unknown region ${NAME}`);
  const CAMS = {
    fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
    corridor: { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  };
  const CAM = CAMS[CAMNAME];
  const ARMS = (arg('arms', 'base') || 'base').split(',').map((spec) => {
    const [name, kv] = spec.split(':');
    const set = {};
    for (const pair of (kv || '').split(';').filter(Boolean)) {
      const [k, v] = pair.split('=');
      set[k] = Number(v);
    }
    return { name, set };
  });

  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = []; page.on('pageerror', (e) => errs.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 300000 });
  await page.addStyleTag({ content: '#attr{display:none!important} #hud,.pv-hud{display:none!important}' });
  await page.evaluate(([t, n]) => {
    __district.setTraffic(0); __district.setPedestrians(n);
    __district.sky.cloudWind.set(0, 0);
    __district.setTimeOfDay(t);
  }, [TOD, PEDS]);
  await page.evaluate((c) => {
    const r = __district.district.meta.route, a = r[c.wpA], b = r[c.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const ux = dx / len, uz = dz / len;
    const px = a.x - ux * c.back + -uz * c.side, pz = a.z - uz * c.back + ux * c.side;
    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam([px, c.height, pz], [a.x + ux * c.fwd, c.tgtY, a.z + uz * c.fwd], c.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  }, CAM);

  const settle = async () => {
    const f0 = await page.evaluate(() => __district.frames);
    await page.waitForFunction((f) => __district.frames > f + 4, f0, { timeout: 900000, polling: 200 });
  };
  const applyArm = (set) => page.evaluate((st) => {
    const p = __district.postParams();
    // Restore every sweepable AO knob to the file's own shipped values first, so
    // an arm is what it says it is and not what it says PLUS whatever the arm
    // before it left behind.
    const D = { aoRadius: 0.6, aoBias: 0.035, aoIntensity: 8.5, aoStrength: 1.0,
      aoBlurRadius: 2, aoSamples: 12, aoKernel: 0, aoFalloff: 0, aoDither: 0, aoDepthSigma: 0 };
    Object.assign(p, D, st);
    p.aoEnabled = true;
    const out = {}; for (const k of Object.keys(D)) out[k] = p[k];
    return out;
  }, set);
  const readBuf = () => page.evaluate(() => {
    const D = __district, post = D.post, r = D.renderer;
    const read = (rt) => {
      const w = rt.width, h = rt.height, buf = new Uint8Array(w * h * 4);
      r.readRenderTargetPixels(rt, 0, 0, w, h, buf);
      const px = new Array(w * h);
      for (let i = 0; i < w * h; i++) px[i] = buf[i * 4];
      return { w, h, px };
    };
    return { pre: read(post.aoRT), post: read(post.aoBlurRT) };
  });
  const toPlane = (g) => {
    const { w, h, px } = g;
    const L = new Float64Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) L[(h - 1 - y) * w + x] = px[y * w + x];
    return { L, w, h };
  };
  const mapRect = (r, w, h) => ({ x: Math.round(r.x * w / 1600), y: Math.round(r.y * h / 900),
    w: Math.max(2, Math.round(r.w * w / 1600)), h: Math.max(3, Math.round(r.h * h / 900)) });

  const results = [];
  const run = async (arm, label) => {
    const got = await applyArm(arm.set);
    await settle();
    const file = `docs/shots/${TAG}-${label}.png`;
    await page.screenshot({ path: file, timeout: 300000 });
    const frame = measure(readPNG(file), REG, PADPX);
    if (!KEEP) fs.unlinkSync(file);
    const g = await readBuf();
    const buf = {};
    for (const [k, gg] of [['pre', g.pre], ['post', g.post]]) {
      const { L, w, h } = toPlane(gg);
      buf[`${k}Band`] = axisNoise(L, w, h, mapRect(REG.band, w, h), 'y');
      buf[`${k}Mean`] = rectStats(L, w, h, mapRect(REG.band, w, h)).mean;
    }
    results.push({ label, arm: arm.name, params: got, frame, buf });
    console.log(`  ${label.padEnd(16)} trough ${frame.trough.toFixed(3)}  bandV ${frame.bandV.toFixed(2)}  faceV ${frame.faceV.toFixed(2)}  |  AO pre ${buf.preBand.toFixed(2)} post ${buf.postBand.toFixed(2)} mean ${buf.postMean.toFixed(1)}`);
  };

  console.log(`\nregion ${NAME}, cam ${CAMNAME}, tod ${TOD}, peds ${PEDS}, ${ARMS.length} arms`);
  for (const arm of ARMS) await run(arm, arm.name);
  await run(ARMS[0], '__repeat');

  // THE GUARD. Same parameters, same world, measured again at the end. If it
  // does not land on the same numbers then something in the page moved and every
  // difference above it is suspect.
  const a0 = results[0], rp = results[results.length - 1];
  const keys = [['trough', 0.004], ['bandV', 0.05], ['faceV', 0.05]];
  const bad = keys.filter(([k, tol]) => Math.abs(a0.frame[k] - rp.frame[k]) > tol);
  const bufBad = Math.abs(a0.buf.postBand - rp.buf.postBand) > 0.08;
  console.log(`\nrepeat of ${a0.arm}: ` + keys.map(([k]) => `${k} d=${(rp.frame[k] - a0.frame[k]).toFixed(4)}`).join('  ') +
    `  AOpost d=${(rp.buf.postBand - a0.buf.postBand).toFixed(4)}`);
  const isVoid = bad.length > 0 || bufBad;
  console.log(isVoid ? 'REPEAT DISAGREES -- THE SWEEP IS VOID.' : 'repeat agrees; the sweep stands.');

  console.log('\narm              trough  bandMean  bandV  faceV  ratio   relV    AOpre   AOpost  AOmean  effTaps');
  for (const r of results) {
    console.log(`${r.label.padEnd(16)} ${r.frame.trough.toFixed(3).padStart(6)} ${r.frame.bandMean.toFixed(1).padStart(9)} ` +
      `${r.frame.bandV.toFixed(2).padStart(6)} ${r.frame.faceV.toFixed(2).padStart(6)} ${r.frame.noiseRatio.toFixed(2).padStart(6)} ` +
      `${(100 * r.frame.relV).toFixed(1).padStart(6)}% ${r.buf.preBand.toFixed(2).padStart(8)} ${r.buf.postBand.toFixed(2).padStart(8)} ` +
      `${r.buf.postMean.toFixed(1).padStart(7)} ${((r.buf.preBand / r.buf.postBand) ** 2).toFixed(1).padStart(8)}`);
  }
  fs.writeFileSync(`docs/ao-noise-${TAG}.json`, JSON.stringify({ region: NAME, tod: TOD, peds: PEDS, void: isVoid, results }, null, 2));
  console.log(`\nwrote docs/ao-noise-${TAG}.json`);
  if (errs.length) console.log('PAGE ERRORS:', errs);
  await browser.close();
  if (isVoid) process.exit(1);
}

if (has('live')) { await live(); process.exit(0); }

// ---------------------------------------------------------------------------
// OFFLINE
// ---------------------------------------------------------------------------
const PAD = Number(arg('pad', '30'));
const regionFor = (file) => {
  const explicit = arg('region', '');
  if (explicit) {
    if (!REGIONS[explicit]) throw new Error(`unknown region ${explicit}`);
    return { name: explicit, ...REGIONS[explicit] };
  }
  for (const k of Object.keys(REGIONS)) if (file.includes(k)) return { name: k, ...REGIONS[k] };
  throw new Error(`no region matches ${file}; pass --region`);
};

const HEAD = 'region                 trough  bandMean  ctxP90  noiseRatio  bandV  faceV  bandH   relV';
const row = (label, m) => `${label.padEnd(22)} ${m.trough.toFixed(3).padStart(6)} ${m.bandMean.toFixed(1).padStart(9)} ${m.ctxP90.toFixed(1).padStart(7)} ${m.noiseRatio.toFixed(2).padStart(11)} ${m.bandV.toFixed(2).padStart(6)} ${m.faceV.toFixed(2).padStart(6)} ${m.bandH.toFixed(2).padStart(6)} ${(100 * m.relV).toFixed(2).padStart(6)}%`;

const before = arg('before', ''), after = arg('after', ''), shot = arg('shot', '');
if (shot) {
  const r = regionFor(shot);
  console.log(HEAD);
  console.log(row(r.name, measure(readPNG(shot), r, PAD)));
} else if (before && after) {
  const rb = regionFor(before), ra = regionFor(after);
  const mb = measure(readPNG(before), rb, PAD), ma = measure(readPNG(after), ra, PAD);
  console.log(HEAD);
  console.log(row(`before ${rb.name}`, mb));
  console.log(row(`after  ${ra.name}`, ma));
  console.log(`\ntrough      ${mb.trough.toFixed(3)} -> ${ma.trough.toFixed(3)}   (1.0 = no seam; higher is less black)`);
  console.log(`noiseRatio  ${mb.noiseRatio.toFixed(2)} -> ${ma.noiseRatio.toFixed(2)}   (1.0 = band no grainier than the wall beside it)`);
  console.log(`band vnoise ${mb.bandV.toFixed(2)} -> ${ma.bandV.toFixed(2)}  grey levels`);
} else {
  console.log('usage: --selftest | --shot FILE | --before A --after B | --live [--port N]');
  process.exit(2);
}
