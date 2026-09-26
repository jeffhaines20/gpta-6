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
import { Vehicle, BODY_RADIUS } from '../src/vehicle.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex } from '../src/blockers.js';
import { DamageModel, IMPACT, dynamicContact } from '../src/damage.js';
import { WantedSystem } from '../src/wanted.js';
import { Traffic } from '../src/traffic.js';
import { Pedestrians } from '../src/pedestrians.js';
import { RoadGraph, followPath } from '../src/roadpath.js';
import { MissionRunner } from '../src/mission.js';
import { MISSIONS } from '../src/missions.js';
import { hardnessFor } from '../src/audio.js';

const HZ = 120, DT = 1 / HZ;
const OTHER_CAR = { bodyRadius: 0.95, bodyMass: 1400 };
const PERSON = { bodyRadius: 0.35, bodyMass: 80 };
const BODY_ENCLOSING = Math.hypot(0.95, 2.15);
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
    this.t = 0;
    this.log = [];
    this.stats = { crashes: 0, crimes: 0, knockdowns: 0, shunts: 0, sounds: 0,
      worstDv: 0, distance: 0, topSpeed: 0 };
    this._lastPos = { x: 0, z: 0 };
    this._controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this._route = null;
    // Every damage record, as a line in the transcript — the same hook the crash voice uses.
    this.damage.onImpact = (rec) => {
      this.stats.sounds++;
      if (!(rec.dv > 0.6)) return;
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

  /** What the player is doing with the controls. Same shape src/input.js produces. */
  drive({ throttle = 0, brake = 0, steer = 0, handbrake = false } = {}) {
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
      if (this.mission.mission) {
        const before = this.mission.hud().objective;
        this.mission.update(DT, this._snapshot());
        const after = this.mission.hud().objective;
        if (after !== before) this.say(`OBJECTIVE  ${after ?? '(none)'}`);
      }
      this.t += DT;
    }
    return this;
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

  _crime(name) {
    const r = this.wanted.reportCrime(name,
      { at: { x: this.vehicle.position.x, z: this.vehicle.position.z } });
    if (!r.applied) return;
    this.stats.crimes++;
    this.say(`CRIME   ${name} — ${this.wanted.stars} star${this.wanted.stars === 1 ? '' : 's'}`);
  }

  /**
   * The moving-body pass, in the same shape district/main.js runs it: the worst contact of
   * each KIND reacts, and the damage charge is the single worst. See main.js's own comment
   * about why the worst-only rule is right for the charge and wrong for everything else.
   */
  _contacts() {
    const v = this.vehicle;
    const speed = Math.hypot(v.velocity.x, v.velocity.z);
    if (!(speed > 0.3)) return;
    const base = { carX: v.position.x, carZ: v.position.z, carVX: v.velocity.x,
      carVZ: v.velocity.z, carMass: v.mass ?? 1400, yaw: this._yaw() };
    let worstPed = null, worstCar = null;
    for (const c of this.traffic._lastPositions) {
      const dx = c.x - base.carX, dz = c.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + OTHER_CAR.bodyRadius) ** 2) continue;
      const hit = dynamicContact({ ...base, ...OTHER_CAR, bodyX: c.x, bodyZ: c.z,
        bodyVX: Math.sin(c.heading ?? c.yaw ?? 0) * (c.v ?? 0),
        bodyVZ: Math.cos(c.heading ?? c.yaw ?? 0) * (c.v ?? 0) });
      if (hit && (!worstCar || hit.dv > worstCar.dv)) { worstCar = hit; worstCar.id = c.id; }
    }
    for (const p of this.peds.positions()) {
      if (p.down) continue;
      const dx = p.x - base.carX, dz = p.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + PERSON.bodyRadius) ** 2) continue;
      const hit = dynamicContact({ ...base, ...PERSON, bodyX: p.x, bodyZ: p.z });
      if (hit && (!worstPed || hit.dv > worstPed.dv)) { worstPed = hit; worstPed.i = p.i; }
    }
    if (!worstPed && !worstCar) return;
    const tx = v.velocity.x / speed, tz = v.velocity.z / speed;
    if (worstPed) {
      const r = this.peds.hit(worstPed.i, { speed, dirX: tx, dirZ: tz });
      if (r) {
        this.stats.knockdowns++;
        this.say(`HIT     a pedestrian at ${(speed * 3.6).toFixed(0)} km/h — ` +
          `${r.fatal ? 'they do not get up' : 'thrown ' + r.throwWanted.toFixed(1) + ' m'}`);
        this._crime(r.fatal ? 'pedestrianKilled' : 'pedestrianHit');
      }
    }
    if (worstCar) {
      const r = this.traffic.hit(worstCar.id, { dv: worstCar.dv, dirX: tx, dirZ: tz });
      if (r) {
        this.stats.shunts++;
        this.say(`RAM     a traffic car, ${r.dv.toFixed(1)} m/s — knocked ${r.push.toFixed(1)} m`);
      }
    }
    const worst = (worstCar && (!worstPed || worstCar.dv > worstPed.dv)) ? worstCar : worstPed;
    const kind = worst === worstCar ? IMPACT.vehicle : IMPACT.pedestrian;
    if (worst.dv > this.stats.worstDv) this.stats.worstDv = +worst.dv.toFixed(2);
    const rec = this.damage.impact({ dv: worst.dv, kind, dirX: worst.dirX, dirZ: worst.dirZ,
      speed });
    if (rec.crime && kind !== IMPACT.pedestrian) this._crime(rec.crime);
    if (kind !== IMPACT.pedestrian) {
      v.position.x += worst.nx * worst.depth;
      v.position.z += worst.nz * worst.depth;
    }
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

  /** The route line the HUD draws, as a player would follow it. */
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
    for (const c of this.traffic._lastPositions) {
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
      traffic: this.traffic._lastPositions.length,
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
export function driveTo(session, x, z, { maxSpeed = 16, timeout = 180 } = {}) {
  const from = session.vehicle.position;
  const path = session.roads.path(from.x, from.z, x, z, { spacing: 4, offset: 3, smoothPasses: 2 });
  if (!path || !path.points || path.points.length < 2) return { arrived: false, why: 'no route' };
  const state = { i: 0 };
  const t0 = session.t;
  while (session.t - t0 < timeout) {
    const v = session.vehicle;
    const f = followPath(path.points, { x: v.position.x, z: v.position.z, yaw: session._yaw(),
      speed: v.speed }, state, { maxSpeed });
    if (f.done) return { arrived: true, seconds: +(session.t - t0).toFixed(1) };
    session.drive(f.controls).step(DT * 8);
    if (session.damage.wrecked) return { arrived: false, why: 'wrecked', seconds: +(session.t - t0).toFixed(1) };
  }
  return { arrived: false, why: 'timeout' };
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
   * A harness that cannot fail is not a harness. Two arms: a session that drives into a
   * building must lose health and say so in its transcript, and one that idles must not.
   */
  let pass = 0, fail = 0;
  const check = (name, ok, detail) => {
    if (ok) { pass++; console.log(`  ok   ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  FAIL ${name}  ${detail ?? ''}`); }
  };
  console.log('PLAYTEST HARNESS SELFTEST');
  const idle = new Session({ traffic: 0, peds: 0 });
  idle.step(10);
  check('an idle session takes no damage', idle.damage.health === 1, `${idle.damage.health}`);
  check('and its transcript is empty', idle.log.length === 0, `${idle.log.length} lines`);
  const crash = new Session({ traffic: 0, peds: 0 });
  crash.placeAt(576.2 - 26, -85, Math.PI / 2);
  crash.drive({ throttle: 1 }).step(12);
  check('driving into a building costs health', crash.damage.health < 1,
    `${crash.damage.health.toFixed(3)}`);
  check('and the transcript says so', crash.log.some((l) => l.line.startsWith('CRUNCH')),
    crash.log.map((l) => l.line)[0] ?? '(nothing)');
  const seen = crash.look();
  check('look() hides what a player cannot see', !('traffic' in seen) && !('at' in seen),
    Object.keys(seen).join(','));
  check('and debug() shows it', typeof crash.debug().at.x === 'number');
  const speed = new Session({ traffic: 0, peds: 0 });
  speed.drive({ throttle: 1 }).step(8);
  check('the car actually accelerates', speed.look().speedKmh > 30, `${speed.look().speedKmh} km/h`);
  console.log(`\n${pass} passed, ${fail} failed`);
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
