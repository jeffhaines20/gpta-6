// Deterministic gate for road-graph routing and path following.
//
//   node tools/roadpath-test.mjs
//
// tools/route-drive.mjs drives the real district and is the integration measurement. This
// file is the unit gate, and half of it is KNOWN-BAD INPUT: every bug this round found in
// src/roadpath.js gets a synthetic case that reproduces it, because all five were invisible
// from the outside. Each one produced a controller reporting everything nominal:
//
//   §2  a 75 m gap in the path, aimed at by an arc-length look-ahead, gives a heading error
//       of 0.00 while the car drives across a city block
//   §3  a radial look-ahead selects a point BEHIND the car once the car is far enough from it
//   §4  a three-point curvature window lands on a short segment left by resampling and
//       reports a 0.45 m corner that is not there — which is ACTIONABLE, so the limiter
//       demanded 0 km/h at every junction
//   §5  grip alone is not the corner ceiling; the car's steering authority falls with speed
//   §6  a lane offset wider than the road puts the course inside the buildings
import fs from 'node:fs';
import { RoadGraph, followPath, pathSpeedLimit, steerableSpeed, gripSpeed, cornerSpeed,
  minTurnRadius, steerForRadius, RESPONSE,
  resample, smooth, minRadius, worstGap, offsetRight, pathCurvature, ARC_WINDOW,
  laneOffsetFor, laneOffsets, ROUTE_LANE_M, rightOf, CRAWL_MS, SPEED_DEADBAND, CRAWL_OVERRUN } from '../src/roadpath.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel, HALF_EXTENT } from '../src/damage.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const blockers = new BlockerIndex(district);

console.log('ROADPATH GATE');
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// §1  The graph is the one traffic.js walks, and it refuses the impassable edges.
// ---------------------------------------------------------------------------
console.log('\n§1  The graph');
const plain = new RoadGraph(district);
const g = new RoadGraph(district, { blockers, carRadius: 0.95 });
console.log(`    without the wall index: ${JSON.stringify(plain.stats)}`);
console.log(`    with it:                ${JSON.stringify(g.stats)}`);
check('the graph has nodes and directed links', g.stats.vertices > 500 && g.stats.directed > 1000);
check('11 edges are refused as impassable', g.stats.blockedEdges === 11, `${g.stats.blockedEdges}`);
check('that is 317 m of a 935-edge network', g.stats.blockedMetres === 317, `${g.stats.blockedMetres}`);
check('the wall index only ever REMOVES links', g.stats.directed < plain.stats.directed);

/**
 * AND `isolated` MEANS ENDPOINTS, NOT VERTICES. It used to be
 * `district.verts.length - out.size`, which reported 1,496 where the truth is 13, because the
 * adjacency keys on edge ENDPOINTS and 1,483 of this district's 2,159 vertices are interior
 * points of a road's polyline that can never appear in it. A round reading that number would
 * conclude the network is 69% disconnected when 98.5% of it is one component. The two checks
 * below pin the definition rather than the figure: isolated is a shortfall against ENDPOINTS,
 * and it can never exceed them.
 */
check('isolated counts edge endpoints, not polyline vertices',
  g.stats.isolated === g.stats.endpoints - g.stats.vertices,
  `${g.stats.endpoints} endpoints - ${g.stats.vertices} in graph = ${g.stats.isolated}`);
check('...so it is a small fraction, not most of the district',
  g.stats.isolated >= 0 && g.stats.isolated < g.stats.endpoints * 0.1,
  `${g.stats.isolated} of ${g.stats.endpoints} endpoints` +
  ` (${(100 * g.stats.isolated / g.stats.endpoints).toFixed(1)}%)`);
/**
 * A ROUTER WHOSE NETWORK IS IN PIECES CANNOT TAKE A PLAYER ANYWHERE, and vertex count cannot
 * see that: a graph of 663 vertices in 663 components has the same `vertices` as this one.
 * Forward reachability over the same directed adjacency `route` walks, so one-way streets count
 * the way the router counts them. Blocking 11 edges strands 13 endpoints and 10 more vertices
 * into 12 fringe pieces; the rest is one network.
 */
check('the drivable network is essentially one piece',
  g.stats.largestComponent >= g.stats.vertices * 0.95,
  `${g.stats.largestComponent} of ${g.stats.vertices}` +
  ` (${(100 * g.stats.largestComponent / g.stats.vertices).toFixed(1)}%)`);
check('and blocking edges is what costs the rest, so the control is not vacuous',
  plain.stats.largestComponent > g.stats.largestComponent,
  `${plain.stats.largestComponent} unblocked against ${g.stats.largestComponent} blocked`);
// Every refused edge is a service alley, which is the claim the source makes.
const classes = [...g.blocked].map((i) => district.edges[i].c);
console.log(`    refused edge classes: ${JSON.stringify([...new Set(classes)])}`);
check('every refused edge is class "service"', classes.every((c) => c === 'service'),
  JSON.stringify([...new Set(classes)]));
// One-way is honoured the way traffic.js honours it.
let oneWayOk = true;
district.edges.forEach((e, i) => {
  if (g.blocked.has(i)) return;
  const a = e.v[0], b = e.v[e.v.length - 1];
  const fwd = (g.out.get(a) ?? []).some((l) => l.e === i && l.forward);
  const rev = (g.out.get(b) ?? []).some((l) => l.e === i && !l.forward);
  if (e.o > 0 && rev) oneWayOk = false;
  if (e.o < 0 && fwd) oneWayOk = false;
  if (e.o === 0 && !(fwd && rev)) oneWayOk = false;
});
check('one-way edges are directed and two-way edges are not', oneWayOk);
// Unreachable has to be null, not an empty path a caller reads as "already there".
const isolated = [...g.out.keys()].find((v) => (g.out.get(v) ?? []).length === 0);
check('route() to an unreachable node returns null',
  g.route([...g.out.keys()][0], -999) === null);
check('route() to itself returns an empty path, not null',
  g.route(5, 5)?.edges.length === 0);

// ---------------------------------------------------------------------------
// §2  KNOWN-BAD: a gap in the path, and the look-ahead that drives into it.
// ---------------------------------------------------------------------------
console.log('\n§2  Known-bad: a gap in the path');
// A straight run, then a 75 m jump, then a straight run — the exact shape path() produced
// before the lead-in was walked along its own edge.
const gappy = [];
for (let x = 0; x <= 40; x += 4) gappy.push([x, 0, 0]);
gappy.push([115, 0, 0]);                       // the 75 m jump
for (let x = 119; x <= 160; x += 4) gappy.push([x, 0, 0]);
const wgBad = worstGap(gappy);
console.log(`    the bad polyline: ${gappy.length} points, worst gap ${wgBad.gap.toFixed(1)} m at index ${wgBad.at}`);
check('KNOWN-BAD: the gap is there to be found', wgBad.gap === 75);
const fixed = resample(gappy, 4);
const wgFixed = worstGap(fixed);
console.log(`    resampled at 4 m: ${fixed.length} points, worst gap ${wgFixed.gap.toFixed(3)} m`);
check('resample closes it', wgFixed.gap <= 4.001, `${wgFixed.gap}`);
// Against the SOURCE's own endpoints, not against a number typed out here: the first draft
// asserted 160 because the loop above says `x <= 160`, and a step of 4 from 119 ends at 159.
check('resample keeps the endpoints',
  near(fixed[0][0], gappy[0][0], 1e-9) &&
  near(fixed[fixed.length - 1][0], gappy[gappy.length - 1][0], 1e-9),
  `${fixed[0][0]}..${fixed[fixed.length - 1][0]} against ${gappy[0][0]}..${gappy[gappy.length - 1][0]}`);
// And the consequence, which is the part worth asserting: on the bad polyline the aim is the
// far side of the gap and the car is told everything is fine.
const carAt = { x: 40, z: 0, yaw: Math.PI / 2, speed: 22 };   // heading +x, 79 km/h
const badFollow = followPath(gappy, carAt, { i: 0 });
const goodFollow = followPath(fixed, carAt, { i: 0 });
console.log(`    at (40, 0) doing 79 km/h: bad path aims at (${badFollow.aim[0].toFixed(0)}, ${badFollow.aim[1].toFixed(0)}), ` +
  `good path aims at (${goodFollow.aim[0].toFixed(0)}, ${goodFollow.aim[1].toFixed(0)})`);
check('KNOWN-BAD: the gappy path aims past the gap', badFollow.aim[0] >= 115,
  `${badFollow.aim[0]}`);
check('the resampled path aims a look-ahead away', goodFollow.aim[0] < 115 && goodFollow.aim[0] > 40,
  `${goodFollow.aim[0]}`);
check('both report a heading error of zero — which is why this was invisible',
  near(badFollow.err, 0, 1e-9) && near(goodFollow.err, 0, 1e-9));
// The district's own course must not have one.
const tour = g.tour(district.meta.route.slice(1), { spacing: 4, offset: 3 });
const wgTour = worstGap(tour.points);
console.log(`    the district course: ${tour.points.length} points, ${tour.length.toFixed(0)} m, worst gap ${wgTour.gap.toFixed(2)} m`);
check('no gap in the district course exceeds twice the spacing', wgTour.gap < 8, `${wgTour.gap.toFixed(2)}`);

// ---------------------------------------------------------------------------
// §3  KNOWN-BAD: a radial look-ahead aims behind the car.
// ---------------------------------------------------------------------------
console.log('\n§3  Known-bad: a radial look-ahead');
// An L: east along z=0, then a right-angle turn south. The car has taken the corner and is
// now south of it, 12 m from the corner point it just passed.
const L = [];
for (let x = 0; x <= 40; x += 4) L.push([x, 0, 0]);
for (let z = -4; z >= -60; z -= 4) L.push([40, z, 0]);
// 12.2 m from the corner it just passed, with a 12.03 m look-ahead at 24 km/h. The first
// draft used -11, which is 11.2 m away — inside the look-ahead, so the radial rule looked
// further on and found a point that happened to be ahead. The bug needs the car to be
// FURTHER from the passed point than the look-ahead, which is exactly what happens as it
// drives away from a corner it cut.
const past = { x: 38, z: -12, yaw: Math.PI, speed: 6.7 };     // heading -z (south), 24 km/h
const cornerIdx = 10;                                          // [40, 0]
// The old rule: the first point whose RADIAL distance is at least the look-ahead, searched
// from the current index. Reproduced here so the defect is in the file, not in history.
const lookAhead = Math.min(28, Math.max(8, 6 + past.speed * 0.9));
let radialAim = null;
for (let k = cornerIdx; k < L.length; k++) {
  if (Math.hypot(L[k][0] - past.x, L[k][1] - past.z) >= lookAhead) { radialAim = L[k]; break; }
}
const arcFollow = followPath(L, past, { i: cornerIdx });
console.log(`    car at (38, -12) heading south at 24 km/h, look-ahead ${lookAhead.toFixed(1)} m`);
console.log(`      KNOWN-BAD radial rule aims at (${radialAim[0]}, ${radialAim[1]})`);
console.log(`      arc-length rule aims at      (${arcFollow.aim[0]}, ${arcFollow.aim[1]})`);
check('KNOWN-BAD: the radial rule aims at a point BEHIND the car', radialAim[1] > past.z,
  `z ${radialAim[1]} against the car at ${past.z}`);
check('the arc-length rule aims ahead', arcFollow.aim[1] < past.z, `z ${arcFollow.aim[1]}`);
check('and so the heading error stays small', Math.abs(arcFollow.err) < 0.4, `${arcFollow.err.toFixed(3)}`);
// Progress is monotonic: it can never go backwards, however far off the line the car is.
const st = { i: 20 };
followPath(L, { x: -100, z: 500, yaw: 0, speed: 10 }, st);
check('progress never goes backwards, even from 500 m off the line', st.i >= 20, `${st.i}`);

// ---------------------------------------------------------------------------
// §4  KNOWN-BAD: a three-point curvature window on a short segment.
// ---------------------------------------------------------------------------
console.log('\n§4  Known-bad: curvature over three points');
// A dead-straight line with one 0.4 m segment and a 1.5 rad kink at it — the artefact a
// resample join leaves.
// A 0.3 m segment that turns 90 degrees and comes straight back: arc 0.6 m over 1.57 rad is
// a radius of 0.38 m. This is the shape a resample join leaves — two points centimetres
// apart with a direction change between them — and it is on a road that is otherwise
// straight. The first draft's kink turned only a few degrees and read 88 m, which is a
// perfectly reasonable corner and reproduced nothing.
const kinked = [[0, 0, 0], [4, 0, 0], [8, 0, 0], [8.3, 0, 0], [8.3, 0.3, 0],
  [12, 0.3, 0], [16, 0.3, 0], [20, 0.3, 0]];
// The old rule, reproduced: radius from a three-point window.
let threePoint = Infinity;
for (let k = 0; k < kinked.length - 2; k++) {
  const a = kinked[k], b = kinked[k + 1], c = kinked[k + 2];
  const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
  let t = h2 - h1;
  while (t > Math.PI) t -= Math.PI * 2;
  while (t < -Math.PI) t += Math.PI * 2;
  if (Math.abs(t) < 1e-4) continue;
  const arc = Math.hypot(b[0] - a[0], b[1] - a[1]) + Math.hypot(c[0] - b[0], c[1] - b[1]);
  threePoint = Math.min(threePoint, arc / Math.abs(t));
}
const arcBased = minRadius(kinked, ARC_WINDOW);
console.log(`    a straight line with one 0.4 m segment in it:`);
console.log(`      KNOWN-BAD three-point radius: ${threePoint.toFixed(2)} m`);
console.log(`      over a ${ARC_WINDOW} m arc:            ${arcBased.radius.toFixed(1)} m`);
check('KNOWN-BAD: three points report an impossibly tight corner on a straight line',
  threePoint < RESPONSE.rMin0, `${threePoint.toFixed(2)} m`);
// 7.6 m, not 0.38: over the 12 m the window spans, that shape genuinely does turn 90
// degrees, so a radius of about 7.6 m is the right answer. The claim is that the reading is a
// plausible corner rather than an artefact — NOT that the car can hold it. 7.6 m is under the
// car's 8.45 m standstill minimum, and so is the district's own tightest junction at 6.04 m,
// which is why cornerSpeed() has a crawl floor rather than returning zero.
check('the arc window sees a plausible corner, not an artefact', arcBased.radius > 4,
  `${arcBased.radius.toFixed(1)} m`);
check('and a speed the car can creep through it at', cornerSpeed(arcBased.radius) > 1,
  `${(cornerSpeed(arcBased.radius) * 3.6).toFixed(1)} km/h`);
// And the consequence: the bad reading is ACTIONABLE.
console.log(`      a ${threePoint.toFixed(2)} m radius is steerable at ${(steerableSpeed(threePoint) * 3.6).toFixed(0)} km/h`);
check('KNOWN-BAD: which is why the limiter demanded a standstill', steerableSpeed(threePoint) === 0);
check('the district course has no such artefact',
  minRadius(tour.points).radius > 4,
  `${minRadius(tour.points).radius.toFixed(2)} m`);
console.log(`    the district course's tightest corner: ${minRadius(tour.points).radius.toFixed(2)} m, ` +
  `steerable at ${(steerableSpeed(minRadius(tour.points).radius) * 3.6).toFixed(0)} km/h`);

// ---------------------------------------------------------------------------
// §5  Two ceilings, and the one the first draft did not have.
// ---------------------------------------------------------------------------
console.log('\n§5  The cornering envelope, re-measured against src/vehicle.js');
/**
 * RESPONSE is a MEASURED model, so the gate's job is to re-measure it. A measured constant
 * that nothing re-derives is a magic number waiting for the car to change under it — and the
 * car did change under the derived version, which is how it came to be out by 1.75x.
 *
 * Steady-state: hold a steer input and a speed until the radius settles, then read the yaw
 * rate. Nothing here reads RESPONSE to decide what to do; it only compares.
 */
const ground = new FlatGround(0);
function steady(kmh, steerIn, settle = 10, hold = 3) {
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  const want = kmh / 3.6;
  const drive = () => v.setControls({ throttle: v.speed < want ? 1 : 0,
    brake: v.speed > want * 1.02 ? 0.3 : 0, steer: steerIn });
  for (let k = 0; k < 120 * settle; k++) { drive(); v.stepFixed(1 / 120, ground, 120); }
  let sw = 0, sv = 0, n = 0, minV = Infinity;
  for (let k = 0; k < 120 * hold; k++) {
    drive(); v.stepFixed(1 / 120, ground, 120);
    sw += Math.abs(v.angularVelocity.y); sv += v.speed; n++;
    if (v.speed < minV) minV = v.speed;
  }
  const w = sw / n, sp = sv / n;
  return { w, sp, R: w > 1e-4 ? sp / w : Infinity, lat: w * sp, held: minV / want };
}

// --- the linearity claim: radius x steer is constant at a given speed.
console.log('    radius x steer input, which RESPONSE claims is constant at a given speed:');
console.log('     speed   steer 0.1   steer 0.2   steer 0.4     spread    R_min(v) says');
let worstLin = 0, worstFit = 0;
for (const kmh of [20, 40, 60, 80]) {
  const cs = [0.1, 0.2, 0.4].map((si) => steady(kmh, si).R * si);
  const mean = cs.reduce((x, y) => x + y) / cs.length;
  const spread = (Math.max(...cs) - Math.min(...cs)) / mean;
  const predicted = minTurnRadius(kmh / 3.6);
  const fitErr = Math.abs(predicted - mean) / mean;
  if (spread > worstLin) worstLin = spread;
  if (fitErr > worstFit) worstFit = fitErr;
  console.log(`    ${String(kmh).padStart(4)} km/h ${cs.map((c) => c.toFixed(2).padStart(11)).join('')}   ` +
    `${(spread * 100).toFixed(1).padStart(5)}%   ${predicted.toFixed(2).padStart(6)} m  (${(fitErr * 100).toFixed(1)}% out)`);
}
check('the steady-state response is linear in steer input to 3%', worstLin < 0.03,
  `${(worstLin * 100).toFixed(1)}%`);
check('minTurnRadius() matches the measurement to 3%', worstFit < 0.03,
  `${(worstFit * 100).toFixed(1)}%`);

// --- the lateral ceiling. Find the tightest radius the car HOLDS at each speed.
console.log('\n    the sustainable envelope (tightest radius held without scrubbing speed):');
console.log('     speed   min radius   lat accel   cornerSpeed() for that radius');
let maxLat = 0, envelopeOk = true;
for (const kmh of [30, 50, 70, 80]) {
  let best = null;
  for (const si of [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.85, 1.0]) {
    const r = steady(kmh, si);
    if (r.held > 0.95) best = r;
  }
  if (!best) { envelopeOk = false; continue; }
  if (best.lat > maxLat) maxLat = best.lat;
  const allowed = cornerSpeed(best.R) * 3.6;
  console.log(`    ${String(kmh).padStart(4)} km/h   ${best.R.toFixed(1).padStart(7)} m   ` +
    `${best.lat.toFixed(2).padStart(7)} m/s2   ${allowed.toFixed(0).padStart(4)} km/h`);
  // The controller must never allow MORE than the car can hold.
  if (allowed > kmh * 1.02) envelopeOk = false;
}
console.log(`    measured lateral ceiling ${maxLat.toFixed(2)} m/s2; RESPONSE.latMax ${RESPONSE.latMax}`);
check('the envelope was found at every speed', envelopeOk);
check('RESPONSE.latMax matches the measured ceiling to 8%',
  Math.abs(maxLat - RESPONSE.latMax) / maxLat < 0.08,
  `measured ${maxLat.toFixed(2)} against ${RESPONSE.latMax}`);
check('cornerSpeed never allows more than the car can hold', envelopeOk);

// --- braking, which the speed limiter's scan distance depends on.
const bv = new Vehicle();
bv.position.set(0, 0.55, 0);
for (let k = 0; k < 120 * 30 && bv.speed < 80 / 3.6; k++) { bv.setControls({ throttle: 1, brake: 0, steer: 0 }); bv.stepFixed(1 / 120, ground, 120); }
const z0 = bv.position.z, v0 = bv.speed;
for (let k = 0; k < 120 * 30 && bv.speed > 0.05; k++) { bv.setControls({ throttle: 0, brake: 1, steer: 0 }); bv.stepFixed(1 / 120, ground, 120); }
const measuredBrake = (v0 * v0) / (2 * Math.abs(bv.position.z - z0));
console.log(`    braking from ${(v0 * 3.6).toFixed(0)} km/h: ${Math.abs(bv.position.z - z0).toFixed(1)} m, ` +
  `${measuredBrake.toFixed(2)} m/s2; RESPONSE.brake ${RESPONSE.brake}`);
check('RESPONSE.brake matches the measurement to 8%',
  Math.abs(measuredBrake - RESPONSE.brake) / measuredBrake < 0.08,
  `measured ${measuredBrake.toFixed(2)} against ${RESPONSE.brake}`);

// --- steerForRadius is the inversion, so asking for R_min gives full lock.
check('steerForRadius(v, R_min(v)) is exactly full lock',
  near(steerForRadius(13.9, minTurnRadius(13.9)), 1, 1e-12));
check('steerForRadius halves when the radius doubles',
  near(steerForRadius(13.9, 40), 2 * steerForRadius(13.9, 80), 1e-12));
check('a radius under the standstill minimum needs more than full lock',
  steerForRadius(0, RESPONSE.rMin0 - 1) > 1);

// --- the two ceilings, and which binds where.
console.log('\n    radius   grip     steering   binding');
for (const r of [9, 11, 13, 16, 20, 30, 60]) {
  console.log(`    ${String(r).padStart(5)} m  ${(gripSpeed(r) * 3.6).toFixed(0).padStart(4)} km/h  ` +
    `${(steerableSpeed(r) * 3.6).toFixed(0).padStart(5)} km/h   ${steerableSpeed(r) < gripSpeed(r) ? 'STEERING' : 'grip'}`);
}
check('steering binds at 11 m of radius', steerableSpeed(11) < gripSpeed(11));
check('grip binds at 30 m of radius', steerableSpeed(30) > gripSpeed(30));
check('a radius under the standstill minimum is not steerable at any speed',
  steerableSpeed(RESPONSE.rMin0) === 0);
let mono = true;
for (let r = 9; r < 80; r += 0.5) if (cornerSpeed(r + 0.5) < cornerSpeed(r)) mono = false;
check('cornerSpeed is monotonic in radius', mono);

// --- the limiter brakes early enough, and does not oscillate.
const tight = [];
for (let x = 0; x <= 200; x += 4) tight.push([x, 0, 0]);
for (let z = -4; z >= -80; z -= 4) tight.push([200, z, 0]);
console.log('\n    the limiter approaching a right-angle turn 200 m away:');
let prev = null, oscillations = 0;
for (let k = 0; k < 50; k += 4) {
  const lim = pathSpeedLimit(tight, k, 22, 22);
  if (prev !== null && lim > prev + 0.01) oscillations++;
  prev = lim;
}
// THE SCAN IS TAKEN FROM maxSpeed, NOT THE CURRENT SPEED, so the limit is a function of
// position alone. Feeding a different current speed must not change the answer.
const atSpeed = [4, 10, 16, 22].map((v) => pathSpeedLimit(tight, 40, v, 22));
console.log(`      at index 40, fed current speeds 4/10/16/22 m/s: ${atSpeed.map((v) => (v * 3.6).toFixed(1)).join(' / ')} km/h`);
check('the limit does not depend on the current speed — no feedback loop',
  atSpeed.every((v) => near(v, atSpeed[0], 1e-9)), atSpeed.join(', '));
check('the limit is monotonically non-increasing on the approach', oscillations === 0,
  `${oscillations} rises`);

// ---------------------------------------------------------------------------
// §5b  Four more ways a follower reports nominal while driving into a wall.
// ---------------------------------------------------------------------------
console.log('\n§5b Known-bad: the four that finishing this cost');

// (a) A WINDOWED GLOBAL CLOSEST POINT TELEPORTS where the route passes near itself.
// A path that runs out and back 0.6 m away: the nearest point in a forward window is on the
// return leg, 180 m further along, and the progress index jumps there in one step.
const nearTouch = [];
for (let x = 0; x <= 200; x += 4) nearTouch.push([x, 0, 0]);
for (let x = 200; x >= 0; x -= 4) nearTouch.push([x, 1.6, 0]);
{
  // The car 1.0 m off its own leg and therefore 0.6 m from the return leg, which is the
  // geometry the real failure had: off-line 1.17 m on the outbound, 0.63 m from the leg
  // 184 m further along. Sitting exactly ON the line does not reproduce it, because then
  // nothing is nearer than the point underneath.
  const at = { x: 100, z: 1.0, yaw: Math.PI / 2, speed: 21 };
  // The old rule, reproduced: nearest point in an 80-forward window.
  let bestI = 25, bestD = Infinity;
  for (let k = 25; k < Math.min(nearTouch.length, 25 + 80); k++) {
    const dd = (nearTouch[k][0] - at.x) ** 2 + (nearTouch[k][1] - at.z) ** 2;
    if (dd < bestD) { bestD = dd; bestI = k; }
  }
  const f = followPath(nearTouch, at, { i: 25 });
  console.log(`    a route that doubles back 0.6 m away, car at index 25:`);
  console.log(`      KNOWN-BAD windowed-nearest picks index ${bestI} (${nearTouch[bestI][0]}, ${nearTouch[bestI][1]})`);
  console.log(`      projection picks index ${f.i} (${nearTouch[f.i][0]}, ${nearTouch[f.i][1]}), err ${f.err.toFixed(3)}`);
  check('KNOWN-BAD: a windowed nearest-point search teleports across the touch', bestI > 50,
    `${bestI}`);
  check('the projection stays on the leg the car is on', f.i < 40, `${f.i}`);
  check('and so the heading error stays at zero', Math.abs(f.err) < 0.2, `${f.err.toFixed(3)}`);
}

// (b) PURE PURSUIT IS ZERO AT 180 DEGREES as well as at zero.
{
  const line = [];
  for (let x = 0; x <= 80; x += 4) line.push([x, 0, 0]);
  // Car on the line but facing exactly backwards.
  const back = { x: 20, z: 0, yaw: -Math.PI / 2, speed: 3 };
  const f = followPath(line, back, { i: 5 });
  const naive = Math.sin(f.err) * 2 / Math.max(Math.hypot(f.aim[0] - back.x, f.aim[1] - back.z), 1e-3);
  console.log(`    a car on the line facing exactly backwards: err ${f.err.toFixed(3)} rad`);
  console.log(`      KNOWN-BAD uncapped 2 sin(err)/d curvature: ${naive.toExponential(2)} — essentially zero`);
  console.log(`      with the quarter-turn cap: steer ${f.controls.steer.toFixed(3)}`);
  check('KNOWN-BAD: the uncapped curvature at 180 degrees is nearly zero',
    Math.abs(naive) < 1e-6, `${naive}`);
  check('the capped law commands full lock instead',
    Math.abs(f.controls.steer) > 0.99, `${f.controls.steer}`);
  /**
   * AND AT 180 DEGREES FULL LOCK IS STILL NOT ENOUGH, SO IT REVERSES. This arm used to assert
   * that the steering sign matches the heading error's, which is right while the car is driving
   * forward and wrong here: an aim point directly behind is inside the car's turning circle at
   * any speed, so full lock orbits a circle that never contains it. Measured on two real
   * `driveTo` legs from a standstill — 30 m to Shakedown's own pickup and 337 m to the marina —
   * the progress index sat at 0 for the whole timeout with the steering on full lock and every
   * reported number correct. Reversing mirrors the steering on purpose, which is what a
   * three-point turn is, so the direction check is now stated per direction of travel.
   */
  console.log(`      reversing ${f.reversing}, throttle ${f.controls.throttle.toFixed(2)}, ` +
    `required radius ${f.reqRadius.toFixed(2)} m against a minimum of ` +
    `${minTurnRadius(back.speed).toFixed(2)} m`);
  check('an aim point directly behind is unreachable at full lock',
    f.reqRadius < minTurnRadius(back.speed),
    `${f.reqRadius.toFixed(2)} m wanted, ${minTurnRadius(back.speed).toFixed(2)} m available`);
  check('so the follower reverses out of it', f.reversing && f.controls.throttle < 0,
    `reversing ${f.reversing}, throttle ${f.controls.throttle.toFixed(2)}`);
  check('and mirrors the steering, which is what swings the nose round',
    Math.sign(f.controls.steer) === -Math.sign(f.err),
    `steer ${f.controls.steer.toFixed(2)} against err ${f.err.toFixed(2)}`);
  // Driving forward, the sign still follows the error — the manoeuvre must not leak into
  // ordinary cornering. 40 degrees off the line at 10 m/s is a corner, not a reversal.
  const off = { x: 20, z: 0, yaw: Math.PI / 2 - 0.7, speed: 10 };
  const g = followPath(line, off, { i: 5 });
  check('a car merely off-line does not reverse', !g.reversing
    && Math.sign(g.controls.steer) === Math.sign(g.err),
    `err ${g.err.toFixed(2)}, steer ${g.controls.steer.toFixed(2)}, reversing ${g.reversing}`);
}

// (c) THE TURN THE CAR IS IN IS ALSO A CEILING. pathSpeedLimit looks forward only, so once
// the apex is behind the index it sees the straight beyond and the target jumps.
{
  const corner = [];
  for (let x = 0; x <= 40; x += 4) corner.push([x, 0, 0]);
  for (let a = 0; a <= 90; a += 12) {
    const r = 8, cx = 40, cz = -r;
    corner.push([cx + r * Math.sin(a * Math.PI / 180), cz + r * Math.cos(a * Math.PI / 180), 0]);
  }
  for (let z = -8; z >= -60; z -= 4) corner.push([48, z, 0]);
  // Mid-corner: the index is past the apex, the scan ahead is the straight.
  const midIdx = 14;
  const ahead = pathSpeedLimit(corner, midIdx, 3, 22);
  // The car is holding a tight radius right now; cornerSpeed of it is the real ceiling.
  const holding = cornerSpeed(8);
  console.log(`    mid-corner at index ${midIdx} of an 8 m bend:`);
  console.log(`      KNOWN-BAD forward-only limit: ${(ahead * 3.6).toFixed(0)} km/h`);
  console.log(`      the turn being held allows:   ${(holding * 3.6).toFixed(0)} km/h`);
  check('KNOWN-BAD: the forward-only limit is far above what the current turn allows',
    ahead > holding * 2, `${(ahead * 3.6).toFixed(0)} vs ${(holding * 3.6).toFixed(0)} km/h`);
  // followPath takes the min of the two, so its target respects the turn.
  const f = followPath(corner, { x: corner[midIdx][0], z: corner[midIdx][1], yaw: 1.0, speed: 3 }, { i: midIdx });
  check('followPath caps the target by the turn it is asking for',
    f.target <= cornerSpeed(f.reqRadius) + 1e-9,
    `target ${(f.target * 3.6).toFixed(1)} against ${(cornerSpeed(f.reqRadius) * 3.6).toFixed(1)} km/h`);
}

// (d) A RING WALKED AT A FIXED STEP LEAVES A REVERSE SPUR.
{
  const ring = [];
  for (let a = 0; a < 360; a += 30) ring.push([50 * Math.cos(a * Math.PI / 180), 50 * Math.sin(a * Math.PI / 180), 0]);
  const open = resample(ring, 7);                 // walked as an open line, then closed by hand
  open.push([ring[0][0], ring[0][1], 0]);
  const closed = resample(ring, 7, true);
  const lastSeg = Math.hypot(open[open.length - 1][0] - open[open.length - 2][0],
    open[open.length - 1][1] - open[open.length - 2][1]);
  // UNIFORMITY, not the requested spacing. Dividing a ring evenly cannot also hit an
  // arbitrary step exactly: the step becomes length/round(length/spacing), which for this
  // 310.6 m ring at 7 m is 7.06. The claim is that every segment is the SAME, which is what
  // a look-ahead measured in arc length needs.
  let lo = Infinity, hi = 0;
  for (let i = 0; i < closed.length; i++) {
    const a = closed[i], b = closed[(i + 1) % closed.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    lo = Math.min(lo, L); hi = Math.max(hi, L);
  }
  console.log(`    a 50 m-radius 12-gon ring resampled at 7 m:`);
  console.log(`      KNOWN-BAD open walk then hand-closed: last segment ${lastSeg.toFixed(2)} m against a 7 m step`);
  console.log(`      divided evenly as a ring: segments ${lo.toFixed(3)}..${hi.toFixed(3)} m, spread ${(hi - lo).toFixed(4)} m`);
  check('KNOWN-BAD: the open walk leaves a remainder segment', Math.abs(lastSeg - 7) > 1,
    `${lastSeg.toFixed(2)} m`);
  check('dividing the ring evenly makes every segment the same length', hi - lo < 0.25,
    `${(hi - lo).toFixed(4)} m`);
  check('and each one is within 5% of the requested spacing',
    Math.abs(hi - 7) / 7 < 0.05 && Math.abs(lo - 7) / 7 < 0.05, `${lo.toFixed(2)}..${hi.toFixed(2)}`);
  check('and the ring carries no duplicate closing point',
    Math.hypot(closed[closed.length - 1][0] - closed[0][0], closed[closed.length - 1][1] - closed[0][1]) > 1);
  // The district course must close exactly and have no reversal at the seam.
  const n = tour.points.length;
  check('the district course closes exactly',
    Math.hypot(tour.points[n - 1][0] - tour.points[0][0], tour.points[n - 1][1] - tour.points[0][1]) < 1e-6);
}

// (e) The crawl floor, which is a design decision and not a fudge — and whose "free by
// construction" was true of a different number until #128 measured it.
//
// The old check here was `cornerSpeed(1) <= 2.2`, "so a contact there is free". It compared a
// SPEED with src/damage.js's free DELTA-V, and two things stand between them: a wall reverses the
// normal velocity by (1 + e), and the speed loop holds its target PLUS a deadband. Fourteen junction
// turns in #128's census charged 2.6-2.8 m/s clipping a wall at 2.49-2.50 under a floor of 2.2, with
// this check green. So the floor is now derived from both, and both halves are MEASURED below rather
// than asserted from the constants that define them.
{
  const freeDv = new DamageModel().freeDv;
  const wallE = new Vehicle().wallRestitution;
  const BODY_L = 2 * HALF_EXTENT.z;
  const STUCK_S = 9.5;                      // src/roadpath.js STUCK_S, asserted in the progress-anchor section
  console.log(`    cornerSpeed floor: ${(cornerSpeed(1) * 3.6).toFixed(2)} km/h for a corner the car cannot hold ` +
    `(CRAWL_MS ${CRAWL_MS.toFixed(4)}, deadband ${SPEED_DEADBAND}, overrun ${CRAWL_OVERRUN}, e ${wallE}, free ${freeDv})`);
  check('an impossible corner still gets a crawl, not a standstill: a body length in under half the stuck window',
    cornerSpeed(1) === CRAWL_MS && CRAWL_MS * (STUCK_S / 2) > BODY_L,
    `${(CRAWL_MS * STUCK_S / 2).toFixed(2)} m in ${STUCK_S / 2} s against ${BODY_L} m`);
  check('the floor is the target whose HELD speed, overrun included, charges the free threshold head-on',
    Math.abs((CRAWL_MS + SPEED_DEADBAND + CRAWL_OVERRUN) * (1 + wallE) - freeDv) < 1e-9,
    `(${CRAWL_MS.toFixed(4)} + ${SPEED_DEADBAND} + ${CRAWL_OVERRUN}) x ${1 + wallE}`);

  // 1. THE HELD SPEED, measured: a right-angle corner of 2 m radius on open ground, which no speed
  //    can follow, so the follower crawls it at the floor. The deadband and the overrun are claims
  //    about the loop, so they are read off it — at 1/120 s and at clear-time's 1/15 s, the
  //    coarsest control step any caller drives the follower at, because the overrun is one step.
  const HZ = 120, DT = 1 / HZ, yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  const corner = [];
  for (let z = 0; z <= 40; z += 2) corner.push([0, z]);
  for (let a = 10; a <= 90; a += 10) corner.push([-2 + 2 * Math.cos(a * Math.PI / 180), 40 + 2 * Math.sin(a * Math.PI / 180)]);
  for (let s = 2; s <= 40; s += 2) corner.push([-2 - s, 42]);
  const held = (ctrl) => {
    const per = Math.round(ctrl / DT);
    const car = new Vehicle(), ground = new FlatGround(0), st = { i: 0 };
    car.position.set(0, 0.55, 0);
    let atFloor = 0, heldMax = 0, f = null;
    for (let s = 0; s < HZ * 60; s++) {
      if (s % per === 0) {
        f = followPath(corner, { x: car.position.x, z: car.position.z, yaw: yawOf(car.quaternion), speed: car.speed }, st, { dt: ctrl });
        if (f.done) break;
        if (Math.abs(f.target - CRAWL_MS) < 1e-9) atFloor++;
        car.setControls(f.controls);
      }
      if (atFloor * ctrl > 1 && Math.abs(f.target - CRAWL_MS) < 1e-9) heldMax = Math.max(heldMax, car.speed);
      car.stepFixed(DT, ground, HZ);
    }
    return { seconds: atFloor * ctrl, heldMax };
  };
  const fine = held(1 / 120), coarse = held(1 / 15);
  console.log(`    held at the floor: ${fine.seconds.toFixed(1)} s there; held up to ${fine.heldMax.toFixed(4)} m/s at a 1/120 s ` +
    `step and ${coarse.heldMax.toFixed(4)} at 1/15 s, against floor + deadband ${(CRAWL_MS + SPEED_DEADBAND).toFixed(4)}`);
  check('the follower crawls an impossible corner at the floor for long enough to measure', fine.seconds > 3,
    `${fine.seconds.toFixed(1)} s`);
  check('and the speed it HOLDS there is the floor plus the deadband, not the floor',
    fine.heldMax > CRAWL_MS + SPEED_DEADBAND * 0.8, `held up to ${fine.heldMax.toFixed(4)}`);
  check('and runs past that by less than CRAWL_OVERRUN even at the coarsest control step a caller uses',
    coarse.heldMax <= CRAWL_MS + SPEED_DEADBAND + CRAWL_OVERRUN && coarse.heldMax > fine.heldMax,
    `${(coarse.heldMax - CRAWL_MS - SPEED_DEADBAND).toFixed(4)} at 1/15 s against ${CRAWL_OVERRUN}`);

  // 2. THE CLIP, measured: the car square to a wall at the speed MEASURED above, charged by the
  //    damage model — not at the speed the formula says, which is the substitution that hid this.
  const clip = (v) => {
    const wall = new BlockerIndex({ buildings: [{ p: [[-20, 10], [20, 10], [20, 30], [-20, 30]], h: 10 }] });
    const c = new Vehicle(), dmg = new DamageModel(), ground = new FlatGround(0);
    c.blockers = wall; c.damage = dmg;
    let worst = 0, charged = 0;
    const real = dmg.impact.bind(dmg);
    dmg.impact = (ev) => { const r = real(ev); if (ev.dv > worst) worst = ev.dv; if (r.applied) charged++; return r; };
    c.position.set(0, 0.55, 0);
    for (let s = 0; s < HZ * 8 && c.contacts === 0; s++) {
      c.setControls({ throttle: 0, brake: 0, steer: 0, handbrake: false });
      c.velocity.set(0, c.velocity.y, v);            // held to the wall, as the crawl holds it
      c.stepFixed(DT, ground, HZ);
    }
    return { contacts: c.contacts, worst, charged };
  };
  const now = clip(coarse.heldMax), old = clip(2.2 + SPEED_DEADBAND);
  console.log(`    head-on at the measured held crawl ${coarse.heldMax.toFixed(4)} m/s: dv ${now.worst.toFixed(4)}, ` +
    `charged ${now.charged}; KNOWN-BAD at the old held ${(2.2 + SPEED_DEADBAND).toFixed(2)}: dv ${old.worst.toFixed(3)}, charged ${old.charged}`);
  check('a head-on clip at the measured held crawl HAPPENS and is free', now.contacts > 0 && now.worst > 0 && now.charged === 0,
    `contacts ${now.contacts}, dv ${now.worst.toFixed(4)} against ${freeDv}`);
  check('KNOWN-BAD: the old floor of 2.2, held at 2.5, is charged', old.contacts > 0 && old.charged > 0,
    `dv ${old.worst.toFixed(3)}`);
}

// ---------------------------------------------------------------------------
// §6  The lane offset, and the road that is narrower than it.
// ---------------------------------------------------------------------------
console.log('\n§6  The lane offset');
/**
 * WHICH SIDE IS RIGHT, ASKED OF SOMETHING THAT IS NOT THIS MODULE (#127). The two checks that stood
 * here were `right of a +x heading is -z` and `right of a +z heading is +x`: literals, written from
 * the same graph-paper intuition as the code, so they could only ever agree with it — and the code
 * put every route lane on the driver's LEFT. Two oracles now, neither of them a number typed in:
 *
 *   - three.js's own projection. A camera looking along the heading, as the chase camera does,
 *     must see the offset lane on the right half of its screen. Swept over sixteen headings, so a
 *     convention that is right only on an axis cannot pass.
 *   - the fleet. src/traffic.js places its cars at `+lane` along its own normal and its fleet
 *     drives on the right; a settled fleet's cars must sit on the POSITIVE side of `rightOf` their
 *     own heading, measured from the centreline of the edge they are on.
 */
const THREE = await import('../vendor/three.module.min.js');
const screenSide = (heading) => {
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  const fx = Math.sin(heading), fz = Math.cos(heading);
  cam.position.set(0, 1.5, 0);
  cam.lookAt(fx * 20, 1.5, fz * 20);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const line = [[0, 0, 0], [fx * 10, fz * 10, 0], [fx * 20, fz * 20, 0]];
  const lane = offsetRight(line, 3)[1];
  return new THREE.Vector3(lane[0], 0, lane[1]).project(cam).x;
};
const sides = Array.from({ length: 16 }, (_, k) => screenSide((k / 16) * Math.PI * 2));
console.log(`    the offset lane on a driver's screen, NDC x over 16 headings: `
  + `min ${Math.min(...sides).toFixed(3)}, max ${Math.max(...sides).toFixed(3)}`);
check('an offset lane is on the RIGHT of a driver\'s screen at every heading (three.js projection)',
  sides.every((x) => x > 0.05), `NDC x ${sides.map((x) => x.toFixed(2)).join(' ')}`);
// The formula the lane used to have, through the same oracle: it must fail it, or the oracle is
// not an oracle.
{
  const cam = new THREE.PerspectiveCamera(60, 16 / 9, 0.1, 200);
  cam.position.set(0, 1.5, 0); cam.lookAt(0, 1.5, 20); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
  const old = new THREE.Vector3(+3, 0, 10).project(cam).x;    // (dz, -dx) * 3 for a +z heading
  check('KNOWN-BAD: the convention the lane used to have, (dz, -dx), lands on the LEFT',
    old < -0.05, `NDC x ${old.toFixed(3)}`);
}
{
  const { Traffic } = await import('../src/traffic.js');
  const scene = { add() {}, remove() {} };
  const tr = new Traffic(scene, district, { count: 12 });
  for (let k = 0; k < 120; k++) tr.update(1 / 30, { x: -150, z: -160 });
  let n = 0, positive = 0, worst = Infinity;
  for (const p of tr._lastPositions ?? []) {
    if (!Number.isFinite(p.heading) || p.box || p.shunted) continue;
    const e = district.edges[p.edge];
    let best = null;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
      const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2));
      const qx = a.x + dx * t, qz = a.z + dz * t, d = Math.hypot(p.x - qx, p.z - qz);
      if (!best || d < best.d) best = { d, qx, qz };
    }
    const [rx, rz] = rightOf(Math.sin(p.heading), Math.cos(p.heading));
    const side = (p.x - best.qx) * rx + (p.z - best.qz) * rz;
    if (Math.abs(side) < 0.2) continue;        // a car on a single-track edge has no side to read
    n++;
    if (side > 0) positive++;
    worst = Math.min(worst, side);
  }
  console.log(`    the fleet against rightOf its own heading: ${positive} of ${n} cars on the positive side`);
  check('and the fleet\'s cars sit on the positive side of rightOf their own heading — one convention',
    n >= 5 && positive === n, `${positive} of ${n}, worst ${worst.toFixed(2)} m`);
}
const straight = [[0, 0, 0], [4, 0, 0], [8, 0, 0], [12, 0, 0]];
const right = offsetRight(straight, 3);
console.log(`    a line along +x offset 3 m right: (${right[1][0]}, ${right[1][1]})`);
check('the per-point form is used where given',
  near(offsetRight(straight, 3, () => 1)[1][1], right[1][1] / 3, 1e-9),
  `${offsetRight(straight, 3, () => 1)[1][1]} against ${right[1][1] / 3}`);
// The district: the offset must never push the course into a building, at any request.
console.log('    course clearance to the nearest wall, by requested offset:');
for (const off of [0, 1, 2, 3, 6]) {
  const t = g.tour(district.meta.route.slice(1), { spacing: 4, offset: off });
  let blocked = 0;
  for (const q of t.points) if (blockers.resolveCircle(q[0], q[1], 0.95)) blocked++;
  console.log(`      offset ${off} m: ${t.points.length} points, ${blocked} blocked, ${t.length.toFixed(0)} m`);
  check(`offset ${off} m puts no point of the course inside a wall`, blocked === 0, `${blocked}`);
}
console.log('    (a `service` road in this district is 2.8 m wide, so an uncapped 3 m offset');
console.log('     is off the tarmac entirely — the cap is per point, from that road\'s own width.)');

/**
 * §6b  THE SAME OFFSET ON EVERY EDGE IN THE DISTRICT, not just on the nine-waypoint tour.
 *
 * §6 above passed the whole time while the offset was wrecking cars, because the tour happens to
 * avoid the edges where it fails. Two playtesters found it on `path()` — the point-to-point route
 * the missions use — one of them at the same spot in 5 of 6 starting headings. This section walks
 * every edge, both lanes, every 2 m, and it is the census the fix was measured against.
 *
 * The residual is the interesting part. After the fit, every blocked lane sample is a blocked
 * CENTRELINE sample, on the 12 edges whose own centreline is not strictly clear, 11 of which the
 * router already excludes. So the offset contributes no blocked point of its own, and that is an
 * equality between two different quantities at two different offsets rather than a tautology.
 */
console.log('\n§6b The same offset on every edge in the district');
const OFF = 3, LANE_STEP = 2, RUNGS = [1, 0.75, 0.5, 0.25];
function laneCensus(capFor, fit) {
  let pts = 0, laneBad = 0, centreBad = 0, laneOnly = 0, fitted = 0, longest = 0, notLongest = 0;
  const badEdges = new Set();
  for (let i = 0; i < district.edges.length; i++) {
    const e = district.edges[i];
    const want = capFor(e, OFF);
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (!(L > 0)) continue;
      const n = Math.max(1, Math.ceil(L / LANE_STEP));
      const ux = (b.x - a.x) / L, uz = (b.z - a.z) / L;
      for (let sp = 0; sp <= n; sp++) {
        const t = sp / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        const centreClear = g.clearAt(x, z);
        for (const sign of [1, -1]) {
          pts++;
          if (!centreClear) centreBad++;
          let chosen = want, above = null;
          if (fit && want > 0) {
            chosen = 0;
            for (const f of RUNGS) {
              const amt = want * f;
              if (g.clearAt(x + uz * amt * sign, z - ux * amt * sign)) { chosen = amt; break; }
              above = amt;
            }
            if (above !== null) {
              fitted++;
              // THE FIT OWES THE LONGEST CLEAR RUNG: the rung above the one taken must really be
              // blocked, or the ladder is just a constant wearing a ladder's clothes.
              // The good case is that the rung above IS blocked. Written the other way round
              // first, which read as 82 failures against a fit that was working correctly.
              if (g.clearAt(x + uz * above * sign, z - ux * above * sign)) notLongest++;
              else longest++;
            }
          }
          const clear = g.clearAt(x + uz * chosen * sign, z - ux * chosen * sign);
          if (!clear) { laneBad++; badEdges.add(i); if (centreClear) laneOnly++; }
        }
      }
    }
  }
  return { pts, laneBad, centreBad, laneOnly, fitted, longest, notLongest, edges: badEdges.size };
}
const capNow = (e, off) => laneOffsetFor(e, off);
const capOld = (e, off) => Math.min(off, Math.max(0, (e.w * Math.max(1, e.lanes)) / 2 - 1.2));
const fitOn = laneCensus(capNow, true);
const widthOnly = laneCensus(capNow, false);
const oldCap = laneCensus(capOld, false);
console.log(`    ${fitOn.pts} lane samples over ${district.edges.length} edges`);
console.log(`      cap w * lanes / 2 - 1.2, no fit   ${String(oldCap.laneBad).padStart(5)} blocked` +
  `  (${oldCap.laneOnly} of them on a clear centreline, ${oldCap.edges} edges)`);
console.log(`      cap w / 2 - margin, no fit        ${String(widthOnly.laneBad).padStart(5)} blocked` +
  `  (${widthOnly.laneOnly} of them on a clear centreline, ${widthOnly.edges} edges)`);
console.log(`      fitted against the blockers       ${String(fitOn.laneBad).padStart(5)} blocked` +
  `  (${fitOn.laneOnly} of them on a clear centreline, ${fitOn.edges} edges)`);
console.log(`      the centreline itself             ${String(fitOn.centreBad).padStart(5)} blocked`);
console.log(`      ${fitOn.fitted} samples took a reduced rung; the rung above was blocked at ` +
  `${fitOn.longest} of them`);
check('the fit leaves no lane point blocked that the centreline does not',
  fitOn.laneOnly === 0, `${fitOn.laneOnly} lane-only`);
check('and its residual is exactly the centreline\'s own',
  fitOn.laneBad === fitOn.centreBad, `${fitOn.laneBad} vs ${fitOn.centreBad}`);
// TEETH: the two caps that were tried before must both fail this, or the check above is decoration.
check('the cap that shipped before this fails the same census',
  oldCap.laneOnly > 0, `${oldCap.laneOnly} lane-only points on ${oldCap.edges} edges`);
check('and so does the corrected width cap on its own',
  widthOnly.laneOnly > 0, `${widthOnly.laneOnly} lane-only points`);
check('the fit always takes the longest clear rung',
  fitOn.notLongest === 0 && fitOn.longest > 0,
  `${fitOn.longest} verified, ${fitOn.notLongest} took a short rung with a clear one above`);
// And the slope limiter: a step in the offset is a kink in the path.
const strip = [];
for (let i = 0; i < 40; i++) strip.push([i * 4, 0, 0]);
// Blocked on the side the lane goes to: the driver's right of a +x heading is +z (rightOf(1, 0)).
const halfBlocked = (x, z) => !(x > 60 && x < 100 && z > 0.5);
const amts = laneOffsets(strip, 3, () => ({ w: 20, lanes: 1 }), halfBlocked, 4);
let worstStep = 0;
for (let i = 1; i < amts.length; i++) worstStep = Math.max(worstStep, Math.abs(amts[i] - amts[i - 1]));
console.log(`    a 40-point strip with one blocked stretch: offsets ` +
  `${amts.map((a) => a.toFixed(1)).join(' ')}`);
check('the offset never steps more than the slope limit', worstStep <= 4 * 0.25 + 1e-9,
  `worst step ${worstStep.toFixed(3)} m against ${(4 * 0.25).toFixed(2)}`);
check('and it does reach zero where the lane is blocked', Math.min(...amts) === 0,
  `min ${Math.min(...amts).toFixed(2)}, max ${Math.max(...amts).toFixed(2)}`);

/**
 * THE ROUTE LANE. The line a player follows is 1.5 m right of the centreline. It was chosen by a
 * sweep against the collision rate that turned out to be measured on the driver's LEFT, and on the
 * right the same sweep cannot tell 0 to 2.2 m apart — so it is kept rather than re-chosen; see
 * ROUTE_LANE_M (#127). What this section owes is the property that makes ONE constant the right
 * shape for it: that the request is honoured as asked on every two-way road, rather than silently
 * capped on some and not others.
 */
{
  let capped = 0, twoWay = 0, narrow = 0;
  for (const e of district.edges) {
    const got = laneOffsetFor(e, ROUTE_LANE_M);
    if (e.o !== 0 || e.w < 3.8) { narrow++; continue; }
    twoWay++;
    if (Math.abs(got - ROUTE_LANE_M) > 1e-9) capped++;
  }
  console.log(`    the route lane (${ROUTE_LANE_M} m) over ${twoWay} two-way edges: ` +
    `${capped} capped below it, ${narrow} single-track or one-way (offset 0)`);
  check('the route lane is honoured as asked on every two-way road', capped === 0,
    `${capped} of ${twoWay} capped`);
  /**
   * THE NARROWEST TWO-WAY ROAD IS THE ONE IN THE DATA, not the threshold. Written against
   * TWO_WAY_MIN_W (3.8 m) this check failed — 2.45 m of body against a 1.90 m half-width — and
   * it was the check that was wrong, not the constant: an edge at exactly 3.8 m would be capped
   * to 0.70 by `w / 2 - LANE_MARGIN_M` long before the body reached the kerb, and in any case the
   * narrowest two-way edge this district HAS is 6.0 m. Asserting against a threshold rather than
   * the population is how a gate reports a defect the build does not have.
   */
  const narrowestTwoWay = Math.min(...district.edges
    .filter((e) => e.o === 0 && e.w >= 3.8).map((e) => e.w));
  const reach = ROUTE_LANE_M + 0.95;
  console.log(`    the narrowest two-way edge in the data is ${narrowestTwoWay.toFixed(1)} m; ` +
    `the body on the route lane reaches ${reach.toFixed(2)} m of its ` +
    `${(narrowestTwoWay / 2).toFixed(2)} m half-width`);
  check('and the body on it clears the narrowest two-way kerb line in the data',
    reach <= narrowestTwoWay / 2 + 1e-9,
    `reaches ${reach.toFixed(2)} m against ${(narrowestTwoWay / 2).toFixed(2)} m`);
  check('it is right of the centreline and inside the fleet\'s own lane',
    ROUTE_LANE_M > 0 && ROUTE_LANE_M < 2.05,
    `${ROUTE_LANE_M} m against the fleet's 2.05-2.20`);
}

/**
 * §6c  THE ROUTE A MOVING CAR IS GIVEN (#129). Leg 7 of the district's route, as playtest's driveTo
 * chained it: the car arrives at (208.5, -381.4) doing 11 m/s heading -z, and the shortest route to
 * waypoint 7 opens 36 m up the alley it came down. The follower cannot turn round in a street at
 * speed — it circled into a building 41 m off its line at every lane offset — so `path` takes the
 * car's heading and speed and prefers any route that opens ahead. Asserted both ways, plus the
 * stopped case, which must be routed exactly as it was.
 */
{
  const opening = (p, yaw) => {
    const P = p.points, fx = Math.sin(yaw), fz = Math.cos(yaw);
    for (let i = 1; i < P.length; i++) {
      const dx = P[i][0] - P[0][0], dz = P[i][1] - P[0][1];
      if (Math.hypot(dx, dz) >= 2) return (dx * fx + dz * fz) / Math.hypot(dx, dz);
    }
    return NaN;
  };
  const car = { x: 208.5, z: -381.4, yaw: 3.08 }, to = district.meta.route[7];
  const blind = g.path(car.x, car.z, to.x, to.z, { spacing: 4, offset: ROUTE_LANE_M, smoothPasses: 2 });
  const moving = g.path(car.x, car.z, to.x, to.z, { spacing: 4, offset: ROUTE_LANE_M, smoothPasses: 2,
    heading: car.yaw, speed: 11 });
  const stopped = g.path(car.x, car.z, to.x, to.z, { spacing: 4, offset: ROUTE_LANE_M, smoothPasses: 2,
    heading: car.yaw, speed: 0.5 });
  const ob = opening(blind, car.yaw), om = opening(moving, car.yaw);
  console.log(`\n§6c The route a moving car is given`);
  console.log(`    leg 7 from (208.5, -381.4) heading -z: without a heading it opens at cos ${ob.toFixed(2)} `
    + `to the nose over ${blind.length.toFixed(0)} m; at 11 m/s at cos ${om.toFixed(2)} over ${moving.length.toFixed(0)} m`);
  check('KNOWN-BAD: routed blind, leg 7 opens BEHIND the car', ob < 0, `cos ${ob.toFixed(3)}`);
  check('given the heading of a moving car, it opens ahead', om > 0, `cos ${om.toFixed(3)}`);
  check('and a STOPPED car is routed exactly as before, so the three-point turn still has its case',
    JSON.stringify(stopped.points) === JSON.stringify(blind.points),
    `${stopped.points.length} points against ${blind.points.length}`);
  /**
   * AND A ROUTE THAT OPENS AHEAD CAN STILL TURN ROUND. A car at (645, -260) on one-way alley edge 762,
   * pointing at its dead end: the route that "opens ahead" drives 27 m to the end and comes back down
   * the same edge, which the follower cannot do either — measured, the preference without this term
   * took 10 timeouts in 30 legs where the U-turn at the car took 2. So doubling back along the
   * car's own edge counts as turning round, and when every route turns round the path says so
   * (`turnsBack`) for the caller to stop first.
   */
  /*
   * RESTATED BY #131. The subject was (645, -260), heading 2.17 up one-way alley edge 762, and it read
   * as a dead end only because the shortest route out of its far vertex opened with a hairpin. The
   * turn-limited router takes edge 87 there instead — a turn the car can make — so that car now has
   * a route ahead (711 m, the follower arrives in 41.4 s at dv 0), which is what the next check
   * keeps. The subject for "no route ahead" is a REAL dead end: alley edge 3, 62 m, whose far vertex
   * has no other link. Every one of the district's 48 dead-end spurs over 40 m reads turnsBack.
   */
  const dead = g.path(704.6, -53.1, 250, 2, { spacing: 4, smoothPasses: 2, heading: 1.57, speed: 11 });
  const deadBlind = g.path(704.6, -53.1, 250, 2, { spacing: 4, smoothPasses: 2 });
  console.log(`    a car heading into dead-end alley edge 3 at (704.6, -53.1): turnsBack ${dead.turnsBack}, `
    + `${dead.length.toFixed(0)} m against ${deadBlind.length.toFixed(0)} m routed blind`);
  check('a moving car with no route ahead is TOLD so, not sent to the dead end to turn round there',
    dead.turnsBack === true && JSON.stringify(dead.points) === JSON.stringify(deadBlind.points),
    `turnsBack ${dead.turnsBack}, ${dead.length.toFixed(0)} m against ${deadBlind.length.toFixed(0)} m`);
  check('and a caller that gives no heading is told nothing', blind.turnsBack === false && deadBlind.turnsBack === false,
    `${blind.turnsBack} / ${deadBlind.turnsBack}`);
  const was = g.path(645, -260, 250, 2, { spacing: 4, smoothPasses: 2, heading: 2.17, speed: 11 });
  check('and the old subject, which only LOOKED like a dead end, is routed ahead by a turn the car can make (#131)',
    was.turnsBack === false && was.hairpin === false && was.edges[0]?.e === 87,
    `turnsBack ${was.turnsBack}, hairpin ${was.hairpin}, first edge ${was.edges[0]?.e}, ${was.length.toFixed(0)} m`);
}

// ---------------------------------------------------------------------------
// §6d  The router's turn limit (#131).
// ---------------------------------------------------------------------------
/**
 * The router was a vertex search over length, so a 139-degree hairpin from a 6.6 m road into a 2.8 m
 * alley was as good as a straight on, and the follower spent 200 s of a 240 s timeout reversing at
 * its mouth. It is a search over LINKS now, with src/roadpath.js's TURN_LIMIT_RAD (120 degrees, read
 * off a drive through every turn the graph offers) as a preference that falls back to the unlimited
 * route only when nothing gentler reaches. The turns here are this gate's OWN arithmetic off the
 * district's edges, not RoadGraph.turn, so the router's rule is not checked by itself.
 */
console.log('\n§6d The router\'s turn limit (#131)');
{
  const LIMIT = 120;
  const travel = (e, forward, atEnd) => {
    const v = forward ? district.edges[e].v : [...district.edges[e].v].reverse();
    const p = district.verts[v[atEnd ? v.length - 2 : 0]], q = district.verts[v[atEnd ? v.length - 1 : 1]];
    const l = Math.hypot(q.x - p.x, q.z - p.z) || 1;
    return [(q.x - p.x) / l, (q.z - p.z) / l];
  };
  const worstTurnDeg = (r) => {
    let w = 0;
    for (let i = 1; i < r.edges.length; i++) {
      const [ax, az] = travel(r.edges[i - 1].e, r.edges[i - 1].forward, true);
      const [bx, bz] = travel(r.edges[i].e, r.edges[i].forward, false);
      w = Math.max(w, Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz)) * 180 / Math.PI);
    }
    return w;
  };
  let seed = 131;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
  const verts = [...g.out.keys()];
  let pairs = 0, limited = 0, overLimit = 0, unlimitedOver = 0, fallbacks = 0, fallbackPair = null, lost = 0;
  for (let k = 0; k < 200; k++) {
    const a = verts[Math.floor(rnd() * verts.length)], b = verts[Math.floor(rnd() * verts.length)];
    const r = g.route(a, b), r0 = g.route(a, b, { turnLimit: Infinity });
    if (!r0) continue;
    // A pair the unlimited search can route and the router cannot is a REFUSAL, which is the thing
    // the fallback exists to prevent — counted, not skipped, or a router that refused would pass.
    if (!r) { lost++; continue; }
    pairs++;
    if (worstTurnDeg(r0) >= LIMIT) unlimitedOver++;
    if (r.hairpin) { fallbacks++; fallbackPair ??= [a, b]; continue; }
    limited++;
    if (worstTurnDeg(r) >= LIMIT) overLimit++;
  }
  console.log(`    ${pairs} random pairs: the unlimited search turns ${LIMIT} deg or more on ${unlimitedOver}; `
    + `the router on ${overLimit} of its ${limited} limited routes, and fell back on ${fallbacks}`);
  check('no route the router calls limited turns 120 degrees or more at any junction',
    limited > 150 && overLimit === 0, `${overLimit} of ${limited}`);
  check('KNOWN-BAD: the unlimited search does, on the same pairs', unlimitedOver > 5, `${unlimitedOver} of ${pairs}`);
  check('and where nothing gentler reaches, it still routes, flagged as a hairpin rather than refused',
    lost === 0 && fallbacks > 0 && g.route(fallbackPair[0], fallbackPair[1])?.hairpin === true,
    `${lost} refused, ${fallbacks} fell back${fallbackPair ? `, e.g. ${fallbackPair.join(' -> ')}` : ''}`);

  /*
   * The reported turn: 139 degrees at vertex 95 from edge 33 (6.6 m) into alley 350 (2.8 m), where
   * the follower spent 200 s of a 240 s timeout. From a point on 33 to a point on 350 either side of
   * it, the shortest route has NO edges at all — the walk in and the walk out meet at the vertex —
   * so the turn lived in the one place `route` returned early without pricing it.
   */
  const at = (ei, u, s2) => {
    const e = district.edges[ei], v = e.v[0] === u ? e.v : [...e.v].reverse();
    let acc = 0;
    for (let k = 1; k < v.length; k++) {
      const p = district.verts[v[k - 1]], q = district.verts[v[k]], L = Math.hypot(q.x - p.x, q.z - p.z);
      if (acc + L >= s2) { const t = (s2 - acc) / L; return [p.x + (q.x - p.x) * t, p.z + (q.z - p.z) * t]; }
      acc += L;
    }
    return null;
  };
  const [sx, sz] = at(33, 95, 30), [tx, tz] = at(350, 95, 30);
  const leg = g.path(sx, sz, tx, tz, { spacing: 4, offset: ROUTE_LANE_M });
  const legOld = g.path(sx, sz, tx, tz, { spacing: 4, offset: ROUTE_LANE_M, turnLimit: Infinity });
  const driveLeg = (pts) => {
    const v = new Vehicle(); v.blockers = blockers;
    v.position.set(pts[0][0], 0.55, pts[0][1]);
    v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.atan2(pts[2][0] - pts[0][0], pts[2][1] - pts[0][1]));
    const st = { i: 0 }, gr = new FlatGround(0);
    for (let s2 = 0; s2 < 120 * 240; s2++) {
      const q = v.quaternion, yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
      const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: v.speed }, st, { maxSpeed: 22, dt: 1 / 120 });
      if (f.done) return s2 / 120;
      v.setControls(f.controls); v.stepFixed(1 / 120, gr, 120);
    }
    return Infinity;
  };
  const tNew = driveLeg(leg.points), tOld = driveLeg(legOld.points);
  console.log(`    33 -> 350 at vertex 95: unlimited ${legOld.length.toFixed(0)} m, ${legOld.edges.length} edges, `
    + `${Number.isFinite(tOld) ? `arrives in ${tOld.toFixed(1)} s` : 'TIMES OUT at 240 s'}; limited `
    + `${leg.length.toFixed(0)} m round the block, ${leg.edges.length} edges, `
    + `${Number.isFinite(tNew) ? `arrives in ${tNew.toFixed(1)} s` : 'TIMES OUT'}`);
  check('the #131 turn is taken round the block, not as a hairpin at the vertex',
    legOld.edges.length === 0 && leg.edges.length > 0 && leg.hairpin === false,
    `unlimited ${legOld.edges.length} edges, limited ${leg.edges.length}, hairpin ${leg.hairpin}`);
  check('and the follower arrives on it, where through the hairpin it never does',
    Number.isFinite(tNew) && !Number.isFinite(tOld), `${tNew.toFixed(1)} s against ${tOld}`);
  /*
   * AND path() PREFERS A CANDIDATE THAT TOOK NO HAIRPIN BEFORE COMPARING LENGTHS. Of its four
   * start/end vertex combinations one may only have reached its target through the fallback; over
   * 2,927 random point-to-point paths, 92 differ when that candidate competes on length alone, and
   * every one of them then takes the hairpin because it is shorter. Two of them, as subjects.
   */
  for (const [[x0, z0], [x1, z1]] of [[[-31.3, 185], [-409.9, -59.1]], [[108.1, 102.3], [-19.2, -251.8]]]) {
    const p = g.path(x0, z0, x1, z1, { spacing: 4, offset: ROUTE_LANE_M });
    check(`(${x0}, ${z0}) -> (${x1}, ${z1}) takes the longer route without a hairpin over a shorter one with`,
      p && p.hairpin === false, p ? `hairpin ${p.hairpin}, ${p.length.toFixed(0)} m` : 'no path');
  }
}

// ---------------------------------------------------------------------------
// §7  Smoothing, determinism and cost.
// ---------------------------------------------------------------------------
console.log('\n§7  Smoothing, determinism, cost');
const square = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
const rounded = smooth(square, 2);
check('smoothing pins the endpoints',
  near(rounded[0][0], 0, 1e-9) && near(rounded[rounded.length - 1][0], 0, 1e-9));
// Resampled first, because minRadius over a fixed arc cannot see a corner made of two 10 m
// segments — see windowTurn's own note about reading zero turn on a polyline of right
// angles. The comparison has to be between two polylines of the same spacing.
const sqDense = resample(square, 2), roundDense = resample(rounded, 2);
console.log(`    a 10 m square: tightest corner ${minRadius(sqDense, 6).radius.toFixed(2)} m, ` +
  `after 2 smoothing passes ${minRadius(roundDense, 6).radius.toFixed(2)} m`);
check('smoothing rounds the corners', minRadius(roundDense, 6).radius > minRadius(sqDense, 6).radius,
  `${minRadius(sqDense, 6).radius.toFixed(2)} -> ${minRadius(roundDense, 6).radius.toFixed(2)}`);
check('smoothing leaves a straight line straight',
  smooth(straight, 3).every(([, z]) => near(z, 0, 1e-9)));
const t1 = JSON.stringify(g.tour(district.meta.route.slice(1), { spacing: 4, offset: 3 }).points);
const t2 = JSON.stringify(g.tour(district.meta.route.slice(1), { spacing: 4, offset: 3 }).points);
check('the same tour is bit-identical across calls', t1 === t2);
const g2 = new RoadGraph(district, { blockers, carRadius: 0.95 });
check('two graphs built from the same district agree',
  JSON.stringify(g2.stats) === JSON.stringify(g.stats));

let t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) new RoadGraph(district, { blockers, carRadius: 0.95 });
console.log(`    RoadGraph build (with the wall scan) ${(Number(process.hrtime.bigint() - t0) / 20 / 1e6).toFixed(1)} ms`);
t0 = process.hrtime.bigint();
for (let i = 0; i < 20; i++) g.tour(district.meta.route.slice(1), { spacing: 4, offset: 3 });
console.log(`    tour of the whole 3.4 km route          ${(Number(process.hrtime.bigint() - t0) / 20 / 1e6).toFixed(1)} ms`);
const N = 200000, state = { i: 0 };
t0 = process.hrtime.bigint();
for (let i = 0; i < N; i++) {
  state.i = i % Math.max(1, tour.points.length - 2);
  followPath(tour.points, { x: 0, z: 0, yaw: 0, speed: 15 }, state);
}
const fpNs = Number(process.hrtime.bigint() - t0) / N;
console.log(`    followPath                              ${(fpNs / 1000).toFixed(2)} us  ` +
  `= ${(fpNs * 120 / 1e9 * 100).toFixed(4)}% of wall clock at 120 Hz`);
check('followPath is under 50 us', fpNs < 50000, `${(fpNs / 1000).toFixed(1)} us`);

// Purity: no THREE, no DOM, no random.
const src = fs.readFileSync(new URL('../src/roadpath.js', import.meta.url), 'utf8');
const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
check('the comment stripper works', src.includes('WHY THIS EXISTS') && !stripped.includes('WHY THIS EXISTS'));
for (const f of ['Math.random', 'performance.now', 'Date.now', 'from \'three', 'document.', 'window.']) {
  check(`no ${f} in src/roadpath.js`, !stripped.includes(f));
}

// ---------------------------------------------------------------------------
/**
 * § BEING BLOCKED IS NOT THE SAME AS GOING SLOWLY — the eleventh way to report everything
 * nominal while getting nowhere.
 *
 * `src/roadpath.js`'s STUCK_M / STUCK_S comment has the whole story. The short version: a
 * round-5 playtester found the follower holding the throttle open against a building for 400
 * seconds with `state.i` stuck and 37,018 contacts, and NO GATE COULD SEE IT. `route-drive` and
 * this file both point the car along the path before they start, so neither meets a blockage;
 * `drive-through` meets it constantly and papers over it with a stuck-nudge teleport, which is why
 * the budget gate finishes and prints numbers about a traversal no player could make.
 *
 * WHAT THIS SECTION TESTS AND WHAT IT DOES NOT, because getting that wrong cost four wrong arms.
 * The detector's CONTRACT is tested here, against a car that is pinned by construction: that is
 * the exact antecedent — "the car is commanding drive and not moving" — so pinning it is the
 * cleanest way to state it, not a fake. The end-to-end before/after belongs in
 * `tools/playtest.mjs --selftest`, because the stall only reproduces in the Session harness: a
 * bare `Vehicle` against real district geometry GRINDS ALONG THE WALL AND ESCAPES. Both poses I
 * built here did — a long facade (160.90 m, 11,009 contacts, arrived after 207 s) and a notch with
 * 5 of 8 directions blocked (159.44 m, 110 contacts, arrived in 19.1 s, detector never fired).
 * Reporting either as a known-bad would have been a check whose two sides are the same.
 */
console.log('\n§ blocked, not slow: the progress anchor');
{
  const HZ = 60, DT = 1 / HZ;
  const ground = new FlatGround(0);
  const BODY_L = 4.30;                     // 2 * HALF_EXTENT.z, src/damage.js
  const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  const STUCK_S_CLAIMED = 9.5;             // src/roadpath.js's own value, asserted below

  /** A straight clear path from the origin, 400 m along +z. */
  const straight = [];
  for (let d = 0; d <= 400; d += 8) straight.push([0, d]);

  /**
   * Drive the follower for `seconds`. `pin` holds the car exactly where it started after every
   * sub-step, which is the detector's antecedent stated directly.
   */
  function follow(pts, { dt = 0, seconds = 60, maxSpeed = 12, pin = false,
    stopAtDone = true } = {}) {
    const v = new Vehicle();
    v.damage = new DamageModel();
    const st = { i: 0 };
    const p0 = { x: v.position.x, z: v.position.z };
    let backing = 0, wedgedAt = null, backingFrom = null, n = 0, doneAt = null, worstStuck = 0;
    const step = 1 / 8;
    const sub = Math.round(step * HZ);
    const realStep = sub / HZ;             // derived, so dt and the sub-steps cannot disagree
    for (let k = 0; k < seconds / realStep; k++) {
      const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw: yawOf(v.quaternion),
        speed: v.speed }, st, { maxSpeed, dt: dt > 0 ? realStep : undefined });
      if (f.done && doneAt === null) doneAt = +(k * realStep).toFixed(1);
      if (f.done && stopAtDone) break;
      if (f.backing) { backing++; if (backingFrom === null) backingFrom = +(k * realStep).toFixed(2); }
      if (f.wedged && wedgedAt === null) wedgedAt = +(k * realStep).toFixed(2);
      if (f.stuckFor !== null) worstStuck = Math.max(worstStuck, f.stuckFor);
      n++;
      v.setControls(f.controls);
      for (let q = 0; q < sub; q++) {
        v.stepFixed(DT, ground, HZ);
        if (pin) { v.position.set(p0.x, v.position.y, p0.z); v.velocity.set(0, v.velocity.y, 0); }
      }
      v.damage.update(realStep);
    }
    return { i: st.i, of: pts.length, moved: Math.hypot(v.position.x - p0.x, v.position.z - p0.z),
      backing, n, wedgedAt, backingFrom, doneAt, worstStuck, seconds: +(n * realStep).toFixed(1) };
  }

  // 1. The contract, against a pinned car.
  const pinnedOff = follow(straight, { dt: 0, seconds: 40, pin: true });
  const pinnedOn = follow(straight, { dt: 1, seconds: 40, pin: true });
  console.log(`    a car commanding drive and pinned in place, 40 s:`);
  console.log(`      detector off:  worst stuckFor ${pinnedOff.worstStuck}, backing ` +
    `${pinnedOff.backing}/${pinnedOff.n}, wedged ${pinnedOff.wedgedAt ?? 'never'}`);
  console.log(`      detector on:   worst stuckFor ${pinnedOn.worstStuck}, backing ` +
    `${pinnedOn.backing}/${pinnedOn.n} from ${pinnedOn.backingFrom} s, ` +
    `wedged from ${pinnedOn.wedgedAt ?? 'never'} s`);
  check('KNOWN-BAD: with no dt the detector never notices a car that cannot move',
    pinnedOff.worstStuck === 0 && pinnedOff.backing === 0 && pinnedOff.wedgedAt === null,
    `stuckFor ${pinnedOff.worstStuck}, backing ${pinnedOff.backing}`);
  /**
   * WITHIN ONE CONTROL STEP OF THE TIMEOUT, and the tolerance is that step rather than a number
   * chosen to pass. `state.anchorFor` accumulates `dt` BEFORE the comparison, so the frame on
   * which backing is first reported is the one whose counter crossed the line — and the time this
   * arm records for it is the frame's own start, one step earlier. The counter's value there is
   * printed beside it: 9.6 against a 9.5 s timeout, one 0.133 s step over.
   */
  const CTRL_STEP = 8 / 60;
  check('with a dt it notices, within one control step of the timeout and not before',
    pinnedOn.backingFrom !== null
    && pinnedOn.backingFrom >= STUCK_S_CLAIMED - CTRL_STEP
    && pinnedOn.backingFrom < STUCK_S_CLAIMED + CTRL_STEP,
    `backing from ${pinnedOn.backingFrom} s, counter ${pinnedOn.worstStuck} s, against a ` +
    `${STUCK_S_CLAIMED} s timeout and a ${CTRL_STEP.toFixed(3)} s step`);
  check('and the counter itself crossed the timeout, which is the quantity the rule reads',
    pinnedOn.worstStuck >= STUCK_S_CLAIMED
    && pinnedOn.worstStuck < STUCK_S_CLAIMED + CTRL_STEP,
    `${pinnedOn.worstStuck} s`);
  check('and it reports WEDGED once backing has also failed, so a caller can give up',
    pinnedOn.wedgedAt !== null && pinnedOn.wedgedAt > pinnedOn.backingFrom,
    `wedged from ${pinnedOn.wedgedAt} s, backing from ${pinnedOn.backingFrom} s`);
  check('wedged comes a full timeout after backing began, not immediately',
    pinnedOn.wedgedAt - pinnedOn.backingFrom >= STUCK_S_CLAIMED - 0.2,
    `${(pinnedOn.wedgedAt - pinnedOn.backingFrom).toFixed(2)} s apart`);
  /**
   * THE DETECTOR IS INERT WITHOUT A dt, AND SAYS SO. It is time-based and this project's rule is
   * that behaviour must not be a function of frame rate, so counting frames is not an option — but
   * a system silently never switched on is its most repeated defect, so the off state is reported
   * rather than being indistinguishable from "not stuck".
   */
  {
    const noDt = followPath(straight, { x: 0, z: 0, yaw: 0, speed: 0 }, { i: 0 });
    const withDt = followPath(straight, { x: 0, z: 0, yaw: 0, speed: 0 }, { i: 0 }, { dt: 1 / 8 });
    check('stuckFor is null with no dt and a number with one, which is how it says it is off',
      noDt.stuckFor === null && typeof withDt.stuckFor === 'number',
      `${noDt.stuckFor} / ${withDt.stuckFor}`);
    check('and a caller can see the manoeuvre it commands',
      typeof withDt.backing === 'boolean' && typeof withDt.wedged === 'boolean',
      `backing ${withDt.backing}, wedged ${withDt.wedged}`);
  }

  /**
   * 2. AND IT MUST NOT FIRE ON HONEST ACCELERATION. `STUCK_S` is 9.5 s because the car takes
   *    6.30 s to travel one body length from rest at the follower's own lowest commanded throttle
   *    (0.20) and the damage model's engine-power floor (0.25). Re-measured here rather than
   *    quoted, so a change to either module fails this instead of passing quietly.
   */
  {
    const worstHonest = (() => {
      const v = new Vehicle();
      const dm = new DamageModel();
      dm.regions.front = 0.9;              // enginePower bottoms at 0.25 past front damage 0.85
      v.damage = dm;
      const x0 = v.position.x, z0 = v.position.z;
      for (let k = 0; k < 300 * HZ; k++) {
        v.setControls({ throttle: 0.20, brake: 0, steer: 0 });
        v.stepFixed(DT, ground, HZ);
        if (Math.hypot(v.position.x - x0, v.position.z - z0) >= BODY_L) return k / HZ;
      }
      return Infinity;
    })();
    const clean = follow(straight, { dt: 1, seconds: 180, maxSpeed: 12 });
    console.log(`    honest acceleration from rest at throttle 0.20 and enginePower 0.25 covers ` +
      `one body length (${BODY_L} m) in ${worstHonest.toFixed(2)} s`);
    console.log(`    a clean 400 m straight from rest: i ${clean.i}/${clean.of}, moved ` +
      `${clean.moved.toFixed(0)} m in ${clean.seconds} s, worst stuckFor ` +
      `${clean.worstStuck.toFixed(2)} s, backing ${clean.backing}/${clean.n}`);
    check('the timeout is longer than the worst honest time to travel one body length',
      STUCK_S_CLAIMED > worstHonest,
      `${STUCK_S_CLAIMED} s against ${worstHonest.toFixed(2)} s`);
    check('and not so much longer that a stall is indistinguishable from a drive',
      STUCK_S_CLAIMED < worstHonest * 2.5,
      `${STUCK_S_CLAIMED} s against ${(worstHonest * 2.5).toFixed(2)} s`);
    check('a clean drive from rest never trips the detector',
      clean.backing === 0 && clean.worstStuck < STUCK_S_CLAIMED,
      `backing ${clean.backing}, worst stuckFor ${clean.worstStuck.toFixed(2)} s`);
    check('and that clean drive actually drove, or the check above is vacuous',
      clean.moved > 300, `${clean.moved.toFixed(0)} m`);
    check('the anchor resets on progress rather than accumulating over the drive',
      clean.worstStuck < STUCK_S_CLAIMED && clean.seconds > 30,
      `worst ${clean.worstStuck.toFixed(2)} s over ${clean.seconds} s of driving`);
    // The timeout must also be long enough to cover the case it was derived from, which is a
    // DAMAGED car: a check on an undamaged one would pass at a third of the value.
    check('the derivation uses the damaged car, which is the case that needs the room',
      worstHonest > 4, `${worstHonest.toFixed(2)} s at enginePower 0.25`);
  }

  /**
   * 3. THE DISTANCE IS ONE BODY LENGTH, and it is the vehicle's, not a number picked here.
   */
  check('the stuck distance is one car body length', Math.abs(BODY_L - 2 * HALF_EXTENT.z) < 1e-9,
    `${BODY_L} against ${2 * HALF_EXTENT.z}`);
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nROADPATH: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nROADPATH: PASS — ${checks.length} checks`);
