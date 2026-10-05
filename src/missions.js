// The authored missions.
//
// Data only: every mission here is validated by defineMission() at import time, so a
// fault in this file is a module that fails to load rather than a mission that
// dead-ends on the one path nobody walked. The engine and the reasoning behind that
// are in src/mission.js.
//
// COORDINATES ARE THE DISTRICT'S OWN BAKED ROUTE, read off data/district.json's
// meta.route rather than invented:
//
//    0  (-471,  205)  Marina / bayfront
//    1  (-328,   63)  Bayfront @ Main St
//    2  (  19,   -6)  Main St @ Pineapple Ave
//    3  (  57, -164)  Five Points junction
//    4  ( 569, -164)  Main St east
//    5  ( 619, -344)  Turn north
//    6  ( 209, -385)  2nd St westbound
//    7  (-173, -423)  2nd St @ Cocoanut
//    8  (-335,  -12)  Back to bayfront
//
// Street names follow FEASIBILITY-1B's fiction: Main Street is MARLIN STREET,
// Pineapple is Tarpon Row, Gulfstream is Halyard, Lemon is Lantern.
import { defineMission } from './mission.js';

/**
 * MARLIN STREET — the first mission.
 *
 * Shaped around the systems that already exist rather than around systems it would
 * be nice to have. It uses: on-foot/in-vehicle transitions (mode switching works),
 * arrival at a point (the route is baked), a stage deadline, the wanted system's
 * escalation and its SEARCH-then-CLEAR distinction, and a health floor. It asks for
 * nothing that does not already run.
 *
 * The beat: a courier run east along Marlin Street that turns into a pursuit at the
 * Five Points junction, and has to be shaken before the drop at the marina.
 *
 * WHY THE CHASE STAGE USES `evaded` AND NOT `wantedAtMost: 0`. The wanted system drops
 * the last star and then holds a SEARCH state while units sweep the last known
 * position; wantedAtMost:0 is true the instant the star goes, which is not "you got
 * away" and would clear the mission while three cars are still converging on the
 * player. `evaded` requires stars 0 AND state clear.
 *
 * WHY THE PURSUIT STAGE HAS A DEADLINE THAT PASSES RATHER THAN FAILS. A player who
 * cannot shake the police in four minutes has not failed the courier job - the parcel
 * is still in the car. It routes to the drop with the heat still on, which is a harder
 * ending, not a lost one. A mission that can only be completed one way is a mission
 * most players do not complete.
 */
/**
 * WHERE A MISSION GIVES UP ON THE CAR, AND WHY IT IS THIS NUMBER.
 *
 * It was 0.2, and that left an UNWINNABLE BAND 0.08 wide. `src/damage.js`'s `fireHealth` is
 * 0.12: a hit that takes health to 0.12 or below latches a fire, which drains at 0.04/s, wrecks
 * the car, and `respawnCar()` repairs it — health 1.000 with a replacement alongside. A hit that
 * leaves health in [0.12, 0.20) latches nothing. There is no fire, no wreck, no replacement, and
 * `damage.repair()` has exactly two callers in the whole tree: inside `respawnCar()` and the
 * `__district.repairCar()` console hook. There is no garage, no spray shop, no repair anywhere a
 * player can reach.
 *
 * So the car was RESCUED BY BEING MORE BROKEN AND STRANDED BY BEING LESS. A playtester found it:
 * at health 0.1542 they started marlin-street three times, drove the 168 m eastbound leg each
 * time — `eastbound` carries no health guard, so the mission can always be STARTED — and failed
 * on entry to `ambush` after 19.8 s, with the marker put back on the map every time. Measured
 * boundaries: 0.2020 playable, 0.1794 dead, 0.1263 dead, 0.0958 rescued by its own fire. The
 * only escape was 7.2 s of full throttle into a wall, which nothing in the game tells you about.
 *
 * Matching this to `fireHealth` gives the invariant **if the car runs, the job is possible**: a
 * mission may only give up on health once the car is already burning down to a replacement, so
 * failing the job and losing the car are the same event instead of two with a gap between them.
 * It is the smaller of the two available fixes — the other is to make cars catch fire at 20%
 * health, which removes the band by changing what every collision costs.
 *
 * `tools/mission-test.mjs` asserts the RELATION against damage.js's own constant rather than
 * this literal, so moving either number without the other fails the gate.
 */
const MISSION_FAIL_HEALTH = 0.12;

export const MARLIN_STREET = defineMission({
  id: 'marlin-street',
  title: 'Marlin Street',
  /**
   * THE SETUP LINE LIVES HERE BECAUSE `toCar` IS SKIPPED BY ANYONE WHO DRIVES TO THE JOB.
   * `toCar`'s only exit is `inVehicle`, which is already true for a player who arrives by car,
   * so the transition completes in the frame it began: a playtester measured the first objective
   * on screen for 0.008333 s, half a frame at 60 Hz. "The parcel is already in the boot." was the
   * flagship's only piece of setup narration and it appeared nowhere else, so a player who drove
   * to the marker never read it. The brief is shown at the OFFER, whatever mode they arrive in.
   * `toCar`'s own subtitle stays, because on foot the stage is real and holds for as long as you
   * stand there.
   */
  brief: 'A parcel from the marina to the east end of Marlin Street. The parcel is already in'
    + ' the boot. Should be simple.',
  /**
   * THE PICKUP, and why it is 354 m from the spawn rather than on top of it. A job you are
   * standing in when the page loads is not a job you chose; a job 354 m up the road is a reason
   * to drive into town, which is the one thing this district is for. (19, -6) is route waypoint
   * 2, Marlin Street at Tarpon Row, on the centreline of a 6.6 m street with 6 m of clearance
   * either side and the crowd already around it.
   */
  start: { x: 19, z: -6, radius: 12 },
  stages: [
    {
      id: 'toCar',
      objective: 'GET TO THE CAR',
      subtitle: 'The parcel is already in the boot.',
      triggers: [
        { kind: 'inVehicle', goto: 'eastbound' },
      ],
      onEnter: { stinger: 'missionStart', hudFlash: true },
    },
    {
      id: 'eastbound',
      objective: 'DRIVE EAST ALONG MARLIN STREET',
      subtitle: 'Five Points, then keep going.',
      marker: { x: 57, z: -164 },
      triggers: [
        { kind: 'reach', x: 57, z: -164, radius: 30, goto: 'ambush' },
        // Stepping out mid-run does not fail the job, it just interrupts it.
        { kind: 'onFoot', goto: 'backToCar' },
      ],
    },
    {
      id: 'backToCar',
      objective: 'GET BACK IN THE CAR',
      subtitle: null,
      triggers: [
        { kind: 'inVehicle', goto: 'eastbound' },
      ],
    },
    {
      // The turn. Two stars arrive as an intent for main.js to apply to the wanted
      // system; the runner itself never calls it.
      id: 'ambush',
      objective: 'LOSE THEM',
      /**
       * NO MARKER, AND THE HISTORY IS THE WHOLE ARGUMENT — three markers in three rounds, and a
       * GATE RULE PUT EVERY ONE OF THEM THERE.
       *
       * 1. The stage originally had none, and that was measured as the worst thing in the game:
       *    a playtester sat through 156.3 s of a 249.4 s run — 63% — with a blank HUD across
       *    five entries. So `mission-test` grew "every stage with a time limit has somewhere to
       *    go".
       * 2. To satisfy it the marker went at the drop, (-471, 205) — which is `drop`'s own reach
       *    trigger, 0.0 m away, radius 28 m. A player who follows the HUD shakes the tail
       *    standing on the drop, `drop` fires in the same breath, and "DELIVER THE PARCEL TO THE
       *    MARINA" is the active stage for 0.033 s. The delivery leg of the delivery mission did
       *    not exist. So `mission-test` grew a second rule: a marker must not sit inside the next
       *    stage's reach radius.
       * 3. (-194.8, 38.6) satisfies both rules — 322 m from the drop, 11.5x its radius, 0.06 m
       *    off a routable road — and is still wrong, because THIS STAGE HAS NO DESTINATION AT
       *    ALL. Its only exit is `{ all: [timer 2 s, evaded] }`. A playtester drove the arrow to
       *    1 m and stopped, which is what you do with an arrow, and was arrested at the two stars
       *    this stage's own `onEnter` had just given them: MISSION ABORTED, 3 of 6 stages.
       *    Reproduced here — arrived at the cue, held the brake, busted, aborted at t=198.3 s.
       *    Driving away instead passed the mission at 273.7 s.
       *
       * So the property is not another rule about WHERE a marker may sit. It is that **a stage
       * whose exit condition is not positional must not post a positional cue** — `src/mission.js`
       * now refuses one in `defineMission`, which makes it an authoring error rather than a gate
       * rule a later round can satisfy sideways for a fourth time.
       *
       * AND THE CUE IS NOT GONE, IT IS THE RIGHT ONE. Measured on entry to this stage, with
       * nothing else in the world: the wanted strip reads `EVADING 16s` and the minimap carries
       * two `enemy` blips at 128 m and 265 m. Both already existed. A red dot chasing you cannot
       * be misread as a destination, which is exactly what the old arrow was.
       */
      /**
       * THE SUBTITLE HAS TO SAY WHAT TO DO, because this stage is the only one with no waypoint.
       * A playtester sat through fourteen of them and reported the line as it read from the seat:
       * "'LOSE THEM — Somebody talked. Police at Five Points.' with no waypoint, 500 m from Five
       * Points ... from the seat it reads as a broken objective". The old text says where the
       * trouble came from; a player needs to know that the answer is distance and time.
       *
       * IT NAMED A CUE THAT NEVER FIRES. "watch the stars drop" was measured over 109 s of
       * fleeing at 40 km/h: the stars read 2 at EVERY sample and went 2 -> 0 in one step at the
       * stage transition, after the stage was already won. The thing that does move is the wanted
       * note — SEEN -> EVADING 11s -> SEEN -> REPORTED — so the line names that word instead,
       * exactly as `composeWanted` spells it.
       */
      subtitle: 'Somebody talked. Break away and run the EVADING clock down.',
      triggers: [
        // A MINIMUM DWELL BEFORE `evaded` COUNTS, and it is not belt-and-braces for
        // its own sake. The runner now breaks its transition chain whenever a stage
        // declares onEnter, so main.js is guaranteed a frame to apply `setWanted: 2`
        // before this is evaluated - but "one frame" is a promise about the host, and
        // a host that applies it late would let the player pass a chase that never
        // started. Nobody shakes a pursuit two seconds after it begins, so the
        // composite costs the player nothing and removes the dependency.
        { kind: 'all', of: [{ kind: 'timer', seconds: 2 }, { kind: 'evaded' }], goto: 'drop' },
        { kind: 'healthBelow', fraction: MISSION_FAIL_HEALTH, outcome: 'failed' },
      ],
      timeLimit: 240,
      onTimeout: 'dropHot',
      onEnter: { setWanted: 2, stinger: 'chase', hudFlash: true },
    },
    {
      id: 'drop',
      objective: 'DELIVER THE PARCEL TO THE MARINA',
      subtitle: 'Clear. Take it back to the bayfront.',
      marker: { x: -471, z: 205 },
      triggers: [
        { kind: 'reach', x: -471, z: 205, radius: 28, outcome: 'passed' },
        { kind: 'healthBelow', fraction: MISSION_FAIL_HEALTH, outcome: 'failed' },
        /**
         * THE HEAT COMING BACK DOES NOT UNDO THE DELIVERY, IT PUTS THE CHASE BACK ON — but ONE
         * star is not the heat coming back, it is an accident, and at `stars: 1` this trigger was
         * the single worst thing in the mission.
         *
         * The chain, isolated with the runner and the wanted system directly:
         *
         *     one pedestrianHit            -> 1 star  -> drop re-enters ambush
         *     ambush's onEnter setWanted:2 -> 2 stars (it fires on EVERY entry)
         *     escape clock, 1 star  12.1 s
         *     escape clock, 2 stars 30.2 s
         *
         * So a single clip at 8 km/h — one of a playtester's was 0.08 km/h over the free
         * threshold, thrown 0.4 m — was escalated by the mission's own re-entry into a 30-second
         * stage, five times in one run, for 63% of the mission with no waypoint. `pedestrianHit`
         * carries `min: 1`, so one star is the FLOOR of the least serious thing a driver can do.
         *
         * Two stars is the police having found you: two offences, or one `pedestrianKilled`
         * (`min: 2`). That is the quantity this trigger was always reaching for, and it is the
         * reviewer's own diagnosis — the threshold was doing two jobs.
         */
        { kind: 'wantedAtLeast', stars: 2, goto: 'ambush' },
      ],
      onEnter: { stinger: 'clear' },
    },
    {
      // The harder ending: still wanted, still expected at the marina.
      id: 'dropHot',
      objective: 'DELIVER THE PARCEL — THEY ARE STILL BEHIND YOU',
      subtitle: 'No more time. Get it to the marina.',
      marker: { x: -471, z: 205 },
      triggers: [
        { kind: 'reach', x: -471, z: 205, radius: 28, outcome: 'passed' },
        { kind: 'healthBelow', fraction: MISSION_FAIL_HEALTH, outcome: 'failed' },
      ],
      timeLimit: 300,
      onTimeout: 'failed',
      onEnter: { stinger: 'pressure', hudFlash: true },
    },
  ],
});

/**
 * A SHORT ONE, for testing the wiring in a live page without driving the district.
 * Both markers are within sight of the spawn, so a reviewer or a builder can confirm
 * objectives, waypoints and the pass path in under a minute.
 */
export const SHAKEDOWN = defineMission({
  id: 'shakedown',
  title: 'Shakedown',
  brief: 'Two markers by the bayfront. Exists so the wiring can be checked in a minute.',
  // 30 m along Marlin Street from the spawn: far enough not to fire on the first frame, close
  // enough to still be the one-minute wiring check this mission exists to be.
  start: { x: -308.9, z: 40, radius: 12 },
  stages: [
    { id: 'a', objective: 'GET IN THE CAR',
      triggers: [{ kind: 'inVehicle', goto: 'b' }] },
    /**
     * STAGE b'S MARKER WAS 0.35 m FROM THE SPAWN, so it cleared on the same frame stage `a` did
     * and the objective line was never read by anybody. Both playtesters found it independently:
     * "two of its three objectives are already satisfied", "the played mission is one 201 m
     * drive". (-328, 63) is route waypoint 1 and the spawn is (-327.84, 63.30) — inside a 30 m
     * radius by a factor of eighty. It is now 86 m up South Gulfstream Avenue, which is 8 s at
     * town speed and still visible from the start.
     */
    { id: 'b', objective: 'DRIVE TO THE BAYFRONT MARKER', marker: { x: -242.3, z: 68.6 },
      triggers: [
        { kind: 'reach', x: -242.3, z: 68.6, radius: 24, goto: 'c' },
        { kind: 'onFoot', goto: 'a' },
      ] },
    { id: 'c', objective: 'NOW THE MARINA', marker: { x: -471, z: 205 },
      triggers: [{ kind: 'reach', x: -471, z: 205, radius: 30, outcome: 'passed' }] },
  ],
});

export const MISSIONS = Object.freeze({
  [MARLIN_STREET.id]: MARLIN_STREET,
  [SHAKEDOWN.id]: SHAKEDOWN,
});
