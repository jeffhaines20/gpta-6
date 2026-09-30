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
  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 1.15, cool: 8,  refractory: 0, min: 1, scene: true }),
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

export const RESPONSE = Object.freeze([
  Object.freeze({ units: 0, spawnMin: 0,   spawnMax: 0,   giveUpRadius: 0,   speedMul: 0,    intercept: false, aggression: 0.00, cooldown: 0,  searchGrow: 0,  spotRadius: 0,   siren: 0.00 }),
  Object.freeze({ units: 1, spawnMin: 80,  spawnMax: 190, giveUpRadius: 380, speedMul: 0.94, intercept: false, aggression: 0.15, cooldown: 12, searchGrow: 7,  spotRadius: 85,  siren: 0.35 }),
  Object.freeze({ units: 2, spawnMin: 90,  spawnMax: 240, giveUpRadius: 460, speedMul: 1.00, intercept: false, aggression: 0.32, cooldown: 18, searchGrow: 9,  spotRadius: 105, siren: 0.55 }),
  Object.freeze({ units: 4, spawnMin: 110, spawnMax: 310, giveUpRadius: 560, speedMul: 1.08, intercept: true,  aggression: 0.52, cooldown: 26, searchGrow: 12, spotRadius: 125, siren: 0.72 }),
  Object.freeze({ units: 6, spawnMin: 130, spawnMax: 390, giveUpRadius: 700, speedMul: 1.16, intercept: true,  aggression: 0.74, cooldown: 34, searchGrow: 15, spotRadius: 150, siren: 0.87 }),
  Object.freeze({ units: 8, spawnMin: 150, spawnMax: 470, giveUpRadius: 860, speedMul: 1.26, intercept: true,  aggression: 1.00, cooldown: 44, searchGrow: 18, spotRadius: 175, siren: 1.00 }),
]);

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
    /** The scene of the last injury, until the player stops at it or leaves it. See _watchScene. */
    this._scene = null;
    // Reused in place so sanitising costs no per-frame allocation.
    this._safePlayer = { x: 0, z: 0, seen: undefined };
    this.playerVel = { x: 0, z: 0 };

    this.lastKnown = { x: 0, z: 0, t: 0, valid: false };
    this.units = [];

    this.stats = {
      crimes: 0, crimesIgnored: 0, escalations: 0, decays: 0,
      searches: 0, reacquires: 0, escapes: 0, unitsRequested: 0,
      unitsLost: 0, listenerErrors: 0, updates: 0,
      // The scene of an injury: armed on a `scene: true` crime, discharged by stopping, charged
      // as `hitAndRun` by leaving. See _watchScene.
      scenesArmed: 0, scenesStopped: 0, scenesFled: 0,
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

    const prev = this.stars;
    const delta = c.heat * (opts.scale ?? 1);
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
      this._scene = { x: at.x, z: at.z, at: this.time, stopped: false, id, d: 0 };
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
      notice: this._notice ? { id: this._notice.id, label: this._notice.label,
        age: this.time - this._notice.t } : null,
    };
  }

  // ------------------------------------------------------------ internals
  _sanitize(player) {
    const p = this._safePlayer;
    if (Number.isFinite(player.x)) p.x = player.x;
    if (Number.isFinite(player.z)) p.z = player.z;
    p.seen = player.seen;
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
   */
  _watchScene(player) {
    const sc = this._scene;
    if (!sc) return;
    const d = Math.hypot(player.x - sc.x, player.z - sc.z);
    sc.d = d;
    if (d <= SCENE_LEAVE_M) {
      if (Math.hypot(this.playerVel.x, this.playerVel.z) < SCENE_STOP_MS) {
        if (!sc.stopped) { sc.stopped = true; this.stats.scenesStopped++; }
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

  _trackVelocity(dt, player) {
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
    if (next === 0) {
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
    return sc.stopped
      ? { objective: { text: 'STOPPED AT THE SCENE' }, subtitle: 'leaving costs nothing now' }
      : { objective: { text: 'STOP AT THE SCENE', distance: Math.max(0, sc.leaveIn ?? 0) },
        subtitle: 'leaving is a second offence' };
  }
  const n = s.notice;
  if (n && (n.age ?? Infinity) < LAW_NOTICE_S) {
    const stars = Math.max(0, s.stars | 0);
    return { objective: { text: String(n.label).toUpperCase() },
      subtitle: stars > 0 ? `wanted — ${stars} star${stars === 1 ? '' : 's'}` : 'nobody saw it' };
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
