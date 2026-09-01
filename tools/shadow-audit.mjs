// What in the scene graph can cast a sun shadow, and can the shadow map resolve it?
//
// Two separate questions, and a frame that shows no ground contact needs both
// answered before anything is changed:
//
//   1. Is the mesh FLAGGED a caster? A `castShadow = false` mesh is simply absent
//      from the shadow pass no matter how the map is configured.
//   2. Can the map RESOLVE it? An ortho shadow camera W metres across a mapSize
//      of N texels gives W/N metres per texel. An object narrower than ~2 texels
//      cannot produce a contiguous occluded run and vanishes even when flagged.
//
// So this reports both, per category, plus the texel size and each category's
// characteristic width in texels. Categories are read off the scene graph by
// name and constructor, not assumed.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { SHOTS, placeCamera, describe } from './framing.mjs';
import fs from 'node:fs';

const TOD = process.env.AUDIT_TOD ?? 'golden';
const TRAFFIC = Number(process.env.AUDIT_TRAFFIC ?? 30);
const PEDS = Number(process.env.AUDIT_PEDS ?? 40);
const TAG = process.env.AUDIT_TAG ?? 'shadow';

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('pageerror', (e) => console.error('PAGEERROR', e.message));
await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.evaluate((t) => __district.setTimeOfDay(t), TOD);
await page.evaluate(([t, p]) => { __district.setTraffic(t); __district.setPedestrians(p); }, [TRAFFIC, PEDS]);
// Audit the scene the hero frames are judged on, not the spawn point: which
// chunks are resident, and therefore how many casters exist, depends entirely
// on where the viewer stands.
console.log(describe('corridor', await page.evaluate(placeCamera, SHOTS.corridor)));
{
  let last = -1, stable = 0;
  for (let i = 0; i < 60 && stable < 3; i++) {
    const m = await page.evaluate(() => __district.worldReport().meshes);
    stable = m === last ? stable + 1 : 0; last = m;
    if (stable < 3) await page.waitForTimeout(2500);
  }
  console.log(`world settled at ${last} chunk meshes`);
}
await page.waitForTimeout(9000);

const report = await page.evaluate(() => {
  // Category is decided by where a mesh SITS in the graph, walked from the root
  // down, so a rename in one module cannot silently move meshes into "other".
  const cat = (o) => {
    for (let n = o; n; n = n.parent) {
      const nm = n.name || '';
      if (/^chunk:/.test(nm)) return 'world chunk';
      if (nm === 'furniture' || nm === 'streetfurniture') return 'furniture';
      if (nm === 'pedestrians') return 'pedestrians';
      if (nm === 'traffic') return 'traffic';
      if (nm === 'sky' || nm === 'skydome') return 'sky';
      if (nm === 'weather') return 'weather';
    }
    if (/^props:/.test(o.name || '')) return 'props';
    return 'other';
  };
  const rows = {};
  const named = {};
  __district.scene.traverse((o) => {
    if (!o.isMesh) return;
    const c = cat(o) + (o.isInstancedMesh ? ' (instanced)' : '');
    const r = (rows[c] ??= { meshes: 0, casters: 0, receivers: 0, instances: 0, castInstances: 0, tris: 0, names: {} });
    r.meshes++;
    if (o.castShadow) r.casters++;
    if (o.receiveShadow) r.receivers++;
    const n = o.isInstancedMesh ? o.count : 1;
    r.instances += n;
    if (o.castShadow) r.castInstances += n;
    const g = o.geometry;
    const t = g && g.index ? g.index.count / 3 : (g && g.attributes.position ? g.attributes.position.count / 3 : 0);
    r.tris += t * (o.isInstancedMesh ? o.count : 1);
    const key = (o.name || '(unnamed)').replace(/\d+/g, '#');
    r.names[key] = (r.names[key] ?? 0) + 1;
    // Characteristic width: the smaller horizontal extent of the geometry's own
    // bounding box, which is what the shadow map has to resolve.
    if (g) {
      if (!g.boundingBox) g.computeBoundingBox();
      const bb = g.boundingBox;
      const w = Math.min(bb.max.x - bb.min.x, bb.max.z - bb.min.z);
      named[key] ??= { w: 0, cast: !!o.castShadow };
      named[key].w = Math.max(named[key].w, +w.toFixed(2));
      named[key].cast = named[key].cast || !!o.castShadow;
    }
  });
  const sun = __district.tod.sun;
  const c = sun.shadow.camera;
  return {
    rows, named,
    shadow: {
      mapSize: [sun.shadow.mapSize.x, sun.shadow.mapSize.y],
      left: c.left, right: c.right, top: c.top, bottom: c.bottom, near: c.near, far: c.far,
      bias: sun.shadow.bias, normalBias: sun.shadow.normalBias,
      type: __district.renderer.shadowMap.type, enabled: __district.renderer.shadowMap.enabled,
      autoUpdate: __district.renderer.shadowMap.autoUpdate,
    },
    render: __district.renderStats(),
    world: __district.worldReport(),
  };
});

const s = report.shadow;
const mPerTexel = (s.right - s.left) / s.mapSize[0];
console.log(`\n${TOD}  traffic ${TRAFFIC}  peds ${PEDS}`);
console.log(`shadow map ${s.mapSize[0]}x${s.mapSize[1]} over ${(s.right - s.left).toFixed(0)} m ` +
  `= ${mPerTexel.toFixed(3)} m/texel   near ${s.near} far ${s.far} bias ${s.bias} normalBias ${s.normalBias}`);
console.log(`\ncategory                     meshes  casters   instances  castInst      tris`);
for (const [k, r] of Object.entries(report.rows).sort()) {
  console.log(`${k.padEnd(28)} ${String(r.meshes).padStart(6)} ${String(r.casters).padStart(8)} ` +
    `${String(r.instances).padStart(11)} ${String(r.castInstances).padStart(9)} ${String(Math.round(r.tris)).padStart(9)}`);
}
console.log(`\nper-geometry minimum horizontal extent, in shadow texels:`);
const wide = Object.entries(report.named).sort((a, b) => a[1].w - b[1].w);
for (const [k, v] of wide) {
  const tx = v.w / mPerTexel;
  console.log(`  ${(v.cast ? 'CAST' : '    ')} ${k.padEnd(34)} ${String(v.w).padStart(7)} m ` +
    `= ${tx.toFixed(1).padStart(7)} texels${tx < 2 ? '   <- cannot resolve' : ''}`);
}
let castMeshes = 0, castTris = 0;
for (const r of Object.values(report.rows)) { castMeshes += r.casters; }
console.log(`\nscene: draw ${report.render.calls} (scene ${report.render.sceneCalls}) tris ${report.render.triangles}`);
console.log(`shadow pass: ${castMeshes} caster meshes (NOT counted by renderer.info - three.js resets it ` +
  `after shadowMap.render, so the budget gate cannot see this cost)`);
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(`docs/${TAG}-audit-${TOD}.json`, JSON.stringify({ tod: TOD, traffic: TRAFFIC, peds: PEDS, mPerTexel, ...report }, null, 1));
console.log(`wrote docs/${TAG}-audit-${TOD}.json`);
await browser.close();
