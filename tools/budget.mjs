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

export function gate(results) {
  const rows = results.map(({ name, value, spec }) => assess(name, value, spec));
  const worst = rows.some((r) => r.status === 'FAIL') ? 'FAIL'
    : rows.some((r) => r.status === 'WARN') ? 'WARN' : 'PASS';
  return { status: worst, rows,
    headroom: rows.map((r) => ({
      name: r.name, value: r.value, failAt: r.fail,
      headroomPct: +(((r.fail - r.value) / r.fail) * 100).toFixed(1),
    })) };
}

export function printGate(g) {
  console.log(`\nBUDGET GATE: ${g.status}`);
  for (const r of g.rows) {
    console.log(`  ${r.status.padEnd(4)} ${r.name.padEnd(16)} ${String(r.value).padStart(9)}  ` +
      `warn ${r.warn}  fail ${r.fail}  headroom ${(((r.fail - r.value) / r.fail) * 100).toFixed(1)}%`);
  }
}
