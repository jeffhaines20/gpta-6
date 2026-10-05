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
import { Vehicle, composeStuck, STUCK_HOLD_S, STUCK_THROTTLE,
  STUCK_SPEED_MS, STUCK_CONTACT_GRACE_S } from '../src/vehicle.js';
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
  /**
   * THE DEPTH RAMP IS ON THE LEAVING TERM, RESTATED IN THE COMMIT THAT MOVED IT. This read the
   * COMPOSED brake and asserted it grows with depth, which was true while the crawl was
   * depth-scaled too. The crawl is not any more — it applies as soon as you are outside at all,
   * because scaling it meant it barely applied near the line and a car 2 to 15 m out toured at
   * 143 km/h — so a car leaving at 10 m/s is over the crawl and the composed brake is 1.00 at both
   * depths. The property is intact and belongs to the term that still has it, which the fence now
   * reports separately: the further out you are, the harder it pushes BACK.
   */
  const deep = worldFence(b, b.x1 + 30, 0, 1, 0, 10, 0, { throttle: 1 });
  const shallow = worldFence(b, b.x1 + 3, 0, 1, 0, 10, 0, { throttle: 1 });
  check('the LEAVING brake ramps with depth', deep.leavingK > shallow.leavingK,
    `${shallow.leavingK} at 3 m, ${deep.leavingK} at 30 m`);
  check('and the crawl does not, which is this round\'s correction',
    deep.crawlK === shallow.crawlK, `${shallow.crawlK} at 3 m, ${deep.crawlK} at 30 m`);
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
  /**
   * One arm: hold `pick(v)` from a pose and report where the car got to.
   *
   * `stopHome` ENDS THE ARM ONCE THE CAR IS INSIDE, and without it the containment table lies. A
   * car whose nose points INWARD drives home, is free the moment it crosses the line, accelerates
   * legitimately inside, and may leave again somewhere else at speed — and an arm that kept
   * accumulating read 139 km/h and 74 m out for a pose that was doing exactly the right thing.
   * A containment number has to be about the time spent OUTSIDE.
   */
  const run = (v, pick, seconds, { stopHome = false, settleS = 2 } = {}) => {
    let along = 0, worst = 0, peak = 0, settled = 0, brakeSum = 0, drift = 0, n = 0, homeAt = null;
    const p0 = { x: v.position.x, z: v.position.z };
    let arc = 0, prev = { x: v.position.x, z: v.position.z };
    for (let i = 0; i < Math.round(seconds * HZ); i++) {
      const y = yawOf(v.quaternion);
      const f = worldFence(BOX, v.position.x, v.position.z, Math.sin(y), Math.cos(y),
        v.velocity.x, v.velocity.z, pick(v, y));
      v.setControls(f.controls);
      v.stepFixed(DT, ground, HZ);
      const d = depthAt(v.position.x, v.position.z);
      if (homeAt === null && d === 0) homeAt = i / HZ;
      if (stopHome && d === 0) break;
      arc += Math.hypot(v.position.x - prev.x, v.position.z - prev.z);
      prev = { x: v.position.x, z: v.position.z };
      along = Math.max(along, Math.hypot(v.position.x - p0.x, v.position.z - p0.z));
      worst = Math.max(worst, d);
      const kmh = Math.hypot(v.velocity.x, v.velocity.z) * 3.6;
      peak = Math.max(peak, kmh);
      if (i > settleS * HZ) settled = Math.max(settled, kmh);
      if (i > 5) drift = Math.max(drift, Math.abs(v.velocity.x));
      brakeSum += f.controls.brake ?? 0; n++;
    }
    return { out: depthAt(v.position.x, v.position.z), along, arc, worst, peak, settled, drift,
      brake: n ? brakeSum / n : 0, homeAt,
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
    `${half.controls.brake.toFixed(2)} at ${FENCE_FULL_M / 2} m ` +
    `(leaving term ${hard.leavingK} / ${half.leavingK})`);
  check('a car actually leaving is braked fully at the full-authority depth',
    hard.controls.brake === 1, `${hard.controls.brake}`);
  /**
   * THE DEPTH RAMP IS ON THE LEAVING TERM, RESTATED. This check read the COMPOSED brake and
   * asserted 0.5 at half the depth; it now reads `leavingK`, because the crawl stopped being
   * depth-scaled in the same commit — a car leaving at 1 m/s is over the crawl, so the composed
   * brake is 1.00 at both depths and the old form failed. The property it was guarding is intact
   * and it belongs to the term that still has it: the further out you are, the harder the fence
   * pushes BACK, while the crawl applies as soon as you are outside at all.
   */
  check('and the depth ramp still halves the LEAVING term at half the depth',
    Math.abs(half.leavingK - 0.5) < 1e-3 && Math.abs(hard.leavingK - 1) < 1e-9,
    `${half.leavingK} at ${FENCE_FULL_M / 2} m against ${hard.leavingK} at ${FENCE_FULL_M} m`);
  check('the crawl term is NOT depth-scaled, which is this round\'s correction',
    Math.abs(worldFence(BOX, BOX.x1 + 2, 0, 0, 1, 0, 10, { throttle: 0, brake: 0 }).crawlK
      - worldFence(BOX, BOX.x1 + 60, 0, 0, 1, 0, 10, { throttle: 0, brake: 0 }).crawlK) < 1e-9,
    `${worldFence(BOX, BOX.x1 + 2, 0, 0, 1, 0, 10, { throttle: 0, brake: 0 }).crawlK} at 2 m, ` +
    `${worldFence(BOX, BOX.x1 + 60, 0, 0, 1, 0, 10, { throttle: 0, brake: 0 }).crawlK} at 60 m`);

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
  /**
   * SWEPT OVER DEPTH, and that is a correction a blind reviewer had to make. The first version ran
   * this at ONE depth — `FENCE_FULL_M`, the only depth where the depth scale is 1 — and asserted a
   * 23.8 km/h ceiling. At 2, 5, 10 and 15 m out the same arm read **143 km/h**, because the crawl
   * was multiplied by `out / FENCE_FULL_M` and so barely applied near the line, which is exactly
   * where a player who has drifted past it is. "585 m at 12 km/h" was exact at 30 m and wrong
   * everywhere else — the identical defect shape this section already records for the POSE axis,
   * swept on pose and not on depth. The crawl is no longer depth-scaled; the sweep is here so that
   * cannot come back.
   */
  const CRAWL_CEIL = FENCE_CRAWL_MS * 3.6 * 3;
  /** The car's measured braking deceleration; tools/roadpath-test.mjs re-measures it at 11.0. */
  const BRAKE_MS2 = 11.0;
  console.log(`\n    holding full throttle for ${ARM_S} s, by depth and pose ` +
    `(ceiling ${CRAWL_CEIL.toFixed(1)} km/h = 3x the crawl)`);
  console.log('      out m   nose     start     arc outside   peak km/h  settled   worst out   settle');
  /**
   * ONLY POSES THE THROTTLE IS NOT REFUSED FOR, because an OUTWARD nose gets zero throttle and its
   * row is trivially contained — arc 1 m, peak 0 km/h, which is a check whose two sides are both
   * zero. The refusal is asserted on its own below. So: tangential, and a few degrees INWARD,
   * which is where the reviewer's 143 km/h reading came from.
   */
  const tours = [];
  for (const [out, deg, kmh] of [[2, 0, 0], [5, 0, 0], [10, 0, 0], [20, 0, 0],
    [FENCE_FULL_M, 0, 0], [60, 0, 0],
    // And at SPEED, which is the reviewer's case: a shallow inward nose at 143 km/h satisfied an
    // inward-COMPONENT test of 2.2 m/s, so the crawl switched itself off entirely.
    [FENCE_FULL_M, 0, 140], [FENCE_FULL_M, -3, 140], [FENCE_FULL_M, -6, 140], [10, -3, 140]]) {
    const v = place(out, deg * Math.PI / 180);
    if (kmh > 0) {
      const y = yawOf(v.quaternion);
      v.velocity.set(Math.sin(y) * kmh / 3.6, v.velocity.y, Math.cos(y) * kmh / 3.6);
    }
    /**
     * THE SETTLE WINDOW IS THE BRAKING CURVE, not a fixed 2 s. An arm entering at 140 km/h needs
     * 140/3.6/11 = 3.54 s to stop at the measured braking deceleration, so a 2 s window read
     * 50 km/h and called it the settled speed — which is a point on the deceleration, not a
     * limit the fence imposes.
     */
    const settleS = kmh / 3.6 / BRAKE_MS2 + 1;
    const r = run(v, HOLD({ throttle: 1, brake: 0, steer: 0 }), ARM_S, { stopHome: true, settleS });
    tours.push({ ...r, start: out, deg, kmh });
    console.log(`      ${String(out).padStart(5)}   ${`${deg} deg`.padEnd(7)} ` +
      `${String(kmh).padStart(6)}   ${r.arc.toFixed(0).padStart(11)}   ` +
      `${r.peak.toFixed(0).padStart(9)} ${r.settled.toFixed(0).padStart(8)}   ` +
      `${r.worst.toFixed(1).padStart(9)}   ${settleS.toFixed(1)} s`);
  }
  const tan = tours.find((t) => t.start === FENCE_FULL_M && t.deg === 0 && t.kmh === 0);
  /**
   * THE SETTLED SPEED, NOT THE PEAK, for an arm that STARTS at 140 km/h — the peak there is the
   * initial condition and says nothing about what the fence allowed. `settled` is the worst speed
   * after the first two seconds, which is longer than the brake needs: 140 km/h at 11 m/s2 stops in
   * 3.5 s, and the crawl only has to get it under its own ceiling.
   */
  check('the crawl holds the speed near its own limit at EVERY depth, not just the deepest',
    tours.every((t) => t.settled < CRAWL_CEIL),
    tours.filter((t) => t.settled >= CRAWL_CEIL)
      .map((t) => `${t.start}m/${t.deg}deg/${t.kmh}:${t.settled.toFixed(0)}`)
      .join(' ') || `worst ${Math.max(...tours.map((t) => t.settled)).toFixed(1)} km/h`);
  check('and holding the throttle never gets the car further out than it started, at any depth',
    tours.every((t) => t.worst < t.start + 2),
    tours.filter((t) => t.worst >= t.start + 2)
      .map((t) => `${t.start}m -> ${t.worst.toFixed(1)}`).join(' ') || 'none');
  // Non-empty by construction: an arm where the car never moved would satisfy both above.
  check('the car did move in every one of these arms, so the bounds measured something',
    tours.every((t) => t.arc > 5), tours.map((t) => t.arc.toFixed(0)).join(' '));
  check('and the sweep covers the shallow depths, which is where the defect was',
    tours.some((t) => t.out <= 5) && tours.some((t) => t.out >= 60),
    tours.map((t) => t.out).join(' '));
  check('and it covers a car already AT SPEED with a shallow inward nose, which is the pose that ' +
    'switched the crawl off',
    tours.some((t) => t.kmh > 100 && t.deg < 0), tours.filter((t) => t.kmh > 100).length + ' arms');
  /**
   * AND AN OUTWARD NOSE IS REFUSED OUTRIGHT, which is what makes those rows unnecessary above.
   * Swept over the angle rather than asserted at dot = 1: every check in this section before this
   * round used `fwd = (+-1, 0)` exactly.
   */
  {
    // The angle is measured FROM THE TANGENT, so `dot = sin(a)` — which is what makes 0.06 of a
    // degree the interesting case. The first version measured it from DEAD OUTWARD instead and
    // reported "90 degrees past the tangent gets throttle 1.00", which is the tangent itself.
    const angles = [0.06, 1, 3, 6, 15, 45, 90];
    const refused = angles.map((deg) => {
      const a = deg * Math.PI / 180;
      return worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, Math.sin(a), Math.cos(a),
        0, 0, { throttle: 1, brake: 0 }).controls.throttle;
    });
    console.log(`      an outward nose at ${angles.join(', ')} degrees past the tangent gets ` +
      `throttle ${refused.map((t) => t.toFixed(2)).join(', ')}`);
    check('any outward nose is refused the throttle, at every angle and not only dead-outward',
      refused.every((t) => t === 0), refused.join(' '));
    // And the tangent itself is NOT refused, or the car could never get moving at all.
    const atTangent = worldFence(BOX, BOX.x1 + FENCE_FULL_M, 0, 0, 1, 0, 0,
      { throttle: 1, brake: 0 }).controls.throttle;
    check('but the tangent itself is not, or a stationary car could never get moving',
      atTangent === 1, `${atTangent}`);
  }

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

/**
 * § A WEDGED CAR, AND THE CUE THAT NOW SAYS SO.
 *
 * A blind playtester rebuilt one pin five times and held each control for 30 s: full throttle
 * forward moved the car 0.34 m, full reverse moved it 145.15 m, with engine power at 0.46 and
 * 34,296 wall contacts over 360 s of which 34,295 charged nothing. Nothing on screen said
 * anything. `src/wanted.js`'s `composeLaw` is the only place the game has ever suggested
 * reverse, and only once an arrest is already running.
 *
 * BUILT GEOMETRY, NOT A FOUND PIN, and that is a correction. Two scenario arms tried to produce
 * a pin by driving at the district: sixteen headings of 20 s at full throttle gave a best of
 * 23.31 m of travel, and a pocket search found a spot where the car simply WRECKED — the contact
 * counter went negative, because a respawn resets it. A wreck is a different feature with its own
 * cue. So the wall here is a 20 m box the car is crept into, which pins it by construction and
 * cannot wreck it, and the detector's own inputs are swept separately below.
 */
console.log('\n§ the wedged-car cue');
{
  const HZ = 120, DT = 1 / HZ;
  const ground = new FlatGround(0);
  /**
   * A POCKET THE CAR CANNOT DRIVE OUT OF FORWARD: three walls around a 4 m bay, open to the
   * south. 4 m against a 1.9 m body leaves room to enter and none to turn.
   *
   * THE RING FIELD IS `p`, NOT `ring`, and the first version of this used `ring`: `BlockerIndex`
   * reads `buildings[b].p`, so it built an index of ZERO segments and the car drove 251.656 m
   * through where the wall was meant to be — with the arm correctly refusing rather than
   * reporting a pin. A silently empty index is the shape this file's own §1 exists to catch.
   */
  const BAY = 2.0, DEPTH = 10;
  const ix2 = new BlockerIndex({ buildings: [
    { p: [[-BAY - 8, 0], [-BAY, 0], [-BAY, -DEPTH], [-BAY - 8, -DEPTH]] },     // west wall
    { p: [[BAY, 0], [BAY + 8, 0], [BAY + 8, -DEPTH], [BAY, -DEPTH]] },         // east wall
    { p: [[-BAY - 8, 0], [BAY + 8, 0], [BAY + 8, 8], [-BAY - 8, 8]] },         // the end wall
  ] });
  console.log(`    the pocket: ${ix2.report().segments} wall segments, a ${BAY * 2} m bay `
    + `${DEPTH} m deep, closed to the north`);
  const drive = (controls, seconds, v) => {
    for (let i = 0; i < Math.round(seconds * HZ); i++) { v.setControls(controls); v.step(DT, ground); }
    return v;
  };
  const pinned = () => {
    const v = new Vehicle();
    v.blockers = ix2;
    v.position.set(0, v.position.y, -8);
    v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, 0);     // +z, into the end wall
    drive({ throttle: 0.35 }, 8, v);                            // crept in, so nothing wrecks
    return v;
  };
  const v0 = pinned();
  const before = { x: v0.position.x, z: v0.position.z, c: v0.contacts };
  drive({ throttle: 1 }, 10, v0);
  const travelled = Math.hypot(v0.position.x - before.x, v0.position.z - before.z);
  console.log(`    crept into a wall, then 10 s of full throttle: ${travelled.toFixed(3)} m of `
    + `travel, ${v0.contacts - before.c} contacts `
    + `(${((v0.contacts - before.c) / 10).toFixed(0)}/s), stuckFor ${v0.stuckFor.toFixed(2)} s`);
  /**
   * THE ARM ASSERTS IT IS PINNED BEFORE ASSERTING ANYTHING ABOUT THE CUE, because both sides of
   * "the cue fires when the car cannot move" are empty when the car can. Both earlier versions
   * of this measurement failed exactly here and said so rather than reporting a number.
   */
  check('the car really is pinned, so the arms below are measuring a jam',
    travelled < 1.0 && v0.contacts - before.c > 100,
    `${travelled.toFixed(3)} m under full power, ${v0.contacts - before.c} contacts`);
  check('and the cue fires on it, naming the direction that was NOT tried',
    v0.stuckFor >= STUCK_HOLD_S && composeStuck(v0)?.subtitle === 'reverse',
    `stuckFor ${v0.stuckFor.toFixed(2)} s, line `
    + `${JSON.stringify(composeStuck(v0))}`);
  // AND REVERSE GETS OUT, which is the whole reason the cue says that word.
  const vr = pinned();
  const r0 = { x: vr.position.x, z: vr.position.z };
  drive({ throttle: -1 }, 10, vr);
  const back = Math.hypot(vr.position.x - r0.x, vr.position.z - r0.z);
  console.log(`    the same pin, 10 s of full reverse: ${back.toFixed(2)} m — `
    + `x${(back / Math.max(0.001, travelled)).toFixed(0)} of what forward managed`);
  check('reverse gets the car out, so the cue is advice and not commentary',
    back > 20 && back / Math.max(0.001, travelled) > 20,
    `${back.toFixed(2)} m against ${travelled.toFixed(3)} m forward`);
  check('and holding reverse into a wall names the other direction',
    (() => {
      const v = new Vehicle();
      v.blockers = ix2;
      // Reversed into the same pocket: nose south, tail at the end wall.
      v.position.set(0, v.position.y, -8);
      v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, Math.PI);
      drive({ throttle: -0.35 }, 8, v);
      drive({ throttle: -1 }, 10, v);
      return v.stuckFor >= STUCK_HOLD_S && composeStuck(v)?.subtitle === 'drive';
    })(), 'tail-in jam -> "drive"');

  /**
   * THE DETECTOR'S THREE CONDITIONS, SWEPT. A jam needs a contact, an open throttle and no
   * travel, and each is asserted to be NECESSARY: without this the arms above pass for a
   * detector that fires on any three seconds of anything.
   */
  const rows = [
    ['no contact, full throttle, stationary', { touched: false, th: 1, v: 0 }, false],
    ['contact, throttle under the threshold', { touched: true, th: STUCK_THROTTLE - 0.01, v: 0 }, false],
    ['contact, full throttle, but moving', { touched: true, th: 1, v: STUCK_SPEED_MS + 0.01 }, false],
    ['contact, full throttle, stationary', { touched: true, th: 1, v: 0 }, true],
    ['contact, at the throttle threshold exactly', { touched: true, th: STUCK_THROTTLE, v: 0 }, true],
    ['contact, full reverse, stationary', { touched: true, th: -1, v: 0 }, true],
  ];
  const fire = ({ touched, th, v: planar }) => {
    const v = new Vehicle();
    v.setControls({ throttle: th });
    for (let i = 0; i < Math.round((STUCK_HOLD_S + 1) * HZ); i++) {
      v.velocity.set(planar, 0, 0);
      v.throttle = th;                       // held directly: setControls clamps and this sweeps
      v._trackJam(DT, touched);
    }
    return { stuckFor: v.stuckFor, line: composeStuck(v) };
  };
  /**
   * THE CONTACT GRACE, RE-MEASURED HERE RATHER THAN TRUSTED. `STUCK_CONTACT_GRACE_S` is
   * district/main.js's own dt clamp, and what it has to clear is how long a WEDGED car goes
   * without a corrected sample — which is a property of the collider and the wall, not a
   * constant anybody chose, so it can move under the feature.
   */
  {
    const v = pinned();
    let gap = 0, worst = 0, touches = 0, steps = 0;
    for (let i = 0; i < 30 * HZ; i++) {
      const c0 = v.contacts;
      v.setControls({ throttle: 1 });
      v.step(DT, ground);
      steps++;
      if (v.contacts > c0) { touches++; gap = 0; } else { gap += DT; if (gap > worst) worst = gap; }
    }
    console.log(`    a wedged car is contact-free on ${(100 * (1 - touches / steps)).toFixed(1)}% `
      + `of steps; worst gap ${worst.toFixed(4)} s = ${(worst / DT).toFixed(0)} steps, against a `
      + `grace of ${STUCK_CONTACT_GRACE_S}`);
    check('the contact grace clears the worst gap a real pin produces',
      worst > 0 && STUCK_CONTACT_GRACE_S > worst,
      `grace ${STUCK_CONTACT_GRACE_S} s against a measured worst of ${worst.toFixed(4)} s `
      + `(x${(STUCK_CONTACT_GRACE_S / worst).toFixed(2)})`);
    check('and the gap is real, so resetting on one clear step would have been the bug it was',
      touches < steps && touches > steps * 0.5,
      `${touches} of ${steps} steps touched`);
  }
  console.log(`    the detector's conditions (threshold ${STUCK_THROTTLE} throttle, `
    + `${STUCK_SPEED_MS} m/s, ${STUCK_HOLD_S} s):`);
  const wrong = [];
  for (const [name, inp, want] of rows) {
    const got = fire(inp);
    const fired = got.line !== null;
    console.log(`      ${name.padEnd(42)} ${fired ? 'CUE' : '—  '}  `
      + `stuckFor ${got.stuckFor.toFixed(2)} s`);
    if (fired !== want) wrong.push(name);
  }
  check('each of the three conditions is necessary, and together they are sufficient',
    wrong.length === 0, wrong.join('; ') || `${rows.length} cases, all as expected`);
  /**
   * AND THE DWELL CLEARS THE WORST HONEST PULL-AWAY. Full brake to rest then full power, time
   * spent under `STUCK_SPEED_MS`, measured here rather than quoted: the throttle threshold is
   * 0.5 and not `composeLaw`'s 0.05 precisely because at 0.05 a legitimate crawl away spends
   * longer under the threshold than the dwell is.
   */
  const pullAway = (throttle) => {
    const v = new Vehicle();
    drive({ brake: 1 }, 2, v);
    drive({ throttle: 1 }, 6, v);
    drive({ brake: 1 }, 6, v);
    let t = 0;
    for (let i = 0; i < Math.round(10 * HZ); i++) {
      v.setControls({ throttle });
      v.step(DT, ground);
      if (Math.hypot(v.velocity.x, v.velocity.z) < STUCK_SPEED_MS) t += DT; else break;
    }
    return t;
  };
  /**
   * AND THE SAME THING IN THE SHIPPED DISTRICT, not only in a bay built for the purpose. The
   * synthetic pocket above is the controlled case; this is the one a player can reach.
   *
   * (132.89, 221.48) was found by gridding the district at 5 m for clear spots with most of 16
   * directions blocked within 6 m, then testing each by creeping in and holding full throttle —
   * 388 candidates, 5 real pins. It reproduces the playtester's own numbers, which is what makes
   * it the right subject rather than a convenient one:
   *
   *     reported by the playtester   forward 0.34 m over 30 s, ~96 contacts/s
   *     here                         forward 0.185 m over 10 s, 94 contacts/s, reverse 28.7 m
   */
  {
    const PIN = { x: 132.89, z: 221.48, yaw: 1.571 };
    const atPin = () => {
      const v = new Vehicle();
      v.blockers = ix;                                 // the REAL district index, from §1
      v.position.set(PIN.x, v.position.y, PIN.z);
      v.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, PIN.yaw);
      drive({ throttle: 0.35 }, 8, v);
      return v;
    };
    const f = atPin();
    const f0 = { x: f.position.x, z: f.position.z, c: f.contacts };
    drive({ throttle: 1 }, 10, f);
    const fwd2 = Math.hypot(f.position.x - f0.x, f.position.z - f0.z);
    const r = atPin();
    const r0 = { x: r.position.x, z: r.position.z };
    drive({ throttle: -1 }, 10, r);
    const back2 = Math.hypot(r.position.x - r0.x, r.position.z - r0.z);
    console.log(`    a real pin at (${PIN.x}, ${PIN.z}): forward ${fwd2.toFixed(3)} m, reverse `
      + `${back2.toFixed(1)} m, ${f.contacts - f0.c} contacts `
      + `(${((f.contacts - f0.c) / 10).toFixed(0)}/s), stuckFor ${f.stuckFor.toFixed(1)} s`);
    check('the shipped district contains a pin a player can reach, and the cue fires in it',
      fwd2 < 1.0 && back2 > 15 && f.stuckFor >= STUCK_HOLD_S
      && composeStuck(f)?.subtitle === 'reverse',
      `forward ${fwd2.toFixed(3)} m, reverse ${back2.toFixed(1)} m, `
      + `stuckFor ${f.stuckFor.toFixed(1)} s`);
  }

  const atThreshold = pullAway(STUCK_THROTTLE);
  const atBustThrottle = pullAway(0.05);
  console.log(`    an unobstructed pull-away stays under ${STUCK_SPEED_MS} m/s for `
    + `${atThreshold.toFixed(3)} s at throttle ${STUCK_THROTTLE}, and `
    + `${atBustThrottle.toFixed(3)} s at the bust's 0.05`);
  check('the dwell clears the worst pull-away at its own throttle threshold, by a stated factor',
    atThreshold > 0 && STUCK_HOLD_S / atThreshold > 5,
    `x${(STUCK_HOLD_S / atThreshold).toFixed(1)} (${STUCK_HOLD_S} s against `
    + `${atThreshold.toFixed(3)} s)`);
  check('KNOWN-BAD: the bust\'s 0.05 would not clear it, which is why this has its own constant',
    atBustThrottle > STUCK_HOLD_S,
    `${atBustThrottle.toFixed(3)} s at throttle 0.05 against a dwell of ${STUCK_HOLD_S}`);
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
