// Headless traffic harness.
//
// The traffic AI is pure JS over the baked road graph — it needs no GL context and
// no browser. Running it under node instead of Playwright turns a 40 s capture into
// a 2 s run, which is what makes a multi-seed, multi-density sweep affordable.
//
//   node tools/traffic-sim.mjs
//   node tools/traffic-sim.mjs --cars=30,60,90 --seeds=8 --seconds=180
//   node tools/traffic-sim.mjs --player=static --out=docs/traffic-junction.json
//   TRAFFIC_MODULE=/abs/path/to/old-traffic.js node tools/traffic-sim.mjs   (A/B)
//
// Options: --cars (default 30,60) --seeds (4) --seconds (120) --player (route|static)
//          --playerSpeed (8 m/s) --dt (1/60) --label --out
//
// Every instrument this reports has a two-way self-test in tools/traffic-selftest.mjs.
//
// Determinism: src/traffic.js draws from Math.random() for spawns and turn choice.
// The harness swaps in a seeded mulberry32 for the duration of a run, so a run is
// reproducible and two builds can be compared on the same traffic realisation.
import fs from 'node:fs';
// TRAFFIC_MODULE points the harness at a different build of the traffic AI, so a
// before/after is measured by ONE instrument rather than by two harnesses that have
// to be trusted to agree. Give it an absolute path.
const { Traffic } = await import(process.env.TRAFFIC_MODULE ?? '../src/traffic.js');

const district = JSON.parse(fs.readFileSync('data/district.json', 'utf8'));
const scene = { add() {} };

const arg = (k, d) => {
  const hit = process.argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};

// ---------------------------------------------------------------- seeded RNG
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- player
// The budget gate drives the baked mission route, so traffic is measured where the
// player actually is. A static player would park the whole fleet in one annulus.
function routePlayer(speed) {
  const route = district.meta.route;
  let wp = 1;
  const pos = { x: route[0].x, z: route[0].z };
  return {
    pos,
    step(dt) {
      const t = route[wp];
      let dx = t.x - pos.x, dz = t.z - pos.z;
      const d = Math.hypot(dx, dz);
      if (d < 8) { wp = (wp + 1) % route.length; return; }
      pos.x += (dx / d) * speed * dt;
      pos.z += (dz / d) * speed * dt;
    },
  };
}
function staticPlayer() {
  const s = district.meta.spawn;
  return { pos: { x: s.x, z: s.z }, step() {} };
}

// ---------------------------------------------------------------- stats reset
// stats accumulate from frame 0; a warm-up window has to be discarded or the
// numbers describe a fleet that is still materialising.
function resetStats(tr) {
  for (const k of Object.keys(tr.stats)) {
    if (typeof tr.stats[k] === 'number') tr.stats[k] = 0;
  }
  delete tr.stats.closestApproachM;
  tr._minHist = null;
  if (tr.resetWaitHistogram) tr.resetWaitHistogram();
}

// ---------------------------------------------------------------- JIT warm-up
// The FIRST run in a fresh process disagrees with every later run on the same seed
// (measured: overlapFrames 118 then 320, 320, 320). Nothing in traffic.js is
// stateful across instances and Math.random is reseeded per run, so the cause is
// V8 tiering - the interpreter and TurboFan do not agree to the last bit on
// Math.pow/hypot, and IDM squares the result of a pow every step, so a 1-ULP
// difference diverges. Burning one throwaway run puts every measured run on the
// optimised path, which makes a fresh process reproduce its own numbers.
let _warmed = false;
function warmJit() {
  if (_warmed) return;
  _warmed = true;
  runOnce({ cars: 30, seed: 99, seconds: 25, warmup: 0, _warm: true });
}

// ---------------------------------------------------------------- one run
export function runOnce({ cars = 30, seed = 1, seconds = 120, warmup = 20,
                          player = 'route', playerSpeed = 13, dt = 1 / 60, _warm = false,
                          stuckLimitS, stopLine } = {}) {
  if (!_warm) warmJit();
  const realRandom = Math.random;
  Math.random = mulberry32(seed * 2654435761);
  try {
    const tr = new Traffic(scene, district, { count: cars, stuckLimitS, stopLine });
    const p = player === 'static' ? staticPlayer() : routePlayer(playerSpeed);

    // Externally observed throughput. Deliberately measured from OUTSIDE the module
    // so it cannot be flattered by a counter the module increments itself.
    let vehicleMetres = 0, speedSum = 0, speedSamples = 0, crossings = 0;
    let stoppedSamples = 0;
    // Independent overlap sweep. It must reproduce the module's own pair count
    // exactly - an agreeing second implementation is the check that neither is
    // silently inert - and it additionally says WHY each overlapping pair is close.
    const cause = { sameLane: 0, sharedJunction: 0, entryBlocked: 0, bothStopped: 0, other: 0, pairs: 0 };
    const sharedExamples = new Map();   // movement pair -> closest distance seen
    const prev = new Array(cars).fill(null);   // slot -> {id, edge, forward}

    const warmFrames = Math.round(warmup / dt);
    const runFrames = Math.round(seconds / dt);

    for (let f = 0; f < warmFrames + runFrames; f++) {
      p.step(dt);
      tr.update(dt, p.pos);
      if (f === warmFrames - 1) { resetStats(tr); vehicleMetres = 0; speedSum = 0; speedSamples = 0; crossings = 0; stoppedSamples = 0; }
      const measuring = f >= warmFrames;
      if (measuring && tr._lastPositions) {
        const P = tr._lastPositions;
        for (let a = 0; a < P.length; a++) for (let b = a + 1; b < P.length; b++) {
          const dd = Math.hypot(P[a].x - P[b].x, P[a].z - P[b].z);
          if (dd >= tr.overlapDistance) continue;
          cause.pairs++;
          const shared = P[a].holds.length && P[b].holds.length
            && P[a].holds.some((j) => P[b].holds.includes(j));
          if (P[a].key === P[b].key) cause.sameLane++;
          else if (shared) {
            // Both cars hold a junction in common, so the arbitration let them in at
            // the same time. Name the movements it actually GRANTED at that vertex -
            // P[].mv is the plan for the junction AHEAD, which for a car that has
            // already crossed is a different movement entirely and would misattribute
            // the pair. Where the two cars are close at some OTHER junction they both
            // happen to hold, the two granted movements simply will not look adjacent,
            // and that is the honest reading.
            cause.sharedJunction++;
            const jv = P[a].holds.find((j) => P[b].holds.includes(j));
            const act = tr._junctions.get(jv);
            const k = `v${jv}: ` + [act?.active.get(P[a].id)?.key ?? '?',
              act?.active.get(P[b].id)?.key ?? '?'].sort().join('  vs  ');
            if (!(sharedExamples.get(k) <= dd)) sharedExamples.set(k, dd);
          } else if (P[a].blocked || P[b].blocked) cause.entryBlocked++;
          else if (P[a].v < 0.15 && P[b].v < 0.15) cause.bothStopped++;
          else cause.other++;
        }
      }
      for (let i = 0; i < cars; i++) {
        const car = tr.cars[i];
        const was = prev[i];
        if (car) {
          if (measuring) {
            vehicleMetres += car.v * dt;
            speedSum += car.v; speedSamples++;
            if (car.v < 0.15) stoppedSamples++;
            if (was && was.id === car.id && (was.edge !== car.edge || was.forward !== car.forward)) crossings++;
          }
          prev[i] = { id: car.id, edge: car.edge, forward: car.forward };
        } else prev[i] = null;
      }
    }

    const r = tr.report();
    const minutes = seconds / 60;
    return {
      cars, seed, seconds,
      overlapPct: r.overlapPctOfFrames,
      overlapNearJunction: r.overlapNearJunction,
      overlapSameEdge: r.overlapSameEdge,
      overlapCrossEdge: r.overlapCrossEdge,
      overlapFrames: r.overlapFrames,
      frames: r.frames,
      overlapCarPct: r.overlapCarPctOfCarFrames ?? null,
      overlapPairsPerFrame: r.overlapPairsPerFrame ?? null,
      overlapPairsNearJunction: r.overlapPairsNearJunction ?? 0,
      overlapPairsMidBlock: r.overlapPairsMidBlock ?? 0,
      closestApproachM: r.closestApproachM ?? null,
      closestPairHistogram: r.closestPairHistogram,
      // throughput, measured externally
      crossingsPerMin: +(crossings / minutes).toFixed(1),
      despawnsPerMin: +(r.despawns / minutes).toFixed(1),
      vehicleKmPerMin: +(vehicleMetres / 1000 / minutes).toFixed(2),
      meanSpeedKmh: +((speedSum / Math.max(1, speedSamples)) * 3.6).toFixed(2),
      stoppedPctOfCarFrames: +((stoppedSamples / Math.max(1, speedSamples)) * 100).toFixed(2),
      // module-side counters
      junctionWaitPct: r.junctionWaitPctOfCarFrames,
      followBrakePct: r.followBrakePctOfCarFrames,
      entryBlockedCarFrames: r.entryBlockedCarFrames,
      spawns: r.spawns, despawns: r.despawns, deadEnds: r.deadEnds, uTurns: r.uTurns,
      alive: r.alive,
      wait: tr.waitReport ? tr.waitReport() : null,
      cause: tr._lastPositions ? cause : null,
      causeAgrees: tr._lastPositions ? cause.pairs === r.overlapPairFrames : null,
      sharedExamples: [...sharedExamples.entries()].sort((x, y) => x[1] - y[1]).slice(0, 6),
      grid: r.gridlockRecoveries ?? null,
      extra: {
        junctionsHeld: r.junctionsHeld,
        activeMovements: r.activeMovements ?? null,
        conflictDenials: r.conflictDenials ?? null,
        boxDenials: r.boxDenials ?? null,
        replans: r.replans ?? null,
      },
    };
  } finally {
    Math.random = realRandom;
  }
}

function agg(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => typeof x === 'number');
  if (!v.length) return null;
  const s = [...v].sort((a, b) => a - b);
  return {
    mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(2),
    min: +s[0].toFixed(2), max: +s[s.length - 1].toFixed(2),
  };
}

function fmt(rows, cars) {
  const sub = rows.filter((r) => r.cars === cars);
  const a = (k) => agg(sub, k);
  const o = a('overlapPct'), c = a('crossingsPerMin'), sp = a('meanSpeedKmh');
  const nj = sub.reduce((s, r) => s + r.overlapNearJunction, 0);
  const se = sub.reduce((s, r) => s + r.overlapSameEdge, 0);
  const ce = sub.reduce((s, r) => s + r.overlapCrossEdge, 0);
  const of_ = sub.reduce((s, r) => s + r.overlapFrames, 0);
  const fr = sub.reduce((s, r) => s + r.frames, 0);
  const lines = [];
  lines.push(`  ${cars} cars  (${sub.length} seeds x ${sub[0].seconds}s)`);
  lines.push(`    overlap        ${o.mean}%  [${o.min}-${o.max}]   frames ${of_}/${fr}`);
  lines.push(`      nearJunction ${nj}  sameEdge ${se}  crossEdge ${ce}   (worst pair per frame, shipped classifier)`);
  if (a('overlapCarPct')) {
    lines.push(`    overlap-cars   ${a('overlapCarPct').mean}% of car-frames   pairs/frame ${a('overlapPairsPerFrame').mean}`);
    lines.push(`      pairs at junction ${sub.reduce((s2, r) => s2 + r.overlapPairsNearJunction, 0)}  mid-block ${sub.reduce((s2, r) => s2 + r.overlapPairsMidBlock, 0)}`);
  }
  lines.push(`    crossings/min  ${c.mean}  [${c.min}-${c.max}]`);
  lines.push(`    vehicle-km/min ${a('vehicleKmPerMin').mean}   despawns/min ${a('despawnsPerMin').mean}`);
  lines.push(`    mean speed     ${sp.mean} km/h  [${sp.min}-${sp.max}]   stopped ${a('stoppedPctOfCarFrames').mean}% of car-frames`);
  lines.push(`    junctionWait   ${a('junctionWaitPct').mean}% of car-frames   followBrake ${a('followBrakePct').mean}%   entryBlocked ${a('entryBlockedCarFrames').mean} car-frames`);
  lines.push(`    closest pair   ${a('closestApproachM').mean} m mean of per-run minima`);
  if (sub[0].wait && sub[0].wait.episodes !== undefined) {
    const w = sub[0].wait;
    const p = (k) => +(sub.reduce((s, r) => s + (r.wait[k] ?? 0), 0) / sub.length).toFixed(2);
    lines.push(`    junction wait  episodes ${p('episodes')}  mean ${p('meanS')}s  p50 ${p('p50S')}s  p95 ${p('p95S')}s  p99 ${p('p99S')}s  max ${p('maxS')}s`);
    void w;
  }
  const cz = (k) => sub.reduce((s2, r) => s2 + (r.cause ? r.cause[k] : 0), 0);
  if (sub[0].cause) lines.push(`    overlap cause  sameLane ${cz('sameLane')}  sharedJunction ${cz('sharedJunction')}  entryBlocked ${cz('entryBlocked')}  bothStopped ${cz('bothStopped')}  other ${cz('other')}`
    + `   [independent sweep ${sub.every((r) => r.causeAgrees) ? 'AGREES with' : 'DISAGREES with'} module counter]`);
  const ex = sub.flatMap((r) => r.sharedExamples ?? []).sort((x, y) => x[1] - y[1]).slice(0, 4);
  for (const [k, d] of ex) lines.push(`      shared-junction pair ${d.toFixed(2)} m : ${k}`);
  if (sub[0].grid !== null && sub[0].grid !== undefined) {
    lines.push(`    gridlock recoveries ${(sub.reduce((s, r) => s + r.grid, 0) / sub.length).toFixed(2)} per run`);
  }
  const e = sub[0].extra;
  if (e.conflictDenials !== null) {
    const q = (k) => (sub.reduce((s, r) => s + (r.extra[k] ?? 0), 0) / sub.length).toFixed(0);
    lines.push(`    denials        conflict ${q('conflictDenials')}  box ${q('boxDenials')}  replans ${q('replans')}`);
  }
  return lines.join('\n');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const densities = (arg('cars', '30,60')).split(',').map(Number);
  const seeds = Number(arg('seeds', '4'));
  const seconds = Number(arg('seconds', '120'));
  const player = arg('player', 'route');
  const playerSpeed = Number(arg('playerSpeed', '8'));
  const label = arg('label', '');
  const rows = [];
  for (const cars of densities) {
    for (let s = 1; s <= seeds; s++) rows.push(runOnce({ cars, seed: s, seconds, player, playerSpeed, dt: Number(arg('dt', String(1 / 60))) }));
  }
  console.log(`traffic-sim  ${label || '(unlabelled)'}  player=${player}@${playerSpeed}m/s  ${seeds} seeds x ${seconds}s`);
  for (const cars of densities) console.log(fmt(rows, cars));
  const out = arg('out', '');
  if (out) {
    const dir = out.includes('/') ? out.replace(/\/[^/]+$/, '') : '.';
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(out, JSON.stringify({ label, player, seconds, rows }, null, 1));
    console.log(`\nwrote ${out}`);
  }
}
