// WHAT IS THE HARD-EDGED BAND ON THE CORRIDOR SIDEWALK?
//
// A blind reviewer of the round-8 frames reported "a hard-edged textureless wedge
// pasted on the corridor sidewalk, x 1425-1600 y 743-800, dead-straight horizontal
// top edge, no penumbra, brick coursing vanishes inside it, present unchanged at
// all four hours INCLUDING NIGHT, and it does not move with the sun". Two
// hypotheses were live:
//
//   A. the sun's +-120 m ortho shadow camera clamps to "occluded" outside its
//      frustum, so everything past a fixed distance reads as shadowed;
//   B. it is a surface - something drawn on the pavement.
//
// This decides between them by DIFFERENCING, on the same frame, in one session:
//
//   base          the frame as shipped
//   noshadow      sun.shadow.intensity = 0 - every cast shadow gone
//   noprops       the street-furniture root hidden - every prop gone
//
// A step that survives `noshadow` is not the shadow pass. A step that disappears
// with `noprops` is a prop. The two together name the object.
//
// STEP HEIGHT is measured as the mean luminance above the boundary row minus the
// mean below it, over a band of columns, as a FRACTION of the above-mean, so it
// is comparable between noon and night.
//
//   node tools/wedge-probe.mjs --port 8135 --tag after
//   node tools/wedge-probe.mjs --selftest
//
// The BEFORE arm needs no browser at all: docs/shots/r2post-corridor-*.png are
// committed captures of the same framing, and step() reads them directly.
//
//   noon 38.56%   golden 35.62%   dusk 42.18%   night 43.43%   (control -2 to -5%)
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TAG = arg('tag', 'wedge');
const TIMES = arg('tod', 'noon,night').split(',');
const PORT = Number(arg('port', 8135));         // never 8123: that is the main tree,
                                                // and 8134 was taken by a sibling worktree
const PEDS = Number(arg('peds', 0));            // the crowd is not the subject here
const W = 1600, H = 900;

// The reviewer's own coordinates. Columns inside the band, rows either side of the
// reported boundary, with a two-row guard so the boundary pixel itself never enters
// either mean.
const COLS = [1450, 1470, 1490, 1510, 1530, 1550, 1570, 1590];
const ABOVE = [730, 741];       // inclusive rows of sunlit brick above the edge
const BELOW = [745, 756];       // inclusive rows inside the band
const CONTROL_COLS = [1150, 1200, 1250, 1300];   // same rows, outside the band

const lum = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/** Mean luminance over a set of columns and an inclusive row range. */
function bandMean(img, cols, rows) {
  const { width, height, channels, data } = img;   // channels, NOT 4
  let s = 0, n = 0;
  for (const x of cols) {
    if (x < 0 || x >= width) continue;
    for (let y = rows[0]; y <= rows[1] && y < height; y++) {
      s += lum(data, (y * width + x) * channels); n++;
    }
  }
  return n ? s / n : 0;
}

/**
 * Step across the reported boundary, as a fraction of the lit side.
 * Also returns the same statistic over control columns, which must stay near 0.
 */
export function step(file) {
  const img = readPNG(file);
  const a = bandMean(img, COLS, ABOVE), b = bandMean(img, COLS, BELOW);
  const ca = bandMean(img, CONTROL_COLS, ABOVE), cb = bandMean(img, CONTROL_COLS, BELOW);
  return {
    above: +a.toFixed(2), below: +b.toFixed(2),
    stepPct: a > 0 ? +((1 - b / a) * 100).toFixed(2) : 0,
    controlAbove: +ca.toFixed(2), controlBelow: +cb.toFixed(2),
    controlStepPct: ca > 0 ? +((1 - cb / ca) * 100).toFixed(2) : 0,
    channels: img.channels,
  };
}

// Everything below is the CLI half. Guarded so `import { step }` from another
// tool does not launch a browser — tools/contact.mjs learned this the hard way.
const isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('tools/wedge-probe.mjs');

if (isMain && has('selftest')) {
  // KNOWN-BAD INPUT, no browser needed: a synthetic frame with NO step must
  // report ~0, and one with a step painted in must report it. A metric that
  // reports a wedge on a flat image cannot be trusted to report one on a frame.
  const { writePNG } = await import('./crop.mjs');
  const flat = Buffer.alloc(W * H * 3, 120);
  writePNG(`${OUT}/_wedge-selftest-flat.png`, W, H, flat);
  const stepped = Buffer.alloc(W * H * 3, 120);
  for (let y = 743; y < H; y++) {
    for (const x of [...COLS, ...COLS.map((c) => c + 1), ...COLS.map((c) => c - 1)]) {
      const i = (y * W + x) * 3;
      stepped[i] = stepped[i + 1] = stepped[i + 2] = 66;      // 45% darker
    }
  }
  writePNG(`${OUT}/_wedge-selftest-step.png`, W, H, stepped);
  const f = step(`${OUT}/_wedge-selftest-flat.png`);
  const t = step(`${OUT}/_wedge-selftest-step.png`);
  console.log('selftest flat   ', JSON.stringify(f));
  console.log('selftest stepped', JSON.stringify(t));
  const ok = Math.abs(f.stepPct) < 0.5 && t.stepPct > 40 && Math.abs(t.controlStepPct) < 0.5;
  console.log(ok ? 'SELFTEST PASSED' : 'SELFTEST FAILED');
  process.exit(ok ? 0 : 3);
}

if (!isMain) {
  // Imported for step() alone. Nothing else in this file may run.
} else {
const srv = await ensureServer(PORT, 30000, { root: process.cwd() });
console.log(`server ${JSON.stringify(srv)}`);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: W, height: H } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate((n) => { __district.setTraffic(0); __district.setPedestrians(n); __district.sky.cloudWind.set(0, 0); }, PEDS);

// The corridor hero framing, verbatim from tools/hero-shots.mjs: wpA 3, wpB 4,
// back -55. Any other camera and the reviewer's pixel coordinates mean nothing.
const placed = await page.evaluate((cfg) => {
  const r = __district.district.meta.route;
  const a = r[cfg.wpA], b = r[cfg.wpB];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const px = a.x - (dx / len) * cfg.back + nx * cfg.side;
  const pz = a.z - (dz / len) * cfg.back + nz * cfg.side;
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { x: +px.toFixed(1), z: +pz.toFixed(1) };
}, { wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 });
console.log(`corridor camera at (${placed.x}, ${placed.z})`);
{
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const m = await page.evaluate(() => __district.worldReport().meshes);
    stable = m === last ? stable + 1 : 0; last = m;
    if (stable < 3) await page.waitForTimeout(2500);
  }
  console.log(`world settled at ${last} chunk meshes`);
}

const settle = async () => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f + 3, f0, { timeout: 300000, polling: 200 });
};

const results = [];
for (const tod of TIMES) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await settle();
  const arms = {};
  const shoot = async (name) => {
    const f = `${OUT}/_wedge-${TAG}-${tod}-${name}.png`;
    await page.screenshot({ path: f, timeout: 300000 });
    arms[name] = { file: f, ...step(f) };
    return f;
  };
  await shoot('base');

  const si = await page.evaluate(() => {
    const s = __district.tod.sun.shadow;
    __district._wpShadow = s.intensity;
    s.intensity = 0;
    return s.intensity;
  });
  await settle();
  await shoot('noshadow');
  await page.evaluate(() => { __district.tod.sun.shadow.intensity = __district._wpShadow; });

  const fv = await page.evaluate(() => {
    const f = __district.furniture;
    const root = f.root ?? f;
    __district._wpProps = root.visible;
    root.visible = false;
    return root.visible;
  });
  await settle();
  await shoot('noprops');
  await page.evaluate(() => {
    const f = __district.furniture;
    (f.root ?? f).visible = __district._wpProps;
  });
  await settle();

  results.push({ tod, shadowIntensityInArm: si, propsVisibleInArm: fv, arms });
  console.log(`\n${tod}`);
  for (const [k, v] of Object.entries(arms)) {
    console.log(`  ${k.padEnd(9)} step ${String(v.stepPct).padStart(6)}%   ` +
      `above ${v.above} below ${v.below}   control ${v.controlStepPct}%`);
  }
  const s = arms.base.stepPct, ns = arms.noshadow.stepPct, np = arms.noprops.stepPct;
  console.log(`  -> survives shadow-off: ${(ns > s * 0.6).toString().padEnd(5)}   ` +
    `survives props-off: ${(np > s * 0.6)}`);
}

fs.writeFileSync(`docs/wedge-${TAG}.json`, JSON.stringify(
  { tag: TAG, cols: COLS, above: ABOVE, below: BELOW, controlCols: CONTROL_COLS, results, errors }, null, 1));
console.log(`\nwrote docs/wedge-${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS:', errors);
await browser.close();
}
