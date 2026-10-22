// #136's arithmetic, with no node imports, so the district probe (tools/globe-order.mjs) and the gate
// page (tools/globe-level.html) run ONE definition of each quantity. Passed into the district page as
// SOURCE, the way tools/bloom-math.mjs is, because that page has no import map.
//
// THE QUANTITY. A street lamp is two things the renderer keeps apart: a PointLight the LightPool
// places at the outer globe's centre (candela, in three's physical units), and the globe itself, an
// emissive mesh (nits). Nothing tied them together, so the globe drew at 1.76 nits while its light
// lit a wall five metres away brighter than that. The tie is energy: a Lambertian emitter of
// luminance L and surface area S radiates pi * L * S lumens, an isotropic point source of intensity
// I radiates 4 * pi * I, so the globe that radiates its own light's flux has
//
//     L = 4 I / S = I / (S / 4)
//
// and S / 4 is the mean projected area of a convex body (Cauchy), which is pi r^2 for a sphere and
// less for the 20-triangle globe the module draws. Every quantity below is luminance (Rec. 709 Y in
// three's linear working space), because the comparison a viewer makes is per pixel.

/** Rec. 709 luminance of a linear RGB triple. */
export function luma(r, g, b) { return 0.2126 * r + 0.7152 * g + 0.0722 * b; }

/**
 * The surface area of a NON-INDEXED triangle list, read straight off a position buffer, and the
 * centre and radius of its vertices. `pick(x, y, z)` keeps a subset (one globe of two in a merged
 * head geometry): a triangle is kept when all three of its vertices pass.
 */
export function triangleArea(pos, pick = null) {
  let S = 0, n = 0, cx = 0, cy = 0, cz = 0, nv = 0;
  const kept = [];
  for (let i = 0; i + 8 < pos.length; i += 9) {
    const ax = pos[i], ay = pos[i + 1], az = pos[i + 2];
    const bx = pos[i + 3], by = pos[i + 4], bz = pos[i + 5];
    const qx = pos[i + 6], qy = pos[i + 7], qz = pos[i + 8];
    if (pick && !(pick(ax, ay, az) && pick(bx, by, bz) && pick(qx, qy, qz))) continue;
    const ux = bx - ax, uy = by - ay, uz = bz - az, vx = qx - ax, vy = qy - ay, vz = qz - az;
    const cxp = uy * vz - uz * vy, cyp = uz * vx - ux * vz, czp = ux * vy - uy * vx;
    S += Math.hypot(cxp, cyp, czp) / 2;
    n++;
    for (const [x, y, z] of [[ax, ay, az], [bx, by, bz], [qx, qy, qz]]) { cx += x; cy += y; cz += z; nv++; kept.push(x, y, z); }
  }
  if (!nv) return { area: 0, triangles: 0, centre: null, radius: 0 };
  cx /= nv; cy /= nv; cz /= nv;
  let r = 0;
  for (let i = 0; i < kept.length; i += 3) r = Math.max(r, Math.hypot(kept[i] - cx, kept[i + 1] - cy, kept[i + 2] - cz));
  return { area: S, triangles: n, centre: [cx, cy, cz], radius: r };
}

/**
 * The luminance a globe of mean projected area `meanArea` (m^2) must have to radiate the flux of a
 * point light of `candela` in colour `lightRGB` (linear). The light's luminous intensity is its
 * candela times its colour's luminance, because three multiplies the two.
 */
export function physicalLuminance(candela, lightRGB, meanArea) {
  if (!(meanArea > 0)) return NaN;
  return candela * luma(lightRGB[0], lightRGB[1], lightRGB[2]) / meanArea;
}

/**
 * The radial profile of one plane (rows BOTTOM-UP, as readRenderTargetPixels returns them) about a
 * SCREEN point (top-down y), as the mean over each one-pixel ring out to rMax.
 */
export function radialProfile(plane, w, h, cx, cy, rMax) {
  const sum = new Float64Array(rMax + 1), cnt = new Float64Array(rMax + 1);
  const x0 = Math.max(0, Math.floor(cx - rMax)), x1 = Math.min(w - 1, Math.ceil(cx + rMax));
  const y0 = Math.max(0, Math.floor(cy - rMax)), y1 = Math.min(h - 1, Math.ceil(cy + rMax));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const r = Math.round(Math.hypot(x + 0.5 - cx, y + 0.5 - cy));
      if (r > rMax) continue;
      sum[r] += plane[(h - 1 - y) * w + x];
      cnt[r]++;
    }
  }
  return Array.from(sum, (s, i) => (cnt[i] ? s / cnt[i] : null));
}

/**
 * The first radius, past the profile's peak, at which it falls under each level — the footprint of a
 * glare at that level. null where it never rises above the level (no footprint) and Infinity where it
 * never falls under it inside the profile (the profile was too short to say).
 */
export function footprint(profile, levels) {
  let peak = 0, at = 0;
  profile.forEach((v, i) => { if (v !== null && v > peak) { peak = v; at = i; } });
  return levels.map((lv) => {
    if (!(peak > lv)) return null;
    for (let i = at; i < profile.length; i++) if (profile[i] !== null && profile[i] < lv) return i;
    return Infinity;
  });
}

/** Quantiles of a list, with its length and maximum: { n, max, p50, p90, p99, p999 }. */
export function quantilesOf(vals, qs = [0.5, 0.9, 0.99, 0.999]) {
  if (!vals.length) return null;
  const a = Float64Array.from(vals).sort();
  const out = { n: a.length, max: a[a.length - 1] };
  for (const q of qs) out['p' + String(q * 100).replace('.', '_')] = a[Math.min(a.length - 1, Math.floor(q * a.length))];
  return out;
}

/**
 * The AREA a glare covers at each level, as the radius of a disc of that area: every pixel within rMax
 * of the SCREEN point (cx, cy) whose plane value is at least the level, and — when `other` is given —
 * nearer (cx, cy) than `other`, so the lamp's second globe is not counted as the first one's halo. An
 * area and not a crossing, because a profile with two peaks (two globes, or a globe beside a lit disc)
 * has no single "first radius past the peak", and the first version of this read the far camera's
 * twin globes as one halo three times the size of either.
 */
export function footprintArea(plane, w, h, cx, cy, rMax, levels, other = null) {
  const n = levels.map(() => 0);
  const x0 = Math.max(0, Math.floor(cx - rMax)), x1 = Math.min(w - 1, Math.ceil(cx + rMax));
  const y0 = Math.max(0, Math.floor(cy - rMax)), y1 = Math.min(h - 1, Math.ceil(cy + rMax));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, dy = y + 0.5 - cy;
      if (dx * dx + dy * dy > rMax * rMax) continue;
      if (other && Math.hypot(x + 0.5 - other[0], y + 0.5 - other[1]) < Math.hypot(dx, dy)) continue;
      const v = plane[(h - 1 - y) * w + x];
      levels.forEach((lv, i) => { if (v >= lv) n[i]++; });
    }
  }
  return n.map((k) => Math.sqrt(k / Math.PI));
}
