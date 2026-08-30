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
export const BUDGET = {
  drawCalls:      { warn: 200, fail: 320 },
  triangles:      { warn: 400000, fail: 900000 },
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
    headroom: rows.map((r) => ({
      name: r.name, value: r.value, failAt: r.fail, advisory: r.advisory,
      headroomPct: +(((r.fail - r.value) / r.fail) * 100).toFixed(1),
    })) };
}

export function printGate(g) {
  console.log(`\nBUDGET GATE: ${g.status}`);
  for (const r of g.rows) {
    const tag = r.advisory ? `${r.status} (advisory, not gating)` : r.status;
    console.log(`  ${tag.padEnd(28)} ${r.name.padEnd(16)} ${String(r.value).padStart(9)}  ` +
      `warn ${r.warn}  fail ${r.fail}  headroom ${(((r.fail - r.value) / r.fail) * 100).toFixed(1)}%`);
  }
  if (g.advisory?.length) {
    console.log(`  note: ${g.advisory.join(', ')} reported but not gating in this environment` +
      ` (${ADVISORY_ENV}). Gated in full on a dedicated machine at N>=5.`);
  }
}
