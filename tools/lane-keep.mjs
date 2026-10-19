#!/usr/bin/env node
// tools/lane-keep.mjs — #104's one open item, measured. The entry establishes that the crowd, the
// contact test and the router are each clean (0 of 57 struck pedestrians inside any carriageway,
// max 1.32 m of a 1.30 m bound, 0 of 2,012 lane points putting the car's centre on the pavement)
// and that 51 of 57 knockdowns had the car's BODY over the kerb and 35 its CENTRE. It concludes:
// "It is `followPath` leaving its own lane."
//
// NOTHING HAD MEASURED THE CROSS-TRACK ERROR. This does, against the lane the follower is
// actually tracking, and splits it by whether the course asked for a corner the car can take.
//
// THE ANSWER IS THAT LANE KEEPING IS NOT THE DEFECT:
//
//     where the course is within the car's envelope   p50 0.089 m   p90 1.298   body past the lane  6.4%
//     where it is TIGHTER than the car can turn       p50 1.266     p90 3.052   body past the lane 26.0%
//
// (Measured with every lane on the driver's LEFT, which is where `offsetRight` put it until #127.
// On the right: within the envelope p50 0.087 p90 1.286, 6.1% past the lane; tighter p50 1.289
// p90 2.996, 27.7%; and 443 of the 526 samples past the lane, 84%, at corners it cannot follow.
// The finding is the same finding, a few hundredths apart.)
//
// 411 of the 500 samples that put the body past the lane are at corners the car PHYSICALLY CANNOT
// FOLLOW — 82%. On course it can follow, the follower holds its lane to 9 cm at the median. So the
// lever is the course's corner geometry, which is `tour()`/the router, not the controller; and
// CLAUDE.md already records why those corners exist ("a graph junction is a point and a
// right-angle turn across it reads as 2 m") and already derives the crawl floor as the response.
//
// AND MORE SMOOTHING IS REFUSED, WITH A NUMBER. `tour()` takes `smoothPasses` and ships 2:
//
//     passes    0     1     2     3     5     8    12
//     under     4.3%  4.4%  4.9%  4.7%  4.4%  4.4%  4.4%     of course points under R_min(0)
//
// It is saturated, and the shipped value is the WORST of the seven. Smoothing pins its endpoints
// and redistributes a turn rather than widening it, so it cannot manufacture a radius the graph
// does not have. §4 gates that so the next round does not re-derive it.
//
// (That row is the LEFT side's too. On the right it reads 4.6 / 3.7 / 4.4 / 4.2 / 4.2 / 4.3 / 4.3%:
// still saturated from 2 passes up, 0 is the worst rather than 2, and ONE pass is the lowest —
// 3.7%, with a p10 corner of 8.8 m against the shipped 8.1. That is a lever this table had no
// reason to show before, worth measuring on the drive before anybody takes it.)
//
// RESTATED BY #61, WHICH ACTED ON THIS FILE'S FINDING. The lever it names — the course's corner
// geometry — is `filletCorners` now: every corner rounded to the car's turning circle at the speed
// it holds at the crawl, right turns driven on the centreline. On this file's own drive:
//
//                                         before #61          after
//     forced band p90                       2.778 m           0.958 m
//     forced, body past the lane            15.8%             0.0%
//     samples putting the body past it      414               0
//     course points under R_min(0)          36 of 816, 4.4%   4 of 801, 0.5%
//
// (The "before" column is the right side of the road and #128's follower; the tables above it are
// older still.) What survives is a relation — the forced band is still worse than the achievable
// one, p50 0.450 against 0.036 — and the smoothing refusal, which §4 now measures with the fillet
// off because smoothing alone is what it refuses, with the fillet's column printed beside it.
//
// TWO INSTRUMENT ERRORS ON THE WAY, and the second is #104's own defect recurring inside the
// probe for it:
//
//  1. A WINDOWED NEAREST-POINT SEARCH SNAPS. The first version searched +/-60 points at 4 m
//     spacing — +/-240 m of course — and CLAUDE.md's "nine ways" #6 records a 180 m jump from
//     exactly that wherever a route passes near itself. A snap UNDER-reports the error, which is
//     the flattering direction. §0 runs a +/-8 window beside the wide one and reports how often
//     they agree; measured, 98.3% to within 1 cm, and the tight window reads marginally LARGER.
//  2. BANDING BY THE MATCHED POINT CREDITS A STRAIGHT WITH A CORNER'S EXIT. Cross-track error at
//     a point is caused by the geometry LEADING INTO it, so a car still wide from a junction is
//     sampled where the matched point has become a straight. The two bandings disagree sharply:
//
//         straight (R > 200 m)   by the matched point   p50 0.222   p90 1.893
//                                by the preceding 40 m  p50 0.054   p90 0.815
//
//     That is #104's own classifier defect — a threshold applied to the wrong body — and it is
//     what made the straights look as though they had a tracking problem. §4 gates the disagreement.
//
// AND THE TWO FRACTIONS ARE DIFFERENT QUANTITIES, which is worth saying because they will
// otherwise be quoted interchangeably: **4.4% of course POINTS** turn tighter than the car's
// standstill minimum, while **53.3% of driven SAMPLES** sit within 40 m downstream of a corner
// tighter than the car's envelope AT ITS THEN-SPEED. The second is larger because one tight point
// taints the 10 points behind it and because `R_min(v)` grows with speed — 8.45 m at rest, 12.37
// at 50 km/h. The first is a property of the course; the second is why the error is spread much
// wider than the tight points are.
import { readFileSync } from 'node:fs';
import { RoadGraph, followPath, minTurnRadius, ROUTE_LANE_M, FILLET_R } from '../src/roadpath.js';
import { Vehicle, BODY_RADIUS, BODY_SAMPLES } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';

const SELFTEST = process.argv.includes('--selftest');
const HERE = new URL('.', import.meta.url).pathname;
/**
 * RUN THE REPORT ONLY AS THE MAIN MODULE. The first version gated it on `!SELFTEST` alone, so
 * `import { drive } from './lane-keep.mjs'` printed the whole forty-line report before the
 * importer's first statement — three of my own probes did that while measuring this. A tool whose
 * exports cannot be imported quietly is a tool nothing else can build on.
 */
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());
const district = JSON.parse(readFileSync(`${HERE}../data/district.json`, 'utf8'));
const blockers = new BlockerIndex(district);
const ground = new FlatGround(0);
const HZ = 120, DT = 1 / HZ;
const LANE_OFFSET = 3;                   // route-drive's own value, so the two agree by construction
const MAX_SPEED = 22;                    // followPath's default
const STRAIGHT_R = 200;                  // m: above this the course is effectively straight
const LOOKBACK = 10;                     // course points = 40 m at the tour's 4 m spacing

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

/** The local turn radius at each point of a densified course, off the course itself. */
export function radiiOf(pts) {
  const rad = new Float64Array(pts.length).fill(Infinity);
  for (let i = 1; i < pts.length - 1; i++) {
    const a = pts[i - 1], b = pts[i], c = pts[i + 1];
    const ab = Math.hypot(b[0] - a[0], b[1] - a[1]), bc = Math.hypot(c[0] - b[0], c[1] - b[1]);
    if (ab < 1e-6 || bc < 1e-6) continue;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    const dot = (b[0] - a[0]) * (c[0] - b[0]) + (b[1] - a[1]) * (c[1] - b[1]);
    const turn = Math.abs(Math.atan2(cross, dot));
    rad[i] = turn > 1e-4 ? (ab + bc) / 2 / turn : Infinity;
  }
  if (pts.length > 2) { rad[0] = rad[1]; rad[pts.length - 1] = rad[pts.length - 2]; }
  return rad;
}

/** Perpendicular distance from (x,z) to the course POLYLINE, within `win` points of `i`. */
export function crossTrack(pts, x, z, i, win = 8) {
  let best = Infinity, bestI = i;
  const lo = Math.max(0, i - win), hi = Math.min(pts.length - 1, i + win);
  for (let k = lo; k < hi; k++) {
    const ax = pts[k][0], az = pts[k][1];
    const dx = pts[k + 1][0] - ax, dz = pts[k + 1][1] - az;
    const L2 = dx * dx + dz * dz;
    if (L2 < 1e-12) continue;
    let t = ((x - ax) * dx + (z - az) * dz) / L2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const d = Math.hypot(x - (ax + dx * t), z - (az + dz * t));
    if (d < best) { best = d; bestI = k; }
  }
  return { d: best, i: bestI };
}

/**
 * How many points of a course turn tighter than the car's standstill minimum, and the clearance.
 * `filletR` 0 is the pipeline as it shipped before #61 — smoothing alone — which is what §4's
 * refusal is a statement about.
 */
export function courseShape(smoothPasses, filletR = FILLET_R) {
  const graph = new RoadGraph(district, { blockers, carRadius: BODY_RADIUS });
  const tour = graph.tour(district.meta.route.slice(1), { spacing: 4, offset: LANE_OFFSET, smoothPasses, filletR });
  const pts = tour.points;
  const rad = radiiOf(pts);
  const finite = [...rad].slice(1, -1);
  const under = finite.filter((r) => r < minTurnRadius(0)).length;
  // route-drive's STRONGER clearance test: a point holding a 0.95 m circle is not a point holding
  // a 4.3 m car oriented along the path. Its own first draft checked the circle, found 0, crashed.
  let bodyBlocked = 0;
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[Math.max(0, i - 1)], p2 = pts[Math.min(pts.length - 1, i + 1)];
    const dx = p2[0] - p0[0], dz = p2[1] - p0[1], L = Math.hypot(dx, dz) || 1;
    for (const sz of BODY_SAMPLES) {
      if (blockers.resolveCircle(pts[i][0] + (dx / L) * sz, pts[i][1] + (dz / L) * sz, BODY_RADIUS)) {
        bodyBlocked++; break;
      }
    }
  }
  return { tour, pts, rad, under, n: finite.length, bodyBlocked,
    frac: under / finite.length, length: tour.length };
}

/** Drive the shipped follower round the shipped tour, sampling the cross-track error. */
export function drive({ smoothPasses = 2, capS = 720, everyN = 10 } = {}) {
  const { tour, pts, rad } = courseShape(smoothPasses);
  const v = new Vehicle();
  v.blockers = blockers;                 // BODY COLLISION ON, so a kerb crossing is a real one
  v.position.set(pts[0][0], 0.55, pts[0][1]);
  const p1 = pts[Math.min(3, pts.length - 1)];
  v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 },
    Math.atan2(p1[0] - v.position.x, p1[1] - v.position.z));
  const st = { i: 0 };
  const rows = [];
  let steps = 0, reversing = 0, done = false;
  for (; steps < capS * HZ && !done; steps++) {
    const qn = v.quaternion;
    const yaw = Math.atan2(2 * (qn.w * qn.y + qn.x * qn.z), 1 - 2 * (qn.y ** 2 + qn.x ** 2));
    // PLANAR, not `v.speed`: CLAUDE.md records `vehicle.speed` as three-dimensional and carrying
    // up to 1.82 m/s of suspension on a teleported car.
    const planar = Math.hypot(v.velocity.x, v.velocity.z);
    const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: planar },
      st, { maxSpeed: MAX_SPEED, dt: DT });
    if (f.done) { done = true; break; }
    if (f.reversing) reversing++;
    v.setControls(f.controls);
    v.stepFixed(DT, ground, HZ);
    if (steps % everyN === 0) {
      const fi = f.i ?? st.i;
      const tight = crossTrack(pts, v.position.x, v.position.z, fi, 8);
      const wide = crossTrack(pts, v.position.x, v.position.z, fi, 60);
      let behind = Infinity;
      for (let k = Math.max(0, tight.i - LOOKBACK); k <= tight.i; k++) behind = Math.min(behind, rad[k]);
      rows.push({ d: tight.d, dWide: wide.d, i: tight.i, rad: rad[tight.i], radBehind: behind,
        v: planar, steer: f.controls.steer ?? 0, step: steps, lag: Math.abs(tight.i - fi) });
    }
  }
  if (!rows.length) throw new Error('0 samples: nothing was driven, so there is nothing to report');
  return { rows, steps, reversing, done, tour, pts };
}

// ------------------------------------------------------------------------------------- the report
if (!SELFTEST && IS_MAIN) {
  console.log('LANE KEEP — #104\'s open item\n');
  const { rows, steps, reversing, done, tour } = drive();
  const n = rows.length;
  console.log(`the shipped tour: ${tour.length.toFixed(0)} m, ${tour.points.length} points, `
    + `lane offset ${LANE_OFFSET} m (ROUTE_LANE_M is ${ROUTE_LANE_M})`);
  console.log(`drove ${steps} steps = ${(steps * DT).toFixed(0)} s, ${n} samples at ${(HZ / 10).toFixed(0)} Hz, `
    + `${reversing} reverse frames, ${done ? 'completed the tour' : 'HIT THE CAP'}\n`);

  console.log('=== (0) IS THE INSTRUMENT SNAPPING? ===\n');
  const agree = rows.filter((r) => Math.abs(r.d - r.dWide) < 0.01).length;
  console.log(`  +/-8 against +/-60 point windows agree to 1 cm on ${agree} of ${n}`
    + `  ${(100 * agree / n).toFixed(1)}%`);
  console.log(`  tight window  p50 ${q(rows.map((r) => r.d), 0.5).toFixed(3)}`
    + `  max ${Math.max(...rows.map((r) => r.d)).toFixed(3)} m`);
  console.log(`  wide window   p50 ${q(rows.map((r) => r.dWide), 0.5).toFixed(3)}`
    + `  max ${Math.max(...rows.map((r) => r.dWide)).toFixed(3)} m`);
  console.log('  A snap under-reports, which is the flattering direction, so the tight window is');
  console.log('  what the rest of this report uses.\n');

  console.log('=== (1) THE CROSS-TRACK ERROR ===\n');
  const ds = rows.map((r) => r.d);
  console.log(`  the car's CENTRE from the lane it is tracking:`
    + `  p50 ${q(ds, 0.5).toFixed(3)}  p90 ${q(ds, 0.9).toFixed(3)}`
    + `  p99 ${q(ds, 0.99).toFixed(3)}  max ${Math.max(...ds).toFixed(3)} m`);
  console.log(`  the body EDGE is a further BODY_RADIUS ${BODY_RADIUS} m out.\n`);

  console.log('=== (2) BANDED TWO WAYS, and the second is the honest one ===\n');
  console.log('  band                                       samples     p50      p90      max   mean km/h');
  for (const key of ['rad', 'radBehind']) {
    for (const [name, lo, hi] of [['straight', STRAIGHT_R, Infinity], ['gentle  ', 50, STRAIGHT_R],
      ['real    ', 20, 50], ['tight   ', 0, 20]]) {
      const g = rows.filter((r) => r[key] > lo && r[key] <= hi);
      const label = `${key === 'rad' ? 'matched point' : 'preceding 40 m'}: ${name}`;
      if (!g.length) { console.log(`  ${label.padEnd(42)} ${String(0).padStart(7)}`); continue; }
      const gd = g.map((r) => r.d);
      console.log(`  ${label.padEnd(42)} ${String(g.length).padStart(7)}`
        + `   ${q(gd, 0.5).toFixed(3)}    ${q(gd, 0.9).toFixed(3)}    ${Math.max(...gd).toFixed(3)}`
        + `     ${(g.reduce((s, r) => s + r.v, 0) / g.length * 3.6).toFixed(1)}`);
    }
  }
  console.log('\n  Banding by the MATCHED point credits a straight with the exit of the corner before');
  console.log('  it. That is #104\'s own classifier defect, and it is what made the straights look');
  console.log('  as though they had a tracking problem.\n');

  console.log('=== (3) WAS THE CORNER ACHIEVABLE AT ALL? ===\n');
  console.log(`  R_min at rest ${minTurnRadius(0).toFixed(2)} m, at 20 km/h ${minTurnRadius(20 / 3.6).toFixed(2)},`
    + ` at 50 km/h ${minTurnRadius(50 / 3.6).toFixed(2)} m — it GROWS with speed\n`);
  const forced = rows.filter((r) => r.radBehind < minTurnRadius(r.v));
  const able = rows.filter((r) => r.radBehind >= minTurnRadius(r.v));
  const over = (g) => g.filter((r) => r.d + BODY_RADIUS > LANE_OFFSET).length;
  for (const [name, g] of [['TIGHTER than the car can turn', forced], ["within the car's envelope", able]]) {
    const gd = g.map((r) => r.d);
    console.log(`  ${name.padEnd(32)} ${String(g.length).padStart(5)}`
      + `  p50 ${q(gd, 0.5).toFixed(3)}  p90 ${q(gd, 0.9).toFixed(3)}  max ${Math.max(...gd).toFixed(3)} m`
      + `   body past the lane ${(100 * over(g) / g.length).toFixed(1)}%`);
  }
  const totOver = over(rows);
  console.log(`\n  ${over(forced)} of ${totOver} samples that put the body past the lane`
    + ` (${(100 * over(forced) / totOver).toFixed(0)}%) are at corners the car cannot follow.`);
  console.log(`  On course it CAN follow, the follower holds its lane to`
    + ` ${q(able.map((r) => r.d), 0.5).toFixed(3)} m at the median.`);
  console.log('\n  SO LANE KEEPING IS NOT THE DEFECT #104 IMPLIED. The lever is the course\'s corner');
  console.log('  geometry — `tour()` and the router — and CLAUDE.md already records why those');
  console.log('  corners exist and already derives the crawl floor as the response to them.');

  console.log('\n=== (4) AND MORE SMOOTHING IS REFUSED — the fillet does what it could not (#61) ===\n');
  console.log('                 SMOOTHING ALONE (as shipped before #61)            WITH THE FILLET');
  console.log('  passes   points   radius p10   under R_min(0)   body blocked    radius p10   under R_min(0)   body blocked');
  const fracs = [];
  for (const p of [0, 1, 2, 3, 5, 8, 12]) {
    const c = courseShape(p, 0), f = courseShape(p);
    fracs.push({ p, frac: c.frac });
    const finite = [...c.rad].slice(1, -1).filter((r) => Number.isFinite(r));
    const ffin = [...f.rad].slice(1, -1).filter((r) => Number.isFinite(r));
    console.log(`  ${String(p).padStart(6)}   ${String(c.pts.length).padStart(6)}`
      + `   ${q(finite, 0.1).toFixed(1).padStart(9)}`
      + `   ${String(c.under).padStart(4)} of ${String(c.n).padStart(4)} ${(100 * c.frac).toFixed(1).padStart(4)}%`
      + `   ${String(c.bodyBlocked).padStart(5)}`
      + `        ${q(ffin, 0.1).toFixed(1).padStart(9)}`
      + `   ${String(f.under).padStart(4)} of ${String(f.n).padStart(4)} ${(100 * f.frac).toFixed(1).padStart(4)}%`
      + `   ${String(f.bodyBlocked).padStart(5)}`);
  }
  // COMPUTED, because the sentence it replaces — "the SHIPPED value of 2 is the worst of the
  // seven" — was a reading of the course with every lane on the driver's LEFT, and the first run
  // on the right side made it false (#127). A conclusion printed as a literal is a check that
  // cannot fail.
  const worst = fracs.reduce((a, b) => (b.frac > a.frac ? b : a));
  const best = fracs.reduce((a, b) => (b.frac < a.frac ? b : a));
  const spread = (worst.frac - best.frac) * 100;
  console.log(`\n  ${spread.toFixed(1)} points between the best (${best.p} passes, ${(100 * best.frac).toFixed(1)}%)`
    + ` and the worst (${worst.p}, ${(100 * worst.frac).toFixed(1)}%). Smoothing pins its endpoints and`);
  console.log('  redistributes a turn rather than widening it, so it cannot manufacture a radius the');
  console.log('  graph does not have.');
}

// ------------------------------------------------------------------------------------- selftest
/**
 * AND SO MUST THE SELFTEST BE. Gating only the REPORT on IS_MAIN fixes half of it: a tool that
 * imports this one while itself running with `--selftest` runs THIS selftest instead, and the
 * block ends in `process.exit`, so the importing tool's own checks never print. That is exactly
 * what tools/shunt-rate.mjs saw on its first run -- it imports tools/lane-keep.mjs, and
 * `node tools/shunt-rate.mjs --selftest` printed `LANE KEEP SELFTEST: PASS` and stopped. Both
 * blocks need both conditions.
 */
if (SELFTEST && IS_MAIN) {
  console.log('LANE KEEP SELFTEST\n');

  // 1. R_min comes off the module and GROWS with speed, which is what makes §3's test per-sample
  //    rather than against one constant. A build that made it constant would read every corner
  //    as achievable at speed.
  check('R_min is read off the module and grows with speed',
    minTurnRadius(0) > 8 && minTurnRadius(20) > minTurnRadius(0) + 4,
    `${minTurnRadius(0).toFixed(2)} at rest, ${minTurnRadius(20).toFixed(2)} at 20 m/s`);

  // 2. THE DRIVE HAPPENED. A check whose two sides are both zero is not a check, and every
  //    percentage below is a fraction of this.
  const { rows, done, steps } = drive({ capS: 400 });
  check('the follower drove and the tour completed', done && rows.length > 500,
    `${rows.length} samples over ${(steps / HZ).toFixed(0)} s, done ${done}`);

  // 3. THE SNAP CHECK, which is the instrument's own control. The two windows must agree on the
  //    large majority; if they diverge the nearest-point search is selecting a different part of
  //    the course and every error below is under-reported.
  const agree = rows.filter((r) => Math.abs(r.d - r.dWide) < 0.01).length;
  check('the tight and wide nearest-point windows agree, so no snap is in play',
    agree / rows.length > 0.9, `${(100 * agree / rows.length).toFixed(1)}% to within 1 cm`);

  // 4. THE BANDING DISAGREEMENT IS THE FINDING, so it is asserted rather than described. If the
  //    two bandings agreed, the look-back would be doing nothing and §2 would be vacuous.
  const strA = rows.filter((r) => r.rad > STRAIGHT_R).map((r) => r.d);
  const strB = rows.filter((r) => r.radBehind > STRAIGHT_R).map((r) => r.d);
  check('banding by the matched point reads a WORSE straight than banding by the course driven',
    strA.length > 50 && strB.length > 50 && q(strA, 0.9) > q(strB, 0.9) * 1.5,
    `p90 ${q(strA, 0.9).toFixed(3)} by the point against ${q(strB, 0.9).toFixed(3)} by the 40 m behind`);

  // 5. AND THE POSITIVE HALF: on course the car CAN follow, the error is small. A follower that
  //    had lost the path entirely would fail this while still passing check 4.
  const able = rows.filter((r) => r.radBehind >= minTurnRadius(r.v)).map((r) => r.d);
  check('on course within the car\'s envelope the follower holds its lane',
    able.length > 100 && q(able, 0.5) < 0.5,
    `p50 ${q(able, 0.5).toFixed(3)} m over ${able.length} samples`);

  // 6. AND THE FORCED HALF IS WORSE, which is the whole relocation. Both directions, because
  //    "the error is all in the corners" is the claim and either side alone does not say it.
  const forced = rows.filter((r) => r.radBehind < minTurnRadius(r.v)).map((r) => r.d);
  check('and it is materially worse where the course is tighter than it can turn',
    forced.length > 100 && q(forced, 0.5) > q(able, 0.5) * 3,
    `p50 ${q(forced, 0.5).toFixed(3)} against ${q(able, 0.5).toFixed(3)} m`);

  // 7. THE FORCED BAND'S OWN MAGNITUDE, which is the check that catches `corner-now` — and the
  //    reason the six above do not. Every one of them asserts a RELATIONSHIP (the forced band is
  //    worse than the achievable one, the matched-point banding reads worse than the honest one),
  //    and removing the corner-speed ceiling makes all three hold HARDER. Measured both ways:
  //
  //                                    shipped   corner-now
  //        forced band p90              3.052      7.065     x2.3
  //        forced band max              4.411      8.802     x2.0
  //        forced, body past the lane   25.9%      42.1%
  //        ACHIEVABLE band p90          1.187      1.169     unmoved
  //        achievable, body past lane   6.5%       6.5%      88 of ~1361 BOTH times
  //
  //    RESTATED BY #127 — the table above is the driver's LEFT. On the right, the row re-run:
  //
  //                                    shipped   corner-now
  //        forced band p90              2.996      7.609     x2.5
  //        forced band max              4.531      9.741     x2.1
  //        forced, body past the lane   27.7%      44.5%
  //        ACHIEVABLE band p90          1.286      1.314     unmoved to 0.03
  //        achievable, body past lane   6.1%       6.4%
  //
  //    The achievable half being byte-for-byte unmoved is what says the ceiling is about corners
  //    the car cannot geometrically make, which is the crawl-floor argument from the other side.
  //
  //    The bound is 5.0 m and it is PICKED, in the middle of a measured 2.3x gap with nothing in
  //    between: the drive is deterministic (no RNG, fixed course and start) and reproduces
  //    p90 3.051808 / max 4.410706 to six decimals across runs, so the shipped side carries no
  //    spread at all. (On the right side: p90 2.995835 / max 4.530818, twice, and the gap is 2.5x —
  //    5.0 is x1.67 above the shipped figure and x1.52 below corner-now's.) That is the only kind of absolute bound this project considers writable,
  //    and both figures are printed beside it so a retune has to come here and restate them.
  //
  //    RESTATED BY #61, WHICH TOOK THIS CHECK'S TEETH. With the corners rounded to the car's turning
  //    circle the forced band shrinks both ways, and `corner-now` reads p90 1.854 — UNDER the old
  //    5.0, so the bound that existed to catch it passed it. Re-measured, same deterministic drive:
  //
  //                                    shipped (#61)   corner-now
  //        forced band p90                 0.958          1.854     x1.94
  //
  //    1.35 sits in that gap with nothing in between, x1.41 above the shipped figure and x1.37 below
  //    the mutation's — the same kind of bound, restated rather than loosened, in the commit that
  //    moved both sides of it.
  const fP90 = q(forced, 0.9);
  check('the forced band stays under the ceiling the corner-speed term holds it to',
    fP90 < 1.35, `p90 ${fP90.toFixed(3)} m against 1.35; with #61's fillet shipped reads 0.958 and `
    + `corner-now reads 1.854, so the bound sits in a 1.94x gap`);

  // 8. THE SMOOTHING REFUSAL, gated so a future round does not re-derive it. Measured 4.3% at 0
  //    passes and 4.4% at 12, with the shipped 2 the worst at 4.9%. It is a statement about
  //    smoothing ALONE, so it is measured with #61's fillet off (`filletR` 0): with it on, these
  //    three read 0.9 / 0.5 / 0.7% and say nothing about Chaikin.
  const s0 = courseShape(0, 0), s2 = courseShape(2, 0), s12 = courseShape(12, 0);
  check('more smoothing does not reduce the sub-R_min corners',
    s12.frac > s0.frac * 0.8,
    `${(100 * s0.frac).toFixed(1)}% at 0 passes, ${(100 * s2.frac).toFixed(1)}% at 2 (shipped), `
    + `${(100 * s12.frac).toFixed(1)}% at 12`);
  check('and no amount of it puts the car body through a wall either, so the refusal is not a trade',
    s0.bodyBlocked === 0 && s12.bodyBlocked === 0,
    `${s0.bodyBlocked} and ${s12.bodyBlocked} body-blocked points`);
  // 8b. AND THE FILLET DOES WHAT IT COULD NOT (#61): under a third of the best smoothing count's
  //     fraction, at the shipped two passes, with the car body still clear of every wall. The
  //     smoothing column is the KNOWN-BAD, measured in the same breath.
  const f2 = courseShape(2);
  const bestSmooth = Math.min(s0.frac, s2.frac, s12.frac, courseShape(1, 0).frac);
  check('the fillet takes the course under a third of what any amount of smoothing reached, and clear',
    f2.frac < bestSmooth / 3 && f2.bodyBlocked === 0,
    `${(100 * f2.frac).toFixed(2)}% filleted against smoothing's best ${(100 * bestSmooth).toFixed(1)}%, `
    + `${f2.bodyBlocked} body-blocked points`);

  // 9. An empty population throws rather than reporting a percentile of nothing.
  let threw = false;
  try { q([], 0.5); } catch { threw = true; }
  check('a percentile of an empty population throws', threw);

  console.log(`\nLANE KEEP SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
