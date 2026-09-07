// Is the district's shopfront lighting actually VARIED, and does the lit state
// cost the daylight frame anything?
//
// Two questions, both answerable without a browser, because both are properties
// of the kit's arithmetic rather than of a pixel.
//
//  1. THE WRAP INVARIANT. The whole mechanism rests on one claim: a lit cell and
//     an unlit cell address the SAME texel of the albedo and roughness atlases,
//     because those wrap and the two rects differ by exactly 1.0 in v. If that is
//     off by a texel anywhere, lighting a shop changes it in daylight too, and
//     the change is small enough to survive a glance. So it is asserted here for
//     every cell in the TRIM table rather than trusted.
//
//  2. THE SPREAD. "Not every shop should be lit" is the requirement, and a
//     fraction alone does not establish it: 42% of tenancies lit in runs of nine
//     is a lit half of the street and a dark half. What has to be true is that
//     the lit ones are INTERLEAVED, so the census reports the run-length
//     distribution along each frontage as well as the fraction.
//
// Browserless, deterministic, and it walks the same lot planner the streamer
// does - so it cannot drift from what is built. Same no-op 2D context
// tools/frontage-stats.mjs and tools/geom-audit.mjs install, for the same reason.
//
//   node tools/shoplit-census.mjs
//   node tools/shoplit-census.mjs --selftest
import fs from 'node:fs';

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
const { TRIM, TRIM_LIT_V, trimCell, tenancyLit, LIT_TENANCY, buildingStyle, lotPlanFor, edgesOf } = FAC;

/**
 * Does the lit rect of every trim cell wrap onto the unlit one?
 * @returns {{cell:string, du:number, dv:number, ok:boolean}[]}
 */
export function wrapInvariant(cells, cellFn, litV) {
  return Object.entries(cells).map(([name, c]) => {
    const a = cellFn(c, false), b = cellFn(c, true);
    // u must be untouched, and v must differ by EXACTLY the block height. An
    // integer offset is the only offset a RepeatWrapping sampler cannot see.
    const du = Math.max(Math.abs(b.u0 - a.u0), Math.abs(b.u1 - a.u1));
    const dv0 = b.v0 - a.v0, dv1 = b.v1 - a.v1;
    const ok = du === 0 && dv0 === litV && dv1 === litV && Number.isInteger(litV);
    return { cell: name, du, dv: dv0, dv1, ok };
  });
}

/** Runs of equal value in a boolean array, as lengths. */
export function runLengths(arr) {
  const out = [];
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    n++;
    if (i === arr.length - 1 || arr[i + 1] !== arr[i]) { out.push(n); n = 0; }
  }
  return out;
}

function selftest() {
  let fail = 0;
  const ck = (name, got, want) => {
    const ok = got === want;
    if (!ok) fail++;
    console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: got ${got}, want ${want}`);
  };

  // The real table must pass, on every cell.
  const rows = wrapInvariant(TRIM, trimCell, TRIM_LIT_V);
  ck('every trim cell wraps', rows.every((r) => r.ok), true);
  ck('all 16 cells checked', rows.length, 16);

  // KNOWN-BAD INPUT 1: an offset that is not an integer. 0.5 lands halfway up the
  // atlas and a wrapping sampler CAN see it, so the daylight guarantee is void.
  // This is the mistake a "just shift it into the spare half" instinct makes.
  const halfShift = (c, lit) => {
    const a = trimCell(c, false);
    return lit ? { u0: a.u0, u1: a.u1, v0: a.v0 + 0.5, v1: a.v1 + 0.5 } : a;
  };
  ck('a 0.5 offset is rejected', wrapInvariant(TRIM, halfShift, 0.5).every((r) => r.ok), false);

  // KNOWN-BAD INPUT 2: shifting u as well as v. Wrapping saves v; it does not
  // save a cell that has slid sideways into its neighbour.
  const uShift = (c, lit) => {
    const a = trimCell(c, false);
    return lit ? { u0: a.u0 + 0.25, u1: a.u1 + 0.25, v0: a.v0 + 1, v1: a.v1 + 1 } : a;
  };
  ck('a u offset is rejected', wrapInvariant(TRIM, uShift, 1).every((r) => r.ok), false);

  // KNOWN-BAD INPUT 3: no offset at all. A lit cell that never left the unlit
  // block would light NOTHING, and the frame would look exactly like the defect.
  const noShift = (c) => trimCell(c, false);
  ck('a zero offset is rejected', wrapInvariant(TRIM, noShift, 1).every((r) => r.ok), false);

  // runLengths, on inputs whose answer is obvious by eye.
  ck('runs of alternating', JSON.stringify(runLengths([1, 0, 1, 0])), '[1,1,1,1]');
  ck('runs of one block', JSON.stringify(runLengths([1, 1, 1, 0, 0])), '[3,2]');
  ck('runs of empty', JSON.stringify(runLengths([])), '[]');

  // tenancyLit must be a FUNCTION of its arguments and not of call order, or the
  // district would light differently depending on which chunk streamed first.
  const a1 = tenancyLit(7, 3, 2), a2 = tenancyLit(7, 3, 2);
  ck('tenancyLit is deterministic', a1, a2);
  let differs = false;
  for (let k = 0; k < 40 && !differs; k++) if (tenancyLit(7, 3, k) !== a1) differs = true;
  ck('tenancyLit is not constant', differs, true);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

// ------------------------------------------------------------------- census
const rows = wrapInvariant(TRIM, trimCell, TRIM_LIT_V);
const bad = rows.filter((r) => !r.ok);
console.log(`\nWRAP INVARIANT: ${rows.length - bad.length} of ${rows.length} trim cells ` +
  `place their lit rect exactly ${TRIM_LIT_V}.0 above the unlit one, u untouched`);
for (const b of bad) console.log(`  FAIL ${b.cell}: du ${b.du}, dv ${b.dv}`);

const district = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const buildings = district.buildings;
let lit = 0, total = 0, shopBuildings = 0;
const allRuns = [];
const litRuns = [];
for (let i = 0; i < buildings.length; i++) {
  const b = buildings[i];
  const style = buildingStyle(b, i);
  if (!style.storefront || !style.lots) continue;
  const ring = b.p;
  const all = edgesOf(ring, { minLen: 0, longest: ring.length });
  const plan = lotPlanFor(ring, style, b.h, all);
  if (!plan.size) continue;
  shopBuildings++;
  for (const [, lp] of plan) {
    const flags = lp.lots.map((L) => (L.lit ? 1 : 0));
    if (!flags.length) continue;
    total += flags.length;
    lit += flags.reduce((a, c) => a + c, 0);
    for (const r of runLengths(flags)) allRuns.push(r);
    // Run lengths of the LIT stretches only: this is the number that says
    // whether the street reads as interleaved shops or as two halves.
    let n = 0;
    for (let k = 0; k < flags.length; k++) {
      if (flags[k]) n++;
      if ((!flags[k] || k === flags.length - 1) && n) { litRuns.push(n); n = 0; }
    }
  }
}
const hist = (a) => {
  const h = {};
  for (const v of a) h[v] = (h[v] ?? 0) + 1;
  return Object.entries(h).sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([k, v]) => `${k}:${v}`).join('  ');
};
console.log(`\nTENANCY CENSUS (LIT_TENANCY = ${LIT_TENANCY})`);
console.log(`  lotted shopfront buildings : ${shopBuildings}`);
console.log(`  tenancies                  : ${total}`);
console.log(`  lit after dark             : ${lit}  (${((100 * lit) / total).toFixed(1)}%)`);
console.log(`  run lengths, lit or dark   : ${hist(allRuns)}`);
console.log(`  run lengths of LIT stretches: ${hist(litRuns)}`);
const longest = Math.max(0, ...allRuns);
const longestLit = Math.max(0, ...litRuns);
console.log(`  longest run of any kind    : ${longest} tenancies`);
console.log(`  longest run of LIT shops   : ${longestLit} tenancies`);
// The two directions fail differently and only one of them is this change's
// fault. A long LIT run is the "row of lightboxes" the old flat emissive panels
// produced and is the thing to guard; a long DARK run is a closed block, which is
// ordinary on a real high street after ten o'clock and is reported rather than
// warned about. Threshold on the lit side only.
console.log(longestLit > 5
  ? `  WARNING: ${longestLit} lit shops in a row reads as a lightbox, not as a street`
  : '  lit shops are interleaved, not banked');
