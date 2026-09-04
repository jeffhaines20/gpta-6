// What the trees cost, where they are, and whether any of their triangles face
// the wrong way. No browser: the dressing pass runs in node against
// data/district.json, so this is a cheap check that can be run after every edit
// rather than at the end.
//
// THREE MEASUREMENTS, and each exists because reasoning about it went wrong once:
//
//   --tiers      per-tree triangles for 'tree' and 'treeDetail', averaged over
//                a few hundred keys, in BOTH frame handednesses, with the
//                backfacing count per tier. The palm work found ten boot plates
//                emitting 20 backfacing triangles per palm on an emitter whose
//                winding had been reasoned about and looked fine; the whole-kit
//                defect had been "reintroduced on a new emitter". A new emitter
//                is exactly what this file is for.
//
//   --district   the real dressing pass over the real district, so the per-tree
//                cost is multiplied by the number of trees that are actually
//                placed rather than by a number from a previous ledger entry.
//                Also reports the species split against the census profile.
//
//   --attach     does every leaf clump actually touch a limb? A critic looking
//                at the bench frame flagged leaf plates sitting in open sky
//                with no branch reaching them. geom-audit.mjs cannot see this:
//                that gate asks whether a prop reaches the GROUND. This walks
//                every clump on every tree, finds the nearest point on any of
//                that tree's limb polylines, and compares the distance against
//                the clump's own SMALLEST extent -- the shortest distance from
//                its centre to its own surface -- so a pass means the limb is
//                inside the leaf mass in every direction, not merely near it.
//
//   --selftest   the opposite-reading test. An audit that reports 0 backfacing
//                triangles is worth nothing unless it has been seen to report a
//                non-zero one, so this deliberately reverses a winding and
//                asserts the count moves. A null result from an instrument
//                nobody has watched work is the trap this repo has paid for.
import * as THREE from '../vendor/three.module.min.js';
import fs from 'node:fs';
import { StreetFurniture, __kit } from '../src/streetfurniture.js';

const has = (k) => process.argv.includes(`--${k}`);
const arg = (k, d) => {
  const i = process.argv.indexOf(`--${k}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d;
};

// The two kinds of local frame this kit builds props in. `det` is
// ox*az - ax*oz: -1 is a REFLECTION, and it is the one 4,596 props were wound
// against before the kit learned to read it.
const FRAMES = {
  '+1': (x, z) => __kit.frame(x, z, 0, 1, 1, 0),
  '-1': (x, z) => __kit.frame(x, z, 0, 1, -1, 0),
};
// The census is taken at a POSITION, because the species is a function of one.
// (118, -170) is inside the Main St east tunnel, where the profile peaks at
// 0.90 and OAK_MAX*0.90 = 79% of keys are oaks; (0, 400) is off the corridor
// entirely and every key there is a palm. Running both is what separates "the
// oak costs this much" from "the average tree costs this much".
const AT = { oak: [118, -170], palm: [0, 400] };

function tierCensus(n) {
  // WITHOUT THIS EVERY KEY COMES BACK A PALM. oakWeight is 0 with no route, so
  // a tier census that forgot to hand one over would measure the tree this
  // round is replacing and report it as the tree this round built.
  __kit.setOakRoute(JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route);
  const out = {};
  for (const [spot, xz] of Object.entries(AT)) {
  for (const [tag, mk] of Object.entries(FRAMES)) {
    const f = mk(xz[0], xz[1]);
    const det = f.ox * f.az - f.ax * f.oz;
    for (const kind of ['tree', 'treeDetail']) {
      let tris = 0, bad = 0, ok = 0, flat = 0, lo = Infinity, hi = -Infinity, wide = 0;
      // The two clearance claims, measured off the emitted vertices rather than
      // asserted from the constants: how far the crown reaches toward the
      // frontage (which the placement test only guarantees 2.2 m of) and how
      // far it reaches over the carriageway.
      let toward = -Infinity, over = -Infinity, lowOver = Infinity;
      let kept = 0;
      for (let k = 0; k < n; k++) {
        const key = k * 977 + 13;
        // ONE SPECIES PER ROW. The oak spot is 79% oaks and 21% palms, so a
        // mean taken over every key there is a mean of two different trees --
        // and the palm's own crown reaches 3.78 m toward a frontage, which read
        // as the oak breaking a bound it was in fact keeping.
        const isOak = __kit.treeParams(key, xz[0], xz[1]).oak;
        if (isOak !== (spot === 'oak')) continue;
        kept++;
        const buf = __kit.newBuf();
        __kit.props[kind](buf, f, key);
        const w = windingOf(buf);
        tris += w.tris; bad += w.bad; ok += w.ok; flat += w.flat;
        lo = Math.min(lo, w.tris); hi = Math.max(hi, w.tris);
        let r = 0, top = 0;
        for (let i = 0; i < buf.pos.length; i += 3) {
          // radius about the PROP, not about the world origin -- the frame is
          // planted at a real corridor position, so hypot of the raw vertex is
          // the distance to (0, 0) and reads as a 200 m tree.
          const dx = buf.pos[i] - f.x, dz = buf.pos[i + 2] - f.z;
          r = Math.max(r, Math.hypot(dx, dz));
          top = Math.max(top, buf.pos[i + 1]);
          // Back into the prop's own (out, along) frame. out = (ox, oz).
          const lx = dx * f.ox + dz * f.oz;
          toward = Math.max(toward, lx);
          over = Math.max(over, -lx);
          if (-lx > 2.05) lowOver = Math.min(lowOver, buf.pos[i + 1]);
        }
        wide = Math.max(wide, r);
      }
      const row = `${spot}/${kind}@det${det < 0 ? '-1' : '+1'}`;
      out[row] = { n: kept, mean: +(tris / kept).toFixed(1), min: lo, max: hi, bad, ok, flat,
        maxRadius: +wide.toFixed(2), towardFrontage: +toward.toFixed(2),
        overRoad: +over.toFixed(2),
        lowestOverRoad: Number.isFinite(lowOver) ? +lowOver.toFixed(2) : null };
    }
  }
  }
  return out;
}

/** windingOf, re-derived here only because the kit's copy is not exported. */
function windingOf(buf, i0 = 0) {
  const { pos, nrm, idx } = buf;
  let ok = 0, bad = 0, flat = 0;
  for (let t = i0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
    const vx = pos[c] - pos[a], vy = pos[c + 1] - pos[a + 1], vz = pos[c + 2] - pos[a + 2];
    const gx = uy * vz - uz * vy, gy = uz * vx - ux * vz, gz = ux * vy - uy * vx;
    const nx = nrm[a] + nrm[b] + nrm[c], ny = nrm[a + 1] + nrm[b + 1] + nrm[c + 1];
    const nz = nrm[a + 2] + nrm[b + 2] + nrm[c + 2];
    const scale = Math.hypot(gx, gy, gz) * Math.hypot(nx, ny, nz);
    if (scale < 1e-12) { flat++; continue; }
    const d = (gx * nx + gy * ny + gz * nz) / scale;
    if (d < -0.08) bad++; else if (d <= 0.08) flat++; else ok++;
  }
  return { tris: (idx.length - i0) / 3, ok, bad, flat };
}

/**
 * The whole dressing pass, and the same pass with the corridor route withheld.
 *
 * Withholding the route turns oakWeight to 0 everywhere, which switches off BOTH
 * halves of this round -- the species and the extra tree stations the census
 * buys -- and reproduces the district exactly as it dressed before. So the pair
 * is a true A/B rather than this run against a number from an older ledger
 * entry taken on a different district file.
 */
function dress(withRoute) {
  const d = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
  if (!withRoute) d.meta = { ...d.meta, route: null };
  const fu = new StreetFurniture(new THREE.Scene(), { max: 1200 });
  // THE LAMPS FIRST, exactly as district/main.js places them.
  //
  // Without them this harness dressed a district with no lamps in it, and the
  // tree test is
  //     lampClearance(treeX, treeZ) >= 3.4
  // which with no lamps placed is Infinity everywhere. So the harness reported
  // 294 trees and 278,101 prop triangles where the page reports 276 and
  // 272,349: an 18-tree, 5,752-triangle error, in the harness, in the direction
  // that flatters the change. The numbers this file prints have to be the
  // numbers the page renders or they are decoration.
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
  fu.dressDistrict(d, { audit: true });
  return fu;
}

function district() {
  const before = dress(false);
  const b = before.report();
  const bt = before.placed.filter((p) => p.kind === 'tree' || p.kind === 'treeDetail')
    .reduce((a, p) => a + p.wind.tris, 0);
  const bn = before.placed.filter((p) => p.kind === 'tree').length;

  const fu = dress(true);
  const r = fu.report();
  const byKind = new Map();
  for (const p of fu.placed) {
    let e = byKind.get(p.kind);
    if (!e) byKind.set(p.kind, (e = { n: 0, tris: 0, bad: 0, worstFloat: -Infinity }));
    e.n++; e.tris += p.wind.tris; e.bad += p.wind.bad;
    if (p.hostY !== null) e.worstFloat = Math.max(e.worstFloat, p.lowY - p.hostY);
  }
  console.log('KIND              n     tris   per   backfacing   worstFloat(mm)');
  for (const [k, e] of [...byKind].sort((a, b) => b[1].tris - a[1].tris)) {
    console.log(`${k.padEnd(14)} ${String(e.n).padStart(5)} ${String(e.tris).padStart(8)} `
      + `${(e.tris / e.n).toFixed(1).padStart(6)}   ${String(e.bad).padStart(6)}       `
      + `${Number.isFinite(e.worstFloat) ? (e.worstFloat * 1000).toFixed(1) : 'n/a'}`);
  }
  const t = byKind.get('tree'), td = byKind.get('treeDetail');
  console.log(`\nTREES  ${t.n} placed`);
  console.log(`  FAR  'tree'        ${(t.tris / t.n).toFixed(1)} tris/tree   ${t.tris} total`);
  console.log(`  NEAR 'treeDetail'  ${(td.tris / td.n).toFixed(1)} tris/tree   ${td.tris} total`);
  console.log(`  per tree           ${((t.tris + td.tris) / t.n).toFixed(1)}`);
  console.log(`  district           ${t.tris + td.tris}`);
  console.log(`\nALL PROPS  count ${r.propCount}  triangles ${r.propTriangles}  `
    + `buckets ${r.propBuckets}  worstFloatMm ${r.worstFloatMm}  backfacing ${r.backfacingTris}`);

  console.log('\nA/B, the same pass with the corridor route withheld (all palms,'
    + ' no density boost):');
  console.log(`  trees            ${bn} -> ${t.n}   (+${t.n - bn})`);
  console.log(`  tree triangles   ${bt} -> ${t.tris + td.tris}   (+${t.tris + td.tris - bt}, `
    + `${(100 * (t.tris + td.tris - bt) / bt).toFixed(1)}%)`);
  console.log(`  all props        ${b.propTriangles} -> ${r.propTriangles}   `
    + `(+${r.propTriangles - b.propTriangles}, ${(100 * (r.propTriangles - b.propTriangles) / b.propTriangles).toFixed(1)}%)`);
  console.log(`  prop count       ${b.propCount} -> ${r.propCount}`);
  console.log(`  worstFloatMm     ${b.worstFloatMm} -> ${r.worstFloatMm}`);
  console.log(`  backfacing       ${b.backfacingTris} -> ${r.backfacingTris}`);

  // Species, counted by the dressing pass where each tree was planted -- not
  // re-derived here, because a second copy of the placement rule drifts from the
  // one that placed the trees, which is the lesson tools/geom-audit.mjs is
  // written around.
  console.log('\nSPECIES  ' + JSON.stringify(r.treeSpecies));

  // WHERE the oaks are, against where the census said they should be. A tree is
  // attributed to a census run by its corridor arc-length, so this reads as the
  // same four runs oak-profile.mjs prints or the placement rule is not doing
  // what it was written from.
  const RUNS = [
    ['bayfront    s 220-340', 220, 340],
    ['McAnsh      s 500-560', 500, 560],
    ['Main St E   s 720-840', 720, 840],
    ['Main St E   s 1020-1100', 1020, 1100],
  ];
  const route = JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route;
  const sOf = (x, z) => {
    let bs = 0, bo = Infinity, acc = 0;
    for (let i = 0; i + 1 < route.length; i++) {
      const a = route[i], b = route[i + 1];
      const dx = b.x - a.x, dz = b.z - a.z, len = Math.hypot(dx, dz) || 1;
      let t = ((x - a.x) * dx + (z - a.z) * dz) / (len * len);
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const off = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
      if (off < bo) { bo = off; bs = acc + t * len; }
      acc += len;
    }
    return { s: bs, off: bo };
  };
  const trees = fu.placed.filter((p) => p.kind === 'tree').map((p) => ({ ...p, ...sOf(p.x, p.z) }));
  console.log('\nTREE STATIONS BY CENSUS RUN     trees   weight at the densest');
  for (const [name, s0, s1] of RUNS) {
    const here = trees.filter((p) => p.s >= s0 && p.s <= s1 && p.off < 55);
    const w = Math.max(0, ...here.map((p) => __kit.oakWeight(p.x, p.z)));
    console.log(`  ${name.padEnd(26)} ${String(here.length).padStart(4)}    ${w.toFixed(2)}`);
  }
  const off = trees.filter((p) => !RUNS.some(([, s0, s1]) => p.s >= s0 && p.s <= s1 && p.off < 55));
  console.log(`  ${'everywhere else'.padEnd(26)} ${String(off.length).padStart(4)}`);
  return r;
}

/**
 * Every clump against every limb, on every tree the district could plant.
 *
 * The clump records the limb point it was hung on, but trusting that record is
 * the mistake: the whole question is whether the geometry that came out still
 * agrees with it. So the distance is measured to the nearest point on the limb
 * POLYLINES -- the same arrays limbTube() sweeps its rings along -- and the
 * clump's own record is used only to report how much of the answer it explains.
 */
function attach(n, nudge = 0) {
  __kit.setOakRoute(JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route);
  const AT = [118, -170];
  let clumps = 0, trees = 0, worst = -Infinity, worstAt = null;
  let detached = 0, offRecord = 0;
  const hist = [0, 0, 0, 0, 0];
  for (let k = 0; k < n; k++) {
    const key = k * 977 + 13;
    const p = __kit.treeParams(key, AT[0], AT[1]);
    if (!p.oak) continue;
    trees++;
    // TIER BY TIER, against ONLY the limbs that tier draws. Checking every
    // clump against every limb on the tree would pass a far-tier clump that
    // hangs on a twig the far tier does not draw -- which is the same plate in
    // open sky, just at 300 m instead of 30.
    const limbs = __kit.oakLimbs(p);
    const twigs = __kit.oakTwigs(p, limbs);
    const segsOf = (list) => {
      const out = [];
      for (const lb of list) {
        for (let i = 0; i + 1 < lb.pts.length; i++) out.push([lb.pts[i], lb.pts[i + 1]]);
      }
      return out;
    };
    const tiers = [
      [segsOf(limbs), __kit.oakClumpsOf(p, limbs, p.nClump, 0)],
      [segsOf(twigs), __kit.oakClumpsOf(p, twigs, p.nInfill, 1)],
    ];
    for (const [segs, list] of tiers) {
    for (const c0 of list) {
      // --break displaces every clump before measuring. An attachment audit
      // that has never been seen to FAIL is worth nothing: this repo has paid
      // once already for a probe that toggled a material nothing used and
      // produced an identical frame.
      const c = nudge ? { ...c0, x: c0.x + nudge, y: c0.y + nudge } : c0;
      clumps++;
      let best = Infinity;
      for (const [A, B] of segs) {
        const vx = B[0] - A[0], vy = B[1] - A[1], vz = B[2] - A[2];
        const l2 = vx * vx + vy * vy + vz * vz || 1;
        let t = ((c.x - A[0]) * vx + (c.y - A[1]) * vy + (c.z - A[2]) * vz) / l2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        best = Math.min(best, Math.hypot(c.x - (A[0] + vx * t), c.y - (A[1] + vy * t),
          c.z - (A[2] + vz * t)));
      }
      // The pillow's SMALLEST extent: the nadir, at 0.74 of the height. Any
      // direction from the centre reaches at least this far, so a limb point
      // inside this radius is inside the leaf mass whichever way it lies.
      const inner = c.hgt * 0.74;
      const ratio = best / inner;
      hist[Math.min(4, Math.floor(ratio * 4))]++;
      if (ratio > 1) detached++;
      if (ratio > worst) { worst = ratio; worstAt = { key, gap: +best.toFixed(3), inner: +inner.toFixed(3) }; }
      const rec = Math.hypot(c.x - c.on[0], c.y - c.on[1], c.z - c.on[2]);
      if (Math.abs(rec - best) > 0.02) offRecord++;
    }
    }
  }
  console.log(`${clumps} leaf clumps on ${trees} oaks, measured against ${'their own limb polylines'}`);
  console.log('gap to the nearest limb, as a fraction of the clump\'s smallest half-extent:');
  const lab = ['0.00-0.25', '0.25-0.50', '0.50-0.75', '0.75-1.00', 'OVER 1.00'];
  hist.forEach((v, i) => console.log(`  ${lab[i]}  ${String(v).padStart(6)}  ${(100 * v / clumps).toFixed(1)}%`));
  console.log(`worst ${worst.toFixed(3)} (${JSON.stringify(worstAt)})`);
  console.log(`${offRecord} clumps whose nearest limb is not the one they record`);
  console.log(detached === 0
    ? 'ATTACH PASS - every clump contains a piece of a limb'
    : `ATTACH FAIL - ${detached} clumps hang clear of every limb on their tree`);
  return detached === 0;
}

if (has('attach')) {
  const n = Number(arg('n', 600));
  if (has('break')) {
    console.log('--break: every clump displaced 1.5 m off its limb before measuring.\n');
    const stillPass = attach(n, 1.5);
    console.log(stillPass
      ? '\nSELFTEST FAIL - the attachment audit passed geometry it should have failed'
      : '\nSELFTEST PASS - the attachment audit can produce the opposite reading');
    process.exit(stillPass ? 1 : 0);
  }
  process.exit(attach(n) ? 0 : 1);
} else if (has('selftest')) {
  // Can this instrument report a non-zero backfacing count at all? Build a tree,
  // then reverse every triangle's index order and re-measure. If the reversed
  // buffer does not read as almost entirely backfacing, the audit is inert and
  // its zero on the real geometry means nothing.
  __kit.setOakRoute(JSON.parse(fs.readFileSync('data/district.json', 'utf8')).meta.route);
  const f = __kit.frame(118, -170, 0, 1, 1, 0);
  const buf = __kit.newBuf();
  __kit.props.tree(buf, f, 4242);
  __kit.props.treeDetail(buf, f, 4242);
  const a = windingOf(buf);
  const flipped = { ...buf, idx: [] };
  for (let i = 0; i < buf.idx.length; i += 3) flipped.idx.push(buf.idx[i], buf.idx[i + 2], buf.idx[i + 1]);
  const b = windingOf(flipped);
  console.log(`as built   tris ${a.tris}  ok ${a.ok}  bad ${a.bad}  flat ${a.flat}`);
  console.log(`reversed   tris ${b.tris}  ok ${b.ok}  bad ${b.bad}  flat ${b.flat}`);
  const pass = a.bad === 0 && b.bad > b.tris * 0.8 && b.ok < b.tris * 0.1;
  console.log(pass
    ? 'SELFTEST PASS - the audit separates a correctly wound tree from a reversed one'
    : 'SELFTEST FAIL - this instrument cannot produce the opposite reading');
  process.exit(pass ? 0 : 1);
} else if (has('district')) {
  district();
} else {
  const n = Number(arg('n', 400));
  const c = tierCensus(n);
  console.log(`per-tree triangles over ${n} keys, both handednesses\n`);
  console.log('tier                      n   mean    min   max  backfacing  flat   widest'
    + '  ->frontage  ->road  lowSoffit');
  for (const [k, v] of Object.entries(c)) {
    console.log(`${k.padEnd(22)} ${String(v.n).padStart(4)} ${String(v.mean).padStart(6)} `
      + `${String(v.min).padStart(5)} ${String(v.max).padStart(5)} ${String(v.bad).padStart(11)} `
      + `${String(v.flat).padStart(5)} ${String(v.maxRadius).padStart(8)} `
      + `${String(v.towardFrontage).padStart(10)} ${String(v.overRoad).padStart(7)} `
      + `${String(v.lowestOverRoad).padStart(10)}`);
  }
  // The two clearance claims, as a check rather than a note. The palm rows are
  // reported and not gated: its frond reach predates this round and is recorded
  // in the ledger as a deliberate 2.6 m number.
  let held = true;
  for (const [k, v] of Object.entries(c)) {
    if (!k.startsWith('oak/')) continue;
    if (v.towardFrontage > 2.20) { held = false; console.log(`  FRONTAGE ${k}: ${v.towardFrontage} m > 2.20`); }
    if (v.lowestOverRoad !== null && v.lowestOverRoad < 4.20) { held = false; console.log(`  SOFFIT ${k}: ${v.lowestOverRoad} m < 4.20`); }
  }
  console.log(held
    ? '\nCLEARANCES HOLD: no oak vertex passes 2.20 m toward the frontage and'
      + ' none hangs below 4.20 m over the carriageway.'
    : '\nCLEARANCES BROKEN, see above.');
  for (const spot of Object.keys(AT)) {
    const far = c[`${spot}/tree@det-1`], near = c[`${spot}/treeDetail@det-1`];
    console.log(`per tree at the ${spot} spot: ${(far.mean + near.mean).toFixed(1)} triangles`);
  }
  console.log('run  --district  for the placed count and the district total');
  console.log('run  --selftest  to confirm the backfacing counter is not inert');
}
