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
    };
  });
  console.log(`  ${JSON.stringify(live)}`);
  check('frames keep coming', live.frames > f0, `${f0} -> ${live.frames}`);
  check('the scene has geometry in it', live.tris === null || live.tris > 10000,
    `${live.tris} triangles`);
  check('chunks streamed in', live.chunks === null || live.chunks > 0, `${live.chunks}`);
  check('the crowd is alive', live.crowd === null || live.crowd > 0, `${live.crowd} people`);
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

await browser.close();
console.log(`\nBOOT: ${fail ? `FAIL — ${fail} of ${pass + fail}` : `PASS — ${pass} checks`} ` +
  `in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
process.exit(fail ? 1 : 0);
