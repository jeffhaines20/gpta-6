// Per-step attribution for the chunk-build stall gate.
//
// `tools/drive-through.mjs --traffic` reports ONE number, `chunk stall ms` - the
// worst uninterrupted streaming slice over a scripted drive - and nothing in the
// repo could say which of the ~30 things a slice does produced it. Four rounds
// guessed. This measures it instead: src/streaming.js keeps a ledger of every
// slice (scan / dispose / steps) and every step (kind, cost, chunk, LOD), and
// this tool aggregates it.
//
// WHAT THE NUMBERS MEAN, and the traps in them:
//
//  * The gate's quantity is a MAX, not a percentile. Its range on unchanged code
//    is 8.2-15.1 ms and it has read 7.1, 24.1, 7.9, 68.5 and 11.6 on the same
//    commit depending only on how many headless browsers were alive. So this
//    tool reports the DISTRIBUTION per kind (n, sum, p50, p95, max) and not only
//    the max: a kind whose p95 is high over many steps is a real cost, a kind
//    that is high exactly once may be a scheduling artifact of the box.
//  * A slice can contain several steps and several chunks - _drainQueue loops
//    until the deadline - so "the worst step" and "the worst slice" are
//    different questions. Both are reported.
//  * sliceMs includes the rescan and any _dispose, neither of which is a build
//    step. `unattributed` is sliceMs minus (scan + dispose + steps); if it is
//    large the ledger is missing a term and the attribution is a lie. The
//    self-test has a case for exactly that failure.
//
// Usage:
//   node tools/chunk-steps.mjs [--traffic] [--circuits N] [--query kerbs=0]
//   node tools/chunk-steps.mjs --selftest
import fs from 'node:fs';

// --------------------------------------------------------------- aggregation
// Pure, so --selftest can reach it without a browser. Everything that can be
// wrong about this measurement is in here.
const pct = (sorted, q) => (sorted.length
  ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]
  : null);

export function analyse(log, opts = {}) {
  const topN = opts.topN ?? 8;
  const { kinds, chunks, slice, step } = log;
  const nStep = step.ms.length, nSlice = slice.ms.length;

  // --- per-kind distribution
  const byKind = new Map();
  for (let i = 0; i < nStep; i++) {
    const name = kinds[step.kind[i]];
    let e = byKind.get(name);
    if (!e) byKind.set(name, (e = { kind: name, n: 0, sum: 0, max: 0, maxChunk: null, maxLod: null, all: [] }));
    const ms = step.ms[i];
    e.n++; e.sum += ms; e.all.push(ms);
    if (ms > e.max) { e.max = ms; e.maxChunk = chunks[step.chunk[i]]; e.maxLod = step.lod[i]; }
  }
  const kindRows = [...byKind.values()].map((e) => {
    const s = e.all.sort((a, b) => a - b);
    return {
      kind: e.kind, n: e.n,
      sum_ms: +e.sum.toFixed(2),
      p50_ms: +pct(s, 0.5).toFixed(3),
      p95_ms: +pct(s, 0.95).toFixed(3),
      max_ms: +e.max.toFixed(3),
      max_chunk: e.maxChunk, max_lod: e.maxLod,
    };
  }).sort((a, b) => b.max_ms - a.max_ms);

  // --- the worst slices, decomposed
  const order = [...Array(nSlice).keys()].sort((a, b) => slice.ms[b] - slice.ms[a]);
  const stepsBySlice = new Map();
  for (let i = 0; i < nStep; i++) {
    const sl = step.slice[i];
    let a = stepsBySlice.get(sl);
    if (!a) stepsBySlice.set(sl, (a = []));
    a.push(i);
  }
  const worst = order.slice(0, topN).map((i) => {
    const seq = slice.seq[i];
    const rows = (stepsBySlice.get(seq) ?? []).map((j) => ({
      kind: kinds[step.kind[j]], ms: +step.ms[j].toFixed(3),
      chunk: chunks[step.chunk[j]], lod: step.lod[j],
    })).sort((a, b) => b.ms - a.ms);
    const stepSum = rows.reduce((t, r) => t + r.ms, 0);
    return {
      slice_ms: +slice.ms[i].toFixed(2),
      scan_ms: +slice.scan[i].toFixed(2),
      dispose_ms: +slice.dispose[i].toFixed(2),
      step_ms: +slice.step[i].toFixed(2),
      steps: slice.n[i],
      unattributed_ms: +(slice.ms[i] - slice.scan[i] - slice.dispose[i] - slice.step[i]).toFixed(2),
      step_sum_check_ms: +stepSum.toFixed(2),
      top_steps: rows.slice(0, 6),
    };
  });

  // --- how the whole recorded window divides up
  let tScan = 0, tDisp = 0, tStep = 0, tSlice = 0;
  for (let i = 0; i < nSlice; i++) {
    tScan += slice.scan[i]; tDisp += slice.dispose[i]; tStep += slice.step[i]; tSlice += slice.ms[i];
  }
  const sliceSorted = [...slice.ms].sort((a, b) => a - b);
  const share = (v) => +(100 * v / Math.max(1e-9, tSlice)).toFixed(1);

  return {
    slices_recorded: nSlice, slices_total: log.slices, idle_slices: log.idleSlices,
    dropped_rows: log.dropped, steps_recorded: nStep,
    slice_ms: {
      p50: +(pct(sliceSorted, 0.5) ?? 0).toFixed(3),
      p95: +(pct(sliceSorted, 0.95) ?? 0).toFixed(3),
      max: +(sliceSorted.length ? sliceSorted[sliceSorted.length - 1] : 0).toFixed(3),
    },
    total_ms: {
      slice: +tSlice.toFixed(1), scan: +tScan.toFixed(1),
      dispose: +tDisp.toFixed(1), step: +tStep.toFixed(1),
      unattributed: +(tSlice - tScan - tDisp - tStep).toFixed(1),
    },
    // The share of the whole recorded slice budget each term carries. This says
    // where to spend effort; the max says what to fix first. They can disagree.
    share_pct: {
      scan: share(tScan), dispose: share(tDisp), step: share(tStep),
      unattributed: share(tSlice - tScan - tDisp - tStep),
    },
    worst_step: kindRows.length
      ? { kind: kindRows[0].kind, ms: kindRows[0].max_ms, chunk: kindRows[0].max_chunk }
      : null,
    kinds: kindRows,
    worst_slices: worst,
  };
}

// ------------------------------------------------------------------ selftest
// Each case is a shape this aggregator has to get right, written so the obvious
// wrong implementation FAILS it. A probe whose self-test only checks that it
// runs is a probe that will report a confident wrong answer.
function selftest() {
  const fail = [];
  const ok = (name, cond, got) => { if (!cond) fail.push(`${name}: got ${JSON.stringify(got)}`); };

  const mk = (kinds, chunks, steps, slices) => ({
    on: true, cap: 1e6, slices: slices.seq.length, idleSlices: 0, dropped: 0,
    kinds, chunks, slice: slices, step: steps,
  });

  // 1. The max step is not the last step. A "last wins" or "first wins"
  //    attribution names 'road' or 'trim'; the right answer is 'kerb'.
  {
    const log = mk(['trim', 'kerb', 'road'], ['0,0'],
      { slice: [0, 0, 0], kind: [0, 1, 2], ms: [1, 9, 2], chunk: [0, 0, 0], lod: [0, 0, 0] },
      { seq: [0], ms: [12], scan: [0], dispose: [0], step: [12], n: [3] });
    const a = analyse(log);
    ok('worst step is the max, not the last', a.worst_step.kind === 'kerb', a.worst_step);
    ok('worst step carries its chunk', a.worst_step.chunk === '0,0', a.worst_step);
  }

  // 2. Within ONE kind: p50 must be a median, not a mean, and the per-kind max
  //    must be the largest sample and not the newest one. The 100 is deliberately
  //    NOT last - a running max written unconditionally reports 1 here, and case 1
  //    cannot see that bug because every kind in it has a single sample. The
  //    chunk must travel with the max, not with the last row.
  {
    const ms = [1, 100, 1, 1, 1];
    const chunk = [0, 1, 0, 0, 0];
    const log = mk(['trim'], ['0,0', '9,9'],
      { slice: ms.map(() => 0), kind: ms.map(() => 0), ms, chunk, lod: ms.map(() => 0) },
      { seq: [0], ms: [104], scan: [0], dispose: [0], step: [104], n: [5] });
    const a = analyse(log);
    ok('p50 is a median not a mean', a.kinds[0].p50_ms === 1, a.kinds[0]);
    ok('per-kind max is the largest, not the latest', a.kinds[0].max_ms === 100, a.kinds[0]);
    ok('the chunk travels with the max', a.kinds[0].max_chunk === '9,9', a.kinds[0]);
  }

  // 3. THE DANGEROUS ONE. A slice whose cost is NOT in any step must show up as
  //    unattributed rather than being divided silently among the steps that are
  //    there. This is the failure that would make a MISSING term in the ledger
  //    look like a clean attribution: a 20 ms slice with 3 ms of steps, no scan
  //    and no dispose is 17 ms nobody has explained. An implementation that
  //    computes the residual against the step sum, or omits it, reports 0 and
  //    the whole conclusion built on it is wrong.
  {
    const log = mk(['trim'], ['0,0'],
      { slice: [0], kind: [0], ms: [3], chunk: [0], lod: [0] },
      { seq: [0], ms: [20], scan: [0], dispose: [0], step: [3], n: [1] });
    const a = analyse(log);
    ok('unattributed slice time is reported', a.worst_slices[0].unattributed_ms === 17, a.worst_slices[0]);
    ok('unattributed share is reported', a.share_pct.unattributed === 85, a.share_pct);
  }

  // 4. Scan and dispose are slice terms, not steps, and must not then be counted
  //    as unattributed. 10 = 4 scan + 5 dispose + 1 step -> residual 0.
  {
    const log = mk(['trim'], ['0,0'],
      { slice: [0], kind: [0], ms: [1], chunk: [0], lod: [0] },
      { seq: [0], ms: [10], scan: [4], dispose: [5], step: [1], n: [1] });
    const a = analyse(log);
    ok('scan+dispose are attributed', a.worst_slices[0].unattributed_ms === 0, a.worst_slices[0]);
    ok('share splits three ways', a.share_pct.scan === 40 && a.share_pct.dispose === 50, a.share_pct);
  }

  // 5. Steps must be matched to their OWN slice. Slice seq 7 owns the 9 ms step;
  //    an implementation that joins by array position instead of by seq
  //    attributes it to slice 3 and shows the worst slice as having no steps -
  //    which reads as "the cost is not in a step" and sends the next round
  //    hunting the wrong thing.
  {
    const log = mk(['kerb'], ['1,1'],
      { slice: [7], kind: [0], ms: [9], chunk: [0], lod: [0] },
      { seq: [3, 7], ms: [1, 9], scan: [0, 0], dispose: [0, 0], step: [0, 9], n: [0, 1] });
    const a = analyse(log);
    const w = a.worst_slices[0];
    ok('steps join their slice by seq',
      w.slice_ms === 9 && w.top_steps.length === 1 && w.top_steps[0].kind === 'kerb', w);
  }

  // 6. An empty ledger must say "nothing", not "zero" - a max of 0 over no
  //    samples reads exactly like a measured result, and this project has
  //    already shipped one hard-coded zero that read like a measured stall.
  {
    const log = mk([], [], { slice: [], kind: [], ms: [], chunk: [], lod: [] },
      { seq: [], ms: [], scan: [], dispose: [], step: [], n: [] });
    const a = analyse(log);
    ok('empty ledger has no worst step', a.worst_step === null, a.worst_step);
    ok('empty ledger reports zero rows', a.steps_recorded === 0 && a.slices_recorded === 0, a);
  }

  if (fail.length) {
    console.error('SELFTEST: FAIL');
    for (const f of fail) console.error('  ' + f);
    process.exit(1);
  }
  console.log('SELFTEST: PASS — 6 cases, 12 assertions');
}

if (process.argv.includes('--selftest')) { selftest(); process.exit(0); }

// ----------------------------------------------------------------- live run
const { chromium } = await import('playwright');
const { launchOptions } = await import('./browser.mjs');
const { ensureServer } = await import('./serve.mjs');

const arg = (name, dflt) => {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const WITH_TRAFFIC = process.argv.includes('--traffic');
const CIRCUITS = Number(arg('--circuits', 3));
const QUERY = arg('--query', process.env.DRIVE_QUERY ?? '');
// Own port, like DRIVE_PORT and HERO_PORT: 8123 belongs to the main tree and
// ensureServer refuses a foreign document root rather than photographing it.
const PORT = Number(process.env.STEP_PORT ?? process.env.DRIVE_PORT ?? 8123);
const OUT = arg('--out', `docs/chunk-steps${WITH_TRAFFIC ? '-traffic' : ''}.json`);

await ensureServer(PORT);
const browser = await chromium.launch(launchOptions(['--js-flags=--expose-gc']));
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/${QUERY ? '?' + QUERY : ''}`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 60000 });
if (WITH_TRAFFIC) await page.evaluate(() => __district.setTraffic(true));

// The same autopilot as drive-through.mjs, so the workload this attributes is
// the workload the gate measures. Copied rather than imported because it is
// injected into the page, not run here.
await page.evaluate(() => {
  const route = __district.district.meta.route;
  const v = __district.vehicle;
  __district.placeAt(route[1].x, route[1].z);
  let wp = 2, lap = 0, stuckFor = 0;
  __district.setAutopilot((dt) => {
    const target = route[wp];
    const dx = target.x - v.position.x, dz = target.z - v.position.z;
    if (Math.hypot(dx, dz) < 26) { wp++; if (wp >= route.length) { wp = 1; lap++; } return; }
    const q = v.quaternion;
    const yaw = Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
    let err = Math.atan2(dx, dz) - yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const steer = Math.max(-1, Math.min(1, err * 1.6));
    const throttle = Math.abs(err) > 0.9 ? 0.32 : Math.abs(err) > 0.45 ? 0.55 : 1;
    v.setControls({ throttle, brake: 0, steer, handbrake: false });
    if (v.speed < 0.6) { stuckFor += dt; if (stuckFor > 2.5) { __district.placeAt(target.x, target.z); stuckFor = 0; } }
    else stuckFor = 0;
    window.__lapCount = lap;
  });
  window.__lapCount = 0;
  __district.setTimeScale(22);
});

await page.waitForTimeout(6000);                       // warm up past the fill burst
// Order matters. The ledger goes on FIRST, so startRecording()'s resetPeakStats
// clears it in the same call that clears worstSliceMs. The two windows are then
// the same window, which is the only way the attribution can be OF the gate's
// number rather than of a nearby one.
const on = await page.evaluate(() => __district.world.setStepLog(true));
if (!on) throw new Error('step ledger did not turn on');
await page.evaluate(() => __district.startRecording());

const t0 = Date.now();
let laps = 0;
while (laps < CIRCUITS && Date.now() - t0 < 300000) {
  await page.waitForTimeout(4000);
  laps = await page.evaluate(() => window.__lapCount ?? 0);
}
const world = await page.evaluate(() => __district.worldReport());
const log = await page.evaluate(() => __district.world.stepLog());
await browser.close();

const a = analyse(log);
// Cross-check against the gate's own field. If these disagree, the ledger is not
// recording the window the gate reads and nothing below is about the gate.
a.gate_worst_slice_ms = +world.worstSliceMs.toFixed(2);
a.gate_worst_build_ms = +world.worstBuildMs.toFixed(2);
a.gate_worst_dispose_ms = +world.worstDisposeMs.toFixed(2);
a.gate_worst_scan_ms = +world.worstScanMs.toFixed(2);
a.ledger_vs_gate_ms = +(a.slice_ms.max - a.gate_worst_slice_ms).toFixed(2);
a.laps = laps; a.query = QUERY; a.traffic = WITH_TRAFFIC; a.errors = errors;

fs.mkdirSync('docs', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ analysis: a, log }, null, 1));
const { worst_slices, kinds, ...head } = a;
console.log(JSON.stringify(head, null, 2));
console.log('\n--- per kind (sorted by max) ---');
for (const k of kinds) {
  console.log(`  ${k.kind.padEnd(22)} n=${String(k.n).padStart(5)}  sum=${String(k.sum_ms).padStart(8)}` +
    `  p50=${String(k.p50_ms).padStart(7)}  p95=${String(k.p95_ms).padStart(7)}` +
    `  max=${String(k.max_ms).padStart(7)}  @${k.max_chunk}`);
}
console.log('\n--- worst slices ---');
for (const w of worst_slices) {
  console.log(`  ${w.slice_ms} ms  scan ${w.scan_ms}  dispose ${w.dispose_ms}` +
    `  steps ${w.step_ms} (${w.steps})  unattributed ${w.unattributed_ms}`);
  for (const s of w.top_steps) console.log(`      ${s.kind.padEnd(22)} ${s.ms} ms  @${s.chunk} lod${s.lod}`);
}
console.log(`\nwritten ${OUT}`);
