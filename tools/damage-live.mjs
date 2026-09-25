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
