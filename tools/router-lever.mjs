#!/usr/bin/env node
/**
 * router-lever — WHAT #109's OBVIOUS FIX ACTUALLY BUYS.
 *
 * `src/pursuit.js`'s `_chooseNext` is a greedy descent on the distance from an option's FAR
 * ENDPOINT to the target. #89 recorded that this is a different function from the one
 * `bestApproach` minimises, so "the minimising edge is one no unit will ever drive"; #108 made
 * the ADMISSION local to fix the consequence and said in as many words that it did not make the
 * ROUTER better, leaving a measured residual ("the router reaches a minimising edge 319 of 516
 * clear spots 30-140 m off a road; it never does 197 of 516, 38%").
 *
 * Round 11 then found that residual INSIDE the reach — a spot 0.04 m from a road where two
 * police cars stop 24 m away and nothing happens, because the edge the router hands them has a
 * blocked officer walk while the network's own best approach does not.
 *
 * The obvious lever is to score options by their CLOSEST APPROACH instead, which is a quantity
 * `_localBest` already computes. CLAUDE.md: "'it perturbs a seeded stream' is a reason to
 * measure, not a reason to defer." This measures it, with no physics and no seeds, by walking
 * the router directly — #108's own protocol, which settled its question in two minutes.
 *
 * ## THE RESULT, and it is not a clean win
 *
 *     can ANY of a spawned fleet of 8 reach a stop point that arrests this spot?
 *     shipped, score by FAR ENDPOINT        1463 of 1636   89.4%
 *     candidate, score by CLOSEST APPROACH  1495 of 1636   91.4%
 *     newly covered 46 (2.8%)      LOST 14 (0.9%)      neither 127 (7.8%)
 *     mean steps to settle   12.4 -> 11.9, so the router is marginally CHEAPER
 *
 * A net +32 spots and +2.0 points, and **14 spots that arrest today would stop arresting**.
 * #108's own bar was "NOT ONE SPOT REGRESSED", so this does not clear it. The reason for the
 * regressions is worth stating: a descent on closest approach is myopic about the FUTURE (it will
 * take an edge that passes near the target and leads nowhere) where a descent on the endpoint is
 * myopic about the PRESENT.
 *
 * ## AND THE THIRD RULE IS BETTER THAN BOTH, WITH NO CONSTANT TO TUNE
 *
 * A blend would need a weight, which this project refuses. A LEXICOGRAPHIC order does not:
 * "prefer an option that gets CLOSER to the player than where I already am; when none does, head
 * TOWARD them." Among improving options it descends the approach — the quantity that decides
 * whether an arrest is possible — and with nothing improving it falls back to the shipped
 * endpoint rule, which keeps making geometric progress and cannot stall.
 *
 *     rule                                        covered        newly   LOST   mean steps
 *     shipped, far ENDPOINT                 1463 of 1636  89.4%      -      -        12.4
 *     candidate, closest APPROACH           1495 of 1636  91.4%     46     14        11.9
 *     candidate, LEXICOGRAPHIC              1497 of 1636  91.5%     41      7        12.1
 *
 * Best coverage of the three, **half the regressions**, and the router costs the same.
 *
 * ## BUT IT IS STILL NOT ZERO, AND THAT LOCATES THE CAUSE
 *
 * 7 spots still regress, and the lexicographic order cannot be blamed for choosing the wrong
 * objective — it only ever prefers an option that genuinely improves the approach. **The
 * remaining losses are the price of GREEDINESS, not of the objective**: a local improvement can
 * still lead into a worse local minimum, and no ordering of objectives fixes that because the
 * router commits to one edge at a time with no lookahead.
 *
 * So what would reach zero is a different KIND of router — a search over the option tree, or
 * Dijkstra on "best approach reachable from here" — which is a different module and a different
 * cost. That is a more useful thing to know than either candidate's percentage.
 *
 * RECORDED RATHER THAN SHIPPED. The measurement is the deliverable: +34 net spots for 7
 * regressions is a real improvement with a known price, and taking it means re-baselining
 * `pursuit-test`, `arrest-band` and `boot-check`'s arrest arms, because it perturbs the seeded
 * pursuit stream. CLAUDE.md is right that a perturbation is a reason to measure rather than to
 * defer — so it is measured, and the decision now has a price instead of an argument.
 *
 * ## THE CONFIGURATION CHANGED THE CONCLUSION, which is the reason this file exists
 *
 * The first version started each walk from 8 edges spread round the network and read
 * **80.6% against 81.0%, with 47 spots LOST** — a reshuffle, and I nearly wrote the lever off on
 * it. That is the wrong configuration: `_spawn` rejects any point outside **70 to 260 m** of the
 * target, so a real unit starts in a band AROUND the player and walks a short way, where a
 * spread start set walks across the district. Using the module's own `_spawn` gives the table
 * above. CLAUDE.md's rule is that a gate constructing the subject itself has to construct it the
 * way the game does, and the cheap proof is whether the fix moves the reading — it moved it from
 * "refuse the lever" to "the lever works and costs 14 spots".
 *
 * A second configuration error in the same probe: the first version built `PursuitUnits` with no
 * `clearAt`, and `_footPathClear` opens `if (!this.clearAt) return true`, so the officer's walk
 * read clear on 1340 of 1340 spots. With the predicate both hosts wire, 366 of 1309 in-reach
 * spots (28.0%) are blocked, which reproduces the 27% CLAUDE.md already records.
 *
 * Cycles are counted and are NOT a defect: 7,181 of 12,939 walks revisit an edge, and the
 * module's own comment says a unit "drives on and comes round again, which is what the greedy
 * router already does at every junction".
 */
import { readFileSync } from 'node:fs';
import { PursuitUnits } from '../src/pursuit.js';
import { BlockerIndex } from '../src/blockers.js';

const district = JSON.parse(readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
const p = new PursuitUnits({ add() {} }, district, { count: 8, seed: 0 });
const blockers = new BlockerIndex(district);
p.clearAt = (x, z, r = 0.95) => !blockers.resolveCircle(x, z, r);

const STEP_CAP = 400;

/** Walk the greedy router from (edge, forward) under `score`, and report what it can reach. */
function walk(edge, forward, target, score) {
  let e = edge, f = forward;
  const seen = new Set();
  let bestD = Infinity, bestPt = null, steps = 0, cycled = false;
  for (; steps < STEP_CAP; steps++) {
    const c = p._closestOn(e, f, target);
    if (c.d < bestD) { bestD = c.d; bestPt = { x: c.x, z: c.z }; }
    const key = `${e}:${f}`;
    if (seen.has(key)) { cycled = true; break; }
    seen.add(key);
    const opts = p._optionsAt(e, f);
    if (!opts.length) break;
    let pick = null;
    if (score === 'lex') {
      pick = pickLex(opts, target, c.d);
    } else {
      let pickS = Infinity;
      for (const o of opts) {
        const sc = score(o, target);
        if (sc < pickS) { pickS = sc; pick = o; }
      }
    }
    if (!pick) break;
    e = pick.e; f = pick.forward;
  }
  return { bestD, bestPt, steps, cycled };
}

const byEndpoint = (o, t) => {
  const v = p.d.verts[p._endVertex(o.e, o.forward)];
  return Math.hypot(v.x - t.x, v.z - t.z);
};
const byApproach = (o, t) => p._closestOn(o.e, o.forward, t).d;

/**
 * THE LEXICOGRAPHIC RULE, which is the candidate with no weight to tune.
 *
 * "Prefer an option that gets CLOSER to the player than where I already am; when none does, head
 * TOWARD them." Among improving options it descends the approach (the quantity that decides
 * whether an arrest is possible); with nothing improving it falls back to the shipped endpoint
 * rule (which keeps making geometric progress and cannot stall). Two objectives in priority
 * order, no constant between them — where the pure approach rule gets stuck because every option
 * leads nowhere, this behaves exactly as the shipped build does.
 */
function pickLex(opts, t, hereD) {
  let best = null, bestA = Infinity, fall = null, fallE = Infinity;
  for (const o of opts) {
    const a = byApproach(o, t);
    if (a < hereD && a < bestA) { bestA = a; best = o; }
    const e = byEndpoint(o, t);
    if (e < fallE) { fallE = e; fall = o; }
  }
  return best ?? fall;
}

// Spots: off every 5th edge at a spread of offsets, which is round 11's and #108's band together.
const spots = [];
for (let i = 0; i < district.edges.length; i += 5) {
  const e = district.edges[i];
  const v0 = district.verts[e.v[0]], v1 = district.verts[e.v[e.v.length - 1]];
  const ex = v1.x - v0.x, ez = v1.z - v0.z, L = Math.hypot(ex, ez) || 1;
  const nx = -ez / L, nz = ex / L;
  const mx = (v0.x + v1.x) / 2, mz = (v0.z + v1.z) / 2;
  for (const off of [2, 10, 20, 30, 50, 90]) {
    for (const sgn of [1, -1]) {
      const x = mx + nx * off * sgn, z = mz + nz * off * sgn;
      if (!p.clearAt(x, z, 0.95)) continue;        // inside a building: not a player position
      spots.push({ x, z });
    }
  }
}
console.log(`${spots.length} clear spots off ${Math.ceil(district.edges.length / 5)} edges`);
console.log(`reachRadius ${p.reachRadius} m\n`);

/**
 * THE START SET IS THE MODULE'S OWN `_spawn`, not 8 edges spread round the network.
 *
 * My first version did the latter and reported 80.6% against 81.0%. It is the wrong
 * configuration: `_spawn` rejects any point outside **70 to 260 m** of the target, so a real
 * unit starts in a band AROUND the player and walks a short way, where a spread start set walks
 * across the district. This file's standing rule is that a gate constructing the subject itself
 * has to construct it the way the game does, and the cheap proof is whether the fix moves the
 * reading.
 */
const FLEET = 8;
function spawnStarts(target) {
  const out = [];
  for (let i = 0; i < FLEET; i++) {
    const before = p.units[i];
    p.units[i] = null;
    if (p._spawn(i, target) && p.units[i]) {
      out.push({ e: p.units[i].edge, f: p.units[i].forward });
    }
    p.units[i] = before;
  }
  return out;
}

const tally = { endpoint: 0, approach: 0, lex: 0, both: 0, neither: 0, newly: 0, lost: 0,
  lexNewly: 0, lexLost: 0,
  cyclesE: 0, cyclesA: 0, cyclesL: 0, stepsE: 0, stepsA: 0, stepsL: 0, n: 0, noSpawn: 0, startsSeen: 0 };
const arrestable = (r, t) => r.bestD <= p.reachRadius && !!r.bestPt
  && p._footPathClear(r.bestPt.x, r.bestPt.z, t.x, t.z);

for (const t of spots) {
  tally.n++;
  // A spot is covered if ANY of the fleet's start edges can get there, which is the question
  // the game asks: eight units, not one.
  let okE = false, okA = false, okL = false;
  const starts = spawnStarts(t);
  if (!starts.length) { tally.noSpawn++; continue; }
  tally.startsSeen += starts.length;
  for (const s of starts) {
    const rE = walk(s.e, s.f, t, byEndpoint);
    const rA = walk(s.e, s.f, t, byApproach);
    const rL = walk(s.e, s.f, t, 'lex');
    tally.stepsE += rE.steps; tally.stepsA += rA.steps; tally.stepsL += rL.steps;
    if (rE.cycled) tally.cyclesE++;
    if (rA.cycled) tally.cyclesA++;
    if (rL.cycled) tally.cyclesL++;
    if (arrestable(rE, t)) okE = true;
    if (arrestable(rA, t)) okA = true;
    if (arrestable(rL, t)) okL = true;
  }
  if (okL) tally.lex++;
  if (!okE && okL) tally.lexNewly++;
  if (okE && !okL) tally.lexLost++;
  if (okE) tally.endpoint++;
  if (okA) tally.approach++;
  if (okE && okA) tally.both++;
  if (!okE && !okA) tally.neither++;
  if (!okE && okA) tally.newly++;
  if (okE && !okA) tally.lost++;
}

const pc = (n) => `${(100 * n / tally.n).toFixed(1)}%`;
console.log('=== can ANY of 8 start edges reach a stop point that arrests this spot? ===\n');
console.log(`  shipped: score by FAR ENDPOINT    ${tally.endpoint} of ${tally.n}  ${pc(tally.endpoint)}`);
console.log(`  candidate: score by CLOSEST APPROACH ${tally.approach} of ${tally.n}  ${pc(tally.approach)}`);
console.log(`  candidate: LEXICOGRAPHIC (approach if it improves, else endpoint) ${tally.lex} of ${tally.n}  ${pc(tally.lex)}`);
console.log(`\n  approach:      newly ${tally.newly} (${pc(tally.newly)})     LOST ${tally.lost} (${pc(tally.lost)})`);
console.log(`  lexicographic: newly ${tally.lexNewly} (${pc(tally.lexNewly)})     LOST ${tally.lexLost} (${pc(tally.lexLost)})`);
console.log(`  covered by both ${tally.both}   by neither ${tally.neither}  (${pc(tally.neither)})`);
console.log(`\n  ${tally.startsSeen} spawned starts over ${tally.n} spots`
  + ` (${tally.noSpawn} spots where _spawn found nowhere in its 70-260 m band)`);
console.log(`  router cost: mean steps to settle  endpoint ${(tally.stepsE / Math.max(1, tally.startsSeen)).toFixed(1)}`
  + `   approach ${(tally.stepsA / Math.max(1, tally.startsSeen)).toFixed(1)}`
  + `   lex ${(tally.stepsL / Math.max(1, tally.startsSeen)).toFixed(1)}`);
console.log(`  walks that CYCLED (revisited an edge): endpoint ${tally.cyclesE}`
  + `   approach ${tally.cyclesA}   of ${tally.startsSeen}`);
console.log('\n  (a cycle is not a defect: the module\'s own comment says a unit "drives on and');
console.log('  comes round again", which is what a greedy router does at every junction.)');
