// Time-of-day sweep. For each preset: same camera looking down the Marlin Street
// corridor, one screenshot, and a full scene-graph audit with intensities in
// physical units.
//
// This exists because of the Phase 1 incident: a blind visual critique read a
// mis-tuned light constant as an entirely missing lighting subsystem. Pairing
// every capture with an audit makes that mistake impossible to repeat.
import { chromium } from 'playwright';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 810 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

// Park on the Marlin Street corridor just west of Five Points, looking east
// down the corridor. Identical camera for all three captures.
const CAM = await page.evaluate(() => {
  const r = __district.district.meta.route;
  const a = r[2], b = r[4];                        // Marlin St @ Tarpon Row -> Marlin St east
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  const dx = b.x - a.x, dz = b.z - a.z;
  const len = Math.hypot(dx, dz);
  // Sit ON the road vertex looking down the corridor: offsetting backwards put
  // the camera inside a building footprint.
  const pos = [a.x, 9.5, a.z];
  const tgt = [a.x + (dx / len) * 420, 6, a.z + (dz / len) * 420];
  __district.freeCam(pos, tgt, 52);
  return { pos, tgt, from: a, to: b };
});

// Let the streamer fill in around the parked camera.
await page.evaluate(() => { for (let i = 0; i < 200; i++) __district.world.update(__district.vehicle.position); });
await page.waitForTimeout(9000);

const results = [];
for (const tod of ['noon', 'dusk', 'night']) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(9000);
  const audit = await page.evaluate(() => __district.audit());
  const render = await page.evaluate(() => __district.renderStats());
  const world = await page.evaluate(() => __district.worldReport());
  await page.screenshot({ path: `${OUT}/tod-${tod}.png` });
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
    litLamps: r.audit.litPointLights, lampCandela: r.audit.samplePointLightCandela,
    exposure: r.audit.exposureAsStop, toneMapping: r.audit.toneMapping,
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
console.log(flagged.length ? `\nIMPLAUSIBLE AT: ${flagged.map((f) => f.tod).join(', ')}` : '\nAll three times of day within the plausible envelope.');
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

await browser.close();
