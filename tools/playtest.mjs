// A playable game, in node, at 28x real time — so an agent can PLAY it rather than assert it.
//
//   node tools/playtest.mjs                         the built-in demo session
//   node tools/playtest.mjs --scenario FILE.mjs     run a scenario a reviewer wrote
//   node tools/playtest.mjs --selftest              prove the harness can fail
//
// WHY THIS EXISTS, AND WHAT IT IS NOT. Every gate in tools/ asserts a number. None of them
// answers "is this a game" — whether a mission can be finished, whether the car is drivable
// using only what a player can see, whether the wanted system escalates at a rate a person
// would call fair. Those are judgements, and a judgement needs a play session and somebody
// to read it.
//
// The whole simulation runs headlessly. Measured on this box: 60 s of game time with the
// vehicle, the damage model, the wanted system, a 30-car fleet and a 64-strong crowd costs
// 2,143 ms of wall clock — 28x real time, so half an hour of play is a minute of waiting.
// The browser cannot do this: SwiftShader is under one frame a second, and the sim advances
// with rendered frames, so a 60 s session there is twenty minutes and 60 frames.
//
// WHAT IT CANNOT TELL YOU, said plainly so a report does not claim it:
//
//   - nothing about FEEL. Frame rate, input latency and how the car responds to a thumb are
//     not in here, and the browser cannot measure them either at 0.8 fps.
//   - nothing about PIXELS. No renderer. What a thing looks like is tools/hero-shots.mjs and
//     tools/reaction-shots.mjs, and those cost minutes a frame.
//   - nothing about SOUND. src/audio.js needs an AudioContext; there is none here, and there
//     is none in headless Chromium either without a gesture.
//
// THE PLAYER SEES WHAT A PLAYER SEES. `look()` returns the HUD, the mission line, the
// waypoint's bearing and distance, and what is within sight ahead — not the sim's own state.
// That restriction is the whole point: a harness that hands over `traffic._lastPositions`
// lets an agent drive by omniscience and report that the game is easy to drive. Everything
// the real HUD does not show is behind `debug()`, which a scenario may read when it is
// diagnosing something but should not steer by.
import fs from 'node:fs';
import * as THREE from '../vendor/three.module.min.js';
import { Vehicle, BODY_SAMPLES, BODY_RADIUS, BODY_ENCLOSING } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel, IMPACT, dynamicContact } from '../src/damage.js';
import { WantedSystem } from '../src/wanted.js';
import { Traffic } from '../src/traffic.js';
import { Pedestrians } from '../src/pedestrians.js';
import { RoadGraph, followPath } from '../src/roadpath.js';
import { MissionRunner, OUTCOMES, MissionBoard } from '../src/mission.js';
import { MISSIONS } from '../src/missions.js';

const HZ = 120, DT = 1 / HZ;
const OTHER_CAR = { bodyRadius: 0.95, bodyMass: 1400 };
const PERSON = { bodyRadius: 0.35, bodyMass: 80 };
/** One victim, one offence, within this window. district/main.js's own figure and reason. */
const PED_CRIME_WINDOW_S = 20;
/** How long a wreck is held before a replacement arrives. district/main.js's own figure. */
const WRECK_HOLD_S = 4;
// Four distinct scratch vectors, not two reused, for the reason applyImpulseAt's own comment
// gives: sharing one with a caller turned `offset.cross(impulse)` into a self-cross.
const _fwd = new THREE.Vector3(), _right = new THREE.Vector3();
const _imp = new THREE.Vector3(), _off = new THREE.Vector3();
/** How far ahead a player can make out a car or a person, and how wide the view is. */
const SIGHT_M = 70, SIGHT_HALF_ANGLE = 0.65;       // ~75 degrees across

/**
 * One play session. Everything district/main.js assembles that does not need a GL context.
 *
 * The pursuit layer is NOT here: src/pursuit.js draws its units through an InstancedMesh and
 * main.js's shim is written against the renderer's lifecycle. A session can still get stars
 * and can still be told it is being chased — it just has nobody to be chased BY, which is
 * stated in every report rather than left to be discovered.
 */
export class Session {
  constructor(opts = {}) {
    this.district = opts.district
      ?? JSON.parse(fs.readFileSync(new URL('../data/district.json', import.meta.url), 'utf8'));
    const scene = { add() {} };
    this.blockers = new BlockerIndex(this.district);
    this.vehicle = new Vehicle();
    this.damage = new DamageModel();
    this.vehicle.blockers = this.blockers;
    this.vehicle.damage = this.damage;
    this.ground = new FlatGround(0);
    this.wanted = new WantedSystem();
    this.traffic = new Traffic(scene, this.district, { count: opts.traffic ?? 30 });
    this.traffic.clearAt = (x, z, r) => !this.blockers.resolveCircle(x, z, r);
    this.peds = new Pedestrians(scene, this.district, { count: opts.peds ?? 64 });
    this.roads = new RoadGraph(this.district, { blockers: this.blockers, carRadius: BODY_RADIUS });
    this.mission = new MissionRunner();
    /**
     * THE BOARD, so a playtester exercises the loop a player has rather than the one a console
     * has. `startMission()` is still here for a scenario that wants to jump straight into a
     * mission, but the honest way in is to drive into a marker, and that is what the real page
     * now does too.
     */
    this.board = new MissionBoard(MISSIONS);
    this.mission.on('finished', (e) => {
      if (this.mission.mission) this.board.record(this.mission.mission.id, e.outcome);
    });
    this.t = 0;
    this.log = [];
    // `impacts` is every damage record; `voices` is the subset src/audio.js would actually
    // play. Those read 458 and 3 over 76 m of ordinary driving, because the median record is
    // 0.007 m/s of kerb rumble and audio.js refuses anything under 0.6 — so a single number
    // called "sounds" was wrong by two orders of magnitude, in the alarming direction.
    this.stats = { crashes: 0, crimes: 0, knockdowns: 0, fatal: 0, shunts: 0,
      impacts: 0, voices: 0, tested: 0, contacts: 0, pedRepeats: 0,
      wrecks: 0, respawns: 0, worstDv: 0, distance: 0, topSpeed: 0 };
    this._lastPos = { x: 0, z: 0 };
    this._controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this._route = null;
    this._offer = null;
    this._wreckFor = 0;
    this._outcome = OUTCOMES.RUNNING;
    /** When each pedestrian was last reported as a crime, by their own id. See _contacts. */
    this._pedCrimeAt = new Map();
    /** The last pedestrian this session struck: who, how hard, and whether it was charged. */
    this.lastHit = null;
    // Every damage record, as a line in the transcript — the same hook the crash voice uses.
    this.damage.onImpact = (rec) => {
      this.stats.impacts++;
      // EVERY record, not only the moving-body ones. `worstDv` used to be set inside the
      // dynamic pass alone, so a session that drove head-on into a building at 50 km/h
      // reported a worst delta-v of 0.00 — the number a reader would quote first.
      if (rec.dv > this.stats.worstDv) this.stats.worstDv = +rec.dv.toFixed(2);
      if (!(rec.dv > 0.6)) return;
      this.stats.voices++;
      this.say(`CRUNCH  ${rec.dv.toFixed(1)} m/s into ${rec.kind}, ${rec.region}` +
        (rec.applied ? `, health now ${this.damage.health.toFixed(2)}` : ', no damage'));
    };
    const spawn = this.district.meta.spawn;
    this.placeAt(spawn.x, spawn.z);
  }

  // ------------------------------------------------------------------ the world
  placeAt(x, z, yaw = 0) {
    this.vehicle.position.set(x, 0.55, z);
    this.vehicle.velocity.set(0, 0, 0);
    this.vehicle.quaternion.setFromAxisAngle({ x: 0, y: 1, z: 0 }, yaw);
    this._lastPos = { x, z };
    return this;
  }

  say(line) { this.log.push({ t: +this.t.toFixed(2), line }); return this; }

  /**
   * What the player is doing with the controls. Same shape src/input.js produces.
   *
   * IT REFUSES A NON-FINITE INPUT, because a player's hands cannot produce one and a
   * scenario's arithmetic can. A playtester computed a steer angle from `route[i].x` on a
   * route whose points are `[x, z, edge]` triples, got NaN, and drove the car to (NaN, NaN),
   * where the game kept running: the speedo read NaN, the waypoint read NaN, and every object
   * in the city appeared in `carsAhead` because `NaN > SIGHT_M` and `NaN < 0.01` are both
   * false. A harness that lets that through reports a broken world instead of a broken input.
   */
  drive({ throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
    for (const [k, n] of [['throttle', throttle], ['brake', brake], ['steer', steer]]) {
      if (!Number.isFinite(n)) throw new Error(`drive(): ${k} is ${n}. A control input has to ` +
        `be a finite number — check for an undefined field. routeToWaypoint() returns ` +
        `[x, z, edgeIndex] triples, not {x, z} objects.`);
    }
    this._controls = { throttle, brake, steer, handbrake };
    return this;
  }

  /** Advance the world. Seconds of GAME time, not of waiting. */
  step(seconds) {
    const n = Math.max(1, Math.round(seconds * HZ));
    for (let k = 0; k < n; k++) {
      this.vehicle.setControls(this._controls);
      this.vehicle.stepFixed(DT, this.ground, HZ);
      this.damage.update(DT);
      this.wanted.update(DT, { x: this.vehicle.position.x, z: this.vehicle.position.z });
      this.traffic.update(DT, this.vehicle.position);
      this.peds.update(DT, this.vehicle.position);
      this._moving();
      this._contacts();
      this._wreckWatch(DT);
      // Drive into a marker and the job starts, exactly as district/main.js does it.
      if (!this.mission.hud()) this._offers();
      if (this.mission.mission) {
        /**
         * `hud()` RETURNS NULL THE INSTANT THE OUTCOME STOPS BEING RUNNING (mission.js:445),
         * which is how a mission ends — so reading `.objective` off it unconditionally threw on
         * the frame the last stage passed, every time, and this harness had therefore never
         * once seen a mission finish. Both playtesters hit it; one had to reach `report()`
         * instead to find out it had won.
         */
        const before = this.mission.hud();
        this.mission.update(DT, this._snapshot());
        const after = this.mission.hud();
        const objBefore = before ? before.objective : null;
        const objAfter = after ? after.objective : null;
        if (objAfter !== objBefore) this.say(`OBJECTIVE  ${objAfter ?? '(none)'}`);
        if (this.mission.outcome !== this._outcome) {
          this._outcome = this.mission.outcome;
          this.say(`MISSION ${this._outcome.toUpperCase()} after ` +
            `${this.mission.time.toFixed(1)} s`);
        }
      }
      this.t += DT;
    }
    return this;
  }

  /**
   * The offer pass. Inside a pickup radius with nothing running, the mission starts; inside the
   * notice radius it is named, so `look()` can show a player what a marker is before they are
   * standing in it.
   */
  _offers() {
    const hot = this.board.offerAt(this.vehicle.position.x, this.vehicle.position.z);
    if (hot) {
      this.board.starts++;
      this._outcome = OUTCOMES.RUNNING;
      this.mission.start(hot.mission);
      this.say(`MISSION ${hot.mission.id}: ${hot.mission.title} — ` +
        `${this.mission.hud()?.objective ?? ''}`);
      this._offer = null;
      return;
    }
    const seen = this.board.offerAt(this.vehicle.position.x, this.vehicle.position.z, 'notice');
    this._offer = seen
      ? { title: seen.mission.title, brief: seen.mission.brief, range: seen.distance }
      : null;
  }

  _snapshot() {
    return { px: this.vehicle.position.x, pz: this.vehicle.position.z, inVehicle: true,
      speed: this.vehicle.speed, health: this.damage.health,
      wantedStars: this.wanted.stars, wantedState: this.wanted.state };
  }

  _moving() {
    const d = Math.hypot(this.vehicle.position.x - this._lastPos.x,
      this.vehicle.position.z - this._lastPos.z);
    this.stats.distance += d;
    this._lastPos = { x: this.vehicle.position.x, z: this.vehicle.position.z };
    const kmh = this.vehicle.speed * 3.6;
    if (kmh > this.stats.topSpeed) this.stats.topSpeed = +kmh.toFixed(1);
    if (this.vehicle.pendingImpact) {
      const hit = this.vehicle.pendingImpact;
      this.vehicle.pendingImpact = null;
      this.stats.crashes++;
      if (hit.crime) this._crime(hit.crime);
    }
  }

  /**
   * A WRECKED CAR IS NOT THE END OF THE SESSION. district/main.js's own rule, mirrored here so a
   * playtester plays the game rather than a version of it that strands them: four seconds of
   * wreck, the mission called off, then a replacement car on the nearest road. Before this a
   * playtester measured 60 s of full throttle and 60 s of full reverse both giving 0 km/h, with
   * the mission outcome stuck on 'running' and the objective still on the HUD.
   */
  _wreckWatch(dt) {
    if (!this.damage.wrecked) { this._wreckFor = 0; return; }
    if (this._wreckFor === 0) {
      this.stats.wrecks++;
      this.say('WRECK   the car is destroyed — a replacement in ' + WRECK_HOLD_S + ' s');
      if (this.mission.mission && this.mission.outcome === OUTCOMES.RUNNING) {
        this.mission.abort('the car is wrecked');
      }
    }
    this._wreckFor += dt;
    if (this._wreckFor < WRECK_HOLD_S) return;
    this.respawn();
  }

  /** Of a heading and its reverse, the one with more clear road ahead. */
  _clearerHeading(x, z, yaw, reach = 30, step = 2) {
    const run = (h) => {
      const sx = Math.sin(h), sz = Math.cos(h);
      for (let d = step; d <= reach; d += step) {
        if (this.blockers.resolveCircle(x + sx * d, z + sz * d, BODY_RADIUS)) return d - step;
      }
      return reach;
    };
    return run(yaw) >= run(yaw + Math.PI) ? yaw : yaw + Math.PI;
  }

  /** The replacement car, on the nearest road centreline, facing along it. */
  respawn() {
    this._wreckFor = 0;
    this.stats.respawns++;
    this.damage.repair();
    this.vehicle.contacts = 0;
    this.vehicle.pendingImpact = null;
    const near = this.roads.nearestOn(this.vehicle.position.x, this.vehicle.position.z);
    let x = this.district.meta.spawn.x, z = this.district.meta.spawn.z, yaw = 0;
    if (near && near.dist < 80 && !this.blockers.resolveCircle(near.x, near.z, BODY_RADIUS)) {
      x = near.x; z = near.z;
      const a = this.district.verts[near.a], b = this.district.verts[near.b];
      yaw = Math.atan2(b.x - a.x, b.z - a.z);
      // Facing the way there is road: an edge has two directions and the first one pointed the
      // replacement at the building it had just been destroyed against, 11 m off.
      yaw = this._clearerHeading(x, z, yaw);
    }
    this.placeAt(x, z, yaw);
    this.vehicle.angularVelocity.set(0, 0, 0);
    this.say(`RESPAWN a replacement car at (${x.toFixed(0)}, ${z.toFixed(0)})`);
    return { x: +x.toFixed(1), z: +z.toFixed(1) };
  }

  _crime(name) {
    const r = this.wanted.reportCrime(name,
      { at: { x: this.vehicle.position.x, z: this.vehicle.position.z } });
    if (!r.applied) return;
    this.stats.crimes++;
    this.say(`CRIME   ${name} — ${this.wanted.stars} star${this.wanted.stars === 1 ? '' : 's'}`);
  }

  /**
   * The moving-body pass, in the same shape district/main.js runs it: the worst contact of
   * each KIND reacts, the damage charge is the single worst, and the crime follows the person.
   *
   * IT IS THE SAME CALL NOW, AND THE FIRST DRAFT WAS A PARAPHRASE OF IT. `base` carried a
   * `yaw` scalar where src/damage.js's `dynamicContact` destructures
   * `fwdX/fwdZ/rightX/rightZ/samples/carRadius`, so `for (const sz of samples)` threw on
   * `undefined` the first time the car came within 3.3 m of anybody — 10.68 s and 208 m into
   * a playtester's first session. It also skipped the push-out impulse, the pedestrian crime
   * window and `restitution`, and it gated the whole pass behind `speed > 0.3` where main.js
   * gates nothing and lets `closing > 0` decide.
   *
   * THE SELFTEST COULD NOT SEE ANY OF IT, which is the part worth keeping. Every arm ran
   * `traffic: 0, peds: 0`, so the harness passed 7 of 7 while being unable to survive touching
   * a single pedestrian — the exact shape CLAUDE.md's "a check whose two sides are both zero"
   * section is about, in the file written to catch it in the game.
   */
  _contacts() {
    const v = this.vehicle;
    const fwd = _fwd.set(0, 0, 1).applyQuaternion(v.quaternion);
    const right = _right.set(1, 0, 0).applyQuaternion(v.quaternion);
    const base = {
      carX: v.position.x, carZ: v.position.z,
      fwdX: fwd.x, fwdZ: fwd.z, rightX: right.x, rightZ: right.z,
      carVX: v.velocity.x, carVZ: v.velocity.z,
      carMass: v.mass, samples: BODY_SAMPLES, carRadius: BODY_RADIUS,
      restitution: v.wallRestitution,
    };
    // One `worst` by delta-v for the damage charge, and the worst of each KIND for the
    // reactions, because an 80 kg body can never out-delta-v a 1,400 kg car: at 16.7 m/s of
    // closing a pedestrian is 1.04 and a car is 9.60, so a frame that touched both used to
    // produce no knockdown and no pedestrian crime at all.
    let worst = null, worstKind = null, worstPed = null, worstCar = null;
    for (const c of this.traffic._lastPositions ?? []) {
      const dx = c.x - base.carX, dz = c.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + OTHER_CAR.bodyRadius) ** 2) continue;
      this.stats.tested++;
      // The direction of TRAVEL, not the direction it is pointing: `yaw` carries the shunt's
      // spin and `heading` is the direction along the edge.
      const cy = typeof c.heading === 'number' ? c.heading
        : (typeof c.yaw === 'number' ? c.yaw : null);
      const hit = dynamicContact({ ...base, ...OTHER_CAR, bodyX: c.x, bodyZ: c.z,
        bodyVX: cy === null ? 0 : Math.sin(cy) * (c.v ?? 0),
        bodyVZ: cy === null ? 0 : Math.cos(cy) * (c.v ?? 0) });
      if (!hit) continue;
      if (!worst || hit.dv > worst.dv) { worst = hit; worstKind = IMPACT.vehicle; }
      if (!worstCar || hit.dv > worstCar.dv) { worstCar = hit; worstCar.carId = c.id; }
    }
    for (const p of this.peds.positions()) {
      if (p.down) continue;          // a body on the ground is not a fresh crime
      const dx = p.x - base.carX, dz = p.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + PERSON.bodyRadius) ** 2) continue;
      this.stats.tested++;
      const hit = dynamicContact({ ...base, ...PERSON, bodyX: p.x, bodyZ: p.z });
      if (!hit) continue;
      if (!worst || hit.dv > worst.dv) { worst = hit; worstKind = IMPACT.pedestrian; }
      if (!worstPed || hit.dv > worstPed.dv) { worstPed = hit; worstPed.pedIndex = p.i; }
    }
    if (!worst) return;
    this.stats.contacts++;
    const travel = Math.hypot(v.velocity.x, v.velocity.z);
    if (!(travel > 0) || !Number.isFinite(travel)) return;   // no direction to hand over
    const tx = v.velocity.x / travel, tz = v.velocity.z / travel;
    let pedCrime = null;
    if (worstPed && worstPed.pedIndex >= 0) {
      const r = this.peds.hit(worstPed.pedIndex, { speed: travel, dirX: tx, dirZ: tz });
      if (r) {
        this.stats.knockdowns++;
        if (r.fatal) this.stats.fatal++;
        pedCrime = r.fatal ? 'pedestrianKilled' : 'pedestrianHit';
        // A casualty gets up 4.42 s after it goes down and can be knocked down again, so a
        // player creeping back and forth over one person used to collect five stars from a
        // single pedestrian. The window collapses the loop to one report.
        for (const [vid, t] of this._pedCrimeAt) {
          if (this.t - t > PED_CRIME_WINDOW_S) this._pedCrimeAt.delete(vid);
        }
        const last = this._pedCrimeAt.get(r.id);
        if (last !== undefined && this.t - last <= PED_CRIME_WINDOW_S) {
          pedCrime = null; this.stats.pedRepeats++;
        } else this._pedCrimeAt.set(r.id, this.t);
        this.lastHit = { id: r.id, fatal: !!r.fatal, speedKmh: +(travel * 3.6).toFixed(1),
          throwM: +r.throwWanted.toFixed(2), charged: pedCrime !== null, t: +this.t.toFixed(2) };
        this.say(`HIT     a pedestrian at ${(travel * 3.6).toFixed(0)} km/h — ` +
          `${r.fatal ? 'they do not get up' : 'thrown ' + r.throwWanted.toFixed(1) + ' m'}`);
      }
    }
    if (worstCar && worstCar.carId != null) {
      const r = this.traffic.hit(worstCar.carId,
        { dv: worstCar.dv, dirX: tx, dirZ: tz, kind: 'vehicle' });
      if (r) {
        this.stats.shunts++;
        this.say(`RAM     a traffic car, ${r.dv.toFixed(1)} m/s — knocked ${r.push.toFixed(1)} m`);
      }
    }
    // Push the car out and TAKE THE IMPULSE. A pedestrian does not push a car around, so the
    // separation and the impulse are only for the car-mass bodies. Leaving the impulse out was
    // not cosmetic: it is what spins the car after a side-on ram, so the harness answered
    // "what does ramming feel like" with a car that stopped dead in its own lane.
    if (worstKind !== IMPACT.pedestrian) {
      v.position.x += worst.nx * worst.depth;
      v.position.z += worst.nz * worst.depth;
      const j = worst.dv * (OTHER_CAR.bodyMass / (v.mass + OTHER_CAR.bodyMass)) * v.mass;
      v.applyImpulseAt(
        _imp.set(worst.nx * j, 0, worst.nz * j),
        _off.set(worst.dirX * right.x + worst.dirZ * fwd.x, 0,
          worst.dirX * right.z + worst.dirZ * fwd.z));
    }
    const rec = this.damage.impact({ dv: worst.dv, kind: worstKind,
      dirX: worst.dirX, dirZ: worst.dirZ, speed: travel });
    // The pedestrian's own crime is filed from what happened to the BODY, so the record's copy
    // of it is dropped rather than filed twice.
    // The pedestrian crime is the BODY's and only the body's: damage.js reports `pedestrianHit`
    // at any speed by design, so taking it from the record filed an offence for a touch that
    // knocked nobody down. Measured: 0 knockdowns, 6 crimes and five stars from a creep.
    const crimes = [];
    if (pedCrime) crimes.push(pedCrime);
    if (rec.crime && worstKind !== IMPACT.pedestrian) crimes.push(rec.crime);
    for (const c of crimes) this._crime(c);
  }

  _yaw() {
    const q = this.vehicle.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y ** 2 + q.x ** 2));
  }

  // ------------------------------------------------------------------ missions
  startMission(id) {
    // MISSIONS is keyed by id, the way src/missions.js exports it.
    const m = MISSIONS[id] ?? Object.values(MISSIONS)[0];
    this.mission.start(m);
    this.say(`MISSION ${m.id}: ${this.mission.hud().objective ?? ''}`);
    return this.mission.hud();
  }

  /**
   * The route line the HUD draws, as a player would follow it.
   *
   * THE POINTS ARE `[x, z, edgeIndex]` TRIPLES, not `{x, z}` objects — src/roadpath.js's own
   * shape, and src/hud.js reads them that way. Said here because a playtester wrote
   * `route[i].x`, got `undefined`, and steered the car to (NaN, NaN).
   */
  routeToWaypoint() {
    const wp = this.mission.mission ? this.mission.hud().waypoint : null;
    if (!wp) { this._route = null; return null; }
    // The same call district/main.js's routeToMarker makes, with the same spacing.
    const p = this.roads.path(this.vehicle.position.x, this.vehicle.position.z, wp.x, wp.z,
      { spacing: 8, offset: 0, smoothPasses: 1 });
    this._route = p && p.points ? p.points : null;
    return this._route;
  }

  // ------------------------------------------------------------------ the view
  /**
   * WHAT A PLAYER CAN SEE. The HUD, the objective, the waypoint's bearing and range, and
   * whatever is within SIGHT_M in a forward cone. Nothing else: no positions of things behind
   * the car, no ids, no sim state. A scenario that wants more is diagnosing, not playing, and
   * should say so by calling debug().
   */
  look() {
    const v = this.vehicle, yaw = this._yaw();
    const fwd = { x: Math.sin(yaw), z: Math.cos(yaw) };
    const ahead = (x, z) => {
      const dx = x - v.position.x, dz = z - v.position.z;
      const d = Math.hypot(dx, dz);
      if (d > SIGHT_M || d < 0.01) return null;
      const dot = (dx * fwd.x + dz * fwd.z) / d;
      if (dot < Math.cos(SIGHT_HALF_ANGLE)) return null;
      const cross = fwd.x * (dz / d) - fwd.z * (dx / d);
      return { range: +d.toFixed(1), bearing: +Math.atan2(cross, dot).toFixed(2) };
    };
    const cars = [], people = [];
    // `_lastPositions` is assigned at the END of Traffic.update(), so it does not exist at all
    // before the first step() — and look() at frame zero is the first thing a player does.
    for (const c of this.traffic._lastPositions ?? []) {
      const a = ahead(c.x, c.z);
      if (a) cars.push({ ...a, speedKmh: +((c.v ?? 0) * 3.6).toFixed(0), askew: !!c.shunted });
    }
    for (const p of this.peds.positions()) {
      const a = ahead(p.x, p.z);
      if (a) people.push({ ...a, down: !!p.down });
    }
    cars.sort((a, b) => a.range - b.range);
    people.sort((a, b) => a.range - b.range);
    const hud = this.mission.mission ? this.mission.hud() : null;
    const wp = hud ? hud.waypoint : null;
    let waypoint = null;
    if (wp) {
      const dx = wp.x - v.position.x, dz = wp.z - v.position.z, d = Math.hypot(dx, dz);
      const dot = (dx * fwd.x + dz * fwd.z) / (d || 1);
      const cross = fwd.x * (dz / (d || 1)) - fwd.z * (dx / (d || 1));
      waypoint = { range: +d.toFixed(0), bearing: +Math.atan2(cross, dot).toFixed(2) };
    }
    return {
      t: +this.t.toFixed(1),
      speedKmh: +(v.speed * 3.6).toFixed(0),
      // The HUD's own fields, and only those: health, the damage vignette, the star count.
      health: +this.damage.health.toFixed(3),
      smoke: +this.damage.smoke.toFixed(2),
      wreck: this.damage.wrecked,
      stars: this.wanted.stars,
      objective: hud ? hud.objective : null,
      subtitle: hud ? hud.subtitle : null,
      // hud() goes null when the mission ends, so without this a finished mission and no
      // mission at all look identical from the seat.
      missionOutcome: this.mission.mission ? this.mission.outcome : null,
      // A job on offer nearby, the way the objective band names it in the page.
      offer: this._offer ?? null,
      waypoint,
      // What is in front of the windscreen, nearest first, capped the way attention is.
      carsAhead: cars.slice(0, 6),
      peopleAhead: people.slice(0, 8),
      // The one thing the player feels that is not on the HUD.
      pullsTo: this.damage.steerPull > 0.02 ? 'right'
        : this.damage.steerPull < -0.02 ? 'left' : null,
    };
  }

  /** Everything the player cannot see. For diagnosing a session, never for steering it. */
  debug() {
    return {
      at: { x: +this.vehicle.position.x.toFixed(1), z: +this.vehicle.position.z.toFixed(1) },
      yaw: +this._yaw().toFixed(2),
      insideBuilding: this.blockers.insideAny(this.vehicle.position.x, this.vehicle.position.z) >= 0,
      contacts: this.vehicle.contacts,
      damage: this.damage.report(),
      wanted: this.wanted.report(),
      mission: this.mission.mission ? this.mission.report() : null,
      board: this.board.report(),
      traffic: (this.traffic._lastPositions ?? []).length,
      crowd: this.peds.positions().length,
      stats: { ...this.stats, distance: +this.stats.distance.toFixed(0) },
    };
  }

  /** The session as a reviewer would read it. */
  transcript() {
    return this.log.map((l) => `  ${String(l.t).padStart(7)}s  ${l.line}`).join('\n');
  }
}

/**
 * An autopilot a scenario can use when it wants to GET somewhere rather than to test the
 * driving. It is src/roadpath.js's own follower, which is the same one the route gate drives,
 * so a scenario that uses it is testing the world and not the controller.
 */
export function driveTo(session, x, z, { maxSpeed = 16, timeout = 180, offset = 0 } = {}) {
  const from = session.vehicle.position;
  /**
   * OFFSET 0, THE SAME LINE district/main.js DRAWS. This was `offset: 3` — a right-hand lane —
   * and on this district's own roads a flat 3 m offset leaves the carriageway: both playtesters
   * had the autopilot wreck the car on the mission's own return leg, one of them 5 times out of
   * 6 starting headings at the identical point, (-189.8, -95). Isolated one term at a time, on
   * the Five Points -> marina route, everything else held:
   *
   *     offset  0      0 of 181 route points blocked   arrived, health 1.00
   *     offset  1.5    0 of 181                        arrived, health 1.00
   *     offset -3      0 of 181                        arrived, health 0.60
   *     offset  3     11 of 181                        WRECKED 411 m short
   *
   * The offset itself is fixed in src/roadpath.js (see the cap on `path`'s per-point width);
   * this default is 0 because that is what a player is shown.
   */
  const path = session.roads.path(from.x, from.z, x, z, { spacing: 4, offset, smoothPasses: 2 });
  if (!path || !path.points || path.points.length < 2) return { arrived: false, why: 'no route' };
  /**
   * AND IT SAYS SO WHEN THE ROUTE IS INSIDE A BUILDING, rather than driving into it and
   * reporting 'wrecked'. No follower can steer out of a road that is inside a building — the
   * blocked count tells a reader which of the two they are looking at.
   */
  let blocked = 0;
  for (const p of path.points) if (session.blockers.resolveCircle(p[0], p[1], BODY_RADIUS)) blocked++;
  const state = { i: 0 };
  const t0 = session.t;
  while (session.t - t0 < timeout) {
    const v = session.vehicle;
    const f = followPath(path.points, { x: v.position.x, z: v.position.z, yaw: session._yaw(),
      speed: v.speed }, state, { maxSpeed });
    if (f.done) {
      return { arrived: true, seconds: +(session.t - t0).toFixed(1), points: path.points.length,
        metres: +path.length.toFixed(0), blocked };
    }
    session.drive(f.controls).step(DT * 8);
    if (session.damage.wrecked) {
      return { arrived: false, why: blocked ? `wrecked (route has ${blocked} of ` +
        `${path.points.length} points inside a building)` : 'wrecked',
      seconds: +(session.t - t0).toFixed(1), blocked };
    }
  }
  return { arrived: false, why: 'timeout', blocked };
}

// ---------------------------------------------------------------------------
// The built-in session, which is also the smoke test: it drives, it crashes, it reports.
// ---------------------------------------------------------------------------
const SELFTEST = process.argv.includes('--selftest');
const scenarioArg = process.argv.indexOf('--scenario');
if (scenarioArg >= 0 && process.argv[scenarioArg + 1]) {
  const mod = await import(new URL(process.argv[scenarioArg + 1], `file://${process.cwd()}/`).href);
  await (mod.default ?? mod.run)({ Session, driveTo });
} else if (SELFTEST) {
  /**
   * A HARNESS THAT CANNOT FAIL IS NOT A HARNESS, AND THIS ONE COULD NOT.
   *
   * The first version passed 7 of 7 while being unable to survive touching a single pedestrian,
   * because every one of its arms ran `traffic: 0, peds: 0` — so the whole moving-body pass, the
   * `HIT`/`RAM` transcript lines and the crowd and fleet reactions were unreachable code that
   * nothing exercised. Two playtesters found it inside sixteen seconds of play each and both had
   * to patch the harness before they could start. It is CLAUDE.md's "a check whose two sides are
   * both zero is not a check", in the file written to catch that class of fault in the game.
   *
   * So every arm below asserts that the thing it measures HAPPENED — a knockdown, a shunt, a
   * mission outcome — and each has a control that must read zero for the same instrument.
   */
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
  };
  const t00 = Date.now();
  console.log('PLAYTEST HARNESS SELFTEST');

  console.log('\n§1  the world, and the car');
  const idle = new Session({ traffic: 0, peds: 0 });
  // look() BEFORE the first step(), which is the first thing a player does and used to throw:
  // traffic._lastPositions is only assigned at the end of Traffic.update().
  let frameZero = null, frameZeroErr = null;
  try { frameZero = idle.look(); } catch (e) { frameZeroErr = e.message; }
  check('look() works at frame zero', frameZero !== null, frameZeroErr ?? `${frameZero.speedKmh} km/h`);
  idle.step(10);
  check('an idle session takes no damage', idle.damage.health === 1, `${idle.damage.health}`);
  check('and its transcript is empty', idle.log.length === 0, `${idle.log.length} lines`);
  const speed = new Session({ traffic: 0, peds: 0 });
  speed.drive({ throttle: 1 }).step(8);
  check('the car accelerates', speed.look().speedKmh > 30, `${speed.look().speedKmh} km/h`);
  let nanThrew = false;
  try { speed.drive({ steer: NaN }); } catch { nanThrew = true; }
  check('drive() refuses a non-finite control', nanThrew);

  console.log('\n§2  a wall');
  const crash = new Session({ traffic: 0, peds: 0 });
  crash.placeAt(576.2 - 26, -85, Math.PI / 2);
  // STOPPED AT THE FIRST IMPACT, NOT AFTER A FIXED 12 s. The wreck respawn added in §2b repairs
  // the car four seconds after it is destroyed, so a fixed run read health 1.000 and this arm
  // reported that driving into a building is free — the instrument measuring a different thing
  // than it did yesterday, which is the failure this whole file is about.
  for (let k = 0; k < 400 && crash.stats.impacts === 0; k++) crash.drive({ throttle: 1 }).step(0.05);
  crash.drive({ throttle: 0, brake: 1 }).step(0.5);
  check('driving into a building costs health', crash.damage.health < 1,
    `${crash.damage.health.toFixed(3)} after ${crash.t.toFixed(1)} s`);
  check('the transcript says so', crash.log.some((l) => l.line.startsWith('CRUNCH')),
    crash.log.map((l) => l.line)[0] ?? '(nothing)');
  // worstDv used to be set only inside the dynamic pass, so a head-on into a building reported
  // 0.00 — the first number a reader would quote.
  check('and the worst delta-v is recorded', crash.stats.worstDv > 2,
    `${crash.stats.worstDv} m/s`);
  const seen = crash.look();
  check('look() hides what a player cannot see', !('traffic' in seen) && !('at' in seen),
    Object.keys(seen).join(','));
  check('and debug() shows it', typeof crash.debug().at.x === 'number');

  /**
   * §2b A WRECK IS NOT THE END OF THE SESSION. A playtester measured the old behaviour
   * exactly: one crash at 47 km/h wrecks the car, and then "60 s of full throttle gives 0 km/h,
   * 60 s of full reverse gives 0 km/h, and the mission outcome stays 'running' for ever with the
   * objective still on screen". The only repair in the codebase was a console call.
   */
  console.log('\n§2b a wreck, and what happens next');
  const dead = new Session({ traffic: 0, peds: 0 });
  dead.startMission('marlin-street');
  dead.placeAt(576.2 - 40, -85, Math.PI / 2);
  for (let k = 0; k < 400 && !dead.damage.wrecked; k++) dead.drive({ throttle: 1 }).step(0.05);
  const wreckAt = { t: dead.t, x: dead.vehicle.position.x, z: dead.vehicle.position.z };
  check('a hard enough crash wrecks the car', dead.damage.wrecked && dead.stats.wrecks === 1,
    `wrecked ${dead.damage.wrecked} at t=${wreckAt.t.toFixed(1)}, worst dv ${dead.stats.worstDv}`);
  check('and the mission is called off', dead.mission.outcome !== OUTCOMES.RUNNING,
    `${dead.mission.outcome}`);
  check('the wreck is held, not resolved instantly', dead.stats.respawns === 0,
    `${dead.stats.respawns} respawns at t=${dead.t.toFixed(2)}`);
  dead.drive({ throttle: 0 }).step(WRECK_HOLD_S + 0.5);
  check('then a replacement car arrives', dead.stats.respawns === 1 && !dead.damage.wrecked
    && dead.damage.health === 1, `${dead.stats.respawns} respawns, health ${dead.damage.health}`);
  check('on a road, not in the wall it died against',
    !dead.blockers.resolveCircle(dead.vehicle.position.x, dead.vehicle.position.z, BODY_RADIUS)
    && dead.roads.nearestOn(dead.vehicle.position.x, dead.vehicle.position.z).dist < 1,
    `(${dead.vehicle.position.x.toFixed(0)}, ${dead.vehicle.position.z.toFixed(0)}), ` +
    `${dead.roads.nearestOn(dead.vehicle.position.x, dead.vehicle.position.z).dist.toFixed(2)} m from a centreline`);
  check('and it drives', (() => {
    dead.drive({ throttle: 1 }).step(4);
    return dead.look().speedKmh > 15;
  })(), `${dead.look().speedKmh} km/h after 4 s of throttle`);
  check('the transcript records the wreck and the replacement',
    dead.log.some((l) => l.line.startsWith('WRECK')) && dead.log.some((l) => l.line.startsWith('RESPAWN')),
    dead.log.filter((l) => l.line.startsWith('WRECK') || l.line.startsWith('RESPAWN'))
      .map((l) => l.line).join(' | ') || '(nothing)');
  check('the job it lost is back on the board',
    dead.board.available().some((m) => m.id === 'marlin-street'),
    dead.board.available().map((m) => m.id).join(', '));
  // THE CONTROL: a session that never wrecks never respawns, so the counter is not a clock.
  const alive = new Session({ traffic: 0, peds: 0 });
  alive.drive({ throttle: 0.5 }).step(20);
  check('a session that never wrecks never respawns',
    alive.stats.wrecks === 0 && alive.stats.respawns === 0,
    `${alive.stats.wrecks} wrecks, ${alive.stats.respawns} respawns, health ${alive.damage.health.toFixed(2)}`);

  /**
   * §3 and §4 are the two the old selftest could not have: they take the harness within
   * 3.3 m of a moving body, which is the point at which `_contacts` used to throw.
   *
   * THE ARM CHASES ITS SUBJECT rather than aiming once and hoping. A body that walks at 1.4 m/s
   * sidesteps a 12 m run-up often enough that a fixed aim is a flaky check, and a flaky check
   * gets deleted. Re-aiming every 0.1 s is deterministic, converges, and is honest about what it
   * is: this is the harness diagnosing itself, not a player driving.
   */
  const chase = (session, pick, seconds = 30,
    stop = (ss) => ss.stats.knockdowns + ss.stats.shunts > 0) => {
    for (let k = 0; k < seconds * 10; k++) {
      const target = pick(session);
      if (!target) { session.drive({ throttle: 0, brake: 1 }).step(0.1); continue; }
      const yaw = session._yaw();
      const dx = target.x - session.vehicle.position.x, dz = target.z - session.vehicle.position.z;
      let err = Math.atan2(dx, dz) - yaw;
      while (err > Math.PI) err -= Math.PI * 2;
      while (err < -Math.PI) err += Math.PI * 2;
      session.drive({ throttle: Math.abs(err) > 1.2 ? 0.25 : 0.55, brake: 0,
        steer: Math.max(-1, Math.min(1, err * 2)) }).step(0.1);
      if (stop(session)) return true;
      if (session.damage.wrecked) return false;
    }
    return false;
  };
  const nearest = (list, from) => {
    let best = null, bd = Infinity;
    for (const q of list) {
      const d = Math.hypot(q.x - from.x, q.z - from.z);
      if (d < bd) { bd = d; best = q; }
    }
    return best;
  };
  /** Main St @ Pineapple Ave: the district's own spawn is 167 m from the nearest pavement and
   *  fills 0 of 48 crowd slots, which tools/reaction-shots.mjs measured the hard way. */
  const CROWD_HOME = { x: 19, z: -6 };

  console.log('\n§3  a pedestrian');
  const town = new Session({ traffic: 0, peds: 48 });
  town.placeAt(CROWD_HOME.x, CROWD_HOME.z, Math.PI / 2);
  town.step(3);                                        // let the crowd fill and start walking
  check('the crowd fills in town', town.peds.positions().length > 8,
    `${town.peds.positions().length} of 48 slots`);
  const hitSomebody = chase(town, (ss) => nearest(ss.peds.positions().filter((q) => !q.down),
    ss.vehicle.position));
  check('driving at a pedestrian knocks them down', hitSomebody && town.stats.knockdowns > 0,
    `${town.stats.knockdowns} knockdowns, worst dv ${town.stats.worstDv} m/s`);
  check('the transcript carries the HIT', town.log.some((l) => l.line.startsWith('HIT')),
    town.log.filter((l) => l.line.startsWith('HIT')).map((l) => l.line)[0] ?? '(nothing)');
  check('and it is a crime', town.stats.crimes > 0 && town.wanted.stars > 0,
    `${town.stats.crimes} crimes, ${town.wanted.stars} stars`);
  // THE CONTROL IS A PARKED CAR IN THE SAME CROWD, not an empty street: it proves the count
  // tracks the CAR's motion and not merely the crowd's existence. Measured by a playtester:
  // over 40 s parked at four locations the nearest anybody came was 3.98 m, against a 2.71 m
  // contact reach, so a stationary car collects nothing.
  /**
   * ONE VICTIM, ONE OFFENCE. A casualty gets back up 4.42 s after it goes down and can then be
   * knocked down again, so without a per-victim window a player creeping back and forth over one
   * person collects a star every 4.42 s — measured against the real wanted system at five stars
   * from one pedestrian and a car that never left the spot. wanted.js's own refractory is per
   * CRIME TYPE, which is the right shape for a bumper grinding along a wall and the wrong one
   * here, because the thing being repeated is the person.
   */
  const victimId = town.lastHit ? town.lastHit.id : null;
  const crimesAfterFirst = town.stats.crimes;
  let hitsOnVictim = 1;
  for (let k = 0; k < 400 && hitsOnVictim < 2; k++) {
    const p = town.peds.peds.find((q) => q && q.id === victimId);
    // Only while they are on their feet: `_contacts` skips a body on the ground, and so does
    // the real game, so driving over a casualty is not a fresh offence.
    if (!p || p.down) { town.drive({ throttle: 0, brake: 1 }).step(0.1); continue; }
    const before = town.stats.knockdowns;
    const yaw = town._yaw();
    let err = Math.atan2(p.x - town.vehicle.position.x, p.z - town.vehicle.position.z) - yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    town.drive({ throttle: Math.abs(err) > 1.2 ? 0.25 : 0.5, brake: 0,
      steer: Math.max(-1, Math.min(1, err * 2)) }).step(0.1);
    if (town.stats.knockdowns > before && town.lastHit && town.lastHit.id === victimId) hitsOnVictim++;
  }
  check('the same person can be run over twice', hitsOnVictim >= 2,
    `${hitsOnVictim} hits on id ${victimId} by t=${town.t.toFixed(1)} s`);
  check('and the repeat is not a second offence', town.stats.pedRepeats > 0,
    `${town.stats.crimes} crimes total (${crimesAfterFirst} after the first hit), ` +
    `${town.stats.pedRepeats} repeats suppressed, ${town.wanted.stars} stars`);

  const parked = new Session({ traffic: 0, peds: 48 });
  parked.placeAt(CROWD_HOME.x, CROWD_HOME.z, Math.PI / 2);
  parked.drive({ handbrake: true }).step(30);
  check('a parked car in the same crowd hits nobody', parked.stats.knockdowns === 0,
    `${parked.stats.knockdowns} knockdowns in 30 s, ${parked.peds.positions().length} people about`);

  /**
   * AND CREEPING THROUGH A CROWD IS NOT A CRIME WAVE. The defect this arm is about cost a
   * playtester 232 of its 487 seconds on the first mission: `drop` carries
   * `wantedAtLeast: 1 -> ambush`, a brush at 1 km/h was a full `pedestrianHit` worth a star, and
   * the objective bounced fourteen times for 22 metres of progress. The twelve triggering hits
   * were at 1 to 6 km/h and every one reported a throw of 0.0-0.2 m.
   *
   * The arm has to CONTACT people to mean anything — `stats.tested` counts the bodies the
   * moving-body pass actually examined, so a creep that met nobody is not a pass.
   */
  const creep = new Session({ traffic: 0, peds: 48 });
  creep.placeAt(CROWD_HOME.x, CROWD_HOME.z, Math.PI / 2);
  for (let k = 0; k < 600; k++) {
    // 1 km/h: throttle just enough to hold a walking pace against the drag.
    creep.drive({ throttle: creep.vehicle.speed > 0.4 ? 0 : 0.12,
      brake: creep.vehicle.speed > 0.6 ? 0.3 : 0 }).step(0.1);
  }
  check('creeping through a crowd meets people', creep.stats.tested > 0,
    `${creep.stats.tested} bodies examined over ${creep.stats.distance.toFixed(0)} m at ` +
    `${(creep.stats.topSpeed).toFixed(1)} km/h top`);
  check('and knocks none of them down', creep.stats.knockdowns === 0 && creep.stats.crimes === 0,
    `${creep.stats.knockdowns} knockdowns, ${creep.stats.crimes} crimes, ` +
    `${creep.wanted.stars} stars`);
  // THE CONTROL: the same crowd at a speed above the floor does knock people down, so the arm
  // above is about the threshold and not about the crowd being out of reach.
  const fast = new Session({ traffic: 0, peds: 48 });
  fast.placeAt(CROWD_HOME.x, CROWD_HOME.z, Math.PI / 2);
  fast.step(3);
  const hitFast = chase(fast, (ss) => nearest(ss.peds.positions().filter((q) => !q.down),
    ss.vehicle.position));
  check('the same crowd at speed is a different story', hitFast && fast.stats.knockdowns > 0,
    `${fast.stats.knockdowns} knockdowns at up to ${fast.stats.topSpeed} km/h`);

  console.log('\n§4  a traffic car');
  const ram = new Session({ traffic: 30, peds: 0 });
  ram.placeAt(CROWD_HOME.x, CROWD_HOME.z, Math.PI / 2);
  ram.step(4);
  check('the fleet publishes', (ram.traffic._lastPositions ?? []).length > 0,
    `${(ram.traffic._lastPositions ?? []).length} cars`);
  /**
   * HEAD-ON, NOT A CHASE. The chase policy §3 uses cannot reach a traffic car: the nearest
   * published car is 128-184 m away down streets that bend, a straight-line aim drives through
   * the intervening block, and the arm wrecked itself on a building at t=16.6 s with `tested`
   * still at 0 — an arm that measured nothing while printing a number. The player car is instead
   * parked 16 m up the road IN FRONT of a moving car, facing it, and driven gently at it. The
   * traffic car holds its lane regardless, which is one of this round's findings and is exactly
   * what makes the contact certain.
   */
  let onc = null, oncD = Infinity;
  for (const q of ram.traffic._lastPositions ?? []) {
    if (!(q.v > 4)) continue;
    const d = Math.hypot(q.x - ram.vehicle.position.x, q.z - ram.vehicle.position.z);
    if (d < oncD) { oncD = d; onc = q; }
  }
  check('some car in the fleet is moving', !!onc,
    onc ? `id ${onc.id} at ${onc.v.toFixed(1)} m/s, ${oncD.toFixed(0)} m off` : 'none');
  /**
   * STEPPED ONE FRAME AT A TIME THROUGH THE CONTACT, so the arm can see the impulse rather
   * than infer it. `worstDrop` is the largest fall in speed inside a single 1/120 s frame: the
   * tyres can shed 11 m/s^2, which is 0.09 m/s in a frame, so anything above ~0.5 m/s can only
   * be a collision impulse. The first version of this arm checked `angularVelocity.y` instead
   * and a mutation that deleted `applyImpulseAt` outright still passed it, because the car was
   * already yawing from the steering — the check read a quantity the change does not own.
   */
  let worstDrop = 0;
  if (onc) {
    ram.placeAt(onc.x + Math.sin(onc.heading) * 16, onc.z + Math.cos(onc.heading) * 16,
      onc.heading + Math.PI);
    let prev = ram.vehicle.speed;
    for (let k = 0; k < 1500 && !ram.stats.shunts && !ram.damage.wrecked; k++) {
      ram.drive({ throttle: 0.4 }).step(DT);
      worstDrop = Math.max(worstDrop, prev - ram.vehicle.speed);
      prev = ram.vehicle.speed;
    }
  }
  check('ramming a traffic car shunts it', ram.stats.shunts > 0,
    `${ram.stats.shunts} shunts, worst dv ${ram.stats.worstDv} m/s`);
  check('the transcript carries the RAM', ram.log.some((l) => l.line.startsWith('RAM')),
    ram.log.filter((l) => l.line.startsWith('RAM')).map((l) => l.line)[0] ?? '(nothing)');
  // The impulse reaches the body: 0.5 * 1400 * dv newton-seconds on 1400 kg is dv/2 of velocity
  // change, so a 6 m/s ram is about 3 m/s in one frame. Without applyImpulseAt the car is pushed
  // out of the overlap and does not slow at all, and the harness answers "what does ramming feel
  // like" with a car that drove on through.
  check('and the player car takes the impulse from it', worstDrop > 0.5,
    `worst speed drop in one frame ${worstDrop.toFixed(2)} m/s ` +
    `(tyres alone can do ${(11 / HZ).toFixed(2)})`);
  // And the charge lands on the player's own health, which nothing asserted: a mutation that
  // charged `dv: 0` passed every other check in this file.
  check('the ram costs the player health', ram.damage.health < 1 && ram.damage.health > 0,
    `health ${ram.damage.health.toFixed(3)}, ` +
    `${ram.log.filter((l) => l.line.includes('into vehicle')).length} vehicle-kind records`);
  // THE CONTROL: the same stretch of road with no fleet at all. It must produce no shunt, which
  // is what says the arm above measured the fleet and not the kerb.
  const noFleet = new Session({ traffic: 0, peds: 0 });
  if (onc) {
    noFleet.placeAt(onc.x + Math.sin(onc.heading) * 16, onc.z + Math.cos(onc.heading) * 16,
      onc.heading + Math.PI);
    for (let k = 0; k < 150; k++) noFleet.drive({ throttle: 0.4 }).step(0.1);
  }
  check('the same road with no fleet shunts nothing', noFleet.stats.shunts === 0,
    `${noFleet.stats.shunts} shunts, health ${noFleet.damage.health.toFixed(2)}`);

  console.log('\n§5  a mission, to its end');
  const mis = new Session({ traffic: 0, peds: 0 });
  const hud0 = mis.startMission('shakedown');
  check('a mission starts with an objective', !!(hud0 && hud0.objective), hud0 ? hud0.objective : 'null');
  /**
   * DRIVEN TO ITS OWN WAYPOINTS, NOT TO A HARD-CODED ONE. The first version of this arm drove
   * straight to the marina because that was where shakedown's last stage ended, and when stage
   * b's marker moved off the spawn — which was the defect being fixed — the arm reported the
   * mission simply not passing. An arm that only works on one authoring of the mission is not
   * testing the mission layer.
   */
  const legs = [];
  for (let k = 0; k < 6; k++) {
    const h = mis.mission.hud();
    if (!h) break;
    if (!h.waypoint) { mis.step(0.5); continue; }
    const r = driveTo(mis, h.waypoint.x, h.waypoint.z, { maxSpeed: 14, timeout: 120 });
    legs.push(`${h.objective} -> ${r.arrived ? r.seconds + ' s' : r.why}`);
    if (!r.arrived) break;
    mis.step(0.5);                                  // a beat for the reach trigger to fire
  }
  console.log(`    ${legs.join('\n    ')}`);
  check('the mission can be driven to its end', mis.mission.outcome === OUTCOMES.PASSED,
    `${mis.mission.outcome} after ${legs.length} legs`);
  check('and every stage was visited', mis.mission.report().visited.length
    === mis.mission.mission.stages.length,
    mis.mission.report().visited.join(' -> '));
  // THE FRAME A MISSION ENDS used to throw: hud() returns null the instant the outcome stops
  // being RUNNING, so this harness had never seen a mission finish.
  let afterErr = null;
  try { mis.step(2); mis.look(); } catch (e) { afterErr = e.message; }
  check('the session survives the frame it ends on', afterErr === null, afterErr ?? 'no throw');
  check('the transcript says it passed', mis.log.some((l) => l.line.includes('MISSION PASSED')),
    mis.log.filter((l) => l.line.startsWith('MISSION')).map((l) => l.line).join(' | ') || '(nothing)');
  const stalled = new Session({ traffic: 0, peds: 0 });
  stalled.startMission('shakedown');
  stalled.step(30);
  check('a mission nobody drives stays running', stalled.mission.outcome === OUTCOMES.RUNNING,
    stalled.mission.outcome);

  /**
   * §5b  THE WAY A PLAYER ACTUALLY STARTS ONE. Until this round the only door into either
   * authored mission was `window.__district.startMission(id)` from the browser console, and a
   * playtester led its report with it. This arm never calls startMission: it drives to the
   * marker and the marker starts the job.
   */
  console.log('\n§5b a mission found by driving into it');
  const found = new Session({ traffic: 0, peds: 0 });
  check('nothing is running at the spawn', found.mission.mission === null
    && found.board.available().length >= 2, `${found.board.available().length} on offer`);
  found.step(0.5);
  check('and no job fires on the first frame', found.mission.mission === null,
    found.mission.mission ? found.mission.mission.id : 'none');
  const job = found.board.available().find((m) => m.id === 'shakedown');
  const toMarker = driveTo(found, job.start.x, job.start.z, { maxSpeed: 12, timeout: 120 });
  check('the pickup is reachable from the spawn', toMarker.arrived, JSON.stringify(toMarker));
  check('driving into the marker starts the job',
    found.mission.mission && found.mission.mission.id === 'shakedown',
    found.mission.mission ? found.mission.mission.id : 'nothing started');
  check('the transcript says which job it was',
    found.log.some((l) => l.line.startsWith('MISSION shakedown')),
    found.log.map((l) => l.line).find((l) => l.startsWith('MISSION')) ?? '(nothing)');
  check('and it is off the board while it runs',
    found.look().offer === null, JSON.stringify(found.look().offer));
  // THE CONTROL: the same drive with the marker already passed must start nothing. Without it,
  // "the job started" could just mean "a job starts wherever you go".
  const done = new Session({ traffic: 0, peds: 0 });
  done.board.record('shakedown', OUTCOMES.PASSED);
  done.board.record('marlin-street', OUTCOMES.PASSED);
  driveTo(done, job.start.x, job.start.z, { maxSpeed: 12, timeout: 120 });
  check('a job already passed does not start again', done.mission.mission === null,
    done.mission.mission ? done.mission.mission.id : 'nothing, correctly');
  // And a player is told a marker is there before they are standing in it.
  const nearby = new Session({ traffic: 0, peds: 0 });
  const r0 = nearby.board.radiusOf(job);
  nearby.placeAt(job.start.x + r0 * 2, job.start.z, 0);
  nearby.step(0.1);
  check('an offer is announced from outside its radius', nearby.look().offer !== null
    && nearby.mission.mission === null, JSON.stringify(nearby.look().offer));

  console.log(`\n${pass} passed, ${fail} failed in ${((Date.now() - t00) / 1000).toFixed(1)} s ` +
    'of wall clock');
  process.exit(fail ? 1 : 0);
} else {
  const s = new Session();
  const t0 = Date.now();
  s.say('a demo session: drive out of the bayfront, then take the first mission');
  s.startMission('marlin-street');
  s.drive({ throttle: 0.8, steer: 0 }).step(6);
  console.log('after six seconds of throttle:', JSON.stringify(s.look(), null, 1));
  s.drive({ throttle: 0, brake: 1 }).step(3);
  console.log('\nTRANSCRIPT');
  console.log(s.transcript() || '  (nothing happened)');
  console.log('\nDEBUG', JSON.stringify(s.debug(), null, 1));
  console.log(`\n${s.t.toFixed(0)} s of game time in ${((Date.now() - t0) / 1000).toFixed(1)} s ` +
    `of wall clock — ${(s.t / ((Date.now() - t0) / 1000)).toFixed(0)}x real time`);
}
