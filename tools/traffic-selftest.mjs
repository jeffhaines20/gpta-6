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
import { Traffic, LANE_FIT } from '../src/traffic.js';
import { BlockerIndex } from '../src/blockers.js';
import * as TrafficMod from '../src/traffic.js';
import { ACHROMATIC_SHARE } from '../src/carpaint.js';

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
    // `body` is the shell this slot draws, measured off its own buffer. Taken from the module
    // the way the spawner takes it rather than typed in here — CLAUDE.md's "a gate that
    // constructs the subject itself has to construct it the way the game does", and the check
    // below that compares the rig's fields with a spawned car's is what caught it missing.
    id: ++tr._nextId, edge, forward, t, len: tr._len(edge), body: tr._bodyLen(slot),
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
  // Every lane the census WALKS, and every one it used to skip. See the block below.
  let walked = 0, centreBad = 0, centreBadM = 0, fellThrough = 0;
  const centreBadLanes = [];
  const centreBadClasses = new Map();
  for (let i = 0; i < district.edges.length; i++) {
    for (const forward of [true, false]) {
      const want = fitted._laneNominal(i);
      /**
       * THE CENSUS USED TO SKIP EVERY LANE WITH NO OFFSET — `if (!(want > 0)) continue` — which is
       * 1,312 of 1,870 (edge, direction) lanes: every one-way edge and every single-track road
       * under TWO_WAY_MIN_W. So it walked 558 lanes out of a network the fleet drives 1,198 states
       * of, and CLAUDE.md's "an audit that walks less than the build cannot fail" is precisely this
       * file. A blind playtester found it and found what it hid.
       *
       * Those lanes have an offset of 0 — they are driven down the centreline — so the clearance
       * question is not "is there no offset to check", it is "is the centreline clear". 24 of them
       * are not, over 12 distinct edges, all 2.8 m `service` alleys: 107.4 m of road a car body
       * cannot fit along, with edges 742 and 766 blocked at every single sample for 36.2 and
       * 32.5 m. And they were REACHABLE: a BFS over the states `_chooseNext` walks reached 9 of
       * the 12, 742 among them.
       */
      if (!(want > 0)) {
        if (!fitted._laneClear(i, forward, 0)) {
          centreBad++;
          centreBadM += fitted._len(i);
          const c = district.edges[i].c ?? '?';
          centreBadClasses.set(c, (centreBadClasses.get(c) ?? 0) + 1);
          centreBadLanes.push({ i, forward });
        }
        continue;
      }
      walked++;
      /**
       * AND `LANE_FIT` HAS NO 0 RUNG, so a two-way lane with no clear rung falls through to
       * `amt = 0` — the centreline — which the ladder never tested. Counted here rather than
       * assumed absent: 1 lane in this district falls through, and its centreline happens to be
       * clear. Latent, and `_edgeDrivable` now tests the offset the fit actually chose, so the
       * fallback is covered by the same predicate as everything else.
       */
      if (!LANE_FIT.some((f) => fitted._laneClear(i, forward, want * f))) fellThrough++;
      const got = fitted._laneOffset(i, forward);
      if (!fitted._laneClear(i, forward, want)) nominalBad++;
      if (!fitted._laneClear(i, forward, got)) fitBad++;
      if (got < want) {
        reduced++;
        // THE FIT OWES THE LONGEST CLEAR RUNG: the rung above the one taken must be blocked.
        // The module's own ladder, imported rather than copied: a duplicate is a magic number
        // waiting for LANE_FIT to change under it.
        const above = LANE_FIT[Math.max(0,
          LANE_FIT.findIndex((f) => Math.abs(want * f - got) < 1e-9) - 1)];
        if (got === 0 || !fitted._laneClear(i, forward, want * above)) longest++;
        else shortRung++;
      }
    }
  }
  console.log(`  lane fit over every two-way edge, both directions: ` +
    `${nominalBad} blocked at the width rule's offset, ${fitBad} after the fit, ` +
    `${reduced} reduced`);
  console.log(`  lanes walked ${walked} of ${district.edges.length * 2}; ` +
    `the other ${district.edges.length * 2 - walked} have no offset and are tested below`);
  console.log(`  CENTRELINE lanes (the 1,312 this census used to skip): ` +
    `${centreBad} a car body cannot follow, ${centreBadM.toFixed(1)} m of edge, ` +
    `classes ${[...centreBadClasses].map(([k, v]) => `${k} ${v}`).join(', ') || 'none'}`);
  console.log(`  two-way lanes whose whole ladder is blocked (fall through to the untested 0): ` +
    `${fellThrough}`);
  check('KNOWN-BAD: some roads cannot carry a car body down their own centreline',
    centreBad > 0, `${centreBad} lanes, ${centreBadM.toFixed(1)} m`);
  /**
   * THE EXCLUSION IS ASSERTED BY REACHABILITY, NOT BY ITS OWN PREDICATE. The first version of this
   * check asked `_edgeDrivable` about exactly the lanes that had just failed
   * `_laneClear(i, forward, 0)` — and for a lane with no offset those are the SAME CALL, so the
   * equality could not fail however broken the exclusion was. CLAUDE.md's "a self-validation that
   * closes over the same quantity twice validates nothing", one round after the shunt fit wrote it
   * down. Collapsing the filter in `_chooseNext` to `() => true` left it reading 24 of 24.
   *
   * What the exclusion owes is that a car can never BE on one of these lanes, so the check is a
   * BFS over the (edge, direction) states `_chooseNext` actually walks, from the spawn set, through
   * the same filter the module applies. Independent of the predicate: it can only pass if the
   * filter is wired into the walk.
   */
  {
    const key = (e, f) => `${e}:${f ? 1 : 0}`;
    const reach = (filtered) => {
      const seen = new Set(), q = [];
      const ok = (e, f) => !filtered || fitted._edgeDrivable(e, f);
      for (const e of fitted.spawnable) {
        const ed = district.edges[e];
        const single = ed.o === 0 && ed.w < TWO_WAY_MIN_W;
        for (const f of [true, false]) {
          if (f && ed.o < 0) continue;
          if (!f && (ed.o > 0 || single)) continue;
          if (!ok(e, f)) continue;
          if (!seen.has(key(e, f))) { seen.add(key(e, f)); q.push({ e, f }); }
        }
      }
      for (let h = 0; h < q.length; h++) {
        const st = q[h];
        const v = fitted._endVertex(st.e, st.f);
        const opts = (fitted.out.get(v) ?? [])
          .filter((o) => !(o.e === st.e && o.forward !== st.f) && ok(o.e, o.forward));
        if (!opts.length && district.edges[st.e].o === 0) opts.push({ e: st.e, forward: !st.f });
        for (const o of opts) {
          if (!seen.has(key(o.e, o.forward))) { seen.add(key(o.e, o.forward)); q.push({ e: o.e, f: o.forward }); }
        }
      }
      return seen;
    };
    const before = reach(false), after = reach(true);
    const hitBefore = centreBadLanes.filter((l) => before.has(key(l.i, l.forward))).length;
    const hitAfter = centreBadLanes.filter((l) => after.has(key(l.i, l.forward))).length;
    console.log(`  reachable (edge,direction) states: ${before.size} unfiltered, ${after.size} filtered`);
    console.log(`  of the ${centreBadLanes.length} undrivable lanes, reachable: ` +
      `${hitBefore} unfiltered -> ${hitAfter} filtered`);
    check('KNOWN-BAD: a car could route onto a road it cannot fit down', hitBefore > 0,
      `${hitBefore} of ${centreBadLanes.length} reachable without the filter`);
    check('and none of them is reachable once the filter is applied', hitAfter === 0,
      `${hitAfter} still reachable`);
    /**
     * AND THE COLLATERAL IS ACCOUNTED FOR RATHER THAN DENIED. The first version of this asserted
     * that exactly the undrivable lanes are lost, and it failed reading 12 against 9 — because
     * three MORE lanes become unreachable, and they should: an alley whose only route in ran
     * through a building is not reachable once the building is respected. All three are 2.8 m
     * service alleys (edges 436, 431 and 775, 122.3 m in all), each with a single inbound state
     * and that state now gone.
     *
     * So the property is not "nothing else is lost", it is "everything lost is either undrivable
     * or has no route in left". That distinguishes correct collateral from a filter that cut a
     * through street, which is what this check is for.
     */
    const lost = [...before].filter((k) => !after.has(k));
    const undrivableLost = [], orphaned = [], unexplained = [];
    let orphanM = 0;
    for (const k of lost) {
      const [es, fs2] = k.split(':');
      const i = +es, forward = fs2 === '1';
      if (!fitted._edgeDrivable(i, forward)) { undrivableLost.push(k); continue; }
      const ed = district.edges[i];
      const v = ed.v[forward ? 0 : ed.v.length - 1];
      const inbound = [...after].filter((k2) => {
        const [e2, f2] = k2.split(':');
        return +e2 !== i && fitted._endVertex(+e2, f2 === '1') === v;
      });
      if (inbound.length === 0) { orphaned.push(k); orphanM += fitted._len(i); }
      else unexplained.push(k);
    }
    console.log(`  ${lost.length} states lost: ${undrivableLost.length} undrivable, ` +
      `${orphaned.length} left with no route in (${orphanM.toFixed(1)} m of service alley), ` +
      `${unexplained.length} unexplained`);
    check('every lane the filter costs is undrivable or has no route in left',
      unexplained.length === 0, unexplained.join(' ') || 'none unexplained');
    check('and the filter is what did it, not a disconnected graph',
      undrivableLost.length === hitBefore, `${undrivableLost.length} against ${hitBefore}`);

    /**
     * AND THE MODULE'S OWN `_chooseNext` IS WHAT IS ASKED, because the BFS above is not.
     *
     * Deleting the `_edgeDrivable` term from `_chooseNext`'s option filter — which IS the
     * shipped-before behaviour — left every check in this file passing, 52 of 52. The BFS walks a
     * REIMPLEMENTATION of the option rule and applies the predicate itself, so it proves the
     * predicate and says nothing about whether the module consults it. That is CLAUDE.md's
     * "nothing asserts that the game reaches it", in the arm written to assert exactly that.
     *
     * So: every state that is itself drivable and has an undrivable exit, hammered through the
     * real `_chooseNext` 400 times each, and the undrivable exit must never come back. Measured
     * with the filter deleted, 400 of 3,200 calls returned it — a non-empty known-bad, which is
     * what makes the zero meaningful.
     */
    const hammer = (filtered) => {
      const t = new Traffic(scene, district, { count: 1 });
      t.clearAt = (x, z, r) => !ix7.resolveCircle(x, z, r);
      const real = t._edgeDrivable.bind(t);
      if (!filtered) t._edgeDrivable = () => true;
      let picks = 0, calls = 0, pairs = 0;
      for (let i = 0; i < district.edges.length; i++) {
        for (const f of [true, false]) {
          const v = t._endVertex(i, f);
          const opts = (t.out.get(v) ?? []).filter((o) => !(o.e === i && o.forward !== f));
          const bad = opts.filter((o) => !real(o.e, o.forward));
          if (!bad.length || !real(i, f)) continue;
          pairs++;
          const car = { edge: i, forward: f, len: t._len(i) };
          for (let k = 0; k < 400; k++) {
            const got = t._chooseNext(car);
            calls++;
            if (got && bad.some((o) => o.e === got.e && o.forward === got.forward)) picks++;
          }
        }
      }
      return { pairs, calls, picks };
    };
    const unfiltered = hammer(false), live = hammer(true);
    console.log(`  _chooseNext from the ${live.pairs} drivable states that have an undrivable exit: ` +
      `${unfiltered.picks} of ${unfiltered.calls} calls returned it with the filter removed, ` +
      `${live.picks} of ${live.calls} as shipped`);
    check('KNOWN-BAD: without the filter _chooseNext hands back the undrivable exit',
      unfiltered.pairs > 0 && unfiltered.picks > 0,
      `${unfiltered.picks} of ${unfiltered.calls} over ${unfiltered.pairs} states`);
    check('the shipped _chooseNext never hands back an undrivable exit', live.picks === 0,
      `${live.picks} of ${live.calls}`);

    /**
     * AND THE SPAWN GUARD IS UNTESTABLE AGAINST THIS DISTRICT, which is worth saying rather than
     * leaving as a passing file. Deleting `_spawn`'s `_edgeDrivable` check leaves all 54 checks
     * green, because every undrivable edge here is rank 8 and `spawnable` filters at rank <= 6 —
     * so no spawn can reach one whether the guard exists or not.
     *
     * That is their rank agreeing with their geometry by accident, not a rule, so the guard stays
     * and the coincidence is asserted instead. If a re-baked graph ever puts an undrivable edge in
     * the spawn set this check fails, which is the moment the guard starts earning its place.
     */
    const spawnUndrivable = fitted.spawnable.filter(
      (e) => [true, false].some((f) => !fitted._edgeDrivable(e, f)));
    const ranks = [...new Set(centreBadLanes.map((l) => district.edges[l.i].r))].sort((a, b) => a - b);
    console.log(`  spawnable edges that are undrivable: ${spawnUndrivable.length} ` +
      `(the undrivable edges are rank ${ranks.join('/')}; spawnable is rank <= 6), so _spawn's own ` +
      `guard cannot be exercised by this district`);
    check('no spawnable edge is undrivable, so the spawn guard is belt-and-braces here',
      spawnUndrivable.length === 0, `${spawnUndrivable.length} of ${fitted.spawnable.length}`);
  }
  check('the census walks every lane, not just the ones with an offset',
    walked + centreBad > 0 && walked < district.edges.length * 2,
    `${walked} with an offset, ${district.edges.length * 2 - walked} without, all now tested`);
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
  const bodies = [];
  for (const dt of DTS) {
    const a = arm({ dt });
    worstBody = Math.min(worstBody, a.body);
    bodies.push(a.body);
    totalOverlaps += a.overlaps; totalNone += a.none;
    console.log(`    ${dt.toFixed(5)}   ${a.body.toFixed(2).padStart(10)}   ` +
      `${String(a.overlaps).padStart(8)}   ${String(a.none).padStart(13)}   ${a.leader}`);
  }
  check('no dt lets a car touch a parked player', totalOverlaps === 0, `${totalOverlaps} overlaps`);
  /**
   * THE LABEL SAID "THE SAME AT EVERY dt" AND THE ASSERTION WAS A FLOOR, which is not the same
   * statement and is why a revert walked through it. `tools/mutation-sweep.mjs` put
   * `_playerGap`'s `along > CAR_LENGTH` back to `along > 0` — the defect that made a car drawing
   * level with the player read a bumper gap of -4.4 m and brake at 28x the free-road acceleration
   * — and every gate in the offline list passed, because a car that slams to a halt beside the
   * player does not OVERLAP it and the gap stays over 2 m. The behaviour is wrong and both
   * predicates were satisfied.
   *
   * What the fix actually alters is the dt-INVARIANCE of the settled gap. Measured at the time:
   *
   *     dt          1/60   1/120   1/50   1/20
   *     before      1.83    1.83   1.83   1.83   (the player term removed entirely)
   *     partial     6.29    2.03   2.03   2.46   (`along > 0`)
   *     shipped     6.29    6.29   6.29   6.29
   *
   * So the check is the SPREAD, and the floor stays beside it as a separate statement. The spread
   * bound is a fraction of the gap rather than an absolute, because the gap is an equilibrium of
   * the IDM term and a re-tune should move it without failing this.
   */
  const spread = Math.max(...bodies) - Math.min(...bodies);
  const rel = spread / Math.min(...bodies);
  console.log(`    body separation across dt: ${bodies.map((b) => b.toFixed(2)).join(' ')} ` +
    `-> spread ${spread.toFixed(3)} m = ${(rel * 100).toFixed(1)}% of the smallest`);
  check('the gap is an equilibrium, so it is the SAME at every dt, not merely above a floor',
    rel < 0.05, `spread ${spread.toFixed(3)} m, ${(rel * 100).toFixed(1)}% of ${Math.min(...bodies).toFixed(2)}`);
  check('and that gap clears both bodies', worstBody > 2,
    `worst body separation ${worstBody.toFixed(2)} m`);
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
  /**
   * THE 4 km ARM DOES NOT TEST THE RANGE BOUND, which is why removing the bound passed this file.
   * `_playerGap` rejects on THREE things in order: the player must be more than a car length ahead
   * ALONG the lane, within the lateral corridor, and inside `PLAYER_WATCH_M`. A player 4 km off the
   * network fails the lateral test, so the range bound is never reached and the mutation sweep's
   * `return gap;` — the 50 m bound deleted — read as caught by nothing.
   *
   * ISOLATING IT needs a player who passes the first two tests and only the third: standing ON a
   * lane's own centreline, far down the same edge. Then the lateral distance is ~0 and the range is
   * the only thing that can refuse. The arm asserts the gap it BUILT so it cannot quietly become
   * another lateral rejection.
   */
  {
    // A long edge, and a point on its centreline well beyond the watch range.
    const probe = new Traffic(scene, district, { count: 1 });
    probe.clearAt = (x, z, r) => !ix.resolveCircle(x, z, r);
    let best = null;
    for (let i = 0; i < district.edges.length; i++) {
      const len = probe._len(i);
      if (len < 160) continue;
      const a = probe._pointOn(i, true, 4), b = probe._pointOn(i, true, len - 4);
      if (a && b) { best = { i, len, a, b }; break; }
    }
    if (!best) {
      check('a long edge exists to isolate the range bound on', false, 'none over 160 m');
    } else {
      const lane = probe._laneOffset(best.i, true);
      const nx = -best.a.dz, nz = best.a.dx;
      // The player, on the lane the car at `a` is driving, `along` metres ahead of it.
      const at = (along) => {
        const p = probe._pointOn(best.i, true, 4 + along);
        return { x: p.x + nx * lane, z: p.z + nz * lane };
      };
      const gapAt = (along) => {
        const q = at(along);
        return probe._playerGap(best.a, lane, q.x, q.z, best.a.dx, best.a.dz);
      };
      const near = gapAt(30), far2 = gapAt(140);
      console.log(`    on edge ${best.i} (${best.len.toFixed(0)} m), player ON the lane:`);
      console.log(`      30 m ahead  -> gap ${Number.isFinite(near) ? near.toFixed(2) + ' m' : 'Infinity'}`);
      console.log(`      140 m ahead -> gap ${Number.isFinite(far2) ? far2.toFixed(2) + ' m' : 'Infinity'}`);
      // The arm has to prove it got PAST the lateral test, or it is measuring that instead.
      check('a player standing in the lane 30 m ahead IS a leader, so the arm clears the corridor',
        Number.isFinite(near) && near > 0, `${near}`);
      check('and the same player 140 m ahead is refused by the RANGE bound alone',
        !Number.isFinite(far2), `${far2}`);
      check('the two differ only in distance along one lane, nothing else',
        Math.abs(near - (30 - 4.4)) < 1.5, `near gap ${near.toFixed(2)} against 30 m minus a car`);
    }
  }
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

// ---------------------------------------------------------------------------
console.log('\n9. the A/B recolour arm is the shipped rule, and it leaves the stream alone');
{
  /**
   * `Traffic.recolour` exists so an A/B of the tone table can be swept off ONE page load, which
   * is what `hero-shots` is for. Three things have to be true of it or the arm measures itself:
   *
   *   1. recolour(false) must reproduce what the CONSTRUCTOR painted, bit for bit. A re-
   *      implementation that agreed "closely" would make every after-arm a measurement of the
   *      arm rather than of the build — this file's own opening paragraph is about instruments
   *      that return plausible numbers while being inert, and this is the same shape.
   *   2. recolour(true) must actually MOVE something, and move the right thing: the achromatic
   *      branch only, because the chromatic lightness did not change this round.
   *   3. neither may take a number from the seeded stream, or the two arms drive different
   *      edges and every comparison between them is between two different traversals.
   */
  const tr = new Traffic(scene, district, { count: 30 });
  const colours = (t) => t.meshes.map((m) => (m.instanceColor ? Array.from(m.instanceColor.array) : []));
  const shipped = JSON.stringify(colours(tr));

  // The stream's own state, either side of the arm. `_r` is a seeded PRNG, so an identical NEXT
  // DRAW is an identical state — and the reference is a FRESH fleet of the same seed, which is
  // what makes this a comparison and not a tautology against tr's own already-advanced stream.
  const reference = new Traffic(scene, district, { count: 30 });
  const nextBefore = reference._r();
  const a = tr.recolour(false);
  check('recolour(false) reproduces the constructor exactly, so an arm measures the build',
    JSON.stringify(colours(tr)) === shipped, 'instanceColor byte-identical across all three shells');
  const nextAfter = tr._r();
  check('and it takes nothing from the seeded stream, so both arms drive the same edges',
    nextAfter === nextBefore, `next draw ${nextAfter} against a fresh fleet's ${nextBefore}`);

  const b = tr.recolour(true);
  const c = tr.recolour(false);
  console.log(`  shipped span x${a.span.toFixed(2)} (${a.lumaLo.toFixed(4)}..${a.lumaHi.toFixed(4)}), ` +
    `legacy span x${b.span.toFixed(2)} (${b.lumaLo.toFixed(4)}..${b.lumaHi.toFixed(4)})`);
  check('the legacy arm actually moves the fleet, rather than being a no-op that looks like one',
    b.span < a.span / 5, `x${b.span.toFixed(2)} against x${a.span.toFixed(2)}`);
  check('and the shipped arm comes back after it, so an A/B can be run in either order',
    JSON.stringify(colours(tr)) === shipped, `round-trip over ${c.cars} cars`);
  /**
   * AND IT MOVES THE ACHROMATIC CARS ONLY. The chromatic lightness is deliberately unchanged this
   * round, so a legacy arm that moved a red car too would be sweeping two terms at once — which is
   * this project's "isolate one term at a time" arriving as a measurement error rather than as a
   * code one.
   */
  const lumaOf = (arr, i) => 0.2126 * arr[i * 3] + 0.7152 * arr[i * 3 + 1] + 0.0722 * arr[i * 3 + 2];
  tr.recolour(false);
  const shippedL = colours(tr);
  tr.recolour(true);
  const legacyL = colours(tr);
  let movedAchro = 0, movedChrom = 0, achro = 0, chrom = 0;
  for (let i = 0; i < tr.count; i++) {
    const isAchro = tr._paintDraws[i][0] < ACHROMATIC_SHARE;
    const sh = tr._shellOf[i], li = tr._localOf[i];
    const d = Math.abs(lumaOf(shippedL[sh], li) - lumaOf(legacyL[sh], li));
    if (isAchro) { achro++; if (d > 1e-6) movedAchro++; } else { chrom++; if (d > 1e-6) movedChrom++; }
  }
  console.log(`  legacy moved ${movedAchro}/${achro} achromatic cars and ${movedChrom}/${chrom} chromatic ones`);
  check('the legacy arm moves the achromatic cars', movedAchro === achro && achro > 0,
    `${movedAchro} of ${achro}`);
  /**
   * STRUCTURALLY GUARANTEED, AND SAYING SO IS THE POINT. `recolour`'s chromatic branch has no
   * `legacy` ternary in it at all, so `movedChrom === 0` cannot fail for any change to
   * `src/carpaint.js` or to the constructor — only for somebody adding a legacy path to
   * `recolour` itself. A blind reviewer flagged it. It is kept at that strength, labelled: a
   * future round that gives the chromatic lightness its own before-arm has to come here and
   * restate this, which is exactly what it is for.
   */
  check('and no chromatic one — guaranteed by recolour having no legacy chromatic branch, not measured',
    movedChrom === 0, `${movedChrom} of ${chrom}`);
  tr.recolour(false);
}

// ---------------------------------------------------------------------------
console.log('\n10. the per-shell body length is the buffer\'s, and every gap reads it');
{
  /**
   * `CAR_LENGTH` was one number for three shells that differ by 0.196 m. The gaps read a
   * measured per-shell length now, taken off the geometry `src/traffic.js` already builds — not
   * a table, because a table is a magic number waiting for `src/carbody.js` to change an
   * overhang under it. This asserts the module's measurement against the one `car-shapes` takes
   * off the same buffers, which is the only thing that says the two paths cannot drift.
   */
  const tr = new Traffic(scene, district, { count: 30 });
  const names = TrafficMod.shellNamesForTests ? TrafficMod.shellNamesForTests() : null;
  const fromBuffer = tr.geometries.map((g) => {
    const p2 = g.getAttribute('position');
    let z0 = Infinity, z1 = -Infinity;
    for (let i = 0; i < p2.count; i++) { const z = p2.getZ(i); z < z0 && (z0 = z); z > z1 && (z1 = z); }
    return z1 - z0;
  });
  console.log(`  shell lengths off the buffer: ${fromBuffer.map((l) => l.toFixed(3)).join(' ')}` +
    `  (module ${tr._shellLen.map((l) => l.toFixed(3)).join(' ')})`);
  check('the module measures each shell off its own buffer',
    tr._shellLen.every((l, i) => Math.abs(l - fromBuffer[i]) < 1e-9),
    tr._shellLen.map((l, i) => `${l.toFixed(4)} vs ${fromBuffer[i].toFixed(4)}`).join(', '));
  /**
   * AND THEY REALLY DIFFER, or every check above passes over three identical numbers and the
   * whole change is decorative — the shape this file's own opening paragraph is about.
   */
  const spread = Math.max(...fromBuffer) - Math.min(...fromBuffer);
  check('and the three shells really are different lengths, or this change is decorative',
    spread > 0.1, `${spread.toFixed(3)} m across ${fromBuffer.length} shells`);
  /**
   * THE NOMINAL IT REPLACED WAS THE COUPE'S, AND THE BACKLOG PRICED THE WRONG SITE. 4.4 is
   * 2 * (CAR_LENGTH - PLAYER_HALF_L) away from the player-following reach, and the coupe's own
   * half plus the player's gives 4.396 — four millimetres. So the under-modelling at the PLAYER
   * site was 0.095 m and not the 0.289 the backlog quoted; only the car-to-car gap subtracts a
   * whole leader body. Both numbers are printed so neither can be quoted for the other.
   */
  const worstCarToCar = Math.max(...fromBuffer) - 4.4;
  const worstToPlayer = Math.max(...fromBuffer) / 2 + 2.15 - 4.4;
  console.log(`  what the single nominal under-modelled: car-to-car ${worstCarToCar.toFixed(3)} m,` +
    ` player-following ${worstToPlayer.toFixed(3)} m — the backlog quoted the first for both`);
  check('the two sites were under-modelled by different amounts, which is why they are priced apart',
    worstCarToCar > worstToPlayer * 2, `${worstCarToCar.toFixed(3)} against ${worstToPlayer.toFixed(3)}`);
  /**
   * EVERY LIVE CAR CARRIES ONE, because `_gapAhead` reads it off a LEADER it only has as an
   * object. A spawned car without the field makes `best - undefined` NaN, and NaN fails every
   * `>` comparison silently — this file's own standing warning.
   */
  const tr2 = new Traffic(scene, district, { count: 30 });
  for (let i = 0; i < 400; i++) tr2.update(1 / 60, { x: 0, z: 0 });
  const live = tr2.cars.filter(Boolean);
  check('every live car carries a finite body length, or a gap goes NaN and every test of it passes',
    live.length > 0 && live.every((c) => Number.isFinite(c.body) && c.body > 0),
    `${live.filter((c) => Number.isFinite(c.body) && c.body > 0).length} of ${live.length} live`);
}

// THE SUMMARY AND THE EXIT ARE THE LAST THING IN THIS FILE, and they have to be: appending
// two sections after a mid-file `process.exit` ran them exactly zero times and the gate still
// printed "22 passed, 0 failed". A gate that cannot reach its own checks passes.
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
