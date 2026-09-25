// Is a car's window a WINDOW, measured as two separate numbers rather than one?
//
// Round 9 moved the glazing from metalness 0.86 to 0 and three independent blind
// reviewers measured the result as a window that had stopped reading as one. The
// pane's MEDIAN rose 1.7-1.9x while its bright end went FLAT OR DOWN - brightest
// 2% / own paint 0.2077 -> 0.1933, and on another car p95/p50 3.93 -> 1.91, "its
// highlight came down while its floor came up". The rear quarter light ended at
// 1.350 of the body paint directly below it: brighter than the paint.
//
// That is two findings, and the round's own metric was one number. A pane has a
// FLOOR (how black it goes, which is the "hole" complaint) and a CEILING (whether
// anything is reflected in it, which is the "reads as glass" requirement), and a
// change can move them in opposite directions. So this reports them separately,
// always, and refuses to collapse them.
//
//   node tools/car-pane.mjs --selftest
//   node tools/car-pane.mjs <tag>...            # one row per pane per frame
//
// EVERY RATIO IS TAKEN IN LINEAR LIGHT INSIDE ONE FRAME, against a paint box on
// the SAME car. Exposure here spans 1/22100 at noon to 1/5 at night; a ratio of
// percentiles in linear light is exactly invariant under that because there it is
// a pure scale, and the same ratio on sRGB bytes drifts ~20% because the OETF is
// not a scale. The selftest measures both, so the claim is comparative and checked
// rather than asserted.
//
// THE LINEARISATION UNDOES THE ENCODING, NOT THE TONE MAP, and that matters when
// the two populations sit in different parts of the curve. A 6x gain on the
// glazing's environment term moved the near windscreen's displayed p50 from
// 8.397e-3 to 8.078e-2 - a factor of 9.62 - with its paint reference IDENTICAL at
// 4.752e-1 in both arms, so the excess is not a moved denominator. It is the ACES
// toe: the pane started deep in the compressed darks and ended outside them, so
// equal steps in scene radiance are unequal steps here.
//
// So these ratios are exactly comparable BETWEEN ARMS at one exposure, which is
// what they are used for, and they are NOT a measurement of a shader gain. Read a
// 9.6x displayed rise as "the pane got much brighter", never as "the term was
// scaled 9.6x". CLAUDE.md's invariance rule covers an exposure change, which moves
// one population uniformly along the curve; it does not cover a population moving
// 10x through the curve while another stays put.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { readPNG } from './png.mjs';

const SHOTS = 'docs/shots';

/** sRGB byte -> linear, the exact piecewise transfer function. */
export function toLinear(b) {
  const c = b / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
const LUMA = (r, g, b) => 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);

function pct(sorted, p) {
  if (!sorted.length) return NaN;
  const i = (sorted.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Linear-light percentiles inside a box.
 *
 * THE STRIDE IS `channels`, READ OFF THE FILE. These screenshots are 3-channel and
 * a hardcoded 4 misaligns every sample and reads NaN in the bottom quarter - where
 * the near car is - and NaN fails every `>` silently, so the bad rows report NO
 * DIFFERENCE. Throwing on a non-finite sample is why this cannot happen quietly.
 */
export function paneStats(png, [x0, y0, x1, y1]) {
  const { data, width, height, channels } = png;
  if (x0 < 0 || y0 < 0 || x1 >= width || y1 >= height) {
    throw new Error(`box ${[x0, y0, x1, y1]} outside ${width}x${height}`);
  }
  const v = [];
  let clipped = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * channels;
      const L = LUMA(data[i], data[i + 1], data[i + 2]);
      if (!Number.isFinite(L)) throw new Error(`non-finite luma at ${x},${y} - stride or channels wrong`);
      if (data[i] >= 254 || data[i + 1] >= 254 || data[i + 2] >= 254) clipped++;
      v.push(L);
    }
  }
  v.sort((a, b) => a - b);
  const p05 = pct(v, 0.05), p50 = pct(v, 0.50), p95 = pct(v, 0.95);
  return { n: v.length, p05, p50, p95,
    // FLOOR and CEILING, never one number. modulation is the ceiling relative to
    // the pane's own middle, which is what "there is something in the window"
    // means; spread is the absolute range, which a paint reference then scales.
    modulation: p50 > 0 ? p95 / p50 : Infinity,
    spread: p95 - p05,
    // Exposure invariance is exact only while nothing clips. Reported beside every
    // ratio rather than assumed away.
    clippedPct: +(100 * clipped / v.length).toFixed(2) };
}

/**
 * GRADIENT OR CONTENT? Modulation cannot tell them apart, and the difference is
 * the whole question.
 *
 * p95/p50 is a histogram statistic. A smooth Fresnel ramp across a windscreen's
 * changing incidence angle and a reflected shopfront can produce the SAME
 * modulation, and only one of them is what "the window has something in it"
 * means. So fit a plane in linear light and split the variance:
 *
 *   planePct     how much of the pane's variance a single tilted plane explains
 *   residualRms  what is left, as a fraction of the pane's own median
 *
 * A pane reflecting a featureless sky is a plane: planePct near 100, residual
 * near 0. A pane reflecting a street has structure a plane cannot follow. This
 * matters here because scene.environment is built with
 * `pmrem.fromEquirectangular(this.lut.texture)` - the SKY LUT and nothing else,
 * no buildings, no street, no cars - so the correct prediction for any gain on
 * the environment term is that it raises the level and the gradient and leaves
 * the residual where it is. An instrument that could not see that distinction
 * would have called such a change a success.
 *
 * Least squares on (x, y, 1), which is exact and needs no iteration.
 */
export function planeFit(png, [x0, y0, x1, y1]) {
  const { data, width, channels } = png;
  let n = 0, sx = 0, sy = 0, sz = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  const vals = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = (y * width + x) * channels;
      const L = LUMA(data[i], data[i + 1], data[i + 2]);
      if (!Number.isFinite(L)) throw new Error(`non-finite luma at ${x},${y}`);
      // Centre the coordinates so the normal equations stay well conditioned.
      const u = x - (x0 + x1) / 2, v = y - (y0 + y1) / 2;
      n++; sx += u; sy += v; sz += L;
      sxx += u * u; sxy += u * v; syy += v * v; sxz += u * L; syz += v * L;
      vals.push([u, v, L]);
    }
  }
  const mz = sz / n;
  // Solve the 3x3 normal equations for z = a*u + b*v + c.
  const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const B = [sxz, syz, sz];
  const det = A[0][0] * (A[1][1] * A[2][2] - A[1][2] * A[2][1])
            - A[0][1] * (A[1][0] * A[2][2] - A[1][2] * A[2][0])
            + A[0][2] * (A[1][0] * A[2][1] - A[1][1] * A[2][0]);
  let a = 0, b = 0, c = mz;
  if (Math.abs(det) > 1e-12) {
    const d = (m) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
                   - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
                   + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    const sub = (col) => A.map((row, i) => row.map((val, j) => (j === col ? B[i] : val)));
    a = d(sub(0)) / det; b = d(sub(1)) / det; c = d(sub(2)) / det;
  }
  let ssTot = 0, ssRes = 0;
  const absRes = [];
  for (const [u, v, L] of vals) {
    ssTot += (L - mz) ** 2;
    const r = L - (a * u + b * v + c);
    ssRes += r * r;
    absRes.push(Math.abs(r));
  }
  absRes.sort((x, y) => x - y);
  return { n,
    planePct: ssTot > 0 ? +(100 * (1 - ssRes / ssTot)).toFixed(2) : 100,
    // RMS AND A ROBUST TWIN, BECAUSE THE RMS ALONE LIED ON THE FIRST REAL PANE IT
    // SAW. The 8.6 m windscreen read residualRms 1.4023 - deviation larger than the
    // pane's own median - on a box whose modulation is 1.278, which means 95% of it
    // lies within 1.278x of the median. Both cannot describe the same population
    // unless a handful of pixels carry the RMS, and they do: a squared statistic is
    // dominated by its outliers. residualMad is the MEDIAN absolute residual, which
    // is not, so a large RMS beside a small MAD reads as "a few hot pixels, not
    // structure" instead of as content that is not there.
    residualRms: mz > 0 ? +(Math.sqrt(ssRes / n) / mz).toFixed(4) : 0,
    residualMad: mz > 0 ? +(pct(absRes, 0.5) / mz).toFixed(4) : 0,
    residualP95: mz > 0 ? +(pct(absRes, 0.95) / mz).toFixed(4) : 0,
    // The plane's own tilt across the box, as a fraction of the median: how strong
    // the smooth gradient is, which is what a Fresnel term across changing
    // incidence actually looks like.
    tiltOverMedian: mz > 0 ? +((Math.abs(a) * (x1 - x0) + Math.abs(b) * (y1 - y0)) / mz).toFixed(4) : 0 };
}

/** The pane against a paint box on the same car in the same frame. */
export function paneVsPaint(png, paneBox, paintBox) {
  const g = paneStats(png, paneBox), p = paneStats(png, paintBox);
  return { pane: g, paint: p,
    medianOverPaint: g.p50 / p.p50,
    p95OverPaint: g.p95 / p.p50,
    floorOverPaint: g.p05 / p.p50,
    modulation: g.modulation };
}

// SUBJECTS, taken verbatim from the three blind reviewers' own boxes so that a
// before/after is comparable to what they said, and named with who measured what.
// The corridor camera is identical at both hours (a +/-3 px landmark search put the
// best cross-hour match at exactly (0,0)), so one box list serves both.
export const PANES = {
  // RE-CUT, BECAUSE THE BOX I HANDED THREE REVIEWERS MANUFACTURED A WRONG ANSWER.
  //
  // [190,642]-[300,668] clips the A-pillar highlight: max byte 164/168 inside a pane
  // whose own range is 12-26 and 28-56. Those pillar pixels are IDENTICAL in both
  // arms, so a cross-arm per-pixel regression is anchored at slope 1 and the whole
  // pane difference lands in the intercept:
  //
  //   handed box   B = 1.0000*A + 2.33e-2   R2 0.853   "a flat lift, a brighter hole"
  //   clean cut    B = 4.4422*A - 5.25e-3   R2 0.991   a SCALE, not a lift
  //
  // Reviewer 3 found it and said the thing that matters: three reviewers handed that
  // box and running the obvious probe on it would all independently report a flat
  // lift, and AGREE, because they were handed the same box. That is the second round
  // running in which a box of mine produced an agreement rather than a measurement -
  // last time a fixed box over moved geometry, this time a highlight anchoring a
  // regression. The bonnet reference is kept: it is byte-identical between arms at
  // both hours over 4,200 px, which is the one control that has never failed.
  nearWindscreen: { pane: [216, 628, 344, 684], paint: [120, 700, 260, 730],
    what: '8.6 m windscreen interior, re-cut clear of the A-pillar (rev3), paint = bonnet' },
  // A NEGATIVE CONTROL, AND IT USED TO BE THE HEADLINE FINDING.
  //
  // All three reviewers reported the rear quarter light as deleted, replaced with
  // painted metal, or absent, measured on this box: 0.2751 of the paint below it in
  // one arm and 1.3499 in the other, with modulation collapsing 4.576 -> 1.081. I
  // published that as a glazing regression. It is not. Holding the glazing at the
  // OLD metalness 0.86 and changing only the body shell moves this box the WHOLE
  // WAY:
  //
  //   cumS1-r5cum  coupe,  metalness 0.86   0.2751   modulation 4.576
  //   cumS3-r5cum  saloon, metalness 0.86   1.3680   modulation 1.081
  //   cumS3-r9cum  saloon, metalness 0.00   1.3499   modulation 1.081
  //
  // The saloon's roofline break is 0.2 m forward of the coupe's (-0.880 against
  // -1.080), so the quarter light moved and the box did not. It lands on glass in
  // the coupe and on body panel in the saloon. Nothing was deleted. Reviewer 2 had
  // written the exact warning for its OTHER box - "a box that is valid for one
  // arm's geometry is not automatically valid for the other's when the geometry is
  // what changed" - and then had the same fault here; so did I, reading it.
  //
  // Kept, relabelled, because in a 3-shell frame it is body panel and the glass
  // albedo lever must NOT move it. A sweep where it moves is reaching the wrong
  // vertices.
  r1QuarterControl: { pane: [1056, 590, 1082, 602], paint: [1056, 612, 1082, 620],
    what: 'NEGATIVE CONTROL: body panel in a 3-shell frame (was read as a deleted window)' },
  // ALSO RE-CUT. The paint reference [1120,604]-[1200,616] is HALF GLASS: rows
  // 604-609 are backlight at byte ~28 and only 610-615 are paint at ~195, so the
  // quantity under test was in the denominator. Reviewer 2 localised it to the row
  // and reviewer 3 to the byte, independently: p95/p05 reads 59.4 and 21.2 across
  // the arms on a panel whose clean cut reads 1.257 in BOTH. Medians survived - the
  // published ratios are ~6% off - but every shape statistic taken on it was noise.
  //
  // Reviewer 2 also found a warm sliver at x 1096-1110 that is identical in both
  // arms and dominates any night mean over the whole pane, so the pane box starts
  // at 1125 and stays there.
  r1Backlight: { pane: [1125, 582, 1185, 598], paint: [1100, 609, 1200, 616],
    what: '14.7 m rear screen interior, paint = boot lid clear of the glass (rev2/rev3)' },
};

function selftest() {
  let f = 0;
  const chk = (name, ok, got) => { if (!ok) { console.log(`  FAIL ${name}: ${got}`); f++; } else console.log(`  ok   ${name}: ${got}`); };

  // A synthetic frame, built rather than borrowed, so the expected answers are known.
  const W = 64, H = 64, ch = 3;
  const enc = (lin) => {
    const c = lin <= 0.0031308 ? 12.92 * lin : 1.055 * lin ** (1 / 2.4) - 0.055;
    return Math.max(0, Math.min(255, Math.round(c * 255)));
  };
  const mk = (fn) => {
    const data = new Uint8Array(W * H * ch);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const [r, g, b] = fn(x, y); const i = (y * W + x) * ch;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    return { data, width: W, height: H, channels: ch };
  };

  // 1. KNOWN-BAD: a flat pane must report modulation EXACTLY 1 and spread 0. A
  //    probe that cannot say "there is nothing in this window" cannot detect the
  //    defect it exists for.
  const flat = paneStats(mk(() => [40, 40, 40]), [8, 8, 40, 40]);
  chk('flat pane reads modulation 1.000 and spread 0',
    Math.abs(flat.modulation - 1) < 1e-9 && flat.spread < 1e-12,
    `modulation ${flat.modulation.toFixed(6)} spread ${flat.spread.toExponential(2)}`);

  // 2. ...and a pane with content must not. A 40->120 horizontal ramp.
  const ramp = paneStats(mk((x) => { const v = 40 + Math.round(80 * x / (W - 1)); return [v, v, v]; }), [8, 8, 40, 40]);
  chk('a pane with a gradient reads modulation > 1', ramp.modulation > 1.5,
    `modulation ${ramp.modulation.toFixed(3)} over a 40-120 ramp`);

  // 3. THE INVARIANCE CLAIM, measured comparatively rather than asserted. Scale the
  //    LINEAR signal by an exposure factor and re-encode: the linear ratio must hold
  //    and the sRGB-byte ratio must drift. This is CLAUDE.md's rule with a number
  //    attached.
  // A range a real pane actually spans - a near-black floor to a sky highlight.
  // My first version used 0.02-0.12, which is narrow enough that the OETF is close
  // to a power law over it and the sRGB ratio barely drifts (3.74%): the test could
  // not tell the two encodings apart, which made it a weak discriminator dressed as
  // a strong one. CLAUDE.md's ~20% figure is over a real bay's much wider span.
  const scene = (x) => 0.002 + 0.50 * (x / (W - 1)) ** 2;    // linear pane content
  const ratioAt = (k) => {
    const png = mk((x) => { const v = enc(scene(x) * k); return [v, v, v]; });
    const st = paneStats(png, [8, 8, 40, 40]);
    // and the same ratio computed on the raw bytes, for the comparison
    const { data, width, channels } = png;
    const bytes = [];
    for (let y = 8; y <= 40; y++) for (let x = 8; x <= 40; x++) bytes.push(data[(y * width + x) * channels]);
    bytes.sort((a, b) => a - b);
    return { lin: st.modulation, srgb: pct(bytes, 0.95) / pct(bytes, 0.50) };
  };
  const a = ratioAt(1), b = ratioAt(0.25), c = ratioAt(4);
  const linDrift = 100 * (Math.max(a.lin, b.lin, c.lin) - Math.min(a.lin, b.lin, c.lin)) / a.lin;
  const srgbDrift = 100 * (Math.max(a.srgb, b.srgb, c.srgb) - Math.min(a.srgb, b.srgb, c.srgb)) / a.srgb;
  // The linear residual is 8-BIT QUANTISATION, not a failure of the invariance -
  // reviewer 2 independently measured the same floor at 5.2% around linear 0.01.
  // So the assertion is comparative and both numbers are printed, which is the only
  // honest form for a claim whose exactness has a known floor.
  chk('the linear modulation survives 16x of exposure far better than the sRGB one',
    linDrift < srgbDrift / 4 && linDrift < 3,
    `linear drift ${linDrift.toFixed(2)}% vs sRGB ${srgbDrift.toFixed(2)}% over x0.25..x4` +
    ` (the linear residual is 8-bit quantisation, floor ~5% near linear 0.01)`);

  // 4. KNOWN-BAD: a 4-byte stride on a 3-channel buffer must THROW, not return a
  //    plausible number. This is the bug class CLAUDE.md names as the most
  //    dangerous, because its wrong answer is reassuring.
  // MY FIRST VERSION OF THIS TEST PASSED A UNIFORM GREY IMAGE AND DID NOT THROW,
  // and it was right not to: a misaligned read of a uniform buffer returns the same
  // value, and inside a box near the TOP the 4-stride index is still in range. So
  // the known-bad input has to be non-uniform AND low in the frame - which is
  // exactly where CLAUDE.md says the real bug reads NaN, "in the bottom quarter",
  // where the near car is. A test that cannot fail is not a test, and this one
  // could not until it was pointed at the right rows.
  let threw = false;
  try {
    const bad = mk((x, y) => { const v = (x * 3 + y * 5) % 200; return [v, v, v]; });
    bad.channels = 4;                       // a 3-channel buffer read with stride 4
    paneStats(bad, [8, H - 9, 40, H - 2]);  // the bottom rows, where it runs off the end
  } catch (e) { threw = true; }
  chk('a wrong stride throws rather than reading past the buffer', threw,
    threw ? 'threw on the bottom rows of a non-uniform image' : 'RETURNED A NUMBER');

  // 5. The clipped fraction must be reported and must be right, since the
  //    invariance above is exact only while nothing clips.
  const hot = paneStats(mk(() => [255, 255, 255]), [8, 8, 40, 40]);
  chk('clipping is counted', hot.clippedPct === 100, `${hot.clippedPct}% of a white box`);

  // 6. THE GRADIENT/CONTENT SPLIT, and the known-bad input is a PLANE. A probe that
  //    reports structure on a pure ramp cannot be used to argue a window has
  //    content in it.
  // THE RAMP HAS TO BE LINEAR IN LINEAR LIGHT, not in bytes. My first version built
  //    it as a byte ramp and read 99.19% / residual 0.0205 - correct behaviour, and
  //    it failed the test, because sRGB->linear is not a scale so a byte ramp is a
  //    CURVED surface in the space the fit works in. The probe was right and the
  //    fixture was wrong, which is the third time in this file.
  const linRamp = (x, y) => 0.02 + 0.30 * (x + y) / (2 * (W - 1));
  const ramp3 = mk((x, y) => { const v = enc(linRamp(x, y)); return [v, v, v]; });
  const pf1 = planeFit(ramp3, [8, 8, 40, 40]);
  chk('a pure tilted ramp is explained by a plane', pf1.planePct > 99.9 && pf1.residualRms < 0.01,
    `planeFit ${pf1.planePct}% residualRms ${pf1.residualRms} tilt ${pf1.tiltOverMedian}`);

  // 7. ...and structure must NOT be. A ramp plus a hard rectangle, which is what a
  //    reflected object looks like.
  const ramp3plus = mk((x, y) => {
    let lin = linRamp(x, y);
    if (x > 18 && x < 30 && y > 14 && y < 26) lin = 0.55;
    const v = enc(lin); return [v, v, v];
  });
  const pf2 = planeFit(ramp3plus, [8, 8, 40, 40]);
  chk('a ramp with an object in it is NOT', pf2.planePct < 90 && pf2.residualRms > pf1.residualRms * 5,
    `planeFit ${pf2.planePct}% residualRms ${pf2.residualRms} against the plain ramp's ${pf1.residualRms}`);

  //    AND THE ROBUST TWIN MUST SEPARATE THE TWO FAILURE MODES. A few hot pixels
  //    must move the RMS and NOT the MAD; real structure over a large area must
  //    move both. Without this the probe cannot tell "there is an object reflected
  //    in the window" from "three pixels caught the sun", and it read 1.4023 on a
  //    real windscreen whose modulation was 1.278 - which is the second case.
  const speck = mk((x, y) => {
    let lin = linRamp(x, y);
    if (x === 20 && y === 20) lin = 0.9;        // one pixel in 1,089
    const v = enc(lin); return [v, v, v];
  });
  const pf4 = planeFit(speck, [8, 8, 40, 40]);
  chk('one hot pixel moves the RMS and not the MAD',
    pf4.residualRms > pf1.residualRms * 3 && Math.abs(pf4.residualMad - pf1.residualMad) < 0.005,
    `RMS ${pf1.residualRms} -> ${pf4.residualRms}, MAD ${pf1.residualMad} -> ${pf4.residualMad}`);
  chk('...while real structure moves both',
    pf2.residualMad > pf1.residualMad * 3,
    `MAD ${pf1.residualMad} (ramp) -> ${pf2.residualMad} (ramp + object)`);

  // 8. And the split must survive an exposure change, or it cannot compare two
  //    builds: residualRms is normalised by the pane's own median for that reason.
  const dim = mk((x, y) => {
    let lin = linRamp(x, y);
    if (x > 18 && x < 30 && y > 14 && y < 26) lin = 0.55;
    const v = enc(lin * 0.25); return [v, v, v];
  });
  const pf3 = planeFit(dim, [8, 8, 40, 40]);
  chk('the gradient/content split survives a 4x exposure cut',
    Math.abs(pf3.residualRms - pf2.residualRms) / pf2.residualRms < 0.25,
    `residualRms ${pf3.residualRms} at x0.25 against ${pf2.residualRms} at x1`);

  console.log(f ? `CAR-PANE SELFTEST FAIL (${f})` : 'CAR-PANE SELFTEST OK');
  return f === 0;
}

const DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT && process.argv.includes('--selftest')) process.exit(selftest() ? 0 : 1);

if (DIRECT) {
  const tags = process.argv.slice(2).filter((x) => !x.startsWith('--'));
  const TIMES = (process.env.CP_TIMES ?? 'noon,night').split(',');
  if (!tags.length) { console.error('usage: car-pane.mjs <tag>...   (or --selftest)'); process.exit(2); }
  for (const [key, S] of Object.entries(PANES)) {
    console.log(`\n=== ${key}: ${S.what}`);
    console.log('  tod    tag                    med/paint  modulation  planeFit  residMAD  residP95  residRMS    tilt clipped');
    for (const tod of TIMES) {
      for (const tag of tags) {
        const file = `${SHOTS}/${tag}-corridor-${tod}.png`;
        if (!fs.existsSync(file)) { console.log(`  ${tod.padEnd(6)} ${tag.padEnd(22)} MISSING ${file}`); continue; }
        const png = readPNG(file);
        const r = paneVsPaint(png, S.pane, S.paint);
        const f = planeFit(png, S.pane);
        console.log(`  ${tod.padEnd(6)} ${tag.padEnd(22)} ${r.medianOverPaint.toFixed(4).padStart(9)}` +
          ` ${r.modulation.toFixed(3).padStart(10)} ${String(f.planePct).padStart(8)}%` +
          ` ${f.residualMad.toFixed(4).padStart(9)} ${f.residualP95.toFixed(4).padStart(9)} ${f.residualRms.toFixed(4).padStart(9)}` +
          ` ${f.tiltOverMedian.toFixed(4).padStart(7)} ${String(r.pane.clippedPct).padStart(6)}%`);
      }
    }
  }
}
