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
  civilianCollision: f({ label: 'Collision with a vehicle',  heat: 0.50, cool: 3,  refractory: 1.5 }),
  hitAndRun:         f({ label: 'Left the scene',            heat: 0.80, cool: 10, refractory: 8.0, min: 1 }),
  pedestrianHit:     f({ label: 'Pedestrian struck',         heat: 1.15, cool: 8,  refractory: 1.0, min: 1 }),
  pedestrianKilled:  f({ label: 'Pedestrian killed',         heat: 2.00, cool: 15, refractory: 1.0, min: 2 }),
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

function f(c) { return Object.freeze({ cool: 0, refractory: 0, min: 0, requiresWanted: false, ...c }); }

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
export const RESPONSE = Object.freeze([
  Object.freeze({ units: 0, spawnMin: 0,   spawnMax: 0,   giveUpRadius: 0,   speedMul: 0,    intercept: false, aggression: 0.00, cooldown: 0,  searchGrow: 0,  spotRadius: 0,   siren: 0.00 }),
  Object.freeze({ units: 1, spawnMin: 80,  spawnMax: 190, giveUpRadius: 380, speedMul: 0.94, intercept: false, aggression: 0.15, cooldown: 12, searchGrow: 7,  spotRadius: 85,  siren: 0.35 }),
  Object.freeze({ units: 2, spawnMin: 90,  spawnMax: 240, giveUpRadius: 460, speedMul: 1.00, intercept: false, aggression: 0.32, cooldown: 18, searchGrow: 9,  spotRadius: 105, siren: 0.55 }),
  Object.freeze({ units: 4, spawnMin: 110, spawnMax: 310, giveUpRadius: 560, speedMul: 1.08, intercept: true,  aggression: 0.52, cooldown: 26, searchGrow: 12, spotRadius: 125, siren: 0.72 }),
  Object.freeze({ units: 6, spawnMin: 130, spawnMax: 390, giveUpRadius: 700, speedMul: 1.16, intercept: true,  aggression: 0.74, cooldown: 34, searchGrow: 15, spotRadius: 150, siren: 0.87 }),
  Object.freeze({ units: 8, spawnMin: 150, spawnMax: 470, giveUpRadius: 860, speedMul: 1.26, intercept: true,  aggression: 1.00, cooldown: 44, searchGrow: 18, spotRadius: 175, siren: 1.00 }),
]);

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
    this._sweep = 0;
    this._nextUnitId = 0;
    this._prevPlayer = null;
    // Reused in place so sanitising costs no per-frame allocation.
    this._safePlayer = { x: 0, z: 0, seen: undefined };
    this.playerVel = { x: 0, z: 0 };

    this.lastKnown = { x: 0, z: 0, t: 0, valid: false };
    this.units = [];

    this.stats = {
      crimes: 0, crimesIgnored: 0, escalations: 0, decays: 0,
      searches: 0, reacquires: 0, escapes: 0, unitsRequested: 0,
      unitsLost: 0, listenerErrors: 0, updates: 0,
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
    this.stats.crimes++;

    // The scene of the crime is information whoever reported it has, so it
    // anchors the search either way. What being WITNESSED adds is a fresh fix:
    // dispatch tracks you for a few seconds even before a car is near, which is
    // what stops a lone crime from dropping straight into `search` with the
    // escape clock already running.
    if (at) this._setLastKnown(at.x, at.z);
    if (opts.witnessed !== false) this._forcedSightUntil = this.time + this.witnessSeconds;

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

  // ------------------------------------------------------------ internals
  _sanitize(player) {
    const p = this._safePlayer;
    if (Number.isFinite(player.x)) p.x = player.x;
    if (Number.isFinite(player.z)) p.z = player.z;
    p.seen = player.seen;
    return p;
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
      stats: { ...this.stats },
    };
  }
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
