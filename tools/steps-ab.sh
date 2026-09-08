#!/usr/bin/env bash
# Interleaved A/B of the per-step ledger, one browser at a time.
#
# This exists because the gate's own number cannot decide this change on a
# shared box. `chunk stall ms` is a MAX over a run, and a max collects
# interference instead of rejecting it: with other builders' harnesses alive
# this round measured 25.5 ms on one arm and 105.5 ms on the other in the same
# interleaved pair, against a 10.7 ms median taken when the box was quiet. Those
# readings are about the neighbours.
#
# tools/chunk-steps.mjs records EVERY step, so the same run yields ~70 samples
# of append:near instead of one maximum. p50 and p95 over 70 samples survive a
# noisy box; the max does not. That is the comparison this script sets up, and
# it interleaves the arms for the same reason tools/stall-ab.sh does.
#
# Usage: tools/steps-ab.sh ROUNDS "armA=QUERY" "armB=QUERY"
set -u
ROUNDS="${1:?rounds}"
shift
ARMS=("$@")
PORT="${STEP_PORT:-8137}"
mkdir -p docs/steps

for r in $(seq 1 "$ROUNDS"); do
  for spec in "${ARMS[@]}"; do
    name="${spec%%=*}"
    query="${spec#*=}"
    load=$(cut -d' ' -f1 /proc/loadavg)
    chrome=$(pgrep -c chrome 2>/dev/null || echo 0)
    out="docs/steps/${name}-r${r}.json"
    t0=$(date +%s)
    STEP_PORT="$PORT" node tools/chunk-steps.mjs --traffic --circuits 3 \
      --query "$query" --out "$out" > "docs/steps/${name}-r${r}.log" 2>&1
    rc=$?
    if [ -f "$out" ]; then
      node -e "
        const a=require('./${out}').analysis;
        const k=a.kinds.find(x=>x.kind==='append:near')||{};
        console.log('r${r} ${name}: append:near n='+k.n+' p50='+k.p50_ms+' p95='+k.p95_ms+' max='+k.max_ms+
          '  | slice p50='+a.slice_ms.p50+' p95='+a.slice_ms.p95+' max='+a.slice_ms.max+
          '  | gate='+a.gate_worst_slice_ms+'  [load ${load} chrome ${chrome}] '+ (( $(date +%s) - t0 ))+'s');
      "
    else
      echo "r${r} ${name}: ERR rc=${rc}"
      tail -3 "docs/steps/${name}-r${r}.log" | sed 's/^/         /'
    fi
  done
done
