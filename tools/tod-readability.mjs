// Is a time-of-day frame READABLE, and if it is not, is that the light or the stop?
//
// The noon preset renders like night. Two quantities can produce that and they
// have opposite fixes, so this measures both from the same pixels:
//
//   - the DISPLAY value, 0-255, which is what "unreadable" actually means; and
//   - the SCENE RADIANCE that produced it, in nits, recovered by inverting the
//     tonemap and dividing by the stop the frame was taken at.
//
// If a shadowed facade carries MORE nits at noon than at golden and still renders
// darker, the light is fine and the camera stop is wrong. If it carries fewer,
// the ambient is the fault. One is an exposure edit, the other is a lighting
// edit, and guessing between them costs a round.
//
// THE INVERSE IS NOT sRGB, and that is load-bearing. src/post.js's composite is a
// RawShaderMaterial that writes aces(color * exposure) straight to gl_FragColor
// with no <colorspace_fragment>, so three.js adds no encode on the way out and the
// byte in the screenshot IS the Narkowicz ACES output. tools/critic-metrics.mjs
// established that against the HDR target and this file reuses its inverse rather
// than deriving a second one. Using the sRGB inverse here would overstate every
// dark region by about 2.4x, which is precisely the size of the effect being
// measured.
//
// Regions are fixed boxes at the tools/daynight-sweep.mjs corridor camera, chosen
// off the frame and stated here so they are auditable rather than tuned per run:
// they sit clear of the minimap, the speedometer and the weapon/wanted HUD, and
// every one of them contains the same surface at all four times of day.
//
//   node tools/tod-readability.mjs [--dir docs/shots] [--prefix tod-]
import { readPNG } from './png.mjs';
import { unAces } from './critic-metrics.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const DIR = arg('dir', 'docs/shots');
const PREFIX = arg('prefix', 'tod-');
const OUT = arg('out', '');

// The stop each frame was taken at, read from the sweep's own artifact so this
// cannot drift from the build that produced the pixels.
const sweep = JSON.parse(fs.readFileSync(arg('sweep', 'docs/daynight.json'), 'utf8'));
// The sweep records the stop as the string audit() prints it ("1/69490"), so it
// is parsed back rather than read as a number - reading it as a number silently
// yields NaN and every nits column comes out NaN.
const asNumber = (e) => (typeof e === 'number' ? e
  : /^1\//.test(e) ? 1 / Number(String(e).slice(2)) : Number(e));
const EXPOSURE = Object.fromEntries(sweep.presets.map((p) => [p.tod, asNumber(p.exposure)]));

// [x, y, w, h] at 1440x810.
const REGIONS = {
  // Open sky above the mid-block roofline. Sky at every time of day.
  sky: [600, 100, 400, 140],
  // The mid-block facade across the corridor. Away from the sun at golden and in
  // its own shade at noon, so it is the shadowed-surface case in every preset.
  facadeShadow: [600, 340, 380, 120],
  // The tall tower on the left. Turned toward the sun at golden.
  facadeLit: [40, 80, 240, 360],
  // Foreground carriageway, clear of the minimap and the speedometer.
  road: [430, 630, 340, 120],
  // Brick plaza on the right, the largest continuous ground plane in frame.
  plaza: [860, 590, 300, 90],
};
// HUD furniture, excluded from the whole-frame histogram.
const HUD = [[20, 530, 275, 240], [1180, 630, 260, 180], [1260, 20, 180, 100], [280, 660, 80, 150],
             [900, 775, 540, 35]];

const inBox = (x, y, [bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh;

function regionStats(img, box, exposure) {
  const [x0, y0, w, h] = box;
  const { width, height, channels: c, data } = img;
  let r = 0, g = 0, b = 0, n = 0, sceneY = 0;
  for (let y = y0; y < Math.min(height, y0 + h); y++) {
    for (let x = x0; x < Math.min(width, x0 + w); x++) {
      const i = (y * width + x) * c;
      r += data[i]; g += data[i + 1]; b += data[i + 2];
      // Luminance of the SCENE value, not of the byte: invert the tonemap per
      // channel first, then weight. Weighting bytes and inverting afterwards
      // would be inverting a non-linearity of an average, which is not the
      // average of the non-linearity.
      sceneY += 0.2126 * unAces(data[i]) + 0.7152 * unAces(data[i + 1]) + 0.0722 * unAces(data[i + 2]);
      n++;
    }
  }
  const exposed = sceneY / n;                 // radiance x exposure, ACES input
  return {
    r: +(r / n).toFixed(1), g: +(g / n).toFixed(1), b: +(b / n).toFixed(1),
    // Display luma, 0-255. This is "how dark does it look".
    v255: +((0.2126 * r + 0.7152 * g + 0.0722 * b) / n).toFixed(1),
    exposed: +exposed.toFixed(4),
    // Physical radiance that produced it.
    nits: +(exposed / exposure).toFixed(0),
  };
}

function frameStats(img) {
  const { width, height, channels: c, data } = img;
  const hist = new Uint32Array(256);
  let n = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (HUD.some((b) => inBox(x, y, b))) continue;
      const i = (y * width + x) * c;
      hist[Math.round(0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2])]++;
      n++;
    }
  }
  const pct = (p) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * p) return v; } return 255; };
  let sum = 0, crushed = 0, deep = 0, clipped = 0;
  for (let v = 0; v < 256; v++) { sum += v * hist[v]; if (v < 16) crushed += hist[v]; if (v < 8) deep += hist[v]; if (v > 250) clipped += hist[v]; }
  return {
    mean: +(sum / n).toFixed(1), p05: pct(0.05), p50: pct(0.5), p95: pct(0.95),
    crushedPct: +((crushed / n) * 100).toFixed(2),   // below 16/255: no material visible
    deepPct: +((deep / n) * 100).toFixed(2),         // below 8/255: black
    clippedPct: +((clipped / n) * 100).toFixed(2),
    pixels: n,
  };
}

const rows = [];
for (const tod of ['noon', 'golden', 'dusk', 'night']) {
  const file = `${DIR}/${PREFIX}${tod}.png`;
  if (!fs.existsSync(file)) { console.log(`${file}: missing`); continue; }
  const img = readPNG(file);
  const exposure = EXPOSURE[tod];
  const regions = Object.fromEntries(
    Object.entries(REGIONS).map(([k, box]) => [k, regionStats(img, box, exposure)]));
  rows.push({ tod, exposure: `1/${Math.round(1 / exposure)}`, frame: frameStats(img), regions });
}

const w = (s, n) => String(s).padStart(n);
console.log(`\n=== FRAME (HUD excluded) — ${DIR}/${PREFIX}*.png ===`);
console.log('preset   stop        mean  p05  p50  p95  <16/255  <8/255  >250');
for (const r of rows) {
  console.log(`${r.tod.padEnd(8)} ${r.exposure.padEnd(10)} ${w(r.frame.mean, 5)} ${w(r.frame.p05, 4)} ${w(r.frame.p50, 4)} ${w(r.frame.p95, 4)} ` +
    `${w(r.frame.crushedPct + '%', 8)} ${w(r.frame.deepPct + '%', 7)} ${w(r.frame.clippedPct + '%', 6)}`);
}
for (const name of Object.keys(REGIONS)) {
  console.log(`\n--- ${name} ${JSON.stringify(REGIONS[name])} ---`);
  console.log('preset    display 0-255   ACES input   scene nits');
  for (const r of rows) {
    const s = r.regions[name];
    console.log(`${r.tod.padEnd(9)} ${w(s.v255, 8)}   ${w(s.exposed, 10)}   ${w(s.nits, 10)}`);
  }
}
if (OUT) { fs.writeFileSync(OUT, JSON.stringify({ regions: REGIONS, rows }, null, 1)); console.log(`\nwrote ${OUT}`); }
