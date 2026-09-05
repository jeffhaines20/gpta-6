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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
