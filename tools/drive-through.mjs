// Scripted drive-through of the baked district. Drives the fixed route at speed
// across many chunk boundaries and records per-frame proxy metrics.
//
// This container renders through SwiftShader, so frame RATE is meaningless here
// and is deliberately not reported. What IS meaningful: draw calls, geometry
// counts, chunk load/unload rates, the worst synchronous chunk-build stall, and
// JS heap growth — none of which depend on GPU speed.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { BUDGET, gate, printGate } from './budget.mjs';

const WITH_TRAFFIC = process.argv.includes('--traffic');
const CIRCUITS = 3;
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
         '--no-sandbox', '--js-flags=--expose-gc'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });

await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

if (WITH_TRAFFIC) await page.evaluate(() => __district.setTraffic(true));

// Install the autopilot: steer toward the next waypoint, advance on arrival.
// Because the sim is fixed-step, this behaves the same however slowly the
// software renderer produces frames.
await page.evaluate((circuits) => {
  const route = __district.district.meta.route;
  const v = __district.vehicle;
  __district.placeAt(route[1].x, route[1].z);
  let wp = 2, lap = 0, stuckFor = 0;
  window.__routeState = () => ({ wp, lap });
  __district.setAutopilot((dt) => {
    const target = route[wp];
    const dx = target.x - v.position.x, dz = target.z - v.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 26) {
      wp++;
      if (wp >= route.length) { wp = 1; lap++; }
      return;
    }
    // Heading error in the car's own frame.
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    let err = Math.atan2(dx, dz) - yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, err * 1.6));   // +err yaws toward the target
    // Ease off through the tight corners so the route is actually followed.
    const throttle = Math.abs(err) > 0.9 ? 0.32 : Math.abs(err) > 0.45 ? 0.55 : 1;
    v.setControls({ throttle, brake: 0, steer, handbrake: false });
    // Nudge free if wedged against a kerb, so one snag cannot end the run.
    if (v.speed < 0.6) { stuckFor += dt; if (stuckFor > 2.5) { __district.placeAt(target.x, target.z); stuckFor = 0; } }
    else stuckFor = 0;
    window.__lapCount = lap;
  });
  window.__lapCount = 0;
  __district.setTimeScale(22);
}, CIRCUITS);

// Warm up so first-load chunk building is not counted as steady-state churn.
await page.waitForTimeout(6000);
const heapBefore = await page.evaluate(() =>
  performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

await page.evaluate(() => __district.startRecording());

// Run until three circuits complete, or the wall-clock cap is hit.
const CAP_MS = 300000;
const t0 = Date.now();
let laps = 0;
while (laps < CIRCUITS && Date.now() - t0 < CAP_MS) {
  await page.waitForTimeout(4000);
  laps = await page.evaluate(() => window.__lapCount ?? 0);
}
const samples = await page.evaluate(() => __district.stopRecording());
const heapAfter = await page.evaluate(() => {
  if (globalThis.gc) globalThis.gc();
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
});

const world = await page.evaluate(() => __district.worldReport());
const trafficReport = await page.evaluate(() => __district.trafficReport());
await page.screenshot({ path: `${OUT}/district-drive${WITH_TRAFFIC ? '-traffic' : ''}.png` });

// ---- aggregate
const num = (k) => samples.map((s) => s[k]).filter((v) => v !== null && v !== undefined);
const stat = (k) => {
  const a = num(k);
  if (!a.length) return null;
  const sorted = [...a].sort((x, y) => x - y);
  return {
    min: sorted[0], p50: sorted[Math.floor(sorted.length * 0.5)],
    p95: sorted[Math.floor(sorted.length * 0.95)], max: sorted[sorted.length - 1],
  };
};
const durationS = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;  // SIMULATED seconds
const loadsTotal = samples.length ? samples[samples.length - 1].loads - samples[0].loads : 0;
const unloadsTotal = samples.length ? samples[samples.length - 1].unloads - samples[0].unloads : 0;

const result = {
  mode: WITH_TRAFFIC ? 'with 30 stub vehicles' : 'no traffic',
  laps_completed: laps,
  route_length_m: 2654,
  frames_sampled: samples.length,
  route_duration_s: +durationS.toFixed(1),
  distance_driven_m: Math.round(samples.reduce((a, s, i) =>
    i ? a + Math.hypot(s.x - samples[i - 1].x, s.z - samples[i - 1].z) : 0, 0)),
  draw_calls: stat('calls'),
  triangles: stat('tris'),
  chunks_loaded: stat('chunks'),
  lod_near: stat('near'),
  lod_far: stat('far'),
  chunk_loads_total: loadsTotal,
  chunk_unloads_total: unloadsTotal,
  chunk_loads_per_s: +(loadsTotal / Math.max(1, durationS)).toFixed(2),
  chunk_unloads_per_s: +(unloadsTotal / Math.max(1, durationS)).toFixed(2),
  lod_swaps_total: world.lodSwaps,
  // Chunk building is resumable, so the number the stall gate cares about is the
  // worst UNINTERRUPTED main-thread slice, not the summed cost of a chunk spread
  // across frames. Both are reported so the change is auditable.
  worst_chunk_build_ms: +world.worstSliceMs.toFixed(2),
  worst_chunk_total_ms: +world.worstBuildMs.toFixed(2),
  heap_mb_before: heapBefore, heap_mb_after: heapAfter,
  heap_growth_mb: heapBefore !== null ? heapAfter - heapBefore : null,
  speed_kmh: stat('kmh'),
  traffic: trafficReport,
  errors,
};

const g = gate([
  { name: 'draw calls', value: result.draw_calls.p95, spec: BUDGET.drawCalls },
  { name: 'triangles', value: result.triangles.p95, spec: BUDGET.triangles },
  { name: 'chunk stall ms', value: result.worst_chunk_build_ms, spec: BUDGET.chunkStallMs },
  { name: 'heap growth MB', value: result.heap_growth_mb ?? 0, spec: BUDGET.heapGrowthMb },
]);
result.budget_gate = g;

const file = `docs/drive${WITH_TRAFFIC ? '-traffic' : ''}.json`;
fs.writeFileSync(file, JSON.stringify({ result, samples }, null, 1));
console.log(JSON.stringify(result, null, 2));
printGate(g);
await browser.close();
process.exit(g.status === 'FAIL' ? 1 : 0);
