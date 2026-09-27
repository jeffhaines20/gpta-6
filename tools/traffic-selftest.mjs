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
 * 7b. THE PLAYER'S CAR IS A LEADER, and this section asserted a coincidence.
 *
 * A playtester crept forward at 3 km/h for 150 s at the first mission's start point, with an
 * empty-city control, so that anything charged above 2 m/s had to be the other car's: 187
 * contacts, an 8.0 m/s charged delta-v, health 1.00 -> 0.638, and TWO `civilianCollision` crimes
 * filed against the player for sitting in their own lane. The fix for that is real.
 *
 * WHAT THIS SECTION GOT WRONG IS THE NUMBER IT ASSERTED. It checked a closest CENTRE approach of
 * 6.29 m and zero car-frames inside the contact radius, at one dt, one seed and one fleet size. A
 * second reviewer swept all three:
 *
 *     closest centre approach     dt 1/60   dt 1/120   dt 1/50   dt 1/20
 *     the player term removed        1.83       1.83      1.83      1.83
 *     as it shipped                  6.29       2.03      2.03      2.46
 *
 * The removed-term arm reads 1.83 m at EVERY dt, which is what says the instrument is sound and
 * the dt dependence belonged to the fix. district/main.js's own frame time is `min(0.05, real)`,
 * so the shipped game runs at 1/120 on a fast display and ~1/50 on a loaded one — never at the
 * one value this gate used. 8 of 10 seeds put a car inside the contact radius, and 40 and 60-car
 * fleets did too. It is CLAUDE.md's "a threshold that holds at one value and fails at every other
 * is a coincidence", in a gate written three commits after that lesson was recorded.
 *
 * SO IT SWEEPS, AND IT MEASURES THE RIGHT QUANTITY. Centre distance is not a collision: two cars
 * abeam at 2.46 m have 0.56 m of clearance between 1.9 m bodies. Body separation through the
 * game's own five-circle collider is the quantity that matters, and it is what caught the
 * remaining defect — a player parked ACROSS a lane, which the point-like corridor could not see.
 */
console.log('\n7b. the fleet brakes for the player, at every dt, seed and fleet size');
{
  const ix = new BlockerIndex(district);
  const P = { x: 19, z: -6 }, STILL = { x: 0, y: 0, z: 0 };
  const SAMPLES = [-1.2, -0.6, 0, 0.6, 1.2], R = 0.95;
  // Body-to-body separation, both cars as the five circles src/vehicle.js collides with.
  const sep = (ax, az, afx, afz, bx, bz, bfx, bfz) => {
    let best = Infinity;
    for (const sa of SAMPLES) {
      const px = ax + afx * sa, pz = az + afz * sa;
      for (const sb of SAMPLES) {
        best = Math.min(best, Math.hypot(bx + bfx * sb - px, bz + bfz * sb - pz) - 2 * R);
      }
    }
    return best;
  };
  // The lane's own direction at P, from the data, so ALONG and ACROSS are the real orientations.
  let lane = null;
  for (let i = 0; i < district.edges.length && !lane; i++) {
    const e = district.edges[i];
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];
      if (Math.hypot(a.x - P.x, a.z - P.z) < 12 || Math.hypot(b.x - P.x, b.z - P.z) < 12) {
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        lane = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
        break;
      }
    }
  }
  const ACROSS = { x: -lane.z, z: lane.x };
  const arm = ({ dt = 1 / 60, seed, count = 30, fwd = lane, secs = 120, noTerm = false }) => {
    const tr = new Traffic(scene, district, seed === undefined ? { count } : { count, seed });
    tr.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
    if (noTerm) tr._playerGap = () => Infinity;
    let body = Infinity, overlaps = 0, frames = 0;
    for (let k = 0; k < Math.round(secs / dt); k++) {
      tr.update(dt, P, STILL, fwd);
      for (const p of tr._lastPositions) {
        frames++;
        const cy = p.heading ?? p.yaw;
        const d = sep(P.x, P.z, fwd.x, fwd.z, p.x, p.z, Math.sin(cy), Math.cos(cy));
        if (d < body) body = d;
        if (d < 0) overlaps++;
      }
    }
    return { body, overlaps, frames, none: tr.stats.gridlockByReason.none,
      leader: tr.stats.playerLeaderFrames, pinned: tr.stats.playerPinnedCars,
      recovered: tr.stats.gridlockRecoveries };
  };

  // --- the sweep. Every combination must keep the bodies apart, not just the gate's own one.
  const DTS = [1 / 60, 1 / 120, 1 / 50, 1 / 20];
  console.log('    dt        body closest   overlaps   gridlock.none   leaderFrames');
  let worstBody = Infinity, totalOverlaps = 0, totalNone = 0;
  for (const dt of DTS) {
    const a = arm({ dt });
    worstBody = Math.min(worstBody, a.body);
    totalOverlaps += a.overlaps; totalNone += a.none;
    console.log(`    ${dt.toFixed(5)}   ${a.body.toFixed(2).padStart(10)}   ` +
      `${String(a.overlaps).padStart(8)}   ${String(a.none).padStart(13)}   ${a.leader}`);
  }
  check('no dt lets a car touch a parked player', totalOverlaps === 0, `${totalOverlaps} overlaps`);
  check('and the gap is the same at every dt, which is what an equilibrium looks like',
    worstBody > 2, `worst body separation ${worstBody.toFixed(2)} m`);
  // KNOWN-BAD: the term removed. The reviewer's own control, and it must fail the same test.
  const off = arm({ noTerm: true });
  console.log(`    the player term removed:  body ${off.body.toFixed(2)} m, ` +
    `${off.overlaps} overlaps`);
  check('KNOWN-BAD: without the term a car does touch a parked player', off.body < worstBody,
    `${off.body.toFixed(2)} m against ${worstBody.toFixed(2)}`);

  console.log('    seed  along the lane        across it');
  let seedOverlaps = 0, seedWorst = Infinity;
  for (let seed = 0; seed < 10; seed++) {
    const al = arm({ seed, secs: 60 }), ac = arm({ seed, fwd: ACROSS, secs: 60 });
    seedOverlaps += al.overlaps + ac.overlaps;
    seedWorst = Math.min(seedWorst, al.body, ac.body);
    if (seed < 3 || al.overlaps || ac.overlaps) {
      console.log(`    ${seed}     ${al.body.toFixed(2).padStart(6)} m / ${al.overlaps} ` +
        `          ${ac.body.toFixed(2).padStart(6)} m / ${ac.overlaps}`);
    }
  }
  /**
   * ACROSS THE LANE IS THE ORIENTATION THAT BROKE IT. `_playerGap` measured its corridor from the
   * player's centre POINT, so a car parked across a lane presented 2.15 m of itself to traffic
   * that could not see it: body separation -0.64 m, 29-77 overlaps at seeds 2 and 8, every one by
   * a car whose own `_playerGap` had returned Infinity. Passing the player's heading and taking
   * the support function of their box turns that into +3.3 m of clearance.
   */
  check('no seed and no orientation lets a car touch a parked player', seedOverlaps === 0,
    `${seedOverlaps} overlaps over 20 arms`);
  check('and the worst separation across them all is a real gap', seedWorst > 1.5,
    `${seedWorst.toFixed(2)} m`);

  console.log('    cars  body closest  gridlock.none');
  let sizeOverlaps = 0, sizeNone = 0;
  for (const count of [10, 20, 30, 40, 60]) {
    const a = arm({ count, secs: 60 });
    sizeOverlaps += a.overlaps; sizeNone += a.none;
    console.log(`    ${String(count).padStart(3)}   ${a.body.toFixed(2).padStart(11)}  ${a.none}`);
  }
  check('no fleet size lets a car touch a parked player', sizeOverlaps === 0,
    `${sizeOverlaps} overlaps`);

  /**
   * AND A CAR WAITING FOR THE PLAYER IS NOT DELETED AS GRIDLOCKED. `gridlockByReason.none` is the
   * channel for "stationary for no arbitration reason", and it read 0 in every arm without the
   * player term and 0 with the player 600 m off the network. With the term and no exemption it
   * read 11-12: a reviewer measured 30 cars taken away over 300 s, 24 of them within 70 m of the
   * player and EVERY ONE at 6.8 m — one car length ahead, blinking out every 12.5 s.
   */
  check('a car stopped for the player is not deleted as gridlocked',
    totalNone === 0 && sizeNone === 0, `${totalNone + sizeNone} 'none'-reason recoveries`);
  const pinned = arm({ secs: 120 });
  console.log(`    cars pinned by the parked player: ${pinned.pinned}, ` +
    `gridlock recoveries ${pinned.recovered}, reason none ${pinned.none}`);
  check('the exemption fired, so the check above is not vacuous', pinned.pinned > 0,
    `${pinned.pinned} cars pinned`);
  // THE CONTROL: with the player far away nothing is pinned, and the anti-gridlock rule is still
  // free to fire for its own reasons — the exemption must not have disabled it.
  const far = new Traffic(scene, district, { count: 30 });
  far.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
  for (let k = 0; k < 60 * 120; k++) far.update(1 / 60, { x: 4000, z: 4000 }, STILL, lane);
  console.log(`    with the player 4 km off: pinned ${far.stats.playerPinnedCars}, ` +
    `leaderFrames ${far.stats.playerLeaderFrames}, gridlock.none ${far.stats.gridlockByReason.none}`);
  check('a player 4 km away pins nobody', far.stats.playerPinnedCars === 0,
    `${far.stats.playerPinnedCars}`);
  /**
   * AND IS NOBODY'S LEADER. There was no range bound at all, and the pre-filter is skipped on a
   * car's first published frame, so a reviewer measured 956 finite gaps beyond 50 m and 165
   * "leader frames" with the player 600 m off the network. Harmless numerically — IDM's term at
   * that range is ~0.014 m/s^2 — but `playerLeaderFrames` is this gate's "the mechanism fired"
   * counter, so it was a probe measuring the opportunity rather than the fix.
   */
  check('and is nobody\'s leader, at any distance', far.stats.playerLeaderFrames === 0,
    `${far.stats.playerLeaderFrames} frames`);
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
