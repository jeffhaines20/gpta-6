// Two layers of cloth on one shopfront: a census of awnings emitted by BOTH kits
// over the same bay.
//
// facades.js `awnings()` and signage.js `awning()` are two independent emitters
// and the contract between them is written in two places:
//
//   facades.js appendBuilding   emits its awnings only on `plainEdges` --
//                               street edges with no entry in the lot plan.
//   signage.js signPlanFor      `(t.lot ? t.lot.awning : aw < 0.48)` -- a
//                               tenancy WITH a lot reads the lot's flag, which
//                               is the same flag the facade kit reads, so the
//                               two cannot disagree. A tenancy with NO lot rolls
//                               its own die.
//
// The second branch is the hole. On a frontage with no lot plan every street
// edge is a plain edge, so the facade kit awns it at p=0.58 per bay AND the sign
// kit awns its tenancies at p=0.48 -- two kits guessing separately, which is
// exactly the failure the comment above `aw` says it is avoiding. It avoids it
// only on LOTTED frontages.
//
// This tool measures the result rather than arguing it: it replays the app's own
// call path (streetDirsFor -> facingEdges -> lotPlanFor -> plainEdges), asks the
// real emitters where their cloth lands, and intersects the spans on the wall.
//
//   node tools/awning-overlap.mjs             census over data/district.json
//   node tools/awning-overlap.mjs --selftest  the metric against known input
//   node tools/awning-overlap.mjs --json out.json
//
// No browser: arithmetic over data/district.json and the real kit helpers, so it
// cannot drift from what the streamer builds.
import fs from 'node:fs';

// signage.js paints its atlases at import; positions never depend on a pixel.
// Same no-op 2D context tools/geom-audit.mjs installs, and for the same reason.
if (typeof document === 'undefined') {
  const grad = { addColorStop() {} };
  const ctx = () => new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      if (k === 'canvas') return { width: 1, height: 1 };
      return (t[k] = (...a) => {
        if (k === 'measureText') return { width: String(a[0] ?? '').length * 8 };
        if (k === 'createLinearGradient' || k === 'createRadialGradient' ||
            k === 'createPattern' || k === 'createConicGradient') return grad;
        if (k === 'getImageData') {
          const w = a[2] | 0 || 1, h = a[3] | 0 || 1;
          return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) };
        }
        return undefined;
      });
    },
    set(t, k, v) { t[k] = v; return true; },
  });
  globalThis.document = {
    createElement: () => ({ width: 0, height: 0, getContext: () => ctx(), toDataURL: () => '' }),
  };
}

import {
  buildingStyle, buffers, edgesOf, facingEdges, awnings, lotPlanFor, appendBuilding,
} from '../src/facades.js';
import { signPlanFor } from '../src/signage.js';
import { streetDirsFor, streetDirFor } from '../src/geom.js';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

// ---------------------------------------------------------------- span census
//
// The facade kit writes every awning on an edge into ONE buffer in a single
// call, because its rng runs across the whole edge list and calling it per edge
// would resequence the dice. So the spans come back out of the vertex buffer by
// projecting onto the edge tangent, not by re-rolling the selection here: a
// second copy of `r() < 0.42` is the thing most likely to drift.
//
// One awning's vertices are contiguous, but we do not need to segment them. What
// the overlap test needs is COVERAGE along the wall, and coverage is a union of
// intervals -- so bucket every fabric vertex by its along-edge coordinate and
// merge. Two awnings 30 mm apart merge into one interval, which is fine: the
// question is "is there cloth here", not "how many pieces".
// A piece is a CONNECTED COMPONENT of the emitted mesh, not a cluster of nearby
// vertices. That distinction is the whole tool. The fabric is a ruled surface
// between two rails, so one 2.7 m awning has vertices at s=6.15 and s=8.85 and
// NOTHING in between -- a density-based merge reads that as two 0.06 m slivers
// and reports 0.49 m of cloth on a wall carrying 5.4 m. It also reports no
// overlap, which is the reassuring shape of wrong answer this repo keeps
// finding. Components cannot merge two separate awnings, because two awnings
// share no vertices, and a component that is only a stay rod contributes a
// narrow interval that the union absorbs.
const WELD = 0.02;   // interval union tolerance, m -- numerical only.

function componentsOf(idx, nVerts) {
  const parent = new Int32Array(nVerts);
  for (let i = 0; i < nVerts; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  const uni = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  for (let i = 0; i + 2 < idx.length; i += 3) { uni(idx[i], idx[i + 1]); uni(idx[i + 1], idx[i + 2]); }
  const groups = new Map();
  for (let i = 0; i < nVerts; i++) {
    const r = find(i);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(i);
  }
  return [...groups.values()];
}

function coverageOf(buf, edge) {
  const n = buf.pos.length / 3;
  const spans = [];
  for (const comp of componentsOf(buf.idx, n)) {
    let sMin = Infinity, sMax = -Infinity, oSum = 0, ok = true;
    for (const v of comp) {
      const dx = buf.pos[v * 3] - edge.a[0], dz = buf.pos[v * 3 + 2] - edge.a[1];
      const s = dx * edge.tx + dz * edge.tz;      // along the wall
      const o = dx * edge.nx + dz * edge.nz;      // off the wall
      if (!Number.isFinite(s) || !Number.isFinite(o)) { ok = false; break; }
      sMin = Math.min(sMin, s); sMax = Math.max(sMax, s); oSum += o;
    }
    if (!ok || sMin === Infinity) continue;
    // Belongs to a different edge of the same ring: the buffer holds every
    // plain edge at once, and a component on the return wall projects to a
    // large negative or far-positive offset here.
    const oMean = oSum / comp.length;
    if (oMean < -0.2 || oMean > 2.2) continue;
    if (sMax < -0.5 || sMin > edge.len + 0.5) continue;
    spans.push([sMin, sMax]);
  }
  if (!spans.length) return [];
  spans.sort((a, b) => a[0] - b[0]);
  const out = [spans[0].slice()];
  for (const [a, b] of spans) {
    const last = out[out.length - 1];
    if (a - last[1] <= WELD) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

function overlapLen(a, b) {
  let total = 0;
  for (const [a0, a1] of a) {
    for (const [b0, b1] of b) {
      total += Math.max(0, Math.min(a1, b1) - Math.max(a0, b0));
    }
  }
  return total;
}

// -------------------------------------------------------------------- selftest
if (has('--selftest')) {
  let bad = 0;
  const say = (ok, what) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}`); };

  // A straight 12 m wall running +x, normal +z.
  const edge = { i: 0, a: [0, 0], tx: 1, tz: 0, nx: 0, nz: 1, len: 12 };

  // A quad from four corner positions, as a real emitter writes one.
  const quad = (s0, s1, o0, o1, buf) => {
    const base = buf.pos.length / 3;
    for (const [s, o] of [[s0, o0], [s1, o0], [s1, o1], [s0, o1]]) {
      buf.pos.push(edge.a[0] + edge.tx * s + edge.nx * o, 3.6,
        edge.a[1] + edge.tz * s + edge.nz * o);
    }
    buf.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  // 1. THE BUG THIS TOOL WAS WRITTEN WITH. A ruled quad has vertices only at
  //    its two rails, 2.7 m apart and nothing between. The first version of
  //    coverageOf bucketed vertices by proximity and read this as two 0.0 m
  //    slivers -- 0.49 m of cloth on a wall carrying 5.4 m, and no overlap
  //    against anything. Connectivity reads the span it actually covers.
  const ruled = { pos: [], idx: [] };
  quad(1, 3.7, 0, 1.35, ruled);
  const cov = coverageOf(ruled, edge);
  say(cov.length === 1 && Math.abs(cov[0][0] - 1) < 1e-6 && Math.abs(cov[0][1] - 3.7) < 1e-6,
    `one ruled quad spans its full 2.70 m: ${JSON.stringify(cov.map((c) => c.map((v) => +v.toFixed(2))))}`);

  // 2. Two awnings 0.30 m apart stay two pieces. They share no vertices, so
  //    nothing can merge them -- but the interior gap of piece 1 (2.46 m) is
  //    eight times larger than the real gap between them, which is why a
  //    density metric cannot tell these two cases apart at any threshold.
  const twoBays = { pos: [], idx: [] };
  quad(0.15, 3.05, 0, 1.35, twoBays);
  quad(3.35, 6.25, 0, 1.35, twoBays);
  const two = coverageOf(twoBays, edge);
  say(two.length === 2, `two awnings 0.30 m apart stay two spans: ${two.length}`);

  // 3. A component on the return wall must not be counted on this edge.
  //    Known-bad input: without the offset window this reads as 2 m of cloth.
  const stray = { pos: [], idx: [] };
  quad(2, 4, -9.5, -9.0, stray);
  say(coverageOf(stray, edge).length === 0, 'a piece 9 m behind the wall is rejected');

  // 4. Interval intersection, which is what the census asserts on.
  say(overlapLen([[0, 3]], [[4, 7]]) === 0, 'disjoint spans overlap 0.0 m');
  say(Math.abs(overlapLen([[0, 3]], [[2, 7]]) - 1) < 1e-9, 'spans [0,3] and [2,7] overlap 1.0 m');
  say(Math.abs(overlapLen([[0, 3], [4, 6]], [[2, 5]]) - 2) < 1e-9,
    'two spans against one overlap 2.0 m in total');

  // 5. The real emitter on a real ring. If the frame is wrong this reads zero,
  //    and zero is the answer that would have shipped quietly.
  const ring = [[0, 0], [12, 0], [12, -10], [0, -10]];
  const es = edgesOf(ring, { minLen: 4, longest: 1 });
  const buf = buffers(); buf.col = null;
  awnings(ring, buf.pos, buf.nrm, buf.uv, buf.idx, { head: 3.6, edges: es, seed: 7 });
  const real = coverageOf(buf, es[0]);
  const covered = real.reduce((t, [x, y]) => t + (y - x), 0);
  // bays = round(12/3.2) = 4 at 3.0 m, kit trims 0.15 m each end -> 2.70 m each.
  say(Math.abs(covered - 5.4) < 0.05 && real.length === 2,
    `real awnings() covers ${covered.toFixed(2)} m in ${real.length} pieces (expect 5.40 in 2)`);

  // 6. And the census's own question, end to end: the same wall, cloth from both
  //    kits over one bay, must report that bay's length and not zero.
  say(Math.abs(overlapLen(real, [[6.5, 8.0]]) - 1.5) < 1e-6,
    'a sign-kit tenancy inside a facade bay reports 1.50 m of double cloth');

  console.log(bad ? `\n${bad} SELFTEST FAILURE(S)` : '\nselftest ok');
  process.exit(bad ? 1 : 0);
}

// ---------------------------------------------------------------------- census
const d = JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url)));

let nBuildings = 0, nOverlapBuildings = 0, nOverlapEdges = 0;
let overlapM = 0, facadeM = 0, signM = 0, buriedM = 0, facTris = 0;
const worst = [];

for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  const style = buildingStyle(b);
  if (!style.storefront) continue;
  const ring = b.p, h = b.h ?? 6;

  // The app's own edge selection. streetDirsFor gives a corner site both of its
  // streets; a single direction is the common case.
  const dirs = streetDirsFor(d, b, 2);
  const faces = 2;
  let streetEdges;
  if (dirs && dirs.length) {
    const seen = new Map();
    for (const dir of dirs) {
      for (const e of facingEdges(ring, dir[0], dir[1], { minLen: 4, max: faces })) {
        if (!seen.has(e.i)) seen.set(e.i, e);
      }
    }
    streetEdges = [...seen.values()].sort((x, y) => y.len - x.len)
      .slice(0, dirs.length > 1 ? faces + 1 : faces);
  } else {
    streetEdges = edgesOf(ring, { minLen: 4, longest: faces });
  }
  if (!streetEdges.length) continue;
  nBuildings++;

  const lotPlan = lotPlanFor(ring, style, h, streetEdges);
  const plainEdges = streetEdges.filter((e) => !lotPlan.has(e.i));

  // Facade cloth, emitted exactly as appendBuilding emits it.
  let facCov = new Map();
  if (style.awnings && plainEdges.length) {
    const buf = buffers(); buf.col = null;
    awnings(ring, buf.pos, buf.nrm, buf.uv, buf.idx, {
      head: style.storefront.head, edges: plainEdges, cell: style.fabric, seed: style.seed,
    });
    for (const e of plainEdges) facCov.set(e.i, coverageOf(buf, e));
    facTris += buf.idx.length / 3;
  }

  // Sign cloth: the plan's own tenancy spans, no emitter needed -- s0/s1 are
  // already along-edge coordinates on the same edge objects.
  const street = streetDirFor(d, b);
  const plan = signPlanFor(b, style, { street, streets: dirs });
  const sigCov = new Map();
  const fasCov = new Map();
  for (const t of plan.tenants) {
    // A tenant either awns or plates its fascia, never both -- signage.js picks
    // one so the NAME stays readable. Facade cloth landing over the fascia
    // branch is not merely a second layer, it is a canopy over a wordmark.
    const m = t.awning ? sigCov : (t.fascia ? fasCov : null);
    if (!m) continue;
    if (!m.has(t.e.i)) m.set(t.e.i, []);
    m.get(t.e.i).push([t.s0, t.s1]);
  }

  let bOverlap = 0;
  for (const [ei, fc] of facCov) {
    facadeM += fc.reduce((t, [a, c]) => t + (c - a), 0);
    const fa = fasCov.get(ei);
    if (fa) buriedM += overlapLen(fc, fa);
    const sc = sigCov.get(ei);
    if (!sc) continue;
    const ov = overlapLen(fc, sc);
    if (ov > 0.25) { nOverlapEdges++; bOverlap += ov; }
  }
  for (const [, sc] of sigCov) signM += sc.reduce((t, [a, c]) => t + (c - a), 0);
  if (bOverlap > 0) {
    nOverlapBuildings++;
    overlapM += bOverlap;
    worst.push({ b: bi, m: +bOverlap.toFixed(2) });
  }
}

worst.sort((a, b) => b.m - a.m);
console.log(`storefront buildings          ${nBuildings}`);
console.log(`facade-kit cloth              ${facadeM.toFixed(1)} m  (${facTris.toLocaleString()} triangles)`);
console.log(`sign-kit cloth                ${signM.toFixed(1)} m`);
console.log(`buildings with DOUBLE cloth   ${nOverlapBuildings}`);
console.log(`edges with double cloth       ${nOverlapEdges}`);
console.log(`fascia buried under cloth     ${buriedM.toFixed(1)} m  (a wordmark under a canopy)`);
console.log(`double-covered wall           ${overlapM.toFixed(1)} m  (${(100 * overlapM / Math.max(1e-9, facadeM)).toFixed(1)}% of facade cloth)`);
const wasted = overlapM + buriedM;
console.log(`redundant cloth               ${wasted.toFixed(1)} m of ${facadeM.toFixed(1)} m ` +
  `(${(100 * wasted / Math.max(1e-9, facadeM)).toFixed(1)}%), ` +
  `${Math.round(facTris * wasted / Math.max(1e-9, facadeM)).toLocaleString()} triangles`);
if (worst.length) {
  console.log(`worst: ${worst.slice(0, 8).map((w) => `#${w.b} ${w.m}m`).join('  ')}`);
}
// ------------------------------------------------------- what the app ships
//
// Everything above prices the COLLISION: what lands on the wall if both kits
// run. Whether the shipped path runs both is a different question, and it is
// answered by the real appendBuilding rather than by the replication above --
// the replication is the thing most able to drift from it.
//
// Built twice on the same building, once opting in and once as the streamer
// calls it. The difference is the facade kit's cloth; the streamer's number
// must be zero.
{
  let sample = null;
  for (let bi = 0; bi < d.buildings.length && !sample; bi++) {
    const b = d.buildings[bi];
    const style = buildingStyle(b);
    if (!style.storefront || !style.awnings) continue;
    const dirs = streetDirsFor(d, b, 2);
    const mk = (opt) => {
      const wall = buffers(), trim = buffers();
      appendBuilding(b.p, b.h ?? 6, buildingStyle(b), wall, trim,
        { street: streetDirFor(d, b), streets: dirs, ...opt });
      return trim.idx.length / 3;
    };
    const optIn = mk({ awnings: true }), shipped = mk({});
    if (optIn === shipped) continue;   // no plain edge on this one; try the next
    sample = { bi, optIn, shipped };
  }
  if (!sample) {
    console.log('\nappendBuilding: no building found where the opt-in changes the mesh');
  } else {
    const delta = sample.optIn - sample.shipped;
    console.log(`\nappendBuilding #${sample.bi}: opt-in ${sample.optIn.toLocaleString()} tris, ` +
      `as the streamer calls it ${sample.shipped.toLocaleString()} (${delta} of cloth withheld)`);
    console.log(delta > 0
      ? 'SHIPPED PATH: facade awnings OFF -- signage.js owns the cloth.'
      : 'SHIPPED PATH: facade awnings ON -- both kits are emitting.');
  }
}

if (has('--json')) {
  fs.writeFileSync(val('--json'), JSON.stringify({
    nBuildings, facadeM, signM, nOverlapBuildings, nOverlapEdges, overlapM, buriedM, facTris, worst,
  }, null, 2));
}
