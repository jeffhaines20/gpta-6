// Routing on the road graph: a path between two points that stays on the streets.
//
// WHY THIS EXISTS, with the number that forced it. tools/drive-through.mjs — the budget
// gate — has always driven the district on an autopilot that steers in a STRAIGHT LINE
// at the next route waypoint, and the waypoints are 75 to 512 m apart. Until body
// collision existed that was harmless. Measured against the wall index:
//
//     Bayfront @ Main -> Main @ Pineapple    354 m   40% blocked, 125 m inside a building
//     Main @ Pineapple -> Five Points        162 m   59% blocked,  88 m inside
//     Main St east -> Turn north             187 m   28% blocked,  49 m inside
//     Turn north -> 2nd St westbound         412 m   47% blocked, 170 m inside
//     2nd St westbound -> 2nd @ Cocoanut     384 m   33% blocked, 100 m inside
//     2nd @ Cocoanut -> Back to bayfront     442 m   50% blocked, 212 m inside
//
//     TOTAL   829 m of a 2,528 m course inside a building — 32.8%
//
// The straight-line course drives through a third of the city's building stock. With
// walls solid the autopilot hits one at 89 km/h and 55 degrees of incidence 10.6 s in,
// is wrecked, and the drive's own stuck-nudge then teleports it round the remaining
// route — 23 teleports, one every 2.65 s, because a wrecked car has no engine power.
// That is not a bug in the collision or the damage model; it is a course that was only
// ever viable because there was nothing to hit.
//
//   node tools/roadpath-test.mjs        the gate
//
// THE GRAPH IS THE ONE traffic.js AND pursuit.js ALREADY WALK, and deliberately so: an
// edge's NODES are its two endpoint vertices (`e.v[0]` and `e.v[e.v.length-1]`) and the
// vertices in between are shape points, which is exactly how traffic.js's
// _buildAdjacency treats them. A router that invented its own topology could send a car
// down a street the traffic layer believes is one-way.
//
// One-way is honoured the same way: `e.o >= 0` admits the forward direction and
// `e.o <= 0` the reverse, again copying traffic.js. So a path this returns is a path a
// traffic car could legally take.

/** NaN-safe clamp, as everywhere else in src/. */
const clamp = (v, lo, hi) => (v > lo ? (v > hi ? hi : v) : lo);

/** Narrower than this and there is no second lane to sit in. src/traffic.js's own threshold. */
const TWO_WAY_MIN_W = 3.8;
/** Clearance from the kerb line: the car's 0.95 m body radius plus a quarter metre of slop. */
const LANE_MARGIN_M = 1.2;

/**
 * HOW FAR RIGHT THE ROUTE LINE A PLAYER FOLLOWS SHOULD SIT, and it is neither 0 nor the lane the
 * fleet uses. district/main.js drew the line on the CENTRELINE, which is the one place on a
 * two-way street that meets both directions of traffic: a playtester measured 16 of 30 cars
 * within 0.95 m of the line the game was telling them to follow, with health 1.00 -> 0.46 over
 * 760 m of driving it.
 *
 * Swept over six legs of the district's own route and three fleet arrangements from the seeded
 * stream, following the line at an 11 m/s target with a 30-car fleet:
 *
 *     offset          0.00      0.75      1.50      2.20
 *     shunts/km       3.81      4.69      2.17     18.44
 *     mean health    0.950     0.931     0.965     0.689
 *
 * 1.5 m is the minimum in every one of the three states individually (1.1, 2.5, 2.9 against
 * 2.9, 2.6, 5.9 on the centreline), and the fleet's own lane is eight times worse than that and
 * wrecks the car. The shape is explainable rather than tuned: src/traffic.js puts its cars at
 * 2.05-2.2 m, so a route THERE drives up the queue it is following, while the centreline meets
 * the oncoming stream head-on. 1.5 threads between the two.
 *
 * It is also below `w / 2 - LANE_MARGIN_M` on every two-way road in the district, so the request
 * is honoured as asked rather than capped — which is what makes one constant the right shape for
 * it. `roadpath-test` asserts that.
 */
export const ROUTE_LANE_M = 1.5;

export class RoadGraph {
  /**
   * `blockers` is an optional src/blockers.js index. Given one, edges whose own
   * centreline a car cannot pass are EXCLUDED from the graph, and that is not a
   * refinement — it is what makes a route driveable at all.
   *
   * THE NUMBERS, because they say how small a fix this is and how real the problem was.
   * Sampling every 2 m along every edge with the car's 0.95 m radius:
   *
   *     14 of 935 edges carry any obstruction at all
   *      7 of those have their centreline INSIDE a building footprint
   *     11 are impassable by the test below — 1.2% of the network, 317 m
   *
   * and EVERY ONE is class `service`: 2.8 m alleys and car-park aisles in the OSM
   * extract, several of them drawn straight through a building. The worst, edge 742, is
   * 36 m long with 23 of its 24 samples inside a footprint. Nothing that looks like a
   * street is affected.
   *
   * Before this, the Main St east leg of the route drove into one of them and the car was
   * wrecked at t=78.8 s with no way round: the blocked points were on the planned course.
   * A follower cannot steer out of a road that is inside a building; only the router can.
   */
  constructor(district, opts = {}) {
    this.d = district;
    this.out = new Map();          // vertex -> [{ e, forward, to, len }]
    this._len = new Map();
    this.blocked = new Set();
    const carRadius = opts.carRadius ?? 0.95;
    const sample = opts.sampleEvery ?? 2;
    // Held so the lane offset can be fitted against the same geometry, by the same predicate,
    // that decides whether an edge is driveable at all. See laneOffsets().
    this.blockers = opts.blockers ?? null;
    this.carRadius = carRadius;
    const add = (v, e, forward, to, len) => {
      if (!this.out.has(v)) this.out.set(v, []);
      this.out.get(v).push({ e, forward, to, len });
    };
    let blockedLen = 0;
    district.edges.forEach((e, i) => {
      const a = e.v[0], b = e.v[e.v.length - 1];
      let l = 0;
      for (let k = 0; k < e.v.length - 1; k++) {
        const p = district.verts[e.v[k]], q = district.verts[e.v[k + 1]];
        l += Math.hypot(q.x - p.x, q.z - p.z);
      }
      this._len.set(i, l);
      if (opts.blockers && this._isBlocked(i, opts.blockers, carRadius, sample)) {
        this.blocked.add(i);
        blockedLen += l;
        return;
      }
      if (e.o >= 0) add(a, i, true, b, l);
      if (e.o <= 0) add(b, i, false, a, l);
    });
    /**
     * `isolated` USED TO BE `district.verts.length - this.out.size`, AND IT WAS WRONG BY 115x.
     *
     * The adjacency keys on edge ENDPOINTS, so an intermediate polyline vertex can never appear
     * in it. This district has 2,159 vertices of which only 676 are endpoints, so that
     * subtraction reported 1,496 isolated where the truthful figure is 13 — it counted all 1,483
     * interior points of every road's polyline as cut off. A round reading it would conclude the
     * network is 69% disconnected when 98.5% of it is one component.
     *
     * A playtester's last line before their round died was "routing drove into a wall", and
     * chasing it is what surfaced this. The route itself is clear: over 397 routes and 37,605
     * route points, 4 routes touch a single point where a 0.95 m body circle does not fit, worst
     * correction 0.109 m — well inside the free-contact class this file's crawl floor derives.
     * What was actually wrong was the statistic.
     *
     * `largestComponent` is here because it is the question a router's caller really has: not how
     * many vertices exist but whether you can get from anywhere to anywhere. It is a forward
     * reachability walk over the same directed adjacency `route` uses, so one-way streets count
     * the way the router counts them.
     */
    const endpoints = new Set();
    district.edges.forEach((e) => { endpoints.add(e.v[0]); endpoints.add(e.v[e.v.length - 1]); });
    let largest = 0;
    const seen = new Set();
    for (const v of this.out.keys()) {
      if (seen.has(v)) continue;
      const stack = [v]; seen.add(v); let n = 0;
      while (stack.length) {
        const u = stack.pop(); n++;
        for (const a of this.out.get(u) ?? []) if (!seen.has(a.to)) { seen.add(a.to); stack.push(a.to); }
      }
      if (n > largest) largest = n;
    }
    this.stats = {
      vertices: this.out.size, edges: district.edges.length,
      blockedEdges: this.blocked.size, blockedMetres: +blockedLen.toFixed(0),
      directed: [...this.out.values()].reduce((n, a) => n + a.length, 0),
      endpoints: endpoints.size,
      isolated: endpoints.size - this.out.size,
      largestComponent: largest,
    };
  }

  /**
   * Is edge `i` impassable? Two ways, and both matter:
   *
   *   - any sample INSIDE a footprint — the road is drawn through a building
   *   - a penetration over half the car's radius — the road passes close enough to a
   *     wall that a car on the centreline is half inside it
   *
   * A penetration under that is a road that runs tight to a building, which is what a
   * downtown alley does and is drivable with care. The 0.5 threshold admits the 3 edges
   * whose worst reading is 0.34, 0.11 and 0.10 m (all long streets, 158/151/143 m) and
   * refuses the 11 whose worst is 0.95 m or more.
   */
  /**
   * ONE DEFINITION OF PASSABLE, used for the centreline and for the lane offset alike. A
   * penetration under half the car's radius is a road that runs tight to a building, which is
   * what a downtown alley does and is drivable with care; `insideAny` is not.
   */
  passableAt(x, z, carRadius = this.carRadius) {
    if (!this.blockers) return true;
    if (this.blockers.insideAny(x, z) >= 0) return false;
    const r = this.blockers.resolveCircle(x, z, carRadius);
    return !(r && r.depth > carRadius * 0.5);
  }

  /**
   * STRICTLY CLEAR, which is a different question from passable, and the difference is the whole
   * reason the lane fit uses this one. A centreline is allowed to penetrate a wall by up to half
   * the car's radius because three of this district's long streets do and there is no alternative
   * route — refusing them would disconnect the network. A LANE OFFSET always has an alternative:
   * zero. So a lane is only taken where the body is completely clear, and the 0.475 m of tolerated
   * overlap that keeps a tight street driveable is not extended to a choice nobody has to make.
   */
  clearAt(x, z, carRadius = this.carRadius) {
    return !this.blockers || !this.blockers.resolveCircle(x, z, carRadius);
  }

  _isBlocked(i, blockers, carRadius, sampleEvery) {
    const e = this.d.edges[i];
    for (let k = 0; k < e.v.length - 1; k++) {
      const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.max(1, Math.round(L / sampleEvery));
      for (let s = 0; s <= n; s++) {
        const t = s / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
        if (blockers.insideAny(x, z) >= 0) return true;
        const r = blockers.resolveCircle(x, z, carRadius);
        if (r && r.depth > carRadius * 0.5) return true;
      }
    }
    return false;
  }

  /**
   * The nearest point on any road centreline, and which edge it is on. This is what a
   * caller wants when the subject is a building entrance or a marker dropped in a car
   * park: the nearest NODE can be 200 m away down a long street while the road itself
   * is 8 m off.
   */
  nearestOn(x, z) {
    let best = null, bestD = Infinity;
    for (let i = 0; i < this.d.edges.length; i++) {
      // An excluded edge is not somewhere to start or finish either. Without this a
      // marker dropped beside an alley-through-a-building snaps onto it and the very
      // first leg of the path is inside the building.
      if (this.blocked.has(i)) continue;
      const e = this.d.edges[i];
      for (let k = 0; k < e.v.length - 1; k++) {
        const a = this.d.verts[e.v[k]], b = this.d.verts[e.v[k + 1]];
        const ex = b.x - a.x, ez = b.z - a.z;
        const L2 = ex * ex + ez * ez;
        if (!(L2 > 0)) continue;
        const t = clamp(((x - a.x) * ex + (z - a.z) * ez) / L2, 0, 1);
        const qx = a.x + ex * t, qz = a.z + ez * t;
        const dd = (qx - x) ** 2 + (qz - z) ** 2;
        if (dd < bestD) {
          bestD = dd;
          best = { edge: i, seg: k, t, x: qx, z: qz, dist: Math.sqrt(dd),
            a: e.v[k], b: e.v[k + 1], v0: e.v[0], v1: e.v[e.v.length - 1] };
        }
      }
    }
    return best;
  }

  /**
   * Dijkstra from one node to another, over edge length. Returns the edge sequence, or
   * null when the target is unreachable — which is a real outcome in an OSM extract and
   * has to be reported rather than returned as an empty path that a caller reads as
   * "already there".
   *
   * A binary heap is not worth it at this size: 1,400 nodes and a linear scan for the
   * minimum is measured in the gate at well under a millisecond, and a wrong heap is a
   * class of bug this does not need.
   */
  route(fromVertex, toVertex) {
    if (fromVertex === toVertex) return { edges: [], vertices: [fromVertex], length: 0 };
    const dist = new Map([[fromVertex, 0]]);
    const prev = new Map();
    const done = new Set();
    for (;;) {
      let u = -1, best = Infinity;
      for (const [v, dv] of dist) if (!done.has(v) && dv < best) { best = dv; u = v; }
      if (u === -1) return null;
      if (u === toVertex) break;
      done.add(u);
      for (const link of this.out.get(u) ?? []) {
        const nd = best + link.len;
        if (nd < (dist.get(link.to) ?? Infinity)) {
          dist.set(link.to, nd);
          prev.set(link.to, { from: u, ...link });
        }
      }
    }
    const edges = [], vertices = [toVertex];
    let cur = toVertex;
    while (cur !== fromVertex) {
      const p = prev.get(cur);
      edges.push({ e: p.e, forward: p.forward });
      cur = p.from;
      vertices.push(cur);
    }
    edges.reverse(); vertices.reverse();
    return { edges, vertices, length: dist.get(toVertex) };
  }

  /**
   * The polyline of an edge sequence, in travel order, resampled to `spacing` metres.
   *
   * RESAMPLED, BECAUSE SHAPE POINTS ARE NOT EVENLY SPACED. An OSM way carries a vertex
   * wherever the surveyor put one: this district's road segments run from 0.2 m to over
   * 200 m. A pure-pursuit controller aiming at "the next point" would crawl through the
   * dense stretches and cut the corner off every long one. A fixed spacing makes the
   * look-ahead a distance rather than a vertex count.
   */
  densify(edges, spacing = 5) {
    const pts = [];
    // Each point carries the edge it came from, as a third element, so path() can size
    // the lane offset to that road's own width. A constant 3 m offset put the course
    // 48 of 807 points inside a building, because a `service` road in this district is
    // 2.8 m wide and 3 m right of its centreline is off the tarmac entirely.
    const push = (x, z, e) => {
      const last = pts[pts.length - 1];
      if (!last || Math.hypot(x - last[0], z - last[1]) > 1e-6) pts.push([x, z, e]);
    };
    for (const { e, forward } of edges) {
      const ev = this.d.edges[e].v;
      const order = forward ? ev : [...ev].reverse();
      for (let k = 0; k < order.length - 1; k++) {
        const a = this.d.verts[order[k]], b = this.d.verts[order[k + 1]];
        const L = Math.hypot(b.x - a.x, b.z - a.z);
        const n = Math.max(1, Math.ceil(L / spacing));
        for (let s = 0; s < n; s++) {
          const t = s / n;
          push(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, e);
        }
      }
      const endV = this.d.verts[forward ? ev[ev.length - 1] : ev[0]];
      push(endV.x, endV.z, e);
    }
    return pts;
  }

  /**
   * The whole job in one call: a driveable polyline from (x0,z0) to (x1,z1).
   *
   * `offset` shifts the line to the right-hand lane, because a path down the centreline
   * of a 14 m carriageway is a path down the middle of the oncoming traffic. Applied as
   * a per-point right-hand normal of the local direction rather than by offsetting each
   * edge, which keeps the corners continuous.
   */
  path(x0, z0, x1, z1, { spacing = 5, offset = 0, smoothPasses = 2 } = {}) {
    const a = this.nearestOn(x0, z0), b = this.nearestOn(x1, z1);
    if (!a || !b) return null;
    // From the far end of the start edge toward the target, and into the near end of the
    // destination edge. Four combinations, and the shortest wins — picking the "obvious"
    // endpoint sends a car the wrong way up a street whenever the projection landed past
    // the midpoint.
    /**
     * SCORED BY THE WHOLE DRIVE, NOT BY THE GRAPH ALONE. This compared `r.length` — the Dijkstra
     * cost between two VERTICES — and ignored the lead-in walk from the car's projection to the
     * start vertex and the tail walk from the end vertex to the target's. Each of those is up to
     * a whole edge long, and on a short route the lead-in is most of the distance.
     *
     * Measured on the 38 m drive from the district spawn to Shakedown's own pickup marker: the
     * combination it chose put the start vertex 4 m BEHIND the car, so the path read
     *
     *     (-328,63) (-330,66) (-329,65) (-327,62) (-324,59) ...
     *
     * — out 4 m, back 4 m, then away. `followPath` cannot advance its index past a reversal (it
     * steps forward only past segments the car is beyond in the along-path direction, which is
     * what stops the teleport this file's comment #6 describes), so the index stuck at 0, the
     * steering sat on full lock, and the car drove in circles for the whole 120 s timeout while
     * every number the follower reported looked nominal. Adding the two walks to the score is
     * both more honest and, here, decisive.
     */
    let best = null, bestScore = Infinity;
    const walkLen = (pts) => {
      let L = 0;
      for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      return L;
    };
    for (const from of [a.v0, a.v1]) {
      for (const to of [b.v0, b.v1]) {
        const r = this.route(from, to);
        if (!r) continue;
        const score = r.length + walkLen(this._walkAlong(a, from, spacing))
          + walkLen(this._walkAlong(b, to, spacing, true));
        if (score < bestScore) { bestScore = score; best = r; }
      }
    }
    if (!best) return null;
    /**
     * THE LEAD-IN IS A WALK ALONG THE START EDGE, NOT A JUMP TO IT, and the first draft
     * made it a jump. `nearestOn` projects the caller's position onto the nearest edge at
     * some fraction along it, while `route` can only start from one of that edge's END
     * VERTICES — so densifying the routed edges and then unshifting the projection point
     * inserts a straight segment of up to the whole edge's length between them.
     *
     * Measured: a 75 m gap in this district's tour at index 79. The follower's arc-length
     * look-ahead accumulated one 75 m segment, aimed at the far end of it, read a heading
     * error of 0.00, and drove the car 78 km/h across a city block in a straight line for
     * four seconds — with the controller reporting everything nominal the whole way,
     * because from its point of view it was following the path exactly. `offLine` grew from
     * 25 m to 75 m while `err` stayed at 0.
     *
     * The walk emits the shape points of the start edge between the projection and the
     * chosen vertex, in travel order, so the path is continuous by construction.
     */
    const lead = this._walkAlong(a, best.vertices[0], spacing);
    const tail = this._walkAlong(b, best.vertices[best.vertices.length - 1], spacing, true);
    let pts = [...lead, ...this.densify(best.edges, spacing), ...tail];
    /**
     * THE CAR AND THE TARGET ON THE SAME EDGE IS ITS OWN CASE, and without it the answer is a
     * U-turn. `route` works between end VERTICES, so two points on one street both route to the
     * same vertex for a graph cost of zero — and the path then walks BACK to that vertex and
     * forward again. Measured from the district spawn to Shakedown's pickup, 19 m apart on
     * Marlin Street: out 10.9 m to the shared vertex, back, then away. `followPath` cannot step
     * its index past a reversal, so the car circled at index 0 for the whole 120 s timeout with
     * the steering on full lock and every number it printed reading nominal — the same shape as
     * the eight other follower faults recorded in CLAUDE.md, arriving from the router's side.
     *
     * The direct walk is compared with the routed answer on length and the shorter wins, so a
     * one-way street the target sits the wrong way up still goes round the block.
     */
    const direct = this._walkSameEdge(a, b, spacing);
    if (direct) {
      let dl = 0;
      for (let i = 1; i < direct.length; i++) {
        dl += Math.hypot(direct[i][0] - direct[i - 1][0], direct[i][1] - direct[i - 1][1]);
      }
      let pl = 0;
      for (let i = 1; i < pts.length; i++) {
        pl += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
      }
      if (dl < pl) pts = direct;
    }
    pts = trimSpur(pts);
    // Belt and braces: resample the whole polyline uniformly, so no joining mistake
    // anywhere above can leave a gap a look-ahead could swallow.
    pts = resample(pts, spacing);
    // Round the junctions, then resample again so the spacing survives the smoothing.
    if (smoothPasses > 0) pts = resample(smooth(pts, smoothPasses), spacing);
    if (offset) {
      const amt = laneOffsets(pts, offset, (i) => {
        const ei = pts[i][2];
        return ei >= 0 ? this.d.edges[ei] : null;
      }, (x, z) => this.clearAt(x, z), spacing);
      pts = offsetRight(pts, offset, (i) => amt[i]);
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { points: pts, length: len, graphLength: best.length, edges: best.edges,
      start: a, end: b, endVertex: best.vertices[best.vertices.length - 1] };
  }

  /**
   * The shape points of `proj.edge` between the projection and `vertex`, in travel order.
   * With `reverse`, the walk runs FROM the vertex TO the projection instead, which is what
   * the tail of a path needs.
   */
  /**
   * Both projections on one edge: the points from `a` to `b` straight along it, through whatever
   * shape points lie between, or null when that edge's direction forbids it. See `path` for why.
   */
  _walkSameEdge(a, b, spacing) {
    if (a.edge !== b.edge) return null;
    const e = this.d.edges[a.edge];
    const ev = e.v;
    const pa = a.seg + a.t, pb = b.seg + b.t;
    const forward = pb >= pa;
    // `o` is the same one-way convention the adjacency uses: >= 0 admits v0 -> v1, <= 0 admits
    // v1 -> v0. Driving the wrong way up a one-way street is not a shortcut.
    if (forward ? !(e.o >= 0) : !(e.o <= 0)) return null;
    const seq = [[a.x, a.z]];
    if (forward) for (let k = a.seg + 1; k <= b.seg; k++) seq.push([this.d.verts[ev[k]].x, this.d.verts[ev[k]].z]);
    else for (let k = a.seg; k > b.seg; k--) seq.push([this.d.verts[ev[k]].x, this.d.verts[ev[k]].z]);
    seq.push([b.x, b.z]);
    const out = [];
    for (let k = 0; k < seq.length - 1; k++) {
      const [ax, az] = seq[k], [bx, bz] = seq[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / spacing));
      for (let i = 0; i < n; i++) {
        const t = i / n;
        out.push([ax + (bx - ax) * t, az + (bz - az) * t, a.edge]);
      }
    }
    out.push([b.x, b.z, a.edge]);
    return out;
  }

  _walkAlong(proj, vertex, spacing, reverse = false) {
    const ev = this.d.edges[proj.edge].v;
    const out = [];
    const push = (x, z) => out.push([x, z, proj.edge]);
    // Which way along the edge's vertex list does `vertex` lie?
    const toEnd = vertex === ev[ev.length - 1];
    const idx = [];
    if (toEnd) for (let k = proj.seg + 1; k < ev.length; k++) idx.push(ev[k]);
    else for (let k = proj.seg; k >= 0; k--) idx.push(ev[k]);
    // Resampled from the projection through those shape points.
    let px = proj.x, pz = proj.z;
    const seq = [[px, pz]];
    for (const vi of idx) { const q = this.d.verts[vi]; seq.push([q.x, q.z]); }
    for (let k = 0; k < seq.length - 1; k++) {
      const [ax, az] = seq[k], [bx, bz] = seq[k + 1];
      const L = Math.hypot(bx - ax, bz - az);
      const n = Math.max(1, Math.ceil(L / spacing));
      for (let sI = 0; sI < n; sI++) {
        const t = sI / n;
        push(ax + (bx - ax) * t, az + (bz - az) * t);
      }
    }
    if (reverse) { out.reverse(); out.push([proj.x, proj.z, proj.edge]); }
    return out;
  }

  /**
   * ONE CONTINUOUS PATH through a list of waypoints, which is not the same thing as a list
   * of paths between them, and the difference cost this round an afternoon.
   *
   * Following the legs independently makes every leg boundary a BLIND CORNER. Measured on
   * this district's route: the Five Points -> Main St east leg is 527 m of straight and the
   * follower takes it perfectly, never more than 1.7 m off the line — and finishes it at
   * 59 km/h with its speed controller reading 79 km/h, because the curvature scan had run
   * off the end of the points it had. The next leg turns 90 degrees south immediately. The
   * car arrived at a right-angle junction at 59 km/h with no braking, left the path, ran
   * 109 m past it and hit a building at (678, -183). Three impacts of exactly that shape,
   * at exactly the same three junctions, at every maximum speed from 50 to 79 km/h —
   * speed-independent, because the cause was never the speed.
   *
   * Concatenated, the controller sees through the junction and brakes on the approach,
   * which is what the braking-distance scan was written to do.
   */
  tour(waypoints, opts = {}) {
    const { spacing = 5, offset = 0, smoothPasses = 2 } = opts;
    /**
     * ONE EDGE LIST FOR THE WHOLE ROUTE, densified once.
     *
     * TWO EARLIER VERSIONS OF THIS JOINED PER-LEG POLYLINES AND BOTH BROKE CONTINUITY, in
     * opposite directions, and both were invisible in the route's length.
     *
     * Routing each leg from its own `nearestOn` projection makes the course DOUBLE BACK at
     * every join, because leg N walks up to the waypoint's projection and leg N+1 walks from
     * that projection back to whichever vertex its own Dijkstra chose — often the one leg N
     * just came from. The course read
     *
     *     (18,-12) (21,-9) (21,-8) (17,-8) (20,-11) (23,-14)
     *
     * at the Main St / Pineapple waypoint: forward, back 4 m, forward again. A follower
     * meeting that gets an aim point BEHIND it, and pure pursuit's command is 2*sin(alpha)/d,
     * which is zero at alpha = pi as well as at zero — so the car drove straight on at 1 km/h
     * for four hundred seconds with its heading error reading -3.14 the whole time.
     *
     * Chaining the legs through the graph instead — leg N+1 starting from the vertex leg N
     * ended at — fixed the reversal and opened a 158 m GAP, because the previous leg's points
     * still ended at its projection while the next leg's began at the routing vertex.
     *
     * So there are no legs. The waypoints are snapped, Dijkstra is run between consecutive
     * snapped vertices, the edge sequences are concatenated, and the result is densified,
     * offset and smoothed as a single polyline. Continuity is then a property of the
     * construction rather than something to patch at the seams.
     */
    const snaps = waypoints.map((w) => this.nearestOn(w.x, w.z));
    if (snaps.some((sn) => !sn)) return { points: [], legs: [], length: 0, failed: waypoints.length };
    // The first vertex: whichever end of the first waypoint's edge starts the shortest tour.
    const legs = [];
    let bestStart = null;
    for (const v0 of [snaps[0].v0, snaps[0].v1]) {
      let cur = v0, total = 0, edges = [], marks = [], ok = true;
      for (let i = 1; i <= snaps.length; i++) {
        const target = snaps[i % snaps.length];
        let leg = null;
        for (const to of [target.v0, target.v1]) {
          const r = this.route(cur, to);
          if (r && (!leg || r.length < leg.length)) leg = r;
        }
        if (!leg) { ok = false; break; }
        marks.push({ to: i % snaps.length, edges: leg.edges.length, length: leg.length });
        edges = edges.concat(leg.edges);
        total += leg.length;
        cur = leg.vertices[leg.vertices.length - 1];
      }
      if (ok && (!bestStart || total < bestStart.total)) bestStart = { v0, total, edges, marks, endVertex: cur };
    }
    if (!bestStart) return { points: [], legs: [], length: 0, failed: waypoints.length };
    for (const m of bestStart.marks) legs.push(m);

    /**
     * CLOSED, AND SMOOTHED ACROSS THE SEAM. A tour is a ring: its last waypoint routes back to
     * its first, so the two ends are the same place — measured at 3.05 m apart on this
     * district, which is one resample step.
     *
     * They were not the same DIRECTION, and smooth() pins its endpoints, so the seam was the
     * one corner on the whole course that never got rounded. The car finished a clean lap
     * 0.6 m from where it started with a heading error of 1.59 rad — 91 degrees — had to turn
     * a right angle from a standstill, and clipped the corner 5.6 s later at index 4. Twice,
     * identically, on laps 2 and 3. And because that first impact leaves the car with
     * asymmetric damage and therefore a steering pull, the contact count for the rest of the
     * lap went from 22 to 5,300: one unsmoothed corner, and the whole drive degrades.
     *
     * Closing the ring before smoothing makes the seam an ordinary corner.
     */
    // A RING THROUGHOUT, opened only at the very end. Every step — resample, smooth,
    // resample — treats the seam as one more segment, so it ends up rounded exactly like
    // every other junction instead of being the one corner nothing touched.
    let pts = this.densify(bestStart.edges, spacing);
    pts = resample(pts, spacing, true);
    if (smoothPasses > 0) pts = resample(smooth(pts, smoothPasses, true), spacing, true);
    if (offset) {
      const amt = laneOffsets(pts, offset, (i) => {
        const ei = pts[i][2];
        return ei >= 0 ? this.d.edges[ei] : null;
      }, (x, z) => this.clearAt(x, z), spacing, { closed: true });
      pts = offsetRight(pts, offset, (i) => amt[i], true);
    }
    // Opened: the follower needs a last point to reach, and it is the first one again, so a
    // lap ends exactly where the next one begins and the reset to index 0 is a no-op in space.
    pts.push([pts[0][0], pts[0][1], pts[0][2]]);
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    return { points: pts, legs, length: len, failed: 0, edges: bestStart.edges, closed: true };
  }
}

/**
 * Resample a polyline to a uniform spacing. Guarantees no gap exceeds `spacing`, which is
 * what a look-ahead measured in arc length depends on: one long segment makes the aim
 * point the far end of it and the car drives straight there, off-road, reporting a heading
 * error of zero the whole way.
 */
export function resample(pts, spacing, closed = false) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0].slice()];
  let carry = 0;
  // With `closed`, the segment from the last point back to the first is walked too, and no
  // duplicate endpoint is appended — so the result is a RING of uniformly spaced points.
  // Without it, forcing closure after an open resample leaves a short reverse spur at the
  // seam: measured at a 3.94 m corner radius where the rest of the course was 6.14 m, and
  // the contacts on a lap went from 22 to 158 because of it.
  /**
   * A CLOSED CURVE IS DIVIDED EVENLY, NOT WALKED AT A FIXED STEP. Walking a ring at a fixed
   * spacing leaves a remainder, and the remainder is a spur: the last emitted point lands
   * short of the start and the closing segment runs BACKWARDS to reach it.
   *
   * The first attempt dropped that point when it was within half a spacing of the start —
   * which is a threshold, and thresholds miss. Measured: the point landed 2.10 m from the
   * start against a 2.00 m threshold, so it was kept, and the course ended
   *
   *     (-298.40, 18.00) -> (-293.72, 18.80) -> (-295.80, 19.13)
   *
   * forward 4.74 m, then back 2.10 m. That 2.10 m reversal was the course's tightest corner
   * at 2.43 m of radius, on a course whose next tightest was 6.14, and it is the reason a
   * clean lap still carried 158 contacts.
   *
   * Choosing the number of points from the ring's own length and spacing them exactly
   * length/n apart closes it by construction, with no remainder to dispose of.
   */
  if (closed) {
    let total = 0;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    }
    const count = Math.max(3, Math.round(total / spacing));
    const step = total / count;
    const ring = [];
    let seg = 0, along = 0, acc = 0;
    for (let k = 0; k < count; k++) {
      const want = k * step;
      while (seg < pts.length) {
        const a = pts[seg], b = pts[(seg + 1) % pts.length];
        const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (acc + L >= want - 1e-9 || seg === pts.length - 1) { along = want - acc; break; }
        acc += L; seg++;
      }
      const a = pts[Math.min(seg, pts.length - 1)], b = pts[(Math.min(seg, pts.length - 1) + 1) % pts.length];
      const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      const t = Math.min(1, Math.max(0, along / L));
      ring.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[2]]);
    }
    return ring;
  }
  const n = pts.length - 1;
  for (let i = 0; i < n; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (!(L > 0)) continue;
    let d = spacing - carry;
    while (d < L) {
      const t = d / L;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, b[2]]);
      d += spacing;
    }
    carry = L - (d - spacing);
  }
  const last = pts[pts.length - 1];
  const tail = out[out.length - 1];
  if (Math.hypot(last[0] - tail[0], last[1] - tail[1]) > 1e-6) out.push(last.slice());
  return out;
}

/**
 * Round the corners of a polyline by Chaikin corner-cutting, `passes` times.
 *
 * WHY A PATH OFF A ROAD GRAPH NEEDS THIS. A graph junction is a POINT, so the routed
 * polyline turns 90 degrees at a single vertex. Resampled at 4 m, that reads as a corner of
 * radius 4 / (pi/2) = 2.5 m — tighter than this car's minimum turning radius of 4.3 m at a
 * standstill, let alone in motion. The speed limiter, correctly, then demands 0 km/h at
 * every junction in the district, the car stops, and the drive is carried entirely by the
 * harness's stuck-nudge. The corner is an artefact of representing a junction as a point;
 * a real car takes a rounded line through it.
 *
 * Chaikin replaces each corner with two points at 1/4 and 3/4 of its edges, so each pass
 * roughly doubles the corner radius while leaving straights untouched. It cuts corners
 * INWARD, which is toward the building on the inside of the turn, so the result has to be
 * re-checked against the wall index rather than assumed — tools/route-drive.mjs reports the
 * blocked count for the smoothed path and for the car body along it.
 *
 * Endpoints are pinned, because they are the lead-in and lead-out that _walkAlong went to
 * the trouble of making continuous.
 */
export function smooth(pts, passes = 1, closed = false) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) return cur;
    const out = closed ? [] : [cur[0].slice()];
    const n = closed ? cur.length : cur.length - 1;
    for (let i = 0; i < n; i++) {
      const a = cur[i], b = cur[(i + 1) % cur.length];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2]]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, b[2]]);
    }
    if (!closed) out.push(cur[cur.length - 1].slice());
    cur = out;
  }
  return cur;
}

/**
 * The tightest corner radius anywhere on a polyline, over a three-point window. The
 * instrument for the paragraph above: a path whose minimum is under the car's turning
 * radius has a corner the car cannot take at any speed.
 */
export function minRadius(pts, minArc = ARC_WINDOW) {
  let worst = Infinity, at = -1;
  for (let k = 0; k < pts.length - 2; k++) {
    const w = windowTurn(pts, k, minArc);
    if (!w || w.turn < 1e-4) continue;
    const r = w.arc / w.turn;
    if (r < worst) { worst = r; at = k; }
  }
  return { radius: worst, at };
}

/** The longest gap between consecutive points. The instrument for the bug above. */
export function worstGap(pts) {
  let worst = 0, at = -1;
  for (let i = 1; i < pts.length; i++) {
    const g = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (g > worst) { worst = g; at = i; }
  }
  return { gap: worst, at };
}

/**
 * Shift a polyline to its own right-hand side. `d` is metres, or a function of the point
 * index returning metres — which is what lets the offset respect each road's own width.
 */
/**
 * How far right of the centreline a route may sit on one edge, from the road's nominal width.
 *
 * `e.w` IS THE WHOLE CARRIAGEWAY, NOT ONE LANE, and the first version of this multiplied it by
 * `e.lanes` — so on Main Street (`w: 6.6, lanes: 2`) it believed the road was 13.2 m wide and
 * let a 3 m offset through unchanged. 3 m plus the car's 0.95 m radius reaches 3.95 m from the
 * centre of a road whose kerb is at 3.3. src/traffic.js reads the same field as a total
 * (`e.w / 2 - CAR_HALF_W`), and that is the reading the drawn road agrees with.
 *
 * SINGLE-TRACKING A NARROW EDGE IS THE SAME RULE src/traffic.js APPLIES, for the same reason:
 * 353 of this district's 935 edges are 2.8 m service alleys, where there is no second lane to
 * move into and the centreline is the only line that fits.
 */
export function laneOffsetFor(e, offset) {
  if (!e || !(offset > 0)) return 0;
  if (e.w < TWO_WAY_MIN_W) return 0;                       // single track: down the middle
  return Math.min(offset, Math.max(0, e.w / 2 - LANE_MARGIN_M));
}

/**
 * The per-point right-hand offset for a route: what the road's width allows, reduced to what is
 * actually CLEAR, with the rate of change bounded.
 *
 * THE NOMINAL WIDTH IS NOT ENOUGH, AND THIS DISTRICT PROVES IT BY 0.45 m. Two playtesters had
 * the game's own follower wreck the car on the game's own route at (-189.8, -95), one of them in
 * 5 of 6 starting headings. Sweeping the actual clearance along that stretch of Main Street —
 * edge 303, `w: 6.6`, so a nominal kerb at 3.30 m:
 *
 *     i=76   wall 3.10 m right of centre        i=82   wall 2.90 m
 *     i=78   wall 3.05 m                        i=84   wall 2.85 m
 *     i=80   wall 2.95 m                        i=86   wall 4.25 m (clear)
 *
 * The footprint encroaches 0.20-0.45 m into the drawn carriageway, so the widest lane the width
 * rule can justify (2.10 m, plus a 0.95 m body, reaching 3.05) still clips it. No width policy
 * fixes that; only measuring does. The same census over the whole network, counting edges whose
 * CENTRELINE is clear while a ±offset lane is not:
 *
 *     offset 3, no cap at all             103 of 935 edges   6,734 m
 *     offset 3, w * lanes / 2 - 1.2        21                1,943 m
 *     offset 3, w / 2 - 1.2                13                1,309 m
 *     offset 3, and single-track < 3.8 m    8                  760 m
 *     offset 3, and fitted against the blockers   0               0 m
 *
 * The 103 is worth keeping because a reviewer's census quoted it as the live figure: it is the
 * UNCAPPED number, and the cap that already existed removed four fifths of it. The defect was
 * real and one fifth the size claimed.
 *
 * THE FIT TAKES THE LONGEST CLEAR RUNG, and the check that it means anything is that the rung
 * above the one chosen is genuinely blocked — the lesson src/traffic.js's shunt fit wrote down,
 * where two counts that closed over the same predicate validated nothing.
 *
 * AND A STEP IN THE OFFSET IS A KINK IN THE PATH. Dropping from 2.1 m to 0 between two points
 * 4 m apart is a 27-degree corner that the follower's look-ahead reads as a real turn. The slope
 * limiter bounds it to `maxSlope` (0.25, about 14 degrees at a 4 m spacing) by two sweeps that
 * can only ever REDUCE an amount, so every point the fit cleared stays clear — which is what
 * makes it safe to apply after the fit rather than before.
 */
export function laneOffsets(pts, offset, edgeOf, clearAt, spacing, opts = {}) {
  const { maxSlope = 0.25, closed = false, rungs = [1, 0.75, 0.5, 0.25] } = opts;
  const n = pts.length;
  const amt = new Array(n).fill(0);
  let fitted = 0, dropped = 0;
  for (let i = 0; i < n; i++) {
    const want = laneOffsetFor(edgeOf(i), offset);
    amt[i] = want;
    if (!(want > 0) || !clearAt) continue;
    // The same wrapped tangent offsetRight uses, for the same reason: on a ring the seam's
    // neighbours are each other, and a one-sided difference there fits the offset to the wrong
    // direction.
    const a = pts[closed ? (i - 1 + n) % n : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n : Math.min(n - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1], L = Math.hypot(dx, dz);
    if (!(L > 0)) continue;
    const nx = dz / L, nz = -dx / L;
    if (clearAt(pts[i][0] + nx * want, pts[i][1] + nz * want)) continue;
    let chosen = 0;
    for (const f of rungs) {
      const t = want * f;
      if (clearAt(pts[i][0] + nx * t, pts[i][1] + nz * t)) { chosen = t; break; }
    }
    amt[i] = chosen;
    fitted++;
    if (chosen === 0) dropped++;
  }
  /**
   * AND ON A RING THE SEAM IS THE PAIR THE SWEEP NEVER VISITS. The first version ran the two
   * sweeps over indices 1..n-1 and n-2..0, which touches every adjacent pair EXCEPT (n-1, 0) —
   * so a closed tour could carry a full step across its own seam. route-drive's heading across
   * the seam went from 14.0 to 40.3 degrees and failed the gate that exists for exactly this,
   * which is the third time in this file a ring's seam has been the one corner nothing smoothed.
   * The wrap pair is now swept explicitly, twice, so the constraint propagates through it.
   */
  const maxStep = spacing * maxSlope;
  const limit = (i, j) => { amt[i] = Math.min(amt[i], amt[j] + maxStep); };
  for (let p = 0; p < (closed ? 2 : 1); p++) {
    for (let k = 1; k < n; k++) limit(k, k - 1);
    if (closed) limit(0, n - 1);
    for (let k = n - 2; k >= 0; k--) limit(k, k + 1);
    if (closed) limit(n - 1, 0);
  }
  amt.fitted = fitted;
  amt.dropped = dropped;
  return amt;
}

/**
 * AND ON A CLOSED RING THE NEIGHBOURS WRAP. Clamping to [0, n-1] gives the first and last points
 * a ONE-SIDED tangent — a forward difference at index 0 and a backward difference at n-1 — so on
 * a ring whose seam lands on a junction those two points are pushed in a direction rotated by
 * that junction's whole turn. Measured on the 3.3 km tour, `heading across the seam`, which is
 * route-drive's own metric:
 *
 *     offset   0 m    67.4 deg      (no offset applied at all: the ring's own junction)
 *     offset   1 m    67.9
 *     offset   2 m    53.6
 *     offset   3 m    14.0          <- the one value the gate runs at
 *     offset   6 m   -67.5
 *
 * The gate asserts |seam| < 0.5 rad and had been passing on that single coincidence since the
 * tour existed. With wrapped neighbours the two end points are offset along the same tangent as
 * their neighbours and the seam reads the ring's own corner at every offset.
 */
/**
 * Remove an out-and-back spur from either end of an open path.
 *
 * WHY THIS IS NEEDED EVEN WITH THE SCORING FIXED. `route` can only start from an end VERTEX of
 * the car's edge, while `nearestOn` projects onto that edge wherever the car happens to be — so
 * when both end vertices route to the target at a similar cost, the cheaper one can still be
 * behind the car, and the path then opens with a short reversal. A reversal anywhere is a wall
 * for `followPath`, whose index cannot step past a segment it is not beyond, and at the HEAD of
 * the path there is no momentum to carry it through: the car circles at index 0 for ever.
 *
 * The test is the angle between the first segment and the next: over 120 degrees is not a corner
 * a car takes, it is a direction reversal, so the first point is dropped and the test repeated.
 * Bounded at a quarter of the points so a pathological path cannot be trimmed to nothing, and
 * applied at both ends because the tail walk has the same shape from the other side.
 */
export function trimSpur(pts, maxTurn = 2.09) {
  if (pts.length < 4) return pts;
  const out = pts.slice();
  const limit = Math.max(1, Math.floor(pts.length / 4));
  const turn = (a, b, c) => {
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]), h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let d = h2 - h1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return Math.abs(d);
  };
  let cut = 0;
  while (out.length > 3 && cut < limit && turn(out[0], out[1], out[2]) > maxTurn) { out.shift(); cut++; }
  cut = 0;
  while (out.length > 3 && cut < limit
    && turn(out[out.length - 3], out[out.length - 2], out[out.length - 1]) > maxTurn) {
    out.pop(); cut++;
  }
  return out;
}

export function offsetRight(pts, d, perPoint = null, closed = false) {
  const out = [];
  const n0 = pts.length;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const amt = perPoint ? perPoint(i) : d;
    const a = pts[closed ? (i - 1 + n0) % n0 : Math.max(0, i - 1)];
    const b = pts[closed ? (i + 1) % n0 : Math.min(n0 - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (!(L > 0)) { out.push([p[0], p[1], p[2]]); continue; }
    // Right of a heading (dx, dz) in this coordinate frame, where +x is right of +z.
    out.push([p[0] + (dz / L) * amt, p[1] - (dx / L) * amt, p[2]]);
  }
  return out;
}

/**
 * THE CAR'S CORNERING ENVELOPE, MEASURED RATHER THAN DERIVED — and the first version of this
 * was derived, was wrong by 1.75x, and is why the follower could not hold a line.
 *
 * WHAT THE DERIVED VERSION SAID. It took `grip = 1.15` and `gravity = 19.6` straight out of
 * src/vehicle.js's friction circle for a lateral ceiling of 22.54 m/s2, and Ackermann bicycle
 * geometry — `R = wheelbase / tan(steer)` — for a minimum turning radius of 4.3 m at rest.
 * Both are properties of a model the car is not. Measured on flat ground by holding a steer
 * input and a speed until the radius settles:
 *
 *                        derived      measured
 *     lateral ceiling    22.54        16.2 m/s2
 *     R_min at 50 km/h    6.2         12.4 m
 *     R_min at full lock  4.3         10.6 m at 20 km/h, and it GROWS with speed
 *     braking            12.40        11.0 m/s2
 *
 * The lateral figure was masked: a safety factor of 0.55 on 22.54 gives 12.40, which happens
 * to sit just under the real 16.2, so the SPEED ceilings came out roughly right by accident.
 * The steering figure was not masked at all, and it is the one that mattered — the controller
 * asked for 0.37 of lock where the car needed 0.64, and drifted 8 m wide of a 38 m bend at
 * 78 km/h while its own numbers read nominal.
 *
 * THE RESPONSE IS EXACTLY LINEAR, WHICH IS WHAT MAKES THIS A MODEL AND NOT A TABLE. Radius
 * times steer input is constant at a given speed — to within 2% across inputs from 0.1 to
 * 0.4 — so that constant IS the radius at full lock, and it is linear in speed:
 *
 *     R_min(v) = 8.446 + 0.2826 * v        metres, v in m/s
 *
 * fitting the measurement to 0.1% at every speed from 20 to 80 km/h. So the steer input for
 * a wanted radius is the exact inversion of the car's own steady-state response:
 *
 *     steer = R_min(v) / R
 *
 * which is 1 exactly when R is the tightest the car can hold, and the whole understeer factor
 * comes out in the wash instead of needing a fudge.
 *
 * tools/roadpath-test.mjs re-measures all four numbers against src/vehicle.js and fails if
 * the car changes under them, which is the only thing that keeps a measured model honest.
 */
export const RESPONSE = Object.freeze({
  rMin0: 8.446,        // m — R_min at a standstill (fit intercept)
  rMinPerV: 0.2826,    // m per m/s — how much the minimum radius grows with speed
  latMax: 16.2,        // m/s2 — sustainable lateral acceleration
  brake: 11.0,         // m/s2 — measured full-brake deceleration, 10.5 to 11.6 over the range
  accel: 3.3,          // m/s2 — measured at the top of the range, 4.6 at the bottom
  /**
   * Margins. The grip figure is what the car can just hold, so a follower running at it has
   * nothing left to correct with; 0.8 leaves a fifth in hand. The steering figure is a
   * geometric limit rather than a friction one, so the margin is taken as lock in reserve:
   * 0.85 means never asking for more than 85% of available lock in steady state.
   */
  gripSafety: 0.8,
  steerReserve: 0.85,
});

/** The tightest radius the car can hold at speed `v`. Measured; see RESPONSE. */
export function minTurnRadius(v) {
  return RESPONSE.rMin0 + RESPONSE.rMinPerV * Math.max(0, v);
}

/**
 * The steer INPUT that produces radius `R` at speed `v`. The exact inversion of the measured
 * steady-state response, so 1.0 is full lock and anything over 1 is a radius the car cannot
 * hold at this speed.
 */
export function steerForRadius(v, R) {
  return minTurnRadius(v) / Math.max(Math.abs(R), 1e-3);
}

/** The fastest a radius can be taken before the steering runs out of lock. */
export function steerableSpeed(radius) {
  return Math.max(0, (radius * RESPONSE.steerReserve - RESPONSE.rMin0) / RESPONSE.rMinPerV);
}

/** The fastest a radius can be taken before the tyres run out of grip. */
export function gripSpeed(radius) {
  return Math.sqrt(RESPONSE.latMax * RESPONSE.gripSafety * Math.max(radius, 0));
}

/**
 * The corner speed for a radius: the lower of the two ceilings.
 *
 * Steering binds below about 13 m of radius and grip above it, which the measurement bears
 * out — at 50 km/h the car needs full lock for 13.1 m, and at 80 km/h it runs out of grip at
 * 30.4 m long before it runs out of lock.
 */
export function cornerSpeed(radius) {
  /**
   * FLOORED AT A CRAWL, and the floor is not a fudge. A radius under the car's standstill
   * minimum of 8.45 m cannot be followed at any speed, so both ceilings return 0 — and a
   * target of 0 means the car stops dead and never reaches the corner at all, which is worse
   * than cutting it. 116 of this district's 851 course points are under 12 m of radius,
   * because a graph junction is a point and a right-angle turn across it reads as 2 m.
   *
   * A real driver in an alley too tight for the turning circle does not stop; they creep
   * round and clip the kerb. 2.2 m/s is 8 km/h, which is the FMVSS bumper threshold in
   * src/damage.js — so a contact taken at the floor speed is, by construction, free.
   */
  return Math.max(2.2, Math.min(gripSpeed(radius), steerableSpeed(radius)));
}

/**
 * The turn and the arc over a window of at least `minArc` metres forward of `from`.
 * Returns null past the end.
 *
 * MEASURED OVER A FIXED ARC LENGTH, NOT OVER THREE POINTS, and this is the whole reason the
 * corner smoothing appeared to do nothing. A resampled polyline carries short segments at
 * its joins — the final point of a resample pass sits wherever the source ended, which can
 * be centimetres from the one before it. A three-point window landing on one of those reads
 * arc 1.4 m over a turn of 1.5 rad and reports a corner of radius 0.45 m: a corner that is
 * not there. `minRadius` reported 0.45 m at every smoothing level from 0 to 4 passes, which
 * is the tell — smoothing cannot fail to round a real corner.
 *
 * The consequence in pathSpeedLimit was worse than a wrong number, because the wrong number
 * was ACTIONABLE: a 0.45 m radius is not steerable at any speed, so the limiter demanded
 * 0 km/h, the car stopped, and the drive was carried by 136 stuck-nudges.
 */
function windowTurn(points, from, minArc) {
  if (from >= points.length - 2) return null;
  const a = points[from], b = points[from + 1];
  let h0 = Math.atan2(b[0] - a[0], b[1] - a[1]);
  let arc = Math.hypot(b[0] - a[0], b[1] - a[1]);
  let k = from + 1;
  // AT LEAST TWO SEGMENTS, ALWAYS. If the first segment alone exceeds minArc the loop below
  // never runs, the end heading is read off the same segment as the start heading, and the
  // turn is exactly zero — so a polyline whose segments are longer than the window reads as
  // dead straight however sharply it corners. Found by this module's own gate, on a 10 m
  // square: minRadius returned Infinity for a shape made entirely of right angles.
  while (k < points.length - 1 && (arc < minArc || k === from + 1)) {
    const p = points[k], q = points[k + 1];
    arc += Math.hypot(q[0] - p[0], q[1] - p[1]);
    k++;
  }
  if (k >= points.length - 1 && arc < minArc * 0.5) return null;
  const p = points[k - 1], q = points[k];
  const h1 = Math.atan2(q[0] - p[0], q[1] - p[1]);
  let turn = h1 - h0;
  while (turn > Math.PI) turn -= Math.PI * 2;
  while (turn < -Math.PI) turn += Math.PI * 2;
  return { turn: Math.abs(turn), arc, to: k };
}

/** The arc window every curvature reading in this module uses, in metres. */
export const ARC_WINDOW = 10;

/**
 * The fastest this path can be taken from `from`, looking far enough ahead to stop.
 *
 * The scan distance is the braking distance at the current speed, floored at 25 m: there
 * is no point reading curvature the car could not react to, and no point reading less
 * than it needs.
 */
export function pathSpeedLimit(points, from, speed, maxSpeed) {
  const a = RESPONSE.brake;
  // Scanned from maxSpeed, not from the CURRENT speed. A scan whose length depends on how
  // fast the car is going right now is a feedback loop: slowing shortens the scan, the corner
  // leaves it, the target jumps back up, the car accelerates, the corner reappears. The
  // throttle then chatters 0 -> 1 -> 0.66 -> 0.81 -> 0 through every bend.
  const scan = Math.max(25, (maxSpeed * maxSpeed) / (2 * a));
  let limit = maxSpeed;
  let d = 0;
  for (let k = from; k < points.length - 2 && d < scan; k++) {
    const w = windowTurn(points, k, ARC_WINDOW);
    if (w) {
      if (w.turn > 1e-3) {
        const radius = w.arc / w.turn;
        const vCorner = cornerSpeed(radius);
        // The speed we may hold NOW is the corner speed plus whatever the brakes can shed
        // between here and there.
        const allowed = Math.sqrt(vCorner * vCorner + 2 * a * d);
        if (allowed < limit) limit = allowed;
      }
    }
    const p = points[k], q = points[k + 1];
    d += Math.hypot(q[0] - p[0], q[1] - p[1]);
  }
  return limit;
}

/**
 * Pure-pursuit steering along a polyline, with a speed controller.
 *
 * LOOK-AHEAD SCALES WITH SPEED, because a fixed one cannot do both jobs: short enough to
 * take a junction at 20 km/h is short enough to weave at 90, and long enough to be smooth
 * at 90 cuts the corner off every junction.
 *
 * `maxSpeed` defaults to 22 m/s — 79 km/h. This is a downtown grid with junctions every
 * 80 m, and the uncapped car reaches 119 km/h on Main Street, which is not a drive any
 * measurement of this district should be made from.
 */
/** Past this much heading error an unreachable aim is behind the car, not round a corner. */
const REVERSE_ERR = 1.75;                 // 100 degrees
/** Enough to back out of a kerbside standstill and no more. */
const REVERSE_THROTTLE = 0.35;

/**
 * AN ELEVENTH WAY TO REPORT EVERYTHING NOMINAL WHILE GETTING NOWHERE: THE AIM IS REACHABLE, THE
 * ROUTE IS CLEAR, AND THERE IS A BUILDING IN BETWEEN.
 *
 * The tenth, below, is an aim point the car cannot turn tightly enough to reach, and it is
 * detected purely geometrically. This one is not geometric at all: every number the follower
 * computes is correct. The aim is a clear point on a clear route, the heading error is modest,
 * `reqRadius` is comfortably larger than the car's minimum so the reverse manoeuvre does not fire,
 * and the car is physically pinned.
 *
 * Found by a round-5 playtester, who reported a 400-second stall: `state.i` stuck at 0 of a clean
 * 41-point route, the car at one spot +/- 0.3 m, throttle commanded every frame, and 37,018
 * contacts at about 97 a second. THEIR EXACT SETUP DID NOT REPRODUCE — planning the same route at
 * 0, 20 and 40 km/h and following it at control rates from 1/30 s to 1 s, the follower reaches the
 * marina every time in 38.7 to 46 s with 0 contacts and health 1.0000 — so something about their
 * start position differed and their route was 41 points against my 45. The BEHAVIOUR is exactly
 * real, and constructing the pose deliberately shows it: nose against a wall with a 26-point route
 * alongside it and 0 of those points blocked, 400 s gives `i` stuck at 5/26, 9.64 m of movement,
 * 35,903 contacts at 90 a second, mean throttle 0.67, and the geometric reverse firing on 4 frames
 * out of 400.
 *
 * SPEED IS THE WRONG TEST and that was measured too. A car jittering against a wall is not
 * stationary: the same arm reads up to 4.8 km/h, so `speed < 0.5` would miss it. What is
 * unarguable is PROGRESS — the car has not gone anywhere — so the detector anchors a position and
 * asks whether the car has left it.
 *
 * `STUCK_M` is one body length, `2 * HALF_EXTENT.z` from src/damage.js, which is the distance below
 * which "the car has not moved" needs no argument. `STUCK_S` has to be longer than HONEST
 * acceleration or the follower would back out of every standing start: measured from rest at the
 * follower's own lowest commanded throttle (its floor is `clamp(-over/4 + 0.2, 0, 1)`, so 0.20) and
 * at the damage model's engine-power floor of 0.25, the car takes **6.30 s** to travel one body
 * length. 1.5x that is the timeout, and `roadpath-test` asserts the relation rather than the
 * number. The window costs nothing: 35,903 contacts over 400 s took 0.0232 of health, so the ~850
 * contacts inside one window take about 0.0005.
 */
const STUCK_M = 4.30;                     // 2 * HALF_EXTENT.z from src/damage.js
const STUCK_S = 9.5;                      // 1.5x the measured 6.30 s worst honest case

export function followPath(points, { x, z, yaw, speed }, state = { i: 0 }, opts = {}) {
  const maxSpeed = opts.maxSpeed ?? 22;
  const lookAhead = clamp(6 + speed * 0.9, 8, 28);

  /**
   * PROGRESS IS THE CLOSEST POINT AHEAD, NOT A PROXIMITY TEST, and the aim is measured in
   * ARC LENGTH ALONG THE PATH, not as a radius. Both of those are the textbook pure-pursuit
   * formulation and both were wrong in the first draft, in the same way and with the same
   * consequence.
   *
   * The first draft advanced `i` only while the car came within 0.6 of the look-ahead of
   * `points[i]`, and then aimed at the first point whose RADIAL distance was at least the
   * look-ahead. Cutting a corner leaves the car more than that from the point it just
   * passed, so `i` stops advancing; and once the car is far enough from that same stuck
   * point, the radial test selects it — a point BEHIND the car — as the aim.
   *
   * Traced at the Main St east / Turn north junction: the controller brakes correctly from
   * 78 to 24 km/h, takes the corner, and at t=73.67 s is at (669, -174) aiming at
   * (671, -189), which is right. One second later `i` is still 311, the car is at
   * (670, -176), and the aim has jumped to (675, -165) — 11 m BEHIND it — with a heading
   * error of -2.29 rad. It turned round, ran 109 m back up the street and hit a building
   * at (678, -183). Three impacts of that exact shape, at three junctions, unchanged at
   * every maximum speed from 50 to 79 km/h.
   *
   * The closest-point search is forward-only and windowed, so it is monotonic — progress
   * can never go backwards — and arc length cannot select a point behind the index it
   * starts from.
   */
  /**
   * PROGRESS IS A LOCAL PROJECTION, NOT THE CLOSEST POINT IN A WINDOW. The second draft
   * searched an 80-point window forward for the globally nearest point, which is monotonic
   * and still teleports: wherever the route passes near itself, a point 180 m further on can
   * be nearer than the one the car is actually on.
   *
   * Traced on 2nd Street westbound. At t=133.5 s the car is at (-135.2, -383.8) doing
   * 77 km/h with i=615, off-line 1.17 m, heading error -0.04 rad — nominal. One quarter of a
   * second later i is 661, forty-six points and 184 m further on, because that part of the
   * route runs 0.63 m from where the car is and the window found it. The heading error goes
   * to +1.543 rad — 88 degrees — at 77 km/h, and the car leaves the line by 22.4 m.
   *
   * Advancing by PROJECTION cannot do that: step forward only past segments the car is
   * already beyond in the along-path direction, and stop at the first segment its projection
   * falls inside. Local, monotonic, and indifferent to what the rest of the path is doing.
   */
  let i = state.i;
  let frac = 0;
  for (let n = 0; n < 400 && i < points.length - 2; n++) {
    const a = points[i], b = points[i + 1];
    const ex = b[0] - a[0], ez = b[1] - a[1];
    const L2 = ex * ex + ez * ez;
    const t = L2 > 0 ? ((x - a[0]) * ex + (z - a[1]) * ez) / L2 : 1;
    if (t < 1) { frac = t > 0 ? t : 0; break; }
    i++;
  }
  // Cross-track error, from the projection rather than from the nearest vertex.
  const pa = points[i], pb = points[Math.min(i + 1, points.length - 1)];
  const projX = pa[0] + (pb[0] - pa[0]) * frac, projZ = pa[1] + (pb[1] - pa[1]) * frac;
  const offLine = Math.hypot(x - projX, z - projZ);

  // The aim point: `lookAhead` metres of ARC from the projection, not from points[i], so the
  // look-ahead does not shorten and lengthen by up to one segment as the car crosses each.
  let acc = -frac * Math.hypot(pb[0] - pa[0], pb[1] - pa[1]);
  let j = i;
  for (; j < points.length - 1; j++) {
    acc += Math.hypot(points[j + 1][0] - points[j][0], points[j + 1][1] - points[j][1]);
    if (acc >= lookAhead) break;
  }
  const aim = points[Math.min(j + 1, points.length - 1)];
  const dx = aim[0] - x, dz = aim[1] - z;
  let err = Math.atan2(dx, dz) - yaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;

  /**
   * PURE PURSUIT FOR THE GEOMETRY, THE MEASURED RESPONSE FOR THE ACTUATOR.
   *
   * The arc through the car's current position to the aim point, at distance d and subtending
   * alpha, has curvature 2*sin(alpha)/d — so the radius the car must hold is d/(2 sin alpha).
   * That much is geometry and every version of this got it right. What to DO with it is the
   * part that was wrong twice: first a flat gain of 1.8 on the heading error, then Ackermann
   * bicycle geometry, and the car is neither. steerForRadius() inverts the response that was
   * actually measured, so the input is right at every speed without a correction factor.
   *
   * An input over 1 means the radius is beyond the car at this speed. It clamps, and the
   * speed ceiling is what stops the situation arising.
   */
  const aimDist = Math.max(Math.hypot(dx, dz), 1e-3);
  /**
   * THE SINE IS CAPPED AT A QUARTER TURN, because 2*sin(alpha)/d is zero at alpha = pi as
   * well as at alpha = 0 and pure pursuit cannot tell "pointing at it" from "pointing exactly
   * away from it". A course that doubled back put the aim point 180 degrees behind the car,
   * the steering command came out at -0.03, and the car drove away in a straight line at
   * 1 km/h for four hundred seconds with its own heading error reading -3.14 the whole time.
   *
   * Past a quarter turn there is nothing to compute: the tightest turn available is the right
   * answer, and the cap delivers it continuously rather than as a special case.
   */
  const a90 = Math.min(Math.abs(err), Math.PI / 2);
  const sinA = Math.sin(a90);
  const reqRadius = sinA > 1e-6 ? aimDist / (2 * sinA) : Infinity;
  let steer = clamp(Math.sign(err) * steerForRadius(speed, reqRadius), -1, 1);

  /**
   * Speed. `pathSpeedLimit` already folds the braking distance in, so its answer is the speed
   * the car should be at NOW, and a proportional controller on the error is enough. The
   * deadband is what stops the throttle and the brake trading places every other frame.
   *
   * THE TURN THE CAR IS ALREADY IN IS ALSO A CEILING, and leaving it out was the last thing
   * wrong with this controller. `pathSpeedLimit` looks FORWARD from the progress index, which
   * is right for anticipating a corner and blind to the one being negotiated: once the apex is
   * behind the index the scan sees the straight beyond it and the target jumps.
   *
   * Traced at a 7.5 m junction: the car crawls in at 9 km/h with the target at 8 and full
   * lock, and one step later the target reads 54, then 79. It floors the throttle while still
   * at full lock, accelerates 9 -> 39.5 km/h in two and a half seconds, runs 7.6 m wide and
   * hits the building on the outside of the turn — the single impact that wrecked the car on
   * an otherwise clean lap.
   *
   * A car at full lock has no grip left to accelerate with, and `reqRadius` is exactly the
   * radius the steering is being asked to hold, so cornerSpeed() of it is the ceiling. It
   * lifts by itself as the car straightens.
   */
  const target = Math.min(maxSpeed, pathSpeedLimit(points, i, speed, maxSpeed),
    cornerSpeed(reqRadius));
  const over = speed - target;
  let throttle = 0, brake = 0;
  if (over > 0.3) brake = clamp(over / 3, 0.15, 1);
  else throttle = clamp(-over / 4 + 0.2, 0, 1);

  /**
   * A TENTH WAY TO REPORT EVERYTHING NOMINAL WHILE GETTING NOWHERE: THE CAR CANNOT TURN INSIDE
   * ITS OWN TURNING CIRCLE, AND FULL LOCK IS NOT THE ANSWER — REVERSE IS.
   *
   * The nine faults recorded in CLAUDE.md are all about choosing the wrong aim point. This one
   * is about an aim point that is correct and unreachable. `steerForRadius` clamps at 1 when the
   * wanted radius is under the car's minimum, which is right on a tight corner — you run a
   * little wide, the index advances, the drive continues. It is not right when the aim point is
   * BEHIND the car: there the car orbits at full lock around a circle that never contains the
   * point, the progress index cannot advance because the car is never beyond segment `i` in the
   * along-path direction, and every number the follower reports is correct.
   *
   * Traced twice, both times a `driveTo` from a standstill with the path leading off behind:
   *
   *     spawn -> Shakedown's pickup, 30 m    i stuck at 0 for the whole 120 s timeout,
   *                                          steer +1.00, speed 9 km/h, orbit radius 9.15 m
   *     stage b's marker -> the marina       i stuck at 0 at t=6.0 s, steer -1.00, 337 m of
   *                                          path never entered, health 1.00 throughout
   *
   * `route-drive` and `drive-through` never met it because both point the car along the path
   * before they start. A player never meets it because a player reverses.
   *
   * THE CONDITION IS GEOMETRIC AND NEEDS NO STATE: the aim is unreachable when the arc it asks
   * for is tighter than the car can hold AND it is more than `REVERSE_ERR` off the nose. Under
   * that, reverse with the steering mirrored, which swings the nose toward the aim — a
   * three-point turn — and the condition clears itself as the heading comes round, so there is
   * no latch to get stuck in and no dt to thread through. A gentle reverse, because this is a
   * manoeuvre and not a getaway.
   */
  const reversing = Math.abs(err) > REVERSE_ERR && reqRadius < minTurnRadius(speed) * 0.95;
  if (reversing) { steer = -steer; throttle = -REVERSE_THROTTLE; brake = 0; }

  /**
   * THE PROGRESS ANCHOR. See STUCK_M / STUCK_S above for what this is and why speed is the wrong
   * test. `dt` has to come from the caller: this is a time-based detector and the project's rule
   * is that behaviour must not be a function of frame rate, so counting frames is not an option.
   * Without it the detector is INERT AND SAYS SO — `stuckFor: null` rather than 0 — because a
   * system that is silently never switched on is this project's most repeated defect.
   */
  const dt = opts.dt ?? 0;
  let wedged = false;
  if (dt > 0) {
    if (state.anchorX === undefined) { state.anchorX = x; state.anchorZ = z; state.anchorFor = 0; }
    const gone = Math.hypot(x - state.anchorX, z - state.anchorZ);
    if (gone > STUCK_M) {
      // Real progress: move the anchor up and forget everything.
      state.anchorX = x; state.anchorZ = z; state.anchorFor = 0;
      state.backing = false; state.backFor = 0;
    } else if (state.backing) {
      /**
       * BACKING IS LATCHED UNTIL THE CAR HAS ACTUALLY MOVED, and the reason is the guard above it:
       * while backing, the commanded throttle is negative, so a detector conditioned on "drive is
       * commanded" clears itself and the reverse lasts exactly one frame. The latch clears on the
       * `gone > STUCK_M` branch, which is the same test that armed it — so it cannot stick.
       */
      state.backFor = (state.backFor ?? 0) + dt;
      steer = -steer; throttle = -REVERSE_THROTTLE; brake = 0;
      // Pinned at both ends. Say so rather than backing into the same wall for ever: the caller
      // can stop and report, which is what `driveTo` does with it.
      if (state.backFor > STUCK_S) wedged = true;
    } else if (throttle > 0 || reversing) {
      state.anchorFor = (state.anchorFor ?? 0) + dt;
      if (state.anchorFor > STUCK_S) {
        state.backing = true; state.backFor = 0;
        steer = -steer; throttle = -REVERSE_THROTTLE; brake = 0;
      }
    } else {
      // Not asking the car to move, so not stuck — a caller that brakes for a corner is not
      // making no progress, it is making a decision.
      state.anchorX = x; state.anchorZ = z; state.anchorFor = 0;
    }
  }

  state.i = i;
  return { controls: { throttle, brake, steer, handbrake: false },
    i, frac, aim, err, target, speed, offLine, reqRadius, reversing,
    curve: pathCurvature(points, j, 3),
    // `stuckFor` is null when the detector is off for want of a dt, 0..STUCK_S while it is
    // counting, and reset by any real progress. `backing` is the recovery manoeuvre it commands.
    stuckFor: dt > 0 ? +(state.anchorFor ?? 0).toFixed(2) : null,
    backing: !!state.backing, wedged,
    remaining: points.length - 1 - i, done: i >= points.length - 2 };
}

/**
 * Total heading change over the next `n` points, in radians. ADVISORY ONLY — it is reported
 * for legibility and nothing decides anything from it. Every reading that matters goes
 * through windowTurn(), for the reason that function's own comment gives.
 */
export function pathCurvature(points, from, n) {
  let total = 0;
  for (let k = from; k < Math.min(points.length - 2, from + n); k++) {
    const a = points[k], b = points[k + 1], c = points[k + 2];
    const h1 = Math.atan2(b[0] - a[0], b[1] - a[1]);
    const h2 = Math.atan2(c[0] - b[0], c[1] - b[1]);
    let d = h2 - h1;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    total += Math.abs(d);
  }
  return total;
}
