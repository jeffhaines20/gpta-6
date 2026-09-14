// What the car lamp spill costs the budget gate, measured by TOGGLING IT in one
// live frame rather than by differencing two drive-throughs.
//
// The gate's triangle number is a near-maximum over ~51-89 coarse samples of a
// quantity that swings 41% of its own p50, and CLAUDE.md records a round losing
// four hours to a same-box baseline for a WARN that arithmetic disposed of in
// minutes. __district.setCarSpill(0|1) turns this round's only added geometry
// off and on with everything else - the same chunks resident, the same fleet in
// the same places, the same frame - so the difference IS the cost.
//
//   SPILLCOST_PORT=8177 node tools/spill-cost.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.SPILLCOST_PORT ?? 8179);
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.SPILLCOST_BOOT ?? 240000) });
const settle = async (n) => {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((t) => __district.frames >= t, f0 + n, { timeout: 600000 });
};
await page.evaluate(() => __district.setTraffic(30));
await settle(40);
// STAND THE PLAYER IN TRAFFIC BEFORE PRICING, or the price is zero for the
// wrong reason. Traffic._updateGlow ranks its spill slots by distance to the
// player, and at the boot position the nearest car is beyond the 110 m cut-off,
// so the first run of this tool priced the fleet's spill at 0 slots and read
// +128 triangles - the player's own glow mesh, twice counted through the two
// arms - which is a true number about an empty street and not the cost of
// anything. Put the player on Main Street east, let the fleet refill around it,
// and the slot occupancy is what a drive actually carries.
await page.evaluate(() => {
  const D = window.__district;
  const r = D.district.meta.route, a = r[3], b = r[4];
  const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  D.placeAt(a.x + ((b.x - a.x) / len) * 55, a.z + ((b.z - a.z) / len) * 55);
  D.setAutopilot(() => {});
  for (let i = 0; i < 900; i++) D.world.update(D.vehicle.position);
  for (let i = 0; i < 600; i++) D.traffic().update(0.05, D.vehicle.position);
});
await settle(10);

const rows = [];
for (const tod of ['dusk', 'night', 'noon']) {
  await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await settle(6);
  const r = {};
  for (const k of [0, 1]) {
    await page.evaluate((v) => __district.setCarSpill(v), k);
    await settle(3);
    r[k] = await page.evaluate(() => ({
      ...__district.renderStats(),
      glow: __district.trafficReport().glow,
    }));
  }
  rows.push({ tod, off: r[0], on: r[1] });
}
console.log('tod     spill   draw calls   scene triangles   glow slots  tris each');
for (const { tod, off, on } of rows) {
  for (const [name, v] of [['off', off], ['on', on]]) {
    console.log(`${tod.padEnd(7)} ${name.padEnd(6)} ${String(v.sceneCalls).padStart(10)}   `
      + `${String(v.triangles).padStart(15)}   ${String(v.glow.visible ? v.glow.used : 0).padStart(10)}  `
      + `${String(v.glow.trianglesEach).padStart(9)}`);
  }
  console.log(`${tod.padEnd(7)} DELTA  ${String(on.sceneCalls - off.sceneCalls).padStart(10)}   `
    + `${String(on.triangles - off.triangles).padStart(15)}`);
}
await browser.close();
