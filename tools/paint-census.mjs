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
import { paintFamily, PAINT_FAMILIES, PAINT_EXCLUDED,
  paintTone, PAINT_TONES, ACHROMATIC_SHARE } from '../src/carpaint.js';
import { buildCarGlowGeometry, buildTrafficCarGeometry, SURFACE,
  paintTintOnly } from '../src/carbody.js';

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
    const u = _r();
    if (r < ACHROMATIC_SHARE) return { h: 0.58, s: 0.012 + r * 0.045, l: paintTone(u).l };
    const paint = paintFamily(_r());
    return { h: paint.h, s: (0.26 + _r() * 0.18) * paint.sat, l: 0.34 + u * 0.26 };
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
console.log('\n=== TONE — the half of the table nothing had looked at, now measured');
{
  const src = fs.readFileSync(new URL('../src/traffic.js', import.meta.url), 'utf8');
  const sf = fs.readFileSync(new URL('../src/streetfurniture.js', import.meta.url), 'utf8');

  const keys = ['white', 'silver', 'black', 'red', 'blue', 'beige', 'green'];
  const tot = Object.fromEntries(keys.map((k) => [k, 0]));
  for (const fr of census.frames) for (const k of keys) tot[k] += fr[k];
  const n2 = keys.reduce((a, k) => a + tot[k], 0);
  const achroN = tot.white + tot.silver + tot.black;

  /**
   * THE ANCHORS ARE THE SAME TWO NUMBERS THE OLD KNOWN GAP WAS WRITTEN AGAINST, deliberately.
   * This section used to assert that NEITHER fleet could reach them and would FAIL if the ranges
   * were widened, so that whoever widened them had to come here and restate the bound. This is
   * that restatement, against the same L~0.85 / L~0.15 it refused before — a gate is never
   * loosened silently, and the cheapest proof that it was not is that the bound did not move.
   *
   * They are HSL lightness in three's WORKING colour space, which for an unsaturated colour is a
   * linear albedo. A white car's paint is about 0.80 and a black car's about 0.05, so these are
   * the loose end of each: anything over 0.85 is unambiguously a white car and anything under
   * 0.15 unambiguously a black one.
   */
  const WHITE_L = 0.85, BLACK_L = 0.15;
  const toneLo = Math.min(...PAINT_TONES.map((t) => t.l0));
  const toneHi = Math.max(...PAINT_TONES.map((t) => t.l1));
  console.log(`  the census: white ${(100 * tot.white / n2).toFixed(1)}%, ` +
    `silver ${(100 * tot.silver / n2).toFixed(1)}%, black ${(100 * tot.black / n2).toFixed(1)}%` +
    ` — a white car is L~${WHITE_L}, a black one L~${BLACK_L}`);
  console.log(`  the table:  ${PAINT_TONES.map((t) => `${t.name} ${(100 * t.w).toFixed(1)}% ` +
    `l ${t.l0.toFixed(3)}..${t.l1.toFixed(3)}`).join(', ')}`);
  console.log(`  span ${toneLo.toFixed(3)} .. ${toneHi.toFixed(3)}, where the ranges this ` +
    'replaced were 0.34..0.60 (traffic) and 0.26..0.66 (parked)');
  check('RESTATED: the fleet can now draw a white car, which is 29.2% of the real population',
    toneHi >= WHITE_L, `the table tops out at ${toneHi.toFixed(3)} against L~${WHITE_L}`);
  check('RESTATED: and a black one, which is another 35.4%',
    toneLo <= BLACK_L, `the table floors at ${toneLo.toFixed(3)} against L~${BLACK_L}`);
  check('KNOWN-BAD: and the two ranges it replaced reached neither',
    0.60 < WHITE_L && 0.66 < WHITE_L && 0.34 > BLACK_L && 0.26 > BLACK_L,
    'traffic 0.34..0.60 and parked 0.26..0.66');

  /**
   * THE WEIGHTS ARE THE CENSUS'S OWN COUNTS. Not "roughly", to the percent — unlike the chromatic
   * families, where n=10 could not support 50/40/10 and the table rounds toward the middle. Here
   * n=55 and there is nothing to round away from.
   */
  const want = { white: tot.white / achroN, silver: tot.silver / achroN, black: tot.black / achroN };
  const worstW = Math.max(...PAINT_TONES.map((t) => Math.abs(t.w - want[t.name])));
  console.log(`  weights against the census's own achromatic counts ` +
    `(${tot.white}/${tot.silver}/${tot.black} of ${achroN}): ` +
    PAINT_TONES.map((t) => `${t.name} ${t.w.toFixed(3)} vs ${want[t.name].toFixed(3)}`).join(', '));
  check('the tone weights are the census counts to under a percentage point',
    worstW < 0.01, `worst off by ${worstW.toFixed(4)}`);

  /** Both call sites reach the table, and the parked pool is the sibling that got missed before. */
  const usesTone = [['src/traffic.js', src], ['src/streetfurniture.js', sf]]
    .filter(([, t]) => /paintTone\(/.test(t) && /ACHROMATIC_SHARE/.test(t));
  check('both fleets draw their tone from the one table',
    usesTone.length === 2, usesTone.map(([f]) => f).join(', ') || 'none');
  check('and neither keeps its own flat lightness range any more',
    !/const l = 0\.34 \+ this\._r\(\)/.test(src) && !/const l = 0\.26 \+ \(\(h \* 7\) % 1\)/.test(sf),
    'no bare lightness literal in either colour block');
  check('and neither keeps its own copy of the achromatic share',
    !/\br < 0\.66\b/.test(src) && !/\bh < 0\.66\b/.test(sf),
    `both read ACHROMATIC_SHARE = ${ACHROMATIC_SHARE}`);
}

/**
 * === THE PAINT-SLOT TINT, which is what makes the range above safe to widen.
 *
 * `instanceColor` multiplies EVERY vertex of an instance, so before this the plate, the lamps,
 * the rims, the tyres and the glass all carried the body's tone. At the OLD range that was a
 * x2.27 error on the plate and it was filed as #1 at x0.41 of a real plate. At the NEW range it
 * would have been a black plate on a black car — 0.0233 against a real plate's ~0.80, x0.029.
 * So the two changes are one change, and this section is the half that cannot be seen in a
 * colour histogram.
 */
console.log('\n=== THE PAINT-SLOT TINT — what instanceColor is still allowed to reach');
{
  const cb = fs.readFileSync(new URL('../src/carbody.js', import.meta.url), 'utf8');
  const tint = paintTintOnly();
  console.log(`  uPaintTintOnly ${tint.value}, tinted slot ${tint.tintedSlot} of ${tint.slots}`);
  check('the tint is live in the shipped build, and it is the paint slot it keeps',
    tint.value === 1 && tint.tintedSlot === SURFACE.paint, JSON.stringify(tint));

  /** Which palette slot each vertex points at, read off the built buffer rather than the source. */
  const slotsOf = (geo) => {
    const uv = geo.attributes.uv;
    const seen = new Map();
    for (let i = 0; i < uv.count; i++) {
      const slot = Math.round(uv.getX(i) * tint.slots - 0.5);
      seen.set(slot, (seen.get(slot) ?? 0) + 1);
    }
    return seen;
  };
  /**
   * THE LAMP SPILL MUST STAY TINTED, and it does only because every vertex of it is on slot 0.
   * `src/traffic.js` writes `setColorAt(i, setScalar(f))` on the glow mesh to carry a per-car
   * BRIGHTNESS rather than a colour — so a vertex of that geometry on any other slot would
   * silently stop responding to the car's own headlamps, with nothing to see but a pool that no
   * longer dims. This is the check for it, and it is the reason this section exists at all.
   */
  const glow = slotsOf(buildCarGlowGeometry({}));
  const glowOff = [...glow.entries()].filter(([k]) => k !== SURFACE.paint);
  console.log(`  buildCarGlowGeometry: ${[...glow.entries()]
    .map(([k, n]) => `slot ${k} x${n}`).join(', ')}`);
  check('every vertex of the lamp spill is on the paint slot, so its per-car brightness survives',
    glowOff.length === 0, glowOff.map(([k, n]) => `slot ${k} x${n}`).join(', ') || 'all slot 0');

  /**
   * AND THE TINT HAS TO REACH SOMETHING. A rule that confines instanceColor to slot 0 does
   * nothing at all if the car is entirely slot 0 — the check above would still pass, for the most
   * flattering possible reason. So: how much of a traffic car escapes, and are the named surfaces
   * #1 is about among them.
   */
  const car = slotsOf(buildTrafficCarGeometry({}));
  const total = [...car.values()].reduce((a, b) => a + b, 0);
  const painted = car.get(SURFACE.paint) ?? 0;
  console.log(`  buildTrafficCarGeometry: ${total} vertices, ${painted} on the paint slot, ` +
    `${total - painted} (${(100 * (total - painted) / total).toFixed(1)}%) escaping the tint`);
  console.log(`    ${[...car.entries()].sort((a, b) => a[0] - b[0])
    .map(([k, n]) => `${Object.keys(SURFACE).find((x) => SURFACE[x] === k) ?? k} x${n}`).join(', ')}`);
  check('a real share of the car escapes the tint, so the rule is not a no-op',
    total - painted > total * 0.1, `${(100 * (total - painted) / total).toFixed(1)}% of ${total}`);
  /**
   * The slot names are the TRAFFIC car's, not the player's, and the first version of this check
   * had `rim` and read 0 vertices. Slot 9 is the player's alloy; the ambient fleet is on slot 13,
   * `rimCoarse`, which exists precisely so that fixing the ambient fleet cannot touch the player's
   * car. Reading the names off the built buffer rather than off an assumption is what caught it.
   */
  for (const name of ['plate', 'headlight', 'taillight', 'rimCoarse', 'tyre', 'glassy']) {
    check(`and the ${name} is among them, which is what #1 was about`,
      (car.get(SURFACE[name]) ?? 0) > 0, `${car.get(SURFACE[name]) ?? 0} vertices`);
  }

  /**
   * THE INJECTION ITSELF. A shader change that silently matches nothing is this project's
   * recorded failure mode — `onBeforeCompile` hands back unresolved includes, and the assertion
   * inside the patch cannot run on a compile three skips because it already has a program under
   * the old cache key. So: the seam is asserted in the source, and the key is asserted to have
   * MOVED from the one the previous injection shipped under.
   */
  check('the shader asserts its own seam rather than replacing blind',
    /color_vertex include not found/.test(cb), 'COLOR_VERTEX_DECL throw present');
  check('the tint is derived from uv.x, which IS the palette slot, rather than from a list',
    /floor\(\s*uv\.x \* 16\.0\s*\)/.test(cb), 'floor( uv.x * 16.0 )');
  check('and the program cache key moved, or three would hand back the old program',
    /carLensFalloff4tint/.test(cb) && !/'carLensFalloff3env'/.test(cb), 'carLensFalloff4tint');
}

console.log('\n' + '='.repeat(78));
for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
// Counted HERE, at the point of use, never snapshotted earlier: see CLAUDE.md, "A gate printed
// three FAIL lines and said PASS".
const failed = checks.filter((c) => !c.ok);
console.log(`\nPAINT CENSUS: ${failed.length ? `FAIL — ${failed.length} of ${checks.length}`
  : `PASS — ${checks.length} checks`}`);
process.exit(failed.length ? 1 : 0);
