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
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : d; };

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
    find: 'if (!(along > CAR_LENGTH)) return Infinity;',
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
    find: 'Math.sign(throttle) * dot > 0',
    to: 'true',
    why: 'the world fence refuses power in both directions and strands the car outside',
  },
  // ---- src/roadpath.js
  {
    id: 'crawl-floor', file: 'src/roadpath.js',
    find: '  return Math.max(2.2, Math.min(gripSpeed(radius), steerableSpeed(radius)));',
    to: '  return Math.min(gripSpeed(radius), steerableSpeed(radius));',
    why: 'an impossible corner stops the car dead instead of letting it creep round',
  },
  // ---- src/blockers.js
  {
    id: 'resolve-eps', file: 'src/blockers.js',
    find: 'const EPS = 1e-6;',
    to: 'const EPS = 0;',
    why: 'resolveCircle stops converging: a parked car is charged an impact every frame',
  },
  // ---- src/mission.js
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
    find: "      subtitle: stars > 0 ? `wanted — ${stars} star${stars === 1 ? '' : 's'}` : 'nobody saw it' };",
    to: "      subtitle: 'nobody saw it' };",
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
    find: '    if (this.bustFor < BUST_HOLD_S) return false;',
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
     */
    id: 'bust-any-speed', file: 'src/wanted.js',
    find: '    if (this.stars <= 0 || !player.held ||\n        Math.hypot(this.playerVel.x, this.playerVel.z) >= SCENE_STOP_MS) {',
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
    find: '      if (near.d <= this.reachRadius && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
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
    find: '      if (near.d <= this.reachRadius && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
    to: '      if (near.d <= this.reachRadius && wantT > near.t && u.t <= near.t) {',
    why: 'a hold lasts two frames, so being caught becomes a coin flip',
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
    find: '      if (near.d <= this.reachRadius && (u.stopped || (wantT > near.t && u.t <= near.t))) {',
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
    find: '        const paint = paintFamily(this._r());\n        color.setHSL(paint.h, (0.26 + this._r() * 0.18) * paint.sat, l);',
    to: '        color.setHSL(this._r(), 0.26 + this._r() * 0.18, l);',
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
    find: '        const paint = paintFamily((h - 0.66) / 0.34);\n        this._pcol.setHSL(paint.h, (0.26 + h * 0.18) * paint.sat, l);',
    to: '        this._pcol.setHSL((h - 0.66) / 0.34, 0.26 + h * 0.18, l);',
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
    find: '        const paint = paintFamily(this._r());',
    to: '        this._r();\n        const paint = paintFamily(this._r());',
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
    find: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.032, l1: 0.062 }),",
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
     */
    id: 'tone-ratio', file: 'src/carpaint.js',
    find: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.032, l1: 0.062 }),",
    to: "  Object.freeze({ name: 'black', w: 0.419, l0: 0.140, l1: 0.200 }),",
    why: 'a black car reads x3.6 too bright while still passing every anchor check',
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
     * THE TINT APPLIED TO EVERY SLOT INSTEAD OF NONE, which is the opposite error and is worse
     * than it looks. The paint stops being tinted at all, so every car in both fleets renders at
     * its authored vertex colour and the whole census becomes decorative — AND the lamp spill
     * stops working, because `src/traffic.js` carries a per-car BRIGHTNESS on that mesh with
     * `setColorAt(i, setScalar(f))` and every vertex of it is on the paint slot.
     *
     * CAUGHT BY A SOURCE REGEX AND NOT BY A MEASUREMENT, and that is worth saying rather than
     * leaving to be discovered: nothing offline renders a shader, and boot-check does not measure
     * spill brightness. The regex asserts the rule is still derived from `uv.x`. A stronger check
     * would need a capture of a lit car at night against an unlit one.
     */
    id: 'tint-slotless', file: 'src/carbody.js',
    find: 'vColor.xyz = mix( vColor.xyz, color.xyz, uPaintTintOnly * step( 0.5, floor( uv.x * 16.0 ) ) );',
    to: 'vColor.xyz = mix( vColor.xyz, color.xyz, uPaintTintOnly );',
    why: 'every car renders at its authored colour and the headlamp pools stop dimming per car',
  },
  {
    /**
     * ONE VERTEX OF THE LAMP SPILL MOVED OFF THE PAINT SLOT. The pools still draw, in the right
     * place, in the right colour, at the right size — and they stop responding to the car's own
     * headlamp state, because the per-car brightness rides on instanceColor and instanceColor now
     * reaches only slot 0. Invisible in every triangle count and every geometry check; the only
     * thing that sees it is the slot census over the built buffer.
     */
    id: 'glow-slot', file: 'src/carbody.js',
    find: '      return b.vert(cx + s * hw, yRoad, z0 + dir * dz, _c, SURFACE.paint);',
    to: '      return b.vert(cx + s * hw, yRoad, z0 + dir * dz, _c, SURFACE.matte);',
    why: 'the headlamp pools stop dimming with the car that casts them, and nothing else changes',
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
 * Derived from the tree's absolute path so two trees never collide and one tree is stable across
 * runs, in the ephemeral range above 8200 and clear of 8123.
 */
function treePort() {
  let h = 2166136261;
  for (const c of ROOT) { h ^= c.charCodeAt(0); h = (h * 16777619) >>> 0; }
  return 8200 + (h % 1200);
}
const GATE_ENV = { ...process.env, BOOT_PORT: String(treePort()) };

function runGate(name) {
  const t0 = Date.now();
  let out = '', rc = 0;
  // A gate may carry its own flags -- `crowd-bill --selftest` is one tool and one
  // argument, not a file called "crowd-bill --selftest.mjs". Without this split the
  // entry silently becomes an ENOENT, which exits non-zero and would have read as
  // "caught by crowd-bill" for every single mutation in the table.
  const [tool, ...flags] = name.split(/\s+/);
  try {
    out = execFileSync('node', [`tools/${tool}.mjs`, ...flags], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000,
      env: GATE_ENV,
    });
  } catch (e) {
    rc = e.status ?? 1;
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
  return { name, rc, threw, failed, brokenAccounting, ms: Date.now() - t0 };
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
if (has('--list')) {
  console.log(`${MUTATIONS.length} mutations\n`);
  for (const m of MUTATIONS) {
    console.log(`  ${m.id.padEnd(16)} ${m.file.padEnd(22)} ${m.browser ? '[browser] ' : ''}${m.why}`);
  }
  process.exit(0);
}

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
  const caught = gates.filter((g) => g.rc !== 0);
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
    : (m.inert ? 'inert' : 'MISSED');
  rows.push({ m, verdict, gates: caught });
  console.log(`${verdict}${caught.length ? ` by ${caught.map((g) => g.name + (g.threw ? '(threw)' : '')).join(', ')}` : ''}`);
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
const wrongNote = rows.filter((r) => r.verdict === 'caught-but-noted-inert');
console.log(`caught ${caught.length}   MISSED ${missed.length}   inert ${inert.length}` +
  `   stale/ambiguous ${stale.length}   of ${rows.length}`);
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
