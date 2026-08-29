// Golden-trace regression gate for vehicle handling. Runs a fixed input script
// through the deterministic fixed-step path and compares against a committed
// trace, so any change to handling has to be deliberate.
//
//   node tools/golden-trace.mjs           check against the committed trace
//   node tools/golden-trace.mjs --update  re-record it
import fs from 'node:fs';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';

const TRACE_FILE = 'data/golden-trace.json';
const TOL = { pos: 0.25, speed: 0.5 };   // metres, km/h

const SCRIPT = [
  { until: 3,  c: { throttle: 1, brake: 0, steer: 0 } },
  { until: 6,  c: { throttle: 1, brake: 0, steer: 0.6 } },
  { until: 8,  c: { throttle: 0, brake: 1, steer: 0 } },
  { until: 12, c: { throttle: 1, brake: 0, steer: -0.8 } },
  { until: 15, c: { throttle: 0.4, brake: 0, steer: 0.3, handbrake: true } },
];

function run() {
  const v = new Vehicle();
  v.position.set(0, 0.55, 0);
  const ground = new FlatGround(0);
  const dt = 1 / 60, total = 15;
  const out = [];
  for (let i = 0; i < Math.round(total / dt); i++) {
    const t = i * dt;
    const step = SCRIPT.find((s) => t < s.until) ?? SCRIPT[SCRIPT.length - 1];
    v.setControls(step.c);
    v.stepFixed(dt, ground, 120);
    if (i % 30 === 0) {
      out.push({ t: +t.toFixed(2), x: +v.position.x.toFixed(3), z: +v.position.z.toFixed(3),
        kmh: +(v.speed * 3.6).toFixed(2) });
    }
  }
  return out;
}

const trace = run();
if (process.argv.includes('--update')) {
  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(TRACE_FILE, JSON.stringify(trace, null, 1));
  console.log(`GOLDEN TRACE recorded: ${trace.length} samples -> ${TRACE_FILE}`);
  process.exit(0);
}
if (!fs.existsSync(TRACE_FILE)) {
  console.error(`No golden trace at ${TRACE_FILE}. Run with --update to record one.`);
  process.exit(2);
}
const golden = JSON.parse(fs.readFileSync(TRACE_FILE, 'utf8'));
const diffs = [];
for (let i = 0; i < Math.min(golden.length, trace.length); i++) {
  const g = golden[i], c = trace[i];
  const dp = Math.hypot(c.x - g.x, c.z - g.z), dv = Math.abs(c.kmh - g.kmh);
  if (dp > TOL.pos || dv > TOL.speed) diffs.push({ t: g.t, dPos: +dp.toFixed(3), dKmh: +dv.toFixed(2) });
}
if (diffs.length) {
  console.error(`GOLDEN TRACE: FAIL — ${diffs.length}/${golden.length} samples drifted`);
  console.error(JSON.stringify(diffs.slice(0, 6), null, 1));
  process.exit(1);
}
console.log(`GOLDEN TRACE: PASS — ${golden.length} samples within ±${TOL.pos} m / ±${TOL.speed} km/h`);
