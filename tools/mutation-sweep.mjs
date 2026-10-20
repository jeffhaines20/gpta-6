// Which of this project's checks have teeth? Break the modules on purpose and see.
//
// Three review rounds have done this by hand, and the misses were worth more than the hits:
// one round's gate caught 15 of 27 mutations, and the twelve it missed are most of what
// CLAUDE.md's "Three reviewers, 40 findings" section is made of. The most recent round found a
// clean miss — `AVOID_R` reverted to the value it replaced passed every gate that touches it,
// because the fix had been measured by a probe and asserted by nothing.
//
// Doing it by hand costs a reviewer its whole context and produces a table nobody can re-run.
// This runs the same sweep in one command and prints the same table.
//
//   node tools/mutation-sweep.mjs                 every mutation, full offline list
//   node tools/mutation-sweep.mjs --only pinned   one, by id
//   node tools/mutation-sweep.mjs --list          the table, without running anything
//   node tools/mutation-sweep.mjs --browser       also run boot-check where a mutation asks
//   node tools/mutation-sweep.mjs --selftest      prove the harness itself
//
// LAST FULL RUN, `--browser`, at 5fa3a6d: **caught 31, MISSED 0, inert 1, stale 0, of 32.**
//
// THAT LINE IS NOT A STATEMENT ABOUT THE CURRENT TABLE, and it read like one for 36 commits.
// 5fa3a6d's table was 32 rows; this one is 86. A reader taking "MISSED 0 of 32" as the state of
// the gate list is reading a claim about a table where 54 of today's rows did not exist — which
// is the same shape as every other stale number this file's own sibling tools record, except
// that this one sits at the top of the mutation harness and so is the most load-bearing stale
// number in the repo. `--list` prints the real count; believe that over this paragraph.
//
// Rows added since have been verified ONE AT A TIME as they landed (the round that added them
// mutates, runs the owning gate, and restores), which is not the same thing as a full sweep: a
// full sweep is also the only thing that catches a row going STALE because the code it names
// moved under it. Re-run the whole table and restate this line before quoting a coverage figure.
//
// Each mutation in that run was caught by the gate that should own it — traffic-selftest for the lane and
// junction rules, reaction-test for the crowd, damage-test for the charge, wanted-test for the
// wanted ladder and the victim window, physics-test for the vehicle, hud-cue for anything drawn,
// blocker-test for the fence and the resolver, roadpath-test and route-drive for the follower,
// mission-test for the board, playtest --selftest for the integration, boot-check for the one rule
// that lives in district/main.js.
//
// That is a baseline, not a guarantee: it was 6 MISSES on the first run and those six holes are
// what the gate additions in bb1ade0 closed. A later run reporting fewer than 28 caught means
// either a gate lost its teeth or a row went stale, and the difference matters — see STALE below.
//
// HOW IT RESTORES, AND WHY THE TREE MUST BE CLEAN. The district is 16 GB against 7 GB of free
// disk, so there is no shadow copy to mutate: it edits in place and restores with
// `git checkout --`, which is exact. That is only safe on a clean tree, so it REFUSES to start
// on a dirty one rather than risk somebody's uncommitted work. `--selftest` asserts the refusal.
//
// A MUTATION WHOSE `find` NO LONGER OCCURS IS REPORTED **STALE**, not missed. A table that
// silently skips the lines the code has moved past would report a shrinking set of misses as
// the code improved, which is the same trap as a diagnostic that becomes more uniform after a
// fix: CLAUDE.md's `tail -20` story. Stale lines are a failure of this file, and it says so.
//
// AND A GATE THAT THREW IS DISTINGUISHED FROM ONE THAT FAILED. Both exit non-zero, so both
// "catch" a mutation — but a throw may be incidental (a null deref three functions away) rather
// than the check noticing. `ped-audit` threw on every run for months while reading as a pass,
// which is the same confusion from the other side.
import fs from 'node:fs';
import { treePort } from './serve.mjs';
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

/**
 * AN UNRECOGNISED FLAG REFUSES, RATHER THAN STARTING A FULL SWEEP.
 *
 * `node tools/mutation-sweep.mjs --help` was typed at this tool and it started the whole table —
 * 124 rows, each mutating a module and restoring it by `git checkout --`. It was killed in the
 * foreground thirty seconds later and left `src/traffic.js` carrying a live mutation and a stale
 * lock file, which is precisely the state CLAUDE.md's three rules about this tool exist to keep
 * the tree out of. Nothing was lost because the work was committed first, which is the other rule.
 *
 * A guard, not a warning, and ABOVE the lock and before any write — the same hoisting this file's
 * own `--selftest` refusal needed, for the same reason.
 */
const KNOWN_FLAGS = new Set(['--selftest', '--list', '--only', '--browser']);
{
  const bad = args.filter((a) => a.startsWith('--') && !KNOWN_FLAGS.has(a));
  if (bad.length || has('--help') || has('-h')) {
    console.error(bad.length ? `unknown flag: ${bad.join(', ')}` : 'mutation-sweep');
    console.error('\nusage: node tools/mutation-sweep.mjs [--selftest | --list | --only <id>] [--browser]');
    console.error('  --selftest   prove the harness, without touching the table');
    console.error('  --list       print the table and exit, writing nothing');
    console.error('  --only <id>  run one row');
    console.error('  --browser    also run boot-check on rows marked browser: true');
    console.error('\nWith no flag it runs the WHOLE table, mutating and restoring a module per row.');
    console.error('Run it in the foreground, on a clean tree, one at a time.');
    process.exit(2);
  }
}


/** The offline list, in CLAUDE.md's own order. All of them run for every mutation. */
const OFFLINE = [
  'check-syntax', 'geom-audit', 'golden-trace', 'physics-test', 'leaf-mask', 'wanted-test',
  'mission-test', 'damage-test', 'blocker-test', 'crash-test', 'roadpath-test', 'route-drive',
  'reaction-test', 'sim-determinism', 'traffic-selftest', 'hud-cue',
  // Added because a blind reviewer wrote ten rows against src/pursuit.js and NINE WERE MISSED:
  // one tool imported it and nothing asserted its geometry. See tools/pursuit-test.mjs.
  'pursuit-test',
  'crowd-bill --selftest',
  // #91's table is a claim about photographs; every other check over these modules is about
  // triangles or determinism and stays green for any colours at all.
  'paint-census',
  // IN THE "OFFLINE" LIST THOUGH IT LAUNCHES A BROWSER, and the reason is cost rather than
  // principle: it only decodes three JPEGs on a blank page, 1 s a run, where boot-check is 443 s
  // and is gated behind --browser for that. It is here because paint-census cannot see a tone
  // RATIO that is wrong while still reaching both anchors — the `tone-ratio` row below is exactly
  // that mutation and this is the only gate that catches it.
  'paint-tone',
  // ALSO A BROWSER GATE ON THE OFFLINE LIST, and measured rather than assumed: 1.36 / 1.41 /
  // 1.43 s over three runs, which is CHEAPER than paint-tone beside it and 260x cheaper than
  // boot-check. It is the only thing in this repo that samples a PIXEL of a car: the paint-slot
  // tint is a vertex-shader rule, and paint-census checks source regexes, boot-check the uniform's
  // own getter, paint-tone committed PNGs a mutated source cannot reach. `tint-invert` passed all
  // three of those, all 70 of boot-check and all 65 of traffic-selftest.
  'car-pixel',
  // 1.33 s, and it is the only gate that reads `src/traffic.js`'s DECLARED speed limit or the
  // GATE on `src/wanted.js`'s idle bleed. #107's pricing turns on both: a `_speedLimit` that fell
  // through to one value, or a bleed that ran continuously instead of after `idleGrace`, each
  // leave every other gate green while moving the quantity the refusal is argued on by 7x.
  'speed-limit --selftest',
  // 4.1 s, and it is the only gate that measures the follower's CROSS-TRACK ERROR against the
  // lane it is tracking. #104 concluded "it is `followPath` leaving its own lane"; this says the
  // follower holds its lane to 9 cm on course it can actually follow, and 83% of the samples
  // that put the body past the lane are at corners tighter than the car's own turning circle.
  //
  // CORRECTED BY RUNNING A ROW. This comment first claimed its checks were "two-sided on that
  // split", which was a coverage claim I had not verified. Swept, `corner-now` came back
  // `roadpath-test route-drive playtest` and NOT lane-keep — because the six checks it had were
  // all RELATIONSHIPS (the forced band is worse than the achievable one; the matched-point
  // banding reads worse than the honest one), and removing the corner-speed ceiling makes every
  // one of them hold HARDER. A one-sided bound where the mutation pushes the quantity the
  // comfortable way is this file's recurring unfailable-check shape, arriving three at a time.
  //
  // It has a seventh check now, on the forced band's own magnitude, measured both ways:
  //     forced p90   3.052 shipped   7.065 under corner-now   x2.3
  //     achievable p90 1.187 shipped 1.169 under corner-now   unmoved, 88 of ~1361 over the lane
  // and it does catch it: FAIL at 7.065, PASS at 3.052. (Those are the driver's LEFT, where every
  // lane sat until #127; re-run on the right it is FAIL at 7.609, PASS at 2.996.) RESTATED BY #61:
  // with the junctions rounded to the car's turning circle the forced band reads 0.958 shipped and
  // 1.854 under corner-now, so the bound moved from 5.0 to 1.35 in the same commit, and an eighth
  // check says the fillet takes the course under a third of what any smoothing reached.
  'lane-keep --selftest',
  // 10.0 s, which is what makes it affordable here: 27 minutes over this table's 164 rows,
  // against playtest --selftest's 11.0 s and traffic-selftest's 23.4 s already on the list. I
  // added it expecting three minutes and a five-fold sweep regression, and priced it afterwards
  // rather than before — the wrong order, and the number is cheap either way.
  //
  // It is the only gate that separates `src/traffic.js`'s shunt FRAME count from its
  // distinct-CAR count. Every other reader of those two uses them as a boolean (`> 0`, `=== 0`),
  // so a build where `shuntCars` increments per frame is green in playtest --selftest,
  // reaction-test and damage-live alike — and a round then reads a contact rate 23x high, which
  // is what #87 did. Swept, `shunt-cars-frames` comes back caught by this gate ALONE.
  //
  // It also owns the no-fleet control arm, so it is the one place that says the follower alone
  // touches nothing at any speed up to 72 km/h — the bound that makes #87 entirely about traffic.
  'shunt-rate --selftest',
  // Milliseconds, and until this round `tools/budget.mjs` had NO selftest at all — it owns every
  // threshold this project argues with, is imported only by two seven-minute browser gates, and
  // so its WARN/FAIL boundary and its headroom column were never exercised offline. It also
  // pins `derivations` against the figures budget.mjs's own header derived by hand, so the two
  // cannot drift apart.
  'budget --selftest',
  // 2.4 s, a purpose-built page through the REAL PostStack, and the only gate that compiles a lit
  // material's shader and reads what the composite does with it. #114's exemption is a chunk patch
  // in three's lit materials plus one line in a composite shader, and nothing offline compiles
  // either: every row below is invisible to the other entries on this list by construction.
  'ao-emit',
  // About 3 s, the same kind of page: one fleet car, the player's car and a pedestrian-sized block in
  // front of a windscreen through the real PostStack (#130). The glazing's AO exemption is a block
  // after opaque_fragment in two car materials, and nothing else on this list renders AO over a car.
  'glass-ao',
  'glass-ao --selftest',
  // 2.8 s, the same kind of page as car-pixel: one traffic car through the REAL instanced material
  // from three sides at street height. The cabin is a ray cast inside that material's fragment
  // shader, so nothing else on this list can see any of the rows below it.
  'car-cabin',
  // A twentieth of a second: the real TimeOfDay through three's own LightShadow.updateMatrices, no
  // GL. #117's shimmer was a shadow box that followed the car to the micron, and nothing on this
  // list built a shadow camera at all.
  'shadow-stable',
  // About 3 s, the same kind of page as car-cabin, from behind: the plate's face is a fragment-shader
  // pattern on one slot, and its geometry is read off the builders before the browser starts — as
  // is the player's door mirrors' (#133), which nothing else on this list builds.
  'car-detail',
  // Under a second, offline. The lettering census over every sign face in the district, and since
  // #134 the street-name blades against the plan's own count: the only thing that reads a sign's
  // BACK face, which is where #134 was, so nothing above sees `blade-back-blank`.
  'sign-orient',
  'sign-orient --selftest',
  // Under half a second. The body shells off the built buffers — equal cost, the base shell
  // byte-identical, real variance, the window visible, the plate vertical, and since #125 the
  // wheels round. It was on CLAUDE.md's gate list and NOT on this one, so nothing it asserts had
  // ever been swept: `wheel-octagon` came back MISSED against a check written to catch it.
  'car-shapes',
  'car-shapes --selftest',
  // About 4 s, a purpose-built page: the real Sky at the night preset through the real PostStack
  // (#124). The star field is GLSL in the sky dome, and nothing else on this list draws a star.
  'star-strokes',
  'star-strokes --selftest',
  // #118's page, the same kind as ao-emit: five panels at known radiances through the real PostStack,
  // the bright pass's two arms off one load. Nothing else compiles BRIGHT_FRAG, so every bloom row
  // above is invisible to the rest of this list.
  'bloom-lit',
  // About 1 s. #132's census: every lamp, mast, utility pole, sign post and pavement prop against the
  // kerb face the streamer draws, by a classifier of its own. Nothing else on this list asks where
  // anything STANDS relative to the kerb — geom-audit asks whether it floats.
  'kerb-stand',
  // #136's page: the module's own street lamp, its light through the real LightPool and the real
  // PostStack at the night bars, at the old globe, the shipped one, the level that would order the glass
  // and the physical one. THE DEAREST ENTRY ON THIS LIST: 27 s a run measured with the box at load 6
  // (twelve arms, each two 1600 x 900 renders, because a bloom's footprint is in pixels and only the
  // hero's own resolution prices it), so about 75 minutes over this table's ~165 rows. It is here because
  // nothing else on the list draws a lamp's globe or lights anything with its light: every globe row
  // below is invisible to the rest of it, and boot-check sees only the wire.
  'globe-level',
  'globe-level --selftest',
  // Milliseconds: the arithmetic globe-level, globe-order and boot-check's globe arm share
  // (tools/globe-math.mjs) — the area off a buffer, the flux identity, a footprint.
  'globe-order --selftest',
];

/**
 * THE TABLE. Each line is a defect somebody could plausibly introduce — a reverted constant, a
 * dropped guard, a filter that stops filtering — written as the exact edit.
 *
 * `browser: true` marks a mutation only a gate that LOADS THE PAGE can see. district/main.js is
 * imported by no offline gate, so a mutation there is invisible to all sixteen by construction;
 * saying so in the table is the point, and `--browser` runs boot-check for those lines.
 */
const MUTATIONS = [
  // ---- src/traffic.js
  {
    /**
     * MEASURED INERT AT HEAD, so its MISS is not a gate gap. When this fix landed the revert was
     * plainly visible — the settled gap went dt-dependent, 6.29/2.03/2.03/2.46 against 6.29 at every
     * dt — and it is now bit-identical: sweeping six long two-way edges at three dt each, 0 of 18
     * (edge, dt) pairs differ at all, worst difference 0.000 m.
     *
     * The range bound and the OBB corridor landed between those two measurements and changed which
     * cars treat the player as a leader at all, and I have not bisected which of them made this
     * term redundant — it is not worth the hours for a predicate that is still the correct one (a
     * leader is ahead, not overlapping) and costs nothing to keep.
     *
     * Recorded rather than deleted, because a row that is inert TODAY is the row that tells you
     * something changed if it ever stops being inert. `inert` is asserted: if any gate ever catches
     * it, the sweep says the note is out of date.
     */
    id: 'gap-level', file: 'src/traffic.js',
    find: 'if (!(along > reach)) return Infinity;',
    to: 'if (!(along > 0)) return Infinity;',
    why: 'a car drawing level with the player reads a negative bumper gap and brakes 28x',
    inert: '0 of 18 (edge, dt) pairs differ, worst 0.000 m — nothing to notice',
  },
  {
    id: 'gap-range', file: 'src/traffic.js',
    find: 'return gap > PLAYER_WATCH_M ? Infinity : gap;',
    to: 'return gap;',
    why: 'the player becomes a leader from 600 m away, so the "it fired" counter counts nothing',
  },
  {
    id: 'gap-obb', file: 'src/traffic.js',
    find: '      : PLAYER_HALF_W * Math.abs(-pfz * nx + pfx * nz) + PLAYER_HALF_L * Math.abs(pfx * nx + pfz * nz);',
    to: '      : PLAYER_HALF_W;',
    why: 'a car parked ACROSS a lane is invisible again — the defect the corridor exists for',
  },
  {
    id: 'pinned', file: 'src/traffic.js',
    find: 'const playerPinned = playerIsLeader && car.v < 0.15;',
    to: 'const playerPinned = false;',
    why: 'cars stopped for the player are deleted as gridlocked, and the queue behind them too',
  },
  {
    id: 'drivable', file: 'src/traffic.js',
    find: '        && this._edgeDrivable(o.e, o.forward)',
    to: '        && true',
    why: 'traffic routes onto roads a car body cannot fit down',
  },
  // ---- src/pedestrians.js
  {
    /**
     * NOTHING VISIBLE CHANGES. Every body is still drawn in exactly the right place with
     * exactly the right pose -- the far tier simply goes back to submitting an invisible
     * instance for each near-held ped, which is 7,392 triangles at the frame the budget
     * gate's p95 selects and x2.00 in the gate's own number. A screenshot cannot see it and
     * neither can any pose assertion; only a bill can.
     */
    id: 'far-pack', file: 'src/pedestrians.js',
    find: '    if (s >= this._farLive) return;',
    to: '    if (true) return;',
    why: 'the far tier bills an invisible body for every near-held ped again',
  },
  {
    /**
     * The swap carries indices and not colours, so every drawn body is in the right place
     * wearing somebody else's shirt. This is the defect that looks like art direction
     * rather than a bug, and crowd-bill's colour-identity check is the only thing in the
     * list that can see it.
     */
    id: 'far-colour', file: 'src/pedestrians.js',
    find: '    if (pb >= 0 && this.peds[pb]) this._writeColors(a, this.peds[pb]);',
    to: '    if (false && this.peds[pb]) this._writeColors(a, this.peds[pb]);',
    why: 'a packed slot keeps the previous occupant\'s shirt and skin',
  },
  {
    id: 'avoid-r', file: 'src/pedestrians.js',
    find: 'export const AVOID_R = 2.86;',
    to: 'export const AVOID_R = 1.6;',
    why: 'the avoidance radius stops covering the car body — the round-3 clean miss',
  },
  {
    id: 'closing', file: 'src/pedestrians.js',
    find: 'if (!force && closing < PED_FREE_MS) return null;',
    to: 'if (!force && v < PED_FREE_MS) return null;',
    why: 'the free threshold goes back on the car\'s ground speed, not the closing speed',
  },
  {
    id: 'runover', file: 'src/pedestrians.js',
    find: '    if (!force && v < PED_FREE_MS) return null;\n    const fatal = v >= ANCHORS.pedKillSpeed;',
    to: '    const fatal = v >= ANCHORS.pedKillSpeed;',
    why: 'rolling onto a body at walking pace becomes a felony',
  },
  {
    id: 'ped-dir', file: 'src/pedestrians.js',
    find: 'if (!(L > 0) || !Number.isFinite(L)) return null;',
    to: 'if (false) return null;',
    why: 'a NaN or zero direction reaches the fall axis; a casualty stands bolt upright',
  },
  // ---- src/damage.js
  {
    id: 'crime-scale', file: 'src/damage.js',
    find: 'return this.majorSeverity > 0 ? severity / this.majorSeverity : 1;',
    to: 'return 1;',
    why: 'the crime charge goes back to speed-blind: a 110 km/h write-off costs 0 stars',
  },
  {
    id: 'free-dv', file: 'src/damage.js',
    find: 'if (!(dv > this.freeDv)) return null;',
    to: 'if (dv < this.freeDv) return null;',
    why: 'at exactly the free threshold a crime is filed with severity 0',
  },
  // ---- src/wanted.js
  {
    /**
     * WALKING PACE IS AN ESCAPE AGAIN. Reverts the reset to the speed test alone, which cannot
     * separate circling from pulling away — a blind playtester beat the whole pursuit on a 25 m
     * circle at 4.8 km/h, 2.7 m off a road, 0 of 3 arrested over the full 150 s where a parked car
     * at the same spot is taken in 9.6 s. `wanted-test` (d2) catches it: circling at 2.8, 4.8 and
     * 20 km/h all arrest now, and driving away at both 4.8 and 40 km/h still does not.
     */
    id: 'bust-sign', file: 'src/wanted.js',
    find: "    if (this.stars <= 0 || !player.held || outrun || (moving && (away ?? true))) {",
    to: "    if (this.stars <= 0 || !player.held || outrun || moving) {",
    why: 'circling at walking pace beats the pursuit again, without leaving the block',
  },
  {
    /**
     * ARRESTED AT 76 km/h, put back. Removes the running-pace term from the reset, which is the
     * shipped rule before this round: a unit that has stopped keeps station at the player's
     * projection at up to its own driving speed, stays `held` inside `holdRadius`, and the radial
     * receding test reads zero against a unit pacing alongside — so the clock completes while the
     * player drives. `tools/clear-time.mjs` measured it on its first real drive. `wanted-test`
     * §d2's paced arm is the catch: paced at 76 km/h must not arrest, paced at 20 km/h must.
     */
    id: 'bust-outrun', file: 'src/wanted.js',
    find: "    if (this.stars <= 0 || !player.held || outrun || (moving && (away ?? true))) {",
    to: "    if (this.stars <= 0 || !player.held || (moving && (away ?? true))) {",
    why: 'a unit pacing a player at 76 km/h arrests them',
  },
  {
    /**
     * THE DEAD END THIS PROJECT REMOVED TWICE, put back. `enginePower`'s `* 0.75` is the reason a
     * living car keeps 0.25 of power at its worst damage; its own comment says "never to zero
     * while the car lives, because a car that cannot move at all is a mission failure the player
     * cannot see coming and cannot do anything about". Making it `* 1.0` gives an UN-WRECKED car at
     * health 0.130 an engine power of exactly 0 — 60 s of full throttle reaches 0.005 m/s.
     *
     * MEASURED BEFORE THE CHECK WAS WRITTEN, and the measurement is why the check exists: NINE of
     * the ten offline gates passed this. The tenth, `roadpath-test`, failed ONE check of 106 —
     * "the timeout is longer than the worst honest time to travel one body length", reading 9.5 s
     * against **Infinity** — which is a bound on a stuck-detector timeout in a gate about path
     * following, not an assertion about the engine. And it OVER-TRIGGERS: it also fails floors of
     * 0.10 and 0.05, which reach 24.4 and 13.0 km/h and are a handicap rather than a dead end, so
     * it cannot tell "the defect is back" from "somebody retuned the handicap" — two readings that
     * want opposite responses.
     *
     * crash-test §9 is the assertion, and it discriminates: 3 of 79 fail at floor 0.00 and it
     * PASSES at 0.05. Its bound is `freeDv` 2.2 m/s, the FMVSS 581 threshold the damage model
     * takes its own free-contact class from and src/roadpath.js derives its crawl floor from.
     */
    id: 'engine-floor', file: 'src/damage.js',
    find: "    return 1 - clamp((this.regions.front - 0.35) / 0.5, 0, 1) * 0.75;",
    to: "    return 1 - clamp((this.regions.front - 0.35) / 0.5, 0, 1) * 1.0;",
    why: 'a living car at 0.13 health has no engine power and no way home — twice-shipped dead end',
  },
  {
    /**
     * THE IDLE BLEED UNGATED. `idleBleed` is 0.09 heat/s and the gate holds it off until
     * `idleGrace` (2.5 s) has passed with no new crime, so at a 3 s crime cadence it is live 16.7%
     * of the time and sheds 0.0150/s. Ungated it sheds 0.0900 — SIX TIMES more — and that single
     * factor decides whether repeated low-grade offences can ever make a player wanted. #107's
     * whole refusal is argued on the break-even scale this moves.
     *
     * The direction is the flattering one: a faster bleed is a more forgiving game, so nothing
     * breaks, nothing errors, and the meter simply stops being able to accumulate.
     *
     * CORRECTED, BY RUNNING THE ROW. This comment first said the row was "behaviour-preserving for
     * a player committing one crime and walking away, which is every other gate's case, so only an
     * instrument that charges REPEATEDLY at a known cadence can see it". The sweep says
     * `wanted-test speed-limit --selftest` — `wanted-test` catches it with SIX failures, among them
     * one named "heat holds during the grace window", which is a check on this exact gate. So the
     * quantity was already gated and the new gate is a second reading of it, not the only one.
     * `speed-limit-flat` below is the row that earns the new gate: caught by it alone.
     */
    id: 'bleed-ungated', file: 'src/wanted.js',
    find: "      if (this.heat > 0 && this.time - this._lastCrimeAt > this.idleGrace) {",
    to: "      if (this.heat > 0) {",
    why: 'repeated low-grade offences can no longer accumulate; the break-even scale moves 6x',
  },
  {
    /**
     * THE DECLARED SPEED LIMIT FLATTENED. `_speedLimit` reads the baked graph's own `r` field and
     * returns 15.5 / 12.5 / 9.0 / 6.5 m/s for primary / secondary / residential / service. Making
     * every road a primary is the defect a round would introduce by "simplifying" it, and it is
     * invisible to `traffic-selftest`: the fleet still drives, still holds its lane, still clears
     * junctions, and its cars still never exceed their own x1.15 jitter ceiling — because that
     * ceiling is relative to whatever the limit returns. Only a gate that asserts the limit has a
     * SPREAD can see it, and #107's price is computed per road class.
     */
    id: 'speed-limit-flat', file: 'src/traffic.js',
    find: "    if (r <= 2) return 15.5;      // primary",
    to: "    if (r <= 8) return 15.5;      // primary",
    why: 'every alley carries arterial traffic speed, and the district declares one limit',
  },
  {
    /**
     * THE FALLBACK INVERTED, which is the half that would otherwise be a free pass in the other
     * direction. `_recedingFrom` returns null when no unit has reported a position; defaulting
     * that to "not receding" arrests a player driving flat out on any host that does not feed unit
     * positions — and `district/main.js` feeds them while `tools/playtest.mjs` only does once a
     * pursuit exists. Nothing errors; a fleeing player simply gets taken at 40 km/h.
     */
    id: 'bust-sign-default', file: 'src/wanted.js',
    find: "    if (this.stars <= 0 || !player.held || outrun || (moving && (away ?? true))) {",
    to: "    if (this.stars <= 0 || !player.held || outrun || (moving && (away ?? false))) {",
    // RESTATED with the running-pace term: "driving flat out" is now reset by `outrun` whatever
    // the fallback says, so the fallback only decides speeds under ARREST_PACE_MS, and
    // `wanted-test` §d2 drives its no-position arm at 20 km/h for that reason.
    why: 'a host that reports no unit positions arrests a player pulling away under 25 km/h',
  },
  {
    /**
     * THE CRIME REPORT TAKES THE HEADLINE BACK. Strips the `status` flag the fix added, so
     * `composeLaw`'s notice outranks a live mission objective again. Measured on a registered pair
     * off ONE sim — the band composed twice per frame, so the crimes are identical — the law tenant
     * owns 33% of the headline against 0%, and the mission 67% against 100%. A blind playtester
     * measured the shipped version at 71-72% over two seeds of the tutorial mission.
     *
     * Nothing errors and both lines still appear; only which one is on top changes.
     */
    id: 'law-headline', file: 'src/wanted.js',
    find: "    return { objective: { text: label }, subtitle: note, status: true,",
    to: "    return { objective: { text: label }, subtitle: note, status: false,",
    why: 'a crime report outranks the mission objective again, 0% -> 33% of the headline',
  },
  {
    id: 'scene-watch', file: 'src/wanted.js',
    find: '    this._watchScene(player);\n',
    to: '',
    why: 'leaving the scene of an injury stops being an offence',
  },
  {
    id: 'scene-stop', file: 'src/wanted.js',
    find: '      if (Math.hypot(this.playerVel.x, this.playerVel.z) < SCENE_STOP_MS) {',
    to: '      if (true) {',
    why: 'driving off at speed counts as having stopped at the scene',
  },
  {
    id: 'scene-radius', file: 'src/wanted.js',
    find: 'SCENE_LEAVE_M = RESPONSE[1].spotRadius;',
    to: 'SCENE_LEAVE_M = 400;',
    why: 'the leave radius stops tracking the response table it is derived from',
  },
  // ---- src/vehicle.js
  {
    id: 'steer-pull', file: 'src/vehicle.js',
    find: 'const target = (steer * this.maxSteer + this.steerPull * this.maxSteer) * speedFactor;',
    to: 'const target = steer * this.maxSteer * speedFactor + this.steerPull * this.maxSteer;',
    why: 'the damage pull goes back to 59% of available authority at 140 km/h',
  },
  {
    id: 'reverse-taper', file: 'src/vehicle.js',
    find: '      t *= THREE.MathUtils.clamp(1 - rev / this.reverseMax, 0, 1);',
    to: '      t *= 1;',
    why: 'reverse has no speed ceiling',
  },
  // ---- src/hud.js
  {
    /**
     * THE YIELD RULE STOPS YIELDING. `composeBand`'s while-loop never advances, so a status tenant
     * keeps the headline whatever it is marked. A separate row from `law-headline` because the fix
     * spans two modules and either half can be reverted alone: this one is the hud.js half.
     */
    id: 'band-yield', file: 'src/hud.js',
    find: "  while (i < present.length - 1 && slots[present[i]].status) i++;",
    to: "  while (false && i < present.length - 1 && slots[present[i]].status) i++;",
    why: 'a status tenant no longer yields the headline, so the band rule is inert',
  },
  {
    /**
     * THE WHOLE ORDER, SO THE `find` IS THE WHOLE LITERAL — and it goes STALE every time a tenant
     * is added, which has now happened twice (`stuck`, then `garage`). That is the designed
     * behaviour rather than a cost: the staleness check reports it and the row gets re-aimed,
     * where a `find` narrow enough to survive would be a row about something other than the
     * order. Both of this file's BAND_ORDER rows were stale on the garage commit and both were
     * caught by that check.
     */
    id: 'band-order', file: 'src/hud.js',
    find: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'law', 'stuck', 'garage', 'mission',\n  'ended', 'offer'];",
    to: "export const BAND_ORDER = ['offer', 'ended', 'mission', 'garage', 'stuck', 'law', 'fence',\n  'wreck', 'busted'];",
    why: 'an offer outranks a wrecked car and the world fence in the objective band',
  },
  {
    id: 'fence-subtitle', file: 'src/hud.js',
    find: "    subtitle = `still on: ${objectiveLine(mission.objective)}`;",
    to: '    subtitle = null;',
    why: 'the fence eats a running mission\'s only sign of life',
  },
  {
    /**
     * THE REGRESSION A BLIND PLAYTESTER MEASURED AT 58% OF GLANCES. Drop the
     * `objectiveLine` call and the band prints `still on: [object Object]` for the
     * six of nine authored stages whose objective carries a distance. The two
     * commits that produced it were four days and two files apart and neither was
     * wrong alone; what failed is that the only gate passed a plain string.
     */
    id: 'objective-raw', file: 'src/hud.js',
    find: "    subtitle = `still on: ${objectiveLine(mission.objective)}`;",
    to: "    subtitle = `still on: ${mission.objective}`;",
    why: 'the band reads "still on: [object Object]" whenever the stage has a destination',
  },
  {
    id: 'pull-cue', file: 'src/hud.js',
    find: '    this._pullCue(ctx, L, d.steerPull);',
    to: '',
    why: 'nothing on screen says which way a damaged car pulls',
  },
  // ---- src/blockers.js
  {
    id: 'fence-dir', file: 'src/blockers.js',
    /**
     * ANCHORED TO THE STATEMENT, NOT THE EXPRESSION. `Math.sign(throttle) * dot > 0` alone went
     * AMBIGUOUS — 2 matches — when `composeFence`'s header started quoting the predicate in prose
     * to explain where the band's verb comes from. A `find` that a COMMENT can satisfy is one
     * explanatory sentence away from mutating nothing, or from mutating the comment.
     */
    find: 'if (throttle !== 0 && Math.sign(throttle) * dot > 0) throttle = 0;',
    to: 'if (throttle !== 0 && true) throttle = 0;',
    why: 'the world fence refuses power in both directions and strands the car outside',
  },
  // ---- src/roadpath.js
  {
    // Repointed by #128: the floor is CRAWL_MS now, derived, where it was a literal 2.2.
    id: 'crawl-floor', file: 'src/roadpath.js',
    find: '  return Math.max(CRAWL_MS, Math.min(gripSpeed(radius), steerableSpeed(radius)));',
    to: '  return Math.min(gripSpeed(radius), steerableSpeed(radius));',
    why: 'an impossible corner stops the car dead instead of letting it creep round',
  },
  {
    /**
     * #128, PUT BACK: the floor a SPEED equal to the free DELTA-V, which is what "free by
     * construction" claimed for as long as it shipped. Only a check that holds the crawl and
     * charges a clip at it can see the difference — the old check compared the two numbers.
     */
    id: 'crawl-floor-old', file: 'src/roadpath.js',
    find: 'export const CRAWL_MS = FREE_DV / (1 + WALL_E) - SPEED_DEADBAND - CRAWL_OVERRUN;',
    to: 'export const CRAWL_MS = FREE_DV;',
    why: 'the crawl is held at 2.5 m/s and a head-on clip there charges 2.88 against a free 2.2',
  },
  {
    id: 'crawl-no-overrun', file: 'src/roadpath.js',
    find: 'export const CRAWL_MS = FREE_DV / (1 + WALL_E) - SPEED_DEADBAND - CRAWL_OVERRUN;',
    to: 'export const CRAWL_MS = FREE_DV / (1 + WALL_E) - SPEED_DEADBAND;',
    why: 'the loop runs one control step past its deadband, so at a coarse step the clip charges 2.23',
  },
  {
    id: 'crawl-deadband', file: 'src/roadpath.js',
    find: '  if (over > SPEED_DEADBAND) brake = clamp(over / 3, 0.15, 1);',
    to: '  if (over > 0.6) brake = clamp(over / 3, 0.15, 1);',
    why: 'the loop holds its target plus a deadband the floor was not derived from',
  },
  {
    /**
     * #128, PUT BACK: the look-ahead tuned for the flat-gain steering. Every budget route-drive had
     * passed it — 88 contacts against 300, 1.987 against a free 2.2 — so only the headroom drive
     * (the course at cap + 4 m/s) can fail it, which is why that check exists.
     */
    id: 'follow-lookahead-old', file: 'src/roadpath.js',
    find: '  const lookAhead = clamp(2 + speed * 0.7, 3, 28);',
    to: '  const lookAhead = clamp(6 + speed * 0.9, 8, 28);',
    why: 'pure pursuit turns in early and cuts every junction; route-drive scrapes and has no headroom',
  },
  {
    /**
     * #127, PUT BACK. Every route lane returns to the driver's LEFT — the oncoming lane — and
     * NOTHING ELSE MOVES: offsetRight and laneOffsets read the same function, so the lane and its
     * clearance test agree with each other exactly as they did for as long as the defect shipped.
     * Only a check with an oracle OUTSIDE this module can see it, which is why roadpath-test
     * projects the offset through three.js's own camera and asks a fleet car which side it is on.
     */
    id: 'route-side', file: 'src/roadpath.js',
    find: '  return L > 0 ? [-dz / L, dx / L] : [0, 0];',
    to: '  return L > 0 ? [dz / L, -dx / L] : [0, 0];',
    why: 'every route lane drives on the driver\'s left, in the oncoming lane, and agrees with itself',
  },
  {
    // The margin's own derivation, given teeth: at 1.2 the follower clips building 51 at 21 m/s
    // on the first lap and the steering pull it leaves wrecks the car ten seconds later.
    id: 'lane-margin', file: 'src/roadpath.js',
    find: 'const LANE_MARGIN_M = 1.5;',
    to: 'const LANE_MARGIN_M = 1.2;',
    why: 'the lane fit leaves a quarter metre of slop and the follower at 22 m/s spends it on a wall',
  },
  {
    // #129 put back: the router ignores the car's heading, so a chained leg opens with a U-turn
    // behind a car doing 11 m/s and the follower circles into a building 41 m off its line.
    id: 'path-uturn', file: 'src/roadpath.js',
    find: '    const moving = Number.isFinite(heading) && Number.isFinite(speed) && speed >= MOVING_MS;',
    to: '    const moving = false;',
    why: 'a route opens behind a moving car and the follower cannot turn round in a street',
  },
  {
    // #129's second term put back: a route that opens ahead and doubles back along the car's own
    // edge — a dead end — reads as fine, so the car is sent to the end to turn round there.
    id: 'path-spur', file: 'src/roadpath.js',
    find: '        const doublesBack = moving && r.edges.length > 0 && r.edges[0].e === a.edge;',
    to: '        const doublesBack = false;',
    why: 'a moving car is sent up a dead end to turn round at its end, which it cannot do either',
  },
  {
    // #126's label put back: a parked-car contact is filed as a wall again, which charges nothing
    // differently and leaves every instrument that counts by kind reading a car as a facade.
    id: 'parked-kind', file: 'src/vehicle.js',
    find: "      kind: worstBox !== undefined ? 'parked' : worstProp !== undefined ? 'prop' : 'wall', box: worstBox };",
    to: "      kind: worstProp !== undefined ? 'prop' : 'wall', box: worstBox };",
    why: 'a parked car is filed as a building, so no instrument can tell which one the car hit',
  },
  // ---- src/blockers.js
  {
    // #126 part 2 undone: the static layer accepts its list and keeps none of it, so every pole,
    // signal, bollard, hydrant and trunk is a ghost again — and nothing visible changes.
    id: 'static-off', file: 'src/blockers.js',
    find: "    this.statics = list.map((c, i) => ({ x: c.x, z: c.z, r: c.r, kind: c.kind ?? 'prop', key: i, solid: true }));",
    to: '    this.statics = [];',
    why: 'the car drives through every lamp pole, tree and bollard again, and looks no different',
  },
  {
    // A car PUT on a bollard — a respawn, a harness teleport — is thrown off it as if it had crashed.
    id: 'static-ghost', file: 'src/blockers.js',
    find: '        if (!c.solid) continue;\n        c.solid = false;',
    to: '        if (!c.solid) continue;\n        continue;',
    why: 'a car put down on a bollard is charged a collision that never happened',
  },
  {
    id: 'resolve-eps', file: 'src/blockers.js',
    find: 'const EPS = 1e-6;',
    to: 'const EPS = 0;',
    why: 'resolveCircle stops converging: a parked car is charged an impact every frame',
  },
  // ---- src/mission.js
  {
    /**
     * THE STAGE CLOCK GOES BACK TO SHOWING NOTHING. Drops the countdown branch, so a stage with a
     * deadline and no destination renders the bare authored string again — which is what a blind
     * playtester measured over 237.9 s of `ambush`: two line families, no number, and then an
     * expiry into `dropHot` saying "No more time" about a deadline never shown.
     */
    id: 'stage-clock', file: 'src/mission.js',
    find: "        : left != null ? { text: s.objective, distance: left, unit: 's' }",
    to: "        : left != null ? s.objective",
    why: 'a timed stage with no destination shows no countdown, which is the shipped defect',
  },
  {
    /**
     * THE STALEMATE COMES BACK. Drops the network floor from `u.stopped`'s gate, so a unit only
     * ever clamps inside `reachRadius` — which is the build #89 measured: five of nine placements
     * of a stationary four-star player sat at four stars for the full 240 s with a unit 37 to
     * 136 m away, seen, untouchable and not allowed to leave. The single worst state this game can
     * be in, and it reads as nothing at all from the outside: no error, no stuck panel, every
     * number nominal.
     */
    id: 'arrest-floor', file: 'src/pursuit.js',
    find: '            && near.d <= this._localBest(u, target) + CLOSER_EPS_M',
    to: '            && false // eslint-disable-line',
    why: 'standing 38 to 136 m off a road is a stalemate again: seen, un-arrestable, un-escapable',
  },
  {
    /**
     * THE FLOOR BECOMES A CEILING. `>=` for `<=` makes every edge EXCEPT the closest one qualify,
     * so a unit clamps on the first far edge it reaches and never routes in — the failure #89
     * traced and warned against when it ruled out simply widening the radius, arriving through the
     * comparison rather than through the bound.
     */
    id: 'arrest-floor-inverted', file: 'src/pursuit.js',
    find: '            && near.d <= this._localBest(u, target) + CLOSER_EPS_M',
    to: '            && near.d >= this._localBest(u, target) + CLOSER_EPS_M',
    why: 'units stop on the first distant edge instead of routing closer, so the chase gets worse',
  },
  {
    /**
     * #108 ITSELF: THE ADMISSION GOES BACK TO THE NETWORK'S OWN MINIMUM. This is the shipped rule
     * between #89 and #108, and it is the subtle half of the stalemate — the hold is no longer
     * impossible, it is impossible at 58% of off-road spots and works at the rest, which reads as
     * the police being unreliable rather than as broken code. `_chooseNext` descends the distance
     * from an option's far endpoint and `bestApproach` minimises an edge's closest approach, so
     * the minimising edge is one no unit drives at 197 of 516 spots.
     */
    id: 'arrest-local-global', file: 'src/pursuit.js',
    find: '            && near.d <= this._localBest(u, target) + CLOSER_EPS_M',
    to: '            && near.d <= best + CLOSER_EPS_M',
    why: 'an arrest off the road works at 45 of 107 spots instead of 101, and which ones is topology',
  },
  {
    /**
     * THE OPTION SET COMES FROM THE WRONG END OF THE EDGE, which breaks `_localBest` AND
     * `_chooseNext` together because #108 made them share it — the point of the factoring. The
     * router then steers by the junction it came FROM, so the whole chase inverts.
     */
    id: 'arrest-option-end', file: 'src/pursuit.js',
    find: '    const v = this._endVertex(edge, forward);',
    to: '    const v = this._endVertex(edge, !forward);',
    why: 'units route by the junction behind them, and a unit can never be at a local minimum',
  },
  {
    /**
     * THE CAR STOPS WHERE NOBODY CAN WALK. Drops the walk from the admission, leaving it only in
     * `u.held`. The arrests still happen — 100 of 107 against 101 — so no count catches this; what
     * it costs is that 27% of stopped unit-frames become a car that has pulled up with no officer
     * able to reach the player. A unit stopping is the only cue this game gives that an arrest is
     * starting, so that build lies to the player a quarter of the time.
     */
    id: 'arrest-walk-admission', file: 'src/pursuit.js',
    find: '            && canWalk()))',
    to: '            ))',
    why: '27% of stopped police cars are parked for nothing, and stopping stops meaning anything',
  },
  {
    /**
     * THE TOLERANCE GOES. `_closestOn` reverses the point list for a backward unit, so the same
     * distance comes out of a different pair of roundings: measured over 88 targets x 935 edges
     * the two reads differ in 0.23% of pairs by up to 2.274e-13 m, and on a MINIMISING edge the
     * backward read exceeded the forward one in 5 of 89 cases. Without the tolerance a few ULPs
     * decide whether a player can be arrested at those spots.
     *
     * KEPT WITH ITS GAP WRITTEN DOWN: 5 of 89 is 5.6% of minimising pairs and a unit has to be
     * driving that edge BACKWARD at the time, so no end-to-end arm is likely to see it. The
     * tolerance's own relation to the noise and to the officer's radius IS asserted, in
     * pursuit-test §10(b), which is the part a future edit is likely to get wrong.
     */
    id: 'arrest-eps', file: 'src/pursuit.js',
    find: '            && near.d <= this._localBest(u, target) + CLOSER_EPS_M',
    to: '            && near.d <= this._localBest(u, target)',
    why: 'a few ULPs of float noise decide whether an arrest is possible on 5.6% of minimising edges',
  },
  {
    /**
     * ONE HITCH BUYS AN ESCAPE. `update` clamps dt to `maxDt` under a comment saying exactly why,
     * and nothing asserted it until #97's ladder was mis-measured by driving the module with one
     * 2.51 s step: the clock advanced 0.25 s, every second crime came back `reason: 'refractory'`,
     * and the table read 11 hits to one star where the answer is 2. Unclamped, a 900 ms frame
     * hitch hands the player 900 ms of escape clock, search decay and heat bleed in one go — and
     * headless capture here runs well under 1 fps, so every browser gate would be playing a
     * different game from the one a player does.
     */
    id: 'hitch-unclamped', file: 'src/wanted.js',
    find: '    const step = clamp(dt, 0, this.maxDt);',
    to: '    const step = dt;',
    why: 'a frame hitch hands the player that much escape clock, and a slow box is a cheat',
  },
  {
    /**
     * THE WALK IS FREE. `arrestSeconds` goes back to a constant, so an officer parked 500 m from
     * the only road still arrests in 4.0 s. This is the half that makes the floor fair — without
     * it, `bestApproach` turns the stalemate into an instant arrest at any distance the fleet can
     * see, which is worse than the stalemate rather than better.
     */
    id: 'arrest-clock', file: 'src/pursuit.js',
    find: '  return Math.max(BUST_HOLD_S, dist / RUN_SPEED);',
    to: '  return BUST_HOLD_S;',
    why: 'an arrest 500 m from the nearest road takes 4.0 s instead of 72.7',
  },
  {
    /**
     * THE CLAMP LOSES ITS DIRECTION. `min` for `max` lets a host SHORTEN an arrest below the
     * floor, and a `holdSeconds` of 0 is then an arrest on the first frame of the hold — no
     * countdown, no warning. A finite check alone cannot see it, which is this file's
     * `scale-sign` lesson in the other module.
     */
    id: 'bust-clamp-down', file: 'src/wanted.js',
    find: '      this.bustNeeds = Number.isFinite(asked) ? Math.max(BUST_HOLD_S, asked) : BUST_HOLD_S;',
    to: '      this.bustNeeds = Number.isFinite(asked) ? Math.min(BUST_HOLD_S, asked) : BUST_HOLD_S;',
    why: 'a host reporting 0 seconds of walk arrests the player on the first frame of the hold',
  },
  {
    /**
     * THE FIELD IS DROPPED AGAIN, at the whitelist, which is exactly where it was lost the first
     * time: both hosts set it, the bridge passes the object through, and `_watchBust` reads
     * `undefined`. Caught only by `stats.bustNoWalk` and the two gates written around it — every
     * arrest inside `reachRadius` is unaffected, so nothing a behavioural arm drives would differ.
     */
    id: 'bust-walk-dropped', file: 'src/wanted.js',
    find: '    if (Number.isFinite(player.holdSeconds)) p.holdSeconds = player.holdSeconds;',
    to: '    if (false) p.holdSeconds = player.holdSeconds;',
    why: 'the host says how long the walk is and the module never hears it, silently',
  },
  {
    /**
     * THE HUD COUNTS DOWN THE WRONG CLOCK. `bustIn` back to the floor, so a 19.5 s arrest shows
     * "4 s", reaches zero, and nothing happens for fifteen more seconds — `bust-never`'s defect
     * arriving through the label instead of the rule. No gameplay change at all.
     */
    id: 'bust-hud-floor', file: 'src/wanted.js',
    find: '      bustIn: this.bustFor > 0 ? Math.max(0, this.bustNeeds - this.bustFor) : null,',
    to: '      bustIn: this.bustFor > 0 ? Math.max(0, BUST_HOLD_S - this.bustFor) : null,',
    why: 'a 19.5 s arrest counts down from 4 s, hits zero, and nothing happens',
  },
  {
    /**
     * THE FLOOR LIFTS THE CHARGE INSTEAD OF REPLACING IT, which is #103's candidate lever rather
     * than a defect — and that is why it is here. Shipped, `max(heat + delta, c.min)` throws away
     * the first strike's severity entirely when the charge is under the floor, so a 10 km/h nudge
     * and a 58.8 km/h strike both cost exactly 1.0000 of heat and 26.1 s of wanted time. This row
     * is the alternative formula, so the KNOWN-BAD rows in `wanted-test` §f3 that record that
     * flatness cannot rot: if somebody takes the lever, those checks have to be restated.
     *
     * It is not shipped because it over-charges at the top of the table: `pedestrianKilled`'s
     * `min` is 2 and its charge AT the fatality switch is 2.0018 by construction, so lifting one
     * by the other makes a single kill four stars where the table says two.
     */
    id: 'heat-floor-lift', file: 'src/wanted.js',
    find: '    this.heat = Math.min(Math.max(this.heat + delta, c.min), this.maxStars + 0.99);',
    to: '    this.heat = Math.min(Math.max(this.heat, c.min) + delta, this.maxStars + 0.99);',
    why: 'the first strike graduates and one pedestrian killed becomes four stars instead of two',
  },
  {
    /**
     * REPEATS STOP STACKING. The charge replaces the running total instead of adding to it, so a
     * crime with a floor pins the meter at that floor for ever however many times it is committed:
     * 31 strikes at 23.7 km/h reach two stars shipped, and none ever would. This is the mutation
     * `wanted-test` §f3's ladder exists for — the flatness #103 reported is confined to the FIRST
     * strike, and this makes it the whole game.
     */
    id: 'heat-no-stack', file: 'src/wanted.js',
    find: '    this.heat = Math.min(Math.max(this.heat + delta, c.min), this.maxStars + 0.99);',
    to: '    this.heat = Math.min(Math.max(delta, c.min), this.maxStars + 0.99);',
    why: 'a hundred pedestrian strikes at 23.7 km/h are worth exactly one star, for ever',
  },
  {
    /**
     * A PICKUP FIRES AT ANY SPEED AGAIN, which is the shipped defect #100 is about: the measured
     * drive to the FLAGSHIP's pickup started the OTHER mission 13.8 s after the spawn, at
     * 24 km/h, with the player having pressed nothing. One line, leaving `stopMs`, the counter,
     * the cue and both hosts' wires in place, so what it reverts is exactly the rule.
     */
    id: 'pickup-moving', file: 'src/mission.js',
    find: '    if (speed >= this.stopMs) { this.refusedMoving++; return null; }',
    to: '    if (false) { this.refusedMoving++; return null; }',
    why: 'driving through a marker takes the job, 13.8 s after the spawn at 24 km/h',
  },
  {
    /**
     * THE PERMISSIVE DEFAULT, and it is the interesting half. `speed = 0` makes every caller that
     * forgets the argument silently keep the drive-through behaviour — a guard whose default is
     * the permissive case, which CLAUDE.md records twice as reading like a guard without being
     * one. BEHAVIOUR-PRESERVING for both shipped hosts, because both pass the speed: only the
     * throw checks can see it, and they are the reason it is caught.
     */
    id: 'pickup-speed-default', file: 'src/mission.js',
    find: '  pickupAt(x, z, speed) {',
    to: '  pickupAt(x, z, speed = 0) {',
    why: 'a host that forgets the speed conscripts silently instead of throwing',
  },
  {
    /**
     * THE REFUSAL LOSES ITS CUE. `composeOffer` always takes the notice branch, so a player sitting
     * in a pickup reads "Easy money. ... — 0 m" and is told nothing about why nothing is happening.
     * The distance is 0 there, so the line reads as an ARRIVAL: the worst shape a missing
     * instruction can take. A level a player cannot see is only allowed to refuse them if
     * something says so, which is `composeGarage`'s "stop here" and the reason this branch exists.
     */
    id: 'offer-cue', file: 'src/mission.js',
    find: '  if (at.inPickup && !at.stopped) {',
    to: '  if (false) {',
    why: 'the pickup refuses the player and says "— 0 m", which reads as having arrived',
  },
  {
    /**
     * THE THRESHOLD'S FALLBACK DRIFTS OFF THE CONSTANT IT COPIES. src/mission.js must not import
     * src/wanted.js, so `stopMs`'s default is a second copy of `SCENE_STOP_MS` — and a copy that
     * nothing re-derives is a magic number waiting for the real one to move under it. Both shipped
     * hosts pass the real one, so this is invisible to every behavioural arm; `mission-test` §13
     * carries the equality check for exactly that reason, as `damage-test` does for the garage's.
     */
    id: 'pickup-stopms-copy', file: 'src/mission.js',
    find: '    this.stopMs = opts.stopMs ?? 1.0;',
    to: '    this.stopMs = opts.stopMs ?? 2.5;',
    why: 'the board\'s fallback stops agreeing with src/wanted.js, silently for both hosts',
  },
  {
    /**
     * THE COUNTDOWN PRINTS SECONDS AS METRES. Drops the unit, and `objectiveLine` defaults to
     * metres by design — its own comment says a tenant that means seconds must not be able to
     * print them as metres. CLAUDE.md records the bust countdown shipping exactly this: "3 m" for
     * a 3 s countdown. Nothing errors and the number is still right; only its label is a lie.
     */
    id: 'stage-clock-unit', file: 'src/mission.js',
    find: "        : left != null ? { text: s.objective, distance: left, unit: 's' }",
    to: "        : left != null ? { text: s.objective, distance: left }",
    why: 'the stage countdown reads "240 m" for 240 seconds, which has shipped once before',
  },
  {
    /**
     * BEING ARRESTED IS GETTING AWAY AGAIN. Reverts `evaded` to the two conditions it had, which
     * `wanted.clear('busted')` both satisfies — so the flagship's chase stage is beaten by
     * committing a crime and letting the police take you, 13.6 s against 55-190 s, with a free
     * repair on top. A blind playtester found it from the outside with a one-variable A/B; no gate
     * saw it, because every arm that drove a chase to zero drove it there by DECAY and the two
     * cases were indistinguishable.
     *
     * A one-line revert that leaves the field, the event and both hosts' snapshots in place, so
     * nothing errors and the only thing that changes is which way a stage exits.
     */
    id: 'evaded-busted', file: 'src/mission.js',
    find: "    test: (t, s) => s.wantedStars <= 0 && s.wantedState === 'clear'\n      && s.wantedClearedBy === 'escaped',",
    to: "    test: (t, s) => s.wantedStars <= 0 && s.wantedState === 'clear',",
    why: 'an arrest satisfies "you got away", so the flagship\'s chase is won by being caught',
  },
  {
    /**
     * THE OTHER DIRECTION, and it is the one a one-sided check misses. `evaded` never fires, so
     * the chase stage cannot be left by evading and the flagship runs to its 240 s timeout every
     * time. Nothing errors and the mission still "works".
     */
    id: 'evaded-never', file: 'src/mission.js',
    find: "      && s.wantedClearedBy === 'escaped',",
    to: "      && s.wantedClearedBy === 'nothing-sets-this',",
    why: 'the chase stage can never be left by evading, so the flagship is unwinnable on its own terms',
  },
  {
    id: 'offer-latch', file: 'src/mission.js',
    find: '  arm(id) { this.latched.add(id); return this; }',
    to: '  arm(id) { return this; }',
    why: 'aborting a mission on its own marker restarts it immediately',
  },
  {
    /**
     * NEUTERS THE REFUSAL THAT KEEPS A POSITIONAL CUE OFF A NON-POSITIONAL STAGE.
     *
     * THIS ROW REPLACES `drop-flash`, which put `ambush`'s marker back on the drop and was the
     * record of the second of three wrong markers on that one stage. Its target line is gone:
     * `ambush` has no marker at all now, and `defineMission` refuses to let it have one, so the
     * old row went stale -- caught by the staleness check in this file's own selftest, which is
     * what that check is for.
     *
     * A row that simply re-added the marker would be worthless as evidence: `defineMission`
     * throws at import, every gate that reads src/missions.js exits non-zero, and non-zero is
     * how this tool spells "caught" -- the same trap CLAUDE.md records for `--browser` finding a
     * foreign document root. So the mutation is aimed at the GUARD instead. It is
     * behaviour-preserving on this tree, because nothing currently violates the rule; what it
     * removes is the ability to refuse the next violation.
     *
     * Caught by mission-test's known-bad arm, which plants four invalid shapes -- the ambush
     * that shipped, a marker 322 m from its reach, a marker whose only positional trigger is
     * `leave`, and one 0.1 m outside the radius -- and asserts every one is refused while four
     * legitimate shapes are accepted.
     */
    id: 'marker-guard', file: 'src/mission.js',
    find: '        if (!reaches.length) {',
    to: '        if (false && !reaches.length) {',
    why: 'a flee stage can be given a destination marker again, and nothing says no',
  },
  {
    /**
     * PUTS BACK A SUBTITLE THAT NAMES A CUE THAT NEVER FIRES.
     *
     * `ambush` is the one stage with no waypoint, so its subtitle is the WHOLE instruction, and
     * it used to end "watch the stars drop". Measured over 109 s of fleeing at 40 km/h: the
     * stars read 2 at every sample and went 2 -> 0 in ONE step at the stage transition, after
     * the stage was already won. The thing that does move is the wanted note -- SEEN ->
     * EVADING 11s -> SEEN -> REPORTED.
     *
     * Behaviour-preserving in every sense a simulation can see: identical geometry, identical
     * triggers, identical outcomes. Only a check that reads the WORDS against the module that
     * prints them can tell the two apart, which is why mission-test asks `composeWanted` for
     * the word rather than spelling it a second time.
     */
    id: 'flee-cue', file: 'src/missions.js',
    find: "      subtitle: 'Somebody talked. Break away and run the EVADING clock down.',",
    to: "      subtitle: 'Somebody talked. Get clear of them and stay clear — watch the stars drop.',",
    why: 'the only instruction on the only waypointless stage names a cue that never fires',
  },
  {
    /**
     * BEHAVIOUR-PRESERVING AND LINEAR IN THE MISSION'S TOTAL SIZE. The list is built over
     * every stage and then filtered back down to the active stage's own triggers, so every
     * outcome is identical and only the cost moves. It exists because mission-test's cost
     * check used to be `us < 5` on a box where unchanged code measures 4.861 to 5.690 - a
     * bound like that catches this mutation at 7.04 us on THIS box and passes it on a box
     * 1.5x faster, while failing correct code half the time here. The replacement compares
     * 4 stages against 404 inside one process, which is a ratio of the same operation, so
     * box speed cancels: x7.89 against a x2 bound.
     */
    id: 'stage-scan', file: 'src/mission.js',
    find: '    const list = Array.isArray(s.triggers) ? s.triggers : [];',
    to: '    const list = (this.mission.stages ?? []).flatMap((q) => (Array.isArray(q.triggers) ? q.triggers : [])).filter((t) => (Array.isArray(s.triggers) ? s.triggers : []).includes(t));',
    why: 'the runner scans every stage every frame; cost grows with the mission, not the stage',
  },
  // ---- src/roadpath.js
  {
    id: 'sine-cap', file: 'src/roadpath.js',
    find: '  const a90 = Math.min(Math.abs(err), Math.PI / 2);',
    to: '  const a90 = Math.abs(err);',
    why: 'pure pursuit cannot tell "pointing at it" from "pointing exactly away"',
  },
  {
    id: 'corner-now', file: 'src/roadpath.js',
    find: '    cornerSpeed(reqRadius));',
    to: '    Infinity);',
    why: 'the corner the car is IN stops being a speed ceiling; it floors the throttle at full lock',
  },
  // ---- src/traffic.js, the junction
  {
    id: 'junction', file: 'src/traffic.js',
    find: "if (cid !== car.id && this._conflicts(mv, other)) { ok = false; why = 'conflict'; break; }",
    to: 'if (false) { ok = false; }',
    why: 'cars stop yielding at junctions and drive through each other',
  },
  // ---- src/hud.js
  {
    id: 'minimap-reach', file: 'src/hud.js',
    find: 'export const MINIMAP_REACH_M = MINIMAP_ZOOM_M / 2;',
    to: 'export const MINIMAP_REACH_M = 1e9;',
    why: 'every job on the board shows as a blip from anywhere in the district',
  },
  {
    /**
     * DROPS THE BAND'S SIXTH TENANT. Nothing errors and five of the six lines still work, so the
     * whole band reads fine — the scene of an injury and the offence that was filed simply never
     * appear, which is the state the game shipped in for as long as `hitAndRun` has existed.
     */
    id: 'law-tenant', file: 'src/hud.js',
    // Only the first line of the literal, because dropping one name does not need the rest.
    find: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'law', 'stuck', 'garage', 'mission',",
    to: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'stuck', 'garage', 'mission',",
    why: 'the 85 m hit-and-run deadline is back to having no words on screen',
  },
  {
    /**
     * TAKES THE LAW OUT OF THE SET THAT KEEPS A MISSION'S SUBTITLE. This is the defect a SET
     * exists to prevent: the fence's rule was written as one `from === 'fence'` branch, and a
     * sixth tenant needing the same rule would silently not have it. A live mission goes
     * invisible for as long as a scene is up.
     */
    id: 'law-subtitle', file: 'src/hud.js',
    find: "const HOLDS_MISSION_SUBTITLE = new Set(['fence', 'law']);",
    to: "const HOLDS_MISSION_SUBTITLE = new Set(['fence']);",
    why: 'a running mission vanishes from the band while the law line is up',
  },
  {
    /**
     * PUTS THE LAW LINE'S DISTANCE BACK IN THE SUBTITLE, where `HOLDS_MISSION_SUBTITLE` deletes it
     * whenever a mission is live — which a blind playtester measured at 0 of 289 law glances with a
     * distance against 46 of 57 with no mission, on one 1.04 km drive. Nothing errors; the line
     * still reads perfectly with no mission running, which is why it shipped.
     */
    id: 'law-distance', file: 'src/wanted.js',
    find: "      : { objective: { text: 'STOP AT THE SCENE', distance: Math.max(0, sc.leaveIn ?? 0) },\n        subtitle: 'leaving is a second offence' };",
    to: "      : { objective: { text: 'STOP AT THE SCENE' },\n        subtitle: `leaving is a second offence — ${Math.max(0, sc.leaveIn ?? 0).toFixed(0)} m` };",
    why: 'the 85 m countdown disappears again whenever a mission is running',
  },
  {
    /**
     * PRINTS THE DISTANCE FROM THE SCENE INSTEAD OF THE DISTANCE TO THE CHARGE — the exact
     * inversion the line exists to avoid, and a number that counts UP while the danger grows.
     * Every check read `leaveIn` off the snapshot rather than off the composed line, so this was
     * missed by the whole offline list.
     */
    id: 'law-inverted', file: 'src/wanted.js',
    find: "      : { objective: { text: 'STOP AT THE SCENE', distance: Math.max(0, sc.leaveIn ?? 0) },",
    to: "      : { objective: { text: 'STOP AT THE SCENE', distance: Math.max(0, sc.d ?? 0) },",
    why: 'the band counts up from the scene instead of down to the charge',
  },
  {
    /**
     * DECOUPLES THE SCENE'S REPORTED DISTANCE FROM THE REAL ONE. `_watchScene` still decides
     * correctly on its own local, so the charge fires at exactly the same place and only the number
     * on screen is wrong — and the old relation check (`d + leaveIn === SCENE_LEAVE_M`) is an
     * algebraic identity in `sc.d`, so it passed for this and for `sc.d = 0` alike.
     */
    id: 'scene-halved', file: 'src/wanted.js',
    find: '    sc.d = d;',
    to: '    sc.d = d * 0.5;',
    why: 'the band promises 42 m of room when there are 21',
  },
  {
    /**
     * FREEZES THE EVADE COUNTDOWN at the full cooldown. Every sample of `remaining` was taken IN
     * CONTACT, where `evadeTimer` is pinned at zero and the two sides of the check are the same
     * number — so `EVADING 44s` for ever passed the whole offline list, which is the playtester's
     * original complaint reinstated.
     */
    id: 'evade-frozen', file: 'src/wanted.js',
    find: '      remaining: this.stars > 0 ? Math.max(0, req - this.evadeTimer) : 0,',
    to: '      remaining: this.stars > 0 ? req : 0,',
    why: 'the escape countdown stops counting down',
  },
  {
    /**
     * DROPS THE NOTICE'S SUBTITLE. Only `objective` was ever asserted for the notice line, so a
     * crime that has just made the player wanted says "nobody saw it".
     */
    id: 'notice-quiet', file: 'src/wanted.js',
    find: "    const note = stars > 0 ? `wanted — ${stars} star${stars === 1 ? '' : 's'}` : 'nobody saw it';",
    to: "    const note = 'nobody saw it';",
    why: 'a crime that raised the wanted level reports that nobody saw it',
  },
  {
    /**
     * STOPS THE MINIMAP ROTATING WITH THE CAR — the most visible minimap bug there is, and it
     * passed all 68 checks the file had, because they held the heading at 0 and asserted only
     * direction and monotonicity.
     */
    id: 'map-norotate', file: 'src/hud.js',
    find: '    const rot = northUp ? 0 : -s.heading;',
    to: '    const rot = 0;',
    why: 'the minimap freezes north-up and stops being car-relative',
  },
  {
    /**
     * HALVES THE MAP SCALE. The blip checks asserted "further away draws further out", which a
     * uniform scale error satisfies exactly.
     */
    id: 'map-scale', file: 'src/hud.js',
    find: '    const ppm = w / zoom;                       // design px per world metre',
    to: '    const ppm = w / zoom / 2;                       // design px per world metre',
    why: 'every blip draws at half its real distance from the car',
  },
  {
    /**
     * DROPS THE `m.x` TERM FROM THE MARKER HASH. The only arm over it moved a blip in Z, so a
     * police car closing purely in x stops redrawing the map for a stationary player.
     */
    id: 'hash-x', file: 'src/hud.js',
    find: '        sig += m.x + m.z * 7.13 + (m.kind ? m.kind.charCodeAt(0) : 0) * 131 + i * 0.011;',
    to: '        sig += m.z * 7.13 + (m.kind ? m.kind.charCodeAt(0) : 0) * 131 + i * 0.011;',
    why: 'a blip moving along x stops redrawing the minimap',
  },
  {
    /**
     * DROPS THE WAYPOINT FROM THE HASH. Its own comment says it is there so the on-foot car
     * waypoint, which is one reused object, still redraws the map.
     */
    id: 'hash-wp', file: 'src/hud.js',
    find: '      sig += s.waypoint.x * 3.7 + s.waypoint.z * 11.9 + 4409',
    to: '      sig += 4409',
    why: 'a moving waypoint stops redrawing the minimap',
  },
  {
    /**
     * DECOUPLES THE CUE'S THRESHOLD FROM THE EXPORTED ONE, one line below the constant that exists
     * to stop it — leaving a band 0.9% wide where the page draws a cue and `look()` says null.
     */
    id: 'pull-local', file: 'src/hud.js',
    find: '    const armFull = PULL_FULL_PX;',
    to: '    const armFull = L.w / 2;',
    why: 'the page and the harness disagree about the smallest visible steering pull',
  },
  {
    /**
     * THE DRAIN NEVER SHOWS AT ONE STAR, which is the case that matters most — am I about to be
     * clear? The drain arm used three stars only.
     */
    id: 'drain-onestar', file: 'src/hud.js',
    find: '    const drainAt = s.wanted - 1;',
    to: '    const drainAt = s.wanted > 1 ? s.wanted - 1 : -1;',
    why: 'the last star never drains, so the last escape has no countdown on the meter',
  },
  {
    /**
     * DROPS `evade` AND `wantedNote` FROM THE STATUS PANEL'S DIRTY LIST. Nothing errors and the
     * panel still draws — once. Measured over an 18 s four-star escape: 1 redraw instead of 1,079,
     * one note instead of eighteen, one star alpha instead of 739. The playtester's original
     * complaint, verbatim, with every check green.
     */
    id: 'status-dirty', file: 'src/hud.js',
    find: "    else if (k === 'wanted' || k === 'weapon' || k === 'wantedFlash'\n      || k === 'evade' || k === 'wantedNote') this._dirty.status = true;",
    to: "    else if (k === 'wanted' || k === 'weapon' || k === 'wantedFlash') this._dirty.status = true;",
    why: 'the whole wanted readout freezes on its first frame',
  },
  {
    /**
     * PINS THE STAR DRAIN OFF. Nothing else changes: the meter still counts, still flashes, and
     * still sheds — it just stops saying how nearly clear you are, which is the state a playtester
     * escaped four stars in over 96 s while reporting the count as the only field that ever moved.
     * Invisible to every gate but hud-cue, because it is a colour on a path fill.
     */
    id: 'star-drain', file: 'src/hud.js',
    find: '    const drain = flashing ? 0 : clamp(s.evade, 0, 1);',
    to: '    const drain = 0;',
    why: 'the top star stops draining, so the escape clock is unreadable again',
  },
  {
    /**
     * PUTS THE STEER-PULL CUE'S BLIND ZONE BACK. `0.02` is a defensible number on its own terms —
     * a hands-off car at that pull leaves a 2.35 m half-lane in 3.9 s at 50 km/h — and it is a
     * STEP at 9.2 pixels of arm, so the cue went from nothing straight to a nine-pixel bar. A
     * round-5 playtester measured an 11.12 m drift over 118.7 m underneath it with no cue at all.
     * Nothing errors and the cue still works everywhere it used to.
     */
    id: 'pull-blind', file: 'src/hud.js',
    find: '    if (!(armFull * frac >= 1)) return;',
    to: '    if (!(mag > 0.02)) return;',
    why: 'a 13 km/h scrape is back to biasing the steering with nothing on screen',
  },
  {
    /**
     * DROPS THE MARKER HASH. The map still redraws whenever the PLAYER moves, so nothing looks
     * wrong while driving — and a police car closing on a player who has STOPPED leaves the map
     * holding its last frame, which is exactly when it is being read. Every blip the HUD had
     * before this round was a fixed job on the board, so identity comparison was enough.
     */
    id: 'marker-sig', file: 'src/hud.js',
    find: '    if (sig !== this._markerSig) { this._markerSig = sig; this._dirty.map = true; }',
    to: '    if (false) { this._markerSig = sig; this._dirty.map = true; }',
    why: 'a moving blip stops redrawing the minimap for a stationary player',
  },
  {
    /**
     * TURNS THE PROGRESS ANCHOR OFF. Nothing errors, nothing about the geometry changes, and the
     * follower goes back to holding the throttle open against a building for as long as the caller
     * lets it: measured at `i` 5/26 of a CLEAR route, 3.38 m of movement and 36,892 contacts over
     * 400 s. Invisible to every gate in the list before this round, because `route-drive` and
     * `roadpath-test` both point the car along the path before they start.
     */
    id: 'stuck-anchor', file: 'src/roadpath.js',
    find: '  const dt = opts.dt ?? 0;',
    to: '  const dt = 0;',
    why: 'the follower pushes a building at full throttle for ever again',
  },
  {
    /**
     * DROPS THE BACKING LATCH. This is the subtle one and it looks like a simplification: while
     * backing, the commanded throttle is NEGATIVE, so a detector conditioned on "drive is
     * commanded" clears its own counter and the reverse lasts exactly one frame. The car then
     * creeps forward for another full timeout and repeats, which reads as a recovery that is
     * trying and is not.
     */
    id: 'stuck-latch', file: 'src/roadpath.js',
    find: '    } else if (state.backing) {',
    to: '    } else if (false) {',
    why: 'the recovery reverse lasts one frame and the car never gets clear',
  },
  {
    /**
     * PUTS THE TIMEOUT INSIDE HONEST ACCELERATION. 9.5 s is 1.5x the measured 6.30 s a damaged car
     * at the follower's lowest commanded throttle needs to travel one body length from rest, so a
     * 2 s timeout backs the car out of every standing start — while a route it can drive still
     * finishes, so nothing looks broken.
     */
    id: 'stuck-early', file: 'src/roadpath.js',
    find: 'const STUCK_S = 9.5;',
    to: 'const STUCK_S = 2.0;',
    why: 'the follower reverses out of its own standing starts',
  },
  // ---- src/blockers.js: the world fence
  {
    /**
     * THE FENCE NAMES THE WRONG CONTROL AGAIN. Inverts the verb, so a nose pointing OUT of the
     * district is told to drive — which `worldFence` refuses — and a nose pointing home is told to
     * reverse. A blind playtester measured the consequence of naming no control at all: 0-89
     * degrees of nose-off covered 0.1 m under 30 s of full throttle, against 210.9 m in reverse.
     *
     * `blocker-test` §12 catches it because it compares the word against the REFUSAL rather than
     * against an angle: for each nose angle it asks the module what it does to a full forward
     * throttle and asserts the verb names reverse exactly where forward was taken away.
     */
    id: 'fence-verb', file: 'src/blockers.js',
    find: "    subtitle: f.noseOut ? 'reverse' : 'drive',",
    to: "    subtitle: f.noseOut ? 'drive' : 'reverse',",
    why: 'the fence tells a car pointing out of the district to drive, which is the refused control',
  },
  {
    /**
     * PUTS THE SIGN TEST BACK. This is the defect itself: a car at rest outside the fence has an
     * outward velocity of numerical noise whose sign flips, so about half of all frames scored a
     * full brake and a parked car 30 m out was held on a mean brake of 0.990. Nothing errors and
     * the fence still contains — it contains by pinning the car, and 180 s of full throttle at the
     * tangential pose then moves it one metre.
     */
    id: 'fence-latch', file: 'src/blockers.js',
    find: '  const leavingK = depthK * Math.min(1, Math.max(0, outV) / FENCE_BRAKE_MS);',
    to: '  const leavingK = depthK * (outV > 0 ? 1 : 0);',
    why: 'a parked car outside the fence is held on full brake by its own rounding error',
  },
  {
    /**
     * DROPS THE CRAWL. The car is un-pinned and nothing replaces the containment the pin was
     * accidentally providing: measured, 180 s of held throttle tours 3,074 m along the outside of
     * the world at 146 km/h. Every other fence property still holds, which is why this needs its
     * own check rather than riding on the ones above.
     */
    id: 'fence-crawl', file: 'src/blockers.js',
    find: '  const crawlK = homing ? 0 : Math.min(1, Math.max(0, speed - FENCE_CRAWL_MS) / FENCE_CRAWL_MS);',
    to: '  const crawlK = 0;',
    why: 'the outside of the world can be toured at 146 km/h again',
  },
  {
    /**
     * CAPS A CAR THAT IS COMING HOME. The dead end CLAUDE.md records twice — the wrecked car with
     * no power, and the first world fence that stranded the player 786 m out — arriving a third
     * time through the crawl. Everything still recovers, just slower, which is exactly the kind of
     * regression a gate has to measure rather than look at.
     */
    id: 'fence-homing', file: 'src/blockers.js',
    find: '  const homing = outV < -FENCE_CRAWL_MS && -outV > speed * FENCE_HOMING_COS;',
    to: '  const homing = false;',
    why: 'driving home is slowed to a crawl, which is how the fence stranded a player before',
  },
  // ---- district/main.js: no offline gate imports it, so these are invisible by construction.
  {
    /**
     * PUTS THE 1 s TYPE REFRACTORY BACK ON A PEDESTRIAN. Nothing errors and the repeat case still
     * behaves, because VictimWindow owns it — what comes back is that a SECOND, DIFFERENT person
     * struck within a second is free. At 40 km/h that is 11.1 m of pavement, and a playtester
     * measured 8 charges for 15 knockdowns in a live crowd.
     */
    id: 'ped-refractory', file: 'src/wanted.js',
    find: "  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 2.00, cool: 8,  refractory: 0, min: 1, scene: true }),",
    to: "  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 2.00, cool: 8,  refractory: 1.0, min: 1, scene: true }),",
    why: 'a second casualty within 11 m is forgiven again',
  },
  {
    /**
     * This line used to target district/main.js, where it was MISSED by every gate because no
     * offline gate imports that file. The rule is `VictimWindow` in src/wanted.js now — moved there
     * BECAUSE of this miss — so the mutation follows it, and wanted-test owns it.
     */
    id: 'charge-window', file: 'src/wanted.js',
    find: '    if (last !== undefined && now - last <= this.seconds) return false;',
    to: '    if (false) return false;',
    why: 'one pedestrian is charged every knockdown cycle again',
  },
  {
    /**
     * THE FLASH GOES BACK TO MEANING THE OPPOSITE THING. `state === SEARCH` is what
     * district/main.js fed for a whole round, under a comment arguing the flash should mean the
     * level is DRAINING — while src/hud.js also raised it on any star increase, so "they have
     * just spotted me" and "I have shaken them" were one animation. Nothing errors; the alarm
     * simply fires when you are getting away and goes quiet when you are caught.
     */
    id: 'flash-search', file: 'src/wanted.js',
    find: '  const flash = s.state === STATES.ACTIVE;',
    to: '  const flash = s.state === STATES.SEARCH;',
    why: 'the star meter\'s alarm means "you are nearly clear" again, as well as "they have you"',
  },
  {
    /**
     * THE OFFENCE IS NEVER RECORDED, so the band never names one. The rules are untouched: heat
     * rises, stars rise, `hitAndRun` still files itself at 85 m — and a playtester drove off from
     * a pedestrian at 40 km/h with not one field of the HUD changing, which is this exact state.
     */
    id: 'crime-notice', file: 'src/wanted.js',
    find: "    this._notice = { id, label: c.label, t: this.time };",
    to: "    this._notice = null;",
    why: 'a filed crime goes back to being silent',
  },
  {
    /**
     * THE SCENE'S DISTANCE STOPS TRACKING. `_watchScene` still decides correctly — the rule reads
     * its own local `d` — so the charge fires at exactly the same place; only the number on screen
     * freezes at 0, so the band promises 85 m of room for ever. A rule and its readout computed
     * from two different quantities is the drift this field exists to prevent.
     */
    id: 'scene-distance', file: 'src/wanted.js',
    find: '    sc.d = d;',
    to: '    sc.d = 0;',
    why: 'the countdown to the hit-and-run charge never moves',
  },
  {
    id: 'loop-breaker', file: 'district/main.js',
    /**
     * The condition, not an assignment: `looping` is a `const`, so `looping = false` THROWS, and a
     * gate that catches a malformed mutation has told you nothing about the rule. It read
     * "caught by boot-check(threw)" until this was fixed, which is exactly the distinction this
     * tool reports separately.
     */
    find: '  const looping = !!candidate && respawnHistory.some((h) => simTime - h.t < LOOP_S',
    to: '  const looping = false && respawnHistory.some((h) => simTime - h.t < LOOP_S',
    why: 'the respawn puts the car back into whatever wrecked it, for ever',
    browser: true,
  },
  {
    /**
     * THE POLICE COME OFF THE MINIMAP. `MARKER_STYLE.enemy` was defined in src/hud.js and the
     * string 'enemy' appeared nowhere else in the tree, so a five-star chase with eight units
     * spawning 150-470 m out showed nothing at all. Only a gate that loads the page can see it:
     * the harness has no pursuit layer, so there are no unit positions for an offline gate to
     * check against.
     */
    id: 'enemy-blips', file: 'district/main.js',
    find: "  for (let i = 0; i < units.length; i++) n = pushHudMarker(n, units[i].x, units[i].z, 'enemy');",
    to: "  for (let i = 0; i < 0; i++) n = pushHudMarker(n, units[i].x, units[i].z, 'enemy');",
    why: 'a chase shows no police anywhere on the map again',
    browser: true,
  },
  {
    /**
     * THE ORDERING FIX, REVERTED WHOLE. A wall at 60 km/h goes back to 2.50 heat and two stars and
     * a civilian car to 4.17 and FOUR, against 1.00 and one star for a struck person — two crimes
     * the table gives no floor at all out-charging every floored one. Nothing errors and nothing
     * looks wrong from inside either module: damage.js's scale is correct, wanted.js's ladder is
     * correct, and only the two put side by side show it. wanted-test §24 is that comparison.
     */
    id: 'charge-cap', file: 'src/wanted.js',
    find: '    const delta = (c.min ?? 0) > 0 ? raw : floorlessCharge(raw);',
    to: '    const delta = raw;',
    why: 'a wall at 60 km/h is twice the crime of a person again, and a car four times',
  },
  {
    /**
     * THE CAP PUT ON THE WRONG HALF OF THE TABLE. Floored crimes are the ones that must NOT be
     * capped — their floor is what ranks them above — so capping those and freeing the floorless
     * ones is the fix applied exactly backwards. `officerDown` at 8.33x can no longer reach five
     * stars, which is the whole point of giving it a floor of four.
     */
    id: 'cap-inverted', file: 'src/wanted.js',
    find: '    const delta = (c.min ?? 0) > 0 ? raw : floorlessCharge(raw);',
    to: '    const delta = (c.min ?? 0) > 0 ? floorlessCharge(raw) : raw;',
    why: 'the worst offence in the table becomes the mildest',
  },
  {
    /**
     * THE CAP STOPS BEING THE TABLE'S OWN LOWEST FLOOR and becomes a number. 2.5 is above the
     * floor a struck person carries, so the wall inversion comes back at full size while every
     * absolute reading still looks plausible — this is the shape CLAUDE.md records as "a threshold
     * that holds at one value and fails at every other".
     */
    id: 'cap-literal', file: 'src/wanted.js',
    find: '  .map((c) => c.min ?? 0).filter((m) => m > 0));',
    to: '  .map((c) => c.min ?? 0).filter((m) => m > 0)) * 2.5;',
    why: 'the ceiling is no longer derived from the table it is meant to rank against',
  },
  {
    /**
     * THE PEDESTRIAN CHARGE GOES FLAT AGAIN. `min: 1` swallows every product under 1, so at 1.15
     * the charge crosses that only at 75 km/h and reads 1.00 from 8 to 75 — the range src/damage.js
     * documented and refused. Reverting it breaks the continuity at the classification switch as
     * well: 1.14 below and 2.04 above, a 1.8x step at one published speed.
     */
    id: 'ped-heat', file: 'src/wanted.js',
    find: "  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 2.00, cool: 8,  refractory: 0, min: 1, scene: true }),",
    to: "  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 1.15, cool: 8,  refractory: 0, min: 1, scene: true }),",
    why: 'the charge is flat from 8 to 75 km/h and steps 1.8x at the fatality switch',
  },
  {
    /**
     * THE PEDESTRIAN SCALE STOPS BEING A FUNCTION OF SPEED. Every strike charges the reference
     * case, so an 8 km/h clip is two stars — which is `missions.js`'s `wantedAtLeast: 2` firing on
     * one accident, the exact defect that trigger's threshold was raised to stop. The ORDERING
     * checks in §24 all still pass, because two is more than a wall's one: the arms that see this
     * are the ones that name the mild case, in wanted-test §5b and mission-test.
     */
    id: 'ped-scale-flat', file: 'src/damage.js',
    find: '    return ref > 0 ? pedFatalityRisk(v) / ref : 1;',
    to: '    return 1;',
    why: 'an 8 km/h clip costs what a 77 km/h one does, and re-enters the mission ambush',
  },
  {
    /**
     * THE RUN-OVER SITE GOES BACK TO ITS LITERAL `scale: 1`, which is how it shipped: a 2 km/h
     * roll over a body charged exactly what a 76 km/h one did. This row targets src/damage.js and
     * not district/main.js BECAUSE of the miss `charge-window` above records — no offline gate
     * imports main.js, so the rule was moved into `runOverCrime` where damage-test can reach it.
     * Writing the mutation was what said the rule was in the wrong module.
     */
    id: 'runover-scale', file: 'src/damage.js',
    find: '    return { crime, scale: this.pedCrimeScale(speed) };',
    to: '    return { crime, scale: 1 };',
    why: 'a roll at walking pace is charged as a fatal-threshold strike',
  },
  {
    /**
     * AND THE OTHER HALF OF THE SAME CALL: the crime stops following the body's own fatality
     * verdict and falls back to the classifier's, which reads the CAR's speed. Those agree today,
     * which is the property damage-test asserts — so this is the mutation that says the agreement
     * is checked rather than assumed.
     */
    id: 'runover-verdict', file: 'src/damage.js',
    find: '      : (fatal ? \'pedestrianKilled\' : \'pedestrianHit\');',
    to: '      : \'pedestrianHit\';',
    why: 'driving over a body at 110 km/h is filed as a non-fatal strike',
  },
  {
    /**
     * THE WIRE ITSELF, in district/main.js, marked [browser] because nothing offline imports it.
     * Recorded rather than left out: a reverted wire puts the whole rule back in the call site and
     * the module's gate still passes, which is the shape this file exists to make visible.
     */
    id: 'runover-wire', file: 'district/main.js',
    find: '      const rv = damage.runOverCrime(over, r.fatal);',
    to: "      const rv = { crime: r.fatal ? 'pedestrianKilled' : 'pedestrianHit', scale: 1 };",
    why: 'the call site decides the charge again, past the module that owns it',
    browser: true,
  },
  {
    /**
     * THE BUST NEVER FIRES. The clock still arms and still shows the player a countdown, and the
     * countdown simply never reaches the end — which reads as "the police are bad at catching you"
     * rather than as a broken rule, and is exactly how the pursuit shipped for months.
     */
    id: 'bust-never', file: 'src/wanted.js',
    find: '    if (this.bustFor < this.bustNeeds) return false;',
    to: '    if (true) return false;',
    why: 'the countdown runs to zero and nothing happens, for ever',
  },
  {
    /**
     * THE CLOCK ACCUMULATES INSTEAD OF RESETTING, so four separate one-second stops add up to a
     * bust. Nothing looks wrong from a single stop; what breaks is that moving away no longer
     * saves you, which is the one thing the rule promises.
     */
    id: 'bust-accumulate', file: 'src/wanted.js',
    find: '      this.bustFor = 0;\n      this._bustThrottle = false;\n      return false;',
    to: '      this._bustThrottle = false;\n      return false;',
    why: 'the out stops working: four interrupted stops become an arrest',
  },
  {
    /**
     * THE SPEED TERM GOES, so the clock runs while you are driving. A unit that pulls alongside on
     * a straight busts you at 70 km/h. It is the term whose absence a stationary test cannot see.
     *
     * AND THAT SENTENCE DESCRIBED THE SHIPPED BUILD, not just this mutation. Once #95 made the reset
     * `moving && away`, a unit pacing on a parallel line read as "not receding" at any speed, so
     * "a unit alongside you at speed is an arrest" was true at HEAD — tools/clear-time.mjs was
     * busted at 76 km/h on its first drive. This row was caught all the while, by wanted-test's
     * DRIVING AWAY arm, which recedes radially from a parked unit: a different geometry, caught
     * for a reason that was not the one in the `why`. A row's sentence is a claim about the
     * shipped code as well as about the mutation, and nothing checked the first half. Repointed
     * at the line ARREST_PACE_MS rewrote, removing both terms as before; the paced arm is the
     * catch it was always described as.
     */
    id: 'bust-any-speed', file: 'src/wanted.js',
    find: '    if (this.stars <= 0 || !player.held || outrun || (moving && (away ?? true))) {',
    to: '    if (this.stars <= 0 || !player.held) {',
    why: 'a unit alongside you at speed is an arrest',
  },
  {
    /**
     * A PURSUIT UNIT CANNOT STOP AGAIN, which is how it shipped: greedy road-graph pursuit drives
     * through the player at 22 m/s for ever. Measured against a stationary target over 400 s, the
     * longest contiguous time any unit spent within a car length was 0.8 s while the minimum
     * distance reached was 0.1 m — touching constantly, holding never. NOTHING about the chase
     * looks different; the bust simply becomes unreachable.
     */
    id: 'hold-never', file: 'src/pursuit.js',
    find: '      if ((near.d <= this.reachRadius\n          || (best > this.reachRadius\n            && near.d <= this._localBest(u, target) + CLOSER_EPS_M\n            && canWalk()))\n        && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
    to: '      if (false) {',
    why: 'the police drive through you at 79 km/h and can never catch anybody',
  },
  {
    /**
     * THE HOLD STOPS BEING STICKY, which is the defect this round actually shipped and had to
     * trace at the frame. A `hold-reroute` row sat beside this one for an hour and was DELETED
     * rather than kept: it reverted a `!u.held` guard that this sweep then could not distinguish
     * from HEAD, because with the hold sticky the guard is redundant — so the guard went too, and
     * src/pursuit.js records why. A row nothing can tell apart is not evidence of coverage. A stationary player is not stationary — the plan's target is the live
     * position and a braked car settles by sub-millimetre amounts — so any backwards drift in the
     * closest approach fails `u.t <= near.t` and the unit leaves for good. `held` was true for
     * exactly two frames at a time, 21 arms of the clock in 80 s, peak 0.017 s, and two arms of
     * one scenario 0.2 m apart disagreed about whether the player was ever caught.
     */
    id: 'hold-ratchet', file: 'src/pursuit.js',
    find: '      if ((near.d <= this.reachRadius\n          || (best > this.reachRadius\n            && near.d <= this._localBest(u, target) + CLOSER_EPS_M\n            && canWalk()))\n        && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
    to: '      if ((near.d <= this.reachRadius\n          || (best > this.reachRadius\n            && near.d <= this._localBest(u, target) + CLOSER_EPS_M\n            && canWalk()))\n        && (wantT > near.t && u.t <= near.t)) {',
    why: 'a hold lasts two frames, so being caught becomes a coin flip',
  },
  {
    /**
     * THE ROUTER'S OPTION RULE REVERTED to the far-endpoint descent it replaced — which is what
     * `src/pursuit.js` shipped until #109, and which costs 25-30 unarrestable spots across the
     * district (`tools/router-lever.mjs --draws N`: 122 never-arrestable spots against 99, and the
     * 2 the lever creates are named in docs/BACKLOG.md).
     *
     * IT SHIPPED WITH NO GATE, which this row exists to say out loud. Measured: the endpoint-only
     * rule passes §1-§9 of `pursuit-test`, `arrest-band` with IDENTICAL coverage (same 8 arrest
     * distances, same escape at 264 m, still "no stalemate row"), `playtest --selftest`,
     * `wanted-test` and `boot-check` at its full 103 checks. The effect is a statistic over 1,636
     * spots and no gate can assert a statistic, so `pursuit-test` §10 asserts the RULE instead —
     * it hunts the real network for a junction where the two rules disagree and checks the module
     * takes the improving option, plus the fallback's own case where nothing improves.
     *
     * Both halves are needed: a rule that ALWAYS prefers the approach has no fallback being
     * tested, and one that never fires is not a rule. §10 reads `stats.approachPicks` 0 -> 1 on
     * the first and 1 -> 1 on the second.
     */
    id: 'router-endpoint', file: 'src/pursuit.js',
    find: '    const hereD = this._closestOn(unit.edge, unit.forward, target).d;',
    to: '    const hereD = -Infinity;',
    why: '25-30 spots across the district go back to being unarrestable, and §10 is the only gate',
  },
  {
    /**
     * STATION-KEEPING UNBOUNDED, which is the defect this row was written FROM rather than for:
     * `u.t = near.t` is what the module shipped, and it teleports. `near.t` is a moving target's
     * projection onto the edge, and a projection slides along a curve faster than the target
     * moves wherever the curve runs near-parallel to the motion. At seed 3, target circling at
     * 0.45 m a frame, a held unit on edge 100 walked `t` backwards 5.7054 m in one 1/30 s frame
     * — a drawn displacement of 5.6518 m against a `speed * dt` of 0.733, and 14.87 m counting
     * reroute frames. 170 m/s, backwards, on a car that has stopped.
     *
     * AND `pursuit-test` §4 WAS GREEN OVER IT for as long as both existed, because it ran one
     * seed: 17 reproduces nothing and 3 reproduces 5.65 m. The section sweeps five seeds now, and
     * that is the only reason this row is catchable at all — which makes it the second instance
     * in one session of a single random draw passing a check over a live defect, after #109's
     * coverage metric.
     *
     * The bound is the car's own speed in either direction and needs no constant, and it is
     * BEHAVIOUR-PRESERVING in the arrest: `arrest-band` is byte-identical to its three-run
     * baseline across the change, and `pursuit-test` holds 48 of 48. So nothing but the teleport
     * moved, which is what says the bound is a bound and not a retune.
     */
    id: 'hold-unbounded', file: 'src/pursuit.js',
    find: '        const step = this.speed * dt;\n        u.t = Math.max(u.t - step, Math.min(near.t, u.t + step));',
    to: '        u.t = near.t;',
    why: 'a stopped police car slides 5.65 m backwards in one frame, at 170 m/s',
  },
  {
    /**
     * THE PAVEMENTS GO BACK INTO THE ROADS. A walk is offset from its own edge and checked
     * against BUILDINGS; nothing checked it against other streets, so 2,302 of 6,521 baked
     * points — 35.30% — lay inside some carriageway, 2,296 of them a NEIGHBOURING street's. The
     * pavement of a 2.8 m service alley ran down the middle of a 13.2 m tertiary road, and the
     * crowd walked it: of 31 contacts on a 9.43 km drive with no traffic, 19 had the pedestrian
     * inside the carriageway.
     *
     * The identity here is what the code did before, not an invented break: nothing errors, the
     * crowd still fills, and the only thing that changes is where people stand.
     */
    id: 'walk-in-road', file: 'src/pedestrians.js',
    find: '    const trimmed = best ? this._trimOffCarriageway(best.pts) : null;',
    to: '    const trimmed = best ? best.pts : null;',
    why: 'a third of the pavement network goes back to running down the middle of other streets',
  },
  {
    /**
     * THE PUSH OUT OF THE ROAD RESOLVES ONE KERB AND STOPS. A junction puts a ped inside two
     * carriageways at once, so one pass leaves them in the other one: measured, the deepest ped
     * in a 48-crowd sat 0.5878 m inside a carriageway and 3 of 48 were over 10 cm in, AFTER the
     * push had run. `src/blockers.js`'s `resolveCircle` documents the identical corner case, and
     * from the outside a resolver that converges and one that gives up look the same.
     */
    id: 'road-push-once', file: 'src/pedestrians.js',
    find: '    for (let pass = 0; pass < ROAD_PUSH_PASSES; pass++) {',
    to: '    for (let pass = 0; pass < 1; pass++) {',
    why: 'at a junction a ped is pushed out of one carriageway and left in the crossing one',
  },
  {
    /**
     * THE STANDOFF BECOMES THE DISPLACEMENT AGAIN. Standing a ped off the kerb by
     * `BUILDING_MARGIN` lifts anyone who has just drifted over the line the whole 0.28 m back:
     * 9,311 pushes on 2.69% of ped-frames at p50 0.2898 m, max 0.3118 — eleven walk steps in one
     * frame, 9,311 of 9,311 over a centimetre. Nobody ends up in the road, so every head-count
     * check still passes; what changes is that the crowd twitches.
     */
    id: 'road-push-hop', file: 'src/pedestrians.js',
    find: '      ped.x = px + ox * (sg.half + 1e-4);',
    to: '      ped.x = px + ox * (sg.half + BUILDING_MARGIN);',
    why: 'the crowd hops 0.29 m sideways on 2.7% of frames instead of being clamped',
  },
  {
    /**
     * #121: THE PAVEMENT GOES BACK IN FRONT OF THE KERB. src/kerb.js widened every street with a
     * parking lane to 2.74 m past the ribbon and the crowd's insets stayed where the kerb used to
     * be, so every kerbed pavement was laid at 1.9 m — in the parking lane, through the cars
     * streetfurniture.js parks at 1.30. Measured over three foci: 51-56% of walker-frames on a
     * kerbed street in the parking lane, 6.9-10.1% inside one of the pool's 44 cars.
     *
     * Under the kerb-section bake the old insets bake NO kerbed pavement at all, so the offset
     * check alone would pass on a minimum over nothing; its count guard is what catches this.
     */
    id: 'ped-kerb-insets', file: 'src/pedestrians.js',
    find: '  _insetsFor(e) { return kerbedEdge(e) ? KERB_INSETS : INSETS; }',
    to: '  _insetsFor(e) { return INSETS; }',
    why: 'every kerbed street\'s pavement goes back to the parking lane, through the parked cars',
  },
  {
    /**
     * #121's second defect: THE PERSONAL LANE POINTS BACKWARD WALKERS INTO THE ROAD. `_targetAt`
     * applies the lane along the TRAVEL direction's normal and the pavement is offset along the
     * EDGE's, so signing it by side alone sent every backward walker toward the road by its whole
     * 0.48-0.90 m band, under a comment saying it "always points AWAY from the carriageway".
     * Measured mid-walk: forward p50 +0.23 m, backward p50 -0.73. Behind the kerb, 3.60 less 0.90
     * is the back chamfer, and the kerb row's bollards stand at 2.85.
     */
    id: 'ped-lane-sign', file: 'src/pedestrians.js',
    find: '    const away = (ped.side ? -1 : 1) * (ped.forward ? 1 : -1);',
    to: '    const away = ped.side ? -1 : 1;',
    why: 'half the crowd walks 0.48-0.90 m on the road side of its pavement, onto the kerb',
  },
  {
    /**
     * #121's third: A PAVEMENT IS HELD TO THE CARRIAGEWAY ALONE. With the insets fixed, 422 of
     * 65,998 kerbed pavement samples still sat inside a parked car's body, 419 of them ANOTHER
     * street's slot: the inner pavement of a divided road laid down its neighbour's parking lane,
     * and walk ends reaching into a cross street's lane. Shrinking the kerb section back to the
     * travelled way is exactly that build.
     */
    id: 'ped-kerb-section', file: 'src/pedestrians.js',
    find: '      if (Math.hypot(x - px, z - pz) < sg.kerb) return true;',
    to: '      if (Math.hypot(x - px, z - pz) < sg.half) return true;',
    why: 'pavements run down the parking lane of the street beside them, through its cars',
  },
  {
    /**
     * #122: A PED IS HANDED A PAVEMENT ACROSS THE ROAD. `_chooseNext` admitted anything within 16 m
     * and a narrow street's far pavement is nearer, `_pushOffRoad` holds the ped at the kerb, and
     * the push clears the stuck clock — so the ped walks into the kerb for good. 67 of 96 at the
     * hero focus within 120 s, every one heading across a road.
     */
    id: 'ped-cross-refuse', file: 'src/pedestrians.js',
    find: '        if (this._handoverCrosses(ped.x, ped.z, leave, q, q2)) {',
    to: '        if (false) {',
    why: 'two thirds of the crowd ends up standing at a kerb for the rest of the session',
  },
  {
    /**
     * #122's second half: THE LANE TARGET IS NOT CLAMPED. The personal lane points away from the
     * ped's own road and an alley can run right beside the pavement on that side; the displaced
     * target lands in its carriageway and the push holds the ped at its edge. One ped, 38 s of a
     * 60 s run, at `reaction-test`'s own focus.
     */
    id: 'ped-lane-clamp', file: 'src/pedestrians.js',
    find: '    if (this._onCarriageway(out.x, out.z)) { out.x = p.x; out.z = p.z; this.stats.laneClamps++; }',
    to: '',
    why: 'a ped beside an alley walks into the alley\'s kerb and stays there',
  },
  {
    /**
     * #126: THE PARKED CARS' LOCAL FRAME WITH ONE SIGN FLIPPED. The box keeps its size and loses its
     * orientation, so on every street that is not axis-aligned the solid car sits beside the drawn
     * one, and a car turned a quarter has its length across. Nothing visible changes.
     */
    id: 'car-box-frame', file: 'src/blockers.js',
    find: '    const la = ux * b.c - uz * b.s;              // across: local +x is (cos yaw, -sin yaw)',
    to: '    const la = ux * b.c + uz * b.s;              // across: local +x is (cos yaw, -sin yaw)',
    why: 'a parked car is solid beside where it is drawn on every street that is not axis-aligned',
  },
  {
    /**
     * #126: NO GHOST. A parked car the pool draws on top of the player's car is solid at once, and
     * the resolver throws the car sideways out of a collision that never happened — and charges it.
     */
    id: 'car-box-ghost', file: 'src/blockers.js',
    find: '        box.solid = false;',
    to: '        box.solid = true;',
    why: 'a parked car that pops in under the player throws the car sideways and charges a crash',
  },
  {
    /** #126: a teleport onto a parked car is charged as driving into it. */
    id: 'car-box-release', file: 'src/blockers.js',
    find: '  release(body = [], r = 0) {\n    let n = 0;',
    to: '  release(body = [], r = 0) {\n    let n = 0; return n;',
    why: 'a respawn or a harness teleport beside a parked car is charged as a crash',
  },
  {
    /** #126: the push out of a parked car can end inside the building behind the pavement. */
    id: 'car-box-wallpass', file: 'src/blockers.js',
    find: '    const w2 = this.base ? this.base.resolveCircle(px, pz, r, maxIters) : null;',
    to: '    const w2 = null;',
    why: 'squeezed between a parked car and a wall, the car is pushed into the wall',
  },
  {
    /**
     * #126: THE HOST WIRE. The car keeps the building index and the parked cars are pictures again —
     * every offline check of CarBlockers stays green, because they construct it themselves.
     */
    id: 'car-box-wire', file: 'district/main.js',
    find: 'vehicle.blockers = carBlockers;\nvehicle.damage = damage;',
    to: 'vehicle.blockers = blockers;\nvehicle.damage = damage;',
    why: 'the car drives through every parked car in the district again',
    browser: true,
  },
  {
    /**
     * THE JAM CLOCK RESETS ON EVERY CONTACT-FREE STEP, which is how `_trackJam` was first
     * written and it NEVER FIRED. A wedged car rocks: measured at 120 Hz in a 4 m bay, a body
     * sample is corrected on 77.0% of steps and the contact-free gaps run p50 0.0167 s, p95 and
     * worst 0.0333 s — four steps. So the clock was reset about 350 times in 30 s and `stuckFor`
     * never got past one step, against a dwell of 4 s.
     *
     * INVISIBLE TO EVERYTHING BUT A REAL-GEOMETRY ARM. The detector's input sweep passes — it
     * feeds `touched` every step, so the gap never happens — and so does the band ladder, and so
     * does the `look()` wire, because all three drive the composer rather than the car.
     * blocker-test's pin arms are what tell the two apart, which is why they exist.
     */
    id: 'jam-reset', file: 'src/vehicle.js',
    find: '    this._sinceContact = touched ? 0 : (this._sinceContact ?? Infinity) + dt;',
    to: '    this._sinceContact = touched ? 0 : Infinity;',
    why: 'the wedged-car cue never fires, because a pinned car is not touching every step',
  },
  {
    /**
     * THE CUE NAMES THE DIRECTION ALREADY BEING TRIED. Behaviour-preserving in every sense a
     * simulation can see: the clock, the contacts and the car's position are identical, and the
     * line is still there with correct English in it. It just tells a player holding full
     * throttle against a wall to hold full throttle against a wall. Measured at a real pin,
     * forward moves 0.183 m and reverse 28.7 m, so the word is the entire value of the cue.
     */
    id: 'jam-word', file: 'src/vehicle.js',
    find: "    subtitle: (v.stuckDir ?? 0) < 0 ? 'drive' : 'reverse',",
    to: "    subtitle: (v.stuckDir ?? 0) < 0 ? 'reverse' : 'drive',",
    why: 'a nose-in jam is told to drive forward, which is what it is already doing',
  },
  {
    /**
     * THE HOST STOPS PASSING THE TENANT. [browser], because nothing offline imports
     * district/main.js. `composeStuck` still works, `BAND_ORDER` still lists `stuck`, hud-cue's
     * ladder still passes — the line is composed by nobody, so the page never shows it. This is
     * the same shape as `host-reach` and as the fleet that was never created: a module that is
     * right and a wire that does not exist.
     */
    id: 'jam-tenant', file: 'district/main.js',
    find: "  const stuckLine = mode === 'car' ? composeStuck(vehicle) : null;",
    to: '  const stuckLine = null;',
    why: 'the page never tells a wedged player anything, however right the module is',
    browser: true,
  },
  {
    /**
     * THE REACH RING KEEPS THE PREVIOUS STAGE'S RADIUS. The band counts to a reach trigger's
     * EDGE and the minimap now draws that zone, so the two readouts agree — and the radius has
     * to be in the dirty hash or a stage whose zone is a different size never redraws it. The
     * pin still moves and still redraws, so the map looks alive the whole time; the ring is
     * simply the wrong size, which is exactly the disagreement the ring exists to remove.
     */
    id: 'hash-wp-radius', file: 'src/hud.js',
    find: '        + (s.waypoint.radius ?? 0) * 17.3;',
    to: '        + 0;',
    why: "the minimap keeps the previous stage's reach ring on screen",
  },
  {
    /**
     * THE FIRST WORDS OF THE GAME GO BACK TO BEING A NOTE TO ITS OWN AUTHOR. `brief` is what the
     * offer band shows a player standing near a marker, and `shakedown` is the nearest job to
     * the spawn — so for most players it is the first text in the game. A playtester read
     * `SHAKEDOWN / Two markers by the bayfront. Exists so the wiring can be checked in a minute.
     * — 30 m`. Nothing errors and the mission plays identically.
     */
    id: 'brief-author', file: 'src/missions.js',
    find: "  brief: 'Easy money. Two markers by the bayfront, a few hundred metres apart.',",
    to: "  brief: 'Two markers by the bayfront. Exists so the wiring can be checked in a minute.',",
    why: "the game's opening line explains why the mission exists to whoever built it",
  },
  {
    /**
     * THE END-OF-MISSION LINE'S CLOCK TICKS WHILE IT IS HIDDEN AGAIN. [browser], because the hold
     * lives in district/main.js and nothing offline imports it. BAND_ORDER puts `wreck` above
     * `ended`, so a mission lost BY being wrecked spent `WRECK_HOLD_S` of its `MISSION_END_S`
     * behind the wreck line: 4.0 s of "THE CAR IS WRECKED" and then 1.9 s of "MISSION ABORTED"
     * against a 6 s hold. The line still appears, which is why a check on "is it shown" cannot
     * see this and boot-check reads the clock instead.
     */
    id: 'end-hidden', file: 'district/main.js',
    find: "  if (missionEndFor > 0 && band.from === 'ended') {",
    to: '  if (missionEndFor > 0) {',
    why: 'a mission lost to a wreck is announced for 1.9 s of its 6 s hold',
    browser: true,
  },
  {
    /**
     * THE SCENE NEVER LETS GO OF THE OBJECTIVE BAND AGAIN.
     *
     * `src/hud.js`'s BAND_ORDER puts `law` above `mission` and `offer`, and `_watchScene` used to
     * keep a scene live until the player drove `SCENE_LEAVE_M` = 85 m — stopping inside it set
     * `stopped` with no timeout. So one clipped pedestrian plus a stop hid the mission objective,
     * the completion line and every job offer indefinitely. Measured, 600 s parked at a scene
     * with a live mission: band from `law` 600.0 s, 100.0%, ONE distinct line, mission 0.0 s.
     *
     * A blind playtester found it twice — 600 s beside a job marker 30 m away, and 360 s at five
     * stars with no mission at all. Nothing errors, no crime changes (`cooperated` is latched on
     * the stop and outlives the scene, and the leave branch only files `hitAndRun` when the
     * driver did NOT stop), and the line on screen is correct English about a true fact. It is
     * only never anything else.
     *
     * Caught in two places on purpose, because the defect spans two modules and neither is wrong
     * alone: wanted-test §23(f) sweeps the acknowledgement's own window, and hud-cue — the one
     * gate that imports both — measures what the band is occupied by over 600 s.
     */
    id: 'scene-forever', file: 'src/wanted.js',
    find: '      if (sc.stopped && this.time - sc.stoppedAt >= LAW_NOTICE_S) {',
    to: '      if (false) {',
    why: 'stopping at a scene takes the objective band and never gives it back',
  },
  {
    /**
     * THE BAND STOPS SAYING IT. Four seconds with no cue is a player being teleported for no
     * stated reason — and `composeLaw` still returns the scene line underneath, so the HUD looks
     * busy and correct while the thing about to happen is invisible.
     */
    id: 'bust-silent', file: 'src/wanted.js',
    find: '  if (s.bustIn != null) {',
    to: '  if (false) {',
    why: 'you are arrested with no warning and no countdown',
  },
  {
    /**
     * THE HOST STOPS PAYING FOR IT: the level clears, and the mission, the repair and the return
     * do not happen. [browser] because nothing offline imports district/main.js — tools/playtest
     * carries its own copy of this wiring, which is why THAT one is gated and this one is recorded.
     */
    id: 'bust-free', file: 'district/main.js',
    find: "    else mission.abort('busted');",
    to: '    else bustStats.cooperated++;',
    why: 'being arrested costs nothing: the mission survives it',
    browser: true,
  },
  {
    /**
     * THE ARREST GOES BACK TO BEING A CAR'S REACH INSTEAD OF AN OFFICER'S, which is how it
     * shipped. `holdRadius` is the distance from an edge's centreline to a car at the kerb of
     * the widest road — 8.75 m — and it decided `held`, so the hold was a function of how far
     * the PLAYER was from a road while `RESPONSE[].spotRadius` lets the police see you from
     * 85-175 m. A blind playtester found it by playing: stop 15.6 m off a centreline at four
     * stars and you get 180.5 s on the brake with 0 busts and a unit holding on 0% of frames.
     *
     * Nothing errors and the chase looks identical — the cars drive the same roads at the same
     * speed and park in the same places. Only an arrest that does not happen is different, and
     * only at distances no screenshot distinguishes. pursuit-test §9 is what tells them apart,
     * by band: 0/8 arrestable at 8.75-16 m against 8/8.
     */
    id: 'reach-car', file: 'src/pursuit.js',
    find: '    return this._reachR ?? (this._reachR = Math.max(this.holdRadius, RUN_SPEED * BUST_HOLD_S));',
    to: '    return this._reachR ?? (this._reachR = this.holdRadius);',
    why: 'standing 15 m off a road is immunity from arrest again',
  },
  {
    /**
     * THE OFFICER WALKS THROUGH WALLS. `_footPathClear` is what stops the 28 m reach being a
     * bare radius, and a version that always returns true is INVISIBLE to every band figure in
     * pursuit-test §9 — those read the same with the predicate deleted, which is exactly why
     * the section carries a separate control for it. 37 of 1,624 real kerb-to-player lines are
     * blocked, and at blocked positions 3,223 of 4,953 stopped unit-frames must NOT hold.
     *
     * Behaviour-preserving everywhere the line is clear, which is 97.7% of the district.
     */
    id: 'walk-free', file: 'src/pursuit.js',
    find: '    const n = Math.max(1, Math.ceil(len / FOOT_STEP_M));',
    to: '    const n = 0;',
    why: 'the police arrest you through a building wall',
  },
  {
    /**
     * THE HOST KEEPS ITS OWN OLD COPY OF THE BOUND. [browser], because nothing offline imports
     * district/main.js — and this is the row that records the most expensive hour of this
     * change: widening the module did nothing a player could feel, because the frame loop
     * re-tested the held unit against the player with `holdRadius`. Measured in that state, at
     * 14.15 m off a road and four stars: held true on 98.5% of samples, longest hold 197.0 s,
     * busts 0 in 200 s. With the host reading the module instead, an arrest at 7.3 s.
     *
     * Caught by boot-check, which compares the number the host lands on against the module's
     * published `reachR` — the `??` fallback to the old bound is otherwise silent.
     */
    id: 'host-reach', file: 'district/main.js',
    find: '  return pursuit ? (pursuit.reachRadius ?? pursuit.holdRadius ?? 0) : 0;',
    to: '  return pursuit ? (pursuit.holdRadius ?? 0) : 0;',
    why: 'the module can reach 28 m and the host still refuses past 8.75',
    browser: true,
  },
  {
    /**
     * THE HOLD RADIUS GOES BACK TO READING A CLASS RANK AS A WIDTH, which is how it shipped:
     * `e.r` is primary 2 / secondary 3 / tertiary 4 / residential 5 / service 8, and `e.w` is the
     * width in metres. 5 + 2.15 = 7.15 instead of 6.6 + 2.15 = 8.75. A blind playtester measured
     * what the 1.6 m cost: standing 8, 9 or 10 m from a centreline at five stars was 0 of 5
     * arrests with the clock never arming, against 5 of 5 at 0, 6 and 7 m.
     */
    id: 'hold-rank', file: 'src/pursuit.js',
    find: '      for (const e of this.d.edges) if (e.w > widest) widest = e.w;',
    to: '      for (const e of this.d.edges) if (e.r > widest) widest = e.r;',
    why: 'the hold radius is a road class rank again, so a wide street is immunity',
  },
  {
    /**
     * A STEP OUT OF THE CAR IS 114 m/s OF TRAVEL AGAIN. `toggleVehicle` moves the body 1.9 m in
     * one frame and the reported position switches between the player's and the car's, so without
     * the declaration the smoothed velocity spikes over the stop threshold and the clock is
     * zeroed. Pressing F every second armed it 109 times in 120 s, peak 0.59 of 4, no arrest.
     */
    id: 'teleport-blind', file: 'src/wanted.js',
    find: '    if (player.teleported) {',
    to: '    if (false) {',
    why: 'the F key is immunity from arrest again',
  },
  {
    /**
     * THE ONE WORD THAT SAYS HOW TO ESCAPE IS DELETED DURING A MISSION. `HOLDS_MISSION_SUBTITLE`
     * hands a running mission's objective to the subtitle of any tenant above it, and `law` is in
     * that set, so the bust countdown read "still on: DRIVE EAST ALONG MARLIN STREET" instead of
     * "drive" in every mission — measured at 0 of them. Nothing errors and the band looks busy.
     */
    id: 'verb-eaten', file: 'src/hud.js',
    find: '  if (!pick.ownSubtitle && HOLDS_MISSION_SUBTITLE.has(from) && mission && mission.objective) {',
    to: '  if (HOLDS_MISSION_SUBTITLE.has(from) && mission && mission.objective) {',
    why: 'a player being arrested mid-mission is never told that driving is the out',
  },
  {
    /**
     * STOPPING AT THE SCENE STOPS PROTECTING THE JOB, which is how it shipped: a blind playtester
     * obeyed "STOP AT THE SCENE", braked, and was arrested at 22.5-32.7 s with the mission aborted
     * 4 times out of 4 — while ignoring the instruction kept the mission 4 of 4 and cost 0.80
     * heat, no extra star and 11.7 s. The band still SAYS the arrest will not cost the job, so the
     * defect is the game lying to the player rather than anything looking broken.
     */
    id: 'coop-never', file: 'src/wanted.js',
    find: '          this.cooperated = true;',
    to: '          this.cooperated = false;',
    why: 'obeying the instruction costs the mission again, and the band promises it will not',
  },
  {
    /**
     * AND THE OTHER WAY: one stop excuses every arrest for the rest of the wanted level. The flag
     * is bounded by the NEXT offence — you stopped, and then you did something else — and without
     * that bound a driver who cooperated once could ram cruisers with the job protected.
     */
    id: 'coop-forever', file: 'src/wanted.js',
    find: '    this.cooperated = false;\n\n    const prev = this.stars;',
    to: '\n    const prev = this.stars;',
    why: 'cooperating once protects the job through every offence that follows',
  },
  {
    /**
     * THE BAND TELLS A WEDGED PLAYER TO DRIVE, which is advice they are already following. A blind
     * playtester nosed into a building at full throttle and was arrested at 9.3 / 13.0 / 19.5 s in
     * 3 of 4 spots, at 0.07-0.25 km/h, while reverse clears the stop threshold in 2.2 s. In
     * ordinary play one 9.9 m/s wall impact was BOTH the crime that summoned the police and the
     * thing that stopped the escape. Nothing errors; the HUD just gives the wrong direction.
     */
    id: 'verb-forward', file: 'src/wanted.js',
    find: "      subtitle: s.bustStuck ? 'reverse' : 'drive', ownSubtitle: true };",
    to: "      subtitle: 'drive', ownSubtitle: true };",
    why: 'a player wedged against a wall at full throttle is told to drive',
  },
  {
    /**
     * AND THE OTHER WAY: every hold says "reverse", including to a player who has not touched the
     * throttle and could simply drive off. The latch is what makes the verb mean something.
     */
    id: 'verb-always-rev', file: 'src/wanted.js',
    find: "    if ((player.throttle ?? 0) > 0.05) this._bustThrottle = true;",
    to: "    this._bustThrottle = true;",
    why: 'everyone is told to reverse, including a player who only has to drive away',
  },
  {
    /**
     * AN OFF-BY-ONE IN `_closestOn`'s WALK, and the reason it matters is the shape of this
     * district: 414 of 935 edges are TWO-POINT, so dropping the last segment drops the only one
     * and the hold becomes impossible on nearly half the network. A reviewer measured it at 42%
     * of the drivable network, 116.3 s of hold going to 0 with the closest approach still 0.22 m.
     * On a multi-point edge the same mutation is nearly harmless, which is why it needs the whole
     * network walked rather than a sample.
     */
    id: 'closest-lastseg', file: 'src/pursuit.js',
    find: '    for (let k = 0; k < pts.length - 1; k++) {\n      const a = pts[k], b = pts[k + 1];\n      const dx = b.x - a.x, dz = b.z - a.z;',
    to: '    for (let k = 0; k < pts.length - 2; k++) {\n      const a = pts[k], b = pts[k + 1];\n      const dx = b.x - a.x, dz = b.z - a.z;',
    why: 'the hold is impossible on the 414 two-point edges — nearly half the district',
  },
  {
    /**
     * ONCE HELD, HELD FOR EVER: the release condition goes. A reviewer measured that version
     * reporting held in 100% of frames while the player fled, worst distance 331.9 m, with the
     * fleet driving 3,056 m instead of 9,170 and a single-frame position jump of 19.59 m.
     */
    id: 'hold-forever', file: 'src/pursuit.js',
    find: '      if ((near.d <= this.reachRadius\n          || (best > this.reachRadius\n            && near.d <= this._localBest(u, target) + CLOSER_EPS_M\n            && canWalk()))\n        && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
    to: '      if (u.stopped || (near.d <= this.reachRadius && wantT > near.t && u.t <= near.t)) {',
    why: 'a unit that once held follows the player for ever, 331 m away, in 19.59 m jumps',
  },
  {
    /**
     * THE HARNESS ITSELF IS A TARGET, because a wrong harness is a wrong round. This reverts
     * tools/playtest.mjs's run-over charge to the literal 1 it carried for several rounds while
     * district/main.js asked `damage.runOverCrime`. `CRIMES.pedestrianHit`'s `min: 1` floor
     * clamps every non-fatal roll to one star under the model and the literal charges two, flat
     * from 3 to 50 km/h; above the kill speed it inverts and the model charges three where the
     * literal charges two.
     *
     * WORTH KEEPING FOR WHAT IT SAYS ABOUT THE OLD ARM. §3b has driven a casualty over through
     * the real step loop for several rounds, sitting on this, asserting `stars > 0` — true under
     * either charge. The mutation is caught now by two checks and was caught by none then, with
     * no change to where the arm stands.
     */
    id: 'runover-literal', file: 'tools/playtest.mjs',
    find: '          this._crime(rv.crime, rv.scale);',
    to: '          this._crime(rv.crime, 1);',
    why: 'the harness charges a full pedestrianHit for a 3 km/h roll: 2 stars where the game gives 1',
  },
  {
    /**
     * THE CHROMATIC THIRD GOES BACK TO THE HUE WHEEL. Nothing errors, the fleet drives
     * identically, the triangle bill is unchanged and every determinism check still passes —
     * because this is a colour and nothing but a colour. 48% of the chromatic third moves into
     * yellow, cyan, violet and magenta, families the 65-vehicle census never observed once. The
     * comment two lines above it goes on saying the wheel "was a fairground", which is how this
     * shipped in the first place: both fleets claimed the fix in prose and neither made it.
     */
    id: 'paint-wheel', file: 'src/traffic.js',
    find: '        const paint = paintFamily(draws[2]);\n        color.setHSL(paint.h, (0.26 + draws[3] * 0.18) * paint.sat,\n          CHROMATIC_L[0] + u * (CHROMATIC_L[1] - CHROMATIC_L[0]));',
    to: '        color.setHSL(draws[2], 0.26 + draws[3] * 0.18,\n          CHROMATIC_L[0] + u * (CHROMATIC_L[1] - CHROMATIC_L[0]));',
    why: 'a third of the moving fleet goes back to being a fairground',
  },
  {
    /**
     * AND THE PARKED POOL'S DOES, which is the sibling half. These two modules have now had the
     * same defect twice — the unnamed mesh, then the colour draw — and the second one went
     * unfixed for 25 days because the first got a one-line patch and nobody looked next door.
     * The row exists so a gate that only walks `traffic.js` reads as the gap it is.
     */
    id: 'paint-wheel-parked', file: 'src/streetfurniture.js',
    find: '        const paint = paintFamily((h - ACHROMATIC_SHARE) / (1 - ACHROMATIC_SHARE));\n        this._pcol.setHSL(paint.h, (0.26 + h * 0.18) * paint.sat,\n          CHROMATIC_L[0] + u * (CHROMATIC_L[1] - CHROMATIC_L[0]));',
    to: '        this._pcol.setHSL((h - ACHROMATIC_SHARE) / (1 - ACHROMATIC_SHARE), 0.26 + h * 0.18,\n          CHROMATIC_L[0] + u * (CHROMATIC_L[1] - CHROMATIC_L[0]));',
    why: 'every third parked car goes back to the wheel while the moving fleet stays fixed',
  },
  {
    /**
     * A THIRD DRAW IN THE COLOUR BLOCK. Behaviour-preserving as a COLOUR — the paint is still
     * drawn from the measured table and still looks right — and it perturbs the seeded stream
     * `_chooseNext` shares, so the fleet drives a different set of edges from the first frame on.
     * CLAUDE.md records what that costs: the same perturbation took `traffic-selftest`'s building
     * check from 0 of 215,960 car-frames inside a building to 342. The defect it surfaces is real
     * and it is in code this row does not touch, which is exactly why a draw count is a gated
     * quantity here and not a style note.
     */
    id: 'paint-draw', file: 'src/traffic.js',
    find: '        draws[2] = this._r();',
    to: '        this._r();\n        draws[2] = this._r();',
    why: 'every routing and spawn decision after the first car moves, for an identical-looking fleet',
  },
  {
    /**
     * ONE FAMILY WIDENED INTO A BAND THE CENSUS NEVER SAW. `blue` runs to 0.66; taking it to 0.50
     * reaches down through cyan, which is 10% of the wheel and 0 of 65 in the photographs. The
     * weights still sum to 1, every family is still reachable and the distribution still matches
     * the table — so a check on the WEIGHTS cannot see it, and only a check on the HUES can.
     */
    id: 'paint-band', file: 'src/carpaint.js',
    find: "  Object.freeze({ name: 'blue', w: 0.36, h0: 0.560, h1: 0.660, sat: 1.00 }),",
    to: "  Object.freeze({ name: 'blue', w: 0.36, h0: 0.460, h1: 0.660, sat: 1.00 }),",
    why: 'teal and cyan come back under the name blue, which the weights check cannot see',
  },
  {
    /**
     * THE BLACK TONE PUT BACK WHERE THE OLD DRAW HAD IT. The table still has three tones, the
     * weights still sum to 1, every draw still returns a finite lightness inside its own range —
     * so paintTone's own selftest stays green and so does every structural check. What goes is
     * the thing the census is about: the fleet stops being able to draw a black car, which is
     * 35.4% of the real population.
     */
    id: 'tone-black', file: 'src/carpaint.js',
    find: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.040, l1: 0.080 }),",
    to: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.340, l1: 0.600 }),",
    why: '41.9% of the fleet goes back to mid grey and nothing about the table looks wrong',
  },
  {
    /**
     * THE HARDER HALF, AND THE ONE paint-census CANNOT SEE. Black's range moves to 0.140..0.200,
     * which still reaches under the L~0.15 anchor paint-census asserts, so that check passes —
     * and the white/black median ratio falls to x4.71, outside the x5.79..x37.33 the sunlit row's
     * own boxes allow. Only `paint-tone` has the photographs to notice, which is why it is on the
     * offline list despite launching a browser.
     *
     * The x2.8 in `why` is against the SHIPPED black median of 0.060, which moved when black's
     * floor was raised to the BRDF dielectric crossing (0.032 -> 0.040). It read x3.6 before, and
     * both the `find` strings here went STALE in that commit — caught only when the selftest's
     * "every row finds its target exactly once" check next ran. A row whose `find` no longer
     * occurs reports STALE, and CLAUDE.md records that a stale row reads as "the code moved under
     * the row", which is a thing that genuinely happens — so it is the most expensive kind of
     * wrong. **Re-point every row that names a constant in the commit that moves the constant.**
     */
    id: 'tone-ratio', file: 'src/carpaint.js',
    find: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.040, l1: 0.080 }),",
    to: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.140, l1: 0.200 }),",
    why: 'a black car reads x2.8 too bright while still passing every anchor check',
  },
  {
    /**
     * THE PAINT-SLOT TINT SWITCHED OFF. Bit-exactly the build before #1, which is the property
     * the uniform was given on purpose — so this row is also the proof that an arm sweeping it to
     * 0 reproduces the old build rather than approximating it. The fleet keeps its new tone range
     * and every non-painted surface goes back to carrying it: a black car gets a black number
     * plate at 0.0233 against a real plate's 0.80.
     */
    id: 'tint-off', file: 'src/carbody.js',
    find: 'const PAINT_TINT = { uPaintTintOnly: { value: 1 } };',
    to: 'const PAINT_TINT = { uPaintTintOnly: { value: 0 } };',
    why: 'the plate, lamps, rims and tyres go back to carrying the body colour — #1, at the new range',
  },
  {
    /**
     * THE TINT APPLIED TO EVERY SLOT INSTEAD OF NONE, which is the opposite error. The paint
     * stops being tinted at all, so every car in both fleets renders at its authored vertex
     * colour and the whole census becomes decorative.
     *
     * THE FIRST VERSION OF THIS NOTE ALSO SAID THE LAMP SPILL STOPS WORKING. It does not.
     * `carGlowMaterial()` returns a bare `MeshBasicMaterial` and `patchLensFalloff` is applied
     * only inside `carSurfaceMaterial`, so the glow program has no `uPaintTintOnly` in it and
     * three's stock `color_vertex` carries its per-car brightness through untouched. A blind
     * reviewer checked the caller instead of believing the comment. The false mechanism was in
     * four places; this is one of them.
     *
     * CAUGHT BY A SOURCE REGEX AND NOT BY A MEASUREMENT, which is worth saying rather than
     * leaving to be discovered: nothing offline renders a shader. The regex asserts the rule is
     * still derived from `uv.x`, and it has a blind spot — see `tint-invert` below.
     */
    id: 'tint-slotless', file: 'src/carbody.js',
    find: 'vColor.xyz = mix( vColor.xyz, color.xyz, uPaintTintOnly * step( 0.5, floor( uv.x * 16.0 ) ) );',
    to: 'vColor.xyz = mix( vColor.xyz, color.xyz, uPaintTintOnly );',
    why: 'every car renders at its authored colour and the measured census becomes decorative',
  },
  {
    /**
     * ONE VERTEX OF THE LAMP SPILL MOVED OFF THE PAINT SLOT, and this row's `why` was WRONG when
     * it was written. It said the pools stop dimming with the car that casts them. They do not:
     * the glow mesh's material is a bare `MeshBasicMaterial` that `patchLensFalloff` never
     * touches, so the paint-slot rule is not in that program at all and the slot a glow vertex
     * sits on does not matter today. A blind reviewer found it.
     *
     * The row is KEPT because the property it breaks is still worth holding: if the glow material
     * were ever moved onto the patched one, every vertex being slot 0 is what would keep the
     * per-car brightness working. It is a conditional, and `paint-census` now labels it as one.
     */
    /**
     * THE MIX ARGUMENTS SWAPPED, which inverts the whole rule: instanceColor then reaches every
     * slot EXCEPT the paint, so every car renders at its authored grey and the plate, lamps, rims
     * and tyres carry the body colour — exactly #1, upside down.
     *
     * A BLIND REVIEWER PLANTED IT AND NOTHING CAUGHT IT. It passes all three of `paint-census`'s
     * source regexes (the seam throw is still there, `floor( uv.x * 16.0 )` is still there, the
     * cache key is still bumped), all of `boot-check` (which reads the uniform's own getter and
     * never samples a pixel) and all of `traffic-selftest` (which is about instanceColor, not
     * about the shader). The regex has a blind spot the rest of the table did not cover.
     *
     * IT IS CAUGHT NOW, BY A STRUCTURAL SOURCE CHECK rather than by a measurement, and the
     * distinction is the point. `paint-census` asserts that the INSTANCE-TINTED colour is the
     * mix's first argument and the authored one its second — stated as the rule (the weight is 1
     * where the authored colour must win) rather than as the string this row changes, so it is
     * not a regex fitted to one mutation.
     *
     * THE GAP THE REVIEWER FOUND IS WIDER THAN THIS ROW AND IS STILL OPEN: nothing anywhere
     * samples a PIXEL of a car. `boot-check` reads the uniform's own getter; `paint-tone`'s
     * RENDER section reads committed PNGs and so cannot see a mutated source at all. The rendered
     * version is max-over-median across one car's own pixels with the fleet forced near-black —
     * the lamp is 0.95 absolute over a body at 0.047 under the correct rule and the body is the
     * brightest thing on the car under the inverted one. Not written.
     */
    id: 'tint-invert', file: 'src/carbody.js',
    find: 'vColor.xyz = mix( vColor.xyz, color.xyz, uPaintTintOnly * step( 0.5, floor( uv.x * 16.0 ) ) );',
    to: 'vColor.xyz = mix( color.xyz, vColor.xyz, uPaintTintOnly * step( 0.5, floor( uv.x * 16.0 ) ) );',
    why: 'the rule inverts: every car is its authored grey and every light detail carries the body colour',
  },
  {
    id: 'glow-slot', file: 'src/carbody.js',
    find: '      return b.vert(cx + s * hw, yRoad, z0 + dir * dz, _c, SURFACE.paint);',
    to: '      return b.vert(cx + s * hw, yRoad, z0 + dir * dz, _c, SURFACE.matte);',
    why: 'breaks the condition that would keep the spill working if its material were ever patched',
  },
  {
    /**
     * THE GARAGE REPAIRS A CAR THAT IS STILL MOVING. Nothing errors, every mission plays
     * identically, and the feature even looks more generous — which is the point: a player
     * driving through on the way somewhere gets a free repair and never learns the garage is
     * there, and the "stop here" line becomes a lie about a rule that does not exist.
     * Measured: 23 frames inside the zone at 2.45 to 5.78 m/s, 5.75 s against a 4 s hold, so
     * a crossing is long enough for the mutant to fire.
     */
    id: 'garage-moving', file: 'src/damage.js',
    find: '    if ((player.speed ?? 0) >= this.stopMs) {',
    to: '    if (false) {',
    why: 'driving through the garage repairs the car, so stopping in it is never learned',
  },
  {
    /**
     * AND IT REPAIRS A CAR THE POLICE ARE CHASING, which is the harder half of the same rule.
     * The refusal is what makes a damaged car at four stars a decision — run for it or shake
     * the tail first — and without it the garage is a free reset mid-pursuit.
     */
    id: 'garage-wanted', file: 'src/damage.js',
    find: '    if ((player.wantedStars ?? 0) > 0) {',
    to: '    if (false) {',
    why: 'the garage repairs the car mid-pursuit, which removes the only cost of being wanted',
  },
  {
    /**
     * THE DWELL IS BANKED INSTEAD OF RESET. Behaviour-preserving in everything a single visit
     * can see — the same four seconds, the same countdown, the same line — and it turns the
     * rule into "spend four seconds in the garage across as many visits as you like". Three
     * 1.6 s visits against a 4 s hold repair the car without it ever having stood still.
     */
    id: 'garage-bank', file: 'src/damage.js',
    find: '    if (!this.inside) { this.dwell = 0; return this.report(d, false); }',
    to: '    if (!this.inside) { return this.report(d, false); }',
    why: 'the hold can be served in short visits, so "hold still" stops being a requirement',
  },
  {
    /**
     * THE HOLD COUNTS FRAMES INSTEAD OF SECONDS, which is the defect two of this game's other
     * holds shipped with — `wreckWatch` and the bust clock both ran off rendered frames, so
     * under ?timeScale=40 a four-second hold took 160 s. Identical at 60 Hz by construction and
     * wrong everywhere else: measured 2.01 s at 120 Hz and 40.17 s at 6 Hz for a 4 s hold, and
     * headless capture here runs under 1 fps.
     */
    id: 'garage-frames', file: 'src/damage.js',
    find: '    this.dwell += dt;',
    to: '    this.dwell += 1 / 60;',
    why: 'the repair takes 2 s at 120 Hz and 40 s at 6 Hz, for a 4 s hold',
  },
  {
    /**
     * THE COUNTDOWN LOSES ITS UNIT, which is exactly what the bust countdown shipped: both HUD
     * render paths default to metres, so a 3 s countdown draws "3 m". The line is still there,
     * still counts down, and still reads as a number — it is just the wrong quantity, and for
     * a full second at each end of every repair it is also the wrong word.
     */
    id: 'garage-unit', file: 'src/damage.js',
    find: "  return { objective: { text: 'REPAIRING', distance: Math.ceil(g.left), unit: 's' },",
    to: "  return { objective: { text: 'REPAIRING', distance: Math.ceil(g.left) },",
    why: 'the repair countdown reads "4 m" for four seconds',
  },
  {
    /**
     * AND THE SUBTITLE GOES BACK TO THE MISSION'S. `src/hud.js`'s HOLDS_MISSION_SUBTITLE
     * replaces a tenant's subtitle with the running mission's objective unless the tenant says
     * otherwise, which ate composeLaw's "reverse" for a round. Without `ownSubtitle` the
     * garage's "hold still" is replaced by whatever job is running, so the one instruction the
     * player needs is the one thing not on screen.
     */
    id: 'garage-subtitle', file: 'src/damage.js',
    find: "    subtitle: 'hold still', ownSubtitle: true };",
    to: "    subtitle: 'hold still' };",
    why: 'the mission objective replaces "hold still", so nothing says to stay put',
  },
  {
    /**
     * THE REPAIR FRAME FLASHES "STOP HERE" AT THE MOMENT OF SUCCESS, for a host that composes
     * the band before applying the repair. district/main.js repairs first so the page is
     * unaffected — this is a row about the MODULE being correct independently of call order,
     * which is the difference between a wire that works and one that works by accident.
     */
    id: 'garage-repaired-frame', file: 'src/damage.js',
    find: '  if (g.repaired) return null;',
    to: '  if (false) return null;',
    why: 'the garage line depends on whether the host repairs before or after composing',
  },
  {
    /**
     * THE MINIMAP BLIP GOES. [browser], because the push is one line in district/main.js and
     * nothing offline imports it. `MARKER_STYLE.shop` had sat in src/hud.js since the file was
     * written with nothing ever posting one — the same shape as `MARKER_STYLE.vehicle`, which
     * left three authored stages saying "GET IN THE CAR" over a blank map. A garage nobody can
     * find is a garage that does not exist, and the feature works perfectly from the console.
     */
    id: 'garage-blip', file: 'district/main.js',
    find: "  n = pushHudMarker(n, GARAGE_AT.x, GARAGE_AT.z, 'shop');",
    to: '  n = n;',
    why: 'the only repair in the game is not on the map',
    browser: true,
  },
  {
    /**
     * AND THE HOST WIRE: the garage counts down, says REPAIRING, finishes — and nothing calls
     * `damage.repair()`. [browser] for the same reason. This is the shape CLAUDE.md records
     * three times over: the module is right, its gate asserts the module, and nothing asserts
     * that the game reaches it.
     */
    id: 'garage-wire', file: 'district/main.js',
    find: '  if (garageState.repaired) {',
    to: '  if (false) {',
    why: 'the repair countdown completes and the car stays broken',
    browser: true,
  },
  {
    /**
     * THE CAP GOES BACK TO BEING A CLIP, which is behaviour-preserving in everything a single
     * crime's STARS can see — a floorless crime still cannot reach one star on its own — and it
     * restores the tie the knee exists to remove: 22 km/h and 88 km/h into a civilian car charge
     * 0.9854 and 1.0000, 0.0146 apart, where the knee separates them by 0.1937. Nothing errors
     * and every ordering check in wanted-test §24 still passes, because ordering was never what
     * broke.
     */
    id: 'knee-clip', file: 'src/wanted.js',
    find: '  if (!(raw > cap / 2)) return raw;\n  return cap - (cap * cap / 4) / raw;',
    to: '  return Math.min(raw, cap);',
    why: 'severity stops mattering above the cap again: 0.0146 between a 22 and an 88 km/h crash',
  },
  {
    /**
     * THE KNEE MOVES TO THE CAP, which leaves the curve continuous and NOT C1: the lower branch
     * arrives with slope 1 and the upper leaves with slope (cap^2/4)/cap^2 = 0.25, a corner at
     * the join. It also makes the whole upper branch wrong — at raw = cap the charge reads 0.75
     * where the two-branch form requires `cap`. Monotonic, so the tie checks cannot see it.
     */
    id: 'knee-point', file: 'src/wanted.js',
    find: '  if (!(raw > cap / 2)) return raw;',
    to: '  if (!(raw > cap)) return raw;',
    why: 'the knee has a corner and drops 25% at the join, where the derivation says it is smooth',
  },
  {
    /**
     * THE MALFORMED-SCALE GUARD GOES. A NaN scale then makes `heat` NaN, and a meter whose heat
     * is NaN never rises again — `NaN >= 1` is false, so the player is immune for the rest of
     * the session with the HUD reading 0 stars and nothing in the console. The same shape as
     * CLAUDE.md's non-finite delta-v buying immortality, through the other door.
     */
    id: 'scale-nan', file: 'src/wanted.js',
    find: '    if (!(Number.isFinite(scale) && scale >= 0)) {',
    to: '    if (false) {',
    why: 'a NaN scale poisons the wanted meter permanently and reads as 0 stars',
  },
  {
    /**
     * AND IT ACCEPTS A NEGATIVE SCALE, which is the half a finite-check alone would miss —
     * CLAUDE.md's "guard the DIRECTION as well as the magnitude", where `Math.hypot(NaN, NaN)
     * || 1` sailed past a magnitude guard. A crime at scale −1 charges 0 and so makes you no
     * more wanted than not committing it.
     */
    id: 'scale-sign', file: 'src/wanted.js',
    find: '    if (!(Number.isFinite(scale) && scale >= 0)) {',
    to: '    if (!Number.isFinite(scale)) {',
    why: 'a negative scale is a free crime, and a finite check alone cannot see it',
  },
  {
    /**
     * THE GARAGE MOVES ONTO A MISSION PICKUP POINT, which is the defect this district has
     * shipped THREE times — `shakedown`'s marker 0.35 m from the spawn, `ambush`'s on top of
     * `drop`'s trigger, and both put there by a gate rule. `garage` sits below `mission` in
     * BAND_ORDER, so a player parked on `marlin-street`'s pickup reads the offer and never the
     * four seconds of "hold still": the repair works and is invisible, which is the 0.033 s
     * delivery leg in a new place.
     */
    id: 'garage-on-marker', file: 'district/main.js',
    find: 'const GARAGE_AT = { x: -67.9, z: 60.3 };',
    to: 'const GARAGE_AT = { x: 19, z: -6 };',
    why: "the garage sits on marlin-street's pickup point, so its cue is never readable",
  },
  // ---------------------------------------------------------------- #106, handing a job back
  {
    /**
     * THE STOP RULE GOES, so the job can be dropped at 140 km/h. The abort key sits one finger
     * from the throttle and nothing in this game undoes an ended mission, so the stop is a safety
     * property rather than ceremony — and `abort-cost` prices it at 1.91 s from the follower's
     * own cruise against the wreck exit's 13.4 s, which is what makes it affordable.
     *
     * BEHAVIOUR-PRESERVING FOR THE CUE, which is why it needs its own row: the prompt still
     * appears and still says the right thing, because `prompt` is derived from `ready` and
     * `ready` is simply true more often. Only an assertion about the THRESHOLD can see it.
     */
    id: 'abort-no-stop', file: 'src/mission.js',
    find: '  const ready = !badSpeed && speed < stopMs;',
    to: '  const ready = !badSpeed;',
    why: 'a job can be handed back at any speed, so one stray keypress at 140 km/h ends it',
  },
  {
    /**
     * THE CUE STOPS NAMING THE REQUIREMENT. Both branches read "GIVE UP THE JOB", so a player
     * doing 80 km/h is told to press a key that does nothing — and never learns why, because the
     * one thing that would have told them is the branch this removes.
     *
     * This is `composeGarage`'s "stop here" precedent being deleted, and it is the same shape as
     * the pickup's own worst case recorded in CLAUDE.md: a refusal that reads as a confirmation.
     * The prompt is still THERE, so nothing counting prompts can see it.
     */
    id: 'abort-cue-flat', file: 'src/mission.js',
    find: "text: ready ? 'GIVE UP THE JOB' : 'STOP TO GIVE IT UP'",
    to: "text: 'GIVE UP THE JOB'",
    why: 'the cue promises a key that does nothing while the car is moving, and never says why',
  },
  {
    /**
     * THE NON-FINITE REFUSAL BECOMES A NON-FINITE ADMISSION. `NaN < stopMs` is false, so the
     * shipped build refuses; dropping the flag from the conjunction makes `ready` depend on the
     * comparison alone and a NaN then... still refuses. So this row mutates the other side: the
     * flag is inverted, and one bad physics frame hands the job back on its own.
     *
     * The counter is the half that matters. `badSpeed` is reported rather than thrown for the
     * reason `abortOffer`'s header gives at length, and the host tallies it — so this row is
     * really a test that the flag is load-bearing rather than decorative.
     */
    id: 'abort-badspeed-inverted', file: 'src/mission.js',
    find: '  const ready = !badSpeed && speed < stopMs;',
    to: '  const ready = badSpeed || speed < stopMs;',
    why: 'one NaN frame hands the job back by itself, and the counter that would say so reads it as healthy',
  },
  {
    /**
     * THE RUNNER'S PER-FRAME NON-FINITE COUNTER GOES BACK TO BEING NOTHING.
     *
     * It is a pure instrument — no behaviour changes — so NOTHING end-to-end can see this, which
     * is exactly why it needs a row. The gap it closes was found by #106's own gate: the throw
     * above it sits behind `_checkedSnapshot` and runs on frame 1 only, so a field going
     * non-finite later makes every distance trigger silently false for the rest of the run and
     * the mission dead-ends with nothing in the console. The counter is the diagnosis.
     */
    id: 'mission-nonfinite-count', file: 'src/mission.js',
    find: "        this._nonFinite.set(f, (this._nonFinite.get(f) ?? 0) + 1);",
    to: "        /* counted nowhere */",
    why: 'a field going NaN mid-run leaves no trace, and every trigger reads false for ever',
  },
  {
    /**
     * THE HOST'S WIRE, so only a gate that LOADS THE PAGE can see it. The key is read and the
     * rule is consulted and the abort is simply never called: the cue still says "Q — GIVE UP
     * THE JOB", pressing Q does nothing, and every offline check over `abortOffer` passes
     * because the module is untouched. This is the shape #100's `startMission` had — a working
     * feature with no door — arriving on the way out instead of the way in.
     */
    id: 'abort-wire-dead', file: 'district/main.js',
    find: '    if (can && can.ready) { mission.abort(ABORT_REASON); missionStats.declined++; }',
    to: '    if (can && can.ready) { missionStats.declined++; }',
    why: 'the cue offers the key, the key is read, and the job is never handed back',
    browser: true,
  },
  {
    /**
     * THE HOST GATES THE CUE ON THE SNAPSHOT'S SPEED INSTEAD OF THE PLAYER'S.
     *
     * `missionSnapshot().speed` is `mode === 'car' ? vehicle.speed : 0` — a deliberate constant
     * on foot, for the reason that function's header gives. So this reads READY for every frame
     * a player spends on foot, sprinting included, and the abort fires mid-stride. In the CAR it
     * is byte-identical, which is what hides it: the only arm that can tell is one on foot.
     */
    id: 'abort-snapshot-speed', file: 'district/main.js',
    find: '    const can = abortOffer(mission, { speed: focusSpeedNow() }, { stopMs: SCENE_STOP_MS });',
    to: '    const can = abortOffer(mission, { speed: missionSnapshot().speed }, { stopMs: SCENE_STOP_MS });',
    why: 'on foot the stop rule is satisfied at a sprint, because that field is a constant there',
    browser: true,
  },
  {
    /**
     * THE END-OF-MISSION BAND FORGETS WHY IT ENDED. An unmapped reason falls through to `null`
     * and the band reads "MISSION ABORTED / Marlin Street — the marker is back on the map",
     * which is byte-identical to a wreck before both aborts started passing a key. A player
     * cannot tell their own decision from a crash.
     *
     * Offline-visible, because mission-test reads the host's REASON_TEXT off the source — the
     * "a new field that no gate feeds" check, arriving as a label.
     */
    id: 'abort-reason-unmapped', file: 'district/main.js',
    find: "    declined: 'you handed it back',",
    to: "    declinedX: 'you handed it back',",
    why: 'handing a job back reads on screen exactly like wrecking the car',
  },
  {
    /**
     * THE EVENT COUNTER BECOMES A FRAME COUNTER AGAIN, which is the defect #87's headline number
     * was made of. `hit()` has no per-car refractory and both hosts call it once a frame for the
     * worst contact, so `shuntFrames` counts frames and `shuntCars` counts cars. Measured over a
     * 350 m drive, 5 seeds at each of 8 speeds: 258 frames over 11 distinct cars, 23.5 each,
     * worst 50 frames on ONE car. The entry read the frame column as a contact rate, and its
     * "19 at 22 km/h against 0 at 36" is three cars against none.
     *
     * The direction is ALARMING rather than flattering, which is the rarer case and still a
     * defect: it made a rate look 23x what it is and sent a round after a mechanism for it.
     *
     * Nothing else can see this. Every other reader uses the counters as a boolean (`> 0`,
     * `=== 0`), so `playtest --selftest`, `reaction-test` and `damage-live` are all green with
     * the two counters identical — which is how the shape survived the session that renamed
     * `runOvers`, `pedHits`, `carHits` and `policeHits` for exactly this reason and left these.
     */
    id: 'shunt-cars-frames', file: 'src/traffic.js',
    find: "    if (!this._shuntedIds.has(id)) { this._shuntedIds.add(id); this.stats.shuntCars++; }",
    to: "    this.stats.shuntCars++;",
    why: 'the distinct-car count reverts to a frame count, so a contact rate reads 23x high',
  },
  {
    /**
     * THE SEED STOPS REACHING THE FLEET, which is how it shipped. `Session` gives `PursuitUnits`
     * and `Pedestrians` `opts.seed ?? 0` and gave `Traffic` only `count`, so `Traffic` fell
     * through to its own fixed default and EVERY SESSION IN A SEED SWEEP HELD THE SAME FLEET.
     * Only the crowd and the police varied.
     *
     * It is behaviour-preserving for every gate that passes no seed, and every other caller in
     * tools/ that passes one also passes `traffic: 0` — so nothing has a fleet to perturb and
     * nothing failed. What it destroys is the meaning of a seed sweep over traffic: #87's
     * `--decide` read 16/16 drives with a contact at 22 km/h against 0/16 at 36 and I wrote that
     * up as a real effect. With the fleet varying it is 5/16 against 5/16 and the effect is gone.
     *
     * The tell was UNANIMITY, twice over: the first contact of each drive hit a car doing 8.091
     * m/s in six of six seeds, identical to three decimals. A cross-seed column that is too
     * consistent is evidence the seed is not reaching what you varied.
     */
    id: 'session-fleet-seed', file: 'tools/playtest.mjs',
    find: "    this.traffic = new Traffic(scene, this.district, { count: opts.traffic ?? 30,\n      seed: opts.seed ?? 0 });",
    to: "    this.traffic = new Traffic(scene, this.district, { count: opts.traffic ?? 30 });",
    why: 'a seed sweep over traffic becomes one fleet replicated, and every gate stays green',
  },
  // ---- src/post.js: #114, emitted light exempt from the screen-space AO. Every one of these
  // renders a plausible frame and passes every other gate on the list, because no other gate
  // compiles a shader.
  {
    id: 'emit-exempt-off', file: 'src/post.js',
    find: '  ao = mix(ao, 1.0, emitShare * aoEmitExempt);',
    to: '  ao = mix(ao, 1.0, 0.0 * emitShare * aoEmitExempt);',
    why: 'the composite before the fix: lit windows go dark beside every pillar again',
  },
  {
    /**
     * THE TAG READ WITHOUT ITS SIGN. Every tagged pixel still decodes correctly — |-(1+e) + 1| is
     * e — so the window, the half panel and the controls all pass. What breaks is the encoding's
     * whole argument: an additive overlay over a wall (alpha -1, plus 1) now decodes as ALL
     * EMITTED, and the awning glow lifts the occlusion off whatever it falls on. A gate without an
     * overlay in its scene cannot see this row.
     */
    id: 'emit-tag-unsigned', file: 'src/post.js',
    find: '  float emitTag = -sceneTex.a - 1.0;',
    to: '  float emitTag = abs(sceneTex.a + 1.0);',
    why: 'a blended overlay invents exemption instead of only ever removing it',
  },
  {
    id: 'emit-tag-binary', file: 'src/post.js',
    find: '\temitShare = emitShare >= 0.0 ? min( emitShare, 1.0 ) : 0.0;',
    to: '\temitShare = emitShare > 0.0 ? 1.0 : 0.0;',
    why: 'a surface with any emission at all is exempted entirely, so a lit wall loses its AO',
  },
  {
    id: 'emit-tag-all', file: 'src/post.js',
    find: '\tgl_FragColor.a = -1.0 - emitShare;',
    to: '\tgl_FragColor.a = -2.0;',
    why: 'every lit opaque pixel tags as emitted, so the AO is gone from the whole city',
  },
  {
    /**
     * THE OPAQUE GUARD. A transparent lit material's alpha is its coverage; tagged, its source
     * alpha is about -1 and normal blending computes src*(-1) + dst*2. Measured on the gate's
     * pane: luma 0.839 -> 0.000. The district's road markings are exactly such a material.
     */
    id: 'emit-tag-transparent', file: 'src/post.js',
    find: '#if defined( OPAQUE ) && ( defined( STANDARD ) || defined( PHONG ) || defined( LAMBERT ) || defined( TOON ) )',
    to: '#if ( defined( STANDARD ) || defined( PHONG ) || defined( LAMBERT ) || defined( TOON ) )',
    why: 'transparent lit materials are tagged and blend as negative coverage: road markings go black',
  },
  {
    id: 'emit-uniform-unwired', file: 'src/post.js',
    find: '    u.aoEmitExempt.value = p.aoEmitExempt ?? 1;',
    to: '    u.aoEmitExempt.value = 1;',
    why: 'the switch is dead, so no capture can show a before and an after off one page load',
  },
  // ---- src/carbody.js: the cabin behind the car glass. Each renders a plausible car.
  {
    id: 'cabin-mask-inverted', file: 'src/carbody.js',
    find: '\t\tif ( uCabinGain > 0.0 && cabinGlass > 0.5 ) {',
    to: '\t\tif ( uCabinGain > 0.0 && cabinGlass < 0.5 ) {',
    why: 'the cabin lands on the paint, the lamps and the tyres and never on the glass',
  },
  {
    /**
     * THE EYE LEFT IN WORLD SPACE. Every car the page renders at the origin with an identity
     * instance matrix looks exactly right under this mutation — the car frame IS the world frame
     * there. The fleet and the parked pool are never at the origin, so every real car would ray-cast
     * from a camera kilometres away in its own frame. Only the rigid-transform row can see it.
     */
    id: 'cabin-eye-world', file: 'src/carbody.js',
    find: '\t\tvCabinEye = ( inverse( cabinToWorld ) * vec4( cameraPosition, 1.0 ) ).xyz;',
    to: '\t\tvCabinEye = cameraPosition;',
    why: 'every real car ray-casts its cabin from the wrong eye; only a car away from the origin shows it',
  },
  {
    id: 'cabin-through-off', file: 'src/carbody.js',
    find: '\t\t\tcabinThroughW = cabinThrough * uCabinGain;',
    to: '\t\t\tcabinThroughW = 0.0;',
    why: 'the far window goes black, so no car can be seen through',
  },
  {
    id: 'cabin-player', file: 'src/carbody.js',
    find: "  if (opts.cabin === false) m.defines = { ...(m.defines ?? {}), CAR_NO_CABIN: '' };",
    to: '',
    why: "the player's door mirrors grow seats",
  },
  {
    id: 'glass-ao-off', file: 'src/carbody.js',
    find: 'const GLASS_AO = { uGlassAoExempt: { value: 1 } };',
    to: 'const GLASS_AO = { uGlassAoExempt: { value: 0 } };',
    why: '#130 shipped off: every pedestrian in front of a car darkens its glass in a soft cloud again',
  },
  {
    id: 'glass-ao-fleet-seam', file: 'src/carbody.js',
    find: "      .replace(OPAQUE_FRAGMENT_DECL, glassAoTag('1.0 - texture2D( roughnessMap, vRoughnessMapUv ).a'))",
    to: '      .replace(OPAQUE_FRAGMENT_DECL, OPAQUE_FRAGMENT_DECL)',
    why: "the fleet's glazing never tags itself: the uniform reads 1 and the parked and moving cars' glass is under the AO",
  },
  {
    id: 'glass-ao-player-seam', file: 'src/carbody.js',
    find: "      .replace(OPAQUE_FRAGMENT_DECL, glassAoTag('1.0'))",
    to: '      .replace(OPAQUE_FRAGMENT_DECL, OPAQUE_FRAGMENT_DECL)',
    why: "the fix on the fleet's material and not its sibling: the player's own panes keep the halo",
  },
  {
    id: 'glass-ao-whole-car', file: 'src/carbody.js',
    find: "      .replace(OPAQUE_FRAGMENT_DECL, glassAoTag('1.0 - texture2D( roughnessMap, vRoughnessMapUv ).a'))",
    to: "      .replace(OPAQUE_FRAGMENT_DECL, glassAoTag('1.0'))",
    why: 'the whole car exempt, paint and tyres included: every car loses its contact darkening, which no glass check sees',
  },
  {
    id: 'star-aa-off', file: 'src/sky.js',
    find: 'const STAR_AA = { uStarAA: { value: 1 } };',
    to: 'const STAR_AA = { uStarAA: { value: 0 } };',
    why: '#124 shipped off: every occupied star cell draws its own faces as 1-px strokes',
  },
  {
    id: 'star-aa-fwidth', file: 'src/sky.js',
    find: '  float w = max(mix(fwidth(dist), wSmooth, uStarAA), 1e-4);',
    to: '  float w = max(fwidth(dist), 1e-4);',
    why: 'the derivative of a jump is the jump: the strokes come back whatever the switch says',
  },
  {
    id: 'wheel-octagon', file: 'src/carbody.js',
    find: '  const seg = opts.wheelSegments ?? 12;   // a multiple of SPOKES, so every spoke lands on a sample',
    to: '  const seg = opts.wheelSegments ?? 8;   // a multiple of SPOKES, so every spoke lands on a sample',
    why: '#125 put back: every fleet and parked wheel an octagon, its flats 3.8 px in at the nearest car a camera shows',
  },
  {
    id: 'mirror-sideways', file: 'src/carbody.js',
    find: '    b.quad(gv(MG.x, -MG.y), gv(-MG.x, -MG.y), gv(-MG.x, MG.y), gv(MG.x, MG.y));',
    to: '    boxAt(b, s * (flank + 0.190), mirrorY + 0.034, mirrorZ - 0.020, 0.006, 0.044, 0.082, dark, SURFACE.glassy, s * 0.16);',
    why: "#133 put back: the door-mirror glass a slab on the housing's outboard face, a little window on the door from beside the car",
  },
  {
    id: 'mirror-toe-out', file: 'src/carbody.js',
    find: '    const yaw = -s * MIRROR_TOE;',
    to: '    const yaw = s * MIRROR_TOE;',
    why: 'the mirror toed out rather than in: its outer end swept forward and sin(toe), 20% of its glass, turned to a camera beside the car',
  },
  {
    id: 'tail-wrap-fleet-off', file: 'src/carbody.js',
    find: '    tailWrap(b, shell, pts, iTailHi, iTailLo, TAIL_WRAP_M, 0.012, tailC);',
    to: '',
    why: "#125's taillight half put back for the fleet: a side-on traffic, parked or police car shows no tail lens at all, 0.0 cm2 to either side",
  },
  {
    id: 'tail-wrap-player-off', file: 'src/carbody.js',
    find: '    tailWrap(b, shell, pts, iTailHi, iTailLo, TAIL_WRAP_M, 0.012, tailCol);',
    to: '',
    why: "the wrap on the fleet and not on the player's car: patching one builder and leaving its sibling",
  },
  {
    id: 'fleet-mirror-bare', file: 'src/carbody.js',
    find: '    b.quad(gv(0.045, -0.032), gv(-0.045, -0.032), gv(-0.045, 0.032), gv(0.045, 0.032));',
    to: '',
    why: "#133's fleet half put back: every traffic, parked and police car's door mirror a plain box with no glass on its back",
  },
  {
    id: 'blade-back-blank', file: 'src/signage.js',
    find: '      { doubleSided: true, offset: 0, post: false, tint: opts.tint, backRect: rect });',
    to: "      { doubleSided: true, offset: 0, post: false, tint: opts.tint, backRect: streetRect('misc', 'bladeBack') });",
    why: '#134 put back: every street-name blade a blank plate from the side its name faces away from',
  },
  {
    id: 'tree-halves-split', file: 'src/streetfurniture.js',
    find: "    if (!emit('tree', f.x, f.z, PAD_Y, (b) => propTree(b, f, key), false, key)) return false;",
    to: "    emit('tree', f.x, f.z, PAD_Y, (b) => propTree(b, f, key), false, key);",
    why: '#139 put back: a tree the kerb face refused still draws its near half, odd fronds and boot plates with no trunk under them, and is counted in the species',
  },
  {
    id: 'tree-species-refused', file: 'src/streetfurniture.js',
    find: '        if (this._plantTree(emit, st.key, tf)) this._countSpecies(st.key, st.treeX, st.treeZ);',
    to: '        this._plantTree(emit, st.key, tf); this._countSpecies(st.key, st.treeX, st.treeZ);',
    why: 'the species census counts the kerb trees the face refused: 261 trees where 245 stand',
  },
  {
    id: 'lens-square', file: 'src/streetfurniture.js',
    find: '      lensDisc(buf, f, 0, y, hz, 0.13, 0.185, LENS_SIDES,',
    to: '      plate(buf, f, 0, y, hz, 0.13, 0.13, 0.185,',
    why: '#124 put back: every signal aspect lens a square plate again, roundness 0.707 where the octagon reads 0.924',
  },
  {
    id: 'lens-hexagon', file: 'src/streetfurniture.js',
    find: 'export const LENS_SIDES = 8;',
    to: 'export const LENS_SIDES = 6;',
    why: 'a hexagon lens reads 0.866, between the square and the octagon: the 0.9 bound is what says a lens is round',
  },
  {
    id: 'lens-winding-hand', file: 'src/streetfurniture.js',
    find: '    if (hand < 0) buf.idx.push(ci, i, j); else buf.idx.push(ci, j, i);',
    to: '    if (hand < 0) buf.idx.push(ci, i, j); else buf.idx.push(ci, i, j);',
    why: "the lens fan wound one way in both frames: right in one hand and facing into the head in the other, so a gate building only one frame passes it",
  },
  {
    id: 'blade-yaw-pair', file: 'src/signage.js',
    find: '    const a = opts.yaws && Number.isFinite(opts.yaws[i]) ? opts.yaws[i] : yaw + i * Math.PI / 2;',
    to: '    const a = yaw + i * Math.PI / 2;',
    why: 'the blades back at right angles off the widest arm: every street-name blade the planner names for its own arm hangs across another street',
  },
  {
    id: 'blade-plate-own', file: 'src/signage.js',
    find: '  const plateOf = (name) => (Number.isInteger(opts.plate) ? opts.plate : bladePlate(name));',
    to: '  const plateOf = (name) => bladePlate(name);',
    why: "#134's colour put back: each blade in its own street's colourway, so 80 of 108 posts carry two colours",
  },
  {
    id: 'blade-plate-name', file: 'src/signage.js',
    find: "export function bladePlate(name) { return hash32('plate', streetKey(name)) % BLADE_PLATES.length; }",
    to: "export function bladePlate(name) { return hash32('plate', name) % BLADE_PLATES.length; }",
    why: "a post's colourway hashed on its upper blade's NAME rather than its street: the two halves of a street that changes name at a junction head posts in two colourways",
  },
  {
    id: 'blade-halves', file: 'src/signage.js',
    find: "  return `${body.replace(/\\s+/g, '').toLowerCase()}|${suffix}`;",
    to: '  return name;',
    why: 'North and South halves of one street count as two. The NAMES this district plans come out the same (measured 2026-10-19: bladePick never pairs two halves here, and the alphabetical tie lands on the half each of the 5 posts beside a name change stands next to), but a post\'s colourway is hashed on streetKey since #134\'s colour fix, so the halves take two colourways and sign-orient sees 3 of 29 streets split',
  },
  {
    id: 'cabin-shipped-off', file: 'src/carbody.js',
    find: ' uCabinGain: { value: 1 },',
    to: ' uCabinGain: { value: 0 },',
    why: 'the cabin is built and never switched on, which every other gate reads as the old car',
  },
  {
    /**
     * Two lines, because the player's glass binds the same uniform with the same line: the first
     * version of this row matched twice once that material got the cabin, and the selftest's
     * "finds its target exactly once" is what said so.
     */
    id: 'cabin-through-unwired', file: 'src/carbody.js',
    find: '    shader.uniforms.uCabinThrough = CABIN_U.uCabinThrough;\n    shader.uniforms.uCabinDetail = CABIN_U.uCabinDetail;\n    shader.uniforms.uPaintTintOnly',
    to: '    shader.uniforms.uCabinDetail = CABIN_U.uCabinDetail;\n    shader.uniforms.uPaintTintOnly',
    why: 'the transmission never reaches the shader, which reads its uniform as 0: no far window',
  },
  // ---- the PLAYER'S glass, a separate mesh on carGlassMaterial. The cabin's blind review found it
  // the one black void in the frame: the fix went into the fleet's material and not its sibling.
  {
    id: 'cabin-player-glass-off', file: 'src/carbody.js',
    find: '\tif ( uCabinGain > 0.0 ) {',
    to: '\tif ( false ) {',
    why: "the player's own car is the one car in the frame with nothing behind its glass",
  },
  {
    /**
     * THE WRONG FRAME, which every coverage check passes: measured, 77.7% of the player's glazing
     * still changes with the cabin on, the seats 0.717 m from where they belong. Only comparing
     * the player's cabin with the coupe's on the pane they share sees it.
     */
    id: 'cabin-player-frame', file: 'src/carbody.js',
    find: 'export const PLAYER_CABIN_Y = -CAR.ground;',
    to: 'export const PLAYER_CABIN_Y = 0;',
    why: "the player's cabin is ray-cast 0.717 m low in the fleet's frame, and still changes the glass",
  },
  {
    id: 'cabin-player-through-unwired', file: 'src/carbody.js',
    find: '    shader.uniforms.uCabinThrough = CABIN_U.uCabinThrough;\n    shader.uniforms.uCabinDetail = CABIN_U.uCabinDetail;\n    const off =',
    to: '    shader.uniforms.uCabinDetail = CABIN_U.uCabinDetail;\n    const off =',
    why: "the player's car is the one car nobody can see through",
  },
  // ---- src/daynight.js: the sun's shadow box (#117). Each renders a perfectly good still frame; the
  // defect is what happens to the shadows between two frames, which no single capture can show.
  {
    id: 'shadow-unsnapped', file: 'src/daynight.js',
    find: '    const da = Math.round(a / texel) * texel - a, db = Math.round(b / texel) * texel - b;',
    to: '    const da = 0, db = 0;',
    why: 'every caster re-rasterises at a new sub-texel phase each frame the car moves: the canopy shade crawls',
  },
  {
    id: 'shadow-world-axes', file: 'src/daynight.js',
    find: '    if (c > 1e-6) _sunAxisX.set(d.z / c, 0, -d.x / c); else _sunAxisX.set(1, 0, 0);',
    to: '    _sunAxisX.set(1, 0, 0);',
    why: 'a snap that looks right and is in the wrong frame: the rasteriser\'s axes are the light\'s, not the world\'s',
  },
  {
    id: 'sun-tilt', file: 'src/daynight.js',
    find: '    this.sun.position.copy(centre).addScaledVector(this.sunDirection(_sunDirScratch), d);',
    to: '    this.sun.position.copy(centre).addScaledVector(this.sunDirection(_sunDirScratch), d);\n' +
      '    this.sun.position.y = Math.sin(this.preset.elevation) * d;',
    why: 'the light tilts with the car\'s height again: a kerb moves every dusk shadow by 1.7 texels',
  },
  {
    id: 'post-sundir-origin', file: 'src/daynight.js',
    find: '    this.sunDirection(q.sunDirection);',
    to: '    q.sunDirection.copy(this.sun.position).normalize();',
    why: 'the post stack\'s sun points from the world origin after any weather change',
  },
  // ---- src/post.js and src/daynight.js: lit light's own bloom bar (#118). Every one of these renders
  // a frame nobody would call broken - a glow round a lamp-lit plate is "atmosphere" - and the only
  // thing that tells them apart is tools/bloom-lit.html's five panels.
  {
    id: 'bloom-lit-bar-emitter', file: 'src/post.js',
    find: '       + cl * brightContrib(dot(cl, BRIGHT_LUMA) * exposure, thresholdLit);',
    to: '       + cl * brightContrib(dot(cl, BRIGHT_LUMA) * exposure, threshold);',
    why: 'lit light tested at the emitter\'s bar again: the split runs, and every lamp-lit plate still glows',
  },
  {
    id: 'bloom-share-inverted', file: 'src/post.js',
    find: '  float share = -s.a - 1.0;',
    to: '  float share = s.a + 2.0;',
    why: 'the share read upside down: emitters lose their bloom and lit surfaces keep it',
  },
  {
    id: 'bloom-untagged-lit', file: 'src/post.js',
    find: '  if (!(share >= -0.01 && share <= 1.01)) return c * brightContrib(dot(c, BRIGHT_LUMA) * exposure, threshold);',
    to: '  if (!(share >= -0.01 && share <= 1.01)) return c * brightContrib(dot(c, BRIGHT_LUMA) * exposure, thresholdLit);',
    why: 'untagged light - the sky, every basic-material glow and halo - tested as lit: the signage stops glowing',
  },
  {
    id: 'bloom-lit-unwired', file: 'src/post.js',
    find: '    this.brightMat.uniforms.thresholdLit.value = this.params.bloomThresholdLit ?? 0;',
    to: '    this.brightMat.uniforms.thresholdLit.value = 0;',
    why: 'the preset names a bar and the bright pass never hears of it',
  },
  {
    id: 'bloom-tag-exact', file: 'src/post.js',
    find: '  if (!(share >= -0.01 && share <= 1.01)) return c * brightContrib(dot(c, BRIGHT_LUMA) * exposure, threshold);',
    to: '  if (!(share >= 0.0 && share <= 1.0)) return c * brightContrib(dot(c, BRIGHT_LUMA) * exposure, threshold);',
    why: 'a lit texel sits exactly on share 0, and a fetch that picks up 1e-7 of a neighbour flips it to untagged',
  },
  {
    id: 'bloom-filtered-tag', file: 'src/post.js',
    find: '    vec3 a = brightSplit(texture2D(tDiffuse, (i0 + vec2(0.5, 0.5)) * inv));',
    to: '    gl_FragColor = vec4(brightSplit(texture2D(tDiffuse, vUv)), 1.0);\n    return;\n' +
      '    vec3 a = brightSplit(texture2D(tDiffuse, (i0 + vec2(0.5, 0.5)) * inv));',
    why: 'one filtered fetch: the tag of an edge texel is a MEAN of -1 and +1, which decodes as nothing',
  },
  {
    id: 'bloom-lit-golden', file: 'src/daynight.js',
    find: "for (const k of ['dusk', 'night']) PRESETS[k].post.bloomThresholdLit = PRESETS.noon.post.bloomThreshold;",
    to: "for (const k of ['golden', 'dusk', 'night']) PRESETS[k].post.bloomThresholdLit = PRESETS.noon.post.bloomThreshold;",
    why: 'golden\'s threshold is already a lit-surface bar; a second one moves its glints for no reason',
  },
  {
    id: 'bloom-lit-literal', file: 'src/daynight.js',
    find: "for (const k of ['dusk', 'night']) PRESETS[k].post.bloomThresholdLit = PRESETS.noon.post.bloomThreshold;",
    to: "for (const k of ['dusk', 'night']) PRESETS[k].post.bloomThresholdLit = 1.4;",
    why: 'a typed number where noon\'s derivation stands, and it drifts the first time noon\'s stop moves',
  },
  // ---- src/carbody.js: the number plate (PLATE). Each renders a plausible car; most render a plate.
  {
    id: 'plate-face-off', file: 'src/carbody.js',
    find: 'const PLATE_U = { uPlateText: { value: 1 } };',
    to: 'const PLATE_U = { uPlateText: { value: 0 } };',
    why: 'the face is built and never switched on: every plate is the blank field the reviewer filed',
  },
  {
    id: 'plate-sampled', file: 'src/carbody.js',
    find: 'plateFaceAA( plateQ, plateQx, plateQy, vCarSeed, diffuseColor.rgb )',
    to: 'plateFace( plateQ, vec2( 0.0 ), vCarSeed, diffuseColor.rgb )',
    why: 'one sharp sample a pixel: the font aliases, and a plate 16 m away reads 0.346 of the blank, not 0.78',
  },
  {
    id: 'plate-seed-const', file: 'src/carbody.js',
    find: '\t\tvCarSeed = float( gl_InstanceID );',
    to: '\t\tvCarSeed = 0.0;',
    why: 'every car in the city has the same registration',
  },
  {
    id: 'plate-euro', file: 'src/carbody.js',
    find: '    const yMid = (a.y + c.y) / 2, hw = PLATE.w / 2, hh = PLATE.h / 2;\n    const corner = (x, y, v) => b.vert(x, y, zBack, plateC,',
    to: '    const yMid = (a.y + c.y) / 2, hw = 0.231, hh = 0.065;\n    const corner = (x, y, v) => b.vert(x, y, zBack, plateC,',
    why: 'the fleet is back on a 0.46 x 0.13 m European plate, which renders a face perfectly well',
  },
  {
    id: 'plate-v-lost', file: 'src/carbody.js',
    find: '    const tl = corner(-hw, yMid + hh, 1), tr = corner(hw, yMid + hh, 1);',
    to: '    const tl = corner(-hw, yMid + hh, 0.5), tr = corner(hw, yMid + hh, 0.5);',
    why: 'the face loses its vertical: every row of the plate reads the same line of the font',
  },
  // ---- src/carbody.js: the lamps' faces (LAMP_U). Each renders a car with lamps on it.
  // ---- the cabin's v3 detail (uCabinDetail).
  {
    id: 'cabin-detail-off', file: 'src/carbody.js',
    find: 'const CABIN_U = { uCabinDetail: { value: 1 },',
    to: 'const CABIN_U = { uCabinDetail: { value: 0 },',
    why: 'v3 is built and shipped off: every parked car is occupied by bald heads again',
  },
  {
    id: 'cabin-detail-unwired', file: 'src/carbody.js',
    find: '    shader.uniforms.uCabinDetail = CABIN_U.uCabinDetail;\n    shader.uniforms.uPaintTintOnly',
    to: '    shader.uniforms.uPaintTintOnly',
    why: 'the fleet\'s material never hears the switch and reads it as 0: v2 for ever, while the player\'s glass has v3',
  },
  // ---- cabin v3.1 (uCabinFix, uCabinDriver): the two defects v3's blind reviewer measured, and the
  // driver. Each renders a car nobody would call broken; the directions are what tell them apart.
  {
    id: 'cabin-fix-wheel', file: 'src/carbody.js',
    find: '				oA[2] = mix( 0.018, ${f(A.dash)}, uCabinFix ) * cabinFalloff( tw );',
    to: '				oA[2] = 0.018 * cabinFalloff( tw );',
    why: 'the wheel stays a pale ring in front of a darker cabin, 1.35x the area inside it',
  },
  {
    id: 'cabin-mirror-face-lost', file: 'src/carbody.js',
    find: '			oR[3] = d.z > 0.0 ? face * uCabinFix : 0.0;',
    to: '			oR[3] = 0.0;',
    why: 'the mirror is its dark housing from behind again: a dark band where its glass shows the street',
  },
  {
    id: 'cabin-mirror-face-front', file: 'src/carbody.js',
    find: '			oR[3] = d.z > 0.0 ? face * uCabinFix : 0.0;',
    to: '			oR[3] = d.z < 0.0 ? face * uCabinFix : 0.0;',
    why: 'the mirror\'s face on the wrong side: glass from ahead, housing from behind - v3\'s reversal, rebuilt',
  },
  {
    id: 'cabin-mirror-blend', file: 'src/carbody.js',
    find: '		thr = thr * ( 1.0 - oC[j] ) + oC[j] * oR[j];',
    to: '		thr = thr * ( 1.0 - oC[j] );',
    why: 'a reflective share that shows nothing: the mirror\'s face goes black instead of showing the street',
  },
  {
    id: 'cabin-driver-unwired', file: 'src/carbody.js',
    find: '    }\n    shader.uniforms.uCabinFix = CABIN_U.uCabinFix;\n    shader.uniforms.uCabinDriver = CABIN_U.uCabinDriver;',
    to: '    }\n    shader.uniforms.uCabinFix = CABIN_U.uCabinFix;',
    why: 'the fleet\'s material never hears the driver switch: an empty fleet whatever the switch says',
  },
  {
    id: 'cabin-driver-not-asked', file: 'src/traffic.js',
    find: '    this.material = trafficCarMaterial({ driver: true });',
    to: '    this.material = trafficCarMaterial();',
    why: 'the moving fleet drives itself again; only a gate that walks the live pools can see which asked',
    browser: true,
  },
  {
    id: 'cabin-driver-default', file: 'src/carbody.js',
    find: '  uCabinFix: { value: 0 }, uCabinDriver: { value: 1 } };',
    to: '  uCabinFix: { value: 0 }, uCabinDriver: { value: 0 } };',
    why: 'the reviewed decision quietly reverted: an empty cabin in every moving car, and car-cabin\'s own rows set the switch themselves, so only its "ships v3.1 as reviewed" check sees it',
  },
  {
    id: 'cabin-driver-parked', file: 'src/streetfurniture.js',
    find: '    const material = trafficCarMaterial({ emissiveMap: retroEmissiveMap() });',
    to: '    const material = trafficCarMaterial({ emissiveMap: retroEmissiveMap(), driver: true });',
    why: 'every parked car has somebody sitting in it, for ever',
    browser: true,
  },
  // ---- #132: nothing that stands on the pavement stands in front of the kerb. Each is a placer, or the
  // guard, or the query they share, reverted to what put 750 posts in the road.
  // ---- #131: the router's turn limit. Each is a hairpin the follower cannot make, routed again.
  {
    id: 'route-turn-off', file: 'src/roadpath.js',
    find: '    const limit = opts.turnLimit ?? TURN_LIMIT_RAD;\n    if (fromVertex === toVertex) {',
    to: '    const limit = opts.turnLimit ?? Infinity;\n    if (fromVertex === toVertex) {',
    why: 'every hairpin is as good as a straight again: 8 of 193 random routes turn 120 degrees or more, and 33 -> 350 times out',
  },
  {
    id: 'route-no-fallback', file: 'src/roadpath.js',
    find: '    if (r || !Number.isFinite(limit)) return r;',
    to: '    return r;',
    why: 'a target only a hairpin reaches is refused instead of routed: a preference turned into a wall',
  },
  {
    id: 'route-zero-edge', file: 'src/roadpath.js',
    find: '      if (!a || !b || RoadGraph.turnBetween(a, b) < limit) {',
    to: '      if (true) {',
    why: 'the route of no edges is never priced, and #131\'s own turn lived there: walk in on 33, walk out on 350',
  },
  {
    id: 'route-ends-blind', file: 'src/roadpath.js',
    find: '          arrive: dirAt(this._walkAlong(a, from, spacing), true),\n          leave: dirAt(this._walkAlong(b, to, spacing, true), false),',
    to: '          arrive: null,\n          leave: null,',
    why: 'the limit sees only the junctions inside a route, not the two where the walks join it',
  },
  {
    id: 'route-hairpin-equal', file: 'src/roadpath.js',
    find: '        const hp = !!r.hairpin, bestHp = best ? !!best.hairpin : true;',
    to: '        const hp = false, bestHp = false;',
    why: 'a candidate that had to take a hairpin competes on length with one that did not',
  },
  // ---- #61: the route's junction turns rounded to the car's turning circle. Each is one term of
  // the round put back, so that a sweep says which gate sees which term. Swept one at a time, in the
  // commit that added them:
  //
  //     fillet-off          roadpath-test route-drive reaction-test lane-keep shunt-rate
  //     fillet-right-hold   roadpath-test route-drive lane-keep
  //     fillet-window-old   roadpath-test ALONE, and only its reading of a circle: the drive the
  //                         reading decides (8 of 194 seeded legs into an alley corner at 37 km/h)
  //                         is on no gate, because none of them drives those legs
  //     fillet-merge-off    roadpath-test route-drive reaction-test lane-keep shunt-rate
  //     fillet-clear-off    MISSED first, against every gate — no tour corner is short for clearance,
  //                         so the tour reads byte-identically without the predicate — and caught by
  //                         roadpath-test 6e(7b) once that drove a district corner the ladder decides
  //     cusp-reaim          roadpath-test (its in-place reversal arm, and #131's unrounded hairpin)
  //     cusp-any-behind     shunt-rate ALONE: its 72 km/h subject goes from one shunted car to none
  //
  // and fillet-off's first sweep had roadpath-test THROWING on a null `fillet` rather than failing,
  // which is fixed: it prints eight FAIL lines now.
  {
    id: 'fillet-off', file: 'src/roadpath.js',
    find: 'export const FILLET_R = minTurnRadius(FREE_DV / (1 + WALL_E));',
    to: 'export const FILLET_R = 0;',
    why: 'every junction is a point again: 36 of the tour\'s 816 points under the car\'s standstill radius, and the parked cars at the budget gate\'s two stops are hit on every lap',
  },
  {
    id: 'fillet-right-hold', file: 'src/roadpath.js',
    find: 'cap: a.right ? 0 : Math.min(laneOffsetFor(edgeOf(a.eIn), offset), laneOffsetFor(edgeOf(a.eOut), offset)) });',
    to: 'cap: Math.min(laneOffsetFor(edgeOf(a.eIn), offset), laneOffsetFor(edgeOf(a.eOut), offset)) });',
    why: 'a right turn is driven in its own lane, on the inside of the arc, and the follower cuts it toward the parked cars on the right',
  },
  {
    id: 'fillet-window-old', file: 'src/roadpath.js',
    find: '  const mid = () => arc - first / 2 - last / 2;',
    to: '  const mid = () => arc;',
    why: 'the curvature window divides n-1 vertex turns into n segment lengths again, reads a 9 m fillet as 13.4 m and lets the car into it at 37 km/h',
  },
  {
    id: 'fillet-merge-off', file: 'src/roadpath.js',
    find: '  maxOutside = 0.5 } = {}) {',
    to: '  maxOutside = 0 } = {}) {',
    why: 'a corner split by a two-degree kink is rounded as two short arcs, and #128\'s own right turn takes 8.27 m where the car needs 8.99',
  },
  {
    id: 'fillet-clear-off', file: 'src/roadpath.js',
    find: '      const f = filletCorners(pts, { closed, clearAt: clear, radiusFor: () => filletR });',
    to: '      const f = filletCorners(pts, { closed, clearAt: null, radiusFor: () => filletR });',
    why: 'a fillet is taken at full radius whatever stands on the inside of the corner',
  },
  {
    id: 'cusp-reaim', file: 'src/roadpath.js',
    find: '  if (Math.abs(err) > REVERSE_ERR) {',
    to: '  if (false) {',
    why: 'a car that comes slowly to a cusp finds its aim folded back behind it and orbits one segment short for ever',
  },
  {
    // The rule's first version, put back: it re-aimed at the next vertex whenever the look-ahead was
    // behind, cusp or no cusp, which also swapped a standing three-point turn for full lock forward.
    id: 'cusp-any-behind', file: 'src/roadpath.js',
    find: '      if (Math.abs(Math.atan2(ux * wz - uz * wx, ux * wx + uz * wz)) <= REVERSE_ERR) continue;',
    to: '',
    why: 'a car beside the start of a route that leaves behind it drives forward at full lock instead of backing round',
  },
  {
    // Repointed by intent when #137 rewrote the loop round it: the post's settle behind the kerb.
    id: 'kerb-lamp-front', file: 'src/streetfurniture.js',
    find: '            const kb = this.kerbFace.behind(c.x + c.nx * off, c.z + c.nz * off, LAMP_POLE_R);',
    to: '            const kb = { x: c.x + c.nx * off, z: c.z + c.nz * off, moved: 0, o: null };',
    why: 'the lamp line back at w/2 + 1.4: every kerbed post in the parking lane, which no lamp-reading gate measures',
  },
  {
    // Repointed by intent when #137 rewrote the loop round it: the refusal between two faces.
    id: 'kerb-lamp-unsettled', file: 'src/streetfurniture.js',
    find: '            if (kb.moved > 0 && (this.buildingClearance(kb.x, kb.z) < LAMP_POLE_R || kb.worst < -0.01)) continue;',
    to: '            if (kb.moved > 0 && (this.buildingClearance(kb.x, kb.z) < LAMP_POLE_R)) continue;',
    why: 'a post pushed between two faces that each send it in front of the other is placed anyway',
  },
  // ---- #135 and #137: the street lamps as a system. kerb-stand measures both off the instance
  //      matrices; route-drive drives among the posts.
  {
    id: 'lamp-yaw-along', file: 'src/streetfurniture.js',
    find: '        const yaw = Math.atan2(c.nz * side, -c.nx * side);',
    to: '        const yaw = Math.atan2(-c.nx * side, -c.nz * side);',
    why: '#135 back: the recorded yaw, which runs every arm along the street and hangs the emitter 2.2 m along the pavement',
  },
  {
    id: 'lamp-per-segment', file: 'src/streetfurniture.js',
    find: '    const st = this._lampStations(district, plan, opts.spacing ?? LAMP_SPACING);',
    to: [
      '    const st = { stations: [], stats: { planned: 0, redundant: 0, snapped: 0, dropped: 0, refused: 0, behind: 0 } };',
      '    district.edges.forEach((e, ei) => {',
      '      if (e.r > 6) return;',
      '      for (let k = 0; k < e.v.length - 1; k++) {',
      '        const a = district.verts[e.v[k]], b = district.verts[e.v[k + 1]];',
      '        const len = Math.hypot(b.x - a.x, b.z - a.z), n = Math.floor(len / 26);',
      '        for (let q = 1; q <= n; q++) {',
      '          st.stats.planned++;',
      '          const f = q / (n + 1), side = q % 2 ? 1 : -1, nx = -(b.z - a.z) / len, nz = (b.x - a.x) / len;',
      '          const off = (e.w / 2 + 1.4) * side;',
      '          const kb = this.kerbFace.behind(a.x + (b.x - a.x) * f + nx * off, a.z + (b.z - a.z) * f + nz * off, LAMP_POLE_R);',
      '          if (kb.moved > 0 && (this.buildingClearance(kb.x, kb.z) < LAMP_POLE_R || kb.worst < -0.01)) { st.stats.refused++; continue; }',
      '          if (kb.moved > 0) st.stats.behind++;',
      '          st.stations.push({ ei, s: 0, side, x: kb.x, z: kb.z, yaw: Math.atan2(nz * side, -nx * side) });',
      '        }',
      '      }',
      '    });',
    ].join('\n'),
    why: '#137 back, with #135 left fixed so the row isolates it: floor(len / 26) a SEGMENT, sides by s % 2 — a third of the street unlit, 73% of the lamps on one side',
  },
  {
    id: 'lamp-corner-off', file: 'src/streetfurniture.js',
    find: '          const clear = g.lamp + (turning.has(g.ei) ? KERB.cornerR : 0);',
    to: '          const clear = g.lamp;',
    why: 'no corner kept clear where kerb.js draws no return: a post in the inside of the turn into an alley, which the follower takes at 12 m/s',
  },
  {
    id: 'lamp-line-carriageway', file: 'src/streetfurniture.js',
    find: '        const s = { x0: a.x, z0: a.z, x1: b.x, z1: b.z, hw: e.w / 2, lamp: lampLine(e), ei };',
    to: '        const s = { x0: a.x, z0: a.z, x1: b.x, z1: b.z, hw: e.w / 2, lamp: kerbedEdge(e) ? lampLine(e) : e.w / 2 + LAMP_POLE_R, ei };',
    why: 'a post may stand a pole\'s width off somebody else\'s unkerbed carriageway, where it keeps 1.4 m from its own',
  },
  {
    id: 'lamp-own-bend', file: 'src/streetfurniture.js',
    find: '          if (g.ei === ei && segDist(c.x, c.z, g.x0, g.z0, g.x1, g.z1) < 1e-6) continue;',
    to: '          if (g.ei === ei) continue;',
    why: 'its own road stops counting past a bend: a post in the next segment\'s parking lane on the inside of an 82 degree fold',
  },
  {
    id: 'lamp-overflow-hidden', file: 'src/streetfurniture.js',
    find: '      if (!head) { out.overflow++; continue; }',
    to: '      if (!head) { out.placed++; continue; }',
    why: 'a lamp past the pool counted as placed again: the meshes draw fewer than the report says, and nothing reads the difference',
  },
  {
    id: 'lamp-skip-off', file: 'src/streetfurniture.js',
    find: '            if (lat * side > 0 && lat * side <= line + 3 && Math.abs(along) < spacing / 2) return true;',
    to: '            if (lat * side > 0 && lat * side <= line + 3 && false) return true;',
    why: 'every edge anchors its own ends beside its neighbour\'s: 211 more lamps, 85 pairs under 3 m apart at the junctions',
  },
  {
    /**
     * THE LAMP POOL FORGETS ITS NAME. Nothing visible changes: every lamp draws where it did. What
     * changes is the price every instrument that buckets by name quotes for it — tri-breakdown and
     * shadow-bill read the three meshes as `street furniture + trees`, at that row's x1.28 where they
     * bill x2.00 — and only a gate over the live graph can see a pool that does not name itself.
     */
    id: 'lamp-unnamed', file: 'src/streetfurniture.js',
    find: "    this.heads.name = 'lamp:head';",
    to: "    this.heads.name = '';",
    why: 'the lamp globes are billed as street furniture at x1.28 where they cost x2.00, and every table that buckets by name says so with a straight face',
    browser: true,
  },
  {
    id: 'kerb-mast-front', file: 'src/streetfurniture.js',
    find: '        const kb = this.kerbFace.behindPoints(p.x + ux * setback + rx * off, p.z + uz * setback + rz * off,\n          squareOf(SIGNAL_FOOT_HALF, ux, uz, rx, rz));',
    to: '        const kb = { x: p.x + ux * setback + rx * off, z: p.z + uz * setback + rz * off, moved: 0, worst: null };',
    why: 'the masts back at w/2 + 1.35, where the guard then refuses most of them: a junction with no signals, which reads as a choice',
  },
  {
    id: 'kerb-mast-centre', file: 'src/streetfurniture.js',
    find: '          squareOf(SIGNAL_FOOT_HALF, ux, uz, rx, rz));',
    to: '          [[0, 0]]);',
    why: 'the footing measured by its centre, which was the first wrong version: every footing\'s edge left on the kerb\'s back chamfer',
  },
  {
    id: 'kerb-utility-front', file: 'src/streetfurniture.js',
    find: '          const { x, z, moved, worst } = this.kerbFace.behind(a.x + ax * t - az * side * off,\n            a.z + az * t + ax * side * off, UTILITY_POLE_R);',
    to: '          const x = a.x + ax * t - az * side * off, z = a.z + az * t + ax * side * off, moved = 0, worst = 0;',
    why: 'the utility poles back at w/2 + 1.5, where the guard refuses the kerbed ones: 84 poles and their spans gone',
  },
  {
    id: 'kerb-guard-off', file: 'src/streetfurniture.js',
    find: '      if (!IN_ROAD_KINDS.has(kind) && !inherit) {\n        // The test is on the FOOTPRINT THAT WAS EMITTED',
    to: '      if (false) {\n        // The test is on the FOOTPRINT THAT WAS EMITTED',
    why: 'every prop whose station falls at a corner or a run end stands in the road again: about 250 of them',
  },
  {
    id: 'kerb-face-unclamped', file: 'src/kerb.js',
    find: '      t = t < 0 ? 0 : t > 1 ? 1 : t;\n      const cx = s.ax + dx * t, cz = s.az + dz * t;',
    to: '      if (t < 0 || t > 1) continue;\n      const cx = s.ax + dx * t, cz = s.az + dz * t;',
    why: 'the query blind at a corner return\'s vertices, which is where the probe that found #132 first went wrong: corner masts read as having no kerb',
  },
  {
    id: 'kerb-sign-front', file: 'src/signage.js',
    find: '    const kb = face.behind(sgn.x, sgn.z, SIGN_POST_R);',
    to: '    const kb = { x: sgn.x, z: sgn.z, moved: 0, o: null };',
    why: 'every stop, one-way and parking plate back in the parking lane, which kerb.js\'s header had called "a post in the ground"',
  },
  {
    id: 'lamp-face-off', file: 'src/carbody.js',
    find: 'const LAMP_U = { uLampDetail: { value: 1 } };',
    to: 'const LAMP_U = { uLampDetail: { value: 0 } };',
    why: 'every headlamp in the city is the white field the reviewer measured at 2.6x a sunlit bonnet',
  },
  {
    id: 'lamp-chrome-lost', file: 'src/carbody.js',
    find: '\tmetalnessFactor = mix( metalnessFactor, 1.0, lampChrome );',
    to: '\tmetalnessFactor = metalnessFactor;',
    why: 'the reflectors become grey paint: a lamp whose bright parts go dark with everything else in shade',
  },
  {
    id: 'lamp-insert-emits', file: 'src/carbody.js',
    find: '\t\t\ttotalEmissiveRadiance *= mix( 1.0, lampD.a, uLampDetail );',
    to: '',
    why: 'the reverse lamp glows red with the tail at night, which a car driving forward never shows',
  },
  {
    id: 'lamp-player-frame', file: 'src/carbody.js',
    find: '  const bodyMat = carSurfaceMaterial({ envMapIntensity: opts.envMapIntensity ?? 1.8, cabin: false,\n    frameY: PLAYER_CABIN_Y });',
    to: '  const bodyMat = carSurfaceMaterial({ envMapIntensity: opts.envMapIntensity ?? 1.8, cabin: false });',
    why: 'the player\'s lamps read the face 0.717 m below themselves: a uniform housing with nothing on it',
  },
  {
    id: 'player-glass-metal', file: 'src/carbody.js',
    find: '    roughness: PALETTE[SURFACE.glassy][0], metalness: PALETTE[SURFACE.glassy][1],',
    to: '    roughness: 0.045, metalness: 0.88,',
    why: "the player's glass goes back to the 1% reflector slot 10 records fixing for the fleet",
  },
  // ---- #136: the street lamp's globe against its own light. globe-level measures the ordering and the
  //      halo on its page; boot-check owns the one wire district/main.js holds.
  {
    id: 'globe-level-old', file: 'src/streetfurniture.js',
    find: 'export const LAMP_GLOBE_LEVEL = 1 / 30;',
    to: 'export const LAMP_GLOBE_LEVEL = 4.4673e-4;',
    why: '#136 back: the globe at 1.76 nits, 1/2,239 of its light, outshone by the facade\'s lobe x57.75 and by its own twin',
  },
  {
    id: 'globe-level-physical', file: 'src/streetfurniture.js',
    find: 'export const LAMP_GLOBE_LEVEL = 1 / 30;',
    to: 'export const LAMP_GLOBE_LEVEL = 1;',
    why: 'every globe at the luminance that radiates its light\'s flux: ordered, and a white disc 6.5 of its own radius at 58 m',
  },
  {
    id: 'globe-area-typed', file: 'src/streetfurniture.js',
    find: '  return S / 4;',
    to: '  return Math.PI * 0.25 * 0.25;',
    why: 'the globe\'s area typed off the SphereGeometry call rather than read off its 20 facets: 33% too big, so the globe draws 25% too dim',
  },
  {
    id: 'globe-light-uncoloured', file: 'src/streetfurniture.js',
    find: '  return LAMP_CANDELA * colourLuma(new THREE.Color(LAMP_LIGHT_COLOR)) / meanArea;',
    to: '  return LAMP_CANDELA / meanArea;',
    why: 'the light\'s candela without its colour, which three multiplies by it: a globe x1.54 brighter than the light it stands for',
  },
  {
    id: 'globe-setlit-literal', file: 'src/streetfurniture.js',
    find: '    this.headMat.emissiveIntensity = on ? this.globeIntensity() : 0;',
    to: '    this.headMat.emissiveIntensity = on ? 2.4 : 0;',
    why: 'the old literal back in setLit alone: the module still DECLARES 1/30 and the page draws 1/2,239 at every hour change',
  },
  {
    /**
     * The one wire that lives in district/main.js. Behaviour-preserving for every offline gate, which build
     * their own LightPool from the module's constant, so only boot-check can see it — and it reads as
     * nothing in a frame either, because the globe derives from LAMP_CANDELA and would no longer match a
     * light the page placed at a different number.
     */
    id: 'lamp-candela-typed', file: 'district/main.js',
    find: '  for (const head of lamps.heads) lightPool.addEmitter(head.x, head.y, head.z, LAMP_CANDELA, LAMP_LIGHT_COLOR, LAMP_REACH);',
    to: '  for (const head of lamps.heads) lightPool.addEmitter(head.x, head.y, head.z, 1800, LAMP_LIGHT_COLOR, LAMP_REACH);',
    why: 'the page types its own candela again: a light twice what the globe in front of it was derived from',
    browser: true,
  },
];

// --------------------------------------------------------------------------- mechanics
/**
 * TRACKED changes only. `git status --porcelain` counts untracked files too, and the first run of
 * this tool refused to start because of ITSELF — it was untracked, so it read the tree as dirty.
 * That is the wrong predicate: the thing being guarded is `git checkout -- <file>`, which can only
 * discard modifications to a TRACKED file and cannot touch an untracked one.
 *
 * It can, however, fail outright on a file git does not know about, so `tracked()` checks that
 * separately for every target rather than folding the two questions into one.
 */
const gitClean = () => execSync('git status --porcelain --untracked-files=no',
  { cwd: ROOT, encoding: 'utf8' }).trim() === '';
const tracked = (f) => {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', f],
      { cwd: ROOT, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch { return false; }
};

/**
 * A PORT OF THIS TREE'S OWN, and without it `--browser` was a silent no-op in every tree but one.
 *
 * `tools/boot-check.mjs` defaults to `BOOT_PORT ?? 8123`, and 8123 BELONGS TO THE MAIN TREE —
 * CLAUDE.md says so in as many words. `runGate` passed no port, so a sweep run from a worktree had
 * `ensureServer` find a live server with a foreign document root and THROW, and a throw exits
 * non-zero, and non-zero is how this file spells "caught". A blind reviewer found it by planting a
 * control mutation that was literally the same program — `const WRECK_HOLD_S = BUST_HOLD_S` to
 * `= 4.0` on a tree where BUST_HOLD_S is 4.0 — and watching all seven of its `[browser]` rows come
 * back caught. This tool is the one place that trap was never patched, which is the recurring shape
 * CLAUDE.md records: patch one tool and leave its siblings armed.
 *
 * The derivation lives in `tools/serve.mjs` now, as one definition any browser tool can import —
 * leaving it here was the same shape one level up.
 */
const GATE_ENV = { ...process.env, BOOT_PORT: String(treePort(ROOT)) };

/**
 * AND A TIMEOUT IS NOT A CAUGHT MUTATION EITHER, the third way after an ENOENT and a throw to exit
 * non-zero without a gate having noticed anything. Every gate had 600 s, and boot-check now takes 771 s
 * on an idle box (13 minutes, against the 5.5 CLAUDE.md quotes: the arms have grown, and so has the
 * page). So execFileSync killed the browser control at HEAD, the control read "RED (0 failed)", and the
 * sweep refused a row on a tree whose boot-check passes. Inside a row the same kill would have read as
 * "caught by boot-check". A timed-out gate is reported as such and counts as neither caught nor clean,
 * and boot-check gets the budget its own runs measure.
 */
const GATE_TIMEOUT_MS = { 'boot-check': 2400000 };

function runGate(name) {
  const t0 = Date.now();
  let out = '', rc = 0, timedOut = false;
  // A gate may carry its own flags -- `crowd-bill --selftest` is one tool and one
  // argument, not a file called "crowd-bill --selftest.mjs". Without this split the
  // entry silently becomes an ENOENT, which exits non-zero and would have read as
  // "caught by crowd-bill" for every single mutation in the table.
  const [tool, ...flags] = name.split(/\s+/);
  try {
    out = execFileSync('node', [`tools/${tool}.mjs`, ...flags], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      timeout: GATE_TIMEOUT_MS[tool] ?? 600000, env: GATE_ENV,
    });
  } catch (e) {
    rc = e.status ?? 1;
    timedOut = e.code === 'ETIMEDOUT' || (e.status == null && e.signal === 'SIGTERM');
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }
  /**
   * A THROW IS NOT A FAILED CHECK. Both exit non-zero, and a reviewer reading only the exit code
   * cannot tell "the gate noticed" from "something died on the way". A node stack trace is the
   * tell: a gate that fails prints its own verdict line and no `at <file>:<line>` frames.
   */
  const threw = /^\s+at .+:\d+:\d+\)?$/m.test(out) || /\b(TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(out);
  const failed = out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  /**
   * AND A GATE THAT PRINTS FAIL AND EXITS 0 IS A BROKEN GATE, NOT A MISSED MUTATION. This tool
   * already read both halves and compared neither, so the two cases were indistinguishable in its
   * own output — and the one that happened read as the flattering one.
   *
   * `tools/mission-test.mjs` computed `const failed = checks.filter(...)` a hundred and thirty
   * lines above its last section, which is a SNAPSHOT of a growing array. Section 11's nine
   * checks printed in the listing and none of them reached the exit code: with
   * `garage-on-marker` applied the gate printed three FAIL lines and said
   * `MISSION: PASS — 121 checks`, rc 0, and this sweep recorded the row MISSED. The check that
   * was written for that exact defect was sitting there failing.
   *
   * A MISSED row sends a round looking for a check to write. This row needed the OPPOSITE — the
   * check existed and the accounting was broken — and nothing in the report could say so. It is
   * reported separately now, and it is the more urgent of the two: a gate whose rc does not
   * follow its own checks cannot be trusted about any row, not just this one.
   */
  const brokenAccounting = rc === 0 && failed.length > 0;
  return { name, rc, threw, failed, brokenAccounting, timedOut, ms: Date.now() - t0 };
}

function playtestSelftest() {
  const t0 = Date.now();
  let out = '', rc = 0;
  try {
    out = execFileSync('node', ['tools/playtest.mjs', '--selftest'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
      env: GATE_ENV,
    });
  } catch (e) { rc = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  const threw = /^\s+at .+:\d+:\d+\)?$/m.test(out) || /\b(TypeError|ReferenceError|SyntaxError)\b/.test(out);
  const failed = out.split('\n').filter((l) => /^\s*FAIL\b/.test(l)).map((l) => l.trim());
  return { name: 'playtest', rc, threw, failed, ms: Date.now() - t0 };
}

/** Apply a mutation. Returns null when its `find` no longer occurs — a STALE line. */
function apply(m) {
  const p = path.join(ROOT, m.file);
  const src = fs.readFileSync(p, 'utf8');
  const n = src.split(m.find).length - 1;
  if (n === 0) return null;
  if (n > 1 && !m.firstOnly) return { ambiguous: n };
  fs.writeFileSync(p, m.firstOnly ? src.replace(m.find, m.to) : src.split(m.find).join(m.to));
  return { hits: n };
}
const restore = (m) => execFileSync('git', ['checkout', '--', m.file], { cwd: ROOT });

/**
 * ONE AT A TIME, AND I PROVED WHY BY BREAKING IT. While a sweep was running I ran `--selftest` in
 * another shell. The selftest mutates `src/damage.js` and restores it with `git checkout --`, and
 * the sweep had a DIFFERENT file mutated at that moment — so the two instances were each editing
 * and reverting the same working tree, and either could have wiped the other's mutation in the
 * middle of a gate run. The selftest's own clean-tree checks failed, which is how I noticed; had
 * they collided on the same file instead, the sweep would have quietly reported a mutation as
 * MISSED because it was no longer applied.
 *
 * A lock file, so the second instance says so instead of corrupting the first. Held for the whole
 * run and released on exit, including on a throw.
 */
const LOCK = path.join(ROOT, '.mutation-sweep.lock');
function takeLock(what) {
  try {
    fs.writeFileSync(LOCK, `${what} pid ${process.pid} at ${new Date().toISOString()}\n`, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;
    let held = '';
    try { held = fs.readFileSync(LOCK, 'utf8').trim(); } catch { /* raced away */ }
    console.error('REFUSING: another mutation-sweep is running, and two of them share one working');
    console.error('tree — each would revert the other\'s mutation mid-gate and report it MISSED.');
    if (held) console.error(`  lock held by: ${held}`);
    console.error(`  if that process is gone, delete ${path.relative(ROOT, LOCK)}`);
    process.exit(2);
  }
  const drop = () => { try { fs.unlinkSync(LOCK); } catch { /* already gone */ } };
  process.on('exit', drop);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { drop(); process.exit(130); });
}

/**
 * THE DIRTY-TREE REFUSAL, AND IT COVERS BOTH ENTRY POINTS NOW — which it did not, and the half it
 * left uncovered is the half that destroys work.
 *
 * `restore()` is `git checkout -- <file>`, so on an uncommitted file it reverts YOUR edit along
 * with the mutation. The sweep path refused on a dirty tree; `--selftest` only RECORDED a failed
 * check saying "the selftest itself needs a clean tree to prove anything" and then went on to
 * mutate `src/damage.js` and check it out anyway. Run against a tree carrying an uncommitted
 * `src/damage.js`, it deleted the module under construction — a whole new class and its composer,
 * gone, with git holding no copy to give back.
 *
 * CLAUDE.md already records this exact mechanism ("`git checkout -- file` on an UNCOMMITTED file
 * reverts your own work with the test mutation") and this tool already had the right refusal
 * written, twenty lines below the branch that needed it. A warning is not a guard, and a guard on
 * one of two paths reads as a guard: the recurring shape in this repo is patching one and leaving
 * its sibling, and these two are siblings in one file.
 *
 * So it is hoisted above both branches and runs before the lock, before any mutation, and before
 * either path can write to a tracked file.
 */
/**
 * `--list` GOES ABOVE THE REFUSAL, because it provably writes nothing and a dirty tree is exactly
 * when somebody wants to read the table. Hoisting the refusal above both WRITING branches was the
 * fix for a selftest that destroyed an uncommitted module; hoisting it above the read-only branch
 * too was overreach in the same commit, and it made the documented "print the table and exit,
 * writing nothing" impossible to do while holding uncommitted work.
 */
if (has('--list')) {
  console.log(`${MUTATIONS.length} mutations\n`);
  for (const m of MUTATIONS) {
    console.log(`  ${m.id.padEnd(16)} ${m.file.padEnd(22)} ${m.browser ? '[browser] ' : ''}${m.why}`);
  }
  process.exit(0);
}

if (!gitClean()) {
  console.error('REFUSING: the working tree is dirty.');
  console.error('This tool restores by `git checkout -- <file>`, which would discard your changes.');
  console.error('Commit or stash first. (The district is 16 GB against 7 GB free, so there is no');
  console.error('shadow copy to mutate instead.)');
  process.exit(2);
}

// --------------------------------------------------------------------------- selftest
if (has('--selftest')) {
  takeLock('selftest');
  const checks = [];
  const say = (ok, name, detail) => { checks.push({ ok, name, detail }); };

  // 1. The refusal. Restoring by `git checkout --` is only safe on a clean tree.
  say(typeof gitClean() === 'boolean', 'it can read whether the tree is clean');
  say(gitClean(), 'the selftest itself needs a clean tree to prove anything', 'commit first');
  // Untracked files must NOT count as dirty, or this tool refuses to run because of itself.
  say(gitClean(), 'an untracked file does not read as dirty', 'this file was untracked on its first run');
  const untracked = [...new Set(MUTATIONS.map((m) => m.file))].filter((f) => !tracked(f));
  say(untracked.length === 0, 'every mutation targets a file git tracks, so restore cannot fail',
    untracked.join(', ') || 'all tracked');

  /**
   * 1b. EVERY ROW STILL FINDS ITS TARGET, EXACTLY ONCE.
   *
   * A full sweep reports STALE for a row whose code moved under it — and a full sweep is
   * long, so nothing checks between them, and a table can rot for weeks while reading as
   * coverage. CLAUDE.md says in as many words that a full sweep "is also the only thing that
   * catches a row going STALE"; that sentence was a description of a gap, not a plan.
   *
   * Found the hard way: one round refactored `composeBand`'s `??` chain into `BAND_ORDER`
   * and a later round rerouted its subtitle through `objectiveLine`, and between them THREE
   * rows over src/hud.js silently stopped matching anything. A scan of the whole table found
   * seven stale rows across four files. This is that scan, and it is milliseconds.
   *
   * TWO matches is a failure as well as zero: `apply()` replaces the first occurrence, so an
   * ambiguous target mutates a line the row's `why` is not about.
   */
  {
    const seen = new Map();
    const bad = [];
    for (const m of MUTATIONS) {
      const abs = `${ROOT}/${m.file}`;
      if (!fs.existsSync(abs)) { bad.push(`${m.id}: no such file ${m.file}`); continue; }
      const body = seen.get(abs) ?? seen.set(abs, fs.readFileSync(abs, 'utf8')).get(abs);
      const n = body.split(m.find).length - 1;
      if (n !== 1) bad.push(`${m.id} (${m.file}): ${n} matches`);
    }
    say(bad.length === 0, `every one of ${MUTATIONS.length} rows finds its target exactly once`,
      bad.length ? bad.join('; ') : `${MUTATIONS.length} rows, ${seen.size} files`);
  }

  /**
   * 2. A MUTATION THAT MUST BE CAUGHT. Breaking syntax in a src file has to fail check-syntax, or
   *    the harness is not running the gates it claims to.
   */
  const bad = { id: 'selftest-syntax', file: 'src/damage.js',
    find: 'export function pedFatalityRisk(speedMs) {', to: 'export function pedFatalityRisk(speedMs) { (' };
  const a1 = apply(bad);
  const g1 = a1 ? runGate('check-syntax') : null;
  if (a1) restore(bad);
  say(!!a1 && g1.rc !== 0, 'a broken module fails check-syntax', g1 ? `rc ${g1.rc}` : 'find string missing');
  say(gitClean(), 'and the tree is clean again afterwards');

  /**
   * 3. A NO-OP MUTATION MUST BE REPORTED AS MISSED. Without this the harness could be finding
   *    something for every line — including the ones it has broken by accident — and a table of
   *    all-caught would read as good news.
   */
  const noop = { id: 'selftest-noop', file: 'src/damage.js',
    find: 'export const THROW = Object.freeze(', to: 'export const THROW = /* noop */ Object.freeze(' };
  const a2 = apply(noop);
  const g2 = a2 ? runGate('check-syntax') : null;
  const g2b = a2 ? runGate('damage-test') : null;
  if (a2) restore(noop);
  say(!!a2 && g2.rc === 0 && g2b.rc === 0, 'a semantically identical edit is caught by nothing',
    g2 ? `check-syntax rc ${g2.rc}, damage-test rc ${g2b.rc}` : 'find string missing');

  /**
   * 3b. A GATE THAT PRINTS FAIL AND EXITS 0 IS REPORTED AS A BROKEN GATE, NOT AS A MISSED ROW.
   *
   * This is the arm the defect that prompted it would have needed. `mission-test` snapshotted
   * `const failed = checks.filter(...)` a hundred and thirty lines above its last section, so
   * that section's nine checks printed in the listing and none reached the exit code: with the
   * garage moved onto a mission pickup point it printed three FAIL lines, said
   * `MISSION: PASS — 121 checks`, exited 0, and this sweep recorded the row MISSED. A MISSED row
   * sends a round out to write a check; the check was already there and failing.
   *
   * TWO MUTATIONS AT ONCE, IN TWO FILES, which is what makes this an integration arm rather than
   * a test of one boolean: a real defect in the subject AND the accounting broken on top of it.
   * The control is the same subject defect with the accounting intact, and the two have to
   * disagree — otherwise this arm would pass for a sweep that called everything broken.
   */
  const subject = { id: 'selftest-garage', file: 'district/main.js',
    find: 'const GARAGE_AT = { x: -67.9, z: 60.3 };', to: 'const GARAGE_AT = { x: 19, z: -6 };' };
  const blind = { id: 'selftest-blind', file: 'tools/mission-test.mjs',
    find: 'const failed = checks.filter((c) => !c.ok);',
    to: 'const failed = checks.slice(0, 0).filter((c) => !c.ok);' };
  const sApplied = apply(subject);
  const honest = sApplied ? runGate('mission-test') : null;
  const bApplied = sApplied ? apply(blind) : null;
  const blinded = bApplied ? runGate('mission-test') : null;
  if (bApplied) restore(blind);
  if (sApplied) restore(subject);
  say(!!honest && honest.rc !== 0 && honest.failed.length > 0 && !honest.brokenAccounting,
    'a real defect makes the gate exit non-zero, which is the control for the next one',
    honest ? `rc ${honest.rc}, ${honest.failed.length} FAIL line(s), broken ${honest.brokenAccounting}`
      : 'the garage line is not in district/main.js');
  say(!!blinded && blinded.rc === 0 && blinded.failed.length > 0 && blinded.brokenAccounting,
    'and a gate whose accounting is broken is reported as broken, not as a missed row',
    blinded ? `rc ${blinded.rc}, ${blinded.failed.length} FAIL line(s), broken ` +
      `${blinded.brokenAccounting}` : 'the accounting line is not in tools/mission-test.mjs');
  say(!!honest && !!blinded && honest.failed.length === blinded.failed.length,
    'and both printed the same failures, so only the accounting differed',
    honest && blinded ? `${honest.failed.length} vs ${blinded.failed.length} FAIL lines` : 'n/a');

  // 4. A STALE line is reported as stale, not as a miss.
  const stale = { id: 'selftest-stale', file: 'src/damage.js',
    find: 'a string that is certainly not in this file 8f3a', to: 'x' };
  say(apply(stale) === null, 'a find string that does not occur reports STALE');

  // The lock is untracked, so holding it must not make the tree read as dirty — otherwise the
  // tool locks itself out on its own second check.
  say(fs.existsSync(LOCK) && gitClean(), 'holding the lock does not make the tree read as dirty');

  // An inert row must not be counted as a gate gap, and a row with no note must be.
  const inertRows = MUTATIONS.filter((m) => m.inert);
  say(inertRows.length > 0 && inertRows.every((m) => typeof m.inert === 'string' && m.inert.length > 20),
    'every inert row carries the measurement that says it is inert',
    inertRows.map((m) => m.id).join(', ') || 'none');
  say(MUTATIONS.filter((m) => !m.inert).length > MUTATIONS.length / 2,
    'and most rows are not excused, so the table is not mostly notes');

  // 5. And the throw/fail distinction, on real output shapes.
  say(/^\s+at .+:\d+:\d+\)?$/m.test('    at file:///x/y.mjs:12:3'), 'a node stack frame reads as a throw');
  say(!/^\s+at .+:\d+:\d+\)?$/m.test('  FAIL  some check — 3 against 4'),
    'and a FAIL line does not');

  console.log('MUTATION SWEEP SELFTEST');
  for (const c of checks) console.log(`  ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? ` — ${c.detail}` : ''}`);
  const bad2 = checks.filter((c) => !c.ok).length;
  console.log(bad2 ? `\nSELFTEST: FAIL — ${bad2} of ${checks.length}` : `\nSELFTEST: PASS — ${checks.length} checks`);
  process.exit(bad2 ? 1 : 0);
}

// --------------------------------------------------------------------------- listing
// --------------------------------------------------------------------------- the sweep

const untracked = [...new Set(MUTATIONS.map((m) => m.file))].filter((f) => !tracked(f));
if (untracked.length) {
  console.error(`REFUSING: these targets are not tracked by git, so restore would fail: ${untracked.join(', ')}`);
  process.exit(2);
}

takeLock('sweep');
const only = val('--only', null);
const browser = has('--browser');
const list = only ? MUTATIONS.filter((m) => m.id === only) : MUTATIONS;
if (!list.length) { console.error(`no mutation with id "${only}"`); process.exit(2); }

console.log(`MUTATION SWEEP — ${list.length} mutation(s), ${OFFLINE.length} offline gates` +
  `${browser ? ' + boot-check where asked' : ''}`);
console.log(`tree ${execSync('git rev-parse --short HEAD', { cwd: ROOT, encoding: 'utf8' }).trim()}` +
  `${browser ? `, browser port ${treePort()}` : ''}\n`);

/**
 * THE BROWSER GATE HAS TO PASS AT HEAD BEFORE IT CAN JUDGE ANYTHING, and this control is what a
 * blind reviewer's round was missing. `boot-check` was RED at HEAD for three commits — four of 42,
 * deterministically, in its own run-over arm — and every `[browser]` row in that reviewer's sweep
 * came back "caught" regardless of what it mutated, because the sweep reads a non-zero exit as a
 * gate noticing. They proved it with a row that was the same program either way.
 *
 * A gate that already fails cannot distinguish anything, so the sweep refuses rather than
 * reporting. One run of boot-check, up front, which is a minute against the hour the rows cost.
 */
if (browser && list.some((m) => m.browser)) {
  process.stdout.write('  control         boot-check at HEAD ... ');
  const ctl = runGate('boot-check');
  if (ctl.timedOut) {
    console.log(`TIMED OUT after ${(ctl.ms / 1000).toFixed(0)} s`);
    console.error('\nREFUSING: boot-check did not finish inside its budget at HEAD, which says nothing');
    console.error('about the build and leaves nothing for a [browser] row to be compared with.');
    console.error('Run it alone and read how long it takes before raising GATE_TIMEOUT_MS.');
    process.exit(2);
  }
  if (ctl.rc !== 0) {
    console.log(`RED (${ctl.threw ? 'threw' : `${ctl.failed.length} failed`})`);
    console.error('\nREFUSING: the browser gate does not pass at HEAD, so it cannot tell a');
    console.error('mutation from the state it is already in — every [browser] row would come');
    console.error('back "caught" whatever it did. Fix boot-check first.');
    for (const f of ctl.failed.slice(0, 6)) console.error(`  ${f}`);
    process.exit(2);
  }
  console.log(`green in ${(ctl.ms / 1000).toFixed(0)} s`);
}

const rows = [];
for (const m of list) {
  process.stdout.write(`  ${m.id.padEnd(16)} `);
  const a = apply(m);
  if (a === null) {
    rows.push({ m, verdict: 'STALE', gates: [] });
    console.log('STALE — its `find` string is not in the file any more');
    continue;
  }
  if (a.ambiguous) {
    restore(m);
    rows.push({ m, verdict: 'AMBIGUOUS', gates: [] });
    console.log(`AMBIGUOUS — ${a.ambiguous} occurrences; narrow the find string or set firstOnly`);
    continue;
  }
  const gates = [];
  for (const g of OFFLINE) gates.push(runGate(g));
  gates.push(playtestSelftest());
  if (browser && m.browser) gates.push(runGate('boot-check'));
  restore(m);
  const timed = gates.filter((g) => g.timedOut);
  const caught = gates.filter((g) => g.rc !== 0 && !g.timedOut);
  /**
   * SURFACED ON THE ROW, because a gate that printed FAIL and exited 0 makes every verdict on
   * this row meaningless — including a `caught` from some other gate, which may be masking the
   * same thing. See `runGate`.
   */
  const broken = gates.filter((g) => g.brokenAccounting);
  if (broken.length) {
    console.log(`BROKEN GATE — ${broken.map((g) => `${g.name} printed ` +
      `${g.failed.length} FAIL line(s) and exited 0`).join('; ')}`);
    console.error(`\nSTOPPING: ${broken.map((g) => g.name).join(', ')} does not exit non-zero on` +
      ' its own failing checks, so no row in this sweep can be trusted. Its accounting has to be');
    console.error('fixed before the table means anything. First FAIL line(s):');
    for (const g of broken) for (const f of g.failed.slice(0, 4)) console.error(`  ${g.name}: ${f}`);
    restore(m);
    process.exit(2);
  }
  /**
   * A MUTATION MEASURED TO CHANGE NOTHING IS NOT A GATE GAP. Without this a permanently inert row
   * either nags for ever or gets deleted, and deleting it loses the measurement that says it is
   * inert. `inert` rows are reported apart from real misses — and if one is ever CAUGHT, that is a
   * finding too, because the note claiming it changes nothing has stopped being true.
   */
  const verdict = caught.length ? (m.inert ? 'caught-but-noted-inert' : 'caught')
    : timed.length ? 'TIMED OUT' : (m.inert ? 'inert' : 'MISSED');
  rows.push({ m, verdict, gates: caught });
  console.log(`${verdict}${caught.length ? ` by ${caught.map((g) => g.name + (g.threw ? '(threw)' : '')).join(', ')}` : ''}` +
    `${timed.length ? `${caught.length ? ';' : ''} ${timed.map((g) => g.name).join(', ')} timed out` : ''}`);
  if (!gitClean()) {
    console.error(`\nSTOPPING: the tree did not come back clean after ${m.id}. Inspect it by hand.`);
    process.exit(2);
  }
}

// --------------------------------------------------------------------------- report
console.log('\n' + '='.repeat(78));
const missed = rows.filter((r) => r.verdict === 'MISSED');
const stale = rows.filter((r) => r.verdict === 'STALE' || r.verdict === 'AMBIGUOUS');
const caught = rows.filter((r) => r.verdict.startsWith('caught'));
const inert = rows.filter((r) => r.verdict === 'inert');
const timedOutRows = rows.filter((r) => r.verdict === 'TIMED OUT');
const wrongNote = rows.filter((r) => r.verdict === 'caught-but-noted-inert');
console.log(`caught ${caught.length}   MISSED ${missed.length}   inert ${inert.length}` +
  `   stale/ambiguous ${stale.length}${timedOutRows.length ? `   TIMED OUT ${timedOutRows.length}` : ''}   of ${rows.length}`);
if (timedOutRows.length) {
  console.log('\nTIMED OUT — a gate ran out of time and caught nothing else, so the row is unmeasured:');
  for (const r of timedOutRows) console.log(`  ${r.m.id}`);
}
if (inert.length) {
  console.log('\nINERT — measured to change nothing at HEAD, so there is nothing for a gate to see:');
  for (const r of inert) console.log(`  ${r.m.id}  ${r.m.inert}`);
}
if (wrongNote.length) {
  console.log('\nNOTED INERT BUT CAUGHT — the note has stopped being true, which is a finding:');
  for (const r of wrongNote) {
    console.log(`  ${r.m.id}  caught by ${r.gates.map((g) => g.name).join(', ')}`);
    console.log(`      the note says: ${r.m.inert}`);
  }
}

if (missed.length) {
  console.log('\nMISSED — a defect no gate in the list noticed:');
  for (const r of missed) {
    console.log(`  ${r.m.id}  (${r.m.file})`);
    console.log(`      ${r.m.why}`);
    if (r.m.browser && !browser) {
      console.log('      NOTE: marked [browser]; no offline gate imports district/main.js, so this');
      console.log('      is invisible BY CONSTRUCTION. Re-run with --browser to include boot-check.');
    }
  }
}
if (stale.length) {
  console.log('\nSTALE — this file is out of date, which is a defect in this file and not a pass:');
  for (const r of stale) console.log(`  ${r.m.id}  (${r.m.file})  ${r.verdict}`);
}
const threwOnly = caught.filter((r) => r.gates.every((g) => g.threw));
if (threwOnly.length) {
  console.log('\nCAUGHT ONLY BY A THROW — a weaker catch than a failed check, because the gate did');
  console.log('not notice, something died on the way:');
  for (const r of threwOnly) {
    console.log(`  ${r.m.id}  ${r.gates.map((g) => g.name).join(', ')}`);
  }
}
console.log('\nper mutation:');
for (const r of rows) {
  const by = r.gates.map((g) => `${g.name}${g.threw ? '(threw)' : ''}`).join(' ');
  console.log(`  ${r.verdict.padEnd(10)} ${r.m.id.padEnd(16)} ${by}`);
}
// The sweep is a report, not a gate: a MISS is information, and failing the command on one would
// make a round delete the mutation rather than close the hole. Stale lines DO fail, because they
// are this file rotting.
console.log(stale.length
  ? `\nMUTATION SWEEP: ${stale.length} STALE LINE(S) — fix the table`
  : '\nMUTATION SWEEP: done');
process.exit(stale.length ? 1 : 0);
