// Deterministic gate for static world collision.
//
//   node tools/blocker-test.mjs
//
// FOUR THINGS THIS HAS TO PROVE, and each is a way the module could pass a smoke test
// while being useless:
//
//   §1  THE SEGMENTS ARE THE BUILD'S. src/blockers.js duplicates facades.js's edge
//       rule rather than importing it, because the vehicle must not depend on the
//       texture library. So the gate imports the real `edgesOf` and `ringArea` and
//       compares building by building, edge by edge, normal by normal. CLAUDE.md:
//       "when a tool replays the build, it must replay the build's own selection, and
//       the cheap proof is that its counts match." geom-audit passed for years while
//       blind to half of every corner site.
//   §2  THE ROADS ARE STILL DRIVEABLE. A collider that blocks the street is worse
//       than no collider. Sampled every 2 m along every road centreline, counting
//       where a car-sized circle cannot fit, and compared against the bbox collider
//       the on-foot player still uses.
//   §3  IT CANNOT BE TUNNELLED, and the step size that would tunnel it is stated
//       rather than assumed.
//   §5  THE EFFECTIVE MASS IS THE REAL ONE. The 1/m shortcut is the natural thing to
//       write and it over-corrects every off-centre contact — which is every contact
//       that clips a building corner. The gate builds the shortcut and measures the
//       error.
import fs from 'node:fs';
import { BlockerIndex, insideRing, ringArea, contactImpulse,
  districtBounds, worldFence, WORLD_MARGIN_M,
  FENCE_FULL_M, FENCE_BRAKE_MS, FENCE_CRAWL_MS } from '../src/blockers.js';
import { Vehicle } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { edgesOf, ringArea as facadeRingArea } from '../src/facades.js';
// One import for both the contact-impulse section and the fence sweep: the file used to pull it
// in inside a block, and a second top-level import of the same name is a redeclaration.
const damageMod = await import('../src/damage.js');
const { DamageModel } = damageMod;

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };
const near = (a, b, tol) => Math.abs(a - b) <= tol;

const district = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const CAR_R = 0.95;          // the body half-width src/vehicle.js's inertia box uses

console.log('STATIC BLOCKER GATE');
console.log('='.repeat(78));
const tBuild = process.hrtime.bigint();
const ix = new BlockerIndex(district);
const buildMs = Number(process.hrtime.bigint() - tBuild) / 1e6;
console.log(`\nindex: ${JSON.stringify(ix.report())}`);
console.log(`built in ${buildMs.toFixed(1)} ms`);
check('the index built in under 100 ms', buildMs < 100, `${buildMs.toFixed(1)} ms`);

// ---------------------------------------------------------------------------
// §1  The segments are the build's own edges.
// ---------------------------------------------------------------------------
console.log('\n§1  Agreement with facades.js appendBuilding');
let areaMax = 0, edgeCount = 0, mismatch = 0, normalMismatch = 0, worstBuilding = -1;
for (let b = 0; b < district.buildings.length; b++) {
  const ring = district.buildings[b].p;
  const da = Math.abs(ringArea(ring) - facadeRingArea(ring));
  if (da > areaMax) { areaMax = da; worstBuilding = b; }
  const want = edgesOf(ring, { minLen: 0.05 });
  const got = ix.segs.filter((s) => s.b === b);
  edgeCount += want.length;
  if (want.length !== got.length) { mismatch++; continue; }
  for (let i = 0; i < want.length; i++) {
    const w = want[i], g = got[i];
    if (w.a[0] !== g.ax || w.a[1] !== g.az || w.b[0] !== g.bx || w.b[1] !== g.bz) mismatch++;
    else if (Math.abs(w.nx - g.nx) > 1e-12 || Math.abs(w.nz - g.nz) > 1e-12) normalMismatch++;
  }
}
console.log(`    facades.js edgesOf(minLen 0.05) over 523 rings: ${edgeCount} edges`);
console.log(`    src/blockers.js:                                ${ix.segs.length} segments`);
console.log(`    worst ringArea disagreement: ${areaMax} (building ${worstBuilding})`);
check('the segment count matches the build exactly', ix.segs.length === edgeCount,
  `${ix.segs.length} vs ${edgeCount}`);
check('no edge endpoints disagree', mismatch === 0, `${mismatch} mismatches`);
check('no outward normals disagree', normalMismatch === 0, `${normalMismatch} mismatches`);
check('ringArea is bit-identical to facades.js over all 523 rings', areaMax === 0);

// The normals point outward, checked independently of the winding rule that produced
// them: step off each edge's midpoint by 1 mm along the normal and the point must be
// outside its own ring. This is the check that would have caught a flipped `flip`.
let inward = 0, degenerate = 0;
for (const s of ix.segs) {
  const mx = (s.ax + s.bx) / 2, mz = (s.az + s.bz) / 2;
  const ring = ix.boxes[s.box].ring;
  const out = insideRing(ring, mx + s.nx * 0.001, mz + s.nz * 0.001);
  const inn = insideRing(ring, mx - s.nx * 0.001, mz - s.nz * 0.001);
  if (out) inward++;
  else if (!inn) degenerate++;    // neither side inside: a spur or a self-touching ring
}
console.log(`    normals pointing INTO their own ring: ${inward} of ${ix.segs.length}`);
console.log(`    edges with neither side inside (spurs / self-touching rings): ${degenerate}`);
check('no outward normal points into its own building', inward === 0, `${inward}`);
check('spurs are a small minority', degenerate < ix.segs.length * 0.05,
  `${degenerate}/${ix.segs.length} = ${(degenerate / ix.segs.length * 100).toFixed(1)}%`);

// ---------------------------------------------------------------------------
// §2  The roads are still driveable — and the bbox collider's phantom walls.
// ---------------------------------------------------------------------------
console.log('\n§2  Driveability, against the bbox collider district/main.js still uses on foot');
// The bbox collider, exactly as refreshFootColliders builds it.
const boxes = district.buildings.map((b) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of b.p) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z; }
  return { x0, x1, z0, z1 };
});
const inBox = (x, z, pad) => {
  for (const b of boxes) if (x > b.x0 - pad && x < b.x1 + pad && z > b.z0 - pad && z < b.z1 + pad) return true;
  return false;
};
// Sample every road centreline every 2 m.
let samples = 0, edgeBlocked = 0, boxBlocked = 0, insideReal = 0;
const blockedAt = [];
for (const e of district.edges) {
  for (let i = 0; i + 1 < e.v.length; i++) {
    const a = district.verts[e.v[i]], b = district.verts[e.v[i + 1]];
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.round(L / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      samples++;
      if (ix.resolveCircle(x, z, CAR_R)) { edgeBlocked++; if (blockedAt.length < 5) blockedAt.push([+x.toFixed(1), +z.toFixed(1)]); }
      if (ix.insideAny(x, z) >= 0) insideReal++;
      if (inBox(x, z, CAR_R)) boxBlocked++;
    }
  }
}
console.log(`    ${samples} road-centreline samples at 2 m spacing, car radius ${CAR_R} m`);
console.log(`      blocked by the SEGMENT index: ${edgeBlocked}  (${(edgeBlocked / samples * 100).toFixed(2)}%)`);
console.log(`      blocked by the BBOX collider:  ${boxBlocked}  (${(boxBlocked / samples * 100).toFixed(2)}%)`);
console.log(`      centreline samples actually inside a footprint: ${insideReal}`);
if (blockedAt.length) console.log(`      first few blocked: ${JSON.stringify(blockedAt)}`);
check('the segment index blocks under 2% of road centreline',
  edgeBlocked / samples < 0.02, `${(edgeBlocked / samples * 100).toFixed(2)}%`);
check('KNOWN-BAD: the bbox collider blocks far more road than the segments do',
  boxBlocked > edgeBlocked * 3, `box ${boxBlocked} vs seg ${edgeBlocked}`);
console.log(`    the bbox collider blocks ${(boxBlocked / Math.max(1, edgeBlocked)).toFixed(1)}x as many road samples`);

// The phantom-area measurement itself, at 1 m, over every footprint. This is the
// number in src/blockers.js's header and it is a gate so it cannot rot.
let phantom = 0, bboxArea = 0, polyArea = 0, phantomBlockedBySegs = 0;
for (let i = 0; i < ix.boxes.length; i++) {
  const b = ix.boxes[i];
  bboxArea += (b.x1 - b.x0) * (b.z1 - b.z0);
  polyArea += Math.abs(ringArea(b.ring));
  for (let z = Math.floor(b.z0) + 0.5; z < b.z1; z += 1) {
    for (let x = Math.floor(b.x0) + 0.5; x < b.x1; x += 1) {
      // The cell CENTRE has to be inside the box. floor(x0)+0.5 can sit up to half a
      // metre outside it, and without this the raster counts a border strip round
      // every one of 523 footprints — 11,143 m2 of it, which is how the first run of
      // this gate read 128,749 against the 117,606 the standalone measurement got.
      if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
      if (ix.insideAny(x, z) >= 0) continue;         // real wall (this or any building)
      phantom++;
      // The whole claim: the segment index leaves these clear. Only counted where the
      // cell is more than the car radius from a real wall, since a cell 0.3 m outside
      // a building is legitimately blocked for a car.
      if (!ix.resolveCircle(x, z, 0.15)) continue;
      phantomBlockedBySegs++;
    }
  }
}
// Two figures, because they answer different questions and mixing them up is how the
// first run of this gate disagreed with its own source file. The ANALYTIC one is the
// headline: total bbox area minus total polygon area. The RASTER one is smaller
// because it also excludes any cell that lies inside a DIFFERENT building's polygon —
// shared party walls are real walls, not phantom.
console.log(`\n    bbox area ${Math.round(bboxArea)} m2 over ${Math.round(polyArea)} m2 of building`);
console.log(`    analytic phantom (bbox - polygon):        ${Math.round(bboxArea - polyArea)} m2 = ${((bboxArea - polyArea) / bboxArea * 100).toFixed(1)}% of all bbox area`);
console.log(`    rastered at 1 m, excluding party walls:   ${phantom} m2`);
console.log(`      of those, blocked by the segment index for a 0.15 m probe: ${phantomBlockedBySegs} (${(phantomBlockedBySegs / phantom * 100).toFixed(2)}%)`);
check('the analytic phantom area is the 142,932 m2 the header claims',
  near(bboxArea - polyArea, 142932, 100), `${Math.round(bboxArea - polyArea)}`);
check('the rastered phantom area is the 117,606 m2 the header claims',
  near(phantom, 117606, 50), `${phantom}`);
check('the segment index leaves over 95% of the phantom area open',
  phantomBlockedBySegs / phantom < 0.05, `${(phantomBlockedBySegs / phantom * 100).toFixed(2)}%`);

// ---------------------------------------------------------------------------
// §3  Resolution: flat wall, inside corner, deep recovery, tunnelling.
// ---------------------------------------------------------------------------
console.log('\n§3  Resolution');
// A synthetic square, so the expected answers are exact.
const SQ = { buildings: [{ p: [[-10, -10], [10, -10], [10, 10], [-10, 10]], h: 12 }] };
const sq = new BlockerIndex(SQ, { cell: 8 });
check('the synthetic square has 4 segments', sq.segs.length === 4);
// Straight in from the east.
let hit = sq.resolveCircle(10.4, 0, 1);
// r plus the resolver's epsilon, deliberately: see resolveCircle's note. Asserting
// exactly r here was the first draft, and it failed at 11.000001 — which is the fix
// for the non-termination bug doing its job, not a defect.
check('a circle overlapping a flat wall is pushed to r (plus the resolver epsilon) from it',
  hit && near(hit.x, 11, 2e-6) && hit.x > 11 && near(hit.z, 0, 1e-12), hit && `x ${hit.x}`);
check('the reported normal is the wall normal', hit && near(hit.nx, 1, 1e-9) && near(hit.nz, 0, 1e-12));
check('a circle clear of the wall reports null', sq.resolveCircle(11.5, 0, 1) === null);
check('a circle exactly r away reports null', sq.resolveCircle(11, 0, 1) === null);
// An OUTSIDE corner of the square is an inside corner for nothing, so build an L that
// has a real inside corner: the notch of an L-shaped footprint.
const L = { buildings: [{ p: [[0, 0], [20, 0], [20, 20], [10, 20], [10, 10], [0, 10]], h: 12 }] };
const lix = new BlockerIndex(L, { cell: 8 });
const notch = lix.resolveCircle(9.6, 10.6, 1);     // inside the notch, near both walls
console.log(`    L notch: pushed to (${notch.x.toFixed(3)}, ${notch.z.toFixed(3)}) in ${notch.iters} iterations, depth ${notch.depth.toFixed(3)}`);
check('the notch corner resolves out of BOTH walls',
  notch && notch.x <= 9.0 + 1e-9 && notch.z >= 11.0 - 1e-9,
  notch && `(${notch.x.toFixed(3)}, ${notch.z.toFixed(3)})`);
check('the notch needed more than one iteration', notch.iters > 1, `${notch.iters}`);
// Deep inside recovery.
const deep = sq.resolveCircle(0, 0, 1);
console.log(`    from the dead centre of a 20x20 footprint: -> (${deep.x.toFixed(2)}, ${deep.z.toFixed(2)}), recovered building ${deep.recovered}`);
check('a circle at the centre of a building is recovered', deep && deep.recovered === 0);
check('recovery lands it outside the ring', deep && !insideRing(SQ.buildings[0].p, deep.x, deep.z));
check('recovery lands it clear by the radius',
  deep && sq.resolveCircle(deep.x, deep.z, 1) === null,
  deep && JSON.stringify(sq.resolveCircle(deep.x, deep.z, 1)));
// Worst iteration count needed over the real district, on the road samples that fired.
let worstIters = 0, fired = 0;
for (const e of district.edges) {
  for (let i = 0; i + 1 < e.v.length; i++) {
    const a = district.verts[e.v[i]], b = district.verts[e.v[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const r = ix.resolveCircle(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, CAR_R, 8);
      if (r) { fired++; if (r.iters > worstIters) worstIters = r.iters; }
    }
  }
}
console.log(`    worst iteration count over ${fired} real contacts (budget raised to 8): ${worstIters}`);
check('4 iterations is enough for every contact in the district', worstIters <= 4, `${worstIters}`);
// THE ITERATION COUNT IS THE INSTRUMENT THAT FOUND THE EPSILON BUG, so it stays.
// Before the fix this read 32 of a 32 budget on 37 contacts, with the depth unchanged
// after the first pass and a non-null contact returned for a 0.0000 m correction — a
// resolver burning its whole budget every frame while reporting success. The two
// checks that pin it down are the residual ones: resolving a resolved position must
// report clear, and must never leave the circle inside a footprint.
let residual = 0, insideAfter = 0;
for (const e of district.edges) {
  for (let i = 0; i + 1 < e.v.length; i++) {
    const a = district.verts[e.v[i]], b = district.verts[e.v[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      const r = ix.resolveCircle(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, CAR_R, 8);
      if (!r) continue;
      if (ix.resolveCircle(r.x, r.z, CAR_R, 8)) residual++;
      if (ix.insideAny(r.x, r.z) >= 0) insideAfter++;
    }
  }
}
console.log(`    of ${fired} contacts: ${residual} still contacting after resolution, ${insideAfter} still inside a footprint`);
check('resolution is idempotent: a resolved position reports clear', residual === 0, `${residual}`);
check('resolution never leaves the circle inside a footprint', insideAfter === 0, `${insideAfter}`);
console.log(`    (the synthetic L notch above needed ${notch.iters}, so the iteration is not dead code)`);

// Tunnelling. State the step that would do it rather than assuming none does.
console.log(`\n    tunnelling: a circle of radius ${CAR_R} m cannot pass a wall in one step`);
console.log(`    while the step is under 2r = ${(2 * CAR_R).toFixed(2)} m. At the 120 Hz fixed step`);
console.log(`    that is ${(2 * CAR_R * 120 * 3.6).toFixed(0)} km/h; the car's top speed is far below it.`);
let tunnelled = 0, sweeps = 0;
for (const speed of [30, 60, 120, 200, 400]) {
  const step = (speed / 3.6) / 120;
  // Drive straight at each of the synthetic square's four walls.
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    let x = -dx * 25, z = -dz * 25;
    for (let i = 0; i < 200; i++) {
      x += dx * step; z += dz * step;
      const r = sq.resolveCircle(x, z, 1);
      if (r) { x = r.x; z = r.z; }
      sweeps++;
      if (insideRing(SQ.buildings[0].p, x, z)) { tunnelled++; break; }
    }
  }
  const passed = insideRing(SQ.buildings[0].p, 0, 0);   // sanity: the centre IS inside
  if (!passed) check('the inside test works on the synthetic square', false);
}
console.log(`    ${sweeps} swept steps at 30..400 km/h into all four walls: ${tunnelled} tunnelled`);
check('nothing tunnels up to 400 km/h with per-step resolution', tunnelled === 0, `${tunnelled}`);
// And the honest negative: one step larger than 2r DOES pass through, which is what
// makes the bound above a real bound rather than a hope.
let bigStep = 30;   // m, far past 2r
let x = -25, z = 0, through = false;
for (let i = 0; i < 4; i++) { x += bigStep; const r = sq.resolveCircle(x, z, 1); if (r) { x = r.x; z = r.z; } if (x > 20) through = true; }
check('KNOWN-BAD: a 30 m step passes clean through a 20 m building', through);

// ---------------------------------------------------------------------------
// §4  The mission route is playable.
// ---------------------------------------------------------------------------
console.log('\n§4  The route');
let routeBlocked = 0, routeInside = 0;
for (const p of district.meta.route) {
  const inside = ix.insideAny(p.x, p.z) >= 0;
  const blocked = !!ix.resolveCircle(p.x, p.z, CAR_R);
  if (inside) routeInside++;
  if (blocked) routeBlocked++;
  if (inside || blocked) console.log(`    ${p.name}: inside ${inside}, blocked ${blocked}`);
}
console.log(`    ${district.meta.route.length} route waypoints: ${routeInside} inside a building, ${routeBlocked} blocked for a car`);
check('no route waypoint is inside a building', routeInside === 0, `${routeInside}`);
check('no route waypoint is blocked for a car', routeBlocked === 0, `${routeBlocked}`);
// The mission's own coordinates, since those are what a player is sent to.
const { MISSIONS } = await import('../src/missions.js');
let missionBad = 0;
for (const m of Object.values(MISSIONS)) {
  for (const st of m.stages) {
    for (const t of st.triggers ?? []) {
      const pts = t.kind === 'reach' || t.kind === 'leave' ? [[t.x, t.z]] : [];
      for (const [px, pz] of pts) {
        if (ix.insideAny(px, pz) >= 0) { missionBad++; console.log(`    ${m.id}/${st.id} target (${px}, ${pz}) is INSIDE a building`); }
      }
    }
    if (st.marker && ix.insideAny(st.marker.x, st.marker.z) >= 0) {
      missionBad++; console.log(`    ${m.id}/${st.id} marker is INSIDE a building`);
    }
  }
}
check('no authored mission target is inside a building', missionBad === 0, `${missionBad}`);

// ---------------------------------------------------------------------------
// §5  contactImpulse, and the 1/m shortcut.
// ---------------------------------------------------------------------------
console.log('\n§5  Contact impulse');
const M = 1400, IY = (M / 12) * (1.9 * 1.9 + 4.3 * 4.3) * 1.35;
console.log(`    mass ${M} kg, yaw inertia ${IY.toFixed(0)} kg m2 (src/vehicle.js's own box)`);
// Square-on into a wall: the offset is along the normal, so there is no torque and
// the effective mass IS 1/m. That is the case the shortcut gets right.
const head = contactImpulse({ vx: 0, vz: -13.9, rx: 0, rz: -2.15, nx: 0, nz: 1,
  mass: M, inertiaY: IY, restitution: 0 });
console.log(`    square-on at 50 km/h: jn ${head.jn.toFixed(0)} Ns, dv ${head.dv.toFixed(3)} m/s`);
check('a square-on contact has no lever arm, so 1/m is exact',
  near(head.jn, M * 13.9, 1), `${head.jn.toFixed(1)} vs ${(M * 13.9).toFixed(1)}`);
check('the charged delta-v is the closing speed at restitution 0', near(head.dv, 13.9, 1e-9));
check('restitution 0.15 raises the charged delta-v by 15%',
  near(contactImpulse({ vx: 0, vz: -13.9, rx: 0, rz: -2.15, nx: 0, nz: 1,
    mass: M, inertiaY: IY, restitution: 0.15 }).dv, 13.9 * 1.15, 1e-9));
// Corner clip: the lever arm is real, and this is where the shortcut is wrong.
//
// THE SIGN CONVENTION, since the first draft of this test passed a separating contact
// and read null. `n` is the WALL's outward normal, so it points from the wall toward
// the car; an approaching car therefore has v dot n < 0. Reversing into a wall at
// 50 km/h on the rear-right corner is vz -13.9 against n (0, 1), with the contact
// offset r at (0.95, -2.15) in body space.
const corner = contactImpulse({ vx: 0, vz: -13.9, rx: 0.95, rz: -2.15, nx: 0, nz: 1,
  mass: M, inertiaY: IY, restitution: 0.15, friction: 0 });
const shortcut = -(1 + 0.15) * -13.9 * M;
console.log(`    front-corner clip: jn ${corner.jn.toFixed(0)} Ns; the 1/m shortcut says ${shortcut.toFixed(0)} Ns`);
console.log(`    KNOWN-BAD: the shortcut over-corrects by ${((shortcut / corner.jn - 1) * 100).toFixed(1)}%`);
check('the effective mass reduces an off-centre impulse', corner.jn < shortcut);
check('KNOWN-BAD: the 1/m shortcut over-corrects a corner clip by over 5%',
  shortcut / corner.jn > 1.05, `${((shortcut / corner.jn - 1) * 100).toFixed(1)}%`);
check('a separating contact returns null',
  contactImpulse({ vx: 0, vz: 5, rx: 0, rz: -2.15, nx: 0, nz: 1, mass: M, inertiaY: IY }) === null);
check('a tangent contact returns null',
  contactImpulse({ vx: 10, vz: 0, rx: 0, rz: -2.15, nx: 0, nz: 1, mass: M, inertiaY: IY }) === null);
// Friction is capped by the Coulomb cone. A real scrape: 20 m/s along a wall whose
// outward normal is -x, at 5 degrees of incidence. The first draft of this wrote
// `vx: 20, vz: -1`, which against that normal is a square-on 20 m/s crash and was
// charged 23 m/s of delta-v — the test setting up the very case §2 of the damage gate
// exists to distinguish, and getting it backwards.
const SCR = 20, SCR_DEG = 5;
const scrape = contactImpulse({
  vx: SCR * Math.sin(SCR_DEG * Math.PI / 180), vz: -SCR * Math.cos(SCR_DEG * Math.PI / 180),
  rx: 0.95, rz: 0, nx: -1, nz: 0, mass: M, inertiaY: IY, restitution: 0.15, friction: 0.4 });
console.log(`    ${SCR} m/s at ${SCR_DEG}deg along a wall: jn ${scrape.jn.toFixed(1)}, jt ${scrape.jt.toFixed(1)}, ` +
  `ratio ${(scrape.jt / scrape.jn).toFixed(3)}, charged dv ${scrape.dv.toFixed(3)} m/s`);
check('scrape friction is capped at the friction coefficient',
  scrape.jt <= 0.4 * scrape.jn + 1e-9, `${(scrape.jt / scrape.jn).toFixed(4)}`);
check('a 20 m/s scrape at 5 degrees is charged a small delta-v', scrape.dv < 3,
  `${scrape.dv.toFixed(3)}`);
const dmg = new DamageModel();
console.log(`    and src/damage.js scores that scrape at ${dmg.severityFor(scrape.dv).toFixed(4)}, ` +
  `against ${dmg.severityFor(contactImpulse({ vx: SCR, vz: 0, rx: 0, rz: 0, nx: -1, nz: 0, mass: M, inertiaY: IY, restitution: 0.15 }).dv).toFixed(4)} for the same speed square-on`);
check('the scrape costs the car nothing', dmg.severityFor(scrape.dv) === 0);
check('the same speed square-on is a write-off',
  dmg.severityFor(contactImpulse({ vx: SCR, vz: 0, rx: 0, rz: 0, nx: -1, nz: 0,
    mass: M, inertiaY: IY, restitution: 0.15 }).dv) === 1);

// ---------------------------------------------------------------------------
// §6  Determinism and cost.
// ---------------------------------------------------------------------------
console.log('\n§6  Determinism and cost');
function sweep() {
  let acc = 0;
  for (let i = 0; i < 4000; i++) {
    const x = -700 + (i * 1.37) % 1400, z = -500 + (i * 2.91) % 1000;
    const r = ix.resolveCircle(x, z, CAR_R);
    if (r) acc += r.depth + r.nx * 3 + r.nz * 7 + r.iters;
  }
  return acc.toFixed(9);
}
check('4,000 resolveCircle calls are bit-identical across runs', sweep() === sweep());
const ix2 = new BlockerIndex(district);
check('two indexes built from the same district agree',
  JSON.stringify(ix2.report()) === JSON.stringify(ix.report()));

// Cost. The vehicle calls this twice per 120 Hz fixed step: 240 a second.
const N = 200000;
// Two populations, because the answer differs by an order of magnitude and the one
// that matters is the common case.
const openRoad = [], nearWall = [];
for (const e of district.edges) {
  for (let i = 0; i + 1 < e.v.length && (openRoad.length < 400 || nearWall.length < 40); i++) {
    const a = district.verts[e.v[i]], b = district.verts[e.v[i + 1]];
    const n = Math.max(1, Math.round(Math.hypot(b.x - a.x, b.z - a.z) / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const tgt = ix.resolveCircle(x, z, CAR_R) ? nearWall : openRoad;
      if (tgt.length < (tgt === nearWall ? 40 : 400)) tgt.push([x, z]);
    }
  }
}
console.log(`    cost populations: ${openRoad.length} open-road points, ${nearWall.length} in contact`);
check('the cost benchmark has a real in-contact population', nearWall.length > 10, `${nearWall.length}`);
for (const [label, pop] of [['open road', openRoad], ['touching a wall', nearWall.length ? nearWall : openRoad]]) {
  if (!pop.length) continue;
  let t0 = process.hrtime.bigint(), sink = 0;
  for (let i = 0; i < N; i++) { const p = pop[i % pop.length]; if (ix.resolveCircle(p[0], p[1], CAR_R)) sink++; }
  const ns = Number(process.hrtime.bigint() - t0) / N;
  console.log(`    resolveCircle, ${label.padEnd(16)} ${ns.toFixed(1).padStart(7)} ns  ` +
    `= ${(ns * 240 / 1e9 * 100).toFixed(5)}% of a second at 240 calls/s  (${sink} hits)`);
  check(`resolveCircle on ${label} is under 20 us`, ns < 20000, `${ns.toFixed(0)} ns`);
}
const tIns = process.hrtime.bigint();
for (let i = 0; i < N; i++) ix.insideAny(-700 + (i * 1.37) % 1400, -500 + (i * 2.91) % 1000);
const insNs = Number(process.hrtime.bigint() - tIns) / N;
console.log(`    insideAny                        ${insNs.toFixed(1).padStart(7)} ns`);
console.log(`    the whole collision budget at 240 calls/s is well under 0.1% of wall clock.`);

// ---------------------------------------------------------------------------
// THE EDGE OF THE WORLD. There was none: a playtester held the throttle north from the bayfront
// and the car was still doing 146 km/h at 4,595 m out, 8,990 m past anything modelled.
// ---------------------------------------------------------------------------
console.log('\n§ the world fence');
{
  const b = districtBounds(district);
  let rx0 = Infinity, rx1 = -Infinity, rz0 = Infinity, rz1 = -Infinity;
  for (const v of district.verts) {
    rx0 = Math.min(rx0, v.x); rx1 = Math.max(rx1, v.x);
    rz0 = Math.min(rz0, v.z); rz1 = Math.max(rz1, v.z);
  }
  console.log(`    roads run x ${rx0.toFixed(0)}..${rx1.toFixed(0)}, z ${rz0.toFixed(0)}..${rz1.toFixed(0)}`);
  console.log(`    meta.bounds  x ${district.meta.bounds.x0.toFixed(0)}..${district.meta.bounds.x1.toFixed(0)}, ` +
    `z ${district.meta.bounds.z0.toFixed(0)}..${district.meta.bounds.z1.toFixed(0)}`);
  console.log(`    the fence    x ${b.x0.toFixed(0)}..${b.x1.toFixed(0)}, z ${b.z0.toFixed(0)}..${b.z1.toFixed(0)}`);
  /**
   * THE FENCE IS THE ROADS, NOT `meta.bounds`, and the two disagree by hundreds of metres: the
   * declared bounds are +/-716.95 by +/-500.94 while the network runs to x 814 and z 719. A fence
   * at the declared bounds would cut off real driveable street, which is worse than no fence.
   */
  check('the fence contains every road vertex', b.x0 < rx0 && b.x1 > rx1 && b.z0 < rz0 && b.z1 > rz1,
    `${b.x1.toFixed(0)} vs ${rx1.toFixed(0)}, ${b.z1.toFixed(0)} vs ${rz1.toFixed(0)}`);
  check('KNOWN-BAD: meta.bounds does not', district.meta.bounds.x1 < rx1 || district.meta.bounds.z1 < rz1,
    `roads reach ${rx1.toFixed(0)}/${rz1.toFixed(0)} against bounds ` +
    `${district.meta.bounds.x1.toFixed(0)}/${district.meta.bounds.z1.toFixed(0)}`);
  check('the margin is the run-off it claims', Math.abs((b.x1 - rx1) - WORLD_MARGIN_M) < 1e-6,
    `${(b.x1 - rx1).toFixed(2)} m`);
  // Inside, the fence is not there at all. Every road vertex and the spawn.
  let touched = 0;
  for (const v of district.verts) {
    if (worldFence(b, v.x, v.z, 0, 1, 0, 0, { throttle: 1 }).held) touched++;
  }
  check('no road vertex is outside the fence', touched === 0, `${touched} of ${district.verts.length}`);
  const sp = district.meta.spawn;
  check('and the spawn is well inside it',
    worldFence(b, sp.x, sp.z, 0, 1, 0, 0, { throttle: 1 }).out === 0);
  /**
   * OUTSIDE, IT IS A ONE-WAY FENCE. Refusing all power is the dead end this project already
   * shipped once in the wrecked car, so the refusal is by the direction the car would MOVE: out is
   * refused at both ends of the throttle, in is allowed at both.
   */
  const out = { x: b.x1 + 20, z: 0 };
  const push = (fx, fz, throttle, vx = 0, vz = 0) =>
    worldFence(b, out.x, out.z, fx, fz, vx, vz, { throttle, brake: 0 });
  const nose = push(1, 0, 1), noseRev = push(1, 0, -1);
  const home = push(-1, 0, 1), homeRev = push(-1, 0, -1);
  console.log(`    20 m out past x1, nose outward:  throttle +1 -> ${nose.controls.throttle}, ` +
    `-1 -> ${noseRev.controls.throttle}`);
  console.log(`    the same spot, nose inward:      throttle +1 -> ${home.controls.throttle}, ` +
    `-1 -> ${homeRev.controls.throttle}`);
  check('driving further out is refused', nose.controls.throttle === 0);
  check('reversing further out is refused', homeRev.controls.throttle === 0);
  check('driving home is allowed', home.controls.throttle === 1);
  check('and so is reversing home', noseRev.controls.throttle === -1);
  /**
   * AND THE BRAKE IS ON THE VELOCITY, NOT THE DEPTH, which the first version got wrong: measured
   * at 786 m out, a brake ramped on depth sat at 1.0 while the car tried to leave, so thirty
   * seconds of full throttle pointing home moved it 0.1 m — the same dead end by another route.
   */
  check('a car travelling outward is braked', push(1, 0, 1, 10, 0).controls.brake > 0,
    `${push(1, 0, 1, 10, 0).controls.brake}`);
  check('a car travelling home is not', push(-1, 0, 1, -10, 0).controls.brake === 0,
    `${push(-1, 0, 1, -10, 0).controls.brake}`);
  check('a car standing still outside is not', push(1, 0, 1, 0, 0).controls.brake === 0,
    `${push(1, 0, 1, 0, 0).controls.brake}`);
  check('the brake ramps with depth', worldFence(b, b.x1 + 30, 0, 1, 0, 10, 0, { throttle: 1 }).controls.brake
    > worldFence(b, b.x1 + 3, 0, 1, 0, 10, 0, { throttle: 1 }).controls.brake,
    `${worldFence(b, b.x1 + 3, 0, 1, 0, 10, 0, { throttle: 1 }).controls.brake.toFixed(2)} at 3 m, ` +
    `${worldFence(b, b.x1 + 30, 0, 1, 0, 10, 0, { throttle: 1 }).controls.brake.toFixed(2)} at 30 m`);
  console.log('    (live, on open ground: 180 s of full throttle at the fence stops the car 61.3 m');
  console.log('     out at 0 km/h; turning round drives home at 140 km/h; reverse from 20 m out');
  console.log('     with the nose still outward comes home at 27 km/h.)');
}

// ---------------------------------------------------------------------------
/**
 * § THE FENCE, SWEPT OVER THE POSE — which is the gap that let a dead pose ship.
 *
 * Every check in the section above uses `fwd = (+-1, 0)` on the +x face, so the nose dot is
 * exactly +1 or -1 and NOTHING between has ever been exercised. That is CLAUDE.md's "a threshold
 * that holds at one value and fails at every other is a coincidence", and the round-5 crime
 * playtester found what it hid: at the pure TANGENTIAL pose both of the fence's tests were on
 * quantities that are numerically zero.
 *
 * These arms drive a real `Vehicle` through the real fence, in tools/playtest.mjs's own loop,
 * which is district/main.js's. A synthetic box, so nothing but the fence is under test: out past
 * the real fence there are no buildings, roads or props. The box is deliberately much larger than
 * the district (1,676 x 1,243 m) — the first version used +-400 m and a 60 s arm at 146 km/h drove
 * clean across it and out of the far side, reading "drives home, ends 73 m out".
 */
console.log('\n§ the fence, swept over the pose');
{
  const HZ = 60, DT = 1 / HZ, ARM_S = 60;
  const BOX = { x0: -3000, x1: 3000, z0: -3000, z1: 3000 };
  const ground = new FlatGround(0);
  const depthAt = (x, z) => Math.hypot(Math.max(BOX.x0 - x, 0, x - BOX.x1),
    Math.max(BOX.z0 - z, 0, z - BOX.z1));
  const yawOf = (q) => Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  const place = (out, yaw) => {
    const v = new Vehicle();
    v.position.set(BOX.x1 + out, v.position.y, 0);
    v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
    return v;
  };
  /** One arm: hold `pick(v)` from a pose and report where the car got to. */
  const run = (v, pick, seconds) => {
    let along = 0, worst = 0, peak = 0, brakeSum = 0, drift = 0, n = 0, homeAt = null;
    for (let i = 0; i < Math.round(seconds * HZ); i++) {
      const y = yawOf(v.quaternion);
      const f = worldFence(BOX, v.position.x, v.position.z, Math.sin(y), Math.cos(y),
        v.velocity.x, v.velocity.z, pick(v, y));
      v.setControls(f.controls);
      v.stepFixed(DT, ground, HZ);
      const d = depthAt(v.position.x, v.position.z);
      along = Math.max(along, Math.abs(v.position.z));
      worst = Math.max(worst, d);
      peak = Math.max(peak, Math.hypot(v.velocity.x, v.velocity.z) * 3.6);
      if (i > 5) drift = Math.max(drift, Math.abs(v.velocity.x));
      brakeSum += f.controls.brake ?? 0; n++;
      if (homeAt === null && d === 0) homeAt = i / HZ;
    }
    return { out: depthAt(v.position.x, v.position.z), along, worst, peak, drift,
      brake: brakeSum / n, homeAt,
      kmh: Math.hypot(v.velocity.x, v.velocity.z) * 3.6 };
  };
  const HOLD = (c) => () => c;
  /** A player heading home: full throttle, steering at the district, reversing out of a corner. */
  const HOMEWARD = (v, y) => {
    const fx = Math.sin(y), fz = Math.cos(y);
    const hx = -v.position.x, hz = -v.position.z, hl = Math.hypot(hx, hz) || 1;
    const cross = fx * (hz / hl) - fz * (hx / hl);
    const ahead = (fx * hx + fz * hz) / hl;
    const steer = Math.max(-1, Math.min(1, cross * 3));
    return ahead < -0.2
      ? { throttle: -0.55, brake: 0, steer: -steer }
      : { throttle: 1, brake: 0, steer };
  };

  /**
   * 1. THE LATCH. A car standing still outside must not be held on the brake by its own rounding
   *    error. This is the defect, and the measurement that is its own known-bad: with the old sign
   *    test the same arm read a mean brake of 0.990.
   */
  const rest = run(place(FENCE_FULL_M, 0), HOLD({ throttle: 0, brake: 0, steer: 0 }), 10);
  console.log(`    at rest ${FENCE_FULL_M} m out, tangential: worst |v_out| ${rest.drift.toExponential(2)} m/s, ` +
    `mean fence brake ${rest.brake.toFixed(3)} (the sign test it replaced read 0.990)`);
  check('a car standing still outside is not held on the brake by numerical noise',
    rest.brake < 0.05, `mean brake ${rest.brake.toFixed(3)}`);
  check('and the drift that used to latch it is real, so the arm is not measuring nothing',
    rest.drift > 1e-4 && rest.drift < 0.05, `${rest.drift.toExponential(2)} m/s`);
  /**
   * AND THE THRESHOLD IS ABOVE THAT DRIFT BY A STATED MARGIN. This is the relation the constant
   * is chosen on, so it is asserted rather than the number: a threshold that sat near the drift
   * would be the same defect one decimal place further down.
   */
  check('the brake scale is at least 20x the drift it has to ignore',
    FENCE_BRAKE_MS > 20 * rest.drift,
    `${FENCE_BRAKE_MS} against ${rest.drift.toExponential(2)} — x${(FENCE_BRAKE_MS / rest.drift).toFixed(0)}`);

  /**
   * 2. AND THE BRAKE IS STILL FULL FOR A REAL ESCAPE. The point of a ramp is that the small case
   *    is small, not that the large case is weak — without this, "no latch" is satisfied by a
   *    fence with no brake at all.
   */
  const hard = worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, 1, 0, 1, 0, { throttle: 1, brake: 0 });
  const half = worldFence(BOX, BOX.x1 + FENCE_FULL_M / 2, 0, 1, 0, 1, 0, { throttle: 1, brake: 0 });
  console.log(`    leaving at 1 m/s: brake ${hard.controls.brake.toFixed(2)} at ${FENCE_FULL_M} m, ` +
    `${half.controls.brake.toFixed(2)} at ${FENCE_FULL_M / 2} m`);
  check('a car actually leaving is braked fully at the full-authority depth',
    hard.controls.brake === 1, `${hard.controls.brake}`);
  check('and the depth ramp still halves it at half the depth',
    Math.abs(half.controls.brake - 0.5) < 1e-9, `${half.controls.brake}`);

  /**
   * 3. THE CRAWL, and its derivation asserted across modules rather than left to a comment. It is
   *    src/damage.js's FMVSS free threshold, so a contact taken at the fence's own speed limit is
   *    free by construction — the same derivation src/roadpath.js's corner floor makes.
   */
  console.log(`    the crawl is ${FENCE_CRAWL_MS} m/s against DamageModel.freeDv ${new DamageModel().freeDv}`);
  check('the fence crawl IS the damage model\'s free-contact threshold',
    FENCE_CRAWL_MS === new DamageModel().freeDv,
    `${FENCE_CRAWL_MS} against ${new DamageModel().freeDv}`);

  /**
   * 4. CONTAINMENT ALONG THE FENCE, which the latch was providing by accident. The old code held a
   *    tangential car at 1 m in 180 s; with the latch gone and nothing in its place it toured
   *    3,074 m at 146 km/h, which is the "drove 4,595 m off the map over nothing" this fence
   *    exists for.
   */
  const tan = run(place(FENCE_FULL_M, 0), HOLD({ throttle: 1, brake: 0, steer: 0 }), ARM_S);
  console.log(`    tangential, ${ARM_S} s of full throttle: ${tan.along.toFixed(0)} m along, ` +
    `${tan.worst.toFixed(1)} m out at worst, peak ${tan.peak.toFixed(0)} km/h`);
  check('holding the throttle along the fence does not get the car further out',
    tan.worst < FENCE_FULL_M + 2, `${tan.worst.toFixed(1)} m against ${FENCE_FULL_M} m`);
  check('and the crawl holds the speed near its own limit, so the outside cannot be toured',
    tan.peak < FENCE_CRAWL_MS * 3.6 * 3, `${tan.peak.toFixed(0)} km/h against a ` +
    `${(FENCE_CRAWL_MS * 3.6).toFixed(1)} km/h crawl`);
  // Non-empty by construction: an arm where the car never moved would satisfy both above.
  check('the car did move, so those two bounds measured something',
    tan.along > 10, `${tan.along.toFixed(0)} m along`);

  /**
   * 5. AND A CAR ON ITS WAY IN IS NEVER SLOWED BY THE CRAWL. Capping a car that is heading home is
   *    the dead end CLAUDE.md records twice, and the crawl would be exactly that without the
   *    exemption. Measured: without it, recovering from the dead-outward pose costs 10.7 s against
   *    the old code's 6.7 s.
   */
  const fast = worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, -1, 0, -20, 0, { throttle: 1, brake: 0 });
  const slow = worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, -1, 0, -1, 0, { throttle: 1, brake: 0 });
  console.log(`    coming home at 20 m/s: brake ${fast.controls.brake.toFixed(2)}, ` +
    `homing ${fast.homing};  at 1 m/s: brake ${slow.controls.brake.toFixed(2)}, homing ${slow.homing}`);
  check('a car coming home faster than the crawl is exempt from it',
    fast.controls.brake === 0 && fast.homing === true, `${fast.controls.brake}`);
  check('and its throttle is untouched, so nothing about driving home is refused',
    fast.controls.throttle === 1, `${fast.controls.throttle}`);
  // The exemption is on the VELOCITY, not the nose: reverse with an outward nose is driving home.
  const revHome = worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, 1, 0, -20, 0, { throttle: -1, brake: 0 });
  check('reversing home with the nose still outward is exempt too',
    revHome.controls.brake === 0 && revHome.controls.throttle === -1,
    `brake ${revHome.controls.brake}, throttle ${revHome.controls.throttle}`);

  /**
   * 6. THE FLAT-OUT CHARGE still stops, which is what containment finally means. 200 m of run-up
   *    inside, nose dead outward, throttle pinned: unchanged at 54 m by this round's edit.
   */
  {
    const v = new Vehicle();
    v.position.set(BOX.x1 - 200, v.position.y, 0);
    v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI / 2);
    const r = run(v, HOLD({ throttle: 1, brake: 0, steer: 0 }), 120);
    console.log(`    a flat-out charge: overran to ${r.worst.toFixed(1)} m, ended ` +
      `${r.out.toFixed(1)} m out at ${r.kmh.toFixed(1)} km/h`);
    check('a flat-out charge at the fence is stopped', r.kmh < 1, `${r.kmh.toFixed(2)} km/h`);
    check('and the overrun is bounded', r.worst < 80, `${r.worst.toFixed(1)} m`);
    check('the charge actually crossed the fence, or the two above measured a car inside it',
      r.worst > 10, `${r.worst.toFixed(1)} m`);
  }

  /**
   * 7. AND THE POSE SWEEP ITSELF: can a player get home from every pose? Under ONE fixed homing
   *    controller, so the arms are comparable with each other — the absolute seconds are that
   *    controller's and not the fence's, which is why what is asserted is "recovers at all".
   *
   * With the old code the four poses at and near tangential recovered from NONE of them inside
   * 180 s, while +-30 degrees and dead-outward recovered in 8.2 s and 6.7 s: the defect exactly.
   */
  console.log('\n    pose         dot    home in    worst m');
  const POSES = [['tangential', 0], ['+1 deg out', 0.0175], ['+6 deg out', 0.105],
    ['-6 deg out', -0.105], ['+30 deg out', 0.524], ['dead outward', Math.PI / 2],
    ['dead home', -Math.PI / 2]];
  const homes = [];
  for (const [label, yaw] of POSES) {
    const r = run(place(FENCE_FULL_M, yaw), HOMEWARD, 180);
    homes.push({ label, yaw, ...r });
    console.log(`    ${label.padEnd(13)}${Math.sin(yaw).toFixed(3).padStart(6)}   ` +
      `${(r.homeAt === null ? 'never' : `${r.homeAt.toFixed(1)}s`).padStart(8)}   ${r.worst.toFixed(1).padStart(7)}`);
  }
  check('a player can get home from EVERY pose, including the tangential one that was dead',
    homes.every((h) => h.homeAt !== null),
    homes.filter((h) => h.homeAt === null).map((h) => h.label).join(', ') || 'all recovered');
  check('and the sweep covers the band between the two poses every other check uses',
    homes.some((h) => Math.abs(Math.sin(h.yaw)) < 0.001)
    && homes.some((h) => Math.abs(Math.sin(h.yaw)) > 0.01 && Math.abs(Math.sin(h.yaw)) < 0.2),
    homes.map((h) => Math.sin(h.yaw).toFixed(3)).join(' '));
  // The poses that already worked must not have got slower than the fence can explain.
  const deadOut = homes.find((h) => h.label === 'dead outward');
  check('the pose that already recovered still does, at about the same cost',
    deadOut.homeAt !== null && deadOut.homeAt < 12,
    `${deadOut.homeAt?.toFixed(1)}s against the old code's 6.7s`);
}

// ---------------------------------------------------------------------------
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nSTATIC BLOCKERS: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nSTATIC BLOCKERS: PASS — ${checks.length} checks`);
