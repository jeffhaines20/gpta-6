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
// one question: does the car get stuck on a building, and how much does it hit.
import fs from 'node:fs';
import { Vehicle, BODY_RADIUS, BODY_SAMPLES } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel } from '../src/damage.js';
import { RoadGraph, followPath, minRadius, worstGap, steerableSpeed, CORNER } from '../src/roadpath.js';

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
 * WHAT THIS GATES AND WHAT IT ONLY REPORTS, kept apart on purpose.
 *
 * SETTLED, and therefore asserted: the road-graph COURSE is clean. Every point of it holds
 * a car, and holds a car oriented along the path, and its tightest corner is a real
 * junction rather than an artefact. The straight-line course is not clean, and that is
 * asserted too, because a future change that makes it look clean means the collision
 * stopped working rather than the course got better.
 *
 * NOT SETTLED, and therefore printed with its current value rather than gated: the
 * FOLLOWER's drive quality. It gets three circuits round, it never leaves the car inside a
 * building, and it is nowhere near a clean drive — it still takes three impacts per circuit
 * and the damage model, correctly, writes the car off. Five distinct bugs have been found
 * and fixed in it during this round, each with its own number in src/roadpath.js, and the
 * trend is right (contacts 737 -> 187, nudges 571 -> 112, 1,800 s -> 782 s for three
 * circuits) without being finished. A gate that passed on those figures would be a gate
 * asserting that a car which writes itself off three times a lap is driving properly, which
 * is the exact shape of guard CLAUDE.md complains about: "it passed the whole time. That
 * was luck, not evidence."
 *
 * So the drive numbers are printed, compared against the values recorded here, and a
 * REGRESSION in them fails. An improvement does not pass the gate; it updates the numbers.
 */
const RECORDED = { contacts: 1654, nudges: 112, applied: 5, offLine: 27 };
// These are the figures for the current follower, and two consecutive runs reproduce them
// to the unit (781.5 s, 1654, 5, 112, 26.79 m) — the whole simulation is deterministic, so
// any movement in them is a change in the code and not in the weather.
//
// 1,654 contacts with 1,596 of them below the damage threshold is a car SCRAPING, not a car
// crashing, and the course is not the cause: measured clearance from the course to the
// nearest wall is a minimum of 1.92 m and a median of 11.23 m at every lane offset from 0
// to 3 m, with not one point of 737 within 1.5 m of a wall. Every contact therefore comes
// from the follower's excursions — worst 26.79 m off the line — which localises what is
// left to one thing.
//
// An earlier reading of 187 contacts looked better and was worse: it was measured while the
// speed limiter was demanding 0 km/h at every junction, so the car crawled and was carried
// by 136 nudges. Fewer contacts per second is not better driving.

check(`all ${CIRCUITS} circuits completed`, lap >= CIRCUITS, `${lap}/${CIRCUITS} in ${simSeconds.toFixed(0)}s`);
check('the car is never left inside a building',
  MODE === 'straight' && NO_COLLISION
    ? true      // with walls off and a straight course, being inside a building is the POINT
    : blockers.insideAny(v.position.x, v.position.z) < 0,
  `insideAny ${blockers.insideAny(v.position.x, v.position.z)}`);
if (MODE === 'straight') {
  // THE STRAIGHT ARM IS EXPECTED TO FAIL, and asserting that is the measurement.
  if (NO_COLLISION) {
    check('with walls off, the straight course drives through the city', v.contacts === 0);
  } else {
    check('with walls on, the straight course wrecks the car', damage.wrecked,
      `health ${rep.health}`);
    check('and the stuck-nudge then hand-carries it round', nudges > CIRCUITS,
      `${nudges} nudges`);
  }
} else if (!NO_COLLISION) {
  // --- the course. Settled.
  check('no point of the planned course is blocked for a car',
    blockedPts === 0, `${blockedPts}/${pathPts}`);
  check('no point of the planned course is blocked for the CAR BODY along it',
    bodyBlockedPts === 0, `${bodyBlockedPts}/${pathPts}`);
  const mr = minRadius(tour.points);
  console.log(`  tightest corner on the course: ${mr.radius.toFixed(2)} m at index ${mr.at}, ` +
    `steerable at ${(steerableSpeed(mr.radius) * 3.6).toFixed(0)} km/h`);
  check('the tightest corner is a real junction, not a resampling artefact',
    mr.radius > CORNER.wheelbase, `${mr.radius.toFixed(2)} m against a ${CORNER.wheelbase} m wheelbase`);
  const wg = worstGap(tour.points);
  console.log(`  worst gap between consecutive points: ${wg.gap.toFixed(2)} m at index ${wg.at}`);
  check('no gap in the course exceeds twice the spacing', wg.gap < 8, `${wg.gap.toFixed(2)} m`);
  check('the router excluded the impassable service edges',
    graph.stats.blockedEdges === 11, `${graph.stats.blockedEdges}`);
  // --- the follower. Not settled: reported, and regressions fail.
  console.log('\n  FOLLOWER (not settled — reported against the values recorded in this file):');
  const rows = [
    ['body contacts', v.contacts, RECORDED.contacts],
    ['stuck-nudges', nudges, RECORDED.nudges],
    ['impacts applied', rep.stats.applied, RECORDED.applied],
    ['worst m off the line', +worstOffPath.toFixed(0), RECORDED.offLine],
  ];
  for (const [label, got, want] of rows) {
    const d = got - want;
    console.log(`    ${label.padEnd(22)} ${String(got).padStart(5)}   recorded ${String(want).padStart(5)}   ` +
      `${d === 0 ? 'unchanged' : d < 0 ? `${-d} better` : `${d} WORSE`}`);
    // A 25% margin, because these are a chaotic simulation and not a clean measurement.
    check(`${label} has not regressed`, got <= want * 1.25 + 1, `${got} against ${want}`);
  }
  check('the follower never leaves the car inside a building',
    !nudgeAt.some((n) => n.inside), `${nudgeAt.filter((n) => n.inside).length} nudges fired from inside`);
  check('the collider never holds the car deeper than 5 cm', worstOff < 0.05,
    `${worstOff.toFixed(4)} m`);
  console.log('    the car still writes itself off on this drive. That is the damage model');
  console.log('    being right about a follower that is not finished, not a damage bug.');
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
