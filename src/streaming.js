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
import { extrudeFootprint, ribbon, triangulate } from './geom.js';
import {
  getMaterials, wallFamilyFor, roofFor, markingForEdge, applyMarkingUV,
  SURFACE_LAYERS, SURFACE_TINTS,
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
    this.stats = { loads: 0, unloads: 0, lodSwaps: 0, worstBuildMs: 0, lastBuildMs: 0,
      queued: 0, pendingUnload: 0, sliceMs: 0, worstSliceMs: 0, scanMs: 0, worstScanMs: 0,
      lastFinishMs: 0, worstFinishMs: 0, worstDisposeMs: 0, worstUploadMs: 0 };

    // One shared registry for the whole district: N buildings share M materials,
    // and M is a number the budget gate can hold.
    this.registry = opts.registry ?? getMaterials(opts.materialOpts);
    this.materials = opts.materials ?? this.registry.streamingMaterials();
    this.root = new THREE.Group();
    this.root.name = 'district';
    scene.add(this.root);

    this.facadeTime = opts.facadeTime ?? 'dusk';
    generateFacadeLibrary();
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
    for (const [key, entry] of this.loaded) {
      if (!want.has(key)) this._pendingUnload.set(key, entry);
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
    this.stats.queued = this.queue.length;
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
        if (next.swap) { this._dispose(this.loaded.get(next.key)); this.stats.lodSwaps++; }
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

  // Direction from a building toward the nearest road, so storefronts face the
  // street. Computed against the chunk's own edges, which is enough at this scale.
  _streetDirFor(b) {
    let cx = 0, cz = 0;
    for (const [x, z] of b.p) { cx += x; cz += z; }
    cx /= b.p.length; cz /= b.p.length;
    const key = this.keyOf(cx, cz);
    const chunk = this.d.chunks[key];
    if (!chunk || !chunk.edges.length) return null;
    let best = null, bestD = Infinity;
    for (const ei of chunk.edges) {
      for (const vi of this.d.edges[ei].v) {
        const v = this.d.verts[vi];
        const d = (v.x - cx) ** 2 + (v.z - cz) ** 2;
        if (d < bestD) { bestD = d; best = v; }
      }
    }
    if (!best) return null;
    const len = Math.hypot(best.x - cx, best.z - cz) || 1;
    return [(best.x - cx) / len, (best.z - cz) / len];
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

  // Build the list of one-mesh upload steps. Each is small and independently
  // gateable, which is what keeps the worst slice bounded.
  _planUploads(job) {
    const steps = [];
    if (job.lod === LOD.NEAR) {
      for (const [recipe, buf] of job.byRecipe) {
        steps.push(() => this._meshFromBuffers(buf, facadeMaterial(recipe, { time: this.facadeTime }), true));
      }
      steps.push(() => this._meshFromBuffers(job.trim, trimMaterial(), true));
    } else {
      steps.push(() => this._mergedMesh(job));
    }
    steps.push(() => this._roadMesh(job.chunk));
    for (const [key, buf] of job.zoneBuf) {
      steps.push(() => this._zoneMeshFromBuffer(buf, key));
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

  _roadMesh(chunk) {
    if (chunk.edges.length) {
      const pos = [], nrm = [], uv = [], idx = [];
      for (const ei of chunk.edges) {
        const e = this.d.edges[ei];
        const pts = e.v.map((vi) => this.d.verts[vi]);
        const vStart = pos.length / 3;
        ribbon(pts, e.w, this.groundY + 0.02, pos, nrm, uv, idx);
        applyMarkingUV(uv, vStart, pos.length / 3 - vStart, markingForEdge(e), { vRepeat: 1 });
      }
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
    return null;
  }

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
