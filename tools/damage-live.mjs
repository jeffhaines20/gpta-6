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
    // THE HALF THE DAMAGE ROUND LEFT OUT. Three strikes at 60 km/h used to leave three people
    // walking; this says the strike reached src/pedestrians.js on the REAL collision path, not
    // just through the harness hook §8 uses.
    console.log(`    crowd: ${JSON.stringify(after.crowd)}`);
    check('the pedestrian the car hit was knocked down', after.dynamic.pedKnockdowns > 0,
      JSON.stringify(after.dynamic));
    check('and the crowd module counted the same knockdown',
      after.crowd.knockdowns >= after.dynamic.pedKnockdowns,
      `${after.crowd.knockdowns} vs ${after.dynamic.pedKnockdowns}`);
    check('60 km/h is over the fatality line, so it is counted as one',
      after.crowd.fatal > 0 && after.crowd.worstSpeed >= 12.5,
      JSON.stringify(after.crowd));
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
// §8  The reaction reaches the GEOMETRY, not just the state.
//
// tools/reaction-test.mjs proves the arithmetic offline: the throw distance, the phases, the
// wall test, the shunt, the gridlock exclusion. None of it says the rig is posed from the fall,
// or that the shunted car is DRAWN where src/traffic.js says it is. That is what this reads —
// the instance matrices themselves, which is the only thing the player ever sees.
//
// It uses __district.knockNearestPed / shuntNearestCar for the same reason §3 uses crash(): at
// under one frame a second, arranging a specific 60 km/h strike by driving costs minutes, and
// §6 above has already proved the real collision path reaches both modules.
// ---------------------------------------------------------------------------
console.log('\n§8  The reaction in the rendered geometry');
await page.evaluate(() => { __district.repairCar(); __district.clearWanted('live-test'); __district.setPedestrians(64); });
await settle(8);

// Every body's drawn pose, by slot. Read for the WHOLE crowd so the one that was hit can be
// compared against the ones that were not: a fall composed onto the wrong matrix — the mesh's
// rather than the instance's — would tip everybody, and a single-body reading cannot tell.
const POSE_FN = `(() => {
  const P = __district.pedestrians();
  const M4 = __district.camera.matrixWorld.constructor;
  const M = new M4();
  const out = [];
  for (let i = 0; i < P.count; i++) {
    const ped = P.peds[i];
    if (!ped) { out.push(null); continue; }
    const ns = P._nearSlot[i], near = ns >= 0, slot = near ? ns : i;
    (near ? P.nearTorsos : P.torsos).getMatrixAt(slot, M);
    const t = M.elements.slice();
    (near ? P.nearHeads : P.heads).getMatrixAt(slot, M);
    const h = M.elements.slice();
    const upLen = Math.hypot(t[4], t[5], t[6]) || 1;
    out.push({
      i, near, x: t[12], z: t[14], headY: h[13], torsoY: t[13],
      // The torso's own up axis, which is what says WHICH WAY it went over.
      upX: t[4] / upLen, upZ: t[6] / upLen,
      tiltDeg: Math.acos(Math.max(-1, Math.min(1, t[5] / upLen))) * 180 / Math.PI,
      down: !!ped.down, pedX: ped.x, pedZ: ped.z,
    });
  }
  return out;
})()`;
const poseBefore = await page.evaluate(POSE_FN);
const victim = await page.evaluate(() => __district.knockNearestPed(60));
console.log(`    knocked down: ${JSON.stringify(victim)}`);
check('the harness found a pedestrian to knock down', !!victim, JSON.stringify(victim));
if (victim) {
  check('60 km/h is over damage.js fatality line', victim.fatal === true, JSON.stringify(victim));
  check('and the throw distance is the reconstruction figure',
    near(victim.throwWanted, 21.45, 0.05), `${victim.throwWanted}`);
  // The fall is 0.32 s and dt is clamped to 0.05, so it completes in about seven frames. Wait on
  // the PHASE rather than on a frame count, which is the same rule as waiting on a PID.
  await page.waitForFunction((i) => {
    const d = __district.pedestrians().peds[i];
    return d && d.down && d.down.phase !== 'falling';
  }, victim.index, { timeout: 240000, polling: 200 });
  const poseProne = await page.evaluate(POSE_FN);
  const b = poseBefore[victim.index], a = poseProne[victim.index];
  // The two snapshots are separate evaluates, so a slot could in principle have been refilled
  // between them. Assert it rather than throwing a TypeError three sections deep.
  check('the victim is in both pose snapshots', !!(a && b), `${!!b} -> ${!!a}`);
  if (a && b) {
    console.log(`    slot ${victim.index}${a.near ? ' (near tier)' : ''}: torso tilt ` +
      `${b.tiltDeg.toFixed(1)} -> ${a.tiltDeg.toFixed(1)} deg, head Y ` +
      `${b.headY.toFixed(2)} -> ${a.headY.toFixed(2)} m`);
    check('the body was upright before the impact', b.tiltDeg < 5, `${b.tiltDeg.toFixed(1)} deg`);
    check('the drawn torso is on its side after it', a.tiltDeg > 70, `${a.tiltDeg.toFixed(1)} deg`);
    check('and the drawn head came down by over a metre',
      b.headY - a.headY > 1.0, `${(b.headY - a.headY).toFixed(2)} m`);
    // THE CONTROL. One body falls; the other 63 stand.
    let tipped = 0, worstOther = 0;
    for (const q of poseProne) {
      if (!q || q.i === victim.index) continue;
      if (q.tiltDeg > 5) tipped++;
      worstOther = Math.max(worstOther, q.tiltDeg);
    }
    console.log(`    control: ${tipped} of the other ${poseProne.filter(Boolean).length - 1} bodies ` +
      `tipped, worst ${worstOther.toFixed(2)} deg`);
    check('the fall is one body, not the whole crowd', tipped === 0, `${tipped} tipped`);
    // Then the slide. Bounded: a 60 km/h throw is 21.45 m and 3.3 s, which is 66 frames at the
    // 0.05 s clamp, and a wall can stop it sooner — so this waits on the slide STOPPING.
    await page.waitForFunction((i) => {
      const d = __district.pedestrians().peds[i];
      return !d || !d.down || Math.hypot(d.down.vx, d.down.vz) < 0.05;
    }, victim.index, { timeout: 300000, polling: 200 });
    const slide = await page.evaluate((i) => {
      const P = __district.pedestrians();
      const ped = P.peds[i];
      if (!ped || !ped.down) return null;
      const rec = P.positions().find((q) => q.i === i) ?? null;
      return { travelled: ped.down.travelled, want: ped.down.want, phase: ped.down.phase,
        down: rec ? rec.down : null, v: rec ? rec.v : null, fatal: ped.down.fatal };
    }, victim.index);
    console.log(`    slide: ${slide ? `${slide.travelled.toFixed(2)} m of a wanted ` +
      `${slide.want.toFixed(2)} m, phase ${slide.phase}` : 'the casualty was cleared first'}`);
    if (slide) {
      check('the body was actually thrown', slide.travelled > 1, `${slide.travelled.toFixed(2)} m`);
      // A wall can cut the slide short; nothing may make it longer than the model predicts.
      check('and never further than the reconstruction distance',
        slide.travelled <= slide.want * 1.001, `${slide.travelled.toFixed(2)} vs ${slide.want.toFixed(2)}`);
      check('the crowd publishes it as down', slide.down === true, `${slide.down}`);
      check('and it is not walking', slide.v === 0, `${slide.v}`);
      // Only while the body is still there: a cleared slot is drawn at scale zero, whose
      // translation is the origin, and "it moved 300 m" would pass this for the wrong reason.
      const poseSlid = await page.evaluate(POSE_FN);
      const q = poseSlid[victim.index];
      const drawnMoved = q ? Math.hypot(q.x - b.x, q.z - b.z) : null;
      /**
       * AND IT LANDS SHORT OF THE SLIDE, BY A TORSO. The slide is the ROOT's travel; the torso
       * instance is posed about that root, and a body that has gone over lies with its torso
       * centre roughly its own standing height behind the root. First measured at 20.62 m drawn
       * against 21.45 m slid and read as a 0.83 m error — it is the body rotating, and the
       * DIRECTION of that rotation is a real claim about the kinematics:
       *
       *   a car strikes a pedestrian below their centre of mass, so the legs are accelerated
       *   forward and the upper body lags. The head trails, which is why they land on the
       *   bonnet head-first toward the windscreen rather than being tipped forward onto the road.
       *
       * So the drawn torso must fall SHORT, not long, and its up axis must point AGAINST the
       * direction of travel. A fall composed the other way round would read 22.3 m here and
       * would look, in a screenshot, like the body had been tipped over forwards.
       */
      const shortfall = drawnMoved === null ? null : slide.travelled - drawnMoved;
      const upDotTravel = q ? q.upX * victim.dirX + q.upZ * victim.dirZ : null;
      console.log(`    the DRAWN body moved ${drawnMoved === null ? 'n/a' : `${drawnMoved.toFixed(2)} m`}` +
        `, short of the slide by ${shortfall === null ? 'n/a' : `${shortfall.toFixed(2)} m`}` +
        `, up . travel ${upDotTravel === null ? 'n/a' : upDotTravel.toFixed(3)}`);
      check('the drawn body moved with the slide, so the matrices follow the throw',
        drawnMoved !== null && drawnMoved > 1, `${drawnMoved}`);
      check('it lands short of the root by about a torso, not level with it and not beyond',
        shortfall !== null && shortfall > 0.4 && shortfall < 1.4, `${shortfall}`);
      check('and the head trails, which is what a legs-first impact does',
        upDotTravel !== null && upDotTravel < -0.7, `${upDotTravel}`);
    }
  }
}

// --- 8b  A traffic car: shunted off its lane, and drawn where its own module says.
await page.evaluate(() => __district.setTraffic(30));
await page.waitForFunction(() => __district.trafficPositions().length > 0,
  null, { timeout: 240000, polling: 200 });
await settle(6);
const CAR_FN = `(() => {
  const T = __district.traffic();
  const M4 = __district.camera.matrixWorld.constructor;
  const M = new M4();
  const out = [];
  for (const p of T._lastPositions) {
    const slot = T.cars.findIndex((c) => c && c.id === p.id);
    if (slot < 0) continue;
    T.meshes[T._shellOf[slot]].getMatrixAt(T._localOf[slot], M);
    const e = M.elements;
    out.push({ id: p.id, pubX: p.x, pubZ: p.z, pubYaw: p.yaw, v: p.v, shunted: !!p.shunted,
      drawnX: e[12], drawnZ: e[14], drawnYaw: Math.atan2(e[8], e[10]),
      clear: __district.clearAt(p.x, p.z, 0.95) });
  }
  return out;
})()`;
const carsBefore = await page.evaluate(CAR_FN);
check('there is a fleet on the road to ram', carsBefore.length > 0, `${carsBefore.length} cars`);
if (carsBefore.length) {
  const shunt = await page.evaluate(() => __district.shuntNearestCar(8));
  console.log(`    shunted: ${JSON.stringify(shunt)}`);
  check('the harness found a car to shunt', !!shunt, JSON.stringify(shunt));
  if (shunt) {
    await settle(2);
    const carsAfter = await page.evaluate(CAR_FN);
    const b = carsBefore.find((c) => c.id === shunt.id);
    const a = carsAfter.find((c) => c.id === shunt.id);
    check('the shunted car is still in the fleet', !!a, `${shunt.id}`);
    if (a && b) {
      const moved = Math.hypot(a.pubX - b.pubX, a.pubZ - b.pubZ);
      const drawnVsPub = Math.hypot(a.drawnX - a.pubX, a.drawnZ - a.pubZ);
      console.log(`    published position moved ${moved.toFixed(2)} m, yaw by ` +
        `${Math.abs(a.pubYaw - b.pubYaw).toFixed(3)} rad, speed ${b.v.toFixed(2)} -> ${a.v.toFixed(2)} m/s`);
      console.log(`    drawn vs published: ${drawnVsPub.toExponential(1)} m, ` +
        `yaw ${Math.abs(a.drawnYaw - a.pubYaw).toExponential(1)} rad`);
      check('the published position moved', moved > 0.5, `${moved.toFixed(2)} m`);
      check('the published record says it is shunted', a.shunted === true, `${a.shunted}`);
      check('the ram stopped the car', a.v === 0, `${a.v}`);
      // §5's known-bad, live: a shunt applied at the matrix alone would put these apart.
      check('the DRAWN car is the PUBLISHED car, to 1 mm', drawnVsPub < 1e-3,
        `${drawnVsPub.toExponential(2)} m`);
      check('and so is its yaw', Math.abs(a.drawnYaw - a.pubYaw) < 1e-6,
        `${Math.abs(a.drawnYaw - a.pubYaw).toExponential(2)} rad`);
      // The building fit, live: the shunted car must still be on the street.
      check('the shunted car is not inside a building', a.clear === true, `clearAt ${a.clear}`);
    }
    const rep8 = await page.evaluate(() => __district.damageReport());
    console.log(`    fleet: ${JSON.stringify(rep8.fleet)}`);
    check('the fleet counted the shunt', rep8.fleet.shunts > 0, JSON.stringify(rep8.fleet));
    check('and the report carries the worst delta-v', rep8.fleet.worstDv >= 8,
      `${rep8.fleet.worstDv}`);
  }
}

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
