// Time-of-day sweep. For each preset: same camera looking down the Main Street
// corridor, one screenshot, and a full scene-graph audit with intensities in
// physical units.
//
// This exists because of the Phase 1 incident: a blind visual critique read a
// mis-tuned light constant as an entirely missing lighting subsystem. Pairing
// every capture with an audit makes that mistake impossible to repeat.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

// SWEEP_PORT for the same reason tools/hero-shots.mjs has HERO_PORT and
// tools/smoke.mjs has SMOKE_PORT: this gate is run from worktrees, 8123 is the
// main tree's port, and a run that reused it would gate the wrong commit. The
// DEFAULT is unchanged, so CI and every existing invocation behave identically;
// tools/serve.mjs now refuses the reuse outright rather than photographing
// somebody else's tree, so the env var is the way out rather than the guard.
const SWEEP_PORT = Number(process.env.SWEEP_PORT ?? 8123);
await ensureServer(SWEEP_PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${SWEEP_PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

// Park on the Main Street corridor just west of Five Points, looking east
// down the corridor. Identical camera for every capture.
const CAM = await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];                        // Main St @ Pineapple Ave -> Main St east
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  // Sit ON the road vertex looking down the corridor: offsetting backwards put
  // the camera inside a building footprint.
  const nx = -dz / len, nz = dx / len;      // across the carriageway
  const pos = [a.x - (dx / len) * 26 + nx * 5.5, 5.2, a.z - (dz / len) * 26 + nz * 5.5];
  const tgt = [a.x + (dx / len) * 300, 14, a.z + (dz / len) * 300];
  __district.freeCam(pos, tgt, 48);
  return { pos, tgt, from: a, to: b };
});

// Let the streamer fill in around the parked camera.
await page.evaluate(() => { for (let i = 0; i < 200; i++) __district.world.update(__district.vehicle.position); });
await page.waitForTimeout(20000);

const results = [];
for (const tod of ['noon', 'golden', 'dusk', 'night']) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(16000);
  const audit = await page.evaluate(() => __district.audit());
  const render = await page.evaluate(() => __district.renderStats());
  const world = await page.evaluate(() => __district.worldReport());
  await page.screenshot({ path: `${OUT}/tod-${tod}.png`, timeout: 150000 });
  results.push({ tod, audit, render, chunks: world.chunksLoaded });
  console.log(`\n=== ${tod.toUpperCase()} ===`);
  console.log(JSON.stringify(audit, null, 1));
}

const flagged = results.filter((r) => r.audit.implausible.length);
const summary = {
  camera: CAM,
  presets: results.map((r) => ({
    tod: r.tod,
    sunLux: r.audit.sunLux, skyLux: r.audit.skyLux,
    // What the sky DELIVERS to a horizontal surface, over every path carrying it.
    // skyLux above is the HemisphereLight's raw intensity and is 0 whenever the
    // dome's PMREM is doing the delivering, which is the normal case in the
    // district; this is the photometric number the envelope judges.
    skyDelivered: r.audit.skyDelivery ? r.audit.skyDelivery.totalLux : r.audit.skyLuxDelivered,
    skyPaths: r.audit.skyDelivery ? r.audit.skyDelivery.paths : null,
    // The district's own interreflection: the one light in the scene that is
    // neither the sky nor the sun. It is what an UP-FACING shaded surface is lit
    // by that the dome cannot deliver - the dome's ground term writes below the
    // horizon and so reaches only vertical and downward normals. Recorded here
    // because the dome's own version of this term sat at 0.03 nits through the
    // whole of dusk for months with nothing reporting it.
    bounceLux: r.audit.bounceDelivery ? r.audit.bounceDelivery.lux : null,
    bounceShareOfSky: r.audit.bounceDelivery ? r.audit.bounceDelivery.shareOfSky : null,
    bounceBlueOverRed: r.audit.bounceDelivery ? r.audit.bounceDelivery.blueOverRed : null,
    // The MS whitening's own proof that it is purely chromatic. See below.
    msWhiten: r.audit.sky ? r.audit.sky.msWhiten : null,
    litLamps: r.audit.litPointLights, lampCandela: r.audit.samplePointLightCandela,
    exposure: r.audit.exposureAsStop,
    // The stop as a NUMBER as well as the string. "1/1" is what
    // Math.round(1/(1/1.15)) prints, and every tool that parsed the string back
    // was therefore reading night 15% off - tools/tod-readability.mjs's night
    // nits column and tools/transfer-audit.mjs --solve both did.
    exposureValue: r.audit.exposure,
    toneMapping: r.audit.toneMapping,
    lights: r.audit.lightCount, shadowCasters: r.audit.shadowCasters,
    drawCalls: r.render.calls, triangles: r.render.triangles,
    implausible: r.audit.implausible,
  })),
  anyImplausible: flagged.length > 0,
  errors,
};
fs.writeFileSync('docs/daynight.json', JSON.stringify(summary, null, 1));
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify(summary.presets, null, 1));
console.log(flagged.length ? `\nIMPLAUSIBLE AT: ${flagged.map((f) => f.tod).join(', ')}` : `\nAll ${results.length} times of day within the plausible envelope.`);
// --- NEGATIVE TEST -------------------------------------------------------
// Re-inject the exact Phase 1 failure (street lamps at 26 cd) and confirm the
// plausibility checker flags it. A checker that has never failed is not a check.
await page.evaluate(() => __district.setTimeOfDay('night'));
await page.waitForTimeout(1500);
const injected = await page.evaluate(() => {
  __district.scene.traverse((o) => { if (o.isPointLight && o.intensity > 0) o.intensity = 26; });
  return __district.audit();
});
const caught = injected.implausible.length > 0;
console.log('\n=== NEGATIVE TEST: Phase 1 mis-tuning (lamps at 26 cd) ===');
console.log(caught ? `CAUGHT: ${injected.implausible[0]}` : 'NOT CAUGHT — the checker is useless');
fs.writeFileSync('docs/daynight-negative.json', JSON.stringify({
  injectedCandela: 26, caught, flags: injected.implausible.slice(0, 3),
  totalFlags: injected.implausible.length,
}, null, 1));

// --- NEGATIVE TEST 2: the double delivery ---------------------------------
// The envelope used to judge the HemisphereLight's raw intensity, which meant it
// read PASS on a build that put 14,067 lux of sky on golden hour against a
// 5,500-11,800 envelope. It now judges the DELIVERED total and counts how many
// paths deliver it. Asserting that in a comment is not the same as showing it, so
// this re-injects exactly the configuration that was removed - the hemisphere back
// at the preset's skyLux with the environment untouched - and requires the checker
// to fire on it.
await page.evaluate(() => __district.setTimeOfDay('golden'));
await page.waitForTimeout(2500);
const doubled = await page.evaluate(() => {
  const tod = __district.tod;
  tod.hemi.intensity = tod.preset.skyLux;
  const a = __district.audit();
  return { flags: a.implausible, delivery: a.skyDelivery };
});
const caughtDouble = doubled.flags.some((f) => /delivered 2 times|delivers .* outside plausible/.test(f));
console.log('\n=== NEGATIVE TEST 2: the sky delivered twice (the state this build removed) ===');
console.log(JSON.stringify(doubled, null, 1));
console.log(caughtDouble ? 'CAUGHT' : 'NOT CAUGHT — the delivered-sky assertion is useless');
fs.writeFileSync('docs/daynight-negative-sky.json', JSON.stringify({
  injected: 'HemisphereLight restored to preset.skyLux at golden, environment untouched',
  caught: caughtDouble, ...doubled,
}, null, 1));

// --- NEGATIVE TEST 3: the bounce that quietly went to zero ---------------
// src/sky.js's own ground bounce sat at 0.03 nits through the whole of dusk for
// months - the sky half of its E was uSunIlluminance * 0.16 * sin(elevation) and
// the dusk preset puts the sun at elevation exactly 0 - and the only reason it
// went unnoticed that long is that nothing reported the number. The district's
// interreflection is now a light with the same failure mode: it is a product of
// three terms, and any of them going to zero leaves every up-facing shaded
// surface lit by the open sky alone, which is the defect this round was opened
// for. So the envelope has to fire on that, and this proves it does by writing
// the zero in.
await page.evaluate(() => __district.setTimeOfDay('noon'));
await page.waitForTimeout(2500);
const noBounce = await page.evaluate(() => {
  const tod = __district.tod;
  tod.bounce.intensity = 0;
  const a = tod.audit();
  return { flags: a.implausible, bounce: a.bounceDelivery };
});
const caughtBounce = noBounce.flags.some((f) => /district bounce light delivers|the bounce light delivers/.test(f));
console.log('\n=== NEGATIVE TEST 3: the district bounce switched off ===');
console.log(JSON.stringify(noBounce, null, 1));
console.log(caughtBounce ? 'CAUGHT' : 'NOT CAUGHT — the bounce assertion is useless');
fs.writeFileSync('docs/daynight-negative-bounce.json', JSON.stringify({
  injected: 'bounce light intensity forced to 0 at noon',
  caught: caughtBounce, ...noBounce,
}, null, 1));

// --- THE MS WHITENING IS PURELY CHROMATIC, MEASURED AS AN A/B -------------
// src/sky.js softens uBetaR toward its own luminance for the MULTIPLY-scattered
// term, and that is the entire reason a hue change of this size is allowed to
// leave PLAUSIBLE and PLAUSIBLE_SKY exactly where they are: skyLux, zenithNits
// and horizonNits must not move.
//
// The first version of that change asserted the property "by construction" and
// was WRONG - msR and the MS tint are both per-channel, so the luminance of their
// product with beta is not the product of their luminances, and the un-normalised
// mix moved golden's skyLux by 2.7% and dusk's by 5.3%. The shader now rescales
// the whitened term against the un-whitened one per texel, which makes the
// residual zero by construction, and reporting a by-construction zero would only
// report the construction back. So this refreshes the LUT at msWhiten 0 and at
// the authored value and compares the dome's own integrals.
//
// TWO-SIDED. It fails if the photometry moves AND if the hue does not: "nothing
// moved" is also what a whitening wired to nothing produces, and that would read
// as a pass forever.
await page.evaluate(() => __district.setTimeOfDay('golden'));
await page.waitForTimeout(2500);
const chromaAB = await page.evaluate(() => {
  const sky = __district.sky;
  const read = () => {
    const a = sky.audit();
    return { skyLux: a.skyLux, zenithNits: a.zenithNits, horizonNits: a.horizonNits,
      ambientChroma: a.ambientChroma, zenithChroma: a.zenithChroma, horizonChroma: a.horizonChroma,
      applied: a.msWhiten ? a.msWhiten.applied : null, betaBlueOverRed: a.msWhiten ? a.msWhiten.blueOverRed : null };
  };
  const authored = sky.msWhiten;
  // environment:false - the PMREM is 108-181 ms and nothing here reads it.
  sky.msWhiten = 0; sky.refresh({ force: true, environment: false });
  const off = read();
  sky.msWhiten = authored; sky.refresh({ force: true, environment: false });
  const on = read();
  return { authored, off, on };
});
const rel = (a, b) => Math.abs(a - b) / Math.max(1e-9, Math.abs(b));
const photometryMoved = ['skyLux', 'zenithNits', 'horizonNits']
  .map((k) => [k, rel(chromaAB.on[k], chromaAB.off[k])])
  .filter(([, r]) => r > 0.005);
const hueMoved = Math.abs(chromaAB.on.ambientChroma - chromaAB.off.ambientChroma) > 0.05;
console.log('\n=== MS WHITENING A/B AT GOLDEN (msWhiten 0 against the authored value) ===');
console.log(JSON.stringify(chromaAB, null, 1));
console.log(photometryMoved.length
  ? `NOT PURELY CHROMATIC: ${photometryMoved.map(([k, r]) => `${k} moved ${(r * 100).toFixed(2)}%`).join(', ')}`
  : 'PHOTOMETRY HELD: skyLux, zenith and horizon within 0.5%.');
console.log(hueMoved
  ? `HUE MOVED: hemispherical ambient chroma ${chromaAB.off.ambientChroma} -> ${chromaAB.on.ambientChroma}`
  : 'HUE DID NOT MOVE — the whitening is wired to nothing and this assertion is useless');
fs.writeFileSync('docs/daynight-mswhiten.json', JSON.stringify({
  ...chromaAB, photometryMoved, hueMoved,
  perPreset: summary.presets.map((p) => ({ tod: p.tod, ...(p.msWhiten ?? {}) })),
}, null, 1));
const chromaOk = photometryMoved.length === 0 && hueMoved;

await browser.close();

// The lighting sweep is a gate, not a report. It fails if any preset is
// implausible, if any negative test stops catching what it was written for - a
// checker that has stopped failing is not a checker - or if the MS whitening has
// stopped being luminance-preserving.
const pass = flagged.length === 0 && caught && caughtDouble && caughtBounce && chromaOk;
console.log(`\nLIGHTING SWEEP: ${pass ? 'PASS' : 'FAIL'}` +
  (flagged.length ? ` — implausible at ${flagged.map((f) => f.tod).join(', ')}` : '') +
  (caught ? '' : ' — NEGATIVE TEST 1 (lamps at 26 cd) DID NOT FIRE') +
  (caughtDouble ? '' : ' — NEGATIVE TEST 2 (sky delivered twice) DID NOT FIRE') +
  (caughtBounce ? '' : ' — NEGATIVE TEST 3 (bounce switched off) DID NOT FIRE') +
  (chromaOk ? '' : ' — MS WHITENING A/B FAILED (photometry moved, or hue did not)'));
process.exit(pass ? 0 : 1);
