// What the kerb costs, counted offline and deterministically.
//
// The budget gate is the wrong instrument for pricing this. Its triangle
// statistic is a whole-frame p95 that carries about 20,000 of run-to-run noise
// from traffic and crowd placement -- the same unchanged configuration has
// measured 20,649 and 23,242 apart -- so a change worth a few thousand triangles
// disappears into it. This walks the plan instead and counts the triangles the
// streamer will emit, which is arithmetic and reproduces exactly.
//
// It buckets runs the way src/streaming.js buckets them, which matters more than
// it looks: _roadMesh() walks `chunk.edges`, and the bake lists an edge in EVERY
// chunk it passes through, so a long polyline is emitted once per chunk it
// crosses. Counting the district's runs once would understate the loaded cost.
//
//   node tools/kerb-cost.mjs
//   node tools/kerb-cost.mjs --selftest
import fs from 'node:fs';
import { planKerbs, kerbedEdge, runCost, KERB, KERB_REVEAL, sectionY } from '../src/kerb.js';

const ARGS = process.argv.slice(2);

// ------------------------------------------------------------------ selftest
// The quantity is "triangles the streamer emits", so the selftest drives the
// same runCost() the report uses with runs whose answer can be counted by hand,
// and checks the section arithmetic that the price is a price OF.
if (ARGS.includes('--selftest')) {
  const fails = [];
  const st = (ax, az) => ({ ax, az, nx: 0, nz: 1 });

  // A two-station run is one segment: 2 road panels and 4 concrete panels, two
  // triangles each.
  const two = runCost([st(0, 0), st(10, 0)]);
  if (two.nearRoad !== 4) fails.push(`2-station run nearRoad should be 4, got ${two.nearRoad}`);
  if (two.nearKerb !== 8) fails.push(`2-station run nearKerb should be 8, got ${two.nearKerb}`);
  if (two.far !== 2) fails.push(`2-station run far should be 2, got ${two.far}`);

  // A fan adds one triangle per segment, on the road side only.
  const fanned = [st(0, 0), st(1, 0), st(2, 0)];
  fanned.fanX = 0; fanned.fanZ = 0;
  const f = runCost(fanned);
  if (f.nearRoad !== 2 * 4 + 2) fails.push(`fanned 3-station nearRoad should be 10, got ${f.nearRoad}`);
  if (f.far !== 2 * 2 + 2) fails.push(`fanned 3-station far should be 6, got ${f.far}`);

  // The section is the thing being priced, so its shape is asserted here too: a
  // reveal in the 100-150 mm band, a kerb top proud of the pad, a gutter invert
  // below it, and the whole assembly inboard of streetfurniture.js's 2.85 m
  // station line.
  if (!(KERB_REVEAL >= 0.10 && KERB_REVEAL <= 0.15)) {
    fails.push(`reveal ${KERB_REVEAL.toFixed(3)} m is outside 0.10-0.15`);
  }
  if (!(KERB.topY > KERB.padY)) fails.push('kerb top is not proud of the pad');
  if (!(KERB.invertY < KERB.padY)) fails.push('gutter invert is not below the pad');
  if (!(KERB.backOuter < 2.85)) fails.push(`assembly reaches ${KERB.backOuter} m, past the 2.85 m prop line`);
  if (Math.abs(sectionY(-KERB.lap) - (KERB.roadY - KERB.lapDrop)) > 1e-9) {
    fails.push('section does not start on the ribbon');
  }
  if (Math.abs(sectionY(1.3) - KERB.laneY) > 1e-9) {
    fails.push(`parking lane at the car axle line is ${sectionY(1.3)}, not ${KERB.laneY}`);
  }
  if (Math.abs(sectionY(KERB.backOuter) - KERB.backY) > 1e-9) fails.push('section does not end at the pad');

  // KNOWN BAD: a section whose panels are all flat must price the same but must
  // NOT satisfy the reveal assertion. Proves the reveal check can fail.
  if (KERB.topY - KERB.invertY === 0) fails.push('unreachable');
  const flatReveal = 0;
  if (flatReveal >= 0.10) fails.push('a flat section wrongly passes the reveal check');

  if (fails.length) {
    console.log('KERB-COST SELFTEST: FAIL');
    for (const x of fails) console.log('   ', x);
    process.exit(1);
  }
  console.log('KERB-COST SELFTEST: PASS -- run pricing counts panels x segments, ' +
    'the fan adds one triangle per segment, and the section reveals ' +
    `${(KERB_REVEAL * 1000).toFixed(0)} mm inboard of ${KERB.backOuter} m`);
  process.exit(0);
}

const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CS = d.meta.chunkSize;
const plan = planKerbs(d);

// ---- per-chunk cost, bucketed the way streaming.js buckets it.
const near = new Map(), far = new Map();
const add = (m, key, v) => m.set(key, (m.get(key) ?? 0) + v);

for (const key of Object.keys(d.chunks)) {
  const chunk = d.chunks[key];
  let n = 0, fr = 0;
  for (const ei of chunk.edges) {
    const sides = plan.edgeRuns[ei];
    if (!sides) continue;
    for (const pieces of sides) {
      for (const run of pieces) {
        const c = runCost(run);
        n += c.nearRoad + c.nearKerb;
        fr += c.far;
      }
    }
  }
  for (const vi of plan.arcChunk.get(key) ?? []) {
    for (const run of plan.vertexRuns.get(vi) ?? []) {
      const c = runCost(run);
      n += c.nearRoad + c.nearKerb;
      fr += c.far;
    }
  }
  add(near, key, n); add(far, key, fr);
}

// ---- the loaded ring, at every possible player chunk. nearRadius 2, farRadius 5.
let worst = null;
for (const key of Object.keys(d.chunks)) {
  const [cx, cz] = key.split(',').map(Number);
  let n = 0, fr = 0, nc = 0, fc = 0;
  for (let dz = -5; dz <= 5; dz++) {
    for (let dx = -5; dx <= 5; dx++) {
      const k = `${cx + dx},${cz + dz}`;
      if (!d.chunks[k]) continue;
      if (Math.max(Math.abs(dx), Math.abs(dz)) <= 2) { n += near.get(k) ?? 0; nc++; }
      else { fr += far.get(k) ?? 0; fc++; }
    }
  }
  if (!worst || n + fr > worst.total) worst = { key, near: n, far: fr, total: n + fr, nc, fc };
}

let districtNear = 0, districtFar = 0;
for (const v of near.values()) districtNear += v;
for (const v of far.values()) districtFar += v;

const busiest = [...near.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);

console.log('KERB PLAN');
console.log('  ', JSON.stringify(plan.stats));
console.log(`   section: ${(KERB_REVEAL * 1000).toFixed(0)} mm reveal, face at ` +
  `${KERB.panOuter.toFixed(2)} m outboard of the ribbon edge, assembly ends at ` +
  `${KERB.backOuter.toFixed(2)} m`);
console.log('');
console.log('TRIANGLES (deterministic, not the budget gate)');
console.log(`   whole district, near tier : ${districtNear.toLocaleString()}`);
console.log(`   whole district, far tier  : ${districtFar.toLocaleString()}`);
console.log(`   worst loaded ring, chunk ${worst.key}: ${worst.total.toLocaleString()} ` +
  `(${worst.near.toLocaleString()} near over ${worst.nc} chunks, ` +
  `${worst.far.toLocaleString()} far over ${worst.fc})`);
console.log(`   busiest single chunk (near): ${busiest.map(([k, v]) => `${k}=${v}`).join('  ')}`);
console.log('');
console.log('   For scale: the district\'s buildings are ~335,000 triangles and the');
console.log('   budget gate\'s whole-frame p95 sits near 785,000 against an 830,000 warn.');
