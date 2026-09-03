// Follow-up to tools/stream-queue-probe.mjs.
//
// That probe settled the reported defect: `stats.queued` is a stale scan-time
// gauge, and at rest the rebuild loop re-queues NOTHING (want 44 / missing 0 /
// lodDiff 0 / already-correct 44). While reading the surrounding code to prove
// that, one asymmetry stood out and the first probe's motion pattern - always
// +x, never back - could not reach it:
//
//   * A chunk that leaves `want` is put in `_pendingUnload` (rescan path only).
//   * NOTHING ever takes a key back OUT of `_pendingUnload`.
//   * The drain loops dispose whatever is in there, with no `want.has(key)`
//     check, and `loaded.delete(key)`.
//   * The rebuild loop only queues a key when `!this.loaded.get(key)` - and at
//     the moment it runs, a re-wanted pending chunk IS still in `this.loaded`.
//
// So a chunk you leave and come back to before its disposal budget reaches it
// is wanted, present, NOT queued - and then deleted out from under the scene.
// It stays a hole until the next chunk-boundary crossing rescans and re-queues
// it, which then costs a full chunk build the streamer never needed to pay.
//
// That is a hypothesis from reading code, which this project does not accept as
// a finding. This measures it directly rather than inferring it: it counts keys
// that are in `want` and in `_pendingUnload` at the same time, then watches
// whether wanted chunks actually disappear with an EMPTY build queue and NO
// rescan - the signature nothing else in the streamer can produce.
//
// Controls, because an instrument is not believed until it has produced the
// opposite reading:
//   A. null control - the same watch window from a settled world with no
//      u-turn. `missing` must stay 0 and the overlap must stay 0.
//   B. recovery control - force one rescan afterwards. The holes must appear in
//      the queue and refill, which proves they were real and unqueued.
//
// Counts only. No timing number is reported: SwiftShader, and other harnesses
// share this container. Progress is measured in `update()` calls, not seconds,
// so the result does not depend on how fast the page happens to be running.
//
// Output: docs/stream-uturn.json
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/stream-uturn.json';
const SETTLE_FLOOR_MS = Number(process.env.SQ_SETTLE_MS || 32000);
const SETTLE_CAP_MS = 180000;

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

const meta = await page.evaluate(() => {
  const D = window.__district, w = D.world;
  const S = { updates: 0, rescans: 0, rescanLog: [] };
  window.__sq = S;

  const origUpdate = w.update;
  w.update = function patched(pos) {
    S.updates++;
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);
    if (pcx !== this._lastCx || pcz !== this._lastCz || !this._want) {
      S.rescans++;
      S.pendingRescan = { pcx, pcz, updates: S.updates };
    }
    return origUpdate.call(this, pos);
  };
  const origDrain = w._drainQueue;
  w._drainQueue = function patched(want, pcx, pcz, t0) {
    if (S.pendingRescan) {
      let missing = 0, lodDiff = 0;
      for (const e of this.queue) { if (e.swap) lodDiff++; else missing++; }
      let wantedAndPending = 0;
      for (const k of want.keys()) if (this._pendingUnload.has(k)) wantedAndPending++;
      S.rescanLog.push({
        ...S.pendingRescan, wantSize: want.size, queued: this.stats.queued,
        missing, lodDiff, alreadyCorrect: want.size - this.queue.length,
        loaded: this.loaded.size, pendingUnload: this._pendingUnload.size,
        wantedAndPending,
      });
      S.pendingRescan = null;
    }
    return origDrain.call(this, want, pcx, pcz, t0);
  };

  D.setAutopilot(() => {});

  // Park in the densest neighbourhood so the ring is full and a whole column
  // actually exists to leave and come back to.
  let best = null;
  for (const key of Object.keys(D.district.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    let n = 0;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) if (D.district.chunks[`${cx + dx},${cz + dz}`]) n++;
    }
    if (!best || n > best.n) best = { cx, cz, n };
  }
  D.placeAt((best.cx + 0.5) * w.chunkSize, (best.cz + 0.5) * w.chunkSize);
  return { chunkSize: w.chunkSize, nearRadius: w.nearRadius, farRadius: w.farRadius,
    unloadsPerUpdate: w.unloadsPerUpdate, budgetMs: w.budgetMs, home: best };
});

const snap = (label) => page.evaluate((lbl) => {
  const D = window.__district, w = D.world;
  const pos = D.vehicle.position;
  const pcx = Math.floor(pos.x / w.chunkSize), pcz = Math.floor(pos.z / w.chunkSize);
  let wantSize = 0, missing = 0, lodDiff = 0, correct = 0, wantedAndPending = 0;
  const holes = [];
  for (let dz = -w.farRadius; dz <= w.farRadius; dz++) {
    for (let dx = -w.farRadius; dx <= w.farRadius; dx++) {
      const cx = pcx + dx, cz = pcz + dz, key = `${cx},${cz}`;
      if (!D.district.chunks[key]) continue;
      const lod = w.desiredLod(cx, cz, pos.x, pos.z);
      if (lod === null) continue;
      wantSize++;
      if (w._pendingUnload.has(key)) wantedAndPending++;
      const cur = w.loaded.get(key);
      if (!cur) { missing++; holes.push({ key, lod, d: Math.max(Math.abs(dx), Math.abs(dz)) }); }
      else if (cur.lod !== lod) lodDiff++;
      else correct++;
    }
  }
  // Is any hole inside the near ring - i.e. full-detail geometry missing right
  // next to the player, not a far-tier box on the horizon?
  const nearHoles = holes.filter((h) => h.d <= w.nearRadius).length;
  const r = w.report();
  return {
    label: lbl, ms: Math.round(performance.now()), frames: D.frames,
    updates: window.__sq.updates, rescans: window.__sq.rescans,
    pcx, pcz, wantSize, missing, lodDiff, correct, wantedAndPending,
    nearHoles, holes: holes.slice(0, 12),
    liveQueueDepth: w.queue.length, inFlight: w.job ? 1 : 0,
    reportedQueued: r.queued, chunksLoaded: r.chunksLoaded, meshes: r.meshes,
    triangles: r.triangles, loads: r.loads, unloads: r.unloads,
    lodSwaps: r.lodSwaps, pendingUnload: r.pendingUnload,
  };
}, label);

// Progress is counted in update() calls, not milliseconds, so the result does
// not depend on how fast this container happens to be rendering.
async function waitUpdates(n, capMs = 120000) {
  const start = await page.evaluate(() => window.__sq.updates);
  await page.waitForFunction(
    (a) => window.__sq.updates >= a.start + a.n, { start, n }, { timeout: capMs },
  );
}
const moveTo = (cx, cz) => page.evaluate(({ cx, cz }) => {
  const D = window.__district, w = D.world;
  D.placeAt((cx + 0.5) * w.chunkSize, (cz + 0.5) * w.chunkSize);
}, { cx, cz });

// ------------------------------------------------------------------- settle
// Content-based criterion, not "nothing changed for a while": the world is
// settled when it holds exactly what it wants and has no work outstanding.
const settleSeries = [];
let settled = null;
const t0 = Date.now();
while (Date.now() - t0 < SETTLE_CAP_MS) {
  await page.waitForTimeout(1000);
  const s = await snap('settle');
  settleSeries.push(s);
  if (s.missing === 0 && s.lodDiff === 0 && s.liveQueueDepth === 0 && s.inFlight === 0
      && s.pendingUnload === 0 && Date.now() - t0 >= SETTLE_FLOOR_MS) { settled = s; break; }
}
if (!settled) { console.error('world never settled - readings below are not trustworthy'); }

// --------------------------------------------------------- A. null control
// Same watch window, no u-turn. If wanted chunks vanish here too, the u-turn is
// not what is doing it.
const nullControl = [];
for (let i = 0; i < 8; i++) { await waitUpdates(1); nullControl.push(await snap('null-control')); }

// ------------------------------------------------------------- B. the u-turn
const home = meta.home;
const before = await snap('before-uturn');
await moveTo(home.cx + 1, home.cz);          // cross one boundary: trailing column leaves want
await waitUpdates(1);
const away = await snap('away');
await waitUpdates(3);                         // let a few - not all - pending disposals land
const awaySettleIsh = await snap('away-dwell');
await moveTo(home.cx, home.cz);              // cross straight back: that column is wanted again
await waitUpdates(1);
const backImmediate = await snap('back-immediately');

// Watch, without crossing another boundary. No rescan can happen here, so the
// queue cannot be refilled: anything that disappears, disappears for good.
const watch = [];
for (let i = 0; i < 24; i++) { await waitUpdates(1); watch.push(await snap(`watch-${i + 1}`)); }

// ---------------------------------------------------- C. recovery control
// One forced rescan. The holes must show up in the queue and refill.
await page.evaluate(() => { window.__district.world._lastCx = NaN; });
await waitUpdates(2);
const afterForced = await snap('after-forced-rescan');
const recovery = [];
for (let i = 0; i < 20; i++) {
  await waitUpdates(1);
  const s = await snap(`recovery-${i + 1}`);
  recovery.push(s);
  if (s.missing === 0 && s.liveQueueDepth === 0 && s.inFlight === 0) break;
}

const logs = await page.evaluate(() => ({
  updates: window.__sq.updates, rescans: window.__sq.rescans, rescanLog: window.__sq.rescanLog,
}));

const out = {
  probe: 'stream-uturn-probe', when: new Date().toISOString(), meta,
  settle: { reached: !!settled, tookMs: Date.now() - t0, settled, series: settleSeries },
  nullControl, before, away, awaySettleIsh, backImmediate, watch,
  afterForced, recovery, counters: logs, errors,
};
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const hdr = 'label                 upd resc  want miss lodD  ok  w&pend nearHoles live job  rep  loaded  loads unl';
const row = (s) => `${s.label.padEnd(20)} ${String(s.updates).padStart(4)} ${String(s.rescans).padStart(4)} `
  + `${String(s.wantSize).padStart(5)} ${String(s.missing).padStart(4)} ${String(s.lodDiff).padStart(4)} `
  + `${String(s.correct).padStart(3)} ${String(s.wantedAndPending).padStart(6)} ${String(s.nearHoles).padStart(9)} `
  + `${String(s.liveQueueDepth).padStart(4)} ${String(s.inFlight).padStart(3)} ${String(s.reportedQueued).padStart(4)} `
  + `${String(s.chunksLoaded).padStart(6)} ${String(s.loads).padStart(6)} ${String(s.unloads).padStart(3)}`;
console.log('--- u-turn probe ---');
console.log('home chunk', JSON.stringify(meta.home), ' settle', settled ? 'MET' : 'NOT MET');
console.log(hdr);
if (settled) console.log(row(settled));
for (const s of nullControl) console.log(row(s));
console.log(row(before)); console.log(row(away)); console.log(row(awaySettleIsh));
console.log(row(backImmediate));
for (const s of watch) console.log(row(s));
console.log(row(afterForced));
for (const s of recovery) console.log(row(s));
console.log('\nrescans logged:');
for (const r of logs.rescanLog) console.log('  ', JSON.stringify(r));
if (errors.length) console.log('errors', errors.slice(0, 5));
console.log(`wrote ${OUT}`);
await browser.close();
