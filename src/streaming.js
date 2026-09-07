// Chunked streaming over the baked district.
//
// Two things matter here and they pull against each other:
//   1. Draw calls. Every building in a chunk is merged into ONE geometry per
//      LOD, so a loaded chunk costs 2 draw calls (buildings + roads), not 500.
//   2. Main-thread stall. Chunk build is synchronous work on the render thread,
//      so it is budgeted per frame and the cost is measured, not assumed.
//
// It implements the Phase 1 ground.js interface (heightAt / raycastDown) so the
// existing vehicle drives on it with no changes.

import * as THREE from '../vendor/three.module.min.js';
import { extrudeFootprint, ribbon, triangulate, streetDirFor, streetDirsFor } from './geom.js';
import { planKerbs, appendKerbRun, appendKerbFan, appendKerbApron } from './kerb.js';
import {
  getMaterials, wallFamilyFor, roofFor, markingForEdge, applyMarkingUV,
  MARKINGS, SURFACE_LAYERS, SURFACE_TINTS,
} from './materials.js';
import {
  buildingStyle, appendBuilding, buffers, facadeMaterial, trimMaterial,
  generateFacadeLibrary, setAllFacadeTimes,
} from './facades.js';

export const LOD = { NEAR: 0, FAR: 1 };

// Which baked land-use tags get their own ground surface. Anything absent keeps the
// default paving, which is what most of a downtown block actually is.
const ZONE_MATERIAL = {
  parking: 'parkingLot',
  grass: 'grass',
  park: 'grass',
  garden: 'grass',
  playground: 'grass',
  recreation_ground: 'grass',
  marina: 'concrete',
  construction: 'dirt',
};

export class StreamingWorld {
  constructor(scene, district, opts = {}) {
    this.scene = scene;
    this.d = district;
    this.chunkSize = district.meta.chunkSize;
    this.nearRadius = opts.nearRadius ?? 2;    // chunks kept at LOD0
    this.farRadius = opts.farRadius ?? 5;      // chunks kept at LOD1
    this.budgetMs = opts.budgetMs ?? 3;        // per-frame chunk build budget
    this.groundY = 0;

    this.loaded = new Map();                   // key -> { lod, group }
    this.queue = [];
    this.job = null;
    this._want = null;
    this._pendingUnload = new Map();
    // One chunk per update. Measured under the chase harness, a single _dispose is
    // ~8 ms and is now the dominant term in the stall budget. That is almost
    // certainly a SwiftShader artifact - it is GL buffer deletion, which a real
    // driver does far more cheaply - so it is flagged for the real-hardware
    // checkpoint rather than engineered around any further.
    this.unloadsPerUpdate = opts.unloadsPerUpdate ?? 1;
    this._lastCx = NaN; this._lastCz = NaN;
    // Every field here is written by a measurement. Three were not, and went in
    // the same clear-out as `queuedAtScan` (see the note in update()), for the
    // reason that one was deleted: one write, no readers.
    //
    //   pendingUnload  initialised and never assigned again. Dead on arrival -
    //                  report() has always overwritten the spread value with the
    //                  live `this._pendingUnload.size`, which is the number three
    //                  probes actually read. Deleting it changes no output.
    //   lastFinishMs   never assigned from anything, but REPORTED, so every
    //   worstFinishMs  harness JSON in docs/ carries `"worstFinishMs": 0` -
    //                  four of them do. A hard-coded zero that reads like a
    //                  measured stall is worse than a missing field, and nothing
    //                  in the repo ever read them. They were not wired up because
    //                  there is no unmeasured quantity left for "finish" to mean:
    //                  worstBuildMs is a chunk's total build cost, worstSliceMs
    //                  the per-frame slice (what the budget gate reads, via
    //                  drive-through.mjs and chase-harness.mjs), worstScanMs the
    //                  rescan, worstDisposeMs one _dispose, worstUploadMs the
    //                  largest single mesh upload. If a future gate wants chunk
    //                  LATENCY - queued-to-landed wall clock, which genuinely is
    //                  unmeasured - it should arrive with the reader that needs
    //                  it, in the same change.
    this.stats = { loads: 0, unloads: 0, lodSwaps: 0, worstBuildMs: 0, lastBuildMs: 0,
      sliceMs: 0, worstSliceMs: 0, scanMs: 0, worstScanMs: 0,
      worstDisposeMs: 0, worstUploadMs: 0 };

    // One shared registry for the whole district: N buildings share M materials,
    // and M is a number the budget gate can hold.
    this.registry = opts.registry ?? getMaterials(opts.materialOpts);
    this.materials = opts.materials ?? this.registry.streamingMaterials();
    this.root = new THREE.Group();
    this.root.name = 'district';
    scene.add(this.root);

    this.facadeTime = opts.facadeTime ?? 'dusk';
    // Kerbs are on by default and can be turned off for an A/B arm. The switch
    // exists so a before/after capture is ONE build on ONE port with one thing
    // different, rather than two trees whose frames turn out to be of the same
    // commit -- which is how two rounds in this project were spent.
    this.kerbsOn = opts.kerbs !== false;
    this.kerbPlan = undefined;
    generateFacadeLibrary();
    // Planned HERE and not on first use. It is 89 ms of arithmetic over the
    // whole graph, and on first use it would land inside a chunk build's timed
    // slice - the quantity the budget gate reads as chunkStallMs against an 8 ms
    // warn. The constructor runs inside the loading screen's own phase, where
    // 89 ms is load time and is accounted as load time.
    this._kerbPlan();
    this._buildWater();
  }

  // ---------------------------------------------------------------- ground API
  // Sarasota's downtown is essentially flat (a few metres of relief across the
  // whole district), so a constant plane is honest here. The interface is what
  // matters: terrain can become a heightfield later without touching the vehicle.
  heightAt() { return this.groundY; }
  raycastDown(origin, maxDist) {
    const d = origin.y - this.groundY;
    if (d < 0 || d > maxDist) return null;
    return { y: this.groundY, normalY: 1 };
  }

  // ---------------------------------------------------------------- water edge
  _buildWater() {
    const b = this.d.meta.bounds;
    const pad = 900;
    const geo = new THREE.PlaneGeometry(
      (b.x1 - b.x0) + pad * 2, (b.z1 - b.z0) + pad * 2
    );
    const mesh = new THREE.Mesh(geo, this.materials.water);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((b.x0 + b.x1) / 2, this.groundY - 0.45, (b.z0 + b.z1) / 2);
    mesh.renderOrder = -1;
    this.root.add(mesh);
    this.water = mesh;

    // Land pad: everything inside the trim box that is not water.
    const land = new THREE.Mesh(
      new THREE.PlaneGeometry(b.x1 - b.x0, b.z1 - b.z0),
      this.materials.ground ?? this.materials.land
    );
    land.rotation.x = -Math.PI / 2;
    land.position.set((b.x0 + b.x1) / 2, this.groundY - 0.05, (b.z0 + b.z1) / 2);
    land.receiveShadow = true;
    this.root.add(land);
  }

  // ---------------------------------------------------------------- streaming
  keyOf(x, z) {
    return `${Math.floor(x / this.chunkSize)},${Math.floor(z / this.chunkSize)}`;
  }

  desiredLod(cx, cz, px, pz) {
    const centerX = (cx + 0.5) * this.chunkSize, centerZ = (cz + 0.5) * this.chunkSize;
    const dist = Math.max(Math.abs(centerX - px), Math.abs(centerZ - pz)) / this.chunkSize;
    if (dist <= this.nearRadius) return LOD.NEAR;
    if (dist <= this.farRadius) return LOD.FAR;
    return null;
  }

  update(pos) {
    const tScan0 = performance.now();
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);

    // Rescan only when the player crosses a chunk boundary. Recomputing the want
    // map every update cost 6.8 ms and produced an identical answer almost every
    // time; LOD depends on which chunk the player is in, not where inside it.
    const moved = pcx !== this._lastCx || pcz !== this._lastCz;
    if (!moved && this._want) {
      const t0q = performance.now();
      this.stats.scanMs = 0;
      let ub = this.unloadsPerUpdate;
      for (const [key, entry] of this._pendingUnload) {
        if (ub-- <= 0) break;
        this._dispose(entry);
        this.loaded.delete(key);
        this._pendingUnload.delete(key);
        this.stats.unloads++;
      }
      const built = this._drainQueue(this._want, pcx, pcz, t0q);
      this.stats.sliceMs = performance.now() - t0q;
      if (this.stats.sliceMs > this.stats.worstSliceMs) this.stats.worstSliceMs = this.stats.sliceMs;
      return built;
    }
    this._lastCx = pcx; this._lastCz = pcz;

    const want = new Map();
    for (let dz = -this.farRadius; dz <= this.farRadius; dz++) {
      for (let dx = -this.farRadius; dx <= this.farRadius; dx++) {
        const cx = pcx + dx, cz = pcz + dz;
        const key = `${cx},${cz}`;
        if (!this.d.chunks[key]) continue;              // nothing baked here
        const lod = this.desiredLod(cx, cz, pos.x, pos.z);
        if (lod !== null) want.set(key, lod);
      }
    }

    // Unload anything outside the ring, bounded. Disposal is invisible work on
    // chunks the player has already left, so spreading it over frames costs
    // nothing and keeps it out of the stall budget.
    //
    // The `else` is not tidiness, it is a hole in the world. Disposal is spread
    // at unloadsPerUpdate=1, so a chunk can still be sitting in _pendingUnload
    // when the player turns around and it re-enters `want`. Nothing else takes a
    // key back out of that map, and the drain loops below dispose whatever is in
    // it without consulting `want` - while the queue rebuild further down skips
    // the same chunk, because at that moment it is still present in `this.loaded`
    // with the right LOD. Wanted, present, unqueued, then deleted.
    //
    // Measured on the code WITHOUT this line, at 258aded^ served from a scratch
    // checkout: tools/stream-uturn-probe.mjs -> docs/stream-uturn-before.json.
    // (The first version of this comment quoted a run of the FIXED code by
    // mistake, so it cited a file that refuted it. These are the real figures.)
    //
    // Home chunk 1,0 with want = 94. Cross one boundary, dwell 3 updates, cross
    // straight back: the return rescan logs 3 keys that are in `want` AND in
    // _pendingUnload at the same time, and queues 6 - none of them those 3,
    // because all 3 are still sitting in `this.loaded` at the right LOD. Over
    // the next 3 updates, with the rescan count frozen at 3 and `loads` frozen
    // at 101 - no build is started for them, ever - `missing` climbs 5 -> 8,
    // `unloads` climbs 12 -> 15 and `wantedAndPending` falls 3 -> 0. One
    // disposal per update, each one a wanted chunk.
    //
    // It does not self-heal. Once the queue drained (loads 101 -> 106) `missing`
    // sat at exactly 3 for the next 20 samples, updates 73 to 94, with an empty
    // queue, no job in flight and `loads` frozen at 106. Only a forced rescan
    // repaired it, and it cost 3 full chunk builds to do so: loads 106 -> 109.
    // That is the price of the bug - a dispose and a rebuild per event, both
    // landing in the stall budget, for chunks that never needed to leave.
    //
    // The holes are always far-tier: a chunk only ever exits `want` from the
    // outer edge of the ring, so the near ring cannot lose geometry this way.
    for (const [key, entry] of this.loaded) {
      if (!want.has(key)) this._pendingUnload.set(key, entry);
      else this._pendingUnload.delete(key);
    }
    let unloadBudget = this.unloadsPerUpdate;
    for (const [key, entry] of this._pendingUnload) {
      if (unloadBudget-- <= 0) break;
      this._dispose(entry);
      this.loaded.delete(key);
      this._pendingUnload.delete(key);
      this.stats.unloads++;
    }

    // Queue loads and LOD swaps, nearest first so the player never outruns detail.
    this.queue.length = 0;
    for (const [key, lod] of want) {
      const cur = this.loaded.get(key);
      if (!cur) this.queue.push({ key, lod, swap: false });
      else if (cur.lod !== lod) this.queue.push({ key, lod, swap: true });
    }
    this.queue.sort((a, b) => {
      const [ax, az] = a.key.split(',').map(Number), [bx, bz] = b.key.split(',').map(Number);
      return (Math.abs(ax - pcx) + Math.abs(az - pcz)) - (Math.abs(bx - pcx) + Math.abs(bz - pcz));
    });
    // There used to be a `this.stats.queued = this.queue.length` here, and it was
    // the reported queue depth. It is not a depth: it is this one rebuild's
    // verdict, written once and never touched again as the queue drains - and
    // the rebuild is skipped entirely on every update that does not cross a
    // chunk boundary, which parked is all of them. So it froze, and because a
    // cold start rebuilds with `loaded` empty it froze at ~want.size, which the
    // world then converges to - a number that shadows the loaded-chunk count for
    // ever. Four harnesses each invented a different wrong reason for it: "a
    // cumulative counter" (contact.mjs), "the queue never drains"
    // (sun-share.mjs), "the far ring keeps a permanent backlog"
    // (lamp-onscreen.mjs), "the far ring keeps re-queueing" (glaz-probe.mjs).
    // None of those happen. Measured parked and settled
    // (tools/stream-queue-probe.mjs): want 44, missing 0, LOD-differs 0,
    // already-correct 44, live queue depth 0 - the rebuild loop pushes nothing -
    // and one forced rescan on that same settled world took the reported number
    // from 44 to 0 without loading or unloading a single chunk.
    //
    // It was renamed to `queuedAtScan` rather than deleted, and a review then
    // pointed out that nothing anywhere read it: one write, no readers, in a
    // repo that already has a dead-field problem. So it is gone. report()
    // derives `queued` from the live queue instead. If a future stall-budget
    // gate wants "work created by one crossing", it should be added back WITH
    // the reader that needs it, in the same change.
    this._want = want;

    // Spend at most budgetMs per frame building chunks. This is the knob that
    // trades pop-in against hitching, and it is why the stall is bounded.
    const t0 = performance.now();
    this.stats.scanMs = t0 - tScan0;
    if (this.stats.scanMs > this.stats.worstScanMs) this.stats.worstScanMs = this.stats.scanMs;
    const built = this._drainQueue(want, pcx, pcz, t0);
    this.stats.sliceMs = performance.now() - tScan0;
    if (this.stats.sliceMs > this.stats.worstSliceMs) this.stats.worstSliceMs = this.stats.sliceMs;
    return built;
  }

  // One slice of work: continue the in-flight chunk, or start the next one.
  // Mesh creation is a distinct phase so a chunk that has finished appending
  // geometry does not also pay for buffer upload in the same slice.
  _drainQueue(want, pcx, pcz, t0) {
    const deadline = t0 + this.budgetMs;
    let built = 0;
    while (performance.now() < deadline) {
      if (!this.job) {
        const next = this.queue.shift();
        if (!next) break;
        if (!want.has(next.key)) continue;
        // Decide from `this.loaded` NOW, not from the `swap` flag the rebuild
        // stamped on this entry at scan time. Two things go wrong when the entry
        // is trusted, and both need the chunk that was mid-build across a rescan:
        //
        //  * DOUBLE BUILD. The in-flight chunk is in neither `loaded` nor the
        //    queue while it builds - `this.job` is its own place - so a rescan
        //    that lands mid-build re-queues it as a fresh load. The job then
        //    completes and writes `loaded`, and the duplicate dequeues with
        //    swap:false, disposes nothing, and adds a SECOND group to root. The
        //    first is orphaned: still parented, still drawn, still holding its
        //    buffers, and invisible to `this.loaded` - so it is never disposed,
        //    it double-counts in report().meshes/triangles, and its roads and
        //    zone polygons z-fight the new copy at the same fixed y.
        //  * STALE cur.lod. The old swap branch disposed the entry but left the
        //    key in `loaded`, so between the dispose and the rebuild landing,
        //    `loaded` pointed at a group that had left the scene. A rescan in
        //    that window read its LOD and could call the chunk already correct.
        //
        // Both measured on the same zig-zag stress walk run against each tree,
        // tools/stream-churn-probe.mjs, ~1,520 updates and 163 rescans each.
        // Neither defect was introduced by the _pendingUnload fix above: the
        // "before" run is 258aded^ served from a scratch checkout.
        //
        //   docs/stream-churn-before.json  ->  docs/stream-churn-after.json
        //   orphaned groups in root at rest      3                0
        //   chunk groups in root vs loaded.size  96 / 93          94 / 94
        //   orphan meshes / triangles            12 / 11,272      0 / 0
        //   updates with a loaded entry whose
        //     group had left the scene           649 of 1,520     0 of 1,517
        //   _beginBuild on a key already in
        //     loaded                             1,070            0
        //   zero-queued updates whose committed
        //     want map was NOT satisfied         6 of 813         0 of 819
        //
        // That last row is the one that matters to callers: `queued === 0` was
        // not honest before this guard, because a rescan reading a stale cur.lod
        // could conclude "already correct" and queue nothing. The 1,070 -> 0 is
        // by construction - the key is deleted before the rebuild starts, so it
        // can no longer be in `loaded` when _beginBuild runs.
        const cur = this.loaded.get(next.key);
        if (cur && cur.lod === next.lod) continue;      // already satisfied - the in-flight job landed it
        if (cur) { this._dispose(cur); this.loaded.delete(next.key); this.stats.lodSwaps++; }
        else this.stats.loads++;
        this.job = this._beginBuild(next.key, next.lod);
      }
      if (!this.job.appended) {
        if (!this._stepBuild(this.job, deadline)) break;   // still appending
        this.job.appended = true;
        continue;
      }
      if (!this._stepUploads(this.job, deadline)) break;   // still uploading
      this.loaded.set(this.job.key, { lod: this.job.lod, group: this.job.group });
      this.stats.lastBuildMs = this.job.ms;
      if (this.job.ms > this.stats.worstBuildMs) this.stats.worstBuildMs = this.job.ms;
      this.job = null;
      built++;
    }
    return built;
  }

  _dispose(entry) {
    if (!entry) return;
    const td0 = performance.now();
    this.root.remove(entry.group);
    entry.group.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); }
    });
    const dm = performance.now() - td0;
    if (dm > (this.stats.worstDisposeMs ?? 0)) this.stats.worstDisposeMs = dm;
  }

  // Direction from a building toward the street it FRONTS, so storefronts face
  // the right way.
  //
  // This used to take the nearest road VERTEX to the footprint centroid, which
  // is wrong twice over and was measurably wrong on two thirds of the district.
  //
  //   1. A vertex is a junction or a polyline kink, not the road. On a long
  //      straight block the street a building actually fronts may have no vertex
  //      within 200 m, while a junction on the street BEHIND it sits 40 m away --
  //      so the building turns its back on its own high street. tools/street-dir
  //      counts 348 of 519 buildings more than 45 degrees off, and 99 of them
  //      (19%) pointing broadly BACKWARDS, more than 120 degrees out. Building
  //      #18 -- the 181 m Main Street frontage the lot pass exists to subdivide
  //      -- was one of the 177-degree cases, so the whole parade of shopfronts
  //      was being planned against the wrong elevation.
  //   2. It searched only the building's OWN chunk, so a building near a chunk
  //      boundary was blind to the street on the other side of it.
  //
  // What replaces it asks the question the caller actually means. A building
  // fronts the street its WALL looks at, so for each footprint edge, measure how
  // far along that edge's own outward normal the nearest road segment lies;
  // roads behind a wall are rejected outright, and the edge that sees a road
  // soonest and most squarely wins. Its outward normal is the answer.
  //
  // Cached on the building, like _perim below: the frontage search is 122 us
  // against the nearest-vertex search's 2.7 us, which would be 1-2 ms of a 3 ms
  // chunk slice if it ran per build. Cached it is paid once per building for the
  // life of the session -- 64 ms across all 523, spread over streaming.
  //
  // tools/street-dir.mjs holds the same three methods side by side with a
  // self-test that isolates the failure: a road 15 m in front whose vertices are
  // 200 m away, and a stub 40 m behind whose vertices are 40 m away.
  _streetDirFor(b) {
    if (b._streetDir !== undefined) return b._streetDir;
    return (b._streetDir = this._computeStreetDir(b));
  }

  _computeStreetDir(b) { return streetDirFor(this.d, b); }

  // Every street the building stands on, cached the same way. A corner site
  // fronts two and needs the shopfront kit on both; see streetDirsFor.
  _streetDirsFor(b) {
    if (b._streetDirs !== undefined) return b._streetDirs;
    return (b._streetDirs = streetDirsFor(this.d, b, 2));
  }

  // Per-building cost cap. The stall gate is a hard constraint, so an
  // individually expensive style is trimmed here rather than allowed to blow a
  // frame. Measured worst case falls from 22.3 ms to ~2 ms.
  _capStyle(style, b) {
    // Balcony count scales as floors x PERIMETER, not floors x vertex count: a
    // four-point 737 m2 tower emitted 19k trim vertices in 28.5 ms because its
    // edges are long, not because it has many of them.
    if (b._perim === undefined) {
      let per = 0;
      for (let i = 0; i < b.p.length; i++) {
        const a = b.p[i], c = b.p[(i + 1) % b.p.length];
        per += Math.hypot(c[0] - a[0], c[1] - a[1]);
      }
      b._perim = per;
    }
    const cost = style.floors * b._perim;
    if (cost > 1400) { style.balconies = false; style.fireEscape = false; }
    if (cost > 1800) style.roofUnits = Math.min(style.roofUnits, 3);
    return style;
  }

  _meshFromBuffers(buf, material, shadow) {
    if (!buf.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    if (buf.col.length) geo.setAttribute('color', new THREE.Float32BufferAttribute(buf.col, 3));
    geo.setIndex(buf.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = shadow;
    mesh.receiveShadow = shadow;
    return mesh;
  }

  // Lit windows are a property of the facade textures, so time of day has to be
  // pushed into the facade library rather than only into the lights.
  setFacadeTime(time) {
    this.facadeTime = time;
    setAllFacadeTimes(time);
  }

  // ---------------------------------------------------------------- chunk build
  // Resumable build. Returns a job; call _stepBuild until job.done.
  _beginBuild(key, lod) {
    return {
      key, lod, i: 0,
      chunk: this.d.chunks[key],
      group: new THREE.Group(),
      byRecipe: new Map(),
      appended: false,
      zoneIdx: 0,
      zoneBuf: new Map(),        // materialKey -> {pos,nrm,uv,idx}
      trim: buffers(),
      merged: null,
      roadsDone: false,
      done: false,
      ms: 0,
    };
  }

  _stepBuild(job, deadline) {
    const t0 = performance.now();
    const { chunk, lod } = job;
    if (lod === LOD.NEAR) {
      let didWork = false;
      while (job.i < chunk.buildings.length) {
        if (didWork && performance.now() >= deadline) { job.ms += performance.now() - t0; return false; }
        const b = this.d.buildings[chunk.buildings[job.i]];
        const style = this._capStyle(buildingStyle(b), b);
        if (!job.byRecipe.has(style.recipe)) job.byRecipe.set(style.recipe, buffers());
        appendBuilding(b.p, b.h, style, job.byRecipe.get(style.recipe), job.trim, {
          street: this._streetDirFor(b),
          streets: this._streetDirsFor(b),
        });
        job.i++;
        didWork = true;
      }
    } else {
      if (!job.merged) job.merged = { pos: [], nrm: [], uv: [], idx: [], layer: [], col: [] };
      const m = job.merged;
      const tag = (from, to, family, tintName) => {
        const li = SURFACE_LAYERS.indexOf(family);
        const hex = SURFACE_TINTS[family][tintName] ?? Object.values(SURFACE_TINTS[family])[0];
        const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, bl = (hex & 255) / 255;
        for (let v = from; v < to; v++) { m.layer.push(li); m.col.push(r, g, bl); }
      };
      let didFar = false;
      while (job.i < chunk.buildings.length) {
        if (didFar && performance.now() >= deadline) { job.ms += performance.now() - t0; return false; }
        const bi = chunk.buildings[job.i];
        const b = this.d.buildings[bi];
        const wall = wallFamilyFor(b, bi), roof = roofFor(b, bi);
        const before = m.pos.length / 3;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of b.p) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        extrudeFootprint([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], b.h, m.pos, m.nrm, m.uv, m.idx);
        const after = m.pos.length / 3;
        tag(before, after - 4, wall.family, wall.tint);
        tag(after - 4, after, roof.family, roof.tint);
        job.i++;
        didFar = true;
      }
    }

    // Zones, one polygon per iteration so a chunk full of car parks cannot blow
    // the slice the way it did when they were triangulated in a single step.
    const zoneList = chunk.zones ?? [];
    while (job.zoneIdx < zoneList.length) {
      if (performance.now() >= deadline) { job.ms += performance.now() - t0; return false; }
      const z = this.d.zones[zoneList[job.zoneIdx]];
      job.zoneIdx++;
      const key = ZONE_MATERIAL[z.z];
      if (!key) continue;
      if (!job.zoneBuf.has(key)) job.zoneBuf.set(key, { pos: [], nrm: [], uv: [], idx: [] });
      const buf = job.zoneBuf.get(key);
      const start = buf.pos.length / 3;
      const tris = triangulate(z.p);
      if (!tris.length) continue;
      for (const [x, zz] of z.p) {
        // Just above the land plane and below the road ribbons, so a car park
        // never z-fights the street it opens onto.
        buf.pos.push(x, this.groundY + 0.012, zz);
        buf.nrm.push(0, 1, 0);
        buf.uv.push(x * 0.12, zz * 0.12);
      }
      for (let i = 0; i < tris.length; i += 3) {
        buf.idx.push(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
      }
    }

    job.ms += performance.now() - t0;
    return true;
  }

  // Every mesh a chunk emits says which chunk and what it is.
  //
  // A scene-graph audit of shadow casters reported "world chunk: 7 casters / 110
  // meshes" against a wall of unnamed meshes, and with no way to tell a facade
  // from a road ribbon the search for the missing flag went to _buildUnused -
  // dead code nothing calls - rather than here. Two things were wrong with the
  // reading and only a name makes either visible: the casters are the NEAR tier's
  // facade and trim meshes (roads, zone polygons and the far tier's merged boxes
  // are receivers by design), and 7/110 was a scene that had not finished
  // streaming. Audited at the corridor hero camera with the mesh count settled it
  // is 57 casters of 259.
  _named(mesh, job, what) {
    if (mesh) mesh.name = `chunk:${job.key}:lod${job.lod}:${what}`;
    return mesh;
  }

  // Build the list of one-mesh upload steps. Each is small and independently
  // gateable, which is what keeps the worst slice bounded.
  _planUploads(job) {
    const steps = [];
    if (job.lod === LOD.NEAR) {
      for (const [recipe, buf] of job.byRecipe) {
        steps.push(() => this._named(
          this._meshFromBuffers(buf, facadeMaterial(recipe, { time: this.facadeTime }), true),
          job, `facade:${recipe}`));
      }
      steps.push(() => this._named(this._meshFromBuffers(job.trim, trimMaterial(), true), job, 'trim'));
    } else {
      // The far tier stays a receiver and not a caster, and that is now a
      // measured choice rather than an unset flag. Near chunks run to
      // nearRadius 2 x chunkSize 128 = +-320 m around the viewer, and the sun's
      // shadow camera is +-120: every far chunk is outside the shadow volume, so
      // flagging its merged boxes as casters buys nothing and costs a draw call
      // per chunk in the shadow pass. Forcing every chunk mesh to cast at the
      // corridor camera measured 0.50% of the frame darkened for 205 extra
      // caster meshes, and none of that 0.50% was on the near ground.
      steps.push(() => this._named(this._mergedMesh(job), job, 'far'));
    }
    if (job.lod === LOD.NEAR) {
      steps.push(() => this._named(this._roadMesh(job.chunk, job.key), job, 'road'));
      steps.push(() => this._named(this._kerbMesh(job.chunk, job.key), job, 'kerb'));
    } else {
      steps.push(() => this._named(this._farRoadMesh(job.chunk, job.key), job, 'road'));
    }
    for (const [key, buf] of job.zoneBuf) {
      steps.push(() => this._named(this._zoneMeshFromBuffer(buf, key), job, `zone:${key}`));
    }
    return steps;
  }

  _stepUploads(job, deadline) {
    if (!job.uploads) { job.uploads = this._planUploads(job); job.up = 0; }
    while (job.up < job.uploads.length) {
      const t0 = performance.now();
      const mesh = job.uploads[job.up]();
      if (mesh) job.group.add(mesh);
      job.up++;
      const cost = performance.now() - t0;
      job.ms += cost;
      if (cost > (this.stats.worstUploadMs ?? 0)) this.stats.worstUploadMs = cost;
      if (job.up < job.uploads.length && performance.now() >= deadline) return false;
    }
    job.group.name = `chunk:${job.key}:lod${job.lod}`;
    this.root.add(job.group);
    return true;
  }

  _mergedMesh(job) {
    if (!job.merged || !job.merged.pos.length) return null;
    const { lod } = job;
    {
      const m = job.merged;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(m.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(m.nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
      geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(m.layer, 1));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(m.col, 3));
      geo.setIndex(m.idx);
      geo.computeBoundingSphere();
      return new THREE.Mesh(geo, this.materials.building[lod]);
    }
  }

  _zoneMeshFromBuffer(buf, materialKey) {
    if (!buf.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.setIndex(buf.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.registry.get(materialKey) ?? this.materials.land);
    mesh.receiveShadow = true;
    return mesh;
  }

  // ------------------------------------------------------------------- kerbs
  //
  // The kerb is planned ONCE for the whole district (src/kerb.js) and then read
  // per chunk, because the plan is not local: a corner return depends on every
  // edge meeting at its junction, and a straight has to be trimmed back to the
  // returns at both of its ends before it can be emitted. Planning per chunk
  // would either duplicate that work per chunk or get the trims wrong at chunk
  // boundaries. Measured cold at 89 ms over 935 edges, once, behind the loading
  // screen -- and it is skipped entirely when kerbs are off.
  _kerbPlan() {
    if (this.kerbPlan === undefined) {
      this.kerbPlan = this.kerbsOn
        ? planKerbs(this.d, { chunkSize: this.chunkSize })
        : null;
    }
    return this.kerbPlan;
  }

  /** Every kerb run a chunk owns: its edges' straights, plus its own junctions. */
  _kerbRuns(key, chunk) {
    const plan = this._kerbPlan();
    if (!plan) return [];
    const out = [];
    for (const ei of chunk.edges) {
      const sides = plan.edgeRuns[ei];
      if (!sides) continue;
      for (const pieces of sides) for (const run of pieces) out.push(run);
    }
    for (const vi of plan.arcChunk.get(key) ?? []) {
      for (const run of plan.vertexRuns.get(vi) ?? []) out.push(run);
    }
    return out;
  }

  // The carriageway, and the asphalt half of the kerb section with it.
  //
  // The shoulder and the parking lane go in THIS mesh rather than in the kerb's
  // own, for two reasons that both matter: they are asphalt, so they belong on
  // the road material and cost no extra draw call; and applyMarkingUV has to see
  // them in the same vertex range as the ribbon they extend, because the road
  // shader decodes the edge's marking column, width and one-way flag out of the
  // uv it writes. Emitting them separately would decode as column 0 on a 6.6 m
  // street and paint the parking lane as an unmarked alley.
  _roadMesh(chunk, key) {
    const runs = this._kerbRuns(key, chunk);
    if (!chunk.edges.length && !runs.length) return null;
    const pos = [], nrm = [], uv = [], idx = [];
    const plan = this._kerbPlan();
    for (const ei of chunk.edges) {
      const e = this.d.edges[ei];
      const pts = e.v.map((vi) => this.d.verts[vi]);
      const vStart = pos.length / 3;
      ribbon(pts, e.w, this.groundY + 0.02, pos, nrm, uv, idx);
      // The edge's own kerb runs are appended INSIDE its marking range, so they
      // inherit its column and width coding. sweep() writes u = 1 for them,
      // which applyMarkingUV maps to the outer edge of that column: the shader
      // clamps `across` there and reads it as x = +halfW -- outboard of every
      // lane line, off the wheel tracks, inside the kerbside grime. Plain grimy
      // asphalt, which is what a parking lane is.
      if (plan) {
        const sides = plan.edgeRuns[ei];
        if (sides) {
          const buf = { pos, nrm, uv, idx };
          for (const pieces of sides) {
            for (const run of pieces) appendKerbRun(run, buf, null);
          }
        }
      }
      applyMarkingUV(uv, vStart, pos.length / 3 - vStart, markingForEdge(e), { vRepeat: 1 });
    }
    // Junction corners belong to no edge, so they are coded on their own: a
    // corner return's asphalt is the junction's, not either street's.
    if (plan) {
      const buf = { pos, nrm, uv, idx };
      const vStart = pos.length / 3;
      for (const vi of plan.arcChunk.get(key) ?? []) {
        for (const run of plan.vertexRuns.get(vi) ?? []) {
          appendKerbRun(run, buf, null);
          appendKerbFan(run, buf);
        }
      }
      const n = pos.length / 3 - vStart;
      if (n) applyMarkingUV(uv, vStart, n, MARKINGS.none, { vRepeat: 1 });
    }
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.materials.markings ?? this.materials.road);
    mesh.receiveShadow = true;
    return mesh;
  }

  // The concrete half: gutter pan, face, top, back chamfer. One extra mesh per
  // NEAR chunk, on the shared 'kerb' material the registry already builds.
  //
  // It receives shadow and does not cast. The dark line at the foot of a kerb is
  // mostly the FACE's own shading -- its normal leans back over the carriageway,
  // so it falls out of the sun's reach a good hour before the road does and goes
  // fully dark whenever the sun is behind the pavement. Making it a caster would
  // add a second draw call per near chunk to the depth pass for a shadow at most
  // a few centimetres long; the budget gate's draw-call p95 sits at 228 against a
  // 275 warn, and that is not headroom to spend on this.
  _kerbMesh(chunk, key) {
    const runs = this._kerbRuns(key, chunk);
    if (!runs.length) return null;
    const buf = { pos: [], nrm: [], uv: [], idx: [] };
    for (const run of runs) appendKerbRun(run, null, buf);
    if (!buf.pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(buf.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(buf.nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(buf.uv, 2));
    geo.setIndex(buf.idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.registry.get('kerb') ?? this.materials.land);
    mesh.receiveShadow = true;
    return mesh;
  }

  // The FAR tier's road: the ribbon, plus a flat apron over the kerb section's
  // whole footprint and nothing else. See appendKerbApron() for why the widening
  // survives the LOD swap when the 117 mm face does not.
  _farRoadMesh(chunk, key) {
    const runs = this._kerbRuns(key, chunk);
    if (!chunk.edges.length && !runs.length) return null;
    const pos = [], nrm = [], uv = [], idx = [];
    const plan = this._kerbPlan();
    for (const ei of chunk.edges) {
      const e = this.d.edges[ei];
      const pts = e.v.map((vi) => this.d.verts[vi]);
      const vStart = pos.length / 3;
      ribbon(pts, e.w, this.groundY + 0.02, pos, nrm, uv, idx);
      if (plan) {
        const sides = plan.edgeRuns[ei];
        const buf = { pos, nrm, uv, idx };
        if (sides) for (const pieces of sides) for (const run of pieces) appendKerbApron(run, buf);
      }
      applyMarkingUV(uv, vStart, pos.length / 3 - vStart, markingForEdge(e), { vRepeat: 1 });
    }
    if (plan) {
      const buf = { pos, nrm, uv, idx };
      const vStart = pos.length / 3;
      for (const vi of plan.arcChunk.get(key) ?? []) {
        for (const run of plan.vertexRuns.get(vi) ?? []) {
          appendKerbApron(run, buf);
          appendKerbFan(run, buf);
        }
      }
      const n = pos.length / 3 - vStart;
      if (n) applyMarkingUV(uv, vStart, n, MARKINGS.none, { vRepeat: 1 });
    }
    if (!pos.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.materials.markings ?? this.materials.road);
    mesh.receiveShadow = true;
    return mesh;
  }

  // NOT the live build path, and has not been since the resumable build landed:
  // nothing calls it. Read _stepBuild / _planUploads / _stepUploads above for
  // what actually produces a chunk's meshes and sets their shadow flags.
  _buildUnused(key, lod) {
    const chunk = this.d.chunks[key];
    const group = new THREE.Group();
    group.name = `chunk:${key}:lod${lod}`;

    // --- buildings
    // NEAR: full facade kit, grouped by recipe so a chunk costs
    //   (distinct recipes present) + 1 draw calls rather than one per building.
    // FAR:  one merged bounding-box mesh on the shared surface-array material.
    if (chunk.buildings.length && lod === LOD.NEAR) {
      const byRecipe = new Map();
      const trim = buffers();
      for (const bi of chunk.buildings) {
        const b = this.d.buildings[bi];
        const style = buildingStyle(b);
        if (!byRecipe.has(style.recipe)) byRecipe.set(style.recipe, buffers());
        // Face the storefront at the nearest road so awnings and glazing land on
        // the street side rather than into a neighbour's party wall.
        appendBuilding(b.p, b.h, style, byRecipe.get(style.recipe), trim, {
          street: this._streetDirFor(b),
          streets: this._streetDirsFor(b),
        });
      }
      for (const [recipe, buf] of byRecipe) {
        const mesh = this._meshFromBuffers(buf, facadeMaterial(recipe, { time: this.facadeTime }), true);
        if (mesh) group.add(mesh);
      }
      const trimMesh = this._meshFromBuffers(trim, trimMaterial(), true);
      if (trimMesh) group.add(trimMesh);
    } else if (chunk.buildings.length) {
      const pos = [], nrm = [], uv = [], idx = [], layer = [], col = [];
      const tag = (from, to, family, tintName) => {
        const li = SURFACE_LAYERS.indexOf(family);
        const hex = SURFACE_TINTS[family][tintName] ?? Object.values(SURFACE_TINTS[family])[0];
        const r = ((hex >> 16) & 255) / 255, g = ((hex >> 8) & 255) / 255, bl = (hex & 255) / 255;
        for (let v = from; v < to; v++) { layer.push(li); col.push(r, g, bl); }
      };
      for (const bi of chunk.buildings) {
        const b = this.d.buildings[bi];
        const wall = wallFamilyFor(b, bi);
        const roof = roofFor(b, bi);
        const before = pos.length / 3;
        let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
        for (const [x, z] of b.p) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (z < z0) z0 = z; if (z > z1) z1 = z;
        }
        extrudeFootprint([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], b.h, pos, nrm, uv, idx);
        const after = pos.length / 3;
        tag(before, after - 4, wall.family, wall.tint);
        tag(after - 4, after, roof.family, roof.tint);
      }
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setAttribute('aLayer', new THREE.Float32BufferAttribute(layer, 1));
        geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.materials.building[lod]);
        group.add(mesh);
      }
    }

    this.root.add(group);
    return { lod, group };
  }

  // The gate must measure the window a harness actually recorded. worstSliceMs
  // otherwise carries the initial fill burst - dozens of chunks built while the
  // loading screen is still up - into a steady-state churn measurement, and
  // reports a stall the player never experiences.
  resetPeakStats() {
    this.stats.worstBuildMs = 0;
    this.stats.worstSliceMs = 0;
    this.stats.worstScanMs = 0;
    this.stats.worstDisposeMs = 0;
    this.stats.worstUploadMs = 0;
  }

  report() {
    let tris = 0, meshes = 0;
    this.root.traverse((o) => {
      if (o.isMesh && o.geometry.index) { tris += o.geometry.index.count / 3; meshes++; }
    });
    const lods = { 0: 0, 1: 0 };
    for (const e of this.loaded.values()) lods[e.lod]++;
    return {
      chunksLoaded: this.loaded.size, lodNear: lods[0], lodFar: lods[1],
      meshes, triangles: Math.round(tris), ...this.stats,
      // Live depth: chunks waiting to be built, plus the one being built now.
      // The in-flight chunk has to count - it is real work that has not landed,
      // and without it the last chunk of a fill reports an empty queue while it
      // is still being built.
      //
      // What `queued === 0` means, exactly: every chunk in the want map from the
      // last boundary crossing is loaded at its wanted LOD, and no build is in
      // flight. That is the useful settle signal, and it is what four harnesses
      // wanted when they gave up and waited on the mesh count instead.
      //
      // What it does NOT mean is that the streamer is idle. Disposal is a
      // separate budget: chunks the ring has left can still be in the scene,
      // drawn and holding their buffers, while this reads zero. Measured over a
      // 1,552-update walk (docs/stream-churn-before.json), 219 of 812
      // zero-queued updates had chunks still awaiting disposal, up to 7 at once.
      // `pendingUnload` below is that number - a settle check that cares about
      // draw calls or triangles has to wait on both.
      //
      // It is also a statement about the LAST CROSSING's want map, not about
      // where the camera is standing right now. desiredLod() reads a continuous
      // position but the map is only rebuilt when the player changes chunk, so
      // between crossings the ring is deliberately stale. That is by design and
      // documented at the rescan gate in update().
      queued: this.queue.length + (this.job ? 1 : 0),
      pendingUnload: this._pendingUnload.size,
      materials: this.registry ? this.registry.report() : null,
    };
  }
}

function defaultMaterials() {
  return {
    building: [
      new THREE.MeshStandardMaterial({ color: 0x9a9489, roughness: 0.85, metalness: 0.05 }),
      new THREE.MeshStandardMaterial({ color: 0x8c8880, roughness: 0.95, metalness: 0.0 }),
    ],
    road: new THREE.MeshStandardMaterial({ color: 0x3c3f45, roughness: 0.92, metalness: 0.1 }),
    land: new THREE.MeshStandardMaterial({ color: 0x5f6354, roughness: 0.98 }),
    water: new THREE.MeshStandardMaterial({ color: 0x1d3a4d, roughness: 0.15, metalness: 0.6 }),
  };
}
