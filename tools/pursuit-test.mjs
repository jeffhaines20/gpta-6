// Deterministic gate for the police pursuit layer.
//
// src/pursuit.js HAD NO GATE AT ALL, and that is the finding this file exists for. A blind
// mutation reviewer wrote ten rows against it and NINE WERE MISSED by the whole list —
// `grep -rn "from '../src/pursuit.js'" tools/*.mjs` returned one line, tools/playtest.mjs, and
// `sim-determinism` only checks the filename appears in a list. The tenth was caught because it
// broke the interface rather than the geometry.
//
// What the misses had in common is worth more than the list: every one of them was a GEOMETRIC
// defect that left the module's own reports and the harness's star counts looking exactly right.
// An off-by-one in `_closestOn`'s walk makes the hold impossible on 42% of the network. One
// bracket moved makes a held unit held for ever, so the fleet drives 3,056 m instead of 9,170 and
// reports a one-frame jump of 19.59 m. Neither errors, neither shows in a transcript.
//
//   node tools/pursuit-test.mjs
//
// No browser and no GL: PursuitUnits builds against `{ add() {} }` and keeps its positions in an
// InstancedMesh matrix, which `getMatrixAt` reads in node. Same reason tools/playtest.mjs can run
// the whole simulation offline.
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { PursuitUnits, arrestSeconds } from '../src/pursuit.js';
import { HALF_EXTENT } from '../src/damage.js';
import { buildBlockers } from '../src/blockers.js';
import { RUN_SPEED, ON_FOOT_RADIUS } from '../src/player.js';
import { BUST_HOLD_S } from '../src/wanted.js';

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const SCENE = { add() {}, remove() {} };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const mat = new THREE.Matrix4(), vec = new THREE.Vector3();

/**
 * BUILT THE WAY THE GAME BUILDS IT, which means `clearAt`.
 *
 * `src/pursuit.js` holds a target when a unit has stopped at its edge's closest approach AND an
 * officer can WALK from there to the player. With no predicate that walk is unrefused, so a
 * gate that omitted it would measure a 28 m radius straight through walls — a configuration the
 * page never runs. CLAUDE.md records the same omission in `traffic-selftest`, where the gate
 * measuring cars-inside-buildings had built its Traffic with no `clearAt` at all, and the cheap
 * proof it mattered was that supplying it changed the reading. It changes this one too: see the
 * line-of-sight control in §8.
 */
const blockers = buildBlockers(district);
const CLEAR_AT = (x, z, r = 0.95) => !blockers.resolveCircle(x, z, r);
const build = (opts = {}) => {
  const { clearAt = CLEAR_AT, ...rest } = opts;
  const p = new PursuitUnits(SCENE, district, { count: 8, seed: 5, ...rest });
  if (clearAt) p.clearAt = clearAt;
  return p;
};
/** Where unit `i` is drawn, which is the only place its position exists. */
const posOf = (p, i) => {
  p.mesh.getMatrixAt(i, mat);
  vec.setFromMatrixPosition(mat);
  return { x: vec.x, z: vec.z };
};
/** Every vertex of an edge, in the direction a unit would drive it. */
const polyline = (e, forward) => (forward ? e.v : [...e.v].reverse()).map((v) => district.verts[v]);
const lengthOf = (pts) => {
  let l = 0;
  for (let k = 0; k < pts.length - 1; k++) l += Math.hypot(pts[k + 1].x - pts[k].x, pts[k + 1].z - pts[k].z);
  return l;
};
/** The point `t` metres along a polyline, by walking it — independent of the module's own walker. */
const walkTo = (pts, t) => {
  let rem = t;
  for (let k = 0; k < pts.length - 1; k++) {
    const a = pts[k], b = pts[k + 1];
    const seg = Math.hypot(b.x - a.x, b.z - a.z);
    if (rem <= seg || k === pts.length - 2) {
      const f = seg > 1e-12 ? Math.max(0, Math.min(1, rem / seg)) : 0;
      return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f };
    }
    rem -= seg;
  }
  return pts[pts.length - 1];
};

// ------------------------------------------------- 1. the hold radius covers the widest road
/**
 * WHAT THE RADIUS IS FOR. Units run the road-graph CENTRELINE and a player can be at the far
 * kerb, so the worst honest separation between a unit that has ARRIVED and the player it arrived
 * at is half the widest road plus the car's own half-length.
 *
 * This shipped derived from `e.r`, which is a CLASS RANK (primary 2, secondary 3, tertiary 4,
 * residential 5, service 8) and not a width — 7.15 m instead of 8.75. A blind playtester measured
 * the cost: standing 8, 9 or 10 m off a centreline at five stars was 0 of 5 arrests with the bust
 * clock never arming, against 5 of 5 at 0, 6 and 7 m.
 */
console.log('\n1. the hold radius');
{
  const p = build();
  const widest = Math.max(...district.edges.map((e) => e.w));
  const needed = widest / 2 + HALF_EXTENT.z;
  const classes = {};
  for (const e of district.edges) {
    classes[e.c] = classes[e.c] ?? { r: e.r, w: new Set() };
    classes[e.c].w.add(e.w);
  }
  for (const [c, v] of Object.entries(classes)) {
    console.log(`    ${c.padEnd(12)} r ${v.r}   w ${[...v.w].sort((a, b) => a - b).join(' ')}`);
  }
  console.log(`    widest ${widest} m, so half of it plus HALF_EXTENT.z ${HALF_EXTENT.z} = ` +
    `${needed.toFixed(2)} m; holdRadius ${p.holdRadius.toFixed(2)} m`);
  check('the hold radius reaches the far kerb of the widest road, plus a car',
    p.holdRadius >= needed - 1e-9, `${p.holdRadius.toFixed(2)} against ${needed.toFixed(2)}`);
  check('and not much more, or it is not a CONTACT radius',
    p.holdRadius < needed * 1.5, `${p.holdRadius.toFixed(2)} against ${(needed * 1.5).toFixed(2)}`);
  /**
   * KNOWN-BAD: the rank it used to read is a DIFFERENT NUMBER, so the two cannot be confused by
   * accident. Without this, a radius derived from `r` on a district where the two happened to
   * agree would pass the bounds above.
   */
  const widestRank = Math.max(...district.edges.map((e) => e.r));
  check('KNOWN-BAD: the class rank is not the width, so the two derivations differ',
    Math.abs(widestRank / 2 + HALF_EXTENT.z - p.holdRadius) > 1,
    `rank ${widestRank} would give ${(widestRank / 2 + HALF_EXTENT.z).toFixed(2)}`);
  check('the radius is finite and positive', p.holdRadius > 0 && Number.isFinite(p.holdRadius),
    `${p.holdRadius}`);
}

// ---------------------------------- 2. _closestOn finds the nearest point, on EVERY edge
/**
 * THE POSTCONDITION, WALKED OVER THE WHOLE NETWORK, because the defect it catches is invisible
 * on most of it. A reviewer's off-by-one in `_closestOn`'s segment walk made the hold impossible
 * on 42% of the drivable network — 247 of 582 drivable edges are TWO-POINT, so dropping the last
 * segment drops the only one. On a multi-point edge the same mutation is nearly harmless.
 *
 * Checked against a dense independent sample rather than against the module's own answer: what
 * `_closestOn` returns must BE the minimum, not merely be self-consistent.
 */
console.log('\n2. _closestOn, over every edge');
{
  const p = build();
  const probes = [{ x: 0, z: 0 }, { x: 120, z: -60 }, { x: -300, z: 90 }, { x: 57, z: -164 },
    { x: -471, z: 205 }, { x: 600, z: 400 }];
  let worstExcess = 0, worstEdge = -1, outOfRange = 0, twoPoint = 0, tested = 0;
  let worstPointErr = 0;
  for (let i = 0; i < district.edges.length; i++) {
    const e = district.edges[i];
    if (e.v.length === 2) twoPoint++;
    for (const forward of [true, false]) {
      const pts = polyline(e, forward);
      const len = lengthOf(pts);
      if (!(len > 0)) continue;
      for (const target of probes) {
        tested++;
        const got = p._closestOn(i, forward, target);
        if (!(got.t >= -1e-9 && got.t <= len + 1e-9)) outOfRange++;
        // The point the module says is closest must be where it says it is.
        const at = walkTo(pts, got.t);
        worstPointErr = Math.max(worstPointErr,
          Math.abs(Math.hypot(target.x - at.x, target.z - at.z) - got.d));
        // And no sample along the edge may be closer than the distance it reported.
        const N = Math.max(40, Math.ceil(len / 0.5));
        let best = Infinity;
        for (let k = 0; k <= N; k++) {
          const q = walkTo(pts, (len * k) / N);
          best = Math.min(best, Math.hypot(target.x - q.x, target.z - q.z));
        }
        const excess = got.d - best;
        if (excess > worstExcess) { worstExcess = excess; worstEdge = i; }
      }
    }
  }
  console.log(`    ${tested} (edge, direction, target) triples over ${district.edges.length} edges, ` +
    `${twoPoint} of them two-point`);
  console.log(`    worst excess over a dense sample ${(worstExcess * 1000).toFixed(2)} mm ` +
    `${worstEdge >= 0 ? `(edge ${worstEdge})` : ''}, worst point/distance disagreement ` +
    `${(worstPointErr * 1000).toFixed(3)} mm, ${outOfRange} t values out of range`);
  check('every triple was tested, or this section asserts nothing', tested > 8000, `${tested}`);
  check('the district really does hold two-point edges, which is where the defect lives',
    twoPoint > 200, `${twoPoint} of ${district.edges.length}`);
  check('`t` is always inside the edge', outOfRange === 0, `${outOfRange} out of range`);
  check('the reported distance is the distance to the reported point',
    worstPointErr < 1e-6, `${(worstPointErr * 1000).toFixed(4)} mm`);
  check('and no point on the edge is closer than the one it found',
    worstExcess < 0.01, `${(worstExcess * 1000).toFixed(2)} mm excess`);
}

// ------------------------------------------- 3. the hold holds, and then it lets go
/**
 * THE HOLD'S WHOLE CONTRACT, and the two halves fail in opposite directions. Without stickiness a
 * hold lasts two frames (the defect this round shipped and had to trace frame by frame); with one
 * bracket moved it lasts for ever, and a reviewer measured that version reporting held in 100% of
 * frames while the player fled, worst distance 331.9 m, with the fleet driving 3,056 m instead of
 * 9,170.
 */
console.log('\n3. the hold, and the release');
{
  const spot = { x: -327.8, z: 63.3 };
  const p = build();
  const target = { ...spot };
  let heldRun = 0, bestHeld = 0;
  for (let i = 0; i < 300 * 30; i++) {
    p.update(1 / 30, target);
    const held = p.units.filter((u) => u && u.held).length;
    if (held > 0) { heldRun += 1 / 30; if (heldRun > bestHeld) bestHeld = heldRun; } else heldRun = 0;
  }
  const heldNow = p.units.filter((u) => u && u.held);
  // Taken HERE, where units are holding, and asserted at the end of the section.
  const reportedHeld = p.report().held;
  const actuallyHeld = heldNow.length;
  // Every unit that says it is holding must BE within the radius of the target.
  let worstHeldD = 0;
  for (let i = 0; i < p.count; i++) {
    if (!p.units[i] || !p.units[i].held) continue;
    const q = posOf(p, i);
    worstHeldD = Math.max(worstHeldD, Math.hypot(q.x - target.x, q.z - target.z));
  }
  console.log(`    stationary target, 300 s: longest held run ${bestHeld.toFixed(1)} s, ` +
    `${heldNow.length} holding now, worst held distance ${worstHeldD.toFixed(2)} m`);
  check('a unit holds a stationary target, and keeps holding',
    bestHeld > 60, `${bestHeld.toFixed(1)} s`);
  /**
   * RESTATED FROM `holdRadius` TO `reachRadius`, IN THE COMMIT THAT WIDENED IT.
   *
   * It read `worstHeldD <= p.holdRadius` — the distance from an edge's centreline to a car at
   * the kerb of the widest road, 8.75 m — and that bound was the defect a playtester found by
   * playing: stop 15.6 m off a centreline and you get 180.5 s on the brake at 4 stars with
   * 0 busts and a unit holding on 0% of frames. An arrest is made by a PERSON, who covers
   * `RUN_SPEED * BUST_HOLD_S` = 28.0 m while the clock the HUD is already counting runs down.
   *
   * Note which way the numbers move: the absolute bound got 3.2x looser and the section got
   * stronger, because the walk now has to be CLEAR and that is a separate assertion below with
   * its own control. A bound alone could not say that.
   */
  check('and a unit that says it is holding is inside the officer\'s reach',
    heldNow.length > 0 && worstHeldD <= p.reachRadius + 1e-6,
    `${worstHeldD.toFixed(2)} against reach ${p.reachRadius.toFixed(2)} m `
    + `(the old bound was ${p.holdRadius.toFixed(2)})`);

  /**
   * THEN THE TARGET LEAVES. A hold that never releases is the same failure as one that never
   * takes, and the number that shows it is the distance a "holding" unit reports from.
   */
  let worstAfter = 0, heldFrames = 0, frames = 0, worstOver = -Infinity;
  for (let i = 0; i < 120 * 30; i++) {
    target.x = spot.x + (i / 30) * 20;                 // 72 km/h away, in a straight line
    p.update(1 / 30, target);
    frames++;
    // The bound a holding unit is allowed to be inside: the officer's reach, OR the closest the
    // road network gets to the target at all. Read AFTER update() so it is the same cached value
    // the clamp decided on. See `bestApproach`.
    const allowed = Math.max(p.reachRadius, p.bestApproach(target));
    for (let k = 0; k < p.count; k++) {
      if (!p.units[k] || !p.units[k].held) continue;
      heldFrames++;
      const q = posOf(p, k);
      const d = Math.hypot(q.x - target.x, q.z - target.z);
      worstAfter = Math.max(worstAfter, d);
      worstOver = Math.max(worstOver, d - allowed);
    }
  }
  console.log(`    then 120 s of fleeing at 72 km/h: ${heldFrames} held unit-frames of ` +
    `${frames * p.count}, worst distance from a holding unit ${worstAfter.toFixed(2)} m`);
  check('the hold releases when the target leaves, rather than following it for ever',
    heldFrames < frames * p.count * 0.5,
    `${heldFrames} of ${frames * p.count} unit-frames`);
  /**
   * RESTATED. This read `worstAfter <= reachRadius`, and it was the right invariant for a build
   * whose only hold condition was that radius. `bestApproach` adds a second one — a unit may stop
   * at the NETWORK's closest approach however far that is — so a unit holding 160 m from a target
   * fleeing into open country is now correct, and the bound has to be the pair.
   *
   * THE SLACK IS MEASURED, NOT GUESSED, and CLAUDE.md asks for a bound with nothing between the
   * noise and the signal. A holding unit sits at its edge's closest approach, which is at most
   * `bestApproach` from the target by construction — but the target is moving 20 m/s and the
   * clamp is decided before this reads it, so the unit lags by up to one step of target travel.
   * The measured worst excess is printed beside the bound, and the bound is `speed * dt` of
   * TARGET motion (0.667 m at 20 m/s and 1/30 s) plus the unit's own step, which is what the lag
   * can physically be. A looser number would admit a unit that had stopped tracking entirely.
   */
  const lag = 20 / 30 + p.speed / 30;
  console.log(`    worst excess over max(reach, bestApproach): ${worstOver === -Infinity ? 'n/a'
    : worstOver.toFixed(3)} m, against one frame of target+unit travel ${lag.toFixed(3)} m`);
  check('a holding unit is inside the reach OR at the closest the network gets',
    heldFrames > 0 && worstOver <= lag,
    `worst excess ${worstOver === -Infinity ? 'n/a' : worstOver.toFixed(3)} m over `
    + `${heldFrames} held unit-frames, bound ${lag.toFixed(3)}`);
  check('KNOWN-BAD: and that admits distances the old reach-only bound refused, which is the fix',
    worstAfter > p.reachRadius,
    `${worstAfter.toFixed(2)} m against the old bound of ${p.reachRadius.toFixed(2)}`);

  /**
   * `arrestSeconds` IS `reachRadius`'s OWN DERIVATION AS A FUNCTION, and the property that makes
   * it a derivation rather than a curve somebody drew is that the two terms cross EXACTLY at
   * `reachRadius`. So every arrest the game already made is unchanged and only the ones the
   * network floor newly admits are lengthened. Asserted as the crossing rather than as a table of
   * values, so retuning RUN_SPEED or BUST_HOLD_S moves the reach and the clock together.
   */
  console.log(`    arrestSeconds: ${[0, 8, p.reachRadius, 37.8, 97.3, 136.7, 185.9]
    .map((d) => `${d.toFixed(1)}m->${arrestSeconds(d).toFixed(2)}s`).join('  ')}`);
  check('the arrest clock is flat out to the officer\'s reach',
    arrestSeconds(0) === BUST_HOLD_S && arrestSeconds(p.reachRadius) === BUST_HOLD_S,
    `${arrestSeconds(0)} and ${arrestSeconds(p.reachRadius)} against ${BUST_HOLD_S}`);
  check('and rises strictly beyond it, so distance starts to matter exactly there',
    arrestSeconds(p.reachRadius + 1) > BUST_HOLD_S
      && arrestSeconds(p.reachRadius * 2) > arrestSeconds(p.reachRadius + 1),
    `${arrestSeconds(p.reachRadius + 1).toFixed(3)} then `
    + `${arrestSeconds(p.reachRadius * 2).toFixed(3)} s`);
  check('the two terms cross AT the reach, which is what makes it one derivation and not two',
    Math.abs(p.reachRadius / RUN_SPEED - BUST_HOLD_S) < 1e-12,
    `${(p.reachRadius / RUN_SPEED).toFixed(6)} against ${BUST_HOLD_S}`);
  check('and a non-finite or negative distance falls to the floor, not to zero or NaN',
    [NaN, undefined, -5, Infinity].every((d) => arrestSeconds(d) >= BUST_HOLD_S),
    [NaN, undefined, -5, Infinity].map((d) => `${d}->${arrestSeconds(d)}`).join(' '));
  /**
   * `report().held` IS RECONCILED WHILE UNITS ARE ACTUALLY HELD, which the first version of this
   * check was not: it ran after the fleeing phase, where nothing is held, and compared 0 against
   * 0. CLAUDE.md's "a check whose two sides are both zero". Both numbers are taken at the
   * stationary phase's peak, recorded above, and the count is asserted non-zero.
   */
  console.log(`    report().held ${reportedHeld} against ${actuallyHeld} units holding, ` +
    `holdR ${p.report().holdR}`);
  check('report() agrees with the units it is reporting on, while some ARE held',
    actuallyHeld > 0 && reportedHeld === actuallyHeld &&
    Math.abs(p.report().holdR - p.holdRadius) < 1e-12 &&
    Math.abs(p.report().reachR - p.reachRadius) < 1e-12,
    `${reportedHeld} / ${actuallyHeld}, holdR ${p.report().holdR}, reachR ${p.report().reachR}`);
}

// ----------------------------------------- 4. a unit never moves faster than it drives
/**
 * THE DISPLACEMENT BOUND, which is what catches a hold that teleports. `u.t` is an along-edge
 * distance and the only thing allowed to advance it is `speed * dt` — so a frame where a unit's
 * drawn position jumps further than that, on the SAME edge, is the module moving a car rather than
 * driving it. A reviewer's `hold-forever` mutation reported a 19.59 m single-frame jump.
 *
 * Frames where the edge CHANGED are excluded and counted: a reroute legitimately teleports along
 * the graph, from the end of one edge to the start of the next, and that is a different claim.
 */
console.log('\n4. displacement per frame');
{
  const p = build({ seed: 17 });
  const target = { x: -327.8, z: 63.3 };
  const DT = 1 / 30;
  const prev = new Array(p.count).fill(null);
  let worst = 0, worstSame = 0, reroutes = 0, sameEdge = 0;
  for (let i = 0; i < 240 * 30; i++) {
    target.x = -327.8 + Math.sin(i / 400) * 180;
    target.z = 63.3 + Math.cos(i / 400) * 180;
    p.update(DT, target);
    for (let k = 0; k < p.count; k++) {
      const u = p.units[k];
      if (!u) { prev[k] = null; continue; }
      const q = posOf(p, k);
      const was = prev[k];
      if (was && was.edge === u.edge && was.forward === u.forward) {
        const d = Math.hypot(q.x - was.x, q.z - was.z);
        sameEdge++;
        if (d > worstSame) worstSame = d;
      } else if (was) reroutes++;
      if (was) worst = Math.max(worst, Math.hypot(q.x - was.x, q.z - was.z));
      prev[k] = { x: q.x, z: q.z, edge: u.edge, forward: u.forward };
    }
  }
  const bound = p.speed * DT;
  /**
   * THE TOLERANCE IS FLOAT ACCUMULATION, AND IT IS MEASURED. `_pointOn` walks a polyline summing
   * segment lengths, so a step on one edge comes out up to 28.8 microns over `speed * dt` — the
   * first version of this check used 1e-6 and failed on exactly that. 1 mm sits 34x above the
   * measured noise and 19,590x below the 19.59 m single-frame jump the `hold-forever` mutation
   * this check exists for produces, so there is no value in between for it to be wrong at.
   */
  const TOL = 0.001;
  const excess = worstSame - bound;
  console.log(`    ${sameEdge} same-edge frames and ${reroutes} edge changes; worst step on one ` +
    `edge ${worstSame.toFixed(6)} m against speed*dt = ${bound.toFixed(6)} m, excess ` +
    `${(excess * 1e6).toFixed(1)} microns against a ${(TOL * 1000).toFixed(0)} mm tolerance ` +
    `(worst of any frame, reroutes included, ${worst.toFixed(2)} m)`);
  check('both cases occur, or the exclusion makes this vacuous',
    sameEdge > 10000 && reroutes > 100, `${sameEdge} same-edge, ${reroutes} reroutes`);
  check('a unit on one edge never moves further in a frame than it drives',
    excess <= TOL, `${(excess * 1e6).toFixed(1)} microns over`);
  check('and the tolerance is float noise, not room for a jump',
    TOL < bound / 100, `${(TOL * 1000).toFixed(0)} mm against a ${bound.toFixed(3)} m step`);
}

/**
 * §9  THE OFFICER'S REACH, which is the fix for the one finding a blind playtester got by
 * playing rather than by measuring: brake 5.4 m off a centreline and you are busted in 11.0 s;
 * hold full lock for 3 s first and stop 15.6 m off and you get 180.5 s on the brake at 4 stars
 * with 0 busts and a unit holding on 0% of frames, byte-identical over three runs.
 *
 * The mechanism was that `held` was decided by `holdRadius` — the distance from an edge's
 * CENTRELINE to a car at the kerb of the widest road, so the hold was a function of how far the
 * PLAYER was from a road, while `RESPONSE[].spotRadius` lets them SEE you from 85-175 m.
 *
 * Four arms, and the one that matters is the first: the statistic is not a mean held fraction,
 * which averages positions the police cannot reach with positions they hold continuously, but
 * whether the longest CONTIGUOUS hold clears `BUST_HOLD_S` — the thing a player experiences,
 * which is binary.
 */
{
  console.log('\n§9  how far off a road the police can take you');
  // The derivation, read off the two modules that declare it rather than restated here.
  console.log(`    holdRadius ${build().holdRadius.toFixed(2)} m (widest edge / 2 + car half-length)`);
  console.log(`    reach      ${build().reachRadius.toFixed(2)} m `
    + `= RUN_SPEED ${RUN_SPEED} * BUST_HOLD_S ${BUST_HOLD_S}`);
  check('the reach is the officer\'s run, derived and not written down',
    Math.abs(build().reachRadius - Math.max(build().holdRadius, RUN_SPEED * BUST_HOLD_S)) < 1e-12,
    `${build().reachRadius.toFixed(2)} m`);
  // A MAX, so retuning the district's widest road can widen this and can never narrow it: the
  // on-road case the module was already right about must not be regressed by this change.
  check('and it can never be narrower than the car\'s own stop radius',
    build().reachRadius >= build().holdRadius, `${build().reachRadius} >= ${build().holdRadius}`);

  /**
   * THE SAMPLING BOUND IS ASSERTED AS A RELATION, not as the number. A circle test of radius r
   * can only notice a wall while consecutive samples are under 2r apart; CLAUDE.md records a
   * sampled sweep that held by 12% and by luck because its step came from a mean rather than a
   * maximum. Measured on the module's own walk: the worst gap between consecutive samples over
   * a long line, against 2 * ON_FOOT_RADIUS.
   */
  {
    const p = build();
    let worstGap = 0;
    const seen = [];
    const spy = p.clearAt;
    p.clearAt = (x, z, r) => { seen.push([x, z, r]); return spy(x, z, r); };
    p._footPathClear(0, 0, 0, 97.3);                    // a 97.3 m line, deliberately not round
    p.clearAt = spy;
    for (let k = 1; k < seen.length; k++) {
      worstGap = Math.max(worstGap, Math.hypot(seen[k][0] - seen[k - 1][0],
        seen[k][1] - seen[k - 1][1]));
    }
    const radii = new Set(seen.map((q) => q[2]));
    console.log(`    the walk over 97.3 m: ${seen.length} samples, worst gap `
      + `${worstGap.toFixed(4)} m against the 2r bound of `
      + `${(2 * ON_FOOT_RADIUS).toFixed(2)} m; radius used ${[...radii].join(',')}`);
    check('the walk samples closer than twice its own test radius',
      seen.length > 1 && worstGap < 2 * ON_FOOT_RADIUS,
      `${worstGap.toFixed(4)} < ${(2 * ON_FOOT_RADIUS).toFixed(2)} m`);
    check('and it tests a PERSON, not the car it got out of',
      radii.size === 1 && radii.has(ON_FOOT_RADIUS), [...radii].join(','));
  }

  // Edge segments once, for "distance to the NEAREST edge" — the axis a player experiences.
  // Not the unit's own edge: in this network stepping 20 m off edge A can put you 5 m from B.
  const segs = [];
  for (const e of district.edges) {
    const pts = e.v.map((v) => district.verts[v]);
    for (let k = 0; k < pts.length - 1; k++) segs.push([pts[k], pts[k + 1]]);
  }
  const nearestEdge = (x, z) => {
    let best = Infinity;
    for (const [a, b] of segs) {
      const dx = b.x - a.x, dz = b.z - a.z, s2 = dx * dx + dz * dz;
      if (s2 < 1e-12) continue;
      const f = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / s2));
      const d = Math.hypot(x - (a.x + dx * f), z - (a.z + dz * f));
      if (d < best) best = d;
    }
    return best;
  };
  // Positions found by walking out from a road and keeping the ones that are clear, so every
  // one is somewhere a car could be, and their distances are measured rather than assumed.
  const spots = [];
  for (const [sx, sz] of [[57, -164], [19, -6], [-242, 68], [-471, 205], [200, 100]]) {
    for (let ang = 0; ang < 16; ang++) {
      const a = ang * Math.PI / 8;
      for (const step of [2, 6, 10, 14, 18, 22, 40, 56]) {
        const x = sx + Math.cos(a) * step, z = sz + Math.sin(a) * step;
        if (!CLEAR_AT(x, z)) continue;
        spots.push({ x, z, d: nearestEdge(x, z) });
      }
    }
  }
  /**
   * THREE ARMS, ONE PER LEVER, because there are now two and a two-arm table cannot say which
   * one bought what. CLAUDE.md: "isolate one term at a time", and "a round reverted the wrong
   * lever because it never isolated".
   *
   *   'legacy'  both off:   `_reachR` back to `holdRadius` AND no network floor. What shipped
   *                         before either change.
   *   'reach'   the reach only: the previous round's widening, with the floor off.
   *   'shipped' both on.
   *
   * THE FLOOR IS TURNED OFF BY STUBBING `bestApproach` TO -Infinity, not to 0: the call site
   * tests `near.d <= best`, so -Infinity is "no edge is ever the closest the network gets" and 0
   * would still admit a player standing exactly on a centreline.
   */
  const longestHold = (sp, arm) => {
    const p = build({ count: 6 });
    if (arm === 'legacy' || arm === 'reach') p.bestApproach = () => -Infinity;
    if (arm === 'legacy') p._reachR = p.holdRadius;  // the bound that shipped, as the control
    const t = { x: sp.x, z: sp.z };
    let cur = 0, longest = 0;
    for (let f = 0; f < 1800; f++) {
      p.update(1 / 60, t);
      if (p.units.some((u) => u && u.held)) { cur++; if (cur > longest) longest = cur; } else cur = 0;
    }
    return longest / 60;
  };
  const BANDS = [[0, 8.75], [8.75, 16], [16, 28], [28, 1e9]];
  const rows = [];
  for (const [lo, hi] of BANDS) {
    const inB = spots.filter((r) => r.d >= lo && r.d < hi).slice(0, 8);
    if (inB.length < 3) continue;
    const ok = (arm) => inB.map((r) => longestHold(r, arm))
      .filter((v) => v >= BUST_HOLD_S).length;
    rows.push({ lo, hi, n: inB.length,
      legacyOK: ok('legacy'), reachOK: ok('reach'), newOK: ok('shipped') });
  }
  console.log('    nearest edge      n   arrestable LEGACY   +REACH   +NETWORK FLOOR');
  for (const r of rows) {
    console.log(`    ${`${r.lo}-${r.hi === 1e9 ? '999' : r.hi} m`.padEnd(16)} `
      + `${String(r.n).padStart(2)}        ${`${r.legacyOK}/${r.n}`.padStart(7)}  `
      + `${`${r.reachOK}/${r.n}`.padStart(7)}  ${`${r.newOK}/${r.n}`.padStart(14)}`);
  }
  const band = (lo) => rows.find((r) => r.lo === lo);
  const mid = band(8.75), far = band(16), near = band(0), out = band(28);
  /**
   * KNOWN-BAD AS A BAND, not as a single position. The control is the same code with `_reachR`
   * forced back to `holdRadius`, in ONE process against the same seeds and the same spots, so
   * nothing but the bound differs. Both sides have to be non-zero in the right direction or the
   * arm says nothing: the near band must be arrestable in BOTH arms (the change did not break
   * what worked) and the 8.75-16 m band must go from none to all.
   */
  check('the near band was arrestable in every arm, including the legacy one',
    !!near && near.legacyOK >= near.n - 1 && near.reachOK >= near.n - 1
      && near.newOK >= near.n - 1,
    near ? `${near.legacyOK}/${near.reachOK}/${near.newOK} of ${near.n}` : 'no near band');
  check('KNOWN-BAD: just past the car\'s stop radius, the legacy build arrested nobody',
    !!mid && mid.legacyOK === 0, mid ? `${mid.legacyOK}/${mid.n} at 8.75-16 m` : 'no band');
  check('the widened reach is what fixed that band, and the floor does not undo it',
    !!mid && mid.reachOK === mid.n && mid.newOK === mid.n,
    mid ? `legacy ${mid.legacyOK}, +reach ${mid.reachOK}, +floor ${mid.newOK} of ${mid.n}` : 'no band');
  check('out to the officer\'s reach, where the legacy build also arrested nobody',
    !!far && far.legacyOK === 0 && far.reachOK >= Math.ceil(far.n * 0.6)
      && far.newOK >= far.reachOK,
    far ? `legacy ${far.legacyOK}, +reach ${far.reachOK}, +floor ${far.newOK} of ${far.n}` : 'no band');
  /**
   * AND THE LIMIT IS STATED RATHER THAN LEFT TO BE FOUND. Beyond the reach it is still immunity
   * in BOTH arms — the change closed a band, it did not make the player always arrestable, and
   * "drive a hundred metres into open land and they cannot take you" needs police who get out
   * of the car, not a bigger number here. This row is what stops the next round reading the one
   * above as "the hold is unbounded now".
   */
  /**
   * RESTATED: PAST THE REACH IS NO LONGER IMMUNITY, AND THAT IS THIS ROUND'S CHANGE.
   *
   * This check read "beyond the reach it is immunity in BOTH arms, which is the design limit",
   * and it was right about the build it was written for — `reachRadius`'s own comment says so:
   * "driving a hundred metres into open land is still immunity. That is a separate finding and it
   * needs police who get out of the car, not a bigger number here." `bestApproach` is that, so
   * the design limit moved and the check has to say which arm holds it.
   *
   * #89 measured the cost of leaving it: five of nine placements of a stationary four-star player
   * sat at four stars for the full 240 s with a unit 37 to 136 m away — seen, untouchable, and
   * not allowed to leave. `arrest-band` now reports "no stalemate row" and arrests at 38, 53, 68,
   * 97, 137 and 186 m in 28 to 46 s.
   */
  check('KNOWN-BAD: past the officer\'s reach, both older arms are immunity',
    !!out && out.legacyOK === 0 && out.reachOK === 0,
    out ? `legacy ${out.legacyOK}, +reach ${out.reachOK} of ${out.n} past 28 m` : 'no band');
  check('and the network floor is what ends it, which is the whole of #89\'s open half',
    !!out && out.newOK > 0,
    out ? `${out.newOK}/${out.n} past 28 m, against 0 in both older arms` : 'no band');

  /**
   * THE LINE-OF-SIGHT CONTROL, and it is the seam assertion for the whole walk test: if
   * `_footPathClear` never refuses, the reach is a bare 28 m radius through walls and every
   * number above is the same number it would be with the predicate deleted. Measured in
   * isolation first, because an end-to-end arm cannot tell "never refuses" from "never asked".
   */
  {
    const p = build({ count: 6 });
    let clear = 0, blocked = 0;
    for (let i = 0; i < segs.length; i += 7) {
      const [a, b] = segs[i];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
      for (const side of [1, -1]) for (const d of [12, 18, 24]) {
        const tx = mx + nx * side * d, tz = mz + nz * side * d;
        if (!CLEAR_AT(tx, tz)) continue;
        if (p._footPathClear(mx, mz, tx, tz)) clear++; else blocked++;
      }
    }
    console.log(`    the walk predicate over ${clear + blocked} kerb-to-player lines: `
      + `${clear} clear, ${blocked} BLOCKED (${(100 * blocked / (clear + blocked)).toFixed(1)}%)`);
    check('the walk test refuses some real lines, so it is not decoration',
      blocked > 0 && clear > 0, `${blocked} blocked of ${clear + blocked}`);
    check('and with no predicate wired every one of them is allowed, which is the other half',
      (() => { const q = build({ clearAt: null }); return q.clearAt == null
        && q._footPathClear(0, 0, 0, 400) === true; })(), 'unrefused without clearAt');

    // End to end: `stopped` and `held` must DIVERGE where the walk is blocked, and agree where
    // it is not. Without both sides, `held 0` reads the same whether no unit arrived or every
    // unit arrived and a wall was in the way — which is why report() now carries both.
    const tally = (list) => {
      let heldF = 0, stoppedF = 0, gap = 0;
      for (const c of list) {
        const q = build({ count: 6 });
        const t = { x: c.x, z: c.z };
        for (let f = 0; f < 900; f++) {
          q.update(1 / 60, t);
          for (const u of q.units) {
            if (!u || !u.stopped) continue;
            stoppedF++;
            if (u.held) heldF++; else gap++;
          }
        }
      }
      return { heldF, stoppedF, gap };
    };
    const cands = [];
    for (let i = 0; i < segs.length && cands.length < 600; i += 3) {
      const [a, b] = segs[i];
      const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 1e-6) continue;
      const nx = -(b.z - a.z) / L, nz = (b.x - a.x) / L;
      for (const side of [1, -1]) for (const d of [14, 20]) {
        const tx = mx + nx * side * d, tz = mz + nz * side * d;
        if (!CLEAR_AT(tx, tz)) continue;
        cands.push({ x: tx, z: tz, blockedWalk: !p._footPathClear(mx, mz, tx, tz) });
      }
    }
    const B = tally(cands.filter((c) => c.blockedWalk).slice(0, 6));
    const C = tally(cands.filter((c) => !c.blockedWalk).slice(0, 10));
    console.log(`    stopped-but-not-held, 15 s per position, 14-20 m off a kerb:`);
    console.log(`      walk clear   ${C.gap} of ${C.stoppedF} stopped unit-frames`);
    console.log(`      walk blocked ${B.gap} of ${B.stoppedF} stopped unit-frames`);
    check('a unit stopped within reach on a clear line always holds',
      C.stoppedF > 1000 && C.gap === 0, `${C.gap} of ${C.stoppedF}`);
    // Not all of them: `blockedWalk` is measured from ONE kerb midpoint, and a unit on the
    // street on the other side has its own clear line. That is correct, and it is why this is a
    // majority rather than a total.
    check('and one stopped behind a building mostly cannot, which is the control',
      B.stoppedF > 1000 && B.gap > B.stoppedF * 0.5,
      `${B.gap} of ${B.stoppedF} = ${(100 * B.gap / B.stoppedF).toFixed(1)}%`);
  }
}

// ---------------------------------------------------------------------------- report
const failed = checks.filter((c) => !c.ok);
console.log('');
for (const c of checks) {
  console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
}
console.log(failed.length
  ? `\nPURSUIT: FAIL — ${failed.length} of ${checks.length}`
  : `\nPURSUIT: PASS — ${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
