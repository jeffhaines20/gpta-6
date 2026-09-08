// Does a lit shopfront light anything OUTSIDE its own bay? — issue #45.
//
// The glazing is emissive and reads correctly. Two things a lit shopfront also
// does were missing: it throws light on the PAVEMENT in front of it, and it
// lights the SOFFIT of its own awning. This tool measures both, and it measures
// them as ratios inside one frame, because CLAUDE.md is explicit that a raw
// level is not comparable across builds — the exposure stop moves — while a
// ratio inside one frame survives it.
//
// THE NUMBERS, and which of them is load-bearing.
//
// THE PRIMARY STATEMENT IS PER-SUBJECT AND BEFORE/AFTER. Every arm is compared
// against the both-off arm of the SAME hour, the SAME camera and the SAME
// subject, so the ratio is one surface's own brightness with and without the
// term. Nothing else in the frame moves, so nothing else has to be controlled
// for. It is reported as a median with its full range and an n, plus a count of
// how many DARK subjects moved at all — the control.
//
// The within-frame lit-vs-dark ratios are also printed, and one of them is worth
// distrusting:
//
//   nearFar    the pavement 0.35–1.35 m in front of a tenancy over the pavement
//              1.90–2.70 m in front of the SAME tenancy. Same material, same
//              frame, same lamp, same exposure. NOTE the far band is not
//              spill-free: the painted profile puts 0.104 of peak there against
//              0.517 in the near band, so this ratio UNDER-reports the pool by
//              about 5x. It is quoted because it is the one number that needs no
//              second population at all.
//   litDark    the near band over a LIT tenancy divided by the near band over a
//              DARK one in the same frame — "can you tell which shops are open
//              from the ground".
//   soffit     lit-vs-dark ACROSS DIFFERENT AWNINGS, and it is confounded: a
//              first capture read 0.310, i.e. lit soffits DARKER than dark ones,
//              because the ten awnings in the lit population were different
//              cloth at different angles from the three in the dark one. Sample
//              sizes of 10 and 3 cannot separate a lighting change from a
//              colourway. The soffit's real answer is the per-subject one above.
//
// EVERY MASK IS GEOMETRIC. Not one of them is built by thresholding brightness:
// a luma-thresholded "pavement" mask reselects its own sample the moment the
// frame gets brighter, and would report a real change as zero. The bands are
// world-space rectangles derived from the same edge maths signage.js builds the
// shopfront from, projected through the live camera matrix, and rasterised.
//
// THE FOUR ARMS COME FROM ONE PAGE LOAD. Both terms are additive meshes whose
// level is a material colour, so before / pavement-only / soffit-only / shipped
// are setSpillScale and setSoffitScale on the same frame: the same pixels, the
// same exposure, the same streamed chunks, two uniforms apart. A control
// rectangle of sky is sampled in every arm and must not move, because two arms
// that differ somewhere they should not is a failure that looks like data.
//
// RESOLUTION IS REPORTED, NOT ASSUMED. Every subject carries the pixel area of
// its own bands and its metres-per-pixel, and a subject whose near band is under
// MIN_PX pixels is dropped rather than quoted. An awning soffit 40 m out is a
// couple of pixels; this tool says so instead of averaging it in.
//
//   node tools/shop-spill.mjs --selftest
//   node tools/shop-spill.mjs --census                 offline price, no browser
//   node tools/shop-spill.mjs --cam facing --facing 5 --tod night,dusk
//   node tools/shop-spill.mjs --reduce docs/shop-spill-facing.json
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

// A near band under this many pixels cannot resolve what it is being asked. 60 px
// is about a 12 x 5 patch; below it one paver joint moves the median.
const MIN_PX = 60;

// ---------------------------------------------------------------- sampling
//
// readPNG returns `channels`, and for these screenshots it is 3, not 4. A
// hardcoded 4-byte stride misaligns every sample and reads past the end of the
// buffer in the bottom quarter, where the reads come back undefined -> NaN -
// and NaN loses every `>` comparison silently, so the misread rows report NO
// DIFFERENCE. That is the most dangerous shape a measurement bug can take: the
// wrong answer is the reassuring one. Hence `channels` below and the finite
// check inside the loop, both of which the selftest attacks directly.

const s2l = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };

/** Is (x,y) inside the convex screen polygon `poly` ([[x,y],...] in order)? */
export function inPoly(poly, x, y) {
  let sign = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cr = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]);
    if (cr === 0) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/**
 * Every LINEAR luma inside a screen polygon, sorted.
 *
 * Linear and not encoded, deliberately. The sRGB OETF is not a scale, so a ratio
 * of two encoded values still moves when the exposure does; in linear light an
 * exposure change IS a scale and a ratio of two linear medians is exactly
 * invariant under one. tools/bay-legibility.mjs makes the same argument and the
 * selftest below measures it rather than asserting it.
 */
export function polyLumaLinear(img, poly) {
  const { width: W, height: H, channels: C, data } = img;
  if (data.length < W * H * C) {
    throw new Error(`buffer short: ${data.length} for ${W}x${H}x${C} — stride wrong?`);
  }
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W - 1, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
  const out = [];
  let clipped = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inPoly(poly, x + 0.5, y + 0.5)) continue;
      const i = (y * W + x) * C;
      const v = 0.2126 * s2l(data[i]) + 0.7152 * s2l(data[i + 1]) + 0.0722 * s2l(data[i + 2]);
      if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      if (data[i] >= 254 && data[i + 1] >= 254 && data[i + 2] >= 254) clipped++;
      out.push(v);
    }
  }
  out.sort((a, b) => a - b);
  // The ratio is exactly exposure-invariant only while nothing clips, so the
  // clipped fraction rides along with every sample rather than being assumed
  // zero. An added emissive term that looks right in the framebuffer can be
  // sitting on the ACES white point; a pool that clips is not a pool.
  out.clipPct = out.length ? (100 * clipped) / out.length : 0;
  return out;
}

/**
 * The same thing for a region that MUST have sampled real pixels: a control.
 *
 * A control's whole job is to fail when the arms differ somewhere they should
 * not, and a control that has degenerated to zero samples cannot fail - its
 * median is NaN, NaN loses every comparison silently, and the row goes on
 * reading "no difference" whatever happens to the build. That is the exact shape
 * CLAUDE.md names as the most dangerous measurement bug and the reason
 * tools/arm-diff.mjs throws on a non-finite difference. So this throws, and
 * `--selftest` drives it off the bottom of a frame to prove it does.
 *
 * It cost a real row in a real capture: an earlier version of this file printed
 * `control region ... n/a vs n/a (NaN% apart)` from a stale field, sitting under
 * two healthy sky controls that read 0.00% apart. Nothing was wrong with the
 * capture; everything was wrong with a control that could print that at all.
 */
export function controlLuma(img, poly, what = 'control') {
  const v = polyLumaLinear(img, poly);
  if (v.length < 200) {
    throw new Error(`${what} sampled ${v.length} pixels — a control with no ` +
      'samples cannot fail, so it is not a control. Check the rect is inside the frame.');
  }
  const m = median(v);
  if (!Number.isFinite(m)) throw new Error(`${what} median is ${m} — stride or rect wrong`);
  return m;
}

/**
 * (R - B) / luma inside a polygon, in LINEAR light: how WARM the surface is.
 *
 * The soffit term is a warm additive glow on a surface that was already lit to
 * about the level of the pavement, so what it does is shift the colour more than
 * it raises the level -- the first capture of it measured a x1.11 lift in luma,
 * which is real and small. Chroma is the better instrument for that and it is
 * exposure-invariant for the same reason the level ratios are: an exposure
 * change is a scale in linear light, and this is a ratio of two linear
 * quantities measured on the same pixels.
 *
 * Per-pixel and then medianed, not summed-then-divided: one blown texel in the
 * sample would otherwise carry the whole statistic.
 */
export function polyWarm(img, poly) {
  const { width: W, height: H, channels: C, data } = img;
  if (data.length < W * H * C) throw new Error(`buffer short: ${data.length} — stride wrong?`);
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const [x, y] of poly) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  x0 = Math.max(0, Math.floor(x0)); x1 = Math.min(W - 1, Math.ceil(x1));
  y0 = Math.max(0, Math.floor(y0)); y1 = Math.min(H - 1, Math.ceil(y1));
  const out = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!inPoly(poly, x + 0.5, y + 0.5)) continue;
      const i = (y * W + x) * C;
      const r = s2l(data[i]), g = s2l(data[i + 1]), b = s2l(data[i + 2]);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      if (!Number.isFinite(l)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      if (l > 1e-6) out.push((r - b) / l);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

export const median = (a) => (a.length
  ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2)
  : NaN);

/**
 * The metric itself, over one frame and one subject list.
 *
 * Kept out of the browser half on purpose so the selftest can drive it with
 * synthetic frames and synthetic subjects, which is the only way to know it can
 * detect what it claims to detect.
 */
export function measureFrame(img, subjects) {
  const rows = [];
  for (const s of subjects) {
    // A subject may carry pavement bands, an awning soffit, or both, and the two
    // want opposite viewpoints — see the FACING cameras. A row contributes to
    // whichever of the two it can actually resolve and to nothing else.
    const near = s.near ? polyLumaLinear(img, s.near) : [];
    const mid = s.mid ? polyLumaLinear(img, s.mid) : [];
    const soffit = s.soffit ? polyLumaLinear(img, s.soffit) : [];
    const soffitW = s.soffit ? polyWarm(img, s.soffit) : [];
    const hasBands = near.length >= MIN_PX && mid.length >= MIN_PX;
    const hasSoffit = soffit.length >= MIN_PX;
    if (!hasBands && !hasSoffit) continue;
    rows.push({
      id: s.id, state: s.state, distance: s.distance, mPerPx: s.mPerPx,
      nearPx: hasBands ? near.length : 0, midPx: hasBands ? mid.length : 0,
      soffitPx: hasSoffit ? soffit.length : 0,
      nearClipPct: hasBands ? +near.clipPct.toFixed(2) : null,
      soffitClipPct: hasSoffit ? +soffit.clipPct.toFixed(2) : null,
      near: hasBands ? median(near) : null,
      mid: hasBands ? median(mid) : null,
      nearFar: hasBands ? median(near) / median(mid) : null,
      soffit: hasSoffit ? median(soffit) : null,
      soffitWarm: hasSoffit && soffitW.length ? median(soffitW) : null,
    });
  }
  return rows;
}

/** Median of a plucked field over the rows a predicate selects. */
export function agg(rows, pick, keep = () => true) {
  const v = rows.filter(keep).map(pick).filter((x) => x !== null && Number.isFinite(x));
  v.sort((a, b) => a - b);
  return { n: v.length, med: median(v), lo: v.length ? v[0] : NaN, hi: v.length ? v[v.length - 1] : NaN };
}

const isLit = (r) => r.state === 'lit' || r.state === 'dim';
const isDark = (r) => r.state === 'dark';

export function summarise(rows) {
  return {
    subjects: rows.length,
    lit: rows.filter(isLit).length,
    dark: rows.filter(isDark).length,
    bandRows: rows.filter((r) => r.nearPx > 0).length,
    soffitRows: rows.filter((r) => r.soffitPx > 0).length,
    nearFarLit: agg(rows, (r) => r.nearFar, isLit),
    nearFarDark: agg(rows, (r) => r.nearFar, isDark),
    nearLit: agg(rows, (r) => r.near, isLit),
    nearDark: agg(rows, (r) => r.near, isDark),
    soffitLit: agg(rows, (r) => r.soffit, isLit),
    soffitDark: agg(rows, (r) => r.soffit, isDark),
    maxNearClipPct: Math.max(0, ...rows.map((r) => r.nearClipPct ?? 0)),
    maxSoffitClipPct: Math.max(0, ...rows.map((r) => r.soffitClipPct ?? 0)),
  };
}

// -------------------------------------------------------------------- selftest
if (has('--selftest')) {
  let bad = 0;
  const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); };
  const near1 = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

  // A synthetic frame builder in LINEAR light, encoded to sRGB the way the
  // renderer does, so every test below is on the same footing as a real capture.
  const l2s = (l) => Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055));
  const frame = (W, H, C, fn) => {
    const data = new Uint8Array(W * H * C);
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const b = l2s(Math.max(0, Math.min(1, fn(x, y))));
        const i = (y * W + x) * C;
        for (let c = 0; c < Math.min(3, C); c++) data[i + c] = b;
        if (C === 4) data[i + 3] = 255;
      }
    }
    return { width: W, height: H, channels: C, data };
  };

  // 1. THE STRIDE. The same picture at 3 and at 4 channels must measure the
  //    same, and a 4-byte stride assumed over 3-channel data must not quietly
  //    succeed. Build a 3-channel frame, lie about its channel count, and check
  //    the tool refuses instead of returning a comfortable number.
  const box = [[2, 2], [10, 2], [10, 10], [2, 10]];
  const flat3 = frame(24, 24, 3, () => 0.25);
  const flat4 = frame(24, 24, 4, () => 0.25);
  say(near1(median(polyLumaLinear(flat3, box)), median(polyLumaLinear(flat4, box)), 2e-3),
    `3-channel and 4-channel frames of one picture agree: ` +
    `${median(polyLumaLinear(flat3, box)).toFixed(5)} vs ${median(polyLumaLinear(flat4, box)).toFixed(5)}`);
  let threw = false;
  try { polyLumaLinear({ ...flat3, channels: 4 }, box); } catch { threw = true; }
  say(threw, 'a 4-byte stride over 3-channel data throws instead of reading NaN');

  // 2. THE POLYGON. A rectangle from (2,2) to (10,10) contains the 64 pixel
  //    CENTRES at x+0.5 in 2.5..9.5, and an off-by-one in inPoly or in the bbox
  //    clamp shows up here immediately as 49, 81 or 100.
  say(polyLumaLinear(flat3, box).length === 64,
    `an 8x8 rect selects ${polyLumaLinear(flat3, box).length} pixel centres (expect 64)`);

  // 3. EXPOSURE INVARIANCE, measured rather than claimed. Two bands, then the
  //    whole frame scaled in LINEAR light by 1.9 stops and re-encoded. The raw
  //    levels must move a long way and the RATIO must not.
  const bands = (k) => frame(64, 64, 3, (x, y) => (y < 32 ? 0.30 : 0.06) * k);
  const nb = [[4, 4], [60, 4], [60, 28], [4, 28]], mb = [[4, 36], [60, 36], [60, 60], [4, 60]];
  const r1 = median(polyLumaLinear(bands(1), nb)) / median(polyLumaLinear(bands(1), mb));
  const r2 = median(polyLumaLinear(bands(1 / 3.73), nb)) / median(polyLumaLinear(bands(1 / 3.73), mb));
  const lvl1 = median(polyLumaLinear(bands(1), nb)), lvl2 = median(polyLumaLinear(bands(1 / 3.73), nb));
  say(Math.abs(r1 - r2) / r1 < 0.02 && lvl2 / lvl1 < 0.35,
    `1.9 stops moves the level ${lvl1.toFixed(4)} -> ${lvl2.toFixed(4)} and the ratio ` +
    `${r1.toFixed(3)} -> ${r2.toFixed(3)} (${(100 * Math.abs(r1 - r2) / r1).toFixed(1)}%)`);

  // 4. A LUMA-THRESHOLDED MASK IS THE KNOWN-BAD INPUT, and this is the whole
  //    reason the bands are geometric. Select "pavement" as everything under a
  //    fixed luma, brighten the frame, and the mask reselects: it now excludes
  //    the very pixels that got brighter and reports almost nothing. The
  //    geometric mask sees the real change. Both are computed here so the
  //    difference is a number in the log and not a paragraph.
  const before = bands(1);
  const after = frame(64, 64, 3, (x, y) => (y < 32 ? 0.30 + 0.22 : 0.06));
  const thrMask = (img) => {
    const out = [];
    for (let y = 0; y < 64; y++) {
      for (let x = 0; x < 64; x++) {
        const i = (y * 64 + x) * 3;
        const v = 0.2126 * s2l(img.data[i]) + 0.7152 * s2l(img.data[i + 1]) + 0.0722 * s2l(img.data[i + 2]);
        if (v < 0.34) out.push(v);
      }
    }
    out.sort((a, b) => a - b);
    return median(out);
  };
  const geoMove = median(polyLumaLinear(after, nb)) / median(polyLumaLinear(before, nb));
  const thrMove = thrMask(after) / thrMask(before);
  say(geoMove > 1.6 && Math.abs(thrMove - geoMove) > 0.5,
    `geometric mask sees the injected pool at x${geoMove.toFixed(2)}; ` +
    `a luma-thresholded one reports x${thrMove.toFixed(2)} — it reselected, and ` +
    `excluded the very pixels that got brighter`);

  // 5. CAN THE METRIC FIND THE THING IT IS FOR? Inject a pool into the near band
  //    of the LIT subjects only, leave the dark ones alone, and require the
  //    summary to move by the predicted amount on one population and not at all
  //    on the other. Known-bad: swap `near` and `mid` in a subject and the ratio
  //    must invert, which is the check that catches a v-flip in the band builder.
  const subj = (id, state, x) => ({
    id, state, distance: 12, mPerPx: 0.01,
    near: [[x, 4], [x + 20, 4], [x + 20, 28], [x, 28]],
    mid: [[x, 36], [x + 20, 36], [x + 20, 60], [x, 60]],
    soffit: null,
  });
  const subjects = [subj('L1', 'lit', 2), subj('L2', 'lit', 24), subj('D1', 'dark', 44)];
  const litX = new Set([2, 24]);
  const injected = frame(64, 64, 3, (x, y) => {
    const base = y < 32 ? 0.30 : 0.06;
    for (const x0 of litX) if (x >= x0 && x < x0 + 20 && y < 32) return base + 0.22;
    return base;
  });
  const s0 = summarise(measureFrame(before, subjects));
  const s1 = summarise(measureFrame(injected, subjects));
  say(s1.nearFarLit.med / s0.nearFarLit.med > 1.6 &&
      Math.abs(s1.nearFarDark.med / s0.nearFarDark.med - 1) < 0.02,
    `injected pool moves nearFar(lit) x${(s1.nearFarLit.med / s0.nearFarLit.med).toFixed(2)} ` +
    `and nearFar(dark) x${(s1.nearFarDark.med / s0.nearFarDark.med).toFixed(3)}`);
  const swapped = subjects.map((s) => ({ ...s, near: s.mid, mid: s.near }));
  const sw = summarise(measureFrame(injected, swapped));
  say(sw.nearFarLit.med < 1 && s1.nearFarLit.med > 1,
    `swapping the two bands inverts the ratio ${s1.nearFarLit.med.toFixed(2)} -> ${sw.nearFarLit.med.toFixed(2)}`);

  // 6. THE RESOLUTION GUARD. A subject whose band is smaller than MIN_PX must be
  //    DROPPED, not quoted. This is the rule that stops a 2-pixel awning soffit
  //    40 m out being averaged in with a 900-pixel one at 12 m.
  const tiny = { ...subj('T', 'lit', 2), near: [[2, 2], [7, 2], [7, 7], [2, 7]] };
  say(measureFrame(before, [tiny]).length === 0,
    `a 25-pixel band is dropped rather than quoted (MIN_PX ${MIN_PX})`);

  // 7. THE BAND BUILDER, on both ring windings. bandFor() is the only geometry
  //    in this file and its one job is "outward from the wall". Known-bad: an
  //    edge normal that points INTO the building puts the whole pool inside the
  //    shop, which on screen is invisible and would read as "the change did
  //    nothing".
  const wall = { a: [0, 0], tx: 1, tz: 0, nx: 0, nz: 1, len: 12 };
  const b1 = bandFor(wall, 3, 9, 0.35, 1.35);
  say(b1.every((p) => p[2] > 0) && Math.min(...b1.map((p) => p[2])) > 0.34,
    `the near band is 0.35-1.35 m OUTSIDE the wall: z ${b1.map((p) => p[2].toFixed(2)).join(' ')}`);
  const flipped = { ...wall, nx: 0, nz: -1 };
  const b2 = bandFor(flipped, 3, 9, 0.35, 1.35);
  say(b2.every((p) => p[2] < 0), 'a flipped normal is detectable — every corner lands behind the wall');

  // 8a. THE CHROMA METRIC has to see a warm shift and ignore an exposure change,
  //     which is the whole reason it is a difference of two normalised
  //     quantities. Known-bad: a metric on the ENCODED bytes drifts under an
  //     exposure change, and this asserts ours does not.
  {
    const grey = frame(48, 48, 3, () => 0.2);
    const box2 = [[4, 4], [44, 4], [44, 44], [4, 44]];
    const warmFrame = (k) => {
      const data = new Uint8Array(48 * 48 * 3);
      for (let i = 0; i < 48 * 48; i++) {
        data[i * 3] = l2s(0.30 * k); data[i * 3 + 1] = l2s(0.20 * k); data[i * 3 + 2] = l2s(0.08 * k);
      }
      return { width: 48, height: 48, channels: 3, data };
    };
    const w0 = median(polyWarm(grey, box2));
    const w1 = median(polyWarm(warmFrame(1), box2));
    const w2 = median(polyWarm(warmFrame(1 / 3.73), box2));
    say(Math.abs(w0) < 0.02 && w1 > 0.5,
      `neutral reads ${w0.toFixed(4)}, a warm surface reads ${w1.toFixed(3)}`);
    say(Math.abs(w1 - w2) / w1 < 0.02,
      `1.9 stops moves the chroma ${w1.toFixed(3)} -> ${w2.toFixed(3)} ` +
      `(${(100 * Math.abs(w1 - w2) / w1).toFixed(1)}%)`);
  }

  // 8. THE CONTROL MUST BE ABLE TO FAIL. A rect driven off the bottom of the
  //    frame selects nothing, its median is NaN, and NaN loses every comparison
  //    silently -- so a control in that state reads "no difference" forever.
  //    controlLuma throws instead. Known-bad input: the same rect inside the
  //    frame must come back finite, or this test is passing for the wrong reason.
  let ctlThrew = false;
  try { controlLuma(flat3, [[0, 100], [24, 100], [24, 140], [0, 140]], 'off-frame'); } catch { ctlThrew = true; }
  say(ctlThrew, 'a control rect off the bottom of the frame THROWS rather than reading NaN');
  say(Number.isFinite(controlLuma(frame(64, 64, 3, () => 0.2), [[2, 2], [60, 2], [60, 40], [2, 40]])),
    'the same control inside the frame comes back finite');

  // 9. WHICH END OF THE CELL IS THE WALL, read out of the EMITTED UVs rather
  //    than argued on paper. The two emitters disagree on purpose -- awning()'s
  //    `sr` gives arc position 0 (the wall) the cell's v0, while spillPatch
  //    lists its far corners first and gives the wall v1 -- so the two painters
  //    must paint their bright end at opposite canvas rows. Painting both the
  //    same way put the awning's brightest texels along the HEM, which is a
  //    bright line down the leading edge of every lit canopy and darkness where
  //    the light comes from. No capture can see it: the same energy
  //    redistributed moves the median by about as much. Only this can.
  {
    const grad = { addColorStop() {} };
    const ctx = () => new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'canvas') return { width: 1, height: 1 };
        return (t[k] = (...a) => {
          if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
          if (/Gradient$/.test(k) || k === 'createPattern') return grad;
          if (k === 'getImageData') return { width: 1, height: 1, data: new Uint8ClampedArray(4) };
          return undefined;
        });
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    if (typeof document === 'undefined') {
      globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }) };
    }
    if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };
    const S = await import('../src/signage.js');
    // A straight 12 m wall running +x, outward normal +z, so "metres out from
    // the wall" is just z.
    const e = { a: [0, 0], tx: 1, tz: 0, nx: 0, nz: 1, len: 12, i: 0 };
    const endsOf = (buf) => {
      const v = [];
      for (let i = 0; i < buf.pos.length / 3; i++) v.push({ o: buf.pos[i * 3 + 2], v: buf.uv[i * 2 + 1] });
      v.sort((a, b) => a.o - b.o);
      return { wall: v[0], far: v[v.length - 1] };
    };
    const glow = S.buffers();
    S.awning(e, 2, 8, 4.0, S.shopRect('stripe', 0), S.shopRect('valance', 0), S.buffers(), null,
      { tint: [1, 1, 1], glow, glowRect: S.shopRect('soffit', 0), glowTint: [1, 1, 1] });
    const g = endsOf(glow);
    say(g.wall.v < g.far.v,
      `awning soffit: the wall end (out ${g.wall.o.toFixed(2)} m) takes v ${g.wall.v.toFixed(5)}, ` +
      `the hem (out ${g.far.o.toFixed(2)} m) takes v ${g.far.v.toFixed(5)} — wall is the LOWER v`);
    const pav = S.buffers();
    S.spillPatch(e, 2, 8, pav, S.shopRect('spill', 0), [1, 1, 1]);
    const q = endsOf(pav);
    say(q.wall.v > q.far.v,
      `pavement pool: the wall end (out ${q.wall.o.toFixed(2)} m) takes v ${q.wall.v.toFixed(5)}, ` +
      `the far end (out ${q.far.o.toFixed(2)} m) takes v ${q.far.v.toFixed(5)} — wall is the HIGHER v`);
  }

  console.log(bad ? `\n${bad} SELFTEST FAILURE(S)` : '\nselftest ok');
  process.exit(bad ? 1 : 0);
}

/** The four world corners of a band on the pavement, in edge coordinates. */
export function bandFor(e, s0, s1, o0, o1, y = -0.05) {
  const P = (s, o) => [e.a[0] + e.tx * s + e.nx * o, y, e.a[1] + e.tz * s + e.nz * o];
  return [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)];
}

// ---------------------------------------------------------------------- census
//
// The offline half: what this change costs, counted from data/district.json by
// the same code the streamer runs, with no browser and no run-to-run noise. The
// budget gate's triangle count carries ~20k of it and cannot resolve 1,478.
if (has('--census')) {
  if (typeof document === 'undefined') {
    const grad = { addColorStop() {} };
    const ctx = () => new Proxy({}, {
      get(t, k) {
        if (k in t) return t[k];
        if (k === 'canvas') return { width: 1, height: 1 };
        return (t[k] = (...a) => {
          if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
          if (/Gradient$/.test(k) || k === 'createPattern') return grad;
          if (k === 'getImageData') {
            const w = a[2] | 0 || 1, h = a[3] | 0 || 1;
            return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
          }
          return undefined;
        });
      },
      set(t, k, v) { t[k] = v; return true; },
    });
    globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }) };
  }
  if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };
  const S = await import('../src/signage.js');
  const F = await import('../src/facades.js');
  const G = await import('../src/geom.js');
  const B = await import('../src/build-cost.js');
  const d = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url)));

  const on = S.districtSignageBuffers(d, {
    streetDirFor: (b) => G.streetDirFor(d, b), streetDirsFor: (b) => G.streetDirsFor(d, b, 2),
  });
  const off = S.districtSignageBuffers(d, {
    spill: false, soffit: false,
    streetDirFor: (b) => G.streetDirFor(d, b), streetDirsFor: (b) => G.streetDirsFor(d, b, 2),
  });

  // The state census, by frontage kind, so the implied (unlotted) population is
  // visible rather than folded in. It is 13.9% of tenancies and it is the half
  // that needed facades.js impliedBayStates() exported to be right at all.
  const st = { lotted: {}, implied: {} };
  const awn = { lotted: {}, implied: {} };
  const name = ['none', 'dark', 'dim', 'lit'];
  let tenancies = 0, awnings = 0;
  for (const b of d.buildings) {
    const style = B.capStyle(F.buildingStyle(b), b);
    if (!style?.storefront) continue;
    const plan = S.signPlanFor(b, style,
      { street: G.streetDirFor(d, b), streets: G.streetDirsFor(d, b, 2) });
    for (const t of plan.tenants) {
      const kind = t.lot ? 'lotted' : 'implied';
      const k = name[t.litState] ?? '?';
      st[kind][k] = (st[kind][k] ?? 0) + 1;
      tenancies++;
      if (t.awning) { awn[kind][k] = (awn[kind][k] ?? 0) + 1; awnings++; }
    }
  }
  // WHERE DOES THE POOL ACTUALLY LAND? The decal is a flat rectangle projected
  // outward from a wall and it is NOT clipped to the pavement polygon, so the
  // honest question is how much of it ends up somewhere a pool of light has no
  // business being: inside another building's footprint, most of all, which
  // happens wherever a shopfront faces a narrow lane. Marched along the normal
  // in 0.2 m steps and WEIGHTED BY THE FALLOFF, because a stray texel at 0.05 of
  // peak is not the same defect as a stray texel at 1.0.
  const boxes = d.buildings.map((b) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.p) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); z0 = Math.min(z0, z); z1 = Math.max(z1, z);
    }
    return { p: b.p, x0, x1, z0, z1 };
  });
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const insideAny = (x, z) => {
    for (const b of boxes) {
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (inRing(b.p, x, z)) return true;
    }
    return false;
  };
  const clearance = S.spillClearance(d);
  let wTot = 0, wIn = 0, worst = 0, worstId = '';
  let wTotC = 0, wInC = 0;
  for (const b of d.buildings) {
    const style = B.capStyle(F.buildingStyle(b), b);
    if (!style?.storefront) continue;
    const plan = S.signPlanFor(b, style,
      { street: G.streetDirFor(d, b), streets: G.streetDirsFor(d, b, 2) });
    for (const t of plan.tenants) {
      if (t.litState < 2) continue;
      const e = t.e;
      const free = clearance(e.a[0] + e.tx * t.mid, e.a[1] + e.tz * t.mid, e.nx, e.nz);
      const reach = Math.min(S.SPILL_REACH, free);
      const ships = free >= 0.9;
      let tw = 0, ti = 0, twc = 0, tic = 0;
      for (let u = 0.1; u < 1; u += 0.2) {
        const along = t.s0 - 0.35 + (t.s1 - t.s0 + 0.7) * u;
        for (let k = 0.1; k < 1; k += 0.05) {
          const w = S.spillFalloff(k);
          const P = (o) => [e.a[0] + e.tx * along + e.nx * o, e.a[1] + e.tz * along + e.nz * o];
          const [x, z] = P(k * S.SPILL_REACH);
          tw += w;
          if (insideAny(x, z)) ti += w;
          if (ships) {
            const [xc, zc] = P(k * reach);
            twc += w;
            if (insideAny(xc, zc)) tic += w;
          }
        }
      }
      wTot += tw; wIn += ti; wTotC += twc; wInC += tic;
      if (tw > 0 && ti / tw > worst) { worst = ti / tw; worstId = `${b.i ?? '?'}:${e.i}:${t.slot}`; }
    }
  }

  const atlas = S.shopAtlas();
  console.log('SHOP-SPILL CENSUS  (offline, data/district.json)');
  console.log(`  tenancies ${tenancies}   awnings ${awnings}`);
  console.log(`  lotted   ${JSON.stringify(st.lotted)}   awnings ${JSON.stringify(awn.lotted)}`);
  console.log(`  implied  ${JSON.stringify(st.implied)}   awnings ${JSON.stringify(awn.implied)}`);
  console.log(`  pavement pools      ${on.stats.spills} quads, ${on.stats.spillTriangles} triangles`);
  console.log(`  awning soffit glow  ${on.stats.litSoffits} of ${awnings} awnings, ` +
    `${on.stats.soffitTriangles} triangles`);
  console.log(`  shop signage tris   ${off.stats.shopTriangles} -> ${on.stats.shopTriangles} ` +
    `(delta ${on.stats.shopTriangles - off.stats.shopTriangles})`);
  console.log(`  draw calls          ${off.stats.drawCalls} -> ${on.stats.drawCalls}`);
  console.log(`  shop atlas          ${atlas.W}x${atlas.H}, ${atlas.rects.size} cells, ` +
    `${(atlas.util * 100).toFixed(1)}% used`);
  console.log(`  pool landing INSIDE a building footprint:` +
    `  unclipped ${(100 * wIn / wTot).toFixed(2)}%` +
    `  as shipped ${(100 * wInC / wTotC).toFixed(2)}%` +
    `   (falloff-weighted; worst unclipped tenancy ${(100 * worst).toFixed(1)}%, ${worstId})`);
  console.log(`  tenancies whose pool was dropped for having under 0.9 m in front: ` +
    `${on.stats.spillsDropped}`);
  console.log(`  falloff  t=0 ${S.spillFalloff(0).toFixed(3)}  0.25 ${S.spillFalloff(0.25).toFixed(3)}` +
    `  0.5 ${S.spillFalloff(0.5).toFixed(3)}  0.75 ${S.spillFalloff(0.75).toFixed(3)}` +
    `  1.0 ${S.spillFalloff(1).toFixed(3)}   (t x ${S.SPILL_REACH} m from the wall)`);
  process.exit(0);
}

// ---------------------------------------------------------------------- reduce
if (has('--reduce')) {
  const j = JSON.parse(fs.readFileSync(val('--reduce'), 'utf8'));
  printReport(j);
  process.exit(0);
}

function fmt(a, d = 3) { return Number.isFinite(a) ? a.toFixed(d) : ' n/a'; }

/**
 * The before/after, PER SUBJECT, against the both-off arm of the same hour.
 *
 * A median over a pooled population was the first version and it hid the thing
 * that mattered: the pavement arm moved the DARK control's median to x1.43,
 * which reads as "the change leaks onto shops it should not touch". It does not.
 * Eight of the nine dark subjects were bit-identical between the arms - ratio
 * exactly 1.000 - and one, a 127-px band 27.8 m out beside a lit tenancy on a
 * return wall, moved x2.51 and dragged the median with it. So the control is
 * reported as a COUNT of subjects that moved at all, which cannot be dragged,
 * with the worst offender named.
 */
function deltas(j) {
  const byName = new Map(Object.entries(j.rows));
  const out = [];
  for (const tod of [...new Set(j.arms.map((a) => a.tod))]) {
    const base = byName.get(`${tod} pavement=x0 soffit=x0`);
    if (!base) continue;
    const key = (r) => `${r.cam}|${r.id}`;
    const b = new Map(base.map((r) => [key(r), r]));
    for (const a of j.arms) {
      if (a.tod !== tod || (a.spillScale === 0 && a.soffitScale === 0)) continue;
      const rows = byName.get(a.name) ?? [];
      const near = { lit: [], dark: [] }, soffit = { lit: [], dark: [] };
      // Chroma moves by a DIFFERENCE, not a ratio: (R-B)/luma is already
      // normalised, and a ratio of two normalised quantities near zero is noise.
      const warm = { lit: [], dark: [] };
      let moved = 0, dark = 0, worst = 0, worstId = '';
      for (const r of rows) {
        const p = b.get(key(r));
        if (!p) continue;
        const cls = r.state === 'dark' ? 'dark' : 'lit';
        if (p.near && r.near) {
          near[cls].push(r.near / p.near);
          if (cls === 'dark') {
            dark++;
            const d = Math.abs(r.near / p.near - 1);
            if (d > 0.01) moved++;
            if (d > worst) { worst = d; worstId = `${r.cam}:${r.id}@${r.distance}m/${r.nearPx}px`; }
          }
        }
        if (p.soffit && r.soffit) soffit[cls].push(r.soffit / p.soffit);
        if (p.soffitWarm !== null && r.soffitWarm !== null && p.soffitWarm !== undefined
          && r.soffitWarm !== undefined) warm[cls].push(r.soffitWarm - p.soffitWarm);
      }
      const med = (v) => { v = v.slice().sort((x, y) => x - y); return median(v); };
      out.push({
        arm: a.name, tod,
        nearLit: med(near.lit), nearLitN: near.lit.length,
        nearLitMin: near.lit.length ? Math.min(...near.lit) : NaN,
        nearLitMax: near.lit.length ? Math.max(...near.lit) : NaN,
        nearDark: med(near.dark), nearDarkN: near.dark.length,
        darkMoved: moved, darkTotal: dark, worstDark: 1 + worst, worstDarkId: worstId,
        soffitLit: med(soffit.lit), soffitLitN: soffit.lit.length,
        soffitLitMin: soffit.lit.length ? Math.min(...soffit.lit) : NaN,
        soffitLitMax: soffit.lit.length ? Math.max(...soffit.lit) : NaN,
        soffitDark: med(soffit.dark), soffitDarkN: soffit.dark.length,
        warmLit: med(warm.lit), warmLitN: warm.lit.length,
        warmLitMin: warm.lit.length ? Math.min(...warm.lit) : NaN,
        warmLitMax: warm.lit.length ? Math.max(...warm.lit) : NaN,
        warmDark: med(warm.dark), warmDarkN: warm.dark.length,
      });
    }
  }
  return out;
}

function printReport(j) {
  console.log(`\ncameras ${j.cam}   ${j.viewport.w}x${j.viewport.h}   ` +
    `pooled subjects ${j.subjectCount} (${j.litCount} lit / ${j.darkCount} dark), ` +
    `awning soffits ${j.soffitCount}`);
  console.log(`m/px at the median subject ${fmt(j.medianMPerPx, 4)}   ` +
    `near-band px p50 ${j.nearPxP50}   soffit px p50 ${j.soffitPxP50}`);
  for (const a of j.arms) {
    console.log(`\n${a.name}`);
    const s = a.summary;
    console.log(`  nearFar  lit  ${fmt(s.nearFarLit.med)}  (n ${s.nearFarLit.n})` +
      `     dark ${fmt(s.nearFarDark.med)}  (n ${s.nearFarDark.n})   <- dark is the control`);
    console.log(`  near     lit  ${fmt(s.nearLit.med, 5)}     dark ${fmt(s.nearDark.med, 5)}` +
      `   litDark ${fmt(s.nearLit.med / s.nearDark.med)}`);
    console.log(`  soffit   lit  ${fmt(s.soffitLit.med, 5)} (n ${s.soffitLit.n})` +
      `  dark ${fmt(s.soffitDark.med, 5)} (n ${s.soffitDark.n})` +
      `   ratio ${fmt(s.soffitLit.med / s.soffitDark.med)}`);
    console.log(`  rows: ${s.bandRows} with pavement bands, ${s.soffitRows} with a soffit; ` +
      `worst clipped fraction  near ${fmt(s.maxNearClipPct, 2)}%  soffit ${fmt(s.maxSoffitClipPct, 2)}%`);
  }
  console.log('\nPER-SUBJECT RATIO against the both-off arm of the same hour');
  console.log('arm                             near(lit)  n   range         near(dark) n   ' +
    'dark subjects that moved >1%      soffit(lit)  n   range        soffit(dark) n');
  for (const d of deltas(j)) {
    console.log(`${d.arm.padEnd(31)}` +
      `${fmt(d.nearLit).padStart(7)}  ${String(d.nearLitN).padStart(2)}  ` +
      `${fmt(d.nearLitMin, 2)}-${fmt(d.nearLitMax, 2)}   ` +
      `${fmt(d.nearDark).padStart(8)}  ${String(d.nearDarkN).padStart(2)}   ` +
      `${String(d.darkMoved)} of ${d.darkTotal}` +
      (d.darkMoved ? ` (worst x${fmt(d.worstDark, 2)} ${d.worstDarkId})` : '').padEnd(4) +
      `   ${fmt(d.soffitLit).padStart(7)}  ${String(d.soffitLitN).padStart(2)}  ` +
      `${fmt(d.soffitLitMin, 2)}-${fmt(d.soffitLitMax, 2)}   ` +
      `${fmt(d.soffitDark).padStart(7)}  ${String(d.soffitDarkN).padStart(2)}`);
  }
  console.log('\nSOFFIT CHROMA, (R-B)/luma, as a DIFFERENCE against the both-off arm');
  for (const d of deltas(j)) {
    if (!d.warmLitN && !d.warmDarkN) continue;
    console.log(`${d.arm.padEnd(31)}` +
      `lit ${fmt(d.warmLit).padStart(7)}  n ${String(d.warmLitN).padStart(2)}  ` +
      `range ${fmt(d.warmLitMin, 3)} to ${fmt(d.warmLitMax, 3)}   ` +
      `dark ${fmt(d.warmDark).padStart(7)}  n ${String(d.warmDarkN).padStart(2)}`);
  }

  // The control: a rectangle of sky neither term can reach. Across the four arms
  // it must be identical, because they differ in two material colours and
  // nothing else. A control that moves means the arms differ for a reason this
  // tool has not accounted for, and nothing above it can be trusted.
  const cts = Object.entries(j.control ?? {});
  if (!cts.length) throw new Error('no control was sampled — the contamination check is ABSENT, not passed');
  for (const [tod, c] of cts) {
    const v = Object.values(c);
    if (!v.length || !v.every(Number.isFinite)) {
      throw new Error(`control at ${tod} is ${JSON.stringify(c)} — absent, not passed`);
    }
    const spread = (100 * (Math.max(...v) - Math.min(...v))) / Math.max(...v);
    console.log(`\ncontrol sky rect at ${tod}: ` +
      Object.entries(c).map(([k, x]) => `${k} ${fmt(x, 5)}`).join('  ') +
      `   spread ${spread.toFixed(3)}%` +
      (spread > 0.5 ? '   <-- THE ARMS DIFFER SOMEWHERE THEY SHOULD NOT' : ''));
  }
  // The second control, and the one that samples GROUND rather than sky: a band
  // of carriageway 4.5-7.5 m out from a wall, against a 2.6 m reach.
  const rcs = Object.entries(j.roadControl ?? {});
  if (!rcs.length) {
    console.log('\nroad control: ABSENT (no camera produced one) — treat the ' +
      'ground contamination check as not performed, not as passed');
  } else {
    let worst = 0, worstK = '';
    for (const [k, c] of rcs) {
      const v = Object.values(c);
      if (!v.length || !v.every(Number.isFinite)) {
        throw new Error(`road control ${k} is ${JSON.stringify(c)} — absent, not passed`);
      }
      const sp = (100 * (Math.max(...v) - Math.min(...v))) / Math.max(...v);
      if (sp > worst) { worst = sp; worstK = k; }
    }
    console.log(`\nroad control (4.5-7.5 m out, beyond the 2.6 m reach): ` +
      `${rcs.length} camera/hour pairs, worst spread across the four arms ` +
      `${worst.toFixed(3)}% at ${worstK}` +
      (worst > 0.5 ? '   <-- SOMETHING LEAKED PAST THE REACH' : ''));
  }
}

// ------------------------------------------------------------------ the capture
//
// GUARDED ON BEING THE ENTRY POINT. Everything above is exported so the selftest
// and any other tool can use it, and until this guard existed `import()`ing this
// file to reuse measureFrame() LAUNCHED A CHROMIUM AND STARTED A CAPTURE - which
// it duly did, against the port a capture was already running on. Same shape as
// tools/bay-legibility.mjs's pathToFileURL check and for the same reason.
const { pathToFileURL } = await import('node:url');
if (import.meta.url !== pathToFileURL(process.argv[1] ?? '').href) {
  // Imported for its helpers, not run. Nothing below this line should happen.
} else {
const { chromium } = await import('playwright');
const { ensureServer } = await import('./serve.mjs');
const { launchOptions } = await import('./browser.mjs');

// NOT 8123. That port belongs to the main tree, and a capture that silently
// reuses it photographs a commit this run never built. ensureServer refuses a
// foreign document root; the port here is separate so it never has to.
const PORT = Number(process.env.SPILL_PORT || val('--port', 8146));
const W = 1600, H = 900;
const OUT = val('--out', 'docs/shots/shop-spill');
const CAMNAME = val('--cam', 'fivepoints');
const TODS = val('--tod', 'night,dusk').split(',');

// The first two are verbatim from tools/hero-shots.mjs (see its header for why
// wpA is 3). The other three are MEASUREMENT cameras and are not hero framings:
// they stand lower and look slightly DOWN, because the quantity here is pavement
// and a hero camera pitched up at a skyline puts almost none of it in frame.
//
// The first fivepoints run measured FIVE usable subjects out of 127 candidates -
// 43 on walls the camera stood behind, 35 under MIN_PX, 19 off screen - and
// exactly ONE awning soffit, which was over a DARK tenancy. So the soffit half of
// the metric had n=0 on the side that was supposed to move, and the run could not
// have shown the change working even if it did. More cameras, pooled, is the fix;
// they are FIXED cameras and not a search, because ao-sweep's lesson in
// CLAUDE.md is that a subject chosen by "whichever qualifies first" is not the
// same subject twice.
const CAMS = {
  corridor: { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  fivepoints: { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
  maine: { name: 'maine', wpA: 3, wpB: 4, back: -150, side: 0, height: 2.2, fov: 62, tgtY: 0.8, fwd: 70 },
  mainw: { name: 'mainw', wpA: 2, wpB: 3, back: -70, side: 0, height: 2.2, fov: 62, tgtY: 0.8, fwd: 70 },
  pineapple: { name: 'pineapple', wpA: 2, wpB: 3, back: -190, side: 0, height: 2.2, fov: 62, tgtY: 0.8, fwd: 70 },
};
const CAMLIST = CAMNAME === 'facing' ? null : CAMNAME.split(',').map((n) => {
  const c = CAMS[n];
  if (!c) throw new Error(`no camera ${n}`);
  return c;
});
// How many frontages `--cam facing` measures, and from what standoff.
const FACING_N = Number(val('--facing', 4));

// FRONTAGE CAMERAS, and why the hero cameras could not do this job.
//
// A camera looking DOWN a street sees its frontages nearly edge-on, so a 1 m
// deep band of pavement foreshortens to a few pixels. Scouted over five
// street-axis cameras at night: 11 usable subjects between them and TWO awning
// soffits, one of which was over a dark shop. The dominant rejection was
// "under MIN_PX" — the metric could not resolve what it was being asked, which
// CLAUDE.md says to say out loud rather than quote.
//
// So these stand in the carriageway and look ACROSS at a frontage. They are
// measuring instruments and not hero framings, and they come in pairs because
// the two halves of this change want opposite viewpoints: pavement wants a
// HIGH eye (more ground in frame, less foreshortening) and an awning soffit
// wants a LOW one (you have to be under it to see it). Frontages are chosen by
// a deterministic ranking over the district, not by "whichever qualifies
// first" — ao-sweep's lesson in CLAUDE.md is that the second kind is not the
// same subject twice — and the chosen ids are printed with the results.
const FACING = `(async () => {
  const S = await import('/src/signage.js');
  const F = await import('/src/facades.js');
  const D = __district;
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const cands = [];
  for (let bi = 0; bi < D.district.buildings.length; bi++) {
    const b = D.district.buildings[bi];
    const style = D.world._capStyle(F.buildingStyle(b), b);
    if (!style || !style.storefront) continue;
    const plan = S.signPlanFor(b, style,
      { street: D.world._streetDirFor(b), streets: D.world._streetDirsFor(b) });
    const byEdge = new Map();
    for (const t of plan.tenants) {
      if (!byEdge.has(t.e.i)) byEdge.set(t.e.i, { e: t.e, ts: [] });
      byEdge.get(t.e.i).ts.push(t);
    }
    for (const [ei, g] of byEdge) {
      const lit = g.ts.filter((t) => t.litState >= 2).length;
      const dark = g.ts.filter((t) => t.litState === 1).length;
      const sofLit = g.ts.filter((t) => t.awning && t.litState >= 2).length;
      const sofDark = g.ts.filter((t) => t.awning && t.litState === 1).length;
      // Both populations have to be present or the within-frame lit/dark ratio
      // has no denominator, and a frontage with no lit awning cannot say
      // anything about soffits.
      if (lit < 1 || dark < 1 || sofLit < 1 || sofDark < 1) continue;
      cands.push({ bi, ei, e: g.e, g, n: g.ts.length, lit, dark, sofLit, sofDark,
        score: g.ts.length * 10 + sofLit * 6 + sofDark * 3 + dark });
    }
  }
  cands.sort((a, b) => (b.score - a.score) || (a.bi - b.bi) || (a.ei - b.ei));
  // Aim at a LIT/DARK PAIR, not at the middle of the frontage. The within-frame
  // ratios need both populations in the SAME frame, and a 40 m field on a 164 m
  // frontage lands wherever the midpoint happens to be - which on the first scout
  // was five tenancies that were all lit. The pair is the closest lit/dark
  // couple, so both are in shot and close to the camera axis; the soffit camera
  // asks for the closest AWNED lit/dark couple, because a soffit population needs
  // awnings and not just shops.
  const pairMid = (g, wantAwning) => {
    const A = g.ts.filter((t) => t.litState >= 2 && (!wantAwning || t.awning));
    const B = g.ts.filter((t) => t.litState === 1 && (!wantAwning || t.awning));
    let best = null;
    for (const a of A) for (const b of B) {
      const d = Math.abs(a.mid - b.mid);
      if (!best || d < best.d) best = { d, s: (a.mid + b.mid) / 2 };
    }
    return best ? best.s : g.e.len / 2;
  };
  const cams = [];
  for (const c of cands) {
    if (cams.length >= ${FACING_N} * 2) break;
    const e = c.e;
    const mid = e.len / 2;
    const wx = e.a[0] + e.tx * mid, wz = e.a[1] + e.tz * mid;
    const sMid = pairMid(c.g, false);
    const sx = e.a[0] + e.tx * sMid, sz = e.a[1] + e.tz * sMid;
    let stand = null;
    for (const d of [16, 14, 19, 12, 22]) {
      const px = sx + e.nx * d, pz = sz + e.nz * d;
      let bad = false;
      for (const b of D.district.buildings) {
        const bx = b.p[0][0], bz = b.p[0][1];
        if (Math.hypot(bx - px, bz - pz) > 90) continue;
        if (inRing(b.p, px, pz)) { bad = true; break; }
      }
      if (!bad) { stand = { px, pz, d }; break; }
    }
    if (!stand) continue;
    const tag = 'f' + c.bi + '_' + c.ei;
    // HIGH for the pavement, LOW for the soffit. Same frontage, same standoff.
    // fov 70 at 16 m frames about 40 m of frontage - five tenancies - and still
    // leaves a 1 m deep pavement band about 1,600 px. At the 55/13 m the scout
    // ran, "off screen" was the largest rejection bucket on every frontage.
    const aimAt = (sAlong) => [e.a[0] + e.tx * sAlong, 0, e.a[1] + e.tz * sAlong];
    const gh = aimAt(pairMid(c.g, false)), gl = aimAt(pairMid(c.g, true));
    const meta = { id: tag, stand: stand.d, n: c.n, lit: c.lit, dark: c.dark,
      sofLit: c.sofLit, sofDark: c.sofDark };
    cams.push({ name: tag + 'h', pos: [stand.px, 3.4, stand.pz], tgt: [gh[0], 0.9, gh[2]],
      fov: 70, ...meta });
    cams.push({ name: tag + 'l', pos: [stand.px, 1.5, stand.pz], tgt: [gl[0], 3.4, gl[2]],
      fov: 70, ...meta });
  }
  return cams;
})()`;

fs.mkdirSync(OUT, { recursive: true });
const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
console.log(`server ${JSON.stringify(srv)}`);

const browser = await chromium.launch(launchOptions());

/** One page load, with the world frozen and the HUD off. */
async function open(query) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  page._errors = [];
  page.on('pageerror', (e) => page._errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/${query}`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 240000 });
  await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
  // Traffic, crowd and cloud drift are the three things that move between two
  // frames of one build. All three off: this is a measurement of a surface, not
  // of a street.
  await page.evaluate(() => {
    __district.setTraffic(0);
    __district.setPedestrians(0);
    __district.sky.cloudWind.set(0, 0);
    __district.setHudEnabled(false);
    __district.setAutopilot(() => {});
  });
  return page;
}

/**
 * Point an already-loaded page at one camera and let the streamer catch up.
 *
 * Cameras are moved inside ONE page load rather than one load each: a load and
 * its first settle is a couple of minutes under SwiftShader and the streamer
 * re-settles in seconds, so five cameras cost one load and not five.
 */
async function point(page, cfg) {
  const placed = await page.evaluate((c) => {
    let px, pz, tgt;
    if (c.pos) {
      px = c.pos[0]; pz = c.pos[2]; tgt = c.tgt;
    } else {
      const r = __district.district.meta.route;
      const a = r[c.wpA], b = r[c.wpB];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      px = a.x - (dx / len) * c.back + nx * c.side;
      pz = a.z - (dz / len) * c.back + nz * c.side;
      tgt = [px + (dx / len) * c.fwd, c.tgtY, pz + (dz / len) * c.fwd];
    }
    __district.placeAt(px, pz);
    __district.freeCam([px, c.pos ? c.pos[1] : c.height, pz], tgt, c.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { x: +px.toFixed(1), z: +pz.toFixed(1) };
  }, cfg);
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const m = await page.evaluate(() => __district.worldReport().meshes);
    stable = m === last ? stable + 1 : 0; last = m;
    if (stable < 3) await page.waitForTimeout(2000);
  }
  console.log(`  ${cfg.name} at (${placed.x}, ${placed.z}); world settled at ${last} chunk meshes` +
    (page._errors.length ? `; PAGE ERRORS: ${page._errors.slice(0, 3).join(' | ')}` : ''));
  return placed;
}

/**
 * The subject list, derived IN THE PAGE from the same modules that built the
 * district, and projected through the live camera. Nothing here is a screen
 * coordinate anyone typed.
 */
// Evaluated as an EXPRESSION, so it is an IIFE and not a bare function:
// page.evaluate(string) evaluates the string, it does not call it, and handing
// it `async () => {...}` returns an unserialisable function object that arrives
// here as undefined. Cost one capture run to find.
//
// It returns EVERY candidate with the reason it was or was not kept, not just
// the survivors. The first version returned survivors alone and reported ONE
// usable subject out of 1,001 tenancies with no way to tell which filter had
// eaten them; the histogram is what turned that into a two-minute fix.
const SUBJECTS = `(async () => {
  const S = await import('/src/signage.js');
  const F = await import('/src/facades.js');
  const T = await import('/vendor/three.module.min.js');
  const D = __district, cam = D.camera;
  cam.updateMatrixWorld();
  const cx = cam.position.x, cz = cam.position.z;

  // Everything a ray can hit that is not sky, weather or crowd. The visibility
  // test below needs the real scene: a band behind a parked car is not a
  // measurement of pavement.
  const meshes = [];
  const tagged = (o, names) => { for (let n = o; n; n = n.parent) if (names.has(n.name)) return true; return false; };
  const skip = new Set(['sky', 'skydome', 'weather', 'pedestrians', 'shopSpill']);
  D.scene.traverse((o) => { if (o.isMesh && o.visible && !tagged(o, skip)) meshes.push(o); });
  const rc = new T.Raycaster();

  const project = (p) => {
    const v = new T.Vector3(p[0], p[1], p[2]).project(cam);
    return [(v.x * 0.5 + 0.5) * ${W}, (-v.y * 0.5 + 0.5) * ${H}, v.z];
  };
  // Clip the projected quad to the viewport instead of throwing the subject
  // away when one corner leaves it. Sutherland-Hodgman, four half-planes; the
  // input is convex so the output is too and polyLumaLinear can rasterise it.
  const clip = (poly) => {
    let out = poly.map((p) => [p[0], p[1]]);
    const planes = [[1, 0, 2], [-1, 0, -(${W} - 2)], [0, 1, 2], [0, -1, -(${H} - 2)]];
    for (const [a, b, c] of planes) {
      const inp = out; out = [];
      for (let i = 0; i < inp.length; i++) {
        const P = inp[i], Q = inp[(i + 1) % inp.length];
        const dp = a * P[0] + b * P[1] - c, dq = a * Q[0] + b * Q[1] - c;
        if (dp >= 0) out.push(P);
        if ((dp >= 0) !== (dq >= 0)) {
          const t = dp / (dp - dq);
          out.push([P[0] + (Q[0] - P[0]) * t, P[1] + (Q[1] - P[1]) * t]);
        }
      }
      if (!out.length) return null;
    }
    return out;
  };
  const areaOf = (poly) => {
    let a = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      a += p[0] * q[1] - q[0] * p[1];
    }
    return Math.abs(a) / 2;
  };
  const inFront = (q) => q.every((p) => p[2] > -1 && p[2] < 1);
  // What fraction of this patch can the camera actually see? A 4x4 grid of world
  // points, each raycast from the eye. All-or-nothing on the four corners threw
  // away every band with a lamp post or a kerb clipping one corner.
  const seenFrac = (a, b, c, d) => {
    let ok = 0, n = 0;
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        const u = (i + 0.5) / 4, v = (j + 0.5) / 4;
        const p = [0, 1, 2].map((k) =>
          a[k] * (1 - u) * (1 - v) + b[k] * u * (1 - v) + c[k] * u * v + d[k] * (1 - u) * v);
        const o = new T.Vector3(p[0], p[1], p[2]);
        const dir = o.clone().sub(cam.position);
        const dd = dir.length();
        rc.set(cam.position, dir.normalize());
        rc.far = dd + 1;
        const h = rc.intersectObjects(meshes, false);
        rc.far = Infinity;
        n++;
        if (h.length && h[0].distance > dd - 0.30) ok++;
      }
    }
    return ok / n;
  };

  const band = (e, s0, s1, o0, o1, y) => {
    const P = (s, o) => [e.a[0] + e.tx * s + e.nx * o, y, e.a[1] + e.tz * s + e.nz * o];
    return [P(s0, o0), P(s1, o0), P(s1, o1), P(s0, o1)];
  };
  const name = ['none', 'dark', 'dim', 'lit'];
  const out = [], why = {};
  let kept = 0, roadCtl = null, bestArea = 0;
  const drop = (k) => { why[k] = (why[k] ?? 0) + 1; };
  for (const b of D.district.buildings) {
    const bx = b.p[0][0], bz = b.p[0][1];
    if (Math.hypot(bx - cx, bz - cz) > 150) continue;
    const style = D.world._capStyle(F.buildingStyle(b), b);
    if (!style || !style.storefront) continue;
    const plan = S.signPlanFor(b, style,
      { street: D.world._streetDirFor(b), streets: D.world._streetDirsFor(b) });
    for (const t of plan.tenants) {
      const e = t.e, span = t.s1 - t.s0;
      if (span < 3) { drop('span<3'); continue; }
      // The pavement in front of a wall the camera is BEHIND cannot be measured.
      const nx = e.nx, nz = e.nz;
      const wx = e.a[0] + e.tx * t.mid, wz = e.a[1] + e.tz * t.mid;
      if ((cx - wx) * nx + (cz - wz) * nz < 1.0) { drop('camera behind the wall'); continue; }
      // The middle 60% of the tenancy, so a party pier or a door reveal at the
      // ends cannot get into the sample.
      const a0 = t.mid - span * 0.3, a1 = t.mid + span * 0.3;
      const near = band(e, a0, a1, 0.35, 1.35, -0.05);
      const mid = band(e, a0, a1, 1.90, 2.70, -0.05);
      const dist = Math.hypot(wx + nx * 0.85 - cx, wz + nz * 0.85 - cz);
      const np = near.map(project), mp = mid.map(project);
      if (!inFront(np) || !inFront(mp)) { drop('behind the camera'); continue; }
      // The pavement bands and the awning soffit are judged INDEPENDENTLY. The
      // first version gated the soffit behind the bands, and the low cameras -
      // the only ones that can see a soffit at all - are exactly the ones whose
      // near band is too foreshortened to qualify. Two frontages returned zero
      // soffits for that reason while looking straight at four of them.
      let nc = null, mc = null, nv = 0, mv = 0;
      const ncc = clip(np), mcc = clip(mp);
      if (ncc && mcc && areaOf(ncc) >= ${MIN_PX} && areaOf(mcc) >= ${MIN_PX}) {
        nv = seenFrac(near[0], near[1], near[2], near[3]);
        mv = seenFrac(mid[0], mid[1], mid[2], mid[3]);
        if (nv >= 0.75 && mv >= 0.75) { nc = ncc; mc = mcc; } else drop('bands occluded');
      } else if (!ncc || !mcc) drop('bands off screen');
      else drop('bands under MIN_PX');

      // The awning soffit, if there is one: the underside of the barrel between
      // 20% and 90% of its arc, which is the part a street-level camera sees.
      let soffit = null;
      if (t.awning) {
        // ON THE EMITTED SURFACE, not on the profile curve. awning() builds the
        // barrel as AWNING_SEGS straight hoops - a CHORD approximation of the
        // quarter circle - and the arc bulges above that chord by centimetres in
        // the middle. The first version of this sampled awningProfile(0.55)
        // directly, which floats above the cloth: a ray from the capture camera
        // to it passed OVER the fabric and hit the wall 60 mm further on. So the
        // hoops are rebuilt here exactly as the emitter builds them and the strip
        // is interpolated linearly between them, which is the surface that is
        // actually drawn.
        const out2 = 1.3, drop2 = 0.5, yTop = t.head + 0.34;
        const hoops = [];
        for (let k = 0; k <= F.AWNING_SEGS; k++) {
          const pr = F.awningProfile(k / F.AWNING_SEGS, out2, drop2);
          hoops.push({ o: 0.02 + pr.o, y: yTop - pr.dy });
        }
        const on = (u) => {                       // u in [0,1] along the chord run
          const f = u * F.AWNING_SEGS, i = Math.min(F.AWNING_SEGS - 1, Math.floor(f)), g = f - i;
          return { o: hoops[i].o + (hoops[i + 1].o - hoops[i].o) * g,
            y: hoops[i].y + (hoops[i + 1].y - hoops[i].y) * g };
        };
        const A = on(0.20), B = on(0.90);
        const Q = (s, k) => [e.a[0] + e.tx * s + e.nx * k.o, k.y, e.a[1] + e.tz * s + e.nz * k.o];
        const q = [Q(t.s0 + 0.15, A), Q(t.s1 - 0.15, A), Q(t.s1 - 0.15, B), Q(t.s0 + 0.15, B)];
        const qp = q.map(project);
        if (inFront(qp)) {
          const qc = clip(qp);
          if (qc && areaOf(qc) >= ${MIN_PX} && seenFrac(q[0], q[1], q[2], q[3]) >= 0.75) soffit = qc;
        }
      }
      // Metres per pixel at the near band: the width of the sampled span over
      // the pixels it covers. Quoted with every subject so nobody has to guess
      // whether the metric could resolve what it is being asked.
      // THE ROAD CONTROL. A band of ground 4.5-7.5 m out from the same wall -
      // well beyond SPILL_REACH (2.6 m), and carriageway rather than pavement.
      // Nothing this change emits can reach it, so it must be bit-identical
      // across the four arms; unlike the sky control it is GROUND, so it would
      // also catch a leak into the ground material itself. Kept from whichever
      // subject has the largest near band, so it is the best-resolved one in the
      // frame rather than the first that qualified.
      if (nc) {
        const cb = band(e, a0, a1, 4.5, 7.5, -0.05).map(project);
        if (inFront(cb)) {
          const cc = clip(cb);
          if (cc && areaOf(cc) >= 400 && areaOf(nc) > bestArea) {
            bestArea = areaOf(nc);
            roadCtl = cc;
          }
        }
      }
      if (!nc && !soffit) continue;
      const wpx = Math.hypot(np[1][0] - np[0][0], np[1][1] - np[0][1]);
      out.push({
        id: b.i + ':' + e.i + ':' + t.slot,
        state: name[t.litState],
        awning: !!t.awning,
        distance: +dist.toFixed(1),
        seen: +((nv + mv) / 2).toFixed(2),
        mPerPx: wpx > 0 ? +((a1 - a0) / wpx).toFixed(4) : null,
        near: nc, mid: mc, soffit,
      });
      kept++;
    }
  }
  out.sort((a, b) => a.distance - b.distance);
  return { subjects: out, why, roadCtl };
})()`;

// Rows are keyed by ARM (tod + which of the two terms is on) and pooled across
// cameras. A per-subject ratio is comparable between cameras -- it is taken
// inside one frame -- and pooling is how a population of 5 becomes a population
// big enough for a median to mean something.
const armRows = new Map();
const push = (key, meta, rows) => {
  if (!armRows.has(key)) armRows.set(key, { ...meta, rows: [], files: [] });
  const a = armRows.get(key);
  a.rows.push(...rows);
  return a;
};
const perCam = {};
const control = {};
const roadControl = {};
let camList = null;
const scoutOnly = has('--scout');

// THE FOUR ARMS, FROM ONE PAGE LOAD.
//
//   x0/x0   before: both terms off, every triangle still in the scene
//   x1/x0   the pavement pool alone
//   x0/x1   the awning soffit glow alone
//   x1/x1   as shipped
//
// One load and two material colours apart, so the arms share the streamed
// chunks, the exposure, the camera and the subject list exactly. The first
// version of this harness used two page loads and a ?nosoffit=1 build flag,
// because the soffit glow was baked into the atlas EMISSIVE and could not be
// switched at runtime; moving it to an additive mesh removed both the daylight
// change and the second load. A capture that costs one load is a capture that
// gets re-run when the level is wrong, which it was.
// --daylight: is the change invisible before dusk, end to end?
//
// The offline hashes already prove the OPAQUE geometry is byte-identical -- the
// facade/trim buffers at sha256 7df65ec9... and the signage buffers at
// 32911b92..., both unchanged -- and SPILL_EMISSIVE is 0 at noon and golden, so
// an additive material whose colour is black adds nothing. That is an argument
// about three files. This is the test: load the district WITH both meshes and
// again WITHOUT them (?nospill=1&nosoffit=1), photograph noon and golden, and
// require the frames to be IDENTICAL pixel for pixel. It exercises the whole
// path - the mesh submission, the blend state, the transparent queue, the
// renderOrder - not just the numbers going in.
if (has('--daylight')) {
  const out = [];
  for (const [tag, q] of [['with', ''], ['without', '?nospill=1&nosoffit=1']]) {
    console.log(`\nload ${tag} the two additive meshes  ${q || '(default)'}`);
    const page = await open(q);
    await point(page, CAMS.fivepoints);
    for (const tod of ['noon', 'golden']) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await page.waitForTimeout(2500);
      const f = path.join(OUT, `daylight-${tod}-${tag}.png`);
      await page.screenshot({ path: f, timeout: 150000 });
      out.push({ tod, tag, f });
      console.log(`  ${path.basename(f)}`);
    }
    await page.close();
  }
  await browser.close();
  let bad = 0;
  for (const tod of ['noon', 'golden']) {
    const a = readPNG(out.find((x) => x.tod === tod && x.tag === 'with').f);
    const b = readPNG(out.find((x) => x.tod === tod && x.tag === 'without').f);
    if (a.width !== b.width || a.height !== b.height || a.channels !== b.channels) {
      throw new Error('frames differ in shape — nothing below means anything');
    }
    let diff = 0, worst = 0;
    for (let i = 0; i < a.data.length; i++) {
      const d = Math.abs(a.data[i] - b.data[i]);
      if (!Number.isFinite(d)) throw new Error(`non-finite difference at ${i} — stride wrong?`);
      if (d) { diff++; if (d > worst) worst = d; }
    }
    const pct = (100 * diff) / a.data.length;
    console.log(`${tod}: ${diff} of ${a.data.length} bytes differ (${pct.toFixed(4)}%), ` +
      `worst |diff| ${worst}  channels ${a.channels}` + (diff ? '   <-- NOT INVISIBLE' : ''));
    if (diff) bad++;
  }
  console.log(bad ? `\n${bad} DAYLIGHT ARM(S) DIFFER` : '\nDAYLIGHT: identical, pixel for pixel');
  process.exit(bad ? 1 : 0);
}

const ARMS = [[0, 0], [1, 0], [0, 1], [1, 1]];
const page = await open('');
if (!camList) {
  camList = CAMLIST ?? await page.evaluate(FACING);
  if (!camList.length) throw new Error('no frontage qualified for a facing camera');
  console.log(`  frontages: ${[...new Set(camList.map((c) => c.id))].join(' ')}`);
  for (const c of camList.filter((x) => x.name.endsWith('h'))) {
    console.log(`    ${c.id}  ${c.n} tenancies (${c.lit} lit / ${c.dark} dark), ` +
      `awnings ${c.sofLit} lit / ${c.sofDark} dark, standoff ${c.stand} m`);
  }
}
for (const cfg of camList) {
  await point(page, cfg);
  for (const tod of TODS) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(2500);
    const got = await page.evaluate(SUBJECTS);
    const subs = got && got.subjects;
    if (!Array.isArray(subs)) {
      throw new Error(`the page returned ${JSON.stringify(got)} — ` +
        'no measurement below this line would mean anything');
    }
    const nLit = subs.filter((x) => x.state === 'lit' || x.state === 'dim').length;
    const nSof = subs.filter((x) => x.soffit).length;
    const nSofLit = subs.filter((x) => x.soffit && x.state !== 'dark').length;
    console.log(`  ${cfg.name}/${tod}: ${subs.length} subjects (${nLit} lit), ` +
      `${nSof} soffits (${nSofLit} over a lit shop); rejected ${JSON.stringify(got.why)}`);
    perCam[`${cfg.name}/${tod}`] = { subjects: subs.length, lit: nLit,
      soffits: nSof, soffitsLit: nSofLit, why: got.why };
    if (scoutOnly || !subs.length) continue;
    for (const [sp, so] of ARMS) {
      await page.evaluate(([a, b]) => {
        __district.setSpillScale(a); __district.setSoffitScale(b);
      }, [sp, so]);
      await page.waitForTimeout(1200);
      const file = path.join(OUT, `${cfg.name}-${tod}-p${sp}s${so}.png`);
      // 150 s, not the 30 s default. SwiftShader renders this frame in tens of
      // seconds and the default 30 s ended a capture run mid-sweep.
      await page.screenshot({ path: file, timeout: 150000 });
      const img = readPNG(file);
      const rows = measureFrame(img, subs).map((r) => ({ ...r, cam: cfg.name }));
      const key = `${tod} pavement=x${sp} soffit=x${so}`;
      push(key, { name: key, tod, spillScale: sp, soffitScale: so }, rows).files.push(file);
      console.log(`    ${path.basename(file)}  ${rows.length} usable  channels ${img.channels}`);
      // The control: a rectangle of SKY, which neither term can reach. Across
      // the four arms it must be IDENTICAL - they differ in two material
      // colours and nothing else - and if it moves, whatever moved is not what
      // this tool thinks it measured.
      if (cfg === camList[0]) {
        const sky = [[40, 30], [200, 30], [200, 110], [40, 110]];
        control[tod] = control[tod] ?? {};
        control[tod][`p${sp}s${so}`] = controlLuma(img, sky, `sky control at ${tod}`);
      }
      // The road control is per camera, because it is built off that camera's
      // own frontage. Every camera contributes one, and every one of them has to
      // be identical across the four arms.
      if (got.roadCtl) {
        const k = `${cfg.name}/${tod}`;
        roadControl[k] = roadControl[k] ?? {};
        roadControl[k][`p${sp}s${so}`] = controlLuma(img, got.roadCtl, `road control ${k}`);
      }
    }
  }
}
await page.close();
await browser.close();

if (scoutOnly) {
  console.log(`\nSCOUT: ${JSON.stringify(perCam, null, 1)}`);
  process.exit(0);
}

const arms = [...armRows.values()].map((a) => ({ ...a, summary: summarise(a.rows) }));
const all = arms[0].rows;
const px = (f) => { const v = all.map(f).filter((x) => x > 0).sort((a, b) => a - b); return median(v); };
const report = {
  cam: CAMNAME, viewport: { w: W, h: H },
  perCam,
  subjectCount: all.length,
  litCount: all.filter((r) => r.state !== 'dark').length,
  darkCount: all.filter((r) => r.state === 'dark').length,
  soffitCount: all.filter((r) => r.soffitPx > 0).length,
  medianMPerPx: px((r) => r.mPerPx), nearPxP50: px((r) => r.nearPx), soffitPxP50: px((r) => r.soffitPx),
  control, roadControl,
  arms: arms.map(({ rows, ...a }) => a),
  rows: Object.fromEntries(arms.map((a) => [a.name, a.rows])),
};
report.deltas = deltas(report);
// The NUMBERS are the record and they are tracked; the frames are 1.4 MB each
// and regenerable from this tool, which is the policy .gitignore already applies
// to the oak bench, the glazing heroes and the canopy A/B sets.
const jf = `docs/shop-spill-${CAMNAME.replace(/,/g, '+')}.json`;
fs.writeFileSync(jf, JSON.stringify(report, null, 1));
printReport(report);
console.log(`\nwrote ${jf}`);
}
