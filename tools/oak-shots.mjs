// Before/after frames for the live-oak round, in the district rather than on a
// bench, at the three cameras the census actually points at.
//
// Every camera stands somewhere the oak profile is non-zero and says so, so a
// frame that shows no change is a frame in a stretch where the census said
// there should be none. Two times of day per camera: binding constraint 3.
//
//   node tools/oak-shots.mjs --tag before
//   node tools/oak-shots.mjs --tag after
//
// The wait is not decoration. Scenes take about 30 s to finish streaming and a
// fixed short wait measures a half-built district; this pumps world.update()
// directly and then waits again per time of day, and reports the chunk count it
// actually captured at so a thin frame can be seen rather than guessed at.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const TAG = arg('tag', 'after');
// GOLDEN AND DUSK, not noon and dusk. Binding constraint 3 asks for two times
// of day; it does not ask for one of them to be unreadable. This build's noon
// preset sets the stop for a 100,000 lux sky, so everything not in direct sun
// goes to near-black -- the committed a8-corridor-noon.png does exactly the
// same thing, so that is the shipped look and not a fault in this harness. A
// canopy judged in that frame is a canopy judged in silhouette. Golden and dusk
// both expose the street, and the pair still spans 8.3 stops of exposure.
const TIMES = (arg('times', 'golden,dusk')).split(',');

// Cameras. `at` is where the camera stands and `look` where it points; both are
// world (x, y, z), and the y values put the eye at a driver's height rather
// than a helicopter's, because an oak canopy is a thing you are UNDER.
const SHOTS = [
  // The measured tunnel: Main St east x 86..148, 13 census stations above 15%
  // foliage with a median 27.8% of the TOP of frame in leaf. Standing west of
  // it looking east, so the whole run is in one frame.
  { name: 'tunnel', at: [52, 2.0, -163.9], look: [250, 6.2, -164.6], fov: 55 },
  // Inside it, from the kerb, which is the composition the reference views use.
  { name: 'under', at: [104, 2.1, -161.5], look: [186, 6.4, -166.0], fov: 62 },
  // The bayfront run, s 240..320: the densest bucket in the district at 14 of
  // 16 stations above 15%, and by eye a mix of kerbside oaks and a park edge.
  { name: 'bayfront', at: [-296, 2.0, 74], look: [-186, 6.0, 52], fov: 55 },
];

fs.mkdirSync('docs/shots', { recursive: true });
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });

const report = await page.evaluate(() => __district.furniture.report());
console.log(`furniture: ${report.propCount} props, ${report.propTriangles} triangles, `
  + `trees ${report.props.tree}, species ${JSON.stringify(report.treeSpecies)}, `
  + `worstFloatMm ${report.worstFloatMm}`);

const results = [];
for (const s of SHOTS) {
  await page.evaluate((cfg) => {
    __district.placeAt(cfg.at[0], cfg.at[2]);
    __district.setAutopilot(() => {});
    __district.freeCam(cfg.at, cfg.look, cfg.fov);
    // Pump the streamer at the camera rather than sleeping and hoping.
    for (let i = 0; i < 1200; i++) __district.world.update(__district.vehicle.position);
  }, s);
  await page.waitForTimeout(15000);
  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    // WAIT FOR THE EXPOSURE, DO NOT ASSUME IT. The camera stop spans 1/78,000
    // at noon to 1/1.15 at night and it adapts over seconds, so a fixed 15 s
    // after a cold start caught the FIRST time of day mid-adaptation: the noon
    // frame in the first run of this tool came out as a near-black street under
    // a blue sky, with the dusk frame that followed it -- which had had the
    // noon wait to settle in as well -- perfectly exposed. A before/after pair
    // where the two arms are at different stops compares nothing.
    const stop = await page.evaluate(async () => {
      const read = () => window.__district.post.params.exposure;
      let prev = read();
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const now = read();
        if (Math.abs(now - prev) <= Math.abs(prev) * 0.002) return { exposure: now, seconds: i + 1 };
        prev = now;
      }
      return { exposure: prev, seconds: 40, settled: false };
    });
    await page.waitForTimeout(3000);
    const file = `docs/shots/oak2-${TAG}-${s.name}-${tod}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    const audit = await page.evaluate(() => {
      const w = __district.worldReport(), r = __district.renderStats(), a = __district.audit();
      return { chunks: w.chunksLoaded, lodNear: w.lodNear, lodFar: w.lodFar,
        drawCalls: r.calls, sceneCalls: r.sceneCalls, triangles: r.triangles,
        exposure: a.exposureAsStop, sunEl: a.sunElevationDeg };
    });
    results.push({ shot: s.name, tod, file, audit, settle: stop });
    console.log(`${file}   chunks ${audit.chunks}  draw ${audit.drawCalls}  `
      + `tris ${audit.triangles}  exposure ${audit.exposure}  `
      + `settled in ${stop.seconds}s${stop.settled === false ? ' (NOT SETTLED)' : ''}`);
  }
}
fs.writeFileSync(`docs/oak2-${TAG}-audits.json`,
  JSON.stringify({ tag: TAG, furniture: report, results, errors }, null, 1));
console.log(`\nwrote docs/oak2-${TAG}-audits.json`);
if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 4));
await browser.close();
