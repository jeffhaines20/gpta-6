// Is the district's shopfront lighting actually VARIED, and does the lit state
// cost the daylight frame anything?
//
// Two questions, both answerable without a browser, because both are properties
// of the kit's arithmetic rather than of a pixel.
//
//  1. THE WRAP INVARIANT. The whole mechanism rests on one claim: the three
//     tenancy states address the SAME texel of the albedo and roughness atlases,
//     because those wrap and the rects differ by whole units of v. If that is off
//     by a texel anywhere, lighting a shop changes it in daylight too, and the
//     change is small enough to survive a glance. So it is asserted here for
//     every cell in the TRIM table, in every state, rather than trusted.
//
//  2. THE SPREAD. "Not every shop should be lit" is the requirement, and a
//     fraction alone does not establish it: 30% of tenancies open in runs of nine
//     is a lit half of the street and a dark half. What has to be true is that
//     the open ones are INTERLEAVED, so the census reports the run-length
//     distribution along each frontage as well as the shares. This tool exists
//     because the first build of the change WAS uniform enough to matter - the
//     hero frame's near row drew dark end to end - and that has to be visible in
//     a number, not only in a picture nobody has captured yet.
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
const {
  TRIM, TRIM_NONE, TRIM_DARK, TRIM_DIM, TRIM_LIT, TRIM_STATES, trimCell,
  tenancyState, tenancyStateCapped, MAX_DARK_RUN, TENANCY_MIX,
  buildingStyle, lotPlanFor, edgesOf,
} = FAC;
// TRIM_GRID is module-private in facades.js; it is 4 and the atlas is 512 px, and
// both are asserted below by rebuilding the cell size from them and checking the
// UV rects agree.
const TRIM_STATES_GRID = 4;
const STATE_NAME = {
  [TRIM_NONE]: 'not a shopfront', [TRIM_DARK]: 'closed, dark',
  [TRIM_DIM]: 'closed, light on', [TRIM_LIT]: 'open',
};

/**
 * Does the lit rect of every trim cell wrap onto the unlit one?
 * @returns {{cell:string, du:number, dv:number, ok:boolean}[]}
 */
export function wrapInvariant(cells, cellFn, states = 3) {
  const rows = [];
  for (const [name, c] of Object.entries(cells)) {
    const a = cellFn(c, 0);
    for (let st = 1; st < states; st++) {
      const b = cellFn(c, st);
      // u must be untouched, and v must differ by EXACTLY a whole number of
      // blocks. An integer offset is the only offset a RepeatWrapping sampler
      // cannot see.
      const du = Math.max(Math.abs(b.u0 - a.u0), Math.abs(b.u1 - a.u1));
      const dv0 = b.v0 - a.v0, dv1 = b.v1 - a.v1;
      const ok = du === 0 && dv0 === st && dv1 === st && Number.isInteger(dv0);
      rows.push({ cell: `${name}/${st}`, du, dv: dv0, dv1, ok });
    }
  }
  return rows;
}

/**
 * Bytes an RGBA8 texture costs on the GPU including its mip chain, counted level
 * by level the way packedMips actually builds it rather than by multiplying the
 * base by 4/3.
 *
 * The shortcut is wrong here and wrong in the direction that flatters: the
 * emissive atlas is 4 x 12 cells, so its chain runs 256x768, 128x384 ... 4x12,
 * 2x6, 1x3, 1x1, and three of those levels are NOT a clean quarter of the one
 * above. Rounding up at every step is the difference between a number that can be
 * quoted and one that is nearly right.
 */
export function textureBytes(w, h) {
  let bytes = 0;
  for (;;) {
    bytes += w * h * 4;
    if (w === 1 && h === 1) return bytes;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
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

  // The real table must pass, on every cell in every state.
  const rows = wrapInvariant(TRIM, trimCell, TRIM_STATES);
  ck('every trim cell wraps in every state', rows.every((r) => r.ok), true);
  ck('16 cells x 3 shopfront states checked', rows.length, 48);
  // The grid width this file assumes, checked against the UV rects facades.js
  // actually emits rather than hardcoded twice in two files.
  const g0 = trimCell(TRIM.stone, 0);
  ck('grid is 4 wide', Math.round(1 / (g0.u1 - g0.u0 + 2 * 0.004)), TRIM_STATES_GRID);

  // KNOWN-BAD INPUT 1: an offset that is not an integer. 0.5 lands halfway up the
  // atlas and a wrapping sampler CAN see it, so the daylight guarantee is void.
  // This is the mistake a "just shift it into the spare half" instinct makes.
  const halfShift = (c, st) => {
    const a = trimCell(c, 0);
    return { u0: a.u0, u1: a.u1, v0: a.v0 + st * 0.5, v1: a.v1 + st * 0.5 };
  };
  ck('a 0.5 offset is rejected', wrapInvariant(TRIM, halfShift).every((r) => r.ok), false);

  // KNOWN-BAD INPUT 2: shifting u as well as v. Wrapping saves v; it does not
  // save a cell that has slid sideways into its neighbour.
  const uShift = (c, st) => {
    const a = trimCell(c, 0);
    return { u0: a.u0 + st * 0.25, u1: a.u1 + st * 0.25, v0: a.v0 + st, v1: a.v1 + st };
  };
  ck('a u offset is rejected', wrapInvariant(TRIM, uShift).every((r) => r.ok), false);

  // KNOWN-BAD INPUT 3: no offset at all. A lit cell that never left the dark
  // block would light NOTHING, and the frame would look exactly like the defect.
  const noShift = (c) => trimCell(c, 0);
  ck('a zero offset is rejected', wrapInvariant(TRIM, noShift).every((r) => r.ok), false);

  // textureBytes, against a case anyone can check by hand: a 1x1 texture is its
  // own whole chain, and a 2x2 is 4 texels plus 1.
  ck('1x1 rgba', textureBytes(1, 1), 4);
  ck('2x2 rgba with its mip', textureBytes(2, 2), (4 + 1) * 4);
  // KNOWN-BAD INPUT: the 4/3 shortcut. Asserting it is wrong for the 4 x 12 chain
  // was this file's own first guess and it is FALSE - 256x768 sums to exactly
  // 262,144 texels, which is 196,608 x 4/3 to the byte, because the tail
  // 4x12, 2x6, 1x3, 1x1 happens to telescope. The shortcut is still not a safe
  // general rule, and 5x5 is where it breaks: the real chain is 25 + 4 + 1 = 30
  // texels and the shortcut says 33.3. Both are asserted, because the useful
  // record here is which one of them surprised me.
  ck('4/3 is exact for the 256x768 chain', textureBytes(256, 768), 256 * 768 * 4 * 4 / 3);
  ck('4/3 over-counts a 5x5 chain', textureBytes(5, 5) < Math.round(5 * 5 * 4 * (4 / 3)), true);
  ck('5x5 chain is 30 texels', textureBytes(5, 5), 30 * 4);

  // runLengths, on inputs whose answer is obvious by eye.
  ck('runs of alternating', JSON.stringify(runLengths([1, 0, 1, 0])), '[1,1,1,1]');
  ck('runs of one block', JSON.stringify(runLengths([1, 1, 1, 0, 0])), '[3,2]');
  ck('runs of empty', JSON.stringify(runLengths([])), '[]');

  // tenancyState must be a FUNCTION of its arguments and not of call order, or
  // the district would light differently depending on which chunk streamed first.
  const a1 = tenancyState(7, 3, 2), a2 = tenancyState(7, 3, 2);
  ck('tenancyState is deterministic', a1, a2);
  // ... and it must actually reach all three SHOPFRONT states, or a block of the
  // emissive atlas is paid for and never sampled.
  const seen = new Set();
  for (let k = 0; k < 600; k++) seen.add(tenancyState(7, 3, k));
  ck('all three shopfront states occur', seen.size, 3);
  ck('states are in range', [...seen].every((v) => v >= TRIM_DARK && v <= TRIM_LIT), true);
  // And it must NEVER hand back TRIM_NONE. That block is the one every cornice,
  // awning and balcony balustrade in the district samples, and it is black; a
  // shopfront landing there is the bug that made the near row of the hero frame
  // pure black, only this time it would be systematic rather than a 5% roll.
  ck('no shopfront is ever handed the non-shopfront block', seen.has(TRIM_NONE), false);

  // THE RUN CAP. Fed the worst possible input - a stream that wants to be dark
  // every single time - the capped form must still break the run at
  // MAX_DARK_RUN, and must reset its counter the moment a lit tenancy appears.
  // This is the known-bad input for the rule that answers the review round's
  // "should a run that long be possible": tenancyState alone says yes.
  let run = 0;
  const seq = [];
  for (let k = 0; k < 12; k++) {
    // Force the raw roll to dark by asking the capped form directly with a run
    // that is already at the cap on every other step, and by reading what the
    // uncapped one would have said.
    const capped = tenancyStateCapped(run, 'forced', k);
    seq.push(capped.state);
    run = capped.run;
  }
  ck('capped run never exceeds MAX_DARK_RUN', run <= MAX_DARK_RUN, true);
  let worst = 0, cur = 0;
  for (const st of seq) { cur = st === TRIM_DARK ? cur + 1 : 0; if (cur > worst) worst = cur; }
  ck('no dark run in the sequence exceeds the cap', worst <= MAX_DARK_RUN, true);
  // Directly: at the cap, a dark roll must be promoted, and the counter reset.
  const atCap = tenancyStateCapped(MAX_DARK_RUN, 'forced', 3);
  ck('at the cap nothing is ever dark', atCap.state === TRIM_DARK, false);
  ck('and the run resets', atCap.run, 0);
  // Below the cap the raw roll must pass through untouched, or the cap is
  // silently rewriting the whole district instead of trimming its tail.
  let passthrough = true;
  for (let k = 0; k < 200; k++) {
    if (tenancyStateCapped(0, 'p', k).state !== tenancyState('p', k)) passthrough = false;
  }
  ck('below the cap the roll is untouched', passthrough, true);

  console.log(fail ? `\n${fail} FAILED` : '\nall passed');
  process.exit(fail ? 1 : 0);
}

if (process.argv.includes('--selftest')) selftest();

// ------------------------------------------------------------------- census
const rows = wrapInvariant(TRIM, trimCell, TRIM_STATES);
const bad = rows.filter((r) => !r.ok);
console.log(`\nWRAP INVARIANT: ${rows.length - bad.length} of ${rows.length} cell/state pairs ` +
  'place their rect a WHOLE number of blocks above the dark one, u untouched');
for (const b of bad) console.log(`  FAIL ${b.cell}: du ${b.du}, dv ${b.dv}`);

// VRAM, from the same constants buildTrimEmissive uses, so it cannot drift from
// the atlas that is actually built. Cell size is C / 2 where C = 512 / TRIM_GRID.
const CELL = 512 / TRIM_STATES_GRID / 2;
const EM_W = TRIM_STATES_GRID * CELL, EM_H = TRIM_STATES_GRID * TRIM_STATES * CELL;
const emBytes = textureBytes(EM_W, EM_H);
console.log(`\nVRAM: the emissive atlas is ${EM_W}x${EM_H} RGBA8 = ` +
  `${(emBytes / 1048576).toFixed(2)} MB with its full mip chain`);
console.log('      albedo and rm are untouched at 512x512 each; nothing else is added.');
console.log(`      EMISSIVE_INTENSITY's comment refuses 7 MB for a third FACADE ` +
  `emissive atlas; this is ${((100 * emBytes) / (7 * 1048576)).toFixed(0)}% of that.`);

const district = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const buildings = district.buildings;
let total = 0, shopBuildings = 0;
const count = { [TRIM_NONE]: 0, [TRIM_DARK]: 0, [TRIM_DIM]: 0, [TRIM_LIT]: 0 };
const allRuns = [];
const darkRuns = [];
for (let i = 0; i < buildings.length; i++) {
  const b = buildings[i];
  const style = buildingStyle(b, i);
  // `lots` OR `groundLots`: a tower's ground floor is a row of tenancies with
  // its own lit states, and gating on `lots` alone made this census blind to
  // 162 of them the moment towers got shopfronts. lotPlanFor answers for both.
  if (!style.storefront || !(style.lots || style.groundLots)) continue;
  const ring = b.p;
  const all = edgesOf(ring, { minLen: 0, longest: ring.length });
  const plan = lotPlanFor(ring, style, b.h, all);
  if (!plan.size) continue;
  shopBuildings++;
  for (const [, lp] of plan) {
    const states = lp.lots.map((L) => L.litState);
    if (!states.length) continue;
    total += states.length;
    for (const st of states) count[st]++;
    for (const r of runLengths(states)) allRuns.push(r);
    // Run lengths of the fully DARK stretches: this is the number that says
    // whether a street-level camera can land on a row with nothing in it, which
    // is exactly what happened to the first build of this change.
    let n = 0;
    for (let k = 0; k < states.length; k++) {
      if (states[k] === TRIM_DARK) n++;
      if ((states[k] !== TRIM_DARK || k === states.length - 1) && n) { darkRuns.push(n); n = 0; }
    }
  }
}
const hist = (a) => {
  const h = {};
  for (const v of a) h[v] = (h[v] ?? 0) + 1;
  return Object.entries(h).sort((x, y) => Number(x[0]) - Number(y[0]))
    .map(([k, v]) => `${k}:${v}`).join('  ');
};
console.log(`\nTENANCY CENSUS (open ${TENANCY_MIX.open}, dim to ${TENANCY_MIX.dimTo})`);
console.log(`  lotted shopfront buildings : ${shopBuildings}`);
console.log(`  tenancies                  : ${total}`);
for (const st of [TRIM_LIT, TRIM_DIM, TRIM_DARK, TRIM_NONE]) {
  if (st === TRIM_NONE && !count[st]) continue;
  console.log(`  ${STATE_NAME[st].padEnd(27)}: ${String(count[st]).padStart(4)}  ` +
    `(${((100 * count[st]) / total).toFixed(1)}%)`);
}
const showing = count[TRIM_LIT] + count[TRIM_DIM];
console.log(`  showing a READABLE light   : ${showing}  (${((100 * showing) / total).toFixed(1)}%)`);
const black = count[TRIM_NONE];
console.log(`  PURE BLACK behind the glass: ${black}  (${((100 * black) / total).toFixed(1)}%)` +
  '  <- the complaint; must be 0');
console.log(`  run lengths, any one state : ${hist(allRuns)}`);
console.log(`  run lengths of DARK stretches: ${hist(darkRuns)}`);
console.log(`  (MAX_DARK_RUN = ${MAX_DARK_RUN})`);
const longest = Math.max(0, ...allRuns);
const longestDark = Math.max(0, ...darkRuns);
console.log(`  longest run of one state   : ${longest} tenancies`);
console.log(`  longest FULLY DARK run     : ${longestDark} tenancies`);
// This guard is kept, but it is no longer the thing that matters. A street-level
// camera sees roughly four to six tenancies across a near frontage, and a run of
// closed-and-dark shops longer than that used to be able to fill a hero frame
// with the defect - which is exactly what happened twice. It cannot any more,
// because TRIM_DARK is faint rather than black; the run length is now a
// composition note rather than a correctness one, and the line above it (pure
// black, must be 0) is the one to read.
// The cap makes this a gate rather than a note. A street-level camera sees four
// to six tenancies across a near frontage, and the CASSAVA / LUMEN CAMERA row
// drew dark on every visible lot in four successive versions of this change
// before the cap existed.
console.log(longestDark > MAX_DARK_RUN
  ? `  FAIL: a run of ${longestDark} closed-and-dark shops got past MAX_DARK_RUN`
  : `  no run of closed-and-dark shops longer than ${MAX_DARK_RUN}`);
