// A/B the light pool's selection rule inside ONE page session.
//
// tools/lamp-onscreen.mjs measures one build at a time, so a before/after pair
// costs two loads, two streaming settles, and whatever the other harnesses on
// this box were doing in between. That is a lot of variance to hang a one-light
// difference on. This runs both rules against the SAME loaded district, the same
// streamed chunks and the same camera, seconds apart:
//
//   legacy    - LightPool.setView stubbed out, so hasView stays false and _rank()
//               falls back to horizontal distance. Bit-for-bit the old rule.
//   viewaware - the shipped rule: an emitter that cannot light any visible
//               surface is ranked after every emitter that can.
//
// Three things get measured.
//   1. On-screen lit lamps at eight camera/heading pairs along the hero route,
//      because the one corridor camera the sweep uses turns out to have only 15
//      emitters inside the pool's 130 m reach and just one of them on screen -
//      a camera with almost no headroom is a bad place to judge a fix from.
//   2. The night and dusk frame itself, diffed pixel for pixel. Selection is the
//      only thing that moves between the two captures, so every changed pixel is
//      light that reached the player because of it.
//   3. Whether swapMargin earns its place. A monotonic 360 deg pan swaps the same
//      lamps in and out either way, so it says nothing; what hysteresis is for is
//      NON-monotonic movement - a hand on the mouse, a chase camera breathing
//      around a heading. So the camera is jittered around a boundary it has been
//      shown to sit on, in yaw and then in position, and the swaps are counted
//      with the margin at 8 m and at 0.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { readPNG } from './png.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

// ---- the two rules, as page-side switches ---------------------------------
// hasView is not enough on its own: main.js hands the camera over every frame and
// update() would set it straight back. Stubbing the instance's setView keeps the
// prototype method intact for the restore and makes the fallback branch live.
const LEGACY = `() => {
  const p = __district.lightPool;
  p.setView = () => false;
  p.hasView = false;
  p.assigned.fill(-1);            // no incumbents carried across the switch
}`;
const VIEWAWARE = `() => {
  const p = __district.lightPool;
  delete p.setView;               // back to the prototype
  p.assigned.fill(-1);
}`;

const PROBE = `async () => {
  const T = await import('/vendor/three.module.min.js');
  const cam = __district.camera;
  cam.updateMatrixWorld();
  const world = new T.Matrix4().fromArray(cam.matrixWorld.elements);
  const view = world.clone().invert();
  const vp = new T.Matrix4().fromArray(cam.projectionMatrix.elements).multiply(view);
  const fr = new T.Frustum().setFromProjectionMatrix(vp);
  const eye = new T.Vector3().setFromMatrixPosition(world);
  const classify = (x, y, z, radius) => {
    const p = new T.Vector3(x, y, z);
    const v = p.clone().applyMatrix4(view);
    const ndc = p.clone().applyMatrix4(vp);
    const inFront = v.z < 0;
    return {
      onScreen: inFront && Math.abs(ndc.x) <= 1 && Math.abs(ndc.y) <= 1 && ndc.z >= -1 && ndc.z <= 1,
      illuminates: fr.intersectsSphere(new T.Sphere(p, radius)),
      behind: !inFront, dist: +eye.distanceTo(p).toFixed(1),
    };
  };
  const pool = __district.lightPool;
  const lit = [];
  for (let s = 0; s < pool.lights.length; s++) {
    const l = pool.lights[s];
    if (!l.visible || l.intensity <= 0) continue;
    lit.push(classify(l.position.x, l.position.y, l.position.z, l.distance));
  }
  const maxD2 = pool.maxDistance * pool.maxDistance;
  let inRange = 0, sOn = 0, sIll = 0;
  for (const e of pool.emitters) {
    const dx = e.x - cam.position.x, dz = e.z - cam.position.z;
    if (dx * dx + dz * dz >= maxD2) continue;
    inRange++;
    const c = classify(e.x, e.y, e.z, e.distance);
    if (c.onScreen) sOn++;
    if (c.illuminates) sIll++;
  }
  return {
    viewAware: pool.hasView, lit: lit.length,
    onScreen: lit.filter((l) => l.onScreen).length,
    illuminating: lit.filter((l) => l.illuminates).length,
    behind: lit.filter((l) => l.behind).length,
    nearestLit: lit.length ? Math.min(...lit.map((l) => l.dist)) : null,
    farthestLit: lit.length ? Math.max(...lit.map((l) => l.dist)) : null,
    supply: { inRange, onScreen: sOn, illuminates: sIll },
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
await page.evaluate(() => __district.setAutopilot(() => {}));

// Eight camera/heading pairs: four points on the hero route, each looked at
// along the route and then across it. One camera is one accident.
const CAMS = await page.evaluate(() => {
  const r = __district.district.meta.route;
  const out = [];
  for (const [ai, bi] of [[2, 4], [4, 5], [0, 1], [5, 6]]) {
    const a = r[ai], b = r[bi];
    if (!a || !b) continue;
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    const pos = [a.x - (dx / len) * 26 + nx * 5.5, 5.2, a.z - (dz / len) * 26 + nz * 5.5];
    out.push({ name: `r${ai}-along`, pos, tgt: [a.x + (dx / len) * 300, 14, a.z + (dz / len) * 300] });
    out.push({ name: `r${ai}-across`, pos, tgt: [pos[0] + nx * 300, 14, pos[2] + nz * 300] });
  }
  return out;
});

async function settle(minMs = 45000, maxMs = 240000) {
  await page.evaluate(() => { for (let i = 0; i < 300; i++) __district.world.update(__district.vehicle.position); });
  const t0 = Date.now();
  let stable = 0, last = -1, w = null;
  while (Date.now() - t0 < maxMs) {
    await page.waitForTimeout(2500);
    w = await page.evaluate(() => __district.worldReport());
    stable = (w.chunksLoaded === last) ? stable + 1 : 0;
    last = w.chunksLoaded;
    if (stable >= 4 && Date.now() - t0 >= minMs) break;
  }
  return { chunksLoaded: w.chunksLoaded, queued: w.queued, triangles: w.triangles, waitedMs: Date.now() - t0 };
}

const place = async (c) => {
  await page.evaluate(({ pos, tgt }) => {
    __district.placeAt(pos[0], pos[2]);
    __district.freeCam(pos, tgt, 48);
  }, c);
};

await place(CAMS[0]);
const streamed = await settle();
console.log('streamed', JSON.stringify(streamed));
await page.evaluate(() => __district.setTimeOfDay('night'));
await page.waitForTimeout(6000);

// ---- 1. on-screen lit lamps, both rules, eight views ----------------------
const perCam = [];
for (const c of CAMS) {
  await place(c);
  await page.waitForTimeout(3500);            // let the streamer catch up a little
  const row = { cam: c.name };
  for (const [mode, sw] of [['legacy', LEGACY], ['viewaware', VIEWAWARE]]) {
    await page.evaluate(`(${sw})()`);
    await page.waitForTimeout(1200);
    await advanceFrames(4);
    row[mode] = await page.evaluate(`(${PROBE})()`);
    // The switch must actually have taken. It did not, for the whole first run:
    // page.evaluate(sw) was passed a STRING holding an arrow function, which
    // Playwright evaluates as an expression - so it built a function object and
    // threw it away, and BOTH arms measured whatever main.js had left the pool in.
    // Every camera came back identical and the A/B looked like a clean null.
    const expect = mode === 'legacy' ? false : true;
    if (row[mode].viewAware !== expect) {
      throw new Error(`${c.name} ${mode}: pool.hasView is ${row[mode].viewAware}, expected ${expect} `
        + '- the arm did not take, so this comparison is meaningless');
    }
  }
  perCam.push(row);
  console.log(`${c.name.padEnd(12)}  supply ${String(row.legacy.supply.inRange).padStart(3)} in range / ` +
    `${row.legacy.supply.onScreen} on screen / ${row.legacy.supply.illuminates} can light  ||  ` +
    `legacy ${row.legacy.onScreen} on screen ${row.legacy.illuminating} lighting ${row.legacy.behind} behind  ->  ` +
    `viewaware ${row.viewaware.onScreen} on screen ${row.viewaware.illuminating} lighting ${row.viewaware.behind} behind`);
}
const tot = (mode, k) => perCam.reduce((a, r) => a + r[mode][k], 0);
const supplyTot = (k) => perCam.reduce((a, r) => a + r.legacy.supply[k], 0);

// ---- 2. the frame itself, at two times of day ----------------------------
// Night is the one that matters. Dusk is the second sample the critique rule
// asks for, and here it is also the regression check: lamps are on at dusk too.
const frames = {};
for (const tod of ['night', 'dusk']) {
  await place(CAMS[0]);
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(9000);
  const shots = {};
  for (const [mode, sw] of [['legacy', LEGACY], ['viewaware', VIEWAWARE]]) {
    await page.evaluate(`(${sw})()`);
    await page.waitForTimeout(2500);
    const f = `${OUT}/lamp-ab-${tod}-${mode}.png`;
    await page.screenshot({ path: f, timeout: 180000 });
    shots[mode] = f;
  }
  const a = readPNG(shots.legacy), b = readPNG(shots.viewaware);
  let changed = 0, sum = 0, brighter = 0, dimmer = 0, lumA = 0, lumB = 0;
  const n = a.width * a.height;
  for (let i = 0; i < n; i++) {
    const ia = i * a.channels, ib = i * b.channels;
    const la = 0.2126 * a.data[ia] + 0.7152 * a.data[ia + 1] + 0.0722 * a.data[ia + 2];
    const lb = 0.2126 * b.data[ib] + 0.7152 * b.data[ib + 1] + 0.0722 * b.data[ib + 2];
    lumA += la; lumB += lb;
    const d = Math.max(Math.abs(a.data[ia] - b.data[ib]), Math.abs(a.data[ia + 1] - b.data[ib + 1]),
                       Math.abs(a.data[ia + 2] - b.data[ib + 2]));
    if (d > 2) { changed++; sum += d; if (lb > la) brighter++; else dimmer++; }
  }
  frames[tod] = {
    pixels: n,
    changedPct: +(100 * changed / n).toFixed(3),
    meanAbsDiffOverChanged: +(changed ? sum / changed : 0).toFixed(2),
    brighterPct: +(100 * brighter / n).toFixed(3),
    dimmerPct: +(100 * dimmer / n).toFixed(3),
    meanLumaLegacy: +(lumA / n).toFixed(3),
    meanLumaViewAware: +(lumB / n).toFixed(3),
    shots,
  };
  console.log(`\n${tod}: ${frames[tod].changedPct}% of pixels changed, ` +
    `${frames[tod].brighterPct}% brighter / ${frames[tod].dimmerPct}% dimmer, ` +
    `mean luma ${frames[tod].meanLumaLegacy} -> ${frames[tod].meanLumaViewAware}`);
}

// ---- 3. does swapMargin do anything? -------------------------------------
// SUPERSEDED by tools/lamp-hysteresis.mjs, which sweeps up through the boundary
// and back down and so can tell hysteresis from a threshold that merely sits
// somewhere else. This arm cannot: it locates the boundary at margin 0 and then
// dithers around THAT heading at margin 8, where "0 swaps" is equally consistent
// with a shifted-but-still-sharp edge. Kept because sections 1 and 2 are the
// headline A/B and get re-run whenever the ranking changes; pass
// --skip-hysteresis to stop here and not pay for a measurement that has been
// replaced.
if (process.argv.includes('--skip-hysteresis')) {
  fs.writeFileSync('docs/lamp-ab.json', JSON.stringify({
    streamed, perCam,
    totals: {
      cameras: perCam.length,
      supply: { inRange: supplyTot('inRange'), onScreen: supplyTot('onScreen'), illuminates: supplyTot('illuminates') },
      legacy: { onScreen: tot('legacy', 'onScreen'), illuminating: tot('legacy', 'illuminating'), behind: tot('legacy', 'behind') },
      viewaware: { onScreen: tot('viewaware', 'onScreen'), illuminating: tot('viewaware', 'illuminating'), behind: tot('viewaware', 'behind') },
    },
    frames, hysteresis: 'skipped - see docs/lamp-hysteresis.json', errors,
  }, null, 1));
  await browser.close();
  console.log('\n=== TOTALS over ' + perCam.length + ' views ===');
  console.log(JSON.stringify({
    supply: { inRange: supplyTot('inRange'), onScreen: supplyTot('onScreen'), illuminates: supplyTot('illuminates') },
    legacy: { onScreen: tot('legacy', 'onScreen'), illuminating: tot('legacy', 'illuminating'), behind: tot('legacy', 'behind') },
    viewaware: { onScreen: tot('viewaware', 'onScreen'), illuminating: tot('viewaware', 'illuminating'), behind: tot('viewaware', 'behind') },
  }, null, 1));
  if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
  process.exit(0);
}

await page.evaluate(() => __district.setTimeOfDay('night'));
// Invoked, not merely evaluated - the same mistake that made the whole first run
// a false null. Asserted straight after, because a switch that silently does not
// take is indistinguishable from a margin that does nothing.
await page.evaluate(`(${VIEWAWARE})()`);
await page.waitForTimeout(3000);
if (!(await page.evaluate(() => __district.lightPool.hasView))) {
  throw new Error('pool is not view-aware entering section 3 - the arm did not take');
}

async function advanceFrames(n = 3) {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f, f0 + n, { timeout: 60000 });
}
const yawAt = async (c, th, R = 300) => {
  await page.evaluate(({ pos, th, R }) => {
    __district.freeCam(pos, [pos[0] + Math.cos(th) * R, pos[1] + 2, pos[2] + Math.sin(th) * R], 48);
  }, { pos: c.pos, th, R });
  await advanceFrames();
  return page.evaluate(() => __district.lightPool.assigned.slice());
};
const same = (a, b) => a.every((v, i) => v === b[i]);

// Find a heading the selection actually changes across - jittering somewhere the
// set is stable would prove nothing about hysteresis either way.
const HERO = CAMS[0];
await page.evaluate(() => { __district.lightPool.swapMargin = 0; });
let boundary = null, prev = await yawAt(HERO, 0);
for (let deg = 1; deg <= 360 && boundary === null; deg += 1) {
  const s = await yawAt(HERO, (deg * Math.PI) / 180);
  if (!same(s, prev)) boundary = deg;
  prev = s;
}
console.log(`\nselection boundary found at yaw ${boundary} deg`);

// Rotational jitter: oscillate +/-1.5 deg across that boundary, six times over.
async function jitterYaw(margin) {
  await page.evaluate((m) => { __district.lightPool.swapMargin = m; }, margin);
  const base = ((boundary ?? 0) - 0.5) * Math.PI / 180;
  let prevSet = await yawAt(HERO, base), swaps = 0, samples = 0;
  for (let k = 0; k < 24; k++) {
    const th = base + (1.5 * Math.PI / 180) * Math.sin((k / 24) * Math.PI * 2 * 6);
    const s = await yawAt(HERO, th);
    if (!same(s, prevSet)) swaps += s.filter((v, i) => v !== prevSet[i]).length;
    prevSet = s; samples++;
  }
  return { margin, swaps, samples };
}
// Translational jitter: the same question for the ORIGINAL complaint the field
// was written for - two emitters at nearly equal distance trading a slot as the
// viewer creeps forward. The chase camera breathes several metres.
async function jitterMove(margin) {
  await page.evaluate((m) => { __district.lightPool.swapMargin = m; }, margin);
  const [x, y, z] = HERO.pos, [tx, ty, tz] = HERO.tgt;
  const dx = tx - x, dz = tz - z, len = Math.hypot(dx, dz) || 1;
  let prevSet = null, swaps = 0, samples = 0;
  for (let k = 0; k < 24; k++) {
    const s = 3.5 * Math.sin((k / 24) * Math.PI * 2 * 6);
    await page.evaluate(({ p, t }) => {
      __district.placeAt(p[0], p[2]);
      __district.freeCam(p, t, 48);
    }, { p: [x + (dx / len) * s, y, z + (dz / len) * s], t: [tx, ty, tz] });
    await advanceFrames();
    const set = await page.evaluate(() => __district.lightPool.assigned.slice());
    if (prevSet && !same(set, prevSet)) swaps += set.filter((v, i) => v !== prevSet[i]).length;
    prevSet = set; samples++;
  }
  return { margin, swaps, samples };
}
const hysteresis = {
  yaw: { margin8: await jitterYaw(8), margin0: await jitterYaw(0) },
  move: { margin8: await jitterMove(8), margin0: await jitterMove(0) },
};
await page.evaluate(() => { __district.lightPool.swapMargin = 8; });
console.log('\n=== HYSTERESIS (jitter across a boundary, 24 samples each) ===');
console.log(JSON.stringify(hysteresis));

const summary = {
  streamed,
  perCam,
  totals: {
    cameras: perCam.length,
    supply: { inRange: supplyTot('inRange'), onScreen: supplyTot('onScreen'), illuminates: supplyTot('illuminates') },
    legacy: { onScreen: tot('legacy', 'onScreen'), illuminating: tot('legacy', 'illuminating'), behind: tot('legacy', 'behind') },
    viewaware: { onScreen: tot('viewaware', 'onScreen'), illuminating: tot('viewaware', 'illuminating'), behind: tot('viewaware', 'behind') },
  },
  frames, hysteresis, errors,
};
fs.writeFileSync('docs/lamp-ab.json', JSON.stringify(summary, null, 1));
await browser.close();
console.log('\n=== TOTALS over ' + perCam.length + ' views ===');
console.log(JSON.stringify(summary.totals, null, 1));
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
