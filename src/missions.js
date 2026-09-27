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
export const MARLIN_STREET = defineMission({
  id: 'marlin-street',
  title: 'Marlin Street',
  brief: 'A parcel from the marina to the east end of Marlin Street. Should be simple.',
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
       * AND IT POINTS AT THE DROP WHILE YOU SHAKE THEM, because a stage with no marker is a stage
       * with no waypoint, and this is the only one in either mission that had none. A playtester
       * measured 156.3 s of a 249.4 s run — 63% — with a blank HUD, across five entries, and
       * called it the worst thing in the game.
       *
       * `dropHot` already establishes the pattern: it is the harder ending and it points at the
       * marina while you are still wanted. There is no reading of this fiction where the courier
       * stops wanting to reach the drop, so being told where it is while being told to lose them
       * is coherent — and a player who does not know which way to run cannot run.
       */
      marker: { x: -471, z: 205 },
      /**
       * THE SUBTITLE HAS TO SAY WHAT TO DO, because this stage is the only one with no waypoint.
       * A playtester sat through fourteen of them and reported the line as it read from the seat:
       * "'LOSE THEM — Somebody talked. Police at Five Points.' with no waypoint, 500 m from Five
       * Points ... from the seat it reads as a broken objective". The old text says where the
       * trouble came from; a player needs to know that the answer is distance and time.
       */
      subtitle: 'Somebody talked. Get clear of them and stay clear — watch the stars drop.',
      triggers: [
        // A MINIMUM DWELL BEFORE `evaded` COUNTS, and it is not belt-and-braces for
        // its own sake. The runner now breaks its transition chain whenever a stage
        // declares onEnter, so main.js is guaranteed a frame to apply `setWanted: 2`
        // before this is evaluated - but "one frame" is a promise about the host, and
        // a host that applies it late would let the player pass a chase that never
        // started. Nobody shakes a pursuit two seconds after it begins, so the
        // composite costs the player nothing and removes the dependency.
        { kind: 'all', of: [{ kind: 'timer', seconds: 2 }, { kind: 'evaded' }], goto: 'drop' },
        { kind: 'healthBelow', fraction: 0.2, outcome: 'failed' },
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
        { kind: 'healthBelow', fraction: 0.2, outcome: 'failed' },
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
        { kind: 'healthBelow', fraction: 0.2, outcome: 'failed' },
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
