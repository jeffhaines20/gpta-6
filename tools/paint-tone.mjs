// WHAT A LIGHT CAR AND A DARK CAR ACTUALLY READ AS SIDE BY SIDE, off the reference photographs.
//
//   node tools/paint-tone.mjs --selftest
//   node tools/paint-tone.mjs                      # the measurement, and the gate
//   node tools/paint-tone.mjs --crop <row id>      # write an annotated crop to check a row's boxes
//   node tools/paint-tone.mjs --grid <file> --at x0,y0,x1,y1 [--zoom n]
//                                                  # a grid-labelled view, for PLACING a new box
//
// #1 / docs/BACKLOG.md: `reference/sarasota/car-colour-census.json` says 64.6% of the real
// population is white, silver or black, and NEITHER fleet can draw a white car or a black one.
// `src/traffic.js` drew `l = 0.34 + r * 0.26` and `src/streetfurniture.js` `l = 0.26 + u * 0.4`,
// which in three's WORKING colour space are linear albedos — so the whole shipped fleet lived
// between a mid grey and a light grey. The census named the FAMILIES and had no number for their
// TONE, which is the same gap #91 found for hue: a prose claim about appearance is a claim
// nothing can fail.
//
// THIS IS A RATIO BETWEEN TWO CARS, NOT AN ABSOLUTE LEVEL, and that is the whole method. These
// are auto-exposed JPEG panoramas, so no absolute pixel value means anything across frames. Two
// cars in the SAME frame, in the SAME light, with the SAME panel orientation, give a ratio that
// is a property of the two cars.
//
//   same frame        one exposure, so the ratio survives it (CLAUDE.md: ratios, in linear light)
//   same row          parked nose-in together, so one sun and one surround
//   same panel        the rear face of each car, so one orientation and one incidence
//
// All three are needed. A bonnet against a flank measures the sky, not the paint; a sunlit car
// against a shaded one measures the shade. Both of those were tried first and both gave numbers
// that looked fine — the f682 row below is kept as the record of the second one.
//
// WHAT THIS CANNOT DO, stated because it bounds every number here.
//
//   1. A ratio of PHOTOGRAPHED LUMINANCE is not a ratio of ALBEDO. It carries the ambient fill
//      both cars sit in and the clearcoat sheen both cars carry, and both lift the dark car
//      proportionally more. So a measured ratio is a floor on the albedo ratio, not an estimate
//      of it — which is the right direction for a gate that asks "is the shipped range wide
//      enough".
//   2. The camera's curve is not the sRGB OETF, AND I FIRST CLAIMED MORE THAN THAT ALLOWS. The
//      first version of this header said a pipeline LIFTS shadows, a lift compresses a ratio
//      toward 1, and therefore every reading here is a floor. The selftest proved the lift and
//      the header generalised it. A blind reviewer ran the other curves through the same chain:
//
//          true ratio 16, through encode -> curve -> EOTF
//            identity            16.00
//            lift  ^(1/1.3)       8.99      compresses
//            lift  ^(1/2)         4.33      compresses
//            TOE   ^1.15         22.57      EXPANDS
//            TOE   ^1.3          30.97      EXPANDS
//            S-curve smoothstep  66.69      EXPANDS, x4.2
//            additive glare +0.002 lin  15.10   compresses
//            additive glare +0.01  lin  12.36   compresses
//
//      A contrast S-curve on the encoded value is exactly what a consumer pipeline applies, and
//      it runs the wrong way. So the TONE-CURVE leg bounds nothing in either direction. What
//      survives is the ADDITIVE leg — veiling glare, clearcoat sheen and ambient fill lift the
//      dark car proportionally more, which compresses, by 5-23% at plausible magnitudes. That is
//      the one direction this file is allowed to claim.
//
//      So the two rows are two measurements and neither is a bound. What makes x16.9 believable
//      is that an INDEPENDENT source agrees: published white automotive paint is 0.75-0.85 and
//      black 0.04-0.06, a ratio of x12.5 to x21. Two lines of evidence landing on ~16 is the
//      argument; one photograph with a bound argued from a curve nobody has characterised is not.
//   3. It cannot resolve a hue or a family. Families here are the census's own labels, assigned
//      by eye on the annotated crops `--crop` writes.
//
// AND THE BOXES ARE DATA, NOT CODE — the same discipline `tools/glass-census.mjs` records. Each
// is a hand-placed rectangle on a named car in a named frame; `--crop` draws them over the image
// so a reader can check one landed where it says.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { PAINT_TONES, paintTone, ACHROMATIC_SHARE } from '../src/carpaint.js';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'reference/sarasota/mapillary';
const has = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

/** sRGB -> linear, the exact piecewise EOTF. The dark end is where the dark car is. */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Rec.709 luma in linear light. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * THE ROWS. Each is one frame, one parked row, one panel orientation, and the cars in it.
 * `light` records what the row is standing in, because it turned out to be the dominant term.
 * Boxes are [x, y, w, h] in the ORIGINAL image's pixels (2048 x 1024 for these panoramas).
 */
const ROWS = [
  {
    id: 'main-lot-sun',
    file: 'mly-538231612303303.jpg',
    light: 'open lot, midday sun, no tree shade on any of the three',
    panel: 'rear face (tailgate / boot lid / lower tailgate), all three parked nose-in',
    note: 'the row this tool was built for: three census families, one frame, one light, one panel',
    cars: [
      { id: 'minivan', family: 'white', note: 'white minivan, lower tailgate', box: [1106, 546, 11, 5] },
      { id: 'fusion', family: 'silver', note: 'silver sedan, lower tailgate band', box: [1225, 608, 44, 6] },
      { id: 'bmw', family: 'black', note: 'black saloon, boot lid below the rear screen', box: [1160, 570, 36, 6] },
    ],
  },
  {
    /**
     * THE SAME MEASUREMENT IN DEEP SHADE, AND IT READS 8.9x SMALLER. Kept, and quoted, because
     * it is the floor the gate is written against and because the disagreement is the finding:
     * nothing about these two cars is unusual, and 1.89 against 16.9 is what the light does.
     * Both subjects sit in the shadow region, and I first wrote that any pipeline lifts there, a
     * lift compresses, and therefore this row understates. The selftest proves the lift and only
     * the lift; a toe or an S-curve EXPANDS the same ratio (see the header). So this row is a
     * second measurement and NOT a bound, and what it is actually good for is the disagreement:
     * two rows of the same quantity landing x9.0 apart is what says the LIGHT is the dominant
     * term, which no single row could have told anybody. A round that had measured only this one
     * would have concluded the real spread is about 2x and shipped something barely wider.
     */
    id: 'kerb-shade',
    file: 'mly-1371467967414042.jpg',
    light: 'deep building shade, no direct sun on either car',
    panel: 'rear face (tailgate), both parked nose-in',
    note: 'the dim arm: a sanity floor for the gate, and the measurement that says the LIGHT dominates',
    cars: [
      { id: 'suv', family: 'black', note: 'charcoal SUV, tailgate — the census family "black" is "black, charcoal and any dark body"', box: [155, 562, 35, 10] },
      { id: 'pickup', family: 'white', note: 'white pickup, lower tailgate', box: [231, 594, 50, 7] },
    ],
  },
  {
    /**
     * REJECTED, AND RECORDED RATHER THAN DELETED. This was the first row tried: the silver Ford
     * Fusion `glass-census` already carries a verified box on, against the dark SUV behind it in
     * the same frame. It reads 1.84 and it measures nothing, for two reasons that are each
     * enough: the SUV is dark BRONZE rather than black (mean sRGB 81,70,62 — warm), and it sits
     * in tree shade while the Fusion does not. Two cars in one frame is not the control; one
     * light and one panel is.
     */
    id: 'f682-mixed',
    file: 'mly-682234297680292.jpg',
    light: 'MIXED — the SUV is in tree shade and the Fusion is not',
    panel: 'near-side flank on both',
    reject: 'mixed light, and the dark car is bronze rather than any shade of black',
    cars: [
      { id: 'rangerover', family: 'bronze', note: 'dark bronze SUV, rear flank, in tree shade', box: [1126, 589, 19, 10] },
      { id: 'fusion', family: 'silver', note: 'silver Ford Fusion, rear door — the box glass-census uses', box: [1470, 711, 30, 11] },
    ],
  },
];

/**
 * THE SHIPPED RENDER, MEASURED BY THE SAME INSTRUMENT AS THE PHOTOGRAPHS.
 *
 * `hero-shots` with HERO_ARMS=paint0,paint1 captures the before and after off ONE page load, ONE
 * camera, ONE settled district — see `tools/ground-albedo.mjs`'s arm table. The two arms are 10
 * rendered frames apart (0.5 s of sim at the clamped dt) and the audits record `triangles`,
 * `chunks`, `lodNear`, `lodFar` and `drawCalls` byte-identical between them, so the resident set
 * and the geometry are the same and only the world clock moved.
 *
 * THE SUBJECTS ARE TWO PARKED CARS, which do not move at all in that 0.5 s. A moving car does —
 * up to 5 m — so a fixed box on one would be measuring a different car, which is this project's
 * "a fixed box over moved geometry" section arriving through the sim instead of the shell.
 *
 * AND ONE OF THEM IS A CHROMATIC CAR, WHICH IS THE CONTROL THAT MAKES THE REST READABLE. The
 * chromatic lightness did not change this round, so its paint must come back BYTE-IDENTICAL. It
 * does — 0.3575, mean sRGB 161,138,147 in both arms — and that single number says three things at
 * once: the arms are registered to the pixel on static geometry, the exposure and the light are
 * the same, and the one term that was supposed to stay still did.
 */
const RENDER = {
  id: 'shipped-render-noon',
  dir: '.',
  before: 'docs/shots/paint-paint0-fivepoints-noon.png',
  after: 'docs/shots/paint-paint1-fivepoints-noon.png',
  boxes: [
    { id: 'chromatic.paint', note: "the pink car's boot lid, clear of its tail lights", box: [202, 552, 32, 7] },
    { id: 'chromatic.plate', note: "and its number plate", box: [217, 578, 13, 4] },
    { id: 'achromatic.paint', note: "the grey car's boot lid, clear of its tail lights", box: [4, 552, 32, 7] },
    { id: 'achromatic.plate', note: "and its number plate", box: [17, 575, 15, 4] },
  ],
};

async function sampleRender(page) {
  const out = {};
  for (const [arm, file] of [['before', RENDER.before], ['after', RENDER.after]]) {
    if (!fs.existsSync(file)) return { missing: file };
    const r = await sampleRow(page, { id: arm, dir: RENDER.dir, file,
      cars: RENDER.boxes.map((b) => ({ ...b, family: 'render' })) });
    out[arm] = Object.fromEntries(r.cars.map((c) => [c.id, c]));
  }
  return out;
}

/**
 * ONE INSTRUMENT ON BOTH SIDES OF THE COMPARISON. A row may name its own directory, so a captured
 * frame from `docs/shots` is sampled by exactly the code the reference photographs are — same
 * EOTF, same median, same clipped fraction, same p10/p90 spread. CLAUDE.md's rule about two
 * instruments disagreeing is a rule about not HAVING two, where one will do.
 */
async function sampleRow(page, row) {
  const file = path.join(row.dir ?? DIR, row.file);
  if (!fs.existsSync(file)) return { ...row, error: 'missing file' };
  const mime = file.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const data = `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  const px = await page.evaluate(([src, boxes]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width; c.height = img.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(img, 0, 0);
      resolve({ w: img.width, h: img.height, boxes: boxes.map((b) => {
        const d = x.getImageData(b[0], b[1], b[2], b[3]).data;
        const out = [];
        for (let i = 0; i < d.length; i += 4) out.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
        return out;
      }) });
    };
    img.onerror = () => resolve(null);
    img.src = src;
  }), [data, row.cars.map((c) => c.box)]);
  if (!px) return { ...row, error: 'decode failed' };
  const cars = row.cars.map((c, i) => {
    const p = px.boxes[i];
    /**
     * CLIPPING DESTROYS A RATIO and the error runs toward 1 on the bright car, which is the
     * flattering direction here. Carried per box rather than mentioned, as glass-census does.
     */
    const clipped = p.filter(([r, g, b]) => r >= 1 || g >= 1 || b >= 1).length / p.length;
    const L = p.map(([r, g, b]) => luma(toLinear(r), toLinear(g), toLinear(b))).sort((a, b) => a - b);
    const q = (f) => L[Math.min(L.length - 1, Math.max(0, Math.round(f * (L.length - 1))))];
    const mean = p.reduce((a, c2) => [a[0] + c2[0], a[1] + c2[1], a[2] + c2[2]], [0, 0, 0])
      .map((v) => Math.round(255 * v / p.length));
    return { ...c, n: L.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), clipped, meanSRGB: mean };
  });
  const byFam = (f) => cars.filter((c) => c.family === f);
  const white = byFam('white')[0], black = byFam('black')[0];
  return { ...row, imgW: px.w, imgH: px.h, cars,
    /**
     * The row's own white/black ratio, and the SPREAD the two boxes' own p10/p90 allow. That
     * spread is the tolerance any claim against this row has to live inside — measured from the
     * boxes rather than picked, which is CLAUDE.md's rule for a bound.
     */
    ratio: white && black ? white.p50 / black.p50 : null,
    ratioLo: white && black ? white.p10 / black.p90 : null,
    ratioHi: white && black ? white.p90 / black.p10 : null };
}

/** An annotated crop over one row's boxes, so they can be checked by eye. */
async function crop(page, row, outFile) {
  const f = path.join(row.dir ?? DIR, row.file);
  const mime = f.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const data = `data:${mime};base64,${fs.readFileSync(f).toString('base64')}`;
  const png = await page.evaluate(([src, boxes]) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const M = 40;
      const x0 = Math.max(0, Math.min(...boxes.map((b) => b[0])) - M);
      const y0 = Math.max(0, Math.min(...boxes.map((b) => b[1])) - M);
      const x1 = Math.min(img.width, Math.max(...boxes.map((b) => b[0] + b[2])) + M);
      const y1 = Math.min(img.height, Math.max(...boxes.map((b) => b[1] + b[3])) + M);
      const S = Math.max(2, Math.min(10, Math.round(1400 / Math.max(1, x1 - x0))));
      const c = document.createElement('canvas');
      c.width = (x1 - x0) * S; c.height = (y1 - y0) * S;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
      const cols = ['#00ff00', '#ff00ff', '#ffff00', '#00ffff'];
      x.lineWidth = 2;
      boxes.forEach((b, i) => {
        x.strokeStyle = cols[i % cols.length];
        x.strokeRect((b[0] - x0) * S, (b[1] - y0) * S, b[2] * S, b[3] * S);
      });
      res(c.toDataURL('image/png'));
    };
    img.onerror = () => res(null);
    img.src = src;
  }), [data, row.cars.map((c) => c.box)]);
  if (!png) return false;
  fs.writeFileSync(outFile, Buffer.from(png.split(',')[1], 'base64'));
  return true;
}

// --------------------------------------------------------------- the shipped fleets' tone range
/**
 * WHAT THE TWO CALL SITES ACTUALLY DRAW, read out of the source rather than restated here.
 *
 * Restating a range in a gate is how a gate stops testing the build: CLAUDE.md's "a probe that
 * hardcodes the value it is testing cannot see the fix". Both modules are read for the line that
 * produces their CHROMATIC lightness, because the achromatic one now comes from PAINT_TONES and
 * is checked directly.
 */
const CHROMATIC_L = [
  { file: 'src/traffic.js', re: /CHROMATIC_L\s*=\s*\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]/ },
  { file: 'src/streetfurniture.js', re: /CHROMATIC_L\s*=\s*\[\s*([0-9.]+)\s*,\s*([0-9.]+)\s*\]/ },
];
function chromaticRanges() {
  return CHROMATIC_L.map(({ file, re }) => {
    const m = fs.readFileSync(file, 'utf8').match(re);
    return { file, lo: m ? +m[1] : null, hi: m ? +m[2] : null };
  });
}
/** The achromatic tone range the shipped table can reach, and its family medians. */
function toneStats() {
  const lo = Math.min(...PAINT_TONES.map((t) => t.l0));
  const hi = Math.max(...PAINT_TONES.map((t) => t.l1));
  const med = Object.fromEntries(PAINT_TONES.map((t) => [t.name, (t.l0 + t.l1) / 2]));
  return { lo, hi, span: hi / lo, med, ratio: med.white / med.black };
}

// --------------------------------------------------------------------------- selftest
function selftest() {
  let fail = 0;
  const say = (ok, name, detail) => {
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  say(Math.abs(toLinear(0.5) - 0.21404114) < 1e-6, 'the sRGB EOTF at its published anchor',
    toLinear(0.5).toFixed(8));
  say(toLinear(0) === 0 && toLinear(1) === 1, 'and at both ends');

  /**
   * THE CLAIM THE WHOLE "FLOOR" READING RESTS ON: a shadow LIFT compresses a ratio toward 1.
   *
   * Every phone and pano pipeline lifts shadows — it is what makes a backlit photograph usable —
   * and the lift is larger in relative terms at the dark end than at the bright one. So two
   * surfaces at a true reflectance ratio R are photographed at something SMALLER than R, and the
   * reading is a floor. Shown here on a plain gamma-style lift rather than argued.
   */
  const encode0 = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const trueRatio = 16;
  const brightTrue = 0.50, darkTrue = brightTrue / trueRatio;
  /** The real chain: linear -> encode -> the camera's own curve -> this tool's EOTF. */
  const through = (curve) => toLinear(curve(encode0(brightTrue))) / toLinear(curve(encode0(darkTrue)));
  const smoothstep = (x) => x * x * (3 - 2 * x);
  const id = through((x) => x);
  const lift13 = through((x) => x ** (1 / 1.3)), lift2 = through((x) => x ** (1 / 2));
  const toe115 = through((x) => x ** 1.15), toe13 = through((x) => x ** 1.3);
  const scurve = through(smoothstep);
  console.log(`    a true ratio of ${trueRatio} reads: identity ${id.toFixed(2)}, ` +
    `lift^(1/1.3) ${lift13.toFixed(2)}, lift^(1/2) ${lift2.toFixed(2)}, ` +
    `toe^1.15 ${toe115.toFixed(2)}, toe^1.3 ${toe13.toFixed(2)}, S-curve ${scurve.toFixed(2)}`);
  say(Math.abs(id - trueRatio) < 1e-9, 'no curve reads the truth', id.toFixed(4));
  say(lift13 < trueRatio && lift2 < lift13, 'a LIFT compresses a ratio toward 1',
    `${lift13.toFixed(2)} then ${lift2.toFixed(2)}`);
  /**
   * AND THE OTHER DIRECTION, WHICH THE FIRST VERSION OF THIS ARM DID NOT MODEL AND THE HEADER
   * GENERALISED FROM ANYWAY. A toe or a contrast S-curve — which is exactly what a consumer JPEG
   * pipeline applies — EXPANDS the same ratio, the S-curve by x4.2. So "a measured ratio is a
   * floor" was overreach: the tone-curve leg bounds nothing in either direction, and only the
   * additive leg below does. A blind reviewer found this; the arm now proves both ways so the
   * claim cannot be made again from this file.
   */
  say(toe115 > trueRatio && toe13 > toe115 && scurve > toe13,
    'KNOWN-BAD: a TOE or an S-curve EXPANDS it, so no curve argument bounds a measured ratio',
    `${toe115.toFixed(2)}, ${toe13.toFixed(2)}, ${scurve.toFixed(2)} against ${trueRatio}`);
  /**
   * The additive leg is the one directional statement that survives: veiling glare, clearcoat
   * sheen and ambient fill add a floor to BOTH subjects, which lifts the dark one proportionally
   * more. That compresses, always, and it is why a photographed car-to-car ratio understates the
   * albedo ratio whatever the curve does.
   */
  const glare = (g) => (brightTrue + g) / (darkTrue + g);
  say(glare(0.002) < trueRatio && glare(0.01) < glare(0.002),
    'an ADDITIVE floor (glare, sheen, ambient) compresses, monotonically — the one direction that holds',
    `${glare(0.002).toFixed(2)} at +0.002 and ${glare(0.01).toFixed(2)} at +0.01 linear`);
  /**
   * KNOWN-BAD: the same two surfaces read in sRGB-ENCODED values rather than linear ones. That
   * is a lift too — the OETF is exactly a shadow lift — so it makes the same error, and this
   * tool would read 3.4 where the truth is 16 if it skipped the EOTF.
   */
  const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const srgbRead = encode(brightTrue) / encode(darkTrue);
  say(srgbRead < trueRatio / 3,
    'KNOWN-BAD: reading the same pair in sRGB values collapses it, because the OETF IS a lift',
    `${srgbRead.toFixed(2)} against ${trueRatio}`);
  /**
   * And the invariance that makes a within-frame ratio worth taking at all: in LINEAR light it
   * does not move with exposure, so the camera's auto-exposure cannot reach it.
   */
  const stops = [-1, -0.5, 0, 0.5, 1].map((s) => (brightTrue * 2 ** s) / (darkTrue * 2 ** s));
  say(Math.max(...stops) - Math.min(...stops) < 1e-12,
    'a linear ratio is exactly exposure-invariant, which is why both boxes must be in one frame',
    `spread ${(Math.max(...stops) - Math.min(...stops)).toExponential(1)}`);

  // The table itself.
  const t = toneStats();
  const wsum = PAINT_TONES.reduce((a, x) => a + x.w, 0);
  say(Math.abs(wsum - 1) < 1e-9, 'the tone weights sum to 1', wsum.toFixed(6));
  say(t.med.white > t.med.silver && t.med.silver > t.med.black,
    'and the three tones are ordered white > silver > black',
    `${t.med.white.toFixed(3)} / ${t.med.silver.toFixed(3)} / ${t.med.black.toFixed(3)}`);
  /**
   * paintTone is a PARTITION of [0,1): every draw lands in exactly one tone, the shares are the
   * weights, and the lightness it returns is inside that tone's own range. The failure this
   * guards is the one `paintFamily`'s comment names — a `for` loop over weights that falls off
   * the end and returns undefined, reaching the caller as `setHSL(..., undefined)`.
   */
  const N = 200000, seen = Object.fromEntries(PAINT_TONES.map((x) => [x.name, 0]));
  let inRange = 0, finite = 0;
  for (let i = 0; i < N; i++) {
    const r = paintTone((i + 0.5) / N);
    if (r && seen[r.name] !== undefined) seen[r.name]++;
    const row = PAINT_TONES.find((x) => x.name === r.name);
    if (row && r.l >= row.l0 - 1e-12 && r.l <= row.l1 + 1e-12) inRange++;
    if (Number.isFinite(r.l)) finite++;
  }
  say(finite === N && inRange === N, 'every draw returns a finite lightness inside its own tone',
    `${inRange}/${N}`);
  const worst = Math.max(...PAINT_TONES.map((x) => Math.abs(seen[x.name] / N - x.w)));
  say(worst < 1e-3, 'and the observed shares are the weights', `worst ${worst.toExponential(2)}`);
  for (const bad of [NaN, -1, Infinity, undefined]) {
    const r = paintTone(bad);
    if (!(r && Number.isFinite(r.l))) say(false, `a ${String(bad)} draw still returns a tone`);
  }
  say(true, 'and NaN / negative / Infinity / undefined all return a finite tone');

  console.log(fail ? `PAINT-TONE SELFTEST FAIL (${fail})` : 'PAINT-TONE SELFTEST OK');
  return fail === 0;
}

// --------------------------------------------------------------------------- main
if (has('selftest')) process.exit(selftest() ? 0 : 1);

const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();

/**
 * A GRID-LABELLED VIEW OF ANY REGION OF ANY FRAME, which is how the boxes above were placed.
 *
 * Here because the alternative is the next round rediscovering it. Placing a 10x5 px box on a
 * named panel of a named car in a 2048x1024 panorama by guessing coordinates is hours; reading
 * them off a grid drawn in the ORIGINAL image's own pixel numbers is minutes, and `--crop` then
 * checks the result. Four of the six boxes in this file were moved at least once because the
 * first placement straddled a shut line, a taillight or the boundary of a shadow, and every one
 * of those announced itself as a p10/p90 spread before the crop confirmed it.
 */
/**
 * AD-HOC SAMPLING OF ANY FRAME, which is the other half of `--grid`: place a box by reading the
 * grid, then read what it actually contains before writing it into a table. Every box in ROWS was
 * moved at least once between those two steps.
 *
 *   node tools/paint-tone.mjs --sample docs/shots/x.png --boxes 745,547,40,15;1045,602,85,15
 */
if (has('sample')) {
  const file = arg('sample', '');
  const boxes = String(arg('boxes', '')).split(';').filter(Boolean)
    .map((b) => b.split(',').map(Number));
  if (!fs.existsSync(file) || !boxes.length) {
    console.error('usage: --sample <path> --boxes x,y,w,h[;x,y,w,h...]');
    process.exit(2);
  }
  const r = await sampleRow(page, { id: 'adhoc', dir: '.', file,
    cars: boxes.map((b, i) => ({ id: `box${i}`, family: 'n/a', note: '', box: b })) });
  for (const c of r.cars) {
    console.log(`${c.box.join(',').padEnd(18)} n=${String(c.n).padStart(5)}  ` +
      `p10 ${c.p10.toFixed(4)}  p50 ${c.p50.toFixed(4)}  p90 ${c.p90.toFixed(4)}  ` +
      `clip ${(100 * c.clipped).toFixed(1)}%  meanSRGB ${c.meanSRGB.join(',')}`);
  }
  // ALWAYS WRITE THE ANNOTATED CROP. A number from an unverified box is the failure this whole
  // file is built around, and making the verification opt-in is how it gets skipped.
  fs.mkdirSync('docs/shots', { recursive: true });
  const out = 'docs/shots/paint-tone-sample.png';
  await crop(page, { dir: '.', file, cars: r.cars }, out);
  console.log(`  boxes drawn over the frame: ${out}`);
  await browser.close();
  process.exit(0);
}

if (has('grid')) {
  const file = arg('grid', '');
  const [x0, y0, x1, y1] = String(arg('at', '0,0,2048,1024')).split(',').map(Number);
  const zoom = +arg('zoom', '6');
  // A bare name is a reference frame; anything with a separator is a path, so the same grid can
  // be put over a CAPTURED frame when a box has to be placed on the render.
  const full = file.includes('/') ? file : path.join(DIR, file);
  if (!fs.existsSync(full)) { console.error(`no such frame: ${full}`); process.exit(2); }
  const mime = full.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const data = `data:${mime};base64,${fs.readFileSync(full).toString('base64')}`;
  const png = await page.evaluate(([src, a, b, c, d, s2]) => new Promise((res) => {
    const img = new Image();
    img.onload = () => {
      const cv = document.createElement('canvas');
      cv.width = (c - a) * s2; cv.height = (d - b) * s2;
      const x = cv.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(img, a, b, c - a, d - b, 0, 0, cv.width, cv.height);
      x.font = '11px monospace';
      for (let gx = Math.ceil(a / 20) * 20; gx < c; gx += 20) {
        x.strokeStyle = gx % 100 === 0 ? 'rgba(255,0,0,0.75)' : 'rgba(255,0,0,0.22)';
        x.lineWidth = 1; x.beginPath();
        x.moveTo((gx - a) * s2, 0); x.lineTo((gx - a) * s2, cv.height); x.stroke();
        if (gx % 100 === 0) { x.fillStyle = '#ff2020'; x.fillText(String(gx), (gx - a) * s2 + 2, 12); }
      }
      for (let gy = Math.ceil(b / 20) * 20; gy < d; gy += 20) {
        x.strokeStyle = gy % 100 === 0 ? 'rgba(0,160,255,0.75)' : 'rgba(0,160,255,0.22)';
        x.lineWidth = 1; x.beginPath();
        x.moveTo(0, (gy - b) * s2); x.lineTo(cv.width, (gy - b) * s2); x.stroke();
        if (gy % 100 === 0) { x.fillStyle = '#00a0ff'; x.fillText(String(gy), 2, (gy - b) * s2 - 2); }
      }
      res(cv.toDataURL('image/png'));
    };
    img.onerror = () => res(null);
    img.src = src;
  }), [data, x0, y0, x1, y1, zoom]);
  fs.mkdirSync('docs/shots', { recursive: true });
  const out = `docs/shots/paint-tone-grid.png`;
  fs.writeFileSync(out, Buffer.from(png.split(',')[1], 'base64'));
  console.log(`wrote ${out} — ${x0},${y0} to ${x1},${y1} at x${zoom}, labelled in ORIGINAL pixels`);
  await browser.close();
  process.exit(0);
}

if (has('crop')) {
  const id = arg('crop', '');
  const row = ROWS.find((r) => r.id === id);
  if (!row) { console.error(`no row "${id}"; have: ${ROWS.map((r) => r.id).join(', ')}`); process.exit(2); }
  const out = `docs/shots/paint-tone-${id}.png`;
  fs.mkdirSync('docs/shots', { recursive: true });
  console.log(await crop(page, row, out) ? `wrote ${out}` : 'crop failed');
  await browser.close();
  process.exit(0);
}

const rows = [];
for (const r of ROWS) rows.push(await sampleRow(page, r));
/**
 * THE RENDER PAIR IS SAMPLED ON THE SAME PAGE, not on a second browser. The first version
 * launched its own chromium for this and doubled the tool's cost — which matters because it is on
 * `mutation-sweep`'s offline list, where every row pays it. 2.45 s a run against 1.3 s, over ~124
 * rows, is five minutes of sweep for nothing. A blind reviewer timed it and found the "about 1 s"
 * in CLAUDE.md was 2.5x optimistic as well; both are restated.
 */
const render = await sampleRender(page);
await browser.close();

const checks = [];
const check = (ok, name, detail) => { checks.push({ ok, name, detail }); return ok; };

console.log('=== ROWS  (linear luma, one frame / one light / one panel per row)');
for (const r of rows) {
  console.log(`\n${r.id}  ${r.file}`);
  console.log(`  light  ${r.light}`);
  console.log(`  panel  ${r.panel}`);
  if (r.reject) console.log(`  REJECTED: ${r.reject}`);
  if (r.error) { console.log(`  ERROR ${r.error}`); continue; }
  for (const c of r.cars) {
    console.log(`    ${c.id.padEnd(12)} ${c.family.padEnd(8)} n=${String(c.n).padStart(4)}  ` +
      `p10 ${c.p10.toFixed(4)}  p50 ${c.p50.toFixed(4)}  p90 ${c.p90.toFixed(4)}  ` +
      `clip ${(100 * c.clipped).toFixed(1)}%  meanSRGB ${c.meanSRGB.join(',')}   ${c.note}`);
  }
  if (r.ratio) {
    console.log(`    white / black = ${r.ratio.toFixed(2)}   ` +
      `(the boxes' own p10/p90 allow ${r.ratioLo.toFixed(2)} .. ${r.ratioHi.toFixed(2)})`);
  }
}

const sun = rows.find((r) => r.id === 'main-lot-sun');
const shade = rows.find((r) => r.id === 'kerb-shade');
const t = toneStats();

console.log('\n=== WHAT THE TWO USABLE ROWS SAY');
console.log(`  sunlit   white/black ${sun.ratio.toFixed(2)}   the ESTIMATE; subjects span ` +
  `${sun.cars.map((c) => c.p50.toFixed(3)).join(' .. ')}, most of the usable range`);
console.log(`  shaded   white/black ${shade.ratio.toFixed(2)}   a SANITY FLOOR, not a bound: both ` +
  'subjects sit deep in the shadow region and the camera curve there is uncharacterised');
console.log(`  they disagree by x${(sun.ratio / shade.ratio).toFixed(1)}, and the difference is ` +
  `the light the two rows stand in, not the cars`);
console.log('  NEITHER is a bound — a lift compresses and a toe or an S-curve expands (see ' +
  '--selftest). x16.9 is believable because published white/black automotive paint is ' +
  'x12.5 to x21: two independent lines on ~16.');

console.log('\n=== WHAT THE BUILD DRAWS');
for (const tone of PAINT_TONES) {
  console.log(`  ${tone.name.padEnd(7)} w ${tone.w.toFixed(3)}  l ${tone.l0.toFixed(3)} .. ` +
    `${tone.l1.toFixed(3)}  median ${((tone.l0 + tone.l1) / 2).toFixed(4)}`);
}
console.log(`  achromatic share ${ACHROMATIC_SHARE}  (both call sites)`);
console.log(`  tone span ${t.lo.toFixed(4)} .. ${t.hi.toFixed(4)} = x${t.span.toFixed(2)}, ` +
  `white median / black median = x${t.ratio.toFixed(2)}`);
for (const c of chromaticRanges()) {
  console.log(`  chromatic lightness, ${c.file}: ${c.lo} .. ${c.hi}` +
    (c.lo === null ? '   NOT FOUND' : ''));
}

/**
 * THE OLD RANGES, AS LITERALS, because this is the one place a literal belongs: they are what the
 * build used to draw and they are gone from the source, so nothing can read them back. They are
 * here to show the checks below have teeth — both fail on them.
 */
const OLD = { traffic: [0.34, 0.60], parked: [0.26, 0.66] };

// ---------------------------------------------------------------- the shipped render
{
  const R = render;
  if (R.missing) {
    console.log(`\n=== THE SHIPPED RENDER — skipped, no ${R.missing}`);
    console.log('   (capture it with HERO_SHOTS=fivepoints HERO_TIMES=noon,dusk ' +
      'HERO_ARMS=paint0,paint1 HERO_TAG=paint node tools/hero-shots.mjs)');
    check(false, 'the committed before/after pair is present', `missing ${R.missing}`);
  } else {
    console.log('\n=== THE SHIPPED RENDER, same instrument, same statistic as the rows above');
    for (const b of RENDER.boxes) {
      const x = R.before[b.id], y = R.after[b.id];
      console.log(`  ${b.id.padEnd(17)} ${x.p50.toFixed(4)} -> ${y.p50.toFixed(4)}  ` +
        `x${(y.p50 / x.p50).toFixed(2)}   clip ${(100 * x.clipped).toFixed(1)}/` +
        `${(100 * y.clipped).toFixed(1)}%   ${b.note}`);
    }
    const cp = [R.before['chromatic.paint'], R.after['chromatic.paint']];
    const cl = [R.before['chromatic.plate'], R.after['chromatic.plate']];
    const ap = [R.before['achromatic.paint'], R.after['achromatic.paint']];
    const al = [R.before['achromatic.plate'], R.after['achromatic.plate']];
    console.log(`  plate / its own paint:  chromatic ${(cl[0].p50 / cp[0].p50).toFixed(3)} -> ` +
      `${(cl[1].p50 / cp[1].p50).toFixed(3)},  achromatic ` +
      `${(al[0].p50 / ap[0].p50).toFixed(3)} -> ${(al[1].p50 / ap[1].p50).toFixed(3)}`);

    /**
     * THE CONTROL FIRST, because every number under it is unreadable without it. If the chromatic
     * car's paint moved, the two frames are not registered or the light is not the same, and the
     * plate figures below are measuring that instead.
     */
    check(cp[0].p50 === cp[1].p50,
      'CONTROL: the chromatic car\'s paint is byte-identical between the arms',
      `${cp[0].p50.toFixed(4)} both, mean sRGB ${cp[0].meanSRGB.join(',')} / ${cp[1].meanSRGB.join(',')}`);
    /**
     * AND THE FINDING, which nothing but a de-tint produces: on the car whose paint got DARKER,
     * the plate got BRIGHTER. A brightness change, an exposure change, a different hour or a
     * mis-registered pair all move the two the SAME way.
     */
    check(ap[1].p50 < ap[0].p50 && al[1].p50 > al[0].p50,
      'the achromatic car got darker while its own number plate got brighter',
      `paint x${(ap[1].p50 / ap[0].p50).toFixed(2)}, plate x${(al[1].p50 / al[0].p50).toFixed(2)}`);
    check(al[0].p50 / ap[0].p50 < 1 && al[1].p50 / ap[1].p50 > 1,
      'so the plate goes from darker than the paint it is bolted to, to brighter — which is what a plate is',
      `${(al[0].p50 / ap[0].p50).toFixed(3)} -> ${(al[1].p50 / ap[1].p50).toFixed(3)}`);
    /**
     * The chromatic car's plate moves too, on a body that did not. That is the de-tint ALONE,
     * with the tone change held at zero by the control above — the cleanest isolation the pair
     * offers, and it needs no assumption about which tone that car drew.
     */
    check(cl[1].p50 > cl[0].p50 * 1.5,
      'and on the car whose paint did NOT move, the plate still does — the de-tint, isolated',
      `x${(cl[1].p50 / cl[0].p50).toFixed(2)} on a body that moved x${(cp[1].p50 / cp[0].p50).toFixed(2)}`);
    for (const b of RENDER.boxes) {
      const worst = Math.max(R.before[b.id].clipped, R.after[b.id].clipped);
      if (worst > 0) check(false, `${b.id} clips`, `${(100 * worst).toFixed(2)}%`);
    }
    check(RENDER.boxes.every((b) => R.before[b.id].clipped === 0 && R.after[b.id].clipped === 0),
      'no box in the render pair clips, in either arm', 'worst 0.00%');
  }
}

console.log('\n=== CHECKS');
check(t.span >= shade.ratio,
  'the fleet can draw a tone range at least as wide as the DIMMEST pair measured — a sanity floor',
  `x${t.span.toFixed(2)} against x${shade.ratio.toFixed(2)}`);
/**
 * HALF A CASE, AND IT READ AS A GUARD. This tested `OLD.traffic` alone while its message said
 * "the range this replaced" and its detail printed BOTH fleets' figures. The parked pool's old
 * range is x2.54, which CLEARS this floor — so the floor alone never established the defect for
 * that fleet, and only the tighter check below did. A blind reviewer found it. It now names the
 * fleet it is about, and the parked pool's own statement is the one under it.
 */
check((OLD.traffic[1] / OLD.traffic[0]) < shade.ratio,
  "KNOWN-BAD: the MOVING fleet's old range could not reach even that, which is what made it a defect",
  `traffic x${(OLD.traffic[1] / OLD.traffic[0]).toFixed(2)} against x${shade.ratio.toFixed(2)}`);
check((OLD.parked[1] / OLD.parked[0]) >= shade.ratio,
  "and the PARKED pool's old range cleared this floor, so the floor alone never established its defect",
  `parked x${(OLD.parked[1] / OLD.parked[0]).toFixed(2)} against x${shade.ratio.toFixed(2)} — ` +
  'the check two lines down is what catches that fleet');
/**
 * WHAT THIS CHECK IS AND IS NOT. `PAINT_TONES.black` was CONSTRUCTED as 0.80 / 16.94, so
 * `t.ratio` is `sun.ratio` by construction and `sun.ratioLo <= sun.ratio <= sun.ratioHi` always
 * holds — it cannot fail for the shipped value, and presenting it as the photographs validating
 * the table would be CLAUDE.md's "a self-validation that closes over the same quantity twice".
 * A blind reviewer said so.
 *
 * It is a live check on the TABLE, not evidence for it: `mutation-sweep`'s `tone-ratio` row moves
 * black to 0.140..0.200 and falls outside. What it really asserts is printed beside it — with
 * white held at its median the band admits a black median anywhere from 0.021 to 0.138, a factor
 * of 6.45, and 0.138 is a mid-grey car. That is the strength of this check and it is three times
 * weaker than it reads.
 */
check(t.ratio >= sun.ratioLo && t.ratio <= sun.ratioHi,
  "a white car over a black one lands inside the sunlit row's OWN box spread (a check on the table, not evidence for it)",
  `x${t.ratio.toFixed(2)} in x${sun.ratioLo.toFixed(2)}..x${sun.ratioHi.toFixed(2)} — which admits a ` +
  `black median anywhere in ${(t.med.white / sun.ratioHi).toFixed(4)}..${(t.med.white / sun.ratioLo).toFixed(4)}, ` +
  `a factor of ${(sun.ratioHi / sun.ratioLo).toFixed(2)}`);
check((OLD.parked[1] / OLD.parked[0]) < sun.ratioLo,
  'KNOWN-BAD: and the widest old range did not reach even the bottom of that spread',
  `x${(OLD.parked[1] / OLD.parked[0]).toFixed(2)} against x${sun.ratioLo.toFixed(2)}`);
/**
 * A ROW IS ONLY A MEASUREMENT IF ITS BOXES ARE. Clipping reads 1.0 whatever the surface is and
 * runs toward 1 on the bright car — the flattering direction for the question this asks.
 */
for (const r of [sun, shade]) {
  const worst = Math.max(...r.cars.map((c) => c.clipped));
  check(worst === 0, `${r.id}: no box in this row clips`, `worst ${(100 * worst).toFixed(2)}%`);
}
check(sun.cars.find((c) => c.family === 'silver').p50 < sun.cars.find((c) => c.family === 'white').p50
  && sun.cars.find((c) => c.family === 'silver').p50 > sun.cars.find((c) => c.family === 'black').p50,
  'the sunlit row orders white > silver > black, which is the ordering the table reproduces',
  sun.cars.map((c) => `${c.family} ${c.p50.toFixed(4)}`).join('  '));
/**
 * The SILVER figure is deliberately not used for a ratio. Metallic flake lifts a silver car's
 * photographed luminance well above its diffuse albedo, so silver/black here (x12.3) is not a
 * reflectance ratio and nothing is fitted to it. The ORDER is what the row supports.
 */
const ranges = chromaticRanges();
check(ranges.every((c) => c.lo !== null),
  "both call sites still declare a chromatic lightness range this tool can read",
  ranges.map((c) => `${path.basename(c.file)} ${c.lo}..${c.hi}`).join('  '));


const failed = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nPAINT-TONE: ${failed.length ? 'FAIL' : 'PASS'} — ${checks.length} checks` +
  (failed.length ? `, ${failed.length} failed` : ''));
process.exit(failed.length ? 1 : 0);
