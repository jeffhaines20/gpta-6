// Can the autopilot still drive the route now that buildings are solid?
//
//   node tools/route-drive.mjs
//   node tools/route-drive.mjs --no-collision      the same drive with walls off
//
// WHY THIS EXISTS. tools/drive-through.mjs — the budget gate — drives the district on
// an autopilot that steers straight at the next route waypoint and cuts every corner.
// Until this round buildings were not solid, so cutting a corner cost nothing. They are
// now, and the gate's triangle p95 is ALREADY a standing WARN whose growth is
// unaccounted, so the last thing that should happen is a five-minute browser run whose
// result has a new confound in it.
//
// The whole drive can be replayed offline, exactly, because:
//
//   - the sim is fixed-step, and drive-through's own comment says the autopilot
//     "behaves the same however slowly the software renderer produces frames"
//   - src/streaming.js's ground is FLAT (`heightAt() { return this.groundY; }`, and
//     groundY is 0), so FlatGround(0) is not an approximation of it, it is it
//   - the autopilot reads only the route, the vehicle's position and its quaternion
//
// What is missing is traffic and the crowd, which this says nothing about. It answers
// two questions: is the COURSE driveable, and does the FOLLOWER drive it.
//
// WHERE IT ENDED UP. Three circuits of a 3,272 m road-graph tour in 793.5 s at a mean of
// 44.5 km/h, health 1.000, no applied impacts, no stuck-nudges, never more than 9.79 m off
// the line, and every one of its 264 body contacts under the FMVSS free threshold — all of
// them at one 8.3 m corner the car needs 8.9 m for. The straight-line arm, run for contrast,
// still wrecks the car ten seconds in and gets hand-carried round by the stuck-nudge.
//
// It took nine distinct bugs to get there, four in the course and five in the controller, and
// each one is written up where it was fixed. CLAUDE.md collects them: they all have the same
// shape, which is that the instrument reads nominal because it is computed from the same
// wrong quantity the controller is acting on.
import fs from 'node:fs';
import { Vehicle, BODY_RADIUS, BODY_SAMPLES } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel } from '../src/damage.js';
import { RoadGraph, followPath, minRadius, worstGap, cornerSpeed, RESPONSE } from '../src/roadpath.js';

/**
 * The right-hand lane offset. A path down the centreline of a 14 m carriageway is a path
 * down the middle of the oncoming traffic, so the course is shifted 3 m right — which is
 * also what makes the drive's own contacts meaningful, since a car on the correct side of
 * the road is 3 m nearer the kerb and the buildings behind it.
 */
const LANE_OFFSET = 3;

/** 22 m/s is 79 km/h: a downtown grid with junctions every 80 m. See followPath. */
const MAX_SPEED = Number(process.env.RD_MAX_SPEED ?? 22);

const NO_COLLISION = process.argv.includes('--no-collision');
const CIRCUITS = Number(process.env.RD_CIRCUITS ?? 3);
const HZ = 120, DT = 1 / HZ;
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const route = district.meta.route;
const blockers = new BlockerIndex(district);

console.log(`ROUTE DRIVE${NO_COLLISION ? ' (walls OFF)' : ''}`);
console.log('='.repeat(78));
console.log(`route: ${route.length} waypoints, ${CIRCUITS} circuits, ${HZ} Hz fixed step`);

const v = new Vehicle();
const damage = new DamageModel();
if (!NO_COLLISION) { v.blockers = blockers; v.damage = damage; }
const ground = new FlatGround(0);
v.position.set(route[1].x, 0.55, route[1].z);

// TWO COURSES, and the whole point of this file is the difference between them.
//
//   --straight   the control law copied verbatim from tools/drive-through.mjs: steer at
//                the next route waypoint, which is 75 to 512 m away, in a straight line
//   --roads      src/roadpath.js: Dijkstra on the road graph the traffic layer already
//                walks, resampled to 4 m, followed by pure pursuit
//
// 32.8% of the straight-line course — 829 m of 2,528 — is inside a building. That was
// harmless until this round and is not any more.
const MODE = process.argv.includes('--straight') ? 'straight' : 'roads';
console.log(`course: ${MODE}`);

let wp = 2, lap = 0, stuckFor = 0, nudges = 0, steps = 0;
const nudgeAt = [];
const path = [];
let worstOff = 0, offAt = null, blockedPts = 0, bodyBlockedPts = 0, pathPts = 0, pathLen = 0;
let worstOffPath = 0;
const CAP_STEPS = HZ * 60 * 30;         // 30 minutes of simulated time

// ONE CONTINUOUS PATH, not eight. See RoadGraph.tour(): following the legs
// independently makes every leg boundary a blind corner, and that was the entire cause
// of the three impacts this file spent an afternoon attributing to speed.
let graph = null, tour = null, follow = null;
if (MODE === 'roads') {
  graph = new RoadGraph(district, { blockers, carRadius: BODY_RADIUS });
  tour = graph.tour(route.slice(1), { spacing: 4, offset: LANE_OFFSET });
  pathPts = tour.points.length;
  pathLen = tour.length;
  for (const [x, z] of tour.points) if (blockers.resolveCircle(x, z, BODY_RADIUS)) blockedPts++;
  // The stronger clearance test: the car is 4.3 m long, so a point that holds a 0.95 m
  // circle is not the same as a point that holds a CAR oriented along the path. The first
  // draft of this file checked the circle, found 0, and still crashed.
  for (let i = 0; i < tour.points.length; i++) {
    const p0 = tour.points[Math.max(0, i - 1)], p2 = tour.points[Math.min(tour.points.length - 1, i + 1)];
    const dx = p2[0] - p0[0], dz = p2[1] - p0[1], L = Math.hypot(dx, dz) || 1;
    for (const sz of BODY_SAMPLES) {
      if (blockers.resolveCircle(tour.points[i][0] + (dx / L) * sz,
        tour.points[i][1] + (dz / L) * sz, BODY_RADIUS)) { bodyBlockedPts++; break; }
    }
  }
  console.log(`  graph: ${JSON.stringify(graph.stats)}`);
  console.log(`  tour: ${tour.legs.length} legs joined into one path, ${pathLen.toFixed(0)} m, ${pathPts} points`);
  console.log(`    blocked for a 0.95 m circle:              ${blockedPts} (${(blockedPts / pathPts * 100).toFixed(1)}%)`);
  console.log(`    blocked for the CAR BODY along the path:  ${bodyBlockedPts} (${(bodyBlockedPts / pathPts * 100).toFixed(1)}%)`);
  follow = { state: { i: 0 } };
  v.position.set(tour.points[0][0], 0.55, tour.points[0][1]);
  const p1 = tour.points[Math.min(3, tour.points.length - 1)];
  v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 },
    Math.atan2(p1[0] - v.position.x, p1[1] - v.position.z));
}

while (lap < CIRCUITS && steps < CAP_STEPS) {
  let target;
  if (MODE === 'roads') {
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    const f = followPath(tour.points, { x: v.position.x, z: v.position.z, yaw, speed: v.speed },
      follow.state, { maxSpeed: MAX_SPEED });
    if (f.done) { follow.state = { i: 0 }; lap++; steps++; continue; }
    v.setControls(f.controls);
    target = { x: f.aim[0], z: f.aim[1] };
    // How far off the line is it? The single most useful number about a follower, and it
    // is what distinguishes "it clipped a kerb" from "it lost the path completely".
    if (steps % 30 === 0) {
      let off = Infinity;
      for (let k = Math.max(0, f.i - 40); k < Math.min(tour.points.length, f.i + 40); k++) {
        off = Math.min(off, Math.hypot(tour.points[k][0] - v.position.x, tour.points[k][1] - v.position.z));
      }
      if (off > worstOffPath) worstOffPath = off;
    }
  } else {
    target = route[wp];
    const dx = target.x - v.position.x, dz = target.z - v.position.z;
    if (Math.hypot(dx, dz) < 26) {
      wp++;
      if (wp >= route.length) { wp = 1; lap++; }
      steps++;
      continue;
    }
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    let err = Math.atan2(dx, dz) - yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    v.setControls({ throttle: Math.abs(err) > 0.9 ? 0.32 : Math.abs(err) > 0.45 ? 0.55 : 1,
      brake: 0, steer: Math.max(-1, Math.min(1, err * 1.6)), handbrake: false });
  }
  v.stepFixed(DT, ground, HZ);
  damage.update(DT);
  if (v.speed < 0.6) {
    stuckFor += DT;
    if (stuckFor > 2.5) {
      nudges++;
      nudgeAt.push({ t: +(steps * DT).toFixed(1), wp: MODE === 'roads' ? follow.state.i : wp, lap,
        from: [+v.position.x.toFixed(1), +v.position.z.toFixed(1)],
        to: [+target.x.toFixed(1), +target.z.toFixed(1)],
        wrecked: damage.wrecked,
        inside: blockers.insideAny(v.position.x, v.position.z) >= 0 });
      v.position.set(target.x, 0.55, target.z);
      v.velocity.set(0, 0, 0);
      stuckFor = 0;
    }
  } else stuckFor = 0;
  if (steps % 120 === 0) {
    path.push([+v.position.x.toFixed(1), +v.position.z.toFixed(1)]);
    const r = blockers.resolveCircle(v.position.x, v.position.z, BODY_RADIUS);
    if (r && r.depth > worstOff) { worstOff = r.depth; offAt = [+v.position.x.toFixed(1), +v.position.z.toFixed(1)]; }
  }
  steps++;
}

const simSeconds = steps * DT;
const rep = damage.report();
console.log(`\ncompleted ${lap}/${CIRCUITS} circuits in ${simSeconds.toFixed(1)} s of simulated time`);
console.log(`  body contacts        ${v.contacts}`);
console.log(`  damage taken         ${(1 - rep.health).toFixed(4)}  (health ${rep.health}, wrecked ${rep.wrecked})`);
console.log(`  impacts applied      ${rep.stats.applied}  refracted ${rep.stats.refracted}  below threshold ${rep.stats.rejected}`);
console.log(`  worst charged dv     ${rep.stats.worstDv} m/s`);
console.log(`  stuck-nudge teleports ${nudges}${nudgeAt.some((n) => n.wrecked) ? ' (some of them hand-carrying a WRECKED car)' : ''}`);
console.log(`  worst penetration held ${worstOff.toFixed(4)} m${offAt ? ` at (${offAt})` : ''}`);
if (MODE === 'roads') console.log(`  worst distance off the line ${worstOffPath.toFixed(2)} m`);
if (nudges) {
  console.log('  nudges:');
  for (const n of nudgeAt.slice(0, 10)) {
    console.log(`    t=${String(n.t).padStart(7)}s  lap ${n.lap} leg/wp ${n.wp}  ` +
      `from (${n.from}) -> (${n.to})  inside: ${n.inside}  wrecked: ${n.wrecked}`);
  }
  if (nudgeAt.length > 10) console.log(`    ... and ${nudgeAt.length - 10} more`);
}

/**
 * THE FOLLOWER IS FINISHED, so these are assertions now rather than recorded figures.
 *
 * It was not, two rounds ago: 1,654 contacts, 5 applied impacts, 112 stuck-nudges, 26.79 m
 * off the line, and the damage model correctly writing the car off three times a lap. The
 * figures are kept here because the shape of the improvement is the useful part:
 *
 *                       before    after
 *     circuits            2/3      3/3 in 793.5 s
 *     health             0.000    1.000
 *     applied impacts        5        0
 *     stuck-nudges         112        0
 *     body contacts      1,654      264
 *     worst off the line 26.79 m   9.79 m
 *     worst charged dv   30.93 m/s  1.425 m/s
 *
 * THE 264 CONTACTS ARE ONE CORNER, AND THEY ARE FREE. Every one of them, across all three
 * laps, is at path indices 561..563, where the course turns at 8.3 m of radius and the car's
 * own minimum at that speed is 8.9 m — 0.6 m tighter than it can physically turn. So it
 * scrapes for 0.73 s a lap at a worst charged delta-v of 1.425 m/s, which is under the 2.2 m/s
 * FMVSS threshold src/damage.js takes its free band from. It costs nothing, and no controller
 * can fix it: R_min at a standstill is 8.446 m, so a corner of 8.3 m is beyond the car at any
 * speed. Widening the line through it is a racing-line problem, not a tracking one.
 */
const EXPECT = { contacts: 300, applied: 0, nudges: 0, offLine: 12, freeDv: 2.2 };

check(`all ${CIRCUITS} circuits completed`, lap >= CIRCUITS, `${lap}/${CIRCUITS} in ${simSeconds.toFixed(0)}s`);
check('the car is never left inside a building',
  MODE === 'straight' && NO_COLLISION
    ? true      // with walls off and a straight course, being inside a building is the POINT
    : blockers.insideAny(v.position.x, v.position.z) < 0,
  `insideAny ${blockers.insideAny(v.position.x, v.position.z)}`);
if (MODE === 'straight') {
  // THE STRAIGHT ARM IS EXPECTED TO FAIL, and asserting that is the measurement. If a future
  // change makes it survive, the thing to check is whether the collision stopped working
  // rather than whether the autopilot got better.
  if (NO_COLLISION) {
    check('with walls off, the straight course drives through the city', v.contacts === 0);
  } else {
    check('with walls on, the straight course wrecks the car', damage.wrecked,
      `health ${rep.health}`);
    check('and the stuck-nudge then hand-carries it round', nudges > CIRCUITS,
      `${nudges} nudges`);
  }
} else if (!NO_COLLISION) {
  // --- the course.
  check('no point of the planned course is blocked for a car',
    blockedPts === 0, `${blockedPts}/${pathPts}`);
  check('no point of the planned course is blocked for the CAR BODY along it',
    bodyBlockedPts === 0, `${bodyBlockedPts}/${pathPts}`);
  const mr = minRadius(tour.points);
  console.log(`  tightest corner on the course: ${mr.radius.toFixed(2)} m at index ${mr.at}, ` +
    `cornerSpeed ${(cornerSpeed(mr.radius) * 3.6).toFixed(0)} km/h ` +
    `(the car's standstill minimum is ${RESPONSE.rMin0.toFixed(2)} m)`);
  check('the tightest corner is a real junction, not a resampling artefact',
    mr.radius > 5, `${mr.radius.toFixed(2)} m`);
  // Reversals and the seam. See RoadGraph.tour().
  let reversals = 0;
  for (let k = 1; k < tour.points.length - 1; k++) {
    const a = tour.points[k - 1], b = tour.points[k], c = tour.points[k + 1];
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let dd = h2 - h1;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    if (Math.abs(dd) > 2.09) reversals++;
  }
  const n = tour.points.length;
  const closure = Math.hypot(tour.points[n - 1][0] - tour.points[0][0], tour.points[n - 1][1] - tour.points[0][1]);
  const inH = Math.atan2(tour.points[n - 1][0] - tour.points[n - 2][0], tour.points[n - 1][1] - tour.points[n - 2][1]);
  const outH = Math.atan2(tour.points[1][0] - tour.points[0][0], tour.points[1][1] - tour.points[0][1]);
  let seam = outH - inH;
  while (seam > Math.PI) seam -= Math.PI * 2;
  while (seam < -Math.PI) seam += Math.PI * 2;
  console.log(`  reversals in the course: ${reversals};  closure ${closure.toFixed(3)} m;  ` +
    `heading across the seam ${(seam * 180 / Math.PI).toFixed(1)} deg`);
  check('the course never doubles back on itself', reversals === 0, `${reversals}`);
  check('the course closes exactly, so a lap ends where the next begins', closure < 1e-6,
    `${closure.toFixed(4)} m`);
  check('the seam is an ordinary corner, not a discontinuity', Math.abs(seam) < 0.5,
    `${(seam * 180 / Math.PI).toFixed(1)} deg`);
  const wg = worstGap(tour.points);
  console.log(`  worst gap between consecutive points: ${wg.gap.toFixed(2)} m at index ${wg.at}`);
  check('no gap in the course exceeds twice the spacing', wg.gap < 8, `${wg.gap.toFixed(2)} m`);
  check('the router excluded the impassable service edges',
    graph.stats.blockedEdges === 11, `${graph.stats.blockedEdges}`);

  // --- the drive.
  console.log('\n  THE DRIVE:');
  const rows = [
    ['body contacts', v.contacts, EXPECT.contacts],
    ['stuck-nudges', nudges, EXPECT.nudges],
    ['impacts applied', rep.stats.applied, EXPECT.applied],
    ['worst m off the line', +worstOffPath.toFixed(1), EXPECT.offLine],
  ];
  for (const [label, got, want] of rows) {
    console.log(`    ${label.padEnd(22)} ${String(got).padStart(6)}   budget ${String(want).padStart(5)}`);
    check(`${label} is within budget`, got <= want, `${got} against ${want}`);
  }
  console.log(`    ${'health'.padEnd(22)} ${rep.health.toFixed(4).padStart(6)}`);
  console.log(`    ${'worst charged delta-v'.padEnd(22)} ${rep.stats.worstDv.toFixed(3).padStart(6)} m/s   ` +
    `budget ${EXPECT.freeDv} (the FMVSS free band)`);
  check('the car finishes undamaged', rep.health === 1, `${rep.health}`);
  check('every contact is below the free threshold, i.e. paint',
    rep.stats.worstDv < EXPECT.freeDv, `${rep.stats.worstDv.toFixed(3)} m/s`);
  check('no nudge fired from inside a building', !nudgeAt.some((nn) => nn.inside),
    `${nudgeAt.filter((nn) => nn.inside).length}`);
  check('the collider never holds the car deeper than 5 cm', worstOff < 0.05,
    `${worstOff.toFixed(4)} m`);
  console.log(`    mean speed ${(3 * pathLen / simSeconds * 3.6).toFixed(1)} km/h over ${CIRCUITS} circuits`);
}
// Determinism, because the gate's whole argument depends on the drive being repeatable.
check('the path is finite everywhere', path.every(([x, z]) => Number.isFinite(x) && Number.isFinite(z)));
console.log(`\n  ${path.length} path samples at 1 s intervals; ` +
  `x ${Math.min(...path.map((p) => p[0])).toFixed(0)}..${Math.max(...path.map((p) => p[0])).toFixed(0)}, ` +
  `z ${Math.min(...path.map((p) => p[1])).toFixed(0)}..${Math.max(...path.map((p) => p[1])).toFixed(0)}`);

console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nROUTE DRIVE: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nROUTE DRIVE: PASS — ${checks.length} checks`);
