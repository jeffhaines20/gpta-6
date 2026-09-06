// Footprint -> mesh helpers. Ear-clipping is enough here: OSM footprints are
// small, simple polygons, and this keeps the runtime dependency-free.

export function signedArea(ring) {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
  }
  return a / 2;
}

export function triangulate(ring) {
  const n = ring.length;
  if (n < 3) return [];
  const idx = [...Array(n).keys()];
  if (signedArea(ring) > 0) idx.reverse();          // work counter-clockwise
  const out = [];
  const cross = (o, a, b) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const inTri = (p, a, b, c) => {
    const d1 = cross(a, b, p), d2 = cross(b, c, p), d3 = cross(c, a, p);
    const neg = d1 < 0 || d2 < 0 || d3 < 0, pos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(neg && pos);
  };
  let guard = 0;
  while (idx.length > 3 && guard++ < n * n) {
    let clipped = false;
    for (let i = 0; i < idx.length; i++) {
      const ia = idx[(i + idx.length - 1) % idx.length], ib = idx[i], ic = idx[(i + 1) % idx.length];
      const a = ring[ia], b = ring[ib], c = ring[ic];
      if (cross(a, b, c) <= 0) continue;             // reflex
      let ok = true;
      for (const j of idx) {
        if (j === ia || j === ib || j === ic) continue;
        if (inTri(ring[j], a, b, c)) { ok = false; break; }
      }
      if (!ok) continue;
      out.push(ia, ib, ic);
      idx.splice(i, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;                             // degenerate: bail safely
  }
  if (idx.length === 3) out.push(idx[0], idx[1], idx[2]);
  return out;
}

// Extrude a footprint into walls + roof, appending into shared arrays so a whole
// chunk of buildings lands in ONE geometry (and therefore one draw call).
export function extrudeFootprint(ring, height, pos, nrm, uv, idxArr, base = 0) {
  let start = pos.length / 3;
  const n = ring.length;
  // Walls
  for (let i = 0; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = dz / len, nz = -dx / len;
    const v = pos.length / 3;
    pos.push(a[0], base, a[1], b[0], base, b[1], b[0], base + height, b[1], a[0], base + height, a[1]);
    for (let k = 0; k < 4; k++) nrm.push(nx, 0, nz);
    // UVs in metres so texture density is constant regardless of building size.
    uv.push(0, 0, len, 0, len, height, 0, height);
    idxArr.push(v, v + 1, v + 2, v, v + 2, v + 3);
  }
  // Roof
  const tris = triangulate(ring);
  start = pos.length / 3;
  for (const p of ring) { pos.push(p[0], base + height, p[1]); nrm.push(0, 1, 0); uv.push(p[0] * 0.25, p[1] * 0.25); }
  for (let i = 0; i < tris.length; i += 3) {
    idxArr.push(start + tris[i], start + tris[i + 1], start + tris[i + 2]);
  }
}

// A flat quad ribbon along a polyline: how road edges become drivable surface.
export function ribbon(points, width, y, pos, nrm, uv, idxArr) {
  const half = width / 2;
  let dist = 0;
  const left = [], right = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    const prev = points[i - 1] ?? p, next = points[i + 1] ?? p;
    let dx = next.x - prev.x, dz = next.z - prev.z;
    const len = Math.hypot(dx, dz) || 1;
    dx /= len; dz /= len;
    left.push({ x: p.x + dz * half, z: p.z - dx * half });
    right.push({ x: p.x - dz * half, z: p.z + dx * half });
  }
  for (let i = 0; i < points.length; i++) {
    if (i > 0) dist += Math.hypot(points[i].x - points[i - 1].x, points[i].z - points[i - 1].z);
    const v = pos.length / 3;
    pos.push(left[i].x, y, left[i].z, right[i].x, y, right[i].z);
    nrm.push(0, 1, 0, 0, 1, 0);
    uv.push(0, dist / 8, 1, dist / 8);
    if (i > 0) idxArr.push(v - 2, v - 1, v + 1, v - 2, v + 1, v);
  }
}

// ----------------------------------------------------------------- frontage
//
// Which street does a building face? Five places needed this answer and all five
// had their own copy of the same wrong one -- nearest road VERTEX to the
// footprint centroid, searched within the building's own chunk. Measured over
// the district that is more than 45 degrees off on 348 of 519 buildings and
// broadly BACKWARDS (>120 degrees) on 99 of them, because a vertex is a junction
// or a polyline kink rather than the road: on a long straight block the fronting
// street may have no vertex within 200 m while a junction on the street behind
// sits 40 m away. Chunk-local search was a second, independent way to miss.
//
// It lives here, once, for the reason the same week produced twice over: a fault
// patched in one of its copies stays live in the other four, and the copies are
// exactly where nobody looks for it.
//
// tools/street-dir.mjs holds the old and new answers side by side with a
// self-test that isolates the failure.

/**
 * Road class tiers, following the convention streetfurniture.js already uses:
 * it dresses r <= 4 at main-street spacing, r 5 at side-street spacing, and
 * skips r > 5 entirely as alleys.
 *
 * A building fronts the STREET, not whatever tarmac happens to be nearest. This
 * distinction is the whole reason the tier exists: on this district a service
 * alley runs 3.5 m behind a Main Street block while Main Street itself is 11.7 m
 * away across a parking lane, so "nearest road wins" fronts the block onto the
 * alley and turns its back on the high street. That is not hypothetical -- it is
 * what the first version of streetDirFor() did to building #18, and it took an
 * independent observation to catch, because the district-wide statistic improved
 * while the hero view got worse.
 */
const roadTier = (r) => (r <= 4 ? 0 : r <= 5 ? 1 : 2);

/** Road segments within one chunk of (x, z), as [vertA, vertB, edge] triples. */
export function roadSegmentsNear(district, x, z) {
  const cs = district.meta.chunkSize;
  const ci = Math.floor(x / cs), cj = Math.floor(z / cs);
  const out = [];
  for (let i = ci - 1; i <= ci + 1; i++) {
    for (let j = cj - 1; j <= cj + 1; j++) {
      const ch = district.chunks[`${i},${j}`];
      if (!ch) continue;
      for (const ei of ch.edges) {
        const e = district.edges[ei];
        for (let k = 0; k + 1 < e.v.length; k++) {
          out.push([district.verts[e.v[k]], district.verts[e.v[k + 1]], e]);
        }
      }
    }
  }
  return out;
}

/**
 * Outward normal of the footprint edge that fronts the nearest street, or null.
 *
 * A building fronts the street its WALL looks at, so each edge is asked how far
 * along its own outward normal the nearest road lies. Roads behind a wall are
 * rejected outright; among the rest, an edge is scored on distance penalised by
 * how far off its normal the road sits, so a street squarely in front beats a
 * nearer one glimpsed edge-on.
 *
 * @param {Object} district parsed data/district.json
 * @param {{p:number[][]}} b building with footprint ring `p`
 * @returns {[number,number]|null} unit [nx, nz] pointing at the street
 */
// How close a road must be to a SECOND elevation before that elevation counts as
// a frontage in its own right. A corner shop stands on both streets; a mid-block
// building whose rear happens to point at a road two blocks away does not.
const SECOND_FRONTAGE_M = 22;

/**
 * The single best street elevation. Kept as the primary API; see streetDirsFor.
 */
export function streetDirFor(district, b) {
  const d = streetDirsFor(district, b, 1);
  return d.length ? d[0] : null;
}

/**
 * EVERY street elevation of a building, best first -- not just the winner.
 *
 * A corner site fronts two streets. facingEdges() selects front elevations with
 * a cone test around ONE direction (dot > 0.35, about 69 degrees), and a
 * corner's two street elevations are 90 degrees apart, so a single direction can
 * never admit both: the perpendicular one scores ~0 and is dropped. Widening the
 * cone is not a fix, because past 90 degrees it admits the back wall.
 *
 * A blind architectural reviewer found this as a REGRESSION introduced by the
 * frontage work: the Five Points corner block lost its awning, piers, stallriser
 * and recessed glazing and became a flat curtain wall with no entrance -- on the
 * most prominent building in that view. The massing was identical between the
 * two arms, so it was a removed facade rather than a different building. The
 * shopfront kit had gone to whichever single elevation the chosen direction
 * pointed at.
 */
export function streetDirsFor(district, b, max = 2) {
  let cx = 0, cz = 0;
  for (const [x, z] of b.p) { cx += x; cz += z; }
  cx /= b.p.length; cz /= b.p.length;
  const segs = roadSegmentsNear(district, cx, cz);
  if (!segs.length) return [];
  // signedArea() here is the trapezoid form and comes out NEGATIVE for the
  // winding this ring uses, which is the opposite of the shoelace sum. The sign
  // is pinned by the third case in tools/street-dir.mjs --selftest rather than
  // argued: an inward normal would face every shopfront into its own building
  // and still look like a perfectly good unit vector.
  const flip = signedArea(b.p) < 0 ? 1 : -1;
  // Best edge WITHIN each road tier. A better tier always wins outright, however
  // much closer the worse one is; distance only decides between roads of the
  // same standing. Falling through to tier 2 at all is what gives a building on
  // a service yard with no street frontage some sensible orientation.
  // Per-EDGE best score in each tier, kept so a corner site can return both of
  // its street elevations rather than only the winner. The scoring below is
  // unchanged; only the selection at the end is.
  const perEdge = [];
  for (let i = 0; i < b.p.length; i++) {
    const [x0, z0] = b.p[i], [x1, z1] = b.p[(i + 1) % b.p.length];
    const dx = x1 - x0, dz = z1 - z0;
    const len = Math.hypot(dx, dz);
    if (len < 3) continue;                        // a chamfer is not a frontage
    const nx = (dz / len) * flip, nz = (-dx / len) * flip;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const edgeBest = [Infinity, Infinity, Infinity];
    const edgeDist = [Infinity, Infinity, Infinity];
    for (const [a, c, e] of segs) {
      const ax = a.x, az = a.z;
      const sx = c.x - ax, sz = c.z - az;
      const L2 = sx * sx + sz * sz;
      const t = L2 > 0 ? Math.max(0, Math.min(1, ((mx - ax) * sx + (mz - az) * sz) / L2)) : 0;
      const qx = ax + sx * t, qz = az + sz * t;
      const along = (qx - mx) * nx + (qz - mz) * nz;
      if (along <= 0) continue;                   // the road is behind this wall
      const lateral = Math.hypot(qx - mx, qz - mz);
      // Distance, penalised for being off to the side, then divided by the
      // square root of the edge's own length: within one class of street, the
      // primary elevation is the one that shows the most wall to it. Without
      // this, building #18 chose its 31 m END wall over the 181 m Main Street
      // elevation beside it, because the end wall was two metres closer to the
      // same class of road -- geometrically true and architecturally absurd.
      // sqrt rather than the length itself, so a long rear wall cannot outbid a
      // short frontage standing right on the street.
      const score = lateral / Math.max(0.2, along / lateral) / Math.sqrt(len);
      const tier = roadTier(e?.r ?? 0);
      if (score < edgeBest[tier]) { edgeBest[tier] = score; edgeDist[tier] = lateral; }
    }
    const tier = edgeBest.findIndex((v) => v < Infinity);
    if (tier >= 0) perEdge.push({ n: [nx, nz], tier, score: edgeBest[tier], dist: edgeDist[tier] });
  }
  if (!perEdge.length) return [];
  perEdge.sort((a, b2) => (a.tier - b2.tier) || (a.score - b2.score));
  const primaryTier = perEdge[0].tier;
  const out = [];
  for (const c of perEdge) {
    // Only roads of the SAME standing as the primary can be a second frontage.
    // Without this a corner building would take a service alley as its second
    // street and put a parade of shopfronts down it, which is the defect
    // c29b9ef fixed for the primary and would have reintroduced by the back door.
    if (c.tier !== primaryTier) break;
    // A SECOND frontage has to actually stand on its street. Ranking alone is not
    // enough: roadSegmentsNear spans a 3x3 chunk neighbourhood, so almost every
    // elevation of every building has SOME road somewhere in front of it, and
    // taking the top two distinct directions duly reported all 523 buildings as
    // corner sites. The gate is the plain geometric one -- the road has to be
    // within SECOND_FRONTAGE_M of that elevation.
    if (out.length && c.dist > SECOND_FRONTAGE_M) break;
    // Same street if the two normals point within 25 degrees of each other.
    if (out.some((o) => o[0] * c.n[0] + o[1] * c.n[1] > 0.906)) continue;
    out.push(c.n);
    if (out.length >= max) break;
  }
  return out;
}
