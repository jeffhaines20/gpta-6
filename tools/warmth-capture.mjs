// The rendering half of tools/warmth-probe.mjs: the paired arms the split needs,
// plus the light rig's own numbers.
//
// THREE ARMS AT ONE CAMERA, IN ONE PAGE LOAD.
//   base      the shipped frame
//   nosun     every DirectionalLight at intensity 0 - what the SHADE is lit by
//   noshadow  every caster's castShadow off - where the sun is currently blocked
//
// All three are reversible mutations restored from a snapshot, so the arms are
// three states of ONE settled scene rather than three page loads that each
// streamed a slightly different district. It also captures `base2` - the base
// arm again, after the same delay - as a NOISE FLOOR, because an A/B whose
// difference is smaller than its own repeat noise is not a measurement.
//
// WARMTH_PORT, not 8123. tools/serve.mjs verifies the document root by writing a
// token into the tree and reading it back, and 8123 belongs to the main tree; a
// run that reused it would photograph a different commit and the frames would
// look fine.
import { chromium } from 'playwright';
import fs from 'node:fs';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const OUT = 'docs/shots';
const TAG = process.env.WARMTH_TAG ?? 'w0';
const TIMES = (process.env.WARMTH_TIMES ?? 'noon,golden').split(',').map((s) => s.trim()).filter(Boolean);
const PORT = Number(process.env.WARMTH_PORT ?? 8177);

// Identical to tools/hero-shots.mjs's two framings, including the clearance
// pull-in, so the frames are comparable with every other capture this round.
const SHOTS = [
  { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];

const PLACE = (cfg) => {
  const r = __district.district.meta.route;
  const a = r[cfg.wpA], b = r[cfg.wpB];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const segDist = (px, pz, x0, z0, x1, z1) => {
    const vx = x1 - x0, vz = z1 - z0, l2 = vx * vx + vz * vz;
    const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
    return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
  };
  const clearance = (x, z) => {
    const [cx, cz] = __district.world.keyOf(x, z).split(',').map(Number);
    let best = Infinity, worst = -1;
    for (let ddz = -1; ddz <= 1; ddz++) for (let ddx = -1; ddx <= 1; ddx++) {
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
        if (d < best) best = d;
      }
    }
    return { d: best === Infinity ? 99 : best, inside: worst };
  };
  let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
  for (;;) {
    px = a.x - (dx / len) * back + nx * cfg.side;
    pz = a.z - (dz / len) * back + nz * cfg.side;
    cl = clearance(px, pz);
    if (cl.d >= 3.0 || back <= 8) break;
    back -= 1;
  }
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { x: +px.toFixed(1), z: +pz.toFixed(1), back, clearance: +cl.d.toFixed(1) };
};

// The mutations, as (apply -> restore) pairs evaluated in the page. Each returns
// a snapshot its own restore consumes, so nothing is left behind for the next
// arm or the next hour.
const ARMS = {
  nosun: {
    on: () => { const s = []; __district.scene.traverse((o) => {
      if (o.isDirectionalLight) { s.push([o.uuid, o.intensity]); o.intensity = 0; } });
      window.__warmthSnap = s; return s.length; },
    off: () => { const m = new Map(window.__warmthSnap);
      __district.scene.traverse((o) => { if (m.has(o.uuid)) o.intensity = m.get(o.uuid); });
      delete window.__warmthSnap; },
  },
  // castShadow off rather than shadowMap.enabled off: disabling the map would
  // need every material recompiled to stop sampling it, and an empty map is the
  // same picture with none of that risk. needsUpdate forces the (now empty) map
  // to be re-rendered before the screenshot.
  noshadow: {
    on: () => { const s = []; __district.scene.traverse((o) => {
      if (o.castShadow) { s.push(o.uuid); o.castShadow = false; } });
      __district.renderer.shadowMap.needsUpdate = true;
      window.__warmthSnap = s; return s.length; },
    off: () => { const set = new Set(window.__warmthSnap);
      __district.scene.traverse((o) => { if (set.has(o.uuid)) o.castShadow = true; });
      __district.renderer.shadowMap.needsUpdate = true;
      delete window.__warmthSnap; },
  },
};

export async function run() {
  fs.mkdirSync(OUT, { recursive: true });
  await ensureServer(PORT);
  const browser = await chromium.launch(launchOptions());
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
  await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 120000 });
  await page.addStyleTag({ content: '#attr{display:none!important}' });
  await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });

  const audits = {};
  const meta = { tag: TAG, port: PORT, times: TIMES, cameras: {}, arms: {}, errors };
  for (const s of SHOTS) {
    meta.cameras[s.name] = await page.evaluate(PLACE, s);
    console.log(`${s.name}: camera at (${meta.cameras[s.name].x}, ${meta.cameras[s.name].z}), ` +
      `${meta.cameras[s.name].clearance} m clear`);
    await page.waitForTimeout(14000);
    for (const tod of TIMES) {
      await page.evaluate((t) => __district.setTimeOfDay(t), tod);
      await page.waitForTimeout(16000);
      if (!audits[tod]) audits[tod] = await page.evaluate(() => __district.audit());
      await page.screenshot({ path: `${OUT}/${TAG}-${s.name}-${tod}.png`, timeout: 150000 });
      // The noise floor: the same state, the same wait, a second frame. Anything
      // the arms below report that is not bigger than this is not a finding.
      await page.waitForTimeout(2500);
      await page.screenshot({ path: `${OUT}/${TAG}-base2-${s.name}-${tod}.png`, timeout: 150000 });
      for (const [arm, fns] of Object.entries(ARMS)) {
        const n = await page.evaluate(`(${fns.on.toString()})()`);
        meta.arms[`${arm}-${s.name}-${tod}`] = n;
        await page.waitForTimeout(2500);
        await page.screenshot({ path: `${OUT}/${TAG}-${arm}-${s.name}-${tod}.png`, timeout: 150000 });
        await page.evaluate(`(${fns.off.toString()})()`);
        await page.waitForTimeout(2000);
      }
      console.log(`  ${tod}: base, base2, ${Object.keys(ARMS).join(', ')}`);
    }
  }
  await browser.close();
  fs.mkdirSync('docs/measurements', { recursive: true });
  fs.writeFileSync(`docs/measurements/warmth-rig-${TAG}.json`,
    JSON.stringify({ ...meta, audits }, null, 1));
  console.log(`\nwrote docs/measurements/warmth-rig-${TAG}.json`);
  if (errors.length) console.log('PAGE ERRORS:', errors.slice(0, 5));
}

if (process.argv[1] && process.argv[1].endsWith('warmth-capture.mjs')) await run();
