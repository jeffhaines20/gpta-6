// How high does OUR streetwall stand, with no detector in the loop at all?
//
// tools/roofline.mjs answers that question from pixels: topmost non-sky pixel per
// column, where "sky" is a colour test. On 2026-09-03 that test was shown to fail
// in one specific, one-sided way. The golden-hour sun sits at bearing 134 deg
// (src/sky.js), every "R" view on this corridor looks into that half of the dome,
// and ACES plus the horizon glow desaturates the sky there until b - r <= 6 and
// then past it to b < r. The detector then stops in the middle of open sky and
// reports a roofline tens of degrees too high - on R views only, always upward.
// Verified at column 900 of 523356163931260-R-golden.png: rows 190 through 689 are
// open sky the detector calls "built", 31.6 deg reported against a true -2.2.
//
// So this file measures the SAME quantity from the geometry instead. It projects
// the baked footprints in data/district.json through the exact camera
// tools/pano-match.mjs captured with and reports the topmost built row per column,
// converted to elevation with roofline.mjs's own elevOf so the two instruments
// are denominated in one scale and cannot drift.
//
//   node tools/roofline-analytic.mjs                          # every station, current world
//   node tools/roofline-analytic.mjs --matched                # ... only the 48 with an engine frame
//   node tools/roofline-analytic.mjs --compare golden         # ... vs the pixel run (implies --matched)
//   node tools/roofline-analytic.mjs --district old.json      # any world, no re-capture
//   node tools/roofline-analytic.mjs --kit                    # full facade kit, not just massing
//   node tools/roofline-analytic.mjs --selftest               # the convention checks
//
// "Every station" is a MOVING NUMBER: two per panorama in
// reference/sarasota/mapillary/index.json, which was 24 panoramas (48 stations)
// when this was written and is 202 (404 stations) as of 2026-09-04. Every run
// prints the count it used and --json records it. See stations() below.
//
// An analytic measurement needs no browser and no capture, which is the point: a
// massing change can be measured against three worlds in one run, and a frame that
// predates the data cannot silently answer about the previous build.
//
// ------------------------------------------------------------------ VALIDATION
//
// Run against the 2026-09-02 golden capture, per COLUMN, 30,720 columns a side:
//
//   L views   median (pixel - analytic)   0.00 deg,  p25 0.0,  p75 +2.7
//   R views   median (pixel - analytic) +14.65 deg,  85% of columns more than
//             2 deg above the geometry and essentially none below it
//
// Twelve of the 24 L views agree with the pixel detector on p50 to within 0.1 deg.
// That is a pixel measurement reproduced from geometry alone, so the camera model,
// the projection, the row scale and the parapet accounting are all confirmed
// against the thing they are meant to predict.
//
// The 2% of L columns where this reads HIGHER than the detector were looked at.
// Both are the detector, not the ray-caster: column 407 of 1722832548583117-L is
// the bayTower's blue curtain wall (88,104,130 - the sky test passes on it), and
// column 1090 of 2726732917519018-L is a pale grey-blue facade with a window and a
// mullion in it. Cropped and looked at, not inferred.
//
// ---------------------------------------------------------------- WHAT IT MODELS
//
// * Height. `b.h` is NOT the top of the rendered building. src/facades.js gives
//   every recipe a parapet - 1.5 m on deco, 0.95 on bayTower, 1.15 on the other
//   five - and appendBuilding() draws it from `height` up to `height + parapet`.
//   That is read from the real buildingStyle(), not re-derived here, so the two
//   cannot disagree. Measured across the district the kit's highest vertex sits
//   1.15 m above `b.h` at the 10th percentile and 7.03 m above it at the maximum;
//   the difference above the parapet is roof furniture (stair bulkheads, water
//   tanks, aerial masts), which --kit includes and the default does not.
//
// * LOD. src/streaming.js draws a chunk within 2 chunks (256 m, Chebyshev, chunk
//   centre to eye) with the full facade kit, out to 5 chunks as one merged
//   AXIS-ALIGNED BOX per building at `b.h` with no parapet, and beyond that not at
//   all. This reproduces that, because a distant skyline measured as if it were
//   near would be both too tall and the wrong width.
//
// * Perspective. Vertical world lines are NOT vertical in a pitched rectilinear
//   frame - they splay outward below the vanishing point, by ~74 px at the edge of
//   a 15 m-away building here. So a building is projected as its wall quads, not
//   as its roof ring: the ring alone loses the columns between the projected roof
//   corner and the projected base corner, which is exactly where a block ends.
//
// ------------------------------------------------------------ WHAT IT OMITS
//
// This is a LOWER BOUND on the rendered silhouette. It contains buildings and the
// ground plane and nothing else. Not modelled, all of which can only push the
// rendered roofline UP relative to this number:
//
//   - palms and street trees (src/streetfurniture.js) - the largest omission on
//     this corridor, and the one that stands closest to the camera
//   - lamp standards, signal masts, benches, bins, poles
//   - signage (src/signage.js): blade signs, fascias, parapet sign blanks
//   - traffic and pedestrians
//   - weather (src/weather.js) and any post effect that paints into the sky
//
// The default also omits the facade kit above the parapet - roof units, deco
// steps, fire escapes, balconies, awnings. Run --kit to include all of those: it
// builds the REAL geometry through facades.js appendBuilding() and takes the upper
// envelope of every triangle, so the gap between the two runs is a measurement of
// how much the kit adds rather than a guess.
//
// --kit builds the kit the STREAMER builds, cost cap and street direction
// included - see prepareWorld. It used to build neither, which made it an upper
// bound on a mesh the renderer never draws: 403,832 triangles against the
// streamer's 337,374, and the excess concentrated on the biggest buildings,
// because the cap's first casualty above floors x perimeter 1800 is roofUnits -
// the tallest add-ons there are. Correcting it moved 2,494 of 517,120 columns
// and dropped the bayfront-marina median from 9.56 to 8.88 deg.
import fs from 'node:fs';
import path from 'node:path';
import * as THREE from '../vendor/three.module.min.js';
import { buildingStyle, appendBuilding, buffers } from '../src/facades.js';
import { StreamingWorld } from '../src/streaming.js';
import { elevOf, CAM } from './roofline.mjs';

const REN = 'docs/shots/pano-match';
const MLY = 'reference/sarasota/mapillary';
const W = 1280, H = 960;                       // the capture size, so rows line up
const NEARP = 0.1;                             // near plane, metres
const TH = Math.tan((CAM.hfovDeg * Math.PI) / 360);
const TV = TH / CAM.aspect;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const has = (k) => process.argv.includes(`--${k}`);

// ------------------------------------------------------------------- the camera
//
// Built with the engine's own THREE.PerspectiveCamera and lookAt, from the same
// eye / target / fov district/main.js freeCam() is handed by pano-match. Guessing
// a basis by hand is how a measurement ends up sharp, plausible and pointing at
// the wrong building; the projection below is then checked against three.js's own
// projectionMatrix in --selftest, so a sign error cannot survive.
export function cameraAt(px, pz, yawDeg) {
  const cam = new THREE.PerspectiveCamera(CAM.vfovDeg, CAM.aspect, NEARP, 5000);
  cam.position.set(px, CAM.eye, pz);
  const rad = (yawDeg * Math.PI) / 180, D = 60;
  cam.lookAt(px + Math.sin(rad) * D, CAM.eye + D * Math.tan((CAM.pitchDeg * Math.PI) / 180),
    pz - Math.cos(rad) * D);
  cam.updateMatrixWorld(true);
  const e = cam.matrixWorldInverse.elements;
  return { e, cam };
}

/** World -> view space, with the camera looking down -z. */
const vX = (e, x, y, z) => e[0] * x + e[4] * y + e[8] * z + e[12];
const vY = (e, x, y, z) => e[1] * x + e[5] * y + e[9] * z + e[13];
const vZ = (e, x, y, z) => e[2] * x + e[6] * y + e[10] * z + e[14];

// ------------------------------------------------------- clip, project, envelope
//
// Scratch buffers, reused: this runs a few million polygons per world and the
// allocator is otherwise the whole cost.
const cv = new Float64Array(3 * 16), cw = new Float64Array(3 * 16), sc = new Float64Array(2 * 16);

/** Sutherland-Hodgman against the near plane, in view space. Convex in, convex out. */
function clipNear(n) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const az = cv[3 * i + 2], bz = cv[3 * j + 2];
    const ain = az <= -NEARP, bin = bz <= -NEARP;
    if (ain) { cw[3 * m] = cv[3 * i]; cw[3 * m + 1] = cv[3 * i + 1]; cw[3 * m + 2] = az; m++; }
    if (ain !== bin) {
      const t = (-NEARP - az) / (bz - az);
      cw[3 * m] = cv[3 * i] + (cv[3 * j] - cv[3 * i]) * t;
      cw[3 * m + 1] = cv[3 * i + 1] + (cv[3 * j + 1] - cv[3 * i + 1]) * t;
      cw[3 * m + 2] = -NEARP;
      m++;
    }
  }
  for (let i = 0; i < m * 3; i++) cv[i] = cw[i];
  return m;
}

/** View space -> pixel centres. Row 0 is the top of the frame, as in the PNG. */
function project(n) {
  for (let i = 0; i < n; i++) {
    const iz = -1 / cv[3 * i + 2];
    sc[2 * i] = W * 0.5 * (1 + (cv[3 * i] * iz) / TH);
    sc[2 * i + 1] = H * 0.5 * (1 - (cv[3 * i + 1] * iz) / TV);
  }
}

/**
 * Fold one projected convex polygon into the running per-column topmost row.
 *
 * `top[c]` is the smallest row index any object covers in column c, where a pixel
 * counts as covered when the polygon contains its CENTRE - the same rule the
 * rasteriser uses, so the analytic row and the pixel row are the same integer and
 * not two quantities half a pixel apart.
 *
 * `free` gets the same row WITHOUT clamping to the frame. Nothing forces an
 * analytic measurement to stop at row 0 the way a photograph does, so a wall that
 * overflows the top of frame still gets a number instead of the pinned 41.9 that
 * roofline.mjs has to report. 62% of the Main St east columns were pinned in the
 * pixel run; "at least 41.9" cannot say whether a change helped.
 */
function fold(n, top, free) {
  let xmin = Infinity, xmax = -Infinity;
  for (let i = 0; i < n; i++) { const x = sc[2 * i]; if (x < xmin) xmin = x; if (x > xmax) xmax = x; }
  let c0 = Math.ceil(xmin - 0.5), c1 = Math.floor(xmax - 0.5);
  if (c1 < 0 || c0 > W - 1) return;
  if (c0 < 0) c0 = 0;
  if (c1 > W - 1) c1 = W - 1;
  for (let c = c0; c <= c1; c++) {
    const X = c + 0.5;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const ax = sc[2 * i], ay = sc[2 * i + 1], bx = sc[2 * j], by = sc[2 * j + 1];
      if ((ax <= X && bx >= X) || (bx <= X && ax >= X)) {
        const d = bx - ax;
        if (Math.abs(d) < 1e-12) {
          if (ay < lo) lo = ay; if (by < lo) lo = by;
          if (ay > hi) hi = ay; if (by > hi) hi = by;
        } else {
          const y = ay + (by - ay) * ((X - ax) / d);
          if (y < lo) lo = y; if (y > hi) hi = y;
        }
      }
    }
    if (lo === Infinity) continue;
    const rowFree = Math.ceil(lo - 0.5);
    if (rowFree + 0.5 > hi) continue;           // nothing of this polygon covers a pixel centre
    if (rowFree < free[c]) free[c] = rowFree;
    const row = rowFree < 0 ? 0 : rowFree;      // clamped: what a frame this size can show
    if (row >= H || row + 0.5 > hi) continue;   // covered only above the top of frame
    if (row < top[c]) top[c] = row;
  }
}

/** Push one world-space polygon (flat [x,y,z,...]) through clip -> project -> fold. */
function emit(e, poly, n, top, free) {
  for (let i = 0; i < n; i++) {
    const x = poly[3 * i], y = poly[3 * i + 1], z = poly[3 * i + 2];
    cv[3 * i] = vX(e, x, y, z); cv[3 * i + 1] = vY(e, x, y, z); cv[3 * i + 2] = vZ(e, x, y, z);
  }
  let m = n;
  let anyFront = false;
  for (let i = 0; i < n; i++) if (cv[3 * i + 2] <= -NEARP) { anyFront = true; break; }
  if (!anyFront) return;
  let allFront = true;
  for (let i = 0; i < n; i++) if (cv[3 * i + 2] > -NEARP) { allFront = false; break; }
  if (!allFront) { m = clipNear(n); if (m < 3) return; }
  project(m);
  fold(m, top, free);
}

// ------------------------------------------------------------------- the world
//
// One prepared world = one district JSON, plus everything about it that does not
// depend on where the camera stands.
//
// The near tier is what the STREAMER draws, and the streamer does not hand
// buildingStyle()'s output to appendBuilding() untouched. Two things sit between
// them, and both are borrowed here off StreamingWorld.prototype rather than
// re-derived, for the same reason the kit itself is: a copy drifts.
//
//   * _capStyle. A per-building cost cap that keeps one expensive style from
//     blowing the stall budget. On this district it changes 33 of 523 buildings:
//     36 exceed floors x perimeter 1400 (25 lose balconies, 4 lose a fire
//     escape) and 25 exceed 1800, of which 23 have roofUnits capped to 3. Roof
//     units are the TALLEST add-ons - bulkheads, tanks, masts - so an uncapped
//     --kit overstates the silhouette on exactly the large buildings that set a
//     roofline. It changes `parapet`, `height` and `recipe` on zero buildings,
//     which is why the default path below reads the same either way; that is
//     asserted, not assumed, in selftest check 5.
//   * street. The direction of the nearest road, which is where storefronts,
//     awnings and balconies get pointed. Passing {} put them on an arbitrary
//     face.
export function prepareWorld(d, file, opts = {}) {
  const cs = d.meta.chunkSize;
  // A minimal receiver carrying only the fields these two methods read. Calling
  // the real functions is the point; constructing a real StreamingWorld would
  // need a scene, a renderer and the whole material registry.
  const asStreamer = { d, chunkSize: cs, keyOf: StreamingWorld.prototype.keyOf };
  const capStyle = (style, b) => StreamingWorld.prototype._capStyle.call(asStreamer, style, b);
  const streetDirFor = (b) => StreamingWorld.prototype._streetDirFor.call(asStreamer, b);
  const chunkOf = new Array(d.buildings.length);
  for (const [key, ch] of Object.entries(d.chunks)) {
    const [cx, cz] = key.split(',').map(Number);
    for (const bi of ch.buildings) chunkOf[bi] = [(cx + 0.5) * cs, (cz + 0.5) * cs];
  }
  const B = d.buildings.map((b, bi) => {
    const style = capStyle(buildingStyle(b), b);
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const [x, z] of b.p) {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
    }
    const rec = {
      p: b.p, h: b.h, band: b.b ?? null, recipe: style.recipe,
      parapet: style.parapet ? style.parapet.height : 0,
      aabb: [x0, z0, x1, z1], cx: (x0 + x1) / 2, cz: (z0 + z1) / 2,
      r: Math.hypot(x1 - x0, z1 - z0) / 2,
      chunk: chunkOf[bi] ?? [(x0 + x1) / 2, (z0 + z1) / 2],
      tris: null,
    };
    if (opts.kit) {
      // The real kit, into scratch buffers, exactly as the streamer builds it -
      // the same argument tools/geom-audit.mjs makes for running the helpers
      // rather than re-deriving their arithmetic. Only positions and indices are
      // read; no material, texture or UV is touched.
      const wall = buffers(), trim = buffers();
      appendBuilding(b.p, b.h, style, wall, trim,
    // Pass BOTH, exactly as the streamer does. Passing only `street` measured
    // a world nobody renders: the corner-frontage path is keyed on `streets`,
    // so a before/after run of this tool reported a byte-identical district
    // while the engine was building a different one.
    { street: streetDirFor(b), streets: geomStreetDirsFor(d, b, 2) });
      const nv = wall.pos.length / 3;
      const pos = new Float64Array(wall.pos.length + trim.pos.length);
      pos.set(wall.pos, 0); pos.set(trim.pos, wall.pos.length);
      const idx = new Int32Array(wall.idx.length + trim.idx.length);
      idx.set(wall.idx, 0);
      for (let i = 0; i < trim.idx.length; i++) idx[wall.idx.length + i] = trim.idx[i] + nv;
      rec.tris = { pos, idx };
    }
    return rec;
  });
  return { file, d, chunkSize: cs, buildings: B, kit: !!opts.kit };
}

export function loadWorld(file, opts = {}) {
  return prepareWorld(JSON.parse(fs.readFileSync(file, 'utf8')), file, opts);
}

/**
 * The same world with every building height rewritten - re-prepared from the
 * district JSON, NOT patched onto the prepared records.
 *
 * That distinction is the whole of selftest check 4. The old version mapped over
 * `world.buildings` and wrote `{ ...b, h: b.h + 20 }`, which carries the prebuilt
 * `tris` across unchanged; under --kit the near tier then re-rendered identical
 * geometry and the check read the base number for every arm. Going back through
 * prepareWorld re-runs buildingStyle, the cap and appendBuilding, so the kit is
 * rebuilt at the new heights and the arm can actually move.
 */
export function withHeights(world, fn) {
  const d = { ...world.d, buildings: world.d.buildings.map((b, i) => ({ ...b, h: fn(b.h, b, i) })) };
  // _capStyle memoises the perimeter onto the building record; the spread above
  // carries a stale one only if the footprint changed, and it does not.
  return prepareWorld(d, world.file, { kit: world.kit });
}

// ---------------------------------------------------------------- the stations
//
// The same corridor bearing pano-match.mjs used, recomputed from the world being
// measured rather than copied from the capture index - so measuring a different
// world re-aims the camera if that world moved the route. index.json's stamped
// yaw is then checked against it, which is the test that this file's camera is
// the capture's camera and not a near miss.
export function bearingAt(route, x, z, legs = 5) {
  let best = 0, bestD = Infinity, bestSeg = -1;
  for (let i = 0; i + 1 < legs; i++) {
    const a = route[i], b = route[i + 1];
    const dx = b.x - a.x, dz = b.z - a.z, len2 = dx * dx + dz * dz || 1;
    let t = ((x - a.x) * dx + (z - a.z) * dz) / len2;
    t = Math.max(0, Math.min(1, t));
    const dd = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
    if (dd < bestD) { bestD = dd; best = (Math.atan2(dx, -dz) * 180) / Math.PI; bestSeg = i; }
  }
  return { bearing: (best + 360) % 360, seg: bestSeg, dist: bestD };
}

/**
 * The L/R pair for every panorama in the Mapillary index, or just those with a
 * matched engine frame.
 *
 * THE POPULATION IS NOT FIXED and the number in it is not 48. It is however many
 * panoramas reference/sarasota/mapillary/index.json holds, times two, and that
 * file grows whenever the corridor is re-fetched: 24 panoramas (48 stations) when
 * this tool was written, 202 panoramas (404 stations) on 2026-09-04 after the
 * fetch cap was lifted. The medians moved with it - mainst-east 27.7 -> 25.6,
 * fivepoints-approach 22.8 -> 24.3, bayfront 24.1 -> 23.8 - and nothing in the
 * output said which population had produced them. Every caller and every printed
 * summary now states the count, because two runs of "the default" are not
 * necessarily runs over the same corridor.
 *
 * The growth is not a measurement error: all 404 stations sit within 25.4 m of
 * meta.route, so they are all on the corridor this instrument is aimed at.
 *
 * `{ matched: true }` restricts to the stations that docs/shots/pano-match
 * captured an engine frame for - 48 of the 404 today. Only those are comparable
 * against a pixel run, and --compare / --reference therefore imply it: before
 * this, `--legs --reference golden` threw a TypeError on the first station with
 * no pixel counterpart, and `--compare` silently printed 48 lines while writing
 * all 404 into --json.
 */
export function matchedFrames() {
  const f = path.join(REN, 'index.json');
  if (!fs.existsSync(f)) return null;
  return new Set(JSON.parse(fs.readFileSync(f, 'utf8')).frames.map((x) => `${x.id}-${x.side}`));
}

export function stations(world, opts = {}) {
  const route = world.d.meta.route;
  const idx = JSON.parse(fs.readFileSync(path.join(MLY, 'index.json'), 'utf8')).images;
  const out = [];
  for (const p of idx.filter((i) => i.isPano).sort((a, b) => a.x - b.x)) {
    const { bearing, seg } = bearingAt(route, p.x, p.z);
    for (const [side, off] of [['L', -90], ['R', 90]]) {
      out.push({ id: p.id, side, x: p.x, z: p.z, yaw: ((bearing + off) % 360 + 360) % 360, seg });
    }
  }
  if (!opts.matched) return out;
  const keep = matchedFrames();
  if (!keep) throw new Error(`--matched needs ${path.join(REN, 'index.json')}, which is not there`);
  return out.filter((s) => keep.has(`${s.id}-${s.side}`));
}

// Two ways to cut the corridor into legs.
//
// `published` is the partition the 2026-09-02 ledger entry reported against,
// kept verbatim so its claims can be re-tested rather than quietly restated.
// It bins by x threshold, which puts two stations on the Five Points approach
// (x = 34.6 and x = 54.6, both on the Pineapple -> Five Points route leg,
// corridor bearing 13.7) into "Pineapple". `route` is the honest partition:
// which leg of meta.route the station actually stands on, which is also what
// decided the bearing it was shot at.
export const LEG_NAMES = ['bayfront-marina', 'bayfront', 'fivepoints-approach', 'mainst-east'];
export const legRoute = (s) => LEG_NAMES[s.seg] ?? `seg${s.seg}`;
export const legPublished = (s) => (s.x >= 57 ? 'MainStE'
  : s.x <= -138 ? 'bayfront'
    : Math.abs(s.z + 121.7) < 1 && Math.abs(s.x - 54.4) < 1 ? 'FivePtsApproach' : 'Pineapple');

// ---------------------------------------------------------------- the measurement
/**
 * Topmost built row per column, for one world seen from one station.
 *
 * @returns {{cols:number[], rows:Int32Array, p10:number, p50:number, p90:number,
 *            clippedFrac:number, openFrac:number, buildFrac:number,
 *            near:number, far:number, unloaded:number}}
 */
export function silhouette(world, st, opts = {}) {
  const ground = opts.ground !== false;
  const { e } = cameraAt(st.x, st.z, st.yaw);
  const rows = new Int32Array(W).fill(H);       // H = "nothing here"
  const bRows = new Int32Array(W).fill(H);     // buildings only
  const free = new Int32Array(W).fill(H);      // ... and unclamped by the frame edge
  const cs = world.chunkSize, nearR = 2, farR = 5;
  const poly = new Float64Array(48);
  let near = 0, far = 0, unloaded = 0;

  for (const b of world.buildings) {
    const cd = Math.max(Math.abs(b.chunk[0] - st.x), Math.abs(b.chunk[1] - st.z)) / cs;
    const lod = cd <= nearR ? 0 : cd <= farR ? 1 : -1;
    if (lod < 0) { unloaded++; continue; }
    if (b.h <= 0) continue;
    // Behind the camera by more than its own radius: cannot contribute a column.
    const dz = vZ(e, b.cx, CAM.eye, b.cz);
    if (dz > b.r + 4) { continue; }
    if (lod === 0) near++; else far++;

    if (lod === 1) {
      // FAR tier: streaming.js replaces the footprint with its axis-aligned box
      // at b.h and drops the whole kit, parapet included.
      const [x0, z0, x1, z1] = b.aabb;
      const ring = [[x0, z0], [x1, z0], [x1, z1], [x0, z1]];
      for (let i = 0; i < 4; i++) {
        const a = ring[i], c = ring[(i + 1) % 4];
        poly[0] = a[0]; poly[1] = 0; poly[2] = a[1];
        poly[3] = c[0]; poly[4] = 0; poly[5] = c[1];
        poly[6] = c[0]; poly[7] = b.h; poly[8] = c[1];
        poly[9] = a[0]; poly[10] = b.h; poly[11] = a[1];
        emit(e, poly, 4, bRows, free);
      }
      continue;
    }

    if (world.kit) {
      const { pos, idx } = b.tris;
      for (let t = 0; t < idx.length; t += 3) {
        for (let k = 0; k < 3; k++) {
          const o = idx[t + k] * 3;
          poly[3 * k] = pos[o]; poly[3 * k + 1] = pos[o + 1]; poly[3 * k + 2] = pos[o + 2];
        }
        emit(e, poly, 3, bRows, free);
      }
    } else {
      const y = b.h + b.parapet;
      const ring = b.p;
      for (let i = 0; i < ring.length; i++) {
        const a = ring[i], c = ring[(i + 1) % ring.length];
        poly[0] = a[0]; poly[1] = 0; poly[2] = a[1];
        poly[3] = c[0]; poly[4] = 0; poly[5] = c[1];
        poly[6] = c[0]; poly[7] = y; poly[8] = c[1];
        poly[9] = a[0]; poly[10] = y; poly[11] = a[1];
        emit(e, poly, 4, bRows, free);
      }
    }
  }
  for (let c = 0; c < W; c++) rows[c] = bRows[c];

  if (ground) {
    // Why the ground is in here. The pixel instrument reports the topmost NON-SKY
    // pixel, and in a column with no building that is the road, not nothing: all
    // 48 frames of the 2026-09-02 golden capture have skyFrac 0. Leaving it out would
    // compare a median over "columns with a building" against a median over "all
    // columns" and call the difference massing.
    const bb = world.d.meta.bounds, pad = 900;
    const planes = [
      [bb.x0 - pad, bb.z0 - pad, bb.x1 + pad, bb.z1 + pad, -0.45],   // water
      [bb.x0, bb.z0, bb.x1, bb.z1, -0.05],                            // land pad
    ];
    for (const [x0, z0, x1, z1, y] of planes) {
      poly[0] = x0; poly[1] = y; poly[2] = z0;
      poly[3] = x1; poly[4] = y; poly[5] = z0;
      poly[6] = x1; poly[7] = y; poly[8] = z1;
      poly[9] = x0; poly[10] = y; poly[11] = z1;
      emit(e, poly, 4, rows, free);
    }
  }

  const cols = [], seen = [], seenFree = [];
  let clipped = 0, open = 0, built = 0;
  for (let c = 0; c < W; c++) {
    if (bRows[c] < H) built++;
    if (free[c] < H) seenFree.push(elevOf(free[c], H));
    if (rows[c] >= H) { cols.push(null); open++; continue; }
    if (rows[c] === 0) clipped++;
    const v = elevOf(rows[c], H);
    cols.push(v); seen.push(v);
  }
  seen.sort((a, b) => a - b);
  seenFree.sort((a, b) => a - b);
  const q = (p) => (seen.length ? seen[Math.floor((seen.length - 1) * p)] : null);
  const qf = (p) => (seenFree.length ? seenFree[Math.floor((seenFree.length - 1) * p)] : null);
  return {
    id: st.id, side: st.side, yaw: +st.yaw.toFixed(3),
    p10: q(0.1), p50: q(0.5), p90: q(0.9),
    // The same three, with no frame edge in the way. Comparable to another
    // analytic run but NOT to a pixel run, which cannot see past row 0.
    p10Free: qf(0.1), p50Free: qf(0.5), p90Free: qf(0.9),
    skyFrac: +(open / W).toFixed(3), clippedFrac: +(clipped / W).toFixed(3),
    buildFrac: +(built / W).toFixed(3),
    near, far, unloaded, rows, free, cols,
  };
}

// -------------------------------------------------------------------- selftest
//
// Three things this file could get silently wrong, each checked so it cannot.
function selftest(world) {
  let bad = 0;
  const fail = (m) => { console.log(`  FAIL  ${m}`); bad++; };
  const ok = (m) => console.log(`  ok    ${m}`);

  // 1. The hand-rolled projection against three.js's own projection matrix. A
  //    sign error here bends the frame and nothing about the output looks broken.
  {
    const { e, cam } = cameraAt(100, -160, 90);
    let worst = 0;
    for (const p of [[120, 8, -150], [90, 3, -200], [400, 30, -160], [101, 1, -161]]) {
      const v = new THREE.Vector3(...p).project(cam);
      const sx3 = W * 0.5 * (v.x + 1), sy3 = H * 0.5 * (1 - v.y);
      const vx = vX(e, ...p), vy = vY(e, ...p), vz = vZ(e, ...p), iz = -1 / vz;
      const sx = W * 0.5 * (1 + (vx * iz) / TH), sy = H * 0.5 * (1 - (vy * iz) / TV);
      worst = Math.max(worst, Math.abs(sx - sx3), Math.abs(sy - sy3));
    }
    worst < 1e-6 ? ok(`projection matches THREE.Vector3.project to ${worst.toExponential(1)} px`)
      : fail(`projection differs from three.js by ${worst} px`);
  }

  // 2. The row scale. A point placed at a known elevation dead ahead must come
  //    back at that elevation, and the horizon must land where elevOf says 0 is.
  {
    const { e } = cameraAt(0, 0, 0);
    let worst = 0;
    for (const deg of [-10, 0, 5, 12, 25, 35]) {
      const d = 200, y = CAM.eye + d * Math.tan((deg * Math.PI) / 180);
      const vy = vY(e, 0, y, -d), vz = vZ(e, 0, y, -d);
      const sy = H * 0.5 * (1 - (vy * (-1 / vz)) / TV);
      worst = Math.max(worst, Math.abs(elevOf(sy - 0.5, H) - deg));
    }
    worst < 1e-6 ? ok(`row scale agrees with roofline.mjs elevOf to ${worst.toExponential(1)} deg`)
      : fail(`row scale off by ${worst} deg`);
  }

  // 3. The yaws. Recomputed from this world's route, against the yaw pano-match
  //    stamped into the capture index. If these disagree the analytic camera is
  //    not the captured camera and every number below is about another street.
  const ix = path.join(REN, 'index.json');
  if (fs.existsSync(ix)) {
    const stamp = JSON.parse(fs.readFileSync(ix, 'utf8'));
    const mine = Object.fromEntries(stations(world).map((s) => [`${s.id}-${s.side}`, s.yaw]));
    let worst = 0, n = 0;
    for (const f of stamp.frames) {
      const m = mine[`${f.id}-${f.side}`];
      if (m === undefined) { fail(`capture index has ${f.id}-${f.side}, this world has no such station`); continue; }
      let d = Math.abs(((m - f.yaw + 540) % 360) - 180);
      worst = Math.max(worst, d); n++;
    }
    worst <= 0.05 ? ok(`${n} stamped yaws reproduced to ${worst.toFixed(3)} deg`)
      : fail(`stamped yaw differs by up to ${worst.toFixed(2)} deg`);
    for (const k of ['eye', 'pitchDeg', 'hfovDeg']) {
      const want = { eye: CAM.eye, pitchDeg: CAM.pitchDeg, hfovDeg: CAM.hfovDeg }[k];
      if (stamp[k] !== undefined && Math.abs(stamp[k] - want) > 1e-9) fail(`capture ${k} ${stamp[k]} != ${want}`);
    }
  }

  // 4. Can it produce the opposite reading? Raise every building 20 m and the
  //    measurement must go UP; drop the whole district to one storey and it must
  //    come DOWN while staying above the horizon; flatten it away entirely and it
  //    must fall TO the horizon. A probe that cannot move is not measuring
  //    anything.
  //
  //    Under --kit this check was vacuous in two independent ways, both found by
  //    a review on 2026-09-04, and the second is the one worth remembering.
  //
  //      * It perturbed the PREPARED records - `{ ...b, h: b.h + 20 }` - which
  //        carries `tris`, the prebuilt kit geometry, across untouched. The near
  //        tier re-rendered the identical mesh, so every arm read the base
  //        number: `base 28.1, +20 m 28.1`. It failed loudly, which is the only
  //        reason it was caught. The arms now go back through prepareWorld
  //        (withHeights), which re-runs buildingStyle, the cap and
  //        appendBuilding at the new heights.
  //      * Its station, 1414553883288835-R, is one where the kit sets NO column:
  //        measured off the massing prism instead, 0 of 1280 columns move and
  //        p50free is 28.15 either way. Rebuilding the geometry would have fixed
  //        the first defect and left the check still blind to appendBuilding's
  //        output - a green tick for a code path with nothing downstream of it.
  //
  //    So under --kit the station is chosen for kit sensitivity and that
  //    sensitivity is ASSERTED FIRST. If no station on the corridor reads higher
  //    with the kit than without it, this fails rather than proceeding to
  //    measure a quantity the kit does not reach.
  {
    const sts = stations(world);
    const at = (id, side) => sts.find((s) => s.side === side && s.id === id);
    // The published default-mode station, kept so that check's number stays
    // comparable across the ledger.
    let st = at('1414553883288835', 'R') ?? sts[0];

    if (world.kit) {
      const massing = loadWorld(world.file, { kit: false });
      const gapAt = (t) => {
        const m = silhouette(massing, t), k = silhouette(world, t);
        let cols = 0;
        for (let c = 0; c < W; c++) if (m.free[c] !== k.free[c]) cols++;
        return { cols, m: m.p50Free, k: k.p50Free, d: k.p50Free - m.p50Free, clip: k.clippedFrac };
      };
      // Preferred station first - measured 2026-09-04 at +6.06 deg - and a full
      // scan only if it has gone missing or gone blind, so the common path stays
      // two silhouettes rather than 808.
      let pick = at('2183328815516771', 'L'), g = pick && gapAt(pick);
      if (!g || g.d <= 0.5) {
        pick = null; g = null;
        for (const t of sts) {
          const c = gapAt(t);
          if (c.clip > 0.05) continue;          // a station filled to the frame edge reads nothing useful
          if (!g || c.d > g.d) { pick = t; g = c; }
        }
      }
      if (!pick || g.d <= 0.5) {
        fail(`no station where the kit outreads the massing prism (best ${g ? g.d.toFixed(2) : 'n/a'} deg)`
          + ' - the response check below would be blind to appendBuilding');
      } else {
        st = pick;
        ok(`kit is what is read at ${st.id}-${st.side}: ${g.cols} of ${W} columns differ from the massing`
          + ` prism, p50free ${g.m.toFixed(2)} -> ${g.k.toFixed(2)} (+${g.d.toFixed(2)} deg)`);
      }
    }

    const base = silhouette(world, st).p50Free;
    const up = silhouette(withHeights(world, (h) => h + 20), st).p50Free;
    const low = silhouette(withHeights(world, () => 4), st).p50Free;
    const dn = silhouette(withHeights(world, () => 0), st).p50Free;
    // `low` is the arm that keeps the DOWNWARD direction honest under --kit:
    // `flat` sets h = 0, which trips `if (b.h <= 0) continue` before the kit path
    // is reached, so on its own it only ever proved the ground plane lands at the
    // horizon. At one storey every building still goes through appendBuilding.
    (up > base + 5 && low < base - 5 && low > 0.5 && dn < 0.5 && dn > -1.5)
      ? ok(`responds to the world at ${st.id}-${st.side}: +20 m -> ${up.toFixed(1)}, one storey -> ${low.toFixed(1)},`
        + ` flattened -> ${dn.toFixed(1)} (base ${base.toFixed(1)})`)
      : fail(`does not respond: base ${base.toFixed(1)}, +20 m ${up.toFixed(1)}, one storey ${low.toFixed(1)},`
        + ` flat ${dn.toFixed(1)}`);
  }

  // 5. The cost cap changes the kit and NOT the massing. prepareWorld now runs
  //    every style through StreamingWorld's _capStyle, because the streamer does
  //    and an uncapped --kit overstates the silhouette on the largest buildings.
  //    The default path reads only `recipe` and `parapet.height` off that style,
  //    so it must be bit-identical either way - stated as a comment up there,
  //    measured here, because a future cap that trimmed a parapet would move
  //    every default number in this file with nothing to say so.
  {
    let capped = 0, moved = 0, worst = 0;
    const asStreamer = { d: world.d, chunkSize: world.chunkSize, keyOf: StreamingWorld.prototype.keyOf };
    for (const b of world.d.buildings) {
      const raw = buildingStyle(b);
      const before = [raw.recipe, raw.parapet ? raw.parapet.height : 0];
      const cap = StreamingWorld.prototype._capStyle.call(asStreamer, buildingStyle(b), b);
      if (cap.balconies !== raw.balconies || cap.fireEscape !== raw.fireEscape || cap.roofUnits !== raw.roofUnits) capped++;
      const after = [cap.recipe, cap.parapet ? cap.parapet.height : 0];
      if (before[0] !== after[0] || before[1] !== after[1]) { moved++; worst = Math.max(worst, Math.abs(before[1] - after[1])); }
    }
    moved === 0
      ? ok(`cost cap trims ${capped} of ${world.d.buildings.length} buildings and moves no parapet or recipe`)
      : fail(`cost cap changed recipe or parapet on ${moved} buildings (worst ${worst.toFixed(2)} m)`
        + ' - the default massing path is no longer independent of it');
  }
  return bad;
}

// ------------------------------------------------------------------------- CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const districtFile = arg('district', 'data/district.json');
  const world = loadWorld(districtFile, { kit: has('kit') });
  console.log(`world  ${districtFile}  (${world.buildings.length} buildings, ${has('kit') ? 'FULL FACADE KIT (streamer cost cap applied)' : 'massing + parapet'})`);
  console.log(`camera eye ${CAM.eye} m, pitch ${CAM.pitchDeg} deg, hfov ${CAM.hfovDeg} on ${CAM.aspect.toFixed(3)} -> vfov ${CAM.vfovDeg.toFixed(2)}, ${W}x${H}`);

  // Which population produced the numbers below. Not decoration: the Mapillary
  // index grew from 24 panoramas to 202 on 2026-09-04 and every median in the
  // ledger moved with it, with nothing in the output to distinguish the two runs.
  // Comparing against a pixel run only makes sense on the frames that were
  // captured, so --compare and --reference restrict to those rather than
  // half-printing (--compare) or throwing (--legs --reference).
  const matchedOnly = has('matched') || has('compare') || has('reference');
  const POP = stations(world);
  const PANOS = new Set(POP.map((s) => s.id)).size;
  const MATCHED = matchedFrames();
  const SEL = matchedOnly ? stations(world, { matched: true }) : POP;
  console.log(matchedOnly
    ? `stations ${SEL.length} of ${POP.length}, restricted to those with a matched engine frame in ${REN}/index.json`
      + `${has('matched') ? '' : ' (implied by --compare/--reference)'}`
    : `stations ${POP.length} = ${PANOS} panoramas x L/R, from ${MLY}/index.json`
      + `  (--matched restricts to the ${MATCHED ? MATCHED.size : 0} with an engine frame)`);

  if (has('selftest')) {
    console.log('\nselftest');
    const bad = selftest(world);
    console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nall checks passed');
    process.exit(bad ? 1 : 0);
  }

  // ------------------------------------------------------------ per-leg summary
  //
  // The point of an analytic instrument: measure a massing change against every
  // world it passed through without re-capturing any of them. `--worlds` takes
  // name=path pairs; the built side comes from geometry and the reference side,
  // which is a photograph and therefore has no geometry, stays on pixels.
  if (has('legs')) {
    const spec = arg('worlds', `after=${districtFile}`);
    const worlds = spec.split(',').map((s) => {
      const [name, file] = s.split('=');
      return { name, file, w: file === districtFile ? world : loadWorld(file, { kit: has('kit') }) };
    });
    const refRun = arg('reference', null);
    let ref = null;
    if (refRun) {
      const f = path.join(REN, `roofline-${refRun}.json`);
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      ref = Object.fromEntries(j.pairs.map((p) => [`${p.id}-${p.side}`, p.reference]));
    }
    const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : NaN; };
    const mean = (a) => a.reduce((t, v) => t + v, 0) / (a.length || 1);
    const per = {};
    for (const { name, w } of worlds) {
      for (const st of stations(w, { matched: matchedOnly })) {
        const r = silhouette(w, st);
        const k = `${st.id}-${st.side}`;
        (per[k] ??= { st }).st = st;
        per[k][name] = r;
      }
    }
    for (const partition of [['route', legRoute], ['published', legPublished]]) {
      const [pname, fn] = partition;
      console.log(`\n=== legs by ${pname} partition ===`);
      const legs = {};
      for (const [k, v] of Object.entries(per)) (legs[fn(v.st)] ??= []).push(k);
      const head = worlds.map((w) => `${w.name} clamp/free`.padStart(13)).join('');
      console.log(`leg                    side   n  ${head}   ` + (ref ? 'ref(px)   ' + worlds.map((w) => `${w.name}-ref`.padStart(10)).join('') : ''));
      for (const [L, ks] of Object.entries(legs)) {
        for (const side of ['L', 'R', '*']) {
          const sel = ks.filter((k) => side === '*' || per[k].st.side === side);
          if (!sel.length) continue;
          const cells = worlds.map((w) => `${med(sel.map((k) => per[k][w.name].p50)).toFixed(1)}/${med(sel.map((k) => per[k][w.name].p50Free)).toFixed(1)}`.padStart(13)).join('');
          let tail = '';
          if (ref) {
            const rr = med(sel.map((k) => ref[k].p50));
            tail = `${rr.toFixed(1).padStart(8)}   `
              + worlds.map((w) => med(sel.map((k) => per[k][w.name].p50 - ref[k].p50)).toFixed(1).padStart(10)).join('');
          }
          console.log(`${L.padEnd(22)} ${side}  ${String(sel.length).padStart(2)}  ${cells}   ${tail}`);
        }
      }
      console.log('\nmean fraction of columns filled to the top of frame (a lower bound, not a measurement):');
      for (const [L, ks] of Object.entries(legs)) {
        const cells = worlds.map((w) => `${(mean(ks.map((k) => per[k][w.name].clippedFrac)) * 100).toFixed(0)}%`.padStart(9)).join('');
        const rr = ref ? `   reference ${(mean(ks.map((k) => ref[k].clippedFrac)) * 100).toFixed(0)}%` : '';
        console.log(`  ${L.padEnd(22)} n=${String(ks.length).padStart(2)} ${cells}${rr}`);
      }
    }
    process.exit(0);
  }

  const only = arg('id', null), onlySide = arg('side', null);
  const sts = SEL.filter((s) => (!only || s.id === only) && (!onlySide || s.side === onlySide));
  if (!sts.length) { console.error('no stations selected'); process.exit(2); }

  const cmp = arg('compare', null);
  let pix = null;
  if (cmp) {
    const f = path.join(REN, `roofline-${cmp}.json`);
    if (!fs.existsSync(f)) { console.error(`no pixel run at ${f}`); process.exit(2); }
    const j = JSON.parse(fs.readFileSync(f, 'utf8'));
    pix = Object.fromEntries(j.pairs.map((p) => [`${p.id}-${p.side}`, p]));
  }

  console.log('\nanalytic roofline, degrees above the horizon. LOWER BOUND: buildings and ground only.\n');
  console.log(pix
    ? 'pair                   analytic  pixel-built  pix-ana   analytic clip%  pixel clip%'
    : 'pair                   p10     p50     p90   p50free   clip%  built-cols%  near/far/unloaded');
  const rows = [];
  for (const st of sts) {
    const r = silhouette(world, st);
    const k = `${st.id}-${st.side}`;
    if (pix && pix[k]) {
      const d = pix[k].built.p50 - r.p50;
      console.log(`${k.padEnd(22)} ${r.p50.toFixed(1).padStart(7)} ${pix[k].built.p50.toFixed(1).padStart(11)} `
        + `${(d >= 0 ? '+' : '') + d.toFixed(1)}`.padStart(9)
        + `${(r.clippedFrac * 100).toFixed(0).padStart(13)}% ${(pix[k].built.clippedFrac * 100).toFixed(0).padStart(11)}%`);
    } else if (!pix) {
      console.log(`${k.padEnd(22)} ${r.p10.toFixed(1).padStart(6)} ${r.p50.toFixed(1).padStart(7)} ${r.p90.toFixed(1).padStart(7)} ${r.p50Free.toFixed(1).padStart(8)}`
        + `${(r.clippedFrac * 100).toFixed(0).padStart(7)}% ${(r.buildFrac * 100).toFixed(0).padStart(11)}%`
        + `      ${r.near}/${r.far}/${r.unloaded}`);
    }
    rows.push({
      id: st.id, side: st.side, yaw: r.yaw, seg: st.seg, leg: legRoute(st), legPublished: legPublished(st),
      p10: r.p10, p50: r.p50, p90: r.p90,
      p10Free: r.p10Free, p50Free: r.p50Free, p90Free: r.p90Free,
      clippedFrac: r.clippedFrac, buildFrac: r.buildFrac,
      near: r.near, far: r.far,
    });
  }

  const out = arg('json', null);
  if (out) {
    fs.writeFileSync(out, JSON.stringify({
      district: districtFile,
      districtStat: (() => { const s = fs.statSync(districtFile); return { mtime: s.mtime.toISOString(), size: s.size }; })(),
      model: has('kit')
        ? 'full facade kit (facades.js appendBuilding, StreamingWorld._capStyle cost cap, street-facing)'
        : 'footprint prism to h + parapet',
      omits: 'trees, street furniture, signage, traffic, pedestrians, weather'
        + (has('kit') ? '' : '; and roof units, deco steps, fire escapes, balconies, awnings'),
      // Which population these frames are a summary of. The Mapillary index is
      // re-fetched from time to time and the corridor medians move when it grows,
      // so a run that does not record its own denominator cannot be compared to
      // an older one.
      stations: {
        measured: rows.length, available: POP.length, panoramas: PANOS,
        matchedOnly, source: `${MLY}/index.json`,
        matchedFrom: matchedOnly ? `${REN}/index.json` : null,
      },
      camera: { ...CAM, w: W, h: H }, frames: rows,
    }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}
