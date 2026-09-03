// Third and last question raised by tools/stream-uturn-probe.mjs.
//
// After the u-turn fix landed, one chunk was still loaded at the wrong LOD, and
// stayed that way with an EMPTY build queue and no rescan - engine-confirmed,
// not just my recomputation: the next rescan itself queued exactly one swap.
// Two candidates produce that, and they are not the same thing:
//
//   1. INSTRUMENT. `desiredLod` compares a continuous distance against integer
//      radii, so a chunk sitting exactly on the nearRadius/farRadius line flips
//      on a floating-point hair. If the parked vehicle drifts even slightly, the
//      "wrong" LOD is the reading, not the world.
//   2. A STALE IN-FLIGHT JOB. `this.queue` is thrown away and rebuilt on every
//      rescan, but `this.job` - the chunk being built right now - is not. Its
//      LOD was decided by the PREVIOUS scan. When it lands, _drainQueue writes
//      `{ lod: this.job.lod }` into `loaded` unconditionally, and the rebuild
//      loop has already run, so nothing re-queues it. It stays at the superseded
//      LOD until the next boundary crossing.
//
// These are separated by evidence, not argument: this records the exact parked
// position (candidate 1 needs it to move), records the in-flight job's key and
// LOD at the moment of the crossing (candidate 2 names a specific chunk in
// advance), and then checks which chunk actually disagrees afterwards.
//
// Counts and keys only - no timing is reported.
// Output: docs/stream-lod-inflight.json
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = 'docs/stream-lod-inflight.json';
const SETTLE_FLOOR_MS = Number(process.env.SQ_SETTLE_MS || 32000);

fs.mkdirSync('docs', { recursive: true });
await ensureServer();
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));

await page.goto('http://127.0.0.1:8123/district/', { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });

const meta = await page.evaluate(() => {
  const D = window.__district, w = D.world;
  const S = { updates: 0, rescans: 0, jobs: [] };
  window.__sq = S;
  const origUpdate = w.update;
  w.update = function patched(pos) {
    S.updates++;
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);
    if (pcx !== this._lastCx || pcz !== this._lastCz || !this._want) S.rescans++;
    // Every job the streamer starts, with the scan that chose its LOD.
    const before = this.job;
    const r = origUpdate.call(this, pos);
    if (this.job && this.job !== before) {
      S.jobs.push({ key: this.job.key, lod: this.job.lod, updates: S.updates, rescans: S.rescans });
      if (S.jobs.length > 500) S.jobs.shift();
    }
    return r;
  };
  D.setAutopilot(() => {});
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
  return { chunkSize: w.chunkSize, nearRadius: w.nearRadius, farRadius: w.farRadius, home: best };
});

// Full disagreement list, with the exact distance that decided each LOD, so a
// boundary tie is visible as a tie rather than guessed at.
const audit = (label) => page.evaluate((lbl) => {
  const D = window.__district, w = D.world;
  const pos = D.vehicle.position;
  const px = pos.x, pz = pos.z;
  const pcx = Math.floor(px / w.chunkSize), pcz = Math.floor(pz / w.chunkSize);
  const disagree = [];
  let want = 0, missing = 0, correct = 0;
  for (let dz = -w.farRadius; dz <= w.farRadius; dz++) {
    for (let dx = -w.farRadius; dx <= w.farRadius; dx++) {
      const cx = pcx + dx, cz = pcz + dz, key = `${cx},${cz}`;
      if (!D.district.chunks[key]) continue;
      const lod = w.desiredLod(cx, cz, px, pz);
      if (lod === null) continue;
      want++;
      const cur = w.loaded.get(key);
      if (!cur) { missing++; continue; }
      if (cur.lod === lod) { correct++; continue; }
      const centerX = (cx + 0.5) * w.chunkSize, centerZ = (cz + 0.5) * w.chunkSize;
      const dist = Math.max(Math.abs(centerX - px), Math.abs(centerZ - pz)) / w.chunkSize;
      disagree.push({ key, has: cur.lod, wants: lod, dist: +dist.toFixed(9),
        onBoundary: Math.abs(dist - Math.round(dist)) < 1e-6 });
    }
  }
  return {
    label: lbl, updates: window.__sq.updates, rescans: window.__sq.rescans,
    px: +px.toFixed(6), pz: +pz.toFixed(6), pcx, pcz,
    want, missing, correct, disagree,
    liveQueueDepth: w.queue.length, job: w.job ? { key: w.job.key, lod: w.job.lod } : null,
    reportedQueued: w.report().queued, chunksLoaded: w.loaded.size,
  };
}, label);

const waitUpdates = async (n, capMs = 120000) => {
  const start = await page.evaluate(() => window.__sq.updates);
  await page.waitForFunction((a) => window.__sq.updates >= a.start + a.n, { start, n }, { timeout: capMs });
};
const moveTo = (cx, cz) => page.evaluate(({ cx, cz }) => {
  const D = window.__district;
  D.placeAt((cx + 0.5) * D.world.chunkSize, (cz + 0.5) * D.world.chunkSize);
}, { cx, cz });

// settle: the world holds exactly what it wants, nothing outstanding
const t0 = Date.now();
let settled = null;
while (Date.now() - t0 < 180000) {
  await page.waitForTimeout(1000);
  const a = await audit('settle');
  if (a.missing === 0 && a.disagree.length === 0 && a.liveQueueDepth === 0 && !a.job
      && Date.now() - t0 >= SETTLE_FLOOR_MS) { settled = a; break; }
}

const home = meta.home;
await moveTo(home.cx + 1, home.cz);
// Catch the streamer mid-build: the whole question is what happens to a job that
// spans a rescan.
await page.waitForFunction(() => window.__district.world.job !== null, null, { timeout: 60000 })
  .catch(() => {});
const inFlight = await audit('away-in-flight');
const jobAtCrossing = inFlight.job;

await moveTo(home.cx, home.cz);            // rescan lands while that job is still building
await waitUpdates(1);
const justBack = await audit('just-back');
// Drain everything the rescan queued.
for (let i = 0; i < 30; i++) {
  await waitUpdates(1);
  const a = await audit('drain');
  if (a.liveQueueDepth === 0 && !a.job) { break; }
}
const afterDrain = await audit('after-drain');
const jobs = await page.evaluate(() => window.__sq.jobs);

// The verdict, stated as a prediction that either holds or does not.
const predicted = jobAtCrossing ? jobAtCrossing.key : null;
const actual = afterDrain.disagree.map((d) => d.key);
const verdict = {
  parkedPositionMoved: settled ? (settled.px !== afterDrain.px || settled.pz !== afterDrain.pz) : null,
  settledDisagreements: settled ? settled.disagree.length : null,
  jobInFlightAtCrossing: jobAtCrossing,
  disagreementsAfterDrain: afterDrain.disagree,
  predictedByStaleJob: predicted,
  staleJobExplainsIt: !!predicted && actual.length === 1 && actual[0] === predicted
    && afterDrain.disagree[0].has === jobAtCrossing.lod,
  anyOnBoundaryTie: afterDrain.disagree.some((d) => d.onBoundary),
};

fs.writeFileSync(OUT, JSON.stringify(
  { probe: 'stream-lod-inflight', when: new Date().toISOString(), meta, settled,
    inFlight, justBack, afterDrain, jobs, verdict, errors }, null, 2));

console.log('--- in-flight LOD probe ---');
console.log('home', JSON.stringify(meta.home), 'settle', settled ? 'MET' : 'NOT MET');
for (const a of [settled, inFlight, justBack, afterDrain]) {
  if (!a) continue;
  console.log(`${a.label.padEnd(16)} upd=${String(a.updates).padStart(3)} resc=${a.rescans} `
    + `pos=(${a.px},${a.pz}) want=${a.want} miss=${a.missing} ok=${a.correct} `
    + `live=${a.liveQueueDepth} job=${a.job ? a.job.key + '@lod' + a.job.lod : '-'} `
    + `rep=${a.reportedQueued} loaded=${a.chunksLoaded} disagree=${JSON.stringify(a.disagree)}`);
}
console.log('verdict', JSON.stringify(verdict, null, 2));
if (errors.length) console.log('errors', errors.slice(0, 5));
console.log(`wrote ${OUT}`);
await browser.close();
