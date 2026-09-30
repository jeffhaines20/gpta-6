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
    d.setMode('car');
    d.placeAt(-327.8, 63.3, 0);
    d.startMission('marlin-street');
    d.reportCrime('officerDown', { at: { x: -327.8, z: 63.3 } });
    const notHonoured = d.wantedReport().notHonoured.slice();
    const fleet = d.wantedReport().fleet;
    const holdR = fleet ? fleet.holdR : null;
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
    return { before, notHonoured, holdR, fleet, healthBefore, hurt: hurt.applied, seen,
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
  check('the release went through the respawn, not a second code path',
    bust.wreck.respawns > 0, `${bust.wreck.respawns} respawns`);
  check('the pursuit layer reports that it can hold, so the clock can arm in play',
    !bust.notHonoured.includes('held') && bust.holdR > 0,
    `${JSON.stringify(bust.notHonoured)}, holdR ${bust.holdR}`);
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
    // Whoever is in front of the car, within a short run, with clear ground between.
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    const fx = Math.sin(yaw), fz = Math.cos(yaw);
    const ahead = peds.positions()
      .map((p) => {
        const rx = p.x - v.position.x, rz = p.z - v.position.z;
        return { ...p, along: rx * fx + rz * fz, side: Math.abs(rx * fz - rz * fx) };
      })
      .filter((p) => !p.down && p.along > 5 && p.along < 26 && p.side < 1.2)
      .sort((a, b) => a.along - b.along);
    if (!ahead.length) {
      d.setTimeScale(1);
      return { skipped: 'nobody standing in the car’s path', crowd: peds.positions().length };
    }
    const spot = ahead[0];
    // Above damage.js's kill speed the crowd keeps a body down, the same threshold the crime uses.
    peds.hit(spot.i, { speed: 30, dirX: fx, dirZ: fz, force: true });
    await new Promise((r) => requestAnimationFrame(() => r()));
    const bodyDown = peds.isDown(spot.i);
    const seen = [];
    let overs = 0, repeats = 0, closest = Infinity, top = 0;
    const dyn0 = d.damageReport().dynamic;
    d.setAutopilot(() => {
      /**
       * OVER src/pedestrians.js's `PED_FREE_MS` (2.2 m/s) AND FAR UNDER `pedKillSpeed` (21.3).
       * 4 m/s is 14 km/h: a run-over charge of about 0.008, against the 1.00 the old literal
       * applied, so the two readings are two orders of magnitude apart rather than a rounding.
       */
      v.setControls({ throttle: v.speed < 4 ? 0.5 : 0, brake: 0, steer: 0, handbrake: false });
    });
    const t1 = Date.now();
    while (Date.now() - t1 < 25000) {
      await new Promise((r) => requestAnimationFrame(() => r()));
      const p = peds.positions().find((x) => x.i === spot.i);
      if (p) closest = Math.min(closest, Math.hypot(p.x - v.position.x, p.z - v.position.z));
      top = Math.max(top, v.speed * 3.6);
      const dyn = d.damageReport().dynamic;
      overs = dyn.pedRunOvers; repeats = dyn.pedRepeats;
      if (dyn.lastRunOver) { seen.push(dyn.lastRunOver); break; }
    }
    d.setAutopilot(null);
    d.setTimeScale(1);
    v.setControls({ throttle: 0, brake: 1, steer: 0, handbrake: false });
    return { seen, overs, repeats, bodyDown, stars: d.wanted.stars,
      along: +spot.along.toFixed(1), side: +spot.side.toFixed(2),
      closest: +closest.toFixed(2), topKmh: +top.toFixed(1),
      repeats0: dyn0.pedRepeats, overs0: dyn0.pedRunOvers,
      knock: d.damageReport().dynamic.pedKnockdowns, crimes: d.damageReport().crimesReported };
  });
  if (ro.skipped) {
    console.log(`  run-over wire: SKIPPED — ${ro.skipped}`);
    check('the run-over arm could stage a body in the car’s path', false, ro.skipped);
  } else {
    const last = ro.seen[0] ?? null;
    console.log(`  run-over: a body ${ro.along} m ahead (${ro.side} m off the line), down ` +
      `${ro.bodyDown}; crept to ${ro.closest} m at up to ${ro.topKmh} km/h`);
    console.log(`    overs ${ro.overs0} -> ${ro.overs}, repeats ${ro.repeats0} -> ${ro.repeats}, ` +
      `charge ${JSON.stringify(last)}, stars ${ro.stars}`);
    console.log(`    the old literal charged scale 1.00 here, which is ` +
      `${last ? (1 / last.scale).toFixed(0) : '?'}x what the speed says`);
    check('the body was still on the ground when the car got there', ro.bodyDown === true,
      `${ro.bodyDown}`);
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

await browser.close();
console.log(`\nBOOT: ${fail ? `FAIL — ${fail} of ${pass + fail}` : `PASS — ${pass} checks`} ` +
  `in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(fail ? 1 : 0);
