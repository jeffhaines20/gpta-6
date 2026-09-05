// Make the junction fix visible.
//
// Overlap went 73.25% -> 0.20% at 60 cars and throughput rose 19%, and a still
// frame shows none of it: the metric is "how many frames have two cars within
// 2.5 m", which is a thing you see by looking at a hundred frames, not one. A
// review that judges only hero stills scores the largest change of the round at
// zero.
//
// So: park the camera above a busy junction, run the fleet up to density, and
// capture. With the old single-occupant reservation the junction is a queue with
// cars stacked into each other; with conflict arbitration it is a junction with
// several movements crossing at once. That difference IS visible in one frame.
//
// WHAT THIS TOOL CANNOT DO, established the hard way. The overlap STATISTIC it
// prints is meaningless and is now labelled as such. This browser renders about
// 0.7 fps under SwiftShader, so traffic ticks 29 times in 40 s against the
// headless sim's 7,200; at dt = 1.4 s a car covers 12 m between samples while
// the overlap threshold is 2.5 m, so two cars pass through each other and
// nothing is counted. Captured either side of the change, both arms reported 0%
// - not because the old code was fine, but because 29 samples cannot see a
// per-frame event. The FRAME is still worth having: queue-versus-crossing is a
// geometric arrangement, not a sampled statistic. The number belongs to
// tools/traffic-sim.mjs, which runs the same AI at a fixed timestep.
//
//   node tools/junction-shot.mjs --tag after --cars 60
//   JS_PORT=8129 node tools/junction-shot.mjs --tag before --cars 60   # in a worktree
//
// The port matters for the same reason it does in smoke.mjs: ensureServer reuses
// a server already on 8123, so capturing a worktree while the main tree's server
// is up silently photographs the main tree.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const TAG = arg('tag', 'after');
const CARS = Number(arg('cars', 60));
const TOD = arg('tod', 'noon');
const PORT = Number(process.env.JS_PORT ?? 8123);

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr{display:none!important}#hud,.pv-hud{display:none!important}' });
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);

// A junction with several approaches, looked at from above and to one side, so
// cars on every arm are visible at once. Route waypoint 3 is the Five Points
// junction; the camera stands back and up rather than at eye level, because at
// eye level the near cars hide the far ones and the whole point is seeing the
// box at once.
const at = await page.evaluate((cfg) => {
  const r = __district.district.meta.route;
  const j = r[3];
  __district.placeAt(j.x - 40, j.z);
  __district.setAutopilot(() => {});
  __district.freeCam([j.x - 46, 26, j.z + 30], [j.x + 6, 0, j.z], 44);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { x: +j.x.toFixed(1), z: +j.z.toFixed(1) };
}, {});

await page.evaluate((n) => __district.setTraffic(n), CARS);
// Long enough for the fleet to reach density AND for the overlap statistic to
// mean something: the module's counter is cumulative over frames, so a short
// window reports whatever the first few seconds happened to do.
await page.waitForTimeout(Number(process.env.JS_SETTLE ?? 45000));

const file = `docs/shots/junction-${TAG}-${CARS}.png`;
await page.screenshot({ path: file });
const rep = await page.evaluate(() => {
  const t = __district.trafficReport();
  return { alive: t.alive, fleet: t.fleet, frames: t.frames, overlapPct: t.overlapPctOfFrames,
           nearJunction: t.overlapNearJunction, sameEdge: t.overlapSameEdge,
           meanSpeedKmh: t.meanSpeedKmh, stoppedPct: t.stoppedPctOfCarFrames };
});
console.log(`${file}   junction at (${at.x}, ${at.z})`);
console.log(`  ${JSON.stringify(rep)}`);
if ((rep.frames ?? 0) < 500) {
  console.log(`  NOTE: only ${rep.frames} traffic ticks - overlapPct above is a sampling`
    + ` artifact, not a measurement. Use tools/traffic-sim.mjs for overlap.`);
}
if (errors.length) console.log(`  ${errors.length} page errors: ${errors.slice(0, 2).join(' | ')}`);
fs.writeFileSync(`docs/junction-${TAG}.json`, JSON.stringify({ tag: TAG, cars: CARS, tod: TOD, at, ...rep, pageErrors: errors }, null, 1));
await browser.close();
