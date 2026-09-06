// What the district costs in triangles, counted rather than sampled.
//
// The budget gate's triangle statistic is a whole-frame p95 taken while traffic
// and a crowd are being re-seeded around a moving camera; two runs of an
// UNCHANGED configuration measured 20,649 apart. That is fine for catching a
// structural regression and useless for pricing a feature that costs a few
// thousand. So this counts the streamer's own geometry offline, from
// data/district.json and the same builder functions streaming.js calls, and
// reports:
//
//   * the whole district, per kind, at each LOD tier;
//   * the worst in-scene total over every chunk the player can stand in, which
//     is the number that actually meets the budget, because the near ring is
//     5x5 chunks and the far ring 11x11 and neither is the whole district.
//
// Deterministic: run it twice, get the same number. That is the whole point.
//
//   node tools/tri-breakdown.mjs [--json] [--selftest]
import fs from 'node:fs';

// facades.js paints atlases on import-of-first-use and this tool reads only
// vertex counts, so a no-op 2D context is a complete substitute (same trick as
// tools/geom-audit.mjs, and for the same reason).
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
import { triangulate } from '../src/geom.js';
import { planKerbs, runCost, kerbedEdge, KERB, KERB_REVEAL, kerbOffsetFor } from '../src/kerb.js';
import { buildingStyle, appendBuilding, buffers } from '../src/facades.js';

const ARGS = process.argv.slice(2);

// ---------------------------------------------------------------- self test
// A price is a measurement, so the instrument has to be able to be wrong.
// These feed runCost and planKerbs inputs whose answer is known by hand and
// fail if the tool agrees with something else.
function selftest() {
  const fails = [];
  const eq = (name, got, want) => {
    if (got !== want) fails.push(`${name}: got ${got}, want ${want}`);
  };
  // A run of N stations is N-1 quad rows; the near section is 4 panels, the far
  // one 1. Counted by hand off src/kerb.js's section.
  eq('runCost near, 2 stations', runCost([0, 0]).near, 8);
  eq('runCost far, 2 stations', runCost([0, 0]).far, 2);
  eq('runCost near, 5 stations', runCost([0, 0, 0, 0, 0]).near, 32);

  // The section must span the datums it claims to. If someone edits KERB and
  // breaks the relationship the whole design rests on, this fails.
  eq('kerb reveal 140 mm', Math.round(KERB_REVEAL * 1000), 140);
  eq('kerb top proud of pad by 5 mm', Math.round((KERB.topY - KERB.padY) * 1000), 5);
  eq('approach meets the ribbon', KERB.roadY, 0.02);
  eq('kerb face offset for a 7 m street',
    Math.round(kerbOffsetFor(7) * 1000), Math.round((3.5 + 1.95 + 0.65) * 1000));
  // The approach must put the parked-car axle line on the parked-car datum, or
  // 30 cars per near ring float or sink.
  const t = KERB.parkOffset / KERB.laneW;
  const yAtAxle = KERB.roadY + (KERB.lipY - KERB.roadY) * t;
  eq('approach y at the parked-car axle line', Math.round(yAtAxle * 1000),
    Math.round(KERB.parkY * 1000));

  // A graph with one straight two-segment street: two sides, no junctions with
  // anything, so 2 runs of 3 stations = 2 x 2 x 8 = 32 near triangles. A
  // hardcoded 4-vertex assumption or a dropped side gives a different number.
  const toy = {
    meta: { chunkSize: 128 },
    verts: [{ x: 0, z: 0 }, { x: 40, z: 0 }, { x: 80, z: 0 }],
    edges: [{ v: [0, 1, 2], w: 7, lanes: 2, o: 0, c: 'primary', r: 2 }],
    chunks: {}, buildings: [], zones: [],
  };
  const plan = planKerbs(toy);
  let tris = 0, runs = 0;
  for (const sides of plan.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) for (const r of pieces) { tris += runCost(r).near; runs++; }
  }
  eq('toy straight street: runs', runs, 2);
  eq('toy straight street: near triangles', tris, 32);

  // KNOWN-BAD input: the same street with a service alley crossing it must
  // BREAK the kerb, so the count must NOT be 32 any more. A crossing test that
  // silently does nothing would leave it at 32 and this catches that.
  const crossed = {
    ...toy,
    verts: [...toy.verts, { x: 40, z: -20 }, { x: 40, z: 20 }],
    edges: [toy.edges[0], { v: [3, 4], w: 2.8, lanes: 1, o: 0, c: 'service', r: 8 }],
  };
  const plan2 = planKerbs(crossed);
  let runs2 = 0;
  for (const sides of plan2.edgeRuns) {
    if (!sides) continue;
    for (const pieces of sides) runs2 += pieces.length;
  }
  if (runs2 <= 2) fails.push(`crossing alley did not break the kerb: ${runs2} runs, want > 2`);

  // KNOWN-BAD input: a service road must carry no kerb at all.
  if (kerbedEdge({ r: 8, w: 2.8 })) fails.push('service road claimed a kerb');
  if (!kerbedEdge({ r: 2, w: 7 })) fails.push('primary street refused a kerb');

  if (fails.length) {
    console.log('TRI-BREAKDOWN SELFTEST: FAIL');
    for (const f of fails) console.log('   ', f);
    process.exit(1);
  }
  console.log(`TRI-BREAKDOWN SELFTEST: PASS — ${8} checks`);
  process.exit(0);
}
if (ARGS.includes('--selftest')) selftest();

// ---------------------------------------------------------------- the count
const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CH = d.meta.chunkSize;
const plan = planKerbs(d);

// streaming.js _capStyle, replayed so the count is of the world that is drawn.
function capStyle(style, b) {
  let per = 0;
  for (let i = 0; i < b.p.length; i++) {
    const a = b.p[i], c = b.p[(i + 1) % b.p.length];
    per += Math.hypot(c[0] - a[0], c[1] - a[1]);
  }
  const cost = style.floors * per;
  if (cost > 1400) { style.balconies = false; style.fireEscape = false; }
  if (cost > 1800) style.roofUnits = Math.min(style.roofUnits, 3);
  return style;
}
const keyOf = (x, z) => `${Math.floor(x / CH)},${Math.floor(z / CH)}`;
function streetDirFor(b) {
  let cx = 0, cz = 0;
  for (const [x, z] of b.p) { cx += x; cz += z; }
  cx /= b.p.length; cz /= b.p.length;
  const chunk = d.chunks[keyOf(cx, cz)];
  if (!chunk || !chunk.edges.length) return null;
  let best = null, bestD = Infinity;
  for (const ei of chunk.edges) for (const vi of d.edges[ei].v) {
    const v = d.verts[vi];
    const dd = (v.x - cx) ** 2 + (v.z - cz) ** 2;
    if (dd < bestD) { bestD = dd; best = v; }
  }
  if (!best) return null;
  const len = Math.hypot(best.x - cx, best.z - cz) || 1;
  return [(best.x - cx) / len, (best.z - cz) / len];
}

// ---- per chunk, per kind
const per = new Map();
const blank = () => ({ buildNear: 0, buildFar: 0, road: 0, kerbNear: 0, kerbFar: 0, zone: 0 });
for (const key of Object.keys(d.chunks)) per.set(key, blank());

for (const [key, chunk] of Object.entries(d.chunks)) {
  const c = per.get(key);
  for (const bi of chunk.buildings) {
    const b = d.buildings[bi];
    const style = capStyle(buildingStyle(b), b);
    const buf = buffers();
    appendBuilding(b.p, b.h, style, buf, buf, { street: streetDirFor(b) });
    c.buildNear += buf.idx.length / 3;
    c.buildFar += 10;                    // a 4-point box: 4 walls + a 2-tri roof
  }
  for (const ei of chunk.edges) {
    const e = d.edges[ei];
    c.road += (e.v.length - 1) * 2;      // ribbon: one quad per segment
    const sides = plan.edgeRuns[ei];
    if (!sides) continue;
    for (const pieces of sides) for (const r of pieces) {
      c.kerbNear += runCost(r).near;
      c.kerbFar += runCost(r).far;
    }
  }
  for (const vi of plan.arcChunk.get(key) ?? []) {
    for (const r of plan.vertexRuns.get(vi) ?? []) {
      c.kerbNear += runCost(r).near;
      c.kerbFar += runCost(r).far;
    }
  }
  for (const zi of chunk.zones ?? []) {
    const z = d.zones[zi];
    if (!['parking', 'grass', 'park', 'garden', 'playground', 'recreation_ground',
      'marina', 'construction'].includes(z.z)) continue;
    c.zone += triangulate(z.p).length / 3;
  }
}

const sum = (f) => [...per.values()].reduce((a, c) => a + f(c), 0);
const district = {
  chunks: per.size,
  buildingsNear: sum((c) => c.buildNear),
  buildingsFar: sum((c) => c.buildFar),
  roadRibbons: sum((c) => c.road),
  kerbNear: sum((c) => c.kerbNear),
  kerbFar: sum((c) => c.kerbFar),
  zones: sum((c) => c.zone),
};

// ---- worst in-scene total. LOD is Chebyshev distance in chunks from the chunk
// the player stands in: <= nearRadius NEAR, <= farRadius FAR (streaming.js
// desiredLod). So the scene never holds the whole district, and the kerb is
// bounded twice over: by the near ring, and by having no concrete outside it.
const NEAR_R = 2, FAR_R = 5;
let worst = null;
for (const key of per.keys()) {
  const [pcx, pcz] = key.split(',').map(Number);
  const t = { key, near: 0, far: 0, kerbNear: 0, kerbFar: 0, total: 0, nearChunks: 0, farChunks: 0 };
  for (let dz = -FAR_R; dz <= FAR_R; dz++) {
    for (let dx = -FAR_R; dx <= FAR_R; dx++) {
      const k = `${pcx + dx},${pcz + dz}`;
      const c = per.get(k);
      if (!c) continue;
      const cheb = Math.max(Math.abs(dx), Math.abs(dz));
      if (cheb <= NEAR_R) {
        t.nearChunks++;
        t.near += c.buildNear + c.road + c.zone;
        t.kerbNear += c.kerbNear;
      } else {
        t.farChunks++;
        t.far += c.buildFar + c.road + c.zone;
        t.kerbFar += c.kerbFar;
      }
    }
  }
  t.total = t.near + t.far + t.kerbNear + t.kerbFar;
  if (!worst || t.total > worst.total) worst = t;
}

const out = { district, worstInScene: worst, kerbPlan: plan.stats };
if (ARGS.includes('--json')) {
  console.log(JSON.stringify(out, null, 1));
} else {
  const n = (v) => String(Math.round(v)).padStart(9);
  console.log('TRI-BREAKDOWN  (deterministic, offline, from data/district.json)\n');
  console.log('  whole district');
  console.log(`    buildings NEAR   ${n(district.buildingsNear)}`);
  console.log(`    buildings FAR    ${n(district.buildingsFar)}`);
  console.log(`    road ribbons     ${n(district.roadRibbons)}`);
  console.log(`    zone polygons    ${n(district.zones)}`);
  console.log(`    KERB near tier   ${n(district.kerbNear)}   (approach + pan + face + top)`);
  console.log(`    KERB far tier    ${n(district.kerbFar)}   (flat apron only)`);
  console.log(`    chunks           ${n(district.chunks)}`);
  console.log('\n  worst chunk the player can stand in ' +
    `(near ${worst.nearChunks} chunks, far ${worst.farChunks}), key ${worst.key}`);
  console.log(`    near tier        ${n(worst.near)}`);
  console.log(`    far tier         ${n(worst.far)}`);
  console.log(`    KERB near        ${n(worst.kerbNear)}`);
  console.log(`    KERB far         ${n(worst.kerbFar)}`);
  console.log(`    total            ${n(worst.total)}`);
  console.log(`    kerb share       ${((100 * (worst.kerbNear + worst.kerbFar)) / worst.total).toFixed(2)}%`);
  console.log('\n  kerb plan  ' + JSON.stringify(plan.stats));
}
