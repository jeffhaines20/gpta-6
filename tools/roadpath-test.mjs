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
import { RoadGraph, followPath, pathSpeedLimit, steerableSpeed, CORNER,
  resample, smooth, minRadius, worstGap, offsetRight, pathCurvature, ARC_WINDOW } from '../src/roadpath.js';
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
  threePoint < CORNER.wheelbase, `${threePoint.toFixed(2)} m`);
// 7.6 m, not 0.38: over the 12 m the window spans, that shape genuinely does turn 90
// degrees, so a radius of about 7.6 m is the right answer and not a large one. The claim
// being tested is that the reading is a corner a car can take, not that the corner vanishes.
check('the arc window sees a corner a car can take', arcBased.radius > CORNER.wheelbase,
  `${arcBased.radius.toFixed(1)} m against a ${CORNER.wheelbase} m wheelbase`);
check('and a speed it can take it at', steerableSpeed(arcBased.radius) > 5,
  `${(steerableSpeed(arcBased.radius) * 3.6).toFixed(0)} km/h`);
// And the consequence: the bad reading is ACTIONABLE.
console.log(`      a ${threePoint.toFixed(2)} m radius is steerable at ${(steerableSpeed(threePoint) * 3.6).toFixed(0)} km/h`);
check('KNOWN-BAD: which is why the limiter demanded a standstill', steerableSpeed(threePoint) === 0);
check('the district course has no such artefact',
  minRadius(tour.points).radius > CORNER.wheelbase,
  `${minRadius(tour.points).radius.toFixed(2)} m`);
console.log(`    the district course's tightest corner: ${minRadius(tour.points).radius.toFixed(2)} m, ` +
  `steerable at ${(steerableSpeed(minRadius(tour.points).radius) * 3.6).toFixed(0)} km/h`);

// ---------------------------------------------------------------------------
// §5  Two ceilings, and the one the first draft did not have.
// ---------------------------------------------------------------------------
console.log('\n§5  Grip is not the only corner ceiling');
console.log('    radius   grip     steering   binding');
for (const r of [4, 5, 6, 8, 10, 20, 40]) {
  const grip = Math.sqrt(CORNER.useful * r), steer = steerableSpeed(r);
  console.log(`    ${String(r).padStart(5)} m  ${(grip * 3.6).toFixed(0).padStart(4)} km/h  ` +
    `${(steer * 3.6).toFixed(0).padStart(5)} km/h   ${steer < grip ? 'STEERING' : 'grip'}`);
}
check('the corner budget is derived from src/vehicle.js\'s own constants',
  CORNER.grip === 1.15 && CORNER.gravity === 19.6 && CORNER.maxSteer === 0.55);
check('steering binds below 6 m of radius', steerableSpeed(5) < Math.sqrt(CORNER.useful * 5));
check('grip binds above 10 m of radius', steerableSpeed(10) > Math.sqrt(CORNER.useful * 10));
check('a radius under the wheelbase is not steerable at any speed', steerableSpeed(1) === 0);
let steerMono = true;
for (let r = 4.5; r < 60; r += 0.5) if (steerableSpeed(r + 0.5) < steerableSpeed(r)) steerMono = false;
check('steerable speed is monotonic in radius', steerMono);
// The speed limiter obeys both, and brakes early enough to stop.
const tight = [];
for (let x = 0; x <= 120; x += 4) tight.push([x, 0, 0]);
for (let z = -4; z >= -60; z -= 4) tight.push([120, z, 0]);
const far = pathSpeedLimit(tight, 0, 22, 22);
const close = pathSpeedLimit(tight, 27, 22, 22);
console.log(`    120 m before a right-angle turn: limit ${(far * 3.6).toFixed(0)} km/h;  ` +
  `12 m before it: ${(close * 3.6).toFixed(0)} km/h`);
check('the limiter is unrestricted far from a corner', near(far, 22, 0.01), `${far}`);
check('and restricts near one', close < 22 * 0.9, `${close}`);
check('the restriction leaves enough room to stop',
  (close * close - steerableSpeed(8) ** 2) / (2 * CORNER.useful) < 40,
  `${((close * close) / (2 * CORNER.useful)).toFixed(1)} m of braking distance`);

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
