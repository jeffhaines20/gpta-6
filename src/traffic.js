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
//   3. Junction arbitration - a car claims a junction against the MOVEMENTS it
//                          actually crosses, not against the junction as a whole.
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

// Radius of the physical intersection box, used ONLY for classifying where an
// overlap happened. The shipped classifier keys on `toEnd < JUNCTION_CLAIM_DIST`,
// which calls a car 12 m from the end of a short edge "near a junction" and calls a
// car 1 m PAST one "mid-block". Both counters are reported: the original unchanged
// so the comparison with earlier rounds holds, and this one because the original
// cannot tell the two situations apart.
const JUNCTION_BOX_R = 8;

// ---------------------------------------------------------------- conflict model
// A junction used to be a single mutex: one car id at a time, whoever asked first.
// That is wrong in the direction that matters, because it serialises movements that
// never touch. Two cars going opposite ways through the same mid-street node, a
// platoon crossing on one approach, two turns into opposite corners - all of them
// queued for each other, and at 60 cars the queues were most of the fleet.
//
// A movement is (approach edge+direction -> exit edge+direction). Two movements
// conflict when the two sets of positions their cars will occupy inside the junction
// come within CONFLICT_CLEARANCE of each other. The positions are not modelled: they
// are the same centreline-plus-lane-offset points update() writes into the instance
// matrix, sampled along both arms, so there is no curve-fit to be wrong about.
//
// The two arms are kept as SEPARATE polylines. A car's lateral offset jumps at the
// node - it is at V + lane_in*n_in on one frame and V + lane_out*n_out on the next,
// and never occupies the line between - so joining them into one polyline draws a
// phantom segment through the middle of the junction. Measured: that phantom drags
// the reciprocal through-pairs from 4.40 m apart down to 2.27 m and makes 95% of
// them conflict, which would have quietly reproduced the old behaviour.
//
// CONFLICT_CLEARANCE = 3.6 m is read off the district, not guessed. Over all 6,404
// movement pairs at its 503 multi-approach junctions the separations are trimodal:
// 1,983 pairs at 0.0-0.5 m (paths that genuinely cross), 1,132 at 2.0-2.5 m (one
// lane offset - a through against a turn beside it), and 346 at 4.0-4.5 m (two lane
// offsets - opposing streams on their own sides). Only 112 pairs fall in the
// 2.5-4.0 m band at all. 3.6 m sits in that empty band: above the 2.5 m overlap
// threshold with margin, so nothing this model waves through can register as an
// overlap by construction, and below 4.33 m (the 5th percentile of reciprocal
// through-pairs), so 348 of 353 of them are freed.
const CONFLICT_CLEARANCE = 3.6;
const CONFLICT_SAMPLES = 4;       // per arm
// Room a car needs on the far side before it may enter a junction. It is not "is
// the exit occupied right now" but "will I come to rest clear of the junction": a
// car joining a queue stops CAR_LENGTH + s0 behind the last stopped car, and it has
// to end up past JUNCTION_CLEAR_DIST or it never releases the junction it just
// crossed. Measured with the weaker "first 7 m are clear" rule: cars parked on
// 10-15 m blocks held the junction behind them for the whole time they waited at
// the next one, and every conflicting movement there starved - 20 cars per run
// waiting over 15 s, and every dump of a starved junction showed the same shape.
const EXIT_CLEAR_NEEDED = JUNCTION_CLEAR_DIST + CAR_LENGTH + IDM.s0;   // 14.6 m
const EXIT_CLEAR_SPEED = 2.0;     // below this a car on the exit counts as blocking
// How far short of the node a denied car stops. OSM puts its node at the CENTRE of
// an intersection, so a stop line a car's nose-length back is still inside the box:
// measured at 2.6 m, three quarters of all remaining overlapping pairs were a car
// waiting at its line and a car crossing legally in front of it. See the sweep in
// the ledger - this is the one parameter here with a real throughput cost.
const STOP_LINE = 6.0;
const REPLAN_AFTER_S = 3.0;       // denied this long, take a different exit
const STUCK_LIMIT_S = 20;         // immobile this long, the car is recovered
const WAIT_BUCKETS = 121;         // wait histogram: 0.5 s buckets out to 60 s

// Distance from point p to segment a-b, in the ground plane.
function pointSegDistance(p, a, b) {
  const vx = b.x - a.x, vz = b.z - a.z, l2 = vx * vx + vz * vz;
  if (l2 < 1e-9) return Math.hypot(p.x - a.x, p.z - a.z);
  let t = ((p.x - a.x) * vx + (p.z - a.z) * vz) / l2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return Math.hypot(p.x - (a.x + vx * t), p.z - (a.z + vz * t));
}

function segmentDistance(p1, p2, p3, p4) {
  const side = (a, b, c) => Math.sign((b.x - a.x) * (c.z - a.z) - (b.z - a.z) * (c.x - a.x));
  if (side(p1, p2, p3) !== side(p1, p2, p4) && side(p3, p4, p1) !== side(p3, p4, p2)) return 0;
  return Math.min(
    pointSegDistance(p1, p3, p4), pointSegDistance(p2, p3, p4),
    pointSegDistance(p3, p1, p2), pointSegDistance(p4, p1, p2));
}

function polylineDistance(A, B) {
  if (A.length < 2 || B.length < 2) return Infinity;
  let m = Infinity;
  for (let i = 0; i < A.length - 1; i++) {
    for (let j = 0; j < B.length - 1; j++) {
      const d = segmentDistance(A[i], A[i + 1], B[j], B[j + 1]);
      if (d < m) m = d;
    }
  }
  return m;
}

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
    // junction vertex -> { active: Map<carId, movement>, queue: Map<carId, request> }
    // `active` is the set of movements currently being made through the junction,
    // which is the whole change: it used to be one car id.
    this._junctions = new Map();
    // Movements are INTERNED: one object per (approach, exit) pair for the life of
    // the session. Building a fresh one per car per frame put a small object and a
    // template string into the nursery on every claim, which is what turned a 0.18 ms
    // frame at 90 cars into a 44 ms GC spike. Interning also lets each movement carry
    // its own sampled path and its own conflict answers, keyed by object identity, so
    // the hot path allocates nothing at all.
    this._moveCache = new Map();      // movement key -> movement
    this._ticket = 0;                 // monotonic, gives the queue a FCFS order

    this.stats = {
      spawns: 0, despawns: 0, deadEnds: 0, uTurns: 0,
      orphaned: 0, maxSimultaneousOrphans: 0, worstOrphanS: 0,
      overlapFrames: 0, frames: 0,
      junctionWaitCarFrames: 0, followBrakeCarFrames: 0, stoppedCarFrames: 0,
      entryBlockedCarFrames: 0,
      carFrames: 0,
      // Where overlaps actually happen, so the number can be acted on.
      overlapNearJunction: 0, overlapSameEdge: 0, overlapCrossEdge: 0,
      // `overlapFrames` is a MAX statistic - one stuck pair pins it at 100% for as
      // long as it is stuck, which is why it swings 0.5% -> 29% between two windows
      // of the same build. These count the population instead, so a fleet-wide
      // change is distinguishable from one car wedged against a kerb.
      overlapPairFrames: 0, overlapCarFrames: 0,
      overlapPairsNearJunction: 0, overlapPairsMidBlock: 0,
      // Junction wait episodes, closed when the car is finally let through. Needed
      // because a mean wait hides starvation completely: the failure mode is one
      // turning car waiting 40 s while the mean sits at 0.4 s.
      waitEpisodes: 0, waitSumS: 0, waitMaxS: 0,
      // Why a claim was refused, so a throughput loss can be attributed.
      conflictDenials: 0, queueDenials: 0, boxDenials: 0, replans: 0,
      // Cars recovered by the anti-gridlock rule. This is the ONLY thing standing
      // between the arbitration and a permanent deadlock, so it is reported whether
      // it fires or not - a silent zero is the result, not the absence of one.
      gridlockRecoveries: 0,
      gridlockByReason: { conflict: 0, queue: 0, box: 0, none: 0 },
      maxActiveInAJunction: 0,
    };
    // Exposed so a harness can turn the anti-gridlock rule OFF as a control. A
    // result that only holds because jammed cars are being deleted is not a result.
    this.stuckLimitS = opts.stuckLimitS ?? STUCK_LIMIT_S;
    this.stopLine = opts.stopLine ?? STOP_LINE;
    this._waitHist = new Array(WAIT_BUCKETS).fill(0);   // 0.5 s buckets, last is 60 s+
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
        waitS: 0, stuckS: 0, sinceReplanS: 0, fromArm: null, lastDeny: null,
        plan: null, planJv: null, mv: null, ticket: 0, queuedAt: null,
        orphanFor: 0, countedOrphan: false,
      };
      this.stats.spawns++;
      return true;
    }
    return false;
  }

  // ------------------------------------------------------------ conflict model
  // Drop a junction with nothing happening at it. Without this the map only ever
  // grows - one entry per vertex any car has ever approached - and report(), which
  // main.js calls every frame for the debug readout, walks all of them.
  _forgetIfIdle(jv, js) {
    if (js && js.active.size === 0 && js.queue.size === 0) this._junctions.delete(jv);
  }

  _junctionState(jv) {
    let js = this._junctions.get(jv);
    if (!js) { js = { active: new Map(), queue: new Map() }; this._junctions.set(jv, js); }
    return js;
  }

  _armKey(e, forward) { return `${e}:${forward ? 1 : 0}`; }

  // The points a car on this arm actually occupies, from `span` metres out to the
  // node (entry) or from the node out to `span` (exit). Same maths as update().
  _arm(edge, forward, entry) {
    const len = this._len(edge);
    const span = Math.min(JUNCTION_BOX_R, len);
    const lane = this._laneOffset(edge);
    const from = entry ? len - span : 0;
    const to = entry ? len : span;
    const pts = [];
    for (let i = 0; i < CONFLICT_SAMPLES; i++) {
      const p = this._pointOn(edge, forward, from + (to - from) * (i / (CONFLICT_SAMPLES - 1)));
      if (p) pts.push({ x: p.x - p.dz * lane, z: p.z + p.dx * lane });
    }
    return pts;
  }

  _movementPath(mv) {
    if (!mv.path) mv.path = [this._arm(mv.inE, mv.inF, true), this._arm(mv.outE, mv.outF, false)];
    return mv.path;
  }

  // Do these two movements' occupied point sets come within CONFLICT_CLEARANCE?
  _conflicts(a, b) {
    if (a === b) return false;
    // Same approach lane: the two cars are nose to tail on the same road and their
    // separation is car-following's problem, not the junction's. Making them
    // conflict is what stopped a platoon crossing together.
    if (a.inKey === b.inKey) return false;
    // Same exit lane: they merge into the same space. Always a conflict.
    if (a.outKey === b.outKey) return true;
    if (a.key === '*' || b.key === '*') return true;   // test hold, conflicts with all
    const hit = a.conflict.get(b);
    if (hit !== undefined) return hit;
    const A = this._movementPath(a), B = this._movementPath(b);
    let min = Infinity;
    for (const pa of A) for (const pb of B) {
      const d = polylineDistance(pa, pb);
      if (d < min) min = d;
      if (min < CONFLICT_CLEARANCE) break;
    }
    const out = min < CONFLICT_CLEARANCE;
    a.conflict.set(b, out);
    b.conflict.set(a, out);
    return out;
  }

  _movement(inE, inF, outE, outF) {
    const key = `${inE}:${inF ? 1 : 0}>${outE}:${outF ? 1 : 0}`;
    let mv = this._moveCache.get(key);
    if (!mv) {
      mv = {
        key, inKey: this._armKey(inE, inF), outKey: this._armKey(outE, outF),
        inE, inF, outE, outF, path: null, conflict: new Map(),
      };
      this._moveCache.set(key, mv);
    }
    return mv;
  }

  // Is the far side of the junction backed up? A car may not enter a junction it
  // cannot leave - the "do not block the box" rule - because a car stopped inside a
  // junction is what turns a queue into a gridlock. A car merely PASSING through the
  // exit is not a blocker: it will be gone by the time we arrive, and treating it as
  // one costs throughput for nothing. Only a slow or stopped one counts.
  _exitBlocked(edgeIdx, forward) {
    const list = this._byEdge.get(`${edgeIdx}:${forward ? 1 : 0}`);
    if (!list) return false;
    for (const other of list) {
      if (other.v < EXIT_CLEAR_SPEED && other.t < EXIT_CLEAR_NEEDED) return true;
    }
    return false;
  }

  _leaveQueue(car) {
    if (car.queuedAt === undefined || car.queuedAt === null) return;
    const js = this._junctions.get(car.queuedAt);
    if (js) { js.queue.delete(car.id); this._forgetIfIdle(car.queuedAt, js); }
    car.queuedAt = null;
  }

  // Test affordances. `tools/traffic-selftest.mjs` needs to be able to hold a
  // junction against every real car and then let go, without depending on which
  // arbitration model is in the file.
  _blockJunction(jv) {
    this._junctionState(jv).active.set(-1, { key: '*', inKey: '*', outKey: '*', conflict: new Map() });
  }
  _unblockJunction(jv) { const js = this._junctions.get(jv); if (js) js.active.delete(-1); }

  // One closed junction-wait episode, in seconds.
  _recordWait(sec) {
    this.stats.waitEpisodes++;
    this.stats.waitSumS += sec;
    if (sec > this.stats.waitMaxS) this.stats.waitMaxS = sec;
    this._waitHist[Math.min(WAIT_BUCKETS - 1, Math.floor(sec / 0.5))]++;
  }

  resetWaitHistogram() {
    this._waitHist = new Array(WAIT_BUCKETS).fill(0);
    this.stats.waitEpisodes = 0; this.stats.waitSumS = 0; this.stats.waitMaxS = 0;
  }

  waitReport() {
    const h = this._waitHist, n = h.reduce((a, b) => a + b, 0);
    const q = (frac) => {
      if (!n) return 0;
      let seen = 0;
      for (let i = 0; i < h.length; i++) {
        seen += h[i];
        if (seen >= n * frac) return +((i + 1) * 0.5).toFixed(2);
      }
      return +((h.length) * 0.5).toFixed(2);
    };
    return {
      episodes: n,
      meanS: n ? +(this.stats.waitSumS / n).toFixed(3) : 0,
      p50S: q(0.5), p90S: q(0.9), p95S: q(0.95), p99S: q(0.99),
      maxS: +this.stats.waitMaxS.toFixed(2),
      histogram: h.slice(),
    };
  }

  // Release every junction this car holds, and its place in any queue. A leak here
  // is permanent, not transient: car ids are monotonic, so an `active` entry left
  // behind by a car that no longer exists is never removed by anything, and every
  // movement that conflicts with it is refused for the rest of the session.
  _release(car) {
    if (car.waitS > 0) { this._recordWait(car.waitS); car.waitS = 0; }
    for (const jv of car.holds) {
      const js = this._junctions.get(jv);
      if (js) { js.active.delete(car.id); this._forgetIfIdle(jv, js); }
    }
    car.holds.length = 0;
    this._leaveQueue(car);
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
      const js = this._junctions.get(jv);
      if (js) { js.active.delete(car.id); this._forgetIfIdle(jv, js); }
      car.holds.splice(k, 1);
    }
  }

  // Pick the next edge at a junction. Dead-end routing: if nothing leads onward,
  // turn around rather than despawning. A real street network has cul-de-sacs and
  // a car that reaches one drives back out.
  _chooseNext(car, avoid) {
    const v = this._endVertex(car.edge, car.forward);
    let options = (this.out.get(v) ?? []).filter(
      (o) => !(o.e === car.edge && o.forward !== car.forward)
    );
    // A replan that can return the exit it is replanning away from is not a replan.
    // Without this the straightness bias returns the same edge nearly every time and
    // the whole rule fires 0-2 times a run, i.e. it is decoration.
    if (avoid && options.length > 1) {
      const alt = options.filter((o) => !(o.e === avoid.e && o.forward === avoid.forward));
      if (alt.length) options = alt;
    }
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
      let { gap, leader } = this._gapAhead(car, list);

      // Plan the turn here rather than at the transition: the conflict predicate is
      // over (approach, exit) pairs, so the exit has to be known before the claim,
      // and car-following needs it too - see below.
      const toEnd = car.len - car.t;
      const jvAhead = this._endVertex(car.edge, car.forward);
      if (toEnd < JUNCTION_CLAIM_DIST && (!car.plan || car.planJv !== jvAhead)) {
        car.plan = this._chooseNext(car); car.planJv = jvAhead; car.sinceReplanS = 0;
        car.mv = car.plan ? this._movement(car.edge, car.forward, car.plan.e, car.plan.forward) : null;
      }

      // Car-following ACROSS the junction. Without this a car has no leader the
      // moment its leader crosses the node, so it accelerates into the intersection
      // and parks on top of it: the entry check only fires at the transition, by
      // which time the car is already standing on the node. Measured before this:
      // a third of all remaining overlapping pairs were a car at the end of its edge
      // sitting 0.1-0.6 m from a car that had just entered the edge it was aiming
      // for. Reaching over the junction for the leader is also simply what a driver
      // does - you brake for the queue on the far side, not for the white line.
      // It also has to reach onto the exits the car is NOT taking. Two cars from the
      // same approach are exempt from the conflict test on purpose - that exemption
      // is what lets a platoon cross together - so nothing at the junction level
      // separates a leader that turns left from a follower that goes straight. They
      // share the approach lane, then swing apart at the node, and for a frame or two
      // the lane offsets put them inside 2.5 m of each other. With the conflict model
      // in place that divergence was every one of the worst residual pairs. The car
      // ahead is still the car ahead until it is clear of the box, whichever way it
      // went, so it keeps its leader until then.
      if (car.plan && toEnd < JUNCTION_CLAIM_DIST) {
        const planKey = `${car.plan.e}:${car.plan.forward ? 1 : 0}`;
        // The exit this car is taking: anything ahead on it is a leader. Looked up
        // directly rather than through out(), because the dead-end U-turn plan is
        // not one of the junction's exits and would be missed - 25-43 U-turns a run.
        const ahead = this._byEdge.get(planKey);
        if (ahead) {
          for (const other of ahead) {
            if (other === car) continue;
            const g = toEnd + other.t - CAR_LENGTH;
            if (g < gap) { gap = g; leader = other; }
          }
        }
        // The other exits: only a car that came out of this car's own approach and
        // is still inside the junction box - the car it was following before the
        // two of them diverged.
        const myArm = this._edgeKey(car);
        for (const o of this.out.get(jvAhead) ?? []) {
          const k = `${o.e}:${o.forward ? 1 : 0}`;
          if (k === planKey) continue;
          const l = this._byEdge.get(k);
          if (!l) continue;
          for (const other of l) {
            if (other === car || other.fromArm !== myArm || other.t > JUNCTION_BOX_R) continue;
            const g = toEnd + other.t - CAR_LENGTH;
            if (g < gap) { gap = g; leader = other; }
          }
        }
      }

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

      // --- Junction arbitration. Approaching the end of an edge, a car must be
      // granted its MOVEMENT through the junction before it enters. It is refused
      // only by movements it actually crosses; everything else goes at the same
      // time. See the conflict-model note at the top of the file.
      let denied = false;
      if (toEnd < JUNCTION_CLAIM_DIST) {
        const jv = jvAhead;
        const js = this._junctionState(jv);
        if (!js.active.has(car.id)) {
          if (!car.plan) {
            // One-way dead end: nothing to claim, the car despawns at the end.
            this._leaveQueue(car);
          } else {
            const mv = car.mv;
            if (car.queuedAt !== jv) { this._leaveQueue(car); car.ticket = ++this._ticket; car.queuedAt = jv; }
            js.queue.set(car.id, { ticket: car.ticket, mv });

            // Order matters for attribution, not for the outcome: all three refuse.
            // The box is checked FIRST because it is the cheapest and because when a
            // car is both boxed out and conflicted, the box is the real reason - the
            // junction being free would not help it. Checking conflicts first blamed
            // the reservation for jams that were plain congestion on the far side.
            let ok = !this._exitBlocked(car.plan.e, car.plan.forward), why = ok ? '' : 'box';
            if (ok) {
              for (const [cid, other] of js.active) {
                if (cid !== car.id && this._conflicts(mv, other)) { ok = false; why = 'conflict'; break; }
              }
            }
            // First come, first served among conflicting requests. A car can only be
            // held back by a request that arrived EARLIER, so its rank in the queue
            // only ever improves: no car can be passed indefinitely. This is what
            // keeps a busy through-movement from starving a turning car forever.
            if (ok) {
              for (const [cid, req] of js.queue) {
                if (cid !== car.id && req.ticket < car.ticket && this._conflicts(mv, req.mv)) {
                  ok = false; why = 'queue'; break;
                }
              }
            }
            if (ok) {
              js.active.set(car.id, mv);
              js.queue.delete(car.id);
              car.queuedAt = null;
              // Cleared so that a recovery attributed to 'none' really does mean the
              // car was holding rather than refused, instead of quoting a refusal
              // from some junction it passed through minutes ago.
              car.lastDeny = null;
              if (!car.holds.includes(jv)) car.holds.push(jv);
              if (js.active.size > this.stats.maxActiveInAJunction) {
                this.stats.maxActiveInAJunction = js.active.size;
              }
            } else {
              // Decelerate to the stop line, which sits STOP_LINE short of the node
              // so a waiting car is outside the intersection rather than parked on
              // it. The stop line acts as a stationary leader, so followers queue
              // behind rather than each braking for the junction independently.
              const stopGap = Math.max(0.5, toEnd - this.stopLine);
              accel = Math.min(accel, -(v * v) / (2 * stopGap));
              this.stats.junctionWaitCarFrames++;
              car.lastDeny = why;
              if (why === 'conflict') this.stats.conflictDenials++;
              else if (why === 'queue') this.stats.queueDenials++;
              else this.stats.boxDenials++;
              denied = true;
              // Held up long enough to change your mind. Ambient traffic has no
              // destination, so taking a different exit is free, and it stops a car
              // queueing behind a permanently blocked exit.
              car.sinceReplanS += dt;
              if (car.sinceReplanS > REPLAN_AFTER_S) {
                car.sinceReplanS = 0;
                const alt = this._chooseNext(car, car.plan);
                if (alt && (alt.e !== car.plan.e || alt.forward !== car.plan.forward)) {
                  car.plan = alt; this.stats.replans++;
                  car.mv = this._movement(car.edge, car.forward, alt.e, alt.forward);
                }
              }
            }
          }
        }
      } else if (car.queuedAt !== null && car.queuedAt !== undefined) {
        this._leaveQueue(car);
      }
      // Close the wait episode the frame the car is finally let through, so the
      // distribution is over waits-at-a-junction and not over frames.
      if (denied) car.waitS += dt;
      else if (car.waitS > 0) { this._recordWait(car.waitS); car.waitS = 0; }

      car.v = Math.max(0, Math.min(car.limit, v + accel * dt));
      if (car.v < 0.15) this.stats.stoppedCarFrames++;
      // Stuck time for the anti-gridlock rule below. It counts only while a car is
      // stationary AND involved with a junction: refused a claim, or holding one it
      // has not finished crossing. (A car blocked at an entry is in the second case
      // by construction - it holds the junction it is standing in.) A car stationary
      // purely behind another car is excluded: it is in a queue, and a queue moves
      // when its head does.
      //
      // That restriction is what makes the bound below an argument rather than a
      // coincidence. Any wait-for cycle must contain a relation that crosses a
      // junction, because same-edge following orders cars strictly by position along
      // a finite edge and cannot close on itself. The car on the upstream side of
      // such a relation is either refused at that junction or already holding it, so
      // every cycle contains at least one car this rule can see. No car is
      // stationary longer than stuckLimitS, and removing one breaks the cycle.
      //
      // Restricting it away from plain queueing was checked against the unrestricted
      // version: 32 runs, identical to the last digit, so the rule was already only
      // firing on junction-involved cars. It is written down because the argument
      // needs it, not because it moved a number.
      if (car.v < 0.15 && (denied || car.holds.length)) car.stuckS += dt;
      else if (car.v >= 0.15) car.stuckS = 0;
      this.stats.carFrames++;
      car.t += car.v * dt;

      // A denied car must not creep onto the node. Braking alone overshoots at any
      // real step size, and two cars stopped on the same one-way node measured 0.0 m
      // apart - full interpenetration, and the reason the baseline's closest
      // approach was zero. The clamp is at most a fraction of a metre.
      if (denied) {
        const stopAt = Math.max(0, car.len - this.stopLine);
        if (car.t > stopAt) { car.t = stopAt; car.v = 0; }
      }

      // Anti-gridlock. Everything above prevents the ARBITRATION from deadlocking;
      // nothing above can prevent cars from physically boxing each other in on a
      // grid of short blocks, which is a real traffic phenomenon and not a bug in
      // the reservation. A car stationary at a junction for stuckLimitS is removed,
      // which breaks any cycle it is part of by deleting a node from it. Whether it
      // ever fires is reported, not assumed - see stats.gridlockRecoveries, and the
      // control run with stuckLimitS off, which reaches the same overlap figure.
      if (car.stuckS > this.stuckLimitS) {
        this._release(car);
        this.cars[i] = null;
        this.stats.gridlockRecoveries++;
        this.stats.gridlockByReason[car.lastDeny ?? 'none']++;
        this.mesh.setMatrixAt(i, this._hidden);
        continue;
      }

      let p = this._pointOn(car.edge, car.forward, car.t);
      if (!p || car.t >= car.len) {
        const jvHere = this._endVertex(car.edge, car.forward);
        const next = (car.plan && car.planJv === jvHere) ? car.plan : this._chooseNext(car);
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
            positions.push({ x: bx, z: bz, edge: car.edge, toEnd: 0, id: car.id, box: true,
              v: car.v, key: this._edgeKey(car), holds: car.holds, blocked: true,
              mv: car.mv ? car.mv.key : null });
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
        this._leaveQueue(car);
        car.plan = null; car.planJv = null; car.mv = null; car.sinceReplanS = 0;
        car.fromArm = this._edgeKey(car);
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

      positions.push({ x, z, edge: car.edge, toEnd: car.len - car.t, id: car.id,
        box: car.t < JUNCTION_BOX_R || car.len - car.t < JUNCTION_BOX_R,
        v: car.v, key: this._edgeKey(car), holds: car.holds, blocked: false,
        mv: car.mv ? car.mv.key : null });
      this._m.makeRotationY(p.yaw);
      this._m.setPosition(x, 0, z);
      this.mesh.setMatrixAt(i, this._m);
    }

    // Overlap, measured exactly as the stub measured it so the comparison holds.
    let overlapped = false, worst = null, minD = Infinity;
    const inOverlap = new Uint8Array(positions.length);
    let pairsThisFrame = 0;
    for (let a = 0; a < positions.length; a++) {
      for (let b = a + 1; b < positions.length; b++) {
        const d = Math.hypot(positions[a].x - positions[b].x, positions[a].z - positions[b].z);
        if (d < minD) { minD = d; }
        if (d < this.overlapDistance) {
          overlapped = true;
          pairsThisFrame++;
          inOverlap[a] = 1; inOverlap[b] = 1;
          if (positions[a].box || positions[b].box) this.stats.overlapPairsNearJunction++;
          else this.stats.overlapPairsMidBlock++;
          if (!worst || d < Math.hypot(worst[0].x - worst[1].x, worst[0].z - worst[1].z)) {
            worst = [positions[a], positions[b]];
          }
        }
      }
    }
    this.stats.overlapPairFrames += pairsThisFrame;
    for (let a = 0; a < positions.length; a++) if (inOverlap[a]) this.stats.overlapCarFrames++;
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
    // Held for the frame so a harness can classify overlaps independently. The
    // harness's own sweep has to reproduce stats.overlapPairFrames exactly, which is
    // what stops two agreeing-but-wrong implementations of the same mistake.
    this._lastPositions = positions;
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
    let active = 0, queued = 0, busiest = 0;
    for (const js of this._junctions.values()) {
      active += js.active.size; queued += js.queue.size;
      if (js.active.size > busiest) busiest = js.active.size;
    }
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
      // Instantaneous, not time-averaged: it is the fleet's speed at the moment
      // report() is called. tools/traffic-sim.mjs integrates its own over the whole
      // window, which is the one to quote for a throughput comparison.
      meanSpeedKmh: alive.length
        ? +((alive.reduce((a, c) => a + c.v, 0) / alive.length) * 3.6).toFixed(1) : 0,
      junctionsHeld: active,
      activeMovements: active,
      queuedCars: queued,
      busiestJunction: busiest,
      // Population view of the same overlaps. Per CAR-frame, so it is comparable
      // across fleet sizes in a way overlapPctOfFrames is not.
      overlapCarPctOfCarFrames: +((this.stats.overlapCarFrames / Math.max(1, this.stats.carFrames)) * 100).toFixed(2),
      overlapPairsPerFrame: +(this.stats.overlapPairFrames / f).toFixed(3),
      // Distribution of the closest pair each frame, in 1 m buckets. Tells the
      // difference between cars interpenetrating and cars merely passing close.
      closestPairHistogram: this._minHist ?? [],
      drawCalls: 1,
    };
  }
}

// ---------------------------------------------------------------- self-test
// The conflict predicate is the whole change, so it gets checked against cases
// whose answer is known from the road layout rather than from the predicate. It has
// to produce BOTH readings: a predicate stuck at `true` reproduces the old
// one-at-a-time junction exactly and would look like a working conflict model.
//
// Run from tools/traffic-selftest.mjs. Takes a live Traffic so it tests the shipped
// geometry on the shipped district, not a synthetic idealisation of either.
export function conflictSelfTest(tr) {
  const d = tr.d, out = [];
  // Approaches into each vertex, mirroring _buildAdjacency's direction rules.
  const incoming = new Map();
  d.edges.forEach((e, i) => {
    const a = e.v[0], b = e.v[e.v.length - 1];
    if (e.o >= 0) { if (!incoming.has(b)) incoming.set(b, []); incoming.get(b).push({ e: i, forward: true }); }
    if (e.o <= 0) { if (!incoming.has(a)) incoming.set(a, []); incoming.get(a).push({ e: i, forward: false }); }
  });
  const dirIn = (m) => tr._pointOn(m.e, m.forward, tr._len(m.e));
  const straightest = (jv, i) => {
    const here = dirIn(i);
    let best = null, bs = -Infinity;
    for (const o of tr.out.get(jv) ?? []) {
      if (o.e === i.e && o.forward !== i.forward) continue;
      const p = tr._pointOn(o.e, o.forward, 0);
      const dot = here.dx * p.dx + here.dz * p.dz;
      if (dot > bs) { bs = dot; best = o; }
    }
    return best && bs > 0.7 ? best : null;
  };
  // A four-arm junction where all four through-movements exist.
  let site = null;
  for (const [jv, ins] of incoming) {
    if (ins.length < 4) continue;
    const th = ins.map((i) => ({ i, o: straightest(jv, i) })).filter((m) => m.o);
    if (th.length < 4) continue;
    site = { jv, th };
    break;
  }
  if (!site) return [{ name: 'four-arm junction found', ok: false, detail: 'none in this district' }];
  out.push({ name: `four-arm test site vertex ${site.jv}`, ok: true, detail: `${site.th.length} through movements` });

  const mvOf = (m) => tr._movement(m.i.e, m.i.forward, m.o.e, m.o.forward);
  // Reciprocal pair: A's approach is B's exit and vice versa - opposite directions
  // of the same street. Must NOT conflict; that is the capacity fix.
  let recip = null, cross = null;
  for (let a = 0; a < site.th.length; a++) {
    for (let b = a + 1; b < site.th.length; b++) {
      const A = site.th[a], B = site.th[b];
      const isRecip = A.i.e === B.o.e && A.i.forward !== B.o.forward
        && B.i.e === A.o.e && B.i.forward !== A.o.forward;
      if (isRecip && !recip) recip = [A, B];
      if (!isRecip && !cross) cross = [A, B];
    }
  }
  if (recip) {
    const [A, B] = recip, ma = mvOf(A), mb = mvOf(B);
    const c = tr._conflicts(ma, mb);
    out.push({ name: 'opposing through-movements do NOT conflict', ok: c === false,
      detail: `${ma.key} vs ${mb.key} -> ${c}` });
    out.push({ name: '  predicate is symmetric', ok: tr._conflicts(mb, ma) === c, detail: '' });
  } else out.push({ name: 'reciprocal through pair present', ok: false, detail: 'none' });

  if (cross) {
    const [A, B] = cross, ma = mvOf(A), mb = mvOf(B);
    out.push({ name: 'crossing through-movements DO conflict', ok: tr._conflicts(ma, mb) === true,
      detail: `${ma.key} vs ${mb.key}` });
  } else out.push({ name: 'crossing through pair present', ok: false, detail: 'none' });

  // Same approach, two different exits: never a junction conflict - the two cars are
  // in the same lane and car-following owns their spacing.
  const app = site.th[0].i;
  const exits = (tr.out.get(site.jv) ?? []).filter((o) => !(o.e === app.e && o.forward !== app.forward));
  if (exits.length >= 2) {
    const m1 = tr._movement(app.e, app.forward, exits[0].e, exits[0].forward);
    const m2 = tr._movement(app.e, app.forward, exits[1].e, exits[1].forward);
    out.push({ name: 'same approach, different exits do NOT conflict',
      ok: tr._conflicts(m1, m2) === false, detail: `${m1.key} vs ${m2.key}` });
  }
  // Two approaches merging into one exit: always a conflict.
  const other = site.th.find((m) => m.i.e !== app.e || m.i.forward !== app.forward);
  if (other && exits.length) {
    const m1 = tr._movement(app.e, app.forward, exits[0].e, exits[0].forward);
    const m2 = tr._movement(other.i.e, other.i.forward, exits[0].e, exits[0].forward);
    out.push({ name: 'two approaches into one exit DO conflict',
      ok: tr._conflicts(m1, m2) === true, detail: `${m1.key} vs ${m2.key}` });
  }
  // The predicate must not be a constant. Over the whole district it has to say both.
  let yes = 0, no = 0;
  for (const [jv, ins] of incoming) {
    const outs = tr.out.get(jv) ?? [];
    if (ins.length < 2 || !outs.length) continue;
    const mv = [];
    for (const i of ins) for (const o of outs) {
      if (o.e === i.e && o.forward !== i.forward) continue;
      mv.push(tr._movement(i.e, i.forward, o.e, o.forward));
    }
    for (let a = 0; a < mv.length; a++) for (let b = a + 1; b < mv.length; b++) {
      if (tr._conflicts(mv[a], mv[b])) yes++; else no++;
    }
  }
  out.push({ name: 'predicate is not a constant across the district',
    ok: yes > 0 && no > 0, detail: `${yes} conflicting, ${no} free of ${yes + no} pairs` });
  return out;
}

// The Phase 1b name, kept so district/main.js and the harnesses do not have to
// change in the same commit as the behaviour.
export { Traffic as TrafficStub };
