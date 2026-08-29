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

import * as THREE from '../vendor/three.module.js';
import { extrudeFootprint, ribbon } from './geom.js';

export const LOD = { NEAR: 0, FAR: 1 };

export class StreamingWorld {
  constructor(scene, district, opts = {}) {
    this.scene = scene;
    this.d = district;
    this.chunkSize = district.meta.chunkSize;
    this.nearRadius = opts.nearRadius ?? 2;    // chunks kept at LOD0
    this.farRadius = opts.farRadius ?? 5;      // chunks kept at LOD1
    this.budgetMs = opts.budgetMs ?? 4;        // per-frame chunk build budget
    this.groundY = 0;

    this.loaded = new Map();                   // key -> { lod, group }
    this.queue = [];
    this.stats = { loads: 0, unloads: 0, lodSwaps: 0, worstBuildMs: 0, lastBuildMs: 0, queued: 0 };

    this.materials = opts.materials ?? defaultMaterials();
    this.root = new THREE.Group();
    this.root.name = 'district';
    scene.add(this.root);

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
      new THREE.PlaneGeometry(b.x1 - b.x0, b.z1 - b.z0), this.materials.land
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
    const pcx = Math.floor(pos.x / this.chunkSize), pcz = Math.floor(pos.z / this.chunkSize);
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

    // Unload anything outside the ring.
    for (const [key, entry] of this.loaded) {
      if (!want.has(key)) {
        this._dispose(entry);
        this.loaded.delete(key);
        this.stats.unloads++;
      }
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

    // Spend at most budgetMs per frame building chunks. This is the knob that
    // trades pop-in against hitching, and it is why the stall is bounded.
    const t0 = performance.now();
    let built = 0;
    while (this.queue.length) {
      const job = this.queue.shift();
      const before = performance.now();
      if (job.swap) {
        this._dispose(this.loaded.get(job.key));
        this.stats.lodSwaps++;
      } else {
        this.stats.loads++;
      }
      this.loaded.set(job.key, this._build(job.key, job.lod));
      const cost = performance.now() - before;
      this.stats.lastBuildMs = cost;
      if (cost > this.stats.worstBuildMs) this.stats.worstBuildMs = cost;
      built++;
      if (performance.now() - t0 > this.budgetMs) break;
    }
    return built;
  }

  _dispose(entry) {
    if (!entry) return;
    this.root.remove(entry.group);
    entry.group.traverse((o) => {
      if (o.isMesh) { o.geometry.dispose(); }
    });
  }

  // ---------------------------------------------------------------- chunk build
  _build(key, lod) {
    const chunk = this.d.chunks[key];
    const group = new THREE.Group();
    group.name = `chunk:${key}:lod${lod}`;

    // --- buildings, all merged into one geometry
    if (chunk.buildings.length) {
      const pos = [], nrm = [], uv = [], idx = [];
      for (const bi of chunk.buildings) {
        const b = this.d.buildings[bi];
        if (lod === LOD.NEAR) {
          extrudeFootprint(b.p, b.h, pos, nrm, uv, idx);
        } else {
          // LOD1: replace the footprint with its bounding box. Same silhouette
          // budget, a fraction of the vertices.
          let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
          for (const [x, z] of b.p) {
            if (x < x0) x0 = x; if (x > x1) x1 = x;
            if (z < z0) z0 = z; if (z > z1) z1 = z;
          }
          extrudeFootprint([[x0, z0], [x1, z0], [x1, z1], [x0, z1]], b.h, pos, nrm, uv, idx);
        }
      }
      if (pos.length) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
        geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
        geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
        geo.setIndex(idx);
        geo.computeBoundingSphere();
        const mesh = new THREE.Mesh(geo, this.materials.building[lod]);
        mesh.castShadow = lod === LOD.NEAR;
        mesh.receiveShadow = lod === LOD.NEAR;
        group.add(mesh);
      }
    }

    // --- roads, also merged. Edges are registered in every chunk they cross, so
    // a road spanning a boundary renders continuously from both sides.
    if (chunk.edges.length) {
      const pos = [], nrm = [], uv = [], idx = [];
      for (const ei of chunk.edges) {
        const e = this.d.edges[ei];
        const pts = e.v.map((vi) => this.d.verts[vi]);
        ribbon(pts, e.w, this.groundY + 0.02, pos, nrm, uv, idx);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
      geo.setIndex(idx);
      geo.computeBoundingSphere();
      const mesh = new THREE.Mesh(geo, this.materials.road);
      mesh.receiveShadow = true;
      group.add(mesh);
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
