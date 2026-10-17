// Draw-call / geometry budget gate. Phase 1's Risk 1 was that submission cost,
// not triangle count, is the wall; this turns that from a worry into a build
// failure. Thresholds are deliberately tight enough to bite before content grows.
// Thresholds re-derived 2026-08-29 against the first fully textured district
// (binding constraint 4). Measured worst cases, all with 60 civilian + 10 pursuit:
//   chase harness p95 114 / max ~125 calls, 60.9k tris
//   drive-through p95 111 / max 121 calls
//   9 static route cameras at 1920x1080, max 112 calls / 37.1k tris
// Draw-call thresholds are TIGHTENED from the Phase 1b values (260/400), which
// were set against untextured extrusions. warn ~1.6x and fail ~2.5x the measured
// worst leave room for signage, sky, rain and mission props while still failing
// on a structural regression such as losing instancing or per-object materials.
// Stall and heap are principled rather than measured: 16 ms is one 60 Hz frame.
// RE-DERIVED 2026-09-01, because the gated quantity changed underneath these
// numbers. Until now the gate could not see the shadow pass at all: three.js
// counts every shadow-map draw call into renderer.info and then calls
// info.reset() before the opaque pass, so what the gate sampled was the colour
// pass alone. Enabling street-furniture casters took the scene from 84 to 331
// caster meshes and moved the reported draw-call number by ZERO. src/post.js now
// takes info.autoReset itself, so draw calls and triangles include shadows.
//
// That is not a regression, it is the same frame honestly counted. Measured worst
// over three drive-through circuits with traffic, same commit:
//
//   draw calls  p95 228, max 241   (was p95 167 counting the colour pass only)
//   triangles   p95 726,597, max 760,689   (was p95 ~351,000)
//
// The thresholds are re-derived two ways and the TIGHTER is taken for each, so
// this cannot become a quiet loosening:
//
//   (a) this file's own documented rule - warn ~1.6x and fail ~2.5x the measured
//       worst: draw 386 / 602, triangles 1,217,000 / 1,902,000.
//   (b) preserving the headroom the project has actually been operating under -
//       old p95 sat at 0.835 of warn and 0.522 of fail for draw calls, 0.878 and
//       0.390 for triangles: draw 273 / 437, triangles 828,000 / 1,863,000.
//
// Tighter of the two, rounded: draw 275 / 440, triangles 830,000 / 1,850,000.
//
// Worth stating plainly: under (b) the triangle warn had only 13% headroom left
// on the OLD metric, so that threshold was close to firing on ordinary content
// growth before any of this. Whether the gate should be tightened further is a
// separate decision from counting the pass it was missing, and is not made here.
//
// DECIDED 2026-10-17 (#64): TRIANGLES ARE BOUNDED BY DERIVATION (a), THE CAPABILITY BOUND, on a new
// baseline. The owner chose (a) after #75 showed that (b) recomputed always lands 14% above the p95
// it is derived from, so it can fire only by being frozen: a growth detector with a date on it,
// not a bound on anything. The baseline moved in the same change, because the course did:
// drive-through drives the road graph now, body collision on, one full lap (see its header), on the
// right side of the road (#127). Three runs of it on an idle box, at commit 6b47266, measured
//
//   triangles   p95 832,174 / 834,484 / 845,957   max 872,882 / 875,880 / 861,880
//   draw calls  p95 225 / 225 / 236   max 252 / 253 / 243
//   frames 277 / 261 / 270, 3,158 / 3,153 / 3,128 m driven, 1 / 1 / 1 stuck-teleports
//   the drive's net repaired 4 / 6 / 3 times and cleared heat 6 / 10 / 3 times; the artifacts say why
//
// so warn = 1.6 x the worst max and fail = 2.5 x it, ROUNDED DOWN to 10,000 so the rounding cannot
// loosen it further: 1,400,000 / 2,180,000. The thresholds are typed below beside the BASELINE they
// come from, and the selftest re-derives them, so a hand edit to either fails it.
//
// DRAW CALLS ARE NOT MOVED. The decision was about triangles; draw calls are the metric this header
// names as the wall, they are still derivation (b), and on the new course their p95 sits under the
// 275 warn. Whether they should follow is a separate call, and it is not made here.
export const BASELINE = Object.freeze({
  date: '2026-10-17', course: 'roads', bodyCollision: true, runs: 3,
  triangles: Object.freeze({ p95: Object.freeze([832174, 834484, 845957]), max: Object.freeze([872882, 875880, 861880]) }),
  drawCalls: Object.freeze({ p95: Object.freeze([225, 225, 236]), max: Object.freeze([252, 253, 243]) }),
});
export const BUDGET = {
  drawCalls:      { warn: 275, fail: 440 },
  triangles:      { warn: 1400000, fail: 2180000 },   // (a) of BASELINE, rounded down; see above
  chunkStallMs:   { warn: 8, fail: 16 },      // one frame at 60 Hz is 16.7 ms
  heapGrowthMb:   { warn: 40, fail: 120 },    // across three full circuits
};

export function assess(name, value, spec) {
  if (value >= spec.fail) return { name, value, ...spec, status: 'FAIL' };
  if (value >= spec.warn) return { name, value, ...spec, status: 'WARN' };
  return { name, value, ...spec, status: 'PASS' };
}

// Metrics that a shared CI runner cannot measure validly.
//
// Eleven serial runs on a dedicated container measured chunk stall spanning
// 5.3-24.2 ms on UNCHANGED code, while draw calls reproduced to within 1.3% and
// triangles to 0.2%. A hosted runner is noisier than that box, so gating on stall
// there produces red builds on good code - and a gate that cries wolf is worse
// than no gate, because people learn to click through it.
//
// This is deliberately NOT a threshold change. BUDGET.chunkStallMs stays 8/16 and
// is enforced in full everywhere it can be measured. What ADVISORY does is scope
// where a metric is allowed to decide a build, and it is opt-in: unset, every
// metric gates exactly as before. Only the CI workflow sets it, and CI does not
// get to certify a milestone - stall verdicts still require N>=5 local runs.
//
// Logged in PROGRESS.md under the Threshold change log.
export const ADVISORY_ENV = 'BUDGET_ADVISORY';

export function advisoryFromEnv(env = process.env) {
  return (env[ADVISORY_ENV] || '').split(',').map((s) => s.trim()).filter(Boolean);
}

export function gate(results, opts = {}) {
  const advisory = opts.advisory ?? advisoryFromEnv();
  const rows = results.map(({ name, value, spec }) => {
    const r = assess(name, value, spec);
    r.advisory = advisory.includes(r.name);
    return r;
  });
  const deciding = rows.filter((r) => !r.advisory);
  const worst = deciding.some((r) => r.status === 'FAIL') ? 'FAIL'
    : deciding.some((r) => r.status === 'WARN') ? 'WARN' : 'PASS';
  return { status: worst, rows, advisory,
    /**
     * HEADROOM AGAINST THE WARN AS WELL AS THE FAIL, because against the fail alone it reads
     * comfortable on a row that is already over. CLAUDE.md has recorded that for several rounds
     * — "the gate's own headroom % column is measured against the FAIL line, not the WARN line,
     * so it reads comfortable while the warn line is close" — and the code still only had the
     * fail figure. On the committed artifact the triangle row reads:
     *
     *     value 852,605   warn 830,000   fail 1,850,000
     *     headroom vs fail   53.9%        the only number this printed
     *     headroom vs warn   -2.7%        the row's actual status, which is WARN
     *
     * A gate that prints 53.9% beside the word WARN is inviting the reader to explain the WARN
     * away, and this file's own history is a round that did exactly that.
     *
     * `headroomPct` keeps its name and its meaning so nothing reading the JSON breaks; the warn
     * figure is added beside it and is the one `printGate` leads with.
     */
    headroom: rows.map((r) => ({
      name: r.name, value: r.value, warnAt: r.warn, failAt: r.fail, advisory: r.advisory,
      headroomPct: +(((r.fail - r.value) / r.fail) * 100).toFixed(1),
      warnHeadroomPct: +(((r.warn - r.value) / r.warn) * 100).toFixed(1),
    })) };
}

/**
 * THE TWO DERIVATIONS, COMPUTED RATHER THAN QUOTED. This file's header records them as prose and
 * nothing recomputes them, so #75 — "the triangle warn is derivation (b), a headroom ratchet,
 * and its own comment predicted this" — has been argued from a 2026-09-01 sentence ever since.
 *
 *   (a) the file's own documented rule: warn 1.6x and fail 2.5x the measured WORST (the max, not
 *       the p95 — 760,689 x 1.6 = 1,217,102 is where the header's figure comes from). This is a
 *       CAPABILITY bound: it asks whether submission cost is near the wall.
 *   (b) preserving the headroom the project was operating under: warn = p95 / 0.878. This is a
 *       RATCHET: it pins the threshold to a ratio of whatever the content was on the day, so it
 *       fires on ordinary growth and says nothing about capability.
 *
 * The shipped thresholds take the tighter of the two, which is (b) for triangles. The header's
 * last paragraph deferred the question of whether that is the right choice and said so plainly;
 * this function is so the next round reads the answer instead of recomputing the inputs.
 *
 * NO THRESHOLD MOVES HERE. A gate is never loosened silently, and choosing between (a) and (b)
 * is the deferred decision rather than a measurement.
 */
export function derivations(p95, max, operatingRatio = 0.878) {
  return {
    a: { warn: Math.round(max * 1.6), fail: Math.round(max * 2.5), kind: 'capability bound' },
    b: { warn: Math.round(p95 / operatingRatio), fail: null, kind: 'headroom ratchet' },
  };
}

export function printGate(g) {
  console.log(`\nBUDGET GATE: ${g.status}`);
  for (const r of g.rows) {
    const tag = r.advisory ? `${r.status} (advisory, not gating)` : r.status;
    const wh = ((r.warn - r.value) / r.warn) * 100;
    console.log(`  ${tag.padEnd(28)} ${r.name.padEnd(16)} ${String(r.value).padStart(9)}  ` +
      `warn ${r.warn}  fail ${r.fail}  ` +
      // THE WARN FIGURE FIRST, and signed, so an over-warn row cannot read as comfortable.
      `headroom ${wh >= 0 ? '+' : ''}${wh.toFixed(1)}% of warn, ` +
      `${(((r.fail - r.value) / r.fail) * 100).toFixed(1)}% of fail`);
  }
  if (g.advisory?.length) {
    console.log(`  note: ${g.advisory.join(', ')} reported but not gating in this environment` +
      ` (${ADVISORY_ENV}). Gated in full on a dedicated machine at N>=5.`);
  }
}

// ---------------------------------------------------------------- self-test
/**
 * THIS FILE HAD NO SELFTEST, and it owns every threshold the project argues with. It is imported
 * by two browser gates (`drive-through`, `chase-harness`) and by nothing offline, so its
 * arithmetic — the WARN/FAIL boundary, the headroom column, and now `derivations` — was only
 * ever exercised through a seven-minute run.
 *
 * Run as `node tools/budget.mjs --selftest`. No browser, no district, milliseconds.
 */
if (process.argv.includes('--selftest')
  && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  console.log('BUDGET SELFTEST\n');
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
    ok ? pass++ : fail++;
  };
  const spec = { warn: 100, fail: 200 };

  // The boundary, both sides, because `>=` and `>` are one character apart and decide a gate.
  check('a value AT the warn is a WARN, not a PASS', assess('t', 100, spec).status === 'WARN',
    `100 -> ${assess('t', 100, spec).status}`);
  check('and one unit below it passes', assess('t', 99, spec).status === 'PASS',
    `99 -> ${assess('t', 99, spec).status}`);
  check('a value AT the fail is a FAIL', assess('t', 200, spec).status === 'FAIL',
    `200 -> ${assess('t', 200, spec).status}`);

  /**
   * THE HEADROOM COLUMN, AND THE KNOWN-BAD IS THE VERSION THAT SHIPPED. Against the fail line
   * alone an over-warn row reads comfortable: this is the committed artifact's own triangle row,
   * where the old column printed 53.9% beside the word WARN. CLAUDE.md recorded that for several
   * rounds while the code still had only the fail figure.
   */
  {
    const tri = { warn: 830000, fail: 1850000 };
    const g = gate([{ name: 'triangles', value: 852605, spec: tri }], { advisory: [] });
    const h = g.headroom[0];
    check('an over-warn row reports NEGATIVE headroom against its warn',
      h.warnHeadroomPct < 0, `${h.warnHeadroomPct}% of warn on a ${g.rows[0].status} row`);
    check('KNOWN-BAD: and against the FAIL line the same row reads comfortable',
      h.headroomPct > 50,
      `${h.headroomPct}% of fail — the only figure the old column printed, beside "WARN"`);
    check('so the two figures disagree in SIGN, which is what makes the warn one necessary',
      Math.sign(h.warnHeadroomPct) !== Math.sign(h.headroomPct),
      `${h.warnHeadroomPct} against ${h.headroomPct}`);
    check('and the warn figure is the one the printed line leads with',
      /headroom -2\.7% of warn/.test(capture(() => printGate(g))),
      capture(() => printGate(g)).split('\n').filter((L) => L.includes('triangles'))[0]?.trim() ?? '');
  }

  /**
   * THE RATCHET, ASSERTED RATHER THAN ARGUED. Derivation (b) is `p95 / operatingRatio` with the
   * ratio under 1, so recomputing it ALWAYS lands above the p95 it came from — it cannot fire on
   * the content it was derived from, at any scale. That one line is #75's whole finding, and a
   * ratio of 1.0 or more would silently turn (b) into something that can fire, so the guard is
   * on the property and not on the number.
   */
  for (const p95 of [100000, 726597, 852605, 5000000]) {
    const d = derivations(p95, Math.round(p95 * 1.014));
    check(`(b) recomputed at p95 ${p95} cannot fire: warn ${d.b.warn} > p95`,
      d.b.warn > p95, `ratio ${(d.b.warn / p95).toFixed(3)}`);
  }
  /**
   * BY CONSTRUCTION: `derivations` REPRODUCES THE SHIPPED THRESHOLD FROM THE INPUTS THE HEADER
   * QUOTES. The header records the 2026-09-01 re-derivation as triangles p95 726,597 / max
   * 760,689 and the result as warn 830,000 (rounded) / fail 1,850,000. Feeding those back:
   *
   *     (b) warn  726,597 / 0.878 = 827,559   against the header's rounded 830,000
   *     (a) warn  760,689 x 1.6   = 1,217,102 against the header's 1,217,000
   *     (a) fail  760,689 x 2.5   = 1,901,723 against the header's 1,902,000
   *
   * So this function is the same arithmetic the header did by hand, and every statement built on
   * it is about the shipped thresholds rather than about a model of them. Without this check
   * `derivations` could be any plausible pair of formulas.
   */
  {
    const d = derivations(726597, 760689);
    check('derivations reproduces the header\'s own 2026-09-01 figures from its own inputs',
      Math.abs(d.b.warn - 830000) < 2500 && Math.abs(d.a.warn - 1217000) < 500
      && Math.abs(d.a.fail - 1902000) < 500,
      `(b) warn ${d.b.warn} vs 830,000; (a) warn ${d.a.warn} vs 1,217,000; `
      + `(a) fail ${d.a.fail} vs 1,902,000`);
  }
  /**
   * #64, DECIDED: THE SHIPPED TRIANGLE THRESHOLDS ARE DERIVATION (a) OF THE RECORDED BASELINE. Typed
   * literals against recorded data, so this fails when either is edited without the other — which is
   * the point: a re-baseline is a diff to BASELINE that this check forces to carry the thresholds
   * with it, and a hand-tuned threshold is a diff to BUDGET that it refuses.
   */
  {
    const worst = Math.max(...BASELINE.triangles.max);
    const d = derivations(Math.max(...BASELINE.triangles.p95), worst);
    const floor10k = (v) => Math.floor(v / 10000) * 10000;
    check('the shipped triangle thresholds ARE derivation (a) of the recorded baseline, rounded down',
      BUDGET.triangles.warn === floor10k(d.a.warn) && BUDGET.triangles.fail === floor10k(d.a.fail),
      `warn ${BUDGET.triangles.warn} against ${floor10k(d.a.warn)}, fail ${BUDGET.triangles.fail} `
      + `against ${floor10k(d.a.fail)}, from a worst max of ${worst}`);
    check('and the baseline was taken on the course the gate drives, with the walls solid',
      BASELINE.course === 'roads' && BASELINE.bodyCollision === true && BASELINE.runs === 3
      && BASELINE.triangles.p95.length === 3 && BASELINE.triangles.max.length === 3,
      `${BASELINE.course}, collision ${BASELINE.bodyCollision}, ${BASELINE.runs} runs`);
    // Arithmetic about the frozen threshold this replaced, printed rather than counted: four
    // recorded numbers against a literal cannot fail for any edit to any source file.
    console.log(`  note: the frozen 2026-09-01 warn, 830,000, against this baseline's p95s `
      + `${BASELINE.triangles.p95.join(' / ')}; (b) recomputed on it is ${d.b.warn}, `
      + `${(100 * (d.b.warn / Math.max(...BASELINE.triangles.p95) - 1)).toFixed(1)}% above its own p95`);
  }

  console.log(`\nBUDGET SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

/** Capture stdout from a printer so a check can assert the LINE and not just the datum. */
function capture(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try { fn(); } finally { console.log = orig; }
  return out.join('\n');
}
