// #140's arithmetic: how far a lamp globe's SILHOUETTE departs from a sphere's, read off pixels.
// No node imports, so the gate's page (tools/globe-round.html) imports it and the district probe
// (tools/globe-round.mjs --district) passes it into the live page as SOURCE, the way globe-order
// passes tools/globe-math.mjs. Every function here is self-contained apart from calls to the others.
//
// THE FRAME IS ANGULAR, NOT THE SCREEN'S, AND THAT IS THE WHOLE INSTRUMENT. A sphere seen through a
// pinhole projects to an ELLIPSE, stretched away from the image centre by 1 / cos(theta), theta its
// angle off the optical axis. The reviewer's globe at fivepoints sits about 35 degrees off axis in
// that framing's 48-degree lens, where the stretch is x1.22: a circle fitted in SCREEN pixels would
// read a perfect sphere there as about 18% out of round, the same order as the 20-facet polygon it is
// meant to condemn (24.5%). What IS constant round an exact sphere's outline is the angle between a
// ray grazing it and the ray to its centre, asin(r / d). So every edge point is carried to the
// gnomonic plane perpendicular to the centre ray, at unit distance, where a sphere's outline is
// exactly a circle of radius tan(asin(r / d)) — and the circle is fitted there. The selftest has the
// screen-space fit as a KNOWN-BAD instrument, failing on an exact sphere.
//
// TWO READINGS OF ONE EDGE, both off rendered pixels:
//   silhouetteProfile  a binary coverage mask rendered k times magnified (setViewOffset), so an edge
//                      is placed to 1/(2k) of a native pixel. This is the geometry's own outline.
//   radialEdge         a luminance plane at native resolution — the scene target as it was drawn,
//                      multisampled — read along rays from the centre for the crossing of the level
//                      halfway between the globe's inside and the background. This is what a frame
//                      shows, and it is bounded by the pixel grid (and at night by nothing: the
//                      displayed edge there is the bloom's, which is why the HDR plane is read).
// Both end in `roundness`, which takes the edge points in the rectified plane.

/** Perspective camera of vertical fov `fov` degrees over a W x H frame: the view-space ray through
 *  NATIVE pixel coordinate (X right, Y down, a pixel's centre at +0.5). Not normalised. */
export function cropRay(X, Y, cam) {
  const t = Math.tan(cam.fov * Math.PI / 360), a = cam.W / cam.H;
  return [(2 * X / cam.W - 1) * t * a, (1 - 2 * Y / cam.H) * t, -1];
}

/** View-space direction -> native pixel coordinates (X right, Y down). */
export function rayPixel(d, cam) {
  const t = Math.tan(cam.fov * Math.PI / 360), a = cam.W / cam.H;
  const nx = d[0] / -d[2], ny = d[1] / -d[2];
  return [(nx / (t * a) + 1) * cam.W / 2, (1 - ny / t) * cam.H / 2];
}

/** An orthonormal frame about the ray to `centre` (view space): c along it, u roughly screen-right,
 *  v roughly screen-up. Gnomonic coordinates of a direction d are (d.u, d.v) / (d.c). */
export function rectFrame(centre) {
  const n = Math.hypot(centre[0], centre[1], centre[2]);
  const c = [centre[0] / n, centre[1] / n, centre[2] / n];
  // u = normalise(up x (-c))... built as cross(c, up) flipped so it points screen-right when the
  // centre is ahead: for c = (0,0,-1), cross((0,1,0), (0,0,1)) = (1,0,0).
  const up = Math.abs(c[1]) < 0.99 ? [0, 1, 0] : [1, 0, 0];
  const w = [-c[0], -c[1], -c[2]];
  let u = [up[1] * w[2] - up[2] * w[1], up[2] * w[0] - up[0] * w[2], up[0] * w[1] - up[1] * w[0]];
  const un = Math.hypot(u[0], u[1], u[2]);
  u = [u[0] / un, u[1] / un, u[2] / un];
  const v = [w[1] * u[2] - w[2] * u[1], w[2] * u[0] - w[0] * u[2], w[0] * u[1] - w[1] * u[0]];
  return { c, u, v, dist: n };
}

/** A direction's gnomonic coordinates in a rectFrame, or null behind it. */
export function rectify(d, F) {
  const dc = d[0] * F.c[0] + d[1] * F.c[1] + d[2] * F.c[2];
  if (!(dc > 1e-9)) return null;
  return [(d[0] * F.u[0] + d[1] * F.u[1] + d[2] * F.u[2]) / dc, (d[0] * F.v[0] + d[1] * F.v[1] + d[2] * F.v[2]) / dc];
}

/** Gnomonic coordinates back to a view-space direction. */
export function unrectify(p, F) {
  return [F.c[0] + p[0] * F.u[0] + p[1] * F.v[0], F.c[1] + p[0] * F.u[1] + p[1] * F.v[1],
    F.c[2] + p[0] * F.u[2] + p[1] * F.v[2]];
}

/**
 * The 4-connected component of a mask (rows TOP-DOWN, nonzero = subject) holding the pixel nearest
 * (sx, sy) that is set — searched within `reach` pixels — so a second globe in the same crop is not
 * read as part of the first. Returns { comp: Uint8Array, n, touches } or null when nothing is set
 * near the seed. `touches` is true if the component reaches the crop's border, i.e. it is clipped.
 */
export function maskComponent(mask, w, h, sx, sy, reach = 8) {
  let seed = -1, best = Infinity;
  const x0 = Math.max(0, Math.floor(sx - reach)), x1 = Math.min(w - 1, Math.ceil(sx + reach));
  const y0 = Math.max(0, Math.floor(sy - reach)), y1 = Math.min(h - 1, Math.ceil(sy + reach));
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    if (!mask[y * w + x]) continue;
    const d = Math.hypot(x + 0.5 - sx, y + 0.5 - sy);
    if (d < best) { best = d; seed = y * w + x; }
  }
  if (seed < 0) return null;
  const comp = new Uint8Array(w * h);
  const stack = [seed];
  comp[seed] = 1;
  let n = 0, touches = false;
  while (stack.length) {
    const i = stack.pop();
    n++;
    const x = i % w, y = (i / w) | 0;
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
    if (x > 0 && mask[i - 1] && !comp[i - 1]) { comp[i - 1] = 1; stack.push(i - 1); }
    if (x < w - 1 && mask[i + 1] && !comp[i + 1]) { comp[i + 1] = 1; stack.push(i + 1); }
    if (y > 0 && mask[i - w] && !comp[i - w]) { comp[i - w] = 1; stack.push(i - w); }
    if (y < h - 1 && mask[i + w] && !comp[i + w]) { comp[i + w] = 1; stack.push(i + w); }
  }
  return { comp, n, touches };
}

/** The OUTER edge of a component: the midpoint between every 4-neighbour pair of pixel centres one of
 *  which is in and one out, in the crop's own pixel coordinates (x right, y down, centres at +0.5).
 *  Holes are kept out by flood-filling the outside from the border first. */
export function maskEdges(comp, w, h) {
  const out = new Uint8Array(w * h);
  const stack = [];
  for (let x = 0; x < w; x++) for (const y of [0, h - 1]) { const i = y * w + x; if (!comp[i] && !out[i]) { out[i] = 1; stack.push(i); } }
  for (let y = 0; y < h; y++) for (const x of [0, w - 1]) { const i = y * w + x; if (!comp[i] && !out[i]) { out[i] = 1; stack.push(i); } }
  while (stack.length) {
    const i = stack.pop();
    const x = i % w, y = (i / w) | 0;
    for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1]) {
      if (j >= 0 && !comp[j] && !out[j]) { out[j] = 1; stack.push(j); }
    }
  }
  const pts = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x;
    if (x + 1 < w && ((comp[i] && out[i + 1]) || (out[i] && comp[i + 1]))) pts.push([x + 1, y + 0.5]);
    if (y + 1 < h && ((comp[i] && out[i + w]) || (out[i] && comp[i + w]))) pts.push([x + 0.5, y + 1]);
  }
  return pts;
}

/** Algebraic (Kasa) least-squares circle through 2D points: { a, b, R } or null. */
export function fitCircle(pts) {
  const n = pts.length;
  if (n < 3) return null;
  let mx = 0, my = 0;
  for (const p of pts) { mx += p[0]; my += p[1]; }
  mx /= n; my /= n;
  let suu = 0, svv = 0, suv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (const p of pts) {
    const u = p[0] - mx, v = p[1] - my;
    suu += u * u; svv += v * v; suv += u * v;
    suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (!(Math.abs(det) > 1e-30)) return null;
  const r1 = (suuu + suvv) / 2, r2 = (svvv + svuu) / 2;
  const uc = (r1 * svv - r2 * suv) / det, vc = (suu * r2 - suv * r1) / det;
  return { a: uc + mx, b: vc + my, R: Math.sqrt(uc * uc + vc * vc + (suu + svv) / n) };
}

/**
 * THE METRIC, on edge points already in the gnomonic plane of the globe's centre ray, where an exact
 * sphere's outline is a circle of radius tanA = tan(asin(r / d)) centred on the origin.
 *   dev     (max rho - min rho) / max rho about the TRUE centre — the statistic of the offline
 *           silhouette study (scratchpad g140/silhouette.mjs), so the two instruments compare
 *   fitDev  (max - min) of the residuals from a circle FITTED to the points, over its radius
 *   rms     their RMS over the radius
 *   size    the fitted radius over tanA: 1 for a sphere of the stated radius; a polygon inscribed in
 *           it reads under 1, which is what makes this a check on the instrument as well
 *   off     the fitted centre's distance from the true one, over tanA
 *   profile mean rho / tanA in `bins` sectors of azimuth (screen-right = 0, counter-clockwise up)
 * Null with fewer than 16 points: no outline is not a round outline.
 */
export function roundness(pts, tanA, bins = 72) {
  if (!(pts.length >= 16) || !(tanA > 0)) return null;
  let rmin = Infinity, rmax = 0;
  const sum = new Float64Array(bins), cnt = new Float64Array(bins);
  for (const p of pts) {
    const r = Math.hypot(p[0], p[1]);
    if (r < rmin) rmin = r;
    if (r > rmax) rmax = r;
    let k = Math.floor((Math.atan2(p[1], p[0]) / (2 * Math.PI) + 1) * bins) % bins;
    sum[k] += r; cnt[k]++;
  }
  const fit = fitCircle(pts);
  if (!fit) return null;
  let emin = Infinity, emax = -Infinity, e2 = 0;
  for (const p of pts) {
    const e = Math.hypot(p[0] - fit.a, p[1] - fit.b) - fit.R;
    if (e < emin) emin = e;
    if (e > emax) emax = e;
    e2 += e * e;
  }
  const profile = Array.from(sum, (s, i) => (cnt[i] ? +(s / cnt[i] / tanA).toFixed(5) : null));
  const filled = profile.filter((v) => v !== null).length;
  return { n: pts.length, dev: (rmax - rmin) / rmax, fitDev: (emax - emin) / fit.R, rms: Math.sqrt(e2 / pts.length) / fit.R,
    size: fit.R / tanA, off: Math.hypot(fit.a, fit.b) / tanA, rmin: rmin / tanA, rmax: rmax / tanA, filled, bins, profile };
}

/**
 * Where the globe is in a camera: its view-space centre `centre` and radius `radius` (metres), in a
 * frame `cam` = { W, H, fov }. Returns the angular radius, the gnomonic radius tanA, the projected
 * centre in native pixels, the angle off the optical axis, and the outline's two semi-axes in native
 * pixels — tangential and radial, which differ by 1 / cos(theta) for an exact sphere.
 */
export function globeOnScreen(centre, radius, cam) {
  const F = rectFrame(centre);
  const alpha = Math.asin(Math.min(1, radius / F.dist));
  const tanA = Math.tan(alpha);
  const f = (cam.H / 2) / Math.tan(cam.fov * Math.PI / 360);
  const cosT = -F.c[2];
  const [sx, sy] = rayPixel(F.c, cam);
  return { dist: F.dist, alpha, tanA, sx, sy, theta: Math.acos(Math.max(-1, Math.min(1, cosT))),
    rTan: f * tanA / cosT, rRad: f * tanA / (cosT * cosT), f };
}

/**
 * THE GEOMETRY'S OUTLINE, off a magnified coverage mask. `crop` = { W, H, fov, k, x0, y0 }: the mask
 * covers native pixels from (x0, y0), k mask pixels to a native one (rendered with setViewOffset at
 * k times the frame). `mask` rows are TOP-DOWN. Returns roundness(...) plus where it was read, or
 * { refused } when the outline is missing, clipped by the crop, or too small to read.
 */
export function silhouetteProfile(mask, w, h, crop, centre, radius, bins = 72) {
  const g = globeOnScreen(centre, radius, crop);
  const F = rectFrame(centre);
  const seedX = (g.sx - crop.x0) * crop.k, seedY = (g.sy - crop.y0) * crop.k;
  const C = maskComponent(mask, w, h, seedX, seedY, Math.max(8, g.rTan * crop.k * 0.5));
  if (!C) return { refused: 'nothing drawn near the projected centre', globe: g };
  if (C.touches) return { refused: 'the outline reaches the crop border', globe: g };
  const edges = maskEdges(C.comp, w, h);
  const pts = [];
  for (const [ex, ey] of edges) {
    const p = rectify(cropRay(crop.x0 + ex / crop.k, crop.y0 + ey / crop.k, crop), F);
    if (p) pts.push(p);
  }
  const r = roundness(pts, g.tanA, bins);
  if (!r) return { refused: `${pts.length} edge points`, globe: g };
  return { ...r, pixels: C.n, globe: g, resolution: 0.5 / crop.k };
}

/**
 * WHAT A FRAME SHOWS, off a luminance plane at native resolution (rows TOP-DOWN, `crop` as above with
 * k = 1 and x0 = y0 = 0 for a whole frame). Along `rays` azimuths from the centre ray the plane is
 * sampled bilinearly in the gnomonic plane, and the edge is the first crossing, going outward, of the
 * level halfway between the globe's inside (median within 0.5 tanA) and the background (median in
 * 1.6 - 2.0 tanA). A ray that never crosses is counted, not invented. Refused when the inside and the
 * background differ by under `minContrast` of the larger: no edge is not a round edge.
 */
export function radialEdge(plane, w, h, crop, centre, radius, opts = {}) {
  const rays = opts.rays ?? 180, bins = opts.bins ?? 72, minContrast = opts.minContrast ?? 0.1, keepAll = !!opts.keepOccluded;
  const g = globeOnScreen(centre, radius, crop);
  const F = rectFrame(centre);
  const sample = (p) => {
    const [X, Y] = rayPixel(unrectify(p, F), crop);
    const u = (X - crop.x0) * crop.k - 0.5, v = (Y - crop.y0) * crop.k - 0.5;
    const i = Math.floor(u), j = Math.floor(v);
    if (i < 0 || j < 0 || i + 1 >= w || j + 1 >= h) return NaN;
    const fu = u - i, fv = v - j;
    const q = (a, b) => plane[b * w + a];
    return (q(i, j) * (1 - fu) + q(i + 1, j) * fu) * (1 - fv) + (q(i, j + 1) * (1 - fu) + q(i + 1, j + 1) * fu) * fv;
  };
  const med = (lo, hi) => {
    const vals = [];
    for (let k = 0; k < 24; k++) for (let a = 0; a < 48; a++) {
      const rr = (lo + (hi - lo) * (k + 0.5) / 24) * g.tanA, ps = 2 * Math.PI * (a + 0.5) / 48;
      const s = sample([rr * Math.cos(ps), rr * Math.sin(ps)]);
      if (Number.isFinite(s)) vals.push(s);
    }
    vals.sort((x, y) => x - y);
    return vals.length ? vals[vals.length >> 1] : NaN;
  };
  const inside = med(0, 0.5), outside = med(1.6, 2.0);
  if (!Number.isFinite(inside) || !Number.isFinite(outside)) return { refused: 'the globe is not inside the plane', globe: g };
  const contrast = Math.abs(inside - outside) / Math.max(Math.abs(inside), Math.abs(outside), 1e-12);
  if (!(contrast >= minContrast)) return { refused: `contrast ${contrast.toFixed(3)} under ${minContrast}`, globe: g, inside, outside };
  const level = (inside + outside) / 2, sgn = inside > outside ? 1 : -1;
  const pts = [];
  let missed = 0, occluded = 0;
  const step = g.tanA / 400;
  const span = Math.abs(inside - outside);
  for (let a = 0; a < rays; a++) {
    const ps = 2 * Math.PI * (a + 0.5) / rays, cx = Math.cos(ps), cy = Math.sin(ps);
    // A RAY WHOSE OUTSIDE IS NOT THE BACKGROUND IS NOT READ. In a frame the globe hangs on a bracket in
    // front of a pole, a facade or a tree, and along a ray that leaves the globe onto the bracket the
    // crossing is the bracket's far edge, not the globe's: the first district run read the fivepoints
    // globe at "0.53" for exactly that. Both ends of the ray have to look like what they are meant to be.
    const ends = (lo, hi) => {
      const v = [lo, (lo + hi) / 2, hi].map((t) => sample([t * g.tanA * cx, t * g.tanA * cy])).filter(Number.isFinite);
      v.sort((x, y) => x - y);
      return v.length ? v[v.length >> 1] : NaN;
    };
    const ext = ends(1.6, 2.0), int = ends(0.1, 0.4);
    if (!keepAll && (!(Math.abs(ext - outside) <= 0.3 * span) || !(Math.abs(int - inside) <= 0.3 * span))) { occluded++; continue; }
    let prev = sample([0.4 * g.tanA * cx, 0.4 * g.tanA * cy]), found = null;
    for (let rr = 0.4 * g.tanA + step; rr <= 1.6 * g.tanA; rr += step) {
      const s = sample([rr * cx, rr * cy]);
      if (!Number.isFinite(s) || !Number.isFinite(prev)) { prev = s; continue; }
      if (sgn * (prev - level) > 0 && sgn * (s - level) <= 0) {
        found = rr - step * (sgn * (s - level) === 0 ? 0 : (level - s) / (prev - s));
        break;
      }
      prev = s;
    }
    if (found === null) { missed++; continue; }
    // And the crossing has to be a step from the globe straight to the background: a ray that leaves the
    // globe onto a facade and then onto the sky crosses the level at the FACADE's edge, with sky at both
    // of the ends checked above.
    // "Straight" is a pixel and a half either side of it, the width of an anti-aliased edge.
    const just = (t) => sample([t * g.tanA * cx, t * g.tanA * cy]);
    const dt = 1.5 / g.rTan;
    if (!keepAll && (!(Math.abs(just(found / g.tanA + dt) - outside) <= 0.3 * span) ||
      !(Math.abs(just(found / g.tanA - dt) - inside) <= 0.3 * span))) { occluded++; continue; }
    pts.push([found * cx, found * cy]);
  }
  if (occluded > rays / 2) return { refused: `${occluded} of ${rays} rays leave the globe onto something that is not its background`, globe: g, inside, outside, occluded };
  const r = roundness(pts, g.tanA, bins);
  if (!r) return { refused: `${pts.length} edges of ${rays} rays`, globe: g, inside, outside };
  return { ...r, missed, occluded, rays, inside, outside, contrast, globe: g };
}

/** The convex hull of 2D points (monotone chain), counter-clockwise. */
export function hull2(pts) {
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

/**
 * THE SECOND PROTOCOL: the same statistic off the GEOMETRY, with no pixels at all. Central projection
 * takes a convex polyhedron to the convex hull of its vertices' projections, and the gnomonic plane
 * is such a projection, so the hull of the vertices there IS the outline. `vertsView` are the globe's
 * vertices in view space. Returns { sides, dev } with dev about the true centre (the hull's radial
 * extremes: its vertices and its edges' nearest points).
 */
export function hullRoundness(vertsView, centre) {
  const F = rectFrame(centre);
  const pts = vertsView.map((q) => rectify(q, F)).filter(Boolean);
  const H = hull2(pts);
  let rmin = Infinity, rmax = 0;
  for (let i = 0; i < H.length; i++) {
    const a = H[i], b = H[(i + 1) % H.length];
    rmax = Math.max(rmax, Math.hypot(a[0], a[1]));
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, -(a[0] * dx + a[1] * dy) / (dx * dx + dy * dy)));
    rmin = Math.min(rmin, Math.hypot(a[0] + t * dx, a[1] + t * dy));
  }
  return { sides: H.length, dev: (rmax - rmin) / rmax, rmax, rmin };
}
