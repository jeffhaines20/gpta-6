// Frontage statistics and the triangle bill for the facade kit.
//
// The complaint this answers was measured, not felt: 380 m of Main Street east
// is seven footprints, two of them 181 m and 106 m of continuous frontage at one
// height, one recipe and one colour, where the photographs show 6-8 m shopfronts
// each with its own fascia, parapet step, colour and sign.
//
// So this tool measures the two things that argument turns on:
//
//   1. FRONTAGE. How long is an uninterrupted run of one wall treatment on a
//      named band of street? Before the lot pass that is the footprint edge
//      itself; after it, it is the lot. A footprint is a property boundary and
//      cannot be changed without a re-bake (data/district.json is authoritative);
//      a LOT is an appearance unit inside one footprint, and it is what a row of
//      shops actually is.
//
//   2. TRIANGLES. Every lot boundary buys a party pier, a parapet step and a
//      second set of ground-floor courses, so the kit has to be priced before it
//      ships. The budget gate measures a p95 over a drive, and only NEAR chunks
//      carry the facade kit at all, so the number that matters is not the
//      district total but the worst 5x5 chunk window ON THE ROUTE - which is what
//      the streamer holds resident. Both are printed.
//
//   node tools/frontage-stats.mjs
//   node tools/frontage-stats.mjs --band 40,440,-215,-115 --json docs/frontage.json
//
// No browser: this is arithmetic over data/district.json and the real kit
// helpers, so it is as cheap as geom-audit and cannot drift from what the
// streamer builds.
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
if (typeof performance === 'undefined') globalThis.performance = { now: () => Date.now() };

const FAC = await import('../src/facades.js');
const {
  buildingStyle, buffers, appendBuilding, edgesOf, facingEdges,
} = FAC;

const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};
const BAND = (arg('band', '40,440,-215,-115')).split(',').map(Number);
const [BX0, BX1, BZ0, BZ1] = BAND;

const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const CHUNK = d.meta.chunkSize;
const keyOf = (x, z) => `${Math.floor(x / CHUNK)},${Math.floor(z / CHUNK)}`;

// streaming.js _streetDirFor, replayed. A tool that guessed the frontage would
// measure a different building from the one on screen.
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
// streaming.js _capStyle, replayed for the same reason.
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

const touchesBand = (b) => {
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const [x, z] of b.p) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  return x1 >= BX0 && x0 <= BX1 && z1 >= BZ0 && z0 <= BZ1;
};

const q = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(p * a.length))] : 0);
const stats = (a) => {
  if (!a.length) return { n: 0 };
  const s = a.slice().sort((x, y) => x - y);
  return {
    n: s.length,
    min: +s[0].toFixed(1), p25: +q(s, 0.25).toFixed(1), med: +q(s, 0.5).toFixed(1),
    p75: +q(s, 0.75).toFixed(1), max: +s[s.length - 1].toFixed(1),
    mean: +(s.reduce((x, y) => x + y, 0) / s.length).toFixed(1),
  };
};
const hex = (t) => t.map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255)
  .toString(16).padStart(2, '0')).join('');

// ------------------------------------------------------------------ frontage
const band = { footprints: [], runs: [], lots: [] };
for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  if (!touchesBand(b)) continue;
  const style = capStyle(buildingStyle(b), b);
  const street = streetDirFor(b);
  const streetEdges = street
    ? facingEdges(b.p, street[0], street[1], { minLen: 4, max: 2 })
    : edgesOf(b.p, { minLen: 4, longest: 2 });
  // The lot plan the kit itself will build, asked for by the same call
  // appendBuilding makes. Before the lot pass this export does not exist and the
  // run IS the edge, which is exactly the measurement being compared.
  const plan = FAC.lotPlanFor
    ? FAC.lotPlanFor(b.p, style, b.h ?? 6, streetEdges)
    : null;
  const rec = [];
  for (const e of streetEdges) {
    const lots = plan?.get(e.i)?.lots;
    if (lots && lots.length) {
      for (const L of lots) {
        band.runs.push(L.len);
        band.lots.push({
          b: bi, len: +L.len.toFixed(1), tint: hex(L.tint),
          parapet: +L.parapetH.toFixed(2), head: L.head ? +L.head.toFixed(2) : null,
          door: !!L.doorSpan, awning: !!L.awning,
        });
      }
      rec.push({ len: +e.len.toFixed(1), lots: lots.length });
    } else {
      band.runs.push(e.len);
      band.lots.push({
        b: bi, len: +e.len.toFixed(1), tint: hex(style.tint),
        parapet: +(style.parapet?.height ?? 0).toFixed(2),
        head: style.storefront ? +style.storefront.head.toFixed(2) : null,
        door: !!style.entrance, awning: !!style.awnings,
      });
      rec.push({ len: +e.len.toFixed(1), lots: 1 });
    }
  }
  band.footprints.push({ i: bi, recipe: style.recipe, h: b.h, edges: rec });
}

const distinct = (f) => new Set(band.lots.map(f)).size;
console.log(`FRONTAGE  band x ${BX0}..${BX1}  z ${BZ0}..${BZ1}`);
console.log(`  footprints touching the band : ${band.footprints.length}`);
console.log(`  street-facing frontage runs  : ${band.runs.length}` +
  `   total ${band.runs.reduce((a, b2) => a + b2, 0).toFixed(0)} m`);
console.log(`  run width (m)                : ${JSON.stringify(stats(band.runs))}`);
console.log(`  runs over 20 m               : ${band.runs.filter((v) => v > 20).length}` +
  `   over 40 m: ${band.runs.filter((v) => v > 40).length}`);
console.log(`  distinct wall colours        : ${distinct((L) => L.tint)}`);
console.log(`  distinct parapet heights     : ${distinct((L) => L.parapet)}`);
console.log(`  distinct shopfront heads     : ${distinct((L) => L.head)}`);
console.log(`  runs with a street door      : ${band.lots.filter((L) => L.door).length}` +
  ` of ${band.lots.length}`);
console.log('  per footprint:');
for (const f of band.footprints.sort((a, b2) => b2.edges[0]?.len - a.edges[0]?.len)) {
  console.log(`    #${String(f.i).padStart(3)}  ${f.recipe.padEnd(11)} h ${String(f.h).padStart(5)}  ` +
    f.edges.map((e) => `${e.len} m -> ${e.lots} lot${e.lots === 1 ? '' : 's'}`).join(', '));
}

// ----------------------------------------------------------------- triangles
// Every building through the real appendBuilding, bucketed by chunk exactly as
// the streamer buckets them, so a per-chunk total is the geometry a resident
// NEAR chunk actually holds.
const perChunk = new Map();
let facTri = 0, trimTri = 0;
const t0 = Date.now();
for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  const style = capStyle(buildingStyle(b), b);
  const wall = buffers(), trim = buffers();
  appendBuilding(b.p, b.h, style, wall, trim, { street: streetDirFor(b) });
  const tri = (wall.idx.length + trim.idx.length) / 3;
  facTri += wall.idx.length / 3; trimTri += trim.idx.length / 3;
  let cx = 0, cz = 0;
  for (const [x, z] of b.p) { cx += x; cz += z; }
  const key = keyOf(cx / b.p.length, cz / b.p.length);
  perChunk.set(key, (perChunk.get(key) ?? 0) + tri);
}
const buildMs = Date.now() - t0;

// The streamer keeps a 5x5 block of NEAR chunks around the player (nearRadius 2).
// Sample the drive route densely and take the worst and the p95 window: that is
// the quantity tools/budget.mjs sees, minus everything that is not a building.
const route = d.meta.route;
const windows = [];
for (let i = 0; i + 1 < route.length; i++) {
  const a = route[i], b = route[i + 1];
  const seg = Math.hypot(b.x - a.x, b.z - a.z);
  const steps = Math.max(2, Math.ceil(seg / 8));
  for (let s = 0; s <= steps; s++) {
    const x = a.x + (b.x - a.x) * (s / steps), z = a.z + (b.z - a.z) * (s / steps);
    const [cx, cz] = keyOf(x, z).split(',').map(Number);
    let sum = 0;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      sum += perChunk.get(`${cx + dx},${cz + dz}`) ?? 0;
    }
    windows.push(sum);
  }
}
windows.sort((a, b) => a - b);
const p95 = windows[Math.floor(windows.length * 0.95)];

// The corridor hero camera, which is where this round is judged.
const heroWin = (() => {
  const [cx, cz] = keyOf(112.4, -163.8).split(',').map(Number);
  let sum = 0;
  for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
    sum += perChunk.get(`${cx + dx},${cz + dz}`) ?? 0;
  }
  return sum;
})();

console.log('\nTRIANGLES (buildings only; roads, furniture, traffic and signage excluded)');
console.log(`  district total               : ${(facTri + trimTri).toFixed(0)}` +
  `   (facade ${facTri.toFixed(0)}, trim ${trimTri.toFixed(0)})`);
console.log(`  build time for all 523        : ${buildMs} ms`);
console.log(`  worst 5x5 NEAR window on route: ${windows[windows.length - 1].toFixed(0)}`);
console.log(`  p95 5x5 NEAR window on route  : ${p95.toFixed(0)}`);
console.log(`  5x5 NEAR window at the hero   : ${heroWin.toFixed(0)}`);

// Shop signage rides the same lot plan, so it is priced here too.
let sig = null;
try {
  const SIG = await import('../src/signage.js');
  const r = SIG.districtSignageBuffers(d, {
    styleOf: (b) => capStyle(buildingStyle(b), b),
    streetDirFor,
  });
  sig = r.stats;
  console.log(`  signage: ${sig.tenancies} tenancies on ${sig.signedBuildings} buildings, ` +
    `${sig.shopTriangles} shop + ${sig.streetTriangles} street triangles`);
} catch (e) { console.log('  signage: not measured -', e.message); }

const out = arg('json', null);
if (out) {
  fs.writeFileSync(out, JSON.stringify({
    band: BAND, footprints: band.footprints, lots: band.lots,
    runStats: stats(band.runs),
    distinct: { tint: distinct((L) => L.tint), parapet: distinct((L) => L.parapet), head: distinct((L) => L.head) },
    triangles: {
      district: facTri + trimTri, facade: facTri, trim: trimTri,
      worstWindow: windows[windows.length - 1], p95Window: p95, heroWindow: heroWin,
    },
    signage: sig,
  }, null, 1));
  console.log(`\nwrote ${out}`);
}
