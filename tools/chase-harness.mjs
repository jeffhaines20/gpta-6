// Risk 5 chase harness. Spawns the worst case — maximum civilian traffic plus an
// active police pursuit while the player drives the route at speed, forcing
// continuous streaming churn on the real road graph — and asserts the result
// against the budget gate.
//
// FEASIBILITY.md Risk 5 predicted this combination is where projects like this
// stall, and that it is always discovered late. This runs it from week one.
//
// Software rendering here: frame rate is never reported. Rates use simulated time.
import { chromium } from 'playwright';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';
import { BUDGET, gate, printGate } from './budget.mjs';

const TRAFFIC = Number(process.env.CHASE_TRAFFIC ?? 60);
const PURSUIT = Number(process.env.CHASE_PURSUIT ?? 10);
const LAPS = Number(process.env.CHASE_LAPS ?? 2);
const TOD = process.env.CHASE_TOD ?? 'dusk';

fs.mkdirSync('docs/shots', { recursive: true });
await ensureServer();
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

await page.evaluate(({ traffic, pursuit, tod }) => {
  __district.setTimeOfDay(tod);
  __district.setTraffic(traffic);
  __district.setPursuit(pursuit);
  const route = __district.district.meta.route;
  const v = __district.vehicle;
  __district.placeAt(route[1].x, route[1].z);
  let wp = 2, lap = 0, stuck = 0;
  __district.setAutopilot((dt) => {
    const t = route[wp];
    const dx = t.x - v.position.x, dz = t.z - v.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 26) { wp++; if (wp >= route.length) { wp = 1; lap++; } window.__lapCount = lap; return; }
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    let err = Math.atan2(dx, dz) - yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, err * 1.6));
    const throttle = Math.abs(err) > 0.9 ? 0.32 : Math.abs(err) > 0.45 ? 0.55 : 1;
    v.setControls({ throttle, brake: 0, steer, handbrake: false });
    if (v.speed < 0.6) { stuck += dt; if (stuck > 2.5) { __district.placeAt(t.x, t.z); stuck = 0; } } else stuck = 0;
  });
  __district.setTimeScale(22);
  window.__lapCount = 0;
}, { traffic: TRAFFIC, pursuit: PURSUIT, tod: TOD });

await page.waitForTimeout(8000);
const heapBefore = await page.evaluate(() =>
  performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);
await page.evaluate(() => __district.startRecording());

const CAP = 300000, t0 = Date.now();
let laps = 0;
while (laps < LAPS && Date.now() - t0 < CAP) {
  await page.waitForTimeout(4000);
  laps = await page.evaluate(() => window.__lapCount ?? 0);
}
const samples = await page.evaluate(() => __district.stopRecording());
const heapAfter = await page.evaluate(() => {
  if (globalThis.gc) globalThis.gc();
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
});
const world = await page.evaluate(() => __district.worldReport());
const trafficR = await page.evaluate(() => __district.trafficReport());
const pursuitR = await page.evaluate(() => __district.pursuitReport());
await page.screenshot({ path: 'docs/shots/chase-harness.png', timeout: 120000 });

const stat = (k) => {
  const a = samples.map((s) => s[k]).filter((v) => v != null).sort((x, y) => x - y);
  return a.length ? { min: a[0], p50: a[(a.length * 0.5) | 0], p95: a[(a.length * 0.95) | 0], max: a[a.length - 1] } : null;
};
const dur = samples.length ? samples[samples.length - 1].t - samples[0].t : 0;
const loads = samples.length ? samples[samples.length - 1].loads - samples[0].loads : 0;

const result = {
  scenario: `WORST CASE: ${TRAFFIC} civilian + ${PURSUIT} pursuit, ${TOD}, route at speed`,
  laps, simulated_duration_s: +dur.toFixed(1),
  distance_m: Math.round(samples.reduce((a, s, i) => i ? a + Math.hypot(s.x - samples[i - 1].x, s.z - samples[i - 1].z) : 0, 0)),
  draw_calls: stat('calls'), triangles: stat('tris'), chunks: stat('chunks'),
  chunk_loads_total: loads, chunk_loads_per_s: +(loads / Math.max(1, dur)).toFixed(2),
  lod_swaps: world.lodSwaps, // Chunk building is resumable, so the number the stall gate cares about is the
  // worst UNINTERRUPTED main-thread slice, not the summed cost of a chunk spread
  // across frames. Both are reported so the change is auditable.
  worst_chunk_build_ms: +world.worstSliceMs.toFixed(2),
  worst_chunk_total_ms: +world.worstBuildMs.toFixed(2),
  heap_mb_before: heapBefore, heap_mb_after: heapAfter,
  heap_growth_mb: heapBefore != null ? heapAfter - heapBefore : null,
  speed_kmh: stat('kmh'),
  traffic: trafficR, pursuit: pursuitR,
  errors: errors.filter((e) => !/404/.test(e)),
};
const g = gate([
  { name: 'draw calls', value: result.draw_calls.p95, spec: BUDGET.drawCalls },
  { name: 'triangles', value: result.triangles.p95, spec: BUDGET.triangles },
  { name: 'chunk stall ms', value: result.worst_chunk_build_ms, spec: BUDGET.chunkStallMs },
  { name: 'heap growth MB', value: result.heap_growth_mb ?? 0, spec: BUDGET.heapGrowthMb },
]);
result.budget_gate = g;
fs.writeFileSync('docs/chase-harness.json', JSON.stringify({ result, samples }, null, 1));
console.log(JSON.stringify(result, null, 2));
printGate(g);
await browser.close();
process.exit(g.status === 'FAIL' ? 1 : 0);
