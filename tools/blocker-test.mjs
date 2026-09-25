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
import { BlockerIndex, insideRing, ringArea, contactImpulse } from '../src/blockers.js';
import { edgesOf, ringArea as facadeRingArea } from '../src/facades.js';

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
const { DamageModel } = await import('../src/damage.js');
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
console.log('\n' + '='.repeat(78));
const failed = checks.filter((c) => !c.ok);
for (const c of failed) console.log(`FAIL  ${c.name}${c.detail ? `  [${c.detail}]` : ''}`);
if (failed.length) {
  console.log(`\nSTATIC BLOCKERS: FAIL — ${failed.length}/${checks.length} checks failed`);
  process.exit(1);
}
console.log(`\nSTATIC BLOCKERS: PASS — ${checks.length} checks`);
