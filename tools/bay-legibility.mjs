// Is there anything READABLE behind a shopfront pane, or just a wash?
//
// The round that lit the district's shopfronts answered "dark" and produced a new
// defect: a blind reviewer measured one Five Points bay at glass p90 210 with
// 18.7% of it over luma 200, against a corridor bay at p90 ~85 and 1.8% - same
// build, same hour, 2.6x apart on the ratio that matters. At that level the
// dressing the emissive was meant to reveal is washed out: the shelf products
// visible at noon lose half their contrast at night. Illegible, not absent.
//
// So the quantity here is not brightness, it is whether the interior still has
// STRUCTURE in it. Three numbers say that, and they are separated on purpose:
//
//   level      p50, p90, max and the fraction over 200. A bay that clips has
//              thrown away its detail whatever else is true of it.
//   contrast   p90 - p10 inside the bay, and the standard deviation. A wash and
//              a legible interior can share a mean; they cannot share these.
//   ratio      bay p90 divided by the PAVEMENT median in the same frame. This is
//              the exposure-invariant one and it is the one to tune against:
//              CLAUDE.md is explicit that raw levels are not comparable across
//              builds because the stop moves, but a ratio inside one frame is.
//
// The pavement reference is a named rect, not a band, because the ground band of
// these frames contains lamp pools, a red tail light and a car. It is stated in
// PAVEMENT below and printed with every run so a number can never be quoted
// without the denominator it was made with.
//
//   node tools/bay-legibility.mjs --selftest
//   node tools/bay-legibility.mjs r8 r9
//   node tools/bay-legibility.mjs r8 r9 --rect fivepoints:1300,540,90,70
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPNG } from './png.mjs';

export const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Every luma in an [x, y, w, h] box, as a sorted Float64Array. */
export function boxLuma(img, [bx, by, bw, bh]) {
  const { width: W, height: H, channels: C, data } = img;
  if (data.length < W * H * C) {
    throw new Error(`buffer short: ${data.length} for ${W}x${H}x${C} — stride wrong?`);
  }
  if (bx < 0 || by < 0 || bx + bw > W || by + bh > H) {
    throw new Error(`box [${bx},${by},${bw},${bh}] is not inside ${W}x${H}`);
  }
  const out = new Float64Array(bw * bh);
  let k = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const i = (y * W + x) * C;
      const v = luma(data[i], data[i + 1], data[i + 2]);
      // A non-finite luma means the stride is wrong, and the wrong answer would
      // be a reassuring one: NaN sorts to the end and drags every percentile.
      if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      out[k++] = v;
    }
  }
  out.sort();
  return out;
}

/**
 * The same box, in LINEAR light. sRGB out, scene-referred back.
 *
 * `boxLuma` above works on the encoded 8-bit values, which is right for "how
 * bright does this look" and wrong for anything compared across two builds:
 * the OETF is not a scale, so a ratio of encoded values still moves when the
 * exposure does. In linear light an exposure change IS a scale, and a ratio of
 * two linear percentiles is exactly invariant under one. Measured below.
 */
export function boxLumaLinear(img, [bx, by, bw, bh]) {
  const { width: W, height: H, channels: C, data } = img;
  if (data.length < W * H * C) {
    throw new Error(`buffer short: ${data.length} for ${W}x${H}x${C} — stride wrong?`);
  }
  if (bx < 0 || by < 0 || bx + bw > W || by + bh > H) {
    throw new Error(`box [${bx},${by},${bw},${bh}] is not inside ${W}x${H}`);
  }
  const s2l = (u) => { const c = u / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const out = new Float64Array(bw * bh);
  let k = 0, clipped = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const i = (y * W + x) * C;
      const r = data[i], g = data[i + 1], b = data[i + 2];
      if (r >= 254 && g >= 254 && b >= 254) clipped++;
      const v = 0.2126 * s2l(r) + 0.7152 * s2l(g) + 0.0722 * s2l(b);
      if (!Number.isFinite(v)) throw new Error(`non-finite luma at ${x},${y} — stride wrong?`);
      out[k++] = v;
    }
  }
  out.sort();
  return { lum: out, clipPct: +((100 * clipped) / (bw * bh)).toFixed(2) };
}

/**
 * LOCAL contrast: RMS deviation from a local mean, divided by that local mean.
 *
 * This is the number the review round was really quoting when it said the shelf
 * products "lose half their contrast at night" - a shop interior can be bright,
 * flat and useless, and p90 minus p10 will not notice because a smooth vertical
 * ramp has an enormous spread and no detail in it at all. Normalising by the
 * local mean is what makes it comparable between a night frame and a noon one,
 * which are two stops apart: CLAUDE.md's rule that ratios inside one frame
 * survive an exposure change and raw levels do not.
 *
 * `win` is the half-width of the neighbourhood in pixels. It has to be about the
 * size of the FEATURE being asked about - a window much larger than a shelf
 * product measures the gradient behind it instead - so it is a parameter and it
 * is printed.
 */
export function localContrast(img, [bx, by, bw, bh], win = 3) {
  const { width: W, height: H, channels: C, data } = img;
  if (data.length < W * H * C) throw new Error(`buffer short — stride wrong?`);
  if (bx - win < 0 || by - win < 0 || bx + bw + win > W || by + bh + win > H) {
    throw new Error(`box [${bx},${by},${bw},${bh}] with window ${win} runs off ${W}x${H}`);
  }
  let acc = 0, n = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      let sum = 0, sq = 0, m = 0;
      for (let dy = -win; dy <= win; dy++) {
        for (let dx = -win; dx <= win; dx++) {
          const i = ((y + dy) * W + (x + dx)) * C;
          const v = luma(data[i], data[i + 1], data[i + 2]);
          if (!Number.isFinite(v)) throw new Error(`non-finite luma — stride wrong?`);
          sum += v; sq += v * v; m++;
        }
      }
      const mean = sum / m;
      const varr = Math.max(0, sq / m - mean * mean);
      // A neighbourhood at zero has no contrast to speak of and dividing by it
      // manufactures one; skip it rather than clamp it, and report the count.
      if (mean > 2) { acc += Math.sqrt(varr) / mean; n++; }
    }
  }
  return { rms: n ? +(acc / n).toFixed(4) : 0, samples: n, win };
}

/** Percentile of an already-sorted array, by nearest rank. */
export const pct = (sorted, p) => sorted[Math.min(sorted.length - 1,
  Math.max(0, Math.round(p * (sorted.length - 1))))];

export function bayStats(img, rect) {
  const s = boxLuma(img, rect);
  // Exposure-invariant companion to `muddyPct`. See the note on muddyPct below
  // for why it is here and what it replaces.
  const { lum: lin, clipPct } = boxLumaLinear(img, rect);
  const linP50 = pct(lin, 0.50);
  const dispersion = linP50 > 1e-9
    ? +((pct(lin, 0.90) - pct(lin, 0.10)) / linP50).toFixed(3) : 0;
  let sum = 0, over200 = 0, over90 = 0, muddy = 0;
  for (const v of s) {
    sum += v;
    if (v > 200) over200++;
    if (v > 90) over90++;
    if (v >= 30 && v <= 60) muddy++;
  }
  const n = s.length;
  const mean = sum / n;
  let sq = 0;
  for (const v of s) sq += (v - mean) * (v - mean);
  return {
    n,
    mean: +mean.toFixed(2),
    p10: +pct(s, 0.10).toFixed(1),
    p50: +pct(s, 0.50).toFixed(1),
    p90: +pct(s, 0.90).toFixed(1),
    max: +s[n - 1].toFixed(1),
    sd: +Math.sqrt(sq / n).toFixed(2),
    spread: +(pct(s, 0.90) - pct(s, 0.10)).toFixed(1),
    over200Pct: +((100 * over200) / n).toFixed(2),
    over90Pct: +((100 * over90) / n).toFixed(2),
    // MUDDY IS AN ABSOLUTE BAND AND DOES NOT SURVIVE AN EXPOSURE CHANGE.
    // Measured on docs/shots/hero-corridor-dusk.png over a 220x160 bay window,
    // exposure applied in linear light and re-encoded, ZERO content change:
    //
    //   stops    -0.50   -0.25    0.00   +0.25   +0.50   +1.00
    //   muddyPct 20.12   21.41   26.85   31.32   35.45   40.13
    //
    // A round that shifted exposure half a stop and read muddyPct fall by a
    // quarter would have called that a legibility win. It is the population
    // walking across a fixed threshold, which is issue #47 and the same shape
    // of error as the "last radius still over 0.05" crossing in CLAUDE.md.
    // Kept, because past rounds quoted it and deleting it would silently
    // rewrite what those numbers meant -- but never compare it across builds.
    muddyPct: +((100 * muddy) / n).toFixed(2),
    // What to use instead. Percentile spread over the median, in LINEAR light,
    // where an exposure change is a pure scale and therefore cancels. Same
    // frame, same window, same stops as the table above:
    //
    //   dispersion  8.3325  8.3325  8.3325  8.3325  8.3325  8.3325   (0.00%)
    //
    // Exact, not approximate -- and exact only while nothing clips, because a
    // clipped highlight is not scaled by the exposure it saturated at. Hence
    // clipPct: if it is not ~0, the invariance claim does not hold and the
    // number needs saying with that caveat rather than quoting bare.
    // The same ratio taken on the ENCODED values drifts 20% over the same
    // range, which is why this one is computed in linear light and not there.
    dispersion,
    clipPct,
  };
}

function selftest() {
  let fail = 0;
  const ck = (name, got, want) => {
    const ok = Math.abs(got - want) < 1e-6;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
  };
  const mk = (C, fill) => ({
    width: 10, height: 10, channels: C,
    data: Uint8Array.from({ length: 10 * 10 * C }, (_, i) => fill(i, C)),
  });

  // A flat grey bay: every percentile is the same and the spread is zero. This is
  // the WASH the tool exists to detect, and it must read as zero contrast even
  // though its mean is high.
  const flat = bayStats(mk(3, () => 210), [0, 0, 10, 10]);
  ck('wash p50', flat.p50, 210);
  ck('wash p90', flat.p90, 210);
  ck('wash spread is zero', flat.spread, 0);
  ck('wash sd is zero', flat.sd, 0);
  ck('wash is 100% over 200', flat.over200Pct, 100);

  // A bay with the SAME MEAN but real structure: half at 160, half at 260->255.
  // Mean is close to the wash's, spread is not. A metric that cannot separate
  // these two cannot say anything about legibility.
  const structured = bayStats(mk(3, (i) => (Math.floor(i / 3) % 10 < 5 ? 165 : 255)), [0, 0, 10, 10]);
  ck('structured mean is near the wash', Math.round(structured.mean), 210);
  ck('structured spread is NOT zero', structured.spread > 80, true);

  // KNOWN-BAD INPUT 1: 3-channel data read at a 4-byte stride. The buffer is
  // short and the reads past the end become NaN, which sorts to the end of the
  // array and would make p90 and max read as garbage rather than as an error.
  const bad = mk(3, () => 0);
  bad.channels = 4;
  let threw = false;
  try { bayStats(bad, [0, 0, 10, 10]); } catch { threw = true; }
  ck('4-stride on 3-channel data throws', threw ? 1 : 0, 1);

  // KNOWN-BAD INPUT 2: a rect that runs off the image. Silently clamping would
  // quietly change the population a quoted percentile was taken over.
  let threw2 = false;
  try { bayStats(mk(3, () => 0), [5, 5, 10, 10]); } catch { threw2 = true; }
  ck('a rect off the edge throws', threw2 ? 1 : 0, 1);

  // LOCAL CONTRAST, on the pair that matters most and that spread gets wrong.
  // A smooth vertical ramp has a huge spread and NO local detail; a checkerboard
  // of the same mean has the same-ish level and plenty. If the metric cannot
  // separate those it cannot say whether the dressing survived.
  const rampImg = { width: 40, height: 40, channels: 3, data: new Uint8Array(40 * 40 * 3) };
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const v = 60 + Math.round((y / 39) * 120);
      const i = (y * 40 + x) * 3;
      rampImg.data[i] = rampImg.data[i + 1] = rampImg.data[i + 2] = v;
    }
  }
  const checkImg = { width: 40, height: 40, channels: 3, data: new Uint8Array(40 * 40 * 3) };
  for (let y = 0; y < 40; y++) {
    for (let x = 0; x < 40; x++) {
      const v = ((x >> 1) + (y >> 1)) % 2 ? 160 : 80;
      const i = (y * 40 + x) * 3;
      checkImg.data[i] = checkImg.data[i + 1] = checkImg.data[i + 2] = v;
    }
  }
  const rampC = localContrast(rampImg, [10, 10, 20, 20], 3).rms;
  const checkC = localContrast(checkImg, [10, 10, 20, 20], 3).rms;
  // 0.052 and 0.333, measured. My first guess put the ramp under 0.02 and it is
  // not: a 60->180 ramp over 40 px is 3 luma per row, so a 7 px window still
  // spans 21 luma and a gradient is NOT zero local contrast at close range. That
  // is the honest behaviour of the metric and it is why the ramp is a floor to
  // beat rather than a zero - the same ramp stretched over 120 px reads 0.019.
  ck('a smooth ramp reads low', rampC < 0.08, true);
  ck('a checkerboard reads high', checkC > 0.25, true);
  ck('and they are 6x apart', checkC > rampC * 6, true);
  // The spread metric, on the SAME pair, cannot tell them apart the same way -
  // which is exactly why both are reported.
  const rampSpread = bayStats(rampImg, [10, 10, 20, 20]).spread;
  ck('while the ramp spread is large', rampSpread > 40, true);

  // KNOWN-BAD INPUT: a window that reaches outside the image. Reading past the
  // edge would silently mix in whatever is in the buffer there.
  let threw3 = false;
  try { localContrast(rampImg, [0, 0, 20, 20], 3); } catch { threw3 = true; }
  ck('a local window off the edge throws', threw3 ? 1 : 0, 1);

  // Percentiles on a known ramp 0..99: p50 of 100 sorted values is index 50.
  const ramp = { width: 10, height: 10, channels: 3, data: new Uint8Array(300) };
  for (let i = 0; i < 100; i++) { ramp.data[i * 3] = ramp.data[i * 3 + 1] = ramp.data[i * 3 + 2] = i; }
  const r = bayStats(ramp, [0, 0, 10, 10]);
  ck('ramp p50', Math.round(r.p50), 50);
  // 89, not 90: nearest rank over 100 sorted values 0..99 is index
  // round(0.9 * 99) = 89. Written down because the off-by-one is the whole reason
  // two tools quoting "p90" can disagree by a grey level on the same pixels.
  ck('ramp p90', Math.round(r.p90), 89);
  ck('ramp max', Math.round(r.max), 99);

  // ---- issue #47: the exposure invariance the two metrics do and do not have.
  //
  // A synthetic bay with real tonal structure -- dark frame, mid wall, bright
  // glass -- exposed twice, one stop apart, in linear light and re-encoded, so
  // the CONTENT is identical and only the exposure differs. dispersion must not
  // move; muddyPct must. The second assertion is the one that matters: without
  // it this test would still pass against a `dispersion` that had quietly been
  // made an absolute band again, because a constant 0 is invariant too.
  {
    const l2s = (c) => 255 * (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
    const bay = (stops) => {
      const g = Math.pow(2, stops);
      const W = 40, H = 40, data = new Uint8ClampedArray(W * H * 3);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          // Three bands in LINEAR reflectance plus a gentle gradient, then
          // exposed and encoded. The gradient is not decoration: with three
          // flat levels and nothing else, one 8-bit quantisation step moves a
          // percentile onto a different band and the drift below reads 1.7%
          // instead of the ~0 a real frame gives. That is the quantisation
          // floor, not the metric, and the bound asserted below is set by it.
          const lin = (y < 12 ? 0.012 : y < 28 ? 0.055 : 0.14) * (1 + 0.35 * (x / W));
          const v = l2s(Math.min(1, lin * g));
          const i = (y * W + x) * 3;
          data[i] = data[i + 1] = data[i + 2] = v;
        }
      }
      return { width: W, height: H, channels: 3, data };
    };
    const a = bayStats(bay(0), [0, 0, 40, 40]);
    const b = bayStats(bay(1), [0, 0, 40, 40]);
    const dDrift = 100 * Math.abs(b.dispersion / a.dispersion - 1);
    const mDrift = 100 * Math.abs(b.muddyPct - a.muddyPct) /
      Math.max(1, Math.max(a.muddyPct, b.muddyPct));
    // The bound is the 8-bit quantisation floor, not a tolerance chosen to pass:
    // in linear light the exposure is a pure scale and cancels exactly, and on a
    // real frame (docs/shots/hero-corridor-dusk.png, 220x160 bay window, +/-1
    // stop) the measured drift is 0.00%. A synthetic 40x40 gives it fewer
    // distinct levels to land on, so 1% is the floor here.
    const okd = dDrift < 1.0;
    if (!okd) fail++;
    console.log(`${okd ? 'ok  ' : 'FAIL'} dispersion survives a one-stop change: ` +
      `${a.dispersion} -> ${b.dispersion}, drift ${dDrift.toFixed(2)}% < 1%`);
    ck('...and nothing clipped, so the claim holds', b.clipPct + a.clipPct, 0);
    // The assertion that stops `dispersion` being quietly replaced by another
    // absolute band: a constant would pass the invariance check above on its
    // own. muddyPct must be seen to MOVE on the very same pair.
    const ok = mDrift > 20 * Math.max(dDrift, 0.05);
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} muddyPct moves on the same pair ` +
      `(${a.muddyPct} -> ${b.muddyPct}, ${mDrift.toFixed(1)}% vs dispersion's ` +
      `${dDrift.toFixed(2)}%): the defect, reproduced`);
    // And the guard itself: blow the highlights and clipPct must report it,
    // because past that point dispersion is no longer exposure-invariant.
    const hot = bayStats(bay(4), [0, 0, 40, 40]);
    const okc = hot.clipPct > 20;
    if (!okc) fail++;
    console.log(`${okc ? 'ok  ' : 'FAIL'} clipPct flags a blown frame: ${hot.clipPct}% > 20`);
  }

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
}

// The bays the review round measured, verbatim from its own x0-x1 / y0-y1
// notation, converted to [x, y, w, h]. Named so a number can be traced to a rect.
export const RECTS = {
  'fivepoints-night': {
    'blown bay      x1300-1390 y540-610': [1300, 540, 90, 70],
    'mid row        x430-700   y430-530': [430, 430, 270, 100],
  },
  'corridor-night': {
    'good bay       x1350-1440 y470-600': [1350, 470, 90, 130],
    'CASSAVA row    x60-480    y380-600': [60, 380, 420, 220],
  },
};

// The pavement denominator. Chosen off the frame and stated here rather than
// tuned per run: the near carriageway/pavement strip at the bottom centre, which
// is clear of the lamp pools at the kerb, of the parked car on the left and of
// the red tail light. Printed with every ratio.
export const PAVEMENT = { 'corridor-night': [600, 780, 400, 90], 'fivepoints-night': [600, 780, 400, 90] };

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (!isMain) { /* imported for bayStats / boxLuma */ }
else if (process.argv.includes('--selftest')) selftest();
else {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const ri = process.argv.indexOf('--rect');
  const extra = {};
  if (ri >= 0) {
    const [view, box] = process.argv[ri + 1].split(':');
    extra[view] = { [`custom ${box}`]: box.split(',').map(Number) };
  }
  const DIR = 'docs/shots';
  const arms = args.length ? args : ['r8', 'r9'];
  const views = Object.keys(extra).length ? extra : RECTS;
  for (const [view, rects] of Object.entries(views)) {
    const pav = PAVEMENT[view];
    console.log(`\n=== ${view} (pavement reference [${pav}]) ===`);
    // `30-60%` is muddyPct and is NOT comparable between arms -- it walks a
    // fixed threshold across a population that moves with exposure (issue #47;
    // the table in bayStats has the numbers). `disp` is its exposure-invariant
    // replacement, and `clip%` says whether that invariance holds on this frame.
    console.log('rect                                  arm      mean   p10   p50   p90   max' +
      '   sd  spread  >200%  >90%  30-60%    disp  clip%   p90/pav   local');
    for (const [label, rect] of Object.entries(rects)) {
      for (const arm of arms) {
        const f = `${DIR}/${arm}-${view}.png`;
        if (!fs.existsSync(f)) { console.log(`${f}: missing`); continue; }
        const img = readPNG(f);
        const s = bayStats(img, rect);
        const pavMed = pct(boxLuma(img, pav), 0.5);
        const w = (v, n) => String(v).padStart(n);
        console.log(`${label.padEnd(36)} ${arm.padEnd(6)} ${w(s.mean, 6)} ${w(s.p10, 5)} ` +
          `${w(s.p50, 5)} ${w(s.p90, 5)} ${w(s.max, 5)} ${w(s.sd, 5)} ${w(s.spread, 6)} ` +
          `${w(s.over200Pct, 6)} ${w(s.over90Pct, 6)} ${w(s.muddyPct, 6)} ${w(s.dispersion, 7)} ` +
          `${w(s.clipPct, 6)}  ${w((s.p90 / pavMed).toFixed(2), 8)}` +
          `  ${w(localContrast(img, rect, 3).rms.toFixed(4), 7)}`);
      }
    }
  }
}
