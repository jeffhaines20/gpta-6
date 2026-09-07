// Where the frame's triangles actually go, by subsystem.
//
// The budget gate has one number for the whole frame and a hard warn line at
// 830,000 that the district is now sitting on. Every remaining visual fix is
// therefore competing for headroom, and there is no way to arbitrate that
// without knowing what is already spending it. tools/budget.mjs says how much;
// this says on what.
//
// It walks the live scene graph, buckets every mesh by the subsystem that named
// it, and reports triangles three ways: the whole scene, the part inside the
// camera frustum, and the part that is ALSO a shadow caster -- which the budget
// gate counts a second time, because renderer.info includes the depth pass.
//
// VALIDATION is against the engine rather than against a synthetic fixture: the
// in-frustum sum is compared with post.stats.sceneTriangles, the counter the
// budget gate itself reads. A walk that disagrees with the renderer is wrong by
// definition, and the tool says so instead of printing a plausible table.
//
//   node tools/tri-breakdown.mjs
//   TB_PORT=8135 node tools/tri-breakdown.mjs
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';

const PORT = Number(process.env.TB_PORT ?? 8123);
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
await page.waitForTimeout(Number(process.env.TB_SETTLE ?? 20000));

// WHAT ACTUALLY GOT DRAWN, not what I calculate should have been.
//
// The first version of this computed its own frustum planes and tested bounding
// spheres, and disagreed with the renderer by 47% -- instanced meshes carry a
// per-instance geometry sphere and a group transform, so the test culled the
// entire crowd and every vehicle while the engine was plainly drawing them. The
// tool said so and refused to print a table, which is the only reason the wrong
// numbers did not end up in a commit message.
//
// three calls onBeforeRender on every object it draws in the colour pass, so
// hooking that is not a model of the render, it IS the render. The shadow pass
// does not call it, so the shadow share falls out as the difference against the
// engine's own counter rather than being estimated.
const out = await page.evaluate(async () => {
  const { scene, renderStats } = window.__district;
  const bucketOf = (o) => {
    let n = o, name = '';
    while (n) { if (n.name) { name = n.name; break; } n = n.parent; }
    // Streamer meshes are named chunk:<key>:lod<N>:<part>, so the PART is the
    // last segment. Bucketing on the first non-empty name put every one of them
    // in its own row and buried the answer.
    // chunk:<key>:lod<N>:<part> -- the key holds a comma, not a colon, so the
    // part is everything from the fourth segment on. Slicing from the third left
    // 'lod1:road' and every regex below missed, scattering the streamer's meshes
    // into a dozen 'other:' rows.
    const part = /^chunk:/.test(name) ? name.split(':').slice(3).join(':') : name;
    if (/^facade/.test(part)) return 'facade (near LOD)';
    if (/^trim/.test(part)) return 'facade trim (near LOD)';
    if (/^far/.test(part)) return 'buildings (far LOD)';
    if (/^road/.test(part)) return 'roads';
    // The kerb's asphalt half rides in the road mesh; this is the concrete half
    // (gutter pan, face, top, chamfer), one mesh per near chunk. Without its own
    // row it lands in 'other: kerb' and the one thing a reader wants to price is
    // the one thing the table does not name.
    if (/^kerb/.test(part)) return 'kerbs (near LOD)';
    if (/^zone/.test(part)) return 'ground zones';
    if (/furniture|prop/i.test(name)) return 'street furniture + trees';
    if (/sign/i.test(name)) return 'signage';
    if (/ped|crowd|character/i.test(name)) return 'pedestrians';
    if (/car|vehicle|traffic|pursuit/i.test(name)) return 'vehicles';
    if (/sky|dome/i.test(name)) return 'sky dome';
    return name ? `other: ${part || name}` : 'unnamed';
  };

  const rows = new Map();
  const hooked = [];
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const prev = o.onBeforeRender;
    hooked.push([o, prev]);
    o.onBeforeRender = function (...a) {
      const g = this.geometry;
      // Bucket by FRAME. The first version hooked, waited two animation frames
      // and summed everything, so every object drawn in both frames counted
      // twice and the colour pass came out 3.8% ABOVE the engine's own counter
      // for the whole render including shadows -- impossible, and the reason the
      // tool prints a warning when that happens.
      const fr = window.__district.frames;
      if (g) {
        const tris = (g.index ? g.index.count : (g.attributes.position?.count ?? 0)) / 3;
        const n = tris * (this.isInstancedMesh ? this.count : 1);
        const k = bucketOf(this);
        const per = rows.get(fr) ?? new Map();
        const r = per.get(k) ?? { meshes: 0, tris: 0 };
        r.meshes++; r.tris += n;
        per.set(k, r); rows.set(fr, per);
      }
      if (prev) prev.apply(this, a);
    };
  });
  // One frame with the hooks live.
  await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(res))));
  for (const [o, prev] of hooked) o.onBeforeRender = prev ?? (() => {});
  // The middle frame: the first may have been in flight when the hooks went on,
  // the last may be cut short by unhooking.
  const frames = [...rows.keys()].sort((a, b) => a - b);
  const pick = frames[Math.max(0, Math.min(frames.length - 1, 1))];
  return { rows: [...(rows.get(pick) ?? new Map()).entries()], frames: frames.length, stats: renderStats() };
});
await browser.close();
if (errors.length) console.log(`page errors: ${errors.length} — ${errors[0]}`);

const rows = out.rows.sort((a, b) => b[1].tris - a[1].tris);
const drawn = rows.reduce((a, r) => a + r[1].tris, 0);
console.log('subsystem                          draws     triangles    % of colour pass');
for (const [k, r] of rows) {
  if (!r.tris) continue;
  console.log(`${k.padEnd(34)} ${String(r.meshes).padStart(5)}  ${String(Math.round(r.tris)).padStart(12)}  ${(100 * r.tris / drawn).toFixed(1).padStart(15)}%`);
}
console.log(`${'COLOUR PASS TOTAL'.padEnd(34)} ${String(rows.reduce((a, r) => a + r[1].meshes, 0)).padStart(5)}  ${String(Math.round(drawn)).padStart(12)}`);
const engine = out.stats.triangles;
console.log(`\nengine counter (post.stats.sceneTriangles): ${engine}`);
console.log(`shadow pass, by difference               : ${Math.round(engine - drawn)}  (${(100 * (engine - drawn) / Math.max(1, engine)).toFixed(1)}% of the gate's number)`);
if (engine < drawn * 0.95) {
  console.log('\nWARNING: the colour pass alone exceeds the engine counter — the hook is');
  console.log('double-counting, or the counter excludes something. Do not trust this table.');
}
