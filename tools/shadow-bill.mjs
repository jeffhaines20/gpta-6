// How many times does the frame bill each subsystem?
//
// THIS IS THE TERM EVERY PRICE IN THIS PROJECT HAS OMITTED. tools/frontage-stats.mjs
// says the door round cost +3,780 triangles and the awning round saved 5,562;
// tools/tri-breakdown.mjs says the traffic car is 1,050. Those are GEOMETRY counts.
// The budget gate reads renderer.info, which counts an object once in the colour
// pass and AGAIN in every shadow map that contains it -- at HEAD the shadow pass is
// 329,864 against a colour pass of 336,115, so the frame bills almost everything
// twice. A ledger built from geometry and compared against the gate is therefore
// out by a factor approaching two before anything else goes wrong, and #52 spent a
// round wondering why ~2,600 of ledger would not reconcile with ~24,000 of gate.
//
// tri-breakdown gets the shadow total by DIFFERENCE, which is the only thing it can
// do: three does not call onBeforeRender in the depth pass. This gets the per
// subsystem split the only other way available -- turn a subsystem's casters off,
// let the renderer tell you what it stopped drawing, and put them back.
//
//   node tools/shadow-bill.mjs
//   SB_PORT=8136 SB_REPS=5 SB_JSON=docs/shadow-bill.json node tools/shadow-bill.mjs
//
// THE FIRST VERSION OF THIS PRINTED A TABLE ITS OWN CROSS-CHECK REJECTED, and the
// reason is worth keeping. It took the colour pass by WALKING THE SCENE, which is
// every mesh in the graph; the renderer draws only what survives frustum culling.
// Street furniture walked 398,010 triangles against 171,917 actually submitted. So
// the colour figure was 577,669 where the frame's was ~331,600, the shadow total by
// difference came out at 88,268 where it is really ~334,000, every multiplier was
// divided by the wrong denominator, and the summed per-bucket figure disagreed with
// it by 184%. The per-bucket toggles were fine the whole time -- they agreed with
// the all-off control to 7.7% -- and the tool said so rather than printing a
// plausible table, which is the only reason this is a footnote instead of a wrong
// number in a commit message. The colour pass is now taken the way
// tri-breakdown takes it: from onBeforeRender, which IS the render.
//
// THE SECOND VERSION REFUSED TOO, and for a better reason than the first. It read
// the colour pass on one frame and the engine counter on a later one, and between
// them the district GREW: the counter went 700,120 -> 762,717 over a two-minute
// sweep, 8.94%, because streaming.js budgets uploads against the wall clock and a
// 20 s settle is not the streamer's quiet. A stale denominator made the shadow
// total look 369,278 where the all-off control could only account for 236,293 of
// it, so the control read 64% and the table was refused. Both halves are fixed
// here: the hooks stay live for the whole sweep so every read reports the colour
// pass and the counter FROM THE SAME FRAME, and the settle waits for the counter to
// stop moving rather than for a fixed number of seconds.
//
// A DRIFT-CANCELLING SWEEP, because the subject moves. Traffic and the crowd enter
// and leave the frustum between frames and headless SwiftShader renders at well
// under 1 fps, so two consecutive reads of the counter are a second of city apart.
// Buckets are switched off one at a time, cumulatively, then switched back on in
// reverse, and each bucket's cost is the mean of its two readings -- which cancels
// any drift linear over the sweep and costs 2n+1 reads instead of 4n. The two
// directions are printed side by side, so a bucket the method cannot resolve says
// so instead of averaging into a confident number.
//
// A CONTROL ARM, because a lever that does not reach the renderer produces a
// beautifully consistent table of zeros. Three only re-renders a shadow map when it
// is told to, so if shadow autoUpdate were off, every toggle here would read 0.00
// and the tool would report that nothing casts. Arm 0 turns EVERY caster off and
// requires the counter to fall by most of the shadow total before any per-subsystem
// number is printed at all.
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import { bucketSource, trisSource } from './tri-buckets.mjs';

const PORT = Number(process.env.SB_PORT ?? 8123);
const REPS = Number(process.env.SB_REPS ?? 3);
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/${process.env.SB_QUERY ? `?${process.env.SB_QUERY}` : ''}`,
  { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null,
  { timeout: Number(process.env.SB_BOOT ?? 120000) });
await page.waitForTimeout(Number(process.env.SB_SETTLE ?? 20000));
if (process.env.SB_TOD) {
  await page.evaluate((t) => __district.setTimeOfDay(t), process.env.SB_TOD);
  await page.waitForTimeout(Number(process.env.SB_TOD_SETTLE ?? 8000));
}

// THE HOUR IS READ BACK FROM THE PAGE, NOT ECHOED FROM THE ENVIRONMENT, and it is
// read while the browser is still OPEN.
//
// Both tools used to record `tod: process.env.*_TOD ?? 'default'`, and 'default' is
// not an hour, it is the absence of a flag. CLAUDE.md's committed shadow-bill table
// is headed "At noon, default camera" and the page boots at DUSK (TimeOfDay's
// constructor calls apply('dusk'), sunLux 1200, elevation 0.055 rad), so a run made
// without the flag was dusk and was written down as noon. That matters here more than
// most: the same CLAUDE.md records that a subsystem's shadow factor DEPENDS on the
// hour, because which shadow maps contain an object changes with the sun. A table that
// cannot say which hour it measured cannot be compared with anything.
//
// The first version of this read it back next to the JSON write, which is AFTER
// browser.close() in both tools -- it would have thrown 'Target page has been closed'
// on every run that passed *_JSON, and the tools are 4 and 20 minutes, so the throw
// would have landed at the end of the measurement rather than the start of it.
const todSeen = await page.evaluate(() => {
  const t = window.__district && window.__district.tod;
  return t ? { preset: t.presetName, sunLux: t.preset && t.preset.sunLux } : null;
});
console.log(`\nmeasured at tod ${todSeen ? todSeen.preset : '?'}` +
  `${todSeen ? ` (sunLux ${todSeen.sunLux})` : ''}` +
  `${process.env.SB_TOD ? '' : ' — the page\'s boot preset, no SB_TOD passed'}`);

const out = await page.evaluate(async ({ bSrc, tSrc, smoke }) => {
  const bucketOf = new Function(`return (${bSrc})`)();
  const trisOf = new Function(`return (${tSrc})`)();
  const { scene, renderStats } = window.__district;

  const frame = () => new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));

  // WHAT THE RENDERER SUBMITS, not what the graph holds. Hooking onBeforeRender is
  // the same method tri-breakdown uses and for the same reason: a self-written
  // frustum test disagreed with the engine by 47% when that tool tried it.
  //
  // THE TRAVERSE HAPPENS AFTER THE SETTLE, and that is the whole of version three's
  // bug. Installed before it, the hooks and the caster list are a snapshot of a
  // district the streamer is still building: every mesh it adds during the settle is
  // unhooked, so the colour pass froze at 352,543 while the engine's counter climbed
  // past it, and those meshes' casters were never toggled, so turning "every" caster
  // off could only reach 62.7% of the shadow total. One stale traverse, two
  // symptoms, and the cross-check caught it without knowing which.
  const drawn = new Map();
  let hooked = [];
  const installHooks = () => {
    scene.traverse((o) => {
      if (!o.isMesh) return;
      const prev = o.onBeforeRender;
      hooked.push([o, prev]);
      o.onBeforeRender = function (...a) {
        const fr = window.__district.frames;
        const per = drawn.get(fr) ?? new Map();
        const k = bucketOf(this);
        per.set(k, (per.get(k) ?? 0) + trisOf(this.geometry, this.isInstancedMesh ? this.count : 1));
        drawn.set(fr, per);
        if (prev) prev.apply(this, a);
      };
    });
  };
  const removeHooks = () => {
    for (const [o, prev] of hooked) o.onBeforeRender = prev ?? (() => {});
    hooked = [];
  };

  // ONE read = one frame, and it returns the colour pass AND the counter from that
  // same frame. Reading them on different frames is what broke version two.
  const read = async () => {
    // RE-HOOK EVERY READ. A traverse is a snapshot, and the streamer keeps swapping
    // meshes even once the COUNTER has gone quiet - a quiet counter means the
    // triangle total is stable, not that the mesh set is. Hooked once after the
    // settle, the colour figure read 375,361 while the renderer drew 492,208 with
    // every caster off: 31% of the colour pass belonged to meshes added after the
    // traverse. Re-hooking costs one traverse a read and makes the figure the
    // frame's own.
    installHooks();
    await frame();
    removeHooks();
    const fr = window.__district.frames;
    // The frame just completed is the one before the current counter, so take the
    // most recent frame the hooks recorded that is not the one in flight.
    const ks = [...drawn.keys()].filter((k) => k < fr).sort((a, b) => b - a);
    const per = ks.length ? drawn.get(ks[0]) : new Map();
    for (const k of [...drawn.keys()]) if (k < fr - 4) drawn.delete(k);   // bounded
    return { counter: renderStats().triangles,
      colour: [...per.values()].reduce((a, v) => a + v, 0),
      byBucket: [...per.entries()] };
  };

  // SETTLE ON THE STREAMER'S QUIET, not on a wall clock. Read until the counter
  // stops moving, and report what was achieved so a run that never settled says so.
  const settle = [];
  let last = null, quiet = 0;
  for (let i = 0; i < (smoke ? 2 : 60) && quiet < 3; i++) {
    await frame();
    const c = renderStats().triangles;
    if (last != null) {
      const rel = Math.abs(c - last) / Math.max(1, last);
      settle.push(+(rel * 100).toFixed(3));
      quiet = rel < 0.005 ? quiet + 1 : 0;
    }
    last = c;
  }
  // read() installs its own hooks, so there is nothing to install here.

  // Casters, bucketed. Every mesh, so a bucket with none says so rather than 0.
  const casters = new Map(), meshCount = new Map();
  scene.traverse((o) => {
    if (!o.isMesh) return;
    const k = bucketOf(o);
    meshCount.set(k, (meshCount.get(k) ?? 0) + 1);
    if (o.castShadow) { const a = casters.get(k) ?? []; a.push(o); casters.set(k, a); }
  });
  // SMOKE MODE exercises every line of the protocol on two buckets. It is not a
  // measurement -- the control will not close on two buckets -- and it is the
  // difference between finding a typo in thirty seconds and finding it after five
  // minutes of sweeping, which is what the third run of this tool cost.
  const keys = smoke ? [...casters.keys()].slice(0, 2) : [...casters.keys()];

  // ---- the sweep: off one at a time, then back on in reverse.
  const baseR = await read();
  const fwd = [];
  let prev = baseR.counter;
  for (const k of keys) {
    for (const m of casters.get(k)) m.castShadow = false;
    const r = await read();
    fwd.push(prev - r.counter);
    prev = r.counter;
  }
  const allOff = prev;
  const back = new Array(keys.length).fill(0);
  for (let i = keys.length - 1; i >= 0; i--) {
    for (const m of casters.get(keys[i])) m.castShadow = true;
    const r = await read();
    back[i] = r.counter - prev;
    prev = r.counter;
  }
  const endR = await read();

  // AN INDEPENDENT CHECK, because the obvious one is circular. The sum of the
  // forward diffs EQUALS base - allOff by construction, so comparing them
  // validates nothing -- it is the same quantity twice, which this project has
  // been caught by before. What is independent is a second PROTOCOL: re-measure
  // one bucket on its own with a four-read ABBA and see whether it agrees with
  // the figure the cumulative sweep gave it. Take the biggest, where the
  // resolution is best.
  let biggest = null, bestShadow = -Infinity;
  for (let i = 0; i < keys.length; i++) {
    const s = (fwd[i] + back[i]) / 2;
    if (s > bestShadow) { bestShadow = s; biggest = keys[i]; }
  }
  let abba = null;
  if (biggest) {
    const cs = casters.get(biggest);
    const on1 = (await read()).counter;
    for (const m of cs) m.castShadow = false;
    const off1 = (await read()).counter;
    const off2 = (await read()).counter;
    for (const m of cs) m.castShadow = true;
    const on2 = (await read()).counter;
    abba = { bucket: biggest, value: ((on1 + on2) / 2) - ((off1 + off2) / 2),
      sweep: bestShadow, reads: [on1, off1, off2, on2] };
  }
  removeHooks();

  return {
    keys, fwd, back, base: baseR.counter, allOff, restored: endR.counter,
    settle, baseColour: baseR.colour, endColour: endR.colour, abba,
    drawn: baseR.byBucket,
    casters: keys.map((k) => casters.get(k).length),
    meshes: keys.map((k) => meshCount.get(k) ?? 0),
    noCasters: (() => {
      const d = new Map(baseR.byBucket);
      return [...meshCount.keys()].filter((k) => !casters.has(k))
        .map((k) => ({ bucket: k, meshes: meshCount.get(k), drawn: d.get(k) ?? 0 }));
    })(),
    calls: renderStats().calls ?? null,
  };
}, { bSrc: bucketSource, tSrc: trisSource, smoke: !!process.env.SB_SMOKE });
await browser.close();
if (errors.length) console.log(`page errors: ${errors.length} — ${errors[0]}`);

const drawnBy = new Map(out.drawn);
// THE COLOUR PASS IS THE ALL-OFF COUNTER, not the hooked walk. castShadow does not
// change the colour pass, so with every caster off the engine's own number IS the
// colour pass -- one instrument on both sides of the ratio. The hooked sum is kept
// as a FLOOR, and the gap between them is how much the traverse missed: version six
// hooked per read and still came in 81,735 short, because the streamer swaps meshes
// even once the counter has gone quiet. Using the hooked figure as the denominator
// inflated this ratio to x1.93-2.05; the engine's own says x1.47-1.50.
const colour = out.allOff;
const hookedFloor = out.baseColour;
const shadowTotal = out.base - colour;
console.log(`settle: ${out.settle.length} reads, last five counter moves ` +
  `${out.settle.slice(-5).map((v) => `${v}%`).join(' ')}` +
  `${out.settle.slice(-3).every((v) => v < 0.5) ? '  (quiet)' : '  NOT QUIET'}`);
console.log(`colour pass (counter, every caster off): ${Math.round(colour)}`);
console.log(`  hooked walk, a floor on the same frame : ${Math.round(hookedFloor)}` +
  `   (${Math.round(colour - hookedFloor)} of it belongs to meshes the traverse missed)`);
console.log(`engine counter                      : ${out.base}`);
console.log(`shadow pass, by difference          : ${Math.round(shadowTotal)}` +
  `   the frame bills x${(out.base / Math.max(1, colour)).toFixed(3)} of its colour pass`);

console.log(`\nTHE CONTROL: every caster off, reached one bucket at a time`);
console.log(`  counter ${out.base} -> ${out.allOff} -> ${out.restored} (restored)`);
const coverage = 1;   // by construction now: the colour pass IS the all-off counter
const drift = out.restored - out.base;
console.log(`  colour pass moved ${Math.round(out.endColour - colour)} over the same sweep` +
  ` (${Math.round(colour)} -> ${Math.round(out.endColour)})`);
console.log(`  drift over the sweep: ${drift > 0 ? '+' : ''}${Math.round(drift)}` +
  ` (${(100 * Math.abs(drift) / Math.max(1, out.base)).toFixed(2)}% of the counter), which the`);
console.log(`  two sweep directions cancel; each row prints both so you can see it.`);
if (process.env.SB_SMOKE) {
  console.log(`\nSMOKE: the protocol ran end to end over ${out.keys.length} buckets.` +
    ' Not a measurement - run without SB_SMOKE for that.');
  process.exit(0);
}
if (shadowTotal <= 0.05 * colour) {
  console.log(`\nREFUSED: turning every caster off barely moved the counter` +
    ` (${Math.round(shadowTotal)} of ${Math.round(colour)}), so this lever does not reach`);
  console.log('the renderer and a per-subsystem table built on it would be a column of');
  console.log('numbers about nothing. Check renderer.shadowMap.autoUpdate.');
  process.exit(1);
}
if (hookedFloor > colour) {
  console.log(`\nREFUSED: the hooked walk (${Math.round(hookedFloor)}) exceeds the all-off`);
  console.log(`counter (${Math.round(colour)}), which is impossible: the hook cannot see more`);
  console.log('than the renderer drew. Version one of this tool did exactly that by walking');
  console.log('the scene graph instead of the render.');
  process.exit(1);
}

const rows = out.keys.map((k, i) => {
  const f = out.fwd[i], b = out.back[i];
  return { bucket: k, casters: out.casters[i], meshes: out.meshes[i],
    drawn: drawnBy.get(k) ?? 0, fwd: f, back: b, shadow: (f + b) / 2,
    disagree: Math.abs(f - b) };
}).sort((a, b) => b.shadow - a.shadow);

console.log(`\nsubsystem                     casters   drawn tris        shadow   x bill    fwd/back`);
for (const r of rows) {
  const mult = r.drawn > 0 ? `x${((r.drawn + r.shadow) / r.drawn).toFixed(2)}` : '—';
  console.log(`${r.bucket.padEnd(30)} ${String(r.casters).padStart(6)} ` +
    `${String(Math.round(r.drawn)).padStart(11)} ${String(Math.round(r.shadow)).padStart(13)} ` +
    `${mult.padStart(7)}    ${Math.round(r.fwd)}/${Math.round(r.back)}`);
}
for (const n of out.noCasters) {
  if (!n.drawn) continue;
  console.log(`${n.bucket.padEnd(30)} ${String(0).padStart(6)} ${String(Math.round(n.drawn)).padStart(11)}` +
    `    no casters   x1.00`);
}
const summed = rows.reduce((a, r) => a + r.shadow, 0);
console.log(`\nper-subsystem shadow, summed : ${Math.round(summed)}` +
  `   against a ${Math.round(shadowTotal)} total`);
console.log('Those two are NOT an independent check: the forward sweep\'s diffs add up to');
console.log('base minus all-off by construction, so comparing them is the same quantity');
console.log('twice. The checks that mean something are below.');
if (out.abba) {
  const a = out.abba;
  const rel = Math.abs(a.value - a.sweep) / Math.max(1, Math.abs(a.sweep));
  console.log(`\nSECOND PROTOCOL on the biggest bucket, "${a.bucket}":`);
  console.log(`  cumulative sweep ${Math.round(a.sweep)}   standalone ABBA ${Math.round(a.value)}` +
    `   apart by ${(rel * 100).toFixed(1)}%`);
  console.log(`  reads on/off/off/on: ${a.reads.join(' ')}`);
  console.log(`  ${rel < 0.15 ? 'The two protocols agree, so the sweep is reporting the toggle and not the drift.'
    : 'THE TWO PROTOCOLS DISAGREE. Trust neither row; the drift beat this box.'}`);
}
const worstRow = rows.reduce((a, r) => (r.disagree > (a?.disagree ?? -1) ? r : a), null);
console.log(`\nA row whose forward and backward readings disagree is a row the drift beat.`);
if (worstRow && worstRow.disagree) {
  console.log(`  worst: ${worstRow.bucket} at ${Math.round(worstRow.disagree)}` +
    ` (${(100 * worstRow.disagree / Math.max(1, Math.abs(worstRow.shadow))).toFixed(0)}% of its own figure)`);
}
if (process.env.SB_JSON) {
  const fs = await import('node:fs');
  fs.writeFileSync(process.env.SB_JSON, JSON.stringify({
    tod: todSeen ? todSeen.preset : (process.env.SB_TOD ?? 'unknown'),
    todAsked: process.env.SB_TOD ?? null, sunLux: todSeen ? todSeen.sunLux : null,
    colour, engine: out.base, shadowTotal,
    control: { allOff: out.allOff, restored: out.restored, hookedFloor, drift }, abba: out.abba,
    rows, noCasters: out.noCasters, summed,
  }, null, 1));
  console.log(`wrote ${process.env.SB_JSON}`);
}
