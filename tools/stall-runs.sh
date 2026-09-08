#!/usr/bin/env bash
# Strictly sequential runs of the stall gate, one at a time, each run's number
# kept, and each run PROVEN to be its own.
#
# Why this exists at all: the metric cannot be measured any other way. The same
# code has read 7.1, 24.1, 7.9, 68.5 and 11.6 ms depending only on how many
# headless browsers were alive on the box. So: no `&`, no parallel arms, one
# browser at a time, and every run's number printed so a median is taken over
# readings that are visible.
#
# Why the freshness check exists: the first version of this script did NOT have
# one, and it cost the round its first baseline. drive-through.mjs writes
# docs/drive-traffic.json at the very END of a run, and that run died on a
# page.screenshot timeout - so the file was never rewritten and this script
# copied the version COMMITTED IN THE REPO, twice, and reported it as two
# measurements. They agreed to the digit (8.6 ms / 22 ms / 793,020 tris) on a
# metric whose noise band is 8.2-15.1, which is what gave it away.
#
# So the artifact is DELETED before every run and its absence afterwards is a
# hard ERR, not a silently reused number. A missing measurement is a result; a
# stale one is a lie that reads like a result.
set -u
LABEL="${1:?label}"
N="${2:?runs}"
QUERY="${3:-}"
PORT="${DRIVE_PORT:-8137}"
ART="docs/drive-traffic.json"
OUTDIR="docs/stall/${LABEL}"
mkdir -p "$OUTDIR"

echo "=== ${LABEL}: ${N} sequential runs, port ${PORT}, query='${QUERY}' ==="
for i in $(seq 1 "$N"); do
  t0=$(date +%s)
  rm -f "$ART"                       # a stale artifact must not be able to survive a failed run
  DRIVE_PORT="$PORT" DRIVE_QUERY="$QUERY" node tools/drive-through.mjs --traffic \
    > "${OUTDIR}/run${i}.log" 2>&1
  rc=$?
  if [ -f "$ART" ]; then
    cp "$ART" "${OUTDIR}/run${i}.json"
    read -r ms tot tri drw <<<"$(node -e "
      const j=require('./${OUTDIR}/run${i}.json').result;
      console.log(j.worst_chunk_build_ms, j.worst_chunk_total_ms, j.triangles.p95, j.draw_calls.p95);
    ")"
    echo "run ${i}: stall ${ms} ms   worst_total ${tot} ms   tri.p95 ${tri}   draw.p95 ${drw}   rc=${rc}   $(( $(date +%s) - t0 ))s"
  else
    echo "run ${i}: ERR — no ${ART} written (run died before it got there), rc=${rc}, $(( $(date +%s) - t0 ))s"
    tail -4 "${OUTDIR}/run${i}.log" | sed 's/^/         /'
  fi
done

echo "--- ${LABEL} summary ---"
node -e "
const fs=require('fs');
const d='${OUTDIR}';
const v=fs.readdirSync(d).filter(f=>f.endsWith('.json')).sort()
  .map(f=>JSON.parse(fs.readFileSync(d+'/'+f)).result.worst_chunk_build_ms);
if(!v.length){ console.log('${LABEL}  NO RUNS PRODUCED A RESULT'); process.exit(0); }
const s=[...v].sort((a,b)=>a-b);
const med = s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2;
console.log('${LABEL}  runs', JSON.stringify(v), ' median', med, ' range', s[0]+'-'+s[s.length-1], ' n='+v.length);
"
