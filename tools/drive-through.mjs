// Scripted drive-through of the baked district. Drives the fixed route at speed
// across many chunk boundaries and records per-frame proxy metrics.
//
// This container renders through SwiftShader, so frame RATE is meaningless here
// and is deliberately not reported. What IS meaningful: draw calls, geometry
// counts, chunk load/unload rates, the worst synchronous chunk-build stall, and
// JS heap growth — none of which depend on GPU speed.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';
import { BUDGET, gate, printGate } from './budget.mjs';

const WITH_TRAFFIC = process.argv.includes('--traffic');
const CIRCUITS = 3;
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

// DRIVE_PORT exists for the same reason HERO_PORT and SMOKE_PORT do: this gate
// is run from worktrees, and 8123 normally belongs to the MAIN tree. Reusing it
// would gate the wrong commit's triangle count while looking entirely healthy.
// tools/serve.mjs now refuses the reuse outright, so without this the gate simply
// cannot run from a worktree.
const DRIVE_PORT = Number(process.env.DRIVE_PORT ?? 8123);
await ensureServer(DRIVE_PORT);
const browser = await chromium.launch(launchOptions(['--js-flags=--expose-gc']));
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });

// DRIVE_QUERY passes a query string to the page, so a gate arm whose difference
// is a build-time option is one build on one port rather than two commits. The
// baseline for a change measured this way is the SAME tree with the option off,
// which is the only baseline that isolates it: the commit underneath this one
// moved every shopfront onto a different elevation, and a cross-commit
// before/after would have charged that to the furniture.
const DRIVE_QUERY = process.env.DRIVE_QUERY ? `?${process.env.DRIVE_QUERY}` : '';
await page.goto(`http://127.0.0.1:${DRIVE_PORT}/district/${DRIVE_QUERY}`, { waitUntil: 'networkidle' });
// The district has to render five frames before anything can be measured, and
// headless SwiftShader does that in well under 1 fps. 60 s is enough on an idle
// box and is NOT enough with other agents' headless browsers alive on the same
// machine - both of these timed out at 60 s in this session while a capture was
// running. A boot timeout is not a failing gate; raise it rather than reading it
// as one. Same knob as LOT_BOOT in tools/lot-shots.mjs.
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.DRIVE_BOOT ?? 60000) });

if (WITH_TRAFFIC) await page.evaluate(() => __district.setTraffic(true));

// Isolation switch for the chunk-stall metric. The ledger has carried a claim
// since the M2 gate that the HUD adds ~4 ms to the streaming slice through the
// GC it provokes (measured then as 8.1 ms with it off against 12.2 ms with it
// on), and nothing in tools/ could reproduce that: no harness has ever called
// setHudEnabled. DRIVE_HUD=off makes the claim testable instead of quotable.
//
// It disables the canvas HUD only. The plain-text debug readout in main.js is a
// separate per-frame string build and stays on, so a null result here does not
// clear the whole HUD - it clears the canvas half of it.
// Isolation for the chunk-stall metric after the ground-contact work.
//
// That change did three things at once - 4,596 prop buckets became casters, the
// shadow map went 2048 -> 3072, and its extent went +/-260 -> +/-120 - and the
// stall metric then failed three times in seven runs where the eight runs before
// it never passed 12.2 ms. The hypothesis is that SwiftShader rasterises the
// shadow map on the CPU that also runs the streaming slice this metric measures.
// A hypothesis does not get to dismiss a red gate, so this makes it testable:
//
//   DRIVE_SHADOW=off        shadow pass disabled entirely - the decisive control
//   DRIVE_SHADOW=2048       map back to 2048, casters and extent unchanged
//   DRIVE_SHADOW=nocasters  props stop casting, map and extent unchanged
//
// Each variant reports what it actually changed, because a switch that silently
// does nothing has already cost this project a day.
const SHADOW_MODE = process.env.DRIVE_SHADOW;
if (SHADOW_MODE) {
  const applied = await page.evaluate((mode) => {
    const r = __district.renderer;
    let sun = null;
    __district.scene.traverse((o) => { if (o.isDirectionalLight && o.shadow) sun = o; });
    if (mode === 'off') {
      r.shadowMap.enabled = false;
      __district.scene.traverse((o) => { if (o.isMesh) o.castShadow = false; });
      return { mode, shadowMapEnabled: r.shadowMap.enabled };
    }
    if (mode === '2048') {
      // The map is a render target built on first use; it must be dropped for a
      // new size to take, or three keeps rendering into the old 3072 one.
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.needsUpdate = true;
      return { mode, mapSize: sun.shadow.mapSize.width };
    }
    if (mode === 'nocasters') {
      let off = 0;
      __district.scene.traverse((o) => {
        if (o.isMesh && o.castShadow && /props|furniture/.test((o.name || '') + '|' + (o.parent?.name || ''))) {
          o.castShadow = false; off++;
        }
      });
      return { mode, castersDisabled: off };
    }
    throw new Error(`unknown DRIVE_SHADOW: ${mode}`);
  }, SHADOW_MODE);
  console.log('shadow isolation:', JSON.stringify(applied));
  // Prove the variant reached the renderer rather than trusting the assignment.
  const seen = await page.evaluate(() => {
    let sun = null, casters = 0;
    __district.scene.traverse((o) => {
      if (o.isDirectionalLight && o.shadow) sun = o;
      if (o.isMesh && o.castShadow) casters++;
    });
    return { shadowMapEnabled: __district.renderer.shadowMap.enabled,
      mapSize: sun ? sun.shadow.mapSize.width : null, casterMeshes: casters };
  });
  console.log('shadow state now:', JSON.stringify(seen));
}

if (process.env.DRIVE_HUD === 'off') {
  await page.evaluate(() => __district.setHudEnabled(false));
  console.log('canvas HUD DISABLED for this run');
}

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
// 180 s, not Playwright's default 30. A SwiftShader frame takes seconds on an
// idle box and tens of seconds with other headless browsers alive; this gate
// completed all three circuits and then threw on the screenshot, throwing away
// the measurement it had just spent five minutes taking. tools/hero-shots.mjs
// and tools/lot-shots.mjs already use 180 s for the same reason.
await page.screenshot({ path: `${OUT}/district-drive${WITH_TRAFFIC ? '-traffic' : ''}.png`,
  timeout: 180000 });

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
