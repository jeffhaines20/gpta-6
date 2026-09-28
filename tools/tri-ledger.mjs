// Can the budget gate resolve the change you are about to defend?
//
// The gate reports a triangle "p95" and a WARN line, and a round that reads WARN
// then spends hours proving it is not to blame. This tool answers the question
// before the box does, by separating what is ARITHMETIC from what is SAMPLING.
//
// The arithmetic side is exact: district building geometry is deterministic
// (tools/frontage-stats.mjs walks it offline) and a car is a fixed mesh, so a
// fleet's contribution is fleet x tris/car. Nothing in either depends on when a
// sampler fired.
//
// The sampling side is where the gate's number comes from, and it is much weaker
// than "p95" suggests. From a real run:
//
//   frames sampled     51 over 53.5 s          dt 1.05 s per sample
//   triangles          min 563,766  max 868,617   range 41% of the p50
//   so the "p95"       is the 3rd-highest frame of 51
//
// A near-maximum over 51 coarse samples of a quantity that swings 41% is not a
// percentile in any useful sense: which frames land in the top three depends on
// where the drive happened to be when the sampler fired, which depends on load.
// That is why the same configuration has measured 20,649 and 23,242 apart.
//
//   node tools/tri-ledger.mjs docs/drive-traffic.json --baseline 828184
//   node tools/tri-ledger.mjs --selftest
import fs from 'node:fs';

const args = process.argv.slice(2);
/** The gate's own precision on a clean box, and its spread under contention. See `noise` below. */
const CLEAN_SPREAD = 934, DIRTY_SPREAD = 20000;
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

/**
 * How coarse is a percentile taken over `n` samples?
 * Returns the rank from the top that `p` actually selects, by nearest rank —
 * the same rule tools/bay-legibility.mjs's pct() uses.
 */
export function rankFromTop(n, p) {
  if (n < 1) return 0;
  const idx = Math.min(n - 1, Math.max(0, Math.round(p * (n - 1))));
  return n - idx;
}

/**
 * Is a measured gap explainable by the deterministic change, or is it sampling?
 * `noise` is the gate's own documented run-to-run spread for this metric.
 */
export function verdict(measured, expected, noise) {
  const gap = measured - expected;
  if (Math.abs(gap) <= noise) return { gap, call: 'WITHIN SAMPLING NOISE' };
  return { gap, call: gap > 0 ? 'EXCEEDS NOISE — investigate' : 'BELOW EXPECTED — investigate' };
}

if (has('--selftest')) {
  let bad = 0;
  const say = (ok, w) => { if (!ok) bad++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${w}`); };

  // 1. THE POINT OF THE TOOL. A p95 over 51 samples is the 3rd-highest, not a
  //    tail statistic. Over 1000 samples it is the 51st. If this ever reads 1
  //    for a large n the rule has been changed to "max" and every historical
  //    number would silently mean something else.
  say(rankFromTop(51, 0.95) === 3, `p95 of 51 samples is the 3rd-highest: ${rankFromTop(51, 0.95)}`);
  say(rankFromTop(1000, 0.95) === 51, `p95 of 1000 samples is the 51st: ${rankFromTop(1000, 0.95)}`);
  // I asserted 1 here first and it is 2 — round(0.95*19) = 18, so 20-18 = 2.
  // Left as the real numbers rather than the ones I expected: the point of the
  // check is the rank a small n actually gives, and guessing it is how the
  // "p95" gets read as a tail statistic in the first place.
  say(rankFromTop(20, 0.95) === 2, `p95 of 20 samples is the 2nd-highest: ${rankFromTop(20, 0.95)}`);
  say(rankFromTop(11, 0.95) === 1, `p95 of 11 samples IS the maximum: ${rankFromTop(11, 0.95)}`);
  say(rankFromTop(1, 0.95) === 1, 'a single sample degenerates to itself');

  // 2. The verdict must not call a real regression noise, nor noise a regression.
  //    Known-bad input: a gap of exactly the noise band is noise; one at twice
  //    it is not.
  say(verdict(830000, 828000, 20000).call === 'WITHIN SAMPLING NOISE',
    'a 2,000 gap against 20,000 of noise is noise');
  say(verdict(880000, 828000, 20000).call === 'EXCEEDS NOISE — investigate',
    'a 52,000 gap against 20,000 of noise is not');
  say(verdict(828000, 828000, 0).call === 'WITHIN SAMPLING NOISE',
    'an exact match with zero noise still passes');

  /**
   * 3. THE TWO BANDS, AND WHAT I GOT WRONG SETTING THEM UP.
   *
   * I added these expecting the contention band to EXCUSE the WARN that was explained away, and
   * asserted `verdict(851836, 830000, 20000)` would read as noise. It failed: that gap is 21,836
   * and even 20,000 rejects it.
   *
   * The check was wrong, not the record. CLAUDE.md's account is that the round was "right about
   * the DELTA and wrong about the BASELINE" — it compared 851,836 against its own ASSUMED
   * baseline, not against the 830,000 warn line, and against that assumption the gap was small
   * enough for 20,000 to swallow. I had computed the gap from the wrong pair of numbers, which is
   * the same mistake that story is about, arriving in the check written to pin it.
   *
   * What the bands are actually worth is the range where they DISAGREE, and that is what the
   * default decides: a 5,000 gap is noise on a loaded box and a regression on a clean one, and a
   * ~1,900-triangle change — the size this project ships — is invisible at 20,000 and resolvable
   * at 934. Both bands reject 21,836, which is worth pinning too, because it means that WARN was
   * never inside either.
   */
  say(verdict(851836, 830000, DIRTY_SPREAD).call === 'EXCEEDS NOISE — investigate',
    'even the contention band rejects the 21,836 WARN that was explained away');
  say(verdict(851836, 830000, CLEAN_SPREAD).call === 'EXCEEDS NOISE — investigate',
    'and the clean band rejects it far more decisively');
  say(verdict(835000, 830000, DIRTY_SPREAD).call === 'WITHIN SAMPLING NOISE'
    && verdict(835000, 830000, CLEAN_SPREAD).call === 'EXCEEDS NOISE — investigate',
    'a 5,000 gap is where the two bands actually disagree');
  say(verdict(831900, 830000, CLEAN_SPREAD).call === 'EXCEEDS NOISE — investigate'
    && verdict(831900, 830000, DIRTY_SPREAD).call === 'WITHIN SAMPLING NOISE',
    'a 1,900-triangle change is resolvable on a clean box and invisible on a dirty one');
  say(DIRTY_SPREAD > CLEAN_SPREAD * 20, 'the two bands differ by more than a factor of 20');

  console.log(bad ? `\n${bad} SELFTEST FAILURE(S)` : '\nselftest ok');
  process.exit(bad ? 1 : 0);
}

const file = args.find((a) => !a.startsWith('--')) ?? 'docs/drive-traffic.json';
const baseline = +val('--baseline', NaN);
/**
 * THE NOISE BAND DEFAULTED TO THE DIRTY-BOX FIGURE, and that is the number this project has
 * already been burned by once. 20,000 was measured while other agents' headless browsers were
 * alive; a WARN at 851,836 was then explained away as sampling noise on the strength of it, and
 * the WARN was real the whole time. Three runs of identical code on a box with no browsers and no
 * orphaned servers:
 *
 *     p95   852,605   851,671   852,605     spread    934  (0.11%)
 *     p50   705,037   705,037   705,153     spread    116
 *     min   562,399   562,399   562,399     spread      0
 *
 * So 20,000 is a statement about CONTENTION and 934 is the gate's own precision. Defaulting to
 * the contention figure means the tool's first answer is its least discriminating one: at 20,000 a
 * ~1,900-triangle change is invisible, and at 934 it is resolvable.
 *
 * `--dirty` restores the contention band for a reading taken on a loaded box, and the tool now
 * says which one it used and what that assumes, because a band without its box is not a bound.
 */
const dirty = has('--dirty');
const noise = +val('--noise', dirty ? DIRTY_SPREAD : CLEAN_SPREAD);
const j = JSON.parse(fs.readFileSync(new URL('../' + file.replace(/^\.\//, ''), import.meta.url)));
const r = j.result ?? j;
const t = r.triangles;
const n = r.frames_sampled;

console.log(`run                  ${file}`);
console.log(`mode                 ${r.mode}`);
console.log('');
console.log('SAMPLING — how much of the gate number is timing');
console.log(`  frames sampled     ${n} over ${r.route_duration_s} s  (dt ${(r.route_duration_s / n).toFixed(2)} s per sample)`);
console.log(`  triangles          min ${t.min.toLocaleString()}  p50 ${t.p50.toLocaleString()}  p95 ${t.p95.toLocaleString()}  max ${t.max.toLocaleString()}`);
console.log(`  range              ${(t.max - t.min).toLocaleString()} = ${((t.max - t.min) / t.p50 * 100).toFixed(0)}% of the p50`);
const rk = rankFromTop(n, 0.95);
const ord = rk === 1 ? 'highest' : rk === 2 ? '2nd-highest' : rk === 3 ? '3rd-highest' : `${rk}th-highest`;
console.log(`  the "p95" is       the ${ord} frame of ${n}` +
  (rk <= 3 ? '  <-- a near-maximum, not a tail statistic' : ''));
console.log(`  resident chunks    NEAR p50 ${r.lod_near.p50} p95 ${r.lod_near.p95}, FAR p50 ${r.lod_far.p50} p95 ${r.lod_far.p95}`);
console.log(`                     the triangle count tracks these, and how many are`);
console.log(`                     resident at a sampled frame is a timing question.`);
if (r.traffic) console.log(`  fleet              ${r.traffic.fleet} cars`);

if (Number.isFinite(baseline)) {
  console.log('');
  console.log('ARITHMETIC — what the change is actually worth');
  console.log(`  baseline p95       ${baseline.toLocaleString()}`);
  console.log(`  pass --delta to state the deterministic change; then:`);
  const delta = +val('--delta', 0);
  const expected = baseline + delta;
  const v = verdict(t.p95, expected, noise);
  console.log(`  deterministic      ${delta >= 0 ? '+' : ''}${delta.toLocaleString()}`);
  console.log(`  expected p95       ${expected.toLocaleString()}`);
  console.log(`  measured p95       ${t.p95.toLocaleString()}`);
  console.log(`  unexplained        ${v.gap >= 0 ? '+' : ''}${v.gap.toLocaleString()}  -> ${v.call}` +
    `  (noise band +/-${noise.toLocaleString()})`);
  const named = args.includes('--noise');
  console.log(`  the band assumes    ${named ? 'the value you passed'
    : dirty ? 'a LOADED box — 20,000 is contention, not the gate'
      : 'a CLEAN box — no browsers, no orphaned servers'}`);
  if (!named && !dirty) {
    console.log('  if anything else was running, this band is too tight: re-run --dirty, or');
    console.log('  better, clean the box and take the gate three times (CLAUDE.md says why).');
  }
}
