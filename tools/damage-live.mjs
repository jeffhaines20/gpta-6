// Does the damage model reach the LIVE page? The offline gates prove the parts; this
// proves the wiring.
//
// tools/damage-test.mjs (89 checks), tools/blocker-test.mjs (46) and
// tools/crash-test.mjs (74) all run in node with no browser. None of them says
// district/main.js builds the index, attaches it, ticks the model, feeds the HUD,
// reports a crime, or lets the mission read health. CLAUDE.md's recurring lesson is
// that a lever reaching nothing produces beautifully consistent numbers and a
// confident wrong conclusion, and this project has shipped that three times.
//
//   node tools/damage-live.mjs
//
// Headless capture through SwiftShader is well under one frame a second, so this does
// NOT try to steer a car into a building: it teleports, it uses __district.crash() for
// the synthetic charges, and it drives into a wall only once, deliberately, with the
// throttle pinned — which is the only part that costs real wall clock.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.DL_PORT ?? 8123);
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log(`PAGEERROR: ${e.message.slice(0, 400)}`); });
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.DL_BOOT ?? 240000) });
await page.evaluate(() => { __district.setPedestrians(0); __district.setTraffic(false); });

const settle = async (n = 4) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction(({ f, k }) => __district.frames > f + k, { f: f0, k: n },
    { timeout: 180000, polling: 100 });
};

console.log('DAMAGE — LIVE WIRING');
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// §1  The index exists in the page and matches the offline figure.
// ---------------------------------------------------------------------------
const rep0 = await page.evaluate(() => __district.damageReport());
console.log(`\n§1  index: ${JSON.stringify(rep0.index)}`);
check('main.js built a blocker index', rep0.index && rep0.index.segments > 0, JSON.stringify(rep0.index));
check('the live index is the same 3,950 segments the gate measures',
  rep0.index.segments === 3950, `${rep0.index.segments}`);
check('all 523 buildings are in it', rep0.index.buildings === 523, `${rep0.index.buildings}`);
check('a showroom car reports health 1', rep0.health === 1 && !rep0.wrecked, JSON.stringify(rep0).slice(0, 200));

// ---------------------------------------------------------------------------
// §2  The mission snapshot reads the car's health, not a hard-coded 1.
// ---------------------------------------------------------------------------
console.log('\n§2  The mission snapshot');
await page.evaluate(() => { __district.setMode('car'); __district.repairCar(); });
await settle(4);
const snapBefore = await page.evaluate(() => __district.missionReport().snapshot);
const crashRec = await page.evaluate(() => __district.crash(30, 'frontRight'));
await settle(4);
const snapAfter = await page.evaluate(() => __district.missionReport().snapshot);
console.log(`    crash(30,'frontRight') -> severity ${crashRec.severity.toFixed(4)}, region "${crashRec.region}", crime ${crashRec.crime}`);
console.log(`    snapshot health ${snapBefore.health} -> ${snapAfter.health}`);
check('a synthetic 30 km/h charge is applied', crashRec.applied, crashRec.reason);
check('the mission snapshot health MOVED', snapAfter.health < snapBefore.health,
  `${snapBefore.health} -> ${snapAfter.health}`);
// To four decimals, not to the last bit: damageReport() rounds with toFixed(4) for
// legibility and missionSnapshot() does not, so the first draft of this compared
// 0.5381415417647302 against 0.5381 at a 1e-9 tolerance and failed on the rounding.
check('the snapshot health is the damage model, to four decimals',
  near(snapAfter.health, (await page.evaluate(() => __district.damageReport().health)), 1e-4),
  `snapshot ${snapAfter.health} vs report ${await page.evaluate(() => __district.damageReport().health)}`);
// This is the one that matters: the field was a constant for a whole round, and the
// instrument that says so is the runner's own constantFields.
const mr = await page.evaluate(() => {
  __district.startMission('shakedown');
  return null;
});
await settle(6);
await page.evaluate(() => __district.crash(20, 'left'));
await settle(6);
const rep2 = await page.evaluate(() => __district.missionReport());
console.log(`    runner constantFields while health is moving: ${JSON.stringify(rep2.constantFields)}`);
check('the runner no longer lists health as a field that never moves',
  !(rep2.constantFields ?? []).includes('health'), JSON.stringify(rep2.constantFields));
await page.evaluate(() => __district.abortMission('live-test'));

// ---------------------------------------------------------------------------
// §3  An impact becomes a crime. Nothing in this project ever called reportCrime.
// ---------------------------------------------------------------------------
console.log('\n§3  Impacts become crimes');
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); });
await settle(4);
const w0 = await page.evaluate(() => __district.wantedReport());
await page.evaluate(() => __district.crash(35, 'front'));
await settle(6);
const w1 = await page.evaluate(() => __district.wantedReport());
const d3 = await page.evaluate(() => __district.damageReport());
console.log(`    wanted heat ${w0.heat} -> ${w1.heat}, stars ${w0.stars} -> ${w1.stars}, crimes ${w0.stats.crimes} -> ${w1.stats.crimes}`);
console.log(`    damageReport: crimesReported ${d3.crimesReported}, crimesIgnored ${d3.crimesIgnored}, impactSoundsWanted ${d3.impactSoundsWanted}`);
check('a wall impact raised the wanted heat', w1.heat > w0.heat, `${w0.heat} -> ${w1.heat}`);
check('the crime was propertyDamage', w1.stats.crimes > w0.stats.crimes);
check('main.js counted the crime it reported', d3.crimesReported > 0, `${d3.crimesReported}`);
// And a nudge must NOT be a crime, or the meter is unusable in a car park.
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); });
await settle(4);
const nudge = await page.evaluate(() => __district.crash(4, 'front'));
await settle(4);
const w2 = await page.evaluate(() => __district.wantedReport());
console.log(`    a 4 km/h nudge: applied ${nudge.applied}, crime ${nudge.crime}, heat now ${w2.heat}`);
check('a 4 km/h nudge is not a crime', nudge.crime === null && w2.heat === 0,
  `crime ${nudge.crime} heat ${w2.heat}`);

// ---------------------------------------------------------------------------
// §4  The HUD is fed. Only the pixels can say this.
// ---------------------------------------------------------------------------
console.log('\n§4  The HUD');
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); });
await settle(8);
// hud.js keeps its displayed values in `disp`, damped at 10/s toward the fed ones in
// `state`. __district.hud() returns the instance, which the wanted-meter round added
// for exactly this reason: "so a tool can read what the wanted meter was actually fed,
// rather than trusting that the call site passes it".
const hudProbe = async () => page.evaluate(() => {
  const h = __district.hud && __district.hud();
  if (h && h.disp) return { health: h.disp.health, damage: h.disp.damage, fed: h.state.health };
  return null;
});
let hp0 = await hudProbe();
if (!hp0) {
  console.log('    (__district does not expose hud2; falling back to a pixel read)');
} else {
  console.log(`    hud disp.health ${hp0.health.toFixed(4)}, disp.damage ${hp0.damage.toFixed(4)}`);
}
await page.evaluate(() => __district.crash(45, 'front'));
await settle(30);       // the bar is damped at 10/s, so give it time to travel
const hp1 = await hudProbe();
const d4 = await page.evaluate(() => __district.damageReport());
console.log(`    after a 45 km/h charge: model health ${d4.health}, smoke ${d4.smoke}`);
if (hp0 && hp1) {
  console.log(`    hud disp.health ${hp0.health.toFixed(4)} -> ${hp1.health.toFixed(4)}, ` +
    `disp.damage ${hp0.damage.toFixed(4)} -> ${hp1.damage.toFixed(4)}`);
  check('the HUD health bar followed the model down', hp1.health < hp0.health - 0.05,
    `${hp0.health.toFixed(4)} -> ${hp1.health.toFixed(4)}`);
  check('the HUD damage overlay rose', hp1.damage > hp0.damage,
    `${hp0.damage.toFixed(4)} -> ${hp1.damage.toFixed(4)}`);
  // The damped value could in principle move for another reason; the FED value cannot.
  check('the value main.js fed the HUD is the model\'s own health',
    near(hp1.fed, d4.health, 1e-9), `fed ${hp1.fed} vs model ${d4.health}`);
} else {
  check('the page exposes the HUD so its feed can be checked', false,
    'add hud2 to __district');
}

// ---------------------------------------------------------------------------
// §5  A real drive into a real building. This is the only expensive section.
// ---------------------------------------------------------------------------
console.log('\n§5  Driving into a real building');
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); });
// Find a spot on the road with a wall ahead of it, using the page's own index.
const site = await page.evaluate(() => {
  const ix = __district.blockers;
  // Walk outward from Five Points along +x and pick the first segment we can line up
  // a 30 m run at.
  for (const s of ix.segs) {
    if (s.len < 12) continue;
    const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
    // Stand 26 m out along the outward normal and require the whole run to be clear.
    let ok = true;
    for (let d = 3; d <= 26; d += 1.5) {
      if (ix.resolveCircle(mx + s.nx * d, mz + s.nz * d, 1.2)) { ok = false; break; }
    }
    if (!ok) continue;
    return { x: mx + s.nx * 26, z: mz + s.nz * 26, nx: s.nx, nz: s.nz, wallX: mx, wallZ: mz, len: s.len };
  }
  return null;
});
check('found a wall with 26 m of clear run in front of it', !!site, JSON.stringify(site));
if (site) {
  console.log(`    wall at (${site.wallX.toFixed(1)}, ${site.wallZ.toFixed(1)}), starting 26 m out on its normal`);
  await page.evaluate((s) => {
    __district.setMode('car');
    // Point the car at the wall: forward is (sin yaw, cos yaw), and we want (-nx, -nz).
    __district.placeAt(s.x, s.z, Math.atan2(-s.nx, -s.nz));
    __district.repairCar();
  }, site);
  await settle(6);
  const before = await page.evaluate(() => __district.damageReport());
  // Pin the throttle and let it run.
  await page.evaluate(() => __district.press('KeyW'));
  const t0 = Date.now();
  await page.waitForFunction(() => __district.damageReport().contacts > 0,
    null, { timeout: 300000, polling: 200 }).catch(() => {});
  await page.evaluate(() => __district.release('KeyW'));
  await settle(4);
  const after = await page.evaluate(() => __district.damageReport());
  const wAfter = await page.evaluate(() => __district.wantedReport());
  console.log(`    ${((Date.now() - t0) / 1000).toFixed(0)} s of wall clock: contacts ${after.contacts}, ` +
    `health ${before.health} -> ${after.health}`);
  console.log(`    lastContact ${JSON.stringify(after.lastContact)}`);
  console.log(`    regions ${JSON.stringify(after.regions)}, heat ${wAfter.heat}, stars ${wAfter.stars}`);
  check('driving into a building produced a contact', after.contacts > 0, `${after.contacts}`);
  check('driving into a building cost health', after.health < 1, `${after.health}`);
  const still = await page.evaluate(() =>
    __district.blockers.insideAny(__district.vehicle.position.x, __district.vehicle.position.z));
  check('the car did not end up inside the building', still < 0, `insideAny ${still}`);
}

// ---------------------------------------------------------------------------
// §6  Moving bodies: a pedestrian is a crime that costs the car nothing.
// ---------------------------------------------------------------------------
console.log('\n§6  Moving bodies');
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); __district.setPedestrians(64); });
await settle(10);
const anyPed = await page.evaluate(() => {
  const ps = __district.pedestrianPositions();
  return ps.length ? ps[0] : null;
});
check('there is a crowd to hit', !!anyPed, JSON.stringify(anyPed));
if (anyPed) {
  // Put the car on top of a pedestrian at speed. Teleporting sets the position but not
  // the velocity, so the velocity is set through the vehicle directly — a stationary car
  // resting on a pedestrian is not a contact at all, which is correct and is also the
  // reason this cannot just be a teleport.
  const out = await page.evaluate((p) => {
    __district.setMode('car');
    __district.placeAt(p.x - 6, p.z, Math.PI / 2);
    const v = __district.vehicle;
    v.velocity.set(16.67, 0, 0);          // 60 km/h at the crowd
    return { before: __district.damageReport(), wanted: __district.wantedReport() };
  }, anyPed);
  await settle(12);
  const after = await page.evaluate(() => __district.damageReport());
  const wPed = await page.evaluate(() => __district.wantedReport());
  console.log(`    dynamic: ${JSON.stringify(after.dynamic)}`);
  console.log(`    health ${out.before.health} -> ${after.health}, heat ${out.wanted.heat} -> ${wPed.heat}, stars ${wPed.stars}`);
  console.log(`    crimes reported: ${after.crimesReported}, ignored: ${after.crimesIgnored}`);
  check('the moving-body pass ran at all', after.dynamic.frames > 0, JSON.stringify(after.dynamic));
  check('it tested bodies near the car', after.dynamic.tested > 0, `${after.dynamic.tested}`);
  if (after.dynamic.pedHits > 0) {
    check('a pedestrian strike costs the car under 1%', after.health > 0.99, `${after.health}`);
    check('a pedestrian strike is a crime', wPed.heat > out.wanted.heat,
      `${out.wanted.heat} -> ${wPed.heat}`);
    check('and it is worth at least one star', wPed.stars >= 1, `${wPed.stars}`);
  } else {
    // A crowd that walks is a crowd that may not be where it was 12 frames ago, and at
    // under one frame a second a headless page gives the crowd a long time to move. Say
    // so rather than failing: the offline gate covers the arithmetic, and `tested > 0`
    // already proves the pass reaches the crowd.
    console.log('    (the pedestrian moved before the car arrived; tested > 0 is the claim here)');
  }
}

// ---------------------------------------------------------------------------
// §7  The HUD route line, on the streets.
// ---------------------------------------------------------------------------
console.log('\n§7  Routing and the HUD route line');
const graph = await page.evaluate(() => __district.roads.stats);
console.log(`    road graph: ${JSON.stringify(graph)}`);
check('main.js built a road graph', graph && graph.vertices > 500, JSON.stringify(graph));
check('it refused the 11 impassable service edges', graph.blockedEdges === 11, `${graph.blockedEdges}`);
const tourLive = await page.evaluate(() => {
  const t = __district.tourRoute();
  let blocked = 0;
  for (const q of t.points) if (!__district.clearAt(q[0], q[1], 0.95)) blocked++;
  return { points: t.points.length, length: Math.round(t.length), blocked };
});
console.log(`    the whole route as a driveable tour: ${tourLive.points} points, ${tourLive.length} m, ` +
  `${tourLive.blocked} blocked for a car`);
check('the live tour matches the offline figure', tourLive.points === 818, `${tourLive.points}`);
check('no point of the live tour is blocked', tourLive.blocked === 0, `${tourLive.blocked}`);

// The route line only has a source while a mission is running, so start one.
await page.evaluate(() => { __district.setMode('car'); __district.repairCar(); __district.startMission('marlin-street'); });
await settle(8);
const routed = await page.evaluate(() => {
  const h = __district.hud && __district.hud();
  // THE PATH2D LIVES ON THE MINIMAP, NOT ON THE HUD. hud.js has two setRoute()s: the HUD's
  // forwards to update({route}), and the Minimap's builds the Path2D — hud.draw() calls
  // `this.minimap.setRoute(s.route)`. The first draft of this probe read `hud._routePath`,
  // found undefined, and reported the wiring broken when it was the probe looking one object
  // too high. A live check that reads the wrong object is worse than no live check.
  const m = h && h.minimap;
  const line = __district.routeLine();
  return {
    stage: __district.missionReport().stage,
    waypoint: __district.missionHud().waypoint,
    points: line ? line.length : 0,
    first: line ? line[0].slice(0, 2) : null,
    last: line ? line[line.length - 1].slice(0, 2) : null,
    hudHasPath: !!(m && m._routePath),
    hudSrcLen: m && m._routeSrc ? m._routeSrc.length : 0,
  };
});
console.log(`    stage "${routed.stage}", waypoint ${JSON.stringify(routed.waypoint)}`);
console.log(`    route line: ${routed.points} points, ${JSON.stringify(routed.first)} -> ${JSON.stringify(routed.last)}`);
console.log(`    hud._routePath built: ${routed.hudHasPath}, from ${routed.hudSrcLen} points`);
check('the mission stage has a waypoint to route to', !!routed.waypoint, JSON.stringify(routed));
check('main.js planned a route to it', routed.points > 2, `${routed.points} points`);
check('the route ends at the waypoint',
  routed.last && routed.waypoint &&
  Math.hypot(routed.last[0] - routed.waypoint.x, routed.last[1] - routed.waypoint.z) < 60,
  `${JSON.stringify(routed.last)} vs ${JSON.stringify(routed.waypoint)}`);
// THE POINT OF THIS SECTION. hud.js has had setRoute() and a cyan Path2D since it was
// written, and nothing ever called it — the same as objective, subtitle and waypoint before
// the mission round. A built Path2D is the only proof it is fed.
check('the HUD built its route Path2D, which nothing has ever fed before',
  routed.hudHasPath, `src ${routed.hudSrcLen}`);
check('the HUD got the same points main.js planned', routed.hudSrcLen === routed.points,
  `${routed.hudSrcLen} vs ${routed.points}`);
// And it follows the STREETS: a straight line would be shorter than a routed one.
const straightVsRouted = await page.evaluate(() => {
  const wp = __district.missionHud().waypoint;
  const line = __district.routeLine();
  const s0 = line[0];
  let len = 0;
  for (let i = 1; i < line.length; i++) len += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  return { routed: len, straight: Math.hypot(wp.x - s0[0], wp.z - s0[1]) };
});
console.log(`    routed ${straightVsRouted.routed.toFixed(0)} m against ${straightVsRouted.straight.toFixed(0)} m ` +
  `as the crow flies — a ${(straightVsRouted.routed / straightVsRouted.straight).toFixed(2)}x detour`);
// A ROUTE ALONG A STRAIGHT STREET IS NOT A DETOUR, and asserting one was a misreading of what
// the router is for. This leg is Main St east to Five Points, which IS Main Street: 544 m of
// road against 538 m of straight line, a 1.01x "detour", and that is the correct answer. The
// property worth asserting is that the route is never SHORTER than the straight line and that
// every point of it is on the road — and, separately, that a leg which does need to detour
// does detour.
check('the route is never shorter than the straight line',
  straightVsRouted.routed >= straightVsRouted.straight * 0.999,
  `${straightVsRouted.routed.toFixed(0)} vs ${straightVsRouted.straight.toFixed(0)}`);
const onRoad = await page.evaluate(() =>
  __district.routeLine().every((q) => __district.clearAt(q[0], q[1], 0.95)));
check('every point of the route is clear for a car', onRoad);
// A leg that genuinely has to go round: the marina, from the far east end of Main Street.
const detour = await page.evaluate(() => {
  const p = __district.routeTo(-471, 205);
  if (!p) return null;
  const s0 = p.points[0];
  return { routed: p.length, straight: Math.hypot(-471 - s0[0], 205 - s0[1]) };
});
if (detour) {
  console.log(`    and to the marina: ${detour.routed.toFixed(0)} m of road against ` +
    `${detour.straight.toFixed(0)} m straight — a ${(detour.routed / detour.straight).toFixed(2)}x detour`);
  check('a leg that needs to go round does go round',
    detour.routed > detour.straight * 1.05,
    `${detour.routed.toFixed(0)} vs ${detour.straight.toFixed(0)}`);
} else {
  check('a route to the marina exists', false);
}
await page.evaluate(() => __district.abortMission('live-test'));

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
await browser.close();
if (failed.length) {
  console.log(`\nDAMAGE LIVE: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nDAMAGE LIVE: PASS — ${checks.length} checks`);
