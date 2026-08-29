// Stub traffic: kinematic vehicles that follow the real baked road graph and
// obey its one-way flags. There is no AI here on purpose — no following
// distance, no signals, no avoidance. The point of this probe is the streaming
// interaction (spawn, despawn, boundary crossing, orphans), not the driving.

import * as THREE from '../vendor/three.module.min.js';

export class TrafficStub {
  constructor(scene, district, opts = {}) {
    this.d = district;
    this.count = opts.count ?? 30;
    this.despawnRadius = opts.despawnRadius ?? 420;   // beyond the far LOD ring
    this.spawnMin = opts.spawnMin ?? 90;
    this.spawnMax = opts.spawnMax ?? 340;

    this.stats = { spawns: 0, despawns: 0, deadEnds: 0,
      orphaned: 0, maxSimultaneousOrphans: 0, worstOrphanS: 0,
      overlapFrames: 0, frames: 0 };

    this._buildAdjacency();

    // One InstancedMesh for the whole fleet: 30 cars for 1 draw call. Traffic
    // must not be what breaks the draw-call budget.
    const geo = new THREE.BoxGeometry(1.85, 1.35, 4.3);
    geo.translate(0, 0.78, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      roughness: 0.4, metalness: 0.5,
    }), this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const color = new THREE.Color();
    this.cars = [];
    for (let i = 0; i < this.count; i++) {
      color.setHSL(Math.random(), 0.35 + Math.random() * 0.3, 0.35 + Math.random() * 0.25);
      this.mesh.setColorAt(i, color);
      this.cars.push(null);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
  }

  // Directed adjacency respecting one-way flags: o=1 forward, o=-1 reversed, o=0 both.
  _buildAdjacency() {
    this.out = new Map();
    const add = (v, edgeIdx, forward) => {
      if (!this.out.has(v)) this.out.set(v, []);
      this.out.get(v).push({ e: edgeIdx, forward });
    };
    this.d.edges.forEach((e, i) => {
      const a = e.v[0], b = e.v[e.v.length - 1];
      if (e.o >= 0) add(a, i, true);
      if (e.o <= 0) add(b, i, false);
    });
    // Drivable edges only, and long enough to be worth spawning on.
    this.spawnable = this.d.edges
      .map((e, i) => i)
      .filter((i) => this.d.edges[i].r <= 6 && this._edgeLength(i) > 25);
  }

  _edgeLength(i) {
    const e = this.d.edges[i];
    let len = 0;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
      len += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return len;
  }

  _pointOn(edgeIdx, forward, t) {
    const e = this.d.edges[edgeIdx];
    const pts = forward ? e.v.map((v) => this.d.verts[v]) : [...e.v].reverse().map((v) => this.d.verts[v]);
    let remaining = t;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (remaining <= seg || k === pts.length - 2) {
        const f = seg > 0 ? Math.min(1, remaining / seg) : 0;
        return {
          x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
          yaw: Math.atan2(b.x - a.x, b.z - a.z),
          done: remaining > seg && k === pts.length - 2,
        };
      }
      remaining -= seg;
    }
    return null;
  }

  _endVertex(edgeIdx, forward) {
    const e = this.d.edges[edgeIdx];
    return forward ? e.v[e.v.length - 1] : e.v[0];
  }

  _spawn(i, playerPos) {
    // Spawn on a road inside the streamed ring but outside the player's immediate
    // view, so cars are never seen materialising.
    for (let attempt = 0; attempt < 40; attempt++) {
      const edgeIdx = this.spawnable[(Math.random() * this.spawnable.length) | 0];
      const forward = this.d.edges[edgeIdx].o === -1 ? false
        : this.d.edges[edgeIdx].o === 1 ? true : Math.random() < 0.5;
      const len = this._edgeLength(edgeIdx);
      const t = Math.random() * len;
      const p = this._pointOn(edgeIdx, forward, t);
      if (!p) continue;
      const dist = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (dist < this.spawnMin || dist > this.spawnMax) continue;
      this.cars[i] = {
        edge: edgeIdx, forward, t, len,
        speed: 7 + Math.random() * 6,
        id: ++this._nextId,
      };
      this.stats.spawns++;
      return true;
    }
    return false;
  }

  update(dt, playerPos) {
    this._nextId = this._nextId ?? 0;
    let orphansThisFrame = 0;
    const positions = [];
    for (let i = 0; i < this.count; i++) {
      let car = this.cars[i];
      if (!car) { this._spawn(i, playerPos); car = this.cars[i]; }
      if (!car) { this.mesh.setMatrixAt(i, this._hidden); continue; }

      car.t += car.speed * dt;
      let p = this._pointOn(car.edge, car.forward, car.t);

      // Reached the end of this edge: pick an outgoing edge at the junction.
      if (!p || car.t >= car.len) {
        const v = this._endVertex(car.edge, car.forward);
        const options = (this.out.get(v) ?? []).filter(
          (o) => !(o.e === car.edge && o.forward !== car.forward)   // no U-turns
        );
        if (!options.length) {
          // A genuine dead end in the graph (or a one-way trap). Recycle.
          this.stats.deadEnds++;
          this.cars[i] = null;
          this.mesh.setMatrixAt(i, this._hidden);
          continue;
        }
        const next = options[(Math.random() * options.length) | 0];
        car.edge = next.e; car.forward = next.forward;
        car.t = 0; car.len = this._edgeLength(next.e);
        p = this._pointOn(car.edge, car.forward, 0);
      }

      // Despawn well outside the streamed ring.
      const dist = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (dist > this.despawnRadius) {
        this.cars[i] = null;
        this.stats.despawns++;
        this.mesh.setMatrixAt(i, this._hidden);
        continue;
      }

      // Orphan check. The failure mode that matters is a car that is alive and
      // simulated but sits in a chunk the streamer has NOT loaded — invisible,
      // costing CPU, and possibly never recycled. Count distinct cars in that
      // state, and how long the worst one stays there.
      const chunkLoaded = this.isChunkLoaded ? this.isChunkLoaded(p.x, p.z) : true;
      if (!chunkLoaded) {
        car.orphanFor = (car.orphanFor ?? 0) + dt;
        orphansThisFrame++;
        if (car.orphanFor > this.stats.worstOrphanS) this.stats.worstOrphanS = +car.orphanFor.toFixed(2);
        if (!car.countedOrphan) { car.countedOrphan = true; this.stats.orphaned++; }
      } else {
        car.orphanFor = 0;
      }

      // Overlap check: two stub cars occupying the same space. With no collision
      // or following distance this is expected; it is recorded so the real
      // traffic system has a baseline to beat.
      positions.push({ i, x: p.x, z: p.z });

      this._m.makeRotationY(p.yaw);
      this._m.setPosition(p.x, 0, p.z);
      this.mesh.setMatrixAt(i, this._m);
    }
    // Overlaps: pairs closer than a car length. O(n^2) over 30 is trivial.
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        const d = Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
        if (d < 2.5) { this.stats.overlapFrames++; break; }
      }
    }
    if (orphansThisFrame > this.stats.maxSimultaneousOrphans) {
      this.stats.maxSimultaneousOrphans = orphansThisFrame;
    }
    this.stats.frames++;
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  report() {
    return {
      fleet: this.count,
      alive: this.cars.filter(Boolean).length,
      ...this.stats,
      overlapPctOfFrames: this.stats.frames
        ? +((this.stats.overlapFrames / this.stats.frames) * 100).toFixed(1) : 0,
      drawCalls: 1,
    };
  }
}
