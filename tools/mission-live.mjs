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

/**
 * THE BOARD, FIRST, because this is the only door a player has and every other check in this
 * file opens it with a console call. Until this round both authored missions were reachable
 * only from `startMission`, and a playtester led its report with it. The board is 23 checks in
 * mission-test and 8 in playtest --selftest, all of them offline; what nothing asserted is that
 * driving into the marker starts the job IN THE PAGE, or that the marker is drawn at all.
 *
 * Done before the scripted run below so the board is still untouched: a passed mission leaves it.
 */
{
  const b0 = await page.evaluate(() => __district.missionBoard());
  console.log(`  board at the spawn: ${JSON.stringify({ available: b0.available,
    markers: b0.markers, offerHere: b0.offerHere, noticeHere: b0.noticeHere
      ? { id: b0.noticeHere.mission.id, distance: b0.noticeHere.distance } : null })}`);
  check('the board offers both jobs on a fresh load',
    b0.available.length === 2 && b0.markers.length === 2, b0.available.join(', '));
  check('and none of them fires where the player is standing', b0.offerHere === null,
    JSON.stringify(b0.offerHere));

  // THE MARKER IS DRAWN. A blip on the minimap is not a destination; the disc in the street is,
  // and it is the only thing in the world telling a player where to go.
  const drawn = await page.evaluate(() => {
    let n = 0, visible = 0, tris = 0;
    __district.scene.traverse((o) => {
      if (!o.isMesh || !o.geometry || !o.geometry.parameters) return;
      const p = o.geometry.parameters;
      // The offer ring: an open-ended cylinder of unit radius, scaled per marker.
      if (p.openEnded !== true || p.radialSegments !== 24) return;
      n++;
      if (o.visible) visible++;
      tris += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    });
    return { n, visible, tris };
  });
  console.log(`  offer rings in the scene: ${JSON.stringify(drawn)}`);
  check('a ring is in the scene for each job on offer', drawn.visible === 2,
    `${drawn.visible} visible of ${drawn.n}`);
  check('and it is cheap enough to give away', drawn.tris <= 200, `${drawn.tris} triangles`);

  // Just outside the pickup: announced, not started.
  const st = await page.evaluate(() => {
    const m = __district.missionBoard().markers.find((k) => k.id === 'shakedown');
    __district.setMode('car');
    __district.placeAt(m.x + 26, m.z, 0);              // 26 m out: past 12, inside 48
    return m;
  });
  await settle(6);
  const near = await page.evaluate(() => ({ board: __district.missionBoard(),
    running: __district.missionReport().mission }));
  console.log(`  26 m from the marker: running ${JSON.stringify(near.running)}, ` +
    `notice ${near.board.noticeHere ? near.board.noticeHere.mission.id + ' @ ' +
      near.board.noticeHere.distance + ' m' : 'none'}`);
  check('26 m from a marker announces it and starts nothing',
    near.running === null && !!near.board.noticeHere,
    `${near.running}, ${near.board.noticeHere ? near.board.noticeHere.mission.id : 'no notice'}`);

  // Driving into it starts the job, with no console call.
  await page.evaluate((m) => __district.placeAt(m.x, m.z, 0), st);
  await settle(6);
  const inIt = await page.evaluate(() => ({ report: __district.missionReport(),
    board: __district.missionBoard(), hud: __district.missionHud() }));
  console.log(`  standing on it: ${inIt.report.mission} / ${inIt.report.stage}, ` +
    `board now ${JSON.stringify(inIt.board.available)}`);
  check('driving into the marker starts that job', inIt.report.mission === 'shakedown',
    `${inIt.report.mission}`);
  check('the HUD has an objective for it', !!(inIt.hud && inIt.hud.objective),
    inIt.hud ? inIt.hud.objective : 'null');
  /**
   * AND EVERY RING COMES DOWN WHILE A MISSION RUNS, not just the one that was taken. This arm
   * first expected one ring left — for the other job, still on the board — and got two, because
   * `available()` means "not yet passed" and a RUNNING mission is still that. A ring you cannot
   * enter is an instruction you cannot obey, and the ring of the job you are in the middle of
   * doing is worse than either.
   */
  const ringsNow = await page.evaluate(() => {
    let visible = 0;
    __district.scene.traverse((o) => {
      const p = o.isMesh && o.geometry && o.geometry.parameters;
      if (p && p.openEnded === true && p.radialSegments === 24 && o.visible) visible++;
    });
    return visible;
  });
  check('every ring comes down while a mission runs', ringsNow === 0, `${ringsNow} still up`);
  await page.evaluate(() => __district.abortMission('board check done'));
  await settle(6);
  const back = await page.evaluate(() => {
    let visible = 0;
    __district.scene.traverse((o) => {
      const p = o.isMesh && o.geometry && o.geometry.parameters;
      if (p && p.openEnded === true && p.radialSegments === 24 && o.visible) visible++;
    });
    return { visible, available: __district.missionBoard().available };
  });
  console.log(`  after aborting: ${back.visible} rings, board ${JSON.stringify(back.available)}`);
  // An aborted job goes back on the board, so both rings return. A game that deletes its own
  // content on the player's first mistake has one mission fewer.
  check('and they come back when it ends', back.visible === 2 && back.available.length === 2,
    `${back.visible} rings, ${back.available.length} on the board`);
}

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
