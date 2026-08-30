// Clean captures for visual critique: no HUD, framed from the street, at two
// times of day. Every capture is paired with a scene-graph audit written next to
// it, because a critic's diagnosis is a hypothesis until it is audited.
import { chromium } from 'playwright';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.HERO_TIMES ?? 'dusk,night,noon').split(',');
const TAG = process.env.HERO_TAG ?? 'hero';

await ensureServer();
const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });

// Hide the debug overlay: it is not part of what is being judged.
await page.addStyleTag({ content: '#attr{display:none!important}' });
if (process.env.HERO_HIDE_HUD === '1') {
  await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });
}
const HERO_TRAFFIC = Number(process.env.HERO_TRAFFIC ?? 0);
if (HERO_TRAFFIC > 0) {
  await page.evaluate((n) => __district.setTraffic(n), HERO_TRAFFIC);
  await page.waitForTimeout(6000);
}

// Stand in the carriageway on the Marlin Street corridor looking east toward
// Five Points, which is the district's hero view.
const shots = [
  { name: 'corridor', wpA: 2, wpB: 4, back: 34, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];

const results = [];
for (const s of shots) {
  await page.evaluate((cfg) => {
    const r = __district.district.meta.route;
    const a = r[cfg.wpA], b = r[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam(
      [a.x - (dx / len) * cfg.back + nx * cfg.side, cfg.height, a.z - (dz / len) * cfg.back + nz * cfg.side],
      [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd],
      cfg.fov
    );
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  }, s);
  await page.waitForTimeout(14000);

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(15000);
    const file = `${OUT}/${TAG}-${s.name}-${tod}.png`;
    await page.screenshot({ path: file, timeout: 180000 });
    const audit = await page.evaluate(() => {
      const a = __district.audit();
      const w = __district.worldReport();
      const r = __district.renderStats();
      let plain = 0, inst = 0, mats = new Set();
      __district.scene.traverse((o) => {
        if (o.isInstancedMesh) inst++; else if (o.isMesh) plain++;
        if (o.isMesh && o.material) mats.add(o.material.uuid);
      });
      return {
        ...a,
        drawCalls: r.calls, sceneCalls: r.sceneCalls, postPasses: r.postPasses, triangles: r.triangles,
        chunks: w.chunksLoaded, lodNear: w.lodNear, lodFar: w.lodFar,
        plainMeshes: plain, instancedMeshes: inst, distinctMaterialsInScene: mats.size,
        materialLibrary: w.materials,
      };
    });
    results.push({ shot: s.name, tod, file, audit });
    console.log(`${s.name}/${tod}: draw ${audit.drawCalls}, tris ${audit.triangles}, ` +
      `lights ${audit.lightCount}, lit lamps ${audit.litPointLights}, ` +
      `exposure ${audit.exposureAsStop}, implausible ${audit.implausible.length}`);
  }
}
fs.writeFileSync(`docs/${TAG}-audits.json`, JSON.stringify({ results, errors }, null, 1));
console.log(`\nwrote docs/${TAG}-audits.json (${results.length} captures)`);
await browser.close();
