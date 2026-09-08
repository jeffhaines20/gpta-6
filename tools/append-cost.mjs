// What a NEAR chunk's append phase actually costs, per building, offline.
//
// tools/chunk-steps.mjs named `append:near` as the step that produces the stall
// gate's worst slice - 10.9 ms of an 11.1 ms slice, and 24 of 69 calls over the
// 3 ms budget. That says WHICH step. It does not say what inside the step, and
// the step does two quite different things per building:
//
//   1. _streetDirFor / _streetDirsFor - a frontage search over the whole road
//      graph, cached on the building FOR THE LIFE OF THE SESSION, so it is paid
//      once per building, on whichever chunk build first touches it.
//   2. appendBuilding - the facade kit, paid on EVERY build of that chunk.
//
// These need separating before anything is changed, because the remedies are
// opposite. (1) is a warmup cost that belongs behind the loading screen, like
// planKerbs() already is - the streamer's own comment says the frontage search
// is "paid once per building for the life of the session ... spread over
// streaming", and spread over streaming is precisely the thing the stall gate
// measures. (2) is real per-build work and can only be reduced by building less.
//
// No browser: this is arithmetic over data/district.json against the same
// facades.js the streamer calls, so it is a cheap gate and it is deterministic
// where the drive-through is not. It is offline for the same reason
// tools/frontage-stats.mjs is: the budget gate's own numbers carry run-to-run
// noise that swamps the effect being priced.
//
//   node tools/append-cost.mjs [--top N]
//   node tools/append-cost.mjs --selftest
import fs from 'node:fs';

// ---------------------------------------------------------------- aggregation
// Pure, so --selftest can reach it. This is where a wrong answer would come from.
const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  : null);

/**
 * Roll per-building costs up to the per-chunk totals a slice actually pays.
 *
 * A slice builds a CHUNK, so the number that matters is the sum over that
 * chunk's buildings, not the worst single building. Reporting only the
 * per-building max understates a chunk of twenty medium buildings, which is the
 * shape the district mostly has.
 *
 * @param {{chunks:Object}} district
 * @param {number[]} coldMs  per building index, first-touch frontage cost
 * @param {number[]} warmMs  per building index, per-build append cost
 */
export function rollUp(district, coldMs, warmMs) {
  const rows = [];
  for (const [key, chunk] of Object.entries(district.chunks)) {
    const list = chunk.buildings ?? [];
    if (!list.length) continue;
    let cold = 0, warm = 0;
    for (const bi of list) { cold += coldMs[bi] ?? 0; warm += warmMs[bi] ?? 0; }
    rows.push({
      chunk: key, buildings: list.length,
      cold_ms: +cold.toFixed(2), warm_ms: +warm.toFixed(2),
      first_build_ms: +(cold + warm).toFixed(2),
    });
  }
  rows.sort((a, b) => b.first_build_ms - a.first_build_ms);
  const firsts = rows.map((r) => r.first_build_ms).sort((a, b) => a - b);
  const warms = rows.map((r) => r.warm_ms).sort((a, b) => a - b);
  return {
    chunks: rows.length,
    first_build_ms: { p50: pct(firsts, 0.5), p95: pct(firsts, 0.95), max: firsts[firsts.length - 1] ?? null },
    repeat_build_ms: { p50: pct(warms, 0.5), p95: pct(warms, 0.95), max: warms[warms.length - 1] ?? null },
    // The share of a FIRST build that is one-off frontage work. This is the
    // number that decides whether moving it behind the loading screen is worth
    // anything; if it is small the streamer is genuinely building too much.
    cold_share_pct: +(100 * rows.reduce((t, r) => t + r.cold_ms, 0)
      / Math.max(1e-9, rows.reduce((t, r) => t + r.first_build_ms, 0))).toFixed(1),
    rows,
  };
}

// ------------------------------------------------------------------ selftest
function selftest() {
  const fail = [];
  const ok = (name, cond, got) => { if (!cond) fail.push(`${name}: got ${JSON.stringify(got)}`); };

  // 1. A chunk's cost is the SUM over its buildings, not the max and not the
  //    first. A chunk of four 1 ms buildings costs 4 ms and must outrank a
  //    chunk holding one 3 ms building - that is the whole reason this rolls up
  //    per chunk instead of reporting a per-building league table.
  {
    const d = { chunks: { 'a': { buildings: [0, 1, 2, 3] }, 'b': { buildings: [4] } } };
    const cold = [0, 0, 0, 0, 0], warm = [1, 1, 1, 1, 3];
    const r = rollUp(d, cold, warm);
    ok('chunk cost sums its buildings', r.rows[0].chunk === 'a' && r.rows[0].warm_ms === 4, r.rows);
    ok('the smaller chunk is second', r.rows[1].chunk === 'b' && r.rows[1].warm_ms === 3, r.rows);
  }

  // 2. Cold and warm must stay separated. A roll-up that adds them into one
  //    figure cannot answer the question this probe exists for, and a share of
  //    100% or 0% would both be reported as "fine" by a test that only checks
  //    the total.
  {
    const d = { chunks: { 'a': { buildings: [0, 1] } } };
    const r = rollUp(d, [3, 1], [4, 2]);
    ok('cold is summed on its own', r.rows[0].cold_ms === 4, r.rows[0]);
    ok('warm is summed on its own', r.rows[0].warm_ms === 6, r.rows[0]);
    ok('first build is cold+warm', r.rows[0].first_build_ms === 10, r.rows[0]);
    ok('cold share is of the first build', r.cold_share_pct === 40, r.cold_share_pct);
  }

  // 3. A building index with no measurement must contribute 0, not NaN. NaN is
  //    the dangerous one: it fails every > comparison silently, so a chunk whose
  //    cost is NaN sorts to the BOTTOM and reads as the cheapest chunk in the
  //    district. This project has already been bitten by exactly that shape.
  {
    const d = { chunks: { 'a': { buildings: [0, 9] } } };
    const r = rollUp(d, [1], [2]);
    ok('missing samples are 0, never NaN', Number.isFinite(r.rows[0].first_build_ms) && r.rows[0].first_build_ms === 3, r.rows[0]);
  }

  // 4. Chunks with no buildings are dropped rather than reported as free ones
  //    that would drag the p50 to zero.
  {
    const d = { chunks: { 'a': { buildings: [0] }, 'empty': { buildings: [] }, 'none': {} } };
    const r = rollUp(d, [1], [1]);
    ok('empty chunks are not rows', r.chunks === 1, r.chunks);
  }

  // 5. p95 must come off the sorted distribution. With 20 chunks of 1 ms and one
  //    of 100 ms, p95 is 1 and max is 100; an implementation that reports the
  //    max as p95 hides that the tail is a single chunk.
  {
    const chunks = {}; const warm = [];
    for (let i = 0; i < 20; i++) { chunks['c' + i] = { buildings: [i] }; warm.push(1); }
    chunks.big = { buildings: [20] }; warm.push(100);
    const r = rollUp({ chunks }, [], warm);
    ok('p95 is not the max', r.repeat_build_ms.p95 === 1 && r.repeat_build_ms.max === 100, r.repeat_build_ms);
  }

  if (fail.length) {
    console.error('SELFTEST: FAIL');
    for (const f of fail) console.error('  ' + f);
    process.exit(1);
  }
  console.log('SELFTEST: PASS — 5 cases, 9 assertions');
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }

// ------------------------------------------------------------------ live run
// facades.js paints atlases on first use. This probe reads TIMINGS and vertex
// counts only, never a pixel, so a no-op 2D context is a complete substitute -
// the same substitution tools/geom-audit.mjs makes, and for the same reason.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k === 'canvas') return { width: 512, height: 512 };
      if (k === 'createLinearGradient' || k === 'createRadialGradient') return () => grad;
      if (k === 'measureText') return () => ({ width: 10 });
      if (k === 'getImageData') return (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h });
      return () => undefined;
    },
    set() { return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 512, height: 512, getContext: ctx, style: {} }),
  };
}

// generateFacadeLibrary() is deliberately NOT called. It paints the texture
// atlases, which this probe never samples - appendBuilding writes vertices, and
// buildingStyle picks a recipe from data, not from a painted map. Calling it
// would add the whole atlas bake to a probe that is meant to be cheap, and it
// needs a far more complete canvas than a timing probe has any business
// stubbing. tools/geom-audit.mjs runs the same kit helpers the same way.
const { buildingStyle, appendBuilding, buffers } = await import('../src/facades.js');
const { streetDirFor, streetDirsFor } = await import('../src/geom.js');
const { capStyle, styleCost } = await import('../src/build-cost.js');

// argv reader. The first version of this was
//   Number((process.argv[process.argv.indexOf('--passes') + 1]) || 5)
// which, when the flag is ABSENT, indexes argv[-1 + 1] = argv[0] = the node
// binary's path, finds a non-empty string, and so never reaches the `|| 5`.
// Number('/opt/node22/bin/node') is NaN, `pass < NaN` is false, and every timing
// loop ran ZERO times - reporting 0.00 ms per building and Infinity per chunk
// with no error at all. A measurement bug whose wrong answer is a confident
// zero is the exact shape this project keeps getting caught by, so the reader is
// written once and the results are checked for finiteness below.
function numArg(flag, dflt) {
  const i = process.argv.indexOf(flag);
  if (i < 0 || i + 1 >= process.argv.length) return dflt;
  const v = Number(process.argv[i + 1]);
  return Number.isFinite(v) ? v : dflt;
}

const TOP = numArg('--top', 12);
const PASSES = numArg('--passes', 5);
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));

const n = d.buildings.length;
const coldMs = new Array(n).fill(0);
const warmMs = new Array(n).fill(0);
const tris = new Array(n).fill(0);

// --- pass 1: the frontage search, COLD, exactly once per building, which is
// what the streamer pays the first time any chunk build touches it.
// The two halves are timed SEPARATELY because they are not warmed by the same
// thing. district/main.js already calls world._streetDirFor(b) for every
// building it signs, inside the 'signage' loading step - so _streetDir can
// already be warm when a chunk builds, while _streetDirs (the plural, which is
// what appendBuilding's `streets:` actually consumes) has nothing warming it at
// all. Charging them as one number would credit the streamer with a saving the
// signage pass had already made, and would overstate what moving the rest is
// worth.
// The cache makes this genuinely once-only, so it cannot be repeated on the same
// building. Repetition is over the DISTRICT instead: run the whole sweep on
// throwaway copies of each building, keep the min per building, then warm the
// real objects once at the end.
const singleMs = new Array(n).fill(Infinity);
const pluralMs = new Array(n).fill(Infinity);
for (let pass = 0; pass < PASSES; pass++) {
  for (let bi = 0; bi < n; bi++) {
    const src = d.buildings[bi];
    const b = { p: src.p, h: src.h };            // no _streetDir/_streetDirs: cold every pass
    const t0 = performance.now();
    streetDirFor(d, b);
    const t1 = performance.now();
    streetDirsFor(d, b, 2);
    const t2 = performance.now();
    if (t1 - t0 < singleMs[bi]) singleMs[bi] = t1 - t0;
    if (t2 - t1 < pluralMs[bi]) pluralMs[bi] = t2 - t1;
  }
}
for (let bi = 0; bi < n; bi++) {
  const b = d.buildings[bi];
  coldMs[bi] = singleMs[bi] + pluralMs[bi];
  b._streetDir = streetDirFor(d, b);
  b._streetDirs = streetDirsFor(d, b, 2);
}

// --- pass 2: the facade kit, with the frontage cache warm - what every REBUILD
// of that chunk pays.
//
// MIN over PASSES, not the last pass and not the mean. The first version of this
// took pass 2 of 2 and reported append_per_building 0.29 ms; the next run of the
// SAME deterministic code over the SAME data reported 0.58, and the worst chunk's
// repeat build moved 6.65 -> 40.51 ms. Nothing about the subject had changed -
// another builder's headless browser had started on this shared box between the
// two runs (tools/hero-shots.mjs and tools/car-probe.mjs were both alive, 21
// chrome processes).
//
// A timing sample can only be inflated by interference, never deflated by it, so
// the minimum over repetitions is the estimator that survives a shared box; a
// mean or a last-pass reading measures the neighbours. This is the same reason
// the drive-through's stall number cannot be trusted here at all - it is a MAX,
// which is the one statistic that collects interference instead of rejecting it.
for (let pass = 0; pass < PASSES; pass++) {
  for (let bi = 0; bi < n; bi++) {
    const b = d.buildings[bi];
    const style = capStyle(buildingStyle(b), b);
    const wall = buffers(), trim = buffers();
    const t0 = performance.now();
    appendBuilding(b.p, b.h, style, wall, trim, { street: b._streetDir, streets: b._streetDirs });
    const ms = performance.now() - t0;
    if (pass === 0 || ms < warmMs[bi]) warmMs[bi] = ms;
    if (pass === 0) tris[bi] = (wall.idx.length + trim.idx.length) / 3;
  }
}

// Nothing below is worth reading if a timing loop did not run. arm-diff.mjs
// throws on a non-finite difference for the same reason: the dangerous failure
// is the one whose wrong answer looks reassuring.
for (let bi = 0; bi < n; bi++) {
  if (!Number.isFinite(coldMs[bi]) || !Number.isFinite(warmMs[bi])) {
    throw new Error(`building ${bi} has a non-finite timing (cold ${coldMs[bi]}, warm ${warmMs[bi]}) — a timing loop did not run`);
  }
}
if (PASSES < 1) throw new Error(`--passes must be >= 1, got ${PASSES}`);

const r = rollUp(d, coldMs, warmMs);
const sum = (a) => a.reduce((x, y) => x + y, 0);
const out = {
  buildings: n,
  frontage_total_ms: +sum(coldMs).toFixed(1),
  append_total_ms: +sum(warmMs).toFixed(1),
  frontage_per_building_ms: +(sum(coldMs) / n).toFixed(4),
  frontage_single_total_ms: +sum(singleMs).toFixed(1),   // _streetDirFor  - signage already warms this
  frontage_plural_total_ms: +sum(pluralMs).toFixed(1),   // _streetDirsFor - nothing warms this
  rollup_plural_only: rollUp(d, pluralMs, warmMs).first_build_ms,
  append_per_building_ms: +(sum(warmMs) / n).toFixed(4),
  // Per BUILDING, not per chunk. This is the quantity that bounds a slice once
  // the frontage search is out of it: _stepBuild always starts one more building
  // after its deadline check passes, so the worst append step is roughly
  // budgetMs plus the most expensive single building it can start.
  append_per_building: (() => {
    const q = [...warmMs].sort((a, b) => a - b);
    return { p50: +pct(q, 0.5).toFixed(3), p95: +pct(q, 0.95).toFixed(3),
      p99: +pct(q, 0.99).toFixed(3), max: +q[q.length - 1].toFixed(3) };
  })(),
  ...r,
};
const { rows, ...head } = out;
console.log(JSON.stringify(head, null, 2));
console.log(`\n--- worst ${TOP} chunks, by what a FIRST build costs ---`);
console.log('  chunk      bldgs   frontage(cold)   append(warm)   first build   repeat build');
for (const row of rows.slice(0, TOP)) {
  console.log(`  ${row.chunk.padEnd(9)} ${String(row.buildings).padStart(5)}` +
    `   ${String(row.cold_ms).padStart(12)}   ${String(row.warm_ms).padStart(12)}` +
    `   ${String(row.first_build_ms).padStart(11)}   ${String(row.warm_ms).padStart(12)}`);
}
const byB = [...coldMs.keys()].sort((a, b) => (warmMs[b] - warmMs[a])).slice(0, 8);
console.log('\n--- worst 8 single buildings (append only) ---');
for (const bi of byB) {
  const b = d.buildings[bi];
  const st = capStyle(buildingStyle(b), b);
  console.log(`  #${String(bi).padStart(4)}  append ${warmMs[bi].toFixed(2)} ms  frontage ${coldMs[bi].toFixed(2)} ms` +
    `  tris ${tris[bi]}  floors ${st.floors}  perim ${Math.round(b._perim)}  cost ${Math.round(styleCost(st, b))}  ${st.recipe}`);
}
fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync('docs/append-cost.json', JSON.stringify(out, null, 1));
console.log('\nwritten docs/append-cost.json');
