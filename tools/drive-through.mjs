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
    let lap = 0, stuckFor = 0, holdFor = 0;
    const state = { i: 0 };
    __district.placeAt(pts[0][0], pts[0][1],
      Math.atan2(pts[3][0] - pts[0][0], pts[3][1] - pts[0][1]));
    window.__routeState = () => ({ wp: state.i, lap });
    /**
     * THE GAME MUST NOT BE ABLE TO TAKE THE CAR AWAY, AND IF IT DOES THE DRIVE STOPS.
     *
     * The first road-course baseline ran its whole 25-minute net and counted no lap, with 19.9 km
     * driven on a 3.26 km course. The track says why. At 41 s the car hit something at 76 km/h and
     * stopped dead, and at 53.7 s it was at the district's spawn — 434 m from where it had been, in
     * one sample. Replayed with an event log on every sim step, the first 120 s held THREE WRECKS
     * AND ONE BUST, each followed by the game's own `respawnCar()`: `followPath` has no
     * car-following term, the fleet is in its lane, and with the walls solid every contact charges
     * damage and files a crime. (The replay's track is not the baseline's, because the fleet and
     * the crowd run for a wall-clock-dependent number of frames before the drive starts; the
     * mechanism is the same.) The autopilot's progress index never knew the car had moved, so it
     * went on aiming at a point on the far side of the city: pure pursuit to an aim 800 m away asks
     * for a radius of d/(2 sin a), which is the better part of a kilometre, so the car drove circles
     * that size at the path's own speed limit. Twice the stuck-nudge happened to teleport it back
     * onto the course. The third time, at 276 s, it circled out of the district at a constant
     * 62.9 km/h, the stuck-nudge never fired because there was nothing out there to be stuck on, and
     * the median triangle count of the "baseline" was 156,445 — the empty ground outside the map.
     * Its triangle and draw-call rows both read PASS.
     *
     * Three parts, and only the first is about driving:
     *
     *   CAR-FOLLOWING, because a driver does not rear-end the car in front at 79 km/h. A fleet car
     *   is a leader when it is on the course ahead (see followCap); the speed cap is the leader's
     *   own speed along the course plus what a comfortable 5 m/s2 can shed over the gap, and under
     *   1 m/s the car HOLDS on the brake. A hold is not being stuck, so neither stuck detector
     *   counts it.
     *
     *   A SAFETY NET THAT IS COUNTED, not hidden. Any heat is cleared and any damage repaired, every
     *   step, so a contact the following misses cannot end in a bust or a wreck. This gate measures
     *   what the FRAME costs along the course; police units and a respawn are a different course.
     *   Every firing is in `drive_ledger`, so a run that leaned on the net says so.
     *
     *   AND A STOP. If the game moves the car anyway — a respawn or a bust the net did not prevent —
     *   or the car is ever 40 m off its own course, the drive ENDS and says why. That would have
     *   ended the first baseline at 53.7 s of sim instead of 1,204.
     */
    const FOLLOW_AHEAD_M = 40;   // braking from 22 m/s at 5 m/s2 takes 48 m; the cap grades in before that
    const FOLLOW_HALF_W = 2.2;   // a fleet car's centre this near our line: 0.95 + 0.95 + 0.3 of margin
    const FOLLOW_LEN_M = 4.5;    // centre to centre less half of each: our 2.15 + the longest shell's 2.34
    const FOLLOW_GAP_M = 3.0;    // the bumper-to-bumper gap the cap stops at
    const FOLLOW_DECEL = 5.0;    // m/s2; the car brakes at 11 (src/roadpath.js's measured figure)
    const HOLD_V = 1.0;          // a cap under this is a hold on the brake, not a crawl
    const LOST_M = 40;           // off the course by this much is not "wide on a corner"
    const L = window.__driveLedger = { holds: 0, holdS: 0, longestHoldS: 0, impatient: 0, wantedClears: 0,
      maxHeat: 0, maxStars: 0, repairs: 0, minHealth: 1, worstOffLine: 0, end: null,
      respawns0: __district.wreckReport().respawns, busts0: __district.bustReport().busts,
      wrecks0: __district.wreckReport().wrecks, damage0: __district.damageReport() };
    /**
     * A leader is a fleet car within FOLLOW_HALF_W of the COURSE AHEAD, not of a straight line off
     * the bonnet. Through a junction the bonnet's line sweeps across the street being turned into,
     * where cars wait at the mouth of the junction for it to clear — and holding for a car that is
     * holding for you never ends. The course knows which lane the car is about to be in.
     */
    /**
     * AND A LEADER IS GOING OUR WAY. The first verification lap held for its whole 300 s, 26 m in,
     * behind fleet car 8 on Main Street: stopped at the mouth of junction 493 with its heading
     * exactly opposite the course's (-0.738 against 2.404 rad), 6.0 m ahead, because the course
     * turns across its lane there. It had stopped for US — src/traffic.js makes the player a leader
     * to any car whose lane the player's body is in, and a turning car's body spans the lane — and
     * we held for it. A driver turning across a car that has stopped to let them through goes.
     *
     * And past the fleet's own gridlock limit a hold is a deadlock, not a queue: src/traffic.js
     * recovers a car stationary for `stuckLimitS`, so a leader held behind longer than that is
     * ignored for as long again, and every time it happens is counted (`impatient`).
     */
    const PATIENCE_S = __district.trafficReport()?.stuckLimitS ?? 20;
    const ignoreUntil = new Map();
    let simT = 0;
    const followCap = (x, z) => {
      const near = [];
      for (const p of __district.trafficPositions()) {
        if ((ignoreUntil.get(p.id) ?? -1) > simT) continue;
        if (Math.hypot(p.x - x, p.z - z) < FOLLOW_AHEAD_M + FOLLOW_HALF_W) near.push(p);
      }
      if (!near.length) return { cap: Infinity, id: null };
      const best = new Array(near.length).fill(Infinity);
      const dirOf = new Array(near.length).fill(0);
      // Arc length is measured from the car's own projection, not from the segment's start, which
      // can be a whole 4 m segment behind it — in the direction that reads a leader as further off.
      const a0 = pts[state.i], b0 = pts[Math.min(state.i + 1, pts.length - 1)];
      const ex0 = b0[0] - a0[0], ez0 = b0[1] - a0[1], L0 = Math.hypot(ex0, ez0);
      const t0 = L0 > 0 ? Math.max(0, Math.min(1, ((x - a0[0]) * ex0 + (z - a0[1]) * ez0) / (L0 * L0))) : 0;
      let arc = -t0 * L0;
      for (let k = state.i; k < pts.length - 1 && arc < FOLLOW_AHEAD_M; k++) {
        const ax = pts[k][0], az = pts[k][1], ex = pts[k + 1][0] - ax, ez = pts[k + 1][1] - az;
        const L = Math.hypot(ex, ez);
        if (!(L > 0)) continue;
        for (let n = 0; n < near.length; n++) {
          const p = near[n];
          const t = Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / (L * L)));
          const d = Math.hypot(p.x - (ax + ex * t), p.z - (az + ez * t));
          if (d < FOLLOW_HALF_W && arc + t * L < best[n]) { best[n] = arc + t * L; dirOf[n] = Math.atan2(ex, ez); }
        }
        arc += L;
      }
      let cap = Infinity, id = null;
      for (let n = 0; n < near.length; n++) {
        // Not on the course ahead, or level with the car or behind it: not a leader.
        if (!(Number.isFinite(best[n]) && best[n] > 0)) continue;
        const p = near[n];
        // `heading`, not `yaw`: the drawn yaw carries a shunt's spin, and a velocity needs the
        // direction of travel — src/traffic.js says so where it publishes both. Measured against
        // the COURSE's direction where the car sits, which is the lane it is in.
        const cosH = Math.cos((p.heading ?? p.yaw ?? dirOf[n]) - dirOf[n]);
        if (!(cosH > 0)) continue;                     // oncoming, or crossing square: not a leader
        const vAlong = (p.v ?? 0) * cosH;
        const room = Math.max(0, best[n] - FOLLOW_LEN_M - FOLLOW_GAP_M);
        const c = vAlong + Math.sqrt(2 * FOLLOW_DECEL * room);
        if (c < cap) { cap = c; id = p.id; }
      }
      return { cap, id };
    };
    let holdId = null;
    __district.setAutopilot((dt) => {
      if (window.__jitterTick) window.__jitterTick();
      if (L.end) { v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false }); return; }
      const w = __district.wanted;
      if (w.heat > 0 || w.stars > 0) {
        L.maxHeat = Math.max(L.maxHeat, w.heat); L.maxStars = Math.max(L.maxStars, w.stars);
        L.wantedClears++; __district.clearWanted('budget drive');
      }
      const health = __district.damage.health;
      if (health < 1) { L.minHealth = Math.min(L.minHealth, health); L.repairs++; __district.repairCar(); }
      if (__district.wreckReport().respawns !== L.respawns0) { L.end = 'the game respawned the car'; return; }
      if (__district.bustReport().busts !== L.busts0) { L.end = 'the game busted the car'; return; }
      const q = v.quaternion;
      const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
      simT += dt;
      const lead = followCap(v.position.x, v.position.z);
      const cap = lead.cap;
      const holding = cap < HOLD_V;
      /**
       * `dt` arms followPath's own progress anchor, which now backs the car out of a blockage —
       * see STUCK_M / STUCK_S in src/roadpath.js. The teleport below stays as a safety net, and it
       * is COUNTED (`stuck_teleports` in the artifact): on the straight course it fired every 2.65 s
       * on a wrecked car and the gate printed numbers about a traversal no player could make, so a
       * road-course run that leans on it is a run to read before trusting. The follower tries to
       * recover first, so the count is only the places it could not.
       */
      // A hold passes no dt, so followPath's own progress anchor does not read waiting behind a
      // car as being wedged and start backing out of the queue.
      const f = __district.followPath(pts, { x: v.position.x, z: v.position.z, yaw, speed: v.speed },
        state, { maxSpeed: Math.min(22, cap), dt: holding ? 0 : dt });
      if (f.done) { state.i = 0; lap++; window.__lapCount = lap; return; }
      if (f.offLine > L.worstOffLine) L.worstOffLine = f.offLine;
      if (f.offLine > LOST_M) { L.end = `left the course, ${f.offLine.toFixed(1)} m off it`; return; }
      if (holding) {
        if (holdFor === 0 || lead.id !== holdId) { L.holds++; holdFor = 0; holdId = lead.id; }
        holdFor += dt; L.holdS += dt;
        if (holdFor > L.longestHoldS) L.longestHoldS = holdFor;
        if (holdFor > PATIENCE_S) { ignoreUntil.set(lead.id, simT + PATIENCE_S); L.impatient++; holdFor = 0; }
        v.setControls({ throttle: 0, brake: 1, steer: f.controls.steer, handbrake: false });
      } else {
        holdFor = 0; holdId = null;
        v.setControls(f.controls);
      }
      if (v.speed < 0.6 && !f.backing && !holding) { stuckFor += dt; if (stuckFor > 2.5) { __district.placeAt(f.aim[0], f.aim[1]); stuckFor = 0; window.__teleports = (window.__teleports ?? 0) + 1; } }
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
let laps = 0, stopped = null;
while (laps < LAPS_WANTED && !stopped && Date.now() - t0 < CAP_MS) {
  await page.waitForTimeout(4000);
  ({ laps, stopped } = await page.evaluate(() => ({ laps: window.__lapCount ?? 0,
    stopped: window.__driveLedger ? window.__driveLedger.end : null })));
}
const ended = stopped ?? (laps >= LAPS_WANTED ? 'course driven' : 'wall-clock net');
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
/**
 * What the drive did to the world, and what the world did to the drive. Read once at the end:
 * the net's counters are cumulative, and the game's own are read as deltas from the drive's start
 * so an earlier page event cannot be charged to it.
 */
const ledger = await page.evaluate(() => {
  const L = window.__driveLedger;
  if (!L) return null;
  const d = __district.damageReport(), wr = __district.wreckReport(), br = __district.bustReport();
  const r3 = (n) => +n.toFixed(3);
  return { follow_holds: L.holds, follow_hold_s: r3(L.holdS), longest_hold_s: r3(L.longestHoldS),
    impatient: L.impatient,
    wanted_clears: L.wantedClears, max_heat: r3(L.maxHeat), max_stars: L.maxStars,
    repairs: L.repairs, min_health: r3(L.minHealth), worst_off_line_m: r3(L.worstOffLine),
    wrecks: wr.wrecks - L.wrecks0, respawns: wr.respawns - L.respawns0, busts: br.busts - L.busts0,
    crimes_filed: d.crimesReported - L.damage0.crimesReported,
    knockdowns: d.crowd ? d.crowd.knockdowns - (L.damage0.crowd?.knockdowns ?? 0) : null,
    shunted_cars: d.fleet ? d.fleet.shuntCars - (L.damage0.fleet?.shuntCars ?? 0) : null,
    car_hit_frames: d.dynamic.carHitFrames - L.damage0.dynamic.carHitFrames,
    ped_hit_frames: d.dynamic.pedHitFrames - L.damage0.dynamic.pedHitFrames,
    end: L.end };
});
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
  // The road course's car-following, its safety net and its stop: see the autopilot. Null on the
  // straight course, which has none of the three.
  drive_ledger: ledger,
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
/**
 * A DRIVE THAT DID NOT DRIVE ITS COURSE CANNOT PASS. Every row above is a percentile over the
 * samples the drive produced, so a run stopped by the net, a respawn or a lost course prints a
 * complete-looking table about part of a traversal — or, as the first road-course baseline did, a
 * p50 of 156,445 over the empty ground outside the map. The straight course is exempt because it
 * was always a fixed-wall-time sample and its artifacts say so.
 */
if (ROAD_COURSE && ended !== 'course driven') {
  g.status = 'FAIL';
  g.traversal = `the drive did not complete its course: ${ended}`;
}
result.budget_gate = g;

const file = `docs/drive${WITH_TRAFFIC ? '-traffic' : ''}.json`;
fs.writeFileSync(file, JSON.stringify({ result, samples }, null, 1));
console.log(JSON.stringify(result, null, 2));
printGate(g);
if (g.traversal) console.log(`  FAIL ${g.traversal}`);
if (ledger) {
  console.log(`drive: ${ledger.follow_holds} holds behind the fleet (${ledger.follow_hold_s} s, longest ` +
    `${ledger.longest_hold_s} s, ${ledger.impatient} past the fleet's gridlock limit), ` +
    `${ledger.crimes_filed} crimes, ${ledger.knockdowns} knockdowns, ` +
    `${ledger.shunted_cars} cars shunted; the net cleared heat ${ledger.wanted_clears}x (max ` +
    `${ledger.max_heat}) and repaired ${ledger.repairs}x (min health ${ledger.min_health}); ` +
    `${ledger.respawns} respawns, ${ledger.busts} busts, worst ${ledger.worst_off_line_m} m off the course`);
}
if (result.jitter) {
  const j = result.jitter;
  console.log(`jitter: a fixed ${j.base.toFixed(1)} ms workload sampled ${j.n} times — p50 ` +
    `${j.p50.toFixed(1)}, p99 ${j.p99.toFixed(1)}, max ${j.max.toFixed(1)} ms; the worst stretch is ` +
    `${j.excess.max.toFixed(1)} ms of preemption, beside a worst slice of ${result.worst_chunk_build_ms} ms; ` +
    `${j.over.x2} samples past x2, ${j.over.x5} past x5`);
}
await browser.close();
process.exit(g.status === 'FAIL' ? 1 : 0);
