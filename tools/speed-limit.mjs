#!/usr/bin/env node
// tools/speed-limit.mjs — prices #107, "should this district have a speed limit", in the one unit
// that decides it: what filing `reckless` would COST an ordinary drive.
//
// WHAT THE ENTRY GOT WRONG, and both halves matter:
//
//   1. It says a limit would have to be DERIVED and lists three candidates, "none measured", the
//      first being "the traffic fleet's own distribution ... src/traffic.js owns it". The module
//      owns more than a distribution: `_speedLimit(edgeIdx)` is a DECLARED limit per road class,
//      keyed off the baked graph's own `r` field, shipped since the fleet was. So `reckless` has a
//      limit to break, nothing has to be invented, and `damage-test`'s pin — "reckless driving,
//      WHICH HAS NO SPEED LIMIT TO BREAK" — is false. CLAUDE.md already says to grep the module
//      for the mechanism you are about to build; this is the third instance in that file's record.
//
//   2. It argues for the limit on the grounds that `reckless` "is floorless: it accumulates
//      through the soft knee and NEVER ON ITS OWN MAKES YOU WANTED". The first clause is right and
//      the second is false. `FLOORLESS_CAP`'s knee bounds each DELTA at 1; `reportCrime` does
//      `max(heat + delta, c.min)`, so the TOTAL is not bounded by it at all. Three charges at
//      scale 1 are one star in 6.1 s and sixty seconds of them are five stars. §3c is that
//      known-bad, and it is why a limit is a punishment rather than the graduation #103 asked for.
//
// TWO WRONG VERSIONS, kept because each printed a reassuring number:
//
//   §1 first printed a "net of bleed" column as `gross - idleBleed`, reading -0.0567 heat/s at
//   scale 0.25 beside a MODULE-MEASURED "1 star at 60.4 s". A negative net cannot reach a star at
//   all, so the two columns contradicted each other and the ARITHMETIC one was wrong: `idleBleed`
//   is GATED on `this.time - this._lastCrimeAt > this.idleGrace`, and a charge every `refractory`
//   leaves only `refractory - idleGrace` of each window bleeding. The duty cycle is the quantity,
//   it is 16.7% at this cadence, and it is MEASURED off the module here rather than computed.
//
//   §2 first took percentiles of `cornerSpeed(local radius)` over all 1,452 interior course points
//   and printed p50 110 km/h, p90 1,474, max 10,458. Those are the straights. A corner ceiling is
//   not a district limit, and a percentile over a population that is mostly unconstrained measures
//   the straights rather than the corners — CLAUDE.md's "check your sampling can resolve what you
//   assert", arriving as a statistic of the wrong population.
//
//   And §3b read 0 car-samples and printed a NaN percentile, because it put the player at
//   (1e6, 1e6) and `_spawn` rejects a start outside 70-260 m of the target: no car can exist near a
//   player who is not in the city. That is "a gate that constructs the subject itself has to
//   construct it the way the game does", arriving through the player's POSITION. It throws on an
//   empty population now rather than reporting a percentile of nothing.
import { readFileSync } from 'node:fs';
import { RoadGraph, followPath } from '../src/roadpath.js';
import { CRIMES, WantedSystem } from '../src/wanted.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { Traffic } from '../src/traffic.js';

const SELFTEST = process.argv.includes('--selftest');
const HERE = new URL('.', import.meta.url).pathname;
const C = CRIMES.reckless;
const W0 = new WantedSystem();
const GRACE = W0.idleGrace, BLEED = W0.idleBleed;
const ground = new FlatGround();
const DT = 1 / 120;
const FLEET_JITTER_MAX = 1.15;          // src/traffic.js: `_speedLimit(e) * (0.85 + _r() * 0.3)`
const FOLLOW_CAP = 22;                  // src/roadpath.js followPath's default maxSpeed, m/s

const kmh = (v) => (v * 3.6).toFixed(1);
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

// --------------------------------------------------------------------- the module, driven straight
/** Seconds of continuous `reckless` at `scale` before the meter reads `stars`, or null. */
export function secondsToStars(scale, stars = 1, capS = 600) {
  const w = new WantedSystem();
  const far = { x: 1e6, z: 1e6, speed: 30, seen: false };
  let lastCharge = -Infinity, firstDelta = null, bled = 0, t = 0;
  for (; t < capS; t += 0.1) {
    if (t - lastCharge >= C.refractory) {
      const h0 = w.heat;
      const r = w.reportCrime('reckless', { scale, at: { x: 0, z: 0 } });
      if (r && r.applied) { lastCharge = t; if (firstDelta === null) firstDelta = w.heat - h0; }
    }
    const hBefore = w.heat;
    w.update(0.1, far);                 // 0.1 s slices: `update` clamps dt at maxDt, so one big
    if (w.heat < hBefore) bled += hBefore - w.heat;   // step would silently stop the clock
    if (w.stars >= stars) return { t, delta: firstDelta, bledPerS: bled / Math.max(t, 0.1), heat: w.heat };
  }
  return { t: null, delta: firstDelta, bledPerS: bled / capS, heat: w.heat };
}

/** The scale below which continuous `reckless` can never reach one star. Bisected off the module. */
export function breakEvenScale(lo = 0.01, hi = 0.5, iters = 24) {
  for (let i = 0; i < iters; i++) {
    const mid = (lo + hi) / 2;
    if (secondsToStars(mid, 1, 1200).t === null) lo = mid; else hi = mid;
  }
  return hi;
}

// --------------------------------------------------------------------------------- the two drives
const district = JSON.parse(readFileSync(`${HERE}../data/district.json`, 'utf8'));
const roads = new RoadGraph(district);
const limitRig = new Traffic({ add() {} }, district, { count: 1 });
/** The district's own declared limit for an edge, read off the module rather than copied. */
export const limitOf = (i) => limitRig._speedLimit(i);

function edgeLength(i) {
  const e = district.edges[i];
  let l = 0;
  for (let k = 0; k < e.v.length - 1; k++) {
    const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
    l += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return l;
}

/**
 * The shipped follower on the shipped vehicle, over long cross-district routes, each sample scored
 * against the limit of the road it is ON — which is the quantity a rule would read, not a district
 * average. `roads.path()` carries the edge index per point, so the lookup needs no re-projection.
 *
 * THIS IS NOT A PLAYER AND IT IS A ONE-SIDED BOUND. `followPath` caps at 22 m/s = 79.2 km/h and
 * the vehicle will do 140, so a human is at least this fast: the over-the-limit fraction below is
 * a FLOOR on what a player would earn, not an estimate of it.
 */
export function driveSamples(nRoutes = 8, capS = 180) {
  const verts = district.verts;
  const out = [];
  let dist = 0, routes = 0;
  for (let seed = 0; seed < nRoutes; seed++) {
    const a = Math.floor((seed / nRoutes) * verts.length);
    let best = -1, bd = -1;
    for (let b = 0; b < verts.length; b += 7) {
      const d = Math.hypot(verts[a].x - verts[b].x, verts[a].z - verts[b].z);
      if (d > bd) { bd = d; best = b; }
    }
    let r = null;
    try { r = roads.path(verts[a].x, verts[a].z, verts[best].x, verts[best].z); } catch { continue; }
    if (!r || !r.points || r.points.length < 8) continue;
    const pts = r.points.map((p) => [p[0], p[1]]);
    const edgeAt = r.points.map((p) => p[2]);
    const v = new Vehicle();
    v.position.set(pts[0][0], 0.55, pts[0][1]);
    const yaw0 = Math.atan2(pts[1][0] - pts[0][0], pts[1][1] - pts[0][1]);
    v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw0);
    const st = { i: 0 };
    let px = v.position.x, pz = v.position.z;
    for (let k = 0; k < capS * 120; k++) {
      const qn = v.quaternion;
      const yaw = Math.atan2(2 * (qn.w * qn.y + qn.x * qn.z), 1 - 2 * (qn.y ** 2 + qn.x ** 2));
      // PLANAR, not `v.speed`: `vehicle.speed` is `velocity.length()` and carries the suspension's
      // vertical term, which CLAUDE.md records at up to 1.82 m/s on a teleported car.
      const planar = Math.hypot(v.velocity.x, v.velocity.z);
      const f = followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: planar }, st, { dt: DT });
      v.setControls(f.controls);
      v.stepFixed(DT, ground, 120);
      dist += Math.hypot(v.position.x - px, v.position.z - pz);
      px = v.position.x; pz = v.position.z;
      if (k % 12 === 0) {                                   // 10 Hz
        const ei = edgeAt[Math.min(st.i, edgeAt.length - 1)];
        if (Number.isInteger(ei) && ei >= 0 && ei < district.edges.length) {
          const lim = limitOf(ei);
          out.push({ v: planar, limit: lim, excess: planar - lim, ratio: planar / lim });
        }
      }
      if (st.i >= pts.length - 2) break;
    }
    routes++;
  }
  if (!out.length) throw new Error('0 drive samples: nothing was driven, so there is nothing to report');
  return { samples: out, dist, routes };
}

/**
 * The fleet's own speed against its own road's limit — the SECOND PROTOCOL, and the check on §3's
 * denominator. By construction a car's target is `_speedLimit(e) * (0.85 + r * 0.3)`, so a correct
 * reading cannot exceed x1.15; a ratio past that would mean the limit is being looked up for the
 * wrong edge, which is the one way this measurement can be wrong without looking wrong.
 */
export function fleetSamples(windowS = 120, settleS = 20, count = 30) {
  const tr = new Traffic({ add() {} }, district, { count });
  const sp = district.meta.spawn;
  const at = { x: sp.x ?? sp[0], y: 0.55, z: sp.z ?? sp[1] };
  const vels = [], ratios = [];
  for (let k = 0; k < windowS * 120; k++) {
    tr.update(DT, at);
    if (k % 60 === 0 && k > settleS * 120) {                // 2 Hz after the settle
      for (const car of tr.cars) {
        if (!car) continue;
        vels.push(car.v);
        const L = limitOf(car.edge);
        if (L > 0) ratios.push(car.v / L);
      }
    }
  }
  if (!vels.length || !ratios.length) {
    throw new Error('0 car-samples: the fleet never spawned, so there is nothing to report');
  }
  return { vels, ratios };
}

// ------------------------------------------------------------------------------------- the report
if (!SELFTEST) {
  console.log('SPEED LIMIT — pricing #107\n');
  console.log(`reckless: heat ${C.heat}, refractory ${C.refractory} s, cool ${C.cool}, `
    + `min ${C.min === 0 ? 'NONE (floorless)' : C.min}`);
  console.log(`idle bleed ${BLEED} heat/s, GATED on ${GRACE} s since the last crime\n`);

  console.log('=== (1) WHAT CONTINUOUS reckless COSTS ===\n');
  console.log(`A charge every ${C.refractory} s, driven through the module in 0.1 s slices. The bleed only`);
  console.log(`runs after ${GRACE} s with no new crime, so at this cadence it is live for`);
  console.log(`(${C.refractory} - ${GRACE})/${C.refractory} = ${((C.refractory - GRACE) / C.refractory * 100).toFixed(1)}% of the time and sheds `
    + `${(BLEED * (C.refractory - GRACE)).toFixed(4)} per cycle, not ${(BLEED * C.refractory).toFixed(4)}.`);
  console.log('The bled column is MEASURED off the module, which is how the wrong version was caught:\n');
  console.log('  scale   heat/charge   gross heat/s   bled/s (measured)   to 1 star   to 2 stars');
  for (const scale of [0.1, 0.25, 0.5, 1, 2]) {
    const one = secondsToStars(scale, 1);
    const two = secondsToStars(scale, 2);
    const gross = (one.delta ?? 0) / C.refractory;
    console.log(`  ${String(scale).padStart(5)}   ${(one.delta ?? 0).toFixed(4).padStart(11)}`
      + `   ${gross.toFixed(4).padStart(12)}   ${one.bledPerS.toFixed(4).padStart(17)}`
      + `   ${(one.t === null ? 'never' : one.t.toFixed(1) + ' s').padStart(11)}`
      + `   ${(two.t === null ? 'never' : two.t.toFixed(1) + ' s').padStart(10)}`);
  }
  const BE = breakEvenScale();
  console.log(`\n  BREAK-EVEN ${BE.toFixed(4)}: below this scale continuous reckless NEVER reaches one star,`);
  console.log(`  however long you speed — the gated bleed cancels it. Below it the crime is a cue with`);
  console.log(`  no consequence; above it, twenty minutes of merely bad driving IS a felony, which is`);
  console.log(`  the thing the bleed's own comment exists to prevent. It is the design number here.`);

  console.log('\n=== (2) THE LIMIT THE DISTRICT ALREADY DECLARES ===\n');
  const byLimit = new Map();
  let total = 0;
  for (let i = 0; i < district.edges.length; i++) {
    const L = limitOf(i), m = edgeLength(i);
    total += m;
    if (!byLimit.has(L)) byLimit.set(L, { m: 0, n: 0, cls: new Set() });
    const b = byLimit.get(L); b.m += m; b.n++; b.cls.add(district.edges[i].c);
  }
  console.log('  limit (m/s)   km/h    edges   metres   share of network   classes carrying it');
  for (const [L, b] of [...byLimit].sort((a, c) => c[0] - a[0])) {
    console.log(`  ${String(L).padStart(11)}   ${kmh(L).padStart(5)}   ${String(b.n).padStart(5)}`
      + `   ${b.m.toFixed(0).padStart(6)}   ${(b.m / total * 100).toFixed(1).padStart(15)}%`
      + `   ${[...b.cls].join(', ')}`);
  }
  console.log(`\n  whole network ${total.toFixed(0)} m; the fleet jitters each car's own limit x0.85..${FLEET_JITTER_MAX}`);
  console.log(`  followPath caps the player's autopilot at ${FOLLOW_CAP} m/s = ${kmh(FOLLOW_CAP)} km/h,`
    + ` which is above EVERY class limit`);

  console.log('\n=== (3) WHAT AN ORDINARY DRIVE DOES AGAINST THAT LIMIT ===\n');
  const { samples, dist, routes } = driveSamples();
  const vs = samples.map((s) => s.v);
  const over = samples.filter((s) => s.excess > 0);
  const overFrac = over.length / samples.length;
  console.log(`  ${routes} routes, ${dist.toFixed(0)} m driven, ${samples.length} samples at 10 Hz,`
    + ' each against ITS OWN road\'s limit');
  console.log(`  planar speed:  p50 ${kmh(q(vs, 0.5))}  p90 ${kmh(q(vs, 0.9))}  max ${kmh(Math.max(...vs))} km/h`);
  console.log(`  OVER its road's limit on ${(overFrac * 100).toFixed(1)}% of samples`);
  console.log(`  excess when over:  p50 ${kmh(q(over.map((s) => s.excess), 0.5))}`
    + `  p90 ${kmh(q(over.map((s) => s.excess), 0.9))}  max ${kmh(Math.max(...over.map((s) => s.excess)))} km/h`);
  const ratio = over.map((s) => s.ratio);
  console.log(`  as a RATIO of the limit:  p50 x${q(ratio, 0.5).toFixed(2)}  p90 x${q(ratio, 0.9).toFixed(2)}`
    + `  max x${Math.max(...ratio).toFixed(2)}`);
  console.log('  NOT A PLAYER, and one-sided: followPath caps at 79.2 km/h and the car will do 140,');
  console.log('  so this fraction is a FLOOR on what a human would earn rather than an estimate.');

  console.log('\n=== (3b) THE FLEET, by a SECOND PROTOCOL — the population the limit describes ===\n');
  const { vels, ratios } = fleetSamples();
  console.log(`  ${vels.length} car-samples at 2 Hz over 100 s of fleet after a 20 s settle`);
  console.log(`  fleet speed:  p50 ${kmh(q(vels, 0.5))}  p90 ${kmh(q(vels, 0.9))}  max ${kmh(Math.max(...vels))} km/h`);
  console.log('  a playtester reported p50 36, p90 52, max 64 km/h — reproduce before quoting\n');
  console.log(`  against its OWN road's declared limit:  p50 x${q(ratios, 0.5).toFixed(2)}`
    + `  p90 x${q(ratios, 0.9).toFixed(2)}  max x${Math.max(...ratios).toFixed(2)}`
    + `   (ceiling x${FLEET_JITTER_MAX} BY CONSTRUCTION)`);
  console.log(`  over the limit on ${(ratios.filter((r) => r > 1).length / ratios.length * 100).toFixed(1)}%`
    + ` of car-samples, against the autopilot's ${(overFrac * 100).toFixed(1)}%`);
  console.log('  So the declared limit IS this district\'s normal and the fleet obeys it. The player');
  console.log('  is the anomaly, not the limit.');

  console.log('\n=== (3c) KNOWN-BAD: the entry\'s own premise ===\n');
  const one1 = secondsToStars(1, 1);
  const long1 = secondsToStars(1, 99, 60);
  console.log(`  one reckless charge at scale 1 is ${one1.delta.toFixed(4)} of heat = 0 stars — the entry is right`);
  console.log(`  continuous charging reaches ONE STAR at ${one1.t.toFixed(1)} s (heat ${one1.heat.toFixed(4)})`);
  console.log(`  and 60 s of it reaches heat ${long1.heat.toFixed(4)}`);
  console.log('  so "never on its own makes you wanted" is FALSE above the break-even scale:');
  console.log('  FLOORLESS_CAP bounds each DELTA, and `max(heat + delta, c.min)` does not bound the TOTAL.');

  console.log('\n=== (4) THE PRICE, and the tolerance that would be needed ===\n');
  console.log('A charge every refractory while over, scaled by the excess. Two scale rules, both the');
  console.log('shape `crimeScale` already uses elsewhere — a quantity over a reference:\n');
  const ladder = [0.1, 0.25, 0.5, 1, 2].map((s) => [s, secondsToStars(s, 1).t]);
  for (const [name, rule] of [
    ['excess / limit', (s) => s.excess / s.limit],
    ['excess / 10 m/s', (s) => s.excess / 10],
  ]) {
    const sc = over.map(rule);
    const med = q(sc, 0.5);
    let secs = null;
    for (const [k, t] of ladder) if (t !== null && med >= k) secs = t;
    console.log(`  ${name.padEnd(16)} median scale ${med.toFixed(3)}   p90 ${q(sc, 0.9).toFixed(3)}`
      + `   charges/min ${(overFrac * 60 / C.refractory).toFixed(1)}`
      + `   ~1 star in ${secs === null ? '>600' : secs.toFixed(0)} s`);
  }
  console.log(`\n  Both are 5-6x the break-even ${BE.toFixed(3)}, so a limit at the declared value puts a star on`);
  console.log('  an ordinary drive inside twenty seconds.\n');
  console.log('  THE TOLERANCE THAT WOULD BE NEEDED, as a multiplier on the declared limit:');
  const rs = [...ratio].sort((a, b) => a - b);
  for (const f of [0.5, 0.1, 0.05, 0.01]) {
    const want = rs[Math.max(0, Math.round((1 - f) * (rs.length - 1)))];
    console.log(`    charge only the worst ${(f * 100).toFixed(0).padStart(2)}%: x${want.toFixed(2)}`
      + `  (${kmh(want * 15.5).padStart(5)} km/h on a primary, ${kmh(want * 6.5)} on a service alley)`);
  }
  console.log(`\n  AND IT DEGENERATES. The worst 5% and the worst 1% are x${rs[Math.round(0.95 * (rs.length - 1))].toFixed(2)} and`);
  console.log(`  x${rs[Math.round(0.99 * (rs.length - 1))].toFixed(2)} against a MAXIMUM of x${Math.max(...ratio).toFixed(2)}: past about x2.6 the tolerance is reading the`);
  console.log(`  autopilot's own ${kmh(FOLLOW_CAP)} km/h cap rather than a property of the roads, so there is no`);
  console.log('  multiplier that charges the worst few percent without charging almost nothing.');
  console.log('\n  CONCLUSION — a priced refusal, not an oversight. The limit exists and is derivable;');
  console.log('  what is missing is a scale that stays under the break-even, and `reckless` under the');
  console.log('  break-even is a cue with no consequence. That is a cue to design, not a crime to file.');
}

// ------------------------------------------------------------------------------------- selftest
if (SELFTEST) {
  console.log('SPEED LIMIT SELFTEST\n');

  // 1. The entry's premise, both directions. A build that capped the TOTAL at FLOORLESS_CAP rather
  //    than the delta would read `never` at every scale; one with no bleed at all would reach a
  //    star at every scale. Neither passes both of these.
  const hi = secondsToStars(1, 1);
  const lo = secondsToStars(0.05, 1, 1200);
  check('continuous reckless at scale 1 DOES reach one star', hi.t !== null && hi.t < 30,
    `${hi.t === null ? 'never' : hi.t.toFixed(1) + ' s'}, heat ${hi.heat.toFixed(4)}`);
  check('and at scale 0.05 it NEVER does', lo.t === null,
    `heat after 1200 s ${lo.heat.toFixed(4)}, bled/s ${lo.bledPerS.toFixed(4)}`);

  // 2. The break-even is bracketed by those two, which is what makes it a number rather than a
  //    bisection artefact.
  const be = breakEvenScale();
  check('the break-even scale sits strictly between them', be > 0.05 && be < 1, `${be.toFixed(4)}`);

  // 3. THE DUTY CYCLE. This is the check that would have caught the wrong version: an UNGATED bleed
  //    sheds ~0.09/s, the gated one ~0.013. They differ by 7x, so there is nothing in between for
  //    the bound to be wrong at.
  const gated = BLEED * (C.refractory - GRACE) / C.refractory;
  const measured = secondsToStars(0.25, 1).bledPerS;
  check('the measured bleed is the GATED rate, not the raw one',
    measured < gated * 1.5 && measured > gated * 0.4,
    `measured ${measured.toFixed(4)}/s, gated ${gated.toFixed(4)}, ungated would be ${BLEED.toFixed(4)}`);

  // 4. The declared limit is read off the module and covers the whole network. A build whose
  //    `_speedLimit` fell through to one value would fail the spread.
  const limits = new Set();
  for (let i = 0; i < district.edges.length; i++) limits.add(limitOf(i));
  check('the district declares more than one limit', limits.size >= 3,
    `${limits.size} distinct: ${[...limits].sort((a, b) => b - a).join(', ')} m/s`);
  check('and every edge has one', [...limits].every((L) => Number.isFinite(L) && L > 0),
    `${district.edges.length} edges`);

  // 5. BOTH POPULATIONS ARE NON-EMPTY. §3b read 0 car-samples once and printed a NaN percentile;
  //    a probe whose two sides are both zero is not a probe.
  const fleet = fleetSamples(40, 15, 30);
  check('the fleet spawned and was sampled', fleet.vels.length > 100, `${fleet.vels.length} car-samples`);

  // 6. THE BY-CONSTRUCTION CEILING, which is the only check that can catch the limit being looked
  //    up for the wrong edge. `car.limit` is `_speedLimit(e) * (0.85 + r * 0.3)`, so a correct
  //    ratio cannot exceed 1.15; a mis-keyed lookup would scatter past it immediately.
  const worst = Math.max(...fleet.ratios);
  check('no fleet car exceeds its own jitter ceiling', worst <= FLEET_JITTER_MAX + 1e-6,
    `worst x${worst.toFixed(4)} against x${FLEET_JITTER_MAX}`);

  // 7. And the drive is over the limit, which is the finding. A build whose follower respected the
  //    declared limit would read 0% here and the whole entry would be moot.
  const drv = driveSamples(3, 60);
  const of = drv.samples.filter((s) => s.excess > 0).length / drv.samples.length;
  check('the shipped follower exceeds the declared limit', of > 0.5,
    `${(of * 100).toFixed(1)}% of ${drv.samples.length} samples, ${drv.dist.toFixed(0)} m`);

  // 8. And an empty population throws rather than reporting a percentile of nothing.
  let threw = false;
  try { q([], 0.5); } catch { threw = true; }
  check('a percentile of an empty population throws', threw);

  console.log(`\nSPEED LIMIT SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
