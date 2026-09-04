// What height does the PHOTOGRAPH imply for each baked footprint?
//
// tools/roofline-analytic.mjs answers "how high does our streetwall stand" in
// degrees, and tools/roofline.mjs answers the same for the reference photograph.
// Neither answers the question a massing table actually has to be written
// against, which is in METRES: given that this footprint is 7.6 m from the
// camera and its parapet subtends 14.7 deg in the photograph, how tall is it?
//
//   node tools/massing-truth.mjs                       # every station, per-band summary
//   node tools/massing-truth.mjs --band marlin-core-east --per-building
//   node tools/massing-truth.mjs --stations 148.4,158.9,239.3   # the critic's table
//   node tools/massing-truth.mjs --district old.json --json out.json
//
// HOW. For every image column of every reprojected view:
//
//   1. the topmost non-sky row, using tools/roofline.mjs's own isSky - not a
//      second copy of the colour test, so the two cannot drift;
//   2. the world ray through the CENTRE of that pixel, built from the same
//      camera tools/roofline-analytic.mjs projects with (imported, not re-derived);
//   3. the nearest baked footprint edge that ray crosses in plan, which is the
//      street wall standing in that direction. Baked footprints are authoritative
//      (binding constraint 10), so the horizontal distance is a fact even where
//      the height is authored;
//   4. therefore an implied parapet height, eye + t * dy, in metres.
//
// The result is one height per column per view, attributable to one building,
// which is what makes it possible to say "the photographs put building 29 at
// 6.3 m" rather than "this leg reads 38 deg too tall".
//
// ---------------------------------------------------------------- WHAT IT OMITS
//
// This is an UPPER bound on the built height of the front wall. The topmost
// non-sky pixel in a column may belong to
//
//   - a street tree, an awning, a blade sign, a lamp standard or a wire in front
//     of the wall (all TALLER in angle than the parapet behind them);
//   - a taller building further back, seen over the front wall's roof;
//   - a cloud, where the sky test stops early.
//
// Every one of those pushes the implied height UP, never down. So a leg whose
// photographs imply 6 m cannot really be 9.6 m, while a leg implying 9.6 m might
// really be 8. The filters below (--minRun, foliage, soft-edge, grazing-incidence
// and clipped-column rejection) exist to thin that population, and the fraction
// each removes is printed rather than hidden.
//
// The CONTROL is marlin-core-west, whose built massing measured 0.0 deg against
// this same reference before any of this work. If the derivation is sound it must
// return that band's own built heights there, and the summary prints that ratio
// first. An instrument that cannot reproduce a leg known to be right has no
// business being believed about a leg claimed to be wrong.
import fs from 'node:fs';
import path from 'node:path';
import { readPNG } from './png.mjs';
import { isSky, elevOf, CAM } from './roofline.mjs';
import { loadWorld, cameraAt, bearingAt } from './roofline-analytic.mjs';

const MLY = 'reference/sarasota/mapillary';
const VIEWS = path.join(MLY, 'views');
const W = 1280, H = 960;
const TH = Math.tan((CAM.hfovDeg * Math.PI) / 360);
const TV = TH / CAM.aspect;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

const MIN_RUN = Number(arg('minRun', 14));    // rows of solid non-sky under the boundary
const MAX_D = Number(arg('maxDist', 90));     // metres; past this a column is a skyline, not a wall
const MIN_COS = Number(arg('minCos', 0.20));  // grazing incidence rejection
// Cross-street sensitivity. The Mapillary positions on this leg are one October
// drive whose cross-track scatter against the OSM centreline runs -7.0 to +1.6 m,
// which a car in one lane cannot do: that is GPS noise, and it lands straight on
// the wall distance every implied height is computed from. --dz walks the whole
// camera across the street so the answer can be quoted with that error in it
// rather than beside it.
const DZ = Number(arg('dz', 0));

// ------------------------------------------------------------------ the columns
/**
 * Per column: topmost non-sky row, plus the terms that say whether to believe it.
 * The sky test itself is roofline.mjs's, imported.
 */
function refColumns(file) {
  const img = readPNG(file);
  const { width: w, height: h, channels: c, data } = img;
  if (w !== W || h !== H) throw new Error(`${file} is ${w}x${h}, expected ${W}x${H}`);
  const row = new Int32Array(w).fill(-1);
  const flag = new Uint8Array(w);              // 1 open, 2 clipped, 4 thin, 8 soft, 16 foliage, 32 glare
  for (let x = 0; x < w; x++) {
    let r = -1;
    for (let y = 0; y < h; y++) {
      const i = (y * w + x) * c;
      if (!isSky(data[i], data[i + 1], data[i + 2])) { r = y; break; }
    }
    if (r < 0) { flag[x] |= 1; continue; }
    row[x] = r;
    if (r === 0) flag[x] |= 2;
    let e = r; while (e < h) { const i = (e * w + x) * c; if (isSky(data[i], data[i + 1], data[i + 2])) break; e++; }
    if (e - r < MIN_RUN) flag[x] |= 4;
    if (r > 0) {
      const i0 = ((r - 1) * w + x) * c, i1 = (r * w + x) * c;
      const d = Math.abs(data[i0] - data[i1]) + Math.abs(data[i0 + 1] - data[i1 + 1]) + Math.abs(data[i0 + 2] - data[i1 + 2]);
      if (d < 20) flag[x] |= 8;
    }
    const i = (r * w + x) * c, R = data[i], G = data[i + 1], B = data[i + 2];
    if (G >= B && G >= R - 12 && (R + G + B) / 3 < 170) flag[x] |= 16;
    // Glare. These photographs were shot on one October afternoon into a low sun,
    // and every R view on this corridor looks into that half of the dome: the
    // halo around it is blown to near-white, which fails `b > r + 6` and is
    // therefore "built" to the sky test. It is the SAME failure roofline.mjs
    // documents on the render side, on the reference side, and it is one-sided
    // upward. Unfiltered it put the south wall of Main St east at 9.4 m implied
    // against 5.0-6.3 m on the north wall of the identical retail row.
    const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
    if (mx > 200 && (mx - mn) / mx < 0.12) flag[x] |= 32;
  }
  return { row, flag };
}

// -------------------------------------------------------------------- the rays
/** Camera basis in world space, from the same camera roofline-analytic projects with. */
function basisAt(x, z, yaw) {
  const { cam } = cameraAt(x, z, yaw);
  const m = cam.matrixWorld.elements;
  return {
    o: [m[12], m[13], m[14]],
    right: [m[0], m[1], m[2]],
    up: [m[4], m[5], m[6]],
    back: [m[8], m[9], m[10]],
  };
}

/** World direction through the centre of pixel (col, row). */
function rayDir(B, col, row) {
  const xc = (2 * (col + 0.5) / W - 1) * TH;
  const yc = (1 - 2 * (row + 0.5) / H) * TV;
  return [
    B.right[0] * xc + B.up[0] * yc - B.back[0],
    B.right[1] * xc + B.up[1] * yc - B.back[1],
    B.right[2] * xc + B.up[2] * yc - B.back[2],
  ];
}

/**
 * Nearest footprint edge the plan-projected ray crosses.
 *
 * Returns the ray parameter t (so the world point is o + t*dir), the building,
 * and |cos| of the incidence angle against the wall's normal. Walls the ray meets
 * edge-on are reported and thrown away by the caller: a metre of footprint error
 * there moves the implied height by tens of metres.
 */
function castPlan(cands, ox, oz, dx, dz) {
  let bestT = Infinity, bestB = -1, bestCos = 0;
  for (const b of cands) {
    const p = b.p;
    for (let i = 0; i < p.length; i++) {
      const A = p[i], C = p[(i + 1) % p.length];
      const ex = C[0] - A[0], ez = C[1] - A[1];
      const den = dx * ez - dz * ex;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((A[0] - ox) * ez - (A[1] - oz) * ex) / den;
      if (t <= 0.5 || t >= bestT) continue;
      const u = (dx * (A[1] - oz) - dz * (A[0] - ox)) / -den;
      if (u < 0 || u > 1) continue;
      const el = Math.hypot(ex, ez) || 1, dl = Math.hypot(dx, dz) || 1;
      bestT = t; bestB = b.i; bestCos = Math.abs((dx * ez - dz * ex) / (dl * el));
    }
  }
  return bestT === Infinity ? null : { t: bestT, b: bestB, cos: bestCos };
}

// ----------------------------------------------------------------- the stations
function allStations(world) {
  const route = world.d.meta.route;
  const idx = JSON.parse(fs.readFileSync(path.join(MLY, 'index.json'), 'utf8')).images;
  const out = [];
  for (const p of idx.filter((i) => i.isPano).sort((a, b) => a.x - b.x)) {
    // roofline-analytic aims from the first four route legs; reproject-pano, which
    // rendered these views, aims from all eight. Where those disagree the view on
    // disk is not looking where this camera looks, and the column-to-column
    // comparison below is meaningless - so it is checked, per station, not assumed.
    const four = bearingAt(route, p.x, p.z, 5).bearing;
    const all = bearingAt(route, p.x, p.z, route.length).bearing;
    const skew = Math.abs(((four - all + 540) % 360) - 180);
    for (const [side, off] of [['L', -90], ['R', 90]]) {
      out.push({ id: p.id, side, x: p.x, z: p.z + DZ, yaw: ((four + off) % 360 + 360) % 360, skew });
    }
  }
  return out;
}

// -------------------------------------------------------------- the measurement
export function measure(world, st) {
  const file = path.join(VIEWS, `${st.id}-${st.side}.png`);
  if (!fs.existsSync(file)) return null;
  const { row, flag } = refColumns(file);
  const B = basisAt(st.x, st.z, st.yaw);
  // Only footprints that can matter: within MAX_D + the biggest plausible radius.
  const cands = world.buildings.map((b, i) => ({ ...b, i }))
    .filter((b) => Math.hypot(b.cx - st.x, b.cz - st.z) < MAX_D + b.r + 5);
  const cols = [];
  const tally = { open: 0, clipped: 0, thin: 0, soft: 0, foliage: 0, glare: 0, nowall: 0, far: 0, grazing: 0, kept: 0 };
  for (let c = 0; c < W; c++) {
    if (flag[c] & 1) { tally.open++; continue; }
    if (flag[c] & 2) { tally.clipped++; continue; }
    if (flag[c] & 4) { tally.thin++; continue; }
    if (flag[c] & 8) { tally.soft++; continue; }
    if (flag[c] & 16) { tally.foliage++; continue; }
    if (flag[c] & 32) { tally.glare++; continue; }
    const d = rayDir(B, c, row[c]);
    const hit = castPlan(cands, B.o[0], B.o[2], d[0], d[2]);
    if (!hit) { tally.nowall++; continue; }
    const dist = hit.t * Math.hypot(d[0], d[2]);
    if (dist > MAX_D) { tally.far++; continue; }
    if (hit.cos < MIN_COS) { tally.grazing++; continue; }
    tally.kept++;
    cols.push({ c, b: hit.b, dist, h: B.o[1] + hit.t * d[1], elev: elevOf(row[c], H), side: st.side, sx: st.x });
  }
  return { st, cols, tally };
}

const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor((s.length - 1) * p)] : NaN; };

// ------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const districtFile = arg('district', 'data/district.json');
  const world = loadWorld(districtFile);
  const bandOnly = arg('band', null);
  const pick = arg('stations', null);
  let sts = allStations(world);
  if (pick) {
    const want = pick.split(',').map(Number);
    sts = want.map((t) => sts.filter((s) => (!arg('side', null) || s.side === arg('side', null)))
      .reduce((a, b) => (Math.abs(b.x - t) < Math.abs(a.x - t) ? b : a)))
      .flatMap((s) => sts.filter((o) => o.id === s.id));
  }
  const side = arg('side', null);
  if (side) sts = sts.filter((s) => s.side === side);

  const skewed = sts.filter((s) => s.skew > 0.5);
  console.log(`world  ${districtFile}  (${world.buildings.length} buildings)`);
  console.log(`views  ${VIEWS}   stations ${sts.length}`
    + (skewed.length ? `   WARNING ${skewed.length} with a route-leg bearing skew > 0.5 deg` : '   (all bearings agree with the reprojection)'));
  console.log(`filters minRun ${MIN_RUN} rows, maxDist ${MAX_D} m, minCos ${MIN_COS}\n`);

  const perB = new Map();
  const perSt = [];
  const tot = { open: 0, clipped: 0, thin: 0, soft: 0, foliage: 0, glare: 0, nowall: 0, far: 0, grazing: 0, kept: 0 };
  for (const st of sts) {
    const r = measure(world, st);
    if (!r) continue;
    for (const k of Object.keys(tot)) tot[k] += r.tally[k];
    for (const col of r.cols) {
      const b = world.buildings[col.b];
      if (bandOnly && b.band !== bandOnly) continue;
      if (!perB.has(col.b)) perB.set(col.b, []);
      perB.get(col.b).push(col);
    }
    perSt.push(r);
  }

  const grand = [...perB.values()].flat().length;
  console.log(`columns: kept ${tot.kept} of ${sts.length * W}`
    + `   rejected open ${tot.open} clipped ${tot.clipped} thin ${tot.thin} soft ${tot.soft}`
    + ` foliage ${tot.foliage} glare ${tot.glare} no-wall ${tot.nowall} far ${tot.far} grazing ${tot.grazing}`);
  console.log(`${grand} of those land on a footprint in scope\n`);

  // ---------------------------------------------------------------- per band
  const bands = new Map();
  for (const [bi, cols] of perB) {
    const b = world.buildings[bi];
    const key = b.band ?? '(none)';
    if (!bands.has(key)) bands.set(key, []);
    bands.get(key).push({ bi, b, cols });
  }
  console.log('per band. ratio = implied / built, per BUILDING median, so a 106 m frontage counts once.');
  console.log('band                    bldgs  cols   built h        implied h (p25/p50/p75)   ratio p50');
  for (const [name, list] of [...bands.entries()].sort()) {
    const nc = list.reduce((t, x) => t + x.cols.length, 0);
    if (nc < 200) continue;
    const impl = list.map((x) => med(x.cols.map((c) => c.h)));
    const built = list.map((x) => x.b.h + x.b.parapet);
    const ratio = list.map((x, i) => impl[i] / built[i]);
    console.log(`${name.padEnd(24)}${String(list.length).padStart(4)}${String(nc).padStart(7)}`
      + `   ${med(built).toFixed(1).padStart(5)}      `
      + `${q(impl, 0.25).toFixed(1).padStart(6)}/${med(impl).toFixed(1).padStart(5)}/${q(impl, 0.75).toFixed(1).padStart(5)}`
      + `        ${med(ratio).toFixed(2).padStart(5)}`);
  }

  if (has('per-building')) {
    console.log('\nper building, most-seen first. `implied` is the median over every column of every view that');
    console.log('lands on it; `spread` is p25-p75 of the same, which is how much the roofline varies ALONG it.');
    console.log('idx   band                  area  front   built  cols   implied   spread      L-implied  R-implied');
    const rows = [...perB.entries()].map(([bi, cols]) => ({ bi, b: world.buildings[bi], cols }))
      .filter((x) => x.cols.length >= 60)
      .sort((a, b) => b.cols.length - a.cols.length);
    for (const { bi, b, cols } of rows) {
      const hs = cols.map((c) => c.h);
      const L = cols.filter((c) => c.side === 'L').map((c) => c.h);
      const R = cols.filter((c) => c.side === 'R').map((c) => c.h);
      const front = Math.max(b.aabb[2] - b.aabb[0], b.aabb[3] - b.aabb[1]);
      const one = (a) => (a.length >= 40 ? `${med(a).toFixed(1)} (${a.length})` : `- (${a.length})`);
      console.log(`${String(bi).padStart(4)}  ${(b.band ?? '-').padEnd(20)}${String(Math.round(world.d.buildings[bi].a ?? 0)).padStart(6)}`
        + `${front.toFixed(0).padStart(7)}${(b.h + b.parapet).toFixed(1).padStart(8)}${String(cols.length).padStart(6)}`
        + `${med(hs).toFixed(1).padStart(10)}   ${`${q(hs, 0.25).toFixed(1)}-${q(hs, 0.75).toFixed(1)}`.padEnd(12)}`
        + `${one(L).padStart(11)}${one(R).padStart(11)}`);
    }
  }

  const out = arg('json', null);
  if (out) {
    fs.writeFileSync(out, JSON.stringify({
      district: districtFile,
      filters: { minRun: MIN_RUN, maxDist: MAX_D, minCos: MIN_COS },
      stations: sts.length, kept: tot.kept, tally: tot,
      buildings: [...perB.entries()].map(([bi, cols]) => ({
        i: bi, band: world.buildings[bi].band, h: world.buildings[bi].h,
        parapet: world.buildings[bi].parapet, n: cols.length,
        implied: { p25: q(cols.map((c) => c.h), 0.25), p50: med(cols.map((c) => c.h)), p75: q(cols.map((c) => c.h), 0.75) },
        dist: med(cols.map((c) => c.dist)),
      })),
    }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}
