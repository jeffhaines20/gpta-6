// Anti-aliasing A/B/C/D, captured in ONE page load.
//
// Why one load: the district streams for ~30 s and the streamed set is not
// identical run to run, so four separate runs of hero-shots.mjs would differ in
// their geometry as well as in their AA. Here the camera is placed once, the
// world is settled once, and only the AA mode moves between captures.
//
// Arms: off | msaa | fxaa | msaa+fxaa   (src/post.js setAA)
//
// Every arm ASSERTS the toggle took. The switch is invoked as a real function
// object through page.evaluate - never as a string holding an arrow function,
// which this project has already lost an A/B to: Playwright evaluates the
// expression, builds a function object and throws it away, and both arms then
// silently measure the same thing. setAA returns the state it actually reached
// (samples read back off the render target, plus the renderer's own context
// attribute) and this harness refuses to capture an arm that does not match.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';

const OUT = 'docs/shots';
fs.mkdirSync(OUT, { recursive: true });
const TIMES = (process.env.AA_TIMES ?? 'golden,night').split(',');
const ARMS = (process.env.AA_ARMS ?? 'off,msaa,fxaa,msaa+fxaa').split(',');
const TAG = process.env.AA_TAG ?? 'aa';

// Same framings as tools/hero-shots.mjs, so these frames are comparable with
// docs/shots/play-*.png - the frames the aliasing was first measured on.
const ALL_SHOTS = [
  { name: 'corridor', wpA: 2, wpB: 4, back: 34, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];
const WANT = (process.env.AA_SHOTS ?? 'corridor,fivepoints').split(',');
const SHOTS = ALL_SHOTS.filter((s) => WANT.includes(s.name));

// Camera placement, lifted from hero-shots.mjs: extrapolating from a route
// waypoint in a straight line can put the camera inside a building, and a hero
// frame taken from inside a wall manufactures the very defects it is used to
// look for.
function placeCamera(cfg) {
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
          if (d < best) best = d;
        }
      }
    }
    return { d: best === Infinity ? 99 : best, inside: worst };
  };
  const MIN_CLEAR = 3.0;
  let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
  for (;;) {
    px = a.x - (dx / len) * back + nx * cfg.side;
    pz = a.z - (dz / len) * back + nz * cfg.side;
    cl = clearance(px, pz);
    if (cl.d >= MIN_CLEAR || back <= 8) break;
    back -= 1;
  }
  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam(
    [px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd],
    cfg.fov
  );
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return { back, x: +px.toFixed(1), z: +pz.toFixed(1), clearance: +cl.d.toFixed(1) };
}

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.addStyleTag({ content: '#attr{display:none!important}' });
await page.addStyleTag({ content: '#hud,.pv-hud{display:none!important}' });

const baseline = await page.evaluate(() => __district.aaState());
console.log(`shipped default: ${JSON.stringify(baseline)}`);

const results = [];
const digests = new Map();
for (const s of SHOTS) {
  const placed = await page.evaluate(placeCamera, s);
  console.log(`\n${s.name}: camera (${placed.x}, ${placed.z}), back ${placed.back}, ` +
    `${placed.clearance} m clear`);
  await page.waitForTimeout(14000);

  for (const tod of TIMES) {
    await page.evaluate((t) => __district.setTimeOfDay(t), tod);
    await page.waitForTimeout(15000);

    for (const arm of ARMS) {
      // The toggle, as a real function object, and then the assertion that it
      // took. An arm that cannot prove it changed anything is not captured.
      const state = await page.evaluate((mode) => __district.setAA(mode), arm);
      const wantSamples = arm.includes('msaa') ? 4 : 0;
      const wantFxaa = arm.includes('fxaa');
      if (state.mode !== arm || state.samples !== wantSamples || state.fxaaPass !== wantFxaa) {
        throw new Error(`AA toggle did not take: asked ${arm}, got ${JSON.stringify(state)}`);
      }
      if (state.rendererAntialias !== false) {
        console.log(`  NOTE: renderer context antialias is ${state.rendererAntialias}`);
      }
      // WAIT FOR FRAMES, not for a clock. This container renders through
      // SwiftShader at well under one frame per second on this scene, so a fixed
      // 2.5 s wait captured the PREVIOUS arm's image - the frame counter had not
      // moved at all. Three fresh frames after the switch, however long that
      // takes, is the only thing that makes the screenshot this arm's.
      const f0 = await page.evaluate(() => __district.frames);
      const t0 = Date.now();
      await page.waitForFunction((n) => __district.frames >= n, f0 + 3, { timeout: 300000 });
      const f1 = await page.evaluate(() => __district.frames);
      const waited = ((Date.now() - t0) / 1000).toFixed(1);

      const file = `${OUT}/${TAG}-${arm.replace('+', '-')}-${s.name}-${tod}.png`;
      await page.screenshot({ path: file, timeout: 180000 });
      const stats = await page.evaluate(() => ({ ...__district.renderStats(), aa: __district.aaState() }));
      const digest = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 12);
      const key = `${s.name}/${tod}`;
      if (!digests.has(key)) digests.set(key, new Map());
      digests.get(key).set(arm, digest);
      results.push({ shot: s.name, tod, arm, file, digest, frames: f1 - f0, ...stats });
      console.log(`  ${arm.padEnd(10)} draw ${stats.sceneCalls} scene + ${stats.postPasses} post ` +
        `= ${stats.calls}   tris ${stats.triangles}   +${f1 - f0}f in ${waited}s   ${digest}`);
    }
  }
}

// Two arms that produced byte-identical frames did not measure two things.
let identical = 0;
for (const [key, m] of digests) {
  const seen = new Map();
  for (const [arm, d] of m) {
    if (seen.has(d)) { console.log(`IDENTICAL FRAMES: ${key} ${seen.get(d)} == ${arm}`); identical++; }
    seen.set(d, arm);
  }
}
console.log(identical === 0
  ? '\nall arms produced distinct frames'
  : `\nWARNING: ${identical} arm pair(s) produced identical frames`);

fs.writeFileSync(`docs/${TAG}-arms.json`, JSON.stringify({ baseline, results, errors }, null, 1));
console.log(`wrote docs/${TAG}-arms.json  (${results.length} captures, ${errors.length} page errors)`);
if (errors.length) console.log(errors.slice(0, 8).join('\n'));
await browser.close();
