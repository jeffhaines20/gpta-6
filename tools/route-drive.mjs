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
// ON THE RIGHT SIDE OF THE ROAD (#127), which is where it should always have been: three
// circuits in 745.9 s at a mean of 47.2 km/h, health 1.000, 0 applied impacts, 0 stuck-nudges,
// 5.06 m off the line at worst, and 88 body contacts with the worst charged at 1.987 m/s. The
// figures above were measured with every lane on the driver's LEFT. Getting here took two fixes
// on top of the side: the lane fit's clearance from the bare body radius to LANE_MARGIN_M, which
// went from 1.2 to 1.5, and the circuits driven as one polyline (both are written up where they
// are made).
//
// AND WITH ITS CORNERS ROUNDED TO THE CAR'S TURNING CIRCLE (#61), driven with the page's parked cars
// solid for the first time: three circuits in 1014.9 s at a mean of 34.2 km/h, health 1.000, no body
// contact of any kind — walls, furniture or parked cars — 2.49 m off the line at worst, and the
// headroom lap at 26 m/s contact-free in 982 s. The same drive on the course as it shipped before
// #61, parked cars and all, is 1191.2 s, 1,929 contact steps and 6 stuck-nudges: the budget gate's
// two parked-car stops at 635 and 654, reproduced offline, which this file could not see while it
// had no parked cars. (Before #61 and without them it read 1012.3 s, 34.8 km/h, 4.35 m off the line
// and 0 contacts — the number that was not wrong, only blind.)
//
// It took nine distinct bugs to get there, four in the course and five in the controller, and
// each one is written up where it was fixed. CLAUDE.md collects them: they all have the same
// shape, which is that the instrument reads nominal because it is computed from the same
// wrong quantity the controller is acting on.
import fs from 'node:fs';
import { Vehicle, BODY_RADIUS, BODY_SAMPLES } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex, CarBlockers } from '../src/blockers.js';
import * as THREE from '../vendor/three.module.min.js';
import { StreetFurniture, LAMP_POOL } from '../src/streetfurniture.js';
import { DamageModel } from '../src/damage.js';
import { RoadGraph, followPath, minRadius, worstGap, cornerSpeed, RESPONSE } from '../src/roadpath.js';

/**
 * The right-hand lane offset. A path down the centreline of a 14 m carriageway is a path
 * down the middle of the oncoming traffic, so the course is shifted 3 m right — which is
 * also what makes the drive's own contacts meaningful, since a car on the correct side of
 * the road is 3 m nearer the kerb and the buildings behind it.
 */
const LANE_OFFSET = 3;

/**
 * 22 m/s is 79 km/h: a downtown grid with junctions every 80 m. See followPath.
 *
 * AND ON THE RIGHT SIDE OF THE ROAD IT HELD WITH 0.5 m/s TO SPARE (#127, #128) — a record of the
 * follower before #128 re-measured its look-ahead; it is contact-free from 22 to 28 m/s now and the
 * headroom is checked after the drive. The worst charged contact against the speed, then, with
 * the circuits joined and LANE_MARGIN_M at 1.5:
 *
 *     m/s      18     20     21     21.5   22     22.5   23
 *     dv     0.85   0.81   1.52   1.82   1.99   2.34   3.03     the free band ends at 2.2
 *
 * Everything from 21 up is ONE site — the 30-degree bend at course index 66-72 into the 2.8 m
 * service alley, taken 2.9 m wide at 20 m/s, so the car crosses its line and scrapes the far side
 * at index 75-76. The crawl corner at 561-563 — 8.52 m on this side, against the 9.07 m the car
 * needs at its 2.2 m/s crawl — reads 0.68-0.81 at every speed, free by construction. The drive
 * is deterministic, so this cannot flake; it can be TIPPED, by any change that moves the
 * follower's line through that bend by a few tens of centimetres.
 */
const MAX_SPEED = Number(process.env.RD_MAX_SPEED ?? 22);

const NO_COLLISION = process.argv.includes('--no-collision');
const CIRCUITS = Number(process.env.RD_CIRCUITS ?? 3);
const HZ = 120, DT = 1 / HZ;
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const route = district.meta.route;
const blockers = new BlockerIndex(district);
/**
 * AND THE STREET FURNITURE THE PAGE STANDS, SOLID AS IT IS THERE (#126, #132). The page's car hits
 * every lamp, mast, bollard, hydrant, utility pole and tree trunk, so a drive that does not is a
 * drive of a different city — this file's own "a gate that constructs the subject itself has to
 * construct it the way the game does". It is built by the module's own placement, lamps included,
 * and it found the defect it is here for on its first run: a signal mast standing 3.0 m in front
 * of a corner kerb, hit on every lap at 5.6 m/s, health 1.000 -> 0.572 over three circuits.
 */
const furniture = new StreetFurniture(new THREE.Scene(), { max: LAMP_POOL });
furniture.placeStreetLamps(district);
furniture.commit();
furniture.dressDistrict(district, { audit: false });
const carBlockers = new CarBlockers(blockers);
carBlockers.setStatic(furniture.rigidSolids());
/**
 * AND THE PARKED CARS, SOLID AS THE PAGE HAS THEM (#126, #61). This drive had no parked cars, and
 * that is the whole reason it could not see what stopped the budget gate's drive twice in both of
 * #128's runs: the car crawling 3.6-3.8 m wide of a right turn into a parked car on the far side, at
 * course indices 635 and 654. Wired the way district/main.js wires it — the module's own 30-car
 * pool, re-seeded around the car, `setBoxes` on a new fill and `settle` otherwise — except that the
 * re-seed is FORCED on the page's own 20 m distance trigger, because `refreshParked`'s other trigger
 * is 110 ms of wall clock, and a drive that runs a lap in seconds would otherwise re-seed according
 * to how fast the box felt. With it, the shipped course of the round before #61 reproduced the gate's
 * ledger site for site — parked contacts at 339, 367, 634-635 and 654, worst 2.04, all free — where
 * without it this drive read 0 contacts over the same three laps.
 */
furniture.buildParkedCars({ count: 30 });
function parkedAround(car) {
  const body = () => {
    const q = car.quaternion, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
    return BODY_SAMPLES.map((sz) => [car.position.x + fx * sz, car.position.z + fz * sz]);
  };
  let at = null, serial = -1;
  return () => {
    if (!at || Math.hypot(car.position.x - at[0], car.position.z - at[1]) >= 20) {
      furniture.refreshParked(car.position.x, car.position.z, true);
      at = [car.position.x, car.position.z];
    }
    const ps = furniture.parkedSolids();
    if (ps.serial !== serial) { serial = ps.serial; carBlockers.setBoxes(ps.boxes, body(), BODY_RADIUS); }
    else carBlockers.settle(body(), BODY_RADIUS);
  };
}

console.log(`ROUTE DRIVE${NO_COLLISION ? ' (walls OFF)' : ''}`);
console.log('='.repeat(78));
console.log(`route: ${route.length} waypoints, ${CIRCUITS} circuits, ${HZ} Hz fixed step`);

const v = new Vehicle();
const damage = new DamageModel();
// Every impact record, with its time, for the crash-voice rate reported below.
const voiceRows = [];
let voiceRate = { perMin: 0, burst: 0 };
{
  const real = damage.impact.bind(damage);
  damage.impact = (ev) => {
    const r = real(ev);
    voiceRows.push({ t: steps * DT, dv: r.dv || 0 });
    return r;
  };
}
if (!NO_COLLISION) { v.blockers = carBlockers; v.damage = damage; }
const parkMain = parkedAround(v);
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
/**
 * How often the follower had to reverse out of an unreachable aim point. On THIS course it
 * should be nearly never: the car is pointed along the path before the first step and the tour
 * has no reversals in it. The count is printed so that a change to the manoeuvre cannot quietly
 * alter what this gate measures — which is the whole reason it is here rather than in a comment.
 */
let reverseFrames = 0;
const CAP_STEPS = HZ * 60 * 30;         // 30 minutes of simulated time

// ONE CONTINUOUS PATH, not eight. See RoadGraph.tour(): following the legs
// independently makes every leg boundary a blind corner, and that was the entire cause
// of the three impacts this file spent an afternoon attributing to speed.
let graph = null, tour = null, follow = null, course = null, lapPts = 0;
if (MODE === 'roads') {
  graph = new RoadGraph(district, { blockers, carRadius: BODY_RADIUS });
  tour = graph.tour(route.slice(1), { spacing: 4, offset: LANE_OFFSET });
  /**
   * AND THE CIRCUITS ARE ONE POLYLINE TOO, for the same reason the legs are. This loop used to
   * hand followPath the ring and reset its state at `done`, and `pathSpeedLimit` scans forward
   * to the END OF THE ARRAY: so the last 25-plus metres of every lap were driven blind to the
   * corner beyond the seam, which is a junction turning 64 degrees. The car reached it at full
   * speed on every lap but the first, which starts from rest. It was latent for as long as the
   * lane sat on the driver's left (#127), where that corner is taken on its outside; on the
   * right it is taken on its inside and the car hit the kerb-side building at 22, 18 and 16 m/s
   * alike, on lap 2 every time. The ring repeats its first point as its last, so each later lap
   * joins without it. A lap is complete when the follower's index passes a multiple of the
   * ring's own length.
   */
  lapPts = tour.points.length - 1;
  course = tour.points.slice();
  for (let k = 1; k < CIRCUITS; k++) course = course.concat(tour.points.slice(1));
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
    // `dt` arms followPath's progress anchor; without it the stuck detector is inert.
    const f = followPath(course, { x: v.position.x, z: v.position.z, yaw, speed: v.speed },
      follow.state, { maxSpeed: MAX_SPEED, dt: DT });
    if (f.done) { lap = CIRCUITS; steps++; continue; }
    lap = Math.min(CIRCUITS - 1, Math.floor(f.i / lapPts));
    if (f.reversing) reverseFrames++;
    v.setControls(f.controls);
    target = { x: f.aim[0], z: f.aim[1] };
    // How far off the line is it? The single most useful number about a follower, and it
    // is what distinguishes "it clipped a kerb" from "it lost the path completely".
    if (steps % 30 === 0) {
      let off = Infinity;
      for (let k = Math.max(0, f.i - 40); k < Math.min(course.length, f.i + 40); k++) {
        off = Math.min(off, Math.hypot(course[k][0] - v.position.x, course[k][1] - v.position.z));
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
  if (!NO_COLLISION) parkMain();
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
      // Put, not driven, so whatever it lands on is not a collision — district/main.js's placeAt.
      if (!NO_COLLISION) {
        const q = v.quaternion, fx = 2 * (q.x * q.z + q.w * q.y), fz = 1 - 2 * (q.x * q.x + q.y * q.y);
        carBlockers.release(BODY_SAMPLES.map((sz) => [v.position.x + fx * sz, v.position.z + fz * sz]), BODY_RADIUS);
      }
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
/**
 * AND HOW OFTEN THE CRASH VOICE WOULD FIRE, because district/main.js plays a sound for every
 * impact record and the question "does that machine-gun" is answerable here for free. The
 * drive already produces every record; audio.js refuses anything under 0.6 m/s.
 */
{
  const over = voiceRows.filter((r) => r.dv >= 0.6);
  let worst = 0;
  for (let i = 0; i < over.length; i++) {
    let n = 0;
    for (let j = i; j < over.length && over[j].t - over[i].t < 1; j++) n++;
    worst = Math.max(worst, n);
  }
  const mins = (steps * DT) / 60;
  console.log(`  crash voices         ${over.length} of ${voiceRows.length} records clear ` +
    `audio.js's 0.6 m/s floor — ${(over.length / mins).toFixed(1)} a minute, worst ${worst} in any second`);
  // Measured 0.9 a minute over three circuits, worst 3 in any one second at the single
  // 8.3 m corner the car needs 8.9 m for. Six is a bound with room, not a target.
  voiceRate = { perMin: over.length / mins, burst: worst };
}
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
/*
 * RESTATED BY #128. Both paragraphs below this one are records of a follower whose look-ahead was
 * `clamp(6 + 0.9 v, 8, 28)` and whose crawl floor was 2.2 m/s. With the look-ahead re-measured and
 * the floor derived (src/roadpath.js CRAWL_MS), the drive makes NO body contact at all — not at the
 * alley entry, and not at the 8.52 m corner either, which the first paragraph says no controller can
 * fix: it was the look-ahead cutting it, not the corner being beyond the car. Mean speed 47.2 ->
 * 39.4 km/h from the look-ahead and 34.8 with the lower floor, which is what a line the walls allow
 * costs. The budgets below are kept, and the
 * headroom that #128 was about is now a check of its own after the drive.
 */
/*
 * RESTATED BY #127. The paragraph above is a record of the LEFT side of the road, where every lane
 * sat until rightOf was fixed. On the right the 88 contacts are TWO sites, and the corner is the
 * cheaper of them:
 *
 *     path index   contacts   worst dv    what it is
 *     561-563          64       0.812     the same corner, 8.52 m on this side, crawled, free
 *     75-76            24       1.987     the alley entry at 20 m/s — see MAX_SPEED and #128
 *
 * The budgets below did not move. The contact budget is 300 against 88, and the free band is
 * 2.2 against 1.987, which is the one that is close and is said so beside MAX_SPEED.
 */
/*
 * RESTATED BY #61, which rounds the course's corners and gives this drive the parked cars. The
 * drive makes no body contact at all now — 0 against the 300 below — so the contact budget has
 * nothing to bound on the shipped course; it is kept because the course as it shipped before #61
 * reads 1,929 against it with the parked cars in (and 6 nudges against 0), so it still fails the
 * build it exists to fail. The parked-car count is the sharper check and has its own line above.
 */
const EXPECT = { contacts: 300, applied: 0, nudges: 0, offLine: 12, freeDv: 2.2,
  voicesPerMin: 6, voiceBurst: 6 };

check('the crash voice does not machine-gun', voiceRate.perMin <= EXPECT.voicesPerMin,
  `${voiceRate.perMin.toFixed(2)} a minute`);
check('and the worst second holds no more than a crash-worth',
  voiceRate.burst <= EXPECT.voiceBurst, `${voiceRate.burst}`);
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
  let reversals = 0, worstTurn = 0, worstTurnAt = -1;
  for (let k = 1; k < tour.points.length - 1; k++) {
    const a = tour.points[k - 1], b = tour.points[k], c = tour.points[k + 1];
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let dd = h2 - h1;
    while (dd > Math.PI) dd -= Math.PI * 2;
    while (dd < -Math.PI) dd += Math.PI * 2;
    if (Math.abs(dd) > 2.09) reversals++;
    if (Math.abs(dd) > worstTurn) { worstTurn = Math.abs(dd); worstTurnAt = k; }
  }
  const n = tour.points.length;
  const closure = Math.hypot(tour.points[n - 1][0] - tour.points[0][0], tour.points[n - 1][1] - tour.points[0][1]);
  const inH = Math.atan2(tour.points[n - 1][0] - tour.points[n - 2][0], tour.points[n - 1][1] - tour.points[n - 2][1]);
  const outH = Math.atan2(tour.points[1][0] - tour.points[0][0], tour.points[1][1] - tour.points[0][1]);
  let seam = outH - inH;
  while (seam > Math.PI) seam -= Math.PI * 2;
  while (seam < -Math.PI) seam += Math.PI * 2;
  console.log(`  frames the follower spent reversing: ${reverseFrames} of ${steps} ` +
    `(${(reverseFrames / Math.max(1, steps) * 100).toFixed(2)}%)`);
  check('the follower almost never has to reverse on this course',
    reverseFrames / Math.max(1, steps) < 0.01,
    `${reverseFrames} of ${steps} frames`);
  console.log(`  reversals in the course: ${reversals};  closure ${closure.toFixed(3)} m;  ` +
    `heading across the seam ${(seam * 180 / Math.PI).toFixed(1)} deg, ` +
    `worst turn elsewhere ${(worstTurn * 180 / Math.PI).toFixed(1)} deg at index ${worstTurnAt}`);
  check('the course never doubles back on itself', reversals === 0, `${reversals}`);
  check('the course closes exactly, so a lap ends where the next begins', closure < 1e-6,
    `${closure.toFixed(4)} m`);
  /**
   * THE SEAM IS COMPARED WITH THE COURSE'S OWN CORNERS, AND THE THRESHOLD IT REPLACES WAS
   * PASSING ON A COINCIDENCE. This read `Math.abs(seam) < 0.5` — 28.6 degrees — and the tour
   * closes ON A JUNCTION, where the road itself turns about 70 degrees. Measured across offsets,
   * on the tree where the check was green:
   *
   *     offset 0   67.4 deg      offset 2   53.6      offset 6   -67.5
   *     offset 1   67.9          offset 3   14.0  <- the only value this gate runs at
   *
   * So the assertion held at the one offset in use and would have failed at every other, on
   * geometry nobody was worried about. The swing came from `offsetRight` taking a ONE-SIDED
   * tangent at a ring's first and last point, which is now fixed, and with that fixed the seam
   * reads the junction's own turn (70.2 deg) at every offset from 2 m up.
   *
   * What the check is FOR is CLAUDE.md's "a ring's seam is the one corner nothing smooths": the
   * failure it must catch is a 91-degree turn from a standstill where the road is straight, not
   * a junction that happens to be where the lap closes. So the seam's turn is required to be no
   * worse than the worst turn ELSEWHERE on the same course — a comparison within one frame of
   * reference, which is the form that survives a change of offset — and separately not to be a
   * reversal by the same 2.09 rad test the reversal count uses.
   */
  check('the seam turns no harder than the worst corner elsewhere on the course',
    Math.abs(seam) <= worstTurn + 1e-9,
    `${(seam * 180 / Math.PI).toFixed(1)} deg against ${(worstTurn * 180 / Math.PI).toFixed(1)}`);
  check('and the seam is not a reversal', Math.abs(seam) < 2.09,
    `${(seam * 180 / Math.PI).toFixed(1)} deg`);
  const wg = worstGap(tour.points);
  console.log(`  worst gap between consecutive points: ${wg.gap.toFixed(2)} m at index ${wg.at}`);
  check('no gap in the course exceeds twice the spacing', wg.gap < 8, `${wg.gap.toFixed(2)} m`);
  check('the router excluded the impassable service edges',
    graph.stats.blockedEdges === 11, `${graph.stats.blockedEdges}`);
  // #132: the follower keeps to the road, so it touches none of what stands beside it. Asserted
  // as a count of contacts rather than as health, because a 1 m/s brush with a bollard is free
  // and would pass a health check while being exactly the defect.
  check('the street furniture is solid, and the drive touches none of it',
    carBlockers.stats.statics > 2000 && carBlockers.stats.staticContacts === 0,
    `${carBlockers.stats.staticContacts} contact steps against ${carBlockers.stats.statics} solids`);
  /**
   * #61: AND THE PARKED CARS, the same way and for the same reason. Before #61 rounded the corners
   * this read 188 contact steps on one lap at the gate's own two sites — all free, so no health or
   * charge check above could see them, and the gate's drive stopped dead on both. A count, then,
   * as the furniture's is. `refills` says the pool really moved with the car, so a pool that never
   * filled cannot pass this for the most flattering reason.
   */
  check('the parked cars are solid, the pool follows the car, and the drive touches none of them (#61)',
    carBlockers.stats.refills > 20 && carBlockers.stats.boxes > 0 && carBlockers.stats.contacts === 0,
    `${carBlockers.stats.contacts} contact steps, ${carBlockers.stats.refills} refills, ${carBlockers.stats.boxes} boxes in the last`);

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
  console.log(`    mean speed ${(CIRCUITS * pathLen / simSeconds * 3.6).toFixed(1)} km/h over ${CIRCUITS} circuits`);

  /**
   * THE HEADROOM, GATED (#128). This drive held its cap by 0.5 m/s: one alley entry at 20 m/s, and
   * every budget above passed with the car scraping 88 times at a worst charged 1.987 against 2.2.
   * A follower change that moved its line through that bend by a few tens of centimetres would have
   * tipped it, and none of the budgets would have said which way the margin was going — they were
   * written around the scrapes. So the margin is a check of its own: the same course again, with
   * the cap 4 m/s higher, must still be taken with the car undamaged. The old look-ahead charged
   * 3 impacts at 24 m/s and failed this at 22.5; the shipped one is contact-free from 22 to 28.
   * Run last, on its own car and damage model, so nothing above reads a counter it moved.
   */
  const HEAD = 4;
  const hv = new Vehicle(), hd = new DamageModel();
  // Its own pool around its own car: the main drive's last fill is wherever that drive ended.
  const parkHead = parkedAround(hv);
  const headParked0 = carBlockers.stats.contacts;
  hv.blockers = carBlockers; hv.damage = hd;
  hv.position.set(course[0][0], 0.55, course[0][1]);
  const h1 = course[Math.min(3, course.length - 1)];
  hv.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(h1[0] - hv.position.x, h1[1] - hv.position.z));
  const hs = { i: 0 };
  let hSteps = 0, hDone = false;
  for (; hSteps < CAP_STEPS; hSteps++) {
    const q = hv.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    const f = followPath(course, { x: hv.position.x, z: hv.position.z, yaw, speed: hv.speed }, hs,
      { maxSpeed: MAX_SPEED + HEAD, dt: DT });
    if (f.done) { hDone = true; break; }
    hv.setControls(f.controls);
    parkHead();
    hv.stepFixed(DT, ground, HZ);
    hd.update(DT);
  }
  const hr = hd.report();
  console.log(`    at ${MAX_SPEED + HEAD} m/s, ${HEAD} over the cap: ${hDone ? 'finished' : 'DID NOT FINISH'} in ` +
    `${(hSteps * DT).toFixed(0)} s, ${hv.contacts} body contacts (${carBlockers.stats.contacts - headParked0} of them ` +
    `parked cars), worst charged ${hr.stats.worstDv.toFixed(3)} m/s, health ${hr.health.toFixed(4)}`);
  check(`and with ${HEAD} m/s of headroom over the cap the course is still taken undamaged (#128)`,
    hDone && hr.health === 1 && hr.stats.applied === 0 && hr.stats.worstDv < EXPECT.freeDv,
    `${hv.contacts} contacts, ${hr.stats.applied} applied, worst ${hr.stats.worstDv.toFixed(3)} at ${MAX_SPEED + HEAD} m/s`);
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
