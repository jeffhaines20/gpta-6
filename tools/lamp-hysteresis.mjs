// Does LightPool.swapMargin do anything, on a test that could say no?
//
// The first attempt at this did not. It located the switching heading with the
// margin at 0 and then dithered around THAT heading with the margin at 8, and
// read 0 swaps. But a margin that merely MOVED the threshold would score exactly
// the same, because the dither would then sit entirely on one side of a
// shifted-but-still-sharp edge. Zero swaps was consistent with hysteresis and
// with no hysteresis at all, so it established nothing.
//
// Hysteresis is path dependence, so the experiment has to have two paths. The
// camera is swept slowly UP through the boundary and then back DOWN through the
// same angles, and the lit set is recorded at every angle on both passes. A sharp
// threshold - wherever it sits - gives the same set at the same angle going up as
// coming down. A hysteretic one does not, and the angular width of the
// disagreement is the size of the effect. Nothing about a shifted threshold can
// fake that.
//
// Then churn, the number the change is actually judged on: slot reassignments
// while the camera dithers. Measured in all four cells - margin 0 and margin 8,
// dithering about margin 0's boundary AND about margin 8's own band - because a
// shifted threshold would churn at its own boundary and hysteresis would not.
//
// And the cost. The margin lets a lamp that can no longer light anything visible
// keep its slot for another swapMargin metres. That is a wasted slot, which is
// the very thing this class was changed to stop spending, so it is counted too.
//
// Negative control throughout: margin 0 must show the disagreement collapse and
// the churn appear. A run where nothing ever moves proves the rig, not the code.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const STEP_DEG = 0.5;          // sweep resolution
const HALF_WINDOW_DEG = 10;    // sweep +/- this about the boundary
const DITHER_DEG = 1.5;        // dither amplitude
const DITHER_SAMPLES = 24;

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate(() => __district.setHudEnabled(false));
await page.evaluate(() => __district.setAutopilot(() => {}));

// The corridor camera the day/night sweep and the A/B both use.
const HERO = await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz);
  const nx = -dz / len, nz = dx / len;
  const pos = [a.x - (dx / len) * 26 + nx * 5.5, 5.2, a.z - (dz / len) * 26 + nz * 5.5];
  __district.placeAt(pos[0], pos[2]);
  __district.freeCam(pos, [a.x + (dx / len) * 300, 14, a.z + (dz / len) * 300], 48);
  return { pos };
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
  return { chunksLoaded: w.chunksLoaded, queued: w.queued, waitedMs: Date.now() - t0 };
}
const streamed = await settle();
console.log('streamed', JSON.stringify(streamed));
await page.evaluate(() => __district.setTimeOfDay('night'));
await page.waitForTimeout(6000);

// The pool only re-ranks inside a rendered frame, so every step waits on the
// frame counter rather than on the clock: under harness contention a fixed
// timeout can contain no frame at all and then `assigned` is simply stale.
async function advanceFrames(n = 3) {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((f) => __district.frames > f, f0 + n, { timeout: 60000 });
}
async function lookAt(deg) {
  await page.evaluate(({ pos, th }) => {
    __district.freeCam(pos, [pos[0] + Math.cos(th) * 300, pos[1] + 2, pos[2] + Math.sin(th) * 300], 48);
  }, { pos: HERO.pos, th: (deg * Math.PI) / 180 });
  await advanceFrames();
  return page.evaluate(() => ({
    assigned: __district.lightPool.assigned.slice(),
    // The pool's own account of how many of its lit lights can reach the view.
    // Counted in-engine against the same frustum selection used, so a wasted
    // slot is `active - illuminating`.
    report: __district.lightPool.report(),
  }));
}
const setMargin = (m) => page.evaluate((v) => { __district.lightPool.swapMargin = v; }, m);
const sameSlots = (a, b) => a.every((v, i) => v === b[i]);
const sameSet = (a, b) => {
  const A = [...a].filter((v) => v >= 0).sort((x, y) => x - y);
  const B = [...b].filter((v) => v >= 0).sort((x, y) => x - y);
  return A.length === B.length && A.every((v, i) => v === B[i]);
};

// ---- find a heading the selection actually switches across --------------
await setMargin(0);
let boundary = null, prev = (await lookAt(0)).assigned;
for (let deg = 1; deg <= 360 && boundary === null; deg++) {
  const s = (await lookAt(deg)).assigned;
  if (!sameSet(s, prev)) boundary = deg;
  prev = s;
}
if (boundary === null) throw new Error('no switching heading found - nothing to test hysteresis on');
console.log(`switching heading at margin 0: ${boundary} deg`);

// ---- the two-path sweep -------------------------------------------------
async function sweep(margin) {
  await setMargin(margin);
  const lo = boundary - HALF_WINDOW_DEG, hi = boundary + HALF_WINDOW_DEG;
  const angles = [];
  for (let a = lo; a <= hi + 1e-9; a += STEP_DEG) angles.push(+a.toFixed(3));
  // Approach the window from well below so the state entering it is the
  // low-side state, not whatever the previous experiment left behind.
  await lookAt(lo - 6);
  const up = [];
  for (const a of angles) up.push((await lookAt(a)).assigned);
  await lookAt(hi + 6);
  const down = [];
  for (let i = angles.length - 1; i >= 0; i--) down[i] = (await lookAt(angles[i])).assigned;

  let disagree = 0;
  const disagreeAngles = [];
  for (let i = 0; i < angles.length; i++) {
    if (!sameSet(up[i], down[i])) { disagree++; disagreeAngles.push(angles[i]); }
  }
  const switches = (series) => {
    const at = [];
    for (let i = 1; i < series.length; i++) if (!sameSet(series[i], series[i - 1])) at.push(angles[i]);
    return at;
  };
  const distinct = new Set(up.concat(down).map((s) => [...s].filter((v) => v >= 0).sort((a, b) => a - b).join(','))).size;
  return {
    margin,
    steps: angles.length,
    // Path dependence: the same heading giving a different lit set depending on
    // which way the camera arrived at it. THIS is hysteresis; a threshold that
    // merely sits somewhere else cannot produce it.
    pathDependentAngles: disagree,
    pathDependentDeg: +(disagree * STEP_DEG).toFixed(2),
    disagreeSpan: disagreeAngles.length
      ? [disagreeAngles[0], disagreeAngles[disagreeAngles.length - 1]] : null,
    switchAnglesUp: switches(up),
    switchAnglesDown: switches(down),
    distinctSets: distinct,
  };
}
const sweeps = { margin8: await sweep(8), margin0: await sweep(0) };
console.log('\n=== TWO-PATH SWEEP (up through the boundary, then back down) ===');
console.log(JSON.stringify(sweeps, null, 1));

// ---- churn under dither, all four cells ---------------------------------
// A margin that only MOVES the threshold would churn just as hard when the
// dither is centred on its own boundary. That is why both centres are tested.
const band = sweeps.margin8.disagreeSpan;
const bandCentre = band ? (band[0] + band[1]) / 2 : boundary;
async function dither(margin, centre) {
  await setMargin(margin);
  await lookAt(centre - DITHER_DEG);
  let prevSet = (await lookAt(centre)).assigned;
  let slotChanges = 0, setChanges = 0, wasted = 0, active = 0;
  const seen = new Set();
  for (let k = 0; k < DITHER_SAMPLES; k++) {
    const th = centre + DITHER_DEG * Math.sin((k / DITHER_SAMPLES) * Math.PI * 2 * 6);
    const { assigned, report } = await lookAt(th);
    if (!sameSlots(assigned, prevSet)) slotChanges += assigned.filter((v, i) => v !== prevSet[i]).length;
    if (!sameSet(assigned, prevSet)) setChanges++;
    if (report.illuminating !== null) { wasted += report.active - report.illuminating; active += report.active; }
    seen.add([...assigned].filter((v) => v >= 0).sort((a, b) => a - b).join(','));
    prevSet = assigned;
  }
  return {
    margin, centre: +centre.toFixed(2), samples: DITHER_SAMPLES,
    slotReassignments: slotChanges,
    slotReassignmentsPerSample: +(slotChanges / DITHER_SAMPLES).toFixed(3),
    setChanges, distinctSets: seen.size,
    wastedSlotsPerSample: +(wasted / DITHER_SAMPLES).toFixed(3),
    litPerSample: +(active / DITHER_SAMPLES).toFixed(2),
  };
}
const churn = {
  atMargin0Boundary: { margin8: await dither(8, boundary), margin0: await dither(0, boundary) },
  atMargin8Band: { margin8: await dither(8, bandCentre), margin0: await dither(0, bandCentre) },
};
console.log('\n=== CHURN UNDER DITHER (slot reassignments) ===');
console.log(JSON.stringify(churn, null, 1));

// ---- what the margin costs when the camera is NOT moving ----------------
// The band lets a lamp that has stopped reaching the view hold its slot for
// another swapMargin metres. Stationary, that is pure loss, so count it.
async function stationaryCost(margin) {
  await setMargin(margin);
  let wasted = 0, active = 0, n = 0;
  for (let deg = 0; deg < 360; deg += 15) {
    // Arrive at each heading from the same side so incumbency is comparable.
    await lookAt(deg - 5);
    const { report } = await lookAt(deg);
    if (report.illuminating === null) continue;
    wasted += report.active - report.illuminating; active += report.active; n++;
  }
  return { margin, headings: n, litTotal: active, wastedTotal: wasted,
           wastedPerHeading: +(wasted / n).toFixed(2) };
}
const cost = { margin8: await stationaryCost(8), margin0: await stationaryCost(0) };
console.log('\n=== STATIONARY COST (lit lights that cannot reach the view) ===');
console.log(JSON.stringify(cost, null, 1));

await setMargin(8);

// ---- can the rig read the opposite? -------------------------------------
// Every zero above is only worth something if a non-zero was reachable by the
// same counters. These are the assertions, not decoration.
const instrument = {
  churnCounterEverNonZero:
    Object.values(churn).some((c) => Object.values(c).some((v) => v.slotReassignments > 0)),
  sweepSawMoreThanOneSet: sweeps.margin0.distinctSets > 1 && sweeps.margin8.distinctSets > 1,
  margin0IsPathIndependent: sweeps.margin0.pathDependentAngles === 0,
  margin8IsPathDependent: sweeps.margin8.pathDependentAngles > 0,
};
instrument.valid = instrument.churnCounterEverNonZero && instrument.sweepSawMoreThanOneSet;
instrument.hysteresisDemonstrated = instrument.valid &&
  instrument.margin8IsPathDependent && instrument.margin0IsPathIndependent;
console.log('\n=== INSTRUMENT ===');
console.log(JSON.stringify(instrument, null, 1));

fs.writeFileSync('docs/lamp-hysteresis.json', JSON.stringify({
  camera: HERO, streamed, boundaryDeg: boundary, stepDeg: STEP_DEG,
  sweeps, churn, cost, instrument, errors,
}, null, 1));
await browser.close();
console.log('\nwrote docs/lamp-hysteresis.json');
console.log(instrument.hysteresisDemonstrated
  ? 'HYSTERESIS DEMONSTRATED - swapMargin makes the same heading give a different set depending on approach'
  : instrument.valid
    ? 'NO HYSTERESIS - the counters moved, so the null is the code, not the rig'
    : 'RIG INVALID - nothing moved; this run says nothing either way');
if (errors.length) console.log('PAGE ERRORS', errors.slice(0, 5));
