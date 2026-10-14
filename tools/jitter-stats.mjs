// THE STATISTICS FOR `DRIVE_JITTER=1`: how long a FIXED piece of main-thread work takes during the
// budget gate's own drive, and how much of that is the box.
//
//   node tools/jitter-stats.mjs --selftest
//
// BACKLOG #42 left one question the stall gate cannot answer about itself. Its worst slice carries
// about twice the build's warm cost (one live `append:near` step of 7.7 ms on a chunk whose whole
// nine-building repeat build costs 3.92 ms offline), and three things could be the excess:
// SwiftShader's raster threads preempting the main thread on a four-core box, a garbage-collection
// pause, or the same code running colder in the page than in node's best of five.
//
// A workload that is FIXED (the same instructions every time), ALLOCATES NOTHING (so no
// collection is triggered by it) and is WARM (calibrated, then run thousands of times) can only be
// stretched by the third party that is left: the scheduler. So its excess over its own minimum, timed
// in the same page during the same drive, is preemption — measured rather than argued. If that
// excess reaches the size of the stall's spread, the spread is the box; if it stays near zero, it
// is not, and the stall is the build's (or the collector's) after all.
//
// `performance.now()` is coarsened to 0.1 ms in a page that is not cross-origin isolated, so every
// figure here is quantised to that and the workload is calibrated to about 1 ms — ten quanta — so
// the quantisation is a tenth of the base, not the whole of it.

/**
 * Summarise a list of wall-clock samples of one fixed workload. The MINIMUM is the uncontended
 * cost — nothing makes fixed, warm, non-allocating work faster than the machine running it alone —
 * so every excess is measured against it, and the report is the excess's distribution.
 */
export function summarize(ms) {
  if (!Array.isArray(ms) || ms.length < 2) {
    throw new Error(`jitter needs at least 2 samples, got ${Array.isArray(ms) ? ms.length : typeof ms}: ` +
      `a distribution of one is a reading, and of zero is the probe never having run`);
  }
  for (const v of ms) {
    if (!Number.isFinite(v) || v < 0) {
      throw new Error(`a non-finite or negative sample (${v}) — CLAUDE.md: a NaN fails every > ` +
        `comparison silently, and here it would read as "no preemption"`);
    }
  }
  const s = [...ms].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * (s.length - 1) + 0.5))];
  const base = s[0];
  return {
    n: s.length, base,
    p50: at(0.5), p90: at(0.9), p99: at(0.99), max: s.at(-1),
    excess: { p50: at(0.5) - base, p99: at(0.99) - base, max: s.at(-1) - base },
    // How many samples were stretched past a stated multiple of the base — the shape of the tail
    // in one line, so a single outlier and a fat tail do not read the same.
    over: { x2: s.filter((v) => v > 2 * base).length, x5: s.filter((v) => v > 5 * base).length },
  };
}

const SELFTEST = process.argv.includes('--selftest');
const IS_MAIN = process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop());

if (SELFTEST && IS_MAIN) {
  let pass = 0, fail = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`);
    ok ? pass++ : fail++;
  };
  console.log('JITTER STATS SELFTEST');
  const flat = Array.from({ length: 100 }, () => 1.0);
  const f = summarize(flat);
  check('a workload that is never stretched reads zero excess', f.excess.max === 0 && f.over.x2 === 0,
    JSON.stringify(f.excess));
  const tail = [...Array.from({ length: 98 }, () => 1.0), 1.1, 9.0];
  const t = summarize(tail);
  check('one 9 ms sample in a 1 ms workload is an 8 ms excess, counted once past x5',
    Math.abs(t.excess.max - 8.0) < 1e-12 && t.over.x5 === 1 && t.over.x2 === 1,
    `max excess ${t.excess.max}, past x5 ${t.over.x5}`);
  check('and the median does not move for one outlier, which is why the tail is reported separately',
    t.p50 === 1.0, `p50 ${t.p50}`);
  check('the base is the MINIMUM, not the median', summarize([2, 1, 3]).base === 1);
  let threw = false;
  try { summarize([1, NaN, 2]); } catch { threw = true; }
  check('KNOWN-BAD: a NaN sample THROWS rather than reading as no preemption', threw);
  threw = false;
  try { summarize([]); } catch { threw = true; }
  check('KNOWN-BAD: an empty list THROWS — the probe never ran is not a result', threw);
  threw = false;
  try { summarize([1, -0.5]); } catch { threw = true; }
  check('KNOWN-BAD: a negative sample THROWS', threw);
  console.log(`\nJITTER STATS SELFTEST: ${fail ? 'FAIL' : 'PASS'} — ${pass + fail} checks` +
    `${fail ? `, ${fail} failed` : ''}`);
  process.exit(fail ? 1 : 0);
}
