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
