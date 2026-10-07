// Wanted level and police response — the DECISION layer only.
//
// This module decides *what the police want to do*. It never decides where a car
// physically is. src/pursuit.js owns pursuit units and their movement and
// src/traffic.js owns civilian driving; both are being changed by other owners,
// so everything here crosses that boundary through a narrow, duck-typed
// interface (see `bindPursuit`) rather than by reaching into their internals.
//
// Consequences of that split, all deliberate:
//   - No three.js import. No meshes, no lights, no scene objects. Draw-call cost
//     is exactly zero and that is checkable by inspection: there is no
//     `import * as THREE` in this file.
//   - No clock of its own. Time advances only through `update(dt, player)`, so a
//     node test can run an hour of game time in a millisecond and get the same
//     answer every run. The only randomness is a seeded PRNG.
//   - Positions come IN (`reportUnit`) and intentions go OUT (`plan`). The module
//     asks for a unit at a spawn band and a goal; something else decides whether
//     a car can actually get there.
//
// The state machine:
//
//   clear ──crime──► active ──lost contact──► search ──timer──► (one star gone)
//     ▲                ▲                        │                     │
//     └────────────────┴───────re-acquired──────┘                     │
//     └────────────────────────────last star gone────────────────────-┘
//
// Escalation is by "heat" measured in stars, not by integers: three near-misses
// add up to one star the same way one collision does, and a crime can also set a
// hard floor (`min`) so shooting at an officer is never a one-star affair.
//
// Decay is the genre convention, not a timer that runs while you are being shot
// at: stars only fall in `search`, one at a time, and only after the player has
// been out of contact for the whole cooldown. Crimes lengthen that cooldown, so
// the escape from a hit-and-run is genuinely harder than the escape from a
// scraped bumper.
//
// Subscribers (HUD, sirens, mission scripting) attach with `on(event, fn)`. This
// module imports none of them; the dependency arrow points only inward.
//
// Events, all with a plain-object payload:
//   crime         {id, label, applied, heat, stars, at}
//   stars         {stars, prev, reason}      reason: crime|decay|clear|set
//   escalate      {stars, prev}              stars went up
//   clear         {reason}                   dropped to zero (escaped|busted|...)
//   state         {state, prev}              clear|active|search
//   contact       {seen, at}                 police have eyes on the player
//   lastKnown     {x, z}                     the search anchor moved
//   unit:request  {id, role, spawnMin, spawnMax, target}
//   unit:release  {id, reason}               deescalate|lost|clear
//   siren         {on, intensity, stars}
//   '*'           (event, payload) for every one of the above

const TAU = Math.PI * 2;
// NaN-safe by construction. A single non-finite value from the host — an
// uninitialised first frame's dt, a physics blow-up — must land on the low bound
// rather than propagate: `this.time += NaN` is permanent, and it silently kills
// every refractory window (a bumper grinding a wall becomes a five-star felony),
// `forceContact`, and the idle heat bleed. `v > lo` is false for NaN, so NaN takes
// the `lo` branch below.
const clamp = (v, lo, hi) => (v > lo ? (v > hi ? hi : v) : lo);

export const STATES = { CLEAR: 'clear', ACTIVE: 'active', SEARCH: 'search' };

/**
 * The crime vocabulary the game reports into this module.
 *
 *   heat        star delta added to the meter (fractions accumulate)
 *   min         hard star floor; a crime this serious is never below it
 *   cool        seconds added to the escape requirement — the "decay
 *               contribution". Two crimes worth the same star are not worth the
 *               same amount of police patience.
 *   refractory  minimum seconds between two reports of the SAME crime that
 *               count. A bumper grinding along a wall fires a collision every
 *               frame; without this, one scrape is a five-star felony.
 *   requiresWanted  ignored at zero stars (you cannot flee nobody).
 */
export const CRIMES = Object.freeze({
  reckless:          f({ label: 'Reckless driving',          heat: 0.40, cool: 2,  refractory: 3.0 }),
  propertyDamage:    f({ label: 'Property damage',           heat: 0.30, cool: 2,  refractory: 2.5 }),
  civilianCollision: f({ label: 'Collision with a vehicle',  heat: 0.50, cool: 3,  refractory: 1.5, scene: true }),
  hitAndRun:         f({ label: 'Left the scene',            heat: 0.80, cool: 10, refractory: 8.0, min: 1 }),
  /**
   * THE PEDESTRIAN CRIMES CARRY NO TYPE REFRACTORY, AND THAT IS DELIBERATE.
   *
   * They both used to carry 1.0 s, and a playtester measured what it cost: two DIFFERENT people
   * struck 0.2, 0.5 or 0.9 s apart produced two knockdowns and ONE crime, refused with reason
   * `refractory`; at 1.0 s and 1.1 s apart both were charged. At 40 km/h one second is 11.1 m,
   * so two people standing less than 11 m apart on a pavement were one offence, and a live
   * 96-pedestrian rampage filed 8 charges for 15 knockdowns.
   *
   * The refractory's own purpose — see the note above — is that a bumper grinding along a wall
   * is not a felony, which is a statement about ONE SUBJECT repeating. For a person the subject
   * is the victim, not the kind of event, and `VictimWindow` already does exactly that job at
   * 20 s per victim id: `district/main.js`'s `chargeVictim` guards BOTH pedestrian charge sites
   * (the standing case and `runOver`), so the same body cannot be billed twice however many
   * times it is driven over. Stacking a 1 s type window in front of a 20 s victim window adds
   * nothing to the repeat case and silently forgives the second casualty.
   *
   * `f()` defaults `refractory` to 0 and the test is `time - last < c.refractory`, so zero never
   * ignores. Removing it is the whole change; the repeat protection was never here.
   */
  /**
   * AND `pedestrianHit`'s HEAT IS `pedestrianKilled`'s FLOOR, so the two meet at the classification
   * switch instead of jumping. It was 1.15, which put the charge at 0.82 just below the switch and
   * 2.00 just above it — a step of 2.4x at one published speed. `_crimeFor` switches to
   * `pedestrianKilled` at `pedKillSpeed`, which is the fatality curve's own 50% point, so a strike
   * AT that speed should cost exactly what a kill costs at its floor. 2.00 is that number, taken
   * from the table rather than chosen, and `wanted-test` asserts the equality.
   *
   * It does not make the charge graduate in STARS below the switch, and it cannot: `min: 1` is a
   * floor and the next rung is 2, so every scale under 0.5 comes back out as one star. src/damage.js
   * records that mechanism and was right about it. What this buys is the graduation in HEAT over the
   * 50-77 km/h band — which accumulates, and lengthens the cooldown — and no step at the switch.
   */
  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 2.00, cool: 8,  refractory: 0, min: 1, scene: true }),
  pedestrianKilled:  f({ label: 'Pedestrian killed',         heat: 2.00, cool: 15, refractory: 0, min: 2, scene: true }),
  vehicleTheft:      f({ label: 'Vehicle taken',             heat: 1.00, cool: 6,  refractory: 2.0, min: 1 }),
  assault:           f({ label: 'Assault',                   heat: 1.00, cool: 6,  refractory: 1.0, min: 1 }),
  brandish:          f({ label: 'Weapon brandished',         heat: 0.60, cool: 3,  refractory: 3.0 }),
  discharge:         f({ label: 'Firearm discharged',        heat: 1.10, cool: 8,  refractory: 1.0, min: 1 }),
  restrictedArea:    f({ label: 'Restricted area entered',   heat: 1.00, cool: 6,  refractory: 10.0, min: 1 }),
  policeProperty:    f({ label: 'Police vehicle rammed',     heat: 1.20, cool: 9,  refractory: 1.5, min: 2 }),
  roadblockRun:      f({ label: 'Roadblock rammed',          heat: 1.00, cool: 10, refractory: 3.0, min: 3 }),
  officerAssault:    f({ label: 'Officer assaulted',         heat: 2.20, cool: 16, refractory: 1.0, min: 3 }),
  officerDown:       f({ label: 'Officer down',              heat: 3.00, cool: 26, refractory: 1.0, min: 4 }),
  evading:           f({ label: 'Evading pursuit',           heat: 0.15, cool: 4,  refractory: 4.0, requiresWanted: true }),
});

/**
 * `scene: true` marks an offence that leaves someone owed aid, so driving away from it is a second
 * offence. Property damage is not one of them: a wall does not need help. See `_watchScene`.
 */
function f(c) { return Object.freeze({ cool: 0, refractory: 0, min: 0, requiresWanted: false, scene: false, ...c }); }

/**
 * Per-star response tuning, indexed by star level 0..5.
 *
 *   units          how many cars the pursuit layer is asked to hold live
 *   spawnMin/Max   the band around the target new units appear in — wider at
 *                  high stars because a city-wide response converges from far
 *                  away, and because spawning six cars inside 190 m looks staged
 *   giveUpRadius   a unit past this from the target is out of the fight
 *   speedMul       multiplier on the pursuit layer's own base speed
 *   intercept      units try to cut ahead of the player instead of trailing
 *   aggression     0..1 advisory: ramming, boxing in, weapons free
 *   cooldown       seconds out of contact needed to shed ONE star
 *   searchGrow     metres per second the search ring expands
 *   spotRadius     how close a unit must be (with line of sight) to hold contact
 *   siren          0..1 advisory for the audio layer
 *
 * Every column is monotonic in stars; the node test asserts that, because a
 * tuning table that accidentally makes four stars gentler than three is the kind
 * of defect that hides for months.
 */
/**
 * How far from the scene of an injury counts as having left it, and how slowly the car has to be
 * going to count as having stopped there. See `_watchScene` for the derivation of each.
 * SCENE_LEAVE_M is assigned from RESPONSE below, once that table exists.
 */
export let SCENE_LEAVE_M = 0;
export const SCENE_STOP_MS = 1.0;

/**
 * HOW LONG A UNIT HAS TO HOLD YOU, STOPPED, BEFORE YOU ARE BUSTED.
 *
 * THE FLOOR IS MEASURED AND IT IS NOT ZERO. A driver who brakes hard to a standstill and
 * immediately floors it away spends time below the stop threshold whether they like it or not, and
 * a bust that fires inside that window busts a player for using the brake.
 *
 * MEASURED ON THE QUANTITY THE CLOCK READS, which is the correction a blind mutation reviewer
 * made and it was the right call. `_watchBust` tests the SMOOTHED `playerVel` against
 * `SCENE_STOP_MS` (1.0 m/s); the first version of this derivation quoted the car's RAW speed under
 * `ANCHORS.freeDv` (2.2), which is a different threshold on a different signal. Both rows, from
 * src/vehicle.js on flat ground feeding its own positions to this module, full brake to rest then
 * full throttle, at 20 / 40 / 60 / 80 / 110 km/h entry:
 *
 *     smoothed under 1.0 m/s, which the clock reads   0.20 0.17 0.12 0.17 0.17
 *     raw speed under 2.2 m/s, which it does not      0.68 0.67 0.65 0.67 0.67
 *     and with a deliberate 2 s pause on top          2.28 / 2.67
 *
 * Flat in the entry speed either way, because the last metre per second of a braking curve and the
 * first of an acceleration do not depend on where the braking started. So the floor is 0.20 s and
 * a deliberate 2 s pause is 2.28 s. The error was conservative — it understated the margin — but
 * it is the shape CLAUDE.md calls "a probe that measures the OPPORTUNITY does not measure the
 * FIX", and the fix is to quote the signal the code reads.
 *
 * THE VALUE IS THE WRECK BEAT, `WRECK_HOLD_S` in district/main.js, and that is a derivation rather
 * than a coincidence: both are "the game has taken control and is about to fade you out and hand
 * the car back", and a retune of one has to move the other or the two consequences stop feeling
 * like the same game. 4.0 s is 20.0x the unavoidable floor and 1.75x a deliberate 2 s stop.
 * district/main.js reads this constant for both, so there is one number and not two.
 *
 * THE CLOCK IS NOT THE WHOLE RULE. It runs only while the host says a unit is HOLDING you — see
 * `player.held` in `update` — so a player who can drive away is never busted, and the out is
 * always the throttle.
 *
 * AND THE STANDSTILL BUDGET IS LESS THAN 4.0 s, because the clock starts while the car is still
 * rolling: `playerVel` is a smoothed position difference and it crosses `SCENE_STOP_MS` on the way
 * DOWN, before the car is at rest. A blind playtester reported the budget as 3.65 s and read the
 * clock at 1.35 of 4 after one second of standstill. Re-measured here — approach at 8 m/s, brake
 * at 11 m/s2, sit, leave — it reads 0.90 after 1 s and needs about 4.0 s of standstill to fire,
 * so their MECHANISM is right and their CONSTANT is one braking profile's: how much of the clock a
 * stop buys depends on how long the tail of the deceleration spends under 1.0 m/s, which a gentler
 * stop lengthens. There is no single number to write down, which is why the derivation above is
 * against the 0.68 s floor — a quantity that does not depend on the approach.
 */
export const BUST_HOLD_S = 4.0;

export const RESPONSE = Object.freeze([
  Object.freeze({ units: 0, spawnMin: 0,   spawnMax: 0,   giveUpRadius: 0,   speedMul: 0,    intercept: false, aggression: 0.00, cooldown: 0,  searchGrow: 0,  spotRadius: 0,   siren: 0.00 }),
  Object.freeze({ units: 1, spawnMin: 80,  spawnMax: 190, giveUpRadius: 380, speedMul: 0.94, intercept: false, aggression: 0.15, cooldown: 12, searchGrow: 7,  spotRadius: 85,  siren: 0.35 }),
  Object.freeze({ units: 2, spawnMin: 90,  spawnMax: 240, giveUpRadius: 460, speedMul: 1.00, intercept: false, aggression: 0.32, cooldown: 18, searchGrow: 9,  spotRadius: 105, siren: 0.55 }),
  Object.freeze({ units: 4, spawnMin: 110, spawnMax: 310, giveUpRadius: 560, speedMul: 1.08, intercept: true,  aggression: 0.52, cooldown: 26, searchGrow: 12, spotRadius: 125, siren: 0.72 }),
  Object.freeze({ units: 6, spawnMin: 130, spawnMax: 390, giveUpRadius: 700, speedMul: 1.16, intercept: true,  aggression: 0.74, cooldown: 34, searchGrow: 15, spotRadius: 150, siren: 0.87 }),
  Object.freeze({ units: 8, spawnMin: 150, spawnMax: 470, giveUpRadius: 860, speedMul: 1.26, intercept: true,  aggression: 1.00, cooldown: 44, searchGrow: 18, spotRadius: 175, siren: 1.00 }),
]);

/**
 * THE CEILING FOR A CRIME THAT HAS NO FLOOR OF ITS OWN, and it is the table's own lowest floor.
 *
 * `min` is a floor on heat: it says "this crime is at least N stars". Several crimes have none —
 * `propertyDamage`, `civilianCollision`, `reckless` — which is the table saying they are not, on
 * their own, enough to make you wanted. But `opts.scale` had no ceiling, and `damage.js` scales a
 * delta-v crime by `severity / majorSeverity`, which reaches 8.33x. Measured, on a clean record:
 *
 *     km/h   a wall                      a civilian car
 *       20   0.48 heat, 0 stars          0.80 heat, 0 stars
 *       40   2.10 heat, 2 stars          3.50 heat, 3 stars
 *       60   2.50 heat, 2 stars          4.17 heat, **4 STARS**
 *      110   2.50 heat, 2 stars          4.17 heat, 4 stars
 *
 * against a pedestrian struck at any survivable speed: 1.00 heat, ONE star. So ramming another car
 * was four times the offence of hitting a person, and a wall twice — from two crimes the table
 * ranks below every floored one. A round-5 playtester reported the wall half; the car half is
 * larger and nobody had looked.
 *
 * The rule is the table's own ordering, not a number: a crime with no floor may not charge more
 * than the LOWEST FLOOR there is, which is 1 — the least a struck person can cost. Crimes WITH a
 * floor are untouched, because their floor already ranks them above: `officerDown` still blows
 * through to five stars, which is the point of having one.
 *
 * It composes. The cap is on ONE crime's contribution, not on the total, so five wall strikes still
 * stack to five heat; what cannot happen is one of them outranking a casualty.
 */
const FLOORLESS_CAP = Math.min(...Object.values(CRIMES)
  .map((c) => c.min ?? 0).filter((m) => m > 0));

/**
 * AND THE CAP IS A SOFT KNEE, NOT A CLIP, BECAUSE A CLIP IS THE ONE SATURATION THAT TIES.
 *
 * `Math.min(raw, cap)` kept the ordering #80 was about and bought a new defect in the same line:
 * every floorless crime became FLAT from the severity at which `heat * scale` first reaches the
 * cap up to the top of its range. An 88 km/h head-on into an occupied car charged 1.0000 and the
 * same crime at a quarter of that severity charged 0.9854 — 0.0146 apart, which no player can
 * read. The complaint is that severity stops mattering, and a clip is what makes it stop.
 *
 * THE SHAPE IS DERIVED, NOT PICKED. A saturation that is C1 at its knee, strictly increasing
 * everywhere, and asymptotic to the cap is
 *
 *     out = cap - (cap - k)^2 / (raw + cap - 2k)        for raw > k
 *
 * and at k = cap/2 the `cap - 2k` term vanishes, leaving `cap - (cap/2)^2 / raw`. Both halves of
 * "derived" are checkable and `tools/wanted-test.mjs` checks them: the two branches meet at
 * raw = k with value k AND with slope 1 — the upper branch's derivative is (cap^2/4)/raw^2, which
 * is exactly 1 at raw = cap/2 — so there is no corner to tune and nothing to fudge.
 *
 * WHAT IT CHANGES, AND WHAT IT CANNOT. The knee is strictly monotonic, so no two severities ever
 * charge the same, and on the pair above it separates them 0.1937 against the clip's 0.0146 —
 * x13.3. Below k nothing moves at all, so the low-speed scrum that produced #87's 13
 * civilianCollisions in 200 m is untouched.
 *
 * It does NOT flatten any less above 44.5 km/h, and that is a SECOND saturation this cap was
 * being blamed for. `crimeScale` is `severity / majorSeverity` and `severityFor` clamps severity
 * at 1 when the delta-v reaches `killDv` — the right rule for DAMAGE, since one hit cannot cost
 * more than the whole car — so the scale itself reads 8.333 at 50, 60, 80, 110 and 140 km/h. No
 * shape of cap can distinguish inputs that are already identical. Measured, with one term moved
 * at a time:
 *
 *     a wall           the knee bends at 20.5 km/h   the clip flattened from 28.5   scale flat from 44.5
 *     a civilian car   the knee bends at 16.5 km/h   the clip flattened from 22.5   scale flat from 44.5
 *
 * So this fixes the band between the cap and the scale's own ceiling — 16 km/h wide for a wall and
 * 22 for a car, which is where ordinary street driving lives — and the flatness above 44.5 km/h
 * belongs to `severityFor`'s clamp in src/damage.js, which is a different lever and a different
 * argument.
 *
 * It still composes: the cap is on ONE crime's contribution, so repeats stack.
 */
export const FLOORLESS_KNEE = FLOORLESS_CAP / 2;

/**
 * The charge a floorless crime actually contributes. Exported so the gate can walk the curve
 * without constructing crimes, which is why `severityFor` is exported from src/damage.js too.
 *
 * A non-finite `raw` is returned unchanged rather than smoothed, because the only honest thing to
 * do with a number that is not one is to let the caller's guard see it; `reportCrime` refuses it
 * before this is reached.
 */
export function floorlessCharge(raw, cap = FLOORLESS_CAP) {
  if (!(raw > cap / 2)) return raw;
  return cap - (cap * cap / 4) / raw;
}

// One star's `spotRadius` IS the leave radius: see `_watchScene`. Taken from the table rather
// than written twice, so a retune of the response moves both together.
SCENE_LEAVE_M = RESPONSE[1].spotRadius;

// Deterministic PRNG. The search ring needs a little per-unit jitter so eight
// cars do not fan out in a perfect snowflake, but "a little jitter" must not
// mean "this test passes four runs in five".
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class WantedSystem {
  constructor(opts = {}) {
    this.maxStars = opts.maxStars ?? 5;
    this.response = opts.response ?? RESPONSE;

    // Scale hooks for the harness: the chase harness wants a fixed worst-case
    // fleet, a mission may want the response suppressed entirely.
    this.unitScale = opts.unitScale ?? 1;
    this.maxUnits = opts.maxUnits ?? 8;

    this.searchRadius0 = opts.searchRadius ?? 45;    // metres, the moment contact breaks
    this.sweepRate = opts.sweepRate ?? 0.22;         // rad/s the search ring rotates
    this.witnessSeconds = opts.witnessSeconds ?? 6;  // a reported crime holds contact this long
    this.idleBleed = opts.idleBleed ?? 0.09;         // heat/s shed below one star
    this.idleGrace = opts.idleGrace ?? 2.5;          // ...after this long with no new crime
    this.coolBleed = opts.coolBleed ?? 0.5;          // s/s the crime-added patience burns off
    this.maxCool = opts.maxCool ?? 45;               // cap, or a rampage is inescapable
    this.leadSeconds = opts.leadSeconds ?? 2.6;      // how far ahead interceptors aim
    this.maxLead = opts.maxLead ?? 90;               // metres
    this.maxDt = opts.maxDt ?? 0.25;                 // one hitch must not fast-forward an escape

    // Injected by the game so this module never needs a scene to answer "can
    // that officer see the player?". Default true, which reduces contact to pure
    // proximity — correct for a node test and for the 2D lab.
    this.losTest = opts.lineOfSight ?? null;

    this._rng = mulberry32(opts.seed ?? 0x5eed17);
    this._listeners = new Map();
    this._crimeAt = new Map();      // crime id -> time it last counted (refractory)

    this.time = 0;
    this.heat = 0;
    this.stars = 0;
    this.state = STATES.CLEAR;
    this.cool = 0;                  // crime-added seconds on top of the base cooldown
    this.evadeTimer = 0;
    this.searchRadius = this.searchRadius0;
    this.seen = false;
    this.stateSince = 0;
    this._forcedSightUntil = -1;
    this._lastCrimeAt = -1e9;
    /**
     * The last crime that was actually FILED, for `hudState()`. Nothing in the game said a word
     * when an offence landed: a playtester drove off from a pedestrian at 40 km/h, watched heat go
     * 1.00 -> 1.80 and `hitAndRun` file itself 4.61 s later, and not one field of the HUD changed.
     * Kept here rather than in a host because the module that knows a crime happened is the one
     * that should be able to say so, and because both hosts would otherwise time it themselves.
     */
    this._notice = null;
    this._sweep = 0;
    this._nextUnitId = 0;
    this._prevPlayer = null;
    /**
     * HOW LONG A UNIT HAS BEEN HOLDING THE PLAYER STOPPED, in seconds, and 0 whenever it is not.
     * Read by `hudState` so the player can watch it run; see `_watchBust`.
     */
    this.bustFor = 0;

    /**
     * DID THE PLAYER STOP AT THE SCENE AND NOTHING HAPPEN SINCE. Carried on the `busted` event so
     * a host can price an arrest differently for a driver who cooperated; see `_watchScene`.
     *
     * It outlives the scene object itself, because the scene is discharged the moment you stop and
     * the police take another ten seconds to arrive — so the fact has to survive it. Cleared by
     * any SUBSEQUENT crime, which is the honest bound: you stopped, and then you did something
     * else. Not on a timer, because "nothing has happened since" is the claim and a clock would be
     * a number nobody derived.
     */
    this.cooperated = false;

    /**
     * HOW THE LEVEL LAST REACHED ZERO: 'escaped' for the decay path, otherwise the reason the
     * caller gave — 'busted' for an arrest, 'cleared' / a mission's own word for a script. Null
     * while wanted.
     *
     * IT EXISTS BECAUSE `evaded` COULD NOT TELL BEING CAUGHT FROM GETTING AWAY. `src/mission.js`'s
     * trigger tested `wantedStars <= 0 && wantedState === 'clear'`, and `clear('busted')` sets
     * both — so an ARREST satisfied "you got away". A blind playtester found the consequence from
     * the outside on the flagship's chase stage, whose exit is `all[timer 2, evaded]`: committing
     * a crime and letting the police take you flipped the stage in the SAME FRAME as the bust,
     * and because a cooperating arrest does not abort the job and hands the car back repaired,
     * the chase was won 4-14x faster that way than by obeying the HUD — 13.6 s against 55-190 s
     * over five seeds, 4 of 4 arms against 3 of 5.
     *
     * The information was already here and the trigger ignored it: `_applyStars` has always
     * emitted `clear` with the reason, and `stats.escapes` has always counted the decay path
     * alone. So this is not a new concept, it is the existing one given a name a consumer can
     * read.
     */
    this.clearedBy = null;
    /** Has the throttle been open during the current hold. See `_watchBust`. */
    this._bustThrottle = false;

    /** The scene of the last injury, until the player stops at it or leaves it. See _watchScene. */
    this._scene = null;
    // Reused in place so sanitising costs no per-frame allocation.
    this._safePlayer = { x: 0, z: 0, seen: undefined };
    this.playerVel = { x: 0, z: 0 };

    this.lastKnown = { x: 0, z: 0, t: 0, valid: false };
    this.units = [];

    this.stats = {
      crimes: 0, crimesIgnored: 0, escalations: 0, decays: 0,
      // A caller passed a scale that is not a finite non-negative number and was charged the
      // table value instead. Counted rather than thrown, and visible rather than silent: see
      // `reportCrime`, where a NaN scale used to make `heat` NaN for the rest of the session.
      badScales: 0,
      searches: 0, reacquires: 0, escapes: 0, unitsRequested: 0,
      unitsLost: 0, listenerErrors: 0, updates: 0,
      // The scene of an injury: armed on a `scene: true` crime, discharged by stopping, charged
      // as `hitAndRun` by leaving. See _watchScene.
      // `scenesDischarged` beside `scenesStopped` because the two are different events now:
      // a scene is stopped at once and discharged LAW_NOTICE_S later, and a build where the
      // second never happens reads as a held band rather than as a missing counter.
      scenesArmed: 0, scenesStopped: 0, scenesDischarged: 0, scenesFled: 0,
      // Busted: the host held you stopped for BUST_HOLD_S. See `_watchBust`.
      busts: 0, bustHolds: 0,
      // Frames the host declared a teleport. See `_trackVelocity`: a host that never declares one
      // is a host where stepping out of the car is immunity, so 0 here is worth seeing.
      teleports: 0,
    };

    // One stable object, mutated in place: consumers hold a reference and read
    // it every frame rather than allocating a plan per frame.
    this.plan = {
      stars: 0, state: STATES.CLEAR, seen: false,
      target: { x: 0, z: 0 },
      lastKnown: this.lastKnown,
      searchRadius: this.searchRadius0,
      evade: { timer: 0, required: 0, progress: 0 },
      units: 0, spawnMin: 0, spawnMax: 0, giveUpRadius: 0,
      speedMul: 0, intercept: false, aggression: 0, siren: 0,
      assignments: [],
    };
  }

  // ------------------------------------------------------------ subscriptions
  /** @returns {function} an unsubscribe thunk, so callers never need `off`. */
  on(event, fn) {
    if (!this._listeners.has(event)) this._listeners.set(event, new Set());
    this._listeners.get(event).add(fn);
    return () => this.off(event, fn);
  }

  off(event, fn) { this._listeners.get(event)?.delete(fn); return this; }

  once(event, fn) {
    const stop = this.on(event, (p) => { stop(); fn(p); });
    return stop;
  }

  // A throwing HUD listener must not be able to stop the police. Errors are
  // counted and handed to an optional sink rather than unwinding the update.
  emit(event, payload) {
    const fire = (fn, args) => {
      try { fn(...args); } catch (err) {
        this.stats.listenerErrors++;
        if (this.onListenerError) this.onListenerError(err, event, payload);
      }
    };
    const set = this._listeners.get(event);
    if (set) for (const fn of [...set]) fire(fn, [payload]);
    const all = this._listeners.get('*');
    if (all) for (const fn of [...all]) fire(fn, [event, payload]);
    return this;
  }

  /** fn(unit:{x,z}, player:{x,z}) -> boolean. Set null to fall back to proximity. */
  setLineOfSight(fn) { this.losTest = fn; return this; }

  // ------------------------------------------------------------ crime input
  /**
   * Report a crime. `opts.at` is where it happened (defaults to the player's
   * last known-good position), `opts.witnessed` false for something nobody saw —
   * it still raises the meter but does not hand the police a fresh fix.
   * `opts.scale` multiplies the star delta (a 90 km/h impact is not a 10 km/h one).
   */
  reportCrime(id, opts = {}) {
    const c = CRIMES[id];
    if (!c) throw new Error(`unknown crime: ${id}`);
    const at = opts.at ?? (this.lastKnown.valid ? { x: this.lastKnown.x, z: this.lastKnown.z } : null);

    const ignore = (reason) => {
      this.stats.crimesIgnored++;
      const p = { id, label: c.label, applied: false, reason, heat: this.heat, stars: this.stars, at };
      this.emit('crime', p);
      return p;
    };
    if (c.requiresWanted && this.stars === 0) return ignore('no-wanted-level');
    const last = this._crimeAt.get(id);
    if (last !== undefined && this.time - last < c.refractory) return ignore('refractory');
    this._crimeAt.set(id, this.time);
    /**
     * AND A NEW OFFENCE ENDS THE COOPERATION, which is what bounds that flag: stopping at the
     * scene protects the job from an arrest, and doing something else afterwards does not.
     * `hitAndRun` cannot reach this line while `cooperated` is true — `_watchScene` only files it
     * for a scene that was NOT discharged — so there is no self-cancelling case here.
     */
    this.cooperated = false;

    const prev = this.stars;
    /**
     * A MALFORMED SCALE IS REFUSED, not multiplied. `opts.scale` had no validation and every
     * caller in the tree happens to pass a finite non-negative number, so this was a hole rather
     * than a bug — but the hole is the worst-shaped one there is. Measured, before the guard:
     *
     *     scale NaN        heat NaN,  stars 0   and PERMANENT: every comparison against NaN is
     *                                           false, so the level never rises again
     *     scale -1         heat 0,    stars 0   a crime that makes you less wanted
     *     scale Infinity   heat 1,    stars 1   survived only because the cap clipped it
     *
     * The NaN row is CLAUDE.md's "non-finite delta-v, and the immortality it buys" arriving
     * through the other door: `health < 0.2` is false for NaN and so is `heat >= 1`, so the wrong
     * answer is the reassuring one and nothing errors.
     *
     * CHARGED AT THE TABLE VALUE rather than ignored, because a malformed scale is a CALLER bug
     * and not a rule: the crime happened, and the only thing in doubt is how bad it was. The
     * `ignore()` path above is for rules a player can satisfy — no wanted level, refractory — and
     * putting a programming error on it would make a typo look like gameplay. Counted, so it is
     * visible rather than silent.
     */
    let scale = opts.scale ?? 1;
    if (!(Number.isFinite(scale) && scale >= 0)) {
      this.stats.badScales++;
      scale = 1;
    }
    // See FLOORLESS_CAP: a crime the table gives no floor may not out-charge the lowest floor there
    // is, and the cap is a soft knee so that severity never stops mattering. One crime's
    // contribution is capped, not the running total, so repeats still stack.
    const raw = c.heat * scale;
    const delta = (c.min ?? 0) > 0 ? raw : floorlessCharge(raw);
    this.heat = Math.min(Math.max(this.heat + delta, c.min), this.maxStars + 0.99);
    this.cool = Math.min(this.cool + c.cool, this.maxCool);
    this._lastCrimeAt = this.time;
    // No star count here: `_applyStars` has not run yet, so `this.stars` is still the PRE-crime
    // value at this point. `hudState()` reads the live one.
    this._notice = { id, label: c.label, t: this.time };
    this.stats.crimes++;

    // The scene of the crime is information whoever reported it has, so it
    // anchors the search either way. What being WITNESSED adds is a fresh fix:
    // dispatch tracks you for a few seconds even before a car is near, which is
    // what stops a lone crime from dropping straight into `search` with the
    // escape clock already running.
    if (at) this._setLastKnown(at.x, at.z);
    if (opts.witnessed !== false) this._forcedSightUntil = this.time + this.witnessSeconds;

    /**
     * ARM THE SCENE. `hitAndRun` has existed in this table since the day it was written and nothing
     * in the game ever filed it — one of ten such crimes, and the only one whose every input was
     * already here: the scene comes in as `at`, the player's position arrives every `update`, and
     * `playerVel` is already smoothed for the interceptors. See `_watchScene`.
     *
     * A fresh scene replaces an older one rather than queueing. Two victims in four seconds is one
     * event a driver either stops for or does not, and a queue would charge them twice for the same
     * decision.
     */
    if (c.scene && at && Number.isFinite(at.x) && Number.isFinite(at.z)) {
      // `d` is the player's distance from the scene, refreshed every `_watchScene`. It starts at
      // 0 because the player IS at the scene at the instant the crime is filed, and it is stored
      // here rather than recomputed by the HUD so that the number on screen is the same one the
      // rule is deciding on. A second copy of that arithmetic is how the two would drift apart.
      this._scene = { x: at.x, z: at.z, at: this.time, stopped: false,
        // When the player stopped, so the acknowledgement can time out instead of holding
        // the objective band for ever. See `_watchScene`.
        stoppedAt: 0, id, d: 0 };
      this.stats.scenesArmed++;
    }

    const payload = { id, label: c.label, applied: true, heat: this.heat, stars: this.stars, at };
    this._applyStars(prev, 'crime');
    payload.stars = this.stars;
    this.emit('crime', payload);
    return payload;
  }

  /** Convenience for a frame that produced several crimes at once. */
  reportCrimes(ids, opts = {}) { return ids.map((id) => this.reportCrime(id, opts)); }

  // ------------------------------------------------------------ unit input
  /** The pursuit layer tells us where the car it spawned for `id` actually is. */
  reportUnit(id, x, z) {
    const u = this.units.find((v) => v.id === id);
    if (!u) return false;            // stale id from a released unit; ignore
    u.pos = u.pos ?? { x: 0, z: 0 };
    u.pos.x = x; u.pos.z = z;
    return true;
  }

  reportUnits(list) {
    for (const u of list) {
      if (u.position) this.reportUnit(u.id, u.position.x, u.position.z);
      else this.reportUnit(u.id, u.x, u.z);
    }
    return this;
  }

  /** "They just saw you" — a patrol drove past, a camera caught you. */
  forceContact(at = null, seconds = this.witnessSeconds) {
    if (at) this._setLastKnown(at.x, at.z);
    this._forcedSightUntil = Math.max(this._forcedSightUntil, this.time + seconds);
    return this;
  }

  // ------------------------------------------------------------ level control
  /** Mission scripting / cheats. Bypasses crimes entirely. */
  setStars(n, reason = 'set') {
    const prev = this.stars;
    this.heat = clamp(Math.round(n), 0, this.maxStars);
    this._applyStars(prev, reason);
    return this.stars;
  }

  /** Busted, wasted, mission over. Everything resets and every unit is released. */
  clear(reason = 'cleared') {
    const prev = this.stars;
    this.cooperated = false;
    this.heat = 0;
    this.cool = 0;
    this.evadeTimer = 0;
    this._forcedSightUntil = -1;
    this._crimeAt.clear();
    this._applyStars(prev, reason);
    return this;
  }

  // ------------------------------------------------------------ the tick
  /**
   * `player` is {x, z} and may carry `seen` to override contact detection —
   * that is the hook for the game's real occlusion test, which this module must
   * not own. Omit it and contact is decided by unit proximity plus `losTest`.
   */
  update(dt, player) {
    // Clamp for the same reason hud.js clamps: one 900 ms hitch must not hand
    // the player most of an escape.
    const step = clamp(dt, 0, this.maxDt);
    this.time += step;
    this.stats.updates++;

    // A non-finite coordinate must not reach the search anchor, the plan or the
    // unit goals downstream of it; bad values hold the last good ones.
    player = this._sanitize(player);

    this._trackVelocity(step, player);
    this._watchScene(player);
    /**
     * Before contact is evaluated, because a bust clears the level and everything below this line
     * is about a level that still exists. It deliberately does NOT return early: with `stars` now
     * 0 the rest of this function writes the cleared plan, where an early return would leave the
     * pursuit bridge reading last frame's target for a frame — eight cars still converging on a
     * player who has just been arrested.
     */
    this._watchBust(step, player);

    const seen = this._evaluateContact(player);
    if (seen !== this.seen) {
      this.seen = seen;
      this.emit('contact', { seen, at: { x: player.x, z: player.z } });
    }

    if (this.stars > 0) {
      if (seen) {
        // In contact the police always know where you are, so the search anchor
        // rides with the player and the escape clock is pinned at zero.
        this._setLastKnown(player.x, player.z);
        if (this.state !== STATES.ACTIVE) {
          if (this.state === STATES.SEARCH) this.stats.reacquires++;
          this._setState(STATES.ACTIVE);
        }
        this.evadeTimer = 0;
        this.searchRadius = this.searchRadius0;
      } else {
        if (this.state !== STATES.SEARCH) {
          // Freeze the anchor at the last position contact was held. Converging
          // on the LAST KNOWN POSITION and searching outward is the whole point:
          // units must never be handed the player's live position here. An
          // unwitnessed crime can reach this branch with no anchor at all, and
          // without this line the search would silently degrade into exactly the
          // teleport-to-the-player behaviour the state exists to prevent.
          if (!this.lastKnown.valid) this._setLastKnown(player.x, player.z);
          this._setState(STATES.SEARCH);
          this.stats.searches++;
          this.evadeTimer = 0;
          this.searchRadius = this.searchRadius0;
        }
        this.evadeTimer += step;
        this.cool = Math.max(0, this.cool - this.coolBleed * step);
        const tune = this.tune();
        this.searchRadius = Math.min(
          tune.giveUpRadius,
          this.searchRadius0 + tune.searchGrow * this.evadeTimer
        );
        if (this.evadeTimer >= this.evadeRequired()) this._decayOneStar();
      }
    } else {
      // Below one star the meter bleeds off, so twenty minutes of merely bad
      // driving does not eventually add up to a felony.
      if (this.heat > 0 && this.time - this._lastCrimeAt > this.idleGrace) {
        this.heat = Math.max(0, this.heat - this.idleBleed * step);
      }
      if (this.state !== STATES.CLEAR) this._setState(STATES.CLEAR);
    }

    this._sweep = (this._sweep + this.sweepRate * step) % TAU;
    this._syncUnits(player);
    this._writePlan(player);
    return this.plan;
  }

  // ------------------------------------------------------------ derived state
  tune() { return this.response[clamp(this.stars, 0, this.response.length - 1)]; }

  /** Seconds out of contact still needed to shed the next star. */
  evadeRequired() { return this.stars > 0 ? this.tune().cooldown + this.cool : 0; }

  get evadeProgress() {
    const req = this.evadeRequired();
    return req > 0 ? clamp(this.evadeTimer / req, 0, 1) : 0;
  }

  get searching() { return this.state === STATES.SEARCH; }

  /**
   * True while a witnessed crime is still handing dispatch a live fix, i.e.
   * contact is being held by the report rather than by anyone's eyes. The HUD
   * wants this to explain why the meter is not flashing yet.
   */
  get hasFreshFix() { return this.time < this._forcedSightUntil; }

  /**
   * EVERYTHING THE PLAYER IS ALLOWED TO KNOW ABOUT THE LAW, as a plain snapshot.
   *
   * Two playtesters reported the same hole from opposite ends. Over a whole 96 s escape from four
   * stars the only field of the HUD that ever differed was the star COUNT: the shed times are
   * 40/66/84/96 s, the rule is good, and nothing expressed it. And a hit-and-run filed itself
   * 85.6 m and 4.61 s after the impact with the band still reading "DRIVE EAST ALONG MARLIN
   * STREET" — the one mechanic in the game with a 3.6 km/h threshold and an 85 m deadline, and no
   * way to learn either from playing.
   *
   * This exists as a snapshot rather than as six getters because the two composers below have to
   * be pure functions over numbers a test can write down. `composeBand` was moved out of
   * district/main.js for exactly that reason and the move found four of its five tenants missing
   * from the harness; presentation state assembled inside a host is presentation state nothing
   * can walk.
   *
   * Allocates: one object per call, called once a frame by each host. The plan object next door
   * is mutated in place because it is read every frame by the pursuit bridge AND held across
   * frames; this is read and discarded inside the same frame, and a reused one would alias
   * between the two hosts in the harness, where one process runs both.
   */
  hudState() {
    const sc = this._scene;
    const req = this.evadeRequired();
    return {
      stars: this.stars,
      state: this.state,
      // 0 at the moment contact is lost, 1 the instant before a star goes. In contact the timer
      // is pinned at zero by `update`, so this is 0 there and the meter reads full.
      evade: this.evadeProgress,
      remaining: this.stars > 0 ? Math.max(0, req - this.evadeTimer) : 0,
      hasFreshFix: this.hasFreshFix,
      units: this.units.length,
      scene: sc
        ? { x: sc.x, z: sc.z, stopped: sc.stopped, d: sc.d, leaveIn: Math.max(0, SCENE_LEAVE_M - sc.d) }
        : null,
      cooperated: this.cooperated,
      notice: this._notice ? { id: this._notice.id, label: this._notice.label,
        age: this.time - this._notice.t } : null,
      /**
       * SECONDS OF HOLD STILL TO SURVIVE, or null when nobody is holding you. A countdown rather
       * than the elapsed figure, because what the player needs is how long they have to get out,
       * and because `bustFor === 0` and "not held" are the same number and must not read as the
       * same state. See `_watchBust`.
       */
      bustIn: this.bustFor > 0 ? Math.max(0, BUST_HOLD_S - this.bustFor) : null,
      /**
       * TRUE WHILE THE PLAYER IS BEING HELD AND HAS ALREADY TRIED THE THROTTLE, which is what
       * turns "drive" into "reverse". See `_watchBust`.
       */
      bustStuck: this.bustFor > 0 && this._bustThrottle === true,
    };
  }

  // ------------------------------------------------------------ internals
  _sanitize(player) {
    const p = this._safePlayer;
    if (Number.isFinite(player.x)) p.x = player.x;
    if (Number.isFinite(player.z)) p.z = player.z;
    p.seen = player.seen;
    p.held = player.held === true;
    p.teleported = player.teleported === true;
    p.throttle = Number.isFinite(player.throttle) ? player.throttle : 0;
    return p;
  }

  /**
   * LEAVING THE SCENE OF AN INJURY IS A SECOND OFFENCE, and this is what files `hitAndRun`.
   *
   * Two thresholds, and only one of them is a choice:
   *
   * SCENE_LEAVE_M is `RESPONSE[1].spotRadius`, this module's own statement of how close a unit has
   * to be, with line of sight, to hold contact on the player. That is the game's existing
   * definition of "within sight", so leaving the scene is getting beyond where a witness could
   * still see you. It is read from the table rather than copied, so it moves with it.
   *
   * SCENE_STOP_MS is a choice, and is stated as one. It has to be below `damage.js`'s free
   * threshold of 2.2 m/s, or "stopped at the scene" and "still rolling fast enough for a contact
   * to cost nothing" would be the same reading; and above the velocity tracker's own floor, which
   * is exactly 0 for a stationary car because `_trackVelocity` smooths towards the true value.
   * 1.0 m/s sits between with margin at both ends, and `wanted-test` asserts the relation rather
   * than the number.
   *
   * Stopping anywhere inside the leave radius discharges it permanently for that scene: a driver
   * who stops, waits, and then drives off has stopped. Whether they should also have to STAY is a
   * design question this does not answer, and the honest reason is that there is nothing in the
   * codebase to anchor a dwell time to.
   *
   * AND THE SCENE ITSELF IS DISCHARGED `LAW_NOTICE_S` AFTER THAT, WHICH IT WAS NOT. The scene
   * stayed live until the player drove 85 m, and `composeLaw` returns a line for any live scene
   * while `src/hud.js`'s BAND_ORDER puts `law` above `mission` and `offer` — so stopping at the
   * scene took the objective band and never gave it back. Measured, 600 s parked at a scene with
   * a live mission:
   *
   *     band from `law`      600.0 s   100.0%
   *     band from `mission`    0.0 s
   *     band from `offer`      0.0 s
   *     distinct lines over the whole 600 s: 1
   *
   * One clipped pedestrian plus a stop hid the mission objective, the completion line and every
   * job offer until the player drove 85 m. A blind playtester found it twice — once at 600 s
   * beside a job marker 30 m away, once holding for 360 s at five stars with no mission at all.
   *
   * `LAW_NOTICE_S` RATHER THAN A NEW NUMBER, because that is already this file's answer to "how
   * long does a law line stay on screen after the thing it reports" — matched to src/hud.js's
   * `escalateSeconds` so the words and the star alarm stop together, with `tools/hud-cue.mjs`
   * asserting the two are equal. "STOPPED AT THE SCENE" is a notice of a fact, so it behaves
   * like every other notice in the file instead of being the one that never leaves.
   *
   * NOTHING ABOUT THE CRIME CHANGES, and that is what makes this safe to isolate. `cooperated`
   * is latched on the same frame and its own comment already says it outlives `sc`, because the
   * police arrive after the scene is gone; and the branch below only files `hitAndRun` when
   * `!sc.stopped`, so a scene that was stopped at never filed one whether it lived four seconds
   * or four hundred. The only thing the extra 596 s bought was a band nobody else could use.
   */
  _watchScene(player) {
    const sc = this._scene;
    if (!sc) return;
    const d = Math.hypot(player.x - sc.x, player.z - sc.z);
    sc.d = d;
    if (d <= SCENE_LEAVE_M) {
      if (Math.hypot(this.playerVel.x, this.playerVel.z) < SCENE_STOP_MS) {
        if (!sc.stopped) {
          sc.stopped = true;
          sc.stoppedAt = this.time;
          this.stats.scenesStopped++;
          // See `cooperated`: this outlives `sc`, because the police arrive after it is gone.
          this.cooperated = true;
          this.emit('cooperated', { at: { x: sc.x, z: sc.z } });
        }
      }
      // The acknowledgement has been read by now. `cooperated` carries the consequence on.
      if (sc.stopped && this.time - sc.stoppedAt >= LAW_NOTICE_S) {
        this._scene = null;
        this.stats.scenesDischarged++;
      }
      return;
    }
    // Beyond witness range. Either they stopped and this is over, or it is an offence.
    this._scene = null;
    if (sc.stopped) return;
    this.stats.scenesFled++;
    // Reported at the SCENE, not where the car is now: that is where the search should anchor,
    // and it is the only position a witness could give.
    this.reportCrime('hitAndRun', { at: { x: sc.x, z: sc.z } });
  }

  /**
   * BEING CAUGHT. `player.held` is the HOST's verdict that a unit has pulled up on the player and
   * stopped there, for exactly the reason `player.seen` is the host's verdict on line of sight:
   * this module owns the consequence and must not own the geometry. src/pursuit.js decides it from
   * its own `reachRadius` and district/main.js checks that unit against the player rather than
   * against the pursuit target — which are the same point in contact and 300 m apart during a
   * search.
   *
   * THAT RADIUS IS AN OFFICER'S AND NOT A CAR'S, and it is derived from `BUST_HOLD_S` below:
   * `RUN_SPEED * BUST_HOLD_S` = 28 m, the distance a person covers while this clock runs. It was
   * `holdRadius` — half the widest edge plus the car's half-length, 8.75 m — so the arrest was a
   * function of how far the PLAYER was from a road, and stopping 15.6 m off a centreline at four
   * stars was 180.5 s on the brake with 0 busts. (Before that it read 7.15, because the
   * derivation was using `e.r`, a CLASS RANK, as a width.) src/pursuit.js's `reachRadius` carries
   * the measurement; what matters here is that the dwell this clock requires is half of it.
   *
   * THE SPEED TEST IS `_watchScene`'s, not a second threshold. "Stopped" already has a definition
   * in this file and a derivation above it; a bust that used its own number would drift from it.
   *
   * THE CLOCK RESETS RATHER THAN DECAYS. A player who inches forward out of the hold has got away,
   * and a decaying clock would let four separate one-second stops add up to a bust — which is not
   * "a unit held you", it is bookkeeping. `bustHolds` counts how often the clock started, so a
   * rule that arms constantly and never fires is visible instead of silent.
   *
   * A HOST THAT NEVER SETS `held` NEVER BUSTS ANYBODY, which is the failure this round exists to
   * avoid, so it is reported rather than left to be discovered: `stats.bustHolds` counts how often
   * the clock has ARMED, against `stats.busts` for how often it fired, and district/main.js lists
   * `held` in `wantedReport().notHonoured` when the pursuit layer under it exposes no `holdRadius`.
   * A rule that never arms reads as `bustHolds: 0` instead of as silence.
   */
  /**
   * IS THE PLAYER MOVING AWAY FROM WHOEVER IS HOLDING THEM, as opposed to merely moving.
   *
   * Returns null when no unit has reported a position, so a host that does not feed them behaves
   * exactly as before — the fallback is asserted in `wanted-test`, because a predicate that
   * silently answers "yes" for a host with no data would turn the fix into a free pass.
   *
   * The radial component is tested against `SCENE_STOP_MS`, the same threshold the speed test
   * uses, so this introduces NO new constant: the question changes from "are you moving" to "are
   * you moving away", and the number stays where it was derived.
   */
  _recedingFrom(player) {
    let best = Infinity, bx = 0, bz = 0;
    for (const u of this.units) {
      if (!u.pos) continue;
      const dx = player.x - u.pos.x, dz = player.z - u.pos.z;
      const d = Math.hypot(dx, dz);
      if (d < best) { best = d; bx = dx; bz = dz; }
    }
    if (!Number.isFinite(best) || best <= 0) return null;
    // The component of the SMOOTHED velocity along the unit-to-player direction. Positive is away.
    const out = (this.playerVel.x * bx + this.playerVel.z * bz) / best;
    return out >= SCENE_STOP_MS;
  }

  _watchBust(dt, player) {
    /**
     * MOVING DOES NOT RESET THE CLOCK UNLESS YOU ARE MOVING AWAY.
     *
     * The reset was a speed test alone, and a speed test cannot tell the two cases apart that
     * matter here. A blind playtester found the gap by driving a circle: four stars, **2.7 m off a
     * road** — the spot that arrests a parked car in 9.6 s — on a 25 m circle so the position was
     * held within 50 m:
     *
     *     mean  2.8 km/h                               ARRESTED 3 of 3  (9.6 / 9.5 / 6.8 s)
     *     mean  4.8, 5.8, 6.7, 8.6, 12.4, 19.9 km/h    0 of 3, free the full 150 s
     *
     * Walking pace, without leaving the block, beat the whole pursuit — and none of those arms
     * escaped either, so it was a second stalemate rather than an out.
     *
     * I TRIED THE OBVIOUS DERIVATION FIRST AND THE MODULE'S OWN FLOOR REFUTED IT. An arrest is
     * made by a person, and `src/pursuit.js` builds `reachRadius = RUN_SPEED * BUST_HOLD_S` from
     * that, so testing the speed against `RUN_SPEED` (7.0 m/s) looked self-consistent — and it
     * closed the exploit cleanly, 6.5 m/s arrested and 7.5 m/s free. But the floor this clock is
     * derived against moves with the threshold, measured by feeding `src/vehicle.js`'s own
     * positions through this module:
     *
     *     contiguous seconds under the threshold    under 1.0 m/s    under 7.0 m/s
     *       brake to rest, then full throttle        0.18 - 0.25      2.17 - 2.24
     *       with a deliberate 2 s pause                     2.28             4.25
     *
     * `BUST_HOLD_S` is 4.0 s, so a deliberate two-second pause goes from x1.75 of margin to
     * **x0.94** — the clock stops outlasting it, which is a rule that section states in as many
     * words. Fixing that by growing the clock moves `WRECK_HOLD_S` and the garage dwell with it,
     * because they are deliberately one beat.
     *
     * SO THE SPEED WAS THE WRONG QUANTITY, not the wrong number. What separates circling from
     * pulling away is the SIGN, and the sign costs nothing: the reset now needs the player to be
     * moving AND receding, both against the threshold already derived. Every figure above is
     * untouched — a two-second pause is still spent under 1.0 m/s, so it still buys 2.28 s of a
     * 4.0 s clock — and the circle, which recedes from nobody, no longer resets anything.
     *
     * It is also right in a case neither version covered: driving at speed TOWARDS the officer
     * holding you is not an escape, and used to reset the clock every frame.
     */
    const moving = Math.hypot(this.playerVel.x, this.playerVel.z) >= SCENE_STOP_MS;
    const away = this._recedingFrom(player);
    // `away === null` is "no unit has told us where it is", and then this falls back to the speed
    // test alone, which is what it always was.
    if (this.stars <= 0 || !player.held || (moving && (away ?? true))) {
      this.bustFor = 0;
      this._bustThrottle = false;
      return false;
    }
    if (this.bustFor === 0) { this.stats.bustHolds++; this._bustThrottle = false; }
    /**
     * HAS THE PLAYER ALREADY TRIED TO DRIVE OUT OF THIS. If the throttle has been open at any
     * point during the hold and the car is still under the stop threshold, "drive" is advice they
     * are already following — so the verb becomes "reverse", which is the only out left.
     *
     * A blind playtester nosed into a building at full throttle and was arrested at 9.3 / 13.0 /
     * 19.5 s in 3 of 4 spots, holding throttle 1.0 at 0.07-0.25 km/h, with reverse clearing the
     * threshold in 2.2 s and nothing saying so. In ordinary play with the game's own follower: one
     * 9.9 m/s wall impact filed `propertyDamage`, took the level to three stars, and immobilised
     * the car in the same instant — the crime and the trap were one event, and the longest run
     * under 1.0 m/s was 10.42 s against a 4.0 s clock.
     *
     * LATCHED FOR THE HOLD rather than read per frame, so a player stabbing the throttle does not
     * make the verb flicker. It resets with the clock.
     */
    if ((player.throttle ?? 0) > 0.05) this._bustThrottle = true;
    this.bustFor += dt;
    if (this.bustFor < BUST_HOLD_S) return false;
    this.bustFor = 0;
    this.stats.busts++;
    // The level goes first, so a listener that reads `stars` sees the cleared value: being busted
    // is the end of the chase, not a state you are in with five stars showing.
    const at = { x: player.x, z: player.z };
    // Read BEFORE `clear`, which resets it, and passed on so the host can price the arrest.
    const cooperated = this.cooperated;
    this.clear('busted');
    this.emit('busted', { at, heldFor: BUST_HOLD_S, cooperated });
    return true;
  }

  /**
   * `teleported` IS THE HOST SAYING THE BODY WAS MOVED RATHER THAN DRIVEN, and without it getting
   * out of the car was immunity from arrest.
   *
   * `toggleVehicle` puts the player 1.9 m beside the car in one frame, and the reported position
   * is the player's on foot and the car's in it — so a step out is a 1.9 m jump, which at 60 Hz
   * differences to 114 m/s. Every consumer of `playerVel` reads that as travel: `_watchBust`
   * zeroes its clock, `_watchScene` stops counting you as stopped, and the interceptors aim at a
   * ghost. Measured by a blind playtester on the page and reproduced here: sitting still at four
   * stars and pressing F every second armed the bust clock 109 times in 120 s with a peak of 0.59
   * of 4 and no arrest, against a control that was arrested at 16 s. Every 4 s it peaked at 3.59
   * and still never fired.
   *
   * THE HOST OWNS THE FACT, for the same reason it owns `seen` and `held`: this module cannot tell
   * a teleport from a very fast car without a speed threshold, and a threshold would be wrong at
   * one frame rate or another — 1.9 m is 114 m/s at 60 Hz and 7.6 m/s at the 0.25 s dt clamp,
   * which is an ordinary speed. So there is no number here to get wrong.
   *
   * The previous smoothed value is HELD rather than zeroed, because a teleport says nothing about
   * whether the player was moving: a respawn lands a stationary car and a step out leaves a
   * stationary one, and in both cases what the module knew a frame ago is the better estimate.
   */
  _trackVelocity(dt, player) {
    if (player.teleported) {
      // Re-anchor without differencing, so the jump never becomes a velocity.
      if (!this._prevPlayer) this._prevPlayer = { x: player.x, z: player.z };
      this._prevPlayer.x = player.x;
      this._prevPlayer.z = player.z;
      this.stats.teleports++;
      return;
    }
    if (this._prevPlayer && dt > 1e-6) {
      const vx = (player.x - this._prevPlayer.x) / dt;
      const vz = (player.z - this._prevPlayer.z) / dt;
      // Smoothed so an interceptor does not chase every steering twitch. Frame
      // rate independent, for the same reason vehicle.js is.
      const k = 1 - Math.exp(-6 * dt);
      this.playerVel.x += (vx - this.playerVel.x) * k;
      this.playerVel.z += (vz - this.playerVel.z) * k;
    } else {
      this._prevPlayer = { x: player.x, z: player.z };
    }
    this._prevPlayer.x = player.x;
    this._prevPlayer.z = player.z;
  }

  _evaluateContact(player) {
    if (this.stars === 0) return false;
    if (this.time < this._forcedSightUntil) return true;
    if (typeof player.seen === 'boolean') return player.seen;
    const r = this.tune().spotRadius;
    if (r <= 0) return false;
    for (const u of this.units) {
      if (!u.pos) continue;
      const d = Math.hypot(u.pos.x - player.x, u.pos.z - player.z);
      if (d > r) continue;
      if (this.losTest && !this.losTest(u.pos, player)) continue;
      return true;
    }
    return false;
  }

  _setLastKnown(x, z) {
    const lk = this.lastKnown;
    const moved = !lk.valid || Math.hypot(lk.x - x, lk.z - z) > 0.5;
    lk.x = x; lk.z = z; lk.t = this.time; lk.valid = true;
    if (moved) this.emit('lastKnown', { x, z });
  }

  _setState(next) {
    const prev = this.state;
    if (prev === next) return;
    this.state = next;
    this.stateSince = this.time;
    this.emit('state', { state: next, prev });
  }

  _decayOneStar() {
    const prev = this.stars;
    // Drop to the clean floor of the next level down: banked fractional heat is
    // forfeited by escaping, which is what makes escaping feel like progress.
    this.heat = Math.max(0, prev - 1);
    this.evadeTimer = 0;
    this.searchRadius = this.searchRadius0;
    this.stats.decays++;
    this._applyStars(prev, 'decay');
  }

  // Single funnel for every star change, so the event surface cannot drift
  // between the crime path, the decay path and the scripting path.
  _applyStars(prev, reason) {
    const next = clamp(Math.floor(this.heat), 0, this.maxStars);
    if (next === prev) return;
    this.stars = next;
    if (next > prev) this.stats.escalations++;
    this.emit('stars', { stars: next, prev, reason });
    if (next > prev) this.emit('escalate', { stars: next, prev });
    if (next > 0) this.clearedBy = null;
    if (next === 0) {
      // The same word the `clear` event carries five lines below, so the field and the event
      // cannot disagree about one transition.
      this.clearedBy = reason === 'decay' ? 'escaped' : reason;
      if (reason === 'decay') this.stats.escapes++;
      this.heat = 0;
      this.cool = 0;
      this.evadeTimer = 0;
      this._forcedSightUntil = -1;
      this._releaseAll(reason === 'decay' ? 'escaped' : reason);
      this._setState(STATES.CLEAR);
      this.emit('clear', { reason: reason === 'decay' ? 'escaped' : reason });
    }
    this.emit('siren', { on: next > 0, intensity: this.tune().siren, stars: next });
  }

  _releaseAll(reason) {
    for (const u of this.units) this.emit('unit:release', { id: u.id, reason });
    this.units.length = 0;
  }

  _syncUnits(player) {
    const tune = this.tune();
    const want = this.stars === 0 ? 0
      : clamp(Math.round(tune.units * this.unitScale), 0, this.maxUnits);
    const target = this.state === STATES.SEARCH && this.lastKnown.valid
      ? { x: this.lastKnown.x, z: this.lastKnown.z }
      : { x: player.x, z: player.z };

    // Out of the fight: a unit that has fallen past the give-up radius is
    // released rather than trailed forever. Units that have not reported a
    // position yet are exempt — they have not spawned.
    if (tune.giveUpRadius > 0) {
      for (let i = this.units.length - 1; i >= 0; i--) {
        const u = this.units[i];
        if (!u.pos) continue;
        if (Math.hypot(u.pos.x - target.x, u.pos.z - target.z) > tune.giveUpRadius) {
          this.units.splice(i, 1);
          this.stats.unitsLost++;
          this.emit('unit:release', { id: u.id, reason: 'lost' });
        }
      }
    }

    while (this.units.length > want) {
      const u = this.units.pop();
      this.emit('unit:release', { id: u.id, reason: 'deescalate' });
    }
    while (this.units.length < want) {
      const u = {
        id: ++this._nextUnitId,
        role: 'chase',
        goal: { x: target.x, z: target.z },
        pos: null,
        jitter: this._rng() - 0.5,
        since: this.time,
      };
      this.units.push(u);
      this.stats.unitsRequested++;
      this.emit('unit:request', {
        id: u.id, role: u.role, spawnMin: tune.spawnMin, spawnMax: tune.spawnMax,
        target: { x: target.x, z: target.z },
      });
    }

    this._assignGoals(player, target, tune);
  }

  // Roles and goals. This is the whole tactical decision: who drives at the
  // player, who cuts ahead of them, and who sweeps which arc of the search.
  _assignGoals(player, target, tune) {
    const n = this.units.length;
    if (!n) return;

    if (this.state === STATES.SEARCH) {
      for (let i = 0; i < n; i++) {
        const u = this.units[i];
        if (i === 0) {
          // Somebody always drives to the spot itself. A ring with a hole in the
          // middle looks like a cordon, not a search.
          u.role = 'probe';
          u.goal.x = target.x; u.goal.z = target.z;
          continue;
        }
        u.role = 'search';
        const share = TAU / (n - 1);
        const a = this._sweep + (i - 1) * share + u.jitter * share * 0.5;
        u.goal.x = target.x + Math.cos(a) * this.searchRadius;
        u.goal.z = target.z + Math.sin(a) * this.searchRadius;
      }
      return;
    }

    // In contact. Interceptors aim at where the player will be, which is what
    // turns a conga line into a pincer; the rest converge on the player.
    const nIntercept = tune.intercept ? Math.max(1, Math.round(n * 0.4)) : 0;
    const speed = Math.hypot(this.playerVel.x, this.playerVel.z);
    const lead = Math.min(this.maxLead, speed * this.leadSeconds);
    const dirX = speed > 0.5 ? this.playerVel.x / speed : 0;
    const dirZ = speed > 0.5 ? this.playerVel.z / speed : 0;
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      if (i < nIntercept) {
        u.role = 'intercept';
        u.goal.x = target.x + dirX * lead;
        u.goal.z = target.z + dirZ * lead;
      } else {
        u.role = 'chase';
        u.goal.x = target.x;
        u.goal.z = target.z;
      }
    }
  }

  _writePlan(player) {
    const tune = this.tune();
    const p = this.plan;
    const target = this.state === STATES.SEARCH && this.lastKnown.valid
      ? this.lastKnown : player;
    p.stars = this.stars;
    p.state = this.state;
    p.seen = this.seen;
    p.target.x = target.x; p.target.z = target.z;
    p.searchRadius = this.state === STATES.SEARCH ? this.searchRadius : 0;
    p.evade.timer = this.evadeTimer;
    p.evade.required = this.evadeRequired();
    p.evade.progress = this.evadeProgress;
    p.units = this.units.length;
    p.spawnMin = tune.spawnMin;
    p.spawnMax = tune.spawnMax;
    p.giveUpRadius = tune.giveUpRadius;
    p.speedMul = tune.speedMul;
    p.intercept = tune.intercept;
    p.aggression = tune.aggression;
    p.siren = tune.siren;
    // Rebuilt rather than reused: the array is short (<= 8) and a stale entry
    // pointing at a released unit is a bug the consumer cannot see.
    p.assignments = this.units.map((u) => ({ id: u.id, role: u.role, goal: u.goal, pos: u.pos }));
    return p;
  }

  // ------------------------------------------------------------ diagnostics
  report() {
    return {
      time: +this.time.toFixed(2),
      stars: this.stars,
      heat: +this.heat.toFixed(3),
      state: this.state,
      seen: this.seen,
      evade: { timer: +this.evadeTimer.toFixed(2), required: +this.evadeRequired().toFixed(2),
        progress: +this.evadeProgress.toFixed(3) },
      cool: +this.cool.toFixed(2),
      lastKnown: this.lastKnown.valid
        ? { x: +this.lastKnown.x.toFixed(2), z: +this.lastKnown.z.toFixed(2), age: +(this.time - this.lastKnown.t).toFixed(2) }
        : null,
      searchRadius: +this.searchRadius.toFixed(1),
      units: this.units.map((u) => ({ id: u.id, role: u.role,
        goal: { x: +u.goal.x.toFixed(1), z: +u.goal.z.toFixed(1) } })),
      tuning: this.tune(),
      // What the player is being shown, beside what is true. A round spent an hour on a hit-and-run
      // that had fired correctly and silently; the diagnostic that would have settled it in a line
      // is the scene and the notice next to each other.
      hud: this.hudState(),
      stats: { ...this.stats },
    };
  }
}

/**
 * HOW LONG AN OFFENCE STAYS ON SCREEN AFTER IT IS FILED.
 *
 * Matched to src/hud.js's `escalateSeconds` default, which is how long the star meter's own alarm
 * flashes after a level change: the words and the alarm should stop together, or the player is
 * left reading "PEDESTRIAN STRUCK" over a meter that has gone quiet. The two constants live in two
 * modules because wanted.js must not import the presentation layer, so `tools/hud-cue.mjs` — the
 * one gate that imports both — asserts they are equal rather than leaving it to a comment.
 */
export const LAW_NOTICE_S = 4;

/**
 * THE STAR METER'S WORDS, AND WHICH OF TWO THINGS THE FLASH MEANS.
 *
 * district/main.js fed `wantedFlash: wanted.state === SEARCH` under a comment arguing that the
 * flash should mean the level is DRAINING. src/hud.js ALSO flashes for `escalateSeconds` after any
 * star increase. So "they have just spotted me" and "I have shaken them" were the same animation,
 * which is the one distinction a chase is made of. Restated here:
 *
 *   flash  = they have a fix on you        — the alarm. Contact, by eyes or by a fresh report.
 *   evade  = how far through shedding a star you are, 0..1 — drawn as the top star draining out.
 *
 * The drain is what the old comment wanted and could not have from a boolean: it is a reading, so
 * it says how nearly clear rather than only that you are. With it drawn, the flash is free to mean
 * the other thing, and the two states are no longer one animation.
 *
 * `note` is the same quantity in words, because the harness has no canvas and a playtester was
 * given only the star COUNT for a whole 96 s escape. Pure over a snapshot for that reason: both
 * hosts compose the same string and either can be walked in a test.
 */
export function composeWanted(s = {}) {
  const stars = Math.max(0, s.stars | 0);
  if (stars <= 0) return { stars: 0, evade: 0, note: null, flash: false };
  const evade = clamp(s.evade ?? 0, 0, 1);
  // In contact, by eyes or by a witness's report — `_evaluateContact` treats both as seen, and
  // `update` pins the escape clock at zero for both, so one alarm covers them.
  const flash = s.state === STATES.ACTIVE;
  let note;
  if (flash) note = s.hasFreshFix ? 'REPORTED' : 'SEEN';
  else if (s.state === STATES.SEARCH) note = `EVADING ${Math.ceil(s.remaining ?? 0)}s`;
  // stars > 0 and neither state: the frame a crime is filed, before the next `update` picks a
  // state. One frame in the page and a whole step in a 28x harness, so it gets a word rather
  // than a blank.
  else note = 'WANTED';
  return { stars, evade, note, flash };
}

/**
 * THE BAND'S LAW TENANT: the scene of an injury while it is live, then the offence that was filed.
 *
 * `hitAndRun` fires at exactly SCENE_LEAVE_M and discharges below SCENE_STOP_MS, and neither
 * number was learnable from playing. A playtester drove off at 40 km/h, the offence filed itself
 * 85.6 m and 4.61 s later, and the band still read "DRIVE EAST ALONG MARLIN STREET"; stopping
 * instead produced a decay indistinguishable from doing nothing. Both thresholds are good rules.
 *
 * So the line is a distance to the charge rather than a distance from the scene: `leaveIn` counts
 * down to the thing that is about to happen, which is the number a driver can act on. And stopping
 * gets a line of its own, because a mechanic whose reward is "nothing happens" teaches nothing.
 *
 * One tenant for both, because the scene and the charge are the same event: the scene clears at
 * the instant `hitAndRun` is filed, so the stop line hands straight over to "LEFT THE SCENE" with
 * no gap and no second slot in the priority order.
 */
export function composeLaw(s = {}) {
  /**
   * BEING HELD OUTRANKS EVERYTHING, including the scene of the injury that got you here: four
   * seconds is not long enough to read two lines, and the only action it leaves is the throttle.
   * The subtitle says what to do rather than what is happening, because a player who has never
   * been busted before has no way to know that moving is the out.
   */
  if (s.bustIn != null) {
    /**
     * `ownSubtitle` because this one word is the only place the game tells a player how to get out
     * of an arrest, and `src/hud.js`'s HOLDS_MISSION_SUBTITLE replaced it with the mission's
     * objective in every mission — a playtester measured `drive` in 0 of them. See composeBand.
     */
    return { objective: { text: 'BUSTED IN', distance: Math.max(0, s.bustIn), unit: 's' },
      // `reverse` once the throttle has been tried and the car has not moved: a nose-in crash is
      // both the crime and the immobilisation, and forward is not the out. See `bustStuck`.
      subtitle: s.bustStuck ? 'reverse' : 'drive', ownSubtitle: true };
  }
  const sc = s.scene;
  if (sc) {
    /**
     * THE DISTANCE IS IN THE OBJECTIVE, NOT THE SUBTITLE, and that is a correction. It was a
     * subtitle, and src/hud.js's `HOLDS_MISSION_SUBTITLE` hands a running mission's objective to
     * the subtitle of any tenant above it — so the number was deleted whenever a mission was live,
     * which is most of the game. A blind playtester measured it at **0 of 289** law glances with a
     * distance while a mission ran, against 46 of 57 when none was, on one 1.04 km drive.
     *
     * The page has an element for an objective's distance and dirty-checks it per whole metre, so
     * this is also where it is cheapest; `objectiveLine` renders it for a host with no canvas.
     */
    /**
     * THE SUBTITLE SAYS WHAT STOPPING BOUGHT. It used to say "leaving costs nothing now" —
     * permission with no urgency, to a player who has just been told to stop and is about to be
     * arrested for obeying. A blind playtester priced the whole choice: obeying lost the mission
     * 4 times in 4, and fleeing cost 0.80 heat, no extra star, 10.8 s of cooldown and 11.7 s
     * longer to clear. The consequence is priced differently now — see `cooperated` — and this is
     * where a player can learn it, which is the half that makes it a choice rather than a trap.
     */
    return sc.stopped
      ? { objective: { text: 'STOPPED AT THE SCENE' },
        subtitle: 'an arrest will not cost the job', ownSubtitle: true }
      : { objective: { text: 'STOP AT THE SCENE', distance: Math.max(0, sc.leaveIn ?? 0) },
        subtitle: 'leaving is a second offence' };
  }
  const n = s.notice;
  if (n && (n.age ?? Infinity) < LAW_NOTICE_S) {
    const stars = Math.max(0, s.stars | 0);
    /**
     * `status: true` — A REPORT, NOT AN INSTRUCTION, and the only branch of this function that is.
     *
     * The two above it are instructions with consequences: the bust countdown leaves four seconds
     * and one control, and `STOP AT THE SCENE` carries the job (see `cooperated`). This one names
     * a crime that has already happened and asks for nothing. It still belongs on the band — it is
     * how a player learns what they are wanted FOR — but it must not take the headline from a live
     * mission objective, and it was:
     *
     *     shakedown from the board, two seeds, full crowd and fleet, both PASSED
     *       seed 1   mission 9.8 s / law 24.3 s    law owns 71%
     *       seed 5   mission 9.4 s / law 24.7 s    law owns 72%
     *
     * Seven tenths of the first mission in the game, measured by a blind playtester. Both runs
     * knocked a pedestrian down 4.2 s after the first objective appeared while driving the game's
     * own route line at 15 m/s, so it is the ordinary case rather than a corner.
     *
     * And on the flagship's `ambush` it is not a share, it is a contradiction: that stage has no
     * waypoint, so stopping to read the band is the natural move, and the line read `STOP AT THE
     * SCENE — 85 m` over `still on: LOSE THEM` for 6.43 / 8.32 / 14.00 s in 3 of 5 runs. The
     * subtitle was right and the precedence was backwards.
     *
     * `statusLine` is the whole thing as ONE line, because when it yields it has a subtitle to
     * live in rather than two. Composed here, with the content, rather than in `src/hud.js`.
     */
    const label = String(n.label).toUpperCase();
    const note = stars > 0 ? `wanted — ${stars} star${stars === 1 ? '' : 's'}` : 'nobody saw it';
    // The one-line form takes a COMMA where the two-line form takes a dash, or it reads
    // "LEFT THE SCENE — wanted — 2 stars" with two dashes doing different jobs.
    const flat = stars > 0 ? `wanted, ${stars} star${stars === 1 ? '' : 's'}` : note;
    return { objective: { text: label }, subtitle: note, status: true,
      statusLine: `${label} — ${flat}` };
  }
  return null;
}

/**
 * The one place this module touches the pursuit layer.
 *
 * `pursuit` is duck-typed. Everything is optional and the bridge uses whatever
 * exists, so it works against the Phase 1b `PursuitUnits` in src/pursuit.js
 * today and against the M3 rewrite tomorrow without either knowing about the
 * other:
 *
 *   spawnUnit(id, {role, spawnMin, spawnMax, target})   a unit is wanted
 *   releaseUnit(id, reason)                             it is not, any more
 *   setUnitGoal(id, x, z, role)                         per-unit destination
 *   setUnitCount(n)                                     fleet size
 *   setTarget(x, z)                                     where the fleet converges
 *   setSpeedMultiplier(m) / setGiveUpRadius(r) / setSpawnBand(min, max)
 *   getUnitPositions() -> [{id, x, z}]                  positions back in
 *
 * Fallbacks: `PursuitUnits` exposes `speed` and `giveUpRadius` as plain fields
 * it re-reads every frame, so those two are written directly. Its `count` is an
 * InstancedMesh capacity fixed at construction and is deliberately left alone.
 *
 * The bridge never calls `pursuit.update()`. Movement stays entirely with its
 * owner; the caller keeps driving it, with `wanted.plan.target` as the target:
 *
 *   bridge.update(dt, player);
 *   pursuit.update(dt, wanted.plan.target);
 */
/**
 * ONE VICTIM, ONE OFFENCE, WITHIN A WINDOW — and it lives here because it is crime attribution,
 * not because wanted.js needs it. It was a Map and eight lines inside `district/main.js`, which no
 * offline gate imports: `tools/mutation-sweep.mjs` deleted the window test and all sixteen gates
 * plus playtest --selftest passed, because none of them can see that file. A rule with real teeth
 * in a place nothing can reach is a rule that will be broken silently.
 *
 * WHY IT EXISTS. A casualty gets back on its feet 4.42 s after going down and can be knocked down
 * again immediately, so a player creeping back and forth over one person collected a fresh crime
 * every cycle. Measured against the real wanted system: 7 knockdowns in 30 s, all 7 charged — the
 * per-CRIME refractory in `reportCrime` is 1.0 s and far too short to see them — heat 5.99, FIVE
 * STARS from one pedestrian and a car that never left the spot.
 *
 * That refractory is per crime TYPE, which is the right shape for a bumper grinding along a wall
 * and the wrong one here, because the thing being repeated is the VICTIM. The window is a little
 * longer than the knockdown cycle, so the loop collapses to one report while a genuinely separate
 * pedestrian a second later stays fully chargeable.
 */
export class VictimWindow {
  constructor(seconds) {
    this.seconds = seconds;
    /** victim id -> the time they were last charged for. */
    this.seen = new Map();
  }

  /**
   * Should this victim be charged now? Expires stale entries first, so the map cannot grow for a
   * session's worth of casualties.
   */
  charge(id, now) {
    for (const [vid, t] of this.seen) if (now - t > this.seconds) this.seen.delete(vid);
    const last = this.seen.get(id);
    if (last !== undefined && now - last <= this.seconds) return false;
    this.seen.set(id, now);
    return true;
  }

  /** How many victims are inside the window right now. */
  get tracked() { return this.seen.size; }
}

export function bindPursuit(wanted, pursuit, opts = {}) {
  const baseSpeed = opts.baseSpeed ?? pursuit.speed ?? 22;
  const unsub = [
    wanted.on('unit:request', (r) => pursuit.spawnUnit?.(r.id, r)),
    wanted.on('unit:release', (r) => pursuit.releaseUnit?.(r.id, r.reason)),
  ];

  return {
    update(dt, player) {
      if (pursuit.getUnitPositions) wanted.reportUnits(pursuit.getUnitPositions());
      const plan = wanted.update(dt, player);

      if (pursuit.setUnitCount) pursuit.setUnitCount(plan.units);
      if (pursuit.setTarget) pursuit.setTarget(plan.target.x, plan.target.z);
      if (pursuit.setSpawnBand) pursuit.setSpawnBand(plan.spawnMin, plan.spawnMax);
      if (pursuit.setUnitGoal) {
        for (const a of plan.assignments) pursuit.setUnitGoal(a.id, a.goal.x, a.goal.z, a.role);
      }
      if (pursuit.setSpeedMultiplier) pursuit.setSpeedMultiplier(plan.speedMul);
      else if (plan.speedMul > 0) pursuit.speed = baseSpeed * plan.speedMul;
      if (pursuit.setGiveUpRadius) pursuit.setGiveUpRadius(plan.giveUpRadius);
      else if (plan.giveUpRadius > 0) pursuit.giveUpRadius = plan.giveUpRadius;
      return plan;
    },
    detach() {
      for (const u of unsub) u();
      pursuit.speed = baseSpeed;
    },
  };
}
