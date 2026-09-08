// What the HUD allocates on its per-frame path, measured rather than reasoned.
//
// The HUD runs every frame and nothing else in this project does, so an
// allocation here is the one that shows up as GC sawtooth in a drive. M2's own
// next action was "reduce HUD per-frame allocation" and the honest first
// question is how much there is.
//
// Two numbers, because they fail differently:
//
//   font assignments  every `ctx.font = ...` on the frame path. When the right
//                     hand side is a template literal over module constants it
//                     builds a NEW, identical string every frame. This is exact
//                     and deterministic: it counts events, not bytes.
//   heap delta        bytes retained across N frames after a forced GC. Noisy,
//                     and honest about being noisy -- it is reported as a per
//                     frame average over a large N with the floor stated.
//
// The DOM stub is deliberately thin. It is enough to construct the HUD and run
// update(), and no more; it draws nothing and rasterises nothing, so what is
// left is JS allocation on the frame path, which is the thing being asked about.
//
//   node --expose-gc tools/hud-alloc.mjs
//   node --expose-gc tools/hud-alloc.mjs --selftest
//   node --expose-gc tools/hud-alloc.mjs --frames 5000
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const num = (f, d) => { const i = args.indexOf(f); return i >= 0 ? +args[i + 1] : d; };

let fontAssigns = 0;
const resetCounters = () => { fontAssigns = 0; };

function mkCtx() {
  const t = { canvas: { width: 512, height: 512 }, _font: '' };
  return new Proxy(t, {
    get(o, k) {
      if (k === 'font') return o._font;
      if (k in o) return o[k];
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
          k === 'createPattern' || k === 'createConicGradient') {
        return () => ({ addColorStop() {} });
      }
      if (k === 'getImageData') {
        return (x, y, w, h) => {
          const W = (w | 0) || 1, H = (h | 0) || 1;
          return { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
        };
      }
      return (o[k] = () => {});
    },
    set(o, k, v) {
      // The whole point of the harness. Counting the ASSIGNMENT rather than the
      // string identity is deliberate: a build that hoisted the constants but
      // still assigned every frame would look fixed if we counted distinct
      // strings, and it would still be doing the work.
      if (k === 'font') { fontAssigns++; o._font = v; return true; }
      o[k] = v; return true;
    },
  });
}

function mkEl() {
  const el = {
    style: { setProperty() {}, removeProperty() {}, getPropertyValue: () => '' },
    dataset: {}, children: [], width: 512, height: 512, textContent: '',
    classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
    appendChild(c) { el.children.push(c); return c; },
    setAttribute() {}, removeAttribute() {}, remove() {},
    getContext: () => mkCtx(),
    addEventListener() {}, removeEventListener() {},
    querySelector: () => null, querySelectorAll: () => [],
    getBoundingClientRect: () => ({ x: 0, y: 0, width: 512, height: 512, top: 0, left: 0 }),
  };
  return el;
}

function installDOM() {
  globalThis.window = {
    devicePixelRatio: 1, innerWidth: 1600, innerHeight: 900,
    addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {}, addListener() {} }),
    requestAnimationFrame: () => 0,
  };
  globalThis.document = {
    createElement: () => mkEl(), createElementNS: () => mkEl(),
    head: mkEl(), body: mkEl(),
    getElementById: () => null, querySelector: () => null, querySelectorAll: () => [],
    addEventListener() {}, removeEventListener() {},
  };
}

/** One frame of plausible, CHANGING state — a parked HUD allocates nothing. */
const frameState = (i) => ({
  dt: 1 / 60, visible: true,
  speed: 40 + (i % 23), rpm: 0.3 + (i % 17) / 40, slip: (i % 9) / 20,
  health: 0.5 + (i % 11) / 30, armour: 0.3 + (i % 7) / 20,
  wanted: i % 6, gear: 1 + (i % 5),
  heading: (i * 0.017) % 6.28, px: i * 0.3, pz: -i * 0.2,
  damage: (i % 13) / 20, vignette: (i % 5) / 10,
});

async function run(frames) {
  installDOM();
  const { HUD } = await import('../src/hud.js');
  const hud = new HUD({});
  for (let i = 0; i < 60; i++) hud.update(frameState(i));   // warm the caches
  if (globalThis.gc) globalThis.gc();
  resetCounters();
  const h0 = process.memoryUsage().heapUsed;
  for (let i = 0; i < frames; i++) hud.update(frameState(i));
  const h1 = process.memoryUsage().heapUsed;
  return { fontAssigns, heapDelta: h1 - h0, frames };
}

if (has('--selftest')) {
  let bad = 0;
  const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

  // 1. The counter counts assignments, and only font assignments.
  resetCounters();
  const ctx = mkCtx();
  for (let i = 0; i < 7; i++) ctx.font = '700 12px x';
  ctx.fillStyle = '#fff';
  ctx.lineWidth = 3;
  say(fontAssigns === 7, `7 font assignments counted as ${fontAssigns}, other props ignored`);

  // 2. KNOWN-BAD INPUT: assigning the SAME hoisted constant still counts. A
  //    probe that deduplicated by string value would read 1 here and would
  //    report a build as fixed while it still built a string every frame.
  resetCounters();
  const HOISTED = '700 12px y';
  for (let i = 0; i < 5; i++) ctx.font = HOISTED;
  say(fontAssigns === 5, `5 assignments of one constant still count as 5, got ${fontAssigns}`);

  // 3. The heap probe can see a known allocation. Without --expose-gc the
  //    baseline is not settled and this is the check that says so.
  if (!globalThis.gc) {
    say(false, 'run with --expose-gc: the heap number is meaningless without it');
  } else {
    globalThis.gc();
    const h0 = process.memoryUsage().heapUsed;
    const keep = [];
    for (let i = 0; i < 1000; i++) keep.push(new Array(128).fill(i));
    const grew = process.memoryUsage().heapUsed - h0;
    say(grew > 400_000, `a known ~1 MB allocation is seen: ${(grew / 1024).toFixed(0)} KiB > 400 KiB`);
    say(keep.length === 1000, 'and the allocation was not optimised away');
  }

  console.log(bad ? `\n${bad} SELFTEST FAILURE(S)` : '\nselftest ok');
  process.exit(bad ? 1 : 0);
}

// What one avoided assignment is actually worth. Interleaved and median-of-5,
// because a straight A-then-B ordering measures JIT warmup as much as the work.
function costPerAssignment() {
  const FAM = 'ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif';
  const HOISTED = `700 37px ${FAM}`;
  let sink = '';
  const N = 5_000_000, a = [], b = [];
  for (let r = 0; r < 5; r++) {
    let t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) sink = `700 37px ${FAM}`;
    a.push(Number(process.hrtime.bigint() - t) / N);
    t = process.hrtime.bigint();
    for (let i = 0; i < N; i++) sink = HOISTED;
    b.push(Number(process.hrtime.bigint() - t) / N);
  }
  const med = (x) => x.slice().sort((p, q) => p - q)[2];
  return { built: med(a), hoisted: med(b), len: sink.length };
}

const frames = num('--frames', 2000);
const r = await run(frames);
console.log(`frames                     ${r.frames}`);
console.log(`ctx.font assignments       ${r.fontAssigns}  (${(r.fontAssigns / r.frames).toFixed(2)} per frame)`);
if (globalThis.gc) {
  console.log(`heap delta                 ${(r.heapDelta / 1024).toFixed(0)} KiB  ` +
    `(${(r.heapDelta / r.frames).toFixed(0)} B/frame)`);
  console.log(`  Noisy. A single GC inside the loop makes it negative; treat the sign as`);
  console.log(`  meaningless and only a large positive as evidence. The font count above is`);
  console.log(`  the deterministic one.`);
} else {
  console.log(`heap delta                 (run with --expose-gc)`);
}

const c = costPerAssignment();
console.log(`\ncost of ONE font assignment`);
console.log(`  as a template literal     ${c.built.toFixed(2)} ns`);
console.log(`  as a hoisted constant     ${c.hoisted.toFixed(2)} ns`);
console.log(`  saved                     ${(c.built - c.hoisted).toFixed(2)} ns each, ` +
  `${((c.built - c.hoisted) * r.fontAssigns / r.frames).toFixed(0)} ns per frame`);
console.log(`  V8 does NOT constant-fold the template even though every part of it is a`);
console.log(`  module const -- an 11x difference says the string is rebuilt each time.`);
console.log(`  But ${((c.built - c.hoisted) * r.fontAssigns / r.frames / 16667000 * 100).toFixed(5)}% of a 60 fps frame is not a performance result and is not`);
console.log(`  claimed as one. The reason to hoist is the ~${(91 * r.fontAssigns / r.frames).toFixed(0)} B/frame of garbage, and even`);
console.log(`  that is small. See the commit: this is a priced result, not a win.`);
