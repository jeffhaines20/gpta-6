// What the SSAO radius actually does to the frame, per radius.
//
// Three blind reviewers put "every person hovers" at or near the top of their
// lists, and the pedestrian round found the arithmetic behind it: post.js runs
// SSAO at a 2.2 m world radius, and against a 0.4 m body that is 5.5x his width
// -- the reviewers' "soft fan roughly six times his body width" is that number,
// not a figure of speech. So the halo is not a crowd defect at all, it is one
// district-wide parameter, and every figure and prop in the game sits in one.
//
// The instrument is a DIFFERENCE, not an appearance. For each radius the frame
// is captured with AO on and with AO off; subtracting isolates exactly what the
// AO pass contributed, independent of exposure, tonemapping, sun angle or albedo
// -- which matters because the daylight round has just moved the noon stop and
// added a bounce term, so absolute luma is not comparable across builds.
//
// Reported per radius:
//   spread   the fraction of the ground band the AO pass darkens at all. A
//            contact term touches a little of it; a 2.2 m kernel touches most.
//   depth    mean darkening where it acts, in levels of 255.
//   contact  the strongest darkening found in the ground band -- the actual
//            contact, which is the part that SHOULD survive tightening.
//   facade   the same, measured in the facade band, which is AO's legitimate
//            job: reveals, soffits, the line where wall meets pavement. A radius
//            that fixes the halo and erases this is not an improvement.
//
//   node tools/ao-sweep.mjs
//   AO_RADII=2.2,1.4,0.9,0.6,0.35 AO_PORT=8136 node tools/ao-sweep.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const PORT = Number(process.env.AO_PORT ?? 8123);
const RADII = (process.env.AO_RADII ?? '2.2,1.4,0.9,0.6,0.35').split(',').map(Number);
const PEDS = Number(process.env.AO_PEDS ?? 40);

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
// FREEZE THE SCENE. The AO term is isolated by differencing an AO-on capture
// against an AO-off one, and those are seconds apart on a browser rendering at
// well under 1 fps -- so anything that MOVES in between lands in the difference
// as if it were occlusion. The first version left the crowd and the traffic
// running and read 44.2% then 27.6% for the same unchanged radius: a 60% swing
// with nothing changed, which is the measurement telling you it is measuring the
// simulation and not the parameter.
//
// With the movers pinned off the difference is the AO pass and nothing else, and
// the price is that there are no figures left to measure a halo around. That is
// why the metric below is position-free: SSAO does not care what casts, so the
// SHAPE of the term over static street furniture answers the same question.
await page.evaluate(() => {
  const d = window.__district;
  d.setPedestrians(0);
  if (d.setTraffic) d.setTraffic(0);
  if (d.setHudEnabled) d.setHudEnabled(false);
});
await page.waitForTimeout(Number(process.env.AO_SETTLE ?? 20000));

async function capture(tag) {
  // 30 s is playwright's default and it is not enough here: SwiftShader renders
  // this scene at well under 1 fps, and with sibling agents driving their own
  // browsers on the same container a frame can take minutes.
  const buf = await page.screenshot({ type: 'png', timeout: 240000 });
  const f = `/tmp/ao-${tag}.png`;
  fs.writeFileSync(f, buf);
  return readPNG(f);
}

/** Per-pixel darkening the AO pass contributed, as positive levels. */
function aoTerm(on, off) {
  const C = on.channels, W = on.width, H = on.height;
  const d = new Float32Array(W * H);
  for (let i = 0, p = 0; i < W * H; i++, p += C) {
    const a = 0.2126 * on.data[p] + 0.7152 * on.data[p + 1] + 0.0722 * on.data[p + 2];
    const b = 0.2126 * off.data[p] + 0.7152 * off.data[p + 1] + 0.0722 * off.data[p + 2];
    d[i] = Math.max(0, b - a);
  }
  return { d, W, H };
}

function band(t, y0f, y1f, thresh = 2) {
  const y0 = (t.H * y0f) | 0, y1 = (t.H * y1f) | 0;
  let n = 0, hit = 0, sum = 0, max = 0;
  for (let y = y0; y < y1; y++) for (let x = 0; x < t.W; x++) {
    const v = t.d[y * t.W + x];
    n++;
    if (v > thresh) { hit++; sum += v; }
    if (v > max) max = v;
  }
  return { spread: 100 * hit / n, depth: hit ? sum / hit : 0, peak: max };
}

/**
 * How LOCALISED the AO term is, without needing to know where anything is.
 *
 * A contact term has steep edges: it goes from nothing to strong over a few
 * pixels at the base of an object. A haze is smooth everywhere. So the ratio of
 * the mean gradient magnitude to the mean value separates them, and it needs no
 * object positions, no projection and no crowd -- all of which is why the first
 * two versions of this failed.
 */
function sharpness(t, y0f, y1f) {
  const y0 = (t.H * y0f) | 0, y1 = (t.H * y1f) | 0;
  let sumV = 0, sumG = 0, n = 0;
  for (let y = y0 + 1; y < y1 - 1; y++) {
    for (let x = 1; x < t.W - 1; x++) {
      const i = y * t.W + x;
      const gx = t.d[i + 1] - t.d[i - 1];
      const gy = t.d[i + t.W] - t.d[i - t.W];
      sumV += t.d[i];
      sumG += Math.hypot(gx, gy);
      n++;
    }
  }
  return { mean: sumV / n, grad: sumG / n, sharp: sumG / Math.max(0.001, sumV) };
}

// REPRODUCIBILITY GATE. Everything below is a difference between two captures
// taken seconds apart on a renderer running at well under 1 fps, so anything
// that moves in between arrives in the difference as if it were occlusion.
// Pinning the crowd and the traffic was not enough: the same unchanged 2.2 m
// radius has read 44.2%, 27.6% and 31.0% on three runs of this tool, a spread
// far larger than the effect being looked for.
//
// So the baseline radius is measured TWICE before the sweep starts, and the
// sweep is refused if the two disagree. A tool that cannot repeat itself has no
// business reporting a trend, and the failure mode it would otherwise produce --
// a plausible monotonic-looking table built out of noise -- is exactly the kind
// this session has already been burned by.
async function measureAt(r) {
  await page.evaluate((rr) => { window.__district.post.params.aoRadius = rr; window.__district.post.params.aoEnabled = true; }, r);
  await page.waitForTimeout(2500);
  const on = await capture(`on-${r}`);
  await page.evaluate(() => { window.__district.post.params.aoEnabled = false; });
  await page.waitForTimeout(2500);
  const off = await capture(`off-${r}`);
  return aoTerm(on, off);
}
{
  const a = band(await measureAt(RADII[0]), 0.72, 1.0);
  const b = band(await measureAt(RADII[0]), 0.72, 1.0);
  const drift = Math.abs(a.spread - b.spread) / Math.max(0.01, (a.spread + b.spread) / 2);
  console.log(`repeatability at ${RADII[0]} m: ground spread ${a.spread.toFixed(1)}% then ${b.spread.toFixed(1)}%  (drift ${(100 * drift).toFixed(1)}%)`);
  if (drift > 0.12) {
    console.error(`\nREFUSING TO SWEEP: the same radius does not reproduce (${(100 * drift).toFixed(1)}% drift).`);
    console.error('The difference of two captures is measuring the simulation, not the AO pass.');
    console.error('The instrument that can answer this reads the AO render target DIRECTLY --');
    console.error('post.js keeps it in aoBlurRT, one capture, no differencing and nothing moving');
    console.error('in between. Build that instead of tightening thresholds here.');
    await browser.close();
    process.exit(2);
  }
}

const rows = [];
for (const r of RADII) {
  await page.evaluate((rr) => { window.__district.post.params.aoRadius = rr; window.__district.post.params.aoEnabled = true; }, r);
  await page.waitForTimeout(2500);
  const on = await capture(`on-${r}`);
  await page.evaluate(() => { window.__district.post.params.aoEnabled = false; });
  await page.waitForTimeout(2500);
  const off = await capture(`off-${r}`);
  const t = aoTerm(on, off);
  const g = band(t, 0.72, 1.0), f = band(t, 0.35, 0.72);
  const sg = sharpness(t, 0.72, 1.0), sf = sharpness(t, 0.35, 0.72);
  rows.push({ r, g, f, sharpGround: sg, sharpFacade: sf });
  console.log(`  localisation  ground: mean ${sg.mean.toFixed(2)} grad ${sg.grad.toFixed(3)} sharpness ${sg.sharp.toFixed(3)}` +
    `   facade: mean ${sf.mean.toFixed(2)} grad ${sf.grad.toFixed(3)} sharpness ${sf.sharp.toFixed(3)}`);
  console.log(`radius ${String(r).padStart(4)} m   ground: spread ${g.spread.toFixed(1).padStart(5)}%  depth ${g.depth.toFixed(1).padStart(5)}  peak ${g.peak.toFixed(0).padStart(3)}` +
    `   |   facade: spread ${f.spread.toFixed(1).padStart(5)}%  depth ${f.depth.toFixed(1).padStart(5)}  peak ${f.peak.toFixed(0).padStart(3)}`);
}
await browser.close();
if (errors.length) console.log(`page errors: ${errors.length} — ${errors[0]}`);
fs.writeFileSync('docs/ao-sweep.json', JSON.stringify({ radii: RADII, peds: PEDS, rows }, null, 1));

const base = rows[0];
console.log(`\nrelative to ${base.r} m (what ships today):`);
for (const row of rows.slice(1)) {
  console.log(`  ${String(row.r).padStart(4)} m   ground spread x${(row.g.spread / base.g.spread).toFixed(2)}` +
    `   contact peak x${(row.g.peak / Math.max(1, base.g.peak)).toFixed(2)}` +
    `   facade spread x${(row.f.spread / Math.max(0.01, base.f.spread)).toFixed(2)}` +
    `   facade peak x${(row.f.peak / Math.max(1, base.f.peak)).toFixed(2)}`);
}
console.log('\nWanted: ground spread DOWN a lot, contact peak and facade peak held.');
