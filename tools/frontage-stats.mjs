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
import { streetDirFor as geomStreetDirFor, streetDirsFor as geomStreetDirsFor } from '../src/geom.js';

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
// Imported here rather than lazily inside the triangle section, because
// --selftest asserts facades and signage agree and needs both.
const SIGN = await import('../src/signage.js');
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
// The frontage answer, imported from src/geom.js rather than replayed here. It
// used to be a hand-copy of streaming.js's nearest-road-VERTEX search, and when
// that turned out to be backwards on 99 buildings the copy in each tool would
// have gone on measuring a world nobody renders.
const streetDirFor = (b) => geomStreetDirFor(d, b);
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

// The street elevations appendBuilding builds on, replayed EXACTLY: the union
// over every street direction, each direction contributing at most `faces`
// edges, the union capped one above that for a corner site.
//
// This used to be `facingEdges(primary, max 2)` - the cone around the PRIMARY
// direction alone - which is not what the kit does and has not been since
// streetDirsFor arrived. On building #76 the two selections differ outright:
// the primary-only answer is edges 0 and 4 (79.9 m and 27.0 m) while the engine
// builds 0, 2 and 4 (79.9 + 78.4 + 27.0), so the tool was reporting 106.9 m of a
// 185.3 m frontage and calling it the building. Same class of fault as the
// hand-copied streetDirFor that measured a world nobody renders; the rule in
// this repo is that a measurement replays the engine's own call or it is not a
// measurement.
export function streetEdgesOf(district, b, faces = 2) {
  const dirs = geomStreetDirsFor(district, b, 2);
  if (!dirs.length) return edgesOf(b.p, { minLen: 4, longest: faces });
  const seen = new Map();
  for (const dir of dirs) {
    for (const e of facingEdges(b.p, dir[0], dir[1], { minLen: 4, max: faces })) {
      if (!seen.has(e.i)) seen.set(e.i, e);
    }
  }
  return [...seen.values()].sort((a, b2) => b2.len - a.len)
    .slice(0, dirs.length > 1 ? faces + 1 : faces);
}

// --------------------------------------------------------------------- selftest
//
//   node tools/frontage-stats.mjs --selftest
//
// Three assertions, each of which FAILS on a specific known-bad input this file
// has actually shipped or nearly shipped:
//
//   1. A corner site's street selection must contain BOTH perpendicular
//      elevations. The primary-only selection this tool used until today returns
//      one of them, and the check below is run against that exact wrong answer
//      so the test proves it can tell them apart. Without this, a tool measuring
//      106.9 m of a 185.3 m frontage looks like a tool measuring a frontage.
//   2. A lot plan must TILE its edge: the run widths sum to the edge length and
//      the first and last lot land on the corners. lotCuts clamps every interior
//      boundary twice and an off-by-one there leaves a sliver or a gap, which is
//      a wall with a hole in it and run statistics that are quietly wrong.
//   3. A ground-only subdivision must leave ONE wall colour, ONE parapet and ONE
//      head on the elevation. That is the entire difference between it and a
//      property subdivision, and a plan that got it wrong would still look like
//      a lot plan to every count in this file.
function selftest() {
  let fails = 0;
  const ok = (name, cond, detail) => {
    console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
    if (!cond) fails++;
  };

  // 1. Corner selection. A square footprint handed two perpendicular street
  //    directions, the shape streetDirsFor returns for a corner site.
  const sq = [[0, 0], [40, 0], [40, 40], [0, 40]];
  const dirs = [[0, -1], [1, 0]];
  const union = (faces = 2) => {
    const seen = new Map();
    for (const dir of dirs) {
      for (const e of facingEdges(sq, dir[0], dir[1], { minLen: 4, max: faces })) {
        if (!seen.has(e.i)) seen.set(e.i, e);
      }
    }
    return [...seen.values()].sort((a, b) => b.len - a.len).slice(0, faces + 1);
  };
  const both = union();
  const primaryOnly = facingEdges(sq, dirs[0][0], dirs[0][1], { minLen: 4, max: 2 });
  const hasBoth = (es) => es.some((e) => Math.abs(e.nz + 1) < 0.01) &&
                          es.some((e) => Math.abs(e.nx - 1) < 0.01);
  const normals = (es) => es.map((e) => `(${e.nx.toFixed(0)},${e.nz.toFixed(0)})`).join(' ');
  ok('corner union carries both street elevations', hasBoth(both), normals(both));
  ok('and the primary-only answer does NOT (the bug this replaces)',
    !hasBoth(primaryOnly), normals(primaryOnly));

  // 2 and 3, over the real district: every lot plan the kit will build.
  let tiled = 0, badTile = null, groundEdges = 0, badGround = null, lotEdges = 0;
  for (let bi = 0; bi < d.buildings.length; bi++) {
    const b = d.buildings[bi];
    const style = capStyle(buildingStyle(b), b);
    const plan = FAC.lotPlanFor(b.p, style, b.h ?? 6, streetEdgesOf(d, b));
    for (const [, lp] of plan) {
      const last = lp.lots[lp.lots.length - 1];
      const sum = lp.lots.reduce((a, L) => a + L.len, 0);
      if (Math.abs(sum - lp.e.len) > 1e-6) {
        badTile = badTile ?? `#${bi} edge ${lp.e.i}: lots sum ${sum.toFixed(4)} vs edge ${lp.e.len.toFixed(4)}`;
      }
      if (Math.abs(lp.lots[0].s0) > 1e-9 || Math.abs(last.s1 - lp.e.len) > 1e-6) {
        badTile = badTile ?? `#${bi} edge ${lp.e.i}: covers ${lp.lots[0].s0.toFixed(4)}..${last.s1.toFixed(4)}`;
      }
      tiled++;
      if (lp.ground) {
        groundEdges++;
        const tints = new Set(lp.lots.map((L) => L.tint.join(',')));
        const pars = new Set(lp.lots.map((L) => L.parapetH.toFixed(4)));
        const heads = new Set(lp.lots.map((L) => (L.head ?? 0).toFixed(4)));
        if (tints.size !== 1 || pars.size !== 1 || heads.size !== 1) {
          badGround = badGround ??
            `#${bi} edge ${lp.e.i}: ${tints.size} colours, ${pars.size} parapets, ${heads.size} heads`;
        }
      } else lotEdges++;
    }
  }
  ok(`every lot plan tiles its edge (${tiled} planned edges)`, !badTile, badTile ?? '');

  // 4. THE TWO EDGE SELECTIONS AGREE. facades.js appendBuilding and signage.js
  //    signPlanFor each carry their own copy of the union-over-street-directions
  //    rule and neither imports the other. Last time one moved and the other did
  //    not, the Five Points corner building came out with shopfront bays and no
  //    awning over them, and it took two blind reviewers to find it. This asks
  //    signPlanFor for the edges it actually used - it returns them - and
  //    compares against the set appendBuilding builds on, over every shopfront
  //    building in the district.
  let checked = 0, badPair = null;
  for (let bi = 0; bi < d.buildings.length && !badPair; bi++) {
    const b = d.buildings[bi];
    const style = capStyle(buildingStyle(b), b);
    if (!style.storefront) continue;
    const built = streetEdgesOf(d, b).map((e) => e.i).sort((x, y) => x - y);
    const signed = SIGN.signPlanFor(b, style,
      { street: streetDirFor(b), streets: geomStreetDirsFor(d, b, 2) })
      .edges.map((e) => e.i).sort((x, y) => x - y);
    if (built.join(',') !== signed.join(',')) {
      badPair = `#${bi} ${style.recipe}: facades builds [${built}], signage signs [${signed}]`;
    }
    checked++;
  }
  ok(`facades and signage select the same elevations (${checked} shopfront buildings)`,
    !badPair, badPair ?? '');
  ok(`ground-only edges keep one colour, one parapet, one head (${groundEdges} of them)`,
    !badGround, badGround ?? `${lotEdges} property-lotted edges also present`);
  // A ground subdivision that never happens cannot fail assertion 3, so say so
  // rather than letting a green line stand for a check that never ran.
  if (!groundEdges) console.log('  NOTE  no ground-only subdivision in this build; assertion 3 is vacuous');
  console.log(fails ? `\nSELFTEST FAILED (${fails})` : '\nSELFTEST OK');
  return fails;
}
if (process.argv.includes('--selftest')) process.exit(selftest() ? 1 : 0);

// ------------------------------------------------------------------ frontage
const band = { footprints: [], runs: [], lots: [] };
for (let bi = 0; bi < d.buildings.length; bi++) {
  const b = d.buildings[bi];
  if (!touchesBand(b)) continue;
  const style = capStyle(buildingStyle(b), b);
  const streetEdges = streetEdgesOf(d, b);
  // The lot plan the kit itself will build, asked for by the same call
  // appendBuilding makes. Before the lot pass this export does not exist and the
  // run IS the edge, which is exactly the measurement being compared.
  const plan = FAC.lotPlanFor
    ? FAC.lotPlanFor(b.p, style, b.h ?? 6, streetEdges)
    : null;
  const rec = [];
  for (const e of streetEdges) {
    const lp = plan?.get(e.i);
    const lots = lp?.lots;
    // A PROPERTY lot and a GROUND tenancy are both runs of frontage and are not
    // the same claim. A property lot changes the wall colour, the parapet and
    // the window phase for the full height; a ground tenancy changes only what
    // happens under the fascia, and the tower above it stays one wall. Counting
    // them together would let a change that only subdivides ground floors read
    // as if it had subdivided buildings.
    const kind = lots && lots.length ? (lp.ground ? 'ground' : 'lot') : 'whole';
    if (lots && lots.length) {
      for (const L of lots) {
        band.runs.push(L.len);
        band.lots.push({
          b: bi, len: +L.len.toFixed(1), tint: hex(L.tint), kind,
          parapet: +L.parapetH.toFixed(2), head: L.head ? +L.head.toFixed(2) : null,
          door: !!L.doorSpan, awning: !!L.awning,
        });
      }
      rec.push({ len: +e.len.toFixed(1), lots: lots.length, kind });
    } else {
      band.runs.push(e.len);
      band.lots.push({
        b: bi, len: +e.len.toFixed(1), tint: hex(style.tint), kind,
        parapet: +(style.parapet?.height ?? 0).toFixed(2),
        head: style.storefront ? +style.storefront.head.toFixed(2) : null,
        door: !!style.entrance, awning: !!style.awnings,
      });
      rec.push({ len: +e.len.toFixed(1), lots: 1, kind });
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
console.log(`  runs with an awning          : ${band.lots.filter((L) => L.awning).length}` +
  ` of ${band.lots.length}`);
console.log(`  runs by kind                 : ` +
  `${band.lots.filter((L) => L.kind === 'lot').length} property lot, ` +
  `${band.lots.filter((L) => L.kind === 'ground').length} ground tenancy, ` +
  `${band.lots.filter((L) => L.kind === 'whole').length} whole edge`);
console.log('  per footprint:');
for (const f of band.footprints.sort((a, b2) => b2.edges[0]?.len - a.edges[0]?.len)) {
  console.log(`    #${String(f.i).padStart(3)}  ${f.recipe.padEnd(11)} h ${String(f.h).padStart(5)}  ` +
    f.edges.map((e) => `${e.len} m -> ${e.lots} ${e.kind === 'ground' ? 'tenanc' + (e.lots === 1 ? 'y' : 'ies') : 'lot' + (e.lots === 1 ? '' : 's')}`).join(', '));
}

// -------------------------------------------------------------------- census
//
//   node tools/frontage-stats.mjs --census
//
// The band above is the hero corridor. This is the whole district, and it exists
// because "how many buildings does this affect" is a different question from
// "how does the hero block look". Every street elevation the kit builds on,
// classified by what subdivides it, plus the population of frontages that
// nothing subdivides at all and the reason each one is in that population.
if (process.argv.includes('--census')) {
  const per = new Map();
  const blocked = [];
  let streetM = 0, lotM = 0, groundM = 0, wholeM = 0;
  for (let bi = 0; bi < d.buildings.length; bi++) {
    const b = d.buildings[bi];
    const style = capStyle(buildingStyle(b), b);
    const ses = streetEdgesOf(d, b);
    const plan = FAC.lotPlanFor(b.p, style, b.h ?? 6, ses);
    const row = per.get(style.recipe) ??
      { n: 0, shop: 0, lot: 0, ground: 0, lotM: 0, groundM: 0, wholeM: 0 };
    row.n++; if (style.storefront) row.shop++;
    let kinds = new Set();
    for (const e of ses) {
      streetM += e.len;
      const lp = plan.get(e.i);
      if (lp && lp.lots.length > 1) {
        if (lp.ground) { groundM += e.len; row.groundM += e.len; kinds.add('ground'); }
        else { lotM += e.len; row.lotM += e.len; kinds.add('lot'); }
      } else { wholeM += e.len; row.wholeM += e.len; }
    }
    if (kinds.has('lot')) row.lot++;
    if (kinds.has('ground')) row.ground++;
    per.set(style.recipe, row);
    // The population the gate holds back: enough street frontage to hold more
    // than one tenancy, and nothing subdividing any of it.
    const total = ses.reduce((a, e) => a + e.len, 0);
    if (!kinds.size && ses.some((e) => e.len >= FAC.LOT.minEdge)) {
      blocked.push({
        i: bi, recipe: style.recipe, h: b.h, z: b.z ?? '', k: b.k ?? '',
        shop: !!style.storefront, lotM: style.rec.lotM ?? null,
        groundM: style.rec.groundM ?? null,
        why: style.rec.lotM ? ((b.h ?? 6) > 22 ? 'h>22' : 'edges<13m') : 'no lotM',
        edges: ses.map((e) => +e.len.toFixed(1)), sum: +total.toFixed(1),
      });
    }
  }
  const pc = (v) => `${(100 * v / streetM).toFixed(1)}%`;
  console.log('\nCENSUS  every street elevation the kit builds on, district-wide');
  console.log(`  street frontage total        : ${streetM.toFixed(0)} m`);
  console.log(`    subdivided into properties : ${lotM.toFixed(0)} m  ${pc(lotM)}`);
  console.log(`    ground floor tenanted only : ${groundM.toFixed(0)} m  ${pc(groundM)}`);
  console.log(`    one wall end to end        : ${wholeM.toFixed(0)} m  ${pc(wholeM)}`);
  console.log('  per recipe (buildings):');
  for (const [k, v] of [...per].sort((a, b2) => b2[1].n - a[1].n)) {
    console.log(`    ${k.padEnd(12)} n ${String(v.n).padStart(3)}  shopfront ${String(v.shop).padStart(3)}  ` +
      `property-lotted ${String(v.lot).padStart(3)}  ground-tenanted ${String(v.ground).padStart(3)}  ` +
      `[${v.lotM.toFixed(0)} / ${v.groundM.toFixed(0)} / ${v.wholeM.toFixed(0)} m]`);
  }
  blocked.sort((a, b2) => b2.sum - a.sum);
  console.log(`  ${blocked.length} buildings with >= ${FAC.LOT.minEdge} m of street frontage and NO subdivision:`);
  const why = new Map();
  for (const t of blocked) {
    const key = `${t.why} / ${t.recipe}`;
    why.set(key, (why.get(key) ?? 0) + 1);
  }
  for (const [k, v] of [...why].sort((a, b2) => b2[1] - a[1])) console.log(`    ${String(v).padStart(4)}  ${k}`);
  const N = Number(arg('top', 12));
  console.log(`  worst ${N} by total street frontage:`);
  for (const t of blocked.slice(0, N)) {
    console.log(`    #${String(t.i).padStart(3)} ${t.recipe.padEnd(12)} h ${String(t.h).padStart(6)} ` +
      `z=${(t.z || '-').padEnd(11)} k=${(t.k || '-').padEnd(11)} shop=${t.shop ? 'Y' : 'n'} ` +
      `${t.why.padEnd(9)} ${t.edges.join(' + ')} = ${t.sum} m`);
  }
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
  appendBuilding(b.p, b.h, style, wall, trim,
    // Pass BOTH, exactly as the streamer does. Passing only `street` measured
    // a world nobody renders: the corner-frontage path is keyed on `streets`,
    // so a before/after run of this tool reported a byte-identical district
    // while the engine was building a different one.
    { street: streetDirFor(b), streets: geomStreetDirsFor(d, b, 2) });
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
  const r = SIGN.districtSignageBuffers(d, {
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
