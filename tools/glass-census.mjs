// WHAT A CAR WINDOW ACTUALLY READS AS, measured off the reference photographs.
//
//   node tools/glass-census.mjs --selftest
//   node tools/glass-census.mjs                      # the census, and the gate
//   node tools/glass-census.mjs --crop <car id>      # write an annotated crop to check a box
//
// #92: the shipped car's side glass reads 0.914 to 1.043 of the DOOR SKIN BESIDE IT at noon —
// between 8.6% darker than the paint and 4% brighter — and 0.0225 of it at night. A window that
// reads as a window is well under half the paint beside it. The backlog's own note says what was
// missing: "what the target ratio IS, which should be measured off reference/sarasota/mapillary
// rather than asserted". This is that measurement.
//
// THE RATIO IS TAKEN IN LINEAR LIGHT, which is CLAUDE.md's rule and matters more here than
// usual: an sRGB-encoded ratio is not invariant under exposure and these frames are a camera's
// auto-exposed JPEGs. Both boxes are in the SAME frame under the same exposure, so after
// linearising, glass/paint is a property of the two surfaces rather than of the capture.
//
// WHAT THIS CANNOT DO, said out loud because it bounds every number below. The camera's tone
// curve is not exactly sRGB — there is contrast and highlight rolloff in any phone JPEG — so
// linearising with the sRGB EOTF leaves a residual. It is a MONOTONE curve applied to both
// boxes, so the ORDERING and the rough magnitude survive; a ratio of 0.25 is not really 0.95.
// The claim this file supports is "well under half", not "0.247 exactly", and the gate is
// written as a band rather than a point for that reason.
//
// AND THE BOXES ARE DATA, NOT CODE. Each is a hand-placed rectangle on a named car in a named
// frame, listed below with what it is meant to be on. `--crop` writes the box outlines over the
// image so a reader can check one landed where it says. That is the same discipline as
// CLAUDE.md's "print the angle you actually built, not the one you meant" — a box that slid onto
// a pillar or a highlight is invisible in the number and obvious in the crop.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import fs from 'node:fs';
import path from 'node:path';

const DIR = 'reference/sarasota/mapillary';
const has = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

/**
 * sRGB -> linear, the exact piecewise EOTF rather than a 2.2 power. The difference matters at
 * the dark end, which is exactly where glass lives.
 */
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
/** Rec.709 luma in linear light. */
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/**
 * THE SUBJECTS. Each is one car with its side glass and the painted door skin beside it, in the
 * same frame, at the same range, under the same light. `glass` is on the side window and `paint`
 * on the door below it; both are chosen inside flat, unobstructed areas away from highlights,
 * the beltline chrome and any reflection of a bright object.
 *
 * Boxes are [x, y, w, h] in the ORIGINAL image's pixels (2048 x 1024 for these panoramas).
 */
const SUBJECTS = [
  { id: 'fusion-silver', file: 'mly-682234297680292.jpg', pane: 'side', note: 'silver Ford Fusion, side-on',
    glass: [1470, 681, 30, 9], paint: [1470, 711, 30, 11] },
  { id: 'suburban-white', file: 'mly-562274623010141.jpg', pane: 'side', note: 'white Chevy Suburban',
    glass: [690, 585, 30, 10], paint: [690, 625, 30, 12] },
  { id: 'lexus-white', file: 'mly-562274623010141.jpg', pane: 'side', note: 'white Lexus sedan, rear quarter',
    glass: [1285, 618, 20, 7], paint: [1285, 640, 20, 7] },
  { id: 'prius-white', file: 'mly-562274623010141.jpg', pane: 'side', note: 'white Toyota Prius',
    glass: [1740, 620, 30, 9], paint: [1740, 655, 30, 11] },
  /**
   * DROPPED: a white Chevy Tahoe in mly-1371467967414042.jpg, whose side glass could not be
   * measured with a fixed box at the scale it occupies. Three placements read 0.006, 0.005 and
   * 0.002 at modulations of 7.41, 7.30 and 11.25 — every one straddling the B-pillar, the door
   * shut line or the frame, which the annotated crops show plainly. A number from any of them
   * would be a measurement of a box. It is recorded here rather than silently absent because
   * "the subject resisted the instrument" is a result, and because a 0.002 left in the table
   * would have widened the band by two orders of magnitude on the strength of a bad box.
   */
  /**
   * A WINDSCREEN OVER ITS OWN BONNET, which is the subject `tools/car-pane.mjs`'s `nearWindscreen`
   * measures and which this census did not have. Without it the shipped windscreen's 0.0201 was
   * being compared against a band measured on SIDE glass — two panes at two incidences, which is
   * the error this whole entry turned out to be. A white Nissan Rogue from the front three-quarter:
   * the screen is seen well off its normal, as the shipped one is.
   */
  /**
   * A WINDSCREEN OVER ITS OWN BONNET — AND IT IS HERE TO BE REJECTED, WHICH IS THE POINT.
   *
   * `car-pane`'s `nearWindscreen` measures exactly this subject on the shipped car and reads
   * 0.0201 of its bonnet. Comparing that against a band measured on SIDE glass is the error this
   * whole entry turned out to be, so the matching real subject was needed.
   *
   * It cannot be given a median ratio from this imagery, and the reason is the finding: a real
   * windscreen seen off its normal in Florida midday sun is MIRROR-BRIGHT. 29% of the glass box
   * is clipped at 255 while its own sunlit white bonnet clips 0%, so over much of its area the
   * screen is at least as bright as the brightest paint on the car. Two earlier placements lower
   * on the screen read 5% and 29% clipped; there is no box on this pane that does not clip.
   *
   * So the ratio is refused and the ASYMMETRY is asserted instead, below. It bounds the
   * direction without inventing a precision the sensor cannot give: whatever a real windscreen's
   * number is at this geometry, it is not 0.02 of the bonnet.
   */
  { id: 'rogue-windscreen', file: 'mly-682234297680292.jpg', note: 'white Nissan Rogue, windscreen over bonnet',
    pane: 'windscreen', glass: [1862, 597, 25, 7], paint: [1860, 613, 28, 11] },
  { id: 'atlas-silver', file: 'mly-1328081225548925.jpg', pane: 'side', note: 'silver VW Atlas, close, side-on',
    glass: [465, 680, 25, 7], paint: [465, 715, 25, 10] },
];

async function sample(page, subjects) {
  const out = [];
  for (const s of subjects) {
    const file = path.join(DIR, s.file);
    if (!fs.existsSync(file)) { out.push({ ...s, error: 'missing file' }); continue; }
    const data = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
    const r = await page.evaluate(([src, boxes]) => new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.width; c.height = img.height;
        const x = c.getContext('2d', { willReadFrequently: true });
        x.drawImage(img, 0, 0);
        const read = (b) => {
          const d = x.getImageData(b[0], b[1], b[2], b[3]).data;
          const px = [];
          for (let i = 0; i < d.length; i += 4) px.push([d[i] / 255, d[i + 1] / 255, d[i + 2] / 255]);
          return px;
        };
        // Clipping destroys a ratio: a clipped highlight reads 1.0 whatever the surface is, and
        // the error is in the flattering direction for a bright body. CLAUDE.md's rule is to
        // report the clipped fraction beside the number, so it is carried per box.
        void 0;
        resolve({ w: img.width, h: img.height, glass: read(boxes.glass), paint: read(boxes.paint) });
      };
      img.onerror = () => resolve(null);
      img.src = src;
    }), [data, { glass: s.glass, paint: s.paint }]);
    if (!r) { out.push({ ...s, error: 'decode failed' }); continue; }
    /**
     * THE MEDIAN, NOT THE MEAN, and that is not fussiness. A box on glass can clip a bright
     * reflection of sky or a wing mirror; a box on paint can clip the beltline. A mean carries
     * the outlier into the ratio and a median does not — and the p10/p90 are printed beside it
     * so a box that is half on something else announces itself as a wide spread.
     */
    const stat = (px) => {
      /**
       * THE CLIPPED FRACTION, carried rather than mentioned. A pixel at 255 in any channel has
       * lost its value: it reads 1.0 whatever the surface really is, so a box with clipped
       * pixels cannot give a ratio at all — and the error runs toward 1 on a bright body, which
       * is the flattering direction for the question this tool is asking. The first run had a
       * white Suburban reading paint = 1.0000 and a ratio of 0.098 that looked like the best
       * result in the table; it was a blown highlight.
       */
      const clipped = px.filter(([r2, g2, b2]) => r2 >= 1 || g2 >= 1 || b2 >= 1).length / px.length;
      const L = px.map(([r2, g2, b2]) => luma(toLinear(r2), toLinear(g2), toLinear(b2)))
        .sort((a, b) => a - b);
      const q = (f) => L[Math.min(L.length - 1, Math.max(0, Math.round(f * (L.length - 1))))];
      /**
       * p95/p50 IS CARRIED SO THIS IS COMPARABLE WITH `tools/car-pane.mjs`, which calls that
       * ratio `modulation` and exists because "a pane has a FLOOR and a CEILING and a change can
       * move them in opposite directions". Reporting a spread here and a ratio there would make
       * the real cars and the shipped ones two measurements that cannot be put side by side —
       * which is the whole defect #92 turned out to be.
       */
      return { n: L.length, p10: q(0.1), p50: q(0.5), p90: q(0.9), p95: q(0.95), clipped };
    };
    const g = stat(r.glass), p = stat(r.paint);
    out.push({ ...s, imgW: r.w, imgH: r.h, g, p, ratio: p.p50 > 0 ? g.p50 / p.p50 : null,
      modulation: g.p50 > 0 ? g.p95 / g.p50 : null,
      ceiling: p.p50 > 0 ? g.p95 / p.p50 : null,
      spreadG: g.p50 > 0 ? (g.p90 - g.p10) / g.p50 : Infinity,
      spreadP: p.p50 > 0 ? (p.p90 - p.p10) / p.p50 : Infinity });
  }
  return out;
}

/** An annotated crop around one subject, so a box can be checked by eye. */
async function crop(page, s, outFile) {
  const file = path.join(DIR, s.file);
  const data = `data:image/jpeg;base64,${fs.readFileSync(file).toString('base64')}`;
  const png = await page.evaluate(([src, boxes]) => new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const all = [boxes.glass, boxes.paint];
      const x0 = Math.max(0, Math.min(...all.map((b) => b[0])) - 120);
      const y0 = Math.max(0, Math.min(...all.map((b) => b[1])) - 90);
      const x1 = Math.min(img.width, Math.max(...all.map((b) => b[0] + b[2])) + 120);
      const y1 = Math.min(img.height, Math.max(...all.map((b) => b[1] + b[3])) + 90);
      const S = 4;                                   // upscaled, so a 6 px box is visible
      const c = document.createElement('canvas');
      c.width = (x1 - x0) * S; c.height = (y1 - y0) * S;
      const x = c.getContext('2d');
      x.imageSmoothingEnabled = false;
      x.drawImage(img, x0, y0, x1 - x0, y1 - y0, 0, 0, c.width, c.height);
      x.lineWidth = 2;
      x.strokeStyle = '#00ff00';
      x.strokeRect((boxes.glass[0] - x0) * S, (boxes.glass[1] - y0) * S, boxes.glass[2] * S, boxes.glass[3] * S);
      x.strokeStyle = '#ff00ff';
      x.strokeRect((boxes.paint[0] - x0) * S, (boxes.paint[1] - y0) * S, boxes.paint[2] * S, boxes.paint[3] * S);
      resolve(c.toDataURL('image/png'));
    };
    img.onerror = () => resolve(null);
    img.src = src;
  }), [data, { glass: s.glass, paint: s.paint }]);
  if (!png) return false;
  fs.writeFileSync(outFile, Buffer.from(png.split(',')[1], 'base64'));
  return true;
}

// --------------------------------------------------------------------------- selftest
/**
 * ON SYNTHETIC INPUT WITH A KNOWN ANSWER, because every number this tool prints is a ratio of
 * two medians and a ratio of two medians is exactly the shape that can be confidently wrong.
 */
function selftest() {
  let fail = 0;
  const say = (ok, name, detail) => {
    if (!ok) fail++;
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  };
  // The EOTF against its published anchors.
  say(Math.abs(toLinear(0) - 0) < 1e-12, 'sRGB 0 is linear 0');
  say(Math.abs(toLinear(1) - 1) < 1e-12, 'sRGB 1 is linear 1');
  say(Math.abs(toLinear(0.5) - 0.21404114) < 1e-6, 'sRGB 0.5 is linear 0.2140',
    `${toLinear(0.5).toFixed(8)}`);
  /**
   * KNOWN-BAD: a 2.2 POWER instead of the piecewise curve, which is the approximation this would
   * otherwise have used. It is wrong by 9.1% at sRGB 0.5 and by 69% at 0.05 — and 0.05 is where
   * dark glass sits, so the error is largest exactly where the subject is.
   */
  const pow = (c) => c ** 2.2;
  const errMid = Math.abs(pow(0.5) - toLinear(0.5)) / toLinear(0.5);
  const errDark = Math.abs(pow(0.05) - toLinear(0.05)) / toLinear(0.05);
  console.log(`    a 2.2 power is off by ${(100 * errMid).toFixed(1)}% at sRGB 0.5 and ` +
    `${(100 * errDark).toFixed(0)}% at 0.05, where dark glass lives`);
  say(errDark > 0.3, 'KNOWN-BAD: a 2.2 power is badly wrong at the dark end', `${(100 * errDark).toFixed(0)}%`);
  /**
   * WHY THE RATIO HAS TO BE TAKEN IN LINEAR LIGHT, with two surfaces at a fixed reflectance
   * ratio photographed at four exposures.
   *
   * I WROTE THIS ARM AROUND THE WRONG PROPERTY FIRST, and measuring it is what found that. The
   * first version asserted that the sRGB ratio DRIFTS with exposure by more than 0.05, on the
   * strength of CLAUDE.md's note that "the same ratio on the sRGB-ENCODED values drifts 20%".
   * It drifts 0.0216 here — real, and 4.3% of its own value, which on a question of "is this a
   * quarter of the paint or nearly all of it" would not have misled anybody. A guessed bound,
   * caught by its own measurement.
   *
   * THE PROPERTY THAT MATTERS IS BIAS, NOT DRIFT, and it is much larger. The OETF compresses
   * the dark end, so an sRGB ratio is pulled toward 1: glass that is genuinely a QUARTER of the
   * paint beside it reads as roughly HALF. That is a factor of two in the flattering direction —
   * it makes a window that does not read as a window look closer to right than it is, which is
   * exactly the error a round chasing #92 cannot afford.
   *
   * Which also means the colour space of the figures in the backlog is load-bearing and
   * unstated. "0.914 to 1.043 of the door skin" says nothing about which encoding it was taken
   * in, and the two readings differ by about 2x at this level.
   */
  const encode = (v) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);
  const trueRatio = 0.25;
  const linRatios = [], srgbRatios = [];
  for (const stop of [-1, -0.5, 0, 0.5]) {
    const e = 2 ** stop;
    const paintLin = Math.min(1, 0.30 * e), glassLin = Math.min(1, 0.30 * trueRatio * e);
    linRatios.push(glassLin / paintLin);
    srgbRatios.push(encode(glassLin) / encode(paintLin));
  }
  const linSpread = Math.max(...linRatios) - Math.min(...linRatios);
  const srgbSpread = Math.max(...srgbRatios) - Math.min(...srgbRatios);
  const srgbMid = srgbRatios[2];
  console.log(`    a true reflectance ratio of ${trueRatio}: linear reads ` +
    `${linRatios[2].toFixed(3)} at every exposure (spread ${linSpread.toExponential(1)}), ` +
    `sRGB reads ${srgbMid.toFixed(3)} — x${(srgbMid / trueRatio).toFixed(2)} the truth, ` +
    `and drifts ${srgbSpread.toFixed(4)} over 1.5 stops`);
  say(linSpread < 1e-12 && Math.abs(linRatios[2] - trueRatio) < 1e-12,
    'the linear ratio is the true reflectance ratio at every exposure, which is why this works',
    `${linRatios[2]} at spread ${linSpread.toExponential(1)}`);
  /**
   * The bound is a FACTOR, measured, not a threshold picked: the sRGB reading is nearly twice
   * the truth here and there is nothing between "the encoding does not matter" and that.
   */
  say(srgbMid / trueRatio > 1.8,
    'KNOWN-BAD: an sRGB ratio reads nearly twice the truth, in the flattering direction',
    `${srgbMid.toFixed(3)} against ${trueRatio}, x${(srgbMid / trueRatio).toFixed(2)}`);
  say(srgbSpread > 0 && srgbSpread / srgbMid < 0.10,
    'and its exposure drift is real but secondary, which the first version of this arm had backwards',
    `${(100 * srgbSpread / srgbMid).toFixed(1)}% of its own value over 1.5 stops`);
  // The median picks the middle, not the mean, over a box with an outlier.
  const withSpike = [0.1, 0.1, 0.1, 0.1, 0.9];
  const med = [...withSpike].sort((a, b) => a - b)[2];
  const mean = withSpike.reduce((a, b) => a + b) / withSpike.length;
  say(med === 0.1 && Math.abs(mean - 0.26) < 1e-9,
    'a median ignores one specular pixel in five where a mean does not',
    `median ${med}, mean ${mean.toFixed(2)}`);
  console.log(fail ? `GLASS-CENSUS SELFTEST FAIL (${fail})` : 'GLASS-CENSUS SELFTEST OK');
  return fail === 0;
}

// --------------------------------------------------------------------------- main
if (has('selftest')) process.exit(selftest() ? 0 : 1);

if (!SUBJECTS.length) {
  console.error('no subjects defined yet — see SUBJECTS in this file');
  process.exit(2);
}
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage();
const rows = await sample(page, SUBJECTS);
if (has('crop')) {
  const want = arg('crop', null);
  fs.mkdirSync(path.join(DIR, 'views'), { recursive: true });
  for (const s of SUBJECTS) {
    if (want && s.id !== want) continue;
    const out = path.join(DIR, 'views', `glass-${s.id}.png`);
    await crop(page, s, out);
    console.log(`  wrote ${out}`);
  }
}
await browser.close();

console.log('GLASS CENSUS — what a real car window reads as, against the paint beside it');
console.log('='.repeat(78));
console.log('  car                 pane       med/paint  modul  ceil/paint   spread            clipped');
for (const r of rows) {
  if (r.error) { console.log(`  ${r.id.padEnd(24)} ${r.error}`); continue; }
  const bad = r.g.clipped > 0 || r.p.clipped > 0 || r.spreadP > 1.0;
  console.log(`  ${r.id.padEnd(20)}${(r.pane ?? '?').padEnd(11)}${r.ratio.toFixed(3).padStart(8)}` +
    `${r.modulation.toFixed(2).padStart(8)}${r.ceiling.toFixed(3).padStart(10)}` +
    `   g${r.spreadG.toFixed(2)}/p${r.spreadP.toFixed(2)}` +
    `  clip ${(100 * r.g.clipped).toFixed(0)}%/${(100 * r.p.clipped).toFixed(0)}%` +
    `${bad ? '   <- REJECTED' : ''}`);
}
/**
 * A BOX IS ACCEPTED OR IT IS NOT, and the rule rejects only on what actually destroys a ratio.
 *
 * RESTATED, AND THE FIRST VERSION HAD IT WRONG IN A WAY WORTH KEEPING. It also rejected a wide
 * spread on the GLASS box, at a threshold of 1.5 that I picked — and that throws away the
 * subject. Glass genuinely varies: the same window carries a sky reflection at its top edge, the
 * interior behind it, and a near-black patch where it reflects something dark. The VW Atlas reads
 * a glass spread of 1.70 for exactly that reason and its ratio of 0.333 is a real reading, not a
 * bad box. A guessed threshold that discards the variance the tool exists to characterise is the
 * "a metric whose answer is its own instrument" trap in yet another coat.
 *
 * So what is left are the two that are unambiguous:
 *
 *   CLIPPING, in either box. A pixel at 255 has lost its value — it reads 1.0 whatever the
 *   surface is — and the error runs toward 1 on a bright body, the flattering direction. The
 *   white Suburban reads paint = 1.0000 at 76% clipped and produced a ratio of 0.098 that looked
 *   like the best number in the table.
 *
 *   A WIDE SPREAD ON THE PAINT BOX. Paint is a uniform surface, so a spread there is the box
 *   straddling a shut line, the beltline or a highlight, and it moves the DENOMINATOR. The Prius
 *   reads p1.82 and a ratio of 1.254, which is glass brighter than paint and is not a thing.
 *
 * The glass spread is PRINTED on every row instead, because it is a property of the subject.
 */
const REJECT = (r) => r.g.clipped > 0 || r.p.clipped > 0 || r.spreadP > 1.0;
const ok = rows.filter((r) => !r.error && Number.isFinite(r.ratio) && !REJECT(r));
const rejected = rows.filter((r) => !r.error && Number.isFinite(r.ratio) && REJECT(r));
const sorted = ok.map((r) => r.ratio).sort((a, b) => a - b);
const med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
console.log(`\n  ${ok.length} cars, glass/paint in linear light: ` +
  `min ${sorted[0]?.toFixed(3)}  median ${med?.toFixed(3)}  max ${sorted[sorted.length - 1]?.toFixed(3)}`);

// --------------------------------------------------------------------------- the gate
const checks = [];
const check = (name, okk, detail) => { checks.push({ name, ok: !!okk, detail }); };
/**
 * EVERY ARM ASSERTS THAT THE THING IT MEASURES HAPPENED, which here means that boxes were
 * actually sampled off actual images: all of these pass trivially over an empty subject list.
 */
check('the census sampled real images, or every bound below is vacuous',
  rows.length >= 4 && rows.every((r) => !r.error && r.imgW > 0),
  `${rows.length} subjects, ${rows.filter((r) => r.error).length} failed to read`);
check('at least three subjects survive the box rules, so the band is not one reading',
  ok.length >= 3, `${ok.length} accepted of ${rows.length}`);
/**
 * THE FINDING. A window that reads as a window is well under half the paint beside it. Every
 * accepted subject clears that, and the median is far under it.
 */
check('every real car\u2019s side glass is well under half the paint beside it',
  ok.every((r) => r.ratio < 0.5), ok.map((r) => `${r.id} ${r.ratio.toFixed(3)}`).join(', '));
check('and the median is far under, which is what makes this a target and not a ceiling',
  med !== null && med < 0.25, `median ${med?.toFixed(3)} over ${ok.length} cars`);
/**
 * THE GUARD HAS TEETH ON REAL DATA, which is better evidence than a synthetic known-bad: two of
 * these five subjects are boxes I placed badly, and the rule caught both for the right reasons.
 * A run where nothing is ever rejected is a run whose rule has never been exercised.
 */
const clipKill = rejected.filter((r) => r.g.clipped > 0 || r.p.clipped > 0);
const spreadKill = rejected.filter((r) => r.g.clipped === 0 && r.p.clipped === 0 && r.spreadP > 1.0);
console.log(`  rejected: ${rejected.map((r) => `${r.id} (` +
  `${r.g.clipped > 0 || r.p.clipped > 0 ? `clipped ${(100 * Math.max(r.g.clipped, r.p.clipped)).toFixed(0)}%`
    : `paint spread ${r.spreadP.toFixed(2)}`})`).join(', ') || 'none'}`);
check('the clipping rule fired on a real badly-placed box, not only on synthetic input',
  clipKill.length >= 1, clipKill.map((r) => r.id).join(', ') || 'never fired');
check('and so did the paint-spread rule, on a row whose ratio was above 1',
  spreadKill.length >= 1 && spreadKill.every((r) => r.ratio > 1),
  spreadKill.map((r) => `${r.id} ${r.ratio.toFixed(3)}`).join(', ') || 'never fired');
/**
 * AND THE GLASS SPREAD IS THE SUBJECT, printed rather than rejected: real glass carries a sky
 * reflection, an interior and a dark patch in one window, so a window is a RANGE and not a
 * number. That is the property the shipped car is missing — see docs/BACKLOG.md #92, where it
 * sits at a near-constant 0.914 to 1.043 and never goes dark at all.
 */
const widest = ok.reduce((m, r) => (r.spreadG > m.spreadG ? r : m), ok[0]);
console.log(`  glass is a range, not a number: the widest accepted window spans ` +
  `${(100 * widest.g.p10 / widest.p.p50).toFixed(1)}% to ${(100 * widest.g.p90 / widest.p.p50).toFixed(1)}% ` +
  `of its own paint (${widest.id})`);
check('a real window varies across its own area, which a constant ratio cannot reproduce',
  ok.some((r) => r.spreadG > 0.8), ok.map((r) => `${r.id} ${r.spreadG.toFixed(2)}`).join(' '));
/**
 * THE MODULATION, in the same statistic `tools/car-pane.mjs` reports, so the real cars and the
 * shipped ones can be put in one table. A real window's bright end is several times its own
 * median — it reflects the sky at its top edge and the interior lower down — and a pane whose
 * p95 is within a few percent of its p50 is a flat panel wearing a window's name, whatever its
 * median happens to be.
 */
const mods = ok.map((r) => r.modulation).sort((a, b) => a - b);
console.log(`  modulation (p95/p50), the statistic car-pane reports: ` +
  `${mods.map((m) => m.toFixed(2)).join(', ')}`);
/**
 * THE BOUND IS THE MEASURED RANGE, AND MY FIRST GUESS WAS WRONG IN THE USUAL WAY. This asserted
 * "several times brighter at its top", `modulation > 1.8`, on the strength of the census's own
 * observation that one window spans 0% to 56% of its paint. Measured, real windows read 1.56,
 * 1.75 and 2.25 — two of three under the guess. A bound picked before the sweep, failing on the
 * data it was written from.
 *
 * The real figure is more useful than the guess, because it is BOUNDED AT BOTH ENDS and the
 * shipped panes miss it on both sides:
 *
 *     real cars              1.56 .. 2.25
 *     shipped windscreen     1.276      flatter than glass — a dark panel, not a window
 *     shipped backlight      1.195      flatter still
 *     shipped side glass     5.295      runs away: its p95 is ~1.33 of the paint, brighter
 *                                       than the body, which is what reviewers called
 *                                       "body-coloured sheet metal with no window"
 *
 * So a window is not just "dark" — it is dark WITH a bounded amount of life in it, and a pane
 * can fail by being too flat or by having a bright end that outruns the paint.
 */
check('a real window is modulated but not runaway, which bounds it at both ends',
  ok.every((r) => r.modulation > 1.3 && r.modulation < 3.0),
  ok.map((r) => `${r.id} ${r.modulation.toFixed(2)}`).join(' '));
check('and its bright end stays under the paint beside it, unlike a panel',
  ok.every((r) => r.ceiling < 1.0), ok.map((r) => `${r.id} ${r.ceiling.toFixed(3)}`).join(' '));
/**
 * THE WINDSCREEN, BOUNDED BY ITS CLIPPING RATHER THAN MEASURED BY ITS RATIO. See the subject's
 * own note: there is no box on this pane that does not clip, which is itself the statement. The
 * asymmetry is what carries it — the glass clips and its own sunlit bonnet does not — and that
 * holds whatever the true ratio is.
 */
const screen = rows.find((r) => r.pane === 'windscreen' && !r.error);
if (screen) {
  console.log(`  a real windscreen off its normal: ${(100 * screen.g.clipped).toFixed(0)}% of the ` +
    `glass box is clipped against ${(100 * screen.p.clipped).toFixed(0)}% of its own sunlit bonnet` +
    ` — so it is at least as bright as the brightest paint on the car, where the shipped one` +
    ` reads 0.0201 of its bonnet`);
  check('a real windscreen off-normal is mirror-bright, which bounds the direction of #92',
    screen.g.clipped > 0.10 && screen.p.clipped === 0,
    `glass ${(100 * screen.g.clipped).toFixed(0)}% clipped, bonnet ${(100 * screen.p.clipped).toFixed(0)}%`);
  check('and it is excluded from the band, because a clipped box has no ratio to give',
    REJECT(screen), 'rejected');
}

/**
 * AND THE SHIPPED CONSTANT IS DERIVED FROM THIS BAND, so it cannot drift silently.
 *
 * `src/carbody.js`'s `uGlassEnvExtra` scales the glazing's own environment term. The table below
 * is MEASURED — `tools/ground-albedo.mjs`'s `ge*` arms swept the constant, the frames are in
 * docs/shots, and `tools/car-pane.mjs` read the near windscreen against its own bonnet at noon.
 * It is recorded here as data because re-running it needs captures and this gate must not.
 *
 * The check is not circular: the SHIPPED value is compared against the one this table and the
 * census band pick out together. Setting the constant back to 2 fails it, because ge2's measured
 * 0.0619 is below the 0.137 floor the photographs establish.
 */
const GE_SWEEP = { 0: 0.0167, 1: 0.0368, 2: 0.0619, 3: 0.0916, 5: 0.1616 };
const lo = sorted[0], hi = sorted[sorted.length - 1];
const inBand = Object.entries(GE_SWEEP).filter(([, v]) => v >= lo && v <= hi).map(([k]) => +k);
const { glassEnv } = await import('../src/carbody.js');
const shipped = glassEnv().extra;
console.log(`\n  the swept constant: ${Object.entries(GE_SWEEP)
  .map(([k, v]) => `${k}->${v.toFixed(4)}`).join(' ')}`);
console.log(`  values landing inside the measured band ${lo.toFixed(3)}..${hi.toFixed(3)}: ` +
  `${inBand.join(', ') || 'none'}; src/carbody.js ships ${shipped}`);
check('the swept constant has a value that reaches the band at all, or the lever is too weak',
  inBand.length > 0, `${inBand.join(', ') || 'none of 0,1,2,3,5'}`);
check('and src/carbody.js ships one of them, so the constant is derived and not picked',
  inBand.includes(shipped), `ships ${shipped}, band-reaching values are ${inBand.join(', ')}`);

console.log('');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
const failed = checks.filter((c) => !c.ok);
console.log(`\nGLASS CENSUS: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}`
  : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
