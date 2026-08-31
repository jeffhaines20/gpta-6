// Does the lighting the audit REPORTS actually reach the frame?
//
// Four blind critics, across two rounds, reported "no shadow map bound" and "no
// ambient occlusion" on frames whose scene-graph audit says shadowMapEnabled:
// true with 87 casters and aoEnabled: true at strength 0.95. One of those two
// readings is wrong, and checking the flag again would not settle it — the audit
// records what is CONFIGURED, and the critics are describing what is VISIBLE.
//
// So this renders the identical camera four ways and diffs the pixels:
//   baseline / shadows off / AO off / lamps off
// A feature that changes nothing when disabled is not reaching the frame,
// whatever the audit says about it. That is the measurement, not the flag.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
const TOD = process.env.ISO_TOD ?? 'dusk';
fs.mkdirSync(OUT, { recursive: true });

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr{display:none!important},#hud,.pv-hud{display:none!important}' });
await page.evaluate((n) => __district.setTraffic(n), 30);
await page.waitForTimeout(6000);

// Same framing as the fivepoints hero shot, which is what the critics judged.
await page.evaluate(async (tod) => {
  __district.setTimeOfDay(tod);
  const d = __district.district;
  const wp = d.route ?? d.waypoints ?? null;
  const a = wp ? wp[3] : { x: 31.5, z: -156.8 };
  const b = wp ? wp[4] : { x: 60, z: -156.8 };
  __district.placeAt(a.x, a.z);
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  __district.setAutopilot?.(() => {});
  __district.freeCam([a.x - (dx / len) * 26, 3.0, a.z - (dz / len) * 26],
    [a.x + (dx / len) * 200, 12, a.z + (dz / len) * 200], 48);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
}, TOD);
await page.waitForTimeout(2500);

const variants = [
  ['baseline', () => {}],
  ['noshadow', () => { __district.renderer.shadowMap.enabled = false;
                       __district.scene.traverse((o) => { o.castShadow = false; }); }],
  ['noao',     () => { __district.post.params.aoEnabled = false; }],
  // NOT just zeroing intensity: LightPool.update() runs every frame and rewrites
  // intensity from the emitter's candela, so a zeroed light is back on before the
  // screenshot. Disabling the pool makes update() early-return, so the zero sticks.
  // params are re-read from post.params every frame by render(), so zeroing the
  // strength sticks - unlike PointLight.intensity, which the pool rewrites.
  ['nobloom',  () => { __district.post.params.bloomStrength = 0; }],
  // Which term actually colours an up-facing surface? The dusk preset carries a
  // cool skyColor and a warm sunColor, plus a PMREM built from the sky dome, so
  // "ambient is a constant grey" is a hypothesis to test, not a fact to act on.
  ['nohemi',   () => { __district.scene.traverse((o) => {
                         if (o.isHemisphereLight) o.intensity = 0; }); }],
  ['noenv',    () => { __district.scene.environmentIntensity = 0; }],
  ['nosun',    () => { __district.scene.traverse((o) => {
                         if (o.isDirectionalLight) o.intensity = 0; }); }],
  ['nolamps',  () => { __district.lightPool.enabled = false;
                       __district.scene.traverse((o) => {
                         if (o.isPointLight) { o.intensity = 0; o.visible = false; } }); }],
];

for (const [name, fn] of variants) {
  await page.evaluate(`(${fn.toString()})()`);
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${OUT}/iso-${TOD}-${name}.png` });
  console.log(`captured iso-${TOD}-${name}.png`);
  // Reload between variants so each is measured against a clean baseline.
  if (name !== variants[variants.length - 1][0]) {
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
    await page.addStyleTag({ content: '#attr{display:none!important},#hud,.pv-hud{display:none!important}' });
    await page.evaluate((n) => __district.setTraffic(n), 30);
    await page.waitForTimeout(5000);
    await page.evaluate(async (tod) => {
      __district.setTimeOfDay(tod);
      const d = __district.district;
      const wp = d.route ?? d.waypoints ?? null;
      const a = wp ? wp[3] : { x: 31.5, z: -156.8 };
      const b = wp ? wp[4] : { x: 60, z: -156.8 };
      __district.placeAt(a.x, a.z);
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      __district.setAutopilot?.(() => {});
      __district.freeCam([a.x - (dx / len) * 26, 3.0, a.z - (dz / len) * 26],
        [a.x + (dx / len) * 200, 12, a.z + (dz / len) * 200], 48);
      for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    }, TOD);
    await page.waitForTimeout(2500);
  }
}
await browser.close();
console.log('done');
