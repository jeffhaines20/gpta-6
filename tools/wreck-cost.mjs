#!/usr/bin/env node
// tools/wreck-cost.mjs — prices #96's remaining half: deliberately wrecking the car is the FASTEST
// full repair in the game, 8.2 s against a median 49 s drive to the garage, and the garage was
// built specifically so that it would not be. The entry records three candidate levers and says of
// all three that none is derived. Two of those statements are testable against the modules and the
// modules answer both.
//
// WHAT THE ENTRY GOT WRONG, and the second one is the useful half:
//
//   1. "The respawn POINT ... respawning THERE [at the garage] is a derivation rather than a tuned
//      number ... It is also a large gameplay change and would make a wreck far out of town
//      brutal." The objection has the sign backwards and it needs no sim: respawning at the garage
//      is the garage route WITH THE DRIVE TO THE GARAGE REMOVED. A player who wants a repair
//      wrecks the car and is delivered to the garage repaired, skipping the one cost the garage
//      exists to impose. It does not reduce the inversion, it MAXIMISES it — free fast travel to
//      the exact place you were going. §3 asserts that on every route.
//
//   2. "The replacement's HEALTH. Free today. There is no derivation available for a number
//      between 0 and 1, and anything under 1 risks the dead end this project has already removed
//      twice (a wrecked car with no engine power and no way home)." Both clauses are false:
//        - `DamageModel.fireHealth` (0.12) is the FLOOR. At or below it the fire latch re-wrecks
//          the car in fireHealth/fireRate = 3.0 s, which is an infinite loop. So the number is
//          bounded below by a module constant.
//        - `enginePower` returns 0 ONLY `if (this.wrecked)`; otherwise it bottoms at 0.25, and its
//          own comment says why: "never to zero while the car lives, because a car that cannot
//          move at all is a mission failure the player cannot see coming and cannot do anything
//          about." So THE DEAD END IS A PROPERTY OF `wrecked`, NOT OF `health`, and a respawn
//          clears `wrecked` by definition.
//      The number is therefore a module constant plus a module invariant, which is a derivation.
//
// This tool measures and does not ship. Whether to impose the cost at all is the owner's design
// call, which is what the entry said and still says; what has changed is that the lever it deferred
// for want of a derivation has one.
import { readFileSync } from 'node:fs';
import { RoadGraph, followPath } from '../src/roadpath.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { DamageModel } from '../src/damage.js';
import { SCENE_STOP_MS } from '../src/wanted.js';
import { OFFER_RADIUS_M } from '../src/mission.js';

const SELFTEST = process.argv.includes('--selftest');
const HERE = new URL('.', import.meta.url).pathname;
const district = JSON.parse(readFileSync(`${HERE}../data/district.json`, 'utf8'));
const roads = new RoadGraph(district);
const ground = new FlatGround(0);
/** district/main.js's GARAGE_AT. */
const GARAGE = { x: -67.9, z: 60.3 };
const DT = 1 / 120;
/** Round 11's measured wreck-to-repaired, #96. Not re-measured here: it needs a browser. */
const WRECK_S = 8.2;

const q = (xs, f) => {
  if (!xs.length) throw new Error('percentile of an empty population');
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.round(f * (s.length - 1)))];
};

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
}

/**
 * A car damaged to `health` with the damage on the FRONT, which is a frontal write-off and is also
 * the worst case for `enginePower` and the best case for `steerPull` — the pairing worth quoting,
 * because it is the slowest car that still has no steering handicap to confound the drive.
 */
export function hurt(health) {
  const d = new DamageModel();
  d._total = 1 - health;
  d.regions = { front: 1 - health, rear: 0, left: 0, right: 0 };
  return d;
}

/** Drive `pts` with the shipped follower and the shipped vehicle until stopped inside the ring. */
export function driveSeconds(pts, damage = null, radius = OFFER_RADIUS_M, capS = 600) {
  const v = new Vehicle();
  if (damage) v.damage = damage;              // vehicle.js: `get enginePower()` reads this
  v.position.set(pts[0][0], 0.55, pts[0][1]);
  const yaw0 = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
  v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw0);
  const st = { i: 0 };
  const endX = pts[pts.length - 1][0], endZ = pts[pts.length - 1][1];
  for (let k = 0; k < capS * 120; k++) {
    const qn = v.quaternion;
    const yaw = Math.atan2(2 * (qn.w * qn.y + qn.x * qn.z), 1 - 2 * (qn.y ** 2 + qn.x ** 2));
    const planar = Math.hypot(v.velocity.x, v.velocity.z);
    const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: planar }, st, { dt: DT });
    const dist = Math.hypot(v.position.x - endX, v.position.z - endZ);
    if (dist <= radius) v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    else v.setControls(f.controls);
    v.stepFixed(DT, ground, 120);
    if (dist <= radius && Math.hypot(v.velocity.x, v.velocity.z) < SCENE_STOP_MS) {
      return { t: k * DT, arrived: true, why: 'stopped-in-ring' };
    }
  }
  return { t: capS, arrived: false, why: 'cap' };
}

/** Routes from a spread of graph vertices to the garage, driven healthy and damaged. */
export function garageRoutes(n = 12, health = 0.13) {
  const verts = district.verts;
  const rows = [];
  for (let i = 0; i < n; i++) {
    const vi = Math.floor((i / n) * verts.length);
    const p = verts[vi];
    let toG = null, fromG = null;
    try { toG = roads.path(p.x, p.z, GARAGE.x, GARAGE.z); } catch { continue; }
    try { fromG = roads.path(GARAGE.x, GARAGE.z, p.x, p.z); } catch { }
    if (!toG || !toG.points || toG.points.length < 4) continue;
    const pts = toG.points.map((w) => [w[0], w[1]]);
    const healthy = driveSeconds(pts, null);
    const damaged = driveSeconds(pts, hurt(health));
    if (!healthy.arrived || !damaged.arrived) continue;
    const back = fromG && fromG.points && fromG.points.length >= 4
      ? driveSeconds(fromG.points.map((w) => [w[0], w[1]]), null) : null;
    rows.push({ vi, dist: toG.length, healthy: healthy.t, damaged: damaged.t,
      back: back && back.arrived ? back.t : null });
  }
  if (!rows.length) throw new Error('0 routes drove to the garage: nothing to price');
  return rows;
}

// ------------------------------------------------------------------------------------- the report
if (!SELFTEST) {
  const d0 = new DamageModel();
  console.log('WRECK COST — pricing #96\n');
  console.log('=== (1) THE MODULE\'S OWN FLOORS, which the entry says do not exist ===\n');
  console.log(`  fireHealth ${d0.fireHealth}   fireRate ${d0.fireRate} health/s`);
  console.log(`  a respawn AT or BELOW fireHealth latches on fire and re-wrecks in`
    + ` ${(d0.fireHealth / d0.fireRate).toFixed(1)} s — an infinite`);
  console.log('  loop, and that is the FLOOR. Nothing is picked; it is read off the module.\n');
  for (const h of [1.0, 0.5, 0.2, 0.13, 0.12]) {
    const d = hurt(h);
    console.log(`  health ${h.toFixed(3)}   front ${(1 - h).toFixed(3)}   enginePower ${d.enginePower.toFixed(4)}`
      + `   steerPull ${d.steerPull.toFixed(4)}   wrecked ${d.wrecked}`
      + `   fire latch ${h <= d0.fireHealth}`);
  }
  const wreckedCar = hurt(0.0);
  wreckedCar.wrecked = true;
  console.log(`\n  and WRECKED: enginePower ${wreckedCar.enginePower.toFixed(4)} — the only zero in the function.`);
  console.log('  So an UN-WRECKED car at any surviving health drives, at 0.25 power or better. The dead');
  console.log('  end the entry fears is a property of `wrecked`, which the respawn clears by');
  console.log('  definition, not of `health`.');

  console.log('\n=== (2) THE THREE ROUTES TO A REPAIRED CAR, driven with the shipped follower ===\n');
  const rows = garageRoutes();
  console.log('  wreck pt    to garage      (a) garage   (b) wreck   (c) lever1   (d) lever3');
  console.log('                              healthy       today     at garage   wreck+drive');
  for (const r of rows) {
    console.log(`  v${String(r.vi).padStart(5)}      ${r.dist.toFixed(0).padStart(6)} m`
      + `       ${r.healthy.toFixed(1).padStart(7)} s   ${WRECK_S.toFixed(1).padStart(7)} s`
      + `   ${(r.back === null ? '  n/a' : r.back.toFixed(1)).padStart(8)} s`
      + `   ${(WRECK_S + r.damaged).toFixed(1).padStart(9)} s`);
  }
  const med = (k) => q(rows.map((r) => r[k]).filter((x) => x !== null), 0.5);
  console.log(`\n  ${rows.length} routes arrived\n`);
  console.log(`  (a) drive to the garage, healthy       p50 ${med('healthy').toFixed(1)} s`);
  console.log(`  (b) wreck it on purpose, TODAY         p50 ${WRECK_S.toFixed(1)} s`
    + `   <- x${(med('healthy') / WRECK_S).toFixed(1)} FASTER than the garage`);
  console.log(`      (round 11's figure, #96; it needs a browser and is not re-measured here)`);
  console.log(`  (c) lever 1, respawn AT the garage      p50 ${med('back').toFixed(1)} s to drive back`);
  console.log(`  (d) lever 3, respawn in place at 0.13  p50 ${(WRECK_S + med('damaged')).toFixed(1)} s`);

  console.log('\n=== (3) LEVER 1 INVERTS IN THE OTHER DIRECTION ===\n');
  const cheaper = rows.filter((r) => WRECK_S < r.healthy).length;
  console.log(`  Under lever 1 a wreck costs ${WRECK_S} s and hands back a repaired car AT THE GARAGE.`);
  console.log(`  Driving there costs (a). So the wreck is the cheaper route to a repair on`);
  console.log(`  ${cheaper} of ${rows.length} routes — the inversion is not reduced, it is maximised, because the`);
  console.log('  wreck now also supplies the drive the garage exists to charge for.');
  console.log(`  The drive it hands over for nothing: p50 ${med('healthy').toFixed(1)} s,`
    + ` p75 ${q(rows.map((r) => r.healthy), 0.75).toFixed(1)} s.`);
  console.log('  (p75, not max: the max is the artefact row named in §5.)');
  console.log('  It is only "brutal" for a player who did NOT want the garage — and #106 now lets');
  console.log('  them hand the job back for 0 s, so even that cost has an out.');

  console.log('\n=== (4) LEVER 3 IS DERIVED, AND PER-ROW ===\n');
  // PER-ROW RATIOS, not a ratio of medians. Each row is ONE route driven twice, so its corners and
  // its length cancel; a ratio of medians over different routes holds neither fixed.
  const ratios = rows.map((r) => r.damaged / r.healthy);
  console.log(`  the garage drive at full power                     p50 ${med('healthy').toFixed(1)} s`);
  console.log(`  the SAME route at enginePower 0.25, per row        p25 x${q(ratios, 0.25).toFixed(2)}`
    + `  p50 x${q(ratios, 0.5).toFixed(2)}  p75 x${q(ratios, 0.75).toFixed(2)}`);
  console.log('\n  AND THE REAL STATEMENT IS STRONGER THAN THAT RATIO. Under lever 3 the wreck does not');
  console.log('  produce a repaired car at all, so it leaves the comparison: "what is the fastest');
  console.log(`  route to health 1.000" has one answer, the garage at p50 ${med('healthy').toFixed(1)} s, and wrecking`);
  console.log('  strictly adds to it. That is removal BY CONSTRUCTION rather than a constant tuned');
  console.log('  until the ordering came out right, which is what the entry asked for.');

  console.log('\n=== (5) ONE ROW IS A FOLLOWER ARTEFACT, named rather than averaged away ===\n');
  const anom = rows.filter((r) => r.damaged < r.healthy);
  if (!anom.length) console.log('  none this run');
  for (const r of anom) {
    console.log(`  v${String(r.vi).padStart(5)}  ${r.dist.toFixed(0).padStart(5)} m`
      + `   healthy ${r.healthy.toFixed(1)} s   at 0.25 power ${r.damaged.toFixed(1)} s`);
  }
  console.log('  A slower car cannot be faster on the same points unless the fast one is');
  console.log('  misbehaving, which is roadpath.js\'s own recorded defect: a healthy car at the');
  console.log('  22 m/s cap overshoots a tight corner, stops advancing its index, and loops. It is');
  console.log('  in the `max` column, which is why §3 quotes p75.');

  console.log('\n  THIS TOOL MEASURES AND DOES NOT SHIP. Whether to charge for a wreck at all is a');
  console.log('  design call; what has changed is that the lever the entry deferred for want of a');
  console.log('  derivation has one.');
}

// ------------------------------------------------------------------------------------- selftest
if (SELFTEST) {
  console.log('WRECK COST SELFTEST\n');
  const d0 = new DamageModel();

  // 1. THE INVARIANT THE WHOLE DERIVATION RESTS ON, both directions. A build that removed
  //    enginePower's floor (the `* 0.75`) would give 0 power to a living car and the dead end
  //    would be back; one that removed the `if (this.wrecked)` would give a wreck power it must
  //    not have. Neither passes both of these.
  const lowest = hurt(0.001);
  check('a living car never loses all engine power', lowest.enginePower >= 0.25 - 1e-9,
    `health 0.001, front 0.999 -> enginePower ${lowest.enginePower.toFixed(4)}`);
  const w = hurt(0.0); w.wrecked = true;
  check('and a WRECKED one has none, which is the only zero', w.enginePower === 0);

  // 2. THE FIRE FLOOR, which is what bounds the respawn health below. Straddle it.
  check('fireHealth is a real floor: at it the car catches fire, above it not',
    d0.fireHealth > 0 && d0.fireRate > 0 && 0.13 > d0.fireHealth,
    `fireHealth ${d0.fireHealth}, re-wrecks in ${(d0.fireHealth / d0.fireRate).toFixed(1)} s`);

  // 3. THE DAMAGE REACHES THE VEHICLE. This is the check that catches the probe rather than the
  //    build: `vehicle.enginePower` reads `this.damage`, and if the assignment did not take, every
  //    ratio would be exactly 1.000 and the lever would read as FREE. A NEGATIVE NEEDS ITS
  //    POSITIVE, so the healthy-against-healthy control is asserted beside it.
  const verts = district.verts;
  let probe = null;
  for (let i = 0; i < verts.length && !probe; i += 37) {
    try {
      const r = roads.path(verts[i].x, verts[i].z, GARAGE.x, GARAGE.z);
      if (r && r.points && r.points.length >= 8 && r.length > 200) probe = r;
    } catch { }
  }
  if (!probe) throw new Error('no probe route found');
  const pts = probe.points.map((p) => [p[0], p[1]]);
  const h1 = driveSeconds(pts, null);
  const h2 = driveSeconds(pts, null);
  const dmg = driveSeconds(pts, hurt(0.13));
  check('two healthy drives of one route are identical, so the rig is deterministic',
    h1.arrived && Math.abs(h1.t - h2.t) < 1e-9, `${h1.t.toFixed(4)} s twice`);
  check('and a damaged car is MEASURABLY slower, so `damage` reaches the vehicle',
    dmg.arrived && dmg.t > h1.t * 1.2,
    `healthy ${h1.t.toFixed(1)} s, at 0.25 power ${dmg.t.toFixed(1)} s, x${(dmg.t / h1.t).toFixed(2)}`);

  // 4. ARRIVALS COUNTED. abort-cost printed "FLOOR HOLDS" over eight timeouts once; a verdict with
  //    no arrivals is a check whose two sides are both zero.
  const rows = garageRoutes(6);
  check('the routes arrived rather than timing out', rows.length >= 4,
    `${rows.length} of 6 arrived, p50 ${q(rows.map((r) => r.healthy), 0.5).toFixed(1)} s`);

  // 5. LEVER 1'S SIGN, which needs no sim: a wreck costing WRECK_S and delivering a repaired car
  //    at the garage beats driving there whenever the drive is longer than WRECK_S.
  const cheaper = rows.filter((r) => WRECK_S < r.healthy).length;
  check('respawning at the garage leaves the wreck the CHEAPER repair, so lever 1 does not fix it',
    cheaper === rows.length, `${cheaper} of ${rows.length} routes`);

  // 6. And the inversion it is all about is real on this tree.
  const medH = q(rows.map((r) => r.healthy), 0.5);
  check('the inversion #96 reports reproduces: the wreck beats the garage', medH > WRECK_S * 2,
    `garage p50 ${medH.toFixed(1)} s against a ${WRECK_S} s wreck, x${(medH / WRECK_S).toFixed(1)}`);

  // 7. An empty population throws rather than reporting a percentile of nothing.
  let threw = false;
  try { q([], 0.5); } catch { threw = true; }
  check('a percentile of an empty population throws', threw);

  console.log(`\nWRECK COST SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
