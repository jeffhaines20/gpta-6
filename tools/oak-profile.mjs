// Where the corridor is an OAK TUNNEL, in one number per 20 m, derived from
// docs/oak-census.json rather than from a region name.
//
// `tools/oak-census.mjs --measure` measures canopy at 202 reprojected stations.
// This turns that into the thing the dressing pass can actually consume: a
// weight in [0,1] along the corridor arc-length `s`, sampled every 20 m, which
// src/streetfurniture.js multiplies into the probability that a given tree
// station plants a live oak instead of a palm.
//
// Regenerate with:  node tools/oak-profile.mjs --emit
// and paste the array under OAK_PROFILE in src/streetfurniture.js.
//
// ---------------------------------------------------------------------------
// THREE THINGS THE RAW `foliage` COLUMN GETS WRONG, AND WHAT IS DONE ABOUT THEM
// ---------------------------------------------------------------------------
//
// 1. THE SHADED WALL IS UNDER-READ, BADLY. The census reports L and R views per
//    station and the naive reading pools them. On Main St east that produces a
//    38.7% / 10.3% L-vs-R split at x 90..165 which looks exactly like a
//    one-sided tree line -- and is not one. The R wall at x=138 is BACKLIT: the
//    crown is there, filling a third of the frame, but its underside sits at
//    (30,35,28) and `isFoliage` wants g - b >= 0.16*max + 5, which a shaded
//    leaf fails. `oak-census.mjs --mask 1007445660973812-R` shows it directly:
//    magenta on the sunlit top of the crown, nothing on the two thirds below.
//    So a station is scored on max(L, R), not on the mean. Both walls of Main
//    St east carry oaks and the photographs say so plainly.
//
// 2. FOLIAGE FRACTION DOES NOT SEPARATE A TUNNEL FROM A SHRUB. x=563 reads
//    22.5% foliage and x=138 reads 47.8%, but the first is a leggy specimen
//    with its crown low in the frame and the second is a canopy overhead. The
//    census already carries the discriminator: `upper` is the foliage fraction
//    of the TOP 40% of the frame, and it runs 27-79% through the tunnel against
//    0-3% along the open stretches. It is the whole difference between "there
//    are trees here" and "you are driving through a tunnel", so it multiplies.
//
// 3. THE CLASSIFIER CANNOT TELL AN OAK FROM A PALM. It measures green pixels.
//    Five Points reads 4.2% median with a handful of stations over 15%, and the
//    heaviest of them (548044374984819-L, x=53) is a Canary Island date palm
//    against a brick wall. Pixels cannot resolve that and neither can this
//    file, so the legs that were checked BY EYE and found to be palm --
//    the marina approach and Pineapple/Five Points -- are excluded by hand and
//    the exclusion is named here rather than buried in a threshold.
import fs from 'node:fs';

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
const cum = [0];
for (let i = 0; i + 1 < route.length; i++) {
  cum.push(cum[i] + Math.hypot(route[i + 1].x - route[i].x, route[i + 1].z - route[i].z));
}
const TOTAL = cum[cum.length - 1];

const C = JSON.parse(fs.readFileSync('docs/oak-census.json', 'utf8'));

// ---------------------------------------------------------------- the scoring
// Foliage above a floor, times overhead-ness. The floor is 12%: the district
// median off-hotspot is 4-10% and that is grass, planters, a hedge across the
// street and the odd sapling, none of which is a canopy. The ceiling is 38%,
// where a station is unambiguously under a crown.
const FOL_LO = 0.12, FOL_HI = 0.38;
// `upper` saturates fast. 12% of the top of the frame in leaf is already an
// overhanging limb; the tunnel stations run 3-6x that. The 0.28 floor is what
// keeps a genuinely big crown that happens to be photographed from under its
// edge from scoring zero.
const UP_HI = 0.16, UP_FLOOR = 0.28;
const cl01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const scoreOf = (fol, up) =>
  cl01((fol - FOL_LO) / (FOL_HI - FOL_LO)) * cl01(UP_FLOOR + up / UP_HI);

// Legs checked by eye and found to be PALM, not oak. Excluded by name; see (3).
const PALM_LEGS = new Set([0, 2]);

// Fold the two views of a station into one record on max().
const st = new Map();
for (const r of C.rows) {
  const cur = st.get(r.id);
  if (!cur) st.set(r.id, { ...r, fol: r.foliage, up: r.upper });
  else { cur.fol = Math.max(cur.fol, r.foliage); cur.up = Math.max(cur.up, r.upper); }
}
const stations = [...st.values()].sort((a, b) => a.s - b.s);
for (const p of stations) p.score = PALM_LEGS.has(p.leg) ? 0 : scoreOf(p.fol, p.up);

// -------------------------------------------------------------- the smoothing
// A station is a photograph from one spot, and the tree it is under is 8 m
// across. Sampling the score at 20 m with a 16 m kernel is what turns a list of
// spot readings into the CANOPY RUN they came from -- the reference shows
// discrete trees in pits with gaps between them, and the tunnel is the crowns
// meeting, not the stations agreeing.
const STEP = Number(arg('step', 20));
// 16 m, about one crown radius. Wider (26 m was the first cut) smears the
// tunnel's 63 m of solid 1.00 stations into the open ground either side of it
// and reads the peak at 0.72 instead of 0.90; narrower stops bridging the
// single-station gaps that are just a photographer walking past a gap between
// two trees.
const SIGMA = Number(arg('sigma', 16));
// Past 3 sigma a station contributes nothing, and a sample point with no
// station inside that has no evidence either way -- it reports 0, which plants
// the palm the district already had. That is the right default: this file only
// ever ADDS oaks where they were measured.
const REACH = SIGMA * 3;

function profile() {
  const out = [];
  for (let s = 0; s <= TOTAL + STEP * 0.5; s += STEP) {
    let num = 0, den = 0, n = 0;
    for (const p of stations) {
      const d = Math.abs(p.s - s);
      if (d > REACH) continue;
      const w = Math.exp(-0.5 * (d / SIGMA) ** 2);
      num += w * p.score; den += w; n++;
    }
    out.push({ s, w: den > 0 ? num / den : 0, n });
  }
  return out;
}

const prof = profile();

if (has('emit')) {
  // The array as it is pasted into src/streetfurniture.js: one byte-ish value
  // per STEP metres, two decimals, which is finer than the thing it controls.
  // Trailing zeros are dropped and the consumer reads past-the-end as zero: the
  // census stops at s = 1229 m (it measured four of the route's eight legs) and
  // 65 zeros carrying "no photograph was taken here" would look like a
  // measurement that there are no oaks there. There is no measurement there.
  let last = prof.length - 1;
  while (last > 0 && prof[last].w < 0.005) last--;
  const vals = prof.slice(0, last + 1).map((p) => p.w.toFixed(2));
  console.log(`// step ${STEP} m, ${vals.length} samples over ${TOTAL.toFixed(0)} m of corridor`);
  const per = 10;
  for (let i = 0; i < vals.length; i += per) {
    console.log(`  ${vals.slice(i, i + per).join(', ')},`
      + `   // s ${String(i * STEP).padStart(4)}..${(i + per - 1) * STEP}`);
  }
} else {
  console.log(`corridor ${TOTAL.toFixed(0)} m, ${stations.length} stations, `
    + `step ${STEP} m, sigma ${SIGMA} m\n`);
  console.log('   s     x      z    leg  fol%   up%  score   profile');
  let si = 0;
  for (const p of prof) {
    // the stations that land in this sample's cell, for context
    const here = stations.filter((q) => Math.abs(q.s - p.s) < STEP / 2);
    const bar = '#'.repeat(Math.round(p.w * 40));
    if (!here.length) {
      console.log(`${p.s.toFixed(0).padStart(5)}                              `
        + `        ${p.w.toFixed(2)}  ${bar}`);
      continue;
    }
    here.forEach((q, i) => {
      console.log(`${p.s.toFixed(0).padStart(5)} ${q.x.toFixed(0).padStart(6)} ${q.z.toFixed(0).padStart(6)}`
        + `   ${q.leg}  ${(100 * q.fol).toFixed(1).padStart(5)} ${(100 * q.up).toFixed(1).padStart(5)}`
        + `  ${q.score.toFixed(2)}   ${i === 0 ? p.w.toFixed(2) + '  ' + bar : ''}`);
    });
    si++;
  }
  // The runs, which is the thing a placement rule is actually shaped like.
  console.log('\n--- oak runs (profile >= 0.25) ---');
  let run = null;
  const runs = [];
  for (const p of prof) {
    if (p.w >= 0.25) { if (!run) run = { s0: p.s, s1: p.s, peak: 0 }; run.s1 = p.s; run.peak = Math.max(run.peak, p.w); }
    else if (run) { runs.push(run); run = null; }
  }
  if (run) runs.push(run);
  for (const r of runs) {
    const mid = stations.filter((q) => q.s >= r.s0 - 10 && q.s <= r.s1 + 10);
    const xs = mid.map((q) => q.x), zs = mid.map((q) => q.z);
    console.log(`  s ${r.s0.toFixed(0).padStart(4)}..${r.s1.toFixed(0).padStart(4)}  (${(r.s1 - r.s0).toFixed(0)} m)  `
      + `peak ${r.peak.toFixed(2)}  x ${Math.min(...xs).toFixed(0)}..${Math.max(...xs).toFixed(0)}  `
      + `z ${Math.min(...zs).toFixed(0)}..${Math.max(...zs).toFixed(0)}  leg ${[...new Set(mid.map((q) => q.leg))].join(',')}`);
  }
  const covered = prof.filter((p) => p.w >= 0.25).length * STEP;
  console.log(`\n${covered.toFixed(0)} m of ${TOTAL.toFixed(0)} m (${(100 * covered / TOTAL).toFixed(0)}%) reads as oak at >= 0.25`);
  console.log('run  node tools/oak-profile.mjs --emit  for the pasteable array');
}
