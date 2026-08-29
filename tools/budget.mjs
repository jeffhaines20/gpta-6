// Draw-call / geometry budget gate. Phase 1's Risk 1 was that submission cost,
// not triangle count, is the wall; this turns that from a worry into a build
// failure. Thresholds are deliberately tight enough to bite before content grows.
export const BUDGET = {
  drawCalls:      { warn: 260, fail: 400 },
  triangles:      { warn: 900000, fail: 1800000 },
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
