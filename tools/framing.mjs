// The hero framings, and the ONE placement routine every harness must use.
//
// tools/hero-shots.mjs carries a long comment explaining that `back: 34` puts the
// corridor camera 3.7 m inside building 67, that walls are single-sided so from
// in there the block's own facades vanish and its awnings and parapet are left
// hanging over the street with nothing under them, and that three rounds of blind
// critics reported that frame as floating props and an untethered rooftop slab.
// It fixed that with a clearance loop.
//
// Then tools/sun-sweep.mjs, tools/sun-share.mjs and tools/weather-shots.mjs each
// copied the framing CONSTANTS out of that file and left the loop behind. All
// three measured from inside building 67, and the defect only surfaced because a
// weather capture was finally looked at rather than reduced to a number.
//
// A comment cannot stop the next harness from doing it again; a shared module
// can. Import the framings from here and place the camera with placeCamera().
// Nothing in tools/ should define `back` and `side` for itself.

/** Framings judged as hero views. `back` is a REQUEST - placeCamera may pull in. */
export const SHOTS = {
  corridor:   { wpA: 2, wpB: 4, back: 34, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  fivepoints: { wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
};

/** Metres of pavement required around the camera. */
export const MIN_CLEAR = 3.0;

/**
 * Runs INSIDE the page - pass it straight to page.evaluate(placeCamera, cfg).
 * It must therefore close over nothing but its argument.
 *
 * Walks `back` in toward the waypoint until the camera has MIN_CLEAR metres of
 * clearance from every building footprint, then aims it down the street. Returns
 * where it ended up and how much room it found, so callers can report it: a hero
 * shot is a measuring instrument, and one standing inside a wall manufactures
 * exactly the defect class it is being used to look for.
 */
export function placeCamera(cfg) {
  const r = __district.district.meta.route;
  const a = r[cfg.wpA], b = r[cfg.wpB];
  const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
  const nx = -dz / len, nz = dx / len;

  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
      if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  // Signed clearance to the nearest footprint: negative inside, metres outside.
  // Distance, not just in/out - a camera pressed flat against a wall is as
  // useless a hero frame as one buried in it.
  const segDist = (px, pz, x0, z0, x1, z1) => {
    const vx = x1 - x0, vz = z1 - z0;
    const l2 = vx * vx + vz * vz;
    const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0;
    return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t));
  };
  const clearance = (x, z) => {
    const [cx, cz] = __district.world.keyOf(x, z).split(',').map(Number);
    let best = Infinity, worst = -1;
    for (let ddz = -1; ddz <= 1; ddz++) {
      for (let ddx = -1; ddx <= 1; ddx++) {
        const c = __district.district.chunks[`${cx + ddx},${cz + ddz}`];
        if (!c) continue;
        for (const bi of c.buildings) {
          const ring = __district.district.buildings[bi].p;
          let d = Infinity;
          for (let i = 0; i < ring.length; i++) {
            const A = ring[i], B = ring[(i + 1) % ring.length];
            d = Math.min(d, segDist(x, z, A[0], A[1], B[0], B[1]));
          }
          if (inRing(ring, x, z)) { worst = bi; d = -d; }
          if (d < best) best = d;
        }
      }
    }
    return { d: best === Infinity ? 99 : best, inside: worst };
  };

  const MIN = 3.0;
  let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
  for (;;) {
    px = a.x - (dx / len) * back + nx * cfg.side;
    pz = a.z - (dz / len) * back + nz * cfg.side;
    cl = clearance(px, pz);
    if (cl.d >= MIN || back <= 8) break;
    back -= 1;
  }
  const hit = cl.inside;

  __district.placeAt(a.x, a.z);
  __district.setAutopilot(() => {});
  __district.freeCam([px, cfg.height, pz],
    [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd], cfg.fov);
  for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
  return {
    back, requestedBack: cfg.back, x: +px.toFixed(1), z: +pz.toFixed(1),
    clearance: +cl.d.toFixed(1), stillInside: cl.d >= MIN ? -1 : hit,
    // Which way the lens points, so a harness can say how far off it the sun is
    // instead of assuming.
    headingDeg: +((Math.atan2(dz, dx) * 180) / Math.PI).toFixed(1),
  };
}

/** One line describing where a placement ended up, for harness logs. */
export function describe(name, p) {
  return `${name}: camera at (${p.x}, ${p.z}), back ${p.back}, ${p.clearance} m clear, ` +
    `heading ${p.headingDeg} deg` +
    (p.back !== p.requestedBack ? ` (pulled in from ${p.requestedBack})` : '') +
    (p.stillInside >= 0 ? `  WARNING: still inside building ${p.stillInside}` : '');
}
