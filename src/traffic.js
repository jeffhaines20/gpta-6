// Traffic AI over the real baked road graph.
//
// Replaces the Phase 1b stub, which had no following distance, no lane discipline
// and no junction arbitration, and consequently spent 35.4% of frames with at
// least one pair of cars inside 2.5 m of each other. That number is the baseline
// this has to beat, and it is reported unchanged so the comparison is honest.
//
// Three mechanisms do the work:
//   1. Lane offset      - opposing streams stop occupying the same centreline.
//   2. IDM car-following - a leader/follower gap that is a real control law, not
//                          a constant speed, so platoons form and dissolve.
//   3. Junction reservation - one vehicle crosses a conflict point at a time.
//
// Everything still renders as one InstancedMesh: traffic must never be what
// breaks the draw-call budget.

import * as THREE from '../vendor/three.module.min.js';
import { buildTrafficCarGeometry, trafficCarMaterial, lampEmissive } from './carbody.js';

// Intelligent Driver Model. Standard, stable, and it produces the stop-and-go
// platooning that makes traffic read as traffic rather than as beads on a wire.
const IDM = {
  a: 2.2,        // comfortable acceleration, m/s^2
  b: 2.8,        // comfortable deceleration, m/s^2
  s0: 3.2,       // minimum bumper gap at rest, m
  T: 1.35,       // desired time headway, s
  delta: 4,      // acceleration exponent
};

const CAR_LENGTH = 4.4;
const JUNCTION_CLAIM_DIST = 13;   // how far out a car reserves the junction
const JUNCTION_CLEAR_DIST = 7;    // how far past it releases

export class Traffic {
  constructor(scene, district, opts = {}) {
    this.d = district;
    this.count = opts.count ?? 30;
    this.despawnRadius = opts.despawnRadius ?? 420;
    this.spawnMin = opts.spawnMin ?? 90;
    this.spawnMax = opts.spawnMax ?? 340;
    this.overlapDistance = opts.overlapDistance ?? 2.5;   // unchanged from the stub

    this._buildAdjacency();

    // One geometry, one material, one InstancedMesh — same as the box it replaces.
    // Body panels are authored WHITE because InstancedMesh colour multiplies the
    // vertex colour, so white takes the per-car paint while the glass, tyres and
    // lamps are authored dark and stay dark whatever the car is painted. Finish
    // (roughness/metalness) rides on a palette texture, so one material still
    // gives rubber, glass and steel. See src/carbody.js.
    const geo = buildTrafficCarGeometry({ groundY: 0 });
    this.mesh = new THREE.InstancedMesh(geo, trafficCarMaterial(), this.count);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.castShadow = true;
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    const color = new THREE.Color();
    this.cars = new Array(this.count).fill(null);
    for (let i = 0; i < this.count; i++) {
      color.setHSL(Math.random(), 0.32 + Math.random() * 0.3, 0.34 + Math.random() * 0.26);
      this.mesh.setColorAt(i, color);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;

    this._m = new THREE.Matrix4();
    this._hidden = new THREE.Matrix4().makeScale(0, 0, 0);
    this._nextId = 0;
    // edgeKey -> cars on it, so leader lookup is a sorted scan of a short list
    // rather than an O(n^2) sweep over the whole fleet.
    this._byEdge = new Map();
    // junction vertex -> car id currently crossing
    this._junctions = new Map();

    this.stats = {
      spawns: 0, despawns: 0, deadEnds: 0, uTurns: 0,
      orphaned: 0, maxSimultaneousOrphans: 0, worstOrphanS: 0,
      overlapFrames: 0, frames: 0,
      junctionWaitCarFrames: 0, followBrakeCarFrames: 0, stoppedCarFrames: 0,
      entryBlockedCarFrames: 0,
      carFrames: 0,
      // Where overlaps actually happen, so the number can be acted on.
      overlapNearJunction: 0, overlapSameEdge: 0, overlapCrossEdge: 0,
    };
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
    this._lenCache = new Map();
    this.spawnable = this.d.edges
      .map((_, i) => i)
      .filter((i) => this.d.edges[i].r <= 6 && this._len(i) > 25);
  }

  _len(i) {
    if (this._lenCache.has(i)) return this._lenCache.get(i);
    const e = this.d.edges[i];
    let l = 0;
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
      l += Math.hypot(b.x - a.x, b.z - a.z);
    }
    this._lenCache.set(i, l);
    return l;
  }

  // Speed limit from road class. A service alley and an arterial should not carry
  // the same traffic speed, and the baked graph already knows which is which.
  _speedLimit(edgeIdx) {
    const r = this.d.edges[edgeIdx].r;
    if (r <= 2) return 15.5;      // primary
    if (r <= 4) return 12.5;      // secondary / tertiary
    if (r <= 6) return 9.0;       // residential / unclassified
    return 6.5;                   // service
  }

  // Lateral offset for right-hand traffic. Without this, opposing streams share a
  // centreline and every head-on pass counts as an overlap.
  _laneOffset(edgeIdx) {
    const e = this.d.edges[edgeIdx];
    if (e.o !== 0) return 0;                      // one-way: use the centre
    return Math.min(3.6, Math.max(2.2, e.w / 4));
  }

  _pointOn(edgeIdx, forward, t) {
    const e = this.d.edges[edgeIdx];
    const pts = forward
      ? e.v.map((v) => this.d.verts[v])
      : [...e.v].reverse().map((v) => this.d.verts[v]);
    let rem = t;
    for (let k = 0; k < pts.length - 1; k++) {
      const a = pts[k], b = pts[k + 1];
      const seg = Math.hypot(b.x - a.x, b.z - a.z);
      if (rem <= seg || k === pts.length - 2) {
        const f = seg > 0 ? Math.min(1, rem / seg) : 0;
        const dx = (b.x - a.x) / (seg || 1), dz = (b.z - a.z) / (seg || 1);
        return {
          x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f,
          dx, dz, yaw: Math.atan2(dx, dz),
        };
      }
      rem -= seg;
    }
    return null;
  }

  _endVertex(edgeIdx, forward) {
    const e = this.d.edges[edgeIdx];
    return forward ? e.v[e.v.length - 1] : e.v[0];
  }

  _edgeKey(car) { return `${car.edge}:${car.forward ? 1 : 0}`; }

  _spawn(i, playerPos) {
    for (let a = 0; a < 40; a++) {
      const edge = this.spawnable[(Math.random() * this.spawnable.length) | 0];
      const e = this.d.edges[edge];
      const forward = e.o === -1 ? false : e.o === 1 ? true : Math.random() < 0.5;
      const len = this._len(edge);
      const t = Math.random() * len;
      const p = this._pointOn(edge, forward, t);
      if (!p) continue;
      const dist = Math.hypot(p.x - playerPos.x, p.z - playerPos.z);
      if (dist < this.spawnMin || dist > this.spawnMax) continue;

      // Refuse a spawn that would immediately overlap someone: the stub's habit of
      // materialising inside another car is a large slice of its overlap rate.
      let blocked = false;
      for (const other of this.cars) {
        if (!other) continue;
        if (other.edge === edge && other.forward === forward && Math.abs(other.t - t) < CAR_LENGTH * 1.8) {
          blocked = true; break;
        }
      }
      if (blocked) continue;

      const limit = this._speedLimit(edge);
      this.cars[i] = {
        id: ++this._nextId, edge, forward, t, len,
        v: limit * (0.55 + Math.random() * 0.35),
        limit: limit * (0.85 + Math.random() * 0.3),
        lane: this._laneOffset(edge),
        holds: [],
        orphanFor: 0, countedOrphan: false,
      };
      this.stats.spawns++;
      return true;
    }
    return false;
  }

  // Release every junction this car holds. Car ids are monotonic, so a vertex left
  // in _junctions by a car that no longer exists can never be matched by any future
  // car either: the junction is closed for the rest of the session and every car
  // routed through it stops dead. Every leak here is permanent, not transient.
  _release(car) {
    for (const jv of car.holds) {
      if (this._junctions.get(jv) === car.id) this._junctions.delete(jv);
    }
    car.holds.length = 0;
  }

  // Release only the junctions BEHIND the car. It may legitimately hold two at once -
  // the one it is clearing and the one it is approaching - whenever the edge between
  // them is shorter than JUNCTION_CLAIM_DIST + JUNCTION_CLEAR_DIST (20 m), which is
  // 31.7% of this district's 935 edges. Holding both is correct. Overwriting the
  // first with the second, which is what a scalar holdingJunction did, stranded it.
  _releaseBehind(car, keep) {
    for (let k = car.holds.length - 1; k >= 0; k--) {
      const jv = car.holds[k];
      if (jv === keep) continue;
      if (this._junctions.get(jv) === car.id) this._junctions.delete(jv);
      car.holds.splice(k, 1);
    }
  }

  // Pick the next edge at a junction. Dead-end routing: if nothing leads onward,
  // turn around rather than despawning. A real street network has cul-de-sacs and
  // a car that reaches one drives back out.
  _chooseNext(car) {
    const v = this._endVertex(car.edge, car.forward);
    const options = (this.out.get(v) ?? []).filter(
      (o) => !(o.e === car.edge && o.forward !== car.forward)
    );
    if (options.length) {
      // Prefer continuing roughly straight, so cars do not pinball at every node.
      const here = this._pointOn(car.edge, car.forward, car.len);
      let best = null, bestScore = -Infinity;
      for (const o of options) {
        const p = this._pointOn(o.e, o.forward, 0);
        if (!p) continue;
        const straight = here ? here.dx * p.dx + here.dz * p.dz : 0;
        const score = straight + Math.random() * 0.55;
        if (score > bestScore) { bestScore = score; best = o; }
      }
      if (best) return best;
    }
    // True dead end: reverse along the edge we came in on, if that is legal.
    const e = this.d.edges[car.edge];
    if (e.o === 0) {
      this.stats.deadEnds++;
      this.stats.uTurns++;
      return { e: car.edge, forward: !car.forward, uTurn: true };
    }
    this.stats.deadEnds++;
    return null;
  }

  // Is the first stretch of this edge already occupied? Checked before a car
  // commits to entering, which is the only moment it can teleport into someone.
  _entryBlocked(edgeIdx, forward) {
    const list = this._byEdge.get(`${edgeIdx}:${forward ? 1 : 0}`);
    if (!list) return false;
    for (const other of list) {
      if (other.t < CAR_LENGTH * 1.6) return true;
    }
    return false;
  }

  // Distance to the vehicle ahead on the same edge and direction, or Infinity.
  _gapAhead(car, list) {
    let best = Infinity, leader = null;
    for (const other of list) {
      if (other === car) continue;
      const d = other.t - car.t;
      if (d > 0 && d < best) { best = d; leader = other; }
    }
    return { gap: best - CAR_LENGTH, leader };
  }

  update(dt, playerPos) {
    this.stats.frames++;

    // Bucket by edge+direction once per frame so leader lookup is cheap.
    this._byEdge.clear();
    for (const car of this.cars) {
      if (!car) continue;
      const k = this._edgeKey(car);
      if (!this._byEdge.has(k)) this._byEdge.set(k, []);
      this._byEdge.get(k).push(car);
    }

    let orphansThisFrame = 0;
    const positions = [];

    for (let i = 0; i < this.count; i++) {
      let car = this.cars[i];
      if (!car) { this._spawn(i, playerPos); car = this.cars[i]; }
      if (!car) { this.mesh.setMatrixAt(i, this._hidden); continue; }

      const list = this._byEdge.get(this._edgeKey(car)) ?? [car];
      const { gap, leader } = this._gapAhead(car, list);

      // --- IDM: free-road term minus interaction term.
      const v = car.v, v0 = Math.max(1, car.limit);
      let accel = IDM.a * (1 - Math.pow(v / v0, IDM.delta));
      if (leader && Number.isFinite(gap)) {
        const dv = v - leader.v;
        const sStar = IDM.s0 + Math.max(0, v * IDM.T + (v * dv) / (2 * Math.sqrt(IDM.a * IDM.b)));
        const s = Math.max(0.6, gap);
        accel -= IDM.a * Math.pow(sStar / s, 2);
        if (accel < -0.2) this.stats.followBrakeCarFrames++;
      }

      // --- Junction arbitration. Approaching the end of an edge, a car must hold
      // the conflict point before entering it. One holder at a time turns a
      // free-for-all crossing into a queue.
      const toEnd = car.len - car.t;
      if (toEnd < JUNCTION_CLAIM_DIST) {
        const jv = this._endVertex(car.edge, car.forward);
        const holder = this._junctions.get(jv);
        if (holder === undefined) {
          this._junctions.set(jv, car.id);
          if (!car.holds.includes(jv)) car.holds.push(jv);
        } else if (holder !== car.id) {
          // Someone else owns it: decelerate to a stop short of the line. The stop
          // line acts as a stationary leader, so followers queue behind rather
          // than all braking for the junction independently and stacking up on it.
          const stopGap = Math.max(0.5, toEnd - IDM.s0);
          accel = Math.min(accel, -(v * v) / (2 * stopGap));
          this.stats.junctionWaitCarFrames++;
        }
      }

      car.v = Math.max(0, Math.min(car.limit, v + accel * dt));
      if (car.v < 0.15) this.stats.stoppedCarFrames++;
      this.stats.carFrames++;
      car.t += car.v * dt;

      let p = this._pointOn(car.edge, car.forward, car.t);
      if (!p || car.t >= car.len) {
        const next = this._chooseNext(car);
        // Refuse to enter an edge whose entry is occupied. Without this a car can
        // cross a junction onto a vehicle that has not yet cleared the far side.
        if (next && this._entryBlocked(next.e, next.forward)) {
          car.t = Math.min(car.t, car.len);
          car.v = 0;
          this.stats.entryBlockedCarFrames++;
          // The reservation is deliberately HELD while blocked. Releasing it let
          // another approach into a junction the blocked car still occupies, and
          // measured 34.3% overlap against 13.0% for holding.
          p = this._pointOn(car.edge, car.forward, car.t);
          if (p) {
            const nx0 = -p.dz, nz0 = p.dx;
            const bx = p.x + nx0 * car.lane, bz = p.z + nz0 * car.lane;
            positions.push({ x: bx, z: bz, edge: car.edge, toEnd: 0, id: car.id });
            this._m.makeRotationY(p.yaw);
            this._m.setPosition(bx, 0, bz);
            this.mesh.setMatrixAt(i, this._m);
          }
          continue;
        }
        // Deliberately NOT released here: the car is entering the conflict point,
        // not leaving it. It keeps the reservation until it is JUNCTION_CLEAR_DIST
        // along the new edge, which is what stops a second car driving into the
        // intersection on top of it.
        if (!next) {
          this._release(car);
          this.cars[i] = null;
          this.mesh.setMatrixAt(i, this._hidden);
          continue;
        }
        car.edge = next.e;
        car.forward = next.forward;
        car.t = 0;
        car.len = this._len(next.e);
        car.lane = this._laneOffset(next.e);
        car.limit = this._speedLimit(next.e) * (0.85 + Math.random() * 0.3);
        if (next.uTurn) car.v = Math.min(car.v, 2.5);
        p = this._pointOn(car.edge, car.forward, 0);
        if (!p) { this._release(car); this.cars[i] = null; this.mesh.setMatrixAt(i, this._hidden); continue; }
      } else if (car.holds.length && car.t > JUNCTION_CLEAR_DIST) {
        // Clear of the entry: drop what is behind us, but keep the junction ahead if
        // it has already been claimed.
        this._releaseBehind(car, this._endVertex(car.edge, car.forward));
      }

      // Right-hand lane offset, perpendicular to travel.
      const nx = -p.dz, nz = p.dx;
      const x = p.x + nx * car.lane;
      const z = p.z + nz * car.lane;

      const dist = Math.hypot(x - playerPos.x, z - playerPos.z);
      if (dist > this.despawnRadius) {
        this._release(car);
        this.cars[i] = null;
        this.stats.despawns++;
        this.mesh.setMatrixAt(i, this._hidden);
        continue;
      }

      // Orphan = alive and simulated in a chunk the streamer has not loaded.
      const loaded = this.isChunkLoaded ? this.isChunkLoaded(x, z) : true;
      if (!loaded) {
        car.orphanFor += dt;
        orphansThisFrame++;
        if (car.orphanFor > this.stats.worstOrphanS) this.stats.worstOrphanS = +car.orphanFor.toFixed(2);
        if (!car.countedOrphan) { car.countedOrphan = true; this.stats.orphaned++; }
      } else {
        car.orphanFor = 0;
      }

      positions.push({ x, z, edge: car.edge, toEnd: car.len - car.t, id: car.id });
      this._m.makeRotationY(p.yaw);
      this._m.setPosition(x, 0, z);
      this.mesh.setMatrixAt(i, this._m);
    }

    // Overlap, measured exactly as the stub measured it so the comparison holds.
    let overlapped = false, worst = null, minD = Infinity;
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        const d = Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
        if (d < minD) { minD = d; }
        if (d < this.overlapDistance) {
          overlapped = true;
          if (!worst || d < Math.hypot(worst[0].x - worst[1].x, worst[0].z - worst[1].z)) {
            worst = [positions[a], positions[b]];
          }
        }
      }
    }
    if (Number.isFinite(minD)) {
      this._minHist = this._minHist ?? new Array(10).fill(0);
      this._minHist[Math.min(9, Math.floor(minD))]++;
      if (minD < (this.stats.closestApproachM ?? Infinity)) this.stats.closestApproachM = +minD.toFixed(2);
    }
    if (overlapped) {
      this.stats.overlapFrames++;
      const [p1, p2] = worst;
      if (p1.toEnd < JUNCTION_CLAIM_DIST || p2.toEnd < JUNCTION_CLAIM_DIST) this.stats.overlapNearJunction++;
      else if (p1.edge === p2.edge) this.stats.overlapSameEdge++;
      else this.stats.overlapCrossEdge++;
    }
    if (orphansThisFrame > this.stats.maxSimultaneousOrphans) {
      this.stats.maxSimultaneousOrphans = orphansThisFrame;
    }
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  // Lamps on the whole fleet at once: the emissive palette texel already knows
  // which triangles are headlamps and which are tail lamps, so one uniform does
  // 60 cars without costing a draw call.
  setLights(on, exposure) {
    const e = lampEmissive(on, exposure, 1.5);
    if (e === this._lit) return;
    this._lit = e;
    this.mesh.material.emissive.setScalar(e);
  }

  report() {
    const f = Math.max(1, this.stats.frames);
    const alive = this.cars.filter(Boolean);
    return {
      fleet: this.count,
      alive: alive.length,
      ...this.stats,
      overlapPctOfFrames: +((this.stats.overlapFrames / f) * 100).toFixed(1),
      // These are per-CAR-per-frame events; dividing by frames alone reported
      // over 100% and meant nothing.
      junctionWaitPctOfCarFrames: +((this.stats.junctionWaitCarFrames / Math.max(1, this.stats.carFrames)) * 100).toFixed(1),
      followBrakePctOfCarFrames: +((this.stats.followBrakeCarFrames / Math.max(1, this.stats.carFrames)) * 100).toFixed(1),
      stoppedPctOfCarFrames: +((this.stats.stoppedCarFrames / Math.max(1, this.stats.carFrames)) * 100).toFixed(1),
      meanSpeedKmh: alive.length
        ? +((alive.reduce((a, c) => a + c.v, 0) / alive.length) * 3.6).toFixed(1) : 0,
      junctionsHeld: this._junctions.size,
      // Distribution of the closest pair each frame, in 1 m buckets. Tells the
      // difference between cars interpenetrating and cars merely passing close.
      closestPairHistogram: this._minHist ?? [],
      drawCalls: 1,
    };
  }
}

// The Phase 1b name, kept so district/main.js and the harnesses do not have to
// change in the same commit as the behaviour.
export { Traffic as TrafficStub };
