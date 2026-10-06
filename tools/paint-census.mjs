// THE CAR PAINT TABLE, AGAINST THE PHOTOGRAPHS IT CLAIMS TO COME FROM.
//
//   node tools/paint-census.mjs --selftest
//
// #91: `src/traffic.js` and `src/streetfurniture.js` each carried a long comment saying the
// reference is "overwhelmingly white, silver, grey and black with the occasional red or blue" and
// that a uniform hue wheel "was a fairground" — and each then drew its chromatic third from a
// uniform hue wheel. The achromatic half of each claim shipped; the chromatic half did not.
//
// What was missing was not the code, it was the TARGET: neither comment named a distribution and
// neither named a source, so there was nothing to be wrong against.
// `reference/sarasota/car-colour-census.json` is that source and `src/carpaint.js` is that table.
//
// THIS GATE EXISTS BECAUSE THE TABLE IS A CLAIM ABOUT PHOTOGRAPHS. Every other check over these
// modules is about triangles or determinism and would stay green for any colours at all.
import fs from 'node:fs';
import { paintFamily, PAINT_FAMILIES, PAINT_EXCLUDED } from '../src/carpaint.js';

const checks = [];
const check = (name, ok, detail) => { checks.push({ name, ok: !!ok, detail }); return !!ok; };

console.log('PAINT CENSUS GATE');
console.log('='.repeat(78));


/**
 * THE PAINT FAMILIES, AND THE DRAW COUNT THAT MUST NOT MOVE.
 *
 * #91: both fleets carried a comment saying a uniform hue wheel "was a fairground" and that the
 * reference is "overwhelmingly white, silver, grey and black with the occasional red or blue",
 * and both then drew their chromatic third from a uniform hue wheel. The achromatic half of each
 * claim shipped; the chromatic half did not. `src/carpaint.js` is now the one table both draw
 * from, and `reference/sarasota/car-colour-census.json` is its source.
 *
 * FOUR THINGS ARE ASSERTED HERE AND EACH IS A WAY THIS COULD SHIP BROKEN:
 *
 *   the table    the weights sum to 1 and the realised distribution matches them, swept finely
 *                enough to see a boundary that is off by a percent.
 *   the absence  cyan, violet, magenta, pink, yellow and orange never come out. That is the whole
 *                finding — 0 of 65 in the census — and a table that reintroduced any of them
 *                would still pass a weights-sum check.
 *   the draws    `src/traffic.js`'s chromatic branch takes EXACTLY TWO numbers from the seeded
 *                stream, as it did before. It shares that stream with `_chooseNext`, so a third
 *                draw moves every routing decision after it. CLAUDE.md records what that costs:
 *                "a change that perturbs a seeded sequence exposes content nothing has tested"
 *                took the building check from 0 of 215,960 car-frames to 342.
 *   both fleets  `src/streetfurniture.js` reaches the same table. Patching one module and leaving
 *                its sibling is the recurring shape of defect in this repo, and these two are the
 *                pair it has already happened to twice — the unnamed mesh, then the parked pool.
 */
const census = JSON.parse(fs.readFileSync(new URL('../reference/sarasota/car-colour-census.json',
  import.meta.url), 'utf8'));

console.log('\n=== PAINT — the families, their weights, and the draw count');
{
  const keys = ['white', 'silver', 'black', 'red', 'blue', 'beige', 'green'];
  const tot = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const f of census.frames) for (const k of keys) tot[k] += f[k];
  const n = keys.reduce((a, k) => a + tot[k], 0);
  const chrom = tot.red + tot.blue + tot.beige + tot.green;
  console.log(`  the census: ${census.frames.length} frames, ${n} vehicles — ` +
    `${n - chrom} achromatic (${(100 * (n - chrom) / n).toFixed(1)}%), ` +
    `${chrom} chromatic; red ${tot.red} blue ${tot.blue} beige ${tot.beige} green ${tot.green}`);
  check('the census this table is built on is present and is not empty',
    n >= 50 && chrom >= 5, `${n} vehicles, ${chrom} chromatic over ${census.frames.length} frames`);
  check('and it observed none of the families the table excludes, which is the finding',
    PAINT_EXCLUDED.every((f) => !(f in tot) || tot[f] === 0) && tot.green === 0,
    `excluded ${PAINT_EXCLUDED.join(', ')}; green ${tot.green} of ${n}`);
  /**
   * THE RULE OF THREE, printed because it is the bound the weights are chosen under: a family
   * never seen in n draws has a 95% upper bound of 3/n. Any weight this table gives an unobserved
   * family has to land under it, or the table is asserting something its source refuses.
   */
  const bound = 3 / n;
  const chromShare = 0.34;
  const greenW = PAINT_FAMILIES.find((f) => f.name === 'green').w;
  console.log(`  rule of three at n=${n}: an unobserved family is under ${(100 * bound).toFixed(1)}% ` +
    `of all cars; this table gives green ${(100 * greenW).toFixed(0)}% of a ~${(100 * chromShare).toFixed(0)}% ` +
    `chromatic third = ${(100 * greenW * chromShare).toFixed(1)}% of all cars`);
  check('green is kept but under the bound its own source supports, rather than deleted',
    greenW > 0 && greenW * chromShare < bound,
    `${(100 * greenW * chromShare).toFixed(1)}% against ${(100 * bound).toFixed(1)}%`);

  // ---- the table ----
  const sum = PAINT_FAMILIES.reduce((a, f) => a + f.w, 0);
  check('the family weights sum to exactly 1', Math.abs(sum - 1) < 1e-12, `${sum}`);
  const N = 200000;
  const got = {};
  for (let i = 0; i < N; i++) { const p = paintFamily(i / N); got[p.name] = (got[p.name] ?? 0) + 1; }
  console.log('  family          weight   realised   hue range');
  for (const f of PAINT_FAMILIES) {
    console.log(`    ${f.name.padEnd(14)}${(100 * f.w).toFixed(0).padStart(4)}%` +
      `${(100 * (got[f.name] ?? 0) / N).toFixed(2).padStart(10)}%   ` +
      `${f.h0.toFixed(3)}..${f.h1.toFixed(3)}  sat x${f.sat.toFixed(2)}`);
  }
  check('every family is reachable, so none is a line of table nothing draws',
    PAINT_FAMILIES.every((f) => (got[f.name] ?? 0) > 0),
    PAINT_FAMILIES.map((f) => `${f.name}:${got[f.name] ?? 0}`).join(' '));
  check('and each one comes out at its own weight, to a tenth of a percent',
    PAINT_FAMILIES.every((f) => Math.abs((got[f.name] ?? 0) / N - f.w) < 0.001),
    PAINT_FAMILIES.map((f) => `${f.name} ${(100 * (got[f.name] ?? 0) / N).toFixed(2)}%`).join(' '));

  /**
   * THE ABSENCE, measured as HUE rather than as a name — because a table could rename `cyan` to
   * `blue` and keep drawing it. Every hue the table can emit must fall in a band the census
   * actually observed. The excluded bands are the complement, and they are what the uniform wheel
   * spent 60% of its chromatic third in.
   */
  const EXCLUDED_BANDS = [
    ['yellow/orange', 0.13, 0.25],
    ['cyan', 0.45, 0.55],
    ['violet/magenta/pink', 0.70, 0.96],
  ];
  const hues = [];
  for (let i = 0; i < N; i++) hues.push(paintFamily(i / N).h);
  const inBand = EXCLUDED_BANDS.map(([name, a, b]) =>
    [name, hues.filter((h) => h >= a && h < b).length]);
  console.log(`  hues landing in an excluded band: ${inBand.map(([k, v]) => `${k} ${v}`).join(', ')}` +
    ` of ${N}`);
  check('no hue the table can emit lands in a band the census never observed',
    inBand.every(([, v]) => v === 0),
    inBand.map(([k, v]) => `${k}:${v}`).join(' '));
  /**
   * KNOWN-BAD: the uniform wheel it replaced, run through the same bands. Without this the check
   * above passes for a table that happens to be narrow, rather than for one that is aimed — and
   * the number it prints is the size of the defect.
   */
  const wheel = [];
  for (let i = 0; i < N; i++) wheel.push(i / N);
  const wheelIn = EXCLUDED_BANDS.map(([name, a, b]) =>
    [name, wheel.filter((h) => h >= a && h < b).length]);
  const wheelTotal = wheelIn.reduce((a, [, v]) => a + v, 0);
  console.log(`  KNOWN-BAD, the uniform wheel this replaced: ${wheelIn.map(([k, v]) =>
    `${k} ${(100 * v / N).toFixed(1)}%`).join(', ')} — ${(100 * wheelTotal / N).toFixed(1)}% of its ` +
    'chromatic third in families the census never saw');
  check('KNOWN-BAD: and the wheel it replaced put most of its chromatic third there',
    wheelTotal / N > 0.4, `${(100 * wheelTotal / N).toFixed(1)}%`);

  // ---- a non-finite or out-of-range draw cannot produce a black car ----
  const edge = [0, 1 - 1e-12, 1, 1.5, -0.25, NaN, Infinity];
  const bad = edge.filter((u) => {
    const p = paintFamily(u);
    return !p || !Number.isFinite(p.h) || p.h < 0 || p.h >= 1 || !Number.isFinite(p.sat);
  });
  console.log(`  edge inputs ${edge.map((u) => `${u}->${paintFamily(u).name}`).join(' ')}`);
  check('every input returns a usable hue, so no draw can reach setHSL as undefined',
    bad.length === 0, bad.join(', ') || `${edge.length} inputs`);

  /**
   * THE DRAW COUNT, measured by COUNTING THE DRAWS rather than by reading the diff. A counting
   * wrapper round the generator, one chromatic body and one achromatic body, against the figures
   * the old code took: two and two.
   */
  let draws = 0;
  const counting = (seq) => { let i = 0; return () => { draws++; return seq[i++ % seq.length]; }; };
  const colourFor = (seq) => {
    // The shipped expression, lifted verbatim from src/traffic.js's constructor so the two cannot
    // drift: if that block changes shape this stops compiling or stops matching, which is the
    // point. See the source check below, which asserts the lift is still faithful.
    const _r = counting(seq);
    const r = _r();
    const l = 0.34 + _r() * 0.26;
    if (r < 0.66) return { h: 0.58, s: 0.012 + r * 0.045, l };
    const paint = paintFamily(_r());
    return { h: paint.h, s: (0.26 + _r() * 0.18) * paint.sat, l };
  };
  draws = 0; colourFor([0.2, 0.5]);            const achroDraws = draws;
  draws = 0; colourFor([0.9, 0.5, 0.3, 0.7]);  const chromDraws = draws;
  console.log(`  draws per body: achromatic ${achroDraws}, chromatic ${chromDraws} ` +
    '(the hue-wheel version took 2 and 4)');
  check('the achromatic branch still takes two numbers from the stream', achroDraws === 2, `${achroDraws}`);
  check('and the chromatic branch still takes four, so no routing decision moves',
    chromDraws === 4, `${chromDraws}`);
  /**
   * AND THE LIFT ABOVE IS STILL THE SHIPPED EXPRESSION. A draw count measured on a copy is a
   * measurement of the copy — CLAUDE.md's "a module's own bookkeeping is not a measurement of the
   * module" — so the source is read and the two `this._r()` calls in the chromatic branch are
   * counted in the file itself.
   */
  const src = fs.readFileSync(new URL('../src/traffic.js', import.meta.url), 'utf8');
  const block = /const r = this\._r\(\);[\s\S]*?this\._setColorAt\(i, color\);/.exec(src);
  const calls = block ? (block[0].match(/this\._r\(\)/g) || []).length : -1;
  console.log(`  src/traffic.js's own colour block makes ${calls} calls to this._r()`);
  check('the shipped colour block makes the four stream calls this arm models',
    calls === 4, `${calls} calls to this._r() in the block`);

  /**
   * BOTH FLEETS REACH THE TABLE. The parked pool is the sibling that did not get the fix last
   * time — `src/streetfurniture.js` carried 31,500 triangles into the wrong bucket for 25 days
   * because `src/traffic.js` got a one-line fix and it did not.
   */
  const sfSrc = fs.readFileSync(new URL('../src/streetfurniture.js', import.meta.url), 'utf8');
  const importers = [['src/traffic.js', src], ['src/streetfurniture.js', sfSrc]]
    .filter(([, t]) => /from '\.\/carpaint\.js'/.test(t) && /paintFamily\(/.test(t));
  console.log(`  modules drawing from the table: ${importers.map(([f]) => f).join(', ')}`);
  check('both fleets draw from the one table, not one of them',
    importers.length === 2, importers.map(([f]) => f).join(', ') || 'none');
  check('and neither still has a bare uniform hue draw in its colour block',
    !/setHSL\(this\._r\(\)/.test(src) && !/setHSL\(\(h - 0\.66\) \/ 0\.34/.test(sfSrc),
    'no raw hue-wheel call in either');
}

// ---------------------------------------------------------------------------
/**
 * THE LIGHTNESS, which is the other half of the table and the half nothing had looked at.
 *
 * `src/carpaint.js` fixed WHICH HUES the chromatic third draws. It deliberately did not touch the
 * achromatic/chromatic split, because the census's 15.4% chromatic is a LOWER bound and you do not
 * move a figure your instrument cannot resolve. But the census resolves something else perfectly
 * well, because white, silver and black are exactly the families a coarse visual classifier is
 * good at:
 *
 *     white  29.2%      silver  20.0%      black  35.4%
 *
 * A white car is HSL lightness around 0.88 and a black one around 0.10. Both fleets draw:
 *
 *     src/traffic.js          l = 0.34 + r * 0.26          -> 0.34 .. 0.60
 *     src/streetfurniture.js  l = 0.26 + ((h*7)%1) * 0.4   -> 0.26 .. 0.66
 *
 * **Neither range can produce a white car or a black one.** They cover the SILVER band and paint
 * the other 64.6% of the real achromatic population mid-grey. That is not a subtle distributional
 * point: it is why every car in a frame is the same tone.
 *
 * AND IT WAS FROZEN ON PURPOSE, FOR A REASON THAT HAS EXPIRED. `src/streetfurniture.js` says so in
 * as many words — "LIGHTNESS IS DELIBERATELY UNCHANGED from the hue-wheel version it replaced -
 * only hue and saturation move. The first cut also widened the lightness range, which repainted
 * the probe's own pinned subject and made vGrad, spec and edges incomparable across the round: a
 * confound I introduced into the very A/B I was running." Correct at the time, and a statement
 * about that round's A/B rather than about what the range should be. The same shape as the
 * glazing's `uGlassEnvExtra` at 2: unfinished, not wrong.
 *
 * This section does not fix it — it MEASURES the gap and fails if it is ever closed silently, so
 * the next round starts from the number instead of re-deriving it.
 */
console.log('\n=== LIGHTNESS — the half of the table nothing had looked at');
{
  const src = fs.readFileSync(new URL('../src/traffic.js', import.meta.url), 'utf8');
  const sf = fs.readFileSync(new URL('../src/streetfurniture.js', import.meta.url), 'utf8');
  /** Read the range out of the SOURCE, never retyped: a probe that hardcodes it cannot see a fix. */
  const rangeOf = (text, re) => {
    const m = re.exec(text);
    return m ? { lo: +m[1], span: +m[2], hi: +m[1] + +m[2] } : null;
  };
  const t = rangeOf(src, /const l = ([\d.]+) \+ this\._r\(\) \* ([\d.]+);/);
  const f = rangeOf(sf, /const l = ([\d.]+) \+ \(\(h \* 7\) % 1\) \* ([\d.]+);/);
  console.log(`  src/traffic.js          lightness ${t ? `${t.lo} .. ${t.hi.toFixed(2)}` : 'NOT FOUND'}`);
  console.log(`  src/streetfurniture.js  lightness ${f ? `${f.lo} .. ${f.hi.toFixed(2)}` : 'NOT FOUND'}`);
  check('both fleets state a lightness range this gate can read from the source',
    t !== null && f !== null, `traffic ${JSON.stringify(t)}, parked ${JSON.stringify(f)}`);

  const keys = ['white', 'silver', 'black', 'red', 'blue', 'beige', 'green'];
  const tot = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const fr of census.frames) for (const k of keys) tot[k] += fr[k];
  const n2 = keys.reduce((a, k) => a + tot[k], 0);
  // Representative HSL lightness for each family, which is what the draw has to be able to reach.
  const WHITE_L = 0.85, BLACK_L = 0.15;
  const unreachable = (100 * (tot.white + tot.black) / n2);
  console.log(`  the census: white ${(100 * tot.white / n2).toFixed(1)}%, ` +
    `silver ${(100 * tot.silver / n2).toFixed(1)}%, black ${(100 * tot.black / n2).toFixed(1)}%` +
    ` — a white car is L~${WHITE_L}, a black one L~${BLACK_L}`);
  const reachesWhite = t.hi >= WHITE_L && f.hi >= WHITE_L;
  const reachesBlack = t.lo <= BLACK_L && f.lo <= BLACK_L;
  console.log(`  neither fleet reaches white (${t.hi.toFixed(2)}/${f.hi.toFixed(2)} against ` +
    `${WHITE_L}) or black (${t.lo}/${f.lo} against ${BLACK_L}): ` +
    `${unreachable.toFixed(1)}% of the real population has no tone in either draw`);
  /**
   * ASSERTED AS A KNOWN GAP, not as a pass. The two checks below record the state and will FAIL if
   * the ranges are widened — which is the point: whoever widens them has to come here, read the
   * census, and restate the bound with the new numbers. A gate is never loosened silently.
   */
  check('KNOWN GAP: neither fleet can draw a white car, which is 29.2% of the real population',
    !reachesWhite, `traffic tops out at ${t.hi.toFixed(2)}, parked at ${f.hi.toFixed(2)}, ` +
    `white is L~${WHITE_L}`);
  check('KNOWN GAP: and neither can draw a black one, which is another 35.4%',
    !reachesBlack, `traffic floors at ${t.lo}, parked at ${f.lo}, black is L~${BLACK_L}`);
  check('so the gap is most of the achromatic population, which is most of the fleet',
    unreachable > 50, `${unreachable.toFixed(1)}% unreachable`);
}

console.log('\n' + '='.repeat(78));
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
// Counted HERE, at the point of use, never snapshotted earlier: see CLAUDE.md, "A gate printed
// three FAIL lines and said PASS".
const failed = checks.filter((c) => !c.ok);
console.log(`\nPAINT CENSUS: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}`
  : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
