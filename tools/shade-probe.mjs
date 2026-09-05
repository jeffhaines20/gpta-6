// Is open shade at noon the brightest and warmest shade of the day, and does
// golden hour read warm in BOTH the sky and the ground?
//
// Two defects were reported off the hero frames and neither had an instrument:
//
//   1. At six of eight fixed shaded points, noon rendered DARKEST of the four
//      hours - the asphalt at (950,760) reading half what a sodium lamp puts on
//      it at night - and shaded brick lost 49 points of R-B against the same
//      brick in sun.
//   2. Golden hour's ground plane measured net COOL (mean R-B -5.8) where noon,
//      dusk and night are all warm, and its sky's warmest pixel reached R-B +10
//      against dusk's +71.
//
// Both are cross-hour statistics on FIXED PIXELS, which is the only kind that can
// be compared between times of day: a population re-sorted per hour (the darkest
// 30% of each frame, say) measures a different set of surfaces in each one, and a
// fill that lifts shade out of the bottom 30% then reads as no change at all.
// So the sample points are world surfaces named by their pixel, chosen once, and
// every hour is read at the same coordinates through the same camera.
//
// USAGE
//   node tools/shade-probe.mjs                 capture + measure  (SHADE_PORT=8132)
//   node tools/shade-probe.mjs --measure-only  re-measure PNGs already on disk
//   node tools/shade-probe.mjs --selftest      prove the metrics fail on known-bad
//
// ENV
//   SHADE_PORT  static server port. NEVER 8123 - that belongs to the main tree,
//               and tools/serve.mjs will throw rather than photograph it.
//   SHADE_TAG   filename prefix, so a before arm and an after arm can coexist.
//   SHADE_TIMES comma list, default noon,golden,dusk,night.
import fs from 'node:fs';
import { readPNG } from './png.mjs';

const argv = process.argv.slice(2);
const has = (k) => argv.includes(`--${k}`);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const OUT = arg('out', 'docs/shots');
const TAG = process.env.SHADE_TAG ?? arg('tag', 'shade');
const TIMES = (process.env.SHADE_TIMES ?? 'noon,golden,dusk,night').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.SHADE_PORT ?? 8132);

// ---------------------------------------------------------------- geometry
// 1600x900, the hero framing. Every box and point below is stated here rather
// than tuned per run so a later round can re-read the same surfaces.
const W = 1600, H = 900;

// The eight fixed sample points, per framing. Five are the coordinates the blind
// review quoted; three more were added on the same frames so the "noon is darkest
// at N of 8" count has eight to count. Each is read as the mean of a 7x7 box, so
// a single dithered pixel cannot move it.
// THE FIRST FIVE ARE THE REVIEW'S OWN COORDINATES, on the CORRIDOR framing,
// which is the one it was reading: at (300,420) it reported noon L61 R-B +26,
// golden L87 +47, dusk L68 +68, night L43 +58, and this harness's first run read
// L60 +26 / L84 +46 / L66 +67 / L42 +58 forty pixels away on the same stucco
// wall. That agreement is what makes the rest of the table comparable with the
// review rather than merely adjacent to it.
//
// The last three were chosen on docs/shots/sp-before-corridor-noon.png as three
// more surfaces that are SHADED at noon and present at all four hours - two more
// of the carriageway under the oak canopy and the shopfront run under the awning
// on the right - so the "noon is darkest at N of 8" count has eight to count.
const POINTS = {
  corridor: {
    'road-950-760':       [950, 760],     // carriageway, oak shadow      (review)
    'road-700-860':       [700, 860],     // carriageway, foreground      (review)
    'brickwalk-1470-640': [1470, 640],    // shopfront base, right        (review)
    'shopfront-1250-540': [1250, 540],    // shaded shopfront under awning(review)
    'stucco-300-420':     [300, 420],     // left stucco block            (review)
    'road-560-760':       [560, 760],     // carriageway, left of centre
    'road-1000-880':      [1000, 880],    // carriageway, bottom edge
    'facade-1150-480':    [1150, 480],    // shaded facade, right block
  },
  // The fivepoints framing looks down the same street from 81 m further back and
  // is carried as a second, independent camera: a fix that only works at the
  // camera it was tuned at is not a fix. Its points are the same kinds of
  // surface, read off docs/shots/sp-before-fivepoints-noon.png.
  fivepoints: {
    'road-950-760':       [950, 760],
    'road-700-860':       [700, 860],
    'brickwalk-1470-640': [1470, 640],
    'shopfront-1250-540': [1250, 540],
    'stucco-300-420':     [300, 420],
    'road-400-720':       [400, 720],
    'facade-620-470':     [620, 470],
    'kerb-1150-690':      [1150, 690],
  },
};

// The review's "Five Points ground plane": everything below the roofline that is
// ground at every hour.
const GROUND = { fivepoints: [60, 640, 1440, 260], corridor: [60, 660, 1440, 240] };
// A single continuous paved area, for the lit:shade ratio.
const PLAZA = { fivepoints: [860, 640, 620, 200], corridor: [820, 680, 620, 180] };

const s2l = new Float64Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  s2l[i] = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const linY = (r, g, b) => 0.2126 * s2l[r] + 0.7152 * s2l[g] + 0.0722 * s2l[b];

function pointStat(img, [px, py], half = 3) {
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = Math.max(0, py - half); y <= Math.min(height - 1, py + half); y++) {
    for (let x = Math.max(0, px - half); x <= Math.min(width - 1, px + half); x++) {
      const i = (y * width + x) * c;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  return { r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1), L: +luma(r, g, b).toFixed(1),
    rb: +(r - b).toFixed(1), rbn: +chromaN(r, g, b).toFixed(3) };
}

// R-B IN BYTES IS NOT A HUE, AND THE REVIEW'S TABLE IS IN IT.
//
// The byte difference R-B carries the LEVEL as well as the hue, because sRGB is
// compressive in the darks: the same illuminant on the same surface, lifted from
// L26 to L44, widens its own R-B by about 1.7x without any hue moving at all. A
// round that lifts shade and warms it therefore reads as "R-B got worse" on half
// its points if only the byte difference is reported. So both are here: `rb` for
// comparability with the review, and `rbn` - (R-B)/(R+B) on LINEARISED values,
// which is scale-free and is what "how warm is this surface" actually means.
// src/sky.js's own chroma() is the same quantity on the dome.
function chromaN(r, g, b) {
  const R = s2l[Math.max(0, Math.min(255, Math.round(r)))];
  const B = s2l[Math.max(0, Math.min(255, Math.round(b)))];
  void g;
  return (R - B) / Math.max(R + B, 1e-9);
}

function boxStat(img, [x0, y0, w, h], mask = null) {
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      if (mask && !mask[y * width + x]) continue;
      const i = (y * width + x) * c;
      r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
    }
  }
  if (!n) return { r: 0, g: 0, b: 0, L: 0, rb: 0, rbn: 0, n: 0 };
  r /= n; g /= n; b /= n;
  return { r: +r.toFixed(1), g: +g.toFixed(1), b: +b.toFixed(1), L: +luma(r, g, b).toFixed(1),
    rb: +(r - b).toFixed(1), rbn: +chromaN(r, g, b).toFixed(3), n };
}

/** Mean R-B of the darkest and brightest quintile of a box, and their light ratio. */
function litShade(img, [x0, y0, w, h]) {
  const { width, height, channels: c, data } = img;
  const px = [];
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * c;
      px.push([luma(data[i], data[i + 1], data[i + 2]), data[i], data[i + 1], data[i + 2]]);
    }
  }
  if (!px.length) return null;
  px.sort((a, b) => a[0] - b[0]);
  const q = Math.max(1, Math.floor(px.length * 0.2));
  const mean = (arr) => {
    let r = 0, g = 0, b = 0, y = 0;
    for (const p of arr) { r += p[1]; g += p[2]; b += p[3]; y += linY(p[1], p[2], p[3]); }
    const n = arr.length;
    return { r: r / n, g: g / n, b: b / n, linY: y / n };
  };
  const dark = mean(px.slice(0, q)), lit = mean(px.slice(-q));
  return {
    shadeRB: +(dark.r - dark.b).toFixed(1), shadeL: +luma(dark.r, dark.g, dark.b).toFixed(1),
    // Level-free hue, so "the shade warmed" cannot be confused with "the shade
    // got brighter" - lifting a fixed illuminant out of the sRGB toe widens its
    // own byte R-B by about 1.7x with no hue moving at all.
    shadeRBN: +chromaN(dark.r, dark.g, dark.b).toFixed(3),
    litRB: +(lit.r - lit.b).toFixed(1), litL: +luma(lit.r, lit.g, lit.b).toFixed(1),
    litRBN: +chromaN(lit.r, lit.g, lit.b).toFixed(3),
    // Ratio of LIGHT, not of bytes: a ratio of sRGB code values is not a ratio of
    // luminance and log2 of it is not a stop.
    litOverShade: +(lit.linY / Math.max(1e-9, dark.linY)).toFixed(2),
  };
}

function skyStat(img, mask) {
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, n = 0, maxRB = -999;
  const rbs = [];
  let topR = 0, topG = 0, topB = 0, topN = 0;      // "zenith": the top 12% of sky rows
  let botR = 0, botG = 0, botB = 0, botN = 0;      // "horizon": the bottom 12%
  const rows = [];
  for (let y = 0; y < height; y++) { let k = 0; for (let x = 0; x < width; x++) if (mask[y * width + x]) k++; if (k) rows.push(y); }
  if (!rows.length) return null;
  const yTop = rows[0] + Math.floor((rows[rows.length - 1] - rows[0]) * 0.12);
  const yBot = rows[rows.length - 1] - Math.floor((rows[rows.length - 1] - rows[0]) * 0.12);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (!mask[y * width + x]) continue;
      const i = (y * width + x) * c;
      const R = data[i], G = data[i + 1], B = data[i + 2];
      r += R; g += G; b += B; n++;
      const rb = R - B;
      rbs.push(rb);
      if (rb > maxRB) maxRB = rb;
      if (y <= yTop) { topR += R; topG += G; topB += B; topN++; }
      if (y >= yBot) { botR += R; botG += G; botB += B; botN++; }
    }
  }
  rbs.sort((a, b2) => a - b2);
  const p = (q) => rbs[Math.min(rbs.length - 1, Math.floor(rbs.length * q))];
  return {
    px: n,
    mean: [+(r / n).toFixed(0), +(g / n).toFixed(0), +(b / n).toFixed(0)],
    meanRB: +((r - b) / n).toFixed(1),
    maxRB, p99RB: p(0.99), p50RB: p(0.5),
    zenith: topN ? [Math.round(topR / topN), Math.round(topG / topN), Math.round(topB / topN)] : null,
    horizon: botN ? [Math.round(botR / botN), Math.round(botG / botN), Math.round(botB / botN)] : null,
  };
}

function frameStat(img) {
  const { width, height, channels: c, data } = img;
  let n = 0, sum = 0, lt8 = 0, lt16 = 0, gt250 = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * c;
      const L = luma(data[i], data[i + 1], data[i + 2]);
      sum += L; n++;
      if (L < 8) lt8++;
      if (L < 16) lt16++;
      if (L > 250) gt250++;
    }
  }
  return { mean: +(sum / n).toFixed(1), nearBlackPct: +((100 * lt8) / n).toFixed(3),
           crushedPct: +((100 * lt16) / n).toFixed(2), clippedPct: +((100 * gt250) / n).toFixed(3) };
}

/** Sky mask from the lights-off frame: geometry goes black, the dome does not. */
function maskFromDark(img, thresh = 24) {
  const { width, height, channels: c, data } = img;
  const m = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * c;
      m[y * width + x] = luma(data[i], data[i + 1], data[i + 2]) > thresh ? 1 : 0;
    }
  }
  // Sky is connected to the top edge. Flood from row 0 so a lit window or a
  // specular glint left in the dark frame cannot join the mask.
  const out = new Uint8Array(width * height);
  const stack = [];
  for (let x = 0; x < width; x++) if (m[x]) { stack.push(x); out[x] = 1; }
  while (stack.length) {
    const i = stack.pop();
    const x = i % width, y = (i / width) | 0;
    const push = (j) => { if (j >= 0 && j < width * height && m[j] && !out[j]) { out[j] = 1; stack.push(j); } };
    if (x > 0) push(i - 1);
    if (x < width - 1) push(i + 1);
    if (y > 0) push(i - width);
    if (y < height - 1) push(i + width);
  }
  return out;
}

function measureFile(file, framing, mask) {
  const img = readPNG(file);
  const pts = {};
  for (const [name, xy] of Object.entries(POINTS[framing])) pts[name] = pointStat(img, xy);
  return {
    file, framing,
    points: pts,
    ground: boxStat(img, GROUND[framing]),
    plaza: litShade(img, PLAZA[framing]),
    sky: mask ? skyStat(img, mask) : null,
    frame: frameStat(img),
  };
}

// ------------------------------------------------------------------ selftest
// A metric with no failing case is not a metric. These feed each statistic input
// whose answer is known and require the reported number to say so.
function selftest() {
  const fails = [];
  const mk = (fn) => {
    const width = 200, height = 200, channels = 3, data = new Uint8Array(width * height * 3);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 3;
      data[i] = r; data[i + 1] = g; data[i + 2] = b;
    }
    return { width, height, channels, data };
  };
  // 1. A cool-shade image: bottom half dark and BLUE, top half bright and warm.
  //    litShade must report the shade as negative R-B and the lit as positive.
  const cool = mk((x, y) => (y < 100 ? [200, 170, 140] : [30, 34, 46]));
  const ls = litShade(cool, [0, 0, 200, 200]);
  if (!(ls.shadeRB < -10)) fails.push(`litShade did not see blue shade: shadeRB=${ls.shadeRB}`);
  if (!(ls.litRB > 40)) fails.push(`litShade did not see warm light: litRB=${ls.litRB}`);
  if (!(ls.litOverShade > 8)) fails.push(`litShade ratio too low on an 8-stop split: ${ls.litOverShade}`);
  // 2. A flat image has ratio 1 and R-B 0 - the degenerate case a buggy sort
  //    (comparing bytes as strings, say) would report as a large ratio.
  const flat = mk(() => [90, 90, 90]);
  const fs2 = litShade(flat, [0, 0, 200, 200]);
  if (Math.abs(fs2.litOverShade - 1) > 0.02) fails.push(`flat image ratio should be 1, got ${fs2.litOverShade}`);
  if (Math.abs(fs2.shadeRB) > 0.5) fails.push(`flat image R-B should be 0, got ${fs2.shadeRB}`);
  // 3. pointStat averages a box, so a single hot pixel must not move it far.
  const spike = mk((x, y) => (x === 50 && y === 50 ? [255, 255, 255] : [40, 40, 40]));
  const ps = pointStat(spike, [50, 50]);
  if (!(ps.L > 40 && ps.L < 50)) fails.push(`pointStat 7x7 mean wrong on one hot pixel: L=${ps.L}`);
  // 4. The sky mask must reject a bright patch that does NOT touch the top edge -
  //    a lit window is exactly that, and letting it in poisons every sky number.
  const dark = mk((x, y) => (y < 40 ? [120, 140, 170] : (x > 150 && y > 150 ? [200, 200, 120] : [2, 2, 2])));
  const m = maskFromDark(dark);
  let skyN = 0, windowN = 0;
  for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (m[y * 200 + x]) { if (y < 40) skyN++; else windowN++; }
  if (skyN < 200 * 40 * 0.9) fails.push(`sky mask lost the sky: ${skyN}/8000`);
  if (windowN !== 0) fails.push(`sky mask admitted a detached bright patch: ${windowN} px`);
  // 5. frameStat's near-black share, against an image that is exactly 25% black.
  const quarter = mk((x, y) => (x < 50 ? [0, 0, 0] : [128, 128, 128]));
  const q = frameStat(quarter);
  if (Math.abs(q.nearBlackPct - 25) > 0.01) fails.push(`nearBlackPct should be 25, got ${q.nearBlackPct}`);
  // 6. skyStat's maxRB must find a warm pixel hidden in a cool field - the golden
  //    -hour question is literally "is there a warm pixel anywhere in this sky".
  const width = 200;
  const warmOne = mk((x, y) => (x === 3 && y === 3 ? [220, 160, 120] : [150, 175, 200]));
  const allMask = new Uint8Array(200 * 200).fill(1);
  const sk = skyStat(warmOne, allMask);
  if (sk.maxRB !== 100) fails.push(`skyStat maxRB should be 100, got ${sk.maxRB}`);
  if (!(sk.meanRB < -40)) fails.push(`skyStat meanRB should stay cool, got ${sk.meanRB}`);
  void width;
  // 7. THE SUITE MUST BE ABLE TO FAIL. Six passing cases prove nothing unless a
  //    known-bad implementation trips them, so run two here and require them to.
  //    The broken mask is the real failure mode this file guards: a threshold with
  //    no flood fill admits every lit window as "sky".
  const brokenMask = (img, thresh = 24) => {
    const { width: w2, height: h2, channels: c2, data: d2 } = img;
    const m2 = new Uint8Array(w2 * h2);
    for (let i = 0, n2 = w2 * h2; i < n2; i++) {
      m2[i] = luma(d2[i * c2], d2[i * c2 + 1], d2[i * c2 + 2]) > thresh ? 1 : 0;
    }
    return m2;                                    // no flood fill: the known bad
  };
  const bm = brokenMask(dark);
  let leaked = 0;
  for (let y = 40; y < 200; y++) for (let x = 0; x < 200; x++) if (bm[y * 200 + x]) leaked++;
  if (leaked === 0) fails.push('NEGATIVE CONTROL: the flood-fill-free mask did not leak, so case 4 proves nothing');
  //    And a byte-ratio litShade (the classic bug: ratio of sRGB code values) must
  //    disagree with the linear one on the 8-stop split of case 1.
  const byteRatio = (200 * 0.2126 + 170 * 0.7152 + 140 * 0.0722) / (30 * 0.2126 + 34 * 0.7152 + 46 * 0.0722);
  if (Math.abs(byteRatio - ls.litOverShade) < 1)  {
    fails.push(`NEGATIVE CONTROL: byte ratio ${byteRatio.toFixed(2)} is indistinguishable from the linear ${ls.litOverShade}`);
  }
  console.log(fails.length ? `SELFTEST FAIL\n  ${fails.join('\n  ')}` : 'SELFTEST PASS (6 cases + 2 negative controls)');
  return fails.length === 0;
}

// ---------------------------------------------------------------- reporting
function report(rows) {
  const framings = [...new Set(rows.map((r) => r.framing))];
  const lines = [];
  for (const f of framings) {
    const byTod = Object.fromEntries(rows.filter((r) => r.framing === f).map((r) => [r.tod, r]));
    const tods = TIMES.filter((t) => byTod[t]);
    lines.push(`\n=== ${f} ===   cells are  L<luma>  <R-B in bytes>  <(R-B)/(R+B) linearised>`);
    lines.push(`point                  ` + tods.map((t) => t.padEnd(20)).join(''));
    let noonDarkest = 0, counted = 0;
    for (const name of Object.keys(POINTS[f])) {
      const cells = tods.map((t) => {
        const p = byTod[t].points[name];
        return `L${String(Math.round(p.L)).padStart(3)} ${(p.rb >= 0 ? '+' : '') + Math.round(p.rb)} ` +
          `${p.rbn >= 0 ? '+' : ''}${p.rbn.toFixed(2)}`.padEnd(6);
      });
      lines.push(name.padEnd(23) + cells.join(''));
      if (tods.includes('noon')) {
        counted++;
        const ln = byTod.noon.points[name].L;
        if (tods.every((t) => t === 'noon' || byTod[t].points[name].L >= ln)) noonDarkest++;
      }
    }
    lines.push(`noon is darkest at ${noonDarkest}/${counted} points`);
    lines.push(`ground plane R-B      ` + tods.map((t) => `${byTod[t].ground.rb} (${byTod[t].ground.rbn})`.padEnd(20)).join(''));
    lines.push(`ground plane L        ` + tods.map((t) => String(byTod[t].ground.L).padEnd(20)).join(''));
    lines.push(`plaza shade R-B/L/chr ` + tods.map((t) => `${byTod[t].plaza.shadeRB}/${byTod[t].plaza.shadeL}/${byTod[t].plaza.shadeRBN}`.padEnd(20)).join(''));
    lines.push(`plaza lit   R-B/L/chr ` + tods.map((t) => `${byTod[t].plaza.litRB}/${byTod[t].plaza.litL}/${byTod[t].plaza.litRBN}`.padEnd(20)).join(''));
    lines.push(`plaza lit:shade       ` + tods.map((t) => String(byTod[t].plaza.litOverShade).padEnd(20)).join(''));
    if (byTod[tods[0]].sky) {
      lines.push(`sky mean RGB          ` + tods.map((t) => (byTod[t].sky ? byTod[t].sky.mean.join(',') : '-').padEnd(20)).join(''));
      lines.push(`sky R-B  max/p99/p50  ` + tods.map((t) => (byTod[t].sky ? `${byTod[t].sky.maxRB}/${byTod[t].sky.p99RB}/${byTod[t].sky.p50RB}` : '-').padEnd(20)).join(''));
      lines.push(`sky zenith            ` + tods.map((t) => (byTod[t].sky ? byTod[t].sky.zenith.join(',') : '-').padEnd(20)).join(''));
      lines.push(`sky horizon           ` + tods.map((t) => (byTod[t].sky ? byTod[t].sky.horizon.join(',') : '-').padEnd(20)).join(''));
    }
    lines.push(`frame mean            ` + tods.map((t) => String(byTod[t].frame.mean).padEnd(20)).join(''));
    lines.push(`near-black % (<8)     ` + tods.map((t) => String(byTod[t].frame.nearBlackPct).padEnd(20)).join(''));
    lines.push(`clipped % (>250)      ` + tods.map((t) => String(byTod[t].frame.clippedPct).padEnd(20)).join(''));
  }
  return lines.join('\n');
}

// -------------------------------------------------------------------- main
if (has('selftest')) {
  process.exit(selftest() ? 0 : 1);
}

const FRAMINGS = ['corridor', 'fivepoints'];

const MASK_ONLY = has('mask-only');
if (!has('measure-only')) {
  const { chromium } = await import('playwright');
  const { launchOptions } = await import('./browser.mjs');
  const { ensureServer } = await import('./serve.mjs');
  fs.mkdirSync(OUT, { recursive: true });
  if (PORT === 8123) throw new Error('SHADE_PORT 8123 belongs to the main tree; pick another');
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
  await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
  // Frozen: traffic and pedestrians moving between arms is the one thing that can
  // move a fixed-pixel statistic without any light changing.
  await page.evaluate(() => { __district.setTraffic(0); __district.setPedestrians(0); });
  await page.waitForTimeout(3000);

  const SHOTS = {
    corridor:   { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
    fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
  };
  // Same placement arithmetic as tools/hero-shots.mjs, including the clearance
  // walk-in: a hero camera inside a footprint manufactures the defect class it is
  // being used to look for, and a probe camera does the same.
  const place = async (cfg) => page.evaluate((c) => {
    const r = __district.district.meta.route;
    const a = r[c.wpA], b = r[c.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const px = a.x - (dx / len) * c.back + nx * c.side;
    const pz = a.z - (dz / len) * c.back + nz * c.side;
    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam([px, c.height, pz], [a.x + (dx / len) * c.fwd, c.tgtY, a.z + (dz / len) * c.fwd], c.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { x: +px.toFixed(1), z: +pz.toFixed(1) };
  }, cfg);

  const audits = [];
  for (const f of MASK_ONLY ? [] : FRAMINGS) {
    const at = await place(SHOTS[f]);
    console.log(`${f}: camera at (${at.x}, ${at.z})`);
    await page.waitForTimeout(14000);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await page.waitForTimeout(15000);
      const file = `${OUT}/${TAG}-${f}-${tod}.png`;
      await page.screenshot({ path: file, timeout: 180000 });
      const a = await page.evaluate(() => {
        const au = __district.audit();
        const sk = __district.sky.audit();
        const tod2 = __district.tod;
        return {
          exposure: au.exposure, exposureAsStop: au.exposureAsStop,
          sunLux: au.sunLux, sunLuxDelivered: au.sunLuxDelivered,
          skyDelivery: au.skyDelivery, implausible: au.implausible,
          bounce: tod2.bounceDelivery ? tod2.bounceDelivery() : null,
          sky: {
            skyLux: sk.skyLux, zenithNits: sk.zenithNits, horizonNits: sk.horizonNits,
            zenithChroma: sk.zenithChroma, horizonChroma: sk.horizonChroma,
            ambientChroma: sk.ambientChroma, groundBounce: sk.groundBounce,
            msAniso: sk.msAniso,
          },
          post: { bloomThreshold: au.postProcessing.bloomThreshold,
                  fogDensity: au.postProcessing.fogDensity, aoStrength: au.postProcessing.aoStrength },
        };
      });
      audits.push({ framing: f, tod, ...a });
      console.log(`  ${tod}: stop ${a.exposureAsStop}, skyDelivered ${a.skyDelivery.totalLux} over ${a.skyDelivery.paths} path(s)` +
        `, implausible ${a.implausible.length}`);
    }
  }
  // Sky mask, once per framing, at the end: every light off, bloom and fog off,
  // so geometry is black and the dome is not.
  //
  // AT NOON, and that is not incidental. The first version took the mask after
  // the last hour in TIMES, which is night, and a night dome is 0.2 lux: most of
  // the sky fell under the mask's own brightness threshold and the "sky" it
  // returned was a thin band of twilight plus every lit window in the frame. The
  // mask has to be taken under the brightest dome there is, and at the one hour
  // where nothing in the district is an emitter.
  await page.evaluate(() => __district.setTimeOfDay('noon'));
  await page.waitForTimeout(6000);
  await page.evaluate(() => {
    __district.lightPool.enabled = false;
    // visible = false, not intensity = 0. LightPool.update() rewrites point-light
    // intensity from the emitter's candela every frame, and TimeOfDay.follow()
    // now rewrites the bounce light's the same way, so a zeroed light is back on
    // before the screenshot. An invisible light is dropped from the light list
    // and stays dropped however often something writes its intensity.
    __district.scene.traverse((o) => { if (o.isLight) { o.intensity = 0; o.visible = false; } });
    __district.scene.environmentIntensity = 0;
    __district.post.params.bloomStrength = 0;
    __district.post.params.fogDensity = 0;
    __district.post.params.aoEnabled = false;
  });
  for (const f of FRAMINGS) {
    await place(SHOTS[f]);
    await page.waitForTimeout(MASK_ONLY ? 14000 : 5000);
    await page.screenshot({ path: `${OUT}/${TAG}-${f}-skymask.png`, timeout: 180000 });
    console.log(`${f}: sky mask captured`);
  }
  if (!MASK_ONLY) fs.writeFileSync(`docs/${TAG}-audits.json`, JSON.stringify({ audits, errors }, null, 1));
  await browser.close();
  if (errors.length) console.error('PAGE ERRORS:', errors.slice(0, 5));
}

const rows = [];
for (const f of FRAMINGS) {
  const maskFile = `${OUT}/${TAG}-${f}-skymask.png`;
  const mask = fs.existsSync(maskFile) ? maskFromDark(readPNG(maskFile)) : null;
  for (const tod of TIMES) {
    const file = `${OUT}/${TAG}-${f}-${tod}.png`;
    if (!fs.existsSync(file)) continue;
    rows.push({ tod, ...measureFile(file, f, mask) });
  }
}
const text = report(rows);
console.log(text);
fs.writeFileSync(`docs/${TAG}-metrics.json`, JSON.stringify({ tag: TAG, points: POINTS, ground: GROUND, plaza: PLAZA, rows }, null, 1));
console.log(`\nwrote docs/${TAG}-metrics.json`);
