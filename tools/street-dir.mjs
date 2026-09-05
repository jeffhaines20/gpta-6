// Which way does a building face?
//
// streaming.js decides a building's FRONT by finding the nearest road vertex to
// the footprint centroid and pointing at it. That is wrong in a way that only
// shows up on particular footprints: a vertex is a junction or a polyline kink,
// not the road, so a building on a long straight block whose fronting street has
// no vertex nearby will happily point at a junction on the street BEHIND it.
// The reported symptom was building #29 presenting a blank rear wall to Main St
// east, which is what happens when the front edge is chosen on the wrong side.
//
// This measures the disagreement rather than assuming it. Three candidates:
//   vertex   what streaming.js does today: nearest road VERTEX to the centroid
//   segment  nearest point on the nearest road SEGMENT
//   frontage the edge-based answer: for each footprint edge, how far along its
//            own outward normal is the nearest road segment; the edge that sees
//            a road soonest is the front, and its normal is the direction
//
//   node tools/street-dir.mjs            census + the worst disagreements
//   node tools/street-dir.mjs --selftest
import fs from 'node:fs';
import { streetDirFor } from '../src/geom.js';

const DEG = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1]))) * 180 / Math.PI;

/** Nearest point on segment ab to p, and its squared distance. */
function nearestOnSeg(px, pz, ax, az, bx, bz) {
  const dx = bx - ax, dz = bz - az;
  const L2 = dx * dx + dz * dz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / L2)) : 0;
  const qx = ax + dx * t, qz = az + dz * t;
  return { x: qx, z: qz, d2: (px - qx) ** 2 + (pz - qz) ** 2 };
}

export function makeStreetDir(d) {
  const CHUNK = d.meta.chunkSize;
  const keyOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;
  const centroid = (b) => {
    let cx = 0, cz = 0;
    for (const [x, z] of b.p) { cx += x; cz += z; }
    return [cx / b.p.length, cz / b.p.length];
  };
  // Road segments near a building: its own chunk plus the eight around it, so a
  // building near a chunk boundary is not blind to the street it fronts. The old
  // code looked only in its own chunk, which is a second way to get this wrong.
  const segsNear = (cx, cz) => {
    const out = [];
    const ci = Math.floor(cx / CHUNK), cj = Math.floor(cz / CHUNK);
    for (let i = ci - 1; i <= ci + 1; i++) for (let j = cj - 1; j <= cj + 1; j++) {
      const ch = d.chunks[`${i},${j}`];
      if (!ch) continue;
      for (const ei of ch.edges) {
        const e = d.edges[ei];
        for (let k = 0; k + 1 < e.v.length; k++) out.push([d.verts[e.v[k]], d.verts[e.v[k + 1]]]);
        if (e.v.length === 2) { /* already covered */ }
      }
    }
    return out;
  };
  const norm = (dx, dz) => { const L = Math.hypot(dx, dz) || 1; return [dx / L, dz / L]; };

  return {
    centroid, segsNear, keyOf,
    /** Today's answer. */
    vertex(b) {
      const [cx, cz] = centroid(b);
      const chunk = d.chunks[keyOf(cx, cz)];
      if (!chunk || !chunk.edges.length) return null;
      let best = null, bestD = Infinity;
      for (const ei of chunk.edges) for (const vi of d.edges[ei].v) {
        const v = d.verts[vi];
        const dd = (v.x - cx) ** 2 + (v.z - cz) ** 2;
        if (dd < bestD) { bestD = dd; best = v; }
      }
      return best ? norm(best.x - cx, best.z - cz) : null;
    },
    /** Nearest point on the nearest segment. */
    segment(b) {
      const [cx, cz] = centroid(b);
      let best = null, bestD = Infinity;
      for (const [a, c] of segsNear(cx, cz)) {
        const q = nearestOnSeg(cx, cz, a.x, a.z, c.x, c.z);
        if (q.d2 < bestD) { bestD = q.d2; best = q; }
      }
      return best ? norm(best.x - cx, best.z - cz) : null;
    },
    /**
     * The shipped answer. Imported rather than reimplemented so that the
     * self-test below exercises the code that actually runs, not a copy of it.
     */
    frontage(b) { return streetDirFor(d, b); },
  };
}

function selftest() {
  // The failure mode, isolated. A road can be NEAR a building while its vertices
  // are FAR from it -- that is the normal case on a long straight block -- and a
  // short stub or junction behind the building can have vertices that are nearer
  // than those, without the road itself being nearer. Nearest-vertex then points
  // backwards. My first attempt at this test did not separate the two and every
  // method "failed" identically, which told me nothing.
  const mk = (verts, edges) => ({
    meta: { chunkSize: 1000 }, verts, edges,
    chunks: { '0,0': { edges: edges.map((_, i) => i) } }, buildings: [],
  });
  const ring = [[-20, -10], [20, -10], [20, 10], [-20, 10]];   // 40 x 20, centred
  const b = { p: ring };
  let fail = 0;
  const off = (v, want) => (v ? DEG(v, want) : 999);

  // 1. One road, with a vertex squarely in front. All three must agree.
  {
    const S = makeStreetDir(mk([{ x: 0, z: 15 }, { x: 60, z: 15 }], [{ v: [0, 1] }]));
    const r = ['vertex', 'segment', 'frontage'].map((m) => off(S[m](b), [0, 1]));
    const ok = r.every((x) => x < 20);
    console.log(`  road in front, vertex in front  : vertex ${r[0].toFixed(0)} deg, segment ${r[1].toFixed(0)}, frontage ${r[2].toFixed(0)}  ${ok ? 'all agree' : 'MISMATCH'}`);
    if (!ok) fail++;
  }

  // 2. THE BUG. A long road 15 m in front whose vertices are 200 m away, and a
  //    stub 40 m BEHIND whose vertices are 40 m away. Nearest-vertex picks the
  //    stub and faces the building backwards; the other two must not.
  {
    const S = makeStreetDir(mk(
      [{ x: -200, z: 15 }, { x: 200, z: 15 }, { x: -1, z: -40 }, { x: 1, z: -40 }],
      [{ v: [0, 1] }, { v: [2, 3] }]));
    const v = off(S.vertex(b), [0, 1]), sg = off(S.segment(b), [0, 1]), f = off(S.frontage(b), [0, 1]);
    console.log(`  road in front, stub behind      : vertex ${v.toFixed(0)} deg, segment ${sg.toFixed(0)}, frontage ${f.toFixed(0)}`);
    if (!(v > 120)) { console.log('    expected nearest-vertex to face backwards here; it did not'); fail++; }
    if (!(sg < 20)) { console.log('    nearest-segment did not find the road in front'); fail++; }
    if (!(f < 20)) { console.log('    frontage did not find the road in front'); fail++; }
  }

  // 3. Outward normals. A road on each of two opposite sides, the nearer one
  //    must win, and the answer must point OUT of the footprint, not into it.
  {
    const S = makeStreetDir(mk(
      [{ x: -60, z: 14 }, { x: 60, z: 14 }, { x: -60, z: -50 }, { x: 60, z: -50 }],
      [{ v: [0, 1] }, { v: [2, 3] }]));
    const f = S.frontage(b);
    const ok = off(f, [0, 1]) < 20;
    console.log(`  roads both sides, near one wins : frontage ${off(f, [0, 1]).toFixed(0)} deg  ${ok ? 'outward, toward the near road' : 'WRONG SIGN OR SIDE'}`);
    if (!ok) fail++;
  }
  // 4. ROAD CLASS BEATS PROXIMITY. A service alley 3.5 m behind, a real street
  //    11.7 m in front across a parking lane -- the exact geometry of building
  //    #18 on this district. Picking the nearer tarmac fronts a Main Street
  //    block onto its own back alley, which is what the first version of
  //    streetDirFor did. streetfurniture.js already treats r > 5 as alley.
  {
    const S = makeStreetDir(mk(
      [{ x: -80, z: 21.7 }, { x: 80, z: 21.7 },      // class 4, 11.7 m past the wall
       { x: -80, z: -13.5 }, { x: 80, z: -13.5 }],   // class 8 alley, 3.5 m behind
      [{ v: [0, 1], r: 4, w: 6.6 }, { v: [2, 3], r: 8, w: 2.8 }]));
    const f = S.frontage(b);
    const ok = off(f, [0, 1]) < 20;
    console.log(`  alley near, street far          : frontage ${off(f, [0, 1]).toFixed(0)} deg  ${ok ? 'chose the street' : 'CHOSE THE ALLEY'}`);
    if (!ok) fail++;
  }

  // 5. LENGTH BREAKS A TIE WITHIN A CLASS. Same class of road on the long side
  //    and on the short end, the end marginally closer. The primary elevation is
  //    the one that shows the most wall to the street; without this, #18 chose
  //    its 31 m end over its 181 m Main Street frontage for two metres.
  {
    const long = [[-90, -10], [90, -10], [90, 10], [-90, 10]];   // 180 x 20
    const S = makeStreetDir(mk(
      [{ x: -200, z: 22 }, { x: 200, z: 22 },        // 12 m off the 180 m side
       { x: 100, z: -60 }, { x: 100, z: 60 }],       // 10 m off the 20 m end
      [{ v: [0, 1], r: 4, w: 6.6 }, { v: [2, 3], r: 4, w: 6.6 }]));
    const f = S.frontage({ p: long });
    const ok = off(f, [0, 1]) < 20;
    console.log(`  long side vs nearer short end   : frontage ${off(f, [0, 1]).toFixed(0)} deg  ${ok ? 'chose the long elevation' : 'CHOSE THE END WALL'}`);
    if (!ok) fail++;
  }

  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

// Only census when run directly. Importing this module for makeStreetDir used to
// run the whole district census as a side effect and print it again.
const DIRECT = process.argv[1] && process.argv[1].endsWith('street-dir.mjs');
if (!DIRECT) { /* imported for makeStreetDir */ } else {
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const S = makeStreetDir(d);
let n = 0, disagreeSeg = 0, disagreeFront = 0, behind = 0;
const worst = [];
d.buildings.forEach((b, i) => {
  const v = S.vertex(b), s = S.segment(b), f = S.frontage(b);
  if (!v || !s || !f) return;
  n++;
  const dv = DEG(v, f), ds = DEG(s, f);
  if (DEG(v, s) > 45) disagreeSeg++;
  if (dv > 45) disagreeFront++;
  if (dv > 120) behind++;                            // pointing broadly the wrong way
  worst.push({ i, dv, ds });
});
worst.sort((a, b) => b.dv - a.dv);
console.log(`buildings measured                      : ${n}`);
console.log(`vertex vs segment  disagree >45 deg     : ${disagreeSeg}  (${(100 * disagreeSeg / n).toFixed(1)}%)`);
console.log(`vertex vs frontage disagree >45 deg     : ${disagreeFront}  (${(100 * disagreeFront / n).toFixed(1)}%)`);
console.log(`vertex points broadly BACKWARDS >120 deg: ${behind}  (${(100 * behind / n).toFixed(1)}%)`);
console.log('\nworst 12 (building index, vertex-vs-frontage deg, segment-vs-frontage deg):');
for (const w of worst.slice(0, 12)) console.log(`  #${String(w.i).padStart(3)}  vertex ${w.dv.toFixed(0).padStart(3)} deg   segment ${w.ds.toFixed(0).padStart(3)} deg`);
const b29 = worst.find((w) => w.i === 29);
if (b29) console.log(`\nbuilding #29 (the reported one): vertex ${b29.dv.toFixed(0)} deg off the frontage answer, segment ${b29.ds.toFixed(0)} deg`);
}
