// The hero cameras, shared.
//
// tools/hero-shots.mjs owned these and nothing else could reach them, so a probe that wanted "the
// corridor camera at night" had two choices: copy the placement into its own page.evaluate, or
// measure a different camera and call it the same one. The first is this repo's recurring defect
// (a second copy of a rule drifts from the first - tri-buckets exists because shadow-bill had
// copied tri-breakdown's regexes), and the second is how a number ends up about a frame nobody
// looked at. So the framings, the placement and the settle live here and both import them.
//
// Moved verbatim. hero-shots prints the same "camera at (...), back ..., ... m clear" line from
// the same return value, which is the check that the move changed nothing.

// SETTLE ON RENDERED FRAMES, NEVER ON WALL CLOCK.
//
// This file already knew the rule and applied it in exactly one place -- the
// arm switch below says "Rendered FRAMES after the uniforms were pushed, never
// milliseconds" -- while every other settle here was a waitForTimeout. That is
// the difference between an A/B whose two arms are registered and one whose
// arms are not.
//
// Why it matters more than it looks. district/main.js advances the world with
//   const dt = Math.min(0.05, (now - last) / 1000 || 0.016);
// and a SwiftShader frame takes seconds, so EVERY frame clamps to dt = 0.05.
// The simulation is therefore exactly deterministic in the frame COUNT: frame N
// is always world-time 0.05*N. Wait 14 wall-clock seconds and you get however
// many frames the box felt like giving you, which is a different world state in
// each arm -- pedestrians further along their paths, foliage at a different
// phase, traffic somewhere else.
//
// Measured on the car A/B this was found in. Two arms differing ONLY in
// src/carbody.js came back with 68-85% of upper-band pixels identical and
// differences spanning 900-1570 of 1600 columns. A car cannot change the sky.
// peds-in-frustum differed in all 8 pairs (2 vs 3, 16 vs 19) while cars, parked
// cars and trees matched, which is the signature of a world simulated for
// different lengths of time rather than of anything the diff did.
//
// `frames` is also now recorded in the audit, so registration is checkable after
// the fact instead of having to be inferred from the pixels.
export const FRAME_SETTLE = Number(process.env.HERO_SETTLE_FRAMES ?? 30);
export async function settleFrames(page, n = FRAME_SETTLE, why = '') {
  const f0 = await page.evaluate(() => __district.frames);
  await page.waitForFunction((t) => __district.frames >= t, f0 + n,
    { timeout: 600000, polling: 250 });

  // AND WAIT FOR THE STREAMER TO GO QUIET, which frames alone do not give you.
  //
  // streaming.js budgets its uploads against the WALL CLOCK -- `while
  // (performance.now() < deadline)` on a 3 ms slice -- so how much geometry
  // lands per frame depends on how fast the box was feeling. Two runs at the
  // same frame number therefore hold DIFFERENT resident sets, and the frame is
  // a picture of a half-built district in one arm and a differently-half-built
  // one in the other.
  //
  // That is what was left after seeding every generator: two runs of identical
  // code still differed, and a tile map put the differences in a few localised
  // patches rather than scattered everywhere -- 85.4% of one tile, nothing in
  // most of the others. Not noise; whole objects present in one arm and not the
  // other.
  //
  // `queued` counts the build queue plus the job in flight, `pendingUnload` the
  // chunks on the way out. Both zero, held for a few frames so a queue that is
  // briefly empty between two fills does not read as finished, means the
  // district the camera is looking at is fully built.
  const quiet = await page.waitForFunction(() => {
    const w = __district.worldReport();
    const idle = (w.queued | 0) === 0 && (w.pendingUnload | 0) === 0;
    window.__quietRun = idle ? (window.__quietRun ?? 0) + 1 : 0;
    return window.__quietRun >= 5;
  }, null, { timeout: 600000, polling: 200 }).then(() => true).catch(() => false);
  await page.evaluate(() => { window.__quietRun = 0; });

  const f1 = await page.evaluate(() => __district.frames);
  if (why) console.log(`  settled ${why}: frames ${f0} -> ${f1}` +
    (quiet ? ' (streamer quiet)' : '  STREAMER NEVER WENT QUIET'));
  return f1;
}

// Stand in the carriageway on the Main Street corridor looking east toward
// Five Points, which is the district's hero view.
//
// THE CORRIDOR CAMERA WAS NOT ON THE CORRIDOR, and every visual round this
// project has run was judged partly on that frame. It interpolated waypoint 2
// (19, -6, "Main St @ Pineapple Ave") to waypoint 4 (569, -164, "Main St east")
// - a DIAGONAL across blocks - and then extrapolated 34 m backwards along it,
// landing the camera at about (-13.6, 3.9). An independent fidelity review
// measured it there: no Main Street edge within 45 m, nearest South Pineapple
// 33 m, McAnsh Square 21 m, and the street blade legible in the frame reads
// MC ANSH SQUARE.
//
// Main Street east is waypoint 3 to waypoint 4, constant z = -163.8 from x = 57
// to x = 569 - the same dead east-west leg tools/reproject-pano.mjs calibrates
// its panorama convention against. wpA: 2 was never that leg.
//
// The consequence was not cosmetic. A streetscape reviewer measured 0.097%
// foliage in this frame against 1.835% at fivepoints and concluded the corridor
// had no street trees; it has none because the oak profile is on Main Street east
// and the camera was two blocks off it. The trees, the placement rule and the
// canopy shadow were all fine.
//
// NOTE FOR ANYONE COMPARING OLD CAPTURES: every `*-corridor-*.png` committed
// before 2026-09-05 is the old, mis-sited framing and is NOT comparable with
// anything captured after it.
export const HERO_FRAMINGS = [
  // back is NEGATIVE here on purpose: it places the camera 55 m FORWARD of the
  // Five Points waypoint, at about x = 112 on the Main St east carriageway, which
  // is inside the oak run. src/streetfurniture.js records that the census put
  // nine of the district's twelve live oaks inside x 78..155, "a tree every 9 m
  // of street", so a corridor hero standing west of x = 78 photographs the
  // corridor's name rather than its trees. It also separates this camera from
  // the fivepoints one, which stands 26 m back from the same waypoint on the same
  // axis - at back = +34 the two were 8 m apart and were the same picture twice.
  { name: 'corridor', wpA: 3, wpB: 4, back: -55, side: 0, height: 2.4, fov: 55, tgtY: 16, fwd: 260 },
  { name: 'fivepoints', wpA: 3, wpB: 4, back: 26, side: 7, height: 3.0, fov: 48, tgtY: 12, fwd: 200 },
];

/**
 * OPT-IN FRAMINGS, reachable only by name through HERO_SHOTS, so a default capture is not made longer
 * by a camera built for one question.
 *
 * `cabin` is the cabin driver's re-review, whose blind reviewer asked for "a car side-on within about
 * 15 m": the corridor pairs had no traffic car in frame and fivepoints resolved the driver on about
 * 45 px of one car. The subject is the PLAYER's car, because it is the one car a capture can place —
 * the fleet is unseeded — and `uCabinDriver` reaches its cabin too. Waypoint 3 is the west end of
 * Main Street east; the car stands there nose north (yaw 0 is +z) and the camera 11 m to its +x,
 * which in the car frame is the LEFT, Florida's driver's side, at eye height and looking at the cabin.
 */
export const HERO_EXTRA_FRAMINGS = [
  { name: 'cabin', wpA: 3, look: 'car', carSide: 11, height: 1.6, fov: 40, tgtY: 1.1 },
  // #133's other half: the same car from behind and to its left, 6 m back and 2.4 m out on North
  // Lemon Avenue, where a door mirror's glass is what a camera should see. The side-on `cabin`
  // framing shows the half that was wrong; this one shows the half that was missing.
  { name: 'mirrorback', wpA: 3, look: 'car', carSide: 2.4, carBack: 6.0, height: 1.25, fov: 34, tgtY: 0.9 },
];

export function placeHeroCam(page, cfg) {
  if (cfg.look === 'car') return placeCarCam(page, cfg);
  return page.evaluate((cfg) => {
    const r = __district.district.meta.route;
    const a = r[cfg.wpA], b = r[cfg.wpB];
    const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
    const nx = -dz / len, nz = dx / len;

    // Keep the camera OUT of the buildings.
    //
    // `back` extrapolates in a straight line from a route waypoint, and the route
    // bends: at back = 34 the corridor camera stood 3.7 m inside building 67's
    // footprint (an 8-point concave block). Walls are single-sided, so from in
    // there the block's own facades vanish and its awnings, cornice and parapet
    // are left hanging over the street with nothing under them. Three rounds of
    // blind critics reported that frame as floating props and an untethered
    // rooftop slab; it is the camera, not the geometry. A hero shot is a
    // measuring instrument, and one standing inside a wall manufactures exactly
    // the defect class it is being used to look for.
    const inRing = (ring, x, z) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > z) !== (zj > z) && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
      }
      return inside;
    };
    // Signed clearance to the nearest footprint: negative inside, metres outside.
    // Distance, not just in/out — a camera pressed flat against a wall is as
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
            if (d < best) { best = d; }
          }
        }
      }
      return { d: best === Infinity ? 99 : best, inside: worst };
    };
    const MIN_CLEAR = 3.0;                  // metres of pavement around the camera
    let back = cfg.back, px = 0, pz = 0, cl = { d: 99, inside: -1 };
    for (;;) {
      px = a.x - (dx / len) * back + nx * cfg.side;
      pz = a.z - (dz / len) * back + nz * cfg.side;
      cl = clearance(px, pz);
      if (cl.d >= MIN_CLEAR || back <= 8) break;
      back -= 1;
    }
    const hit = cl.inside;

    __district.placeAt(a.x, a.z);
    __district.setAutopilot(() => {});
    __district.freeCam(
      [px, cfg.height, pz],
      [a.x + (dx / len) * cfg.fwd, cfg.tgtY, a.z + (dz / len) * cfg.fwd],
      cfg.fov
    );
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { back, requestedBack: cfg.back, x: +px.toFixed(1), z: +pz.toFixed(1),
      clearance: +cl.d.toFixed(1), stillInside: cl.d >= MIN_CLEAR ? -1 : hit };
  }, cfg);
}

/**
 * The car-facing placement: the player's car at the waypoint, nose north, and the camera `carSide`
 * metres to its +x looking at the cabin. Reports the same fields as placeHeroCam, and the camera's
 * clearance from the nearest footprint by the same in-ring test, so hero-shots' warning still fires.
 */
function placeCarCam(page, cfg) {
  return page.evaluate((cfg) => {
    const a = __district.district.meta.route[cfg.wpA];
    const px = a.x + cfg.carSide, pz = a.z - (cfg.carBack ?? 0);
    let inside = -1;
    for (const [bi, b] of __district.district.buildings.entries()) {
      const ring = b.p;
      let inRing = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0], zi = ring[i][1], xj = ring[j][0], zj = ring[j][1];
        if ((zi > pz) !== (zj > pz) && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) inRing = !inRing;
      }
      if (inRing) { inside = bi; break; }
    }
    __district.placeAt(a.x, a.z, 0);
    __district.setAutopilot(() => {});
    __district.freeCam([px, cfg.height, pz], [a.x, cfg.tgtY, a.z], cfg.fov);
    for (let i = 0; i < 900; i++) __district.world.update(__district.vehicle.position);
    return { back: 0, requestedBack: 0, x: +px.toFixed(1), z: +pz.toFixed(1),
      clearance: inside >= 0 ? 0 : 99, stillInside: inside };
  }, cfg);
}
