// What each SURFACE of the traffic car actually COSTS and actually COVERS.
//
// WHY. A blind review of round 1 reported "a new flat-black front valance slab,
// ~6,900 px^2, 2.6x the area of the entire front wheel". That is an observation
// about screen area, and the round that caused it priced its additions in
// TRIANGLES only - so it had no way of noticing that an 8-triangle grille is one
// of the largest single-colour surfaces on the car. Triangles and area are
// different currencies and this project had only been counting one of them.
//
// Everything here is offline and deterministic: it builds the geometry in node
// off the same module the district imports, so it carries none of the ~20k of
// placement noise the budget gate's triangle statistic does (CLAUDE.md).
//
//   node tools/car-surface.mjs --selftest
//   node tools/car-surface.mjs                 # per-surface tris and area
//   node tools/car-surface.mjs --view 1,0,0.35 # projected area from a direction
//
// AREA, and the one subtlety in it. `area` is the true 3D area of the triangles
// carrying a surface. `proj` is the area of their projection onto a plane facing
// `view`, counting FRONT-FACING triangles only (n.v > 0) - a panel edge-on to the
// camera projects to ~0 however big it is, which is the whole reason the wheel's
// inboard face was deleted in round 1. Neither is a pixel count: a surface behind
// another surface still counts here. That limit is stated because the metric is
// used below to compare a grille against a wheel, and the grille is not occluded
// in the frame that prompted this.
import { pathToFileURL } from 'node:url';
import { buildTrafficCarGeometry, SURFACE } from '../src/carbody.js';

const NAME = Object.fromEntries(Object.entries(SURFACE).map(([k, v]) => [v, k]));
const PAL_W = 16;

/**
 * Per-surface triangle count, 3D area, and area projected toward `view`.
 * @param {THREE.BufferGeometry} g  a geometry whose uv.x indexes the palette
 * @param {[number,number,number]} view  direction the viewer looks FROM
 */
export function surfaceStats(g, view = [1, 0, 0]) {
  const pos = g.attributes.position.array;
  const uv = g.attributes.uv.array;
  const idx = g.index ? g.index.array : null;
  const n = idx ? idx.length : g.attributes.position.count;
  const vlen = Math.hypot(...view) || 1;
  const v = view.map((c) => c / vlen);
  const rows = new Map();
  for (let t = 0; t < n; t += 3) {
    const a = idx ? idx[t] : t, b = idx ? idx[t + 1] : t + 1, c = idx ? idx[t + 2] : t + 2;
    // uv.x = (paletteIndex + 0.5) / 16, so the index is recovered by inverting it.
    // Round, do not floor: 0.5/16 stored as a float32 can come back a hair under.
    const pi = Math.round(uv[a * 2] * PAL_W - 0.5);
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const bx = pos[b * 3], by = pos[b * 3 + 1], bz = pos[b * 3 + 2];
    const cx = pos[c * 3], cy = pos[c * 3 + 1], cz = pos[c * 3 + 2];
    const e1 = [bx - ax, by - ay, bz - az], e2 = [cx - ax, cy - ay, cz - az];
    const cr = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const twice = Math.hypot(...cr);
    const area = twice / 2;
    // Projected area of a triangle onto the plane normal to v is |n . v| * area,
    // and the sign of n.v says whether it faces the viewer.
    const dot = (cr[0] * v[0] + cr[1] * v[1] + cr[2] * v[2]) / (twice || 1);
    const r = rows.get(pi) ?? { tris: 0, area: 0, proj: 0 };
    r.tris++; r.area += area;
    if (dot > 0) r.proj += area * dot;
    rows.set(pi, r);
  }
  return rows;
}

function selftest() {
  const fail = [];
  const ok = (nm, c, d) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${nm}${d ? ' — ' + d : ''}`); if (!c) fail.push(nm); };

  // A hand-built fixture with KNOWN areas, so the metric is checked against
  // arithmetic rather than against itself. One 2x2 quad in the x=0 plane
  // (surface 3) and one 1x1 quad in the z=0 plane (surface 9).
  const mk = () => {
    const P = [], U = [], I = [];
    const push = (x, y, z, pal) => { P.push(x, y, z); U.push((pal + 0.5) / PAL_W, 0.5); return P.length / 3 - 1; };
    // 2x2 facing +x. The winding here was wrong on the first cut - (b-a)x(c-a)
    // came out -x - and the self-test caught it as three failures rather than as
    // a plausible table. Reversed so the normal really is +x.
    const a0 = push(0, -1, -1, 3), a1 = push(0, -1, 1, 3), a2 = push(0, 1, 1, 3), a3 = push(0, 1, -1, 3);
    I.push(a0, a2, a1, a0, a3, a2);
    // 1x1 facing +z, wound so its normal is +z
    const b0 = push(-0.5, -0.5, 0, 9), b1 = push(0.5, -0.5, 0, 9), b2 = push(0.5, 0.5, 0, 9), b3 = push(-0.5, 0.5, 0, 9);
    I.push(b0, b1, b2, b0, b2, b3);
    return {
      index: { array: I }, attributes: {
        position: { array: P, count: P.length / 3 }, uv: { array: U },
      },
    };
  };
  const g = mk();

  // Winding check first: with the normals as wound above, (0,-1,1)x... must give
  // +x for the first quad. If it does not the projection signs are meaningless.
  const rx = surfaceStats(g, [1, 0, 0]);
  ok('3D area is exact for a known fixture',
    Math.abs(rx.get(3).area - 4) < 1e-9 && Math.abs(rx.get(9).area - 1) < 1e-9,
    `${rx.get(3).area} and ${rx.get(9).area}`);
  ok('triangles land in the right palette bucket',
    rx.get(3).tris === 2 && rx.get(9).tris === 2, `${rx.get(3).tris} / ${rx.get(9).tris}`);
  ok('face-on projected area equals its 3D area',
    Math.abs(rx.get(3).proj - 4) < 1e-9, `proj=${rx.get(3).proj}`);
  ok('EDGE-ON projected area is ~0, not its 3D area',
    rx.get(9).proj < 1e-9, `proj=${rx.get(9).proj}`);
  // Known-bad input: a viewer BEHIND the 2x2 quad must see none of it. A metric
  // that ignores winding would report 4 here and would happily credit the car
  // for the inboard face of every wheel.
  const rback = surfaceStats(g, [-1, 0, 0]);
  ok('a back-facing panel projects to 0 (winding respected)',
    rback.get(3).proj < 1e-9 && Math.abs(rback.get(9).proj) < 1e-9, `proj=${rback.get(3).proj}`);
  // 45 degrees: cos45 * 4 = 2.828427
  const r45 = surfaceStats(g, [1, 0, 1]);
  ok('at 45 degrees a 2x2 panel projects to 2.828',
    Math.abs(r45.get(3).proj - 4 * Math.SQRT1_2) < 1e-9, `proj=${r45.get(3).proj.toFixed(6)}`);
  // And the palette index must survive a float32 round-trip, which is how the
  // real geometry stores it. Truncation instead of rounding puts every surface
  // one bucket low and the table would be quietly, entirely wrong.
  const f32 = Float32Array.from(g.attributes.uv.array);
  const g2 = { ...g, attributes: { ...g.attributes, uv: { array: f32 } } };
  const r2 = surfaceStats(g2, [1, 0, 0]);
  ok('palette index survives float32 storage', r2.get(3) && r2.get(3).tris === 2,
    `buckets ${[...r2.keys()].join(',')}`);

  console.log(fail.length ? `\nSELFTEST FAILED: ${fail.join(', ')}` : '\nSELFTEST OK');
  return fail.length === 0;
}

if (process.argv.includes('--selftest')) {
  const a = selftest();
  const b = windingSelftest();
  process.exit(a && b ? 0 : 1);
}

// ENTRY GUARD. Without one, `import { surfaceStats }` prints a table and, in
// tools that boot a page, launches a browser - which is precisely why the metric
// functions had to be split out of tools/car-probe.mjs into car-metrics.mjs this
// round. Not repeating that here.
const DIRECT = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (DIRECT) {
const vi = process.argv.indexOf('--view');
const view = vi >= 0 ? process.argv[vi + 1].split(',').map(Number) : [1, 0, 0.35];
const g = buildTrafficCarGeometry({ groundY: 0 });
const tris = g.index.count / 3;
const rows = [...surfaceStats(g, view).entries()].sort((a, b) => b[1].proj - a[1].proj);
const totProj = rows.reduce((s, r) => s + r[1].proj, 0);
console.log(`buildTrafficCarGeometry: ${tris} triangles, ${g.attributes.position.count} vertices`);
console.log(`view direction ${view.join(',')} (car is +Z forward, +X right)\n`);
console.log('surface        tris     area m2    proj m2   % of proj');
for (const [pi, r] of rows) {
  console.log(`${(NAME[pi] ?? `#${pi}`).padEnd(12)} ${String(r.tris).padStart(5)}  ${r.area.toFixed(4).padStart(9)}  ${r.proj.toFixed(4).padStart(9)}  ${(100 * r.proj / totProj).toFixed(1).padStart(9)}%`);
}
console.log(`${'TOTAL'.padEnd(12)} ${String(tris).padStart(5)}  ${rows.reduce((s, r) => s + r[1].area, 0).toFixed(4).padStart(9)}  ${totProj.toFixed(4).padStart(9)}`);
}

// ---------------------------------------------------------------- winding
/**
 * Are the triangles of a star-shaped part wound OUTWARD?
 *
 * WHY THIS EXISTS, and it is the most expensive thing this round found. The
 * round-1 traffic wheel shipped with 16 of its 24 rim-face triangles wound
 * inboard. The material is FrontSide, so those triangles were CULLED: of the
 * whole spoked rim only the 8-triangle hub fan was ever drawn. Two independent
 * blind reviews then measured the consequences without being able to name the
 * cause - "a hole plus a speck", "the rim is only visible at 6x gain", hubFrac
 * 0.5% against 8-29% in photographs, and a hub specular of 27.9 against 1.6-2.3,
 * because the one surviving fan is a 20-degree cone and a cone always presents
 * some facet at the mirror angle. carbody.js's own comment predicted it: "Getting
 * this backwards inverts the normals in a way that only shows up under a low sun."
 *
 * Nothing in the project could see it. The triangle count was right, the vertex
 * colours were right, the palette was right, and a screenshot of a dark wheel at
 * 34 px looks like a dark wheel. A geometry that is wrong only in its INDEX ORDER
 * is invisible to every metric that reads pixels or counts triangles.
 *
 * The test: for a part that is star-shaped about `centre` - every wheel here is -
 * a correctly wound triangle has (face normal) . (centroid - centre) > 0.
 */
export function windingAudit(g, centre, pick) {
  const pos = g.attributes.position.array, uv = g.attributes.uv.array;
  const idx = g.index.array;
  let out = 0, inward = 0;
  const bad = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    const P = (i) => [pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]];
    const A = P(a), B = P(b), C = P(c);
    const cen = [(A[0] + B[0] + C[0]) / 3, (A[1] + B[1] + C[1]) / 3, (A[2] + B[2] + C[2]) / 3];
    if (!pick(cen, Math.round(uv[a * 2] * PAL_W - 0.5))) continue;
    const e1 = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
    const e2 = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const d = [cen[0] - centre[0], cen[1] - centre[1], cen[2] - centre[2]];
    const dot = n[0] * d[0] + n[1] * d[1] + n[2] * d[2];
    if (dot > 0) out++; else { inward++; bad.push(cen.map((v) => +v.toFixed(3))); }
  }
  return { out, inward, total: out + inward, bad: bad.slice(0, 6) };
}

export function windingSelftest() {
  const fail = [];
  const ok = (nm, c, d) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${nm}${d ? ' — ' + d : ''}`); if (!c) fail.push(nm); };
  // A tetrahedron wound outward, and the same one with every triangle reversed.
  const V = [[1, 1, 1], [1, -1, -1], [-1, 1, -1], [-1, -1, 1]];
  const F = [[0, 2, 1], [0, 3, 2], [0, 1, 3], [1, 2, 3]];
  const mk = (flip) => {
    const P = [], U = [], I = [];
    for (const v of V) { P.push(...v); U.push(0.5 / PAL_W, 0.5); }
    for (const f of F) I.push(...(flip ? [f[0], f[2], f[1]] : f));
    return { index: { array: I }, attributes: { position: { array: P, count: 4 }, uv: { array: U } } };
  };
  const all = () => true;
  const good = windingAudit(mk(false), [0, 0, 0], all);
  const bad = windingAudit(mk(true), [0, 0, 0], all);
  // Whichever way the fixture happens to be wound, the two must be opposites and
  // must be TOTAL/0 and 0/TOTAL - a test that tolerated a mixture would have
  // passed the round-1 wheel, which was 8 out and 16 in.
  ok('an outward-wound closed solid is 100% one way',
    (good.out === 4 && good.inward === 0) || (good.out === 0 && good.inward === 4),
    `${good.out} out / ${good.inward} in`);
  ok('reversing every triangle flips every verdict',
    good.out === bad.inward && good.inward === bad.out, `${bad.out} out / ${bad.inward} in`);
  ok('a MIXED solid is reported as mixed, not passed',
    (() => { const m = mk(false); m.index.array = [...m.index.array];
      // swap two indices of face 0 only, so it is wound against the other three
      const t = m.index.array[1]; m.index.array[1] = m.index.array[2]; m.index.array[2] = t;
      const r = windingAudit(m, [0, 0, 0], all); return r.out > 0 && r.inward > 0; })(),
    'one reversed face out of four must show up');
  console.log(fail.length ? `\nWINDING SELFTEST FAILED: ${fail.join(', ')}` : '\nWINDING SELFTEST OK');
  return fail.length === 0;
}

// ---------------------------------------------------------------------------
// INDEPENDENT REPRODUCTION of round 2's central claim, run from the main tree
// after the merge rather than taken on the builder's word. CLAUDE.md: reproduce
// the number, then test the diagnosis separately.
//
// Whole-car face audit, round 1 (4e5f603) against round 2 (merged), counting a
// triangle as outboard when its winding normal points away from the car centre:
//
//   round 1   outward-facing 392 tris / 11.3484 m²   inboard-facing 102 / 2.0816 m²
//   round 2   outward-facing 520 tris / 11.9166 m²   inboard-facing  38 / 1.4821 m²
//
// inboard 102 -> 38 is EXACTLY -64, which is the 16 culled rim-face triangles per
// wheel across four wheels that the round set out to fix. Reproduced.
//
// It also settles the third-ring question the builder left open. Flipping moves
// 0.5995 m² off the inboard side; the outward side gains only 0.5682 m². If the
// ring's 64 triangles carried real area the outward gain would EXCEED the
// inboard loss, and it does not -- so the ring contributes about zero
// front-facing area, as the builder said.
//
// It is kept anyway, and this is the reasoning rather than an oversight: the
// on-screen wheel numbers that currently pass (front rimTyre ~1.0, hubPeak
// inside the 1.5-2.3 photograph band at all four hours) were all measured WITH
// the ring present. Removing it would trade a measured result for an unmeasured
// saving of 64 tris/car -- 1,920 district-wide, 0.23% of a budget the round is
// already net-negative against. Zero projected area is also not the same as zero
// visual effect at a grazing angle. The place to settle it is a blind review of
// a with/without pair, not an offline area sum.
//
// Note for anyone repeating this: buildWheelGeometry() is the PLAYER car's wheel
// and is byte-identical across the two rounds. The traffic wheel is built inline
// in buildTrafficCarGeometry, so isolating it through that export measures
// nothing and reads as "no change".
