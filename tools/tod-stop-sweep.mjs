// Render one time-of-day preset at several candidate camera stops, from a SINGLE
// settled scene, so the stop is chosen off frames rather than off arithmetic.
//
// This exists because the noon round had two defensible derivations for the same
// number that disagreed by 1.9 stops, and no amount of further arithmetic was
// going to separate them. Five renders did, in the time one full sweep takes.
//
// THE FIRST STOP IS ALWAYS A CONTROL. Pass the shipping stop first and the frame
// it produces must reproduce docs/shots/tod-<preset>.png; if it does not, the
// harness is measuring something other than the build and every other row is
// worthless. Verified twice on the noon round, once either side of the fix:
// at 1/69,490 the control read mean 23.7 / sky 39.6 / sky-lit facade 2.1 against
// the sweep's own 23.8 / 39.6 / 2.1, and at 1/14,000 mean 113.0 / 8.21% below
// 16/255 against the sweep's 114.0 / 7.92%. The residual is the traffic and the
// pedestrians, which are not frozen here and move between runs.
//
// The stop is written into the PRESET and apply() is re-run, not poked into
// post.params - so sky.applyToPost() and TimeOfDay.normalisePostExposure() run
// against the candidate exactly as they would on a committed change. Writing
// post.params.exposure directly skips both, and both are stop-dependent: the fog
// and inscatter clamps are in exposed units, which is how a stop change can turn
// the far field milky without anything in the scene moving.
//
// Frames land in docs/shots/stop-<preset>-<denominator>.png. Measure them with
//   node tools/tod-readability.mjs --dir docs/shots --prefix stop-noon- ...
// or read them back through the same region boxes tod-readability.mjs defines.
//
//   node tools/tod-stop-sweep.mjs noon 69490,20000,16000,13000,11500
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TOD = process.argv[2] ?? 'noon';
const STOPS = (process.argv[3] ?? '69490,16000,13000').split(',').map(Number);
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

// The exact camera tools/daynight-sweep.mjs parks at, so these frames are
// comparable with docs/shots/tod-*.png pixel for pixel.
await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len;
  __district.freeCam([a.x - (dx / len) * 26 + nx * 5.5, 5.2, a.z - (dz / len) * 26 + nz * 5.5],
    [a.x + (dx / len) * 300, 14, a.z + (dz / len) * 300], 48);
});
// Scenes take about 30 s to finish streaming and a fixed short wait measures a
// half-built district; pump the streamer directly, then wait.
await page.evaluate(() => { for (let i = 0; i < 200; i++) __district.world.update(__district.vehicle.position); });
await page.waitForTimeout(20000);
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.waitForTimeout(16000);

const rows = [];
for (const denom of STOPS) {
  const state = await page.evaluate(([t, e]) => {
    __district.tod.preset.exposure = e;
    __district.tod.apply(t);
    const p = __district.post.params;
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const a = __district.tod.audit();
    return {
      // Both fog terms are clamped in exposed units (0.85 / 2.2). A candidate
      // that pushes either onto its clamp is a candidate whose far field has
      // gone milky, and that is not visible in a single number anywhere else.
      fogExposed: +(lum(p.fogColor) * p.exposure).toFixed(3),
      insExposed: +(lum(p.fogInscatter) * p.exposure).toFixed(3),
      // What the bright pass now admits, in nits, which is the number that says
      // whether raising the stop has started blooming ordinary lit surfaces.
      bloomThresholdNits: Math.round(p.bloomThreshold / p.exposure),
      midSkyExposed: a.sky ? a.sky.midSkyExposed : null,
      implausible: a.implausible,
    };
  }, [TOD, 1 / denom]);
  await page.waitForTimeout(3000);
  const path = `${OUT}/stop-${TOD}-${denom}.png`;
  await page.screenshot({ path, timeout: 150000 });
  rows.push({ stop: `1/${denom}`, path, ...state });
  console.log(`1/${denom}  ${JSON.stringify(state)}`);
}
await browser.close();
fs.writeFileSync(`docs/stop-sweep-${TOD}.json`, JSON.stringify({ preset: TOD, rows, errors }, null, 1));
if (errors.length) console.log(`PAGE ERRORS: ${errors.length}`);
