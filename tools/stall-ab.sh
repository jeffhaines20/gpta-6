#!/usr/bin/env bash
# Interleaved A/B of the chunk-stall gate, one browser at a time.
#
# WHY INTERLEAVED, and not one arm then the other. This box is SHARED. During
# this round's own measurements tools/hero-shots.mjs, tools/car-probe.mjs and a
# second tools/tri-breakdown.mjs were found running, 21 chrome processes between
# them - and `chunk stall ms` is a MAX, the one statistic that collects
# interference rather than rejecting it. The documented spread on unchanged code
# is 7.1 / 24.1 / 7.9 / 68.5 / 11.6 ms, decided entirely by how many browsers
# were alive.
#
# Running arm A to completion and then arm B measures A against B PLUS whatever
# the neighbours were doing in between. Alternating A,B,A,B,A,B spreads that
# drift across both arms instead of putting it all in one, which is the only
# defence available when the environment cannot be made quiet.
#
# Both arms are the SAME COMMIT on the SAME PORT, separated by a query flag -
# the practice ?kerbs=0 already established here, because two trees is how two
# rounds in this project came back with both arms photographing one commit.
#
# Every run records the load average and the live chrome count at its start, so
# a reading taken under interference is visible as such instead of being
# averaged in silently.
#
# Usage: tools/stall-ab.sh ROUNDS "armA=QUERY" "armB=QUERY"
#   e.g. tools/stall-ab.sh 3 "after=" "before=frontage=lazy"
set -u
ROUNDS="${1:?rounds}"
shift
ARMS=("$@")
PORT="${DRIVE_PORT:-8137}"
ART="docs/drive-traffic.json"
mkdir -p docs/stall

echo "=== interleaved A/B, ${ROUNDS} rounds x ${#ARMS[@]} arms, port ${PORT} ==="
for r in $(seq 1 "$ROUNDS"); do
  for spec in "${ARMS[@]}"; do
    name="${spec%%=*}"
    query="${spec#*=}"
    out="docs/stall/${name}"
    mkdir -p "$out"
    load=$(cut -d' ' -f1 /proc/loadavg)
    chrome=$(pgrep -c chrome 2>/dev/null || echo 0)
    t0=$(date +%s)
    rm -f "$ART"
    DRIVE_PORT="$PORT" DRIVE_QUERY="$query" node tools/drive-through.mjs --traffic \
      > "${out}/run${r}.log" 2>&1
    rc=$?
    if [ -f "$ART" ]; then
      cp "$ART" "${out}/run${r}.json"
      read -r ms tri drw <<<"$(node -e "
        const j=require('./${out}/run${r}.json').result;
        console.log(j.worst_chunk_build_ms, j.triangles.p95, j.draw_calls.p95);
      ")"
      echo "r${r} ${name}: stall ${ms} ms  tri.p95 ${tri}  draw.p95 ${drw}  [load ${load} chrome ${chrome}]  rc=${rc}  $(( $(date +%s) - t0 ))s"
    else
      echo "r${r} ${name}: ERR — no ${ART} written, rc=${rc}, $(( $(date +%s) - t0 ))s"
      tail -3 "${out}/run${r}.log" | sed 's/^/         /'
    fi
  done
done

echo "--- summary ---"
for spec in "${ARMS[@]}"; do
  name="${spec%%=*}"
  node -e "
    const fs=require('fs'); const d='docs/stall/${name}';
    if(!fs.existsSync(d)) { console.log('${name}: no runs'); process.exit(0); }
    const v=fs.readdirSync(d).filter(f=>f.endsWith('.json')).sort()
      .map(f=>JSON.parse(fs.readFileSync(d+'/'+f)).result.worst_chunk_build_ms);
    if(!v.length){ console.log('${name}: NO RUNS PRODUCED A RESULT'); process.exit(0); }
    const s=[...v].sort((a,b)=>a-b);
    const med = s.length%2 ? s[(s.length-1)/2] : (s[s.length/2-1]+s[s.length/2])/2;
    console.log('${name}'.padEnd(10), 'runs', JSON.stringify(v), ' median', med, ' range', s[0]+'-'+s[s.length-1], ' n='+v.length);
  "
done
