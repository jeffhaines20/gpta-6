// AUTHOR-TIME ONLY. Authored building massing for the hero corridor.
//
// Binding constraint 9: massing is authoring work, not a data import. Only 9.9%
// of the OSM footprints carry a real height, so along the Main Street corridor
// and the mission route we author it deliberately; everywhere else keeps the
// area-derived default and stays marked d:1.
//
// Rules are declarative and seeded off the footprint centroid, so a re-bake
// produces byte-identical massing.

// Corridor spine in baked local metres, following the real Main Street
// (OSM Main Street) centreline from the bayfront east through Five Points.
const MARLIN_SPINE = [
  [-334.7, -11.8], [-327.8, 63.3], [-180.0, 20.0], [-60.0, 0.0],
  [19.1, -6.3], [57.5, -163.8], [220.0, -163.9], [400.0, -163.9], [569.3, -163.9],
];

// The corridor is NOT one massing regime, and treating it as one is what the
// street-level photography caught. Split at the Five Points junction:
//
//   WEST  bayfront -> Five Points   carries the district's real height. Measured
//                                   delta p50 median 0.0 deg against the reference
//                                   before any of this was touched - it was already
//                                   right, and shortening it uniformly broke two
//                                   faces that had been exact (x=34.6 went 0.0 ->
//                                   -10.4 deg, i.e. from correct to 10 deg short).
//   EAST  Five Points -> Main St E  is a two-to-three storey retail wall. Measured
//                                   +10.1 deg median too tall over 24 walls, with
//                                   62% of columns showing no sky at all against a
//                                   reference showing sky in 82% of them.
//
// Same spine geometry, split at index 5, so nothing moves except which
// distribution claims a footprint.
const MARLIN_WEST_SPINE = MARLIN_SPINE.slice(0, 6);
const MARLIN_EAST_SPINE = MARLIN_SPINE.slice(5);

// The bayfront band, where the district's genuine towers stand.
const BAYFRONT_SPINE = [[-471.2, 204.6], [-420.0, 120.0], [-360.0, 20.0], [-330.0, -60.0], [-320.0, -180.0]];

// 2nd Street, the mission route's return leg.
const SECOND_ST_SPINE = [[619.0, -343.6], [400.0, -370.0], [208.8, -384.9], [-30.0, -405.0], [-173.4, -423.5]];

const LEVEL_H = 3.2;

function distToPolyline(x, z, spine) {
  let best = Infinity;
  for (let i = 0; i < spine.length - 1; i++) {
    const [ax, az] = spine[i], [bx, bz] = spine[i + 1];
    const dx = bx - ax, dz = bz - az;
    const len2 = dx * dx + dz * dz;
    let t = len2 > 0 ? ((x - ax) * dx + (z - az) * dz) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const px = ax + dx * t, pz = az + dz * t;
    const d = Math.hypot(x - px, z - pz);
    if (d < best) best = d;
  }
  return best;
}

// Deterministic per-building hash so the same footprint always draws the same
// storey count from its band's distribution.
function seedOf(x, z) {
  let h = 2166136261;
  const s = `${Math.round(x * 10)}:${Math.round(z * 10)}`;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967295;
}

// Storey distributions per band. Weighted so the corridor reads as a real
// downtown: a dominant 2-3 storey retail wall with occasional taller punctuation,
// not a uniform height.
const BANDS = [
  {
    // EAST of Five Points: the two-to-three storey retail wall.
    //
    // RE-DERIVED 2026-09-02 against street-level photography. The previous
    // distribution (2200:6/8/11, 900:3/4/6, 300:2/3/4, else 2/3) was authored from
    // the idea of a downtown rather than from this one, and on this leg it made
    // the street 1.67x too tall: over 16 street-facing walls where a Mapillary
    // panorama and the engine camera stand on the same coordinate
    // (tools/pano-match.mjs, tools/roofline.mjs) the median built/reference height
    // ratio was 1.67, and only 2 of 16 walls were within a third of the real
    // thing. This table measures 0.94 median and 0.95 mean.
    //
    // The floor stays at 2 storeys above 300 m2: a 3.2 m single-storey box on the
    // retail wall reads as a shed, and the reference has none.
    name: 'marlin-core-east', spine: MARLIN_EAST_SPINE, within: 46,
    pick: (r, area) => {
      if (area > 2200) return r < 0.5 ? 3 : r < 0.85 ? 4 : 6;
      if (area > 900) return r < 0.5 ? 2 : r < 0.85 ? 3 : 4;
      // Two outcomes, not three, and deliberately so - an independent review
      // read the previous `r < 0.6 ? 2 : r < 0.9 ? 2 : 3` as a typo for 2:3:4,
      // which is a fair reading of three branches that return two values. It is
      // written plainly now because the measurement cannot support a third
      // outcome here: only TWO of the 14 marlin-core-east buildings fall in the
      // 300-900 m2 band, and both measured 2 storeys. A stepped 2/3/4 would be
      // inventing a distribution from a sample of two.
      if (area > 300) return r < 0.9 ? 2 : 3;
      return r < 0.7 ? 1 : 2;
    },
  },
  {
    // WEST of Five Points: unchanged, because it was already right. This leg
    // measured 0.0 deg median against the reference BEFORE anything was touched,
    // and the first attempt - which shortened the whole corridor with one table -
    // took a face at x=34.6 from exactly correct to 10.4 deg too short. A
    // correction has to be aimed at the leg that is wrong.
    name: 'marlin-core-west', spine: MARLIN_WEST_SPINE, within: 46,
    pick: (r, area) => {
      if (area > 2200) return r < 0.45 ? 6 : r < 0.8 ? 8 : 11;
      if (area > 900) return r < 0.4 ? 3 : r < 0.75 ? 4 : 6;
      if (area > 300) return r < 0.5 ? 2 : r < 0.85 ? 3 : 4;
      return r < 0.65 ? 2 : 3;
    },
  },
  {
    name: 'marlin-back', spine: MARLIN_SPINE, within: 105,
    pick: (r, area) => {
      if (area > 2200) return r < 0.6 ? 4 : 6;
      if (area > 900) return r < 0.6 ? 3 : 4;
      if (area > 300) return r < 0.7 ? 2 : 3;
      return r < 0.8 ? 1 : 2;
    },
  },
  {
    name: 'bayfront-towers', spine: BAYFRONT_SPINE, within: 130,
    pick: (r, area) => {
      if (area > 1400) return r < 0.35 ? 14 : r < 0.7 ? 17 : 21;
      if (area > 700) return r < 0.5 ? 9 : 12;
      if (area > 250) return r < 0.6 ? 3 : 5;
      return 2;
    },
  },
  {
    name: 'second-street', spine: SECOND_ST_SPINE, within: 60,
    pick: (r, area) => {
      if (area > 1800) return r < 0.5 ? 4 : 6;
      if (area > 700) return r < 0.6 ? 3 : 4;
      if (area > 250) return r < 0.7 ? 2 : 3;
      return r < 0.75 ? 1 : 2;
    },
  },
];

// Named landmarks: a handful of hand-placed hero buildings. Phase 1's critic said
// procedural noise cannot produce "authored", and hero placement is the cheapest
// way to buy it. Positions are near real large parcels; identity is invented.
const LANDMARKS = [
  { name: 'Bayfront Tower', x: -352, z: 86, radius: 55, levels: 24 },
  { name: 'Gulfstream Point Residences', x: -395, z: -30, radius: 50, levels: 19 },
  { name: 'The Palm Avenue Building', x: 40, z: -150, radius: 34, levels: 12 },
  { name: 'Five Points Exchange', x: 78, z: -178, radius: 30, levels: 9 },
  { name: 'Main Street Arcade', x: 250, z: -150, radius: 32, levels: 7 },
];

// Applied per building at bake time. Returns null when no rule claims it, and the
// caller keeps the area-derived default.
export function authoredHeight(cx, cz, area) {
  for (const lm of LANDMARKS) {
    if (Math.hypot(cx - lm.x, cz - lm.z) <= lm.radius && area > 260) {
      return { height: +(lm.levels * LEVEL_H).toFixed(1), band: `landmark:${lm.name}`, levels: lm.levels };
    }
  }
  const r = seedOf(cx, cz);
  for (const band of BANDS) {
    if (distToPolyline(cx, cz, band.spine) <= band.within) {
      const levels = band.pick(r, area);
      return { height: +(levels * LEVEL_H).toFixed(1), band: band.name, levels };
    }
  }
  return null;
}

export const MASSING_BANDS = BANDS.map((b) => b.name);
export const MASSING_LANDMARKS = LANDMARKS;
