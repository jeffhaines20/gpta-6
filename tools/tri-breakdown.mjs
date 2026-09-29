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
//   TB_QUERY=shells=1 TB_TOD=night TB_JSON=docs/tri-b-s1-night.json node tools/tri-breakdown.mjs
//
// TB_QUERY, TB_TOD and TB_JSON exist to answer ONE question this tool was the
// right instrument for and could not be pointed at: daynight-sweep lost 9,024
// triangles at noon, golden and dusk and 4,512 at night, exactly half, and two
// rounds guessed at the cause instead of measuring it. A 2:1 day-to-night split
// is a statement about the SHADOW PASS, which this tool already reports - by
// difference against the engine's own counter, because three does not call
// onBeforeRender in the depth pass. Without a time-of-day knob it could only
// ever read one hour, and without a query string it could not shoot the arm the
// suspected change is in.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { bucketSource } from './tri-buckets.mjs';

const PORT = Number(process.env.TB_PORT ?? 8123);
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const QUERY = process.env.TB_QUERY ? `?${process.env.TB_QUERY}` : '';
await page.goto(`http://127.0.0.1:${PORT}/district/${QUERY}`, { waitUntil: 'networkidle' });
// The district has to render five frames before anything can be measured, and
// headless SwiftShader does that in well under 1 fps. 60 s is enough on an idle
// box and is NOT enough with other agents' headless browsers alive on the same
// machine - both of these timed out at 60 s in this session while a capture was
// running. A boot timeout is not a failing gate; raise it rather than reading it
// as one. Same knob as LOT_BOOT in tools/lot-shots.mjs.
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.TB_BOOT ?? 60000) });
await page.waitForTimeout(Number(process.env.TB_SETTLE ?? 20000));
// TB_TOD, applied after the settle and settled again. The shadow share is the
// whole point of reading more than one hour: at night the sun's caster list
// collapses, so a difference that halves between day and night is in the depth
// pass and a difference that does not is in the colour pass. Those are different
// defects and the tool cannot tell them apart from one hour.
if (process.env.TB_TOD) {
  const tod = process.env.TB_TOD;
  const applied = await page.evaluate((t) => __district.setTimeOfDay(t), tod);
  await page.waitForTimeout(Number(process.env.TB_TOD_SETTLE ?? 8000));
  console.log(`time of day: ${tod} -> ${JSON.stringify(applied && applied.tod ? applied.tod : applied)}`);
}
// WHAT THE PAGE ACTUALLY BUILT, not what the query string asked for. ?shells=1 is
// silently ignored by a tree that does not have the knob, and a run that reports
// a shell count it never checked is the "both arms are the same build" failure
// this project has shipped twice.
const shellsBuilt = await page.evaluate(() =>
  (window.__district.carShells ? window.__district.carShells() : null));
console.log(`shells built: ${JSON.stringify(shellsBuilt)}`);

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
const out = await page.evaluate(async ({ bSrc }) => {
  // The bucketing is injected from tools/tri-buckets.mjs rather than written here,
  // so this tool and tools/shadow-bill.mjs cannot drift apart. That module carries
  // the notes on why each regex is what it is, and a self-test over the two bugs
  // this table has already had: the streamer key holds a comma, and an unnamed mesh
  // must read 'unnamed' because the detail table below keys on exactly that string.
  const bucketOf = new Function(`return (${bSrc})`)();
  const { scene, renderStats } = window.__district;

  const rows = new Map();
  const detail = new Map();
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
        // A bucket the tool cannot name is a bucket a reader cannot price, and
        // 'unnamed' was 9.4% of this frame's colour pass when #52 went looking
        // for 19,582 triangles. So record enough to identify the mesh itself:
        // the parent chain, the instance count, and the material. Only for the
        // buckets that failed to attribute, so the payload stays small.
        if (k === 'unnamed' || k.startsWith('other:')) {
          const chain = [];
          for (let q = this; q && chain.length < 6; q = q.parent) {
            chain.push(q.name || `<${q.type}>`);
          }
          const per2 = detail.get(fr) ?? [];
          per2.push({
            bucket: k, chain: chain.join(' < '),
            tris: tris, instances: this.isInstancedMesh ? this.count : 1, drawn: n,
            material: Array.isArray(this.material)
              ? this.material.map((mm) => mm.type).join('+') : (this.material?.type ?? '?'),
            geo: g.name || '', groups: g.groups ? g.groups.length : 0,
            visible: this.visible, layers: this.layers?.mask ?? null,
          });
          detail.set(fr, per2);
        }
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
  return { rows: [...(rows.get(pick) ?? new Map()).entries()], detail: detail.get(pick) ?? [],
    frames: frames.length, stats: renderStats() };
}, { bSrc: bucketSource });
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
if (out.detail.length) {
  console.log('\nWHAT THE TABLE COULD NOT NAME (every mesh in an unnamed/other row)');
  console.log('   drawn tris  inst   material                    parent chain');
  for (const d of out.detail.sort((a, b) => b.drawn - a.drawn)) {
    console.log(`  ${String(Math.round(d.drawn)).padStart(10)} ${String(d.instances).padStart(6)}` +
      `   ${d.material.padEnd(26)}  ${d.chain}`);
  }
  console.log('  A row here is geometry no subsystem claimed. Name the mesh in src/ and');
  console.log('  it moves into a priced bucket; until then it is 100% of nobody\'s budget.');
}

const engine = out.stats.triangles;
console.log(`\nengine counter (post.stats.sceneTriangles): ${engine}`);
console.log(`shadow pass, by difference               : ${Math.round(engine - drawn)}  (${(100 * (engine - drawn) / Math.max(1, engine)).toFixed(1)}% of the gate's number)`);
if (process.env.TB_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.TB_JSON, JSON.stringify({
    query: process.env.TB_QUERY ?? '', tod: process.env.TB_TOD ?? 'default',
    shells: shellsBuilt, frames: out.frames,
    rows: rows.map(([k, r]) => ({ bucket: k, meshes: r.meshes, tris: Math.round(r.tris) })),
    unattributed: out.detail,
    colourPass: Math.round(drawn), engine,
    shadowByDifference: Math.round(engine - drawn),
    drawCalls: out.stats.calls ?? null,
  }, null, 1));
  console.log(`wrote ${process.env.TB_JSON}`);
}
if (engine < drawn * 0.95) {
  console.log('\nWARNING: the colour pass alone exceeds the engine counter — the hook is');
  console.log('double-counting, or the counter excludes something. Do not trust this table.');
}
