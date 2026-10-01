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
import { PursuitUnits } from '../src/pursuit.js';
import { HALF_EXTENT } from '../src/damage.js';

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const SCENE = { add() {}, remove() {} };
const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const mat = new THREE.Matrix4(), vec = new THREE.Vector3();

const build = (opts = {}) => new PursuitUnits(SCENE, district, { count: 8, seed: 5, ...opts });
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
  check('and a unit that says it is holding is inside the radius',
    heldNow.length > 0 && worstHeldD <= p.holdRadius + 1e-6,
    `${worstHeldD.toFixed(2)} against ${p.holdRadius.toFixed(2)} m`);

  /**
   * THEN THE TARGET LEAVES. A hold that never releases is the same failure as one that never
   * takes, and the number that shows it is the distance a "holding" unit reports from.
   */
  let worstAfter = 0, heldFrames = 0, frames = 0;
  for (let i = 0; i < 120 * 30; i++) {
    target.x = spot.x + (i / 30) * 20;                 // 72 km/h away, in a straight line
    p.update(1 / 30, target);
    frames++;
    for (let k = 0; k < p.count; k++) {
      if (!p.units[k] || !p.units[k].held) continue;
      heldFrames++;
      const q = posOf(p, k);
      worstAfter = Math.max(worstAfter, Math.hypot(q.x - target.x, q.z - target.z));
    }
  }
  console.log(`    then 120 s of fleeing at 72 km/h: ${heldFrames} held unit-frames of ` +
    `${frames * p.count}, worst distance from a holding unit ${worstAfter.toFixed(2)} m`);
  check('the hold releases when the target leaves, rather than following it for ever',
    heldFrames < frames * p.count * 0.5,
    `${heldFrames} of ${frames * p.count} unit-frames`);
  check('and no unit ever reports holding from outside the radius',
    worstAfter <= p.holdRadius + 1e-6,
    `${worstAfter.toFixed(2)} against ${p.holdRadius.toFixed(2)} m`);
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
    Math.abs(p.report().holdR - p.holdRadius) < 1e-12,
    `${reportedHeld} / ${actuallyHeld}, holdR ${p.report().holdR}`);
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
