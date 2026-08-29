// Deterministic fixed-step vehicle test. No renderer, no browser: steps the
// exact same Vehicle class at a fixed 60 Hz so the numbers are independent of
// frame rate. This is the harness that keeps vehicle handling honest in Phase 2.
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';

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
console.log('FIXED-STEP:', JSON.stringify([15, 30, 60, 144].map(viaAccumulator)));
