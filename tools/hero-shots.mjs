// Clean captures for visual critique: no HUD, framed from the street, at two
// times of day. Every capture is paired with a scene-graph audit written next to
// it, because a critic's diagnosis is a hypothesis until it is audited.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.HERO_TIMES ?? 'dusk,night,noon').split(',');
const TAG = process.env.HERO_TAG ?? 'hero';

await ensureServer();
const browser = await chromium.launch(launchOptions());
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
  const placed = await page.evaluate((cfg) => {
    const r = __district.district.meta.route;
    const a = r[cfg.wpA], b = r[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;

    // Keep the camera OUT of the buildings.
    //
    // `back` extrapolates in a straight line from a route waypoint, and the route
    // bends: at back = 34 the corridor camera stood 3.7 m inside building 67's
    // footprint (an 8-point concave block). Walls are single-sided, so from in
    // there the block's own facades vanish and its awnings, cornice and parapet
    // are left hanging over the street with nothing under them. Three rounds of
    // blind critics reported that frame as floating props and an untethered
    // rooftop slab; it is the camera, not the geometry. A hero shot is a
    // measuring instrument, and one standing inside a wall manufactures exactly
    // the defect class it is being used to look for.
    const inRing = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    // Signed clearance to the nearest footprint: negative inside, metres outside.
    // Distance, not just in/out — a camera pressed flat against a wall is as
    // useless a hero frame as one buried in it.
    const segDist = (px, pz, x0, z0, x1, z1) => {
      const vx = x1 - x0, vz = z1 - z0;
      const l2 = vx * vx + vz * vz;
      const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
      return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
    };
    const clearance = (x, z) => {
      const [cx, cz] = __district.world.keyOf(x, z).split(',').map(Number);
      let best = Infinity, worst = -1;
      for (let ddz = -1; ddz <= 1; ddz++) {
        for (let ddx = -1; ddx <= 1; ddx++) {
          const c = __district.district.chunks[`${cx + ddx},${cz + ddz}`];
          if (!c) continue;
          for (const bi of c.buildings) {
            const ring = __district.district.buildings[bi].p;
            let d = Infinity;
            for (let i = 0; i < ring.length; i++) {
              const A = ring[i], B = ring[(i + 1) % ring.length];
              d = Math.min(d, segDist(x, z, A[0], A[1], B[0], B[1]));
            }
            if (inRing(ring, x, z)) { worst = bi; d = -d; }
            if (d < best) { best = d; }
          }
        }
      }
      return { d: best === Infinity ? 99 : best, inside: worst };
    };
    const MIN_CLEAR = 3.0;                  // metres of pavement around the camera
    let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
    for (;;) {
      px = a.x - (dx / len) * back + nx * cfg.side;
      pz = a.z - (dz / len) * back + nz * cfg.side;
      cl = clearance(px, pz);
      if (cl.d >= MIN_CLEAR || back <= 8) break;
      back -= 1;
    }
    const hit = cl.inside;

    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam(
      [px, cfg.height, pz],
      [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd],
      cfg.fov
    );
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { back, requestedBack: cfg.back, x: +px.toFixed(1), z: +pz.toFixed(1),
      clearance: +cl.d.toFixed(1), stillInside: cl.d >= MIN_CLEAR ? -1 : hit };
  }, s);
  console.log(`${s.name}: camera at (${placed.x}, ${placed.z}), back ${placed.back}, ` +
    `${placed.clearance} m clear of the nearest footprint` +
    (placed.back !== placed.requestedBack ? ` (pulled in from ${placed.requestedBack})` : '') +
    (placed.stillInside >= 0 ? `  WARNING: still inside building ${placed.stillInside}` : ''));
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
