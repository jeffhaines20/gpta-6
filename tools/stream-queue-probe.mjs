// Why does StreamingWorld's `queued` counter never drain?
//
// The reported symptom: `world.report().queued` sits at 69-81 forever while
// chunksLoaded, meshes and loads all stop changing. 69-81 is suspiciously close
// to the LOADED-CHUNK count (docs/drive-traffic.json: chunks_loaded p50 68,
// p95 89), not to zero. Two very different mechanisms produce that:
//
//   A. STALE GAUGE. `stats.queued` is written in exactly one place - right after
//      the want-map rebuild - and the rebuild is skipped entirely unless the
//      player crosses a chunk boundary. Parked, the last write is whatever the
//      rebuild decided at the LAST crossing. On first load that is "the whole
//      ring is missing", i.e. ~= the eventual chunk count. It then never moves.
//
//   B. REAL RE-QUEUE. Something puts every chunk back in the queue on every
//      rebuild - `this.loaded` not matching `want` the way the code reads. That
//      would be actual repeated work sitting underneath the chunk-stall gate.
//
// These are distinguishable by measurement and nothing else, so this probe
// measures rather than argues. It instruments the two real decision points:
//
//   * `update()`     - wrapped to record whether each call took the rescan path
//                      or the early-return path.
//   * `_drainQueue()` - wrapped to snapshot `this.queue` at entry. On a rescan
//                      that snapshot IS the rebuild loop's verdict, taken from
//                      the streamer's own data structures with no duplicated
//                      logic: entries with swap===false are the `!cur` branch,
//                      swap===true is the `cur.lod !== lod` branch, and
//                      want.size - queue.length is "already correct". On the
//                      early-return path the same snapshot is the LIVE queue
//                      depth, which is the number `queued` is mistaken for.
//
// Discipline this project has paid for, applied here:
//
//   * The world takes ~30 s to finish streaming. Every reading below is taken
//     against an explicit settle criterion (report unchanged for N consecutive
//     polls AND a floor on elapsed time), and the settle series is written out
//     so the sample can be checked rather than trusted.
//   * An instrument is not believed until it has produced the OPPOSITE reading.
//     Three controls do that: a forced rescan on the settled world (expects the
//     honest number to COLLAPSE), a teleport (expects it to SPIKE), and a
//     stepwise march across chunk boundaries at two different dwell times
//     (expects a small delta when the queue can drain, a growing backlog when
//     it cannot).
//   * No timing number is reported as a finding. Other harnesses run
//     concurrently in this container and it renders through SwiftShader, so
//     every number here is a COUNT. `ms` fields are wall-clock stamps for
//     ordering the log, not measurements.
//
// Output: docs/stream-probe.json
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/stream-probe.json';
const SETTLE_FLOOR_MS = Number(process.env.SQ_SETTLE_MS || 32000);
const SETTLE_STABLE_POLLS = 6;
const SETTLE_CAP_MS = 120000;
const POLL_MS = 1000;

fs.mkdirSync('docs', { recursive: true });

await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
page.on('console', (m) => {
  if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text());
});

await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });

const wait = (ms) => page.waitForTimeout(ms);

// ---------------------------------------------------------------- instrument
// Installed as early as the page allows, so the log covers the initial fill.
const meta = await page.evaluate(() => {
  const D = window.__district;
  const w = D.world;

  const S = {
    rescanLog: [],        // one entry per rebuild of the want map
    liveLog: [],          // sampled live queue depth on the early-return path
    updates: 0,
    rescans: 0,
    earlyReturns: 0,
    liveEvery: 0,         // set >0 to sample the early-return path
    _wasRescan: false,
    label: 'init',
  };
  window.__sq = S;

  const origUpdate = w.update;
  w.update = function patchedUpdate(pos) {
    S.updates++;
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);
    // Same condition src/streaming.js uses to decide whether to rebuild `want`.
    const moved = pcx !== this._lastCx || pcz !== this._lastCz;
    S._wasRescan = moved || !this._want;
    if (S._wasRescan) S.rescans++; else S.earlyReturns++;
    return origUpdate.call(this, pos);
  };

  const origDrain = w._drainQueue;
  w._drainQueue = function patchedDrain(want, pcx, pcz, t0) {
    // On the rescan path this runs AFTER `this.queue` is rebuilt and after
    // `stats.queued` is assigned, and BEFORE a single entry is drained. So the
    // snapshot below is exactly the rebuild loop's classification.
    if (S._wasRescan) {
      let missing = 0, lodDiff = 0;
      for (const e of this.queue) { if (e.swap) lodDiff++; else missing++; }
      S.rescanLog.push({
        label: S.label,
        ms: Math.round(performance.now()),
        frames: D.frames,
        pcx, pcz,
        wantSize: want.size,
        queueLen: this.queue.length,
        statsQueued: this.stats.queued,
        missing,                                   // the `!cur` branch
        lodDiff,                                   // the `cur.lod !== lod` branch
        alreadyCorrect: want.size - this.queue.length,
        loadedBefore: this.loaded.size,
        pendingUnload: this._pendingUnload.size,
        inFlight: this.job ? 1 : 0,
      });
      if (S.rescanLog.length > 3000) S.rescanLog.shift();
      S._wasRescan = false;
    } else if (S.liveEvery && S.updates % S.liveEvery === 0) {
      S.liveLog.push({
        label: S.label,
        ms: Math.round(performance.now()),
        liveDepth: this.queue.length,             // what a real backlog gauge reads
        statsQueued: this.stats.queued,           // what report() actually reports
        loaded: this.loaded.size,
        wantSize: this._want ? this._want.size : -1,
        inFlight: this.job ? 1 : 0,
        pendingUnload: this._pendingUnload.size,
      });
      if (S.liveLog.length > 3000) S.liveLog.shift();
    }
    return origDrain.call(this, want, pcx, pcz, t0);
  };

  // Park it. With an autopilot installed main.js stops feeding the vehicle
  // controls at all, so it cannot creep across a boundary mid-measurement.
  D.setAutopilot(() => {});

  const keys = Object.keys(D.district.chunks);
  return {
    chunkSize: w.chunkSize,
    nearRadius: w.nearRadius,
    farRadius: w.farRadius,
    budgetMs: w.budgetMs,
    unloadsPerUpdate: w.unloadsPerUpdate,
    bakedChunks: keys.length,
    ringCells: (w.farRadius * 2 + 1) ** 2,
    spawn: { x: +D.vehicle.position.x.toFixed(1), z: +D.vehicle.position.z.toFixed(1) },
    mode: D.mode,
    traffic: D.trafficReport() ? D.trafficReport().alive : 0,
    peds: D.pedestrianReport() ? D.pedestrianReport().alive ?? null : null,
  };
});

// A read-only recomputation of the want map from the streamer's own
// `desiredLod`, classified against `this.loaded`. It answers "what would the
// rebuild loop decide RIGHT NOW" without perturbing anything - which is the
// only way to ask the question while parked, because parked, the loop never
// runs. Cross-checked against the instrumented forced rescan below; if the two
// disagree, the recomputation is wrong and nothing derived from it stands.
async function recompute(label) {
  return page.evaluate((lbl) => {
    const D = window.__district, w = D.world;
    const pos = D.mode === 'foot' ? D.player.position : D.vehicle.position;
    const pcx = Math.floor(pos.x / w.chunkSize), pcz = Math.floor(pos.z / w.chunkSize);
    let wantSize = 0, missing = 0, lodDiff = 0, correct = 0;
    for (let dz = -w.farRadius; dz <= w.farRadius; dz++) {
      for (let dx = -w.farRadius; dx <= w.farRadius; dx++) {
        const cx = pcx + dx, cz = pcz + dz, key = `${cx},${cz}`;
        if (!D.district.chunks[key]) continue;
        const lod = w.desiredLod(cx, cz, pos.x, pos.z);
        if (lod === null) continue;
        wantSize++;
        const cur = w.loaded.get(key);
        if (!cur) missing++;
        else if (cur.lod !== lod) lodDiff++;
        else correct++;
      }
    }
    const r = w.report();
    return {
      label: lbl,
      ms: Math.round(performance.now()),
      frames: D.frames,
      pcx, pcz,
      px: +pos.x.toFixed(1), pz: +pos.z.toFixed(1),
      lastCx: w._lastCx, lastCz: w._lastCz,
      recomputedWant: wantSize,
      recomputedMissing: missing,
      recomputedLodDiff: lodDiff,
      recomputedCorrect: correct,
      wouldQueue: missing + lodDiff,          // what a fresh rebuild would push
      liveQueueDepth: w.queue.length,         // what is actually waiting to build
      inFlight: w.job ? 1 : 0,
      storedWantSize: w._want ? w._want.size : -1,
      reportedQueued: r.queued,               // the number under investigation
      chunksLoaded: r.chunksLoaded,
      lodNear: r.lodNear, lodFar: r.lodFar,
      meshes: r.meshes, triangles: r.triangles,
      loads: r.loads, unloads: r.unloads, lodSwaps: r.lodSwaps,
      pendingUnload: r.pendingUnload,
      updates: window.__sq.updates,
      rescans: window.__sq.rescans,
      earlyReturns: window.__sq.earlyReturns,
    };
  }, label);
}

const setLabel = (l) => page.evaluate((v) => { window.__sq.label = v; }, l);
const setLiveEvery = (n) => page.evaluate((v) => { window.__sq.liveEvery = v; }, n);

// ---------------------------------------------------------------- 1. settle
// "Confirm what is in the sample, and when it was taken." A fixed short wait
// measures a half-built district; this waits on a criterion and records the
// series so the criterion can be audited.
await setLabel('fill');
await setLiveEvery(60);
const settleSeries = [];
let settled = null, stable = 0;
const t0 = Date.now();
while (Date.now() - t0 < SETTLE_CAP_MS) {
  await wait(POLL_MS);
  const s = await recompute('settle');
  settleSeries.push(s);
  const prev = settleSeries[settleSeries.length - 2];
  const same = prev
    && prev.chunksLoaded === s.chunksLoaded && prev.meshes === s.meshes
    && prev.loads === s.loads && prev.unloads === s.unloads
    && prev.pendingUnload === s.pendingUnload && prev.liveQueueDepth === s.liveQueueDepth;
  stable = same ? stable + 1 : 0;
  if (stable >= SETTLE_STABLE_POLLS && Date.now() - t0 >= SETTLE_FLOOR_MS) { settled = s; break; }
}
const settleMs = Date.now() - t0;

// ---------------------------------------------------------------- 2. parked
// The counter's headline claim: does it move while nothing else does?
await setLabel('parked');
const parkedSeries = [];
for (let i = 0; i < 12; i++) {
  await wait(POLL_MS);
  parkedSeries.push(await recompute('parked'));
}

// ---------------------------------------------------------------- 3. control C
// Force one rebuild on the SETTLED world by invalidating the boundary cache and
// letting the normal loop do the rescan itself (no synthetic update call). If
// the counter is a stale gauge this collapses; if chunks are genuinely being
// re-queued every rebuild it stays high. This is also the cross-check for the
// read-only recomputation above - the instrumented rescan entry and the
// recomputed verdict must agree.
const beforeForced = await recompute('before-forced-rescan');
await setLabel('forced-rescan');
await page.evaluate(() => { window.__district.world._lastCx = NaN; });
await wait(1500);
const afterForced = await recompute('after-forced-rescan');

// ---------------------------------------------------------------- 4. control B
// Opposite reading: teleport across the district. The instrument must SPIKE.
const target = await page.evaluate(() => {
  const D = window.__district, w = D.world;
  const pos = D.vehicle.position;
  const pcx = Math.floor(pos.x / w.chunkSize), pcz = Math.floor(pos.z / w.chunkSize);
  let best = null, bestD = -1;
  for (const key of Object.keys(D.district.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    const d = Math.max(Math.abs(cx - pcx), Math.abs(cz - pcz));
    // Needs a populated neighbourhood, or "far away" just means "off the map".
    let neigh = 0;
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) if (D.district.chunks[`${cx + dx},${cz + dz}`]) neigh++;
    }
    if (neigh < 20) continue;
    if (d > bestD) { bestD = d; best = { cx, cz, neigh }; }
  }
  return best ? { ...best, chebyshev: bestD, x: (best.cx + 0.5) * w.chunkSize, z: (best.cz + 0.5) * w.chunkSize } : null;
});

await setLabel('teleport');
await page.evaluate((t) => { window.__district.placeAt(t.x, t.z); }, target);
await wait(700);
const rightAfterTeleport = await recompute('right-after-teleport');

// Let it settle again at the new spot, on the same criterion.
await setLabel('teleport-settle');
const teleSeries = [];
let teleSettled = null; stable = 0;
const t1 = Date.now();
while (Date.now() - t1 < SETTLE_CAP_MS) {
  await wait(POLL_MS);
  const s = await recompute('teleport-settle');
  teleSeries.push(s);
  const prev = teleSeries[teleSeries.length - 2];
  const same = prev
    && prev.chunksLoaded === s.chunksLoaded && prev.meshes === s.meshes
    && prev.loads === s.loads && prev.unloads === s.unloads
    && prev.pendingUnload === s.pendingUnload && prev.liveQueueDepth === s.liveQueueDepth;
  stable = same ? stable + 1 : 0;
  if (stable >= SETTLE_STABLE_POLLS && Date.now() - t1 >= SETTLE_FLOOR_MS) { teleSettled = s; break; }
}

// ---------------------------------------------------------------- 5. march
// Cross chunk boundaries deliberately, at two dwell times. This is what a drive
// does to the streamer, minus the physics and minus any timing claim. Slow dwell
// lets the queue drain between crossings; fast dwell does not, which is where a
// genuine backlog - if there is one - has to show up.
async function march(label, steps, dwellMs) {
  await setLabel(label);
  const start = await page.evaluate(() => {
    const D = window.__district, w = D.world;
    return {
      cx: Math.floor(D.vehicle.position.x / w.chunkSize),
      cz: Math.floor(D.vehicle.position.z / w.chunkSize),
      chunkSize: w.chunkSize,
    };
  });
  const marks = [];
  for (let i = 1; i <= steps; i++) {
    await page.evaluate(({ s, i }) => {
      window.__district.placeAt((s.cx + i + 0.5) * s.chunkSize, (s.cz + 0.5) * s.chunkSize);
    }, { s: start, i });
    await wait(dwellMs);
    marks.push(await recompute(`${label}-${i}`));
  }
  return { dwellMs, steps, start, marks };
}

// Reposition to one end of a long baked row so the march stays on the map.
const marchStart = await page.evaluate(() => {
  const D = window.__district, w = D.world;
  const rows = new Map();
  for (const key of Object.keys(D.district.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    if (!rows.has(cz)) rows.set(cz, []);
    rows.get(cz).push(cx);
  }
  let best = null;
  for (const [cz, xs] of rows) {
    xs.sort((a, b) => a - b);
    const span = xs[xs.length - 1] - xs[0];
    // Densest row, not longest: a long sparse row marches off the map.
    if (!best || xs.length > best.count) best = { cz, x0: xs[0], span, count: xs.length };
  }
  D.placeAt((best.x0 + 0.5) * w.chunkSize, (best.cz + 0.5) * w.chunkSize);
  return best;
});
await setLabel('march-settle');
await wait(SETTLE_FLOOR_MS);
const beforeMarch = await recompute('before-march');

const marchSlow = await march('march-slow', Math.min(6, marchStart.span), 2500);
await setLabel('march-regap');
await wait(12000);
const marchFast = await march('march-fast', Math.min(8, marchStart.span), 350);

// ---------------------------------------------------------------- 6. drain
const logs = await page.evaluate(() => ({
  updates: window.__sq.updates,
  rescans: window.__sq.rescans,
  earlyReturns: window.__sq.earlyReturns,
  rescanLog: window.__sq.rescanLog,
  liveLog: window.__sq.liveLog,
}));

const out = {
  probe: 'stream-queue-probe',
  when: new Date().toISOString(),
  meta,
  settle: {
    floorMs: SETTLE_FLOOR_MS, stablePollsRequired: SETTLE_STABLE_POLLS,
    tookMs: settleMs, reachedCriterion: !!settled, series: settleSeries,
  },
  parked: parkedSeries,
  forcedRescan: { before: beforeForced, after: afterForced },
  teleport: { target, rightAfter: rightAfterTeleport, settled: teleSettled, series: teleSeries },
  march: { start: marchStart, before: beforeMarch, slow: marchSlow, fast: marchFast },
  counters: { updates: logs.updates, rescans: logs.rescans, earlyReturns: logs.earlyReturns },
  rescanLog: logs.rescanLog,
  liveLog: logs.liveLog,
  errors,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

// ---------------------------------------------------------------- summary
const f = (n) => String(n).padStart(6);
console.log('--- stream queue probe ---');
console.log(`baked chunks ${meta.bakedChunks}  ring ${meta.ringCells} cells  near/far ${meta.nearRadius}/${meta.farRadius}`);
console.log(`settle: ${(settleMs / 1000).toFixed(1)}s  criterion ${settled ? 'MET' : 'NOT MET'}`);
console.log(`update calls ${logs.updates}  rescans ${logs.rescans}  early-returns ${logs.earlyReturns}`);
console.log('');
console.log('                         reported  live  want  missing  lodDiff  correct  loaded');
const row = (name, s) => console.log(
  `${name.padEnd(24)}${f(s.reportedQueued)}${f(s.liveQueueDepth)}${f(s.recomputedWant)}` +
  `${f(s.recomputedMissing)}${f(s.recomputedLodDiff)}${f(s.recomputedCorrect)}${f(s.chunksLoaded)}`);
if (settled) row('settled (parked)', settled);
for (const s of parkedSeries.slice(0, 3)) row('parked', s);
row('before forced rescan', beforeForced);
row('after forced rescan', afterForced);
row('right after teleport', rightAfterTeleport);
if (teleSettled) row('teleport settled', teleSettled);
row('before march', beforeMarch);
for (const m of marchSlow.marks) row(`march slow ${m.label.slice(-2)}`, m);
for (const m of marchFast.marks) row(`march fast ${m.label.slice(-2)}`, m);
console.log('');
console.log(`rescan events logged: ${logs.rescanLog.length}`);
for (const r of logs.rescanLog.slice(0, 4)) console.log('  ', JSON.stringify(r));
console.log('   ...');
for (const r of logs.rescanLog.slice(-4)) console.log('  ', JSON.stringify(r));
if (errors.length) console.log('errors', errors.slice(0, 5));
console.log(`wrote ${OUT}`);

await browser.close();
