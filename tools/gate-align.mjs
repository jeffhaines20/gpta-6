// Is a gate triangle delta STRUCTURE, or is it SAMPLING?
//
// The budget gate reports a triangle p95 over a drive, and this project has twice
// argued about a delta between two such numbers without being able to say which
// of the two it was. The reason is written into CLAUDE.md: the "p95" is a near
// maximum over ~51-92 coarse samples of a quantity that swings 41% of its own
// p50, so two runs can differ by 20,000 with byte-identical geometry, purely
// because the sampler fired in different places. Comparing p95 with p95 cannot
// separate those cases, and neither can re-running one arm twice on one box --
// that proves self-consistency and says nothing about the cross-commit pair.
//
// What the artifacts DO carry, per sample, is position and residency:
//
//   { t, calls, tris, chunks, near, far, loads, unloads, swaps, stall, heap, x, z, kmh }
//
// So the drive is a registered pair after all. drive-through steers the same
// deterministic course in both runs, and measured on the two artifacts this tool
// was written for, every sample in one lands a MEDIAN OF 0.10 m from a sample in
// the other. Matching by position instead of by percentile holds the camera, the
// route and the resident set fixed, and what is left is the build.
//
//   node tools/gate-align.mjs <A.json> <B.json>
//   node tools/gate-align.mjs A.json B.json --margin 2 --json docs/align.json
//   node tools/gate-align.mjs --selftest
//
// WHAT THIS DOES NOT DO. `near`/`far` are chunk COUNTS, not chunk identities, so
// "same residency" here means the same number of resident chunks at the same
// place, not a proven-identical set. That is as tight as the artifact allows; it
// is stated rather than assumed, and the positional margin is reported so a
// reader can see how well the two drives actually registered.
//
// The self-test's fourth case is the one with teeth, and it is why this file
// exists rather than a subtraction: it builds a B whose p95 is 24,000 higher than
// A's with ZERO structural change, by dropping A's light frames. A tool that
// differences percentiles calls that growth. This one has to read 0.
import fs from 'node:fs';

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

/** Nearest-rank percentile, the rule tools/tri-ledger.mjs and bay-legibility use. */
export function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
}
const asc = (a) => [...a].sort((x, y) => x - y);
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);

/**
 * Match every sample of `b` to the nearest sample of `a` by ground position.
 *
 * Nearest-in-A, not same-index: the two runs do not sample the same number of
 * frames (92 against 89 for the pair this was written for) and one may stop
 * early, so index pairing walks off by a whole sample and compares a junction
 * against a straight. That is the same defect as pairing hero-shots frames by
 * index rather than by name, and the self-test asserts index pairing gets a
 * different, wrong answer on a case where this one is exact.
 */
export function alignByPosition(a, b, margin) {
  const pairs = [], unmatched = [];
  for (const q of b) {
    let best = Infinity, bestA = null;
    for (const p of a) {
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < best) { best = d; bestA = p; }
    }
    if (bestA && best <= margin) pairs.push({ d: best, a: bestA, b: q });
    else unmatched.push({ d: best, b: q });
  }
  return { pairs, unmatched };
}

/** The refusal floor. Below this the two runs did not drive the same course. */
/**
 * How much can the triangle count move over the residual positional error?
 *
 * Matching to within a margin is not matching exactly, and the count is a steep
 * function of position: at 40 km/h on a 1.09 s sample cadence consecutive samples
 * are ~12 m apart and can differ by tens of thousands. So a pair separated by
 * 0.3 m carries an error, and quoting a delta smaller than that error is the
 * "check your sampling can resolve what you assert" failure this project has
 * shipped before.
 *
 * The gradient is taken from A's own consecutive samples, which is the only
 * evidence available: |dtris| / ds against each neighbour, worst of the two.
 * That is an estimate of a secant, not of a derivative, so it UNDERSTATES a
 * curve that peaks between two samples -- stated rather than hidden.
 */
export function misregistrationBound(a, pairs) {
  const idx = new Map(a.map((s, i) => [s, i]));
  const grad = (i) => {
    let g = 0;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= a.length) continue;
      const ds = Math.hypot(a[j].x - a[i].x, a[j].z - a[i].z);
      if (ds > 1e-6) g = Math.max(g, Math.abs(a[j].tris - a[i].tris) / ds);
    }
    return g;
  };
  return pairs.map((p) => ({ d: p.d, gradPerM: grad(idx.get(p.a)), bound: grad(idx.get(p.a)) * p.d }));
}

/** The refusal floor. Below this the two runs did not drive the same course. */
export const MATCH_FLOOR = 0.6;

export function compare(A, B, { margin = 2.0 } = {}) {
  const sa = A.samples ?? [], sb = B.samples ?? [];
  if (!sa.length || !sb.length) throw new Error('an artifact has no samples');
  const { pairs, unmatched } = alignByPosition(sa, sb, margin);
  const frac = pairs.length / sb.length;

  const dTris = asc(pairs.map((p) => p.b.tris - p.a.tris));
  const dist = asc(pairs.map((p) => p.d));
  // Residency held as well as position. This is the structure-isolated figure.
  const iso = pairs.filter((p) => p.b.near === p.a.near && p.b.far === p.a.far);
  const dIso = asc(iso.map((p) => p.b.tris - p.a.tris));

  const mis = misregistrationBound(sa, pairs);
  const bounds = asc(mis.map((m) => m.bound));
  const grads = asc(mis.map((m) => m.gradPerM));

  // What a percentile subtraction would have said, for contrast.
  const pa = asc(sa.map((s) => s.tris)), pb = asc(sb.map((s) => s.tris));
  const p95A = A.result?.triangles?.p95 ?? pct(pa, 0.95);
  const p95B = B.result?.triangles?.p95 ?? pct(pb, 0.95);

  // And what INDEX pairing would have said, which is the wrong instrument.
  const n = Math.min(sa.length, sb.length);
  const dIdx = asc(Array.from({ length: n }, (_, i) => sb[i].tris - sa[i].tris));

  const claim = dIso.length ? pct(dIso, 0.5) : (dTris.length ? pct(dTris, 0.5) : NaN);
  const boundP50 = bounds.length ? pct(bounds, 0.5) : Infinity;

  return {
    margin, matched: pairs.length, ofB: sb.length, ofA: sa.length, matchedFrac: frac,
    registered: frac >= MATCH_FLOOR,
    // Two separate conditions, because they fail for different reasons and a
    // reader needs to know which: did the two runs drive the same course, and is
    // the delta bigger than the error left over from matching them imperfectly?
    resolvable: frac >= MATCH_FLOOR && Math.abs(claim) > boundP50,
    claim, boundP50,
    posDist: { p50: pct(dist, 0.5), p95: pct(dist, 0.95), max: pct(dist, 1) },
    byPosition: dTris.length
      ? { n: dTris.length, min: dTris[0], p25: pct(dTris, 0.25), p50: pct(dTris, 0.5),
          p75: pct(dTris, 0.75), max: pct(dTris, 1), mean: mean(dTris),
          higher: dTris.filter((v) => v > 0).length }
      : null,
    isolated: dIso.length
      ? { n: dIso.length, min: dIso[0], p50: pct(dIso, 0.5), max: pct(dIso, 1), mean: mean(dIso) }
      : null,
    misregistration: bounds.length
      ? { gradP50: pct(grads, 0.5), gradMax: pct(grads, 1),
          boundP50: pct(bounds, 0.5), boundP95: pct(bounds, 0.95), boundMax: pct(bounds, 1) }
      : null,
    byPercentile: { p95A, p95B, delta: p95B - p95A },
    byIndex: dIdx.length ? { n: dIdx.length, p50: pct(dIdx, 0.5), mean: mean(dIdx) } : null,
    unmatched: unmatched.map((u) => ({ x: u.b.x, z: u.b.z, nearestM: u.d })),
  };
}

function report(r, labels) {
  const [la, lb] = labels;
  console.log(`A  ${la}   ${r.ofA} samples`);
  console.log(`B  ${lb}   ${r.ofB} samples`);
  console.log(`\nregistration: ${r.matched}/${r.ofB} B samples within ${r.margin} m of an A sample` +
    `  (${(r.matchedFrac * 100).toFixed(1)}%)`);
  console.log(`  positional separation of matched pairs: p50 ${r.posDist.p50.toFixed(2)} m` +
    `  p95 ${r.posDist.p95.toFixed(2)} m  max ${r.posDist.max.toFixed(2)} m`);
  if (!r.registered) {
    console.log(`\nREFUSED: under ${(MATCH_FLOOR * 100).toFixed(0)}% of B registered against A.` +
      ` These are not two runs of one course, and a triangle delta between them is not attributable.`);
    return;
  }
  const p = r.byPosition;
  console.log(`\nD triangles AT MATCHED POSITION (n=${p.n})`);
  console.log(`  min ${p.min}   p25 ${p.p25}   p50 ${p.p50}   p75 ${p.p75}   max ${p.max}` +
    `   mean ${p.mean.toFixed(0)}`);
  console.log(`  B higher in ${p.higher}/${p.n} pairs`);
  if (r.isolated) {
    const i = r.isolated;
    console.log(`\nand with RESIDENCY HELD too (same near/far count, n=${i.n})`);
    console.log(`  min ${i.min}   p50 ${i.p50}   max ${i.max}   mean ${i.mean.toFixed(0)}`);
    console.log(`  <- this is the structural figure. Chunk COUNTS, not identities; see the header.`);
  }
  if (r.misregistration) {
    const m = r.misregistration;
    console.log(`\ncan this pair RESOLVE that? matching to ${r.margin} m is not matching exactly.`);
    console.log(`  triangles move ${Math.round(m.gradP50)}/m at the median sample` +
      ` (worst ${Math.round(m.gradMax)}/m), so the residual separation is worth`);
    console.log(`  p50 ${Math.round(m.boundP50)}   p95 ${Math.round(m.boundP95)}` +
      `   max ${Math.round(m.boundMax)} triangles of error per pair.`);
    console.log(`  claim ${r.claim > 0 ? '+' : ''}${r.claim} against a typical pair's` +
      ` ${Math.round(r.boundP50)}: ${r.resolvable ? 'RESOLVED' : 'NOT RESOLVED - do not quote it'}` +
      ` (a median over ${r.matched} pairs is tighter still, so this is the conservative reading)`);
  }

  console.log(`\nfor contrast, what the weaker instruments say`);
  console.log(`  p95 subtraction : ${r.byPercentile.p95A} -> ${r.byPercentile.p95B}` +
    `  delta ${r.byPercentile.delta > 0 ? '+' : ''}${r.byPercentile.delta}`);
  console.log(`  index pairing   : p50 ${r.byIndex.p50}  mean ${r.byIndex.mean.toFixed(0)}` +
    `   (pairs sample k with sample k, so it compares different ground)`);
  if (r.unmatched.length) {
    console.log(`\n${r.unmatched.length} B sample(s) had no A partner within the margin:`);
    for (const u of r.unmatched.slice(0, 6)) {
      console.log(`  (${u.x.toFixed(0)}, ${u.z.toFixed(0)})  nearest A sample ${u.nearestM.toFixed(2)} m away`);
    }
  }
}

// ---------------------------------------------------------------------------
// Self-test. Four of these five cases are known-bad input: a comparator that
// passes them all cannot be reporting a subtraction of percentiles.
function selftest() {
  let checks = 0, failed = 0;
  const ok = (cond, label, got) => {
    checks++;
    if (cond) console.log(`  ok    ${label}${got !== undefined ? `   ${got}` : ''}`);
    else { failed++; console.log(`  FAIL  ${label}${got !== undefined ? `   ${got}` : ''}`); }
  };
  // A synthetic drive: 40 samples along a line, triangles swinging 40% like the
  // real thing, so a percentile over it is as coarse as the gate's own.
  const mk = (n, f) => ({
    samples: Array.from({ length: n }, (_, i) => {
      const s = { t: i * 1.09, x: i * 30, z: Math.sin(i / 3) * 40,
        tris: Math.round(700000 + 160000 * Math.sin(i / 2.3) ** 2),
        near: 16, far: 60 + (i % 3), chunks: 70, calls: 130, stall: 5, heap: 300, kmh: 40 };
      return f ? f(s, i) : s;
    }),
  });
  const A = mk(40);

  console.log('1. identity: a run against itself');
  let r = compare(A, JSON.parse(JSON.stringify(A)));
  ok(r.matched === 40, 'all 40 samples register', `${r.matched}/40`);
  ok(r.byPosition.p50 === 0 && r.byPosition.max === 0 && r.byPosition.min === 0,
    'D triangles is exactly 0 at every pair', `min ${r.byPosition.min} max ${r.byPosition.max}`);

  console.log('2. a constant structural offset must come back exactly, not normalised away');
  const K = 19718;
  r = compare(A, mk(40, (s) => ({ ...s, tris: s.tris + K })));
  ok(r.byPosition.min === K && r.byPosition.max === K, `every pair reads +${K}`,
    `min ${r.byPosition.min} max ${r.byPosition.max}`);
  ok(r.isolated && r.isolated.p50 === K, 'the isolated figure reads it too', `${r.isolated?.p50}`);

  console.log('3. KNOWN BAD: two different courses must be refused, not differenced');
  r = compare(A, mk(40, (s) => ({ ...s, x: s.x + 400, z: s.z - 300 })));
  ok(!r.resolvable, 'refused', `${(r.matchedFrac * 100).toFixed(0)}% registered`);
  ok(r.matched === 0, 'nothing registered, and it did not report 0 growth from 0 pairs',
    `matched ${r.matched}`);

  console.log('4. KNOWN BAD: a p95 that rises with NO structural change');
  // The real mechanism, reproduced: the gate's p95 is a near-maximum over coarse
  // samples, so WHICH frames the sampler caught decides it. A has 40 samples of
  // which 2 are heavy, and its p95 (3rd from the top of 40) is therefore a light
  // frame. B holds a handful of the same samples including both heavy ones, and
  // its p95 (the top of 6) is a heavy one. Byte-identical geometry, and the first
  // fixture I wrote for this case could only move it 1,739 because the population
  // had no tail -- a weak known-bad reads as a passing check.
  const spiky = mk(40, (s, i) => ({ ...s, tris: 700000 + (i === 10 || i === 25 ? 160000 : (i % 5) * 900) }));
  const sub = { samples: [10, 25, 3, 8, 17, 31].map((i) => spiky.samples[i]) };
  r = compare(spiky, sub);
  ok(r.byPercentile.delta > 100000, 'the p95 subtraction calls it growth',
    `+${r.byPercentile.delta}`);
  ok(r.byPosition.min === 0 && r.byPosition.max === 0,
    'position matching reads 0 at every pair, which is the truth',
    `min ${r.byPosition.min} max ${r.byPosition.max}`);
  ok(r.matchedFrac === 1, 'and it did not get there by dropping samples',
    `${(r.matchedFrac * 100).toFixed(0)}% registered`);

  console.log('5. KNOWN BAD: index pairing on a run that stopped one sample early');
  // B is A minus its first sample. Position matching still pairs like with like;
  // index pairing compares sample k with sample k+1 and invents a difference.
  const shifted = { samples: A.samples.slice(1) };
  r = compare(A, shifted);
  ok(r.byPosition.max === 0 && r.byPosition.min === 0, 'position pairing still reads 0',
    `min ${r.byPosition.min} max ${r.byPosition.max}`);
  ok(Math.abs(r.byIndex.mean) > 1000, 'index pairing invents a difference, as advertised',
    `mean ${r.byIndex.mean.toFixed(0)}`);

  console.log('6. KNOWN BAD: a delta smaller than the error left over from matching');
  // Displace B along the route by 1 m and give it a token +50 triangles. The pair
  // still registers, and the tool must REFUSE to call +50 a result, because a 1 m
  // misregistration on this gradient is worth thousands. Without this case the
  // tool would happily quote a number its own pairing cannot see -- the same
  // failure as a 46 m prop measured through 2 pixels of ground contact.
  const steep = mk(30, (s, i) => ({ ...s, tris: 700000 + (i % 2) * 90000 }));
  const nudged = { samples: steep.samples.map((s) => ({ ...s, x: s.x + 1.0, tris: s.tris + 50 })) };
  r = compare(steep, nudged);
  ok(r.registered, 'the pair still registers', `${(r.matchedFrac * 100).toFixed(0)}%`);
  ok(r.claim === 50, 'and the delta it measures is the +50 that is really there', `${r.claim}`);
  ok(r.boundP50 > 1000, 'but a 1 m separation on this gradient is worth thousands',
    `${Math.round(r.boundP50)}`);
  ok(!r.resolvable, 'so it is refused, not quoted', `resolvable ${r.resolvable}`);
  // The complement: the same displacement must NOT suppress a real, large delta.
  const bigger = { samples: steep.samples.map((s) => ({ ...s, x: s.x + 1.0, tris: s.tris + 60000 })) };
  r = compare(steep, bigger);
  ok(r.resolvable && r.claim === 60000, 'and the same margin does not suppress a real one',
    `claim ${r.claim} bound ${Math.round(r.boundP50)}`);

  console.log(`\n${checks - failed}/${checks} checks passed`);
  if (failed) { console.error(`${failed} FAILED`); process.exit(1); }
}

if (has('--selftest')) { selftest(); }
else {
  const files = args.filter((a) => !a.startsWith('--') && /\.json$/.test(a));
  const flagged = new Set([val('--margin', null), val('--json', null)].filter(Boolean));
  const paths = files.filter((f) => !flagged.has(f));
  if (paths.length !== 2) {
    console.error('usage: node tools/gate-align.mjs <A.json> <B.json> [--margin 2] [--json out.json]');
    console.error('       node tools/gate-align.mjs --selftest');
    process.exit(2);
  }
  const [pa, pb] = paths;
  const A = JSON.parse(fs.readFileSync(pa, 'utf8'));
  const B = JSON.parse(fs.readFileSync(pb, 'utf8'));
  const r = compare(A, B, { margin: Number(val('--margin', 2)) });
  report(r, [pa, pb]);
  const outPath = val('--json', null);
  if (outPath) {
    fs.writeFileSync(outPath, JSON.stringify({ a: pa, b: pb, ...r }, null, 1));
    console.log(`\nwrote ${outPath}`);
  }
}
