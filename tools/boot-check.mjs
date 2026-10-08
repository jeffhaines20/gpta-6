// Does the page boot? Nothing else in tools/ asks.
//
//   node tools/boot-check.mjs
//   BOOT_TIMEOUT=600 node tools/boot-check.mjs        # a loaded box
//
// WHY THIS EXISTS, AND IT IS THE CHEAPEST GATE IN THE PROJECT BY WHAT IT CATCHES. Commit fab3e2d
// added one line to district/main.js:
//
//     if (peds && furnitureProps) peds.setProps(furnitureProps);
//
// inside the top-level `await loading` block, which is evaluated before the module's later
// declarations exist. `peds` is a module-level `let`, so that read came out of the temporal dead
// zone as `ReferenceError: Cannot access 'peds' before initialization`, the init aborted,
// `window.__district` was never assigned, and the district rendered nothing at all. THREE COMMITS
// shipped on top of it. Every one of the fifteen offline gates was green the whole time, because
// not one of them loads district/main.js: they import src/ modules directly and assert numbers.
//
// The browser gates would have caught it — damage-live, ped-audit, drive-through, hero-shots —
// and they cost twelve to twenty minutes each, so a round that changes a module and runs the
// offline list is a round that does not know whether the game still starts.
//
// WHAT IT ASSERTS, and each one is a failure this project has actually had:
//
//   - not one `pageerror` or uncaught console error, from the first byte to the last frame
//   - `window.__district` exists, which is the init reaching its end
//   - `frames` ADVANCES, not merely exists: a page that assembles and then throws inside its
//     first render loop leaves the global behind with the counter stuck
//   - the renderer drew triangles, so a frame is a frame and not an empty canvas
//   - the systems the game is made of report themselves alive: crowd, fleet, mission board
//
// It is deliberately not a screenshot. What a thing looks like is tools/hero-shots.mjs at minutes
// per frame; whether it runs at all should be two minutes, and this is two minutes.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { bucketSource, trisSource } from './tri-buckets.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const PORT = Number(process.env.BOOT_PORT ?? 8123);
const TIMEOUT_S = Number(process.env.BOOT_TIMEOUT ?? 420);

let pass = 0, fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
};

console.log('BOOT CHECK');
await ensureServer(PORT, 20000, { root: ROOT });
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 640, height: 360 } });

// EVERY ERROR IS KEPT, not the first: a page that throws once per frame and a page that throws
// once at load are different faults and the count is what tells them apart.
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
// A 404 REACHES THE CONSOLE WITHOUT ITS URL, which is why the first run of this gate reported
// "the server responded with a status of 404" and could not say for what. The response hook has
// the URL, so the console line for a failed request is dropped in favour of it.
page.on('console', (m) => {
  if (m.type() !== 'error') return;
  const t = m.text();
  if (/failed to load resource/i.test(t)) return;          // covered by the response hook
  errors.push(`console: ${t.slice(0, 200)}`);
});
const IGNORE_404 = /favicon/i;
page.on('response', (r) => {
  if (r.status() < 400) return;
  const u = r.url();
  if (IGNORE_404.test(u)) return;
  errors.push(`HTTP ${r.status()} ${u.replace(/^https?:\/\/[^/]+/, '')}`);
});
page.on('requestfailed', (r) => {
  if (/favicon/i.test(r.url())) return;
  errors.push(`request failed: ${r.url().slice(-80)} (${r.failure()?.errorText ?? '?'})`);
});

const t0 = Date.now();
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'domcontentloaded' });
console.log(`  dom in ${((Date.now() - t0) / 1000).toFixed(1)} s`);

// Polled rather than waitForFunction, so a failure reports how far it got instead of a timeout.
let state = null;
const deadline = Date.now() + TIMEOUT_S * 1000;
while (Date.now() < deadline) {
  state = await page.evaluate(() => ({
    global: !!window.__district,
    frames: window.__district ? window.__district.frames : -1,
  })).catch((e) => ({ global: false, frames: -1, err: e.message }));
  if (state.frames > 2) break;
  await new Promise((r) => setTimeout(r, 4000));
}
const bootS = (Date.now() - t0) / 1000;
console.log(`  ${JSON.stringify(state)} after ${bootS.toFixed(1)} s`);

check('the page raised no error at all', errors.length === 0,
  errors.length ? `${errors.length}: ${errors.slice(0, 3).join(' | ')}` : '0');
check('window.__district exists, so init reached its end', !!state.global,
  state.err ?? `${state.global}`);
check('and frames advanced past the first', state.frames > 2, `${state.frames} frames`);

if (state.global && state.frames > 2) {
  // A FRAME IS A FRAME, not an empty canvas: a page can render happily with nothing in the
  // scene, and "it booted" would then be true and useless.
  const f0 = state.frames;
  await new Promise((r) => setTimeout(r, 6000));
  const live = await page.evaluate(() => {
    const d = __district;
    return {
      frames: d.frames,
      tris: d.stats ? d.stats.sceneTriangles : (d.post ? d.post.stats.sceneTriangles : null),
      crowd: d.pedestrianPositions ? d.pedestrianPositions().length : null,
      fleet: d.trafficPositions ? d.trafficPositions().length : null,
      board: d.missionBoard ? d.missionBoard() : null,
      wreck: d.wreckReport ? d.wreckReport() : null,
      chunks: d.world ? d.world.report().chunksLoaded : null,
      // The crowd's PACKED far tier, read off the live page. crowd-bill proves the
      // arithmetic offline; this is the only place that says the running game draws
      // it, which is the "check the path from the outside" rule.
      tiers: (() => {
        const P = d.pedestrians ? d.pedestrians() : null;
        if (!P || !P._farAt) return null;
        let alive = 0;
        for (const q of P.peds) if (q) alive++;
        return { alive, nearLive: P._nearLive ?? 0, farCount: P.torsos.count,
          headCount: P.heads.count, limbCount: P.limbs.count,
          nearCount: P.nearTorsos.count };
      })(),
    };
  });
  console.log(`  ${JSON.stringify(live)}`);
  check('frames keep coming', live.frames > f0, `${f0} -> ${live.frames}`);
  check('the scene has geometry in it', live.tris === null || live.tris > 10000,
    `${live.tris} triangles`);
  check('chunks streamed in', live.chunks === null || live.chunks > 0, `${live.chunks}`);
  check('the crowd is alive', live.crowd === null || live.crowd > 0, `${live.crowd} people`);
  if (live.tiers) {
    const t = live.tiers;
    check('the far tier draws alive minus near-held, not everybody',
      t.farCount === t.alive - t.nearLive,
      `${t.farCount} drawn = ${t.alive} alive - ${t.nearLive} near`);
    check('...and its three meshes agree with each other',
      t.headCount === t.farCount && t.limbCount === t.farCount * 8,
      `torsos ${t.farCount}, heads ${t.headCount}, limbs ${t.limbCount}`);
    check('...and the near tier draws exactly the peds holding a near slot',
      t.nearCount === t.nearLive, `${t.nearCount} against ${t.nearLive}`);
    // A packing that never packs anything would pass all three above, so say whether
    // the saving is actually being taken on this page.
    check('and the near tier is populated here, so the packing is doing something',
      t.nearLive > 0, `${t.nearLive} near, saving ${t.nearLive * 616} triangles`);
  }
  check('the fleet is alive', live.fleet === null || live.fleet > 0, `${live.fleet} cars`);
  // The jobs a player can start. A board with nothing on it is the defect the playtest round
  // found: two authored missions reachable only from the browser console.
  check('there are jobs on the board', !!live.board && live.board.available.length > 0,
    live.board ? live.board.available.join(', ') : 'no board');
  check('and none of them fired at the spawn', !!live.board && live.board.offerHere === null,
    live.board ? JSON.stringify(live.board.offerHere) : '-');
  check('the wreck ledger is clean on a fresh load',
    !!live.wreck && live.wreck.wrecks === 0 && !live.wreck.wreckedNow,
    live.wreck ? JSON.stringify(live.wreck) : '-');

/**
 * EVERY CAR IN THE SCENE IS PRICED AS A CAR.
 *
 * tools/tri-buckets.mjs buckets a mesh by walking UP to its first named ancestor, so an unnamed
 * mesh is attributed to whatever contains it. The parked pool's three shell meshes were unnamed
 * under `furniture`, and 31,500 triangles of parked car were therefore reported as `street
 * furniture + trees` by tri-breakdown and shadow-bill alike. That is not the `unnamed` row --
 * which announces itself -- it is a real bucket with a real name, and street furniture prices at
 * x1.41 (much of it distant oaks outside the sun's shadow frustum) against vehicles' x2.00. So
 * 31,500 triangles were being priced at 44,415 of the gate's units where they bill at 63,000: an
 * 18,585 error, larger than the 17,173 cross-session gate spread.
 *
 * `src/traffic.js` was given this exact fix for this exact reason and its sibling pool was left
 * armed, which is the recurring shape of defect in this repo. tri-buckets' own self-test asserts
 * the inheritance RULE and is correct; what it cannot see, having no scene, is a pool that forgets
 * to name itself. Only a gate over the live graph can, so it is here.
 *
 * THE MESH HANDLES COME FROM THE MODULES, NOT FROM A NAME OR A TRIANGLE COUNT. Searching the graph
 * for `/car/` to check that cars are named `/car/` is circular, and searching for geometries of
 * 1,050 triangles hardcodes a number that any change to the car silently breaks. Asking the pools
 * for their own meshes is neither.
 */
{
  const cars = await page.evaluate(([bSrc, tSrc]) => {
    const bucketOf = eval(`(${bSrc})`);
    const trisOf = eval(`(${tSrc})`);
    const d = window.__district;
    const pools = [];
    const park = d.furniture && d.furniture.parked;
    if (park && park.meshes) pools.push(['parked', park.meshes]);
    const tr = d.traffic && d.traffic();
    if (tr && tr.meshes) pools.push(['traffic', tr.meshes]);
    const rows = [];
    for (const [pool, meshes] of pools) {
      for (const m of meshes) {
        rows.push({ pool, name: m.name || '', bucket: bucketOf(m),
          inst: m.count ?? 0, drawn: trisOf(m.geometry, m.count ?? 0),
          inScene: (() => { let n = m; while (n.parent) n = n.parent; return !!n.isScene; })() });
      }
    }
    return { pools: pools.map(([p]) => p), rows };
  }, [bucketSource, trisSource]);

  for (const r of cars.rows) {
    console.log(`    ${r.pool.padEnd(8)} ${(r.name || '<unnamed>').padEnd(20)} ${String(r.drawn).padStart(6)} tris` +
      ` x${r.inst}  -> ${r.bucket}`);
  }
  // BOTH SIDES NON-ZERO, three ways: both pools present, every mesh attached to the scene, and
  // triangles actually drawn. Without these, "every car mesh buckets as a vehicle" passes over an
  // empty list for the most flattering possible reason.
  check('both car pools are reachable, so the next check has something to walk',
    cars.pools.length === 2, cars.pools.join(', ') || 'none');
  check('...and every one of their meshes is in the scene graph',
    cars.rows.length > 0 && cars.rows.every((r) => r.inScene), `${cars.rows.length} meshes`);
  const drawn = cars.rows.reduce((a, r) => a + r.drawn, 0);
  check('...and they are drawing triangles, so the bucket carries weight',
    drawn > 0, `${drawn} triangles over ${cars.rows.filter((r) => r.inst > 0).length} filled meshes`);
  const stray = cars.rows.filter((r) => r.bucket !== 'vehicles');
  check('every car-pool mesh is priced as a vehicle, not as whatever contains it',
    stray.length === 0,
    stray.length ? stray.map((r) => `${r.pool}/${r.name || '<unnamed>'} -> ${r.bucket}`).join('; ')
      : `${cars.rows.length} meshes, ${drawn} triangles, all in "vehicles"`);
}


/**
 * WHAT THE HUD IS ACTUALLY FED, which only this gate can see.
 *
 * `composeWanted`, `composeLaw` and the marker set are gated offline — wanted-test walks the
 * composers and hud-cue walks the canvas — and NEITHER can see the twenty lines of
 * district/main.js that join them up. That is the same blind spot this whole file exists for: the
 * wanted meter itself sat unfed for a whole round with `setWanted()` exported and nothing calling
 * it, and two playtesters reported crime showing them nothing while every offline gate was green.
 *
 * So this asserts the wiring and nothing else: a crime reported through the page's own hook has to
 * arrive in `hud().state` within a frame or two of the game's real loop.
 */
{
  const hudLive = await page.evaluate(async () => {
    const d = __district;
    const step = async (n) => {
      const from = d.frames;
      // Wait on the game's OWN counter, not on a timer: headless SwiftShader runs well under
      // 1 fps here and a fixed sleep would read the frame before the feed.
      for (let i = 0; i < 400 && d.frames < from + n; i++) {
        await new Promise((r) => setTimeout(r, 250));
      }
      return d.frames >= from + n;
    };
    /**
     * THE OBJECTIVE IS READ AS THE PAGE DRAWS IT, off the two DOM elements, not off the state.
     * `objective` can be `{ text, distance }` — the law tenant's distance lives there so that a
     * running mission's subtitle cannot delete it — and this arm read the state object and
     * stringified it to `[object Object]`. Reading the elements is also strictly better: it is
     * what a player sees, and it covers `_syncText` as well as the composer.
     */
    const snap = () => {
      const s = d.hud().state;
      const h = d.hud();
      const text = h.elObjText ? h.elObjText.textContent : '';
      const dist = h.elObjDist ? h.elObjDist.textContent : '';
      return { wanted: s.wanted, flash: s.wantedFlash, evade: +Number(s.evade).toFixed(3),
        note: s.wantedNote, objective: dist ? `${text} — ${dist}` : text,
        objDist: dist, subtitle: h.elSub ? h.elSub.textContent : s.subtitle,
        markers: (s.markers ?? []).map((m) => m.kind).sort(),
        waypoint: !!s.waypoint };
    };
    d.setMode('car');
    d.clearWanted('boot-check');
    const advanced = await step(2);
    const clean = snap();
    // A crime at the car's own position, through the page's hook. `pedestrianHit` is the one that
    // arms a scene, which is the half of this that had an 85 m deadline and no words.
    const at = { x: d.vehicle.position.x, z: d.vehicle.position.z };
    d.reportCrime('pedestrianHit', { at });
    // Four frames, not two: the first raises the level and asks the pursuit layer for a unit, and
    // the blip is read out of that unit's instance matrix, which PursuitUnits writes on its own
    // update. Waiting on the game's counter rather than a timer, so this is frames and not seconds.
    await step(4);
    const charged = snap();
    const w = d.wantedReport();
    return { advanced, clean, charged, stars: w.stars,
      scene: w.hud ? w.hud.scene !== null : null, notice: w.hud ? w.hud.notice : null,
      mode: d.mode };
  });
  console.log(`  clean:   ${JSON.stringify(hudLive.clean)}`);
  console.log(`  charged: ${JSON.stringify(hudLive.charged)}`);
  check('the page advanced frames for this arm, so it read a live feed rather than frame zero',
    hudLive.advanced, `${hudLive.advanced}`);
  // The marker set. `markers` was `missionHud ? null : offerMarkers` and this is the pipeline that
  // replaced it; with no mission running, the board's two jobs are the blips.
  check('the minimap is fed blips on the live page',
    hudLive.clean.markers.length > 0, hudLive.clean.markers.join(', ') || 'none');
  check('and a waypoint to steer by', hudLive.clean.waypoint, `${hudLive.clean.waypoint}`);
  // KNOWN-BAD: with no crime reported the wanted fields have to be quiet, or every check below
  // passes for a HUD that says the same thing whatever happens.
  check('KNOWN-BAD: a clean record feeds the meter nothing',
    hudLive.clean.wanted === 0 && hudLive.clean.note === null && hudLive.clean.evade === 0,
    JSON.stringify(hudLive.clean));
  check('a crime reported through the page raises the meter',
    hudLive.charged.wanted > 0 && hudLive.charged.wanted === hudLive.stars,
    `${hudLive.charged.wanted} against wantedReport's ${hudLive.stars}`);
  check('and gives it words, which is the whole of this finding',
    typeof hudLive.charged.note === 'string' && hudLive.charged.note.length > 0,
    `${hudLive.charged.note}`);
  /**
   * THE LAW TENANT TAKES THE BAND OFF THE OFFER, which is the priority order working in the page
   * and not only in `composeBand`'s unit test.
   *
   * It is the STOPPED line, and that is correct: the car is parked at the spawn, so `playerVel` is
   * zero and the scene is discharged on the frame it arms — a driver who is stationary at the
   * moment of impact HAS stopped at the scene. wanted-test §21 records the same trap costing it a
   * whole worthless sweep, and §23 drives the moving case at 60 Hz offline, where an approach run
   * is affordable. Both lines come from the one tenant down this one path, so what this arm owes
   * is that the path carries them.
   */
  const LAW_LINES = ['STOP AT THE SCENE', 'STOPPED AT THE SCENE'];
  check('the scene of the injury takes the objective band off the job on offer',
    LAW_LINES.some((l) => hudLive.charged.objective.startsWith(l))
    && hudLive.charged.objective !== hudLive.clean.objective,
    `${hudLive.clean.objective} -> ${hudLive.charged.objective} / ${hudLive.charged.subtitle}`);
  check('and it carries a subtitle of its own, not the offer\'s',
    typeof hudLive.charged.subtitle === 'string'
    && hudLive.charged.subtitle !== hudLive.clean.subtitle, `${hudLive.charged.subtitle}`);
  /**
   * AND THE POLICE ARE ON THE MINIMAP. `MARKER_STYLE.enemy` was defined in src/hud.js and the
   * string 'enemy' appeared nowhere else in the tree, so a five-star chase with eight units
   * spawning 150-470 m out showed nothing. This is the only place in the project that can say a
   * running unit reaches the map, because the harness has no pursuit layer at all.
   */
  check('a unit that spawned is drawn on the minimap',
    hudLive.charged.markers.includes('enemy'),
    hudLive.charged.markers.join(', ') || 'none');
  check('KNOWN-BAD: and there was no such blip before the crime',
    !hudLive.clean.markers.includes('enemy'), hudLive.clean.markers.join(', '));
  check('the module agrees a scene is live, so the band is not saying so on its own',
    hudLive.scene === true, `${hudLive.scene}`);
  // Leave the page as it was found: later arms place and respawn the car and a live wanted level
  // would follow them around.
  await page.evaluate(() => __district.clearWanted('boot-check'));
}

/**
 * THE RESPAWN LOOP BREAKER, which only this gate can see. `respawnCar` lives in district/main.js
 * and no offline gate imports that file: `tools/mutation-sweep.mjs` disabled the breaker outright
 * and all sixteen offline gates, playtest --selftest AND this gate passed, because nothing here
 * asked it anything.
 *
 * It is driveable from the page without a crash. Two respawns from one place must trip it: the
 * second candidate lands within LOOP_R of the first entry in the history, so the district's own
 * spawn is used instead and `loopsBroken` rises. That is the whole rule, and the reason it exists
 * is a site at (518,77) that wrecked a car every 9.6 s for ever.
 */
{
  const loop = await page.evaluate(async () => {
    const d = __district;
    const before = d.wreckReport();
    // Somewhere on the road network, so `nearestOn` gives a candidate at all.
    d.setMode('car');
    d.placeAt(518, 77, 0);
    const a = d.respawnCar();
    const mid = d.wreckReport();
    // Straight back to the same place: the next candidate is the one just used.
    d.placeAt(518, 77, 0);
    const b = d.respawnCar();
    const after = d.wreckReport();
    return { before, a, mid, b, after, spawn: { x: d.district.meta.spawn.x, z: d.district.meta.spawn.z } };
  });
  console.log(`  respawn from (518,77) twice: ${JSON.stringify(loop.a)} then ${JSON.stringify(loop.b)}`);
  console.log(`  loopsBroken ${loop.before.loopsBroken} -> ${loop.mid.loopsBroken} -> ${loop.after.loopsBroken}` +
    `, district spawn (${loop.spawn.x.toFixed(0)}, ${loop.spawn.z.toFixed(0)})`);
  check('a respawn puts the car somewhere', !!loop.a && Number.isFinite(loop.a.x),
    JSON.stringify(loop.a));
  check('the first respawn is not treated as a loop', loop.mid.loopsBroken === loop.before.loopsBroken,
    `${loop.before.loopsBroken} -> ${loop.mid.loopsBroken}`);
  check('but a second from the same place is, so the breaker fires',
    loop.after.loopsBroken > loop.mid.loopsBroken,
    `${loop.mid.loopsBroken} -> ${loop.after.loopsBroken}`);
  check('and the replacement goes to the district spawn instead of back into the loop',
    Math.hypot(loop.b.x - loop.spawn.x, loop.b.z - loop.spawn.z) < 1.5,
    `(${loop.b.x}, ${loop.b.z}) against the spawn (${loop.spawn.x.toFixed(1)}, ${loop.spawn.z.toFixed(1)})`);
  check('the two respawns went to different places, so the arm is not comparing one to itself',
    Math.hypot(loop.a.x - loop.b.x, loop.a.z - loop.b.z) > 1,
    `${Math.hypot(loop.a.x - loop.b.x, loop.a.z - loop.b.z).toFixed(1)} m apart`);
}
}


/**
 * A PICKUP FIRES ONLY WHEN THE PLAYER HAS STOPPED, AND THE HOST HAS TO SUPPLY THE SPEED.
 *
 * `MissionBoard.pickupAt` is gated offline in `mission-test` §13 and end to end in
 * `playtest --selftest` §5b. What neither can see is `district/main.js`'s one wire: the planar
 * speed of whatever the player is moving as, read off the car when driving and off the person on
 * foot. A host that passes nothing gets a TypeError rather than a conscription — which this
 * page's own `pageerror` check would catch, but only on a frame where the player is inside a
 * pickup, and the spawn is 30.0 m outside the nearest one. So the frame has to be made.
 *
 * THE VELOCITY IS SET DIRECTLY RATHER THAN DRIVEN, and that is a statement about what this arm
 * is for. It asks whether the HOST passes a speed at all and whether the refusal reaches the band;
 * HOW BIG the margin is belongs offline, where `mission-test` §13 tests the threshold itself and
 * `playtest --selftest` §5b refuses a real 37 km/h arrival. Driving 353 m to the pickup here would
 * be wall minutes at 0.133 s of sim per rendered frame. `vehicle.speed` is a getter over
 * `velocity`, so one assignment is the whole setup, and the physics step that runs before the offer
 * pass carries it into `pickupAt`.
 *
 * SO THE SPEED IS THE SMALLEST ONE THAT PROVES THE WIRE: x2 the board's own threshold, which is
 * also UNDER src/damage.js's 2.2 m/s free-contact threshold. The first version used x8 and was a
 * lesson rather than a measurement — 8 m/s for 40 frames is 42 m of travel, the car left the ring
 * before it stopped, and on the way it struck a pedestrian. That charged a crime, which put a
 * `status` notice over the band, AND spent `chargeVictim`'s 20 s window on an id the run-over arm
 * needs: boot-check went from 3 failures to 9, six of them in three later arms this one had
 * disturbed. CLAUDE.md records the same thing from the other direction — an arm finding "56
 * run-overs and every one a REPEAT" because an earlier arm had parked on a populated street.
 * **An arm that perturbs the page is a dirty tree for every arm after it.** At x2 the car covers
 * 0.45 m in total and touches nothing.
 *
 * AND THE BRAKE GOES THROUGH `setAutopilot`, not `setControls`. The page reads its own input every
 * frame and overwrites whatever an outside caller wrote, so 40 frames of `v.setControls({brake:1})`
 * took 8.01 m/s to 6.88 — which reads as a car that will not stop and is a harness that is not
 * driving it. The wedged arm two sections down already used the hook, with a comment, and this is
 * the file's own recurring shape: patching one arm and not its sibling.
 *
 * MOVING FIRST, because at rest in a pickup the mission fires on the very next frame and there
 * would be nothing left to refuse.
 *
 * TWO INSTRUMENT ERRORS, both from this arm's own first run, and both accused a build that works:
 *
 *   - `missionReport().mission` IS NOT "a mission is running". `MissionRunner` keeps the mission
 *     reference after it ends and moves the OUTCOME, so the arm read "marlin-street" as its
 *     before-state and its after-state and reported the drive-by as having started a mission. The
 *     signal is `missionBoard().starts`, which the host increments ONLY when a pickup fires — the
 *     quantity under test — and the stop arm checks the outcome as well, since a start the runner
 *     does not accept would leave it anything but `running`.
 *   - THE ARM RAN AFTER ANOTHER ARM HAD ENDED A MISSION, and `ended` sits above `offer` in
 *     BAND_ORDER, so the offer line could not show whatever it said. The band read "MISSION
 *     ABORTED / Marlin Street — you were arrested" — a correct band for a page carrying a 6 s
 *     end-of-mission hold, and nothing at all about the pickup. Hence the position: BEFORE the
 *     bust arm, which is the first thing in this file to start a mission. The arm leaves
 *     `marlin-street` RUNNING rather than aborting it, because district/main.js clears
 *     `missionEnd` when a pickup fires and an abort here would hand the next arm the hold this
 *     one just tripped over.
 */
{
  const pick = await page.evaluate(async () => {
    const d = __district;
    const v = d.vehicle;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const read = () => {
      const h = d.hud();
      return { obj: h.elObjText ? h.elObjText.textContent : '',
        sub: h.elSub ? h.elSub.textContent : '' };
    };
    d.setMode('car');
    d.clearWanted('boot-check');
    d.setBodyCollision(false);
    const board = d.missionBoard();
    const starts0 = board.starts;
    const refused0 = board.refusedMoving;
    const at = board.markers.find((m) => m.id === 'marlin-street');
    d.placeAt(at.x, at.z, 0);
    const from = { x: v.position.x, z: v.position.z };
    // The brake, through the hook the page does not overwrite. Held for the whole arm: the first
    // frame still reads the velocity set below, because the physics has not yet shed it.
    d.setAutopilot(() => v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false }));
    v.velocity.set(0, 0, -board.stopMs * 2);
    await frame();
    const moving = { ...read(), ...d.bandReport(), speed: v.speed,
      started: d.missionBoard().starts - starts0,
      offerLine: d.missionBoard().offerLine,
      refused: d.missionBoard().refusedMoving - refused0 };
    let frames = 0;
    for (let i = 0; i < 40 && d.missionBoard().starts === starts0; i++) {
      await frame();
      frames++;
    }
    const stopped = { ...read(), ...d.bandReport(), speed: v.speed,
      started: d.missionBoard().starts - starts0, running: d.missionReport().mission ?? null,
      outcome: d.missionReport().outcome, frames };
    d.setAutopilot(null);
    const travelled = Math.hypot(v.position.x - from.x, v.position.z - from.z);
    return { moving, stopped, stopMs: board.stopMs, at, travelled,
      // What this arm must NOT have done to the page, for the three arms below that need a
      // pristine crowd and an unspent victim window.
      stars: d.wantedReport().stars };
  });
  console.log(`  pickup at (${pick.at.x}, ${pick.at.z}), threshold ${pick.stopMs} m/s:`);
  console.log(`    at ${pick.moving.speed.toFixed(2)} m/s: screen "${pick.moving.obj}" / `
    + `"${pick.moving.sub}" (band "${pick.moving.from}"), offer tenant "`
    + `${pick.moving.offerLine ? pick.moving.offerLine.subtitle : '(none)'}", `
    + `started ${pick.moving.started}`);
  console.log(`    braked to ${pick.stopped.speed.toFixed(3)} m/s over ${pick.stopped.frames} `
    + `frames: "${pick.stopped.obj}" / "${pick.stopped.sub}", `
    + `${pick.stopped.started} start -> ${pick.stopped.running} (${pick.stopped.outcome})`);
  check('KNOWN-BAD: the car really was moving through the pickup, or this arm proves nothing',
    pick.moving.speed >= pick.stopMs, `${pick.moving.speed.toFixed(2)} m/s against ${pick.stopMs}`);
  check('driving through a pickup does not start the mission', pick.moving.started === 0,
    `${pick.moving.started} starts, ${pick.moving.refused} refused frames`);
  /**
   * TWO CHECKS AND NOT ONE, because the screen's subtitle and the offer's subtitle are different
   * quantities whenever a `status` tenant yields the objective down to the offer — src/hud.js's
   * own rule, and correct. The first version asserted the SCREEN and failed over a build that
   * works: `placeAt` re-seeds the crowd around the camera and (19, -6) is authored as a pickup
   * with "the crowd already around it", so the teleport is a contact and the band read
   * "MARLIN STREET / PEDESTRIAN STRUCK — nobody saw it" — the offer owning the objective with a
   * notice holding the subtitle, which is exactly what that rule is for. So: the tenant wins the
   * band, AND its own line carries the instruction.
   */
  check('the offer tenant wins the objective band while the pickup is refusing',
    pick.moving.from === 'offer',
    `band "${pick.moving.from}": "${pick.moving.obj}" / "${pick.moving.sub}"`);
  check('and the host composes the instruction, not just the module',
    !!pick.moving.offerLine && pick.moving.offerLine.subtitle === 'stop to start'
      && pick.moving.offerLine.ownSubtitle === true,
    `offer tenant ${JSON.stringify(pick.moving.offerLine)}`);
  check('stopping in it does start the mission', pick.stopped.started === 1
    && pick.stopped.running === 'marlin-street' && pick.stopped.outcome === 'running',
    `${pick.stopped.started} starts -> ${pick.stopped.running} (${pick.stopped.outcome}) `
    + `after ${pick.stopped.frames} frames`);
  check('and it was the brake that did it, not the frame budget', pick.stopped.frames < 40
    && pick.stopped.speed < pick.stopMs,
    `${pick.stopped.frames} frames to ${pick.stopped.speed.toFixed(3)} m/s`);
  /**
   * AND THE ARM LEAVES THE PAGE ALONE, which is a check rather than a hope: the x8 first version
   * drove 42 m through the crowd and broke six checks in three later arms. Under 2 m of travel and
   * no wanted level is the state those arms are entitled to.
   */
  check('the arm stayed inside the ring and charged nothing, so no later arm inherits it',
    pick.travelled < 2 && pick.stars === 0,
    `${pick.travelled.toFixed(2)} m travelled, ${pick.stars}*`);
}

/**
 * BEING BUSTED, WHICH ONLY THIS GATE CAN SEE END TO END. src/wanted.js owns the clock and
 * wanted-test §25 owns that; tools/playtest carries its own copy of the host wiring and §8 owns
 * that. What lives ONLY in district/main.js is this: the `busted` listener that takes the mission,
 * `bustWatch`'s fade, and the `respawnCar()` that hands the car back repaired. No offline gate
 * imports that file — `charge-window` and `loop-breaker` in mutation-sweep are the same lesson.
 *
 * THE CLOCK IS DRIVEN THROUGH THE MODULE RATHER THAN BY WAITING FOR THE FLEET. Being caught for
 * real takes about 16 s of sim from four stars, and this page renders through SwiftShader at about
 * one frame a second, so waiting for six pursuit cars to converge would be a ten-minute gate. The
 * host's own `held` geometry is checked separately below, off `notHonoured`.
 */
{
  const bust = await page.evaluate(async () => {
    const d = __district;
    const before = d.bustReport();
    const respawns0 = d.wreckReport().respawns;
    d.setMode('car');
    d.placeAt(-327.8, 63.3, 0);
    d.startMission('marlin-street');
    d.reportCrime('officerDown', { at: { x: -327.8, z: 63.3 } });
    const notHonoured = d.wantedReport().notHonoured.slice();
    const fleet = d.wantedReport().fleet;
    const holdR = fleet ? fleet.holdR : null;
    // The module's published reach, the walk wire, and the number the HOST actually uses —
    // the same `??` chain the frame loop runs, evaluated here so the two cannot disagree
    // silently. See the checks below.
    const reachR = fleet ? fleet.reachR : null;
    const footPath = fleet ? fleet.footPath : null;
    const hostReach = d.pursuitReach ? d.pursuitReach() : null;
    // Hurt the car, so "it came back repaired" has two different numbers in it.
    const hurt = d.damage.impact({ dv: 9, kind: 'wall', dirX: 0, dirZ: 1, speed: 9 });
    const healthBefore = d.damage.health;
    // The clock, driven straight at the module: BUST_HOLD_S of held-and-stopped.
    const at = { x: -327.8, z: 63.3, held: true, seen: true };
    const seen = [];
    for (let i = 0; i < 40; i++) {
      d.wanted.update(0.2, at);
      const bi = d.wanted.hudState().bustIn;
      if (bi != null) seen.push(+bi.toFixed(2));
      if (d.bustReport().busts > before.busts) break;
    }
    const fired = d.bustReport();
    const missionAfter = d.missionReport ? d.missionReport().outcome : null;
    // And the fade, which needs real frames. timeScale is the harness hook for exactly this.
    d.setTimeScale(40);
    const f0 = d.frames;
    const t1 = Date.now();
    while (d.bustReport().released === fired.released && Date.now() - t1 < 25000) {
      await new Promise((r) => requestAnimationFrame(() => r()));
    }
    d.setTimeScale(1);
    return { before, respawns0, notHonoured, holdR, reachR, footPath, hostReach,
      fleet, healthBefore, hurt: hurt.applied, seen,
      fired, after: d.bustReport(), missionAfter, health: d.damage.health,
      frames: d.frames - f0, wreck: d.wreckReport() };
  });
  console.log(`  held stopped: countdown ${bust.seen.slice(0, 3).join(' -> ')} ... ` +
    `${bust.seen.slice(-1)[0]}, busts ${bust.before.busts} -> ${bust.fired.busts}`);
  console.log(`  mission ${bust.missionAfter}, released ${bust.fired.released} -> ` +
    `${bust.after.released} after ${bust.frames} frames, health ` +
    `${bust.healthBefore.toFixed(3)} -> ${bust.health.toFixed(3)}`);
  console.log(`  notHonoured ${JSON.stringify(bust.notHonoured)}, fleet holdR ${bust.holdR}`);
  check('the page can be busted at all, which nothing in the shipped game could do',
    bust.fired.busts === bust.before.busts + 1,
    `${bust.before.busts} -> ${bust.fired.busts}`);
  check('the countdown was readable off the module while it ran',
    bust.seen.length > 3 && bust.seen[0] > bust.seen[bust.seen.length - 1],
    bust.seen.join(' '));
  check('the host takes the mission for it, which is what being busted costs',
    bust.missionAfter === 'aborted', `${bust.missionAfter}`);
  check('KNOWN-BAD: the car was damaged first, so the repair is two different numbers',
    bust.hurt === true && bust.healthBefore < 1, `${bust.healthBefore.toFixed(3)}`);
  check('and the fade ends with the car back and repaired',
    bust.after.released === bust.fired.released + 1 && bust.health === 1,
    `released ${bust.after.released}, health ${bust.health.toFixed(3)}`);
  /**
   * A DELTA, NOT A LEVEL, and the first version could not fail. It asserted `respawns > 0`, and the
   * loop-breaker arm above calls `respawnCar()` twice in the same page load — so the count was
   * already 2 before the bust and the check passed whatever the release did. A blind mutation
   * reviewer named it along with the other half: `bustStats.released++` runs BEFORE `respawnCar()`,
   * so "released rose" is not evidence the respawn ran either.
   *
   * The delta across the fade is what says this release went through the same code path as a
   * wreck's, which is the claim: one respawn, not two and not none.
   */
  console.log(`  respawns ${bust.respawns0} -> ${bust.wreck.respawns} across the fade`);
  check('the release went through the respawn, not a second code path',
    bust.wreck.respawns === bust.respawns0 + 1,
    `${bust.respawns0} -> ${bust.wreck.respawns}`);
  check('the pursuit layer reports that it can hold, so the clock can arm in play',
    !bust.notHonoured.includes('held') && bust.holdR > 0,
    `${JSON.stringify(bust.notHonoured)}, holdR ${bust.holdR}`);
  /**
   * AND THE OFF-ROAD HALF OF THAT WIRE, WHICH IS WHY THIS GATE EXISTS.
   *
   * An arrest is made by a person, so `src/pursuit.js` holds a target out to
   * `RUN_SPEED * BUST_HOLD_S` = 28 m provided an officer can WALK there — and the host re-tests
   * the held unit against the PLAYER with its own copy of that radius. Three copies of one
   * bound: the module, this file, and tools/playtest.mjs. Widening the module alone changed
   * nothing a player could feel, measured offline at 14.15 m off a road and four stars: `u.held`
   * true on 98.5% of samples, longest hold 197.0 s, busts 0 in 200 s, because 14.15 failed
   * `<= 8.75` in the host. With all three read off the module it is an arrest at 7.3 s.
   *
   * Two things are asserted and neither is reachable offline. `footPath` says `wirePursuit` ran,
   * so the walk is refusable by the real blocker index rather than allowed through walls; and
   * the host's own radius is compared against the module's `reachR`, because the `??` chain
   * `pursuit.reachRadius ?? pursuit.holdRadius ?? 0` silently falls back to the OLD bound for a
   * module that does not publish the new one — which is the quietest possible way to lose this.
   */
  console.log(`  fleet reachR ${bust.reachR}, holdR ${bust.holdR}, `
    + `footPath ${bust.footPath}, host reach ${bust.hostReach}`);
  check('the page wires the blocker predicate into the pursuit, which no offline gate can see',
    bust.footPath === true && !bust.notHonoured.includes('heldOffRoad'),
    `footPath ${bust.footPath}, notHonoured ${JSON.stringify(bust.notHonoured)}`);
  check('and the host asks the module how far an officer gets, rather than its own old bound',
    bust.reachR > bust.holdR && bust.hostReach === bust.reachR,
    `host ${bust.hostReach} against reach ${bust.reachR} and the old ${bust.holdR}`);
}

/**
 * THE END-OF-MISSION HOLD IS SPENT ONLY WHILE ITS LINE IS ON SCREEN, which is a host rule:
 * `missionEnd` and its clock live in district/main.js and nothing offline imports that file.
 *
 * `src/hud.js`'s BAND_ORDER puts `wreck` above `ended`, and the clock used to tick from the
 * moment the mission ended — so a mission lost BY being wrecked spent `WRECK_HOLD_S` of its
 * `MISSION_END_S` behind the wreck line. Measured in tools/playtest.mjs, which carries its own
 * copy of this wiring: 4.0 s of "THE CAR IS WRECKED" and then 1.9 s of "MISSION ABORTED", t=4.4
 * to 6.2, against a 6 s hold. A playtester reported that line as never read, which overstates it,
 * and the number behind it is right.
 *
 * READ OFF THE CLOCK, not counted in frames. The alternative arm wrecks the car and watches six
 * seconds of band, and at 0.05 s of sim per rendered frame on a page that draws under one a
 * second that is two wall minutes for an assertion the clock answers in ten frames.
 */
{
  const hold = await page.evaluate(async () => {
    const d = __district;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    d.setMode('car');
    d.clearWanted('boot-check');
    d.placeAt(19, -6, 0);
    d.startMission('marlin-street');
    for (let i = 0; i < 3; i++) await frame();
    const running = d.bandReport();
    // Wreck it outright, which is what a hard crash does, and which aborts the mission.
    d.damage.impact({ dv: 30, kind: 'wall', dirX: 0, dirZ: 1, speed: 30 });
    await frame();
    const atWreck = d.bandReport();
    const samples = [];
    for (let i = 0; i < 10; i++) { await frame(); samples.push(d.bandReport()); }
    return { running, atWreck, samples, missionEnd: 6 };
  });
  const wreckFrames = hold.samples.filter((q) => q.from === 'wreck');
  const spent = wreckFrames.length
    ? hold.atWreck.endFor - wreckFrames[wreckFrames.length - 1].endFor : null;
  console.log(`  mission end hold: ${hold.atWreck.endFor} s armed at the wreck, `
    + `${wreckFrames.length} of 10 frames owned by "wreck", `
    + `${spent === null ? 'n/a' : spent.toFixed(3)} s of the hold spent during them`);
  check('the wreck line owns the band after a wreck, or this arm proves nothing',
    hold.atWreck.from === 'wreck' && wreckFrames.length >= 5,
    `from "${hold.atWreck.from}", ${wreckFrames.length} wreck frames of 10`);
  check('and the end-of-mission hold does not tick while a line above it is showing',
    hold.atWreck.endFor > 0 && spent !== null && spent < 1e-6,
    `${spent === null ? 'n/a' : spent.toFixed(4)} s spent over ${wreckFrames.length} hidden `
    + `frames, from an armed ${hold.atWreck.endFor} s`);
  await page.evaluate(() => __district.clearWanted('boot-check'));
}


/**
 * THE RUN-OVER CHARGE'S WIRE, which is the one rule in this round no offline gate could reach.
 * `DamageModel.runOverCrime` is gated by damage-test; that district/main.js ASKS it, rather than
 * deciding for itself as it used to with a literal `scale: 1`, is only visible from the page —
 * `mutation-sweep`'s `runover-wire` came back MISSED before this arm existed.
 *
 * FOUR WRONG VERSIONS OF THIS ARM, each of which printed a number and measured nothing. Worth the
 * space because each one read as the WIRE being broken:
 *
 *   1. Teleported the car onto the body at rest: 1 body down, 0 run-overs. `peds.runOver` refuses
 *      below `PED_FREE_MS`, so a car PLACED on a casualty rolls over nobody.
 *   2. Crept at 1.6 m/s: reached 0.33 m of the body, still 0 run-overs, for the same reason —
 *      1.6 is under 2.2. The crawl is 4 m/s now, over the free speed and far under `pedKillSpeed`.
 *   3. Took `positions()[0]`: 56 run-overs and EVERY ONE A REPEAT — `pedRepeats` 0 -> 56 with the
 *      charge still null — because `chargeVictim`'s 20 s per-victim window had been spent on that
 *      id by an earlier arm's car parked on a populated street.
 *   4. Picked a body 60 m away and then teleported the car to it. Reached 0.1 m and STILL 0
 *      run-overs: src/pedestrians.js re-seeds distant slots around the camera, and `placeAt` moves
 *      the camera 60 m, so the casualty was recycled between the knockdown and the arrival. The
 *      preceding version of this one stopped 3.93 m short of a different body, because its
 *      approach line was whatever +z happened to be and this district has buildings in it.
 *
 * So the order is: place the car, let the crowd settle around it, knock down somebody in FRONT of
 * it, then drive. Nothing is teleported after the knockdown and the approach is the car's own
 * heading, so neither the re-seed nor the geometry can intervene.
 */
{
  const ro = await page.evaluate(async () => {
    const d = __district;
    const peds = d.pedestrians();
    if (!peds) return { skipped: 'no crowd' };
    d.clearWanted('boot-check');
    d.setMode('car');
    const v = d.vehicle;
    d.setTimeScale(8);
    // Somewhere with road ahead: the district's own spawn, which #66 moved onto a populated street.
    d.placeAt(d.district.meta.spawn.x, d.district.meta.spawn.z, 0);
    for (let i = 0; i < 3; i++) await new Promise((r) => requestAnimationFrame(() => r()));
    /**
     * THE CAR IS AIMED AT A PEDESTRIAN, rather than the arm hoping one stands in its path. The
     * version before this took whoever happened to be 5-26 m ahead within 1.2 m of the car's line,
     * and that is a coin flip: run twice on identical code it measured 2 run-overs and then 0, with
     * the subject 0.64 m off the line in the pass and 0.97 m in the failure. A gate that passes
     * sometimes is worse than no gate, and this one would have read as the WIRE being broken.
     *
     * The move is SHORT, and that is deliberate. Version 2 of this arm picked a body 60 m out and
     * teleported to it, and src/pedestrians.js recycled the casualty around the new camera position
     * before the car arrived. The subject here is the nearest standing pedestrian, so the car moves
     * tens of metres at most — and the arm asserts the body is still down when it gets there rather
     * than assuming it.
     */
    const BODY_SIDE = 1.0;                             // the run-up clearance circle
    const clearRun = (bx, bz, h) => {
      const sx = Math.sin(h), sz = Math.cos(h);
      for (let m = 2; m <= 14; m += 2) {
        if (d.blockers.resolveCircle(bx + sx * m, bz + sz * m, BODY_SIDE)) return false;
      }
      return true;
    };
    const near = peds.positions()
      .map((p) => ({ ...p, dist: Math.hypot(p.x - v.position.x, p.z - v.position.z) }))
      .filter((p) => !p.down && p.dist < 60)
      .sort((a, b) => a.dist - b.dist);
    let spot = null, approach = 0;
    for (const c of near.slice(0, 24)) {
      for (let k = 0; k < 24; k++) {
        const h = (k / 24) * Math.PI * 2;
        if (clearRun(c.x, c.z, h)) { spot = c; approach = h; break; }
      }
      if (spot) break;
    }
    if (!spot) {
      d.setTimeScale(1);
      return { skipped: 'no pedestrian within 60 m with a clear 14 m run-up',
        crowd: peds.positions().length };
    }
    // Back along the clear heading, pointing AT them, so the body is on the car's own axis.
    const ax = Math.sin(approach), az = Math.cos(approach);
    d.placeAt(spot.x + ax * 14, spot.z + az * 14, Math.atan2(-ax, -az));
    await new Promise((r) => requestAnimationFrame(() => r()));
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    /**
     * KILLED WITHOUT BEING THROWN, and the throw is what broke the previous version. `hit`'s
     * fatality is `kill ?? (v >= pedKillSpeed)`, so the obvious way to make a body STAY down is a
     * 30 m/s strike — and src/pedestrians.js then slides it `v^2 / (2 mu g)` metres along the
     * direction given, which at 30 m/s is 69 m. Aimed down the car's own heading, as this arm
     * aims it, the casualty lands 55 m BEYOND the 14 m run-up: three runs, three times zero
     * run-overs, deterministically, with the body reported down the whole time.
     *
     * `kill: true` is fatal by DECLARATION, so the speed only sets how far the body slides, and
     * the direction is ACROSS the car rather than along it so a slide cannot carry the body out of
     * the 14 m run-up.
     *
     * AND 3 m/s WAS TOO FAST, WHICH MADE THIS ARM FLAKY 1 RUN IN 3. `throwDistance` slides the
     * body `v^2 / (2 mu g)`, so 3 m/s is **0.695 m across the axis** against a measured
     * across-axis contact window of 1.30 m (`BODY_RADIUS` 0.95 + the person's 0.35, CLAUDE.md
     * #104) — the arm spent **53% of its own lateral margin before the car had moved**, leaving
     * 0.605 m for every other source of drift over a blind `steer: 0` run. Measured failure: the
     * car drove 36.1 m of a 14 m run, ended on `travelCap` with 0 run-overs and a body still
     * reported down, which then broke five more checks in this arm and the garage arm below it.
     *
     *     kill at 3.0 m/s   slides 0.6950 m   0.605 m of margin left   47% of the window
     *     kill at 1.0 m/s   slides 0.0772 m   1.223 m                  94%
     *     kill at 0.5 m/s   slides 0.0193 m   1.281 m                  99%
     *
     * 0.5 m/s keeps 99% of the window and is still a real slide rather than a zero, so the
     * direction arithmetic stays meaningful. The miss is PRINTED either way — see the loop.
     */
    peds.hit(spot.i, { speed: 0.5, dirX: fz, dirZ: -fx, kill: true, force: true });
    await new Promise((r) => requestAnimationFrame(() => r()));
    const bodyDown = peds.isDown(spot.i);
    const seen = [];
    let overs = 0, repeats = 0, closest = Infinity, top = 0, sideMiss = Infinity;
    const dyn0 = d.damageReport().dynamic;
    d.setAutopilot(() => {
      /**
       * OVER src/pedestrians.js's `PED_FREE_MS` (2.2 m/s) AND FAR UNDER `pedKillSpeed` (21.3).
       * 4 m/s is 14 km/h: a run-over charge of about 0.008, against the 1.00 the old literal
       * applied, so the two readings are two orders of magnitude apart rather than a rounding.
       */
      v.setControls({ throttle: v.speed < 4 ? 0.5 : 0, brake: 0, steer: 0, handbrake: false });
    });
    /**
     * BOUNDED BY THE DISTANCE THE CAR COVERS, NOT BY THE WALL CLOCK.
     *
     * This used to be `while (Date.now() - t1 < 25000)`. Headless capture through SwiftShader is
     * well under 1 fps and district/main.js clamps dt to 0.05, so a FRAME is 0.05 s of sim time
     * however long it takes to draw: 25 wall seconds buys whatever frame count the box felt like
     * giving, and the car has 14 m to cover at up to 4 m/s. A blind reviewer measured a slower
     * box getting 5-10 s of sim out of that window and the arm reporting the WIRE broken when
     * nothing was wrong with it. That is the worst way for a gate to fail: it names a real
     * defect that is not there.
     *
     * The run is 14 m, so the bound is 14 m plus a margin, measured on the car. The wall clock
     * stays as a backstop only -- generous, and never the thing that decides a pass -- and the
     * reason the loop stopped is REPORTED, because "no run-over" and "no run-over, and the car
     * never got there" are different findings and the old version could not tell them apart.
     */
    const RUN_M = 14, TRAVEL_CAP_M = RUN_M * 2.5;
    const start = { x: v.position.x, z: v.position.z };
    const t1 = Date.now();
    let travelled = 0, frames = 0, why = 'travel';
    while (true) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      frames++;
      travelled = Math.hypot(v.position.x - start.x, v.position.z - start.z);
      const p = peds.positions().find((x) => x.i === spot.i);
      if (p) {
        closest = Math.min(closest, Math.hypot(p.x - v.position.x, p.z - v.position.z));
        /**
         * THE PERPENDICULAR MISS, against the axis the car was PLACED on. `0 run-overs` cannot
         * tell "the car passed 1.8 m to the side" from "the car drove over it and the wire is
         * broken", and those two send a round to opposite places. `(fz, -fx)` is the right-hand
         * normal of the placement heading, so this needs no steering-sign convention.
         */
        sideMiss = Math.min(sideMiss,
          Math.abs((p.x - v.position.x) * fz - (p.z - v.position.z) * fx));
      }
      top = Math.max(top, v.speed * 3.6);
      const dyn = d.damageReport().dynamic;
      overs = dyn.pedRunOvers; repeats = dyn.pedRepeats;
      if (dyn.lastRunOver) { seen.push(dyn.lastRunOver); why = 'ranOver'; break; }
      if (travelled > TRAVEL_CAP_M) { why = 'travelCap'; break; }
      if (Date.now() - t1 > 180000) { why = 'wallClock'; break; }
    }
    d.setAutopilot(null);
    d.setTimeScale(1);
    v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    return { seen, overs, repeats, bodyDown, stars: d.wanted.stars,
      why, travelled: +travelled.toFixed(1), frames, wallS: +((Date.now() - t1) / 1000).toFixed(1),
      along: RUN_M, side: +spot.dist.toFixed(1), approach: +(approach * 180 / Math.PI).toFixed(0),
      closest: +closest.toFixed(2), topKmh: +top.toFixed(1),
      sideMiss: Number.isFinite(sideMiss) ? +sideMiss.toFixed(3) : null,
      repeats0: dyn0.pedRepeats, overs0: dyn0.pedRunOvers,
      knock: d.damageReport().dynamic.pedKnockdowns, crimes: d.damageReport().crimesReported };
  });
  if (ro.skipped) {
    console.log(`  run-over wire: SKIPPED — ${ro.skipped}`);
    check('the run-over arm could stage a body in the car’s path', false, ro.skipped);
  } else {
    const last = ro.seen[0] ?? null;
    console.log(`  run-over: a body ${ro.along} m straight ahead on a ${ro.approach} deg ` +
      `approach (${ro.side} m from the car before the move), down ${ro.bodyDown}; ` +
      `up to ${ro.topKmh} km/h`);
    console.log(`    overs ${ro.overs0} -> ${ro.overs}, repeats ${ro.repeats0} -> ${ro.repeats}, ` +
      `charge ${JSON.stringify(last)}, stars ${ro.stars}`);
    console.log(`    the drive ended on "${ro.why}" after ${ro.travelled} m of a ${ro.along} m run, ` +
      `${ro.frames} frames, ${ro.wallS} s of wall clock; closest ${ro.closest} m, ` +
      `perpendicular miss ${ro.sideMiss == null ? 'n/a' : `${ro.sideMiss} m`} against a 1.30 m ` +
      `contact window`);
    /**
     * WHY THE DRIVE ENDED, asserted separately from whether it ran anybody over. A box slow
     * enough to hit the backstop reports "the car never got there", which is a statement about
     * the box; the run-over checks below report on the WIRE. Conflating them is how this arm
     * told a reviewer the wire was broken when the box was just slow.
     */
    check('the car covered its run rather than running out of wall clock',
      ro.why !== 'wallClock', `ended on "${ro.why}" after ${ro.travelled} m in ${ro.wallS} s`);
    console.log(`    the old literal charged scale 1.00 here, which is ` +
      `${last ? (1 / last.scale).toFixed(0) : '?'}x what the speed says`);
    check('the body was still on the ground when the car got there', ro.bodyDown === true,
      `${ro.bodyDown}`);
    /**
     * THE CAR WENT OVER THE AXIS THE BODY IS ON, which is the half `0 run-overs` could not say.
     * This arm was flaky 1 run in 3 and the failure read as a broken wire: 0 run-overs, charge
     * null, and five more checks falling over in this arm and the garage arm below. The cause was
     * the arm's own knockdown sliding the body 0.695 m across a 1.30 m window — see the `hit`
     * call — and nothing printed the one number that would have said so.
     *
     * Bounded by the window itself rather than by a figure somebody picked: `BODY_RADIUS` 0.95
     * plus the person's 0.35, which is the across-axis contact bound CLAUDE.md #104 measured at
     * max 1.32 over 57 strikes. A miss outside it is a geometry failure in the arm; a miss inside
     * it with no run-over is a failure in the WIRE, and the two want opposite fixes.
     */
    check('and the car passed within the contact window of the body, or the arm missed it',
      ro.sideMiss != null && ro.sideMiss <= 1.30,
      `perpendicular miss ${ro.sideMiss} m against 1.30 m`);
    /**
     * `closest` TRACKS THE SLOT, NOT THE BODY, so it is printed and not asserted: a fatal
     * knockdown throws the body along the car's heading and src/pedestrians.js recycles the slot
     * once the casualty clears, after which that index is somebody else standing elsewhere. The
     * thing that says the car drove over a body is `pedRunOvers`, which only rises inside
     * `peds.runOver`.
     */
    check('the arm actually drove over a body, so both sides are not zero',
      ro.overs > ro.overs0, `${ro.overs0} -> ${ro.overs} run-overs`);
    check('a run-over reaches the crime path at all', !!last, JSON.stringify(ro.seen));
    check('and its scale comes from the speed, not a literal 1',
      !!last && last.scale < 0.5 && last.crime === 'pedestrianHit',
      last ? `${last.kmh} km/h -> ${last.crime} at ${last.scale}` : 'none');
    // And the window is visible either way: a knockdown charges the victim, so the roll that
    // follows it is a repeat. That is correct, and it is why the record is taken outside the gate.
    console.log(`    charged ${last ? last.charged : '?'}, repeats ${ro.repeats0} -> ${ro.repeats}` +
      ` — a body you knocked down yourself is inside its own 20 s victim window`);
    check('so a roll at walking pace is one star, not the reference case’s two',
      ro.stars === 1, `${ro.stars}*`);
  }
  await page.evaluate(() => __district.clearWanted('boot-check'));
}

/**
 * THE GARAGE'S WIRE, and the only gate that can see it. `src/damage.js`'s `Garage` is gated
 * offline by damage-test (the dwell swept at four step sizes, the 2x2x2 of refusals, the banking
 * known-bad) and its POSITION by mission-test against every mission zone in the district. What
 * neither can see is that this page calls it, with the car's own position and star count, and
 * calls `damage.repair()` when it says so — the shape CLAUDE.md records three times over as "the
 * module is right, its gate asserts the module, and nothing asserts that the game reaches it".
 *
 * READ AGAINST THE SIM CLOCK, NOT A FRAME COUNT, and that is what found the defect this arm was
 * written to look for. The garage was the THIRD hold in district/main.js to be written into the
 * HUD block instead of the sim loop: `bustWatch` and `wreckWatch` both were, and the section of
 * CLAUDE.md about them is called "Two holds were counting rendered frames instead of simulated
 * time". `tools/playtest.mjs` had it in the right place, so no offline gate disagreed with the
 * page — the harness was correct and the page was not, which is why the check has to be here and
 * has to be a RATE rather than an outcome.
 *
 * AND THE TIME SCALE IS WHY THIS COSTS A DOZEN FRAMES RATHER THAN EIGHTY. The frame loop clamps
 * dt to 0.05 s, so a 4 s hold is 80 rendered frames at 1x and this page draws under one a second.
 * At `timeScale` 8 the sim loop runs eight 0.05 s steps per rendered frame and the hold completes
 * in ten — which is only true because the dwell now lives inside that loop. So the arm MEASURES
 * the fix rather than merely benefiting from it: the same ten frames at one dwell step each would
 * have delivered 0.5 s, and the known-bad below says so in those units.
 *
 * THE APPROACH IS A ROUTE POINT, not a bearing I liked: (-81.34, 68.43) is the last point on the
 * road graph's own route from the spawn that is still outside the zone, 15.71 m out, and all 51
 * samples of the corridor from there to the garage are clear for a 1.1 m body circle. A car
 * placed INSIDE the zone never enters it, so `entries` would read 0 and the arm would be
 * measuring a state it had assumed.
 */
{
  const gar = await page.evaluate(async () => {
    const d = __district;
    const v = d.vehicle;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    /**
     * THE BAND READ OFF THE HUD'S OWN ELEMENTS, like the wanted-strip arm above. `bandReport()`
     * publishes `{from, endFor}` and nothing else, so the first version of this arm printed
     * `[garage] undefined / undefined` on every frame and its text check could not pass — three
     * FAILs that were all one wrong accessor. Reading the elements is also strictly better: it
     * is what a player sees, and it covers `_syncText` as well as the composer.
     */
    const band = () => {
      const h = d.hud();
      const text = h.elObjText ? h.elObjText.textContent : '';
      const dist = h.elObjDist ? h.elObjDist.textContent : '';
      return { from: d.bandReport().from, objective: dist ? `${text} — ${dist}` : text,
        subtitle: h.elSub ? h.elSub.textContent : '' };
    };
    const g0 = d.garageReport();
    d.setMode('car');
    d.clearWanted('boot-check');
    d.setBodyCollision(true);
    d.setTimeScale(8);
    d.placeAt(-81.34, 68.43, 2.115);
    for (let i = 0; i < 3; i++) await frame();
    /**
     * BREAKING THE CAR CHARGES A CRIME, and the garage refuses a wanted car — so the whole first
     * version of this arm was refused for being wanted and read `dwell 0` on all 30 frames with
     * `refusedWanted` climbing. The host turns damage records into crimes one block below the
     * impact (`IMPACTS BECOME CRIMES HERE`), so the level has to be let settle and then cleared,
     * and `stars` is recorded afterwards so the arm cannot silently be measuring the refusal
     * again.
     */
    d.damage.impact({ dv: 7.5, kind: 'wall', dirX: 0, dirZ: 1, speed: 7.5 });
    const broken = d.damage.health;
    for (let i = 0; i < 2; i++) await frame();
    /**
     * HEAT, NOT STARS, AND THE STAR VERSION COULD NOT PASS ON THIS ARM'S OWN ACTION.
     *
     * This read `.stars` and asserted it was above zero — "breaking the car charges a crime" —
     * and #97's ladder is what shows that is unreachable here: `dv 7.5` into a wall files
     * `propertyDamage`, which the table gives NO FLOOR, and `FLOORLESS_CAP`'s soft knee holds one
     * such offence strictly under one heat. Measured off the modules: severity 0.2729, scale
     * 2.2743, raw 0.6823, **charged 0.6336 — 0 stars.** Two hits would be 1.2402 and one star.
     *
     * So from the `clearWanted` three lines up, the star count after this impact is ALWAYS 0, and
     * the check passed on heat left behind by an earlier arm. Traced: the run-over arm above
     * charges `pedestrianHit`, which arms a scene, and this arm's own teleport then leaves it —
     * filing `hitAndRun`, whose floor IS 1. So on a run where the run-over arm hit nobody the
     * star count read 0 and this check failed, 1 run in 3, naming a wire that was never broken.
     * The arm's own comment already said it must not "silently be measuring the refusal again";
     * it was silently measuring a different arm's pedestrian.
     *
     * Heat is the quantity the wire produces, so heat is what this asserts. 0.6336 against 0 is
     * the whole claim, it comes from this arm's own impact, and it cannot be satisfied by
     * inheritance because the clear is immediately above.
     */
    const chargedFor = d.wantedReport().heat;
    d.clearWanted('boot-check');
    await frame();
    const starsBefore = d.wantedReport().stars;
    let throttle = 0.3, brake = 0;
    d.setAutopilot(() => v.setControls({ throttle, brake, steer: 0, handbrake: false }));
    // Drive forward until the report says we are inside, then stand on the brake.
    const drive = [];
    for (let i = 0; i < 24 && !d.garageReport().inside; i++) {
      await frame();
      drive.push(+(d.garageReport().distance ?? -1).toFixed(1));
    }
    const entered = { ...d.garageReport(), t: d.simTime, band: band() };
    throttle = 0; brake = 1;
    const held = [];
    for (let i = 0; i < 30 && d.garageReport().hostRepairs === 0; i++) {
      await frame();
      const r = d.garageReport(), b = band();
      held.push({ t: +d.simTime.toFixed(2), dwell: r.dwell, from: b.from,
        line: b.objective, sub: b.subtitle });
    }
    const after = { ...d.garageReport(), health: d.damage.health, t: d.simTime };
    const markers = (d.hud().state.markers ?? []).map((m) => m.kind).sort();
    /**
     * AND THE WANTED REFUSAL, from the page: the one of the three that needs the HOST to be
     * passing the live star count. A host that passed a constant 0 there would pass every check
     * in damage-test and this one alone.
     */
    d.damage.impact({ dv: 7.5, kind: 'wall', dirX: 0, dirZ: 1, speed: 7.5 });
    d.reportCrime('officerDown');
    const hotBroken = d.damage.health;
    const hotStars = d.wantedReport().stars;
    for (let i = 0; i < 16; i++) await frame();
    const hot = { ...d.garageReport(), health: d.damage.health, stars: d.wantedReport().stars,
      band: band() };
    d.setAutopilot(null);
    d.clearWanted('boot-check');
    d.setTimeScale(1);
    return { g0, broken, chargedFor, starsBefore, drive, entered, held, after, markers,
      hotBroken, hotStars, hot };
  });
  const g = gar;
  console.log(`  the garage at (${g.g0.at.x}, ${g.g0.at.z}) r${g.g0.radius}, hold ${g.g0.holdS} s,`
    + ` stop ${g.g0.stopMs} m/s`);
  console.log(`    drove in over ${g.drive.length} frames: ${g.drive.join(' -> ')} m`);
  const sims = g.held.length ? g.held[g.held.length - 1].t - g.entered.t : 0;
  const perFrame = g.held.length ? sims / g.held.length : 0;
  console.log(`    ${g.held.length} frames of brake covering ${sims.toFixed(2)} s of sim `
    + `(${perFrame.toFixed(2)} s a frame); dwell ${g.held.map((q) => q.dwell).join(' ')}`);
  console.log(`    band: ${[...new Set(g.held.map((q) => `[${q.from}] ${q.line} / ${q.sub}`))].join(' -> ')}`);
  console.log(`    health ${g.broken.toFixed(3)} -> ${g.after.health.toFixed(3)}, `
    + `entries ${g.after.entries}, module repairs ${g.after.repairs}, host ${g.after.hostRepairs}`);
  /**
   * EVERY ARM ASSERTS THAT THE THING IT MEASURES HAPPENED, because all three of the numbers
   * below are zero for a car that never moved and never entered.
   */
  check('the car drove into the garage zone rather than being placed in it',
    g.after.entries === 1 && g.drive.length > 0 && g.entered.inside === true,
    `${g.after.entries} entries over ${g.drive.length} frames of throttle`);
  check('and it was broken when it got there, or there is nothing to repair',
    g.broken < 1 && g.broken > 0.2, `health ${g.broken.toFixed(3)}`);
  console.log(`    breaking it charged ${g.chargedFor} of heat (0 stars by design — see the arm), `
    + `cleared to ${g.starsBefore}* before the drive`);
  check('breaking the car charges a crime at all, which is the host wire',
    g.chargedFor > 0, `${g.chargedFor} of heat from a cleared meter`);
  check('and it is not wanted, or this arm measures the wanted refusal instead of the repair',
    g.starsBefore === 0, `${g.starsBefore}* at the wheel`);
  check('the page repairs the car, which is the wire no offline gate can see',
    g.after.hostRepairs === 1 && g.after.health === 1,
    `${g.broken.toFixed(3)} -> ${g.after.health.toFixed(3)}, ${g.after.hostRepairs} host repairs`);
  /**
   * THE DWELL IS SIMULATED SECONDS. The hold completed inside the sim time the brake covered, to
   * within one frame's worth of sim either side — which is the property, and it is FALSE for a
   * dwell advanced once per rendered frame.
   */
  check('the repair takes the hold in SIMULATED seconds, not in rendered frames',
    sims >= g.g0.holdS - perFrame && sims <= g.g0.holdS + perFrame * 2,
    `${sims.toFixed(2)} s of sim against a ${g.g0.holdS} s hold, ${perFrame.toFixed(2)} s a frame`);
  console.log(`    a per-frame dwell would have reached ${(g.held.length * 0.05).toFixed(2)} s `
    + `of its ${g.g0.holdS} s over these ${g.held.length} frames`);
  check('KNOWN-BAD: and these frames could not have served the hold one step per frame',
    g.held.length * 0.05 < g.g0.holdS,
    `${g.held.length} frames x 0.05 s = ${(g.held.length * 0.05).toFixed(2)} s of a ${g.g0.holdS} s hold`);
  check('the band counted the hold down in seconds while it ran',
    g.held.some((q) => q.from === 'garage' && /REPAIRING — \d+ s/.test(String(q.line))),
    [...new Set(g.held.map((q) => `[${q.from}] ${q.line}`))].join(' | '));
  /**
   * AND IT IS ON THE MINIMAP. `MARKER_STYLE.shop` had sat in src/hud.js since the file was
   * written with nothing in the game ever posting one — the third style in that position after
   * `vehicle`, which left three authored stages saying "GET IN THE CAR" over a blank map. Read
   * off the HUD's own state, like the police-blip arm above, because that is the buffer the
   * minimap draws from.
   */
  console.log(`    minimap kinds while parked in it: ${g.markers.join(', ') || 'none'}`);
  check('the garage is a blip on the minimap, or a player cannot find the only repair there is',
    g.markers.includes('shop'), g.markers.join(', ') || 'none');
  // A DELTA against what the first arm left, not against an assumed 1: a level read against a
  // baseline somebody else set is the "respawns > 0 after an earlier arm made it 2" defect.
  const furtherRepairs = g.hot.hostRepairs - g.after.hostRepairs;
  const furtherRefusals = g.hot.refusedWanted - g.after.refusedWanted;
  console.log(`    KNOWN-BAD wanted: ${g.hotStars}* and health ${g.hotBroken.toFixed(3)} parked in `
    + `the garage -> ${furtherRepairs} further repairs, health ${g.hot.health.toFixed(3)}, `
    + `${furtherRefusals} refusals charged, band [${g.hot.band.from}] ${g.hot.band.objective}`
    + ` / ${g.hot.band.subtitle}`);
  check('KNOWN-BAD: the page refuses to repair a car the police are looking for',
    g.hotStars > 0 && furtherRefusals > 0 && furtherRepairs === 0 && g.hot.health < 1,
    `${g.hotStars}*, ${furtherRefusals} refusals, ${furtherRepairs} repairs, `
    + `health ${g.hot.health.toFixed(3)}`);
  check('and the page says why, rather than silently doing nothing',
    g.hot.band.from === 'garage' && /looking/.test(String(g.hot.band.subtitle)),
    `[${g.hot.band.from}] ${g.hot.band.objective} / ${g.hot.band.subtitle}`);
  await page.evaluate(() => __district.clearWanted('boot-check'));
}

// --------------------------------------------------------------- the A/B colour arms
/**
 * THE TWO HALVES OF #1 ARE SWEEPABLE OFF ONE PAGE LOAD, which is the only reason an A/B of them
 * can hold camera, geometry, streaming, traffic, crowd and the cloud deck fixed. `traffic-selftest`
 * proves the moving fleet's arm offline, bit for bit; this is the PARKED pool's arm and the host
 * wire that reaches both — neither of which any offline gate imports.
 *
 * Patching one of this pair and leaving the other is the defect shape these two modules have now
 * produced three times, so the sibling gets a check in the same round rather than the next one.
 */
{
  const arm = await page.evaluate(() => {
    const D = window.__district;
    const before = D.carPaintTint();
    const off = D.setCarPaintTint(0);
    const on = D.setCarPaintTint(1);
    const legacy = D.setCarTone(true);
    const shipped = D.setCarTone(false);
    return { before, off, on, legacy, shipped };
  });
  /**
   * `recolourParked` returns `{ legacy, cars: 0 }` with NO `span` when the pool is empty, and the
   * first version of this line guarded the null and then called `.span.toFixed(2)` on it — so an
   * empty pool would have THROWN here rather than failing the check below. CLAUDE.md: "a tool
   * that throws is not a tool that passes, and nobody notices which". Found by a blind reviewer.
   */
  const span = (x) => (x && Number.isFinite(x.span) ? `x${x.span.toFixed(2)}` : 'no span');
  const side = (name, lo, hi) => (lo && lo.cars > 0
    ? `${lo.cars} cars, legacy span ${span(lo)} -> shipped ${span(hi)}`
    : `NO ${name.toUpperCase()}`);
  console.log(`  tone arms: parked ${side('parked pool', arm.legacy.parked, arm.shipped.parked)}` +
    `; traffic ${side('fleet', arm.legacy.traffic, arm.shipped.traffic)}`);
  check('the page exposes the paint-slot tint as an arm, and it is shipped ON',
    arm.before.value === 1 && arm.off.value === 0 && arm.on.value === 1,
    `${arm.before.value} -> ${arm.off.value} -> ${arm.on.value}`);
  /**
   * BOTH POOLS, OR THE ARM MEASURES HALF THE FLEET. A `setCarTone` that silently returned null for
   * one of them would still print a legacy span and still look like a working A/B.
   */
  check('and setCarTone reaches BOTH fleets, not one of them',
    !!(arm.legacy.parked && arm.legacy.traffic && arm.legacy.parked.cars > 0
      && arm.legacy.traffic.cars > 0),
    `parked ${arm.legacy.parked?.cars ?? 'null'}, traffic ${arm.legacy.traffic?.cars ?? 'null'}`);
  check('the parked pool narrows under the legacy rule, so its arm is not a no-op',
    Number.isFinite(arm.legacy.parked?.span) && Number.isFinite(arm.shipped.parked?.span)
      && arm.legacy.parked.span < arm.shipped.parked.span / 5,
    `${span(arm.legacy.parked)} against ${span(arm.shipped.parked)}`);
  check('and so does the moving fleet, through the same one call',
    Number.isFinite(arm.legacy.traffic?.span) && Number.isFinite(arm.shipped.traffic?.span)
      && arm.legacy.traffic.span < arm.shipped.traffic.span / 5,
    `${span(arm.legacy.traffic)} against ${span(arm.shipped.traffic)}`);
  /**
   * AND THE PAGE IS LEFT AS IT WAS FOUND. An arm that leaves the district in its before-state is
   * how a later section in the same run measures the wrong build — this file's own run-over arm
   * was once poisoned by an earlier arm's parked car, and that is the same shape.
   */
  const after = await page.evaluate(() => window.__district.carPaintTint());
  check('and the page is left in the shipped state, so no later arm inherits a swept one',
    after.value === 1 && arm.shipped.parked?.span > 5 && arm.shipped.traffic?.span > 5,
    `tint ${after.value}, parked ${span(arm.shipped.parked)}, traffic ${span(arm.shipped.traffic)}`);
}

/**
 * THE WALK THE HOST REPORTS, which is the wire nothing offline can reach.
 *
 * `src/pursuit.js`'s `bestApproach` lets a unit stop at the network's closest approach however far
 * that is, and `arrestSeconds(d)` prices the officer's walk from there. The module cannot see
 * either number: it takes `player.holdSeconds` from the frame loop, and on the first wiring that
 * field was DROPPED by `_sanitize`'s whitelist, so an arrest 508 m from the nearest road still
 * took 4.0 s instead of 72.7. `wanted-test` §d3 gates the module and `pursuit-test` the function;
 * only this can see district/main.js actually computing and passing it.
 *
 * THE ARM WAITS ON THE FLEET TO ARRIVE, so it reads `bustNeeds` and the FALLBACK COUNTER rather
 * than waiting for an arrest: `bustNeeds` is latched the moment the clock arms, and a delta of 0
 * on `bustNoWalk` over the window is what says the host spoke. The counter is a delta because the
 * arm above drives `wanted.update` directly with no walk and legitimately increments it.
 *
 * `setTimeScale` BUYS THIS ONE SOMETHING, unlike the wedged-car arm: the pursuit's units move at
 * `speed * dt` inside the sim loop rather than through `stepFixed`, so the whole loop running
 * `timeScale` times moves them `timeScale` times as far. The car does not need to travel at all.
 *
 * LAST IN THE FILE, AND THAT IS NOT TIDINESS. This arm sets four stars and gets the player
 * arrested, which respawns the car and aborts whatever was running. Placed mid-file it broke five
 * checks in the run-over and garage arms below it — the second time in one session that an arm of
 * mine was a dirty tree for the arms after it. An arm that cannot avoid perturbing the page goes
 * where there is nothing left to perturb.
 *
 * AND THE SPOT IS CHOSEN BY DISTANCE FROM THE ROAD, not from the spawn. The first version walked
 * 84 m out from the spawn on sixteen bearings and took the first clear one — which was 3.0 m from
 * a road, so the ordinary 28 m reach arrested it in 4 s and the arm reported "0 units held" over
 * a build that works. `__district.roadDistance` is the router's own projection, so the gate and
 * the game agree about where the roads are.
 */
{
  const walk = await page.evaluate(async () => {
    const d = __district;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    d.setMode('car');
    d.clearWanted('boot-check');
    d.setBodyCollision(false);
    /**
     * FAR ENOUGH OFF A ROAD THAT THE WALK IS LONGER THAN THE FLOOR, or the arm cannot tell the
     * new clock from the old one: `arrestSeconds` is flat out to `reachRadius`. The spot is read
     * off the fleet's own reach rather than typed, x3, and the position is checked against the
     * road network before the arm commits to it.
     */
    const reach = d.pursuitReach();
    const want = reach * 2;
    const base = d.district.meta.spawn;
    let spot = null, bestFound = 0;
    for (let step = want; step <= want * 4 && !spot; step += reach) {
      for (let ang = 0; ang < 24 && !spot; ang++) {
        const a = ang * Math.PI / 12;
        const x = base.x + Math.cos(a) * step, z = base.z + Math.sin(a) * step;
        if (d.clearAt && !d.clearAt(x, z, 1.0)) continue;        // no room for the car
        const nr = d.nearestRoad(x, z);
        if (!nr) continue;
        bestFound = Math.max(bestFound, nr.dist);
        if (nr.dist <= want) continue;
        /**
         * AND THE OFFICER'S WALK HAS TO BE CLEAR, by the same `clearAt` the module samples it
         * with. Without this the arm picked (-364, 199) — 57.4 m from a road and with a building
         * across the line — so `_footPathClear` refused the walk intermittently, `u.held`
         * flickered, and `_watchBust` reset the clock every few frames: it latched 8.205 s
         * correctly and then advanced 0.145 s over 103 rendered frames. The arm reported "0 busts"
         * over a page that was behaving exactly as designed, because an officer may not walk
         * through a wall. Find the subject before sampling it.
         */
        const n = Math.max(1, Math.ceil(nr.dist));
        let clear = true;
        for (let k = 0; k <= n && clear; k++) {
          const f = k / n;
          if (!d.clearAt(x + (nr.x - x) * f, z + (nr.z - z) * f, 0.4)) clear = false;
        }
        if (!clear) continue;
        spot = { x, z, roadD: nr.dist };
      }
    }
    if (!spot) return { why: 'no remote spot', reach, want, bestFound, heldN: 0,
      needs: null, noWalk: 0, best: null, stars: 0, at: null, roadD: bestFound };
    d.placeAt(spot.x, spot.z, 0);
    /**
     * A CRIME AT THE SPOT, NOT `setWanted`. `setWanted` raises the level and says nothing about
     * WHERE, so `lastKnown` kept whatever an earlier arm left it — and both hosts drive
     * `pursuit.update` with `plan.target`, the last-known anchor, so the fleet converged on a
     * point 140 m from the car and `bestApproach` reported 1.224 m while the car sat 57.4 m from
     * any road. The arm read "0 units held" over a build that works. `officerDown` carries
     * `min: 4`, so this is the same four stars with the scene attached.
     */
    d.reportCrime('officerDown', { at: { x: spot.x, z: spot.z } });
    const noWalk0 = d.wantedReport().stats.bustNoWalk ?? 0;
    /**
     * A BASELINE, BECAUSE `busts` IS A LIFETIME COUNT and the bust arm earlier in this file has
     * already made one. Without it the phase-1 loop's `busts > 0` break fired on frame 0, the arm
     * never ran, and `bustNeeds` read the value THAT arm had latched — 4 s — which the gate then
     * reported as the page running the wrong clock. CLAUDE.md records the same class exactly:
     * "a level where a delta was meant: `respawns > 0` after an earlier arm in the same page load
     * had already made it 2."
     */
    const busts0 = d.bustReport().busts;
    /**
     * TWO PHASES, because one `timeScale` cannot serve both. Bringing six units in from a
     * 130-390 m spawn band needs the sim run fast; reading a clock that is 8 s long needs it run
     * slow, and at 40 one rendered frame is 2 s of sim, so an 8 s arrest is four samples and can
     * complete between two of them. The first phase waits on the FLEET, the second on the CLOCK,
     * and each reports which bound ended it.
     */
    /**
     * `timeScale` 4, NOT 40, AND THAT IS WHY THE FIRST VERSION COULD NOT EXPLAIN ITSELF. At 40 one
     * rendered frame is 2 s of sim, the whole held-and-latch sequence happens between two samples,
     * and the arm could only report the state either side of it: no holding unit at any sample, a
     * completed arrest, and a 4 s clock it could not account for. At 4 a frame is 0.2 s, the fleet
     * still closes 4.4 m per frame from a 130-390 m spawn band, and the latch is visible.
     *
     * The budget is the real bound and it is reported: 390 m at 4.4 m a frame is 89 frames.
     */
    d.setTimeScale(4);
    let why = 'fleet frames', needs = null, heldN = 0, lastIn = null;
    /**
     * WHERE THE CAR AND THE HOLDING UNIT WERE WHEN IT HAPPENED. The first version asserted the
     * clock's VALUE and failed at 4 s against an expected 8.2 — and could not say whether the host
     * was wrong or the car had moved, because it recorded neither. A check that cannot distinguish
     * its own subject moving from the code being broken is an argument, not a measurement.
     */
    let trail = null;
    for (let i = 0; i < 220 && heldN === 0; i++) {
      await frame();
      const f = d.wantedReport().fleet;
      heldN = Math.max(heldN, f ? (f.held ?? 0) : 0);
      const at = { x: d.vehicle.position.x, z: d.vehicle.position.z };
      let hd = Infinity;
      for (const u of d.pursuitPositions ? d.pursuitPositions() : []) {
        if (!u.held) continue;
        hd = Math.min(hd, Math.hypot(u.x - at.x, u.z - at.z));
      }
      const w0 = d.wantedReport();
      // THE LATCH FRAME, kept the FIRST time the clock is seen running rather than the last: the
      // value it latched is decided there and `bustNeeds` never changes again during the hold.
      if (!trail && (Number.isFinite(hd) || (w0.hud && w0.hud.bustIn != null))) {
        trail = { carRoadD: d.roadDistance(at.x, at.z),
          drift: Math.hypot(at.x - spot.x, at.z - spot.z),
          heldD: Number.isFinite(hd) ? +hd.toFixed(2) : null,
          needsThen: w0.bustNeeds, bustIn: w0.hud ? w0.hud.bustIn : null, frame: i };
      }
      if (d.bustReport().busts > busts0) { why = 'busted before the clock could be read'; break; }
    }
    if (heldN > 0) {
      /**
       * THE BUDGET IS DERIVED FROM THE CLOCK IT IS WATCHING, which the first version was not: 60
       * frames at `timeScale` 2 is 6.0 s of sim against an 8.2 s arrest, so the arm ran out of
       * frames and reported "0 busts" over a page that was 2 s from making one. A budget smaller
       * than the quantity it measures is not a safety net, it is a second bound — CLAUDE.md's
       * "two bounds that are numerically coincident" with the coincidence gone the wrong way.
       *
       * `timeScale` 4 is 0.2 s of sim a frame, the latch has already been captured by phase 1, so
       * coarser is fine here; x2.5 of the needed frames is the margin, and the arm says which
       * bound ended it either way.
       */
      d.setTimeScale(4);
      const needFrames = Math.ceil((d.wantedReport().bustNeeds ?? 4) / (4 * 0.05) * 2.5);
      why = 'clock frames';
      for (let i = 0; i < needFrames; i++) {
        await frame();
        const w = d.wantedReport();
        if (w.hud && w.hud.bustIn != null) {
          needs = Math.max(needs ?? 0, w.hud.bustIn);
          lastIn = w.hud.bustIn;      // the live countdown, for the rate printed below
        }
        if (d.bustReport().busts > busts0) { why = 'busted'; break; }
      }
    }
    d.setTimeScale(1);
    const after = d.wantedReport();
    const units = (d.wantedReport().fleet || {});
    return { why, needs, heldN, reach, want, roadD: spot.roadD, bestFound,
      // Latched when the clock armed, and it survives the bust — see `bustNeeds` in src/wanted.js.
      bustNeeds: after.bustNeeds ?? null, busts: d.bustReport().busts - busts0, trail, lastIn,
      noWalk: (after.stats.bustNoWalk ?? 0) - noWalk0,
      best: units.bestApproach ?? null, stars: after.stars,
      at: { x: spot.x, z: spot.z } };
  });
  console.log(`  parked ${walk.roadD == null ? 'n/a' : walk.roadD.toFixed(1)} m from the nearest `
    + `road (needed over ${walk.want.toFixed(1)}, the best any bearing offered was `
    + `${walk.bestFound.toFixed(1)}) at `
    + `(${walk.at ? walk.at.x.toFixed(0) : '-'}, ${walk.at ? walk.at.z.toFixed(0) : '-'}): `
    + `ended on "${walk.why}", ${walk.heldN} units held, network best approach ${walk.best}, `
    + `bustIn ${walk.needs === null ? 'n/a' : walk.needs.toFixed(2)} s, `
    + `bustNoWalk +${walk.noWalk}`);
  /**
   * THE SUBJECT FIRST, or every check below passes for the most flattering possible reason: an arm
   * that could not find a remote spot would report nothing held and read as the fleet failing.
   */
  check('the gate found somewhere further from a road than an officer can run',
    walk.roadD != null && walk.roadD > walk.want,
    `${walk.roadD == null ? 'none' : walk.roadD.toFixed(1)} m against ${walk.want.toFixed(1)}`);
  /**
   * THE ARREST ITSELF IS THE CHECK, and `bustNeeds` rather than `hudState().bustIn`. The first
   * version required a sample to catch `fleet.held > 0` and the live countdown to be non-null, and
   * both are frame-granular: at `timeScale` 40 one rendered frame is 2 s of sim, an 8 s arrest is
   * four samples, and a bust releases the units before the next report. It read "0 units held" and
   * "bustIn n/a" over a page that had just made the arrest this whole change is for. `bustNeeds`
   * is latched when the clock arms and survives the bust, so it can be read after the fact.
   *
   * AND IT IS COMPARED WITH THE ARM'S OWN ARITHMETIC, not with a literal: `arrestSeconds` of the
   * road distance the gate measured itself. Two numbers from two sources, which is the only kind
   * of agreement worth asserting — a check against 8.2 would pass for a build that had hardcoded
   * it.
   */
  /**
   * RESTATED FOR #108, AND THIS CHECK IS WHAT CAUGHT THE CHANGE. It read
   * `arrestSeconds(roadD)` — the walk from the NETWORK'S closest point — and that was right only
   * while a unit could stop there. #108's admission is local, so the unit that holds stops where
   * IT cannot get closer: measured here at 176.08 m against a road distance of 57.4, clock
   * 25.154 s against the 8.201 s this line used to want. The gate failed 1 of 81 twice running,
   * deterministically, which is the gate doing its job — the clock was right and the proxy was
   * not.
   *
   * So the bound is the distance the page itself reports for the NEAREST HOLDING UNIT, which this
   * arm already records, and the road distance is still PRINTED because the gap between the two
   * is #108's cost in the live host rather than in a probe.
   */
  const heldD = walk.trail && walk.trail.heldD != null ? Number(walk.trail.heldD) : null;
  const wantS = heldD != null ? Math.max(4.0, heldD / 7.0) : null;
  console.log(`    at the arrest: car drifted ${walk.trail ? walk.trail.drift.toFixed(2) : 'n/a'} m `
    + `from where it was placed, ${walk.trail && walk.trail.carRoadD != null
      ? walk.trail.carRoadD.toFixed(1) : 'n/a'} m from a road, nearest HOLDING unit `
    + `${walk.trail ? walk.trail.heldD : 'n/a'} m away, clock ${
      walk.trail ? walk.trail.needsThen : 'n/a'} s on frame ${walk.trail ? walk.trail.frame : '-'}`);
  console.log(`    the page's latched arrest clock ${walk.bustNeeds} s against this gate's own `
    + `arrestSeconds(held ${heldD == null ? 'n/a' : heldD.toFixed(2)} m) = `
    + `${wantS == null ? 'n/a' : wantS.toFixed(2)} s; the NETWORK gets within `
    + `${walk.roadD == null ? 'n/a' : walk.roadD.toFixed(1)} m, so the unit that held stopped `
    + `${heldD != null && walk.roadD != null ? (heldD - walk.roadD).toFixed(1) : 'n/a'} m further `
    + `out than the closest kerb — #108's cost, in the shipped host`);
  /**
   * WHAT THIS ARM CAN ASSERT, AND THE PARAGRAPH THAT USED TO BE HERE WAS WRONG.
   *
   * It said the arm "CANNOT reliably assert that the arrest COMPLETES", because the clock latched
   * 8.205 s and then advanced 0.145 s over 103 rendered frames while `arrest-band` busted at 37 to
   * 186 m through the other host — so "the two hosts disagree about the STICKINESS of a long
   * hold". That was filed as #108 and it is refuted: running THIS arm's own spot through
   * `tools/playtest.mjs` gives 0 of 480 held steps there too, and `u.held` never flickered (363 of
   * 363 stopped unit-frames held). The hosts agreed; the SPOT differed, and no unit could stop
   * because the admission demanded a network minimum the router cannot reach. See
   * docs/BACKLOG.md #108.
   *
   * So the completion IS asserted now, and the arm measures four things: the clock the page
   * latched is the WALK and not the floor, it equals this gate's own `arrestSeconds` of the held
   * distance the page reported, `bustNoWalk` did not move so the host supplied it rather than the
   * module falling back, and the arrest FIRES. Two independent sources agreeing, and an outcome.
   */
  /**
   * THE RATE, as `bustNeeds` minus the LAST live countdown — the two ends of one quantity. The
   * first version printed `trail.needsThen - needs`, which is the latched clock minus the HIGHEST
   * countdown seen, and came out at -4.005 s: `needsThen` is read from a report taken before the
   * latch completes inside that frame's sim steps, so it is the PREVIOUS arrest's value. Two
   * different quantities subtracted, and the negative sign is what said so.
   */
  console.log(`    the clock then advanced ${walk.bustNeeds != null && walk.lastIn != null
    ? (walk.bustNeeds - walk.lastIn).toFixed(3) : 'n/a'} s of its ${walk.bustNeeds} s over the `
    + `window, ending on "${walk.why}"`);
  check('the clock armed at all, so the three checks below have a subject',
    walk.trail != null && walk.trail.needsThen != null,
    walk.trail ? `latched ${walk.trail.needsThen} s on frame ${walk.trail.frame}` : 'never armed');
  check('and the clock the page ran is the WALK, not the floor',
    walk.bustNeeds !== null && walk.bustNeeds > 4.0 + 0.5,
    `${walk.bustNeeds} s against a 4.0 s floor`);
  check('and it is the walk THIS gate measures, so neither side is a literal',
    walk.bustNeeds !== null && wantS !== null && Math.abs(walk.bustNeeds - wantS) < 1.0,
    `${walk.bustNeeds} against ${wantS === null ? 'n/a' : wantS.toFixed(3)} s`);
  check('so the host supplied it, rather than the module falling back',
    walk.noWalk === 0, `bustNoWalk rose by ${walk.noWalk} over the window`);
  /**
   * AND IT COMPLETES, which #108 is what made assertable. Before it, this spot was a stalemate in
   * the shipped host: the clock armed, nothing held for long enough, and the arm ran out its
   * window. The check is the OUTCOME rather than the clock, because the clock being right was
   * already true of the build that never fired.
   */
  check('and the arrest FIRES, which is the whole of #108 in the shipped host',
    walk.why === 'busted', `ended on "${walk.why}" after ${walk.bustNeeds} s of walk`);
  /**
   * AND THE MODULE'S OWN FLOOR AGREES WITH THE ROAD QUERY, which is the premise the whole change
   * rests on: `bestApproach` is the minimum over the pursuit's edge list and `roadDistance` is the
   * router's projection, two independent walks of the same network. #89's table had them agreeing
   * to between 0.1 and 1.1 m over nine placements; this is the same comparison on the page.
   */
  check('and the module reports the network floor the clamp was decided on',
    walk.best !== null && walk.best > walk.reach,
    `${walk.best} against a reach of ${walk.reach.toFixed(2)} m`);
  check('which is the same number the router gives, by two independent walks of the network',
    walk.best !== null && walk.roadD != null && Math.abs(walk.best - walk.roadD) < 2,
    `bestApproach ${walk.best} against roadDistance ${
      walk.roadD == null ? 'n/a' : walk.roadD.toFixed(3)} m`);
  /**
   * AND PUT THE PAGE BACK, because this arm arrests the player: the car respawns, the mission
   * aborts and the wanted level is spent. Nothing runs after it, and it still restores, because
   * "nothing runs after it" is a fact about today's file order rather than a property of the arm.
   */
  await page.evaluate(() => {
    __district.clearWanted('boot-check');
    __district.setTimeScale(1);
    __district.placeAt(__district.district.meta.spawn.x, __district.district.meta.spawn.z, 0);
  });
}

await browser.close();
console.log(`\nBOOT: ${fail ? `FAIL — ${fail} of ${pass + fail}` : `PASS — ${pass} checks`} ` +
  `in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(fail ? 1 : 0);


/**
 * THE WEDGED-CAR CUE, WHICH ONLY THIS GATE CAN SEE REACH THE PAGE.
 *
 * `src/vehicle.js` owns the detector and `tools/blocker-test.mjs` gates it against real geometry:
 * a car crept into a 4 m bay travels 0.305 m under full throttle, pressing the wall 92 times a
 * second, and reverse covers 63.18 m from the same pin — x207. `src/hud.js`'s `composeBand` owns
 * the precedence and hud-cue's ladder gates that. What lives ONLY in district/main.js is the one
 * line that passes `composeStuck(vehicle)` into the band, and nothing offline imports that file.
 *
 * READ OFF THE DOM, like the arm above it, because the state object is not what a player sees:
 * the `stuck` tenant sets `ownSubtitle`, and the whole content of the line is the one word in the
 * subtitle, so a build that composed it correctly and failed to paint it would be invisible to a
 * check on `state.subtitle`.
 *
 * AT A REAL PIN IN THE SHIPPED DISTRICT, and the first version of this arm was void for an
 * instructive reason: it set `vehicle.stuckFor` directly, and `_trackJam` runs every physics step
 * and zeroed it before the band was composed. The injection failing is the detector working — but
 * it is not a measurement, so it is replaced rather than worked around.
 *
 * (132.89, 221.48) was found by gridding the district at 5 m for clear spots with most of sixteen
 * directions blocked within 6 m and then testing each by creeping in and holding full throttle:
 * 388 candidates, 5 real pins. Offline it gives forward 0.183 m against reverse 28.7 m with 94
 * contacts a second, which is the playtester's 0.34 m and ~96/s. tools/blocker-test.mjs asserts
 * that; what is asserted HERE is only that the line reaches the page.
 *
 * BOUNDED BY THE STATE, NOT THE WALL CLOCK, the way the run-over arm above is. district/main.js
 * clamps dt to 0.05 and `stepFixed` caps at 16 substeps of 1/120, so the physics advances at most
 * 0.133 s per rendered frame however long the frame takes — `setTimeScale` cannot buy more than
 * that. The run ends when `stuckFor` clears the dwell, with a generous wall-clock backstop that
 * never decides a pass, and the reason it ended is reported.
 */
{
  const jam = await page.evaluate(async () => {
    const d = __district;
    const v = d.vehicle;
    const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
    const read = () => {
      const h = d.hud();
      return { obj: h.elObjText ? h.elObjText.textContent : '',
        sub: h.elSub ? h.elSub.textContent : '' };
    };
    d.setMode('car');
    d.clearWanted('boot-check');
    d.setBodyCollision(true);
    d.placeAt(132.89, 221.48, 1.571);
    for (let i = 0; i < 3; i++) await frame();
    const quiet = read();
    // Crept in at 0.35 so the impact is gentle: a hard nose-in WRECKS the car, and a wreck is a
    // different tenant with its own cue. Then full throttle, which is the state under test.
    let phase = 'creep';
    d.setAutopilot(() => {
      v.setControls({ throttle: phase === 'creep' ? 0.35 : 1, brake: 0, steer: 0,
        handbrake: false });
    });
    const t0 = Date.now();
    let why = 'stuck';
    for (let i = 0; i < 400; i++) {
      await frame();
      if (phase === 'creep' && v.contacts > 20) phase = 'push';
      if (v.stuckFor >= 4.0) break;
      if (d.wreckReport().wrecks > 0) { why = 'wrecked'; break; }
      /**
       * THE WALL CLOCK IS A SAFETY NET AGAINST A HANG, NOT A BUDGET, AND AT 240 s IT WAS BOTH.
       *
       * This arm waits on the CAR TO TRAVEL, so `setTimeScale` cannot buy it anything —
       * `stepFixed` caps the physics at 0.133 s of sim per rendered frame however long the frame
       * takes (see CLAUDE.md). Its real bound is the 400-frame budget above. At roughly 0.6 s a
       * frame through SwiftShader, 400 frames IS 240 s, so the two bounds were numerically
       * coincident on this box and which one fired was decided by how fast the machine felt.
       * It fired the clock at `stuckFor 3.80` against a 4.0 threshold — 5% short — and reported
       * "wall clock", which is the one thing that stopped this being read as a behaviour change.
       *
       * 420 s is 400 frames at 1.05 s a frame, which is a slow box rather than a hung one. On a
       * healthy box the loop still exits on the STATE and costs nothing extra; this only changes
       * which bound is reachable. CLAUDE.md: "a check that compares against an absolute number
       * needs the same sweep a measurement does", and "bound such an arm on the STATE rather than
       * the wall clock, and report which of the two ended the run" — it does report, and that is
       * what made this diagnosable in one run.
       */
      if (Date.now() - t0 > 420000) { why = 'wall clock'; break; }
    }
    const nose = read();
    const stuckFor = v.stuckFor, contacts = v.contacts, frames = d.frames;
    // Freed: brake off the wall in reverse, and the line must go.
    d.setAutopilot(() => {
      v.setControls({ throttle: -1, brake: 0, steer: 0, handbrake: false });
    });
    for (let i = 0; i < 60 && v.stuckFor > 0; i++) await frame();
    const after = read();
    d.setAutopilot(null);
    return { quiet, nose, after, stuckFor, contacts, frames, why,
      wrecks: d.wreckReport().wrecks };
  });
  console.log(`  wedged at the pin: "${jam.quiet.obj}" -> "${jam.nose.obj}" / "${jam.nose.sub}", `
    + `then "${jam.after.obj}"`);
  console.log(`    ended on "${jam.why}" with stuckFor ${jam.stuckFor.toFixed(2)} s, `
    + `${jam.contacts} contacts, ${jam.wrecks} wrecks`);
  check('the car got itself wedged on the page rather than wrecked or timed out',
    jam.why === 'stuck' && jam.wrecks === 0 && jam.stuckFor >= 4.0,
    `ended on "${jam.why}", stuckFor ${jam.stuckFor.toFixed(2)} s, wrecks ${jam.wrecks}`);
  check('a wedged car reaches the page, with the one word that gets it out',
    jam.nose.obj.includes('WEDGED') && jam.nose.sub === 'reverse',
    `"${jam.nose.obj}" / "${jam.nose.sub}"`);
  check('KNOWN-BAD: and it is gone once the car frees itself, so it is not a stuck panel',
    !jam.quiet.obj.includes('WEDGED') && !jam.after.obj.includes('WEDGED'),
    `before "${jam.quiet.obj}", after "${jam.after.obj}"`);
}
