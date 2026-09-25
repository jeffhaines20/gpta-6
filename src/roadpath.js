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
    this.stats = {
      vertices: this.out.size, edges: district.edges.length,
      blockedEdges: this.blocked.size, blockedMetres: +blockedLen.toFixed(0),
      directed: [...this.out.values()].reduce((n, a) => n + a.length, 0),
      isolated: district.verts.length - this.out.size,
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

  /** Metres along edge `i`, following its shape points. */
  edgeLength(i) { return this._len.get(i) ?? 0; }

  /**
   * The graph NODE nearest (x, z). Nodes are edge endpoints, so this is not the nearest
   * point on the road — see nearestOn() for that. Linear over the node set, which is
   * ~1,400 entries and is called a handful of times per route rather than per frame.
   */
  nearestNode(x, z) {
    let best = -1, bestD = Infinity;
    for (const v of this.out.keys()) {
      const p = this.d.verts[v];
      const dd = (p.x - x) ** 2 + (p.z - z) ** 2;
      if (dd < bestD) { bestD = dd; best = v; }
    }
    return { vertex: best, dist: Math.sqrt(bestD) };
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
    let best = null;
    for (const from of [a.v0, a.v1]) {
      for (const to of [b.v0, b.v1]) {
        const r = this.route(from, to);
        if (r && (!best || r.length < best.length)) best = r;
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
    // Belt and braces: resample the whole polyline uniformly, so no joining mistake
    // anywhere above can leave a gap a look-ahead could swallow.
    pts = resample(pts, spacing);
    // Round the junctions, then resample again so the spacing survives the smoothing.
    if (smoothPasses > 0) pts = resample(smooth(pts, smoothPasses), spacing);
    if (offset) {
      // Per point, capped by that road's own half-width less a 1.2 m margin, so the
      // course stays on the tarmac whatever was asked for.
      pts = offsetRight(pts, offset, (i) => {
        const ei = pts[i][2];
        const e = ei >= 0 ? this.d.edges[ei] : null;
        if (!e) return offset;
        const half = (e.w * Math.max(1, e.lanes)) / 2;
        return Math.min(offset, Math.max(0, half - 1.2));
      });
    }
    let len = 0;
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    return { points: pts, length: len, graphLength: best.length, edges: best.edges,
      start: a, end: b };
  }

  /**
   * The shape points of `proj.edge` between the projection and `vertex`, in travel order.
   * With `reverse`, the walk runs FROM the vertex TO the projection instead, which is what
   * the tail of a path needs.
   */
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
    const legs = [];
    const points = [];
    for (let i = 0; i < waypoints.length; i++) {
      const a = waypoints[i], b = waypoints[(i + 1) % waypoints.length];
      if (Math.hypot(b.x - a.x, b.z - a.z) < 1) continue;
      const p = this.path(a.x, a.z, b.x, b.z, opts);
      if (!p) { legs.push({ from: i, failed: true }); continue; }
      legs.push({ from: i, length: p.length, points: p.points.length, at: points.length });
      for (const q of p.points) {
        const last = points[points.length - 1];
        if (last && Math.hypot(q[0] - last[0], q[1] - last[1]) < 1e-6) continue;
        points.push(q);
      }
    }
    let len = 0;
    for (let i = 1; i < points.length; i++) {
      len += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    }
    return { points, legs, length: len, failed: legs.filter((l) => l.failed).length };
  }
}

/**
 * Resample a polyline to a uniform spacing. Guarantees no gap exceeds `spacing`, which is
 * what a look-ahead measured in arc length depends on: one long segment makes the aim
 * point the far end of it and the car drives straight there, off-road, reporting a heading
 * error of zero the whole way.
 */
export function resample(pts, spacing) {
  if (pts.length < 2) return pts.slice();
  const out = [pts[0].slice()];
  let carry = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i], b = pts[i + 1];
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
export function smooth(pts, passes = 1) {
  let cur = pts;
  for (let p = 0; p < passes; p++) {
    if (cur.length < 3) return cur;
    const out = [cur[0].slice()];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i], b = cur[i + 1];
      out.push([a[0] * 0.75 + b[0] * 0.25, a[1] * 0.75 + b[1] * 0.25, a[2]]);
      out.push([a[0] * 0.25 + b[0] * 0.75, a[1] * 0.25 + b[1] * 0.75, b[2]]);
    }
    out.push(cur[cur.length - 1].slice());
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
export function offsetRight(pts, d, perPoint = null) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const amt = perPoint ? perPoint(i) : d;
    const a = pts[Math.max(0, i - 1)], b = pts[Math.min(pts.length - 1, i + 1)];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz);
    if (!(L > 0)) { out.push([p[0], p[1], p[2]]); continue; }
    // Right of a heading (dx, dz) in this coordinate frame, where +x is right of +z.
    out.push([p[0] + (dz / L) * amt, p[1] - (dx / L) * amt, p[2]]);
  }
  return out;
}

/**
 * THE CORNERING BUDGET, DERIVED FROM src/vehicle.js RATHER THAN TUNED.
 *
 * That module's tyre model clamps the combined force into a friction circle of
 * `grip = 1.15` times the normal load, and runs at `gravity = -19.6` — 2 g of arcade
 * weight. So the lateral acceleration available is
 *
 *     a = grip * |gravity| = 1.15 * 19.6 = 22.54 m/s^2
 *
 * and a corner of radius R can be taken at v <= sqrt(a * R). The same budget is what
 * stops the car, so the braking distance from v to vTarget is (v^2 - vTarget^2) / 2a.
 *
 * SAFETY is a flat 0.55 of that, and the reason it is not 1.0 is that the radius comes
 * from three points of a 4 m-resampled polyline, which is a crude estimate of a junction
 * radius, and the penalty for over-estimating is a building. tools/route-drive.mjs
 * measures what the factor buys: the whole point of stating it here is that a future
 * round changing it can see what it is trading.
 *
 * WHY THIS IS NEEDED AT ALL. The first draft eased the THROTTLE for corners and never
 * touched the brake. On this district's 500 m stretch of Main Street the car reached
 * 119 km/h, the curvature reading rose 12 m before the junction, the throttle dropped to
 * 0.28 — and the car arrived at the junction still doing 110 km/h and was wrecked
 * against the building opposite. Coasting is not braking.
 */
export const CORNER = Object.freeze({
  grip: 1.15,            // src/vehicle.js's friction-circle coefficient
  gravity: 19.6,         // src/vehicle.js's arcade 2 g
  safety: 0.55,
  // src/vehicle.js's steering geometry, and its speed-dependent authority.
  maxSteer: 0.55,        // radians at the wheel
  wheelbase: 2.62,       // 1.32 + 1.30, from WHEEL_LAYOUT
  steerFalloff: 0.035,   // setControls: steer *= 1 / (1 + |forwardSpeed| * this)
  get accel() { return this.grip * this.gravity; },
  get useful() { return this.accel * this.safety; },
});

/**
 * THE SECOND LIMIT, AND GRIP IS NOT IT. A corner has two ceilings and the first draft of
 * pathSpeedLimit only knew about one.
 *
 * src/vehicle.js scales steering authority DOWN with speed — `speedFactor = 1 / (1 +
 * |forwardSpeed| * 0.035)`, so the car is deliberately less twitchy at 120 km/h — which
 * means its minimum turning radius GROWS with speed:
 *
 *     R_min(v) = wheelbase / tan( maxSteer / (1 + v * falloff) )
 *
 * At rest that is 4.3 m; at 40 km/h it is 6.2 m. So a 6 m junction radius is not merely
 * uncomfortable at 40 km/h, it is geometrically impossible, and no amount of grip helps.
 * Inverting for the fastest speed at which a radius R is still steerable:
 *
 *     v <= ( maxSteer / atan(wheelbase / R) - 1 ) / falloff
 *
 * Grip binds above about 8 m of radius and steering binds below it. The symptom of missing
 * this was unmistakable once traced: full steering lock, a heading error of 1.39 rad, and
 * the off-line distance climbing 1.9 -> 8.2 m while the throttle sat at 0.35 — a car
 * asking for more lock than it has and driving into the building on the outside of the
 * turn. It happened at maxSpeed 22 and again at maxSpeed 16, at different junctions.
 */
export function steerableSpeed(radius) {
  const inner = Math.atan(CORNER.wheelbase / Math.max(radius, 0.1));
  if (!(inner > 0) || inner >= CORNER.maxSteer) return 0;
  return Math.max(0, (CORNER.maxSteer / inner - 1) / CORNER.steerFalloff);
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
  const a = CORNER.useful;
  const scan = Math.max(25, (speed * speed) / (2 * a));
  let limit = maxSpeed;
  let d = 0;
  for (let k = from; k < points.length - 2 && d < scan; k++) {
    const w = windowTurn(points, k, ARC_WINDOW);
    if (w) {
      if (w.turn > 1e-3) {
        const radius = w.arc / w.turn;
        // The lower of the two ceilings: grip, and the steering geometry.
        const vCorner = Math.min(Math.sqrt(a * radius), steerableSpeed(radius));
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
  let i = state.i;
  let bestD = Infinity;
  const window = Math.min(points.length, i + 80);
  for (let k = i; k < window; k++) {
    const dd = (points[k][0] - x) ** 2 + (points[k][1] - z) ** 2;
    if (dd < bestD) { bestD = dd; i = k; }
  }
  let acc = 0, j = i;
  for (; j < points.length - 1; j++) {
    acc += Math.hypot(points[j + 1][0] - points[j][0], points[j + 1][1] - points[j][1]);
    if (acc >= lookAhead) break;
  }
  const aim = points[Math.min(j + 1, points.length - 1)];
  const dx = aim[0] - x, dz = aim[1] - z;
  let err = Math.atan2(dx, dz) - yaw;
  while (err > Math.PI) err -= Math.PI * 2;
  while (err < -Math.PI) err += Math.PI * 2;
  const steer = clamp(err * 1.8, -1, 1);

  const target = Math.min(maxSpeed, pathSpeedLimit(points, i, speed, maxSpeed));
  let throttle = 0, brake = 0;
  if (speed > target * 1.03) {
    // Proportional on the excess, and firm: half the target over is full brakes.
    brake = clamp((speed - target) / Math.max(target * 0.5, 2), 0.2, 1);
  } else {
    throttle = clamp((target - speed) / 3 + 0.3, 0, 1);
    // Still ease for a heading error the steering is fighting.
    if (Math.abs(err) > 0.6) throttle = Math.min(throttle, 0.35);
  }
  state.i = i;
  return { controls: { throttle, brake, steer, handbrake: false },
    i, aim, err, target, speed, offLine: Math.sqrt(bestD), curve: pathCurvature(points, j, 3),
    remaining: points.length - 1 - i, done: i >= points.length - 1 };
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
