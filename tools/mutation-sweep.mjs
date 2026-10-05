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
    id: 'band-order', file: 'src/hud.js',
    find: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'law', 'mission', 'ended', 'offer'];",
    to: "export const BAND_ORDER = ['offer', 'ended', 'mission', 'law', 'fence', 'wreck', 'busted'];",
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
     * PUTS THE AMBUSH MARKER BACK ON THE DROP. Nothing errors, every stage still reaches every
     * other, the mission still passes -- it just passes 0.033 s after the player is told to make
     * the delivery, so the flagship mission's final objective is two frames long and the beat the
     * mission is named for does not happen. A playtester found the original; no gate could see it
     * until mission-test asserted that a marker never lands inside the next stage's reach radius.
     */
    id: 'drop-flash', file: 'src/missions.js',
    find: '      marker: { x: -194.8, z: 38.6 },',
    to: '      marker: { x: -471, z: 205 },',
    why: "the delivery mission's delivery leg disappears again",
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
    find: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'law', 'mission', 'ended', 'offer'];",
    to: "export const BAND_ORDER = ['busted', 'wreck', 'fence', 'mission', 'ended', 'offer'];",
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
    find: '    if (s.waypoint) sig += s.waypoint.x * 3.7 + s.waypoint.z * 11.9 + 4409;',
    to: '    if (false) sig += 0;',
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
    find: '    const delta = (c.min ?? 0) > 0 ? raw : Math.min(raw, FLOORLESS_CAP);',
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
    find: '    const delta = (c.min ?? 0) > 0 ? raw : Math.min(raw, FLOORLESS_CAP);',
    to: '    const delta = (c.min ?? 0) > 0 ? Math.min(raw, FLOORLESS_CAP) : raw;',
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
    find: '      if (near.d <= this.holdRadius && (u.held || (wantT > near.t && u.t <= near.t))) {',
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
    find: '      if (near.d <= this.holdRadius && (u.held || (wantT > near.t && u.t <= near.t))) {',
    to: '      if (near.d <= this.holdRadius && wantT > near.t && u.t <= near.t) {',
    why: 'a hold lasts two frames, so being caught becomes a coin flip',
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
    find: '      if (near.d <= this.holdRadius && (u.held || (wantT > near.t && u.t <= near.t))) {',
    to: '      if (u.held || (near.d <= this.holdRadius && wantT > near.t && u.t <= near.t)) {',
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
  return { name, rc, threw, failed, ms: Date.now() - t0 };
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
if (!gitClean()) {
  console.error('REFUSING: the working tree is dirty.');
  console.error('This tool restores by `git checkout -- <file>`, which would discard your changes.');
  console.error('Commit or stash first. (The district is 16 GB against 7 GB free, so there is no');
  console.error('shadow copy to mutate instead.)');
  process.exit(2);
}

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
