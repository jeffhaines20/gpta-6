// Police pursuit units for the Risk 5 chase harness.
//
// FEASIBILITY.md Risk 5: streaming, traffic, pursuit and mission scripting each
// work alone and interact badly at load, and that is always found late. This
// exists to find it early. The units here are deliberately crude — greedy
// road-graph pursuit, no tactics — because what is being tested is the streaming
// and draw-call behaviour under worst-case churn, not the AI.
//
// The real wanted/police system replaces the decision layer in M3 and keeps this
// harness as its load test.

import * as THREE from '../vendor/three.module.min.js';

export class PursuitUnits {
  constructor(scene, district, opts = {}) {
    this.d = district;
    this.count = opts.count ?? 8;
    this.speed = opts.speed ?? 22;              // m/s, faster than civilian traffic
    this.giveUpRadius = opts.giveUpRadius ?? 600;

    this._buildAdjacency();

    const geo = new THREE.BoxGeometry(1.9, 1.4, 4.5);
    geo.translate(0, 0.8, 0);
    this.mesh = new THREE.InstancedMesh(geo, new THREE.MeshStandardMaterial({
      color: 0xe8eaee, roughness: 0.35, metalness: 0.4,
    }), this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Light bars are the expensive part of a pursuit: two point lights per unit
    // would be 16 extra lights. One emissive instanced bar plus a single shared
    // flashing light keeps the budget honest.
    const barGeo = new THREE.BoxGeometry(1.5, 0.18, 0.34);
    barGeo.translate(0, 1.62, 0);
    this.barMat = new THREE.MeshStandardMaterial({
      color: 0x101216, emissive: 0xff2020, emissiveIntensity: 4,
    });
    this.bars = new THREE.InstancedMesh(barGeo, this.barMat, this.count);
    this.bars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.bars.frustumCulled = false;
    scene.add(this.bars);

    this.units = new Array(this.count).fill(null);
    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._t = 0;
    this.stats = { spawns: 0, despawns: 0, lost: 0, reroutes: 0, deadEnds: 0, frames: 0 };
  }

  _buildAdjacency() {
    this.out = new Map();
    const add = (v, e, forward) => {
      if (!this.out.has(v)) this.out.set(v, []);
      this.out.get(v).push({ e, forward });
    };
    this.d.edges.forEach((e, i) => {
      const a = e.v[0], b = e.v[e.v.length - 1];
      if (e.o >= 0) add(a, i, true);
      if (e.o <= 0) add(b, i, false);
    });
    this.drivable = this.d.edges.map((_, i) => i).filter((i) => this.d.edges[i].r <= 6);
  }

  _len(i) {
    const e = this.d.edges[i];
    let l = 0;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
      l += Math.hypot(b.x - a.x, b.z - a.z);
    }
    return l;
  }

  _pointOn(i, forward, t) {
    const e = this.d.edges[i];
    const pts = forward ? e.v.map((v) => this.d.verts[v]) : [...e.v].reverse().map((v) => this.d.verts[v]);
    let rem = t;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (rem <= seg || k === pts.length - 2) {
        const f = seg > 0 ? Math.min(1, rem / seg) : 0;
        return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, yaw: Math.atan2(b.x - a.x, b.z - a.z) };
      }
      rem -= seg;
    }
    return null;
  }

  _endVertex(i, forward) {
    const e = this.d.edges[i];
    return forward ? e.v[e.v.length - 1] : e.v[0];
  }

  _spawn(idx, target) {
    // Spawn behind the player at pursuit distance: close enough to be a real load
    // on streaming, far enough not to appear out of thin air in view.
    for (let a = 0; a < 50; a++) {
      const e = this.drivable[(Math.random() * this.drivable.length) | 0];
      const edge = this.d.edges[e];
      const forward = edge.o === -1 ? false : edge.o === 1 ? true : Math.random() < 0.5;
      const len = this._len(e);
      const t = Math.random() * len;
      const p = this._pointOn(e, forward, t);
      if (!p) continue;
      const dist = Math.hypot(p.x - target.x, p.z - target.z);
      if (dist < 70 || dist > 260) continue;
      this.units[idx] = { edge: e, forward, t, len };
      this.stats.spawns++;
      return true;
    }
    return false;
  }

  // Greedy: at each junction take the outgoing edge whose far end most reduces
  // distance to the target. Cheap, and it produces exactly the churn pattern a
  // real chase does — units converging from several directions at once.
  _chooseNext(unit, target) {
    const v = this._endVertex(unit.edge, unit.forward);
    const options = (this.out.get(v) ?? []).filter(
      (o) => !(o.e === unit.edge && o.forward !== unit.forward)
    );
    if (!options.length) {
      this.stats.deadEnds++;
      return null;
    }
    let best = null, bestScore = Infinity;
    for (const o of options) {
      const end = this._endVertex(o.e, o.forward);
      const p = this.d.verts[end];
      const score = Math.hypot(p.x - target.x, p.z - target.z);
      if (score < bestScore) { bestScore = score; best = o; }
    }
    this.stats.reroutes++;
    return best;
  }

  update(dt, target) {
    this._t += dt;
    this.stats.frames++;
    // Alternating red/blue at ~2.5 Hz. One shared material, so the whole fleet's
    // light bars cost nothing extra to animate.
    const phase = Math.floor(this._t * 5) % 2;
    this.barMat.emissive.setHex(phase ? 0x2040ff : 0xff2020);

    for (let i = 0; i < this.count; i++) {
      let u = this.units[i];
      if (!u) { this._spawn(i, target); u = this.units[i]; }
      if (!u) { this.mesh.setMatrixAt(i, this._hidden); this.bars.setMatrixAt(i, this._hidden); continue; }

      u.t += this.speed * dt;
      let p = this._pointOn(u.edge, u.forward, u.t);
      if (!p || u.t >= u.len) {
        const next = this._chooseNext(u, target);
        if (!next) { this.units[i] = null; this.mesh.setMatrixAt(i, this._hidden); this.bars.setMatrixAt(i, this._hidden); continue; }
        u.edge = next.e; u.forward = next.forward; u.t = 0; u.len = this._len(next.e);
        p = this._pointOn(u.edge, u.forward, 0);
      }

      if (Math.hypot(p.x - target.x, p.z - target.z) > this.giveUpRadius) {
        this.units[i] = null;
        this.stats.lost++;
        this.stats.despawns++;
        this.mesh.setMatrixAt(i, this._hidden);
        this.bars.setMatrixAt(i, this._hidden);
        continue;
      }

      this._m.makeRotationY(p.yaw);
      this._m.setPosition(p.x, 0, p.z);
      this.mesh.setMatrixAt(i, this._m);
      this.bars.setMatrixAt(i, this._m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.bars.instanceMatrix.needsUpdate = true;
  }

  report() {
    return {
      units: this.count,
      active: this.units.filter(Boolean).length,
      ...this.stats,
      drawCalls: 2,
    };
  }
}
