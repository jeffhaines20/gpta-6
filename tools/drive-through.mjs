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
import { summarize as summarizeJitter } from './jitter-stats.mjs';

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
/**
 * A 404 REACHES THE CONSOLE WITHOUT ITS URL, so `!/favicon/.test(m.text())` never matched what it
 * was written to drop: the console line reads "Failed to load resource: the server responded with
 * a status of 404 (Not Found)" and nothing else. Every run of this gate therefore carried ONE
 * error it could not name — five of five in the 2026-10-14 stall set. tools/boot-check.mjs found
 * and fixed the same thing on its own first run; this is that fix, in the sibling that kept the
 * old filter. The console line for a failed load is dropped and the RESPONSE hook, which has the
 * URL, records anything at 400 or above except the favicon.
 */
page.on('console', (m) => {
  if (m.type() !== 'error' || /failed to load resource/i.test(m.text())) return;
  errors.push(m.text());
});
page.on('response', (r) => {
  if (r.status() < 400 || /favicon/i.test(r.url())) return;
  errors.push(`HTTP ${r.status()} ${r.url().replace(/^https?:\/\/[^/]+/, '')}`);
});

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

/**
 * THE COURSE IS THE ROAD GRAPH, WITH BODY COLLISION ON — since 2026-10-17 (#64).
 *
 * The first autopilot steered in a straight line at route waypoints 75 to 512 m apart, and
 * measured against the wall index 829 m of that 2,528 m course is inside a building — 32.8% of
 * it, with individual legs at 59%, 50% and 47%. That cost nothing until body collision existed;
 * with walls solid the car was wrecked 10.6 s in at 89 km/h and teleported round the rest of the
 * route by the stuck-nudge, so every baseline from then on was taken with collision OFF, about a
 * traversal no player could make. src/roadpath.js is the course a player can drive: the same
 * route's waypoints joined on the road graph, 0 of 851 points blocked even for the full car body,
 * followed by the router's own controller. It was not the default only because changing what a
 * gate measures needs a fresh baseline, and the baseline was waiting on the triangle threshold's
 * derivation; #64 settled that (the capability bound, see tools/budget.mjs), so both moved
 * together.
 *
 * DRIVE_COURSE=straight keeps the old course, collision off, so an artifact from before can still
 * be re-measured like for like. Every artifact records which course it drove and whether the walls
 * were solid, because a number about a different traversal is a different number.
 */
const COURSE = process.env.DRIVE_COURSE === 'straight' ? 'straight' : 'roads';
const ROAD_COURSE = COURSE === 'roads';
const collisionWas = await page.evaluate((on) =>
  (__district.setBodyCollision ? __district.setBodyCollision(on) : null), ROAD_COURSE);
if (ROAD_COURSE) {
  console.log('course: the ROAD GRAPH (src/roadpath.js), body collision ON. DRIVE_COURSE=straight');
  console.log('  drives the pre-2026-10-17 straight-line course instead, collision off.');
} else {
  console.log(`course: STRAIGHT LINES between route waypoints, body collision OFF (was ${collisionWas === null ? 'unavailable' : 'on'})`);
  console.log('  32.8% of this course is inside buildings; it is kept to re-measure old artifacts.');
}

// Install the autopilot: steer toward the next waypoint, advance on arrival.
// Because the sim is fixed-step, this behaves the same however slowly the
// software renderer produces frames.
await page.evaluate(({ circuits, roadCourse }) => {
  const route = __district.district.meta.route;
  const v = __district.vehicle;
  if (roadCourse) {
    // The road course, followed by src/roadpath.js's own controller. Same lap counting, so
    // the CIRCUITS loop below is unchanged.
    const tour = __district.tourRoute();
    const pts = tour.points;
    window.__courseLength = tour.length;
    let lap = 0, stuckFor = 0;
    const state = { i: 0 };
    __district.placeAt(pts[0][0], pts[0][1],
      Math.atan2(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]));
    window.__routeState = () => ({ wp: state.i, lap });
    __district.setAutopilot((dt) => {
      if (window.__jitterTick) window.__jitterTick();
      const q = v.quaternion;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
      /**
       * `dt` arms followPath's own progress anchor, which now backs the car out of a blockage —
       * see STUCK_M / STUCK_S in src/roadpath.js. The teleport below stays as a safety net, and it
       * is COUNTED (`stuck_teleports` in the artifact): on the straight course it fired every 2.65 s
       * on a wrecked car and the gate printed numbers about a traversal no player could make, so a
       * road-course run that leans on it is a run to read before trusting. The follower tries to
       * recover first, so the count is only the places it could not.
       */
      const f = __district.followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: v.speed },
        state, { maxSpeed: 22, dt });
      if (f.done) { state.i = 0; lap++; window.__lapCount = lap; return; }
      v.setControls(f.controls);
      if (v.speed < 0.6 && !f.backing) { stuckFor += dt; if (stuckFor > 2.5) { __district.placeAt(f.aim[0], f.aim[1]); stuckFor = 0; window.__teleports = (window.__teleports ?? 0) + 1; } }
      else stuckFor = 0;
      window.__lapCount = lap;
    });
    window.__lapCount = 0;
    __district.setTimeScale(22);
    return;
  }
  __district.placeAt(route[1].x, route[1].z);
  window.__courseLength = 2654;          // the straight course's nominal length, as every old artifact records it
  let wp = 2, lap = 0, stuckFor = 0;
  window.__routeState = () => ({ wp, lap });
  __district.setAutopilot((dt) => {
    if (window.__jitterTick) window.__jitterTick();
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
    if (v.speed < 0.6) { stuckFor += dt; if (stuckFor > 2.5) { __district.placeAt(target.x, target.z); stuckFor = 0; window.__teleports = (window.__teleports ?? 0) + 1; } }
    else stuckFor = 0;
    window.__lapCount = lap;
  });
  window.__lapCount = 0;
  __district.setTimeScale(22);
}, { circuits: CIRCUITS, roadCourse: ROAD_COURSE });

// Warm up so first-load chunk building is not counted as steady-state churn.
await page.waitForTimeout(6000);
const heapBefore = await page.evaluate(() =>
  performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null);

/**
 * DRIVE_JITTER=1: A FIXED PIECE OF MAIN-THREAD WORK, TIMED DURING THIS VERY DRIVE. Off by default,
 * so the gate's own workload is unchanged unless asked. BACKLOG #42 found the worst slice carrying
 * about twice the build's warm cost and could not say whose time the excess is — the scheduler's,
 * the collector's, or colder code. A loop that is fixed, warm and allocates nothing can only be
 * stretched by the scheduler, so its excess over its own minimum is preemption, in the same page on
 * the same drive as the stall it is compared with. See tools/jitter-stats.mjs. It adds ~1 ms of
 * main-thread work every 25 ms, which is why it is a flag and not the default.
 */
const JITTER = process.env.DRIVE_JITTER === '1';
if (JITTER) {
  const cal = await page.evaluate(() => {
    const spin = (n) => {
      let x = 1;
      for (let i = 0; i < n; i++) x = (Math.imul(x, 1664525) + 1013904223) | 0;
      return x;
    };
    let n = 20000, dt = 0;
    for (let k = 0; k < 24; k++) {
      let best = Infinity;
      for (let r = 0; r < 5; r++) { const t0 = performance.now(); spin(n); best = Math.min(best, performance.now() - t0); }
      dt = best;
      if (dt >= 1.0) break;
      n = Math.ceil(n * Math.max(1.2, Math.min(4, 1.05 / Math.max(dt, 0.05))));
    }
    /**
     * SAMPLED INSIDE THE SIM LOOP, NOT ON A TIMER. The first version used setInterval and read a
     * median of 18.5 ms for a 0.9 ms loop — 11,050 of 11,560 samples past x5 — while the streaming
     * slices it was meant to explain topped out at 7-17 ms. Both were true: a timer fires BETWEEN
     * frames, while SwiftShader's raster threads are busy with the frame just submitted, and the
     * slices run INSIDE the frame's sim loop, which is a different phase with different
     * contention. A probe that samples another phase measures another quantity. The autopilot is
     * called once per sim step, in the same loop as `world.update()`, so a sample taken there is
     * taken where the slices are; one in every 22 calls is one per rendered frame at the gate's
     * timeScale, ~1 ms of added work a frame.
     */
    const ms = [];
    let sink = 0, calls = 0;
    window.__jitterTick = () => {
      if ((calls++ % 22) !== 0) return;
      const t0 = performance.now();
      sink ^= spin(n);
      ms.push(performance.now() - t0);
    };
    // `sink` goes back out so the loop cannot be eliminated as dead code.
    window.__jitterStop = () => { window.__jitterTick = null; return { n, calMs: dt, ms, sink }; };
    return { n, calMs: dt };
  });
  console.log(`jitter probe ON: ${cal.n} iterations, ${cal.calMs.toFixed(2)} ms best of 5 when calibrated, ` +
    'sampled once per rendered frame inside the sim loop, where the streaming slices run');
}
await page.evaluate(() => __district.startRecording());

/**
 * Run until the course is driven, or the wall-clock net is hit — and RECORD WHICH ENDED IT.
 *
 * The straight course never finished its three circuits either: its committed baselines read
 * `laps_completed: 1`, 3,112 m of a 2,654 m route at a p50 of 122 km/h, so the 300 s cap was the
 * stop every time and the gate was a fixed-wall-time sample of the route's first lap. The road
 * course drives the way a player can, p50 39 km/h, and its first run covered 1,075 m of 3,264 in
 * the same 300 s: a third of the route, which is not the route. So the road course runs ONE full
 * lap, with a net set where a slow box rather than a hung one ends — about 300 s of sim at 0.33 s
 * of sim per wall second is 15 minutes — and `ended` says whether the lap or the net stopped it.
 * A gate whose run ends on the net has measured part of its course, and says so.
 */
const LAPS_WANTED = ROAD_COURSE ? 1 : CIRCUITS;
const CAP_MS = ROAD_COURSE ? 1500000 : 300000;
const t0 = Date.now();
let laps = 0;
while (laps < LAPS_WANTED && Date.now() - t0 < CAP_MS) {
  await page.waitForTimeout(4000);
  laps = await page.evaluate(() => window.__lapCount ?? 0);
}
const ended = laps >= LAPS_WANTED ? 'course driven' : 'wall-clock net';
console.log(`ended on: ${ended} (${laps} of ${LAPS_WANTED} laps, ${((Date.now() - t0) / 1000).toFixed(0)} s of wall clock)`);
const samples = await page.evaluate(() => __district.stopRecording());
const jitterRaw = JITTER ? await page.evaluate(() => window.__jitterStop()) : null;
const heapAfter = await page.evaluate(() => {
  if (globalThis.gc) globalThis.gc();
  return performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null;
});

const world = await page.evaluate(() => __district.worldReport());
const courseLength = await page.evaluate(() => window.__courseLength ?? null);
const teleports = await page.evaluate(() => window.__teleports ?? 0);
const trafficReport = await page.evaluate(() => __district.trafficReport());
// The screenshot is an artifact, not a measurement, and it must not be able to
// destroy one. Two rounds hit this independently and each fixed one half of it;
// this is both halves.
//
// The timeout: Playwright's default is 30 s, and a SwiftShader frame takes
// seconds on an idle box and tens of seconds with other headless browsers alive.
// tools/hero-shots.mjs and tools/lot-shots.mjs already use 180 s for the same
// reason, so this does too.
//
// The catch: because the screenshot stood between the last page.evaluate() and
// the writeFileSync below, a timeout THREW AWAY A COMPLETED SEVEN-MINUTE RUN --
// no JSON written, no gate printed, non-zero exit. That is worse than it sounds.
// A caller that copies docs/drive-traffic.json after the run then picks up the
// PREVIOUS run's file and cannot tell. It was found because two "sequential
// runs" of a metric whose noise band is 8.2-15.1 ms both reported 8.6 ms, 22 ms
// and 793,020 triangles to the digit. Two identical readings of this metric are
// not a result, they are a copy.
//
// So it is bounded AND non-fatal, and its failure is recorded in `errors` where
// a reader can see it rather than having to infer it from a missing file.
try {
  await page.screenshot({ path: `${OUT}/district-drive${WITH_TRAFFIC ? '-traffic' : ''}.png`,
    timeout: 180000 });
} catch (e) {
  errors.push(`SCREENSHOT FAILED (measurement kept): ${e.message.split('\n')[0]}`);
}

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
  course: COURSE,
  body_collision: ROAD_COURSE,
  laps_completed: laps,
  laps_wanted: LAPS_WANTED,
  ended,
  route_length_m: courseLength === null ? null : Math.round(courseLength),
  // Every stuck-nudge teleport: on the straight course a wrecked car was teleported round the
  // route once every 2.65 s, so a drive with many of these is not the drive it claims to be.
  stuck_teleports: teleports,
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
  // Present only under DRIVE_JITTER=1; see the probe above.
  jitter: jitterRaw ? { iterations: jitterRaw.n, calibrated_ms: +jitterRaw.calMs.toFixed(3),
    ...summarizeJitter(jitterRaw.ms) } : undefined,
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
if (result.jitter) {
  const j = result.jitter;
  console.log(`jitter: a fixed ${j.base.toFixed(1)} ms workload sampled ${j.n} times — p50 ` +
    `${j.p50.toFixed(1)}, p99 ${j.p99.toFixed(1)}, max ${j.max.toFixed(1)} ms; the worst stretch is ` +
    `${j.excess.max.toFixed(1)} ms of preemption, beside a worst slice of ${result.worst_chunk_build_ms} ms; ` +
    `${j.over.x2} samples past x2, ${j.over.x5} past x5`);
}
await browser.close();
process.exit(g.status === 'FAIL' ? 1 : 0);
