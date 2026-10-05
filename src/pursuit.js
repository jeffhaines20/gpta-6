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
// `reachRadius` is derived from these three and nothing else: an officer who leaves the car and
// runs covers RUN_SPEED * BUST_HOLD_S before the arrest completes, and their path has to be
// clear for a person-sized circle. See the property's own comment below.
import { RUN_SPEED, ON_FOOT_RADIUS } from './player.js';
import { BUST_HOLD_S } from './wanted.js';

// The officer's path is sampled at this spacing. Bounded by the test, not chosen: a circle of
// radius ON_FOOT_RADIUS can only notice a wall while consecutive samples are under 2r = 0.70 m
// apart. `pursuit-test` asserts that relation rather than this number.
const FOOT_STEP_M = 0.5;

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
   * HOW FAR THE POLICE CAN ACTUALLY TAKE YOU, which is further than a car can park.
   *
   * `holdRadius` is the distance from an edge's CENTRELINE to a car at the kerb of the widest
   * road in the district — 13.2 / 2 + 2.15 = 8.75 m. That is exactly right for "a police car
   * stops alongside you" and it was the only way to be held, so the hold was a function of how
   * far the PLAYER was from a road. A blind playtester found what that is worth, pedals and
   * wheel only, no teleports, two arms off one seed:
   *
   *     brake 5.4 m off the centreline    busted in 11.0 s, a unit holding on 41% of frames
   *     full lock ~3 s, stop 15.6 m off   180.5 s on the brake at 4 stars, 0 busts, held 0%
   *
   * Byte-identical over three runs, and `district/main.js` runs the identical check, so it was
   * not harness-only. Measured here on the right axis — distance to the NEAREST edge of any
   * kind, not to the unit's own, because in a dense network stepping 20 m off one edge can put
   * you 5 m from another — over 24 positions, 1,200 frames each, against the old rule:
   *
   *     nearest edge     held %   longest hold   closest unit reached
   *     0 - 8.75 m        52.3%       10.5 s        6.8 m
   *     8.75 - 12 m        0.0%        0.0 s       11.3 m
   *     12 - 16 m          0.0%        0.0 s       17.8 m
   *     16 - 24 m          0.0%        0.0 s       20.0 m
   *     24 - 40 m          0.0%        0.0 s       30.3 m
   *
   * Not degraded past the radius. ZERO, with units arriving 11 m away and driving off again,
   * against a `RESPONSE[].spotRadius` of 85-175 m in which they can see you — which is what
   * blocks the evade timer. A 20x gap in radius and 400x in area.
   *
   * SO THE REACH IS NOT THE CAR'S, IT IS THE OFFICER'S, and it is derived from two constants
   * the game already declares rather than chosen:
   *
   *     src/wanted.js   BUST_HOLD_S  4.0 s   the dwell the arrest already requires
   *     src/player.js   RUN_SPEED    7.0 m/s a person running, the game's own figure
   *     ----------------------------------
   *     reach                       28.0 m
   *
   * An officer who leaves the car the moment it stops and runs arrives exactly as the arrest
   * completes. The HUD already says "BUSTED IN — 4 s"; that line now describes something. And
   * the derivation is self-correcting: retune either constant and the reach follows, which is
   * the opposite of the 7.15 m that was a class RANK read as a width.
   *
   * It is a MAX with `holdRadius`, so a change to the district's widest road can widen this and
   * can never narrow it — the on-road case this was already right about is never regressed.
   *
   * WHAT IT DOES NOT DO, stated because it is a design choice and not an oversight: 28 m covers
   * the forecourt, the verge and the car park, which is where a player actually stops. Gridded
   * at 4 m against the real blocker index, ground within 24 m of a road is 52.7% of all clear
   * ground in the district, so driving a hundred metres into open land is still immunity. That
   * is a separate finding and it needs police who get out of the car, not a bigger number here.
   */
  get reachRadius() {
    return this._reachR ?? (this._reachR = Math.max(this.holdRadius, RUN_SPEED * BUST_HOLD_S));
  }

  /**
   * CAN AN OFFICER GET FROM (ax, az) TO (bx, bz) ON FOOT? A straight line, sampled against the
   * host's own blocker predicate — the one `district/main.js` builds from
   * `blockers.resolveCircle`, so the walk is refused by exactly the geometry the car collides
   * with.
   *
   * SUB-STEPPED, AND THE STEP IS BOUNDED BY THE TEST AND NOT PICKED. A circle test of radius r
   * can only notice a wall while consecutive samples are under 2r apart; r is `ON_FOOT_RADIUS`
   * = 0.35 m, so the bound is 0.70 m and the step is 0.5 m, inside it by 29%. CLAUDE.md records
   * a sampled sweep that held by 12% and by luck because its step was derived from a mean rather
   * than a maximum, so `pursuit-test` asserts the RELATION `step < 2 * r` rather than the number.
   *
   * With no `clearAt` wired this returns true — "no predicate, nothing to exclude", the same
   * convention `src/traffic.js` uses. That is the direction that makes a missing wire VISIBLE
   * rather than silently narrowing the hold back to where it started, and `pursuit-test` asserts
   * every host wires it, because a gate that builds the subject differently from the game
   * measures a configuration the game never runs.
   */
  _footPathClear(ax, az, bx, bz) {
    if (!this.clearAt) return true;
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-9) return this.clearAt(ax, az, ON_FOOT_RADIUS);
    const n = Math.max(1, Math.ceil(len / FOOT_STEP_M));
    for (let k = 0; k <= n; k++) {
      const f = k / n;
      if (!this.clearAt(ax + dx * f, az + dz * f, ON_FOOT_RADIUS)) return false;
    }
    return true;
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
    // `x`/`z` as well as `t`/`d`, because `u.held` now tests whether an officer can WALK from
    // that point to the target and the point is already computed here. Deriving it a second
    // time from `t` would be the same quantity twice, which is how two instruments drift apart.
    let run = 0, bestT = 0, bestD = Infinity, bestX = 0, bestZ = 0;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const dx = b.x - a.x, dz = b.z - a.z;
      const seg = Math.hypot(dx, dz);
      if (seg > 1e-9) {
        const f = Math.max(0, Math.min(1,
          ((target.x - a.x) * dx + (target.z - a.z) * dz) / (seg * seg)));
        const px = a.x + dx * f, pz = a.z + dz * f;
        const d = Math.hypot(target.x - px, target.z - pz);
        if (d < bestD) { bestD = d; bestT = run + seg * f; bestX = px; bestZ = pz; }
      }
      run += seg;
    }
    return { t: bestT, d: bestD, x: bestX, z: bestZ };
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
      this.units[idx] = { edge: e, forward, t, len, held: false, stopped: false };
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
       * ONCE STOPPED, STOPPED WHILE THE TARGET IS STILL BY THIS EDGE — `u.stopped` is in the
       * condition that decides `u.stopped`, and that is the whole point of it.
       *
       * (This paragraph was written about `u.held`, when one flag did both jobs. Everything it
       * says is about where the CAR is, so it is all `u.stopped` now; see TWO STATES at the
       * condition itself for why the arrest signal had to be separated from it.)
       *
       * The first version tested `wantT > near.t && u.t <= near.t` every frame with no tolerance,
       * and a stationary player is not stationary: the plan's target is the player's live position,
       * which drifts sub-millimetre amounts while a braked car settles. Any drift that moves the
       * closest approach BACKWARDS by 1e-9 fails `u.t <= near.t`, the unit takes the else branch,
       * and it drives off for good. Traced at the frame: it was true for exactly TWO frames at
       * a time, 34 such frames across 80 s, 21 arms of the bust clock and a peak of 0.017 s.
       *
       * Sticky, it also does the right thing when the player creeps: `u.t` tracks `near.t`, so the
       * unit keeps station along the kerb instead of being shaken off by a walking pace. It
       * releases when the target leaves the edge's neighbourhood, where `near.d > reachRadius`,
       * and resumes from wherever it was rather than from the start of the edge.
       */
      /**
       * TWO STATES, BECAUSE THEY ANSWER TWO QUESTIONS. `u.stopped` is where the CAR is — the
       * clamp on `t`, everything the paragraphs above are about. `u.held` is what
       * `src/wanted.js`'s bust clock reads, and an arrest is made by a PERSON, who can cover
       * `reachRadius` on foot while the clock runs. One flag answered both and that is why
       * standing 15.6 m off a road was immunity: see `reachRadius` for the measurement.
       *
       * The clamp widens with it, and it has to: a car that drives past at 22 m/s is inside
       * 28 m for about 2.1 s against a 4.0 s dwell, so nobody could ever be arrested from a
       * passing unit however wide the predicate got. The officers get out when the car stops.
       */
      if (near.d <= this.reachRadius && (u.stopped || (wantT > near.t && u.t <= near.t))) {
        u.t = near.t;
        u.stopped = true;
      } else {
        u.t = wantT;
        u.stopped = false;
      }
      /**
       * AND THE WALK IS TESTED ONLY WHERE IT CHANGES THE ANSWER. Inside `holdRadius` the car
       * itself is alongside, so no officer has to go anywhere and the predicate is skipped —
       * which keeps the case this module was already right about independent of whether a host
       * wired `clearAt` at all. Beyond it, the line has to be clear: a player 20 m away with a
       * building between them is not being held by anybody, and that is the control
       * `pursuit-test` asserts reads zero.
       */
      u.held = u.stopped && (near.d <= this.holdRadius
        || this._footPathClear(near.x, near.z, target.x, target.z));
      let p = this._pointOn(u.edge, u.forward, u.t);
      /**
       * A STOPPED UNIT REROUTES AT THE END OF ITS EDGE LIKE ANY OTHER, and this carried a
       * `!u.held` guard for a while on a WRONG DIAGNOSIS, recorded because the mutation sweep is
       * what removed it.
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
        u.stopped = false;
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
      // `stopped` beside `held` because the two can now differ, and the gap between them is
      // exactly the case this module used to get wrong: a car parked within reach of a player
      // it cannot walk to. Without both, "held 0" reads the same whether no unit arrived or
      // every unit arrived and a wall was in the way.
      stopped: this.units.filter((u) => u && u.stopped).length,
      holdR: this.holdRadius,
      reachR: this.reachRadius,
      footPath: !!this.clearAt,
      ...this.stats,
      drawCalls: 2,
    };
  }
}
