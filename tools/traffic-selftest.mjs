// Self-tests for the traffic instruments.
//
// The ledger has been burned twice by instruments that returned plausible numbers
// while being inert: a material-visibility probe that affected zero meshes, and an
// overlap counter with an inner-loop `break` that reported 119.9% of frames. So
// every counter here is checked BOTH WAYS - each test has to produce the reading it
// claims to detect AND the opposite reading on a case where it must stay silent.
//
//   node tools/traffic-selftest.mjs
import fs from 'node:fs';
import { Traffic } from '../src/traffic.js';
import { BlockerIndex } from '../src/blockers.js';
import * as TrafficMod from '../src/traffic.js';

const district = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const scene = { add() {} };
let pass = 0, fail = 0;

function check(name, ok, detail) {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
}

// A traffic instance with the spawner disabled, so a test owns the whole fleet.
function rig(count = 2) {
  const tr = new Traffic(scene, district, { count });
  tr._spawn = () => false;
  for (let i = 0; i < count; i++) tr.cars[i] = null;
  return tr;
}
function place(tr, slot, edge, forward, t, opts = {}) {
  const car = {
    id: ++tr._nextId, edge, forward, t, len: tr._len(edge),
    v: opts.v ?? 0, limit: opts.limit ?? 0,
    lane: tr._laneOffset(edge), holds: [], waitS: 0,
    stuckS: 0, sinceReplanS: 0, fromArm: null, lastDeny: null,
    plan: null, planJv: null, mv: null, ticket: 0, queuedAt: null,
    orphanFor: 0, countedOrphan: false,
    shunt: null, stopS: 0, shuntHeldS: 0,
  };
  tr.cars[slot] = car;
  return car;
}
const longEdge = (min) => district.edges.findIndex((e, i) => {
  let l = 0;
  for (let k = 0; k < e.v.length - 1; k++) {
    const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
    l += Math.hypot(b.x - a.x, b.z - a.z);
  }
  return l > min && e.o === 0;
});
function playerAt(tr, car) {
  const p = tr._pointOn(car.edge, car.forward, car.t);
  return { x: p.x, z: p.z };
}
const run = (tr, pos, n) => { for (let i = 0; i < n; i++) tr.update(1 / 60, pos); };

// The rig hand-builds cars because the spawner picks its own edge and position.
// That duplication has already bitten once: `place()` was missing `stuckS`, the
// anti-gridlock timer went NaN, and the test for it failed for a reason that had
// nothing to do with the code under test. So the rig is checked against a real
// spawn before anything else runs.
console.log('\n0. the test rig builds the same car the spawner does');
{
  const tr = new Traffic(scene, district, { count: 1 });
  const spawn = district.meta.spawn;
  for (let i = 0; i < 60 && !tr.cars[0]; i++) tr.update(1 / 60, spawn);
  const real = tr.cars[0];
  const rigged = place(rig(1), 0, longEdge(80), true, 10);
  const missing = Object.keys(real).filter((k) => !(k in rigged));
  const extra = Object.keys(rigged).filter((k) => !(k in real));
  check('rig car has every field a spawned car has',
    real && missing.length === 0 && extra.length === 0,
    missing.length || extra.length ? `missing [${missing}] extra [${extra}]` : `${Object.keys(real).length} fields`);
}

console.log('\n1. overlap detector fires, and stays silent when it should');
{
  const E = longEdge(80);
  const tr = rig(2);
  const a = place(tr, 0, E, true, 40), b = place(tr, 1, E, true, 40.5);
  run(tr, playerAt(tr, a), 60);
  const hot = { ...tr.stats };
  check('two cars 0.5 m apart -> every frame flagged', hot.overlapFrames === 60, `${hot.overlapFrames}/60`);
  check('  pair count is 1 per frame', hot.overlapPairFrames === 60, `${hot.overlapPairFrames}`);
  check('  car count is 2 per frame', hot.overlapCarFrames === 120, `${hot.overlapCarFrames}`);
  void b;

  const tr2 = rig(2);
  const c = place(tr2, 0, E, true, 20); place(tr2, 1, E, true, 70);
  run(tr2, playerAt(tr2, c), 60);
  check('two cars 50 m apart -> zero frames flagged',
    tr2.stats.overlapFrames === 0 && tr2.stats.overlapPairFrames === 0 && tr2.stats.overlapCarFrames === 0,
    `frames ${tr2.stats.overlapFrames} pairs ${tr2.stats.overlapPairFrames} cars ${tr2.stats.overlapCarFrames}`);

  // Three cars in a heap: the pair counter must see 3 pairs, the frame counter 1.
  const tr3 = rig(3);
  const d = place(tr3, 0, E, true, 40); place(tr3, 1, E, true, 40.4); place(tr3, 2, E, true, 40.8);
  run(tr3, playerAt(tr3, d), 10);
  check('three cars in a heap -> 3 pairs/frame but still 1 frame/frame',
    tr3.stats.overlapPairFrames === 30 && tr3.stats.overlapFrames === 10 && tr3.stats.overlapCarFrames === 30,
    `pairs ${tr3.stats.overlapPairFrames} frames ${tr3.stats.overlapFrames} cars ${tr3.stats.overlapCarFrames}`);
}

console.log('\n2. junction-box classifier separates the two cases');
{
  const E = longEdge(80);
  const trIn = rig(2);
  const a = place(trIn, 0, E, true, 2), b = place(trIn, 1, E, true, 2.5);
  run(trIn, playerAt(trIn, a), 30);
  check('pair 2 m into an edge -> classified at a junction',
    trIn.stats.overlapPairsNearJunction === 30 && trIn.stats.overlapPairsMidBlock === 0,
    `nearJ ${trIn.stats.overlapPairsNearJunction} mid ${trIn.stats.overlapPairsMidBlock}`);
  void b;

  const trMid = rig(2);
  const c = place(trMid, 0, E, true, 40); place(trMid, 1, E, true, 40.5);
  run(trMid, playerAt(trMid, c), 30);
  check('pair 40 m into an 80 m edge -> classified mid-block',
    trMid.stats.overlapPairsMidBlock === 30 && trMid.stats.overlapPairsNearJunction === 0,
    `nearJ ${trMid.stats.overlapPairsNearJunction} mid ${trMid.stats.overlapPairsMidBlock}`);
}

console.log('\n3. junction wait episodes measure the real denial duration');
{
  const E = longEdge(80);
  const tr = rig(1);
  const car = place(tr, 0, E, true, tr._len(E) - 10, { v: 0, limit: 0 });
  const jv = tr._endVertex(E, true);
  // A phantom holder that this car can never be, so the claim is refused.
  tr._blockJunction(jv);
  const pos = playerAt(tr, car);
  run(tr, pos, 60);                       // 1.0 s denied
  check('denied car accrues wait but does not close the episode',
    tr.stats.waitEpisodes === 0 && Math.abs(car.waitS - 1) < 0.02, `waitS ${car.waitS.toFixed(3)}`);
  tr._unblockJunction(jv);
  run(tr, pos, 1);                        // granted -> episode closes
  const w = tr.waitReport();
  check('episode closes at the measured duration',
    w.episodes === 1 && Math.abs(w.maxS - 1) < 0.03, `episodes ${w.episodes} maxS ${w.maxS}`);

  const trFree = rig(1);
  const car2 = place(trFree, 0, E, true, 10, { v: 5, limit: 8 });
  run(trFree, playerAt(trFree, car2), 300);
  check('an unobstructed car records zero wait episodes',
    trFree.waitReport().episodes === 0, `episodes ${trFree.waitReport().episodes}`);
}

console.log('\n4. throughput counter (harness side) counts real edge transitions');
{
  const { runOnce } = await import('./traffic-sim.mjs');
  const moving = runOnce({ cars: 8, seed: 5, seconds: 40, warmup: 5, player: 'static' });
  check('a moving fleet crosses junctions', moving.crossingsPerMin > 20, `${moving.crossingsPerMin}/min`);

  // Opposite reading: pin the fleet, the counter must read zero.
  const E = longEdge(80);
  const tr = rig(3);
  const a = place(tr, 0, E, true, 10); place(tr, 1, E, true, 30); place(tr, 2, E, true, 50);
  const pos = playerAt(tr, a);
  const prev = tr.cars.map((c) => ({ id: c.id, edge: c.edge, forward: c.forward }));
  let crossings = 0;
  for (let f = 0; f < 600; f++) {
    tr.update(1 / 60, pos);
    tr.cars.forEach((c, i) => {
      if (c && prev[i] && prev[i].id === c.id && (prev[i].edge !== c.edge || prev[i].forward !== c.forward)) crossings++;
      if (c) prev[i] = { id: c.id, edge: c.edge, forward: c.forward };
    });
  }
  check('a pinned fleet crosses nothing', crossings === 0, `${crossings}`);
}

console.log('\n5. conflict predicate: crossing movements conflict, parallel ones do not');
if (!TrafficMod.conflictSelfTest) { console.log('  skip (no conflict model in this build)'); } else {
  const r = TrafficMod.conflictSelfTest(new Traffic(scene, district, { count: 1 }));
  for (const c of r) check(c.name, c.ok, c.detail);
}

console.log('\n6. gridlock recovery fires only on a real gridlock');
if (new Traffic(scene, district, { count: 1 }).stats.gridlockRecoveries === undefined) { console.log('  skip (no recovery in this build)'); } else {
  const E = longEdge(80);
  const tr = rig(1);
  const car = place(tr, 0, E, true, tr._len(E) - 10, { v: 0, limit: 0 });
  const jv = tr._endVertex(E, true);
  tr._blockJunction(jv);
  run(tr, playerAt(tr, car), Math.round(60 * (tr.stuckLimitS + 2)));
  check('a car immobile past the stuck limit is recovered',
    tr.stats.gridlockRecoveries >= 1, `${tr.stats.gridlockRecoveries}`);

  const free = runOnce30();
  check('free-flowing traffic triggers no recovery',
    free === 0, `${free} recoveries`);
}
function runOnce30() {
  const tr = new Traffic(scene, district, { count: 6 });
  const s = district.meta.spawn;
  for (let f = 0; f < 3000; f++) tr.update(1 / 60, s);
  return tr.stats.gridlockRecoveries;
}

// ---------------------------------------------------------------------------
const tr0 = new Traffic(scene, district, { count: 1 });
console.log('\n7. the lane offset fits inside the road it is on');
//
// `_laneOffset` was `min(3.6, max(2.2, w/4))`, and the 2.2 m FLOOR was the defect: on a 2.8 m
// service alley the carriageway's half-width is 1.40 m, so a car pushed 2.2 m off the
// centreline had its CENTRE 0.80 m outside the road and its body reaching 3.15 m — 1.75 m of
// car over the kerb line. The district is 38.3% service alley by length.
{
  const CAR_HALF_W = 0.95, TWO_WAY_MIN_W = 3.8;
  const widths = [...new Set(district.edges.map((e) => e.w))].sort((a, b) => a - b);
  const old = (w) => Math.min(3.6, Math.max(2.2, w / 4));
  let worstOld = 0, worstNew = 0;
  for (const w of widths) {
    // A two-way edge of this width, taken from the data rather than invented.
    const ei = district.edges.findIndex((e) => e.w === w && e.o === 0);
    if (ei < 0) continue;
    const got = tr0._laneOffset(ei);
    const reachOld = old(w) + CAR_HALF_W, reachNew = got + CAR_HALF_W;
    worstOld = Math.max(worstOld, reachOld - w / 2);
    worstNew = Math.max(worstNew, reachNew - w / 2);
    check(`a ${w} m road keeps the body inside the carriageway`, reachNew <= w / 2 + 1e-9,
      `body reaches ${reachNew.toFixed(2)} m against a ${(w / 2).toFixed(2)} m half-width`);
    if (w < TWO_WAY_MIN_W) {
      check(`and a ${w} m road is single track`, got === 0, `${got}`);
    }
  }
  console.log(`  worst overhang: was ${worstOld.toFixed(2)} m past the kerb line, now ${worstNew.toFixed(2)}`);
  check('KNOWN-BAD: the old rule hung the body over the kerb', worstOld > 1.5,
    `${worstOld.toFixed(2)} m`);

  /**
   * AND THE WIDTH IS STILL NOT ENOUGH, which this district settles by 0.45 m: a footprint can
   * encroach that far into the drawn carriageway, so the widest lane the width rule can justify
   * still clips it. The fit measures instead. Census over every two-way edge, both directions.
   */
  const ix7 = new BlockerIndex(district);
  const fitted = new Traffic(scene, district, { count: 1 });
  fitted.clearAt = (x, z, r) => !ix7.resolveCircle(x, z, r);
  let nominalBad = 0, fitBad = 0, reduced = 0, longest = 0, shortRung = 0;
  for (let i = 0; i < district.edges.length; i++) {
    for (const forward of [true, false]) {
      const want = fitted._laneNominal(i);
      if (!(want > 0)) continue;
      const got = fitted._laneOffset(i, forward);
      if (!fitted._laneClear(i, forward, want)) nominalBad++;
      if (!fitted._laneClear(i, forward, got)) fitBad++;
      if (got < want) {
        reduced++;
        // THE FIT OWES THE LONGEST CLEAR RUNG: the rung above the one taken must be blocked.
        const rungs = [1, 0.75, 0.5, 0.25];
        const above = rungs[Math.max(0, rungs.findIndex((f) => Math.abs(want * f - got) < 1e-9) - 1)];
        if (got === 0 || !fitted._laneClear(i, forward, want * above)) longest++;
        else shortRung++;
      }
    }
  }
  console.log(`  lane fit over every two-way edge, both directions: ` +
    `${nominalBad} blocked at the width rule's offset, ${fitBad} after the fit, ` +
    `${reduced} reduced`);
  check('KNOWN-BAD: the width rule alone leaves lanes inside buildings', nominalBad > 0,
    `${nominalBad} directions`);
  check('the fit leaves none of them blocked', fitBad === 0, `${fitBad}`);
  check('and it takes the longest clear rung', shortRung === 0 && longest === reduced,
    `${longest} of ${reduced} verified, ${shortRung} took a short rung with a clear one above`);
  // With no clearAt the module still works and the width rule stands, which is what keeps it
  // usable without a blocker index.
  const bare = new Traffic(scene, district, { count: 1 });
  const someTwoWay = district.edges.findIndex((e) => e.o === 0 && e.w >= 3.8);
  check('with no blocker predicate the width rule stands',
    bare._laneOffset(someTwoWay, true) === bare._laneNominal(someTwoWay),
    `${bare._laneOffset(someTwoWay, true)}`);
}

/**
 * 7b. THE PLAYER'S CAR IS A LEADER, and until this round it was invisible to the fleet.
 *
 * A playtester crept forward at 3 km/h for 150 s at the first mission's start point, with an
 * empty-city control, so that anything charged above 2 m/s had to be the other car's: 187
 * contacts, an 8.0 m/s charged delta-v, health 1.00 -> 0.638, and TWO `civilianCollision` crimes
 * filed against the player for sitting in their own lane. The same run with `traffic: 0` took no
 * contacts at all.
 */
console.log('\n7b. the fleet brakes for the player');
{
  const ix = new BlockerIndex(district);
  const near = new Traffic(scene, district, { count: 30 });
  near.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
  const P = { x: 19, z: -6 }, STILL = { x: 0, y: 0, z: 0 };
  // 3.31 m is BODY_ENCLOSING + a car's 0.95 m radius: the distance at which district/main.js's
  // moving-body pass tests for a contact at all, so a car-frame inside it is a crash waiting.
  const CONTACT_R = 3.31;
  let closest = Infinity, inside = 0, frames = 0;
  for (let k = 0; k < 60 * 120; k++) {
    near.update(1 / 60, P, STILL);
    for (const p of near._lastPositions) {
      frames++;
      const d = Math.hypot(p.x - P.x, p.z - P.z);
      if (d < closest) closest = d;
      if (d < CONTACT_R) inside++;
    }
  }
  console.log(`  120 s parked on Marlin Street: closest approach ${closest.toFixed(2)} m, ` +
    `${inside} of ${frames} car-frames inside ${CONTACT_R} m, ` +
    `braked for the player on ${near.stats.playerLeaderFrames} frames`);
  console.log('  (the same measurement before this change: 1.83 m closest, 239 car-frames inside)');
  check('the fleet was driving', frames > 100000, `${frames} car-frames`);
  check('the mechanism fired', near.stats.playerLeaderFrames > 0,
    `${near.stats.playerLeaderFrames} frames`);
  check('no car drives onto a parked player', inside === 0, `${inside} car-frames inside ${CONTACT_R} m`);
  check('and it keeps a real gap, not a grazing one', closest > 4, `${closest.toFixed(2)} m`);
  /**
   * THE CONTROL IS THE SAME FLEET WITH THE PLAYER MOVED OFF IT. One Traffic, 60 s parked in the
   * middle of it and then 60 s with the player 400 m away: the second half must brake for nobody.
   * That is what says the counter is about the player rather than about traffic braking for its
   * own reasons, which it does constantly — `followBrakeCarFrames` is in the thousands either way.
   */
  const away = new Traffic(scene, district, { count: 30 });
  away.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
  for (let k = 0; k < 60 * 60; k++) away.update(1 / 60, P, STILL);
  const brakedWhileParkedInIt = away.stats.playerLeaderFrames;
  for (let k = 0; k < 60 * 60; k++) away.update(1 / 60, { x: P.x + 400, z: P.z }, STILL);
  const brakedAfterMovingOff = away.stats.playerLeaderFrames - brakedWhileParkedInIt;
  check('the control braked for the player while they were parked in it',
    brakedWhileParkedInIt > 0, `${brakedWhileParkedInIt} frames`);
  check('and a player 400 m away is nobody\'s leader', brakedAfterMovingOff === 0,
    `${brakedAfterMovingOff} frames after moving off, against ${brakedWhileParkedInIt} in it`);
}

console.log('\n8. no car is ever published inside a building');
{
  const ix = new BlockerIndex(district);
  const tr = new Traffic(scene, district, { count: 30 });
  /**
   * AND IT WIRES `clearAt`, WHICH IT DID NOT. district/main.js and tools/playtest.mjs both hand
   * the fleet a blocker predicate; this gate built a Traffic with none, so it was measuring a
   * configuration the game never runs — the lane fit added in this round was skipped entirely and
   * the check then read the unfitted offset. CLAUDE.md's own rule: when a tool replays the build,
   * it must replay the build's own selection.
   */
  tr.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
  let frames = 0, inside = 0, worst = 0;
  for (let k = 0; k < 60 * 120; k++) {
    tr.update(1 / 60, { x: 19, z: -6 });
    for (const p of tr._lastPositions) {
      frames++;
      const r = ix.resolveCircle(p.x, p.z, 0.95);
      if (r) { inside++; worst = Math.max(worst, Math.hypot(r.x - p.x, r.z - p.z)); }
    }
  }
  console.log(`  120 s of a 30-car fleet: ${frames} car-frames, ${inside} inside a building, ` +
    `worst ${worst.toFixed(2)} m`);
  check('the fleet was actually driving', frames > 100000, `${frames} car-frames`);
  check('no car body is published inside a building', inside === 0, `${inside}, worst ${worst.toFixed(2)} m`);
  // The other half: single-tracking narrow roads is what keeps them from meeting head-on.
  console.log(`  overlap pair-frames ${tr.stats.overlapPairFrames}, ` +
    `closest approach ${tr.stats.closestApproachM} m`);
  check('and no two cars overlap', tr.stats.overlapPairFrames === 0,
    `${tr.stats.overlapPairFrames}`);
}

// THE SUMMARY AND THE EXIT ARE THE LAST THING IN THIS FILE, and they have to be: appending
// two sections after a mid-file `process.exit` ran them exactly zero times and the gate still
// printed "22 passed, 0 failed". A gate that cannot reach its own checks passes.
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
