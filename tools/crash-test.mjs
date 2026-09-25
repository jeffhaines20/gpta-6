// Integration gate: the vehicle, the wall index and the damage model in one loop.
//
//   node tools/crash-test.mjs
//
// tools/damage-test.mjs proves the arithmetic and tools/blocker-test.mjs proves the
// geometry. Neither proves they are WIRED, and CLAUDE.md's standing lesson is that a
// lever which never reaches the pixels produces beautifully consistent numbers saying
// it does nothing: "check that a new lever reaches the pixels before you spend the hour
// measuring it." So this file drives the real Vehicle into real walls.
//
// §1 is the one that protects everything else. Body collision is opt-in, and
// tools/golden-trace.mjs — the only regression gate handling has — runs with it off. A
// tolerance of 0.25 m cannot see a 1e-15 drift, so this asserts something stronger than
// golden-trace can: an attached index and damage model, with the car nowhere near a
// building, must produce a BIT-IDENTICAL trace to no index at all.
import { Vehicle, BODY_SAMPLES, BODY_RADIUS } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel } from '../src/damage.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;
const HZ = 120, DT = 1 / HZ;

console.log('CRASH GATE — vehicle x walls x damage');
console.log('='.repeat(78));

/** A long wall across +z, and nothing else, so every expected answer is exact. */
const WALL = { buildings: [{ p: [[-200, 40], [200, 40], [200, 80], [-200, 80]], h: 20 }] };
const wallIx = new BlockerIndex(WALL, { cell: 32 });

/** Drive with a fixed control script and return the state trace. */
function drive({ blockers = null, damage = null, steps = 900, controls,
  start = [0, 0.55, 0], yaw = 0 } = {}) {
  const v = new Vehicle();
  v.position.set(start[0], start[1], start[2]);
  if (yaw) v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
  v.blockers = blockers; v.damage = damage;
  const ground = new FlatGround(0);
  const trace = [];
  for (let i = 0; i < steps; i++) {
    v.setControls(controls(i * DT, v));
    v.stepFixed(DT, ground, HZ);
    if (damage) damage.update(DT);
    if (i % 60 === 0) trace.push([v.position.x, v.position.z, v.speed, v.angularVelocity.y]);
  }
  return { v, trace, damage };
}
const FULL = () => ({ throttle: 1, brake: 0, steer: 0 });

// ---------------------------------------------------------------------------
// §1  The off path is bit-identical.
// ---------------------------------------------------------------------------
console.log('\n§1  Opt-in means opt-in');
// Start far behind the wall and stop before reaching it, so the index is attached and
// consulted but never fires.
const bare = drive({ controls: FULL, steps: 600, start: [0, 0.55, -300] });
const wired = drive({ controls: FULL, steps: 600, start: [0, 0.55, -300],
  blockers: wallIx, damage: new DamageModel() });
const ser = (t) => t.map((r) => r.map((n) => n.toExponential(17)).join(',')).join(';');
console.log(`    600 steps from z=-300, no wall in reach: contacts ${wired.v.contacts}, health ${wired.damage.health}`);
console.log(`    final z   bare ${bare.v.position.z.toExponential(17)}`);
console.log(`             wired ${wired.v.position.z.toExponential(17)}`);
check('an attached index that never fires changes nothing, to the last bit',
  ser(bare.trace) === ser(wired.trace));
check('the index really was attached and really did not fire',
  wired.v.blockers === wallIx && wired.v.contacts === 0);
check('an undamaged car has full engine power and no pull',
  wired.v.enginePower === 1 && wired.v.steerPull === 0);
check('a Vehicle with no damage model attached reports 1 and 0',
  bare.v.enginePower === 1 && bare.v.steerPull === 0);

// ---------------------------------------------------------------------------
// One helper for every wall arm, because the first three drafts of these tests each
// got the approach geometry wrong in a different way and each wrong answer looked like
// a result.
//
//   1. "accelerate from 160 m back for 1,400 steps" covers 32 m at 10 km/h, so four of
//      five speed arms never touched the wall, read 0.000 charged delta-v, and PASSED
//      against a prediction of 0.000 damage from 0.000 delta-v. Two zeros are not an
//      agreement, and this is the failure CLAUDE.md warns about in the form it takes in
//      a test rather than in a probe.
//   2. "yaw -0.10 into a wall that runs along x" is 84 degrees of incidence, not 6: a
//      solid crash labelled a scrape. tools/blocker-test.mjs made the same mistake in
//      its own contact-impulse section on the same afternoon.
//   3. "start 0.65 m from the wall and accelerate" makes contact while the car is still
//      doing 8 km/h, so the angled arm measured 0.84 m/s of normal delta-v where the
//      heading and speed predicted 4.83. The car has to be AT speed when it arrives.
//
// So the car is placed clear of the wall with its velocity already along its own
// heading — which is the state a driving car is actually in, and the state in which the
// tyres are not fighting a lateral slide — and the prediction is read against the
// impact speed the run actually had rather than the one it was aimed at:
//
//   dv = speed * sin(incidence) * (1 + restitution)
//
// exactly, because contactImpulse charges the normal component of the contact-point
// velocity, and the lever arm does not enter that.
const WALL_Z = 40, REST = 0.15;
function crashInto({ speedKmh, incidence, steps = 1200, clearance = 6, damage = null,
  hold = false }) {
  const v = new Vehicle();
  const dmg = damage ?? new DamageModel();
  // Spy on the model so every APPLIED impact is recorded with the speed that caused it.
  const seen = [];
  const raw = dmg.impact.bind(dmg);
  dmg.impact = (ev) => { const r = raw(ev); if (r.applied) seen.push({ ...r, atSpeed: ev.speed }); return r; };
  const yaw = Math.PI / 2 - incidence;
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  const speed = speedKmh / 3.6;
  v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
  // Back off along the heading by `clearance` in z, and start well inside the wall's
  // 400 m x-span so a shallow arm has room to run.
  v.position.set(-150 - (fx / Math.max(fz, 1e-6)) * clearance, 0.55,
    WALL_Z - BODY_RADIUS - clearance);
  v.velocity.set(fx * speed, 0, fz * speed);
  v.blockers = wallIx; v.damage = dmg;
  const ground = new FlatGround(0);
  let peakYaw = 0;
  for (let i = 0; i < steps; i++) {
    // Hold the speed so drag does not quietly change the experiment. With `hold`, also
    // steer back onto the original heading, which is what makes a shallow arm GRIND
    // along the wall for hundreds of steps instead of glancing off after seventeen. A
    // sustained scrape is the case the district actually produces, and it is the case
    // the refractory in damage.js exists for.
    let st = 0;
    if (hold) {
      // Yaw out of the quaternion, about +y.
      const yawNow = Math.atan2(
        2 * (v.quaternion.w * v.quaternion.y + v.quaternion.x * v.quaternion.z),
        1 - 2 * (v.quaternion.y * v.quaternion.y + v.quaternion.x * v.quaternion.x));
      let e = yaw - yawNow;
      while (e > Math.PI) e -= 2 * Math.PI;
      while (e < -Math.PI) e += 2 * Math.PI;
      st = Math.max(-1, Math.min(1, e * 3));
    }
    v.setControls({ throttle: v.speed < speed ? 1 : 0, brake: 0, steer: st });
    v.stepFixed(DT, ground, HZ);
    dmg.update(DT);
    if (Math.abs(v.angularVelocity.y) > Math.abs(peakYaw)) peakYaw = v.angularVelocity.y;
  }
  return { v, dmg, seen, peakYaw, inside: wallIx.insideAny(v.position.x, v.position.z) >= 0 };
}
const predictDv = (speed, incidence) => speed * Math.sin(incidence) * (1 + REST);

// ---------------------------------------------------------------------------
// §2  Straight into a wall, at measured speeds, against the analytic prediction.
// ---------------------------------------------------------------------------
console.log('\n§2  Square-on into a wall');
console.log('    aimed   impact speed   charged dv  predicted dv   severity  predicted   health  applied');
const dm0 = new DamageModel();
for (const target of [8, 15, 25, 40, 50, 60]) {
  const r = crashInto({ speedKmh: target, incidence: Math.PI / 2 });
  const first = r.seen[0];
  const sev = 1 - r.dmg.health;
  const dvPred = first ? predictDv(first.atSpeed, Math.PI / 2) : 0;
  const sevPred = first ? dm0.severityFor(first.dv) : 0;
  console.log(`    ${String(target).padStart(3)} km/h  ` +
    `${first ? (first.atSpeed * 3.6).toFixed(1).padStart(9) : '        -'} km/h ` +
    `${first ? first.dv.toFixed(3).padStart(9) : '        -'} m/s ` +
    `${first ? dvPred.toFixed(3).padStart(9) : '        -'} m/s  ` +
    `${sev.toFixed(4).padStart(8)}  ${sevPred.toFixed(4).padStart(9)}   ` +
    `${r.dmg.health.toFixed(4)}   ${r.dmg.stats.applied}`);
  check(`${target} km/h: the car reached the wall`, r.v.contacts > 0,
    `contacts ${r.v.contacts}, z ${r.v.position.z.toFixed(1)}`);
  check(`${target} km/h: the car is not inside the building afterwards`, !r.inside);
  check(`${target} km/h: the car stopped short of the wall`,
    r.v.position.z < WALL_Z - BODY_RADIUS + 0.01, `z ${r.v.position.z.toFixed(3)}`);
  if (target <= 8) {
    // THE FREE THRESHOLD IS ON DELTA-V, NOT ON APPROACH SPEED, and restitution sits
    // between them: 8 km/h into a rigid wall at e=0.15 is 2.56 m/s of delta-v, past
    // the 2.2 m/s bumper anchor, and costs 0.9% of the car. The free APPROACH speed is
    // 2.2/1.15 = 1.91 m/s, which is 6.9 km/h. That is the model being consistent, not
    // generous — asserting `health === 1` here was a misreading of its own anchor.
    const freeApproach = 2.2 / (1 + REST);
    console.log(`      the 2.2 m/s free delta-v is a free APPROACH speed of ` +
      `${(freeApproach * 3.6).toFixed(1)} km/h at restitution ${REST}`);
    check(`${target} km/h into a rigid wall costs under 2% of the car`, r.dmg.health > 0.98,
      `${r.dmg.health.toFixed(4)}`);
    check(`${target} km/h is above the free APPROACH speed, so it is not free`,
      target / 3.6 > freeApproach);
    continue;
  }
  check(`${target} km/h: charged delta-v is speed x (1+e) to 2%`,
    first && near(first.dv / dvPred, 1, 0.02),
    first && `${first.dv.toFixed(3)} vs ${dvPred.toFixed(3)}`);
  check(`${target} km/h: the first impact's damage is severityFor of its own delta-v`,
    first && near(first.severity, dm0.severityFor(first.dv), 1e-9));
  check(`${target} km/h: total damage is the first impact plus a bounce, not a multiple`,
    sev >= sevPred - 1e-9 && sev <= sevPred * 1.4 + 1e-9,
    `${sev.toFixed(4)} against first ${sevPred.toFixed(4)}`);
}
const fatal = crashInto({ speedKmh: 60, incidence: Math.PI / 2 });
console.log(`    60 km/h leaves health ${fatal.dmg.health.toFixed(4)}, wrecked ${fatal.dmg.wrecked}, enginePower ${fatal.v.enginePower}`);
check('a 60 km/h hit fails the mission threshold of 0.2', fatal.dmg.health < 0.2,
  `${fatal.dmg.health}`);
check('a wrecked car has no engine power', fatal.v.enginePower === 0);

// ---------------------------------------------------------------------------
// §3  The scrape-to-crash transition, which is the design decision made visible.
// ---------------------------------------------------------------------------
console.log('\n§3  Incidence sweep at 60 km/h');
console.log('    incidence  contacts   charged dv  predicted dv   severity   health  applied refracted below-thresh');
let scrapeFree = null;
for (const deg of [3, 6, 10, 15, 25, 40, 90]) {
  const inc = deg * Math.PI / 180;
  const r = crashInto({ speedKmh: 60, incidence: inc, steps: 2400, hold: true });
  const first = r.seen[0];
  const dv = first ? first.dv : r.dmg.stats.worstDv;
  const st = r.dmg.stats;
  console.log(`    ${String(deg).padStart(4)}deg  ${String(r.v.contacts).padStart(8)}  ` +
    `${dv.toFixed(3).padStart(9)} m/s ${predictDv(60 / 3.6, inc).toFixed(3).padStart(9)} m/s  ` +
    `${(1 - r.dmg.health).toFixed(4).padStart(8)}   ${r.dmg.health.toFixed(4)}  ` +
    `${String(st.applied).padStart(6)} ${String(st.refracted).padStart(8)} ${String(st.rejected).padStart(11)}`);
  if (deg === 6) scrapeFree = r;
  check(`${deg}deg at 60 km/h: the car is not inside the wall`, !r.inside);
  if (deg <= 6) check(`${deg}deg at 60 km/h costs nothing structural`, r.dmg.health === 1,
    `${r.dmg.health.toFixed(4)}`);
  if (deg >= 40) check(`${deg}deg at 60 km/h fails the mission threshold`, r.dmg.health < 0.2,
    `health ${r.dmg.health.toFixed(4)}`);
  if (deg === 90) check('square-on at 60 km/h is a write-off', r.dmg.wrecked,
    `health ${r.dmg.health.toFixed(4)}`);
}
console.log(`    the 6deg scrape: ${scrapeFree.v.contacts} contact steps, ` +
  `${scrapeFree.dmg.stats.rejected} charges below the 8 km/h threshold, ` +
  `still doing ${(scrapeFree.v.speed * 3.6).toFixed(1)} km/h`);
check('a 6deg scrape produces many contacts and no damage',
  scrapeFree.v.contacts > 50 && scrapeFree.dmg.health === 1,
  `${scrapeFree.v.contacts} contacts, health ${scrapeFree.dmg.health}`);
check('the scrape did not stop the car', scrapeFree.v.speed * 3.6 > 30,
  `${(scrapeFree.v.speed * 3.6).toFixed(1)} km/h`);
const asSpeed = new DamageModel();
asSpeed.impact({ dv: 60 / 3.6, dirX: 0, dirZ: 1 });
console.log(`    KNOWN-BAD: any ONE of those ${scrapeFree.v.contacts} steps charged on SPEED ` +
  `instead of normal delta-v leaves health ${asSpeed.health.toFixed(4)}`);
check('KNOWN-BAD: charging one scrape step on speed writes the car off', asSpeed.health === 0);

// ---------------------------------------------------------------------------
// §4  The five samples, and the 950 mm hole two would leave.
// ---------------------------------------------------------------------------
console.log('\n§4  The body collider');
console.log(`    ${BODY_SAMPLES.length} samples at z = ${BODY_SAMPLES.join(', ')}, radius ${BODY_RADIUS} m`);
// A 0.5 m thin slab running away in +x, its near face at x = 0.7 from the car's axis:
// 0.25 m INSIDE a body whose side is at 0.95, and reachable by the midships sample only.
const PIER = { buildings: [{ p: [[0.7, -0.25], [20.7, -0.25], [20.7, 0.25], [0.7, 0.25]], h: 8 }] };
const pierIx = new BlockerIndex(PIER, { cell: 8 });
const hitBy = (samples) => {
  let worst = 0;
  for (const sz of samples) {
    const r = pierIx.resolveCircle(0, sz, BODY_RADIUS);
    if (r && r.depth > worst) worst = r.depth;
  }
  return worst;
};
const five = hitBy(BODY_SAMPLES);
const two = hitBy([-1.2, 1.2]);
console.log('    a pier whose near corner is 0.25 m inside the body at midships:');
console.log(`      5 samples detect it, deepest correction ${five.toFixed(3)} m`);
console.log(`      KNOWN-BAD, 2 samples (one per end): ${two.toFixed(3)} m — it is not seen at all`);
check('five samples catch a pier at midships', five > 0.2, `${five.toFixed(3)}`);
check('KNOWN-BAD: a two-sample collider drives straight through its own midships',
  two === 0, `${two.toFixed(3)}`);
// The side notch, measured directly, BETWEEN THE OUTERMOST SAMPLES — which is where a
// notch is a defect. Outside them the collider tapers to the nose and tail on purpose;
// the first draft of this probe swept the whole body length, found the 950 mm taper at
// the very tip, and reported it as the worst side notch.
const reachAt = (z) => {
  let reach = 0;
  for (const sz of BODY_SAMPLES) {
    const dz = Math.abs(z - sz);
    if (dz < BODY_RADIUS) reach = Math.max(reach, Math.sqrt(BODY_RADIUS ** 2 - dz * dz));
  }
  return reach;
};
const ends = [BODY_SAMPLES[0], BODY_SAMPLES[BODY_SAMPLES.length - 1]];
let worstGap = 0, gapAt = 0;
for (let z = ends[0]; z <= ends[1]; z += 0.005) {
  const gap = 0.95 - reachAt(z);
  if (gap > worstGap) { worstGap = gap; gapAt = z; }
}
console.log(`    worst side notch between z = ${ends[0]} and ${ends[1]}: ${(worstGap * 1000).toFixed(0)} mm at z = ${gapAt.toFixed(2)}`);
console.log(`    outside that it tapers by design: reach ${reachAt(1.8).toFixed(3)} m at z=1.8, ${reachAt(2.15).toFixed(3)} at the nose`);
check('the worst side notch is under 60 mm', worstGap < 0.06, `${(worstGap * 1000).toFixed(0)} mm`);
const noseGap = Math.hypot(0.95, 2.15 - 1.2) - BODY_RADIUS;
console.log(`    nose corner sits ${noseGap.toFixed(3)} m outside the collider (a rounded car)`);
check('the nose corner cut-back is the 0.394 m the source states', near(noseGap, 0.394, 0.001));

// ---------------------------------------------------------------------------
// §5  A corner clip should spin the car, not stop it dead.
// ---------------------------------------------------------------------------
console.log('\n§5  Corner clip');
// 17 degrees at 40 km/h is 3.77 m/s of normal delta-v, about 5% of the car. Survivable,
// which is the only state in which steerPull and enginePower can be read at all — the
// first draft used 31 degrees at 50 km/h, wrecked the car, and read them both as zero
// for the entirely correct reason that a wrecked car has no engine.
const CLIP_DEG = 17, CLIP_INC = CLIP_DEG * Math.PI / 180;
const clip = crashInto({ speedKmh: 40, incidence: CLIP_INC, steps: 2400 });
const rr = clip.dmg.report();
const clipFirst = clip.seen[0];
console.log(`    40 km/h at ${CLIP_DEG}deg: ${clip.v.contacts} contacts, first charged dv ` +
  `${clipFirst ? clipFirst.dv.toFixed(3) : '-'} m/s (predicted ${predictDv(40 / 3.6, CLIP_INC).toFixed(3)})`);
console.log(`      health ${rr.health.toFixed(4)}, regions ` +
  Object.entries(rr.regions).map(([k, v]) => `${k} ${v.toFixed(3)}`).join(' '));
console.log(`      first contact filed as "${clipFirst ? clipFirst.region : '-'}", peak yaw rate ${clip.peakYaw.toFixed(3)} rad/s`);
console.log(`      steerPull ${clip.v.steerPull.toFixed(4)}, enginePower ${clip.v.enginePower.toFixed(4)}`);
check('the clip charged the predicted delta-v to 4%',
  clipFirst && near(clipFirst.dv / predictDv(clipFirst.atSpeed, CLIP_INC), 1, 0.04),
  clipFirst && `${clipFirst.dv.toFixed(3)} vs ${predictDv(clipFirst.atSpeed, CLIP_INC).toFixed(3)}`);
check('an angled hit puts damage on a side as well as the front',
  rr.regions.front > 0 && (rr.regions.left > 0 || rr.regions.right > 0),
  JSON.stringify(rr.regions));
check('an angled hit imparts yaw', Math.abs(clip.peakYaw) > 0.05, `${clip.peakYaw.toFixed(4)}`);
check('the car is not inside the wall after a corner clip', !clip.inside);
check('asymmetric damage produces a steering pull', Math.abs(clip.v.steerPull) > 0,
  `${clip.v.steerPull}`);
check('the clip left the car driveable', !clip.dmg.wrecked && clip.v.enginePower > 0.5,
  `health ${rr.health} power ${clip.v.enginePower}`);
// THE REGRESSION THESE THREE CHECKS EXIST FOR. Before the contact point was moved from
// the sample CENTRE to the circle SURFACE, the lever arm had no lateral component: every
// crash in the district was filed as pure front or pure rear, steerPull could never
// leave zero, and this same run imparted 0.0016 rad/s of yaw instead of 0.25. The
// position was correct throughout, which is why nothing else could see it.
check('the contact offset has a lateral component at all',
  rr.regions.left + rr.regions.right > 0.001,
  `L ${rr.regions.left} R ${rr.regions.right}`);

// ---------------------------------------------------------------------------
// §6  Recovery: a car spawned inside a building must get out.
// ---------------------------------------------------------------------------
console.log('\n§6  Recovery from inside a building');
const inDmg = new DamageModel();
const rec = drive({ blockers: wallIx, damage: inDmg, steps: 120, start: [0, 0.55, 60],
  controls: () => ({ throttle: 0, brake: 0, steer: 0 }) });
console.log(`    spawned at (0, 60), the dead centre of a 400x40 footprint -> ` +
  `(${rec.v.position.x.toFixed(1)}, ${rec.v.position.z.toFixed(1)}) after 1 s`);
check('a car spawned inside a building ends up outside it',
  wallIx.insideAny(rec.v.position.x, rec.v.position.z) < 0);
check('recovery does not charge a crash to a stationary car', inDmg.health === 1,
  `${inDmg.health}`);
check('recovery does not launch the car', rec.v.speed < 5, `${rec.v.speed.toFixed(2)} m/s`);

// ---------------------------------------------------------------------------
// §7  Determinism and the cost of having collision on.
// ---------------------------------------------------------------------------
console.log('\n§7  Determinism and cost');
const run = () => {
  const d = new DamageModel();
  const r = drive({ blockers: wallIx, damage: d, steps: 1500, start: [0, 0.55, -90], yaw: 0.3,
    controls: (t) => ({ throttle: 1, brake: 0, steer: Math.sin(t * 0.7) * 0.5 }) });
  return JSON.stringify([r.v.position.x, r.v.position.z, r.v.speed, d.report()]);
};
check('a 1,500-step crash run is bit-identical across runs', run() === run());

const district = JSON.parse((await import('node:fs')).default.readFileSync(
  new URL('../data/district.json', import.meta.url), 'utf8'));
const realIx = new BlockerIndex(district);
for (const [label, opts] of [
  ['OFF                ', { blockers: null, start: [57, 0.55, -164] }],
  ['ON, open road      ', { blockers: realIx, start: [57, 0.55, -164] }],
  ['ON, in contact     ', { blockers: wallIx, start: [0, 0.55, 39.2] }],
]) {
  const v = new Vehicle();
  v.blockers = opts.blockers ?? null;
  const st = opts.start;
  const g = new FlatGround(0);
  v.position.set(st[0], st[1], st[2]);
  v.setControls({ throttle: 1, brake: 0, steer: 0.1 });
  for (let i = 0; i < 200; i++) { v.position.set(st[0], st[1], st[2]); v.step(DT, g); }   // warm
  const N = 60000;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < N; i++) { v.position.set(st[0], st[1], st[2]); v.step(DT, g); }
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`    step() collision ${label} ${(ns / 1000).toFixed(2).padStart(6)} us  ` +
    `= ${(ns * HZ / 1e9 * 100).toFixed(3)}% of wall clock at ${HZ} Hz`);
  check(`step() with collision ${label.trim()} is under 25 us`, ns < 25000, `${(ns / 1000).toFixed(2)} us`);
}
console.log('    (the early-out is one grid lookup, which is why "open road" is not');
console.log('     measurably dearer than off at all.)');

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nCRASH GATE: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nCRASH GATE: PASS — ${checks.length} checks`);
