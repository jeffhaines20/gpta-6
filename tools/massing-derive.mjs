// Score candidate marlin-core storey distributions against the MEASURED walls.
//
// COMMITTED AFTER THE FACT, and that is the point of it. The marlin-core-east
// table in tools/bake/massing.mjs was derived by scoring five candidates against
// the street-level measurements, and the numbers that derivation produced were
// published in the ledger - 1.67 median built/reference ratio before, 0.94 after,
// spread 0.46-1.81 against 0.25-2.41 - while the script itself lived in a
// scratchpad and was thrown away. An independent review pointed out, correctly,
// that this made the whole derivation unauditable: the house rule is that critic
// diagnoses are hypotheses until audited, and a derivation nobody can re-run is
// in exactly that position.
//
//   node tools/massing-derive.mjs
//
// CAVEAT, and read it before trusting the output. This scores against
// docs/shots/pano-match/roofline-golden.json, whose BUILT side comes from the
// pixel sky detector in tools/roofline.mjs. That detector was afterwards shown to
// fail on R-facing views at golden hour, where our sun sits at bearing 134 deg and
// ACES desaturates the sky past the detector's blue test - about 34 degrees of
// one-sided error. The REFERENCE side of each pair is a photograph and is not
// affected in the same way, and it is the reference angle this script uses for
// H_ref, so the derivation is less damaged than the residuals published beside it.
// It is still the wrong instrument. Prefer tools/roofline-analytic.mjs where it
// exists, and treat this file as the record of how the shipped table was actually
// chosen rather than as the way to choose the next one.
import fs from 'node:fs';
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const j = JSON.parse(fs.readFileSync('docs/shots/pano-match/roofline-golden.json', 'utf8'));
const idx = JSON.parse(fs.readFileSync('reference/sarasota/mapillary/index.json', 'utf8'));
const pos = {}; idx.images.forEach((i) => { pos[i.id] = i; });
const route = d.meta.route;
const rad = Math.PI / 180;
const bearingAt = (x, z) => { let b = 0, bd = Infinity; for (let i = 0; i + 1 < 5; i++) { const a = route[i], c = route[i + 1]; const dx = c.x - a.x, dz = c.z - a.z, l2 = dx * dx + dz * dz || 1; let t = ((x - a.x) * dx + (z - a.z) * dz) / l2; t = Math.max(0, Math.min(1, t)); const q = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t)); if (q < bd) { bd = q; b = Math.atan2(dx, -dz); } } return b; };
const segD = (px, pz, x0, z0, x1, z1) => { const vx = x1 - x0, vz = z1 - z0, l2 = vx * vx + vz * vz; const t = l2 ? Math.max(0, Math.min(1, ((px - x0) * vx + (pz - z0) * vz) / l2)) : 0; return Math.hypot(px - (x0 + vx * t), pz - (z0 + vz * t)); };
const cen = (p) => { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; };
const face = (x, z, yawRad) => { const ux = Math.sin(yawRad), uz = -Math.cos(yawRad); let best = null, bd = Infinity;
  for (const b of d.buildings) for (let i = 0; i < b.p.length; i++) { const A = b.p[i], B = b.p[(i + 1) % b.p.length];
    const mx = (A[0] + B[0]) / 2, mz = (A[1] + B[1]) / 2;
    if ((mx - x) * ux + (mz - z) * uz < 2) continue;
    if (Math.abs((mx - x) * (-uz) + (mz - z) * ux) > 14) continue;
    const dist = segD(x, z, A[0], A[1], B[0], B[1]);
    if (dist < bd) { bd = dist; best = b; } }
  return best ? { b: best, d: +bd.toFixed(1) } : null; };
const seedOf = (x, z) => { let h = 2166136261; const s = `${Math.round(x * 10)}:${Math.round(z * 10)}`; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967295; };

const CURRENT = (r, area) => { if (area > 2200) return r < 0.45 ? 6 : r < 0.8 ? 8 : 11; if (area > 900) return r < 0.4 ? 3 : r < 0.75 ? 4 : 6; if (area > 300) return r < 0.5 ? 2 : r < 0.85 ? 3 : 4; return r < 0.65 ? 2 : 3; };
const CANDIDATES = {
  current: CURRENT,
  A: (r, area) => { if (area > 2200) return r < 0.45 ? 4 : r < 0.8 ? 6 : 8; if (area > 900) return r < 0.4 ? 2 : r < 0.75 ? 3 : 4; if (area > 300) return r < 0.5 ? 2 : r < 0.85 ? 2 : 3; return r < 0.65 ? 1 : 2; },
  B: (r, area) => { if (area > 2200) return r < 0.5 ? 4 : r < 0.85 ? 5 : 7; if (area > 900) return r < 0.45 ? 2 : r < 0.8 ? 3 : 4; if (area > 300) return r < 0.55 ? 2 : r < 0.9 ? 2 : 3; return r < 0.7 ? 1 : 2; },
  C: (r, area) => { if (area > 2200) return r < 0.45 ? 3 : r < 0.8 ? 5 : 7; if (area > 900) return r < 0.4 ? 2 : r < 0.75 ? 3 : 4; if (area > 300) return r < 0.5 ? 1 : r < 0.85 ? 2 : 3; return r < 0.65 ? 1 : 2; },
  // D keeps a 2-storey floor on the retail wall: a 3.2 m single-storey box on Main
  // Street reads as a shed, and the reference has none.
  D: (r, area) => { if (area > 2200) return r < 0.45 ? 3 : r < 0.8 ? 5 : 7; if (area > 900) return r < 0.45 ? 2 : r < 0.8 ? 3 : 4; if (area > 300) return r < 0.6 ? 2 : r < 0.9 ? 2 : 3; return r < 0.65 ? 1 : 2; },
  E: (r, area) => { if (area > 2200) return r < 0.5 ? 3 : r < 0.85 ? 4 : 6; if (area > 900) return r < 0.5 ? 2 : r < 0.85 ? 3 : 4; if (area > 300) return r < 0.6 ? 2 : r < 0.9 ? 2 : 3; return r < 0.7 ? 1 : 2; },
};

const faces = [];
for (const p of j.pairs) { const q = pos[p.id]; if (!(q.z < -100 && q.x > 55)) continue;
  const yaw = bearingAt(q.x, q.z) + (p.side === 'L' ? -90 : 90) * rad;
  const f = face(q.x, q.z, yaw); if (!f) continue;
  // 'marlin-core' is the historic pre-split band name; after the east/west split
  // the same footprints carry 'marlin-core-east'. Accept both so this script
  // reproduces the original derivation AND runs against the current bake.
  if (f.b.b !== 'marlin-core' && f.b.b !== 'marlin-core-east') continue;
  // marlin-back rows are 48-80 m away and several are clipped, so they are out.
  if (p.reference.clippedFrac > 0.35) continue;   // a clipped reference angle is a lower bound, not a measurement
  const Href = 2.5 + f.d * Math.tan(p.reference.p50 * rad);
  const [cx, cz] = cen(f.b.p);
  faces.push({ x: q.x, side: p.side, d: f.d, Href, area: f.b.a, r: seedOf(cx, cz), now: f.b.h });
}
console.log(`${faces.length} street-facing marlin-core-east measurements with an unclipped reference angle\n`);
// An empty set is a broken run, not a clean one. Scoring five candidates against
// nothing used to crash three lines later inside toFixed(), which reads as a code
// bug rather than as "your filter matched no walls".
if (!faces.length) {
  console.error('No walls matched. Check the band name filter above against the bands');
  console.error('actually present in data/district.json, and that roofline-golden.json is current.');
  process.exit(2);
}
for (const [name, pick] of Object.entries(CANDIDATES)) {
  const ratios = faces.map((f) => (pick(f.r, f.area) * 3.2) / f.Href).sort((a, b) => a - b);
  const med = ratios[Math.floor(ratios.length / 2)];
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  const within = ratios.filter((v) => v > 0.75 && v < 1.33).length;
  console.log(`  ${name.padEnd(8)} median ratio ${med.toFixed(2)}  mean ${mean.toFixed(2)}  within +-33% of reference: ${within}/${ratios.length}  range ${ratios[0].toFixed(2)}-${ratios[ratios.length - 1].toFixed(2)}`);
}
console.log('\nper face, candidate B:');
for (const f of faces) console.log(`  x=${String(f.x).padStart(5)} ${f.side}  d=${String(f.d).padStart(4)}  H_ref ${f.Href.toFixed(1).padStart(5)}  now ${String(f.now).padStart(5)}  ->  ${(CANDIDATES.B(f.r, f.area) * 3.2).toFixed(1).padStart(5)}`);
