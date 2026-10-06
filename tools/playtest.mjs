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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as THREE from '../vendor/three.module.min.js';
import { Vehicle, BODY_SAMPLES, BODY_RADIUS, BODY_ENCLOSING,
  composeStuck, STUCK_HOLD_S } from '../src/vehicle.js';
import { Player } from '../src/player.js';
import { FlatGround } from '../src/ground.js';
import { BlockerIndex, districtBounds, worldFence } from '../src/blockers.js';
import { DamageModel, IMPACT, dynamicContact, HALF_EXTENT,
  Garage, composeGarage } from '../src/damage.js';
import { WantedSystem, VictimWindow, composeWanted, composeLaw, BUST_HOLD_S, bindPursuit,
  SCENE_STOP_MS } from '../src/wanted.js';
import { Traffic } from '../src/traffic.js';
import { Pedestrians } from '../src/pedestrians.js';
import { RoadGraph, followPath, ROUTE_LANE_M } from '../src/roadpath.js';
import { PursuitUnits } from '../src/pursuit.js';
import { MissionRunner, OUTCOMES, MissionBoard, OFFER_RADIUS_M } from '../src/mission.js';
import { composeBand, objectiveLine, MINIMAP_REACH_M, PULL_MIN } from '../src/hud.js';
import { MISSIONS } from '../src/missions.js';

const HZ = 120, DT = 1 / HZ;

/**
 * THE GARAGE IS AT THE PAGE'S OWN POSITION. `district/main.js` holds the authoritative copy and
 * `tools/mission-test.mjs` asserts the two agree, because a harness that repairs the car somewhere
 * the page does not is a harness whose repair findings are about a different game.
 */
const GARAGE_AT = { x: -67.9, z: 60.3 };

/**
 * THE IDENTITY OF AN OBJECTIVE AS A TRANSCRIPT EVENT: the stage it belongs to and the words it
 * says, with the DISTANCE deliberately left out. Both halves were paid for in measurement; see
 * the call site in `step()`.
 */
function objKey(h, stageId) {
  if (!h) return null;
  const o = h.objective;
  const text = typeof o === 'string' ? o : (o && o.text) ?? '';
  return `${stageId ?? ''}\u0000${text}`;
}
/** district/main.js's own reach and the side offset it steps out to. See `exit`/`enter`. */
const ENTER_RANGE = 3.6, EXIT_SIDE_M = 1.9;
/**
 * SRC/PLAYER.JS AND EVERYTHING ELSE HERE DISAGREE ABOUT THE SIGN OF X, and this is the one place
 * that knows it. `moveAxis` returns y = +1 for W, and player.js maps that to a wish of
 * `(-sin(cameraYaw), cos(cameraYaw))` — mirrored in x against the convention `placeAt`, `_yaw()`
 * and the vehicle all use, where forward at yaw t is `(sin t, cos t)`.
 *
 * Feeding a vehicle-convention yaw straight in as `cameraYaw` therefore points the view at the
 * mirror image of where it was asked to look. Measured: stepping out of a car at yaw 0 put the
 * person 1.9 m to its left with the view set to -pi/2, and walking forward took them back INTO the
 * car — 0.32 m in 4 s against a 3.2 m/s walk speed, because the car collider stopped them. Walking
 * "at" the car from 6 m out ended 20.89 m away.
 *
 * `camYawFor(t)` converts a world heading in this harness's convention into player.js's, so the
 * whole API keeps ONE convention and the mirror lives here.
 */
const camYawFor = (t) => Math.atan2(-Math.sin(t), Math.cos(t));
/** The world direction a given cameraYaw looks along, in player.js's own convention. */
const camFwd = (c) => ({ x: -Math.sin(c), z: Math.cos(c) });
const OTHER_CAR = { bodyRadius: 0.95, bodyMass: 1400 };
const PERSON = { bodyRadius: 0.35, bodyMass: 80 };
/** One victim, one offence, within this window. district/main.js's own figure and reason. */
const PED_CRIME_WINDOW_S = 20;
/** How long a wreck is held before a replacement arrives. district/main.js's own figure. */
const WRECK_HOLD_S = 4;
/** And how long the band holds the line saying a mission ended. main.js's own figure. */
const MISSION_END_S = 6;
/**
 * A respawn point within LOOP_R of one of the last LOOP_KEEP, inside LOOP_S seconds, is a cycle.
 * district/main.js's own figures: the loop this catches has two points 53 m apart, which a 40 m
 * test on the wrong pair of positions missed entirely.
 */
const LOOP_R = 60, LOOP_S = 45, LOOP_KEEP = 3;
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
    /** The edge of the world: the road network's extent plus a margin. See worldFence. */
    this.worldBox = districtBounds(this.district);
    this.outsideWorld = 0;
    this.vehicle = new Vehicle();
    this.damage = new DamageModel();
    this.vehicle.blockers = this.blockers;
    this.vehicle.damage = this.damage;
    this.ground = new FlatGround(0);
    /**
     * ON FOOT. Three authored stage transitions could never fire from this harness, because
     * `_snapshot()` reported `inVehicle: true` unconditionally: `marlin-street`'s
     * `eastbound -> backToCar` and `backToCar -> eastbound`, and `shakedown`'s `b -> a`. Both
     * playtesters reported on the driving and neither could get out of the car.
     *
     * src/player.js is used AS IT IS rather than paraphrased. It is pure — Vector3 arithmetic, no
     * scene, no GL — and it takes exactly what this harness already holds: a ground, the blocker
     * index, and the car as a moving obstacle. The one thing it needs that does not exist here is
     * an `input`, so `walk()` fills a stub with the same two methods district/main.js's real input
     * exposes to it. CLAUDE.md's `_contacts` lesson is why: a paraphrase of the game measures
     * something else, and this file has already made that mistake once.
     */
    this.mode = 'car';
    this.player = new Player();
    /**
     * THE CAMERA'S YAW, WHICH IS NOT THE PLAYER'S. src/player.js's movement is camera-relative and
     * it turns the body to face whatever the axis asked for, so feeding the player's OWN live yaw
     * back in as the camera makes the frame rotate with them: `walk({ forward: -1 })` then turns
     * them round and walks them forward again, and a scenario trying to retreat goes the wrong way.
     * Measured on the first version: 4 s out from the car reached 12.7 m, and 10 s of
     * `forward: -1` took that to 36.0 m instead of back to 0.
     *
     * district/main.js passes `chase.yaw`, a camera that does not spin with the body, so the
     * harness keeps its own and only `walk({ turn })` moves it. `forward: 1` is then "the way the
     * view faces" and `forward: -1` is "back away", which is what both mean in the game.
     */
    this._camYaw = 0;
    /** The car as an obstacle to a person on foot — district/main.js's own `carCollider`. */
    this._carCollider = { x: 0, z: 0, y: 0, hx: 1.25, hy: 1.5, hz: 2.4 };
    /**
     * The three methods src/player.js reads off an input, and no more — enumerated from the module
     * (`grep -o "input\.[a-zA-Z]*"`) rather than guessed, because the first version omitted `hit`
     * and threw `input.hit is not a function` on the first on-foot frame. `jump` is a one-shot, so
     * `hit` consumes it the way a real edge-triggered key does.
     */
    this._footInput = { _ax: 0, _ay: 0, _run: false, _jump: false,
      moveAxis() { return { x: this._ax, y: this._ay }; },
      down(k) { return this._run && (k === 'ShiftLeft' || k === 'ShiftRight'); },
      hit(k) {
        if (k !== 'Space' || !this._jump) return false;
        this._jump = false;                       // consumed, like a key edge
        return true;
      } };
    this.wanted = new WantedSystem();
    /**
     * EVERY CRIME REACHES THE TRANSCRIPT, including the ones this harness does not file itself.
     * `_crime()` counts and narrates the offences the contact pass reports, and `hitAndRun` is
     * filed from INSIDE `wanted.update` when the player leaves the scene of an injury — so it
     * would raise the star level with nothing in the log saying why, which is the one thing a
     * playtester cannot diagnose. Listening to the module covers both routes with one path.
     *
     * `_crime()` narrates before this fires for its own reports, so the guard is on the id it
     * already logged this frame rather than a general de-duplication.
     */
    this.wanted.on('crime', (p) => {
      if (!p.applied || p.id === this._lastFiled) return;
      this.stats.crimes++;
      this.say(`CRIME   ${p.id} — ${this.wanted.stars} star${this.wanted.stars === 1 ? '' : 's'}`);
    });
    /**
     * THE POLICE, WHICH THIS HARNESS DID NOT HAVE. Measured before it did: five stars, engine off,
     * never moving, `units 6/0` — six units requested by the wanted system and ZERO reporting a
     * position, because nothing built a pursuit layer — and the level bled 4* to 0 over 87 s while
     * the player sat still. So the escape was automatic and unconditional, and both playtesters'
     * reports on evasion were measured against a game with no police in it. The browser had them
     * all along, through district/main.js's own bridge.
     *
     * `PursuitUnits` is used AS IT IS, for the reason src/player.js is: it is pure enough to build
     * against `{ add() {} }` and its car positions live in an InstancedMesh matrix, which
     * `getMatrixAt` reads in node. The bridge below is the same duck-typed shim main.js has, cut
     * down to what this harness honours — no light bars, no visibility, no manual override.
     */
    this.pursuit = new PursuitUnits(scene, this.district, { count: 8, seed: opts.seed ?? 0 });
    this.pursuit.units.fill(null);
    this._pursuitIds = [];
    this._pursuitOut = [];
    this._pursuitMat = new THREE.Matrix4();
    this._pursuitVec = new THREE.Vector3();
    this.traffic = new Traffic(scene, this.district, { count: opts.traffic ?? 30 });
    /**
     * The bridge. `count` is what the plan asks for, and the slots above it are nulled so the
     * fleet never drives cars the wanted system has not requested — the same masking main.js does
     * with `pursuit.count` and `mesh.count`, minus the mesh.
     */
    const bridge = {
      spawnUnit: (id) => { this._pursuitIds.push(id); this._fleet(this._pursuitIds.length); },
      releaseUnit: (id) => {
        const k = this._pursuitIds.indexOf(id);
        if (k < 0) return;
        this._pursuitIds.splice(k, 1);
        this.pursuit.units.splice(k, 1); this.pursuit.units.push(null);
        this._fleet(this._pursuitIds.length);
      },
      setUnitCount: (n) => this._fleet(Math.min(n, 8)),
      setTarget: (x, z) => { this._pursuitTarget.x = x; this._pursuitTarget.z = z; },
      setSpeedMultiplier: (m) => { if (m > 0) this.pursuit.speed = 22 * m; },
      setGiveUpRadius: (r) => { if (r > 0) this.pursuit.giveUpRadius = r; },
      getUnitPositions: () => this._unitPositions(),
    };
    this._pursuitTarget = { x: 0, z: 0 };
    this.wantedBridge = bindPursuit(this.wanted, bridge, { baseSpeed: 22 });
    /**
     * BEING BUSTED, the harness's half of it. district/main.js runs the same shape: the module
     * clears the level and this pays for it — the mission goes, the car comes back repaired, and
     * a player who was on foot is put back in it rather than left beside a car that has moved.
     */
    this.wanted.on('busted', (e) => {
      if (this._bustedFor > 0) return;
      this._bustedFor = 1e-9;
      this.stats.busts++;
      this.say(`BUSTED  a unit held you for ${BUST_HOLD_S} s — released in ${BUST_HOLD_S} s` +
        (e.cooperated ? ' (you stopped at the scene, so the job stands)' : ''));
      // Cooperating costs time, not the job: see the same listener in district/main.js.
      if (this.mission.mission && this.mission.outcome === OUTCOMES.RUNNING) {
        if (e.cooperated) this.stats.cooperated++;
        else this.mission.abort('busted');
      }
    });
    this._bustedFor = 0;
    this.traffic.clearAt = (x, z, r) => !this.blockers.resolveCircle(x, z, r);
    /**
     * AND THE PURSUIT GETS THE SAME PREDICATE, for the reason the line above exists at all:
     * CLAUDE.md records `traffic-selftest` building its Traffic with no `clearAt`, so the gate
     * measuring cars-inside-buildings was measuring a configuration the game never runs.
     * `src/pursuit.js` holds a target only when an officer can WALK from the stopped car to the
     * player, and with no predicate that walk is unrefused — so a harness without this line
     * would report arrests through walls that the page refuses, in the direction that flatters.
     * The default radius matches district/main.js's `wirePursuit`.
     */
    this.pursuit.clearAt = (x, z, r = 0.95) => !this.blockers.resolveCircle(x, z, r);
    /**
     * THE SEED REACHES THE CROWD, which it did not. `Session({ seed })` was passed to the
     * pursuit and the traffic and NOT to `Pedestrians`, so every seed ran the identical crowd:
     * `src/pedestrians.js` falls back to `0x9EDE5719` and three "different seeds" placed the same
     * 64 people in the same places. Found while measuring the junction trim — three seeds gave
     * byte-identical hit counts, which is what one sample printed three times looks like, and is
     * the shape CLAUDE.md records as a control that is not one.
     */
    this.peds = new Pedestrians(scene, this.district,
      { count: opts.peds ?? 64, seed: opts.seed ?? 0 });
    /**
     * THE GARAGE, at the same place and with the same three constants district/main.js gives it,
     * read from the modules that own them rather than copied. A harness whose garage is 12 m
     * wide against a page whose garage is something else is a harness that cannot be used to
     * judge the feature.
     */
    this.garage = new Garage({ x: GARAGE_AT.x, z: GARAGE_AT.z,
      radius: OFFER_RADIUS_M, holdS: BUST_HOLD_S, stopMs: SCENE_STOP_MS });
    this._garageState = this.garage.report();
    this.roads = new RoadGraph(this.district, { blockers: this.blockers, carRadius: BODY_RADIUS });
    this.mission = new MissionRunner();
    /**
     * THE BOARD, so a playtester exercises the loop a player has rather than the one a console
     * has. `startMission()` is still here for a scenario that wants to jump straight into a
     * mission, but the honest way in is to drive into a marker, and that is what the real page
     * now does too.
     */
    this.board = new MissionBoard(MISSIONS);
    /**
     * THE INTENTS, because without them the flagship's only pursuit beat is two seconds long.
     *
     * `MissionRunner` does not touch the wanted system; it EMITS what it wants the host to do and
     * `district/main.js:668` applies it. This harness never listened, so `ambush`'s
     * `onEnter: { setWanted: 2 }` landed nowhere — and `ambush` exits on
     * `all[timer 2 s, evaded]`, so with nobody wanted `evaded` was already true and the stage
     * lasted exactly its 2 s dwell timer. A playtester found it, wired it by hand, and measured
     * the same stage at 30.0 s; every ambush number in their report came from the wired arm. A
     * playtester who did not wire it would report the mission's chase as two seconds of nothing.
     *
     * Unhonourable intents are RECORDED rather than dropped, the same way main.js records them:
     * this harness has no audio graph and no pursuit units, so a `stinger` or a `setUnitGoal`
     * should show up in the audit as not honoured instead of looking like it worked.
     */
    this.missionUnhonoured = new Set();
    this.mission.on('intent', (i) => {
      if (typeof i.setWanted === 'number') this.wanted.setStars(i.setWanted, `mission:${i.stage}`);
      else if (i.stinger) this.missionUnhonoured.add(`stinger:${i.stinger}`);
      else if (i.setUnitGoal) this.missionUnhonoured.add(`setUnitGoal:${i.setUnitGoal}`);
      else if (i.setSpawnBand) this.missionUnhonoured.add(`setSpawnBand:${i.setSpawnBand}`);
    });
    this.mission.on('finished', (e) => {
      if (!this.mission.mission) return;
      // Latched, so a mission that ends where it started does not restart on the next frame.
      this.board.record(this.mission.mission.id, e.outcome).arm(this.mission.mission.id);
      // And the band says so for MISSION_END_S, because hud() goes null the instant it ends and
      // without this a finished mission and no mission at all look identical from the seat.
      const title = this.mission.mission.title;
      this._ended = e.outcome === OUTCOMES.PASSED
        ? { objective: 'MISSION COMPLETE', subtitle: title }
        : { objective: `MISSION ${String(e.outcome).toUpperCase()}`,
          subtitle: `${title}${e.reason ? ' — ' + e.reason : ''} — the marker is back on the map` };
      this._endFor = MISSION_END_S;
    });
    this.t = 0;
    this.log = [];
    // `impacts` is every damage record; `voices` is the subset src/audio.js would actually
    // play. Those read 458 and 3 over 76 m of ordinary driving, because the median record is
    // 0.007 m/s of kerb rumble and audio.js refuses anything under 0.6 — so a single number
    // called "sounds" was wrong by two orders of magnitude, in the alarming direction.
    /** The player position handed to the wanted system, with the host's `held` verdict on it. */
    this._wantedPlayer = { x: 0, z: 0, held: false, teleported: false };
    this._teleported = false;
    this.stats = { busts: 0, released: 0, cooperated: 0, crashes: 0, crimes: 0, knockdowns: 0, fatal: 0, shunts: 0,
      impacts: 0, voices: 0, tested: 0, contacts: 0, pedRepeats: 0, runOvers: 0,
      wrecks: 0, respawns: 0, loopsBroken: 0, worstDv: 0, distance: 0, topSpeed: 0,
      repairs: 0 };
    this._lastPos = { x: 0, z: 0 };
    this._controls = { throttle: 0, brake: 0, steer: 0, handbrake: false };
    this._route = null;
    this._offer = null;
    this._ended = null;
    this._endFor = 0;
    this._wreckFor = 0;
    this._respawns = [];
    this._outcome = OUTCOMES.RUNNING;
    /** When each pedestrian was last reported as a crime, by their own id. See _contacts. */
    this._victims = new VictimWindow(PED_CRIME_WINDOW_S);
    /** Set while `_crime` is filing, so the module listener does not count the same report twice. */
    this._lastFiled = null;
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
    // ON FOOT, MOVE THE PERSON TOO, or a teleport leaves them standing in the street they came
    // from while every reader that follows the active body reports the old position.
    if (this.mode === 'foot') {
      this.player.position.set(x + EXIT_SIDE_M, this.player.position.y, z);
      this.player.velocity.set(0, 0, 0);
      this.player.yaw = yaw;
      this._camYaw = camYawFor(yaw);
    }
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

  /**
   * STEP OUT. district/main.js's `toggleVehicle` rules, with its numbers: the player appears
   * `EXIT_SIDE_M` to the car's left, facing that way, at rest.
   *
   * There is no enter/exit animation lock here and that is a deliberate difference, stated rather
   * than hidden: main.js holds an `ENTER_TIME` transition through its state machine, which exists
   * for the camera and the pose. A harness that reproduced the lock would be testing the FSM, and
   * what these three stage transitions need is the `inVehicle` flag flipping.
   */
  exit() {
    this._teleported = true;
    if (this.mode === 'foot') return false;
    const yaw = this._yaw();
    // The car's own left, which is what main.js takes: (-1,0,0) through the body quaternion.
    const sx = -Math.cos(yaw), sz = Math.sin(yaw);
    this.player.position.set(
      this.vehicle.position.x + sx * EXIT_SIDE_M, 0,
      this.vehicle.position.z + sz * EXIT_SIDE_M);
    this.player.position.y = this.ground.heightAt
      ? this.ground.heightAt(this.player.position.x, this.player.position.z) : 0;
    this.player.velocity.set(0, 0, 0);
    this.player.yaw = Math.atan2(sx, sz);
    // The VIEW looks the way they stepped, in player.js's convention. See camYawFor.
    this._camYaw = camYawFor(this.player.yaw);
    this.mode = 'foot';
    this._footInput._ax = 0; this._footInput._ay = 0; this._footInput._run = false;
    this.say(`OUT     stepped out at (${this.player.position.x.toFixed(0)}, ` +
      `${this.player.position.z.toFixed(0)})`);
    return true;
  }

  /** Get back in, if close enough. main.js's `ENTER_RANGE`. */
  enter() {
    this._teleported = true;
    if (this.mode === 'car') return false;
    const d = Math.hypot(this.player.position.x - this.vehicle.position.x,
      this.player.position.z - this.vehicle.position.z);
    if (d > ENTER_RANGE) return false;
    this.mode = 'car';
    this._footInput._ax = 0; this._footInput._ay = 0; this._footInput._run = false;
    this.say(`IN      back in the car (${d.toFixed(1)} m away)`);
    return true;
  }

  /** How far the car is, for a scenario deciding whether `enter()` will work. */
  get carRange() {
    return this.mode === 'car' ? 0
      : Math.hypot(this.player.position.x - this.vehicle.position.x,
        this.player.position.z - this.vehicle.position.z);
  }

  /**
   * WALK. The on-foot analogue of `drive()`, and the same refusal: a non-finite axis is a
   * scenario bug, not a world to report on.
   *
   * `forward`/`right` are the move axis src/player.js reads, in ITS convention — movement is
   * camera-relative there, and the harness has no camera, so the player's own yaw is the frame.
   * That makes `forward: 1` mean "the way they are facing", which is what a scenario wants.
   */
  walk({ forward = 0, right = 0, run = false, turn = null, jump = false } = {}) {
    for (const [k, n] of [['forward', forward], ['right', right]]) {
      if (!Number.isFinite(n)) throw new Error(`walk(): ${k} is ${n}. A control input has to be ` +
        `a finite number.`);
    }
    if (turn !== null) {
      if (!Number.isFinite(turn)) throw new Error(`walk(): turn is ${turn}.`);
      // The VIEW turns, and `turn` is a world heading in THIS harness's convention — the same one
      // `placeAt` takes — converted for player.js. The body then follows whatever the axis asks
      // for in that frame, which is how the game behaves; setting the body's yaw directly would be
      // overwritten on the next step.
      this._camYaw = camYawFor(turn);
    }
    this._footInput._ax = right;
    this._footInput._ay = forward;
    this._footInput._run = !!run;
    if (jump) this._footInput._jump = true;
    return this;
  }

  /** The body a player IS: the car when driving, the person when on foot. */
  _pos() { return this.mode === 'foot' ? this.player.position : this.vehicle.position; }

  /** Advance the world. Seconds of GAME time, not of waiting. */
  step(seconds) {
    const n = Math.max(1, Math.round(seconds * HZ));
    for (let k = 0; k < n; k++) {
      /**
       * THE FENCE, the same one district/main.js applies. A playtester drove 4,595 m off the map
       * at 146 km/h over nothing; the fence refuses only the power that takes the car further out,
       * so it cannot strand anybody.
       */
      const yaw = this._yaw();
      /**
       * THE FENCE FOLLOWS THE BODY THE PLAYER IS, which district/main.js learned the hard way:
       * its `outsideWorld` went stale on foot and left a dead end reachable by pressing F. On
       * foot the refusal is applied to the WALK axis rather than the throttle, because that is
       * the control that would take a person further out.
       */
      const ap = this._pos();
      if (this.mode === 'foot') {
        const pv = this.player.velocity;
        const pf = camFwd(this._camYaw);
        const f = worldFence(this.worldBox, ap.x, ap.z, pf.x, pf.z, pv.x, pv.z,
          { throttle: this._footInput._ay, brake: 0, steer: 0, handbrake: false });
        this.outsideWorld = f.out;
        this._footInput._ay = f.controls.throttle;
      }
      const fenced = worldFence(this.worldBox, this.vehicle.position.x, this.vehicle.position.z,
        Math.sin(yaw), Math.cos(yaw), this.vehicle.velocity.x, this.vehicle.velocity.z,
        this._controls);
      if (this.mode === 'car') this.outsideWorld = fenced.out;
      // The car is stepped either way: it is still in the world, parked, while you walk about.
      this.vehicle.setControls(this.mode === 'foot'
        ? { throttle: 0, brake: 1, steer: 0, handbrake: true } : fenced.controls);
      this.vehicle.stepFixed(DT, this.ground, HZ);
      if (this.mode === 'foot') {
        // The car as a moving obstacle, exactly as main.js hands it over.
        this._carCollider.x = this.vehicle.position.x;
        this._carCollider.z = this.vehicle.position.z;
        this.player.update(DT, this._footInput, this._camYaw, this.ground,
          [this._carCollider], this.blockers);
      }
      this.damage.update(DT);
      /**
       * IS A UNIT HOLDING YOU — the host's verdict, computed here exactly as district/main.js
       * computes it, against the PLAYER rather than against the pursuit target. See
       * `_watchBust` in src/wanted.js for why the module does not own this.
       */
      this._wantedPlayer.x = ap.x; this._wantedPlayer.z = ap.z;
      this._wantedPlayer.held = false;
      // See `_trackVelocity` in src/wanted.js: a step in or out of the car moves the reported
      // position 1.9 m in one frame, and without this that reads as 114 m/s of travel and clears
      // the bust clock. district/main.js carries the same flag.
      this._wantedPlayer.teleported = this._teleported;
      this._teleported = false;
      // What the car was ASKED for, so the bust line can say "reverse" to a player already
      // holding the throttle open against a wall. Negative is reverse and does not latch it.
      this._wantedPlayer.throttle = this.mode === 'car' ? (this._controls.throttle ?? 0) : 0;
      /**
       * `reachRadius`, NOT `holdRadius`, AND THE DIFFERENCE WAS THE WHOLE FIX. This read
       * `holdRadius` — 8.75 m, the distance from an edge's centreline to a car at the kerb of
       * the widest road — so it was a THIRD copy of a bound that also lives in src/pursuit.js
       * and district/main.js. Widening the module alone changed nothing a player could feel:
       * measured at 14.15 m off a road at four stars, `u.held` was true on 98.5% of samples with
       * a longest hold of 197.0 s and the arrest never came, because 14.15 failed `<= 8.75`
       * here. An arrest is made by a person, and `reachRadius` is how far one gets.
       */
      const reachR = this.pursuit.reachRadius ?? this.pursuit.holdRadius ?? 0;
      if (reachR > 0) {
        for (const u of this._unitPositions()) {
          if (!u.held) continue;
          if (Math.hypot(u.x - ap.x, u.z - ap.z) <= reachR) { this._wantedPlayer.held = true; break; }
        }
      }
      this.wantedBridge.update(DT, this._wantedPlayer);
      if (this._pursuitIds.length) this.pursuit.update(DT, this._pursuitTarget);
      this._bustWatch(DT);
      // The CAR is what traffic has to avoid, on foot as much as in it — main.js passes the
      // vehicle unconditionally for the same reason.
      this.traffic.update(DT, this.vehicle.position, this.mode === 'car' ? this.vehicle.velocity : null,
        { x: Math.sin(this._yaw()), z: Math.cos(this._yaw()) });
      // And the crowd follows the CAMERA, which is whatever the player is.
      this.peds.update(DT, ap);
      this._moving();
      this._contacts();
      this._wreckWatch(DT);
      /**
       * THE GARAGE, exactly as district/main.js wires it: the module owns the zone, the dwell
       * and the refusals, and this is the one wire. Driven here rather than in `_band()` because
       * `_band()` is called more than once a frame — `look()` and `debug()` both reach it — and a
       * dwell advanced from a read would run at whatever rate the caller happened to sample at.
       */
      this._garageState = this.mode === 'car'
        ? this.garage.update(DT, { x: this.vehicle.position.x, z: this.vehicle.position.z,
          speed: this.vehicle.speed, wantedStars: this.wanted.stars,
          health: this.damage.health })
        : this.garage.update(DT, { x: Infinity, z: Infinity, speed: 0, wantedStars: 0,
          health: 1 });
      if (this._garageState.repaired) { this.damage.repair(); this.stats.repairs++; }
      /**
       * THE END-OF-MISSION HOLD IS SPENT ONLY WHILE THE LINE IS ON SCREEN, which is what
       * district/main.js now does and what this file has to match or the harness shows a player
       * something the page does not.
       *
       * It ticked from the moment the mission ended, and BAND_ORDER puts `wreck` above `ended`,
       * so a mission lost BY being wrecked spent `WRECK_HOLD_S` of its `MISSION_END_S` behind
       * the wreck line. Measured here: 4.0 s of "THE CAR IS WRECKED" and then 1.9 s of "MISSION
       * ABORTED", t=4.4 to 6.2. A playtester reported that line as never read, which overstates
       * it — 1.9 s is not zero — and the number behind it is right: two thirds of the hold went
       * to a tenant above it.
       *
       * `_band()` is called rather than guessed at, because the question is which tenant WINS
       * and that is composeBand's answer, not a condition this file can restate.
       */
      if (this._endFor > 0 && this._band().from === 'ended') {
        this._endFor -= DT;
        if (this._endFor <= 0) this._ended = null;
      }
      /**
       * Drive into a marker and the job starts, exactly as district/main.js does it — INCLUDING
       * its wreck gate. Without `!this.damage.wrecked` a wrecked car sitting in a marker started a
       * mission, and since `_wreckWatch` only aborts on the FIRST wreck frame that mission then
       * ran through the whole four-second hold and the teleport. A blind reviewer found it with a
       * two-line repro; it is a harness defect rather than a game one, but it made this file
       * unusable for testing that path.
       */
      if (!this.mission.hud() && !this.damage.wrecked) this._offers();
      if (this.mission.mission) {
        /**
         * `hud()` RETURNS NULL THE INSTANT THE OUTCOME STOPS BEING RUNNING (mission.js:445),
         * which is how a mission ends — so reading `.objective` off it unconditionally threw on
         * the frame the last stage passed, every time, and this harness had therefore never
         * once seen a mission finish. Both playtesters hit it; one had to reach `report()`
         * instead to find out it had won.
         */
        const before = this.mission.hud();
        const stageBefore = this.mission.stage ? this.mission.stage.id : null;
        this.mission.update(DT, this._snapshot());
        const after = this.mission.hud();
        const stageAfter = this.mission.stage ? this.mission.stage.id : null;
        /**
         * FLATTENED BEFORE IT IS COMPARED, AND THE COMPARISON IS WHY. This read
         * `before.objective !== after.objective` on the raw field and said
         * `OBJECTIVE  ${objAfter}`, and `MissionRunner.hud()` returns a FRESH
         * `{ text, distance }` object every call for any stage with a destination — six of the
         * nine authored stages. So the identity test was true on every step and the string
         * conversion printed `[object Object]`: one line per 1/120 s, both halves of the same
         * two lines.
         *
         * Measured on 24.3 s of `marlin-street`: 2,696 transcript lines, 2,695 of them
         * OBJECTIVE, 2,694 of those `[object Object]`, TWO distinct values in the whole log.
         * 99.96% of the transcript was one meaningless repeated line, and every real event —
         * the stage boundaries, HIT, RAM, MISSION — was one line in 2,696. This is the
         * transcript every playtester reads, and round 8's two read this.
         *
         * The one objective that logged correctly was `LOSE THEM`, because `ambush` is the only
         * stage with no distance, so its objective is the frozen string and its identity holds.
         * The stage whose cue was the round's headline finding is the one the instrument could
         * still see.
         *
         * `objectiveLine` is imported at the top of this file and already used by `look()` for
         * exactly this flattening. It was not called here — the same sibling-site miss
         * CLAUDE.md records for `composeBand`, which printed the identical string on the
         * shipped page from the same cause.
         */
        /**
         * AND THE EVENT IS A NEW OBJECTIVE, NOT A NEW DISTANCE. Flattening alone took the same
         * 24.3 s from 2,696 lines to 142 — and 141 of those were one line per whole metre of
         * approach, because `hud()` recomputes the distance every frame and the flattened
         * string changes with it. That is the HUD's own dirty granularity, which is right for
         * something being DRAWN and wrong for a transcript: a distance ticking down is not an
         * event, and 141 lines for one leg buries the stage boundaries exactly as the object
         * identity did. Keyed on the stage and the objective's words, the same leg logs 4.
         */
        if (objKey(after, stageAfter) !== objKey(before, stageBefore)) {
          this.say(`OBJECTIVE  ${after ? objectiveLine(after.objective) : '(none)'}`);
        }
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
    const ap = this._pos();
    this.board.refresh(ap.x, ap.z);
    const hot = this.board.offerAt(ap.x, ap.z);
    if (hot) {
      this.board.starts++;
      this._outcome = OUTCOMES.RUNNING;
      this.mission.start(hot.mission);
      this.say(`MISSION ${hot.mission.id}: ${hot.mission.title} — ` +
        `${this.mission.hud()?.objective ?? ''}`);
      this._offer = null;
      return;
    }
    const seen = this.board.offerAt(ap.x, ap.z, 'notice');
    this._offer = seen
      ? { id: seen.mission.id, title: seen.mission.title, brief: seen.mission.brief,
        range: seen.distance, x: seen.mission.start.x, z: seen.mission.start.z }
      : null;
  }

  _snapshot() {
    const ap = this._pos();
    // `inVehicle` WAS HARDCODED TRUE, which is what made three authored stage transitions
    // unreachable from this harness. On foot the speed reported is the person's.
    return { px: ap.x, pz: ap.z, inVehicle: this.mode === 'car',
      speed: this.mode === 'foot' ? Math.hypot(this.player.velocity.x, this.player.velocity.z)
        : this.vehicle.speed,
      health: this.damage.health,
      /**
       * HOW FAR THE CAR IS, so `MissionRunner.objectiveDistance` can put it on an `inVehicle`
       * stage's objective — the number round 6's playtester did not have while running 404 m from
       * the car with "GET IN THE CAR" unchanged on the band. Zero in the car, because `_pos()` IS
       * the car then and the stage is already satisfied. Optional by design: no trigger reads it,
       * so a host without it gets an objective with no distance rather than a throw.
       */
      carRange: this.mode === 'foot' ? this.carRange : 0,
      wantedStars: this.wanted.stars, wantedState: this.wanted.state,
      // How the level last reached zero, so `evaded` can tell escaping from being arrested.
      wantedClearedBy: this.wanted.clearedBy };
  }

  _moving() {
    // The body the player IS, so a walk adds to the odometer instead of reading zero.
    const ap = this._pos();
    const d = Math.hypot(ap.x - this._lastPos.x, ap.z - this._lastPos.z);
    this.stats.distance += d;
    this._lastPos = { x: ap.x, z: ap.z };
    const kmh = this.vehicle.speed * 3.6;
    if (kmh > this.stats.topSpeed) this.stats.topSpeed = +kmh.toFixed(1);
    if (this.vehicle.pendingImpact) {
      const hit = this.vehicle.pendingImpact;
      this.vehicle.pendingImpact = null;
      this.stats.crashes++;
      if (hit.crime) this._crime(hit.crime, hit.crimeScale);
    }
  }

  /**
   * A WRECKED CAR IS NOT THE END OF THE SESSION. district/main.js's own rule, mirrored here so a
   * playtester plays the game rather than a version of it that strands them: four seconds of
   * wreck, the mission called off, then a replacement car on the nearest road. Before this a
   * playtester measured 60 s of full throttle and 60 s of full reverse both giving 0 km/h, with
   * the mission outcome stuck on 'running' and the objective still on the HUD.
   */
  /** Mask the fleet to what the plan asked for. Slots above `n` are nulled, not driven. */
  _fleet(n) {
    this.pursuit.count = Math.max(0, Math.min(n, 8));
    for (let i = this.pursuit.count; i < 8; i++) this.pursuit.units[i] = null;
  }

  /**
   * Where each requested unit is, and whether it has stopped on the target. Read out of the
   * instance matrix, which is the only place PursuitUnits keeps a position — the same route
   * district/main.js's bridge and src/audio.js's sirens take.
   */
  _unitPositions() {
    const out = this._pursuitOut;
    out.length = 0;
    const n = Math.min(this._pursuitIds.length, this.pursuit.count);
    for (let i = 0; i < n; i++) {
      const u = this.pursuit.units[i];
      if (!u) continue;
      this.pursuit.mesh.getMatrixAt(i, this._pursuitMat);
      this._pursuitVec.setFromMatrixPosition(this._pursuitMat);
      out.push({ id: this._pursuitIds[i], x: this._pursuitVec.x, z: this._pursuitVec.z,
        held: u.held === true });
    }
    return out;
  }

  /** The fade after a bust. Same beat as the wreck, and the same constant. */
  _bustWatch(dt) {
    if (this._bustedFor <= 0) return;
    this._bustedFor += dt;
    if (this._bustedFor < WRECK_HOLD_S) return;
    this._bustedFor = 0;
    this.stats.released++;
    this.respawn();
    if (this.mode === 'foot') { this.mode = 'car'; }
    this.player.position.copy(this.vehicle.position);
    this.player.velocity.set(0, 0, 0);
    this.say('OUT     released, the car is back and repaired');
  }

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
    this._teleported = true;
    this._wreckFor = 0;
    this.stats.respawns++;
    this.damage.repair();
    this.vehicle.contacts = 0;
    this.vehicle.pendingImpact = null;
    const near = this.roads.nearestOn(this.vehicle.position.x, this.vehicle.position.z);
    let x = this.district.meta.spawn.x, z = this.district.meta.spawn.z, yaw = 0;
    /**
     * AND A SECOND WRECK IN THE SAME PLACE IS A LOOP. district/main.js's own rule: two of this
     * district's respawn points close a period-2 cycle under held throttle — (518,77) -> (472,78)
     * -> (524,77) -> ... a wreck every 9.6 s for ever. A reviewer found 1 in 86 sampled points
     * does this; the other 85 wander, so the bound is on the SEQUENCE and not on the site.
     */
    const candidate = near && near.dist < 80
      && !this.blockers.resolveCircle(near.x, near.z, BODY_RADIUS) ? near : null;
    const looping = !!candidate && this._respawns.some((h) => this.t - h.t < LOOP_S
      && Math.hypot(candidate.x - h.x, candidate.z - h.z) < LOOP_R);
    if (looping) this.stats.loopsBroken++;
    if (!looping && candidate) {
      const near = candidate;
      x = near.x; z = near.z;
      const a = this.district.verts[near.a], b = this.district.verts[near.b];
      yaw = Math.atan2(b.x - a.x, b.z - a.z);
      // Facing the way there is road: an edge has two directions and the first one pointed the
      // replacement at the building it had just been destroyed against, 11 m off.
      yaw = this._clearerHeading(x, z, yaw);
    }
    this.placeAt(x, z, yaw);
    this.vehicle.angularVelocity.set(0, 0, 0);
    this._respawns.push({ x, z, t: this.t });
    while (this._respawns.length > LOOP_KEEP) this._respawns.shift();
    this.say(`RESPAWN a replacement car at (${x.toFixed(0)}, ${z.toFixed(0)})` +
      (looping ? ' — back at the spawn, that site was looping' : ''));
    return { x: +x.toFixed(1), z: +z.toFixed(1) };
  }

  /**
   * One victim, one offence, within a window — src/wanted.js's `VictimWindow`, the same object
   * district/main.js uses, so the harness cannot drift from the game on the rule that decides
   * whether a repeat is charged. There are two ways to be charged for one person (knocked down,
   * then driven over) and they share it.
   */
  _chargeVictim(id) { return this._victims.charge(id, this.t); }

  _crime(name, scale = 1) {
    // Claimed before the call, because `reportCrime` emits synchronously and the listener above
    // must not count this one twice.
    this._lastFiled = name;
    const r = this.wanted.reportCrime(name,
      { at: { x: this._pos().x, z: this._pos().z }, scale });
    this._lastFiled = null;
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
    let proneUnder = null;
    for (const p of this.peds.positions()) {
      // A body on the ground never enters `dynamicContact` — it must not shove 1,400 kg of car
      // or take a second throw — but it IS still an offence to drive over. See main.js's own
      // run-over block and `peds.runOver`. Collected here, charged below.
      if (p.down) {
        const rx = p.x - base.carX, rz = p.z - base.carZ;
        const r2 = rx * rx + rz * rz;
        if (r2 <= (BODY_ENCLOSING + PERSON.bodyRadius) ** 2
          && (!proneUnder || r2 < proneUnder.r2)) proneUnder = { i: p.i, r2 };
        continue;
      }
      const dx = p.x - base.carX, dz = p.z - base.carZ;
      if (dx * dx + dz * dz > (BODY_ENCLOSING + PERSON.bodyRadius) ** 2) continue;
      this.stats.tested++;
      const hit = dynamicContact({ ...base, ...PERSON, bodyX: p.x, bodyZ: p.z });
      if (!hit) continue;
      if (!worst || hit.dv > worst.dv) { worst = hit; worstKind = IMPACT.pedestrian; }
      if (!worstPed || hit.dv > worstPed.dv) { worstPed = hit; worstPed.pedIndex = p.i; }
    }
    /**
     * The run-over charge, BEFORE the `!worst` return, because a lone casualty under the car sets
     * no contact at all and `worst` is null in exactly the case this is for. main.js's copy was
     * written after its return first and could never fire.
     */
    if (proneUnder) {
      const over = Math.hypot(v.velocity.x, v.velocity.z);
      const r = this.peds.runOver(proneUnder.i, { speed: over });
      if (r) {
        this.stats.runOvers++;
        /**
         * THE CHARGE COMES FROM THE MODEL, NOT FROM A LITERAL 1, and this harness was the second
         * place that got wrong. district/main.js's run-over site passed `scale: 1` and was fixed
         * to `damage.runOverCrime(over, r.fatal)`; this one was left, which is the recurring
         * shape of defect here -- patch the caller you are looking at, leave its sibling.
         *
         * It is not a rounding difference. `pedCrimeScale` is anchored to the fatality curve, so
         * at the walking pace boot-check's arm measures it reads 0.0073 against the literal 1.00:
         * the harness was charging 137x what the game charges, and every playtest round's
         * run-over reading was a reading of the harness. The pedestrian-HIT site twelve lines
         * down already took `rec.crimeScale` from the record for exactly this reason.
         *
         * `runOverCrime` also decides the CRIME, and asking it rather than re-deriving
         * `fatal ? killed : hit` here is the point: that ternary is the model's own, and a
         * harness that keeps its own copy is a harness that can disagree with the game silently.
         */
        const rv = this.damage.runOverCrime(over, r.fatal);
        this.lastRunOver = { kmh: +(over * 3.6).toFixed(1), crime: rv.crime,
          scale: +rv.scale.toFixed(4), charged: false };
        if (this._chargeVictim(r.id)) {
          this.lastRunOver.charged = true;
          this._crime(rv.crime, rv.scale);
          this.say(`OVER    drove over a casualty at ${(over * 3.6).toFixed(0)} km/h` +
            (r.fatal ? ' — they do not get up' : ''));
        } else this.stats.pedRepeats++;
      }
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
        // One victim, one offence, within a window. See `_chargeVictim`.
        if (!this._chargeVictim(r.id)) { pedCrime = null; this.stats.pedRepeats++; }
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
    // The same scale main.js passes, from the same record. See DamageModel._crimeScaleFor.
    for (const c of crimes) this._crime(c, rec.crimeScale);
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
    const h = this.mission.mission ? this.mission.hud() : null;
    let wp = h && h.waypoint ? h.waypoint : null;
    if (!wp) {
      // The same idle target look() points at: the nearest job on the board.
      let best = Infinity;
      for (const k of this.board.markers()) {
        const d = Math.hypot(k.x - this._pos().x, k.z - this._pos().z);
        if (d < best) { best = d; wp = k; }
      }
    }
    if (!wp) { this._route = null; return null; }
    // The same call district/main.js's routeToMarker makes, with the same spacing.
    const p = this.roads.path(this._pos().x, this._pos().z, wp.x, wp.z,
      { spacing: 8, offset: ROUTE_LANE_M, smoothPasses: 1 });
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
    const v = this.vehicle;
    /**
     * THE EYE IS THE BODY THE PLAYER IS. On foot the bearings, the sight cone and the ranges all
     * have to come from where the person is standing and which way they face, or a player who
     * steps out is handed the parked car's view of the street.
     */
    const onFoot = this.mode === 'foot';
    const eye = this._pos();
    // On foot you look where the CAMERA looks; the body may be mid-turn. `camFwd` undoes the
    // convention mirror so the cone points where the scenario aimed it.
    const fwd = onFoot ? camFwd(this._camYaw)
      : { x: Math.sin(this._yaw()), z: Math.cos(this._yaw()) };
    /**
     * A BEARING IS NOT PRIVILEGED INFORMATION, IT IS THE MINIMAP. `look()` gave the offer a range
     * and no direction, and a playtester steering by range alone — drive a leg, turn if it grew —
     * covered 703 m over 76 legs in 241.7 s and never found the job, because the notice radius is
     * 48 m and outside it there is no gradient. With the bearing the minimap blip gives, the same
     * drive took 11.0 s. Withholding it was not restricting the player to what they can see; the
     * page draws every board marker within MINIMAP_REACH_M of them.
     */
    const bearingTo = (x, z) => {
      const dx = x - eye.x, dz = z - eye.z, d = Math.hypot(dx, dz) || 1;
      const dot = (dx * fwd.x + dz * fwd.z) / d;
      const cross = fwd.x * (dz / d) - fwd.z * (dx / d);
      return { range: +d.toFixed(0), bearing: +Math.atan2(cross, dot).toFixed(2) };
    };
    const ahead = (x, z) => {
      const dx = x - eye.x, dz = z - eye.z;
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
    const band = this._band();
    const wantedLine = composeWanted(this.wanted.hudState());
    const hud = this.mission.mission ? this.mission.hud() : null;
    /**
     * WITH NO MISSION RUNNING THE WAYPOINT POINTS AT THE NEAREST JOB, at any distance, the same
     * as district/main.js. Without it a playtester who finished the tutorial at the marina drove
     * 4,121 m over 145 hops and 1,522 s and never came within 339 m of the only content left: of
     * 44.11 km of road, 0.16% starts a job and 1.24% announces one.
     */
    let idle = null;
    if (!hud) {
      let best = Infinity;
      for (const k of this.board.markers()) {
        const d = Math.hypot(k.x - eye.x, k.z - eye.z);
        if (d < best) { best = d; idle = k; }
      }
    }
    /**
     * AND ON FOOT THE CAR IS THE WAYPOINT, which district/main.js has done since the marker round
     * and this did not. A blind playtester stepped out, ran, and read `waypoint: null` at every
     * distance out to 404 m while the band went on saying "GET BACK IN THE CAR" — and filed it as
     * a page defect. It is not: `main.js:1819` posts `_carWaypoint` for exactly this case. The
     * harness's copy of the same fallback was missing, which is the shape CLAUDE.md records as
     * patching one tool and leaving its siblings, arriving from the harness side.
     */
    const wp = hud && hud.waypoint ? hud.waypoint
      : onFoot ? { x: this.vehicle.position.x, z: this.vehicle.position.z }
        : idle;
    let waypoint = null;
    if (wp) {
      const dx = wp.x - eye.x, dz = wp.z - eye.z, d = Math.hypot(dx, dz);
      const dot = (dx * fwd.x + dz * fwd.z) / (d || 1);
      const cross = fwd.x * (dz / (d || 1)) - fwd.z * (dx / (d || 1));
      waypoint = { range: +d.toFixed(0), bearing: +Math.atan2(cross, dot).toFixed(2) };
    }
    return {
      t: +this.t.toFixed(1),
      // The dial reads ROAD speed, the same quantity src/hud.js shows. `vehicle.speed` is the
      // 3-D magnitude and reads 7 km/h on a parked car for the first second of a session.
      speedKmh: onFoot
        ? +(Math.hypot(this.player.velocity.x, this.player.velocity.z) * 3.6).toFixed(0)
        : +(v.roadSpeed * 3.6).toFixed(0),
      /**
       * ON FOOT, and how far the car is. Both are on screen in the page — the mode is obvious from
       * the camera and the car is a minimap blip — and a scenario cannot decide whether `enter()`
       * will work without the range, since `ENTER_RANGE` is 3.6 m.
       */
      onFoot,
      carRange: onFoot ? +this.carRange.toFixed(1) : null,
      // The HUD's own fields, and only those: health, the damage vignette, the star count.
      health: +this.damage.health.toFixed(3),
      smoke: +this.damage.smoke.toFixed(2),
      wreck: this.damage.wrecked,
      // The one thing outside the windscreen a player is told about in words.
      offMap: this.outsideWorld > 0 ? +this.outsideWorld.toFixed(0) : null,
      stars: this.wanted.stars,
      /**
       * THE STAR METER'S OTHER TWO READINGS. A playtester escaped four stars over 96 s and
       * reported that `stars` was the ONLY field of `look()` that ever differed over the whole
       * run — no state, no clock, no reason — and the shed times are 40/66/84/96 s, so the rule
       * was good and nothing expressed it. `wantedNote` is the string the page draws under the
       * stars and `evade` the drain it draws on the top one.
       *
       * AND THE POLICE BLIPS ARE HERE NOW, which this comment used to say was impossible: "this
       * harness has no pursuit layer, so there are no unit positions to give a bearing to". True
       * when it was written and false since the harness gained one — and a blind playtester caught
       * the consequence, that any legibility claim made from `look()` understated the page by the
       * ~10 s of enemy-blip warning it measured before an arrest. A stale comment about a gap is
       * worse than the gap, because it reads as a decision.
       */
      evade: +wantedLine.evade.toFixed(3),
      wantedNote: wantedLine.note,
      /**
       * The band, exactly as the page composes it. `objective`/`subtitle` are what is on screen.
       *
       * THROUGH `objectiveLine`, because an objective can carry a `distance` the page draws in its
       * own element — and a harness that returned the object would give a playtester
       * `[object Object]`, while one that returned only the words would drop the number. A
       * playtester measured exactly that loss from the other end: 0 of 289 law glances with a
       * distance while a mission was live.
       */
      objective: objectiveLine(band.objective),
      subtitle: band.subtitle,
      bandFrom: band.from,
      // hud() goes null when the mission ends, so without this a finished mission and no
      // mission at all look identical from the seat.
      missionOutcome: this.mission.mission ? this.mission.outcome : null,
      // A job on offer nearby, the way the objective band names it in the page, WITH a bearing.
      offer: this._offer
        ? { ...this._offer, ...bearingTo(this._offer.x, this._offer.z) } : null,
      /**
       * The minimap's contents: every job on the board within its reach, with a bearing. This is
       * the blip a player is looking at, and without it `look()` is harder to navigate by than
       * the game.
       */
      /**
       * THE MINIMAP'S CONTENTS. Every job on the board, plus THE CAR WHEN YOU ARE NOT IN IT —
       * `MARKER_STYLE.vehicle` had existed in src/hud.js since it was written with nothing ever
       * posting one, so three authored stages said "GET IN THE CAR" over a blank map.
       *
       * AND A BLIP BEYOND THE REACH IS CLAMPED TO THE EDGE, NOT DROPPED, because that is what the
       * page does: `Minimap._marker` clamps any off-plate blip into the padded frame and draws it
       * at the smaller of its two radii. This filtered by `range <= MINIMAP_REACH_M` and threw
       * them away, so a blind playtester who ran 110.3 m from the car watched the blip vanish and
       * searched for 191 s over eight legs without recovering it — on a page that was drawing it
       * at the map edge the whole time. `edge` marks the clamped ones, because a player can see
       * that a blip is pinned to the frame and knows the range is at least the reach.
       */
      blips: this.board.markers()
        .map((k) => ({ id: k.id, ...bearingTo(k.x, k.z) }))
        .concat(onFoot
          ? [{ id: 'car', ...bearingTo(this.vehicle.position.x, this.vehicle.position.z) }]
          : [])
        /**
         * AND THE GARAGE, ALWAYS, which is what district/main.js posts: `MARKER_STYLE.shop` is
         * the third style that had sat in src/hud.js since it was written with nothing in the
         * game ever posting one. A player navigating by `look()` with no garage blip cannot find
         * the only repair in the game, which is the same defect as the three authored stages
         * that said "GET IN THE CAR" over a blank map.
         */
        .concat([{ id: 'garage', ...bearingTo(GARAGE_AT.x, GARAGE_AT.z) }])
        // One per unit that is actually reporting a position, as district/main.js posts them —
        // never the requested COUNT, which would put eight cars on a map the sim holds none of.
        .concat(this._unitPositions().map((u) => ({ id: 'enemy', ...bearingTo(u.x, u.z) })))
        .map((k) => (k.range > MINIMAP_REACH_M ? { ...k, edge: true } : k))
        .sort((a, b) => a.range - b.range),
      waypoint,
      // What is in front of the windscreen, nearest first, capped the way attention is.
      carsAhead: cars.slice(0, 6),
      peopleAhead: people.slice(0, 8),
      /**
       * WHICH WAY THE CAR DRAGS, AND IT IS ON THE HUD — the page draws it as an offset marker in
       * the vitals band, so this is not privileged information, it is that cue in words.
       *
       * THE THRESHOLD IS THE CUE'S OWN, imported rather than copied. It was a literal `0.02` here
       * and a literal `0.02` in src/hud.js's `_pullCue`, which is the recurring shape CLAUDE.md
       * records as "patching one tool and leaving its siblings": moving the cue's threshold and
       * leaving this one would have left the harness with a blind zone the page no longer has, and
       * a playtester steering by `look()` would report a defect that had been fixed.
       */
      pullsTo: this.damage.steerPull > PULL_MIN ? 'right'
        : this.damage.steerPull < -PULL_MIN ? 'left' : null,
    };
  }

  /** Everything the player cannot see. For diagnosing a session, never for steering it. */
  debug() {
    return {
      mode: this.mode,
      at: { x: +this._pos().x.toFixed(1), z: +this._pos().z.toFixed(1) },
      car: { x: +this.vehicle.position.x.toFixed(1), z: +this.vehicle.position.z.toFixed(1) },
      onFoot: this.mode === 'foot'
        ? { x: +this.player.position.x.toFixed(1), z: +this.player.position.z.toFixed(1),
          carRange: +this.carRange.toFixed(1) } : null,
      yaw: +this._yaw().toFixed(2),
      insideBuilding: this.blockers.insideAny(this._pos().x, this._pos().z) >= 0,
      worldBox: this.worldBox, outsideWorld: this.outsideWorld,
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

  /**
   * THE OBJECTIVE BAND, composed by src/hud.js's `composeBand` — the same call district/main.js
   * makes, so a playtester reads what a player reads. Four of its five tenants were missing from
   * `look()`: a playtester got `wreck: true, objective: null` during the four seconds a wrecked
   * car is held, with no words at all, while the page was saying "THE CAR IS WRECKED / a
   * replacement in 3 s".
   */
  _band() {
    const hud = this.mission.mission ? this.mission.hud() : null;
    const wreck = this.damage.wrecked
      ? { objective: 'THE CAR IS WRECKED',
        subtitle: `a replacement in ${Math.max(0, WRECK_HOLD_S - this._wreckFor).toFixed(0)} s` }
      : null;
    const fence = this.outsideWorld > 0
      ? { objective: 'TURN BACK',
        subtitle: `the district ends here — ${this.outsideWorld.toFixed(0)} m out` }
      : null;
    const ended = this._endFor > 0 ? this._ended : null;
    const offer = this._offer
      ? { objective: this._offer.title.toUpperCase(),
        subtitle: `${this._offer.brief} — ${this._offer.range.toFixed(0)} m` }
      : null;
    /**
     * THE LAW TENANT, composed by src/wanted.js from the same snapshot the page composes it from.
     * Its absence is why a playtester could drive off from a pedestrian at 40 km/h, have
     * `hitAndRun` file itself 85.6 m and 4.61 s later, and see no field of `look()` change at all:
     * the one mechanic in the game with an 85 m deadline and a 3.6 km/h discharge, and no way to
     * learn either from playing.
     */
    const law = composeLaw(this.wanted.hudState());
    // `busted` is the top tenant: while the fade runs it is the only thing on screen, and a
    // playtester who could not see it would report being teleported for no stated reason.
    const busted = this._bustedFor > 0
      ? { objective: 'BUSTED',
        subtitle: `released in ${Math.max(0, WRECK_HOLD_S - this._bustedFor).toFixed(0)} s` }
      : null;
    // `stuck` from src/vehicle.js's own composer, the same call district/main.js makes. Omitting
    // it here is how this harness would stop being able to see a tenant the page shows — the
    // defect CLAUDE.md records as four of composeBand's five tenants missing from `look()`.
    const stuck = this.mode === 'car' ? composeStuck(this.vehicle) : null;
    // `garage` from src/damage.js's own composer, the same call district/main.js makes. See the
    // note on `stuck` above for why omitting one here is how the harness stops being playable.
    const garage = this.mode === 'car'
      ? composeGarage(this._garageState, { health: this.damage.health,
        wantedStars: this.wanted.stars, speed: this.vehicle.speed })
      : null;
    return composeBand({ busted, wreck, fence, law, stuck, garage, mission: hud, ended, offer });
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
/**
 * TWO THINGS A SCENARIO AUTHOR NEEDS TO KNOW, both of which have cost a blind playtester runs:
 *
 * `arrived` CAN COST NO TIME. A route of two points is `done` on the first call, so this returns
 * without stepping the session — a caller looping on it never advances the clock. Check
 * `alreadyThere` and break.
 *
 * AND `look()`'s BEARING IS SIGNED OPPOSITE TO `drive({ steer })`. `steer = -bearing` converges
 * (measured: bearing -2.46 -> -0.01); `steer = +bearing` diverges (range 30 -> 214 m). On foot
 * `walk({ turn })` wants `heading - bearing` for the same reason. A playtester lost two scenarios
 * and half a round to it, reporting that a player cannot run anybody over using only the
 * windscreen — four controller configs, 120 s each, 0 hits, every arm ending against a wall. With
 * the sign right a hit takes 2.8 s. The header's existing note about the on-foot x-mirror does not
 * cover this, so it is written here where the autopilot is.
 */
export function driveTo(session, x, z,
  { maxSpeed = 16, timeout = 180, offset = ROUTE_LANE_M } = {}) {
  const from = session.vehicle.position;
  /**
   * THE SAME LANE district/main.js DRAWS, which is now 1.5 m right of the centreline rather than
   * on it: see ROUTE_LANE_M for the sweep that chose it — 2.17 shunts/km against the centreline's
   * 3.81 and the fleet's own lane's 18.44. What follows is why it was 0 for one round.
   *
   * IT WAS `offset: 3` — a right-hand lane —
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
    // `dt` is what arms followPath's progress anchor. Without it the stuck detector is inert and
    // reports `stuckFor: null`, which is how it says so rather than silently doing nothing.
    const f = followPath(path.points, { x: v.position.x, z: v.position.z, yaw: session._yaw(),
      speed: v.speed }, state, { maxSpeed, dt: DT * 8 });
    if (f.done) {
      /**
       * `alreadyThere` MARKS AN ARRIVAL THAT COST NO TIME, and it is not cosmetic. A route of two
       * points is `done` on the first call — `i >= points.length - 2` — so this returns without
       * stepping the session at all, and a caller looping `while (...) driveTo(...)` never advances
       * the clock and hangs. That killed two of a blind playtester's runs on a loop that looks
       * correct. The flag lets a scenario break instead of spinning.
       */
      const seconds = +(session.t - t0).toFixed(1);
      return { arrived: true, seconds, alreadyThere: seconds === 0,
        points: path.points.length, metres: +path.length.toFixed(0), blocked };
    }
    /**
     * WEDGED IS NOT A TIMEOUT, and saying so is the point. The follower now backs out of a
     * blockage; when backing ALSO makes no progress the car is pinned at both ends, and a caller
     * that reported `timeout` after 180 s of that would be hiding the one thing worth knowing.
     */
    if (f.wedged) {
      return { arrived: false, why: 'wedged — no progress forwards or backwards',
        seconds: +(session.t - t0).toFixed(1), blocked, at: { x: +v.position.x.toFixed(1),
          z: +v.position.z.toFixed(1) } };
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
/**
 * RUN NOTHING ON IMPORT. This file is a module as well as a program — `tools/arrest-band.mjs`
 * imports `Session` from it — and everything below reads `process.argv`, so an importer with its
 * own `--selftest` ran THIS file's 139-check selftest and exited 0 without running one of its
 * own. A green exit code from somebody else's gate is the most flattering failure available, and
 * it took a scrubbed dynamic import at the call site to notice. With no flag at all it instead
 * ran the demo session, which costs a second and prints a JSON dump into the importer's output.
 *
 * The guard is the standard one: argv[1] is the script node was told to run, so comparing it with
 * this module's own URL answers "am I the program" without any convention about flags.
 */
const IS_MAIN = process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
const SELFTEST = IS_MAIN && process.argv.includes('--selftest');
const scenarioArg = IS_MAIN ? process.argv.indexOf('--scenario') : -1;
if (!IS_MAIN) {
  // Imported. Export surface only.
} else if (scenarioArg >= 0 && process.argv[scenarioArg + 1]) {
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

  /**
   * §3b THE CLOSING SPEED AND THE CASUALTY ON THE GROUND. Both were found by a blind playtester
   * and neither had a check anywhere: the free threshold was compared with the CAR's ground speed,
   * so a person walking into a crawling car was free at 12.92 km/h of closing, and a body already
   * down was not an event of any kind at 101 km/h.
   *
   * Driven directly rather than through a chase, because both are about a specific relative
   * velocity and a chase cannot hold one. The pedestrian's velocity is SET and the closing speed
   * PRINTED beside the one `hit()` reports, so the arm states the geometry it built.
   */
  console.log('\n§3b the closing speed, and a body on the ground');
  {
    const s3 = new Session({ traffic: 0, peds: 8 });
    s3.placeAt(CROWD_HOME.x, CROWD_HOME.z, 0);
    s3.step(1);
    const ped = s3.peds.peds[0];
    // The car travels +z at 2.19 m/s — under the 2.2 m/s floor — and the person walks INTO it.
    const rows = [];
    for (const [pyaw, pv] of [[0, 0], [Math.PI, 1.4], [0, 1.4]]) {
      ped.down = null; ped.yaw = pyaw; ped.v = pv;
      const built = 2.19 - Math.cos(pyaw) * pv;
      const r = s3.peds.hit(0, { speed: 2.19, dirX: 0, dirZ: 1 });
      rows.push({ built, down: !!r, reported: r ? r.closing : null });
      console.log(`    car 2.19 m/s, person ${(Math.cos(pyaw) * pv).toFixed(2).padStart(5)} m/s ` +
        `-> closing ${built.toFixed(2)} (${(built * 3.6).toFixed(2)} km/h)  ` +
        `${r ? `knocked down, reported ${r.closing.toFixed(4)}` : 'free'}`);
    }
    check('a person walking INTO a car under the floor is still knocked down',
      rows[1].down, `closing ${rows[1].built.toFixed(2)} m/s`);
    check('and the closing speed reported is the one the arm built',
      Math.abs(rows[1].reported - rows[1].built) < 1e-9,
      `${rows[1].reported?.toFixed(6)} vs ${rows[1].built.toFixed(6)}`);
    check('a stationary person under the floor is still free', !rows[0].down,
      `closing ${rows[0].built.toFixed(2)} m/s`);
    // It cuts both ways, which is what makes it a model rather than a one-way loosening.
    check('and a person walking AWAY is free where the car alone would not be', !rows[2].down,
      `closing ${rows[2].built.toFixed(2)} m/s from a 2.19 m/s car`);

    // A body on the ground: an offence, once, and no second throw.
    const s4 = new Session({ traffic: 0, peds: 8 });
    s4.placeAt(CROWD_HOME.x, CROWD_HOME.z, 0);
    s4.step(1);
    const victim = s4.peds.peds[1];
    victim.yaw = 0; victim.v = 0;
    const first = s4.peds.hit(1, { speed: 12, dirX: 0, dirZ: 1 });
    check('a casualty is on the ground to drive over', !!first && !!victim.down,
      first ? `down at ${first.speed.toFixed(1)} m/s` : 'not down');
    const before = { x: victim.x, z: victim.z, travelled: victim.down.travelled };
    const over = s4.peds.runOver(1, { speed: 28.1 });
    console.log(`    driven over at 101 km/h: ${over ? `charged, fatal ${over.fatal}` : 'NOTHING'}`);
    check('driving over a casualty at 101 km/h is an offence', !!over && over.alreadyDown,
      over ? `fatal ${over.fatal}` : 'null');
    check('above the kill speed they do not get up', !!victim.down.fatal, `${victim.down.fatal}`);
    check('and it does not move the body or re-throw it',
      victim.x === before.x && victim.z === before.z
        && victim.down.travelled === before.travelled,
      `moved ${Math.hypot(victim.x - before.x, victim.z - before.z).toFixed(4)} m`);
    // The free threshold applies here too, so a car rolling onto a body at walking pace is not
    // a felony — the same floor, on the same quantity.
    const s5 = new Session({ traffic: 0, peds: 8 });
    s5.placeAt(CROWD_HOME.x, CROWD_HOME.z, 0);
    s5.step(1);
    s5.peds.peds[1].yaw = 0; s5.peds.peds[1].v = 0;
    s5.peds.hit(1, { speed: 12, dirX: 0, dirZ: 1 });
    check('and a body rolled over under the floor is free',
      s5.peds.runOver(1, { speed: 1.5 }) === null, 'null at 1.5 m/s');
    check('the counters say it happened', s4.peds.stats.runOvers === 1,
      `runOvers ${s4.peds.stats.runOvers}`);

    /**
     * AND THE CONTACT PASS REACHES IT, which is the half that is easy to leave out — every arm
     * above calls `runOver` directly and would pass on a build whose `_contacts` still skipped
     * every downed body outright, which is the build this fixes. So: put a casualty on the road
     * IN FRONT of the car, drive over it through the ordinary step loop, and read the crime off
     * the session. main.js's copy of this block was originally written after its own `!worst`
     * return, where it could never fire, so this is the assertion that would have caught it.
     */
    const s6 = new Session({ traffic: 0, peds: 8 });
    s6.placeAt(CROWD_HOME.x, CROWD_HOME.z, 0);
    s6.step(1);
    const mark = s6.peds.peds[2];
    mark.yaw = 0; mark.v = 0;
    // 14 m ahead along +z, and put down there, so the car arrives at speed with nobody standing.
    mark.x = s6.vehicle.position.x;
    mark.z = s6.vehicle.position.z + 14;
    s6.peds.hit(2, { speed: 12, dirX: 0, dirZ: 1, force: true });
    mark.x = s6.vehicle.position.x;
    mark.z = s6.vehicle.position.z + 14;
    mark.down.vx = 0; mark.down.vz = 0;              // stop the slide so it stays put
    const crimes0 = s6.stats.crimes;
    for (let k = 0; k < 400 && s6.stats.runOvers === 0; k++) {
      s6.drive({ throttle: 1 });
      s6.step(1 / 60);
    }
    console.log(`    driven over through the real step loop: runOvers ${s6.stats.runOvers}, ` +
      `crimes +${s6.stats.crimes - crimes0}, ${s6.wanted.stars} stars`);
    check('the contact pass reaches a body on the ground', s6.stats.runOvers > 0,
      `${s6.stats.runOvers} run-overs`);
    check('and it files a crime the player can see', s6.stats.crimes > crimes0 && s6.wanted.stars > 0,
      `+${s6.stats.crimes - crimes0} crimes, ${s6.wanted.stars} stars`);

    /**
     * AND THE CHARGE IS THE MODEL'S, NOT A LITERAL 1.
     *
     * This harness charged `_crime(fatal ? killed : hit, 1)` where the game calls
     * `damage.runOverCrime(speed, fatal)` -- district/main.js had the identical defect, was
     * fixed, and its sibling here was left. The arm above sat right on top of it for several
     * rounds and could not see it, because `stars > 0` is true whichever scale is passed. An
     * arm in the right place with a toothless assertion is the recurring shape here, and it is
     * worse than no arm: it reads as coverage.
     *
     * THE EXPECTATION IS REPLAYED THROUGH A FRESH WantedSystem rather than written down, so a
     * change to the curve or to the CRIMES table moves the check with it. And the known-bad is
     * the literal: if charging 1 gave the same stars at this speed, the two sides would agree
     * and the check would be measuring nothing -- which is exactly the state the 101 km/h arm
     * was in, and is why the LOW-speed arm below exists as well.
     */
    const rec6 = s6.lastRunOver;
    const replay = (scale) => {
      const w = new WantedSystem();
      w.reportCrime(rec6.crime, { at: { x: 0, z: 0 }, scale });
      return w.stars;
    };
    const wantStars = replay(rec6.scale), literalStars = replay(1);
    console.log(`    charge: ${rec6.kmh} km/h -> ${rec6.crime} at scale ${rec6.scale}` +
      `  (the model says ${wantStars}*, a literal 1 says ${literalStars}*)`);
    check('the two sides of this check are not the same number at this speed',
      wantStars !== literalStars, `${wantStars}* against ${literalStars}*`);
    check('the harness charges what the model says, not a literal 1',
      s6.wanted.stars === wantStars, `${s6.wanted.stars}* against the model's ${wantStars}*`);

    /**
     * AND THE SAME THING AT WALKING PACE, where the defect is largest and points the other way.
     *
     * `CRIMES.pedestrianHit` carries `min: 1`, a FLOOR ON HEAT, so every non-fatal run-over
     * lands at exactly 1.0 heat and one star however slow it was -- measured flat across 3, 6,
     * 10, 14, 20, 30 and 50 km/h. The literal 1 charges the full 2.0 and two stars at all of
     * them. So the observable is 1 star against 2 over the whole non-fatal range, and above the
     * kill speed it inverts: at 101 km/h the model charges 3.59 heat and THREE stars where the
     * literal charges 2.0 and two. One arm at one speed could have been either accident.
     */
    const s7 = new Session({ traffic: 0, peds: 8 });
    s7.placeAt(CROWD_HOME.x, CROWD_HOME.z, 0);
    s7.step(1);
    const slow = s7.peds.peds[3];
    slow.yaw = 0; slow.v = 0;
    slow.x = s7.vehicle.position.x;
    slow.z = s7.vehicle.position.z + 4.5;
    s7.peds.hit(3, { speed: 12, dirX: 0, dirZ: 1, force: true });
    slow.x = s7.vehicle.position.x;
    slow.z = s7.vehicle.position.z + 4.5;
    slow.down.vx = 0; slow.down.vz = 0;
    // A gentle throttle over a short run, so the car arrives at a crawl rather than at 100 km/h.
    for (let k = 0; k < 900 && s7.stats.runOvers === 0; k++) {
      s7.drive({ throttle: 0.12 });
      s7.step(1 / 60);
    }
    const rec7 = s7.lastRunOver;
    check('the slow arm actually ran somebody over, so both sides are not zero',
      s7.stats.runOvers > 0 && !!rec7, `${s7.stats.runOvers} run-overs`);
    if (rec7) {
      const w7 = new WantedSystem();
      w7.reportCrime(rec7.crime, { at: { x: 0, z: 0 }, scale: rec7.scale });
      const lit7 = new WantedSystem();
      lit7.reportCrime(rec7.crime, { at: { x: 0, z: 0 }, scale: 1 });
      console.log(`    slow:   ${rec7.kmh} km/h -> ${rec7.crime} at scale ${rec7.scale}` +
        `  (model ${w7.heat.toFixed(4)} heat / ${w7.stars}*, literal 1 ` +
        `${lit7.heat.toFixed(4)} / ${lit7.stars}*)`);
      check('...at a crawl, not at the speed the arm above arrives at',
        rec7.kmh < 25, `${rec7.kmh} km/h against the fast arm's ${rec6.kmh}`);
      check('KNOWN-BAD: a literal 1 would be visibly worse here, so the check can fail',
        lit7.stars > w7.stars, `${lit7.stars}* against ${w7.stars}*`);
      check('a roll at walking pace is one star, the way boot-check reads it on the page',
        s7.wanted.stars === w7.stars && s7.wanted.stars === 1,
        `${s7.wanted.stars}* at ${rec7.kmh} km/h`);
    }
    // Parked on the body: the window collapses the repeat to the one report already filed.
    const held = s6.stats.crimes;
    for (let k = 0; k < 600; k++) { s6.drive({ brake: 1 }); s6.step(1 / 60); }
    check('and sitting on the body does not charge again', s6.stats.crimes === held,
      `${s6.stats.crimes} against ${held} after 10 s parked on it`);
  }

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
  let legMetres = 0;
  for (let k = 0; k < 6; k++) {
    const h = mis.mission.hud();
    if (!h) break;
    if (!h.waypoint) { mis.step(0.5); continue; }
    const r = driveTo(mis, h.waypoint.x, h.waypoint.z, { maxSpeed: 14, timeout: 120 });
    // Through `objectiveLine` for the third time in this file: `h.objective` is an object
    // whenever the stage has a destination. This line printed `[object Object] -> 24.7 s`.
    legs.push(`${objectiveLine(h.objective)} -> ${r.arrived ? r.seconds + ' s' : r.why}`);
    legMetres += r.metres ?? 0;
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
  /**
   * §5a  THE TRANSCRIPT IS THE INSTRUMENT, AND NOTHING HAD EVER ASSERTED ITS SHAPE.
   *
   * `step()` logged `OBJECTIVE ${hud().objective}` on an IDENTITY comparison of a field
   * `MissionRunner.hud()` rebuilds every frame for any stage with a destination — six of the
   * nine authored stages. Measured on 24.3 s of `marlin-street`: 2,696 lines, 2,695 OBJECTIVE,
   * 2,694 of them the string `[object Object]`, TWO distinct values in the whole log. Every
   * real event was one line in 2,696, and that is the transcript two playtesters read in
   * round 8.
   *
   * Three checks, because the two halves of the defect fail differently and the third is the
   * one a future distance-formatting change would trip:
   *
   *   - no `[object Object]` anywhere, which is the flattening;
   *   - one OBJECTIVE line per stage ENTERED, which is the event rule. Flattening alone left
   *     141 lines on one leg — one per whole metre, the HUD's draw granularity — so a build
   *     with the flattening and not the key passes the first check and fails this one;
   *   - `objKey` is blind to a rebuilt object, asserted against the KNOWN-BAD `!==` on the
   *     same pair. Without that pair the second check passes for any harness that happens not
   *     to move, which is CLAUDE.md's "a check whose two sides are both zero".
   */
  const objLines = mis.log.filter((l) => l.line.startsWith('OBJECTIVE'));
  check('no transcript line says [object Object]',
    !mis.log.some((l) => l.line.includes('[object Object]')),
    `${mis.log.length} lines, ${objLines.length} of them OBJECTIVE`);
  const visited = mis.mission.report().visited.length;
  // The bound is the STAGE COUNT, and the alternative is the METRE COUNT: there is nothing in
  // between for it to be wrong at, which is the only kind of bound worth writing down. `+ 1`
  // for the `(none)` line the mission's last frame logs when hud() goes null.
  check('one OBJECTIVE line per stage entered, not one per metre',
    objLines.length > 0 && objLines.length <= visited + 1,
    `${objLines.length} lines over ${visited} stages and ${legMetres.toFixed(0)} m driven: `
      + objLines.map((l) => l.line.slice(11)).join(' | '));
  {
    const k = new Session({ traffic: 0, peds: 0 });
    k.placeAt(MISSIONS['marlin-street'].start.x, MISSIONS['marlin-street'].start.z, 0);
    k.startMission('marlin-street');
    k.step(0.2);                                   // into `eastbound`, which carries a distance
    const h1 = k.mission.hud(), h2 = k.mission.hud();
    const rebuilt = h1.objective !== h2.objective;  // the known-bad comparison, on one frame
    check('two hud() reads of one frame are a fresh object that objKey reads as the same event',
      rebuilt && objKey(h1, 'eastbound') === objKey(h2, 'eastbound')
        && typeof h1.objective === 'object',
      `identity differs ${rebuilt}, key ${JSON.stringify(objKey(h1, 'eastbound'))}`);
  }
  const stalled = new Session({ traffic: 0, peds: 0 });
  stalled.startMission('shakedown');
  stalled.step(30);
  check('a mission nobody drives stays running', stalled.mission.outcome === OUTCOMES.RUNNING,
    stalled.mission.outcome);
  /**
   * §5a2  LOSING A MISSION BY BEING WRECKED, and the line that says so getting its full hold.
   *
   * `BAND_ORDER` puts `wreck` above `ended`, and the end-of-mission clock used to tick from the
   * moment the mission ended — so a mission lost BY being wrecked spent `WRECK_HOLD_S` of its
   * `MISSION_END_S` behind the wreck line. Measured: 4.0 s of "THE CAR IS WRECKED" and then
   * 1.9 s of "MISSION ABORTED". A playtester reported that line as never read; 1.9 s is not
   * zero, so the observation overstates it, and the number behind it is right — two thirds of
   * the hold went to a tenant above it, and 1.9 s is not long enough for a sentence naming the
   * mission, the reason and the consequence.
   *
   * The clock is spent only on frames where `composeBand` picks `ended`, so the bound is the
   * whole hold. There is nothing between the two outcomes for it to be wrong at: either the
   * clock runs while hidden and the line gets `MISSION_END_S - WRECK_HOLD_S`, or it does not and
   * the line gets `MISSION_END_S`.
   */
  {
    const w = new Session({ traffic: 0, peds: 0, seed: 5 });
    w.placeAt(19, -6, 0);
    w.startMission('marlin-street');
    w.step(0.3);
    w.damage.impact({ dv: 30, kind: 'wall', dirX: 0, dirZ: 1, speed: 30 });
    let endS = 0, wreckS = 0;
    for (let k = 0; k < 300; k++) {
      w.drive({ brake: 1 }).step(0.1);
      const from = w._band().from;
      if (from === 'ended') endS += 0.1;
      if (from === 'wreck') wreckS += 0.1;
    }
    console.log(`    wrecked mid-mission: the wreck line held ${wreckS.toFixed(1)} s and `
      + `"MISSION ABORTED" ${endS.toFixed(1)} s, against a ${MISSION_END_S} s hold and a `
      + `${WRECK_HOLD_S} s wreck hold`);
    check('a mission lost to a wreck is actually announced',
      w.mission.outcome === OUTCOMES.ABORTED && wreckS > 1, `${w.mission.outcome}`);
    check('and its line gets its whole hold, not what the wreck line leaves of it',
      endS >= MISSION_END_S - 0.3,
      `${endS.toFixed(1)} s against ${MISSION_END_S}; the old behaviour gave `
      + `${MISSION_END_S - WRECK_HOLD_S}`);
    check('KNOWN-BAD: the wreck line really did own the band first, so that was the whole cost',
      wreckS >= WRECK_HOLD_S - 0.3, `${wreckS.toFixed(1)} s of ${WRECK_HOLD_S}`);
  }

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

  /**
   * §6  WHAT THE BAND SAYS, and it is the reviewer-facing half of this harness. A playtester
   * measured `look()` giving `wreck: true, objective: null` — no words at all — through the four
   * seconds a wrecked car is held, while the page said "THE CAR IS WRECKED / a replacement in
   * 3 s". Four of the band's five tenants were missing, and the offer had a range and no bearing,
   * which cost that reviewer 703 m over 76 legs in 241.7 s finding nothing that a bearing found
   * in 11.0 s.
   */
  /**
   * §5c ON FOOT. Three authored stage transitions were unreachable from this harness because
   * `_snapshot()` reported `inVehicle: true` unconditionally: `marlin-street`'s
   * `eastbound -> backToCar` and `backToCar -> eastbound`, and `shakedown`'s `b -> a`. Both
   * playtesters reported at length on the driving and neither could get out of the car.
   *
   * These arms walk the whole cycle rather than asserting the flag, because the flag flipping is
   * not the feature — getting out, walking somewhere, and getting back in is.
   */
  console.log('\n§5c out of the car, and back in');
  {
    const f = new Session({ traffic: 0, peds: 0 });
    f.placeAt(19, -6, 0);
    f.startMission('marlin-street');
    f.step(0.5);
    check('the mission is on a stage that watches for stepping out',
      f.mission.report().stage === 'eastbound', f.mission.report().stage);
    check('and the harness reports being in the car', f._snapshot().inVehicle === true,
      `${f._snapshot().inVehicle}`);

    const out = f.exit();
    f.step(0.2);
    console.log(`    stepped out ${f.carRange.toFixed(2)} m from the car, ` +
      `look(): onFoot ${f.look().onFoot}, carRange ${f.look().carRange}, ` +
      `"${f.look().objective}"`);
    check('exit() puts a person beside the car', out && f.mode === 'foot'
      && f.carRange > 1 && f.carRange < 3, `${f.carRange.toFixed(2)} m`);
    check('the snapshot says so, which is what the stage watches',
      f._snapshot().inVehicle === false, `${f._snapshot().inVehicle}`);
    check('KNOWN-BAD: stepping out interrupts the job, it does not fail it',
      f.mission.report().stage === 'backToCar' && f.mission.outcome === OUTCOMES.RUNNING,
      `${f.mission.report().stage} / ${f.mission.outcome}`);
    check('and look() reports being on foot, with the car\'s range',
      f.look().onFoot === true && f.look().carRange > 1, `${f.look().carRange} m`);

    /**
     * AND THE BAND CARRIES THAT RANGE, which it did not. Round 6's playtester ran to 404 m from
     * the car with "GET IN THE CAR" unchanged on the objective the whole way, and reported it as a
     * HUD that said nothing. Two thirds of that was harness gaps and are fixed — the page clamps
     * the blip to the map edge and posts the car as the waypoint — and the BAND was the third.
     *
     * Read through `composeBand` and `objectiveLine`, the same two calls district/main.js makes,
     * so this is the string a player sees rather than a field nobody renders.
     */
    const walkRows = [];
    for (let k = 0; k < 3; k++) {
      f.walk({ forward: 1, run: true }).step(3);
      walkRows.push({ range: +f.carRange.toFixed(1), band: objectiveLine(f._band().objective),
        d: f.mission.report().objectiveDistance, from: f.mission.report().objectiveDistanceFrom });
    }
    console.log(`    walking away: ` +
      walkRows.map((r) => `"${r.band}" at ${r.range} m`).join('  ->  '));
    check('the objective band carries the range to the car, in metres',
      walkRows.every((r) => / — \d+ m$/.test(r.band)),
      walkRows.map((r) => r.band).join(' | '));
    check('and it is the car\'s own range, not some other number',
      walkRows.every((r) => Math.abs(r.d - r.range) < 0.15 && r.from === 'inVehicle'),
      walkRows.map((r) => `${r.d?.toFixed(1)} vs ${r.range}`).join(' '));
    check('and it RISES as the player walks away, which is what was missing',
      walkRows[2].range > walkRows[0].range + 10 &&
      walkRows.every((r, i) => i === 0 || r.d > walkRows[i - 1].d),
      walkRows.map((r) => r.range).join(' -> '));

    /**
     * THE WALK IS src/player.js's OWN, measured against its own constants. This is the arm that
     * would have caught the convention bug: `moveAxis` maps W to a wish of
     * `(-sin(cameraYaw), cos(cameraYaw))`, mirrored in x against the yaw convention the rest of
     * this file uses, so feeding a heading straight through pointed the view at its mirror image.
     * Measured before the fix: 0.32 m in 4 s against a 3.2 m/s walk speed, because the person
     * walked back into the car they had just left.
     */
    const legs = [];
    for (const [label, run] of [['walk', false], ['run', true]]) {
      const g = new Session({ traffic: 0, peds: 0 });
      g.placeAt(19, -6, 0);
      g.step(0.2);
      g.exit();
      // Straight out along the car's own left, which is the way `exit` faced them.
      const yaw = Math.atan2(g.player.position.x - g.vehicle.position.x,
        g.player.position.z - g.vehicle.position.z);
      const x0 = g.player.position.x, z0 = g.player.position.z;
      g.walk({ forward: 1, run, turn: yaw });
      for (let i = 0; i < 240; i++) g.step(1 / 60);
      const d = Math.hypot(g.player.position.x - x0, g.player.position.z - z0);
      legs.push({ label, d, v: d / 4, top: run ? g.player.runSpeed : g.player.walkSpeed });
      console.log(`    ${label} 4 s: ${d.toFixed(2)} m = ${(d / 4).toFixed(2)} m/s ` +
        `against a top of ${legs[legs.length - 1].top.toFixed(2)}`);
    }
    check('walking covers ground at close to src/player.js\'s own walk speed',
      legs[0].v > legs[0].top * 0.9 && legs[0].v <= legs[0].top,
      `${legs[0].v.toFixed(2)} m/s against ${legs[0].top}`);
    check('and running is faster than walking', legs[1].v > legs[0].v * 1.3,
      `${legs[1].v.toFixed(2)} against ${legs[0].v.toFixed(2)} m/s`);

    // The car is an obstacle, not a ghost — main.js's own carCollider, same half-extents.
    const h = new Session({ traffic: 0, peds: 0 });
    h.placeAt(19, -6, 0);
    h.step(0.2);
    h.exit();
    for (let i = 0; i < 360; i++) {
      const dx = h.vehicle.position.x - h.player.position.x;
      const dz = h.vehicle.position.z - h.player.position.z;
      h.walk({ forward: 1, turn: Math.atan2(dx, dz) });
      h.step(1 / 60);
    }
    console.log(`    6 s walking INTO the car: stopped ${h.carRange.toFixed(2)} m out`);
    check('walking into the car is stopped by it', h.carRange > 1.2 && h.carRange < 2.6,
      `${h.carRange.toFixed(2)} m, against a collider of hx 1.25 / hz 2.4`);

    /**
     * OUT OF REACH FIRST, THEN BACK IN — and the order matters. The first version of this asserted
     * `enter()` was refused while the person was still standing 1.9 m from the car, which is INSIDE
     * `ENTER_RANGE`: it returned true, put them back in the car, and a tangled ternary I had written
     * around it passed anyway. Everything after it then measured a session that was driving, and
     * the walk-distance arm read 3.8 m because nobody had walked. A check that cannot fail, written
     * while fixing a round about checks that cannot fail.
     *
     * So: walk clear of the reach, assert the refusal there, then walk back and assert it works.
     */
    let away = 0;
    const outYaw = Math.atan2(f.player.position.x - f.vehicle.position.x,
      f.player.position.z - f.vehicle.position.z);
    f.walk({ forward: 1, turn: outYaw });
    while (f.carRange < ENTER_RANGE * 2 && away < 1200) { f.step(1 / 60); away++; }
    console.log(`    walked out to ${f.carRange.toFixed(2)} m (reach is ${ENTER_RANGE} m)`);
    check('walking gets clear of the car\'s reach', f.carRange > ENTER_RANGE,
      `${f.carRange.toFixed(2)} m against ${ENTER_RANGE}`);
    check('and enter() is refused from out there',
      f.enter() === false && f.mode === 'foot', `${f.mode} at ${f.carRange.toFixed(2)} m`);
    let steps = 0;
    while (f.carRange > 2.5 && steps < 1200) {
      const dx = f.vehicle.position.x - f.player.position.x;
      const dz = f.vehicle.position.z - f.player.position.z;
      f.walk({ forward: 1, turn: Math.atan2(dx, dz) });
      f.step(1 / 60);
      steps++;
    }
    const back = f.enter();
    f.step(0.2);
    console.log(`    walked back to ${f.carRange.toFixed(2)} m and got in: ${back}; ` +
      `stage ${f.mission.report().stage}`);
    check('getting back in resumes the job', back && f.mode === 'car'
      && f.mission.report().stage === 'eastbound', f.mission.report().stage);
    check('and the whole cycle visited all four stage entries',
      f.mission.report().visited.join(' > ') === 'toCar > eastbound > backToCar > eastbound',
      f.mission.report().visited.join(' > '));
    check('the transcript names both transitions', f.log.some((l) => l.line.startsWith('OUT'))
      && f.log.some((l) => l.line.startsWith('IN')),
      f.log.filter((l) => /^(OUT|IN)/.test(l.line)).map((l) => l.line.slice(0, 3)).join(','));

    // And a walk adds to the odometer, so "distance" is not the car's alone.
    check('walking adds to the distance travelled', f.stats.distance > 10,
      `${f.stats.distance.toFixed(1)} m including the walk`);
  }

  console.log('\n§6  the objective band, and somewhere to go');
  const spawnLook = new Session({ traffic: 0, peds: 0 });
  spawnLook.step(0.2);
  const sl = spawnLook.look();
  console.log(`    at the spawn: [${sl.bandFrom}] "${sl.objective}"`);
  console.log(`      offer ${JSON.stringify(sl.offer && { id: sl.offer.id, range: sl.offer.range, bearing: sl.offer.bearing })}`);
  console.log(`      waypoint ${JSON.stringify(sl.waypoint)}, blips ${JSON.stringify(sl.blips)}`);
  check('an offer carries a bearing, not just a range',
    !!sl.offer && Number.isFinite(sl.offer.bearing) && Number.isFinite(sl.offer.range),
    JSON.stringify(sl.offer && { range: sl.offer.range, bearing: sl.offer.bearing }));
  check('the minimap\'s blips are visible to a player', sl.blips.length > 0
    && Number.isFinite(sl.blips[0].bearing), JSON.stringify(sl.blips));
  check('and the band names the job', sl.bandFrom === 'offer' && !!sl.objective, sl.objective);
  /**
   * SOMEWHERE TO GO WITH NOTHING RUNNING. A playtester finished the tutorial at the marina and
   * could not find the only remaining job: 145 hops, 1,522 s, 4,121 m, closest approach 339 m. Of
   * 44.11 km of road, 0.16% starts a job and 1.24% announces one, so exploring cannot work.
   */
  const tutDone = new Session({ traffic: 0, peds: 0 });
  tutDone.board.record('shakedown', OUTCOMES.PASSED);
  tutDone.placeAt(-471, 205, 0);
  tutDone.step(0.2);
  const dl = tutDone.look();
  check('a finished tutorial still leaves a waypoint', !!dl.waypoint && dl.waypoint.range > 300,
    JSON.stringify(dl.waypoint));
  const rt = tutDone.routeToWaypoint();
  check('and a routed line to follow', !!rt && rt.length > 2, rt ? `${rt.length} points` : 'none');
  // THE CONTROL: with every job passed there is nothing to point at, so the waypoint must be null
  // rather than pointing somewhere arbitrary.
  const empty = new Session({ traffic: 0, peds: 0 });
  empty.board.record('shakedown', OUTCOMES.PASSED);
  empty.board.record('marlin-street', OUTCOMES.PASSED);
  empty.step(0.2);
  /**
   * THE GARAGE IS A BLIP AND NOT A WAYPOINT, which is why this control counts JOB blips rather
   * than all of them. It read `blips.length === 0` and broke the moment the garage started
   * posting one — correctly, because the two statements had been conflated: "nothing is on the
   * board" and "nothing is on the minimap" are different claims and only the first is true.
   *
   * A standing amenity that took the idle waypoint would point a player at the garage instead of
   * at the only remaining job, which is the defect this very section exists for from the other
   * end — and it is what district/main.js does too: the garage is `pushHudMarker(..., 'shop')`,
   * never `hud.waypoint`.
   */
  const emptyBlips = empty.look().blips;
  const jobBlips = emptyBlips.filter((b) => b.id !== 'garage' && b.id !== 'car' && b.id !== 'enemy');
  console.log(`    with the board cleared: waypoint ${JSON.stringify(empty.look().waypoint)}, ` +
    `${jobBlips.length} job blips, ${emptyBlips.length} blips in all ` +
    `(${emptyBlips.map((b) => b.id).join(', ') || 'none'})`);
  check('with nothing left on the board there is no waypoint, and no job blip either',
    empty.look().waypoint === null && jobBlips.length === 0,
    `waypoint ${JSON.stringify(empty.look().waypoint)}, jobs ${JSON.stringify(jobBlips)}`);
  check('and the garage is still on the map, because it is an amenity rather than an objective',
    emptyBlips.some((b) => b.id === 'garage'),
    emptyBlips.map((b) => b.id).join(', ') || 'none');

  // The wreck line, in words, for the four seconds it is held.
  const wl = new Session({ traffic: 0, peds: 0 });
  wl.placeAt(576.2 - 40, -85, Math.PI / 2);
  for (let k = 0; k < 400 && !wl.damage.wrecked; k++) wl.drive({ throttle: 1 }).step(0.05);
  wl.step(0.1);
  const wb = wl.look();
  console.log(`    wrecked:     [${wb.bandFrom}] "${wb.objective}" / "${wb.subtitle}"`);
  check('a wrecked car says so in words', wb.bandFrom === 'wreck' && /WRECKED/.test(wb.objective)
    && /replacement/.test(wb.subtitle), `${wb.objective} / ${wb.subtitle}`);
  // And the fence line, which outranks everything except the wreck.
  const fl = new Session({ traffic: 0, peds: 0 });
  fl.vehicle.blockers = null;
  fl.placeAt(0, fl.worldBox.z1 + 20, 0);
  fl.step(0.1);
  const fb = fl.look();
  console.log(`    off the map:  [${fb.bandFrom}] "${fb.objective}" / "${fb.subtitle}"`);
  check('and being off the map does too', fb.bandFrom === 'fence' && /TURN BACK/.test(fb.objective),
    `${fb.objective} / ${fb.subtitle}`);
  // A running mission outranks an offer it is standing in; the band has one tenant at a time.
  const mb = new Session({ traffic: 0, peds: 0 });
  const mj = mb.board.available().find((m) => m.id === 'shakedown');
  mb.placeAt(mj.start.x, mj.start.z, 0);
  mb.step(0.2);
  console.log(`    on a marker:  [${mb.look().bandFrom}] "${mb.look().objective}"`);
  check('a running mission outranks the offer it started from',
    mb.look().bandFrom === 'mission', `${mb.look().bandFrom}`);

  /**
   * §7  THE FOLLOWER AGAINST A BUILDING, WHICH ONLY THIS HARNESS REPRODUCES.
   *
   * A round-5 playtester found `followPath` holding the throttle open against a building for 400
   * seconds with `state.i` stuck at 0 of a clean 41-point route and 37,018 contacts at about 97 a
   * second. `src/roadpath.js`'s progress anchor is the fix and `tools/roadpath-test.mjs` asserts
   * its CONTRACT against a car pinned by construction — but the end-to-end pair has to live here,
   * because a bare `Vehicle` against real district geometry grinds along the wall and escapes.
   * Two poses built in that file both did: a long facade (arrived after 207 s with 11,009
   * contacts) and a notch with 5 of 8 directions blocked (arrived in 19.1 s, detector never
   * fired). This Session, with damage accumulating and the sim's own stepping, pins the car.
   *
   * THEIR EXACT SETUP DID NOT REPRODUCE and that is recorded rather than smoothed over: planning
   * the same route at 0, 20 and 40 km/h and following it at control rates from 1/30 s to 1 s, the
   * follower reaches the marina every time in 38.7 to 46 s with 0 contacts and health 1.0000.
   * Their route was 41 points against 45 here, so their start differed. The BEHAVIOUR is exactly
   * real once the pose is built deliberately.
   */
  console.log('\n§7  the follower against a building');
  {
    const R = 0.95, STEP = 0.25;
    const probe = new Session({ traffic: 0, peds: 0 });
    // A long facade with open ground in front and a clear route running alongside it.
    let spot = null;
    for (let k = 0; k < probe.blockers.segs.length && !spot; k++) {
      const seg = probe.blockers.segs[k];
      if (seg.len < 14) continue;
      const mx = (seg.ax + seg.bx) / 2, mz = (seg.az + seg.bz) / 2;
      for (const sgn of [1, -1]) {
        const nx = seg.nx * sgn, nz = seg.nz * sgn;
        const px = mx + nx * 3.2, pz = mz + nz * 3.2;
        if (probe.blockers.resolveCircle(px, pz, R)) continue;
        if (probe.blockers.resolveCircle(px + nx * 14, pz + nz * 14, R)) continue;
        const pts = [];
        let ok = true;
        for (let d = -40; d <= 160; d += 8) {
          const qx = px + nx * 10 + seg.tx * d, qz = pz + nz * 10 + seg.tz * d;
          if (probe.blockers.resolveCircle(qx, qz, R)) { ok = false; break; }
          pts.push([qx, qz]);
        }
        if (!ok || pts.length < 20) continue;
        spot = { x: px, z: pz, yaw: Math.atan2(-nx, -nz), pts };
        break;
      }
    }
    check('a pinning pose exists in this district, or §7 is vacuous', !!spot,
      spot ? `(${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}), ${spot.pts.length}-point route` : 'none');

    if (spot) {
      let blocked = 0;
      for (const p of spot.pts) if (probe.blockers.resolveCircle(p[0], p[1], R)) blocked++;
      check('and its route is CLEAR, so this is the pinned car and not a road inside a building',
        blocked === 0, `${blocked} of ${spot.pts.length} points blocked`);

      const arm = (armDt) => {
        const s = new Session({ traffic: 0, peds: 0 });
        s.placeAt(spot.x, spot.z, spot.yaw);
        const st = { i: 0 };
        const p0 = { x: s.vehicle.position.x, z: s.vehicle.position.z };
        let backing = 0, n = 0, doneAt = null;
        for (let k = 0; k < 400 / STEP; k++) {
          const v = s.vehicle;
          const f = followPath(spot.pts, { x: v.position.x, z: v.position.z, yaw: s._yaw(),
            speed: v.speed }, st, { maxSpeed: 12, dt: armDt ? STEP : undefined });
          if (f.done) { doneAt = +(k * STEP).toFixed(1); break; }
          if (f.backing) backing++;
          n++;
          s.drive(f.controls).step(STEP);
        }
        const v = s.vehicle;
        return { i: st.i, of: spot.pts.length, doneAt, backing, n,
          moved: Math.hypot(v.position.x - p0.x, v.position.z - p0.z),
          contacts: v.contacts, health: s.damage.health, seconds: +(n * STEP).toFixed(1) };
      };
      const off = arm(false), on = arm(true);
      console.log(`    nose into a facade at (${spot.x.toFixed(1)}, ${spot.z.toFixed(1)}), ` +
        `${spot.pts.length}-point clear route alongside`);
      console.log(`      detector off: i ${off.i}/${off.of}, moved ${off.moved.toFixed(2)} m, ` +
        `${off.contacts} contacts (${(off.contacts / Math.max(off.seconds, 1)).toFixed(0)}/s), ` +
        `done ${off.doneAt ?? 'never'}`);
      console.log(`      detector on:  i ${on.i}/${on.of}, moved ${on.moved.toFixed(2)} m, ` +
        `${on.contacts} contacts (${(on.contacts / Math.max(on.seconds, 1)).toFixed(0)}/s), ` +
        `done ${on.doneAt ?? 'never'}, backing ${on.backing}/${on.n}`);
      check('KNOWN-BAD: without the progress anchor the follower never gets there',
        off.doneAt === null && off.i < off.of / 2,
        `i ${off.i}/${off.of}, done ${off.doneAt ?? 'never'}`);
      check('and it grinds against the building the whole time',
        off.contacts > 5000, `${off.contacts} contacts`);
      check('with the anchor it backs out and finishes the route',
        on.doneAt !== null, `done at ${on.doneAt ?? 'never'} s`);
      check('the recovery is the backing manoeuvre and not luck',
        on.backing > 0 && off.backing === 0, `${on.backing} frames against ${off.backing}`);
      check('and the contacts collapse, because the car stops pushing',
        on.contacts < off.contacts / 10, `${on.contacts} against ${off.contacts}`);
    }
  }

  /**
   * §8 BEING CAUGHT, END TO END, because a rule nothing can reach is not a rule. Before this
   * harness had a pursuit layer the measurement was: five stars, engine off, never moving,
   * `units 6/0` — six units requested and zero reporting a position — and the level bled
   * 4* -> 0 over 87 s. Sitting still was a guaranteed escape, and both playtesters' reports on
   * evasion were made against that.
   *
   * What this arm asserts is the whole chain: units arrive, one of them STOPS on the player,
   * src/wanted.js's clock runs, the level clears, the mission is lost, and the car comes back
   * repaired and drivable. Every link has been broken separately in a shipped build.
   */
  {
    console.log('\n§8  being caught');
    const s = new Session({ seed: 3, peds: 0, traffic: 0 });
    s.startMission('marlin-street');
    s.wanted.reportCrime('officerDown', { at: { x: s.vehicle.position.x, z: s.vehicle.position.z } });
    const hurt = s.damage.impact({ dv: 8, kind: IMPACT.wall, dirZ: 1, speed: 8 });
    const healthBefore = s.damage.health;
    let heldEver = 0, minD = Infinity, sawCountdown = null, unitsEver = 0;
    // Sit still. A minute of game time is ample: measured, the fleet takes 37 s to pin a
    // stationary car from four stars, and that figure is printed so a regression reads as a
    // number rather than as a timeout.
    for (let k = 0; k < 60 && s.stats.released === 0; k++) {
      s.drive({ throttle: 0, brake: 1 }).step(1);
      const u = s._unitPositions();
      heldEver = Math.max(heldEver, u.filter((x) => x.held).length);
      unitsEver = Math.max(unitsEver, u.length);
      for (const x of u) {
        minD = Math.min(minD, Math.hypot(x.x - s.vehicle.position.x, x.z - s.vehicle.position.z));
      }
      const bi = s.wanted.hudState().bustIn;
      if (bi != null && sawCountdown === null) sawCountdown = bi;
    }
    const caughtAt = s.log.find((l) => l.line.startsWith('BUSTED'));
    const outAt = s.log.find((l) => l.line.startsWith('OUT'));
    console.log(`    units reporting ${unitsEver} at the peak (0 now: the bust released them), ` +
      `closest approach ${minD.toFixed(1)} m, ${heldEver} holding at once`);
    console.log(`    busted at ${caughtAt ? caughtAt.t : 'never'} s, released at ` +
      `${outAt ? outAt.t : 'never'} s, health ${healthBefore.toFixed(3)} -> ` +
      `${s.damage.health.toFixed(3)}, mission ${s.mission.outcome}`);
    check('the harness has police that report where they are',
      s.wanted.stats.bustHolds > 0 && unitsEver > 0,
      `armed ${s.wanted.stats.bustHolds}x, ${unitsEver} units reported a position`);
    /**
     * THE HOLD RADIUS COVERS THE WIDEST ROAD, which is what it is FOR and the only property that
     * catches the defect it shipped with. Units run the road-graph CENTRELINE and a player can be
     * at the far kerb, so the worst honest separation between a unit that has arrived and the
     * player it has arrived at is half the widest road plus the car's own half-length.
     *
     * `src/pursuit.js` derived that from `e.r` for a round — a CLASS RANK (primary 2 … service 8),
     * not a width — and came out at 7.15 m instead of 8.75. A blind playtester measured the cost:
     * 8, 9 and 10 m from a centreline at five stars was 0 of 5 arrests with the clock never
     * arming, against 5 of 5 at 0, 6 and 7 m. `mutation-sweep`'s `hold-rank` reverts it and was
     * MISSED by every gate, because the wrong value is SMALLER and the arm below still busts at
     * short range — a radius too small fails only where nothing was looking.
     */
    const widest = Math.max(...s.district.edges.map((e) => e.w));
    const needed = widest / 2 + HALF_EXTENT.z;
    console.log(`    the widest edge is ${widest} m, so a unit on its centreline can be ` +
      `${(widest / 2).toFixed(2)} m from a player at the kerb plus ${HALF_EXTENT.z} m of car ` +
      `= ${needed.toFixed(2)} m; holdRadius is ${s.pursuit.holdRadius.toFixed(2)} m`);
    check('the hold radius reaches the far kerb of the widest road, plus a car',
      s.pursuit.holdRadius >= needed - 1e-9,
      `${s.pursuit.holdRadius.toFixed(2)} against ${needed.toFixed(2)} m`);
    check('and it is not absurdly wider than that either, or it is not a contact radius',
      s.pursuit.holdRadius < needed * 1.5,
      `${s.pursuit.holdRadius.toFixed(2)} against ${(needed * 1.5).toFixed(2)} m`);

    /**
     * AND THIS HARNESS'S OWN COPY OF THE ARREST RADIUS, which is the third of three and the one
     * that cost an hour. `src/pursuit.js` decides `held` per unit out to `reachRadius`; this
     * file and district/main.js then RE-TEST the held unit against the player, because during a
     * search the pursuit target is the last known position and a unit parked on that is not
     * holding anybody. Both re-tests used `holdRadius`.
     *
     * So widening the module changed nothing a player could feel. Measured at 14.15 m off a
     * road at four stars with the module already fixed: `u.held` true on 98.5% of samples,
     * longest hold 197.0 s, busts 0 in 200 s — because 14.15 failed `<= 8.75` in the host. With
     * all three reading the module: arrested at 7.3 s. The ON-ROAD case is byte-identical
     * either way (51.6% held, longest 4.00 s, bust at t=7.8 s), which is what says the change
     * widened the band rather than moving it.
     *
     * Asserted here as the RELATION between this file's choice and the module's, because a
     * number copied into a third place is how this went wrong in the first place.
     */
    const hostReach = s.pursuit.reachRadius ?? s.pursuit.holdRadius ?? 0;
    console.log(`    the arrest radius this harness uses: ${hostReach.toFixed(2)} m against the ` +
      `module's reachRadius ${s.pursuit.reachRadius.toFixed(2)} and holdRadius ` +
      `${s.pursuit.holdRadius.toFixed(2)}`);
    check('this harness asks the module how far an arrest reaches, not its own old bound',
      hostReach === s.pursuit.reachRadius && hostReach > s.pursuit.holdRadius,
      `${hostReach.toFixed(2)} vs reach ${s.pursuit.reachRadius.toFixed(2)}, ` +
      `old ${s.pursuit.holdRadius.toFixed(2)}`);
    check('and the pursuit has the blocker predicate, so the walk can be refused',
      typeof s.pursuit.clearAt === 'function' && s.pursuit.report().footPath === true,
      `footPath ${s.pursuit.report().footPath}`);

    check('a unit stops ON the stationary player rather than driving past',
      heldEver > 0 && minD < s.pursuit.holdRadius,
      `${heldEver} held, closest ${minD.toFixed(1)} m against holdRadius ` +
      `${s.pursuit.holdRadius.toFixed(2)}`);
    check('sitting still at four stars gets you arrested, where it used to clear the level',
      s.stats.busts === 1, `${s.stats.busts} busts in ${s.t.toFixed(0)} s`);
    check('the countdown was visible before it fired, not only after',
      sawCountdown != null && sawCountdown > 0 && sawCountdown <= BUST_HOLD_S,
      `first reading ${sawCountdown}`);
    check('the wanted level is cleared', s.wanted.stars === 0, `${s.wanted.stars}*`);
    /**
     * THE WEDGED-CAR CUE REACHES `look()`, which is the half of that feature this file owns.
     *
     * The DETECTOR is gated in tools/blocker-test.mjs against real geometry — a car crept into a
     * 4 m bay travels 0.305 m under full throttle with 92 contacts a second, and reverse covers
     * 63.18 m from the same pin, x207. What can break HERE is the wire: `_band()` has to pass
     * `stuck` to `composeBand`, and CLAUDE.md records four of composeBand's five tenants missing
     * from `look()` for exactly that reason, which made the harness harder to play than the game.
     *
     * Driven off the module's own `composeStuck` by setting the fields it reads, because a pin in
     * the real district is not reliably reachable: two scenario arms tried and got 23.31 m of
     * travel on the best of sixteen headings, and a pocket search found a spot where the car
     * WRECKED instead — the contact counter went negative, a respawn having reset it.
     */
    const jam = new Session({ traffic: 0, peds: 0 });
    jam.step(0.5);
    const quiet = jam.look().objective;
    jam.vehicle.stuckFor = STUCK_HOLD_S;
    jam.vehicle.stuckDir = 1;
    const wedged = jam.look();
    jam.vehicle.stuckDir = -1;
    const tailIn = jam.look();
    console.log(`    wedged: "${quiet}" -> "${wedged.objective}" / "${wedged.subtitle}"; `
      + `tail-in subtitle "${tailIn.subtitle}"`);
    check('a wedged car reaches look() through the band, with the word that gets it out',
      String(wedged.objective).includes('WEDGED') && wedged.subtitle === 'reverse'
      && tailIn.subtitle === 'drive' && wedged.bandFrom === 'stuck',
      `${JSON.stringify(wedged.objective)} / ${wedged.subtitle}, from ${wedged.bandFrom}`);
    check('KNOWN-BAD: and it is absent without the jam, so that is not just the band\'s default',
      !String(quiet).includes('WEDGED')
      && composeStuck({ stuckFor: STUCK_HOLD_S - 0.01, stuckDir: 1 }) === null,
      `${JSON.stringify(quiet)}; under the dwell -> null`);
    check('the mission is lost, which is what being busted costs',
      s.mission.outcome === OUTCOMES.ABORTED, `${s.mission.outcome}`);
    check('the car comes back repaired, which no player could do before',
      s.stats.released === 1 && s.damage.health === 1 && healthBefore < 1,
      `${healthBefore.toFixed(3)} -> ${s.damage.health.toFixed(3)}`);
    // And it drives: a release that hands back a car that cannot move is the wreck dead end again.
    const before = { x: s.vehicle.position.x, z: s.vehicle.position.z };
    s.drive({ throttle: 1, brake: 0, steer: 0 }).step(4);
    const moved = Math.hypot(s.vehicle.position.x - before.x, s.vehicle.position.z - before.z);
    console.log(`    and four seconds of throttle after release: ${moved.toFixed(1)} m, ` +
      `${s.look().speedKmh} km/h`);
    check('and it drives away', moved > 5, `${moved.toFixed(1)} m`);
    /**
     * KNOWN-BAD: THE OUT IS THE THROTTLE, and a rule with no out is the "barrier that refuses all
     * power" this project has shipped twice. Same seed, same crime, but driving — so the units
     * arrive and never hold a player who keeps moving.
     */
    const g = new Session({ seed: 3, peds: 0, traffic: 0 });
    g.wanted.reportCrime('officerDown', { at: { x: g.vehicle.position.x, z: g.vehicle.position.z } });
    for (let k = 0; k < 60 && g.stats.busts === 0; k++) {
      g.drive({ throttle: 0.55, brake: 0, steer: k % 8 < 4 ? 0.18 : -0.18 }).step(1);
    }
    console.log(`    KNOWN-BAD, the same seed while driving: ${g.stats.busts} busts in ` +
      `${g.t.toFixed(0)} s, ${g.wanted.stars}* left, armed ${g.wanted.stats.bustHolds}x`);
    check('KNOWN-BAD: a player who keeps driving is not busted',
      g.stats.busts === 0, `${g.stats.busts} busts`);
  }


  /**
   * §9  THE GARAGE, END TO END, because the thing a playtester actually hit was that there was no
   * way to fix the car. Measured: a car at 0.686 health with no engine power, 60 s of full
   * throttle and 60 s of full reverse both giving 0 km/h, and the only repair in the game being
   * `__district` from a console. The owner chose "a garage you drive to".
   *
   * `tools/damage-test.mjs` gates the MODULE — the dwell swept at four step sizes, the 2x2x2 of
   * refusals, the banking known-bad — and `tools/mission-test.mjs` gates its POSITION against
   * every mission zone in the district. What is left for this file is the only thing neither can
   * see: that a player driving this car can get to it, stop in it, and watch the band count down.
   *
   * CLAUDE.md's rule is the one this is here for: "when a feature lands, write down how a player
   * gets to it, and then check that path from the outside." Three systems in one round were right
   * in their module and unreachable from the game.
   *
   * THE DRIVE IS A REAL DRIVE, not a teleport onto the spot: the car is placed on the road
   * outside the zone and has to cover the last leg under throttle, because "the car is in the
   * zone" is the one part of this a teleport would assume rather than test.
   */
  {
    console.log('\n§9  the garage');
    const s = new Session({ seed: 5, peds: 0, traffic: 0 });
    /**
     * THE ROUTE FROM THE SPAWN, asserted rather than driven. 242 m of autopilot is a flaky gate
     * — the follower's own lane-keeping is a known open defect — so the claim is the structural
     * one: the road network connects the spawn to the garage. A garage on an unreachable island
     * would pass every module check in this project.
     */
    const spawn = { x: s.vehicle.position.x, z: s.vehicle.position.z };
    const route = s.roads.path(spawn.x, spawn.z, GARAGE_AT.x, GARAGE_AT.z,
      { spacing: 8, offset: ROUTE_LANE_M, smoothPasses: 1 });
    // `path()` returns points as `[x, z, edgeIndex]` triples, which is what `followPath` reads.
    const pts = (route && route.points ? route.points : []).map((q) => ({ x: q[0], z: q[1] }));
    const ends = pts.length
      ? Math.hypot(pts[pts.length - 1].x - GARAGE_AT.x, pts[pts.length - 1].z - GARAGE_AT.z)
      : Infinity;
    console.log(`    routed from the spawn: ${pts.length} points, ` +
      `${route ? route.length.toFixed(0) : '?'} m, ending ${ends.toFixed(1)} m from the garage`);
    check('the road network routes a car from the spawn to the garage',
      pts.length > 2 && ends <= s.garage.radius,
      `${pts.length} points, last one ${ends.toFixed(1)} m out against a ${s.garage.radius} m zone`);

    /**
     * THE APPROACH. Picked off the route rather than chosen: the last route point that is still
     * outside the zone, which is where a player arrives from. Driving from an arbitrary bearing
     * is how a wedged-car arm in §8 ended up with 23.31 m of travel on the best of sixteen
     * headings.
     */
    let approach = null;
    for (const p of pts) {
      const d = Math.hypot(p.x - GARAGE_AT.x, p.z - GARAGE_AT.z);
      if (d > s.garage.radius + 2 && d < s.garage.radius + 20) approach = { ...p, d };
    }
    check('the route passes within a car-length or two of the zone edge, or there is no approach',
      approach !== null, approach ? `${approach.d.toFixed(1)} m out` : 'no route point in the band');
    const yaw = Math.atan2(GARAGE_AT.x - approach.x, GARAGE_AT.z - approach.z);
    s.placeAt(approach.x, approach.z, yaw);
    s.step(0.5);
    // Break the car on the spot rather than by crashing it, so the arm measures the garage and
    // not the collision pass: a crash here would also move the car and pick up crimes.
    s.damage.impact({ dv: 7.5, kind: IMPACT.wall, dirZ: 1, speed: 7.5 });
    const broken = s.damage.health;
    const linesSeen = [];
    let repairedAt = null, sawCountdown = null, worstCountdown = 0;
    for (let k = 0; k < 400 && repairedAt === null; k++) {
      const d = Math.hypot(s.vehicle.position.x - GARAGE_AT.x, s.vehicle.position.z - GARAGE_AT.z);
      // Throttle until the zone, then stand on the brake. A player does exactly this.
      s.drive(d > s.garage.radius * 0.5 ? { throttle: 0.42, brake: 0, steer: 0 }
        : { throttle: 0, brake: 1, steer: 0 }).step(0.25);
      const v = s.look();
      if (v.bandFrom === 'garage') {
        const line = `${objectiveLine(v.objective)} / ${v.subtitle}`;
        if (linesSeen[linesSeen.length - 1] !== line) linesSeen.push(line);
        /**
         * READ OFF THE FLATTENED LINE, because that is what a player sees: `look()` puts the
         * objective through `objectiveLine`, so the number and its unit arrive as words. A probe
         * that reached for `objective.distance` here read null at every input while the countdown
         * was on screen the whole time — the shape CLAUDE.md records as a probe that measures
         * something other than the thing it is checking.
         */
        const m = /REPAIRING — (\d+) s$/.exec(String(v.objective));
        const n = m ? +m[1] : null;
        if (n != null) { if (sawCountdown === null) sawCountdown = n; worstCountdown = Math.max(worstCountdown, n); }
      }
      if (s.stats.repairs > 0) repairedAt = s.t;
    }
    const g = s.garage.report();
    console.log(`    drove in from ${approach.d.toFixed(1)} m out, ${s.stats.distance.toFixed(1)} m ` +
      `travelled; health ${broken.toFixed(3)} -> ${s.damage.health.toFixed(3)} at t=` +
      `${repairedAt == null ? 'never' : repairedAt.toFixed(1)} s`);
    console.log(`    the band, in order: ${linesSeen.map((l) => `"${l}"`).join(' -> ')}`);
    console.log(`    ${JSON.stringify({ ...s.garage.stats, dwell: g.dwell, repairs: s.stats.repairs })}`);
    /**
     * THE DRIVE HAPPENED. "A check whose two sides are both zero is not a check": every number
     * below is zero for a car that never moved and never entered, so the arm asserts the entry
     * and the travel before it asserts anything about the repair.
     */
    check('the car drove into the zone rather than being placed in it',
      s.garage.stats.entries === 1 && s.stats.distance > 2,
      `${s.garage.stats.entries} entries after ${s.stats.distance.toFixed(1)} m`);
    check('and it was broken when it got there, or there is nothing to repair',
      broken < 1 && broken > 0.2, `health ${broken.toFixed(3)}`);
    check('a player can drive to the garage and have the car repaired, which was the finding',
      repairedAt != null && s.damage.health === 1,
      `${broken.toFixed(3)} -> ${s.damage.health.toFixed(3)} at t=${repairedAt == null ? 'never' : repairedAt.toFixed(1)} s`);
    /**
     * AND THE BAND TOLD THEM TO. A repair that happens silently is the same defect as the
     * mission objective nothing reads: the player stops for an unrelated reason, the car is
     * fixed, and nothing in the game said a garage exists. The sequence asserted is the one a
     * player sees — told to stop, then counted down — and the countdown has to START near the
     * full hold rather than appearing at 1 s.
     */
    check('the band told the player to stop, then counted the hold down',
      linesSeen.length >= 2 && linesSeen[0].startsWith('GARAGE') &&
      linesSeen.some((l) => l.startsWith('REPAIRING')),
      linesSeen.join(' -> ') || 'the garage never reached the band');
    check('and the countdown starts at the hold rather than appearing at the end of it',
      worstCountdown === Math.ceil(s.garage.holdS) && sawCountdown === worstCountdown,
      `first ${sawCountdown}, highest ${worstCountdown}, hold ${s.garage.holdS} s`);
    check('the countdown is in seconds and says so, which the bust countdown once did not',
      linesSeen.some((l) => /REPAIRING — \d+ s/.test(l)),
      linesSeen.find((l) => l.startsWith('REPAIRING')) ?? 'no REPAIRING line');

    /**
     * KNOWN-BAD, the two refusals, driven the same way. Both are here because the module's own
     * 2x2x2 cannot see the wire: a host that passed a constant 0 for the stars, or the SMOOTHED
     * speed instead of the car's own, would pass every check in damage-test and fail both of
     * these.
     */
    const hot = new Session({ seed: 5, peds: 0, traffic: 0 });
    hot.placeAt(GARAGE_AT.x, GARAGE_AT.z, 0);
    hot.damage.impact({ dv: 7.5, kind: IMPACT.wall, dirZ: 1, speed: 7.5 });
    hot.wanted.reportCrime('officerDown', { at: { x: GARAGE_AT.x, z: GARAGE_AT.z } });
    let hotLine = null;
    for (let k = 0; k < 40; k++) {
      hot.drive({ throttle: 0, brake: 1 }).step(0.25);
      const v = hot.look();
      if (v.bandFrom === 'garage') hotLine = `${objectiveLine(v.objective)} / ${v.subtitle}`;
    }
    console.log(`    KNOWN-BAD wanted: ${hot.wanted.stars}* in the garage for ` +
      `${(40 * 0.25).toFixed(0)} s -> ${hot.stats.repairs} repairs, band "${hotLine}", ` +
      `refusedWanted ${hot.garage.stats.refusedWanted}`);
    check('KNOWN-BAD: the garage will not repair a car the police are looking for',
      hot.wanted.stars > 0 && hot.garage.stats.refusedWanted > 0 && hot.stats.repairs === 0 &&
      hot.damage.health < 1,
      `${hot.stats.repairs} repairs at ${hot.wanted.stars}*, ${hot.garage.stats.refusedWanted} refusals`);
    check('and it says why, rather than silently doing nothing',
      hotLine != null && /looking/.test(hotLine), `${hotLine}`);

    const past = new Session({ seed: 5, peds: 0, traffic: 0 });
    past.placeAt(approach.x, approach.z, yaw);
    past.step(0.5);
    past.damage.impact({ dv: 7.5, kind: IMPACT.wall, dirZ: 1, speed: 7.5 });
    let insideFrames = 0;
    for (let k = 0; k < 40 && past.stats.repairs === 0; k++) {
      /**
       * 0.18 OF THROTTLE AND NO BRAKE, measured: 5.75 s inside the 24 m zone at 2.45 to 5.78 m/s,
       * against a 4 s hold and a 1.0 m/s stop threshold. Both margins matter — a faster pass is
       * out of the zone before the hold could have finished whatever the rule says, and a brake
       * drag that crept under 1.0 m/s would repair the car and read as the rule being broken.
       * 0.42 of throttle gave 3.50 s, which is the first version of this arm and is void.
       */
      past.drive({ throttle: 0.18, brake: 0, steer: 0 }).step(0.25);
      if (past.garage.report().inside) insideFrames++;
    }
    console.log(`    KNOWN-BAD driving through: ${insideFrames} frames inside the zone, ` +
      `${past.stats.repairs} repairs, refusedMoving ${past.garage.stats.refusedMoving}`);
    check('KNOWN-BAD: driving through the garage does not repair the car',
      insideFrames > 0 && past.garage.stats.refusedMoving > 0 && past.stats.repairs === 0,
      `${insideFrames} frames inside, ${past.stats.repairs} repairs`);
    /**
     * AND THE REFUSAL IS THE SPEED, NOT THE FRAME COUNT. This car was inside the zone for more
     * frames than the hold needs, so a host feeding the garage a constant zero speed would have
     * repaired it. Printed as the comparison, because the two arms differ only in the brake.
     */
    check('and it was in there long enough that only the speed stopped it',
      insideFrames * 0.25 >= s.garage.holdS,
      `${(insideFrames * 0.25).toFixed(2)} s inside against a ${s.garage.holdS} s hold`);

    /**
     * THE ZONE IS ON THE MINIMAP. `MARKER_STYLE.shop` had existed in src/hud.js since the file
     * was written with nothing in the game ever posting one — the same shape as the five
     * systems that were never switched on. A garage a player cannot find is a garage that does
     * not exist.
     */
    const far = new Session({ seed: 5, peds: 0, traffic: 0 });
    const blips = far.look().blips ?? [];
    const shop = blips.filter((b) => b.id === 'garage');
    const trueRange = Math.hypot(far.vehicle.position.x - GARAGE_AT.x,
      far.vehicle.position.z - GARAGE_AT.z);
    console.log(`    minimap from the spawn: ${blips.length} blips, ` +
      `${shop.length} of them the garage` +
      `${shop.length ? ` at ${shop[0].range} m bearing ${shop[0].bearing}` +
        `${shop[0].edge ? ', clamped to the frame' : ''}` : ''}` +
      `; true range ${trueRange.toFixed(0)} m`);
    check('the garage posts a minimap blip, in the style src/hud.js has always carried',
      shop.length === 1 && Math.abs(shop[0].range - trueRange) < 1,
      `${shop.length} garage blips of ${blips.length}, range ${shop.length ? shop[0].range : '?'}` +
      ` against ${trueRange.toFixed(0)} m`);
    /**
     * AND IT IS STILL THERE WHEN IT IS OUT OF REACH, marked rather than dropped. A blind
     * playtester ran 110.3 m from the car, watched its blip vanish from `look()`, and searched
     * 191 s over eight legs for something the page was drawing at the map edge the whole time.
     * The garage is 242 m from the spawn, so this is that case by default.
     */
    check('and out of the map\u2019s reach it is clamped to the frame, not thrown away',
      shop.length === 1 && trueRange > MINIMAP_REACH_M && shop[0].edge === true,
      `${trueRange.toFixed(0)} m against a ${MINIMAP_REACH_M} m reach, edge ${shop.length ? shop[0].edge : '?'}`);
  }

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
