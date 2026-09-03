// How many of the lamps the LightPool actually LIGHTS are ones the player can see?
//
// The pool promotes 10 emitters out of several hundred to real PointLights. It
// selected them by horizontal distance alone, with no knowledge of where the
// camera was pointing, so a lamp 20 m BEHIND the viewer consumed a slot and lit
// nothing on screen while a lamp 60 m ahead down the corridor glowed - its
// emissive fixture geometry is drawn unconditionally - without illuminating
// anything. Three separate critic rounds reported the symptom ("lamps glow but
// cast no light"); this measures the cause.
//
// Three numbers, all at a fixed camera so before/after are comparable:
//
//   onScreen   - the lit fixture projects inside the NDC box and is in front of
//                the near plane. The strict reading of "the player can see the
//                lamp that is lit". No occlusion test, so it is an upper bound.
//   illuminate - the lamp's own falloff sphere (PointLight.distance) intersects
//                the view frustum, i.e. the light can reach SOME visible surface.
//                The physically meaningful one: a lamp just off the left edge
//                still lights the pavement in shot.
//   supply     - of every emitter inside the pool's maxDistance, how many would
//                have passed each test. The denominator: it says whether the
//                pool had better candidates available and declined them.
//
// Plus a rotation-churn sweep, because biasing selection toward the view means
// the set MUST change when the player turns, and the failure mode of doing that
// naively is thrash. Churn is counted as slot reassignments per 10 deg of yaw,
// measured with the hysteresis margin on and off - an A/B that also proves the
// margin is wired to something.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TAG = (process.argv.find((a) => a.startsWith('--tag=')) ?? '--tag=run').slice(6);
const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

// ---------------------------------------------------------------- in-page probe
//
// Runs against a freshly imported copy of three.js so the frustum maths is the
// library's own, and takes its matrices from `.elements` arrays rather than
// sharing objects across the two module instances.
const PROBE = `async () => {
  const T = await import('/vendor/three.module.min.js');
  const cam = __district.camera;
  cam.updateMatrixWorld();                       // do not measure a stale frame
  const world = new T.Matrix4().fromArray(cam.matrixWorld.elements);
  const view = world.clone().invert();
  const proj = new T.Matrix4().fromArray(cam.projectionMatrix.elements);
  const vp = proj.clone().multiply(view);
  const fr = new T.Frustum().setFromProjectionMatrix(vp);
  const eye = new T.Vector3().setFromMatrixPosition(world);

  const classify = (x, y, z, radius) => {
    const p = new T.Vector3(x, y, z);
    const v = p.clone().applyMatrix4(view);      // view space: camera looks down -z
    const ndc = p.clone().applyMatrix4(vp);
    const inFront = v.z < 0;
    return {
      onScreen: inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= -1 && ndc.z <= 1,
      illuminates: fr.intersectsSphere(new T.Sphere(p, radius)),
      behind: !inFront,
      dist: +eye.distanceTo(p).toFixed(1),
      ndc: [+ndc.x.toFixed(2), +ndc.y.toFixed(2)],
    };
  };

  const pool = __district.lightPool;
  const lit = [];
  for (let s = 0; s < pool.lights.length; s++) {
    const l = pool.lights[s];
    if (!l.visible || l.intensity <= 0) continue;
    lit.push({ slot: s, emitter: pool.assigned[s], intensity: +l.intensity.toFixed(0),
               ...classify(l.position.x, l.position.y, l.position.z, l.distance) });
  }

  // The denominator: every emitter the pool was allowed to choose from.
  const maxD2 = pool.maxDistance * pool.maxDistance;
  let inRange = 0, supplyOnScreen = 0, supplyIlluminate = 0, nearestOnScreen = Infinity;
  for (const e of pool.emitters) {
    const dx = e.x - cam.position.x, dz = e.z - cam.position.z;
    if (dx * dx + dz * dz >= maxD2) continue;
    inRange++;
    const c = classify(e.x, e.y, e.z, e.distance);
    if (c.onScreen) { supplyOnScreen++; nearestOnScreen = Math.min(nearestOnScreen, c.dist); }
    if (c.illuminates) supplyIlluminate++;
  }

  return {
    emitters: pool.emitters.length,
    poolSize: pool.size,
    swapMargin: pool.swapMargin,
    lit: lit.length,
    litOnScreen: lit.filter((l) => l.onScreen).length,
    litIlluminating: lit.filter((l) => l.illuminates).length,
    litBehind: lit.filter((l) => l.behind).length,
    supply: { inRange, onScreen: supplyOnScreen, illuminates: supplyIlluminate,
              nearestOnScreen: nearestOnScreen === Infinity ? null : nearestOnScreen },
    detail: lit,
    camera: { x: +cam.position.x.toFixed(1), y: +cam.position.y.toFixed(1), z: +cam.position.z.toFixed(1) },
  };
}`;

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate(() => __district.setHudEnabled(false));

// The daynight-sweep corridor camera, so these frames are comparable with every
// tod-*.png this project has already judged.
const CAM = await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len;
  const pos = [a.x - (dx / len) * 26 + nx * 5.5, 5.2, a.z - (dz / len) * 26 + nz * 5.5];
  const tgt = [a.x + (dx / len) * 300, 14, a.z + (dz / len) * 300];
  __district.freeCam(pos, tgt, 48);
  return { pos, tgt, heading: Math.atan2(dz, dx) };
});

// Scenes take ~30 s to finish streaming and a fixed short wait measures a
// half-built district, so wait on the streamer's own report and record what
// settled. Both before/after samples carry this, so a mismatched pair is visible.
async function settle(minMs = 45000, maxMs = 240000) {
  await page.evaluate(() => { for (let i = 0; i < 300; i++) __district.world.update(__district.vehicle.position); });
  const t0 = Date.now();
  let stable = 0, last = -1, w = null;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(2500);
    w = await page.evaluate(() => __district.worldReport());
    // Not `queued === 0`: under harness contention the far ring keeps a
    // permanent backlog, so that never fires and the sample is taken at the
    // timeout regardless. What matters is that the count around the camera has
    // stopped moving - the queue depth is recorded so a half-built sample shows.
    stable = (w.chunksLoaded === last) ? stable + 1 : 0;
    last = w.chunksLoaded;
    if (stable >= 4 && Date.now() - t0 >= minMs) break;
  }
  return { ...w, waitedMs: Date.now() - t0 };
}
const streamed = await settle();
console.log('streamed', JSON.stringify(streamed));

const results = {};
for (const tod of ['night', 'dusk']) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(8000);
  const m = await page.evaluate(`(${PROBE})()`);
  await page.screenshot({ path: `${OUT}/lamp-${tod}-${TAG}.png`, timeout: 180000 });
  results[tod] = m;
  console.log(`\n=== ${tod.toUpperCase()} (${TAG}) ===`);
  console.log(`lit ${m.lit}  onScreen ${m.litOnScreen}  illuminating ${m.litIlluminating}  behind ${m.litBehind}`);
  console.log(`supply within ${m.poolSize ? '' : ''}range: ${m.supply.inRange} emitters, ` +
              `${m.supply.onScreen} on screen, ${m.supply.illuminates} could illuminate`);
}

// ---- instrument check ----------------------------------------------------
// A probe that cannot produce the opposite reading is not a probe. Spin the same
// camera 180 deg on the spot: the emitters that were on screen must go off it.
// If this comes back unchanged the classifier is not reading the camera at all.
await page.evaluate(() => __district.setTimeOfDay('night'));
await page.waitForTimeout(2000);
const facingA = await page.evaluate(`(${PROBE})()`);
const flipped = await page.evaluate(({ pos, tgt }) => {
  __district.freeCam(pos, [2 * pos[0] - tgt[0], tgt[1], 2 * pos[2] - tgt[2]], 48);
}, CAM);
await page.waitForTimeout(4000);
const facingB = await page.evaluate(`(${PROBE})()`);
await page.evaluate(({ pos, tgt }) => __district.freeCam(pos, tgt, 48), CAM);
await page.waitForTimeout(4000);
const instrument = {
  forwardSupplyOnScreen: facingA.supply.onScreen,
  reversedSupplyOnScreen: facingB.supply.onScreen,
  forwardLitOnScreen: facingA.litOnScreen,
  reversedLitOnScreen: facingB.litOnScreen,
  // Same emitters in range either way - only the classification may move.
  inRangeSame: facingA.supply.inRange === facingB.supply.inRange,
};
instrument.valid = instrument.inRangeSame &&
  instrument.forwardSupplyOnScreen !== instrument.reversedSupplyOnScreen;
console.log('\n=== INSTRUMENT CHECK (180 deg turn on the spot) ===');
console.log(JSON.stringify(instrument));
console.log(instrument.valid ? 'VALID - the classifier moves with the camera'
                             : 'INVALID - identical reading facing both ways');

// ---- rotation churn ------------------------------------------------------
// Yaw the camera through 360 deg in 10 deg steps and count slot reassignments.
// Run twice, with the hysteresis margin at its authored value and at zero: the
// difference is what the margin buys, and a margin that changes nothing is dead.
async function churnSweep(margin) {
  await page.evaluate((m) => { __district.lightPool.swapMargin = m; }, margin);
  const steps = 36, R = 300;
  let prev = null, churn = 0, sets = 0;
  const onScreen = [];
  for (let i = 0; i <= steps; i++) {
    const th = (i / steps) * Math.PI * 2;
    await page.evaluate(({ pos, th, R }) => {
      __district.freeCam(pos, [pos[0] + Math.cos(th) * R, pos[1] + 2, pos[2] + Math.sin(th) * R], 48);
    }, { pos: CAM.pos, th, R });
    await page.waitForTimeout(450);            // several frames at software rates
    const s = await page.evaluate(() => __district.lightPool.assigned.slice());
    if (prev) {
      const changed = s.filter((v, k) => v !== prev[k]).length;
      churn += changed;
      if (changed) sets++;
    }
    prev = s;
    if (i % 3 === 0) onScreen.push((await page.evaluate(`(${PROBE})()`)).litOnScreen);
  }
  return { margin, slotChangesPer360: churn, perTenDeg: +(churn / steps).toFixed(2),
           stepsThatChanged: sets, ofSteps: steps,
           litOnScreenAroundTheTurn: onScreen,
           meanLitOnScreen: +(onScreen.reduce((a, b) => a + b, 0) / onScreen.length).toFixed(2) };
}
const authored = await page.evaluate(() => __district.lightPool.swapMargin);
const churn = { authored: await churnSweep(authored), noMargin: await churnSweep(0) };
await page.evaluate((m) => { __district.lightPool.swapMargin = m; }, authored);
console.log('\n=== ROTATION CHURN (360 deg on the spot, 10 deg steps) ===');
console.log(JSON.stringify(churn, null, 1));

fs.writeFileSync(`docs/lamp-onscreen-${TAG}.json`, JSON.stringify({
  tag: TAG, camera: CAM, streamed, results, instrument, churn, errors,
}, null, 1));
await browser.close();
console.log(`\nwrote docs/lamp-onscreen-${TAG}.json`);
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
