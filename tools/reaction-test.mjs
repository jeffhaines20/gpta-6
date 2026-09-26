// Deterministic gate for what happens to the OTHER party in a collision.
//
//   node tools/reaction-test.mjs
//
// The damage round measured a live page striking three pedestrians at 60 km/h: the car took no
// damage (correct — an 80 kg body cannot dent a 1400 kg car), the wanted meter went to two stars
// (correct — it is a two-star crime), and the people carried on walking. The crime was reported
// and the collision was invisible. This gate is about the half that was missing.
//
// BOTH SUBJECTS CONSTRUCT HEADLESSLY, which is what makes this offline. src/traffic.js and
// src/pedestrians.js build instanced meshes but never touch a GL context, so `{ add() {} }` is a
// sufficient scene — tools/traffic-selftest.mjs established that and this reuses it.
//
// THE KNOWN-BAD SECTIONS are the ones that matter, because a reaction is easy to write in a way
// that looks right and is not:
//
//   §2  a throw distance chosen by feel instead of by reconstruction
//   §3  a slide integrated without the building test, which throws bodies through shopfronts
//   §5  a shunt that moves the DRAWN car without moving the PUBLISHED one, so the collision pass
//       and the renderer disagree about where a car is
//   §6  a shunted car counted as gridlocked, which deletes it a few seconds after the impact and
//       makes the reaction read as a despawn
//   §7  a shunt with no building test, which knocks 0.8% of worst-case cars into a shopfront
import fs from 'node:fs';
import { Pedestrians } from '../src/pedestrians.js';
import { Traffic } from '../src/traffic.js';
import { throwDistance, slideDecel, THROW, ANCHORS, pedFatalityRisk } from '../src/damage.js';
import { BlockerIndex } from '../src/blockers.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const scene = { add() {} };
const DT = 1 / 60;
const FOCUS = { x: 57, z: -164 };

/** A crowd that has settled, with a named victim. */
function crowd(count = 16, frames = 60) {
  const p = new Pedestrians(scene, district, { count });
  for (let k = 0; k < frames; k++) p.update(DT, FOCUS);
  return p;
}
/** A fleet that has settled. */
function fleet(count = 8, frames = 120) {
  const t = new Traffic(scene, district, { count });
  for (let k = 0; k < frames; k++) t.update(DT, FOCUS);
  return t;
}

/**
 * THE DRAWN POSE, READ OFFLINE. Both modules build InstancedMeshes against a `{ add() {} }`
 * scene and never touch a GL context, so the matrices they write are readable here — which
 * matters because a blind review put 27 mutations through this file and the five it missed
 * most cheaply were all pose: the fall transform disabled entirely, the fall angle negated so
 * bodies tip forwards, a fixed fall axis so everyone falls the same way, the throw reversed
 * into the car, and the body moved a third as far as its own bookkeeping said. Every one of
 * them left `down.travelled` untouched, and `down.travelled` was all this gate read.
 *
 * tools/damage-live.mjs §8 does catch all five — in a twelve-minute browser gate. The same
 * readback costs 295 ms here, which is the difference between a check that runs per edit and
 * one that runs once a round.
 *
 * Read the tier that DRAWS the ped: a ped in the near pool is written to nearTorsos/nearHeads
 * and its far slot is set to the hidden matrix, whose determinant is zero.
 */
function poseOf(p, i) {
  const ns = p._nearSlot[i], near = ns >= 0, slot = near ? ns : i;
  const M = new (p._m.constructor)();
  (near ? p.nearTorsos : p.torsos).getMatrixAt(slot, M);
  const t = M.elements.slice();
  (near ? p.nearHeads : p.heads).getMatrixAt(slot, M);
  const h = M.elements.slice();
  const upLen = Math.hypot(t[4], t[5], t[6]) || 1;
  return { i, near, x: t[12], z: t[14], torsoY: t[13], headY: h[13],
    upX: t[4] / upLen, upZ: t[6] / upLen,
    tiltDeg: Math.acos(Math.max(-1, Math.min(1, t[5] / upLen))) * 180 / Math.PI };
}
/** The same for a traffic car: where the renderer will actually draw it. */
function carDrawn(t, id) {
  const slot = t.cars.findIndex((c) => c && c.id === id);
  if (slot < 0) return null;
  const M = new (t._m.constructor)();
  t.meshes[t._shellOf[slot]].getMatrixAt(t._localOf[slot], M);
  const e = M.elements;
  return { x: e[12], z: e[14], yaw: Math.atan2(e[8], e[10]) };
}

console.log('REACTION GATE — what happens to the other party');
console.log('='.repeat(78));

// ---------------------------------------------------------------------------
// §1  The crowd reacts at all.
// ---------------------------------------------------------------------------
console.log('\n§1  A pedestrian is knocked down');
{
  const p = crowd();
  const v = p.positions()[0];
  check('positions() carries the crowd slot, so a caller can act on what it hit',
    typeof v.i === 'number', JSON.stringify(v));
  check('and says whether the body is already down', 'down' in v);
  const before = { x: p.peds[v.i].x, z: p.peds[v.i].z, walking: p.peds[v.i].v };
  const r = p.hit(v.i, { speed: 40 / 3.6, dirX: 1, dirZ: 0 });
  console.log(`    hit at 40 km/h: ${JSON.stringify(r)}`);
  check('hit() reports the knockdown', r && r.index === v.i && !r.fatal, JSON.stringify(r));
  check('the ped is marked down', p.isDown(v.i));
  check('and stops walking', p.peds[v.i].v === 0, `${p.peds[v.i].v}`);
  check('a second hit on a body already down is refused',
    p.hit(v.i, { speed: 40 / 3.6 }) === null);
  check('the counters moved', p.stats.knockdowns === 1 && p.stats.knockdownsFatal === 0);
  // Drive it to its feet.
  let up = null, phases = [];
  for (let k = 0; k < 60 * 20; k++) {
    p.update(DT, FOCUS);
    const ped = p.peds[v.i];
    if (!ped) break;
    if (ped.down && !phases.includes(ped.down.phase)) phases.push(ped.down.phase);
    if (!ped.down) { up = k * DT; break; }
  }
  const moved = p.peds[v.i] ? Math.hypot(p.peds[v.i].x - before.x, p.peds[v.i].z - before.z) : 0;
  const along = p.peds[v.i] ? (p.peds[v.i].x - before.x) * 1 + (p.peds[v.i].z - before.z) * 0 : 0;
  console.log(`    phases ${phases.join(' -> ')}, back on its feet at ${up?.toFixed(2)} s, ` +
    `moved ${moved.toFixed(2)} m, ${along.toFixed(2)} of it along the throw`);
  check('it goes through falling, prone and rising',
    phases.join(',') === 'falling,prone,rising', phases.join(','));
  check('it gets back up', up !== null && up > 3 && up < 7, `${up}`);
  /**
   * WHERE THE BODY IS, NOT WHERE ITS OWN LEDGER SAYS IT IS. `down.travelled` is bookkeeping
   * this module writes itself, and every other section here reads it. A mutation that advanced
   * the position by a THIRD of each step while still adding the full step to `travelled` threw
   * the body 3.18 m instead of 9.53 and passed all 65 checks: the printed `moved` above was the
   * only witness and nothing asserted it. These two lines are that witness.
   */
  check('the body ended up where the throw model says, not where its ledger says',
    Math.abs(moved - r.throwWanted) < 0.05, `${moved.toFixed(3)} against ${r.throwWanted.toFixed(3)}`);
  check('and it went the way the car was going', along > 0.9 * moved, `${along.toFixed(2)} of ${moved.toFixed(2)}`);
  // It has been given one frame since it rose, so it is walking rather than merely not-negative:
  // `v >= 0` was the original form of this check and it cannot fail, because `hit()` sets v = 0
  // and the down branch skips the walk. At the instant it rises v is exactly 0; one frame later
  // it is moving.
  p.update(DT, FOCUS);
  check('and walks again', p.peds[v.i] && p.peds[v.i].v > 0, `${p.peds[v.i] && p.peds[v.i].v}`);
  check('the recovery is counted', p.stats.recoveries === 1);
}

// ---------------------------------------------------------------------------
// §1b  The DRAWN body: the pose, the direction it went over, and the control.
// ---------------------------------------------------------------------------
console.log('\n§1b The fall reaches the instance matrices');
{
  const p = crowd(64, 120);
  const v = p.positions()[0];
  const before = poseOf(p, v.i);
  const r = p.hit(v.i, { speed: 60 / 3.6, dirX: 1, dirZ: 0, kill: true });
  // Far enough for the fall to finish and the slide to stop: 0.32 s of fall, 3.3 s of slide.
  for (let k = 0; k < 60 * 5; k++) {
    p.update(DT, FOCUS);
    const d = p.peds[v.i] && p.peds[v.i].down;
    if (!d) break;
    if (d.phase !== 'falling' && Math.hypot(d.vx, d.vz) < 0.05) break;
  }
  const after = poseOf(p, v.i);
  const d = p.peds[v.i].down;
  const drawnMoved = Math.hypot(after.x - before.x, after.z - before.z);
  const shortfall = d.travelled - drawnMoved;
  const upDotTravel = after.upX * 1 + after.upZ * 0;
  console.log(`    torso tilt ${before.tiltDeg.toFixed(1)} -> ${after.tiltDeg.toFixed(1)} deg, ` +
    `head Y ${before.headY.toFixed(2)} -> ${after.headY.toFixed(2)} m`);
  console.log(`    slid ${d.travelled.toFixed(2)} m, the DRAWN torso moved ${drawnMoved.toFixed(2)} m ` +
    `(short by ${shortfall.toFixed(2)}), up . travel ${upDotTravel.toFixed(3)}`);
  check('the body was upright before the impact', before.tiltDeg < 5, `${before.tiltDeg.toFixed(1)}`);
  check('the drawn torso is on its side after it', after.tiltDeg > 70, `${after.tiltDeg.toFixed(1)}`);
  check('and the drawn head came down by over a metre', before.headY - after.headY > 1.0,
    `${(before.headY - after.headY).toFixed(2)} m`);
  /**
   * THE DIRECTION IS A CLAIM ABOUT THE KINEMATICS, not a tolerance. A car strikes a pedestrian
   * below the centre of mass, the legs are accelerated forward and the upper body lags, so the
   * head trails: the torso lands about its own standing height BEHIND the root, and its up axis
   * points against the direction of travel. A fall composed the other way round lands the torso
   * the same distance IN FRONT and reads up . travel = +1.
   */
  check('the drawn body followed the slide', drawnMoved > 1, `${drawnMoved.toFixed(2)}`);
  check('it lands short of the root by about a torso', shortfall > 0.4 && shortfall < 1.4,
    `${shortfall.toFixed(2)}`);
  check('and the head trails, which is what a legs-first impact does', upDotTravel < -0.7,
    `${upDotTravel.toFixed(3)}`);
  // THE CONTROL: one body falls, the rest stand. A fall composed onto the mesh rather than the
  // instance would tip the whole crowd, and a single-body reading cannot tell.
  let tipped = 0, worstOther = 0, counted = 0;
  for (let j = 0; j < p.count; j++) {
    if (!p.peds[j] || j === v.i) continue;
    counted++;
    const q = poseOf(p, j);
    if (q.tiltDeg > 5) tipped++;
    worstOther = Math.max(worstOther, q.tiltDeg);
  }
  console.log(`    control: ${tipped} of the other ${counted} bodies tipped, worst ${worstOther.toFixed(2)} deg`);
  check('the control has a crowd in it', counted > 20, `${counted}`);
  check('the fall is one body, not the whole crowd', tipped === 0, `${tipped} tipped`);
}

// ---------------------------------------------------------------------------
// §2  The throw distance is the published one.
// ---------------------------------------------------------------------------
console.log('\n§2  Throw distance against accident reconstruction');
console.log(`    d = v^2 / (2 * mu * g), mu ${THROW.mu} (clothed body on asphalt), g ${THROW.g}`);
console.log('    speed    closed form   integrated slide   published');
const PUBLISHED = { 30: 5, 40: 10, 50: 15 };
let worstIntErr = 0, worstPubErr = 0;
for (const kmh of [15, 30, 40, 50, 60]) {
  const p = crowd(8);
  const v = p.positions()[0];
  p.hit(v.i, { speed: kmh / 3.6, dirX: 1, dirZ: 0, kill: false });
  // Open ground: pin the walk's building test off so a wall cannot clamp the slide.
  const realBlocked = p._blocked.bind(p);
  p._blocked = () => false;
  /**
   * READ THE SLIDE, NOT THE DISPLACEMENT. The first draft measured the straight-line distance
   * from where the ped started, after running eight seconds — which is long enough for a
   * survivable casualty to get up at 4.4 s and walk. At 15 km/h that read 4.55 m for a 1.34 m
   * slide (1.34 of sliding plus 3.2 of walking), and at 50 km/h it read 11.26 for a 14.90 m
   * slide, because the ped got up and walked back toward where it came from. Both directions of
   * error at once, from one wrong quantity.
   *
   * `down.travelled` is the slide, and the loop stops when the slide does.
   */
  let slid = 0;
  for (let k = 0; k < 60 * 8; k++) {
    p.update(DT, FOCUS);
    const ped = p.peds[v.i];
    if (!ped || !ped.down) break;
    slid = ped.down.travelled;
    if (Math.hypot(ped.down.vx, ped.down.vz) < 0.05) break;
  }
  p._blocked = realBlocked;
  const closed = throwDistance(kmh / 3.6);
  const intErr = Math.abs(slid - closed) / closed;
  if (intErr > worstIntErr) worstIntErr = intErr;
  const pub = PUBLISHED[kmh];
  let pubCell = '        -';
  if (pub) {
    const e = Math.abs(closed - pub) / pub;
    if (e > worstPubErr) worstPubErr = e;
    pubCell = `${String(pub).padStart(5)} m ${(e * 100).toFixed(0).padStart(3)}%`;
  }
  console.log(`   ${String(kmh).padStart(4)} km/h ${closed.toFixed(2).padStart(10)} m ` +
    `${slid.toFixed(2).padStart(15)} m   ${pubCell}`);
}
check('the integrated slide reproduces the closed form to 3%', worstIntErr < 0.03,
  `${(worstIntErr * 100).toFixed(1)}%`);
check('the closed form matches published data at 30, 40 and 50 km/h to 10%',
  worstPubErr < 0.10, `${(worstPubErr * 100).toFixed(1)}%`);
// The table above prints the error through toFixed(0), which is how "7.26%" became a prose
// claim of "within 7%" in src/damage.js. The worst is asserted here to two decimals so the
// number in the source and the number the gate sees cannot drift apart again.
console.log(`    worst error against the published anchors: ${(worstPubErr * 100).toFixed(2)}%`);
check('and the worst of the three is the 30 km/h anchor, 7.26% ABOVE it',
  Math.abs(worstPubErr * 100 - 7.26) < 0.01, `${(worstPubErr * 100).toFixed(2)}%`);
// KNOWN-BAD: a throw distance chosen by feel. A linear "2 m per 10 km/h" rule is the kind of
// thing that looks fine at one speed and is wrong everywhere else.
console.log('    KNOWN-BAD, a linear 2 m per 10 km/h rule against the published points:');
let linWorst = 0;
for (const kmh of [30, 40, 50]) {
  const lin = kmh / 10 * 2;
  const e = Math.abs(lin - PUBLISHED[kmh]) / PUBLISHED[kmh];
  if (e > linWorst) linWorst = e;
  console.log(`      ${kmh} km/h: ${lin.toFixed(1)} m against ${PUBLISHED[kmh]} m — ${(e * 100).toFixed(0)}% out`);
}
check('KNOWN-BAD: a linear rule is over 20% out somewhere in that range', linWorst > 0.20,
  `${(linWorst * 100).toFixed(0)}%`);
// (`slideDecel() === THROW.mu * THROW.g` was asserted here and is the function's own body —
// a check that compares an expression to itself. What is worth asserting is that the SLIDE
// uses it, which is the step-size sweep below and §2's table above.)

/**
 * AND THE THROW DISTANCE IS A PROPERTY OF THE IMPACT, NOT OF THE FRAME RATE. The slide was first
 * written as a plain Euler step, which carries the whole step at the ENTRY speed and therefore
 * overshoots. Measured on that version, against a closed form of 9.534 m at 40 km/h:
 *
 *     dt 1/120   9.580 m   +0.5%        dt 1/6   10.479 m    +9.9%
 *     dt 1/60    9.627 m   +1.0%        dt 1/2   12.510 m   +31.2%
 *                                       dt 1     15.748 m   +65.2%
 *
 * At 60 Hz it is 1% and invisible. A headless frame here is about a second, so every capture of
 * a knockdown threw the body half again as far as the model says — and in the game, so did any
 * frame hitch. This check is the reason to integrate rather than sample, and the KNOWN-BAD block
 * under it re-runs the sampled form in this file so a regression to it cannot pass.
 */
console.log('    the same 40 km/h impact at five step sizes:');
const STEPS = [1 / 120, 1 / 60, 1 / 6, 1 / 2, 1];
const closed40 = throwDistance(40 / 3.6);
let dtMin = Infinity, dtMax = 0;
for (const dt of STEPS) {
  const p2 = crowd(8);
  const v2 = p2.positions()[0];
  p2.hit(v2.i, { speed: 40 / 3.6, dirX: 1, dirZ: 0, kill: false });
  const realB = p2._blocked.bind(p2);
  p2._blocked = () => false;
  let slid = 0;
  for (let k = 0; k < Math.ceil(12 / dt); k++) {
    p2.update(dt, FOCUS);
    const ped = p2.peds[v2.i];
    if (!ped || !ped.down) break;
    slid = ped.down.travelled;
    if (Math.hypot(ped.down.vx, ped.down.vz) < 0.05) break;
  }
  p2._blocked = realB;
  dtMin = Math.min(dtMin, slid); dtMax = Math.max(dtMax, slid);
  console.log(`      dt ${dt.toFixed(4)} s  ${slid.toFixed(3)} m  ` +
    `${((slid / closed40 - 1) * 100).toFixed(2).padStart(6)}% against the closed form`);
}
check('the thrown distance is the same at every step size from 1/120 s to 1 s, to 0.1%',
  (dtMax - dtMin) / dtMin < 0.001, `${dtMin.toFixed(3)} .. ${dtMax.toFixed(3)} m`);
check('and the coarsest step still lands on the closed form to 0.1%',
  Math.abs(dtMax - closed40) / closed40 < 0.001, `${dtMax.toFixed(3)} vs ${closed40.toFixed(3)}`);
// KNOWN-BAD: the sampled form, re-run here so this check cannot pass against it.
let euler = 0, ev = 40 / 3.6;
const ea = slideDecel();
for (let k = 0; k < 200 && ev > 0.05; k++) {
  euler += ev * 1.0;                                  // one whole second at the entry speed
  ev *= Math.max(0, 1 - (ea * 1.0) / ev);
}
console.log(`      KNOWN-BAD, the sampled form at dt 1 s: ${euler.toFixed(3)} m, ` +
  `${((euler / closed40 - 1) * 100).toFixed(0)}% over`);
check('KNOWN-BAD: the sampled form is over 20% out at a 1 s step, so this check can fail',
  (euler - closed40) / closed40 > 0.20, `${euler.toFixed(3)} vs ${closed40.toFixed(3)}`);

// ---------------------------------------------------------------------------
// §3  A body is not thrown through a shopfront.
// ---------------------------------------------------------------------------
console.log('\n§3  The slide stops at a wall');
{
  // A LARGER CROWD AND EVERY MEMBER TRIED, because the first draft took whichever ped
  // positions() happened to return first and swept 32 directions at a single 6 m radius. That
  // one ped was in the open and the section silently did nothing.
  const p = crowd(48, 90);
  let v = null, dirX = 1, dirZ = 0, found = false, wallAt = 0;
  outer:
  for (const cand of p.positions()) {
    for (const r of [3, 4, 5, 6, 8]) {
      for (let a = 0; a < 48; a++) {
        const th = (a / 48) * Math.PI * 2;
        const ux = Math.sin(th), uz = Math.cos(th);
        if (p._blocked(p.peds[cand.i].x + ux * r, p.peds[cand.i].z + uz * r, 0.28)) {
          v = cand; dirX = ux; dirZ = uz; found = true; wallAt = r;
          break outer;
        }
      }
    }
  }
  check('a pedestrian was found with a building to be thrown at', found);
  if (found) {
    console.log(`    a wall ${wallAt} m from the body, in the throw direction`);
    p.hit(v.i, { speed: 50 / 3.6, dirX, dirZ, kill: false });
    // `travelled` is read INSIDE the loop and the loop stops when the slide does, for the same
    // reason §2's does: a survivable casualty is back on its feet at 4.4 s and `down` is null
    // after that. The first draft read it after six seconds and threw on null.
    let insideEver = false, slid = 0;
    for (let k = 0; k < 60 * 6; k++) {
      p.update(DT, FOCUS);
      const ped = p.peds[v.i];
      if (!ped) break;
      if (p._blocked(ped.x, ped.z, 0.28)) insideEver = true;
      if (!ped.down) break;
      slid = ped.down.travelled;
      if (Math.hypot(ped.down.vx, ped.down.vz) < 0.05) break;
    }
    console.log(`    thrown 50 km/h (would slide ${throwDistance(50 / 3.6).toFixed(1)} m in the open): ` +
      `stopped after ${slid.toFixed(2)} m, ever inside a building: ${insideEver}`);
    check('the body never ends up inside a building', !insideEver);
    // The old form of the next check was `slid < throwDistance(50/3.6)`, which CANNOT FAIL: the
    // loop exits when |v| < 0.05, so `slid` lands a hair under the closed form whatever the wall
    // does — measured margin 4.6e-14 m with the wall test deleted entirely. What the wall does is
    // stop the body EARLY, so that is what to assert.
    check('the wall stopped it well short of the open-ground distance',
      slid < throwDistance(50 / 3.6) * 0.9, `${slid.toFixed(2)} of ${throwDistance(50 / 3.6).toFixed(2)} m`);
    /**
     * AND AT EVERY STEP SIZE, WITH THE WALL LIVE. §2 sweeps dt with `_blocked` stubbed OFF, so
     * nothing there exercises the sub-stepping; this arm is the only thing between the district
     * and a body sliding through a shopfront at a coarse frame. Deleting the sub-stepping
     * (`n = 1`) passed all 65 checks of the previous version of this file.
     *
     * The bound is arithmetic, not taste: `_blocked` tests the DESTINATION with a margin of
     * BUILDING_MARGIN, so a step can only be trusted to notice a wall while it is shorter than
     * twice that margin — 0.56 m. At district/main.js's own dt clamp of 0.05 s, 60 km/h is
     * 0.83 m in one step, past the bound, so the sub-stepping is load-bearing at the shipped
     * frame rate and not only at the harness's.
     */
    /**
     * AND THE SUB-STEP IS SHORTER THAN THE TEST IT FEEDS. `_blocked` samples the DESTINATION with
     * a 0.28 m margin, so it can only be trusted while a step is under 2 * 0.28 = 0.56 m. The
     * first version computed the sub-step count from the step's DISTANCE, which is its AVERAGE
     * speed — and the sub-steps are equal in TIME, so the first one is the fastest. Measured on a
     * crowd of one, with the spacing between consecutive wall tests instrumented:
     *
     *     dt 1     40 km/h    old 0.5073 m   new 0.2857 m
     *     dt 5     40 km/h    old 0.5679 m   new 0.2910 m
     *     dt 5     72 km/h    old 0.5911 m   new 0.2983 m
     *
     * The old form was within 12% of the thinnest blocked band in the district (0.670 m) and
     * nothing tied the three numbers together.
     */
    {
      const solo = crowd(1, 120);
      const sv = solo.positions()[0];
      solo._spawn = () => false;                 // the spawn pass calls _blocked too
      solo.hit(sv.i, { speed: 72 / 3.6, dirX: 1, dirZ: 0, kill: true });
      const realBlocked = solo._blocked.bind(solo);
      let last = null, worstStep = 0, tests = 0;
      solo._blocked = (bx, bz) => {
        if (last) { worstStep = Math.max(worstStep, Math.hypot(bx - last[0], bz - last[1])); tests++; }
        last = [bx, bz];
        return false;
      };
      for (let k = 0; k < 4; k++) solo.update(5, FOCUS);   // a deliberately absurd step size
      solo._blocked = realBlocked;
      console.log(`      sub-steps at dt 5 s, 72 km/h: ${tests} wall tests, worst ${worstStep.toFixed(4)} m`);
      check('the slide actually sub-stepped', tests > 50, `${tests} tests`);
      check('and no sub-step is longer than the 0.3 m bound', worstStep <= 0.3 + 1e-9,
        `${worstStep.toFixed(4)} m`);
      check('which is inside twice the wall test\'s own margin', 0.3 <= 2 * 0.28,
        '0.3 against 2 x 0.28');
    }
    for (const bigDt of [0.05, 0.25, 1.0]) {
      const p2 = crowd(48, 90);
      // The same subject and the same wall: find it again in this crowd by position.
      let w = null;
      for (const cand of p2.positions()) {
        if (Math.hypot(cand.x - v.x, cand.z - v.z) < 0.01) { w = cand; break; }
      }
      if (!w) { check(`the subject is reproducible at dt ${bigDt}`, false); continue; }
      p2.hit(w.i, { speed: 50 / 3.6, dirX, dirZ, kill: true });
      let inside = false, sl = 0;
      for (let k = 0; k < Math.ceil(8 / bigDt); k++) {
        p2.update(bigDt, FOCUS);
        const ped = p2.peds[w.i];
        if (!ped) break;
        if (p2._blocked(ped.x, ped.z, 0.28)) inside = true;
        if (!ped.down) break;
        sl = ped.down.travelled;
        if (Math.hypot(ped.down.vx, ped.down.vz) < 0.05) break;
      }
      console.log(`      at dt ${bigDt.toFixed(2)} s: stopped after ${sl.toFixed(2)} m, ` +
        `inside a building: ${inside}`);
      /**
       * BOTH ENDS, because either alone passes for the wrong reason. Without the sub-stepping a
       * coarse frame tests a destination 13.9 m away, finds it inside the building, and stops the
       * body where it stands: `sl` 0.00 m, nothing inside anything, and an upper-bound-only check
       * waves it through. And a body that tunnelled would read `sl` near the open-ground 14.9 m.
       * The slide has to reach the wall AND stop at it.
       */
      check(`the wall still stops the slide at dt ${bigDt}`,
        !inside && sl > wallAt * 0.5 && sl < wallAt + 1,
        `${sl.toFixed(2)} m of a ${wallAt} m gap, inside ${inside}`);
    }
    // KNOWN-BAD: the closed form alone cannot notice a building, which is why the slide is
    // integrated rather than solved.
    console.log(`    KNOWN-BAD: the closed form puts it ${throwDistance(50 / 3.6).toFixed(1)} m out, ` +
      `past a wall ${wallAt} m away — a closed form cannot see a building`);
    check('KNOWN-BAD: the closed form would have overshot the wall',
      throwDistance(50 / 3.6) > wallAt);
  }
}

/**
 * A CASUALTY IS AN OBSTACLE, NOT A THING TO BE SHOVED. The neighbour hash is built from every
 * ped including the ones on the ground, and the separation pass only ever steers the WALKER — it
 * never writes the neighbour's position. So the crowd veers round a body and brakes for it, and
 * nothing in the crowd can move it. Asserted rather than assumed, because "cheap reciprocal
 * avoidance" is exactly the kind of thing a later change would make actually reciprocal.
 */
{
  const p = crowd(32, 120);
  const cands = p.positions();
  const v = cands[0];
  // Zero throw speed, so the only thing that could move this body is the crowd.
  p.hit(v.i, { speed: 0.001, dirX: 1, dirZ: 0, kill: true });
  const ped = p.peds[v.i];
  const x0 = ped.x, z0 = ped.z;
  /**
   * AND THE ENCOUNTER IS ARRANGED, because a first draft ran a 32-strong crowd for six seconds
   * and the nearest walker came no closer than 3.32 m — the body was never in anyone's way, so
   * "nothing moved it" measured nothing. SEP_RADIUS is about 1.4 m, so a walker is placed at 0.5 m
   * and has to deal with it.
   */
  const w = p.peds[cands[1].i];
  w.x = x0 + 0.5; w.z = z0;
  const d0 = Math.hypot(w.x - x0, w.z - z0);
  let closest = d0;
  for (let k = 0; k < 60 * 2; k++) {
    p.update(DT, FOCUS);
    if (!p.peds[cands[1].i]) break;
    closest = Math.min(closest, Math.hypot(w.x - x0, w.z - z0));
  }
  const d1 = Math.hypot(w.x - x0, w.z - z0);
  /**
   * AND THE SAME WALK WITH NOTHING THERE, because `d1 > d0` is not a test. A walker covers
   * 2.5 m in two seconds whatever it is standing next to: measured, the empty control leaves at
   * 2.491 m and the casualty arm at 2.659 m, so the body contributes 0.168 m of 2.159 — 7.8%.
   * A mutation making casualties invisible to the neighbour hash passed `d1 > d0` untouched.
   * The difference between the arms is the only quantity here that is about the body.
   */
  const ctrl = crowd(32, 120);
  const cv = ctrl.positions()[0];
  const cw = ctrl.peds[ctrl.positions()[1].i];
  const cx0 = ctrl.peds[cv.i].x, cz0 = ctrl.peds[cv.i].z;
  ctrl.peds[cv.i] = null;                        // the same place, with nobody in it
  ctrl._hide(cv.i);
  // AND IT STAYS EMPTY. The refill pass fills a freed slot on the very next frame — measured,
  // one frame — so the first version of this control was "the same ground with a fresh
  // pedestrian standing on it", which is not a control at all and is why it agreed with the
  // casualty arm to 0.17 m.
  ctrl._spawn = () => false;
  cw.x = cx0 + 0.5; cw.z = cz0;
  for (let k = 0; k < 60 * 2; k++) ctrl.update(DT, FOCUS);
  const ctrlD = Math.hypot(cw.x - cx0, cw.z - cz0);
  console.log(`    a walker put 0.50 m from a body: it left at ${d1.toFixed(2)} m, ` +
    `against ${ctrlD.toFixed(2)} m with nothing there`);
  console.log(`    the body moved ${Math.hypot(ped.x - x0, ped.z - z0).toExponential(1)} m`);
  check('the control walker walked, so the comparison means something', ctrlD > 1,
    `${ctrlD.toFixed(2)} m`);
  check('the body pushed the walker further off than empty ground does', d1 > ctrlD + 0.05,
    `${d1.toFixed(3)} against ${ctrlD.toFixed(3)}`);
  check('and the crowd cannot move a body on the ground', ped.x === x0 && ped.z === z0,
    `${ped.x - x0}, ${ped.z - z0}`);
}

// ---------------------------------------------------------------------------
// §4  Whether they die is a published curve, not a line.
//
// THE FIRST VERSION OF THIS SECTION ASSERTED THE WRONG NUMBER CAREFULLY. It checked that
// pedestrians.js and damage.js agreed on 45 km/h, which they did, and that 44 survives and 46
// dies — and the 45 was wrong. It was cited as the 50% point of the published curve; Rosen &
// Sander (2009) put 45 km/h at 5.5% and the 50% point at 76.7 km/h, and the 2011 review by the
// same authors, co-cited in the same comment, exists to correct the older estimate the 45 came
// from. A check that two copies of a number agree cannot see that the number is wrong.
// ---------------------------------------------------------------------------
console.log('\n§4  The fatality curve');
console.log(`    P(fatal) = 1 / (1 + exp(6.9 - 0.090 v)), v in km/h  —  Rosen & Sander (2009)`);
for (const [kmh, want] of [[30, 1.48], [45, 5.47], [50, 8.32], [80, 57.44]]) {
  const got = pedFatalityRisk(kmh / 3.6) * 100;
  console.log(`      ${String(kmh).padStart(3)} km/h: ${got.toFixed(2)}%   published ${want}%`);
  check(`the crowd draws against the published curve at ${kmh} km/h`, Math.abs(got - want) < 0.02,
    `${got.toFixed(3)} vs ${want}`);
}
check('and damage.js\'s anchor is its 50% point', Math.abs(ANCHORS.pedKillSpeed * 3.6 - 76.7) < 0.3,
  `${(ANCHORS.pedKillSpeed * 3.6).toFixed(1)} km/h`);
{
  /**
   * THE POPULATION FOLLOWS THE CURVE. Not 96 bodies — the binomial error at 8% on 96 is 2.8%,
   * which cannot tell the published curve from one half again as steep. 4,000 draws puts it at
   * 0.4%. The draw is a hash of the ped's id and the impact speed, so this is a statement about
   * the shipped function and not about a random seed.
   */
  const N = 4000;
  let worst = 0;
  for (const kmh of [30, 50, 76.7, 90]) {
    const p2 = crowd(8, 60);
    const ped = p2.peds[p2.positions()[0].i];
    let fatal = 0;
    for (let id = 1; id <= N; id++) {
      ped.id = id;
      ped.down = null;
      const r = p2.hit(p2.positions()[0].i, { speed: kmh / 3.6, dirX: 1, dirZ: 0 });
      if (r && r.fatal) fatal++;
    }
    const rate = (fatal / N) * 100, curve = pedFatalityRisk(kmh / 3.6) * 100;
    worst = Math.max(worst, Math.abs(rate - curve));
    console.log(`    ${String(kmh).padStart(5)} km/h: ${fatal} of ${N} died — ${rate.toFixed(2)}% ` +
      `against the curve's ${curve.toFixed(2)}%`);
  }
  check('the outcome over 4,000 bodies tracks the curve to 1.5 points', worst < 1.5,
    `${worst.toFixed(2)} points`);
}
{
  // DETERMINISTIC, AND INDEPENDENT OF ORDER. A hash is not a dice roll: the same body at the
  // same speed dies in every run, and hitting a crowd back to front changes nothing.
  const a = crowd(16, 90), b = crowd(16, 90);
  const fwd = [], rev = [];
  const ids = a.positions().map((q) => q.i);
  for (const i of ids) { const r = a.hit(i, { speed: 60 / 3.6, dirX: 1, dirZ: 0 }); fwd.push(`${i}:${r && r.fatal}`); }
  for (const i of [...ids].reverse()) { const r = b.hit(i, { speed: 60 / 3.6, dirX: 1, dirZ: 0 }); rev.push(`${i}:${r && r.fatal}`); }
  check('the same crowd at the same speed dies the same way in both runs',
    fwd.sort().join(',') === rev.sort().join(','), `${fwd.length} vs ${rev.length}`);
  // (No check here that the draw leaves the shared random stream alone: tools/sim-determinism.mjs
  // owns that, and a check written as `x !== undefined || true` — which is what stood here for
  // ten minutes — is the shape this whole round is about.)
}
{
  // The two outcomes, forced, because the population above cannot guarantee either one.
  for (const [kill, label] of [[false, 'survivable'], [true, 'fatal']]) {
    const p2 = crowd(8);
    const v = p2.positions()[0];
    p2.hit(v.i, { speed: 60 / 3.6, dirX: 1, dirZ: 0, kill });
    let rose = null, cleared = null;
    for (let k = 0; k < 60 * 20; k++) {
      p2.update(DT, FOCUS);
      if (!p2.peds[v.i]) { cleared = k * DT; break; }
      if (!p2.peds[v.i].down) { rose = k * DT; break; }
    }
    console.log(`    a ${label} casualty: rose ${rose === null ? 'never' : `${rose.toFixed(1)} s`}, ` +
      `cleared ${cleared === null ? 'not within 20 s' : `${cleared.toFixed(1)} s`}`);
    if (kill) {
      check('a fatal casualty stays down', rose === null, `rose ${rose}`);
      // In shot, so the clear rule holds it: see the arms below.
      check('and is not cleared in front of the camera', cleared === null, `cleared ${cleared}`);
      let capped = null;
      for (let k = 0; k < 60 * 60; k++) {
        p2.update(DT, FOCUS);
        if (!p2.peds[v.i]) { capped = 20 + k * DT; break; }
      }
      console.log(`      the hard cap frees the slot at ${capped?.toFixed(1)} s`);
      check('the slot is freed by the hard cap', capped !== null && capped > 40 && capped < 50,
        `${capped}`);
    } else {
      check('a survivable casualty gets up', rose !== null && rose > 3 && rose < 7, `${rose}`);
    }
  }
}
// §5  The fleet reacts, and the drawn car is the published car.
// ---------------------------------------------------------------------------
console.log('\n§5  A traffic car is shunted');
{
  const t = fleet();
  const car = t.cars.find(Boolean);
  const before = t._lastPositions.find((p) => p.id === car.id);
  check('a settled fleet publishes the car', !!before);
  check('a scuff moves nothing', t.hit(car.id, { dv: 0.5, dirX: 1, dirZ: 0 }) === null);
  // Ram it across its own heading, which is the case the model is about: the spin is now the
  // LATERAL share of the blow, so a square-on hit has to be a separate arm (below).
  const head = t._lastPositions.find((q) => q.id === car.id).heading;
  const sideX = Math.cos(head), sideZ = -Math.sin(head);
  const r = t.hit(car.id, { dv: 8, dirX: sideX, dirZ: sideZ });
  console.log(`    dv 8 m/s across the heading -> ${JSON.stringify(r)}`);
  check('a real hit shunts it', r && r.push > 1, JSON.stringify(r));
  check('and stops it', car.stopS > 1, `${car.stopS}`);
  check('and the fleet reports it as shunted', t.isShunted(car.id) === true);
  /**
   * AND THE CAR SLIDES THERE RATHER THAN ARRIVING. One frame after the ram it has covered
   * 0.13 m of its 2.91: the offset is walked out at the same deceleration the distance came
   * from, so this arm has to run the slide before it can measure it. That is the fix for a
   * 2.84 m step in one 1/60 s frame — an implied 170 m/s — which the first version shipped
   * under a comment saying the car "slides at about mu*g".
   */
  let slideFrames = 0;
  for (let k = 0; k < 60 * 3; k++) {
    t.update(DT, FOCUS);
    slideFrames++;
    if (!car.shunt || car.shunt.slideV === 0) break;
  }
  console.log(`    the slide took ${(slideFrames * DT).toFixed(2)} s of the ` +
    `${(8 / 11.0).toFixed(2)} s the model gives it`);
  check('the shunt is a slide, not a teleport', slideFrames > 20, `${slideFrames} frames`);
  const after = t._lastPositions.find((p) => p.id === car.id);
  const moved = Math.hypot(after.x - before.x, after.z - before.z);
  console.log(`    the PUBLISHED position moved ${moved.toFixed(2)} m, yaw by ` +
    `${Math.abs(after.yaw - before.yaw).toFixed(3)} rad, shunted flag ${after.shunted}`);
  check('the published position moved with it', moved > 1, `${moved.toFixed(2)} m`);
  check('the published yaw moved with it', Math.abs(after.yaw - before.yaw) > 0.1,
    `${Math.abs(after.yaw - before.yaw).toFixed(3)}`);
  /**
   * THE SPIN HAS A SIGN AND A SHAPE, and it had neither: `yaw + |dv| * 0.06` span every car in
   * the district the same way by the same amount whichever side it was hit, made the lower clamp
   * unreachable, and span a head-on ram as hard as a t-bone. Both reviewers found it
   * independently. Three arms: the same blow from the other side spins the other way, a blow
   * along the heading barely spins at all, and neither is what the old code did.
   */
  {
    const mirror = fleet();
    const mc = mirror.cars.find(Boolean);
    const mh = mirror._lastPositions.find((q) => q.id === mc.id).heading;
    mirror.hit(mc.id, { dv: 8, dirX: -Math.cos(mh), dirZ: Math.sin(mh) });
    const headOn = fleet();
    const hc = headOn.cars.find(Boolean);
    const hh = headOn._lastPositions.find((q) => q.id === hc.id).heading;
    headOn.hit(hc.id, { dv: 8, dirX: Math.sin(hh), dirZ: Math.cos(hh) });
    console.log(`    spin: near side ${car.shunt.yaw.toFixed(3)}, far side ` +
      `${mirror.cars.find((c) => c && c.id === mc.id).shunt.yaw.toFixed(3)}, ` +
      `square on ${headOn.cars.find((c) => c && c.id === hc.id).shunt.yaw.toFixed(3)} rad`);
    const far = mirror.cars.find((c) => c && c.id === mc.id).shunt.yaw;
    const on = headOn.cars.find((c) => c && c.id === hc.id).shunt.yaw;
    check('a blow from the other side spins the car the other way', far * car.shunt.yaw < 0,
      `${car.shunt.yaw.toFixed(3)} against ${far.toFixed(3)}`);
    check('and by the same amount', Math.abs(Math.abs(far) - Math.abs(car.shunt.yaw)) < 0.02,
      `${Math.abs(far).toFixed(3)} vs ${Math.abs(car.shunt.yaw).toFixed(3)}`);
    check('a square-on ram barely spins it', Math.abs(on) < 0.05 * Math.abs(car.shunt.yaw),
      `${on.toFixed(4)} against a side blow's ${car.shunt.yaw.toFixed(3)}`);
  }
  check('and the published record says so', after.shunted === true);
  /**
   * AND THE DRAWN CAR IS THE PUBLISHED CAR. This section is headed with that claim and never
   * read a matrix: it caught the disagreement one way round (a shunt applied to the record and
   * not to the matrix) and missed the other (a matrix written from the un-shunted lane position),
   * which passed all 65 checks of the previous version. The readback costs 224 ms.
   */
  const drawn = carDrawn(t, car.id);
  const gap = drawn ? Math.hypot(drawn.x - after.x, drawn.z - after.z) : null;
  const yawGap = drawn ? Math.abs(((drawn.yaw - after.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) : null;
  console.log(`    the DRAWN car against the published one: ${gap === null ? 'n/a' : gap.toExponential(1)} m, ` +
    `${yawGap === null ? 'n/a' : yawGap.toExponential(1)} rad`);
  check('the renderer draws the car where the module published it', gap !== null && gap < 1e-3,
    `${gap}`);
  check('and at the published yaw', yawGap !== null && yawGap < 1e-5, `${yawGap}`);
  // KNOWN-BAD: a shunt applied only at the matrix. The published position is what the collision
  // pass and the overlap statistics read, so a car drawn somewhere its own module does not know
  // about is the phantom-bounding-box defect again, in motion.
  console.log('    KNOWN-BAD: applied at the matrix only, the published position would not move,');
  console.log('    so district/main.js would collide with a car that is no longer drawn there.');
  check('KNOWN-BAD: the shunt is big enough that the discrepancy would matter',
    r.push > 0.95, `${r.push.toFixed(2)} m against a 0.95 m car radius`);
  // It stops, then straightens and drives on.
  let cleared = null;
  for (let k = 0; k < 60 * 40; k++) {
    t.update(DT, FOCUS);
    if (!t.cars.find((c) => c && c.id === car.id)) break;
    if (!car.shunt) { cleared = k * DT; break; }
  }
  check('and stops reporting it once the shunt has unwound', t.isShunted(car.id) === false);
  console.log(`    the shunt unwound after ${cleared?.toFixed(2)} s and the car drove on at ` +
    `${car.v.toFixed(2)} m/s`);
  check('the shunt unwinds', cleared !== null && cleared < 20, `${cleared}`);
  check('and the car is driving again', car.v > 2, `${car.v}`);
  check('the recovery is counted', t.stats.shuntRecoveries === 1);
  check('the car is still on its own edge throughout', Number.isFinite(car.t) && car.edge >= 0);
}

// ---------------------------------------------------------------------------
// §6  The gridlock exemption, and its bound.
//
// THE FIRST VERSION OF THIS SECTION MEASURED NOTHING, and three things were wrong at once. It
// put the car "in the state the rule watches" with `car.holds = [car.edge]` — `holds` carries
// junction VERTEX ids, `car.edge` is an EDGE index, and the module clears `holds` on the next
// update anyway. Traced over its own 1,380 frames: 0 frames both stopped and holding, so the
// stuck counter was never running. Both arms read 0.02 s against a 20 s limit, with the
// exclusion and without it, and the KNOWN-BAD check under them was `1.2 + 10 * 0.25 > 0` — an
// inequality between two literals that cannot fail.
//
// And the claim the section existed to defend was false. SHUNT_STOP_MAX is 5 s against a 20 s
// gridlock limit, so a single ram can never accumulate enough stuck time to trip the rule: "the
// rule deletes it a few seconds after the impact" does not happen and the exemption is not
// needed for one collision. What the exemption really does is protect a car that was ALREADY
// near the limit when it was hit — and a blind review then showed the exemption was unbounded:
// 215 nudges of dv 1.01 over 300 s pinned a car for ever, and the rule deleted the cars queued
// behind it instead, 9 deletions in 240 s against 0 in the control.
// ---------------------------------------------------------------------------
console.log('\n§6  The gridlock exemption is bounded');
{
  const t = fleet();
  const car = t.cars.find(Boolean);
  // A car that has ALREADY accumulated stuck time, then rammed: the ram must not forgive it.
  car.stuckS = 15;
  t.hit(car.id, { dv: 10, dirX: 1, dirZ: 0 });
  t.update(DT, FOCUS);
  console.log(`    a car 15 s into the stuck counter, then rammed: stuckS ${car.stuckS.toFixed(2)}`);
  check('a ram freezes the stuck counter rather than forgiving it', car.stuckS >= 15,
    `${car.stuckS.toFixed(2)} after 15`);
  check('and the ram did stop the car', (car.stopS ?? 0) > 1, `${car.stopS}`);
}
{
  // THE ATTACK, as the reviewer ran it: the cheapest effective hit, repeated. `stopS` is a max
  // rather than an accumulator, so each nudge renews the stop; the question is whether the
  // EXEMPTION renews with it.
  const t = fleet();
  const car = t.cars.find(Boolean);
  let held = 0, expired = false;
  for (let k = 0; k < 60 * 60; k++) {
    if (k % Math.round(1.4 * 60) === 0) t.hit(car.id, { dv: 1.01, dirX: 1, dirZ: 0 });
    t.update(DT, FOCUS);
    if (!t.cars.find((c) => c && c.id === car.id)) break;
    held = Math.max(held, car.shuntHeldS ?? 0);
    if (t.stats.shuntExemptExpired > 0) { expired = true; break; }
  }
  console.log(`    nudged every 1.4 s: held stopped for ${held.toFixed(1)} s, ` +
    `exemption expired ${expired}`);
  check('a car nudged over and over stays stopped', held > 5, `${held.toFixed(1)} s`);
  check('but the exemption expires, so it cannot be pinned for ever', expired,
    `held ${held.toFixed(1)} s, expiries ${t.stats.shuntExemptExpired}`);
  check('and it expires at the stated bound, not at some other time',
    held >= 10 && held < 11, `${held.toFixed(2)} s against a 10 s bound`);
}
{
  // The legitimate case the exemption is for: one real ram, and the stop it imposes is not
  // counted against a car that is otherwise behaving.
  const t = fleet();
  const car = t.cars.find(Boolean);
  const r = t.hit(car.id, { dv: 15, dirX: 1, dirZ: 0 });
  let worst = 0, alive = true;
  for (let k = 0; k < 60 * 25; k++) {
    t.update(DT, FOCUS);
    if (!t.cars.find((c) => c && c.id === car.id)) { alive = false; break; }
    worst = Math.max(worst, car.stuckS);
  }
  console.log(`    one ${r.stopS.toFixed(1)} s ram: alive ${alive}, worst stuckS ` +
    `${worst.toFixed(2)} against a ${t.stuckLimitS} s limit`);
  check('one ram never gets near the gridlock limit', worst < t.stuckLimitS * 0.5,
    `${worst.toFixed(2)}`);
  check('and the car is still in the fleet', alive);
  check('the gridlock recovery counter did not fire', t.stats.gridlockRecoveries === 0,
    `${t.stats.gridlockRecoveries}`);
  // The arithmetic that makes the first claim structural rather than lucky.
  console.log(`    a single ram can stop a car for at most 5.0 s against a ${t.stuckLimitS} s ` +
    `limit, so it cannot trip the rule by itself`);
  check('the longest stop one ram can impose is under the gridlock limit',
    5 < t.stuckLimitS, `5 against ${t.stuckLimitS}`);
}

// ---------------------------------------------------------------------------
// §7  A shunt does not knock a car through a shopfront.
// ---------------------------------------------------------------------------
console.log('\n§7  The shunt is fitted to the buildings');
{
  const ix = new BlockerIndex(district);
  const clear = (x, z, r) => !ix.resolveCircle(x, z, r);
  // The worst case the model can produce: the 4.5 m cap, in 16 directions, over three
  // fleets on three different parts of the district. dv 25 is far past the cap, which engages at
  // dv 9.95 — through this module's own pairDv at e = 0.15, a 63 km/h closing speed.
  const sweep = (wire) => {
    let tested = 0, inside = 0, worst = 0, fits = 0;
    for (const focus of [{ x: 57, z: -164 }, { x: 300, z: -100 }, { x: -200, z: 120 }]) {
      for (let a = 0; a < 16; a++) {
        const t = new Traffic(scene, district, { count: 30 });
        if (wire) t.clearAt = clear;
        for (let k = 0; k < 240; k++) t.update(DT, focus);
        const th = (a / 16) * Math.PI * 2;
        for (const q of t._lastPositions) t.hit(q.id, { dv: 25, dirX: Math.sin(th), dirZ: Math.cos(th) });
        // RUN THE SLIDE OUT. The offset is walked to its destination at SHUNT_DECEL, so a single
        // frame after the ram applies 0.13 m of a 4.5 m push and a sweep that samples there is
        // measuring nothing. 4.5 m at 9.95 m/s entry is 0.90 s; 72 frames is comfortably past it.
        for (let k = 0; k < 72; k++) t.update(DT, focus);
        for (const q of t._lastPositions) {
          tested++;
          const r = ix.resolveCircle(q.x, q.z, 0.95);
          if (r) { inside++; worst = Math.max(worst, Math.hypot(r.x - q.x, r.z - q.z)); }
        }
        fits += t.stats.shuntFitFrames;
      }
    }
    return { tested, inside, worst, fits };
  };
  /**
   * THE SWEEP HAS TO BE AT THE CAP IT NAMES. `dv 25` is past the cap only while the cap exists:
   * raising SHUNT_MAX to 1e9 turned this into a 27.70 m displacement sweep, which still reported
   * "0 of 1440 inside a building" and passed. Assert the push the sweep is actually applying.
   */
  {
    const t0 = fleet(4, 120);
    const c0 = t0.cars.find(Boolean);
    const r0 = t0.hit(c0.id, { dv: 25, dirX: 1, dirZ: 0 });
    console.log(`    the sweep's own ram: dv 25 -> push ${r0.push.toFixed(3)} m`);
    check('the sweep rams at the cap, so it is the worst case it claims to be',
      Math.abs(r0.push - 4.5) < 1e-9, `${r0.push}`);
    check('and the cap is a bound on the whole offset, not on one axis',
      (() => {
        t0.hit(c0.id, { dv: 25, dirX: 0, dirZ: 1 });
        return Math.hypot(c0.shunt.ox, c0.shunt.oz) <= 4.5 + 1e-9;
      })(), `${Math.hypot(c0.shunt.ox, c0.shunt.oz).toFixed(4)} m after two orthogonal rams`);
  }
  const bad = sweep(false), good = sweep(true);
  console.log(`    without the building hook: ${bad.inside} of ${bad.tested} shunts published inside ` +
    `a building, worst ${bad.worst.toFixed(2)} m in`);
  console.log(`    with it:                   ${good.inside} of ${good.tested}, ` +
    `${good.fits} offsets fitted short`);
  check('the fleet is large enough for this sweep to mean something', good.tested === 1440,
    `${good.tested}`);
  // KNOWN-BAD is the SAME sweep with the hook unwired, which is the state this shipped in
  // until it was measured: 0.8% of worst-case shunts, and only at the cap, which is the one
  // crash a player goes and looks at.
  check('KNOWN-BAD: without the hook, shunts do land inside buildings', bad.inside > 0,
    `${bad.inside} of ${bad.tested}`);
  check('with the hook, no shunt publishes a car inside a building', good.inside === 0,
    `${good.inside} of ${good.tested}`);
  /**
   * `good.fits === bad.inside` was asserted here as a self-validation and it CANNOT FAIL: the
   * fit fires on `!clearAt(destination)` and the bad sweep counts `resolveCircle(destination)`,
   * which is the same predicate at the same point on a bit-identical fleet. It validates that
   * the two sweeps saw the same fleet — worth having, so it stays, renamed to what it does —
   * but it is not evidence the fit is doing its job. Collapsing the fit ladder to `[0]`, so that
   * every blocked shunt becomes NO shunt at all, leaves both counts reading 11.
   *
   * What the fit owes is the LONGEST clear offset, not merely a clear one. So: fit a placement
   * by hand and check the next rung up is genuinely blocked.
   */
  // `good.fits` counts FRAMES in which a fit was applied, and the offset now takes about
  // 0.9 s to slide out, so it is no longer one per placement — what it says is that the fit
  // fired at all and kept firing while the car was out of position.
  check('the fit fired on the placements that needed it', good.fits >= bad.inside,
    `${good.fits} fit-frames against ${bad.inside} bad placements`);
  {
    // Find one of the 11, re-run its fit here, and verify the rung above it is blocked.
    let checked = 0, tooShort = 0;
    for (const focus of [{ x: 57, z: -164 }, { x: 300, z: -100 }, { x: -200, z: 120 }]) {
      for (let a = 0; a < 16 && checked < 6; a++) {
        const t2 = new Traffic(scene, district, { count: 30 });
        t2.clearAt = clear;
        for (let k = 0; k < 240; k++) t2.update(DT, focus);
        const th = (a / 16) * Math.PI * 2;
        const pre = t2._lastPositions.map((q) => ({ ...q }));
        for (const q of pre) t2.hit(q.id, { dv: 25, dirX: Math.sin(th), dirZ: Math.cos(th) });
        for (let k = 0; k < 72; k++) t2.update(DT, focus);
        if (!t2.stats.shuntFitFrames) continue;
        for (const q of t2._lastPositions) {
          const b = pre.find((o) => o.id === q.id);
          const car = t2.cars.find((c) => c && c.id === q.id);
          if (!b || !car || !car.shunt) continue;
          // EXACTLY WHICH RUNG WAS APPLIED. The car is stopped by its own ram, so its lane
          // position has not moved and `b` IS the base the offset is added to. Projecting the
          // published displacement onto the shunt vector recovers the fraction the ladder chose;
          // reverse-engineering it from the distance alone gets the rung wrong whenever the
          // ladder went past 0.75, which is what made the first version of this check report a
          // defect that was not there.
          const ox = car.shunt.ox, oz = car.shunt.oz;
          const mag2 = ox * ox + oz * oz;
          if (!(mag2 > 0)) continue;
          const f = ((q.x - b.x) * ox + (q.z - b.z) * oz) / mag2;
          const rungs = [1, 0.75, 0.5, 0.25, 0];
          const at = rungs.findIndex((r) => Math.abs(r - f) < 1e-6);
          if (at <= 0) continue;                       // not fitted, or not on the ladder
          checked++;
          const up = rungs[at - 1];                    // the rung the ladder rejected
          if (clear(b.x + ox * up, b.z + oz * up, 0.95)) tooShort++;
          if (checked >= 6) break;
        }
      }
    }
    console.log(`    ${checked} fitted offsets examined, ${tooShort} shorter than they needed to be`);
    check('the fit found placements to examine', checked > 0, `${checked}`);
    check('and every fitted offset is the longest clear one on the ladder', tooShort === 0,
      `${tooShort} of ${checked} could have been longer`);
  }
}

// ---------------------------------------------------------------------------
// §7b  Both hit()s guard the DIRECTION, not only the magnitude.
//
// A blind review drove a NaN through each. `Math.hypot(NaN, NaN) || 1` silently becomes 1, so
// the guard that existed — on the delta-v — let the direction through:
//
//   traffic  a NaN offset, and the car is then unrecoverable: `hypot(NaN, ...) > despawnRadius`
//            is false so it never despawns, `hypot(NaN, NaN) < SHUNT_CLEAR_M` is false so the
//            shunt never clears. A fleet slot drawn at (NaN, NaN) for the rest of the session.
//   crowd    16 of 16 entries of the head matrix non-finite, `travelled` stuck at 0, and the
//            counters recording a perfectly normal knockdown.
//
// And a ZERO direction is worse than it looks: the fall axis is (-uz, 0, ux), so it becomes the
// zero vector, `setFromAxisAngle` returns the identity whatever the angle, and the casualty
// stands bolt upright and motionless for 45 s while isDown() says it is on the ground.
// ---------------------------------------------------------------------------
console.log('\n§7b Non-finite and degenerate inputs are refused');
{
  const t = fleet();
  const car = t.cars.find(Boolean);
  const before = JSON.stringify(t._lastPositions.find((q) => q.id === car.id));
  const refusals = [
    ['a NaN direction', { dv: 8, dirX: NaN, dirZ: NaN }],
    ['a NaN delta-v', { dv: NaN, dirX: 1, dirZ: 0 }],
    ['an infinite delta-v', { dv: Infinity, dirX: 1, dirZ: 0 }],
    ['a zero direction', { dv: 8, dirX: 0, dirZ: 0 }],
  ];
  for (const [label, arg] of refusals) {
    check(`the fleet refuses ${label}`, t.hit(car.id, arg) === null, JSON.stringify(arg));
  }
  t.update(DT, FOCUS);
  const after = t._lastPositions.find((q) => q.id === car.id);
  check('and nothing non-finite reached the published position',
    Number.isFinite(after.x) && Number.isFinite(after.z) && Number.isFinite(after.yaw),
    JSON.stringify(after));
  check('nor the drawn matrix', (() => {
    const d = carDrawn(t, car.id);
    return d && Number.isFinite(d.x) && Number.isFinite(d.z) && Number.isFinite(d.yaw);
  })());
  check('the counters recorded no phantom shunts', t.stats.shunts === 0, `${t.stats.shunts}`);
  check('and a real hit still works after all that', t.hit(car.id, { dv: 8, dirX: 1, dirZ: 0 }) !== null);
}
{
  const p2 = crowd(8);
  const v = p2.positions()[0];
  for (const [label, arg] of [
    ['a NaN direction', { speed: 16.7, dirX: NaN, dirZ: NaN }],
    ['a NaN speed', { speed: NaN, dirX: 1, dirZ: 0 }],
    ['a zero direction', { speed: 16.7, dirX: 0, dirZ: 0 }],
  ]) {
    check(`the crowd refuses ${label}`, p2.hit(v.i, arg) === null, JSON.stringify(arg));
  }
  check('nobody was counted as knocked down', p2.stats.knockdowns === 0, `${p2.stats.knockdowns}`);
  p2.update(DT, FOCUS);
  const pose = poseOf(p2, v.i);
  check('and the body is still drawn upright and finite',
    Number.isFinite(pose.x) && Number.isFinite(pose.headY) && pose.tiltDeg < 5,
    JSON.stringify(pose));
  check('a real hit still works after all that',
    p2.hit(v.i, { speed: 16.7, dirX: 1, dirZ: 0 }) !== null);
}

// ---------------------------------------------------------------------------
// §8  Determinism, purity and cost.
// ---------------------------------------------------------------------------
console.log('\n§8  Determinism and cost');
function crowdRun() {
  const p = crowd(24, 90);
  const hits = [];
  for (const v of p.positions().slice(0, 6)) {
    const r = p.hit(v.i, { speed: (20 + v.i * 4) / 3.6, dirX: 1, dirZ: 0 });
    if (r) hits.push(r.throwWanted.toFixed(6));
  }
  for (let k = 0; k < 60 * 6; k++) p.update(DT, FOCUS);
  return JSON.stringify([hits, p.stats.knockdowns, p.stats.recoveries,
    p.positions().map((q) => `${q.x},${q.z},${q.down}`)]);
}
const c1 = crowdRun(), c2 = crowdRun();
check('a crowd of 24 with six knockdowns is bit-identical across runs', c1 === c2);
function fleetRun() {
  const t = fleet(12, 150);
  for (const c of t.cars.filter(Boolean).slice(0, 4)) t.hit(c.id, { dv: 6, dirX: 0, dirZ: 1 });
  for (let k = 0; k < 60 * 6; k++) t.update(DT, FOCUS);
  return JSON.stringify([t.stats.shunts, t.stats.shuntRecoveries,
    t._lastPositions.map((p) => `${p.x.toFixed(4)},${p.z.toFixed(4)},${p.shunted}`)]);
}
check('a fleet of 12 with four shunts is bit-identical across runs', fleetRun() === fleetRun());
// No new randomness: sim-determinism asserts every generator is seeded, and a knockdown that
// rolled dice would make every capture of a crowd a different capture.
for (const [file, label] of [['../src/pedestrians.js', 'pedestrians.js'], ['../src/traffic.js', 'traffic.js']]) {
  const src = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const stripped = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check(`no Math.random in ${label}`, !stripped.includes('Math.random'));
}

/**
 * COST, AND WHAT THIS MEASUREMENT CAN AND CANNOT RESOLVE.
 *
 * The first version timed the casualty arm first and the quiet arm once, last, and read -0.5,
 * 12.5 and 42.1 us over three clean-box runs. A negative cost is not a cost. I diagnosed that as
 * ordering, ran the quiet arm twice, got a consistent 35-73 us, and wrote "1.5-3 us per
 * casualty" into the commit message and the milestone.
 *
 * A blind review then interleaved the two arms properly — six alternating repetitions, both
 * equally warm, minima compared — and got -14.3, +6.0 and -10.6 us. The 35-73 us was still the
 * ordering: the casualty arm ran first and warmed the paths, and comparing it against the MIN of
 * two later quiet runs biases the difference high by construction. Its own runs of the shipped
 * gate spanned 19.6 to 187.8 us on an idle box and failed the 100 us bound in 2 of 11.
 *
 * So: the arms are interleaved, the spread of each is printed beside the difference, and this
 * gate asserts only the thing the measurement can carry — a per-frame ceiling with a 13x margin.
 * The casualty cost is BELOW THE RESOLUTION of this instrument, which is a result, and it is the
 * one that stops the next person quoting 1.5 us per casualty.
 */
const perf = crowd(96, 120);
for (const v of perf.positions().slice(0, 24)) {
  perf.hit(v.i, { speed: 14, dirX: 1, dirZ: 0, kill: true });
}
const quiet = crowd(96, 120);
const N = 200;
const timeOne = (c) => {
  const t0 = process.hrtime.bigint();
  for (let k = 0; k < N; k++) c.update(DT, FOCUS);
  return Number(process.hrtime.bigint() - t0) / N;
};
/**
 * AND THE CASUALTIES HAVE TO STILL BE THERE AT THE END. Six interleaved repetitions is 1,200
 * frames, 20 s of simulated time, and a fatal body more than 35 m from the focus is cleared at
 * 12 s — so the first interleaved version timed a "crowd of 96 with 24 down" that had 2 down by
 * the time it finished. The population is topped up between repetitions, outside the timed
 * region, and the smallest count seen at the end of any repetition is what the check reads.
 */
const topUp = () => {
  let n = 0;
  for (const q of perf.positions()) {
    if (n >= 24) break;
    const ped = perf.peds[q.i];
    // A fatal body is cleared 12 s after it goes down and the slot refills with a walker, so a
    // cohort knocked down at the start ages out MID-repetition: traced, the third repetition of
    // the first interleaved version timed a crowd that had dropped from 24 casualties to 2. Any
    // body past 8 s is re-knocked here, outside the timed region, so the population the timing
    // sees is the population the check reads.
    if (ped && ped.down && ped.down.t < 8) { n++; continue; }
    if (ped && ped.down) ped.down = null;
    if (perf.hit(q.i, { speed: 14, dirX: 1, dirZ: 0, kill: true })) n++;
  }
};
const pedRuns = [], quietRuns = [];
let down = Infinity;
for (let rep = 0; rep < 6; rep++) {
  topUp();
  pedRuns.push(timeOne(perf));
  down = Math.min(down, perf.positions().filter((q) => q.down).length);
  quietRuns.push(timeOne(quiet));
}
const pedNs = Math.min(...pedRuns), quietNs = Math.min(...quietRuns);
const pedSpread = Math.max(...pedRuns) - pedNs, quietSpread = Math.max(...quietRuns) - quietNs;
check('the cost was measured on a population that is actually down', down > 10, `${down}`);
console.log(`    crowd of 96 with ${down} down: ${(pedNs / 1000).toFixed(1)} us/frame ` +
  `(spread ${(pedSpread / 1000).toFixed(1)} over 6 interleaved runs)`);
console.log(`    the same crowd with nobody down:  ${(quietNs / 1000).toFixed(1)} us/frame ` +
  `(spread ${(quietSpread / 1000).toFixed(1)})`);
const delta = pedNs - quietNs;
console.log(`    difference ${(delta / 1000).toFixed(1)} us, against spreads of ` +
  `${(pedSpread / 1000).toFixed(1)} and ${(quietSpread / 1000).toFixed(1)} — ` +
  `${Math.abs(delta) < Math.max(pedSpread, quietSpread) ? 'NOT RESOLVED by this instrument'
    : 'outside the noise of both arms'}`);
const perfT = fleet(30, 150);
let fleetShunted = 0;
for (const c of perfT.cars.filter(Boolean).slice(0, 10)) {
  if (perfT.hit(c.id, { dv: 7, dirX: 1, dirZ: 0 })) fleetShunted++;
}
// THE SAME GUARD THE CROWD ARM HAS. "fleet of 30 with 10 shunted" was a hard-coded string:
// raising SHUNT_MIN_DV to 7.5 made every one of those hits a no-op, the arm got 5x cheaper, and
// nothing noticed.
check('the fleet cost was measured on cars that are actually shunted', fleetShunted === 10,
  `${fleetShunted} of 10`);
const carRuns = [];
for (let rep = 0; rep < 4; rep++) carRuns.push(timeOne(perfT));
const carNs = Math.min(...carRuns);
console.log(`    fleet of 30 with ${fleetShunted} shunted: ${(carNs / 1000).toFixed(1)} us/frame`);
check('a crowd with casualties costs under 3 ms a frame', pedNs < 3e6, `${(pedNs / 1000).toFixed(0)} us`);
check('a fleet with shunts costs under 3 ms a frame', carNs < 3e6, `${(carNs / 1000).toFixed(0)} us`);
check('casualties are not dearer than the walk they replace', pedNs < quietNs * 1.6,
  `${(pedNs / 1000).toFixed(0)} against ${(quietNs / 1000).toFixed(0)} us`);

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nREACTION: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nREACTION: PASS — ${checks.length} checks`);
