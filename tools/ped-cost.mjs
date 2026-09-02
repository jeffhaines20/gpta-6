// What does the pedestrian near LOD actually cost in a frame?
//
// Not "compare today's drive-through artifact against the one in the ledger" -
// that artifact predates several commits from other work on this branch, and the
// crowd is only one of the things that moved. This is a PAIRED reading instead:
// the same camera, the same frame, the same traffic, toggling only
// Pedestrians.setNearLod(0) (which is exactly the geometry that shipped before
// the near tier existed) against the default pool.
//
// Reads renderStats(), which snapshots PostStack's counters right after the
// scene render - never renderer.info directly, which after the composite blit
// describes a 1-triangle fullscreen pass.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const TRAFFIC = Number(process.env.COST_TRAFFIC ?? 30);
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr,#hud,.pv-hud{display:none!important}' });
await page.evaluate((n) => __district.setTraffic(n), TRAFFIC);
await page.evaluate((t) => __district.setTimeOfDay(t), process.env.COST_TOD ?? 'dusk');

const SHOTS = [
  { name: 'corridor', wpA: 2, wpB: 4, back: 34, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];

const rows = [];
for (const s of SHOTS) {
  await page.evaluate((cfg) => {
    const r = __district.district.meta.route;
    const a = r[cfg.wpA], b = r[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;
    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam(
      [a.x - (dx / len) * cfg.back + nx * cfg.side, cfg.height, a.z - (dz / len) * cfg.back + nz * cfg.side],
      [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  }, s);
  await page.waitForTimeout(20000);

  // Sample each arm several times: the crowd keeps walking, so one frame is one
  // crowd configuration and the near tier's cost depends on how many people are
  // standing close to the lens.
  const sample = async (lod) => {
    await page.evaluate((k) => __district.pedestrians().setNearLod(k), lod);
    await page.waitForTimeout(2500);
    const out = [];
    for (let i = 0; i < 5; i++) {
      out.push(await page.evaluate(() => {
        const r = __district.renderStats();
        const p = __district.pedestrianReport();
        return { tris: r.triangles, calls: r.calls, sceneCalls: r.sceneCalls,
          nearLive: p.nearLod.live, alive: p.alive };
      }));
      await page.waitForTimeout(900);
    }
    return out;
  };
  const off = await sample(0);
  const on = await sample(-1);
  const med = (a, k) => a.map((r) => r[k]).sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const row = {
    shot: s.name,
    farOnly: { tris: med(off, 'tris'), calls: med(off, 'calls'), sceneCalls: med(off, 'sceneCalls') },
    withNear: { tris: med(on, 'tris'), calls: med(on, 'calls'), sceneCalls: med(on, 'sceneCalls'),
      nearLive: med(on, 'nearLive') },
    alive: med(on, 'alive'),
  };
  row.deltaTris = row.withNear.tris - row.farOnly.tris;
  row.deltaCalls = row.withNear.calls - row.farOnly.calls;
  rows.push(row);
  console.log(`${s.name.padEnd(11)} far-only ${row.farOnly.tris} tris / ${row.farOnly.calls} calls   ` +
    `with near ${row.withNear.tris} tris / ${row.withNear.calls} calls   ` +
    `delta +${row.deltaTris} tris, +${row.deltaCalls} calls   ` +
    `(${row.withNear.nearLive} of ${row.alive} peds on the near tier)`);
}

const lod = await page.evaluate(() => __district.pedestrianReport().nearLod);
console.log('\naccounting:', JSON.stringify(lod));
fs.writeFileSync('docs/ped-cost.json', JSON.stringify({ traffic: TRAFFIC, rows, lod }, null, 1));
console.log('wrote docs/ped-cost.json');
await browser.close();
