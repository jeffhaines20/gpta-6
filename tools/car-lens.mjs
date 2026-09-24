// THE PARKED CAR'S FRONT LENS, AND ITS WHEEL, MEASURED WHERE THE BUILD PUTS THEM.
//
// WHY THIS EXISTS. Four review rounds have measured the cars off rectangles
// picked by eye off one frame. That is how round 2 tuned an alloy against sunlit
// tarmac, and how round 4's reviewer reported a front-wheel regression through an
// annulus that was road (tools/wheel-mask.mjs, written for that). CLAUDE.md's
// rule for tools that replay the build is that they must replay the build's own
// SELECTION, and the cheap proof is that the counts match. So nothing here is
// picked: every landmark is the screen-space projection of the actual vertices
// the geometry carries for that palette slot, read out of the live scene through
// the same instance matrices the renderer used.
//
// The counts it prints are that proof. buildTrafficCarGeometry emits 12
// headlight vertices, 100 tyre vertices and 100 rim vertices a car; a run that
// reports anything else is looking at a different geometry and says so.
//
//   --landmarks   boot the district, stand the corridor camera up, and write
//                 the projected landmarks of every parked car in frustum
//   --measure     score frames against a landmarks file
//   --selftest    synthetic frames with known answers
//
// THE METRICS, all taken in LINEAR light inside ONE frame, because a ratio on
// sRGB-encoded values drifts ~20% under an exposure change (CLAUDE.md) and the
// arms of a lens sweep do not share an exposure with the build they replace.
//
//   lensPaint   median linear luma over the headlamp's own projected pixels,
//               over the median of the NOSE PAINT between the two lamps. Same
//               material plane, same height, same shading, so a difference is
//               the lens and not the angle of the surface it sits on.
//   clipPct     reported beside it, because the linear-light invariance is exact
//               only while nothing clips.
//   wheel       rimTyre / rimCoV / hubPeak / hubFrac on the ellipse the rim and
//               tyre vertices actually project to, plus wheel-mask's
//               tyre/outside check on that same ellipse.
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const LUT = new Float64Array(256);
for (let i = 0; i < 256; i++) { const c = i / 255; LUT[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }

/** Guard the stride ONCE per image. channels is 3 here, not 4. */
export function checkStride(img) {
  if (img.data.length !== img.width * img.height * img.channels) {
    throw new Error(`buffer ${img.data.length} != ${img.width}*${img.height}*${img.channels} — stride wrong`);
  }
  return img;
}
function linLuma(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  const r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
  if (r === undefined || g === undefined || b === undefined) throw new Error('out of buffer — stride wrong?');
  const L = 0.2126 * LUT[r] + 0.7152 * LUT[g] + 0.0722 * LUT[b];
  // NaN loses every > comparison silently, which is the reassuring-wrong-answer
  // shape CLAUDE.md names. Throw instead.
  if (!Number.isFinite(L)) throw new Error(`non-finite luma at ${x},${y}`);
  return L;
}
function clipped(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return img.data[i] >= 250 || img.data[i + 1] >= 250 || img.data[i + 2] >= 250;
}
export function median(a) {
  const s = Float64Array.from(a).sort();
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2] : 0.5 * (s[s.length / 2 - 1] + s[s.length / 2]);
}
export function pct(a, p) {
  const s = Float64Array.from(a).sort();
  if (!s.length) return NaN;
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))];
}

/** Linear luma of every pixel of a rect, plus the clipped fraction. */
export function rectLin(img, r) {
  const L = []; let clip = 0;
  const x0 = Math.max(0, Math.floor(r[0])), x1 = Math.min(img.width - 1, Math.ceil(r[2]));
  const y0 = Math.max(0, Math.floor(r[1])), y1 = Math.min(img.height - 1, Math.ceil(r[3]));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    L.push(linLuma(img, x, y));
    if (clipped(img, x, y)) clip++;
  }
  if (!L.length) throw new Error(`empty rect ${JSON.stringify(r)}`);
  return { L, med: median(L), p95: pct(L, 95), n: L.length, clipPct: 100 * clip / L.length };
}

/**
 * Linear luma at a list of screen points, plus the clipped fraction.
 *
 * Points, not a rectangle, because the regions this tool measures are slanted
 * strips on a curved surface and a bounding box of one is partly bodywork. Each
 * point is the nearest pixel; duplicates are kept, so the median is weighted the
 * way the surface is sampled rather than the way the raster happens to fall.
 */
export function ptsLin(img, pts) {
  const L = []; let clip = 0, off = 0;
  for (const [px, py] of pts) {
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) { off++; continue; }
    L.push(linLuma(img, x, y));
    if (clipped(img, x, y)) clip++;
  }
  if (!L.length) throw new Error('every sample point is off the frame');
  return { L, med: median(L), p95: pct(L, 95), n: L.length, off,
    clipPct: 100 * clip / L.length };
}

/**
 * The four wheel numbers, on an ellipse.
 *
 * The bands are round 4's, unchanged, so this round's figures are comparable
 * with the ones the reviewer set the bar against: rim is rho < 0.55, tyre is
 * rho >= 0.72. rimCoV, hubPeak and hubFrac are all computed INSIDE the rim band
 * and never read the tyre one - which is the whole reason the tyre albedo is a
 * lever that can move rimTyre alone.
 */
export function wheelRead(img, e) {
  checkStride(img);
  const rimL = [], tyreL = [];
  let clip = 0, n = 0;
  const x0 = Math.floor(e.cx - e.rx - 1), x1 = Math.ceil(e.cx + e.rx + 1);
  const y0 = Math.floor(e.cy - e.ry - 1), y1 = Math.ceil(e.cy + e.ry + 1);
  for (let y = Math.max(0, y0); y <= Math.min(img.height - 1, y1); y++) {
    for (let x = Math.max(0, x0); x <= Math.min(img.width - 1, x1); x++) {
      const rho = Math.hypot((x + 0.5 - e.cx) / e.rx, (y + 0.5 - e.cy) / e.ry);
      if (rho > 1.0) continue;
      const L = linLuma(img, x, y);
      if (clipped(img, x, y)) clip++;
      n++;
      if (rho < 0.55) rimL.push(L); else if (rho >= 0.72) tyreL.push(L);
    }
  }
  if (!rimL.length || !tyreL.length) throw new Error('ellipse too small to carry both bands');
  const rimMed = median(rimL), tyreMed = median(tyreL);
  const mean = rimL.reduce((a, b) => a + b, 0) / rimL.length;
  const sd = Math.sqrt(rimL.reduce((a, b) => a + (b - mean) ** 2, 0) / rimL.length);
  return {
    rimN: rimL.length, tyreN: tyreL.length,
    rimTyre: rimMed / tyreMed,
    rimCoV: sd / mean,
    hubPeak: pct(rimL, 95) / rimMed,
    hubFracPct: 100 * rimL.filter((v) => v > 1.3 * rimMed).length / rimL.length,
    rimMedLin: rimMed, tyreMedLin: tyreMed,
    clipPct: 100 * clip / n,
  };
}

/**
 * WHAT FRACTION OF EACH BAND IS ACTUALLY THE MATERIAL IT IS NAMED AFTER?
 *
 * tools/wheel-mask.mjs asks whether an ellipse is on a tyre by comparing two
 * annuli's brightness, and it catches an ellipse sitting on open road. It cannot
 * catch the case this round found, because that case passes it: the RN rear
 * wheel's ellipse reads tyre/outside 0.155, "ON THE TYRE", and yet only 35% of
 * the rho >= 0.72 band responds AT ALL when the tyre's albedo is multiplied by
 * eight. The other 65% is arch, bodywork and road that happen to be dark.
 *
 * So this asks the question directly, with the build's own lever. Two frames
 * differing ONLY in setCarTyre, per band:
 *
 *   respFrac   the fraction of pixels whose luma moved by more than `thr` DN
 *   respMean   the mean move over the whole band, in DN
 *
 * A band that is the material will move nearly everywhere; a band that is half
 * something else will move half. It is the same argument as the geom-audit
 * finding in CLAUDE.md - a tool that replays the build must replay the build's
 * own selection, and the cheap proof is that its counts match - applied to a
 * mask instead of to a census.
 *
 * thr is 0.5 DN, half a display level: below that the two frames are the same
 * pixel and the difference is rounding.
 */
export function bandResponse(imgA, imgB, e, r0, r1, thr = 0.5) {
  checkStride(imgA); checkStride(imgB);
  if (imgA.width !== imgB.width || imgA.height !== imgB.height) throw new Error('frames differ in size');
  const dn = (img, x, y) => { const i = (y * img.width + x) * img.channels;
    const v = 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
    if (!Number.isFinite(v)) throw new Error(`non-finite at ${x},${y}`);
    return v; };
  let n = 0, moved = 0, sum = 0;
  for (let y = Math.floor(e.cy - e.ry - 1); y <= Math.ceil(e.cy + e.ry + 1); y++) {
    for (let x = Math.floor(e.cx - e.rx - 1); x <= Math.ceil(e.cx + e.rx + 1); x++) {
      if (x < 0 || y < 0 || x >= imgA.width || y >= imgA.height) continue;
      const rho = Math.hypot((x + 0.5 - e.cx) / e.rx, (y + 0.5 - e.cy) / e.ry);
      if (rho < r0 || rho > r1) continue;
      const d = dn(imgB, x, y) - dn(imgA, x, y);
      n++; sum += d;
      if (Math.abs(d) > thr) moved++;
    }
  }
  if (!n) throw new Error('empty band');
  return { n, respFrac: moved / n, respMean: sum / n };
}

// ---------------------------------------------------------------- selftest
/**
 * A tail lens's REDNESS statistics over its own projected surface points.
 *
 * Three numbers, and they are the three the round-4 reviewer judged the parked
 * reflector on, so a round-6 sweep is directly comparable with the bar that was
 * set: peak redness (R - max(G,B)), the chromatic STEP over the paint of the
 * same panel at the same height, and the interior CoV of redness, which is what
 * separates a graded lens from a flat decal. The reviewer asked for a step "well
 * above the current +24.8 without returning to the +140.3 flat decal" and for
 * CoV out of the dead-flat 0.003-0.04 band.
 *
 * Redness is used rather than luma because a deep red carries almost none of its
 * level in luma - the tail texel [186,20,10] has luma weight 0.10961 - so a luma
 * ratio understates a red lens by an order of magnitude and would read a lamp
 * and a reflector as nearly the same thing.
 */
export function tailRedness(img, lensPts, paintPts) {
  const red = (px, py) => {
    const x = Math.round(px), y = Math.round(py);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
    const i = (y * img.width + x) * img.channels;
    return img.data[i] - Math.max(img.data[i + 1], img.data[i + 2]);
  };
  const lens = lensPts.map(([x, y]) => red(x, y)).filter((v) => v !== null);
  const paint = paintPts.map(([x, y]) => red(x, y)).filter((v) => v !== null);
  if (!lens.length || !paint.length) throw new Error('tail lens or paint entirely off the frame');
  const mean = lens.reduce((t, v) => t + v, 0) / lens.length;
  const sd = Math.sqrt(lens.reduce((t, v) => t + (v - mean) ** 2, 0) / lens.length);
  return { peak: Math.max(...lens), mean: +mean.toFixed(1), med: median(lens),
    paintMed: median(paint), step: +(median(lens) - median(paint)).toFixed(1),
    cov: +(sd / Math.max(1e-6, Math.abs(mean))).toFixed(4), n: lens.length };
}

/**
 * Connected components of SATURATED RED pixels in a screen band.
 *
 * redness = R - max(G, B), the measure the round-4 reviewer counted parked tail
 * lamps with, on 4-connected runs of at least `minPx`. Exported and separated
 * from the report so it has a self-test: it lives here rather than inline
 * because the quantity it decides - whether a parked car reads as emitting -
 * is a standing constraint on this project, and an inline metric cannot be
 * failed on known-bad input.
 *
 * `peak` is the component's own maximum redness, and it is the number a level
 * change moves. `n` is its area, which a level change moves much less: the blob
 * is the part of the lens above the threshold, so lowering a graded lens shrinks
 * it from the rim inward while the core stays over. A round that reports only
 * the count can therefore halve the emission and see the count unchanged, which
 * is exactly what happened between round 1 (7 blobs, 960 px, peak 200) and
 * round 5 (7 blobs, 427 px, peak 176) - same count, 44% of the area.
 */
export function rednessBlobs(img, opts = {}) {
  const threshold = opts.threshold ?? 120, minPx = opts.minPx ?? 8;
  const W = img.width;
  const y0 = Math.max(0, opts.y0 ?? 430), y1 = Math.min(opts.y1 ?? 900, img.height);
  const seen = new Uint8Array(W * img.height);
  const red = (x, y) => { const i = (y * W + x) * img.channels;
    return img.data[i] - Math.max(img.data[i + 1], img.data[i + 2]); };
  const blobs = [];
  for (let y = y0; y < y1; y++) for (let x = 0; x < W; x++) {
    if (seen[y * W + x] || red(x, y) <= threshold) { seen[y * W + x] = 1; continue; }
    const st = [[x, y]]; seen[y * W + x] = 1;
    const c = { n: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1, peak: 0 };
    while (st.length) {
      const [a, b] = st.pop(); c.n++; c.peak = Math.max(c.peak, red(a, b));
      c.x0 = Math.min(c.x0, a); c.x1 = Math.max(c.x1, a); c.y0 = Math.min(c.y0, b); c.y1 = Math.max(c.y1, b);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = a + dx, ny = b + dy;
        if (nx < 0 || nx >= W || ny < y0 || ny >= y1 || seen[ny * W + nx]) continue;
        seen[ny * W + nx] = 1;
        if (red(nx, ny) > threshold) st.push([nx, ny]);
      }
    }
    if (c.n >= minPx) blobs.push(c);
  }
  return blobs.sort((a, b) => b.n - a.n);
}

function selftest() {
  let f = 0;
  const enc = (v) => { const s = v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(s * 255))); };
  // 1. A lens/paint pair with a KNOWN linear ratio, placed in the BOTTOM QUARTER
  //    so a 4-byte stride walks off the end and throws instead of reading NaN.
  const W = 300, H = 900;
  const mk = (lensLin, paintLin) => {
    const d = new Uint8Array(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const v = (x >= 40 && x < 80 && y >= 800 && y < 820) ? lensLin
        : (x >= 120 && x < 180 && y >= 800 && y < 820) ? paintLin : 0.004;
      const i = (y * W + x) * 3; d[i] = d[i + 1] = d[i + 2] = enc(v);
    }
    return { width: W, height: H, channels: 3, data: d };
  };
  const lensR = [41, 801, 78, 818], paintR = [122, 801, 178, 818];
  for (const [ll, pl, want] of [[0.02, 0.08, 0.25], [0.12, 0.08, 1.5], [0.08, 0.08, 1.0]]) {
    const img = mk(ll, pl);
    const got = rectLin(img, lensR).med / rectLin(img, paintR).med;
    const err = Math.abs(got - want) / want;
    console.log(`  lens ${ll} / paint ${pl}  ->  ${got.toFixed(4)}   want ${want}   err ${(100 * err).toFixed(2)}%`);
    if (err > 0.02) { console.log('FAIL lensPaint is not reading the ratio it claims'); f++; }
  }
  // 2. EXPOSURE INVARIANCE, which is the whole reason the ratio is taken in
  //    linear light. The same content at four stops must give the same ratio;
  //    the sRGB-encoded ratio is printed beside it because "take a ratio" is not
  //    enough on its own - it has to be a ratio in LINEAR light (CLAUDE.md).
  //
  //    AND THE FLOOR IT IS EXACT DOWN TO. The invariance is exact in continuous
  //    linear light; a PNG is 8 bits, and near black one DN is a large fraction
  //    of the value. At sRGB byte n the linear step is about 2.4/(n + 14) of the
  //    level, so a lens sitting at DN 40 carries +/-2.2% from the encode alone
  //    and a ratio of two such carries ~3%. The first cut of this test asserted
  //    1% and failed on its own synthetic frames, which is the test working: the
  //    bound below is derived rather than relaxed, and the bright pair beside it
  //    shows the METRIC is exact once quantisation is out of the way. A
  //    lens/paint difference smaller than the printed floor is not resolved.
  const drift = (a) => 100 * (Math.max(...a) - Math.min(...a)) / (a.reduce((p, q) => p + q, 0) / a.length);
  const srgbByte = (v) => Math.round(255 * (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055));
  const quantPct = (v) => 100 * 2.4 / (srgbByte(v) + 14);
  const run = (lensLin, paintLin, stops) => {
    const lin = [], srgb = [];
    for (const stop of stops) {
      const img = mk(lensLin * stop, paintLin * stop);
      lin.push(rectLin(img, lensR).med / rectLin(img, paintR).med);
      const mean = (r) => { let s = 0, n = 0;
        for (let y = r[1]; y <= r[3]; y++) for (let x = r[0]; x <= r[2]; x++) { s += img.data[(y * W + x) * 3]; n++; }
        return s / n; };
      srgb.push(mean(lensR) / mean(paintR));
    }
    return { lin, srgb };
  };
  const stops = [0.5, 1, 2, 4];
  const dark = run(0.02, 0.08, stops);
  // Half a DN on each of the two levels, added in quadrature over the sweep.
  const floor = stops.reduce((mx, st) => Math.max(mx,
    0.5 * (quantPct(0.02 * st) + quantPct(0.08 * st))), 0);
  console.log(`  linear-light ratio, lens at DN ${srgbByte(0.02)}   ${dark.lin.map((v) => v.toFixed(4)).join(' ')}   drift ${drift(dark.lin).toFixed(2)}%   8-bit floor ${floor.toFixed(2)}%`);
  console.log(`  sRGB-encoded ratio, same frames        ${dark.srgb.map((v) => v.toFixed(4)).join(' ')}   drift ${drift(dark.srgb).toFixed(2)}%`);
  if (drift(dark.lin) > floor) { console.log('FAIL the linear ratio drifted past the 8-bit floor'); f++; }
  if (drift(dark.srgb) < 5) { console.log('FAIL the known-bad sRGB ratio did not drift: the test cannot separate them'); f++; }
  // The same content well clear of the encode floor: here the metric must be
  // exact, and that is what separates "the ratio is invariant" from "the capture
  // is 8 bits".
  const bStops = [1, 1.5, 2];
  const bright = run(0.10, 0.30, bStops);
  const bFloor = bStops.reduce((mx, st) => Math.max(mx,
    0.5 * (quantPct(0.10 * st) + quantPct(0.30 * st))), 0);
  console.log(`  linear-light ratio, lens at DN ${srgbByte(0.10)}  ${bright.lin.map((v) => v.toFixed(4)).join(' ')}   drift ${drift(bright.lin).toFixed(2)}%   8-bit floor ${bFloor.toFixed(2)}%`);
  if (drift(bright.lin) > bFloor) { console.log('FAIL the linear ratio drifted past its own 8-bit floor'); f++; }
  // THE DRIFT TRACKS THE ENCODE, WHICH IS THE POINT. If the residual were the
  // metric rather than the 8 bits, moving the same content four stops up would
  // not shrink it. It does, by the ratio the floor predicts - so a difference
  // larger than the printed floor is the build, and one smaller is not resolved.
  if (!(drift(bright.lin) < drift(dark.lin))) {
    console.log('FAIL drift did not fall when quantisation did: the residual is not the encode'); f++;
  }
  // 3. A KNOWN-BAD LENS RECT: slid 200 px off the lens onto background. It must
  //    NOT come back near the true answer, or a misplaced landmark would pass.
  const img = mk(0.12, 0.08);
  const slid = rectLin(img, [41, 601, 78, 618]).med / rectLin(img, paintR).med;
  console.log(`  lens rect slid 200 px off the car (KNOWN-BAD)  ${slid.toFixed(4)}   want far from 1.50`);
  if (Math.abs(slid - 1.5) < 0.5) { console.log('FAIL a displaced lens rect read the right answer'); f++; }
  // 4. The wheel read, on a synthetic wheel with a KNOWN rim/tyre step, again in
  //    the bottom quarter. A bright rim over a dark tyre must read rimTyre high;
  //    brightening the TYRE alone must lower it and leave the other three alone,
  //    which is the claim this round's wheel change rests on.
  const WW = 240, WH = 900, cx = 120, cy = 800, rx = 11, ry = 22;
  const wheel = (tyreLin) => {
    const d = new Uint8Array(WW * WH * 3);
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      const rho = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      let v = 0.05;                                  // road
      if (rho <= 1.0) v = rho < 0.20 ? 0.09 : rho < 0.55 ? 0.022 : tyreLin;
      const i = (y * WW + x) * 3; d[i] = d[i + 1] = d[i + 2] = enc(v);
    }
    return { width: WW, height: WH, channels: 3, data: d };
  };
  const e = { cx, cy, rx, ry };
  const a = wheelRead(wheel(0.010), e), b = wheelRead(wheel(0.020), e);
  console.log(`  tyre 0.010  rimTyre ${a.rimTyre.toFixed(3)}  rimCoV ${a.rimCoV.toFixed(3)}  hubPeak ${a.hubPeak.toFixed(3)}  hubFrac ${a.hubFracPct.toFixed(1)}%`);
  console.log(`  tyre 0.020  rimTyre ${b.rimTyre.toFixed(3)}  rimCoV ${b.rimCoV.toFixed(3)}  hubPeak ${b.hubPeak.toFixed(3)}  hubFrac ${b.hubFracPct.toFixed(1)}%`);
  if (!(b.rimTyre < a.rimTyre * 0.75)) { console.log('FAIL doubling the tyre did not halve rimTyre'); f++; }
  for (const k of ['rimCoV', 'hubPeak', 'hubFracPct']) {
    if (Math.abs(a[k] - b[k]) > 1e-9) { console.log(`FAIL ${k} moved with the TYRE: the bands are not independent`); f++; }
  }
  // 5. bandResponse must separate a band that IS the material from one that is
  //    half something else. Two synthetic pairs: in the first the whole rho>=0.72
  //    band is tyre and brightens; in the second only its left half is tyre and
  //    the right half is arch that does not move. The second is the case that
  //    passes wheel-mask and is still not a tyre.
  const wheelHalf = (tyreLin) => {
    const d = new Uint8Array(WW * WH * 3);
    for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
      const rho = Math.hypot((x + 0.5 - cx) / rx, (y + 0.5 - cy) / ry);
      let v = 0.05;
      if (rho <= 1.0) v = rho < 0.20 ? 0.09 : rho < 0.55 ? 0.022 : (x < cx ? tyreLin : 0.010);
      const i = (y * WW + x) * 3; d[i] = d[i + 1] = d[i + 2] = enc(v);
    }
    return { width: WW, height: WH, channels: 3, data: d };
  };
  const full = bandResponse(wheel(0.010), wheel(0.030), e, 0.72, 1.0);
  const half = bandResponse(wheelHalf(0.010), wheelHalf(0.030), e, 0.72, 1.0);
  console.log(`  band response, all tyre        ${(100 * full.respFrac).toFixed(0)}% of ${full.n} px moved`);
  console.log(`  band response, half arch       ${(100 * half.respFrac).toFixed(0)}% of ${half.n} px moved  (KNOWN-BAD mask)`);
  if (full.respFrac < 0.9) { console.log('FAIL a band that is all tyre did not respond'); f++; }
  if (half.respFrac > 0.65 || half.respFrac < 0.35) { console.log('FAIL a half-arch band did not read as half'); f++; }
  // 6. wheelRead must REFUSE an ellipse that cannot carry both bands, rather
  //    than quoting a ratio off three pixels.
  let refused = false;
  try { wheelRead(wheel(0.01), { cx, cy, rx: 0.4, ry: 0.4 }); } catch { refused = true; }
  console.log(`  a 0.8 px ellipse is ${refused ? 'REFUSED' : 'ACCEPTED — bad'}`);
  if (!refused) { console.log('FAIL a degenerate ellipse was scored'); f++; }
  // 5b. TAIL REDNESS, on the distinction the whole parked-lamp argument turns on:
  //     a flat decal and a graded lens can carry the SAME mean and the same step
  //     and are not the same thing to look at. Round 4's case rested on exactly
  //     that - it raised the step from +24.8 to +103.9 while taking the interior
  //     CoV from 0.0249 to 0.1935 - so a metric that cannot separate them cannot
  //     check the round it is being used on.
  {
    const w = 200, h = 900;
    const frame = (fill) => {
      const d = new Uint8Array(w * h * 3);
      for (let i = 0; i < w * h; i++) { d[i * 3] = 30; d[i * 3 + 1] = 28; d[i * 3 + 2] = 32; }
      for (let y = 690; y < 710; y++) for (let x = 60; x < 140; x++) {
        const v = fill((x - 60) / 79, (y - 690) / 19);
        const i = (y * w + x) * 3; d[i] = Math.min(255, 30 + v); d[i + 1] = 28; d[i + 2] = 32;
      }
      return { width: w, height: h, channels: 3, data: d };
    };
    const grid = (x0, x1, y0, y1) => { const q = [];
      for (let j = 0; j <= 6; j++) for (let i = 0; i <= 10; i++)
        q.push([x0 + (x1 - x0) * i / 10, y0 + (y1 - y0) * j / 6]);
      return q; };
    const lensPts = grid(62, 138, 692, 708), paintPts = grid(150, 190, 692, 708);
    const flat = tailRedness(frame(() => 120), lensPts, paintPts);
    const grad = tailRedness(frame((u, v) => Math.round(200 *
      (1 - Math.hypot(u * 2 - 1, v * 2 - 1) ** 2) ** 0.6)), lensPts, paintPts);
    const chk2 = (name, ok, got) => { if (!ok) { console.log(`  FAIL ${name}: ${got}`); f++; }
      else console.log(`  ok   ${name}: ${got}`); };
    chk2('tail/flat decal reads flat', flat.cov < 0.05,
      `CoV ${flat.cov}, peak ${flat.peak}, step ${flat.step}`);
    chk2('tail/graded lens reads graded', grad.cov > 0.15,
      `CoV ${grad.cov}, peak ${grad.peak}, step ${grad.step}`);
    // KNOWN-BAD: the lens window slid 200 px off the car onto bare ground. The
    // step must collapse, or the metric is reading the background and calling it
    // a lens - the same failure the headlamp block above tests for.
    const off = tailRedness(frame(() => 120),
      lensPts.map(([x, y]) => [x, y - 200]), paintPts);
    chk2('tail/lens slid off the car (KNOWN-BAD)', Math.abs(off.step) < 5,
      `step ${off.step}, want ~0 against the real ${flat.step}`);
  }

  // 6. THE REDNESS BLOB CENSUS, on the failure it exists to catch.
  //
  //    The census is the instrument for a standing constraint - parked cars must
  //    not read as having their lights on - so its known-bad input is the build
  //    that LOOKS fixed: one whose lens level came down while its core still
  //    saturates. Three synthetic lenses, each a 30x10 graded ellipse on a dark
  //    ground, differing only in peak redness:
  //
  //      lit     peak 200   - a lamp
  //      half    peak 150   - half the emission, core STILL over the threshold
  //      reflect peak  95   - under the threshold everywhere
  //
  //    A census that counted area alone would call `half` a large improvement;
  //    it is 43% of `lit`'s area. It is still a saturated red blob and the
  //    census has to say so. `reflect` must return NOTHING - a census that
  //    reported a blob there would fail a build that had actually complied.
  const lens = (peak) => {
    const w = 400, h = 900, d = new Uint8Array(w * h * 3);
    for (let i = 0; i < w * h; i++) { d[i * 3] = 20; d[i * 3 + 1] = 18; d[i * 3 + 2] = 22; }
    const cx = 200, cy = 700, rx = 15, ry = 5;
    for (let y = cy - ry; y <= cy + ry; y++) for (let x = cx - rx; x <= cx + rx; x++) {
      const rho = Math.hypot((x - cx) / rx, (y - cy) / ry);
      if (rho > 1) continue;
      // Graded, not flat: the whole argument of round 4 was that a lens has a
      // core and a rectangle does not, and a census tuned on a flat patch would
      // not transfer.
      const v = Math.round(peak * (1 - rho * rho) ** 0.6);
      const i = (y * w + x) * 3;
      d[i] = Math.min(255, 22 + v); d[i + 1] = 18; d[i + 2] = 22;
    }
    return { width: w, height: h, channels: 3, data: d };
  };
  const cen = (peak) => rednessBlobs(lens(peak), { threshold: 120, minPx: 8 });
  const rbLit = cen(200), rbHalf = cen(150), rbRefl = cen(95);
  const chk = (name, ok, got) => { if (!ok) { console.log(`  FAIL ${name}: ${got}`); f++; }
    else console.log(`  ok   ${name}: ${got}`); };
  chk('redness/lit saturates', rbLit.length === 1 && rbLit[0].peak >= 190,
    `${rbLit.length} blob(s), peak ${rbLit[0]?.peak}, ${rbLit[0]?.n} px`);
  chk('redness/half STILL saturates (the reassuring failure)',
    rbHalf.length === 1 && rbHalf[0].peak >= 130,
    `${rbHalf.length} blob(s), peak ${rbHalf[0]?.peak}, ${rbHalf[0]?.n} px` +
    (rbLit[0] && rbHalf[0] ? ` = ${(100 * rbHalf[0].n / rbLit[0].n).toFixed(0)}% of lit's area` : ''));
  chk('redness/reflector is clean', rbRefl.length === 0, `${rbRefl.length} blob(s)`);
  // And the peak has to MOVE with the level, or the metric cannot price a fix.
  chk('redness/peak tracks the level',
    rbLit[0] && rbHalf[0] && rbLit[0].peak > rbHalf[0].peak + 30,
    `${rbLit[0]?.peak} -> ${rbHalf[0]?.peak}`);
  // The band is honoured: the same lens above y 430 must not be counted by a
  // census asked for the ground band.
  const above = rednessBlobs(lens(200), { threshold: 120, minPx: 8, y0: 0, y1: 400 });
  chk('redness/band honoured', above.length === 0, `${above.length} blob(s) in y 0-400`);

  console.log(f ? `CAR-LENS SELFTEST FAIL (${f})` : 'CAR-LENS SELFTEST OK');
  process.exit(f ? 1 : 0);
}

const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('/car-lens.mjs');
if (isMain && process.argv.includes('--selftest')) selftest();
else if (isMain && process.argv.includes('--measure')) await measure();
else if (isMain && process.argv.includes('--landmarks')) await landmarks();
else if (isMain && process.argv.includes('--draw')) await draw();
else if (isMain) { console.log('usage: --selftest | --landmarks | --measure <lm.json> <png...> | --draw <lm.json> <png> <out.png> [carId]'); process.exit(2); }

/**
 * Paint the landmarks onto a magnified crop so they can be SEEN landing before
 * a number off them is quoted. Round 4 needed this twice and both times the
 * picture was the thing that settled it: a rim ellipse that reads plausibly and
 * sits on road looks exactly like one that sits on rubber, in the table.
 */
async function draw() {
  const { writePNG } = await import('./crop.mjs');
  const args = process.argv.slice(2).filter((a) => a !== '--draw');
  const [lmFile, inPng, outPng, carId] = args;
  const lm = JSON.parse(fs.readFileSync(lmFile, 'utf8'));
  const img = checkStride(readPNG(inPng));
  const all = [...lm.cars, ...(lm.wheelCars ?? [])];
  const cars = carId ? all.filter((c) => c.id === carId) : all;
  if (!cars.length) throw new Error(`no such car ${carId}`);
  let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
  const grow = (px, py) => { x0 = Math.min(x0, px); y0 = Math.min(y0, py); x1 = Math.max(x1, px); y1 = Math.max(y1, py); };
  for (const c of cars) {
    for (const l of c.lamps) for (const q of l.pts) grow(q[0], q[1]);
    if (c.nose) for (const q of c.nose.pts) grow(q[0], q[1]);
    if (c.bonnet) for (const q of c.bonnet.pts) grow(q[0], q[1]);
    for (const w of c.wheels) { grow(w.ell.cx - w.ell.rx, w.ell.cy - w.ell.ry); grow(w.ell.cx + w.ell.rx, w.ell.cy + w.ell.ry); }
  }
  const pad = 12;
  x0 = Math.max(0, Math.floor(x0 - pad)); y0 = Math.max(0, Math.floor(y0 - pad));
  x1 = Math.min(img.width - 1, Math.ceil(x1 + pad)); y1 = Math.min(img.height - 1, Math.ceil(y1 + pad));
  const cw = x1 - x0 + 1, ch = y1 - y0 + 1;
  const sc = Math.max(1, Math.min(10, Math.floor(1200 / Math.max(cw, ch))));
  const ow = cw * sc, oh = ch * sc, rgb = Buffer.alloc(ow * oh * 3);
  const near = (v, t, tol) => Math.abs(v - t) < tol;
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    const fx = x0 + x / sc, fy = y0 + y / sc;
    const sx = Math.min(img.width - 1, fx | 0), sy = Math.min(img.height - 1, fy | 0);
    const i = (sy * img.width + sx) * img.channels, o = (y * ow + x) * 3;
    let r = img.data[i], g = img.data[i + 1], b = img.data[i + 2];
    for (const c of cars) {
      // The SAMPLE POINTS themselves, at the pixel each one rounds to, so what
      // is drawn is exactly what is read.
      for (const l of c.lamps) for (const q of l.pts) {
        if (Math.round(q[0]) === sx && Math.round(q[1]) === sy) { r = 0; g = 255; b = 255; }
      }
      if (c.nose) for (const q of c.nose.pts) {
        if (Math.round(q[0]) === sx && Math.round(q[1]) === sy) { r = 255; g = 160; b = 0; }
      }
      if (c.bonnet) for (const q of c.bonnet.pts) {
        if (Math.round(q[0]) === sx && Math.round(q[1]) === sy) { r = 255; g = 60; b = 200; }
      }
      for (const w of c.wheels) {
        const rho = Math.hypot((fx - w.ell.cx) / w.ell.rx, (fy - w.ell.cy) / w.ell.ry);
        for (const [t, col] of [[0.55, [0, 255, 0]], [0.72, [255, 255, 0]], [1.0, [255, 0, 255]]]) {
          if (Math.abs(rho - t) < 0.5 / sc / Math.max(w.ell.rx, 1)) { r = col[0]; g = col[1]; b = col[2]; }
        }
      }
    }
    rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
  }
  writePNG(outPng, ow, oh, rgb);
  console.log(`${outPng} ${ow}x${oh} (crop ${cw}x${ch} at ${x0},${y0}, x${sc})`);
  console.log('  cyan = headlamp sample points   orange = nose paint sample points   green/yellow/magenta = wheel rho 0.55 / 0.72 / 1.0');
}

// ---------------------------------------------------------------- measure
async function measure() {
  const args = process.argv.slice(2).filter((a) => a !== '--measure');
  const [lmFile, ...files] = args;
  const lm = JSON.parse(fs.readFileSync(lmFile, 'utf8'));
  const imgs = files.map((f) => ({ name: f.replace(/^.*\//, '').replace(/\.png$/, ''), img: checkStride(readPNG(f)) }));
  const pad = (s, n) => String(s).padEnd(n);
  console.log(`\n=== FRONT LENS / NOSE PAINT, linear light, ${lm.tod} @ ${lm.camera}`);
  console.log(`  ${pad('car', 28)} ${pad('arm', 9)}  lensMed   noseMed  lens/nose  bonnetMed  lens/bonnet  clip%`);
  for (const c of lm.cars) {
    for (const lamp of c.lamps) {
      for (const { name, img } of imgs) {
        const l = ptsLin(img, lamp.pts), p = ptsLin(img, c.nose.pts);
        const b = c.bonnet && c.bonnet.onScreen ? ptsLin(img, c.bonnet.pts) : null;
        console.log(`  ${pad(`${c.id} ${lamp.side} ${lamp.wpx}x${lamp.hpx}px @${c.dist}m`, 28)} ${pad(name.split('-')[1] ?? name, 9)}` +
          ` ${l.med.toExponential(3)} ${p.med.toExponential(3)} ${String((l.med / p.med).toFixed(3)).padStart(10)}` +
          ` ${b ? b.med.toExponential(3) : '       - '} ${String(b ? (l.med / b.med).toFixed(3) : '-').padStart(12)}` +
          ` ${String(l.clipPct.toFixed(2)).padStart(6)}`);
      }
    }
  }
  // DOES IT READ AS A LIT LAMP? Two censuses, and the second exists because the
  // first CANNOT SEE A TAIL LAMP AND THIS FILE USED TO SAY IT COULD.
  //
  // Clipping is the one absolute the arms share: a pixel at 255 is at 255
  // whatever the exposure, so unlike a luma band it does not walk under an
  // exposure change (CLAUDE.md). That is a good test for a WHITE lamp. It is
  // blind to a red one: the tail texel is [186,20,10] and its green and blue
  // never come near 250, so no red tail lamp at any level clips this test. The
  // heading above this block used to read "the band the reviewer counted
  // saturated tail blobs in" - and the reviewer's criterion was REDNESS > 120,
  // a different quantity entirely. Run on three frames spanning the whole
  // parked-lamp history - round 1 with the lamps lit, the hard `setScalar(0)`
  // fix, and the round-5 retroreflector - it returned 2 blobs / 23 px / the same
  // two coordinates for all three. Byte-identical answers on three frames that
  // differ by a factor of nine in lens level is the instrument saying it is
  // looking somewhere else, and it was: those two blobs are a lit shopfront at
  // (988,453), present in every arm, and the parked lamps were never in it.
  //
  // So the redness census below is the one that answers the question the
  // headings claim to answer, and it is the number the round-4 commit quoted
  // (1 -> 7 blobs) and the number the standing "parked cars must not have their
  // lights on" constraint is about.
  console.log(`\n=== CLIPPED-WHITE BLOBS in the ground band y 430-900 (sees a white lamp; CANNOT see a red one)`);
  for (const { name, img } of imgs) {
    const W = img.width, seen = new Uint8Array(W * img.height);
    const isClip = (x, y) => { const i = (y * W + x) * img.channels;
      return img.data[i] >= 250 && img.data[i + 1] >= 250 && img.data[i + 2] >= 250; };
    const blobs = [];
    for (let y = 430; y < Math.min(900, img.height); y++) for (let x = 0; x < W; x++) {
      if (seen[y * W + x] || !isClip(x, y)) { seen[y * W + x] = 1; continue; }
      const st = [[x, y]]; seen[y * W + x] = 1;
      const c = { n: 0, x0: 1e9, x1: -1, y0: 1e9, y1: -1 };
      while (st.length) {
        const [a, b] = st.pop(); c.n++;
        c.x0 = Math.min(c.x0, a); c.x1 = Math.max(c.x1, a); c.y0 = Math.min(c.y0, b); c.y1 = Math.max(c.y1, b);
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = a + dx, ny = b + dy;
          if (nx < 0 || nx >= W || ny < 430 || ny >= Math.min(900, img.height) || seen[ny * W + nx]) continue;
          seen[ny * W + nx] = 1;
          if (isClip(nx, ny)) st.push([nx, ny]);
        }
      }
      blobs.push(c);
    }
    blobs.sort((a, b) => b.n - a.n);
    console.log(`  ${pad(name, 32)} ${String(blobs.length).padStart(3)} blobs, ${String(blobs.reduce((t, c) => t + c.n, 0)).padStart(5)} px` +
      (blobs.length ? `   largest ${blobs.slice(0, 3).map((c) => `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1}@${c.x0},${c.y0}`).join(' ')}` : ''));
  }
  // SATURATED RED BLOBS, which is the parked tail lamp's own test.
  //
  // redness = R - max(G, B), the reviewer's measure, on a 4-connected component
  // of at least MINPX pixels in the same ground band. A retroreflector returns
  // light and a lamp emits it, and the line between them that this project can
  // actually hold is saturation: signage.js's rule for every retroreflective
  // cheat here is that it stays BELOW the bloom threshold, "a stop sign that
  // blooms reads as a lamp, which is worse than one that reads as slightly
  // self-lit". A blob census is the frame-level form of that rule.
  //
  // Traffic signals and the moving fleet's own tail lamps land in this census
  // too and SHOULD - they are lit. The landmark file's parked-car positions are
  // what separates them: a blob within 40 px of a parked car's projected nose
  // or deck is on a parked car, and a parked car is the one thing in the frame
  // that must not be emitting. That attribution is printed, not assumed.
  // THE GREENHOUSE. Slot 10 is roughness 0.06 / metalness 0.86 with a near-black
  // albedo, so almost everything it shows is the environment reflection scaled by
  // trafficCarMaterial's envMapIntensity - 1.2, against the PLAYER car's 2.6. The
  // number to watch is glass/paint in linear light on the same instance in the
  // same frame, which is exposure-invariant by construction; an absolute level
  // is not comparable between builds (CLAUDE.md) and this one spans 1/22100 at
  // noon to 1/5 at night.
  //
  // p90 is printed beside the median because a greenhouse is not uniform: a
  // windscreen catching one street lamp along its top edge can sit 60x its own
  // median, and a round that moved only that edge would look like a fix.
  if ((lm.glassCars ?? []).length) {
    console.log(`\n=== GREENHOUSE, linear light, ${lm.tod} @ ${lm.camera}`);
    console.log(`  ${pad('car', 28)} ${pad('arm', 10)}  glassMed  glassP90  paintMed  glass/paint  p90/paint  clip%`);
    for (const c of lm.glassCars) {
      for (const { name, img } of imgs) {
        let g, q; try { g = ptsLin(img, c.glass.pts); q = ptsLin(img, c.paintAll.pts); }
        catch (e) { console.log(`  ${pad(c.id, 28)} ${pad(name, 10)} ${e.message}`); continue; }
        console.log(`  ${pad(`${c.id} ${c.glass.wpx}x${c.glass.hpx}px @${c.dist}m (${c.glass.tris}t)`, 28)}` +
          ` ${pad(name.split('-')[1] ?? name, 10)} ${g.med.toExponential(3)} ${g.p95.toExponential(3)}` +
          ` ${q.med.toExponential(3)} ${String((g.med / q.med).toFixed(4)).padStart(12)}` +
          ` ${String((g.p95 / q.med).toFixed(3)).padStart(10)} ${String(g.clipPct.toFixed(2)).padStart(6)}`);
      }
    }
  } else {
    console.log(`\n=== GREENHOUSE: this landmarks file carries no glassCars — regenerate with --landmarks`);
  }

  // THE TAIL LENS ITSELF, per car, which is the subject the blob census only sees
  // the shadow of. A landmarks file written before tailCars existed has none, and
  // the table says so rather than printing nothing and looking complete.
  if ((lm.tailCars ?? []).length) {
    console.log(`\n=== TAIL LENS REDNESS, ${lm.tod} @ ${lm.camera}   (round-4 bar: step >> +24.8, CoV out of 0.003-0.04)`);
    console.log(`  ${pad('car', 28)} ${pad('arm', 10)}  peak  mean   med  paint   step     CoV   n`);
    for (const c of lm.tailCars) {
      for (const t of c.tails) {
        if (!t.onScreen) continue;
        for (const { name, img } of imgs) {
          let r; try { r = tailRedness(img, t.pts, c.tailPaint.pts); }
          catch (e) { console.log(`  ${pad(`${c.id} ${t.side}`, 28)} ${pad(name, 10)} ${e.message}`); continue; }
          console.log(`  ${pad(`${c.id} ${t.side} ${t.wpx}x${t.hpx}px @${c.dist}m`, 28)} ${pad(name.split('-')[1] ?? name, 10)}` +
            ` ${String(r.peak).padStart(5)} ${String(r.mean).padStart(5)} ${String(r.med).padStart(5)}` +
            ` ${String(r.paintMed).padStart(6)} ${String(r.step).padStart(6)} ${String(r.cov).padStart(7)} ${String(r.n).padStart(3)}`);
        }
      }
    }
  } else {
    console.log(`\n=== TAIL LENS REDNESS: this landmarks file carries no tailCars — regenerate with --landmarks`);
  }

  const REDNESS = 120, MINPX = 8;
  console.log(`\n=== SATURATED RED BLOBS, redness>${REDNESS}, n>=${MINPX}, ground band y 430-900`);
  console.log(`  ${pad('frame', 32)} blobs   px   onParked  largest`);
  if (!(lm.fleet ?? []).length) {
    console.log(`  (this landmarks file predates lm.fleet: ${(lm.cars ?? []).length} nose-on and ` +
      `${(lm.wheelCars ?? []).length} side-on subjects, no tail-on cars, so onParked is n/a)`);
  }
  // ATTRIBUTION BY THE CAR'S WHOLE SCREEN EXTENT, NOT BY A CENTROID. The first
  // cut of this took the mean of the lamp, nose and bonnet points and asked for
  // a blob within 40 px of it. Every one of those landmarks is on the NOSE, and
  // the tail lenses this census is about sit at the other end of the car - the
  // near kerb car's are at x 1115 and x 1195 against a nose centroid near x 170.
  // So it reported onParked 0 on a frame with two tail blobs sitting squarely on
  // a parked car, which is the reassuring direction and therefore the dangerous
  // one. The extent is the union of every landmark this car carries INCLUDING
  // its wheel ellipses, which are what actually span its length, padded by 8 px.
  // Attribution comes from lm.fleet - every filled parked instance, by the screen
  // bbox of every vertex it carries. A landmarks file written before that field
  // existed has only the SUBJECT lists, which cannot see a tail-on car, so the
  // column reads n/a rather than a 0 that would be read as "none".
  const PAD = 8;
  const parkedAt = (lm.fleet ?? []).map((f) => ({ id: f.id,
    x0: f.rect[0] - PAD, y0: f.rect[1] - PAD, x1: f.rect[2] + PAD, y1: f.rect[3] + PAD }));
  const canAttribute = parkedAt.length > 0;
  for (const { name, img } of imgs) {
    const blobs = rednessBlobs(img, { threshold: REDNESS, minPx: MINPX });
    const near = (c) => { const mx = (c.x0 + c.x1) / 2, my = (c.y0 + c.y1) / 2;
      return parkedAt.find((p) => mx >= p.x0 && mx <= p.x1 && my >= p.y0 && my <= p.y1); };
    const onParked = canAttribute ? blobs.filter(near) : null;
    console.log(`  ${pad(name, 32)} ${String(blobs.length).padStart(5)} ${String(blobs.reduce((t, c) => t + c.n, 0)).padStart(5)}` +
      ` ${String(onParked ? onParked.length : 'n/a').padStart(9)}   ` +
      blobs.slice(0, 3).map((c) => `${c.x1 - c.x0 + 1}x${c.y1 - c.y0 + 1}@${c.x0},${c.y0} pk${c.peak}${near(c) ? ` [${near(c).id}]` : ''}`).join('  '));
  }

  console.log(`\n=== WHEELS (rim rho<0.55, tyre rho>=0.72), bands rimCoV .31-.54  hubPeak 1.5-1.7  hubFrac 8-29%  rimTyre ~1.0`);
  console.log(`  ${pad('wheel', 28)} ${pad('arm', 10)} rimTyre  rimCoV  hubPeak  hubFrac%  tyre/outside  clip%`);
  const { onTyre } = await import('./wheel-mask.mjs');
  for (const c of (lm.wheelCars ?? lm.cars)) {
    for (const w of c.wheels) {
      for (const { name, img } of imgs) {
        let r; try { r = wheelRead(img, w.ell); } catch (e) { console.log(`  ${pad(`${c.id} ${w.id}`, 28)} ${pad(name, 10)} ${e.message}`); continue; }
        const ot = onTyre(img, w.ell);
        console.log(`  ${pad(`${c.id} ${w.id} ${w.wpx}x${w.hpx}px @${c.dist}m`, 28)} ${pad(name.split('-')[1] ?? name, 10)}` +
          ` ${String(r.rimTyre.toFixed(3)).padStart(7)} ${String(r.rimCoV.toFixed(3)).padStart(7)} ${String(r.hubPeak.toFixed(3)).padStart(8)}` +
          ` ${String(r.hubFracPct.toFixed(1)).padStart(9)} ${String(ot.ratio.toFixed(3)).padStart(13)} ${String(r.clipPct.toFixed(2)).padStart(6)}  ${ot.verdict}`);
      }
    }
  }
}

// ---------------------------------------------------------------- landmarks
async function landmarks() {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  // Its own port. 8123 belongs to the main tree and ensureServer reuses a live
  // server, which is how this project twice compared a build against itself.
  const PORT = Number(process.env.CL_PORT ?? 8524);
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  page.on('pageerror', (e) => console.log('PAGE ERROR', e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null,
    { timeout: Number(process.env.CL_BOOT ?? 240000) });
  const tod = process.env.CL_TOD ?? 'dusk';
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  // The corridor camera, identical to tools/hero-shots.mjs's. Its `back` is
  // NEGATIVE, so hero-shots' pull-in loop breaks on its first iteration and the
  // placement is the closed form below; the tool asserts that rather than
  // assuming it, because a camera that is not the reviewers' camera measures a
  // different frame.
  const cfg = { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 };
  const out = await page.evaluate((c) => {
    const r = __district.district.meta.route, a = r[c.wpA], b = r[c.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const px = a.x - (dx / len) * c.back, pz = a.z - (dz / len) * c.back;
    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam([px, c.height, pz], [a.x + (dx / len) * c.fwd, c.tgtY, a.z + (dz / len) * c.fwd], c.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { camX: +px.toFixed(1), camZ: +pz.toFixed(1) };
  }, cfg);
  // Let the district settle on RENDERED FRAMES, never on wall clock.
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 30, f0, { timeout: 300000, polling: 200 });

  const data = await page.evaluate(() => {
    const cam = __district.camera, p = __district.furniture.parked;
    cam.updateMatrixWorld();
    const W = 1600, H = 900;
    // Column-major: element(row,col) = elements[col*4+row]. M = P * V.
    const PM = cam.projectionMatrix.elements, VM = cam.matrixWorldInverse.elements;
    const M = new Array(16).fill(0);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
      let s = 0; for (let k = 0; k < 4; k++) s += PM[k * 4 + i] * VM[j * 4 + k];
      M[j * 4 + i] = s;
    }
    const proj = (x, y, z) => {
      const cx = M[0] * x + M[4] * y + M[8] * z + M[12];
      const cy = M[1] * x + M[5] * y + M[9] * z + M[13];
      const cw = M[3] * x + M[7] * y + M[11] * z + M[15];
      if (cw <= 0) return null;
      return [(cx / cw * 0.5 + 0.5) * W, (1 - (cy / cw * 0.5 + 0.5)) * H];
    };
    const geo = p.mesh.geometry, pos = geo.getAttribute('position'), uv = geo.getAttribute('uv');
    // The index buffer, for slotPatch below. The traffic car IS indexed (3,150
    // indices over 637 vertices); a non-indexed geometry would make every
    // triangle its own three vertices and the mixed-triangle count meaningless,
    // so say so rather than sampling something else.
    const idx = geo.index;
    if (!idx) throw new Error('traffic car geometry is not indexed; slotPatch cannot walk its triangles');
    const slotOf = (i) => Math.round(uv.getX(i) * 16 - 0.5);
    // The counts this file's header promises. Read off the geometry, not hoped for.
    const counts = {};
    for (let i = 0; i < uv.count; i++) { const s = slotOf(i); counts[s] = (counts[s] ?? 0) + 1; }
    const fleet = [];
    const cars = [];
    const camPos = [cam.position.x, cam.position.y, cam.position.z];
    for (let inst = 0; inst < p.filled; inst++) {
      // Straight off the attribute's backing array. instanceMatrix is a
      // BufferAttribute, not a Matrix4: .toArray() on it is a TypeError, which
      // is how the first run of this tool died.
      const arr = []; for (let k = 0; k < 16; k++) arr[k] = p.mesh.instanceMatrix.array[inst * 16 + k];
      const xf = (x, y, z) => [
        arr[0] * x + arr[4] * y + arr[8] * z + arr[12],
        arr[1] * x + arr[5] * y + arr[9] * z + arr[13],
        arr[2] * x + arr[6] * y + arr[10] * z + arr[14]];
      const px0 = arr[12], pz0 = arr[14];
      const dist = Math.hypot(px0 - camPos[0], pz0 - camPos[2]);
      // Car-local +Z is the nose. A headlamp is only a subject if the nose is
      // pointing at the camera; a car parked the other way shows none.
      const fwd = [arr[8], arr[9], arr[10]];
      const toCam = [camPos[0] - px0, 0, camPos[2] - pz0];
      const facing = (fwd[0] * toCam[0] + fwd[2] * toCam[2]) / (Math.hypot(toCam[0], toCam[2]) || 1);
      const bbox = (pred) => {
        let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, n = 0;
        for (let i = 0; i < pos.count; i++) {
          const lx = pos.getX(i), ly = pos.getY(i), lz = pos.getZ(i);
          if (!pred(slotOf(i), lx, ly, lz)) continue;
          const w = xf(lx, ly, lz), s = proj(w[0], w[1], w[2]);
          if (!s) continue;
          n++;
          x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]);
          y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]);
        }
        return n ? { rect: [x0, y0, x1, y1], n } : null;
      };
      // SAMPLED AS A GRID OF PROJECTED SURFACE POINTS, NOT AS A BOUNDING BOX.
      //
      // The first cut of this took the screen bbox of each slot's vertices. It
      // is wrong twice over and the second way is worse. A headlamp band is a
      // SLANTED strip, so its bbox contains bodywork at two corners; and the
      // nose paint between the lamps has vertex columns only at x = 0 and
      // x = +/-0.53, so its bbox came out 0.6 px WIDE - a sample of one column
      // of pixels, quoted as a median. Both failures produce a number.
      //
      // So each region is a parametric patch of the surface the build emitted,
      // sampled on a grid and INSET from its own edges, and what is stored is
      // the list of screen points. Inset because a boundary pixel is a blend of
      // the lens and whatever is behind it, and at 5 px tall a lens is mostly
      // boundary.
      const INSET = 0.16;
      const gridOf = (corners, nu, nv) => {
        // corners = [p00, p10, p01, p11] in car-local; bilinear in (u, v).
        const pts = [];
        for (let iv = 0; iv < nv; iv++) for (let iu = 0; iu < nu; iu++) {
          const u = INSET + (1 - 2 * INSET) * (nu === 1 ? 0.5 : iu / (nu - 1));
          const v = INSET + (1 - 2 * INSET) * (nv === 1 ? 0.5 : iv / (nv - 1));
          const q = [0, 1, 2].map((k) =>
            (1 - u) * (1 - v) * corners[0][k] + u * (1 - v) * corners[1][k] +
            (1 - u) * v * corners[2][k] + u * v * corners[3][k]);
          const w = xf(q[0], q[1], q[2]), sp = proj(w[0], w[1], w[2]);
          if (sp) pts.push([+sp[0].toFixed(1), +sp[1].toFixed(1)]);
        }
        return pts;
      };
      // The headlamp band's own four corners, read off the 12 headlight
      // vertices: two columns (inboard / outboard) by three rows (low / mid /
      // high), of which the corners are the extremes. Sorting by |x| and then
      // by y is the build's own ordering - overlayBand emits row by row.
      const slotVerts = (slot, side) => {
        const v = [];
        for (let i = 0; i < pos.count; i++) {
          if (slotOf(i) !== slot) continue;
          const x = pos.getX(i);
          if (side * x <= 0) continue;
          v.push([x, pos.getY(i), pos.getZ(i)]);
        }
        return v;
      };
      const lampVerts = (side) => slotVerts(4, side);
      const lamps = [];
      for (const side of [-1, 1]) {
        const v = lampVerts(side);
        if (v.length !== 6) continue;                  // 6 a side; anything else is not this geometry
        const rows = [...new Set(v.map((q) => +q[1].toFixed(3)))].sort((a, b) => a - b);
        const at = (row, inboard) => {
          const cand = v.filter((q) => Math.abs(q[1] - row) < 1e-3);
          cand.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
          return inboard ? cand[0] : cand[cand.length - 1];
        };
        const corners = [at(rows[0], true), at(rows[0], false),
          at(rows[rows.length - 1], true), at(rows[rows.length - 1], false)];
        const pts = gridOf(corners, 7, 5);
        if (pts.length < 20) continue;
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        lamps.push({ side: side < 0 ? 'L' : 'R', pts, verts: v.length,
          wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) });
      }
      // A SLOT'S OWN TRIANGLES, SAMPLED AT BARYCENTRIC INTERIOR POINTS.
      //
      // Every other subject in this file is a QUAD fitted to a slot's corner
      // vertices, which works for a headlamp band, a nose strip and a tail lens
      // because each is a flat patch with a known two-column-by-n-row layout.
      // The glazing is not: 26 vertices wrapping windscreen, side and backlight,
      // with inset chamfer rings at z 0.5, 0.2, -1.16 and -1.42 whose x is WIDER
      // than the rings either side of them. Fitting a quad to its extremes would
      // cut across the roof and the pillars, and the number would look fine.
      //
      // So sample the triangles the build actually emitted. A barycentric point
      // strictly inside a triangle is on that triangle's material by
      // construction - no topology has to be guessed and no threshold chosen.
      //
      // MIXED TRIANGLES ARE SKIPPED AND COUNTED. Slot 0 has 56 of its 500
      // triangles sharing a vertex with another slot, and slot 1 has 48 of 168;
      // a centroid inside one of those is a blend. Slot 10 has 20 triangles and
      // NONE mixed, which is why this is safe for the glazing - and the count is
      // printed so a slot where it is not safe says so instead of quietly
      // averaging in the trim.
      const slotPatch = (slot, sub = 3) => {
        const pts = []; let tris = 0, mixed = 0;
        for (let t = 0; t < idx.count; t += 3) {
          const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2);
          if (slotOf(a) !== slot && slotOf(b) !== slot && slotOf(c) !== slot) continue;
          if (slotOf(a) !== slot || slotOf(b) !== slot || slotOf(c) !== slot) { mixed++; continue; }
          tris++;
          const P = [a, b, c].map((i) => [pos.getX(i), pos.getY(i), pos.getZ(i)]);
          for (let i = 1; i < sub; i++) for (let j = 1; i + j < sub; j++) {
            const u = i / sub, v = j / sub, w = 1 - u - v;
            const q = [0, 1, 2].map((k) => u * P[0][k] + v * P[1][k] + w * P[2][k]);
            const W = xf(q[0], q[1], q[2]), sp = proj(W[0], W[1], W[2]);
            if (sp) pts.push([+sp[0].toFixed(1), +sp[1].toFixed(1)]);
          }
        }
        if (!pts.length) return null;
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        return { pts, tris, mixed,
          wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) };
      };
      // The greenhouse, and the car's own paint as its denominator. Both from the
      // same instance in the same frame, so a ratio between them is the material
      // and not the hour.
      const glass = slotPatch(10, 4);
      const paintAll = slotPatch(0, 2);

      // THE TAIL LAMPS, which are the lenses the "parked cars must not have their
      // lights on" constraint is actually about and which this file has never
      // carried. Slot 5, 9 vertices a side in a 3x3 grid at x 0.281/0.527/0.773,
      // y 0.643/0.707/0.772, z -2.26, so the same corner-extremes construction
      // the headlamp uses reads them - `at` sorts by |x| and takes the ends,
      // which is right for three columns as well as two.
      //
      // The FACING TEST IS THE OPPOSITE ONE. A headlamp is a subject when the
      // nose points at the camera; a tail lamp is a subject when it points away.
      // Every landmarks file written before this carried only nose-on and side-on
      // cars, so the one kind of car whose rear lens can show red was in neither
      // list - which is how a blob census reported 0 parked blobs in a frame with
      // two of them.
      const tails = [];
      for (const side of [-1, 1]) {
        const v = slotVerts(5, side);
        if (v.length !== 9) continue;                  // 9 a side; anything else is not this geometry
        const rows = [...new Set(v.map((q) => +q[1].toFixed(3)))].sort((a, b) => a - b);
        const at = (row, inboard) => {
          const cand = v.filter((q) => Math.abs(q[1] - row) < 1e-3);
          cand.sort((a, b) => Math.abs(a[0]) - Math.abs(b[0]));
          return inboard ? cand[0] : cand[cand.length - 1];
        };
        const corners = [at(rows[0], true), at(rows[0], false),
          at(rows[rows.length - 1], true), at(rows[rows.length - 1], false)];
        const pts = gridOf(corners, 7, 5);
        if (pts.length < 20) continue;
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        tails.push({ side: side < 0 ? 'L' : 'R', pts, verts: v.length,
          wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) });
      }
      // THE TAIL PAINT, the strip of body colour between the two tail lamps, and
      // it is the right denominator for the same reason the nose strip is: the
      // rear centre column carries paint vertices at y 0.645/0.707/0.769 against
      // the lamps' 0.643/0.707/0.772 - the same panel at the same height, so a
      // difference between them is the material and not the angle.
      const tailPaint = (() => {
        const col = [];
        for (let i = 0; i < pos.count; i++) {
          if (slotOf(i) !== 0) continue;
          if (Math.abs(pos.getX(i)) > 1e-3 || pos.getZ(i) > -1.9) continue;
          col.push([pos.getY(i), pos.getZ(i)]);
        }
        col.sort((a, b) => a[0] - b[0]);
        // Only the rows at the lamps' own height; the column also carries the
        // boot lid at y 0.985 and 1.019, which faces the SKY and is a different
        // surface in exactly the way the bonnet comment warns about.
        const band = col.filter((q) => q[0] <= 0.85);
        if (band.length < 2) return null;
        const lo = band[0], hi = band[band.length - 1];
        const corners = [[-0.24, lo[0], lo[1]], [0.24, lo[0], lo[1]],
          [-0.24, hi[0], hi[1]], [0.24, hi[0], hi[1]]];
        const pts = gridOf(corners, 9, 5);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        return { pts, rows: band.length,
          wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) };
      })();
      // THE NOSE PAINT: the strip of body colour between the two lamps.
      //
      // The lamps span |x| 0.30 to 0.77, so x in [-0.28, 0.28] is paint and
      // nothing else - the grille is slot 12 and sits below y 0.75, and the trim
      // below that. Its (y, z) profile is the CENTRE PAINT COLUMN the build
      // emitted, so the strip follows the nose's own slope instead of a guessed
      // plane, and it is at the lamps' own height on the lamps' own surface:
      // a difference between them is the material, not the angle of the panel.
      const spine = [];
      for (let i = 0; i < pos.count; i++) {
        if (slotOf(i) !== 0) continue;
        if (Math.abs(pos.getX(i)) > 1e-3 || pos.getZ(i) < 1.9) continue;
        spine.push([pos.getY(i), pos.getZ(i)]);
      }
      spine.sort((a, b) => a[0] - b[0]);
      // THE BONNET TOP, which is the denominator the round-4 reviewer used and
      // the one the "0.75x" is on. It is a different surface from the nose in
      // the way that matters: it faces the SKY, and at dusk the sky is the
      // brightest thing in the scene, so a vertical lens is bound to lose to it.
      // Both are reported, because the nose says what the MATERIAL does and the
      // bonnet says what the reviewer sees.
      const bonnet = (() => {
        const rows = {};
        for (let i = 0; i < pos.count; i++) {
          if (slotOf(i) !== 0) continue;
          // NO ABSOLUTE Y THRESHOLD. The geometry is translated by
          // groundY - CAR.ground before it is instanced, and the parked pool
          // passes groundY = PAD_Y - 0.02 = -0.07, so every y here is 0.07 lower
          // than the same vertex built at groundY 0. The first cut of this block
          // tested y >= 0.9, which is true offline and false for the front
          // bonnet row in the app - and the tool then reported "bonnet -" for
          // every car in the district with nothing else wrong. The top of each z
          // row IS the bonnet, by construction, so take that instead.
          const z = pos.getZ(i);
          if (z < 1.05 || z > 1.98) continue;
          (rows[z.toFixed(3)] ??= []).push(pos.getY(i));
        }
        const zs = Object.keys(rows).map(Number).sort((a, b) => b - a);
        if (zs.length < 2) return null;
        const yAt = (z) => Math.max(...rows[z.toFixed(3)]);
        const zf = zs[0], zb = zs[zs.length - 1];
        const corners = [[-0.52, yAt(zf), zf], [0.52, yAt(zf), zf],
          [-0.52, yAt(zb), zb], [0.52, yAt(zb), zb]];
        const pts = gridOf(corners, 9, 5);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        return { pts, wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) };
      })();
      let nose = null;
      if (spine.length >= 2) {
        const lo = spine[0], hi = spine[spine.length - 1];
        const corners = [[-0.28, lo[0], lo[1]], [0.28, lo[0], lo[1]],
          [-0.28, hi[0], hi[1]], [0.28, hi[0], hi[1]]];
        const pts = gridOf(corners, 9, 5);
        const xs = pts.map((q) => q[0]), ys = pts.map((q) => q[1]);
        nose = { pts, spine: spine.length,
          wpx: +(Math.max(...xs) - Math.min(...xs)).toFixed(1),
          hpx: +(Math.max(...ys) - Math.min(...ys)).toFixed(1),
          onScreen: pts.every((q) => q[0] >= 1 && q[0] <= 1598 && q[1] >= 1 && q[1] <= 898) };
      }
      // WHEELS, FROM THE RIM VERTICES ONLY, SCALED TO THE TYRE.
      //
      // Not from the tyre vertices, and the difference is the whole ellipse. A
      // tyre is 0.224 m WIDE (x -0.892 to -0.668 on the near side) and the rim
      // face is effectively one plane at the outboard end of it, so the screen
      // bbox of the tyre's own vertices carries the tread's far edge as well as
      // its near one. On a car seen at an angle that stretches the ellipse
      // ALONG THE CAR, and an ellipse wider than the wheel puts bodywork and
      // road inside the rho >= 0.72 band the metric calls tyre - which is the
      // exact failure tools/wheel-mask.mjs was written for after round 4.
      //
      // The rim face is 100 vertices in one plane at radius <= RR = 0.252. Its
      // projection IS the wheel disc seen from the camera; scaling it by
      // R / RR = 0.36 / 0.252 = 1.4286 about its own centre gives the outboard
      // tread ring, which is the silhouette a photograph of the wheel has. The
      // scale is the two numbers in CAR, not a fit.
      const TYRE_OVER_RIM = 0.36 / 0.252;
      const wheels = [];
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        // ONLY THE NEAR SIDE. A car's far wheels project perfectly well and land
        // ON ITS OWN BODYWORK, and an ellipse there reads a plausible rim/tyre
        // step off a door. Measured on the first run of this tool: every far-side
        // ellipse came back with 0% of its tyre band responding to an 8x tyre
        // albedo, against 51% on the near side. The near side is the one whose
        // offset from the car's centre points toward the camera.
        const sideW = xf(sx * 0.9, 0, 0), ctrW = xf(0, 0, 0);
        const toCamX = camPos[0] - ctrW[0], toCamZ = camPos[2] - ctrW[2];
        if ((sideW[0] - ctrW[0]) * toCamX + (sideW[2] - ctrW[2]) * toCamZ <= 0) continue;
        const bb = bbox((s, x, y, z) => s === 13 && sx * x > 0 && sz * z > 0);
        if (!bb) continue;
        const [a0, b0, a1, b1] = bb.rect;
        const cx = (a0 + a1) / 2, cy = (b0 + b1) / 2;
        const rx = (a1 - a0) / 2 * TYRE_OVER_RIM, ry = (b1 - b0) / 2 * TYRE_OVER_RIM;
        wheels.push({ id: `${sx < 0 ? 'L' : 'R'}${sz > 0 ? 'F' : 'B'}`, rimVerts: bb.n,
          ell: { cx: +cx.toFixed(2), cy: +cy.toFixed(2), rx: +rx.toFixed(2), ry: +ry.toFixed(2) },
          rimPx: [+(a1 - a0).toFixed(1), +(b1 - b0).toFixed(1)],
          wpx: +(2 * rx).toFixed(1), hpx: +(2 * ry).toFixed(1) });
      }
      // THE WHOLE FLEET, NOT JUST THE SUBJECTS, because the saturated-red blob
      // census has to say WHICH blobs are on a parked car and the subject lists
      // cannot answer that. `cars` holds cars whose NOSE faces the camera and
      // `wheelCars` cars that are side on; a car showing its TAIL - the one
      // whose rear lens a red blob would be - is in neither. Run against the
      // night corridor frame the subject lists placed the near kerb car's nose
      // at x 54-245 while its two saturated tail blobs sat at x 1115 and 1195,
      // and the census dutifully reported 0 blobs on parked cars in a frame with
      // two of them, which is the flattering direction.
      //
      // So this is every filled instance in the frustum, as the screen bbox of
      // EVERY vertex it carries, with no facing test at all.
      const bodyBB = bbox(() => true);
      if (bodyBB) {
        const [bx0, by0, bx1, by1] = bodyBB.rect;
        fleet.push({ id: `p${inst}`, dist: +dist.toFixed(1), facing: +facing.toFixed(2),
          rect: [+bx0.toFixed(1), +by0.toFixed(1), +bx1.toFixed(1), +by1.toFixed(1)],
          verts: bodyBB.n });
      }
      cars.push({ id: `p${inst}`, dist: +dist.toFixed(1), facing: +facing.toFixed(2),
        x: +px0.toFixed(1), z: +pz0.toFixed(1), lamps, nose, bonnet, wheels, tails, tailPaint,
        glass, paintAll });
    }
    return { counts, filled: p.filled, cars, fleet, camPos: camPos.map((v) => +v.toFixed(1)) };
  });
  // THE COUNTS ARE THE PROOF. buildTrafficCarGeometry emits these; an audit that
  // disagrees with the build is looking somewhere else (CLAUDE.md).
  const want = { 4: 12, 5: 18, 8: 100, 13: 100 };
  const bad = Object.entries(want).filter(([s, n]) => data.counts[s] !== n);
  console.log(`parked geometry vertex census: ${JSON.stringify(data.counts)}`);
  if (bad.length) throw new Error(`geometry census disagrees with the build: ${JSON.stringify(bad)}`);
  console.log(`  headlight 12 / taillight 18 / tyre 100 / rim 100 per car — matches buildTrafficCarGeometry`);
  // TWO SUBJECT LISTS, BECAUSE THEY ARE NOT THE SAME CARS.
  //
  // A car that shows its headlamps is pointing AT the camera, and a car pointing
  // at the camera shows its wheels EDGE ON - 5.7 px wide against 24.9 tall at
  // 27 m, of which the rim band is 3 px. A car that shows a wheel worth
  // measuring is side on, and shows no headlamp at all. The first cut of this
  // tool emitted one list filtered on the lamps and carried the wheels along
  // with it, so every wheel it offered was an edge-on sliver - and the reviewer's
  // own wheel table (36x48, 22x30, 56x86 px) is nothing like that shape, which
  // is the tell.
  //
  // So: lamp subjects are filtered on the lamps, wheel subjects on the wheels,
  // and a car may be in both lists or neither.
  for (const c of data.cars) c.lamps = c.lamps.filter((l) => l.onScreen);
  const lampCars = data.cars.filter((c) => c.lamps.length && c.nose && c.nose.onScreen
    && c.facing > 0.2).sort((a, b) => a.dist - b.dist);
  // A wheel is worth measuring when the rim band can carry pixels: rho < 0.55 of
  // the ellipse has to be at least a few across. 4 px of semi-minor axis is the
  // floor, i.e. about 8 px of visible wheel width; below that wheelRead throws
  // rather than quoting, which is the right behaviour and not a subject.
  const wheelCars = data.cars.map((c) => ({
    ...c,
    lamps: [],
    nose: null,
    wheels: c.wheels.filter((w) => w.ell.rx >= 4 && w.ell.ry >= 4
      && w.ell.cx - w.ell.rx > 1 && w.ell.cx + w.ell.rx < 1598
      && w.ell.cy - w.ell.ry > 1 && w.ell.cy + w.ell.ry < 898),
  })).filter((c) => c.wheels.length).sort((a, b) => a.dist - b.dist);
  for (const c of lampCars) c.wheels = [];
  // A THIRD SUBJECT LIST, for the same reason there are two: these are not the
  // same cars. A tail lamp is a subject when the nose points AWAY, which is the
  // exact complement of the headlamp test, so a tail-on car appears in neither
  // of the other lists and a file carrying only those two cannot measure the
  // lens the parked-lamp constraint is about.
  // Cars whose GREENHOUSE is big enough to resolve. 12 px across is about where a
  // window stops being a window and becomes two pixels of dark trim.
  //
  // THE FIRST CUT OF THIS SELECTED NOTHING, on a frame with a 490 px car in it,
  // and printed "0 glass subjects" without saying why. It required
  // paintAll.onScreen, and paintAll is EVERY paint triangle the car carries - so
  // it spans the whole body, and any car even slightly off the frame edge fails
  // it. The nearest parked car runs off the left edge at x < 0, which is exactly
  // why it is the biggest subject available; the test threw away the only car
  // worth measuring, for being large.
  //
  // The glass itself must be fully on screen, because a clipped window would be
  // averaged against nothing. The paint denominator need not: ptsLin already
  // drops off-frame points and reports how many, so a body running off the edge
  // simply contributes fewer samples. The rejects are printed with their reason
  // rather than silently dropped - a selector that returns an empty list should
  // have to say what it rejected.
  const glassRejects = [];
  const glassCars = data.cars
    .filter((c) => {
      const why = !c.glass ? 'no slot-10 patch'
        : !c.glass.onScreen ? `glass clipped (${c.glass.wpx}x${c.glass.hpx}px)`
        : c.glass.wpx < 12 ? `glass ${c.glass.wpx}px < 12`
        : !c.paintAll ? 'no slot-0 patch'
        : null;
      if (why) glassRejects.push(`${c.id} @${c.dist}m: ${why}`);
      return !why;
    })
    .map((c) => ({ id: c.id, dist: c.dist, facing: c.facing, glass: c.glass, paintAll: c.paintAll }))
    .sort((a, b) => a.dist - b.dist);
  const tailCars = data.cars
    .filter((c) => c.facing < -0.35 && c.tails && c.tails.length
      && c.tails.some((t) => t.onScreen && t.wpx >= 3) && c.tailPaint && c.tailPaint.onScreen)
    .map((c) => ({ ...c, lamps: [], nose: null, bonnet: null, wheels: [] }))
    .sort((a, b) => a.dist - b.dist);
  for (const c of lampCars) { c.tails = []; c.tailPaint = null; c.glass = null; c.paintAll = null; }
  const res = { tod, camera: 'corridor', camPos: data.camPos, filled: data.filled,
    counts: data.counts, cars: lampCars, wheelCars, tailCars, glassCars, fleet: data.fleet };
  const outFile = process.env.CL_OUT ?? `docs/car-lens-landmarks-${tod}.json`;
  fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
  console.log(`camera ${JSON.stringify(out)}  parked filled ${data.filled}  nose-on and on screen: ${lampCars.length}` +
    `   wheel subjects: ${wheelCars.length}   tail-on subjects: ${tailCars.length}` +
    `   glass subjects: ${glassCars.length}   fleet in frustum: ${data.fleet.length}`);
  for (const c of glassCars.slice(0, 10)) {
    console.log(`  GLASS  ${c.id} @${c.dist}m facing ${c.facing}  ${c.glass.wpx}x${c.glass.hpx}px ` +
      `(${c.glass.tris} tris, ${c.glass.mixed} mixed)  paint ${c.paintAll.tris} tris`);
  }
  for (const r of glassRejects) console.log(`  glass reject  ${r}`);
  for (const c of tailCars.slice(0, 10)) {
    console.log(`  TAILS  ${c.id} @${c.dist}m facing ${c.facing}  ` +
      c.tails.map((t) => `${t.side} ${t.wpx}x${t.hpx}px`).join(' | ') +
      `  paint ${c.tailPaint.wpx}x${c.tailPaint.hpx}px`);
  }
  for (const c of wheelCars.slice(0, 10)) {
    console.log(`  WHEELS ${c.id} @${c.dist}m facing ${c.facing}  ` +
      c.wheels.map((w) => `${w.id} ${w.wpx}x${w.hpx}px`).join('  '));
  }
  for (const c of lampCars.slice(0, 12)) {
    console.log(`  ${c.id} @${c.dist}m facing ${c.facing}  lamps ${c.lamps.map((l) => `${l.side} ${l.wpx}x${l.hpx}`).join(' | ')}` +
      `  nose ${c.nose.wpx}x${c.nose.hpx}` +
      `  bonnet ${c.bonnet ? `${c.bonnet.wpx}x${c.bonnet.hpx}${c.bonnet.onScreen ? '' : ' OFF'}` : '-'}` +
      `  wheels ${c.wheels.map((w) => `${w.id} ${w.wpx}x${w.hpx}`).join(' ')}`);
  }
  console.log(`wrote ${outFile}`);
  await browser.close();
  process.exit(0);
}
