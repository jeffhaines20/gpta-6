// Streaming churn census: what the streamer leaves behind over a long walk.
//
// Three questions, all raised by an adversarial review of the _pendingUnload fix
// and none of them answerable from a parked scene:
//
//  1. DUPLICATE BUILDS. `_drainQueue` guards a dequeued entry with
//     `if (!want.has(next.key)) continue;` and never consults `this.loaded`. A
//     rescan rebuilds the queue from want-vs-loaded, and the chunk currently
//     being built is in NEITHER map - `this.job` is not `this.loaded` yet - so
//     it is queued a second time. The job lands and writes `loaded`; the
//     duplicate then dequeues with swap:false, so nothing is disposed, and a
//     SECOND group is added to root. The first is orphaned: still parented,
//     still drawn, still holding its GPU buffers, invisible to `this.loaded`.
//
//  2. SWAP WITHOUT DELETE. The LOD-swap branch disposes `this.loaded.get(key)`
//     but does not delete the key, so between the dispose and the rebuild
//     landing, `this.loaded` points at a group that is no longer in the scene.
//     `report().chunksLoaded` counts it, and a rescan in that window reads its
//     stale `cur.lod` and can conclude "already correct" about a chunk that is
//     not there.
//
//  3. THE `queued === 0` CONTRACT. report() now advertises a live depth. This
//     checks, on EVERY update rather than by polling, whether a zero reading
//     really does mean every wanted chunk is present at its wanted LOD - and
//     separately how often a zero reading coexists with chunks still awaiting
//     disposal, which is a different thing and must not be claimed.
//
// The walk is driven through setAutopilot + setTimeScale so the streamer gets
// thousands of updates without needing thousands of rendered frames: this
// container renders through SwiftShader and other harnesses share it. It is a
// zig-zag with reversals, because a straight line never re-enters a chunk it
// has just left and therefore cannot reach any of the three.
//
// Counts and object identities only. No timing is reported.
// Output: docs/stream-churn.json (SQ_OUT to override, SQ_PORT to aim at another tree)
import { chromium } from 'playwright';
import { launchOptions } from './browser.mjs';
import { ensureServer } from './serve.mjs';
import fs from 'node:fs';

const OUT = process.env.SQ_OUT || 'docs/stream-churn.json';
const PORT = Number(process.env.SQ_PORT || 8123);
const TARGET_UPDATES = Number(process.env.SQ_UPDATES || 2500);
const TIME_SCALE = Number(process.env.SQ_TIMESCALE || 25);
const SETTLE_FLOOR_MS = Number(process.env.SQ_SETTLE_MS || 32000);

fs.mkdirSync('docs', { recursive: true });
await ensureServer(PORT);
const browser = await chromium.launch(launchOptions());
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push('PAGEERROR: ' + e.message));
await page.goto(`http://127.0.0.1:${PORT}/district/`, { waitUntil: 'networkidle' });
await page.waitForFunction('window.__district && window.__district.frames > 5', null, { timeout: 90000 });

const meta = await page.evaluate(() => {
  const D = window.__district, w = D.world;
  const S = {
    updates: 0, rescans: 0,
    // 1. duplicate builds
    beginWhileLoaded: 0, beginWhileLoadedLiveGroup: 0, beginWhileLoadedSameLod: 0,
    overwroteLiveGroup: 0, overwroteSamples: [],
    // 2. swap without delete
    updatesWithStaleLoadedEntry: 0, maxStaleLoadedEntries: 0,
    // 3. contract
    samples: 0, zeroQueued: 0, zeroQueuedUnsatisfied: 0, zeroQueuedRingStale: 0, zeroQueuedWithPending: 0,
    maxPendingAtZeroQueued: 0, violations: [],
  };
  window.__sq = S;

  // Orphan detection at the source: overwriting a `loaded` entry whose group is
  // still parented means the old group stays in root with nothing referencing it.
  const origSet = w.loaded.set.bind(w.loaded);
  w.loaded.set = function (k, v) {
    const prev = w.loaded.get(k);
    if (prev && prev.group && prev.group.parent && prev.group !== v.group) {
      S.overwroteLiveGroup++;
      if (S.overwroteSamples.length < 20) {
        S.overwroteSamples.push({ key: k, oldLod: prev.lod, newLod: v.lod, updates: S.updates });
      }
    }
    return origSet(k, v);
  };

  const origBegin = w._beginBuild;
  w._beginBuild = function (key, lod) {
    const cur = this.loaded.get(key);
    if (cur) {
      S.beginWhileLoaded++;
      if (cur.group && cur.group.parent) S.beginWhileLoadedLiveGroup++;
      if (cur.lod === lod) S.beginWhileLoadedSameLod++;
    }
    return origBegin.call(this, key, lod);
  };

  const origUpdate = w.update;
  w.update = function (pos) {
    S.updates++;
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);
    if (pcx !== this._lastCx || pcz !== this._lastCz || !this._want) S.rescans++;
    const r = origUpdate.call(this, pos);

    // `loaded` entries whose group is no longer in the scene graph.
    let stale = 0;
    for (const e of this.loaded.values()) if (!e.group || !e.group.parent) stale++;
    if (stale) { S.updatesWithStaleLoadedEntry++; if (stale > S.maxStaleLoadedEntries) S.maxStaleLoadedEntries = stale; }

    S.samples++;
    const queued = this.queue.length + (this.job ? 1 : 0);
    if (queued === 0) {
      S.zeroQueued++;
      // THE CONTRACT: against the want map the streamer actually committed to at
      // the last crossing. This is what `queued === 0` is allowed to promise.
      let bad = 0;
      if (this._want) {
        for (const [key, lod] of this._want) {
          const cur = this.loaded.get(key);
          if (!cur || cur.lod !== lod) bad++;
        }
      }
      if (bad) {
        S.zeroQueuedUnsatisfied++;
        if (S.violations.length < 20) S.violations.push({ updates: S.updates, bad });
      }
      // NOT the contract: the ring recomputed at the position right now. The
      // streamer only rebuilds `want` on a chunk-boundary crossing, so between
      // crossings this deliberately disagrees. Counted separately so it is never
      // mistaken for a defect - it is the documented design.
      const cx0 = Math.floor(pos.x / this.chunkSize), cz0 = Math.floor(pos.z / this.chunkSize);
      let stale = 0;
      for (let dz = -this.farRadius; dz <= this.farRadius; dz++) {
        for (let dx = -this.farRadius; dx <= this.farRadius; dx++) {
          const cx = cx0 + dx, cz = cz0 + dz, key = `${cx},${cz}`;
          if (!this.d.chunks[key]) continue;
          const lod = this.desiredLod(cx, cz, pos.x, pos.z);
          if (lod === null) continue;
          const cur = this.loaded.get(key);
          if (!cur || cur.lod !== lod) stale++;
        }
      }
      if (stale) S.zeroQueuedRingStale++;
      if (this._pendingUnload.size) {
        S.zeroQueuedWithPending++;
        if (this._pendingUnload.size > S.maxPendingAtZeroQueued) S.maxPendingAtZeroQueued = this._pendingUnload.size;
      }
    }
    return r;
  };

  let best = null;
  for (const key of Object.keys(D.district.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    let n = 0;
    for (let dz = -5; dz <= 5; dz++) {
      for (let dx = -5; dx <= 5; dx++) if (D.district.chunks[`${cx + dx},${cz + dz}`]) n++;
    }
    if (!best || n > best.n) best = { cx, cz, n };
  }
  D.setAutopilot(() => {});
  D.placeAt((best.cx + 0.5) * w.chunkSize, (best.cz + 0.5) * w.chunkSize);
  return { chunkSize: w.chunkSize, nearRadius: w.nearRadius, farRadius: w.farRadius,
    unloadsPerUpdate: w.unloadsPerUpdate, home: best };
});

// Chunk groups sitting in root that `loaded` does not reference: orphans.
const census = (label) => page.evaluate((lbl) => {
  const D = window.__district, w = D.world;
  const live = new Set();
  for (const e of w.loaded.values()) live.add(e.group);
  let chunkGroups = 0, orphanGroups = 0, orphanMeshes = 0, orphanTris = 0;
  const orphanKeys = [];
  for (const child of w.root.children) {
    if (!child.name || !child.name.startsWith('chunk:')) continue;
    chunkGroups++;
    if (live.has(child)) continue;
    orphanGroups++;
    if (orphanKeys.length < 20) orphanKeys.push(child.name);
    child.traverse((o) => {
      if (o.isMesh && o.geometry && o.geometry.index) { orphanMeshes++; orphanTris += o.geometry.index.count / 3; }
    });
  }
  let staleLoaded = 0;
  for (const e of w.loaded.values()) if (!e.group || !e.group.parent) staleLoaded++;
  const r = w.report();
  return { label: lbl, updates: window.__sq.updates, rescans: window.__sq.rescans,
    liveQueued: w.queue.length + (w.job ? 1 : 0),
    chunkGroupsInRoot: chunkGroups, orphanGroups, orphanMeshes, orphanTris: Math.round(orphanTris),
    orphanKeys, staleLoadedEntries: staleLoaded,
    loaded: w.loaded.size, reportedMeshes: r.meshes, reportedTriangles: r.triangles,
    reportedQueued: r.queued, pendingUnload: r.pendingUnload,
    loads: r.loads, unloads: r.unloads, lodSwaps: r.lodSwaps };
}, label);

// Polls rather than waitForFunction so a slow container reports progress
// instead of dying at a timeout with nothing to show for it.
const waitUpdates = async (n, capMs = 900000) => {
  const start = await page.evaluate(() => window.__sq.updates);
  const t = Date.now();
  let last = start;
  while (Date.now() - t < capMs) {
    await page.waitForTimeout(3000);
    const now = await page.evaluate(() => window.__sq.updates);
    if (now !== last) { process.stdout.write(`\r  updates ${now - start}/${n}   `); last = now; }
    if (now >= start + n) { process.stdout.write('\n'); return now; }
  }
  process.stdout.write('\n');
  console.error(`waitUpdates: only reached ${last - start} of ${n} - reporting what was measured`);
  return last;
};

// settle before the walk, so the fill burst is not counted as churn
const t0 = Date.now();
let settled = null;
while (Date.now() - t0 < 180000) {
  await page.waitForTimeout(1000);
  const c = await census('settle');
  if (c.liveQueued === 0 && c.pendingUnload === 0 && Date.now() - t0 >= SETTLE_FLOOR_MS) { settled = c; break; }
}
const beforeWalk = await page.evaluate(() => {
  const S = window.__sq;
  // Zero the counters so the walk is measured, not the fill.
  for (const k of ['beginWhileLoaded', 'beginWhileLoadedLiveGroup', 'beginWhileLoadedSameLod',
    'overwroteLiveGroup', 'updatesWithStaleLoadedEntry', 'maxStaleLoadedEntries',
    'samples', 'zeroQueued', 'zeroQueuedUnsatisfied', 'zeroQueuedRingStale', 'zeroQueuedWithPending',
    'maxPendingAtZeroQueued']) S[k] = 0;
  S.overwroteSamples.length = 0; S.violations.length = 0;
  return S.updates;
});
const settleCensus = await census('after-settle');

// The walk: a zig-zag with reversals across the densest neighbourhood.
await page.evaluate(({ home, chunkSize, timeScale }) => {
  const D = window.__district;
  const hx = (home.cx + 0.5) * chunkSize, hz = (home.cz + 0.5) * chunkSize;
  let k = 0;
  D.setAutopilot(() => {
    k++;
    // Triangle wave over +/-3 chunks in x, sine over +/-2 in z. This is a
    // STRESS walk, not a route simulation: it crosses a chunk boundary roughly
    // every 10 updates and reverses direction every 60, where a real drive
    // crosses one every few hundred. It is shaped to reach the reversal cases a
    // straight line cannot, so counts below are an upper bound on churn, not a
    // prediction of the route's.
    const tri = (p) => 4 * Math.abs(p / 120 - Math.floor(p / 120 + 0.5)) - 1;   // -1..1
    D.vehicle.position.set(hx + 3 * chunkSize * tri(k), 0.55, hz + 2 * chunkSize * Math.sin(k / 160));
    D.vehicle.velocity.set(0, 0, 0);
    D.vehicle.angularVelocity.set(0, 0, 0);
  });
  D.setTimeScale(timeScale);
}, { home: meta.home, chunkSize: meta.chunkSize, timeScale: TIME_SCALE });

await waitUpdates(TARGET_UPDATES);
const walkEnd = await census('walk-end');

// Stop and let it settle, then take the census that matters: what is left in
// root when the streamer has nothing outstanding.
await page.evaluate(({ home, chunkSize }) => {
  const D = window.__district;
  D.setAutopilot(() => {
    D.vehicle.position.set((home.cx + 0.5) * chunkSize, 0.55, (home.cz + 0.5) * chunkSize);
    D.vehicle.velocity.set(0, 0, 0);
  });
  D.setTimeScale(1);
}, { home: meta.home, chunkSize: meta.chunkSize });
let rest = null;
const t1 = Date.now();
while (Date.now() - t1 < 180000) {
  await page.waitForTimeout(1500);
  const c = await census('rest');
  if (c.liveQueued === 0 && c.pendingUnload === 0 && Date.now() - t1 >= SETTLE_FLOOR_MS) { rest = c; break; }
}
const restFinal = rest ?? await census('rest-timeout');
const counters = await page.evaluate(() => ({ ...window.__sq, overwroteSamples: window.__sq.overwroteSamples,
  violations: window.__sq.violations }));

const out = { probe: 'stream-churn-probe', when: new Date().toISOString(), port: PORT, meta,
  settleReached: !!settled, updatesBeforeWalk: beforeWalk, settleCensus, walkEnd,
  restReached: !!rest, rest: restFinal, counters, errors };
fs.writeFileSync(OUT, JSON.stringify(out, null, 2));

const c = counters;
console.log('--- streaming churn probe ---   port', PORT);
console.log('home', JSON.stringify(meta.home), ' settle', settled ? 'MET' : 'NOT MET',
  ' rest', rest ? 'MET' : 'NOT MET');
console.log(`walk: ${c.updates - beforeWalk} updates, ${c.rescans} rescans total`);
console.log('');
console.log('1. duplicate builds');
console.log(`   _beginBuild called while the key was already in loaded : ${c.beginWhileLoaded}`);
console.log(`     ...of those, the existing group was still in the scene: ${c.beginWhileLoadedLiveGroup}`);
console.log(`     ...of those, at the SAME lod (pure duplicate)         : ${c.beginWhileLoadedSameLod}`);
console.log(`   loaded.set overwrote a still-parented group (orphaned)  : ${c.overwroteLiveGroup}`);
console.log('2. swap without delete');
console.log(`   updates with a loaded entry whose group left the scene  : ${c.updatesWithStaleLoadedEntry} of ${c.samples}`);
console.log(`   worst simultaneous                                      : ${c.maxStaleLoadedEntries}`);
console.log('3. queued === 0 contract');
console.log(`   zero-queued samples                                     : ${c.zeroQueued} of ${c.samples}`);
console.log(`   ...violating the contract (vs the committed want map)  : ${c.zeroQueuedUnsatisfied}`);
console.log(`   ...ring stale vs the position right now (BY DESIGN)     : ${c.zeroQueuedRingStale}`);
console.log(`   ...where chunks were still awaiting disposal            : ${c.zeroQueuedWithPending} (worst ${c.maxPendingAtZeroQueued})`);
console.log('');
console.log('census at rest:', JSON.stringify(restFinal, null, 2));
if (errors.length) console.log('errors', errors.slice(0, 4));
console.log(`wrote ${OUT}`);
await browser.close();
