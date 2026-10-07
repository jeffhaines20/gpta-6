// Static world collision: building walls, as line segments in a uniform grid.
//
// WHY THIS EXISTS AT ALL. Until this module there was no body collision anywhere in
// the project. The car drove through buildings. src/vehicle.js casts four wheel rays
// at the ground and nothing else, and district/main.js's own comment says so: "the
// collision body, the wheel anchors and the spring rates are src/vehicle.js's alone".
// There was no collision body. A damage model with no impacts is a number that never
// changes, so the damage model needed this first.
//
//   node tools/blocker-test.mjs           the gate
//
// WHY SEGMENTS AND NOT BOUNDING BOXES, WITH THE NUMBER. district/main.js already had
// a collider for the on-foot player: the axis-aligned bounding box of each building's
// footprint ring. That is cheap and it is wrong, and the district says how wrong.
// Rasterised at 1 m over all 523 footprints, the area inside some building's bbox but
// outside every building's polygon is
//
//     142,932 m2   — 30.9% of all bbox area
//      21,588 m2   of it ON the carriageway (inside a road's own half-width)
//      28,254 m2   more on the pavement beside it
//
// so a bbox collider hangs 21,588 m2 of invisible wall across the roads the car is
// supposed to drive down, and 161 of 523 buildings (30.8%) carry more than a quarter
// of their box as phantom. The worst single one is b6: 8,765 m2 of box over 2,436 m2
// of building, 6,329 m2 of nothing. Half the district's buildings are over 10%. An
// invisible wall in the middle of a street is the most infuriating bug a collision
// system can have, and it was already shipping for anyone on foot.
//
// Sampled every 2 m along every road centreline in the district — 24,517 points — a
// car-sized circle cannot fit at
//
//        64 of 24,517  (0.26%)   with these segments
//     1,806 of 24,517  (7.37%)   with the bounding boxes
//
// so the box blocks 28.2 times as much road as the geometry does. The 64 are real: 53
// of them are centreline that passes through a footprint, which is a district data
// question and not a collision one.
//
// The real ring is 7.6 vertices per building and 3,950 segments district-wide, which
// is small enough that there was never a performance argument for the box. Measured
// cost is 423 ns on open road and 3.1 us in contact, at 240 calls a second.
//
// THE SEGMENTS ARE THE BUILD'S OWN EDGES. CLAUDE.md's geom-audit lesson is that a
// tool replaying the build must replay the build's own SELECTION, and that the cheap
// proof is matching counts: that audit "passed the whole time" while blind to half of
// every corner site. So this uses facades.js's rule verbatim — its `minLen` filter and
// its winding-derived outward normal — and tools/blocker-test.mjs imports the real
// `edgesOf` and asserts the two agree building by building, edge by edge, normal by
// normal. It does not import facades.js itself: that module pulls in three.js and the
// whole texture library, and the vehicle should not depend on either.

/** NaN-safe clamp, same as wanted.js / mission.js / damage.js. */
const clamp = (v, lo, hi) => (v > lo ? (v > hi ? hi : v) : lo);

/**
 * Penetration below this is not a penetration. See resolveCircle's own note: without
 * it the resolver runs its whole iteration budget every frame on a settled contact.
 * 1 micrometre — far below anything the renderer or the physics can see, far above
 * the 1e-17 residue of the push-out arithmetic.
 */
const EPS = 1e-6;

/**
 * Signed ring area, byte-identical to facades.js's ringArea(). Duplicated rather
 * than imported for the dependency reason above; the gate asserts they agree to the
 * last bit over all 523 rings, so the duplication cannot drift silently.
 */
export function ringArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

/** Is (x,z) inside this ring? Crossing test, the same one pedestrians.js uses. */
export function insideRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, zi] = ring[i], [xj, zj] = ring[j];
    if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * The index. Two grids over the same cell size:
 *
 *   segGrid    segment ids, for the penetration test
 *   boxGrid    building ids whose bbox covers the cell, for the inside test
 *
 * The inside test needs its own grid because a car that ends up deep inside a large
 * footprint — a teleport, a mission restart, a spawn on a lot — has NO wall segment
 * within its radius, so the penetration test sees nothing at all and reports clear.
 * That is the failure mode where the car parks inside a building and the damage model
 * reports a showroom-fresh car, and it costs four float compares a frame to rule out.
 */
export class BlockerIndex {
  constructor(district, opts = {}) {
    this.cell = opts.cell ?? 16;
    this.minLen = opts.minLen ?? 0.05;      // facades.js appendBuilding's own filter
    this.segs = [];
    this.rings = [];
    this.boxes = [];
    this._segGrid = new Map();
    this._boxGrid = new Map();
    this.stats = { buildings: 0, segments: 0, dropped: 0, segCells: 0, boxCells: 0,
      worstSegBucket: 0, worstBoxBucket: 0 };

    const buildings = district?.buildings ?? [];
    for (let b = 0; b < buildings.length; b++) {
      const ring = buildings[b].p;
      if (!Array.isArray(ring) || ring.length < 3) continue;
      this.stats.buildings++;
      this.rings.push(ring);
      // Outward normal from the winding, exactly as facades.js edgesOf does it.
      const flip = ringArea(ring) > 0 ? -1 : 1;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const [x, z] of ring) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      const bi = this.boxes.length;
      this.boxes.push({ b, ring, x0, x1, z0, z1, h: buildings[b].h ?? 0 });
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        const dx = c[0] - a[0], dz = c[1] - a[1];
        const len = Math.hypot(dx, dz);
        if (len < this.minLen) { this.stats.dropped++; continue; }
        this.segs.push({
          ax: a[0], az: a[1], bx: c[0], bz: c[1], len, i, box: bi, b,
          tx: dx / len, tz: dz / len,
          nx: (dz / len) * flip, nz: (-dx / len) * flip,
        });
      }
    }
    this.stats.segments = this.segs.length;
    this._index();
  }

  _key(cx, cz) { return cx * 1000003 + cz; }

  _index() {
    const C = this.cell;
    for (let s = 0; s < this.segs.length; s++) {
      const g = this.segs[s];
      const cx0 = Math.floor(Math.min(g.ax, g.bx) / C), cx1 = Math.floor(Math.max(g.ax, g.bx) / C);
      const cz0 = Math.floor(Math.min(g.az, g.bz) / C), cz1 = Math.floor(Math.max(g.az, g.bz) / C);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const k = this._key(cx, cz);
        let a = this._segGrid.get(k); if (!a) this._segGrid.set(k, a = []);
        a.push(s);
      }
    }
    for (let i = 0; i < this.boxes.length; i++) {
      const b = this.boxes[i];
      const cx0 = Math.floor(b.x0 / C), cx1 = Math.floor(b.x1 / C);
      const cz0 = Math.floor(b.z0 / C), cz1 = Math.floor(b.z1 / C);
      for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
        const k = this._key(cx, cz);
        let a = this._boxGrid.get(k); if (!a) this._boxGrid.set(k, a = []);
        a.push(i);
      }
    }
    this.stats.segCells = this._segGrid.size;
    this.stats.boxCells = this._boxGrid.size;
    for (const a of this._segGrid.values()) if (a.length > this.stats.worstSegBucket) this.stats.worstSegBucket = a.length;
    for (const a of this._boxGrid.values()) if (a.length > this.stats.worstBoxBucket) this.stats.worstBoxBucket = a.length;
  }

  /**
   * Segment ids whose cell neighbourhood covers a circle of radius r at (x,z).
   * Reuses `out` so the hot path allocates nothing: the vehicle calls this twice per
   * fixed step, which is 240 times a second.
   */
  near(x, z, r, out = []) {
    out.length = 0;
    const C = this.cell;
    const cx0 = Math.floor((x - r) / C), cx1 = Math.floor((x + r) / C);
    const cz0 = Math.floor((z - r) / C), cz1 = Math.floor((z + r) / C);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      const a = this._segGrid.get(this._key(cx, cz));
      if (!a) continue;
      for (const s of a) if (out.indexOf(s) < 0) out.push(s);
    }
    return out;
  }

  /**
   * Is there any wall segment in the neighbourhood of a circle? The whole-body early
   * out: src/vehicle.js tests five circles along the body, and on open road — which is
   * almost every frame — one grid lookup answers all five at once.
   */
  anyNear(x, z, r) {
    const C = this.cell;
    const cx0 = Math.floor((x - r) / C), cx1 = Math.floor((x + r) / C);
    const cz0 = Math.floor((z - r) / C), cz1 = Math.floor((z + r) / C);
    for (let cz = cz0; cz <= cz1; cz++) for (let cx = cx0; cx <= cx1; cx++) {
      if (this._segGrid.has(this._key(cx, cz))) return true;
    }
    return false;
  }

  /** The building a point is inside, or -1. Index into `this.boxes`. */
  insideAny(x, z) {
    const C = this.cell;
    const a = this._boxGrid.get(this._key(Math.floor(x / C), Math.floor(z / C)));
    if (!a) return -1;
    for (const i of a) {
      const b = this.boxes[i];
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (insideRing(b.ring, x, z)) return i;
    }
    return -1;
  }

  /**
   * Push a circle out of the walls. Returns null when clear, otherwise
   *
   *   { x, z, nx, nz, depth, seg, iters, recovered }
   *
   * where (x,z) is the corrected centre, (nx,nz) is the unit direction the circle
   * was pushed, and `depth` is the total distance moved.
   *
   * ITERATED, BECAUSE A CORNER NEEDS TWO WALLS. Resolving the single deepest
   * penetration is right for a flat wall and wrong for an inside corner, where the
   * push out of wall A puts the circle further into wall B. Four passes settle every
   * corner in this district; the gate reports the worst count actually needed, so
   * the day a footprint appears that needs five, the number says so instead of the
   * car sinking into the corner.
   *
   * The reported normal is the direction of the NET correction, which is what a
   * collision response wants: in a corner that is the diagonal bisector, and that is
   * the direction the car should come off at.
   */
  resolveCircle(x, z, r, maxIters = 4) {
    const recovered = this.insideAny(x, z);
    let px = x, pz = z;
    if (recovered >= 0) {
      // Deep inside: no wall is within r, so the penetration test is blind. Leave
      // through the nearest edge of the ring we are in, plus the radius.
      //
      // Twice, because footprints in this district share walls: leaving one can land
      // inside its neighbour. Twice and not a loop, because a chain of three is a
      // geometry problem rather than a resolver problem and should be visible as a
      // residual in the gate rather than hidden by more iterations.
      for (let pass = 0; pass < 2; pass++) {
        const in2 = pass === 0 ? recovered : this.insideAny(px, pz);
        if (in2 < 0) break;
        const out = this._exitRing(this.boxes[in2].ring, px, pz, r);
        if (!out) break;
        px = out.x; pz = out.z;
      }
    }
    const cand = this.near(px, pz, r, this._scratch ?? (this._scratch = []));
    let iters = 0, movedX = 0, movedZ = 0, deepest = -1, deepestD = 0;
    for (; iters < maxIters; iters++) {
      let bestS = -1, bestPen = 0, bdx = 0, bdz = 0;
      for (const si of cand) {
        const g = this.segs[si];
        const ex = g.bx - g.ax, ez = g.bz - g.az;
        let t = ((px - g.ax) * ex + (pz - g.az) * ez) / (g.len * g.len);
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const qx = g.ax + ex * t, qz = g.az + ez * t;
        let dx = px - qx, dz = pz - qz;
        const d = Math.hypot(dx, dz);
        if (d >= r - EPS) continue;
        // Direction to leave by. At d ~ 0 there is no direction, so use the wall's
        // own outward normal; otherwise away from the closest point.
        if (d > 1e-6) { dx /= d; dz /= d; } else { dx = g.nx; dz = g.nz; }
        // Only push OUT. A closest point on the interior side of this edge's plane
        // means this edge is a back wall we are already past, and pushing away from
        // it would drive the circle further into the building.
        if (dx * g.nx + dz * g.nz <= 0) continue;
        const pen = r - d;
        if (pen > bestPen) { bestPen = pen; bestS = si; bdx = dx; bdz = dz; }
      }
      if (bestS < 0) break;
      // THE EPSILON IS NOT COSMETIC, and the gate is what found that out. Pushing a
      // circle to exactly r from a wall leaves it, in floating point, a few times
      // 1e-17 short of clear — so the next pass finds a penetration of 1e-17, pushes
      // by 1e-17, and the loop runs its entire budget every single frame while
      // reporting a correctly resolved contact. The gate measured 37 contacts on the
      // real road network burning all 32 iterations of a raised budget with the depth
      // unchanged after the first, and `resolveCircle` returning a non-null contact
      // for a correction of 0.0000 m. Requiring a real penetration to act on, and
      // overshooting by the same epsilon, terminates in one pass on a flat wall.
      px += bdx * (bestPen + EPS); pz += bdz * (bestPen + EPS);
      movedX += bdx * bestPen; movedZ += bdz * bestPen;
      if (bestPen > deepestD) { deepestD = bestPen; deepest = bestS; }
    }
    if (recovered < 0 && deepest < 0) return null;
    const mx = px - x, mz = pz - z;
    const depth = Math.hypot(mx, mz);
    // A correction below the epsilon is not a contact. Returning one made the gate's
    // driveability count wrong and would have charged the damage model an impact for
    // a car parked next to a wall, every frame, forever.
    if (recovered < 0 && !(depth > EPS)) return null;
    const inv = depth > 1e-9 ? 1 / depth : 0;
    return { x: px, z: pz, nx: mx * inv, nz: mz * inv, depth, seg: deepest,
      iters, recovered: recovered >= 0 ? this.boxes[recovered].b : -1 };
  }

  /** Nearest way out of a ring we are inside, plus a clearance of r. */
  _exitRing(ring, x, z, r) {
    let bestD = Infinity, bx = 0, bz = 0, bnx = 0, bnz = 0;
    const flip = ringArea(ring) > 0 ? -1 : 1;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], c = ring[(i + 1) % ring.length];
      const ex = c[0] - a[0], ez = c[1] - a[1];
      const L2 = ex * ex + ez * ez;
      if (!(L2 > 0)) continue;
      let t = ((x - a[0]) * ex + (z - a[1]) * ez) / L2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const qx = a[0] + ex * t, qz = a[1] + ez * t;
      const d = Math.hypot(x - qx, z - qz);
      if (d < bestD) {
        bestD = d; bx = qx; bz = qz;
        const L = Math.sqrt(L2);
        bnx = (ez / L) * flip; bnz = (-ex / L) * flip;
      }
    }
    if (!Number.isFinite(bestD)) return null;
    return { x: bx + bnx * r, z: bz + bnz * r, nx: bnx, nz: bnz, depth: bestD + r };
  }

  report() {
    return { ...this.stats, cell: this.cell, minLen: this.minLen,
      meanSegPerCell: +(this.segs.length ? [...this._segGrid.values()]
        .reduce((a, v) => a + v.length, 0) / this._segGrid.size : 0).toFixed(2) };
  }
}

/**
 * Convenience for callers that only have the district JSON.
 * One index serves the whole map: 3,950 segments is 190 KB of objects, built in a
 * few milliseconds, and it does not change as chunks stream in and out. Rebuilding it
 * per chunk would reintroduce exactly the bug the on-foot collider has, where the
 * collider and the thing it represents are refreshed on different schedules.
 */
export function buildBlockers(district, opts) { return new BlockerIndex(district, opts); }

/**
 * The collision response for a circle sample on a rigid body, as plain numbers.
 *
 * Returns the impulse to apply at the contact and the normal delta-v the damage model
 * should be charged, or null when the contact is separating. Kept here, next to the
 * geometry, because the effective-mass term is the part a caller gets wrong:
 *
 *   k = 1/m + (rz*nx - rx*nz)^2 / Iy
 *
 * is the planar effective mass at an offset contact. Using 1/m alone — the obvious
 * shortcut — over-corrects every off-centre hit, which is every hit that clips a
 * building corner, and makes the car snap rather than spin.
 */
export function contactImpulse({ vx, vz, rx, rz, nx, nz, mass, inertiaY,
  restitution = 0.15, friction = 0.4, omega = 0 }) {
  // Contact-point velocity includes the body's spin: omega x r, planar.
  const cvx = vx - omega * rz, cvz = vz + omega * rx;
  const vn = cvx * nx + cvz * nz;
  if (!(vn < 0)) return null;                       // separating, or exactly tangent
  const cross = rz * nx - rx * nz;
  const k = 1 / mass + (cross * cross) / Math.max(inertiaY, 1e-6);
  const jn = (-(1 + clamp(restitution, 0, 1)) * vn) / k;
  // Tangential: scrape friction, capped by the Coulomb cone.
  let tx = -(cvx - nx * vn), tz = -(cvz - nz * vn);
  const tl = Math.hypot(tx, tz);
  let jt = 0;
  if (tl > 1e-6) {
    tx /= tl; tz /= tl;
    const crossT = rz * tx - rx * tz;
    const kt = 1 / mass + (crossT * crossT) / Math.max(inertiaY, 1e-6);
    jt = Math.min(tl / kt, friction * jn);
  } else { tx = 0; tz = 0; }
  return {
    jx: nx * jn + tx * jt, jz: nz * jn + tz * jt,
    jn, jt,
    // What the damage model is charged. The normal velocity is removed and then
    // reversed by the restitution, so the change along the normal is |vn|*(1+e) —
    // the same expression damage.js's normalDv() documents, computed here from the
    // contact-point velocity so a spinning car's corner is charged for its own speed.
    dv: -vn * (1 + clamp(restitution, 0, 1)),
  };
}

/**
 * WHERE THE WORLD ENDS.
 *
 * There was no boundary at all. A playtester pointed the car north from the bayfront and held the
 * throttle: the fleet and the crowd both drop to zero after 829 m, and the car was still doing
 * 146 km/h at 4,595 m out — 8,990 m past anything modelled — over nothing. Driving east or south
 * from the same spawn wrecks the car in 95-116 m, so the district is boxed in on two of four
 * sides by buildings and open on the others by accident.
 *
 * THE FENCE IS THE ROAD NETWORK'S OWN EXTENT, NOT `meta.bounds`, and that distinction is the
 * whole of the derivation. `meta.bounds` is ±716.95 by ±500.94, while the roads run from
 * x -862 to 814 and z -524 to 719 — so a fence at the declared bounds would cut off real
 * driveable street, which is worse than no fence. Every road has to stay reachable, and nothing
 * beyond the roads is modelled, so the roads plus a margin is exactly the right box.
 *
 * `margin` is 60 m: two blocks' worth of run-off past the last junction, enough that a player
 * chasing the edge of the map meets the fence rather than the end of the pavement.
 */
export const WORLD_MARGIN_M = 60;

export function districtBounds(district, margin = WORLD_MARGIN_M) {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of district.verts) {
    if (v.x < x0) x0 = v.x;
    if (v.x > x1) x1 = v.x;
    if (v.z < z0) z0 = v.z;
    if (v.z > z1) z1 = v.z;
  }
  return { x0: x0 - margin, x1: x1 + margin, z0: z0 - margin, z1: z1 + margin, margin };
}

/**
 * A ONE-WAY FENCE, which is the only kind that cannot strand the player.
 *
 * The obvious implementation — cut the engine outside the box — is the dead end this project has
 * already shipped once, in the wrecked car that could not be driven anywhere: outside the fence
 * with no power, there is no way back in. So the refusal is DIRECTIONAL. Power that would take
 * the car further out is refused; power that brings it back always works, at both ends of the
 * throttle, because a car that left the map nose-first comes back in reverse.
 *
 * The brake ramps with depth rather than slamming on, so meeting the fence at 140 km/h reads as
 * running out of road and not as hitting a wall that is not drawn. `out / 30` reaches full brake
 * 30 m past the line, which is about a second and a half at that speed.
 *
 * AND THE BRAKE IS ON THE VELOCITY, NOT ON THE POSITION, which the first version got wrong and
 * which stranded the car exactly as thoroughly as cutting the engine would have. Measured: 786 m
 * north of the bayfront at full throttle, the fence stopped the car 70.7 m out — correctly — and
 * then thirty seconds of full throttle pointing back at town moved it 0.1 m, because a brake
 * ramped on DEPTH is still at 1.0 when the car is trying to leave. Braking only while the car is
 * actually travelling outward gives the same stop and lets it drive home.
 *
 * Returns the controls to use plus `out`, the metres outside the box, so a HUD can say so and a
 * gate can assert on it. `out` is 0 everywhere inside, which is everywhere a player ever drives.
 */
/**
 * THE DEPTH AT WHICH THE FENCE INSISTS FULLY. Everything below scales with `out / FENCE_FULL_M`,
 * so at the line the fence is a nudge and 30 m out it is the whole of its authority.
 */
export const FENCE_FULL_M = 30;

/**
 * HOW FAST THE CAR HAS TO BE LEAVING FOR THE BRAKE TO BE FULL, and this number is the fix.
 *
 * The fence used to ask `nx*vx + nz*vz > 0` — a SIGN test — and then brake at `min(1, out/30)`,
 * which is 1.0 from 30 m out. A car standing still outside has an outward velocity of numerical
 * noise: measured at up to 8.87e-3 m/s at rest, which flips sign, so about half of all frames
 * scored a full brake and the mean brake on a parked car 30 m out was **0.990**. Held on maximum
 * brake by its own rounding error, the car went nowhere: 180 s of full throttle at the pure
 * TANGENTIAL pose moved it **1 metre**, and no single input recovered that pose at all.
 *
 * Ramped instead of tested, so there is no line for a near-zero quantity to be the wrong side of —
 * which is the whole defect, and a deadband would only move it. The same measurement now reads
 * **0.030**, a 33x reduction, and the tangential pose recovers.
 *
 * It is a choice, stated as one, bounded at both ends:
 *   - ABOVE the drift of a car at rest, which `blocker-test` measures at 7.88e-3 m/s and asserts
 *     a 20x margin against. Two readings of that drift were live in one commit — 8.87e-3 from an
 *     earlier sweep and 7.88e-3 from the gate — which is the "three different conversions were live
 *     at once" trap; the gate's is the one to quote, because it is the one that runs.
 *   - BELOW anything a player would call moving. 0.25 m/s is 0.9 km/h; a car leaving that slowly
 *     takes four minutes to cross the fence's own 60 m margin, and anything faster is fully braked.
 * `blocker-test` asserts both relations rather than the number.
 */
export const FENCE_BRAKE_MS = 0.25;

/**
 * AND A CRAWL WHILE OUTSIDE, IN ANY DIRECTION, because removing the latch removed the containment
 * the latch was accidentally providing.
 *
 * The fence's own comments say it refuses only the power that takes the car FURTHER out, which
 * leaves motion ALONG the fence untouched — and the old code only stopped that by the bug above.
 * Measured with the latch removed and nothing in its place: 180 s of held throttle at the
 * tangential pose tours **3,074 m along the outside of the world at 146 km/h**, which is the
 * "drove 4,595 m off the map at 146 km/h over nothing" this fence was built for. So the
 * containment is now stated instead of accidental: with the crawl it is 585 m at 12 km/h.
 *
 * 2.2 m/s is 8 km/h, `src/damage.js`'s FMVSS 581 bumper threshold, and it is the same derivation
 * `src/roadpath.js`'s `cornerSpeed` floor makes for the same kind of problem — a pose the car
 * cannot drive out of needs a crawl, not a standstill, and a contact taken at this speed is free
 * by construction. `blocker-test` asserts it against `DamageModel.freeDv` rather than trusting
 * the comment.
 *
 * AND A CAR ALREADY ON ITS WAY IN IS EXEMPT, which is not a detail: capping the speed of a car
 * heading home is the dead end CLAUDE.md records twice — the wrecked car with no power and the
 * first world fence, both of which stranded the player 786 m out. The exemption is on the
 * VELOCITY, not the nose, for the same reason the throttle refusal is: reverse with an outward
 * nose is driving home. Measured: without it, recovering from the dead-outward pose costs 10.7 s
 * against the old code's 6.7 s; with it, 6.7 s exactly.
 *
 * AND IT TAKES A DIRECTION, NOT JUST A COMPONENT, which the first version got wrong in the way
 * this whole file keeps getting wrong. An inward component of 2.2 m/s is satisfied by a car doing
 * 143 km/h with its nose FOUR DEGREES inward of the tangent — which is not coming home, it is
 * touring the outside of the world at full speed — so a blind reviewer found the crawl switching
 * itself off at 3 degrees of inward nose and 143 km/h, ending 74 m out. "Coming home" is a
 * statement about direction: more than half the velocity has to be inward, which is the 45 degree
 * line, `-outV > speed / sqrt(2)`. A car genuinely driving in clears it at any speed; a tangential
 * one at any speed does not.
 */
export const FENCE_CRAWL_MS = 2.2;
/** cos 45 degrees: past this, the velocity is more inward than tangential. See FENCE_CRAWL_MS. */
const FENCE_HOMING_COS = Math.SQRT1_2;

/**
 * THE FENCE'S BAND TENANT, and it lives here because the verb is derived from the same quantity
 * the refusal is.
 *
 * It was composed INLINE IN BOTH HOSTS — `{ objective: 'TURN BACK', subtitle: 'the district ends
 * here — N m out' }`, duplicated in `district/main.js` and `tools/playtest.mjs` — which is the
 * host-rule shape CLAUDE.md says to MOVE rather than to browser-test. Moving it is also what makes
 * the verb gateable offline.
 *
 * AND THE OLD SUBTITLE NAMED NO CONTROL, SO IT NAMED THE WRONG ONE BY OMISSION. A blind playtester
 * swept it: 34.0 m out, at rest, 30 s of full throttle, wheel straight —
 *
 *     nose-off from the outward normal     0-89 deg -> 0.1 m        91 deg -> 1.1 m
 *                                           100 deg -> 11.4 m      135 deg -> 135.2 m
 *     reverse, straight                                            210.9 m, out 34 -> 0
 *
 * So nothing forward works until the nose is more than a quarter turn off outward, and **you
 * cannot get the nose there by driving forward** — `worldFence` refuses outward throttle, so there
 * is no speed to steer with. The only control that moves the car is reverse, and the band said
 * "TURN BACK" while `composeStuck` one priority away already knew the word.
 *
 * `noseOut` IS the predicate `Math.sign(throttle) * dot > 0` refuses on, published by `worldFence`
 * for this purpose — so the verb flips where the refusal does, by construction rather than by a
 * threshold somebody picked. The playtester's 89/91 boundary is that sign change, measured from
 * outside.
 *
 * It reads `noseOut` and NOT the reported `outward`, which is rounded to three decimals: at a nose
 * exactly tangential the true dot is 6.1e-17 and the rounded one is 0.000, so the first version of
 * this said "drive" at the one angle where forward is refused. Two roundings of one quantity are
 * not one quantity.
 */
export function composeFence(f) {
  if (!f || !f.held) return null;
  return {
    objective: { text: 'TURN BACK', distance: Math.max(0, f.out ?? 0) },
    /**
     * Signed on the nose, like `composeStuck`: a nose still pointing out of the district is told
     * to reverse, because forward is refused; a nose already pointing home is told to drive,
     * because it is allowed and it works. `drive` is correct and not merely harmless in that
     * case — 135 degrees off outward covers 135.2 m at 105 km/h.
     */
    subtitle: f.noseOut ? 'reverse' : 'drive',
    ownSubtitle: true,
  };
}

export function worldFence(bounds, x, z, fwdX, fwdZ, vx, vz, controls) {
  const dx = Math.max(bounds.x0 - x, 0, x - bounds.x1);
  const dz = Math.max(bounds.z0 - z, 0, z - bounds.z1);
  const out = Math.hypot(dx, dz);
  if (!(out > 0)) return { controls, out: 0, held: false };
  // The outward normal: which way is away from the box. Signed per axis, then normalised.
  const ox = x < bounds.x0 ? -dx : dx, oz = z < bounds.z0 ? -dz : dz;
  const L = Math.hypot(ox, oz) || 1;
  const nx = ox / L, nz = oz / L;
  // How much of the car's nose points outward. Positive: driving forward takes it further out.
  const dot = nx * fwdX + nz * fwdZ;
  let throttle = controls.throttle ?? 0;
  // Refused by the direction the car would MOVE, not by the direction it points: reverse with an
  // outward nose drives home and has to be allowed.
  //
  // NOT RAMPED, and that was measured rather than assumed. The round-5 playtester proposed ramping
  // this refusal so the car "keeps enough drive to steer with", which is the obvious reading and is
  // wrong: swept over band widths from 0.02 to 0.30 of dot, a ramp made recovery from the dead
  // poses WORSE — never, against 137 s for the hard refusal — because partial throttle at a small
  // outward angle builds outward speed for a controller that then has a faster car to turn. The
  // hard refusal only lets the car move once it is pointing home, which is what recovers it. Their
  // OBSERVATION was exact and their proposed lever was the wrong one; CLAUDE.md's own rule.
  if (throttle !== 0 && Math.sign(throttle) * dot > 0) throttle = 0;

  const outV = nx * (vx ?? 0) + nz * (vz ?? 0);
  const speed = Math.hypot(vx ?? 0, vz ?? 0);
  const depthK = Math.min(1, out / FENCE_FULL_M);
  /**
   * (a) HOW FAST IT IS LEAVING, in proportion, and scaled by depth. See FENCE_BRAKE_MS: this
   *     replaced a sign test on a quantity that is numerical noise in the one pose nothing had ever
   *     exercised. The depth scale belongs here — the further out you are, the harder the fence
   *     pushes back — and `out / FENCE_FULL_M` is that.
   */
  const leavingK = depthK * Math.min(1, Math.max(0, outV) / FENCE_BRAKE_MS);
  /**
   * (b) AND A CRAWL IN ANY DIRECTION, NOT SCALED BY DEPTH, which is the correction a blind reviewer
   *     found. Scaling the crawl by `out / FENCE_FULL_M` means it barely applies near the line,
   *     which is exactly where a player who has drifted past it actually is: measured, holding the
   *     throttle from 2, 5, 10 and 15 m out toured at **143 km/h** against a crawl of 7.9, and
   *     recovery from 5 and 10 m out failed outright inside 180 s where 30 m out recovered in 141.
   *     My own claim of "585 m at 12 km/h" was exact at 30 m and tangential and wrong everywhere
   *     else — the same defect shape this section already records for the POSE axis, swept on pose
   *     and not on depth.
   *
   *     The crawl is a statement about being outside at all, so it applies as soon as you are.
   */
  const homing = outV < -FENCE_CRAWL_MS && -outV > speed * FENCE_HOMING_COS;
  const crawlK = homing ? 0 : Math.min(1, Math.max(0, speed - FENCE_CRAWL_MS) / FENCE_CRAWL_MS);
  /**
   * AND THE CRAWL TAKES THE DRIVE AS WELL AS APPLYING THE BRAKE, because the brake alone cannot
   * hold a car whose throttle is held. Measured: entering the fence at 140 km/h with full throttle
   * and a few degrees of inward nose, full brake settles the car at **81 km/h** — `brakeForce` is
   * 7000 N and the engine simply out-pulls it. So "the outside cannot be toured" was true from rest
   * (12 km/h at every depth) and false for a car that arrives fast, which is how a player gets
   * there. The refusal is the other half of the same limiter.
   *
   * It is exempt under exactly the same condition as the brake, so nothing about driving home is
   * refused: a car predominantly inward faster than a crawl keeps everything. Below the crawl the
   * throttle is untouched, so a stationary car can always get moving — which is what the whole of
   * this section exists to protect.
   */
  if (!homing && speed > FENCE_CRAWL_MS) throttle = 0;
  const brake = Math.max(controls.brake ?? 0, leavingK, crawlK);
  return { controls: { ...controls, throttle, brake }, out: +out.toFixed(2), held: true,
    // `leaving` is any outward motion at all, which is what it always meant; the BRAKE is what
    // stopped being a step. Kept because both hosts and the gate report it.
    leaving: outV > 0, homing, outward: +dot.toFixed(3), outwardMs: +outV.toFixed(4),
    /**
     * THE PREDICATE THE REFUSAL USES, published rather than left to be re-derived from `outward`.
     *
     * `outward` is rounded to three decimals for reporting, and at a nose exactly tangential the
     * true dot is 6.1e-17 — positive, so forward IS refused — while the rounded field reads 0.000.
     * `composeFence` keyed its verb off the rounded value and so said "drive" at the one angle
     * where driving is taken away. `blocker-test` §12 caught it by comparing the word against the
     * refusal instead of against an angle, which is the only version of that check that could.
     *
     * One expression, read by the refusal above and by the band's verb, so they cannot disagree at
     * any angle rather than agreeing at the ones somebody sampled.
     */
    noseOut: dot > 0,
    // Which term is holding the car, so a gate and a reader can tell them apart.
    leavingK: +leavingK.toFixed(3), crawlK: +crawlK.toFixed(3) };
}
