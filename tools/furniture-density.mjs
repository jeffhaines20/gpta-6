// How much furniture is actually standing on a given stretch of pavement, and
// where the placement rule threw stations away.
//
// A blind reviewer counted ZERO objects on the corridor's right-hand walk -- a
// full shopfront run in front of the deli -- and zero on the Five Points plaza,
// with the nearest furniture a single bin and a single shrub. The district as a
// whole carries roughly 4,600 props, so "add more furniture" is the wrong
// response to that: the question is why THOSE stretches came out empty. This
// answers it by counting placements per metre of kerb in a named band, and by
// recording every station the rule considered and rejected, with the reason.
//
//   node tools/furniture-density.mjs
//   node tools/furniture-density.mjs --band 100,200,-235,-140 --name "corridor right walk"
//   node tools/furniture-density.mjs --selftest
//
// No browser: the dressing pass runs in node, following tools/oak-audit.mjs,
// lamps included -- without lamps every lampClearance() is Infinity and the
// harness dresses a district the page never renders.
import * as THREE from '../vendor/three.module.min.js';
import fs from 'node:fs';
import { StreetFurniture } from '../src/streetfurniture.js';

const arg = (k, dflt) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};

/** StreetFurniture that keeps a record of every kerb station and its fate. */
function instrument(fu) {
  const log = [];
  const orig = fu._kerbStation.bind(fu);
  fu._kerbStation = function (emit, st) {
    const before = { ...this.props };
    // Re-evaluate the same three tests the rule uses, so a rejection can be
    // attributed rather than merely counted.
    const road = this.roadClearance(st.x, st.z, -1);
    const bld = this.buildingClearance(st.x, st.z);
    const lamp = this.lampClearance(st.x, st.z);
    orig(emit, st);
    let placed = 0;
    for (const [k, v] of Object.entries(this.props)) placed += v - (before[k] ?? 0);
    log.push({
      x: st.x, z: st.z, placed,
      road: +road.toFixed(2), bld: +bld.toFixed(2), lamp: +lamp.toFixed(2),
      reason: placed > 0 ? null
        : road < 1.5 ? 'road' : bld < 0.8 ? 'building' : lamp < 1.6 ? 'lamp' : 'passed-gate-placed-nothing',
    });
  };
  return log;
}

function dress() {
  const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
  const fu = new StreetFurniture(new THREE.Scene(), { max: 1200 });
  let placed = 0;
  for (const e of d.edges) {
    if (e.r > 6) continue;
    for (let k = 0; k < e.v.length - 1 && placed < 1100; k++) {
      const a = d.verts[e.v[k]], b = d.verts[e.v[k + 1]];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      const n = Math.floor(len / 26);
      for (let s = 1; s <= n && placed < 1100; s++) {
        const f = s / (n + 1);
        const x = a.x + (b.x - a.x) * f, z = a.z + (b.z - a.z) * f;
        const side = s % 2 ? 1 : -1;
        const nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;
        const off = (e.w / 2 + 1.4) * side;
        fu.addLamp(x + nx * off, z + nz * off, Math.atan2(-nx * side, -nz * side));
        placed++;
      }
    }
  }
  fu.commit();
  const log = instrument(fu);
  fu.dressDistrict(d, { audit: true });
  return { fu, log, d };
}

function bandReport(name, box, fu, log) {
  const [x0, x1, z0, z1] = box;
  const inBox = (x, z) => x >= x0 && x <= x1 && z >= z0 && z <= z1;
  const props = (fu.placed ?? []).filter((p) => inBox(p.x, p.z));
  const st = log.filter((s) => inBox(s.x, s.z));
  const byKind = {};
  for (const p of props) byKind[p.kind] = (byKind[p.kind] ?? 0) + 1;
  const byReason = {};
  for (const s of st) if (s.reason) byReason[s.reason] = (byReason[s.reason] ?? 0) + 1;
  const area = (x1 - x0) * (z1 - z0);
  console.log(`\n=== ${name}   x ${x0}..${x1}  z ${z0}..${z1}   (${area} m2)`);
  console.log(`  kerb stations considered : ${st.length}`);
  console.log(`  stations that placed     : ${st.filter((s) => s.placed > 0).length}`);
  console.log(`  rejected, by reason      : ${Object.keys(byReason).length ? JSON.stringify(byReason) : 'none'}`);
  console.log(`  props standing here      : ${props.length}   ${JSON.stringify(byKind)}`);
  console.log(`  props per 1000 m2        : ${(1000 * props.length / area).toFixed(1)}`);
  return { props: props.length, stations: st.length, byReason };
}

function selftest() {
  // The instrument must attribute a rejection to the test that actually failed,
  // and must not report a rejection for a station that placed something. Both
  // are checked against a stub rather than the district, so the assertion is
  // about the bookkeeping and not about this particular city.
  let fail = 0;
  const stub = {
    props: {},
    roadClearance: () => 9, buildingClearance: () => 9, lampClearance: () => 9,
    _kerbStation(emit, st) { if (st.ok) this.props.bin = (this.props.bin ?? 0) + 1; },
  };
  const log = instrument(stub);
  stub._kerbStation(null, { x: 0, z: 0, ok: true });
  stub._kerbStation(null, { x: 1, z: 1, ok: false });
  const a = log[0], b = log[1];
  const ok1 = a.placed === 1 && a.reason === null;
  const ok2 = b.placed === 0 && b.reason === 'passed-gate-placed-nothing';
  console.log(`  station that placed      : ${ok1 ? 'counted 1, no reason' : 'WRONG ' + JSON.stringify(a)}`);
  console.log(`  station that placed none : ${ok2 ? 'counted 0, reason recorded' : 'WRONG ' + JSON.stringify(b)}`);
  if (!ok1) fail++;
  if (!ok2) fail++;
  // A failing clearance must be named, not lumped in with the catch-all.
  const stub2 = { ...stub, props: {}, buildingClearance: () => 0.1,
    _kerbStation(emit, st) { /* gate would have rejected */ } };
  const log2 = instrument(stub2);
  stub2._kerbStation(null, { x: 0, z: 0 });
  const ok3 = log2[0].reason === 'building';
  console.log(`  blocked by a building    : ${ok3 ? "named 'building'" : 'WRONG ' + JSON.stringify(log2[0])}`);
  if (!ok3) fail++;
  console.log(fail ? `\nSELFTEST FAILED (${fail})` : '\nSELFTEST PASSED');
  return fail;
}

if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

const { fu, log } = dress();
const rep = fu.report();
console.log(`district: ${rep.propCount} props, ${rep.propTriangles} triangles, ${log.length} kerb stations considered`);
const rejected = log.filter((s) => !s.placed);
const allReasons = {};
for (const s of rejected) allReasons[s.reason] = (allReasons[s.reason] ?? 0) + 1;
console.log(`district: ${rejected.length} of ${log.length} stations placed nothing — ${JSON.stringify(allReasons)}`);

const custom = arg('band', null);
if (custom) {
  bandReport(arg('name', 'band'), custom.split(',').map(Number), fu, log);
} else {
  // The two stretches the reviewer called empty, in world coordinates.
  bandReport('corridor right-hand walk (in front of the deli)', [100, 200, -235, -140], fu, log);
  bandReport('Five Points plaza', [-40, 80, -120, -20], fu, log);
  bandReport('Main St band, for comparison', [40, 440, -215, -115], fu, log);
}
