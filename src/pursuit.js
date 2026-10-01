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
import { rng, hash32 } from './facades.js';
import { buildTrafficCarGeometry, trafficCarMaterial, lampEmissive } from './carbody.js';
// The car's collision half-length, for `holdRadius` below. The same published anchor
// src/wanted.js's bust clock takes its stop threshold from.
import { HALF_EXTENT } from './damage.js';

export class PursuitUnits {
  constructor(scene, district, opts = {}) {
    this.d = district;
    this.count = opts.count ?? 8;
    this.speed = opts.speed ?? 22;              // m/s, faster than civilian traffic
    this.giveUpRadius = opts.giveUpRadius ?? 600;

    this._buildAdjacency();

    // Seeded, for the reason in src/traffic.js: an unseeded spawn makes a
    // pursuit A/B compare two different chases.
    this._r = rng(hash32('pursuit', opts.seed ?? 0x9D17CA5E));

    // Same instanced car shell as civilian traffic (src/carbody.js), painted
    // white by the material's base colour rather than per-instance.
    const geo = buildTrafficCarGeometry({ groundY: 0 });
    this.mesh = new THREE.InstancedMesh(geo, trafficCarMaterial({ color: 0xe8eaee }), this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Light bars are the expensive part of a pursuit: two point lights per unit
    // would be 16 extra lights. One emissive instanced bar plus a single shared
    // flashing light keeps the budget honest.
    const barGeo = new THREE.BoxGeometry(1.42, 0.16, 0.32);
    barGeo.translate(0, 1.50, 0);
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

  /**
   * WHY A HOLD RADIUS EXISTS AT ALL. Without it the fleet drives its edge at `speed` for ever and
   * cannot stop, so no unit ever holds contact — measured against a STATIONARY target over 400 s
   * at two spots and three seeds, the longest contiguous time any unit spent within 4.30 m (a car
   * length) was 0.8 s, within 12 m 2.8 s, within 45 m 13.8 s, while the minimum distance reached
   * was 0.1 m. The pursuit was touching the player constantly and holding him never. Any rule of
   * the form "a unit is holding you" was therefore unsatisfiable, which is how a busted flow gets
   * written, gated against hand-placed units, and never fires in the shipped game.
   *
   * AND IT WAS DERIVED FROM THE WRONG FIELD. It read "the widest drivable half-width in the data,
   * `r` is at most 5" and came out at 5 + 2.15 = 7.15 m. `e.r` IS A CLASS RANK, NOT A WIDTH —
   * primary 2, secondary 3, tertiary 4, residential 5, service 8 — and `e.w` is the width in
   * metres. The widest edge in this district is a 13.2 m tertiary, so the derivation the comment
   * described gives 6.6 + 2.15 = 8.75 and the code was using a rank as a length. Found by a blind
   * playtester, who also measured what the wrong value cost: standing 8, 9 or 10 m from a
   * centreline at five stars was total immunity — 0 of 5 arrests with the clock never arming,
   * against 5 of 5 at 0, 6 and 7 m.
   *
   * COMPUTED FROM THE DISTRICT, not written down, for exactly that reason, and over EVERY edge
   * rather than the `drivable` ones: `_buildAdjacency` adds every edge to `out` and only filters
   * `r <= 6` for SPAWNING, so `_chooseNext` routes units down the 2.8 m service alleys too — the
   * same playtester measured 9.4% of 25,072 unit positions on them. Those are narrower, so the
   * 13.2 m tertiary still sets the bound; taking the max over the edges a unit can actually be ON
   * is the statement that stays true if that ever changes.
   *
   * district/main.js's bridge is duck-typed on purpose (see its header) and this is the field it
   * duck-types on, so it stays a property rather than becoming a module constant.
   */
  get holdRadius() {
    if (this._holdR == null) {
      let widest = 0;
      for (const e of this.d.edges) if (e.w > widest) widest = e.w;
      this._holdR = widest / 2 + HALF_EXTENT.z;
    }
    return this._holdR;
  }

  /**
   * The point on an edge nearest the target, as an along-edge distance and a distance. This is
   * what a unit stops AT: a radius alone cannot say where to stop, and stopping at the moment the
   * radius is first crossed parks the car short of the player on a long approach.
   */
  _closestOn(i, forward, target) {
    const e = this.d.edges[i];
    const pts = forward ? e.v.map((v) => this.d.verts[v])
      : [...e.v].reverse().map((v) => this.d.verts[v]);
    let run = 0, bestT = 0, bestD = Infinity;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const seg = Math.hypot(dx, dz);
      if (seg > 1e-9) {
        const f = Math.max(0, Math.min(1,
          ((target.x - a.x) * dx + (target.z - a.z) * dz) / (seg * seg)));
        const px = a.x + dx * f, pz = a.z + dz * f;
        const d = Math.hypot(target.x - px, target.z - pz);
        if (d < bestD) { bestD = d; bestT = run + seg * f; }
      }
      run += seg;
    }
    return { t: bestT, d: bestD };
  }

  _endVertex(i, forward) {
    const e = this.d.edges[i];
    return forward ? e.v[e.v.length - 1] : e.v[0];
  }

  _spawn(idx, target) {
    // Spawn behind the player at pursuit distance: close enough to be a real load
    // on streaming, far enough not to appear out of thin air in view.
    for (let a = 0; a < 50; a++) {
      const e = this.drivable[(this._r() * this.drivable.length) | 0];
      const edge = this.d.edges[e];
      const forward = edge.o === -1 ? false : edge.o === 1 ? true : this._r() < 0.5;
      const len = this._len(e);
      const t = this._r() * len;
      const p = this._pointOn(e, forward, t);
      if (!p) continue;
      const dist = Math.hypot(p.x - target.x, p.z - target.z);
      if (dist < 70 || dist > 260) continue;
      this.units[idx] = { edge: e, forward, t, len, held: false };
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

      /**
       * DRIVE UP TO THE PLAYER AND STOP THERE, rather than through him at 22 m/s. `u.t` is clamped
       * at the edge's closest approach whenever that approach is inside `holdRadius`, so a unit that has
       * arrived sits on the player until he moves — and `held` is what src/wanted.js's bust rule
       * reads. It cannot chatter: the clamp is a ceiling on `t`, not a state machine, so a unit at
       * the closest approach stays there for exactly as long as the target does.
       *
       * The unit does not REVERSE to follow a target that moves back down the edge — `t` only
       * grows — so it drives on and comes round again, which is what the greedy router already
       * does at every junction.
       */
      const near = this._closestOn(u.edge, u.forward, target);
      const wantT = u.t + this.speed * dt;
      /**
       * ONCE HELD, HELD WHILE THE TARGET IS STILL BY THIS EDGE — `u.held` is in the condition that
       * decides `u.held`, and that is the whole point of it.
       *
       * The first version tested `wantT > near.t && u.t <= near.t` every frame with no tolerance,
       * and a stationary player is not stationary: the plan's target is the player's live position,
       * which drifts sub-millimetre amounts while a braked car settles. Any drift that moves the
       * closest approach BACKWARDS by 1e-9 fails `u.t <= near.t`, the unit takes the else branch,
       * and it drives off for good. Traced at the frame: `held` was true for exactly TWO frames at
       * a time, 34 such frames across 80 s, 21 arms of the bust clock and a peak of 0.017 s.
       *
       * Sticky, it also does the right thing when the player creeps: `u.t` tracks `near.t`, so the
       * unit keeps station along the kerb instead of being shaken off by a walking pace. It
       * releases when the target leaves the edge's neighbourhood, where `near.d > holdRadius`, and
       * resumes from wherever it was rather than from the start of the edge.
       */
      if (near.d <= this.holdRadius && (u.held || (wantT > near.t && u.t <= near.t))) {
        u.t = near.t;
        u.held = true;
      } else {
        u.t = wantT;
        u.held = false;
      }
      let p = this._pointOn(u.edge, u.forward, u.t);
      /**
       * A HELD UNIT REROUTES AT THE END OF ITS EDGE LIKE ANY OTHER, and this carried a `!u.held`
       * guard for a while on a WRONG DIAGNOSIS, recorded because the mutation sweep is what
       * removed it.
       *
       * The reasoning was: the closest approach to a player standing at a junction is the END of
       * the edge, so the hold's clamp also satisfies this test and the unit rerouted every frame.
       * The reasoning is sound and it was not the defect — the defect was the ratchet below. With
       * the hold sticky, removing the guard is bit-identical: same six scenarios, all busting at
       * 16 s with the clock armed exactly once, and the same 390-395 s contiguous holds at two
       * spots and three seeds. `mutation-sweep` could not tell the two versions apart, which is
       * what a redundant guard looks like.
       *
       * And in the case it was written for it is actively wrong: a unit whose closest approach IS
       * its edge's end should carry on to the next edge toward a player standing beyond the
       * junction, not stop at the corner. It re-holds on the new edge at `t = 0` instead, without
       * flickering, because the sticky condition is satisfied there on the next frame.
       */
      if (!p || u.t >= u.len) {
        const next = this._chooseNext(u, target);
        if (!next) { this.units[i] = null; this.mesh.setMatrixAt(i, this._hidden); this.bars.setMatrixAt(i, this._hidden); continue; }
        u.edge = next.e; u.forward = next.forward; u.t = 0; u.len = this._len(next.e);
        u.held = false;
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

  setLights(on, exposure) {
    const e = lampEmissive(on, exposure, 1.5);
    if (e === this._lit) return;
    this._lit = e;
    this.mesh.material.emissive.setScalar(e);
  }

  report() {
    return {
      units: this.count,
      active: this.units.filter(Boolean).length,
      held: this.units.filter((u) => u && u.held).length,
      holdR: this.holdRadius,
      ...this.stats,
      drawCalls: 2,
    };
  }
}
