// Does the mission layer reach the LIVE page? The offline gate proves the state
// machine; this proves the wiring.
//
// mission-test.mjs drives src/mission.js with a fake world and passes 51 checks. None
// of that says district/main.js ticks the runner, feeds the HUD, or executes an
// intent - and CLAUDE.md's recurring lesson is that a lever reaching nothing produces
// beautifully consistent numbers and a confident wrong conclusion. So: one page, one
// mission, teleport to each marker, and assert the outcome.
//
//   node tools/mission-live.mjs
//
// Deliberately uses `shakedown`, which exists for this: three stages, both markers
// near the spawn, no police, no timers. Under a minute of wall clock.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.ML_PORT ?? 8123);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log(`PAGEERROR: ${e.message.slice(0, 400)}`); });
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.ML_BOOT ?? 240000) });
await page.evaluate(() => { __district.setPedestrians(0); });

const settle = async (n = 4) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction(({ f, k }) => __district.frames > f + k, { f: f0, k: n },
    { timeout: 120000, polling: 100 });
};

// The surface exists at all.
const names = await page.evaluate(() => (__district.missions ? __district.missions() : null));
check('__district exposes the authored missions', Array.isArray(names) && names.includes('shakedown'),
  JSON.stringify(names));

const started = await page.evaluate(() => __district.startMission('shakedown'));
check('startMission returns a report on stage 1', started && started.stage === 'a' && started.outcome === 'running',
  `${started?.stage} / ${started?.outcome}`);

// THE TICK. If main.js is not calling update(), elapsed stays at 0 however many frames
// pass - which is exactly the "lever that reaches nothing" this file exists to catch.
await settle(20);
const ticked = await page.evaluate(() => __district.missionReport());
check('the frame loop is ticking the runner', ticked.elapsed > 0, `elapsed ${ticked.elapsed}s`);
check('the snapshot carries every field the mission reads',
  ticked.snapshot && ['px', 'pz', 'inVehicle', 'wantedStars', 'wantedState'].every((f) => f in ticked.snapshot),
  Object.keys(ticked.snapshot ?? {}).join(', '));

// Stage 1 wants the car.
await page.evaluate(() => __district.setMode('car'));
await settle(6);
let r = await page.evaluate(() => __district.missionReport());
check('getting in the car advances past stage 1', r.stage === 'b', `on ${r.stage}`);

// The HUD is actually being fed the objective and the waypoint.
const hud = await page.evaluate(() => __district.missionHud());
check('hud() gives main.js an objective and a waypoint',
  hud && typeof hud.objective === 'string' && hud.waypoint && Number.isFinite(hud.waypoint.x),
  `${hud?.objective} @ (${hud?.waypoint?.x}, ${hud?.waypoint?.z})`);

// Walk the remaining markers by teleporting to each one in turn.
for (let hop = 0; hop < 4; hop++) {
  const h = await page.evaluate(() => __district.missionHud());
  if (!h || !h.waypoint) break;
  await page.evaluate((w) => __district.placeAt(w.x, w.z), h.waypoint);
  await settle(8);
  const rep = await page.evaluate(() => __district.missionReport());
  console.log(`  hop ${hop}: placed at (${h.waypoint.x}, ${h.waypoint.z}) -> ${rep.stage ?? `[${rep.outcome}]`}`);
  if (rep.outcome !== 'running') break;
}

r = await page.evaluate(() => __district.missionReport());
check('driving the markers completes the mission', r.outcome === 'passed', r.outcome);
check('it visited every stage', r.visited.join(' > ') === 'a > b > c', r.visited.join(' > '));
console.log(`\n  log: ${r.log.join(' | ')}`);
console.log(`  constantFields: ${r.constantFields.join(', ') || '(none)'}`);
console.log(`  intentsNotHonoured: ${r.intentsNotHonoured.join(', ') || '(none)'}`);

// And the marlin-street intent path: entering `ambush` must actually set the stars.
await page.evaluate(() => { __district.clearWanted('test'); __district.startMission('marlin-street'); });
await page.evaluate(() => __district.setMode('car'));
await settle(6);
const fp = await page.evaluate(() => __district.missionHud().waypoint);
await page.evaluate((w) => __district.placeAt(w.x, w.z), fp);
await settle(10);
const amb = await page.evaluate(() => ({ ...__district.missionReport(), stars: __district.wantedReport().stars }));
check('an onEnter intent reaches the wanted system in the live game',
  amb.stage === 'ambush' && amb.stars === 2, `stage ${amb.stage}, stars ${amb.stars}`);
check('the health stub is reported as a constant, not hidden',
  amb.constantFields.includes('health'), `constant: ${amb.constantFields.join(', ')}`);

check('no page errors', errors.length === 0, errors.length ? errors[0].slice(0, 200) : 'none');
await browser.close();

const failed = checks.filter((c) => !c.ok);
console.log('\n=== CHECKS');
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
console.log(`\nMISSION-LIVE: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}` : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
