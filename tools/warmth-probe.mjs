// Two questions this round was opened for, and the exposure-robust metrics that
// answer them.
//
//   1. IS OPEN SHADE WARMER THAN THE SUN? A low sun is the warmest source in the
//      frame, so the fill it leaves behind must be COOLER than it. Three blind
//      reviewers measured the opposite on the r4 build.
//   2. IS THERE ANY HEADROOM ABOVE GROUND ALBEDO AT NOON? The sky must be
//      brighter than the ground it lights. On r4 it is darker.
//
// WHY THESE METRICS AND NOT R-B. Noon's camera stop moved between the two builds
// being compared, so any absolute byte quantity - R-B, mean L, "how many pixels
// over 200" - is not comparable across them. Everything below is a RATIO taken
// inside ONE frame:
//
//   * R/B of scene-linear radiance on one material. Exposure is an achromatic
//     scalar, so it cancels exactly. The display bytes are inverted through
//     critic-metrics.mjs's srgb -> aces -> rolloff inverse first, because ACES is
//     per-channel and R/B on a BYTE is not the R/B of any radiance.
//   * sky luminance / ground luminance, both in the same frame.
//   * the fraction of the frame above a byte, which is a property of the
//     tonemap's shoulder rather than of the stop.
//
// AND WHY THE SUN/SHADE SPLIT IS GEOMETRIC. A "shaded" mask thresholded on luma
// RESELECTS ITSELF when the frame gets brighter: raise the stop and the darkest
// 20% of a brighter frame is a different set of pixels, so a change that lifted
// every shadow reads as no change at all. I made that exact mistake earlier in
// this round and it reported a real move as zero. So the mask here comes from an
// A/B of the renderer's own shadow map - base against shadows-off - which is a
// pure visibility term. The same pixel set is selected in both builds because it
// is selected by geometry, not by brightness.
//
// THE PRIMARY METRIC HAS NO MATERIAL CONFOUND AT ALL. armSplit() reads the SAME
// pixels twice, once with the sun on and once with it off:
//
//     fill   = nosun                      what the shade of that pixel is lit by
//     direct = base - nosun               what the sun adds to that same pixel
//
// Both carry the same surface albedo, so comparing their hues compares the two
// ILLUMINANTS and nothing else. "Shade is warmer than sun" is exactly
// fillRB > directRB, and no choice of sample rectangle can manufacture it.
//
// WHAT THE nosun ARM ACTUALLY REMOVES, because it is more than the beam and the
// difference matters for reading these numbers. daynight.js recomputes the
// district bounce from the sun's CURRENT intensity every frame (follow() calls
// _applyBounce()), so zeroing the DirectionalLight also zeroes the sun's share of
// the interreflection. The split is therefore
//
//     fill   = sky + the sky's own share of the bounce
//     direct = the beam + everything the beam causes by bouncing
//
// which is the more useful cut for this question rather than a flaw in it: "is
// the fill warmer than the sun" is asked of what survives the sun's removal
// against what does not. It does mean fillRB is INSENSITIVE to any change to the
// bounce's sun term - it reads the same before and after this round's fix, to
// three decimals, because that term is multiplied by an intensity of zero in
// both arms. The shipped fill is read instead off the frame: the ground-plane
// R-B and R/B rows below, and shadeRB in the band table.
//
//   node tools/warmth-probe.mjs --selftest
//   node tools/warmth-probe.mjs report <tag> [<tag> ...]      # committed frames
//   node tools/warmth-probe.mjs capture                       # renders the arms
//
// capture takes WARMTH_TAG, WARMTH_TIMES, WARMTH_PORT (its own port: 8123 is the
// main tree's and tools/serve.mjs throws rather than photograph it).
import fs from 'node:fs';
import { readPNG } from './png.mjs';
import { unDisplay } from './critic-metrics.mjs';

// --------------------------------------------------------------- the geometry
// 1600x900, the hero framing. Stated once here so a later round re-reads the
// same surfaces rather than re-choosing them.
const W = 1600, H = 900;

// Material bands. One band is one surface class, so a shade/sun split taken
// inside it compares two illuminants on one albedo rather than brick against
// asphalt. [x, y, w, h].
const BANDS = {
  corridor: {
    brickwalk: [1240, 620, 360, 270],   // clay pavers, right-hand walk
    carriageway: [500, 700, 620, 190],  // asphalt, centre of the road
  },
  fivepoints: {
    brickwalk: [1240, 620, 360, 260],
    carriageway: [520, 700, 600, 190],
  },
};

// The review's own two boxes for defect 2, quoted verbatim from its report, plus
// the plaza box it read the fivepoints ground from.
const SKY = { corridor: [270, 95, 80, 60], fivepoints: [300, 40, 120, 80] };
const LIT_GROUND = { corridor: [1330, 690, 120, 70], fivepoints: [760, 700, 140, 100] };
// The review's OWN sky rects land on things that are not clear sky - the corridor
// one is inside the oak canopy's alpha cards - so a clean patch is read alongside
// them rather than instead of them, and both are reported.
const SKY_CLEAN = { corridor: [160, 220, 80, 40], fivepoints: [700, 20, 200, 60] };
// The round's own win metric, in the round's own units: "Five Points ground plane
// mean R-B went -5.8 -> +40.0 at golden". R-B in bytes is NOT comparable across a
// stop change - see critic-metrics.mjs - but golden's stop is 1/9,649 on both the
// pre-round and the post-round build, so at GOLDEN it is comparable and it is the
// number that says whether the warmth this round bought has been reverted.
const GROUND = { fivepoints: [60, 640, 1440, 260], corridor: [60, 660, 1440, 240] };

// --------------------------------------------------------------- the maths
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** Mean scene-linear radiance x exposure over a rect, per channel. */
export function meanLinear(img, [x0, y0, w, h], mask = null) {
  const { width, height, channels: C, data } = img;
  let r = 0, g = 0, b = 0, br = 0, bg = 0, bb = 0, n = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      if (mask && !mask[y * width + x]) continue;
      const i = (y * width + x) * C;
      // C, not 4. Playwright writes 3-channel PNGs for opaque screenshots; a
      // hardcoded 4 misaligns every sample and runs off the end of the buffer in
      // the bottom quarter, where the reads come back undefined -> NaN. NaN
      // fails every comparison silently, so the rows that are wrong are exactly
      // the rows that report "no difference". selftest() below fails on it.
      r += unDisplay(data[i]); g += unDisplay(data[i + 1]); b += unDisplay(data[i + 2]);
      br += data[i]; bg += data[i + 1]; bb += data[i + 2];
      n++;
    }
  }
  if (!n) return null;
  return { R: r / n, G: g / n, B: b / n, r: br / n, g: bg / n, b: bb / n, n };
}

const rb = (m) => (m && m.B > 1e-9 ? m.R / m.B : NaN);

/** Display luma over a rect. Ratios of this survive an exposure change; it alone does not. */
export function meanLuma(img, rect) {
  const m = meanLinear(img, rect);
  return m ? luma(m.r, m.g, m.b) : NaN;
}

/** Fraction of the frame at or above a byte, any channel. The tonemap's shoulder. */
export function overFraction(img, t = 230) {
  const { width, height, channels: C, data } = img;
  let n = 0;
  for (let i = 0; i < width * height * C; i += C) {
    if (data[i] >= t || data[i + 1] >= t || data[i + 2] >= t) n++;
  }
  return (100 * n) / (width * height);
}

/**
 * The illuminant split, on ONE set of pixels.
 *   fillRB   R/B of what lights the surface with the sun switched off
 *   sunRB    R/B of what the sun ADDS to that same surface
 * `frac` is the direct term's share of the total, so a rect that turns out to be
 * in shadow declares itself rather than being read as a hue finding.
 */
export function armSplit(base, nosun, rect, mask = null) {
  const b = meanLinear(base, rect, mask), s = meanLinear(nosun, rect, mask);
  if (!b || !s) return null;
  const d = { R: b.R - s.R, G: b.G - s.G, B: b.B - s.B };
  const yb = luma(b.R, b.G, b.B), ys = luma(s.R, s.G, s.B);
  const share = (yb - ys) / Math.max(yb, 1e-9);
  return {
    n: b.n,
    fillRB: +rb(s).toFixed(3),
    // A rect the sun barely reaches has a direct term that is quantisation noise,
    // and R/B of noise is a number with a decimal point and no meaning. At golden
    // the ground plane is 94-98% inside the shadow map, so this is the common
    // case and not the edge case: it is reported as null rather than as a hue.
    sunRB: share > 0.02 && d.B > 1e-6 ? +rb(d).toFixed(3) : null,
    // > 1 means the shade is warmer than the sunlight, which is the defect.
    fillOverSun: share > 0.02 && d.B > 1e-6 ? +(rb(s) / rb(d)).toFixed(3) : null,
    directShare: +share.toFixed(3),
  };
}

/**
 * TWO DISJOINT GEOMETRIC MASKS, and neither is a brightness threshold.
 *
 *   shade  the sun is measurably BLOCKED here:  noshadow - base > t
 *   sun    the sun measurably REACHES here:     base - nosun   > t
 *
 * "not in shadow" is NOT the same as "sunlit", and reading it that way is what
 * makes an in-frame shade/sun table lie at a low sun. A wall turned away from an
 * 8-degree sun, a kerb face, the underside of an awning: none of them is in the
 * shadow map and none of them has any sun on it either, so putting them in the
 * "sun" population fills it with fill-lit pixels and the two columns converge no
 * matter what the light is doing. Measured at the corridor at golden: the
 * complement of the shadow mask reads R/B 2.104 over the brick walk, and the set
 * that the sun actually reaches reads 1.526 - the same band, the same frame, a
 * 0.58 difference that comes entirely from how "sun" was defined.
 *
 * `t` is in radiance x exposure, a fixed physical amount of light rather than a
 * fixed number of bytes, so the same threshold means the same thing at any stop.
 */
export function lightMasks(base, nosun, noshadow, t = 0.02) {
  if (base.width !== noshadow.width || base.channels !== noshadow.channels) throw new Error('arm mismatch');
  if (base.width !== nosun.width || base.channels !== nosun.channels) throw new Error('arm mismatch');
  const { width, height, channels: C, data } = base;
  const sd = noshadow.data, nd = nosun.data;
  const shade = new Uint8Array(width * height), sun = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * C;
    const dShade = luma(unDisplay(sd[i]) - unDisplay(data[i]),
      unDisplay(sd[i + 1]) - unDisplay(data[i + 1]),
      unDisplay(sd[i + 2]) - unDisplay(data[i + 2]));
    const dSun = luma(unDisplay(data[i]) - unDisplay(nd[i]),
      unDisplay(data[i + 1]) - unDisplay(nd[i + 1]),
      unDisplay(data[i + 2]) - unDisplay(nd[i + 2]));
    if (!Number.isFinite(dShade) || !Number.isFinite(dSun)) {
      throw new Error(`non-finite at pixel ${p} — stride wrong?`);
    }
    shade[p] = dShade > t ? 1 : 0;
    sun[p] = dSun > t ? 1 : 0;
  }
  return { shade, sun };
}

/** Backwards-compatible single mask: where the sun is blocked. */
export function shadowMask(base, noshadow, t = 0.02) {
  return lightMasks(base, base, noshadow, t).shade;
}

/** Shade vs sun INSIDE one material band, split by the two disjoint masks. */
export function bandSplit(base, masks, rect) {
  const sh = meanLinear(base, rect, masks.shade), su = meanLinear(base, rect, masks.sun);
  if (!sh || !su) return null;
  // 3,000 px of a ~100,000 px band. Below that the sun column is a handful of
  // pixels on whatever happens to be catching a gap in the canopy - at golden,
  // after this round's fix, the corridor carriageway has NONE - and a table that
  // prints an R/B for it is inviting the reading three reviewers already made.
  const thin = su.n < 3000;
  return {
    shadeRB: +rb(sh).toFixed(3), shadeN: sh.n, shadeL: +luma(sh.r, sh.g, sh.b).toFixed(1),
    sunRB: thin ? null : +rb(su).toFixed(3), sunN: su.n,
    sunL: thin ? null : +luma(su.r, su.g, su.b).toFixed(1),
    deltaRB: thin ? null : +(rb(su) - rb(sh)).toFixed(3),
    thinSunPopulation: thin,
    // The share of the band the sun reaches at all. At an 8-degree sun in a
    // 16 m / 22 m canyon a wall's shadow is 114 m long, so this is the number
    // that says whether an in-frame sun/shade table has a sun column worth
    // reading at all.
    sunPct: +((100 * su.n) / Math.max(1, sh.n + su.n)).toFixed(1),
  };
}

// ------------------------------------------------------------------ selftest
// A new metric needs a test that FAILS on known-bad input, or it is an assertion.
// Three of the four cases below are deliberately-broken inputs.
const fwdAces = (x) => {
  const v = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  return Math.max(0, Math.min(1, v));
};
const fwdRoll = (x, K = 0.5, C = 8.0) => {
  const S = C - K, t = Math.max(x - K, 0);
  return Math.min(x, K) + (S * t) / (S + t);
};
const fwdSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);
/** radiance x exposure -> the byte src/post.js would write. */
const encode = (v) => Math.max(0, Math.min(255, Math.round(255 * fwdSrgb(fwdAces(fwdRoll(v))))));

function synth(channels, rgbAt) {
  const data = new Uint8Array(W * H * channels);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [r, g, b] = rgbAt(x, y);
      const i = (y * W + x) * channels;
      data[i] = encode(r); data[i + 1] = encode(g); data[i + 2] = encode(b);
      if (channels === 4) data[i + 3] = 255;
    }
  }
  return { width: W, height: H, channels, data };
}

function selftest() {
  const fails = [];
  const ok = (name, cond, detail) => {
    console.log(`  ${cond ? 'pass' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!cond) fails.push(name);
  };

  // 1. A known radiance ratio must come back through the full display chain. The
  //    numbers are chosen mid-range, where the inverse is exact to the byte.
  const RB_TRUE = 2.50;
  const flat = synth(3, () => [0.50, 0.30, 0.50 / RB_TRUE]);
  const got = rb(meanLinear(flat, [100, 100, 200, 200]));
  ok('R/B of a known radiance recovered', Math.abs(got - RB_TRUE) < 0.02, `got ${got.toFixed(3)}`);

  // 2. THE KNOWN-BAD INPUT THIS TOOL EXISTS TO REFUSE. The same image read with a
  //    4-byte stride: every sample past pixel 0 is misaligned and the tail of the
  //    buffer is undefined, so the answer must NOT be the right one.
  const badStride = { ...flat, channels: 4 };
  let badGot = NaN;
  try { badGot = rb(meanLinear(badStride, [100, 100, 200, 200])); } catch { badGot = NaN; }
  ok('a 4-stride read of a 3-channel frame does NOT return the right answer',
    !(Math.abs(badGot - RB_TRUE) < 0.02), `got ${Number.isFinite(badGot) ? badGot.toFixed(3) : 'NaN'}`);

  // 3. armSplit must report the ILLUMINANT hue, not the surface hue. One albedo,
  //    a warm sun and a cool fill: the split has to separate them, and a probe
  //    that just read the base frame would report the mixture for both.
  const ALB = [0.40, 0.28, 0.16];              // brick: R/B 2.5 all by itself
  const FILL = [0.30, 0.34, 0.50];             // cool  fill, R/B 0.60
  const SUN = [1.60, 1.20, 0.80];              // warm direct, R/B 2.00
  const nosun = synth(3, () => ALB.map((a, k) => a * FILL[k]));
  const base = synth(3, () => ALB.map((a, k) => a * (FILL[k] + SUN[k])));
  const sp = armSplit(base, nosun, [200, 200, 300, 300]);
  ok('armSplit recovers the FILL hue through the albedo',
    Math.abs(sp.fillRB - 2.5 * 0.60) < 0.06, `fillRB ${sp.fillRB} want ${(2.5 * 0.6).toFixed(3)}`);
  ok('armSplit recovers the SUN hue through the same albedo',
    Math.abs(sp.sunRB - 2.5 * 2.00) < 0.12, `sunRB ${sp.sunRB} want ${(2.5 * 2).toFixed(3)}`);
  ok('armSplit calls this frame sun-warmer-than-shade', sp.fillOverSun < 1,
    `fillOverSun ${sp.fillOverSun}`);

  // 4. ...and it must call the DEFECT when the fill is the warm one. Same albedo,
  //    hues swapped. A metric that cannot fire is not a metric.
  const nosun2 = synth(3, () => ALB.map((a, k) => a * SUN[k] * 0.25));
  const base2 = synth(3, () => ALB.map((a, k) => a * (SUN[k] * 0.25 + FILL[k] * 1.2)));
  const sp2 = armSplit(base2, nosun2, [200, 200, 300, 300]);
  ok('armSplit fires on a warm-fill/cool-sun frame', sp2.fillOverSun > 1.5,
    `fillOverSun ${sp2.fillOverSun}`);

  // 5. The shadow mask must be a VISIBILITY term, not a brightness one: a frame
  //    that is uniformly brighter has no shadow in it and must mask nothing.
  const brighter = synth(3, () => [0.80, 0.60, 0.40]);
  const dimmer = synth(3, () => [0.40, 0.30, 0.20]);
  const m0 = lightMasks(brighter, brighter, brighter);
  ok('identical arms mask nothing',
    m0.shade.reduce((a, v) => a + v, 0) === 0 && m0.sun.reduce((a, v) => a + v, 0) === 0);
  // base dim, noshadow bright, nosun == base: every pixel is occluded and none is sunlit.
  const m1 = lightMasks(dimmer, dimmer, brighter);
  ok('a fully occluded frame is all shade and no sun',
    m1.shade.reduce((a, v) => a + v, 0) === W * H && m1.sun.reduce((a, v) => a + v, 0) === 0);
  // base bright, nosun dim, noshadow == base: every pixel is sunlit and none is occluded.
  const m2 = lightMasks(brighter, dimmer, brighter);
  ok('a fully sunlit frame is all sun and no shade',
    m2.sun.reduce((a, v) => a + v, 0) === W * H && m2.shade.reduce((a, v) => a + v, 0) === 0);
  // THE KNOWN-BAD DEFINITION. "not in shadow" must NOT be read as "sunlit": a
  // frame where the sun reaches nothing and nothing occludes it (a fully
  // fill-lit frame) has an EMPTY sun set, and the complement of the shadow mask
  // would call all of it sunlit.
  const m3 = lightMasks(dimmer, dimmer, dimmer);
  ok('a fill-lit frame has an empty sun set, not a full one',
    m3.sun.reduce((a, v) => a + v, 0) === 0);

  // 6. overFraction has to count what it says it counts.
  const half = synth(3, (x) => (x < W / 2 ? [8, 8, 8] : [0.02, 0.02, 0.02]));
  const of = overFraction(half, 230);
  ok('overFraction counts the bright half', Math.abs(of - 50) < 0.5, `got ${of.toFixed(2)}%`);

  console.log(fails.length ? `\nSELFTEST FAILED (${fails.length}): ${fails.join(', ')}` : '\nSELFTEST PASSED');
  return fails.length;
}

// -------------------------------------------------------------------- report
const F = (v, w = 6) => String(v).padStart(w);

function reportTag(tag) {
  const rows = [];
  for (const framing of ['corridor', 'fivepoints']) {
    for (const tod of ['noon', 'golden', 'dusk', 'night']) {
      const f = `docs/shots/${tag}-${framing}-${tod}.png`;
      if (!fs.existsSync(f)) continue;
      const img = readPNG(f);
      const skyL = meanLuma(img, SKY[framing]);
      const gndL = meanLuma(img, LIT_GROUND[framing]);
      const cleanL = meanLuma(img, SKY_CLEAN[framing]);
      const g = meanLinear(img, GROUND[framing]);
      const row = { tag, framing, tod,
        skyL: +skyL.toFixed(1), litGroundL: +gndL.toFixed(1),
        skyOverGround: +(skyL / gndL).toFixed(3),
        skyCleanL: +cleanL.toFixed(1),
        skyCleanOverGround: +(cleanL / gndL).toFixed(3),
        groundRminusB: +(g.r - g.b).toFixed(1),
        groundRB: +(g.R / g.B).toFixed(3),
        over230Pct: +overFraction(img, 230).toFixed(3),
        over245Pct: +overFraction(img, 245).toFixed(3) };
      for (const [bn, rect] of Object.entries(BANDS[framing])) {
        row[`${bn}RB`] = +rb(meanLinear(img, rect)).toFixed(3);
      }
      // The paired arms, when this tag has them.
      const ns = `docs/shots/${tag}-nosun-${framing}-${tod}.png`;
      const nsh = `docs/shots/${tag}-noshadow-${framing}-${tod}.png`;
      if (fs.existsSync(ns)) {
        const nosun = readPNG(ns);
        for (const [bn, rect] of Object.entries(BANDS[framing])) {
          const sp = armSplit(img, nosun, rect);
          if (sp) row[`${bn}Split`] = sp;
        }
      }
      if (fs.existsSync(nsh) && fs.existsSync(ns)) {
        const masks = lightMasks(img, readPNG(ns), readPNG(nsh));
        for (const [bn, rect] of Object.entries(BANDS[framing])) {
          const bs = bandSplit(img, masks, rect);
          if (bs) row[`${bn}Band`] = bs;
        }
      }
      rows.push(row);
    }
  }
  return rows;
}

function printRows(rows) {
  console.log('\nDEFECT 2 — headroom above ground albedo (ratios inside one frame)');
  console.log('  tag/framing/tod            skyL  groundL   sky/gnd  cleanSky  clean/gnd   >230%   >245%');
  for (const r of rows) {
    console.log(`  ${(r.tag + ' ' + r.framing + ' ' + r.tod).padEnd(26)}` +
      `${F(r.skyL)} ${F(r.litGroundL)}   ${F(r.skyOverGround)}   ${F(r.skyCleanL)}    ${F(r.skyCleanOverGround)}  ` +
      `${F(r.over230Pct)}  ${F(r.over245Pct)}`);
  }
  console.log('\n  The round\'s own warmth win, in its own units (comparable at GOLDEN only,');
  console.log('  where the stop did not move between the two builds):');
  console.log('  tag/framing/tod            ground plane mean R-B   ground plane R/B');
  for (const r of rows) {
    console.log(`  ${(r.tag + ' ' + r.framing + ' ' + r.tod).padEnd(26)}${F(r.groundRminusB, 15)}${F(r.groundRB, 19)}`);
  }
  console.log('\nDEFECT 1 — is the fill warmer than the sun? (R/B of scene-linear radiance)');
  console.log('  tag/framing/tod            band          fillRB  sunRB  fill/sun  directShare');
  for (const r of rows) {
    for (const bn of Object.keys(BANDS[r.framing])) {
      const s = r[`${bn}Split`];
      if (!s) continue;
      console.log(`  ${(r.tag + ' ' + r.framing + ' ' + r.tod).padEnd(26)} ${bn.padEnd(13)}` +
        `${F(s.fillRB)} ${F(s.sunRB)}   ${F(s.fillOverSun)}     ${F(s.directShare)}` +
        (s.fillOverSun > 1 ? '   <-- shade warmer than sun' : ''));
    }
  }
  const anyBand = rows.some((r) => Object.keys(BANDS[r.framing]).some((b) => r[`${b}Band`]));
  if (anyBand) {
    console.log('\n  ...and as a reviewer reads it: shade vs sun IN the frame, geometric mask');
    console.log('  tag/framing/tod            band          shadeRB  sunRB   dRB   shadeL  sunL   sun%');
    for (const r of rows) {
      for (const bn of Object.keys(BANDS[r.framing])) {
        const s = r[`${bn}Band`];
        if (!s) continue;
        console.log(`  ${(r.tag + ' ' + r.framing + ' ' + r.tod).padEnd(26)} ${bn.padEnd(13)}` +
          `${F(s.shadeRB)} ${F(s.sunRB)} ${F(s.deltaRB)}  ${F(s.shadeL)} ${F(s.sunL)} ${F(s.sunPct)}` +
          (s.sunN < 3000 ? '   (sun population thin)' : ''));
      }
    }
  }
  console.log('\n  R/B on a band with no arms (whole band, sun and shade together):');
  console.log('  tag/framing/tod            brickwalk  carriageway');
  for (const r of rows) {
    console.log(`  ${(r.tag + ' ' + r.framing + ' ' + r.tod).padEnd(26)}${F(r.brickwalkRB, 9)}    ${F(r.carriagewayRB, 9)}`);
  }
}

// Only act as a CLI when run directly. The metrics above are imported by other
// probes, and an unguarded module body would run this argv parse against THEIR
// argv and exit with a usage message - the same trap tools/arm-diff.mjs and
// tools/street-dir.mjs were both caught by.
const DIRECT = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/warmth-probe.mjs');
const argv = DIRECT ? process.argv.slice(2) : [];
if (argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const mode = argv[0] ?? (DIRECT ? 'report' : 'none');
if (mode === 'none') { /* imported as a module */ } else
if (mode === 'report') {
  const tags = argv.slice(1);
  if (!tags.length) { console.error('usage: warmth-probe.mjs report <tag> [<tag>...]'); process.exit(2); }
  const rows = tags.flatMap(reportTag);
  printRows(rows);
  fs.mkdirSync('docs/measurements', { recursive: true });
  fs.writeFileSync(`docs/measurements/warmth-${tags.join('-')}.json`,
    JSON.stringify({ bands: BANDS, sky: SKY, litGround: LIT_GROUND, rows }, null, 1));
  console.log(`\nwrote docs/measurements/warmth-${tags.join('-')}.json`);
} else if (mode === 'capture') {
  await (await import('./warmth-capture.mjs')).run();
} else {
  console.error(`unknown mode ${mode}`);
  process.exit(2);
}
