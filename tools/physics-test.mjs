// Deterministic fixed-step vehicle test. No renderer, no browser: steps the
// exact same Vehicle class at a fixed 60 Hz so the numbers are independent of
// frame rate. This is the harness that keeps vehicle handling honest in Phase 2.
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { DamageModel, IMPACT } from '../src/damage.js';

const DT = 1 / 60;
const ground = new FlatGround(0);

function run(label, setup, seconds, controlFn) {
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  setup?.(v);
  const steps = Math.round(seconds / DT);
  const samples = [];
  for (let i = 0; i < steps; i++) {
    v.setControls(controlFn(i * DT, v));
    v.step(DT, ground);
    if (i % Math.round(0.5 / DT) === 0) {
      samples.push({ t: +(i * DT).toFixed(2), kmh: +(v.speed * 3.6).toFixed(1) });
    }
  }
  return { label, seconds, kmh: +(v.speed * 3.6).toFixed(1), v, samples };
}

const out = {};

// 1. Standing-start acceleration. A GTA-style sedan should reach roughly
//    90-110 km/h in ~10 s and settle at a believable top speed.
const accel = run('accel', null, 14, () => ({ throttle: 1, brake: 0, steer: 0 }));
out.acceleration = {
  kmh_at_5s: accel.samples.find((s) => s.t === 5)?.kmh,
  kmh_at_10s: accel.samples.find((s) => s.t === 10)?.kmh,
  top_kmh: accel.kmh,
  ride_height: +accel.v.position.y.toFixed(3),
  wheels_on_ground: accel.v.wheels.filter((w) => w.contact).length,
};

// 2. Braking from speed.
let brakeStart = 0;
const brake = run('brake', null, 20, (t, v) => {
  if (t < 10) return { throttle: 1, brake: 0, steer: 0 };
  if (!brakeStart) brakeStart = v.speed * 3.6;
  return { throttle: 0, brake: 1, steer: 0 };
});
out.braking = {
  from_kmh: +brakeStart.toFixed(1),
  after_2s: brake.samples.find((s) => s.t === 12)?.kmh,
  after_4s: brake.samples.find((s) => s.t === 14)?.kmh,
  final_kmh: brake.kmh,
};

// 3. Steady-state cornering: full lock at speed. Checks the car actually turns,
//    stays on its wheels, and does not tip or numerically explode.
const turn = run('turn', null, 16, (t) => ({
  throttle: t < 6 ? 1 : 0.45, brake: 0, steer: t < 6 ? 0 : 1,
}));
const yawRate = turn.v.angularVelocity.y;
out.cornering = {
  kmh: turn.kmh,
  yaw_rate_rad_s: +yawRate.toFixed(3),
  turn_radius_m: Math.abs(yawRate) > 1e-3 ? +(turn.v.speed / Math.abs(yawRate)).toFixed(1) : null,
  wheels_on_ground: turn.v.wheels.filter((w) => w.contact).length,
  peak_slip: +Math.max(...turn.v.wheels.map((w) => w.slip)).toFixed(2),
  roll_deg: +(Math.acos(Math.min(1, Math.abs(
    1 - 2 * (turn.v.quaternion.x ** 2 + turn.v.quaternion.z ** 2)
  ))) * 180 / Math.PI).toFixed(1),
};

// 4. Handbrake slide.
const slide = run('handbrake', null, 12, (t) => ({
  throttle: t < 7 ? 1 : 0.2, brake: 0, steer: t < 7 ? 0 : 1, handbrake: t >= 7,
}));
out.handbrake = {
  kmh: slide.kmh,
  yaw_rate_rad_s: +slide.v.angularVelocity.y.toFixed(3),
  rear_slip: slide.v.wheels.slice(2).map((w) => +w.slip.toFixed(2)),
};

// 5. Stability: 30 s of aggressive random input must not produce NaN, launch the
//    car into orbit, or leave it resting through the floor.
const chaos = run('chaos', null, 30, (t) => ({
  throttle: Math.sin(t * 1.7) > -0.3 ? 1 : -0.6,
  brake: Math.sin(t * 0.9) > 0.75 ? 1 : 0,
  steer: Math.sin(t * 2.3) * Math.cos(t * 0.7),
  handbrake: Math.sin(t * 3.1) > 0.85,
}));
const p = chaos.v.position;
out.stability = {
  finite: [p.x, p.y, p.z, ...chaos.v.velocity.toArray()].every(Number.isFinite),
  final_y: +p.y.toFixed(3),
  y_in_range: p.y > 0.3 && p.y < 3,
  final_kmh: chaos.kmh,
  quat_normalized: +Math.abs(chaos.v.quaternion.length() - 1).toFixed(6),
};

// 6. Timestep independence: the same input at 30 / 60 / 120 Hz should land in the
//    same place. Divergence here is the #1 way vehicle physics rots later.
const atRate = (hz) => {
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  const dt = 1 / hz;
  for (let i = 0; i < Math.round(8 / dt); i++) {
    v.setControls({ throttle: 1, brake: 0, steer: i * dt > 3 ? 0.6 : 0 });
    v.step(dt, ground);
  }
  return { hz, kmh: +(v.speed * 3.6).toFixed(1), x: +v.position.x.toFixed(2), z: +v.position.z.toFixed(2) };
};
out.timestep_independence = [30, 60, 120].map(atRate);

// 7. Raw step cost, to see how much of the frame budget one car eats.
const perfCar = new Vehicle();
perfCar.position.set(0, 0.55, 0);
const t0 = process.hrtime.bigint();
for (let i = 0; i < 60000; i++) {
  perfCar.setControls({ throttle: 1, steer: 0.2 });
  perfCar.step(DT, ground);
}
const us = Number(process.hrtime.bigint() - t0) / 1000 / 60000;
out.cost_per_vehicle_step_us = +us.toFixed(2);
out.vehicles_per_16ms_frame = Math.round(16000 / us);

console.log(JSON.stringify(out, null, 2));

// 8. Same test again, but driven through the fixed-step accumulator at wildly
//    different wall-clock frame rates. These must agree.
const viaAccumulator = (hz) => {
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  const wall = 1 / hz;
  for (let i = 0; i < Math.round(8 / wall); i++) {
    v.setControls({ throttle: 1, brake: 0, steer: i * wall > 3 ? 0.6 : 0 });
    v.stepFixed(wall, ground, 120);
  }
  return { wall_hz: hz, kmh: +(v.speed * 3.6).toFixed(1), x: +v.position.x.toFixed(2), z: +v.position.z.toFixed(2) };
};
const fixedStep = [15, 30, 60, 144].map(viaAccumulator);
console.log('FIXED-STEP:', JSON.stringify(fixedStep));

// ---------------------------------------------------------------------------
// Gate. Until 2026-08-30 this file computed everything above and asserted none
// of it: no comparison, no threshold, no process.exit, and `npm run gates` piped
// its output to /dev/null. It could not fail. The property its own comment calls
// "the #1 way vehicle physics rots later" was printed and ignored.
//
// Every bound below is derived from a measured value, with the measurement and
// the headroom stated. Bands are wide enough not to flake on a software
// rasteriser and tight enough to catch real rot. Loosening one is a threshold
// change and belongs in the PROGRESS.md ledger like any other.
// ---------------------------------------------------------------------------
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, detail });
const finite = (o) => Object.values(o).every((v) =>
  typeof v === 'number' ? Number.isFinite(v) : (typeof v === 'object' && v !== null ? finite(v) : true));

// 1. THE headline property. The fixed-step accumulator must put the car in the
//    same place regardless of wall-clock frame rate. Measured spread across
//    15/30/60/144 Hz: 1.67 m. Bound 2.5 m leaves ~1.5x headroom.
let worstPair = 0, worstLabel = '';
for (let i = 0; i < fixedStep.length; i++) {
  for (let j = i + 1; j < fixedStep.length; j++) {
    const d = Math.hypot(fixedStep[i].x - fixedStep[j].x, fixedStep[i].z - fixedStep[j].z);
    if (d > worstPair) { worstPair = d; worstLabel = `${fixedStep[i].wall_hz}Hz vs ${fixedStep[j].wall_hz}Hz`; }
  }
}
check('fixed-step position convergence < 2.5 m', worstPair < 2.5,
  `worst ${worstPair.toFixed(2)} m (${worstLabel})`);

// 2. Speed must converge too. Measured spread: 0.0 km/h.
const kmhSpread = Math.max(...fixedStep.map((f) => f.kmh)) - Math.min(...fixedStep.map((f) => f.kmh));
check('fixed-step speed convergence < 1.0 km/h', kmhSpread < 1.0, `spread ${kmhSpread.toFixed(2)} km/h`);

// 3. Nothing anywhere may go non-finite. This includes the deliberately-bad raw
//    step() path, which is allowed to diverge but not to produce NaN.
check('all outputs finite', finite(out) && finite({ fixedStep }), 'no NaN/Infinity');

// 4. Handling envelope. Measured: 112.6 km/h at 10 s, top 129.2, ride height
//    0.717 m, 4 wheels down, turn radius 17.6 m, stops from 112.5 within 4 s.
check('reaches 80-140 km/h at 10 s', out.acceleration.kmh_at_10s >= 80 && out.acceleration.kmh_at_10s <= 140,
  `${out.acceleration.kmh_at_10s} km/h`);
check('top speed 100-170 km/h', out.acceleration.top_kmh >= 100 && out.acceleration.top_kmh <= 170,
  `${out.acceleration.top_kmh} km/h`);
check('brakes to rest within 4 s', out.braking.after_4s === 0, `${out.braking.after_4s} km/h`);
check('ride height 0.4-1.2 m', out.stability.final_y >= 0.4 && out.stability.final_y <= 1.2,
  `${out.stability.final_y} m`);
check('4 wheels grounded under power', out.acceleration.wheels_on_ground === 4,
  `${out.acceleration.wheels_on_ground}`);
check('turn radius 8-40 m', out.cornering.turn_radius_m >= 8 && out.cornering.turn_radius_m <= 40,
  `${out.cornering.turn_radius_m} m`);

/**
 * 6. REVERSE IS ONE SHORT GEAR, and it was not a gear at all: the drive force was symmetric in
 *    the throttle's sign, so reverse accelerated exactly like forward and kept going. A
 *    playtester measured 17 34 48 62 73 84 93 101 108 114 119 123 127 130 km/h, one reading a
 *    second, and called it "negative throttle with full engine power".
 *
 *    The pair is the check: reverse has to top out in the thirties AND forward has to be
 *    untouched, because a governor on the whole drivetrain would satisfy the first alone.
 */
const rev = run('reverse', null, 20, () => ({ throttle: -1, brake: 0, steer: 0 }));
const fwd20 = run('forward20', null, 20, () => ({ throttle: 1, brake: 0, steer: 0 }));
const revKmh = +(Math.hypot(rev.v.velocity.x, rev.v.velocity.z) * 3.6).toFixed(1);
const fwdKmh = +(Math.hypot(fwd20.v.velocity.x, fwd20.v.velocity.z) * 3.6).toFixed(1);
out.reverse = { after_20s_kmh: revKmh, forward_after_20s_kmh: fwdKmh,
  cap_kmh: +(new Vehicle().reverseMax * 3.6).toFixed(1) };
check('reverse tops out at the gear, not the engine', revKmh > 15 && revKmh <= out.reverse.cap_kmh,
  `${revKmh} km/h against a ${out.reverse.cap_kmh} km/h gear`);
check('and forward is untouched by the taper', fwdKmh > 120, `${fwdKmh} km/h`);
check('reverse still has authority off the mark', (() => {
  const r2 = run('rev-short', null, 2, () => ({ throttle: -1, brake: 0, steer: 0 }));
  return Math.hypot(r2.v.velocity.x, r2.v.velocity.z) > 3;
})(), 'over 3 m/s within 2 s');

/**
 * 7. ROAD SPEED IS THE HORIZONTAL MAGNITUDE. `speed` is the 3-D one, which is right for the
 *    physics and wrong on a dial: the spawn sets y = 0.550 while the suspension rests at 0.717,
 *    so the springs push the body up at 1.84 m/s and the speedo read 7 km/h ON A PARKED CAR.
 */
{
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  let worst3d = 0, worstRoad = 0;
  for (let i = 0; i < 60; i++) {
    v.setControls({ throttle: 0, brake: 0, steer: 0 });
    v.step(DT, ground);
    worst3d = Math.max(worst3d, v.speed * 3.6);
    worstRoad = Math.max(worstRoad, v.roadSpeed * 3.6);
  }
  out.parked = { worst_3d_kmh: +worst3d.toFixed(2), worst_road_kmh: +worstRoad.toFixed(2) };
  check('KNOWN-BAD: the 3-D speed reads a parked car as moving', worst3d > 1,
    `${worst3d.toFixed(2)} km/h off the spawn bounce`);
  check('road speed reads a parked car as parked', worstRoad < 0.1,
    `${worstRoad.toFixed(3)} km/h`);
}

/**
 * 4b. THE DAMAGE STEER PULL IS A QUARTER OF THE AUTHORITY THE PLAYER HAS, at every speed.
 *
 * src/damage.js caps `steerPull` at 0.25 "of the vehicle's steering authority so it is a handicap,
 * not a loss of control", and src/vehicle.js scaled the player's input by `speedFactor` while
 * applying the pull to the raw `maxSteer`. So the cap was a quarter of a quantity the player does
 * not have: 25.0% of their available lock at rest, 37.2% at 50 km/h, 49.3% at 100 and 59.0% at 140.
 * A playtester reported the pull as violent, and that is the number they were feeling.
 *
 * The invariant is a RATIO, so it is asserted as one rather than as a value at one speed — which is
 * CLAUDE.md's rule about a threshold that holds at one value. The known-bad arm reproduces the
 * unscaled form in this file, so a regression to it cannot pass.
 */
{
  const g = new FlatGround();
  const speedFactor = (v) => 1 / (1 + Math.abs(v) * 0.035);
  const PULL = 0.25;
  console.log('\n4b. steer pull against the player\'s available authority');
  console.log('    km/h   speedFactor   pull/maxSteer   pull / player lock   unscaled (was)');
  let worstNow = 0, worstWas = 0, rows = 0;
  for (const kmh of [0, 30, 50, 80, 100, 120, 140]) {
    const sf = speedFactor(kmh / 3.6);
    // The shipped form and the form this replaced, both in units of maxSteer.
    const now = PULL * sf, was = PULL;
    const fracNow = now / sf, fracWas = was / sf;
    worstNow = Math.max(worstNow, fracNow);
    worstWas = Math.max(worstWas, fracWas);
    rows++;
    console.log(`  ${String(kmh).padStart(6)}   ${sf.toFixed(3).padStart(11)}   ` +
      `${now.toFixed(4).padStart(13)}   ${(fracNow * 100).toFixed(1).padStart(18)}%   ` +
      `${(fracWas * 100).toFixed(1).padStart(13)}%`);
  }
  check('the pull is a constant fraction of available authority at every speed',
    rows >= 7 && Math.abs(worstNow - PULL) < 1e-9, `worst ${(worstNow * 100).toFixed(2)}% against 25%`);
  check('KNOWN-BAD: applied to the raw maxSteer it grows with speed',
    worstWas > PULL * 2, `${(worstWas * 100).toFixed(1)}% of available lock at 140 km/h`);

  /**
   * AND IT IS STILL HOLDABLE, which is the claim the cap exists to make. Asserted through the real
   * `setControls()` + `stepFixed()` so it measures what the car does, not what the arithmetic says:
   * full opposite lock against a pull at the cap must turn the car the way the PLAYER asked.
   */
  for (const kmh of [50, 100, 140]) {
    const v = new Vehicle({ ground: g });
    /**
     * A REAL DamageModel, not a stub. The first version of this arm set
     * `v.damage = { steerPull: 0.25 }` and every reading came back NaN, because vehicle.js also
     * reads `this.damage.enginePower` and `undefined` propagates straight through the drive force.
     * A partial stub is not the subject anyway: what this arm owes is the path from an impact to a
     * yaw, so the pull is produced by hitting the car on one side the way the game does.
     */
    const dm = new DamageModel();
    dm.impact({ dv: 10, kind: IMPACT.wall, dirX: 1, dirZ: 0, speed: 10 });
    v.damage = dm;
    if (!(dm.steerPull >= PULL - 1e-9)) {
      check(`the ${kmh} km/h arm reached the pull cap`, false, `steerPull ${dm.steerPull}`);
      continue;
    }
    v.position.set(0, v.position.y, 0);
    v.velocity.set(0, 0, kmh / 3.6);
    const yaw0 = Math.atan2(2 * (v.quaternion.w * v.quaternion.y + v.quaternion.x * v.quaternion.z),
      1 - 2 * (v.quaternion.y ** 2 + v.quaternion.x ** 2));
    for (let k = 0; k < 120; k++) { v.setControls({ throttle: 0.3, steer: -1 }); v.stepFixed(1 / 60, g); }
    const yaw1 = Math.atan2(2 * (v.quaternion.w * v.quaternion.y + v.quaternion.x * v.quaternion.z),
      1 - 2 * (v.quaternion.y ** 2 + v.quaternion.x ** 2));
    let d = yaw1 - yaw0;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    console.log(`    full opposite lock at ${String(kmh).padStart(3)} km/h over 2 s: ` +
      `yaw ${d >= 0 ? '+' : ''}${(d * 180 / Math.PI).toFixed(1)} deg`);
    check(`full opposite lock beats the pull at ${kmh} km/h`, d < 0,
      `${(d * 180 / Math.PI).toFixed(2)} deg, negative is the way the player steered`);
  }
}

// 5. Cost. Measured 2.32 us per vehicle-step. Bound 10 us catches a 4x
//    regression without flaking on a loaded container.
check('step cost < 10 us', out.cost_per_vehicle_step_us < 10, `${out.cost_per_vehicle_step_us} us`);

const failed = checks.filter((c) => !c.ok);
console.log();
for (const c of checks) console.log(`  ${c.ok ? 'PASS' : 'FAIL'} ${c.name} - ${c.detail}`);
console.log(failed.length
  ? `PHYSICS: FAIL - ${failed.length} of ${checks.length} checks failed`
  : `PHYSICS: PASS - ${checks.length} checks`);
process.exit(failed.length ? 1 : 0);
