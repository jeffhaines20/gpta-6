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
    name: 'marlin-core-east', spine: MARLIN_EAST_SPINE, within: 46, sibling: 'marlin-core-west',
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
    name: 'marlin-core-west', spine: MARLIN_WEST_SPINE, within: 46, sibling: 'marlin-core-east',
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

// Heights measured from the PHOTOGRAPHS, for the footprints where the evidence is
// strong enough to beat a distribution.
//
// Every other height on the corridor is drawn from a band's area->storeys table by
// a hash. That is the right default for 500 footprints nobody has a photograph of,
// and it is the wrong answer for the handful we can actually measure.
// tools/massing-truth.mjs converts the parapet angle in a reprojected Mapillary
// view into METRES for the footprint it lands on, so these are read rather than
// invented (binding constraint 9 - massing is authoring work; authoring from the
// reference is the most defensible form of it).
//
// THE BAR, applied before anything went in this table: at least 1,000 accepted
// columns, an interquartile spread of 6 m or less across those columns, and a
// built/implied ratio outside 0.74-1.35. Everything failing it keeps its band
// height, because a wide spread means the footprint does not HAVE one height and
// pinning it to a median would be inventing precision.
//
// These are NOT quantised to LEVEL_H. A storey grid is our model, not the street's,
// and rounding a measured 11.03 m to the nearest 3.2 would put back part of the
// error this table exists to remove.
//
// `height` is the WALL, `implied` is what the photograph measured. They differ by
// the recipe's parapet (1.15 m on all five here), because appendBuilding draws from
// h to h + parapet and the photograph's parapet angle is the TOP of that. The first
// version of this table set height = implied and every one of the five came back
// about 10% tall - the instrument caught the author's own off-by-a-parapet, which
// is the whole argument for measuring after a change rather than before.
//
// What an independent art critic reported, and what the fuller measurement said:
// the critic found buildings 29 and 28 grossly too tall from stations x=148/159
// and x=239. Over all 404 stations, 29 is confirmed (ratio 1.76) but 28 is NOT -
// it reads 1.21 over 730 columns, inside the band's own noise - and the critic's
// five stations give a band ratio of 0.63 against 1.13 over the whole band. They
// were the worst stations, not representative ones. Four buildings are too SHORT
// by more than 29 is too tall, and nobody had noticed.
const REFERENCE_HEIGHTS = [
  // idx 49. 6,832 columns, IQR 3.0 m - the strongest evidence on the corridor, and
  // it was never flagged by eye. Built 10.8 against 7.70 implied.
  { x: 361.6, z: -136.4, radius: 12, height: 6.55, was: 10.75, implied: 7.70, n: 6832 },
  // idx 90. 4,964 columns, IQR 5.1. Built 7.55 against 13.38 - too SHORT by more
  // than building 29 is too tall.
  { x: 505.4, z: -131.4, radius: 12, height: 12.25, was: 7.55, implied: 13.40, n: 4964 },
  // idx 68. 1,467 columns and an IQR of 0.4 m, the tightest reading in the set:
  // this footprint really does have one height. Built 7.55 against 11.03.
  { x: 443.4, z: -138.8, radius: 12, height: 9.85, was: 7.55, implied: 11.03, n: 1467 },
  // idx 24. 1,057 columns, IQR 5.7. Built 7.55 against 11.78.
  { x: 387.8, z: -198.1, radius: 12, height: 10.65, was: 7.55, implied: 11.78, n: 1057 },
  // idx 29 - the critic's worst station, and the one case here that FAILS the
  // spread bar (IQR 9.5 m). It is pinned anyway, to the dominant face rather than
  // to the overall median, and the reason is in the split: of its 2,037 columns,
  // 1,416 read 6.8 m and 621 read 20.6 m. That is not noise, it is a 106 m
  // FRONTAGE that is genuinely two different buildings in reality and one polygon
  // in the OSM extract. We cannot split a baked footprint - the bake's geometry is
  // authoritative (constraint 10) - so the choice is which half to be wrong about.
  // 70% of the evidence and the whole hero view are the low half, so the low half
  // wins. Built 13.95 against 6.8. Recorded as a known compromise, not a fit.
  { x: 109.9, z: -190.2, radius: 14, height: 5.65, was: 13.95, implied: 6.80, n: 2037, spread: 9.5 },
];

// Applied per building at bake time. Returns null when no rule claims it, and the
// caller keeps the area-derived default.
export function authoredHeight(cx, cz, area) {
  // Measured beats invented. This runs BEFORE the landmarks and the bands: a
  // height read off a photograph of the real footprint is better evidence than a
  // hand-placed hero storey count or a hash on floor area, and none of the five
  // hand-placed landmarks is in this table anyway.
  for (const r of REFERENCE_HEIGHTS) {
    if (Math.hypot(cx - r.x, cz - r.z) <= r.radius) {
      return { height: r.height, band: 'reference', levels: Math.max(1, Math.round(r.height / LEVEL_H)) };
    }
  }
  for (const lm of LANDMARKS) {
    if (Math.hypot(cx - lm.x, cz - lm.z) <= lm.radius && area > 260) {
      return { height: +(lm.levels * LEVEL_H).toFixed(1), band: `landmark:${lm.name}`, levels: lm.levels };
    }
  }
  const r = seedOf(cx, cz);
  // First match wins, EXCEPT between a band and its declared sibling.
  //
  // The bands are distinct regimes and their order is a deliberate priority, so
  // first-match is right in general. It is wrong in exactly one place, which an
  // independent review found: marlin-core-east and marlin-core-west are two halves
  // of ONE regime, split at the shared spine vertex [57.5, -163.8], so their 46 m
  // corridors overlap around it. East is listed first, and FOUR footprints matched
  // both. Three sit closer to the WEST spine and were massed by the east retail
  // table anyway - idx 401 at 6.6 m west against 30.5 m east, 462 at 22.3 vs 40.3,
  // 463 at 28.7 vs 45.3 - and two came out as 3.2 m single-storey boxes on the
  // Palm Avenue approach. That is both the leg the split exists to leave alone and
  // the exact thing the east table's own comment forbids ("a 3.2 m single-storey
  // box on the retail wall reads as a shed, and the reference has none"). The
  // fourth is The Palm Avenue Building, which escaped only because LANDMARKS is
  // checked first - luck, not design.
  //
  // Resolving by distance ONLY within a sibling pair fixes that without touching
  // any other precedence. A plain global nearest-wins was tried and rejected: it
  // also let bayfront-towers (within 130) take five footprints from marlin-back
  // (within 105), turning a 12.8 m building into a 67.2 m tower. Massing is
  // authoring work (binding constraint 9); a change that size needs its own
  // measurement, not a ride on a bug fix.
  for (const band of BANDS) {
    const d = distToPolyline(cx, cz, band.spine);
    if (d > band.within) continue;
    let chosen = band;
    if (band.sibling) {
      const sib = BANDS.find((b) => b.name === band.sibling);
      if (sib && distToPolyline(cx, cz, sib.spine) < d) chosen = sib;
    }
    const levels = chosen.pick(r, area);
    return { height: +(levels * LEVEL_H).toFixed(1), band: chosen.name, levels };
  }
  return null;
}

export const MASSING_BANDS = BANDS.map((b) => b.name);
export const MASSING_LANDMARKS = LANDMARKS;
export const MASSING_REFERENCE_HEIGHTS = REFERENCE_HEIGHTS;
