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
  resample, smooth, minRadius, worstGap, offsetRight, pathCurvature, ARC_WINDOW } from '../src/roadpath.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';

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
  check('and it commands it in a consistent direction',
    Math.sign(f.controls.steer) === Math.sign(f.err) || f.err === 0);
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

// (e) The crawl floor, which is a design decision and not a fudge.
console.log(`    cornerSpeed floor: ${(cornerSpeed(1) * 3.6).toFixed(1)} km/h for a corner the car cannot hold`);
check('an impossible corner still gets a crawl speed, not a standstill', cornerSpeed(1) > 2,
  `${cornerSpeed(1)}`);
check('the floor is at or under the damage model\'s free threshold, so a contact there is free',
  cornerSpeed(1) <= 2.2 + 1e-9, `${cornerSpeed(1)}`);

// ---------------------------------------------------------------------------
// §6  The lane offset, and the road that is narrower than it.
// ---------------------------------------------------------------------------
console.log('\n§6  The lane offset');
const straight = [[0, 0, 0], [4, 0, 0], [8, 0, 0], [12, 0, 0]];
const right = offsetRight(straight, 3);
console.log(`    a line along +x offset 3 m right: (${right[1][0]}, ${right[1][1]})`);
check('right of a +x heading is -z', near(right[1][1], -3, 1e-9), `${right[1][1]}`);
const shifted = offsetRight([[0, 0, 0], [0, 4, 0], [0, 8, 0]], 3);
check('right of a +z heading is +x', near(shifted[1][0], 3, 1e-9), `${shifted[1][0]}`);
check('the per-point form is used where given',
  near(offsetRight(straight, 3, () => 1)[1][1], -1, 1e-9));
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
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nROADPATH: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nROADPATH: PASS — ${checks.length} checks`);
